import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateSmokeVerdict, evaluateUninstallProof, formattingObservations, scrollObservation, runObservedSmoke } from '../scripts/smoke-verdict.mjs'
import { MAINTENANCE_REQUIRED_IDS, runMaintenanceSmoke } from '../scripts/maintenance-m1-browser-smoke.mjs'
import { RELEASE_REQUIRED_IDS, collectUninstallProof, probeUninstallPage, runReleaseSmoke } from '../scripts/probes/release-v0.2.1/release-smoke.mjs'

const passes = (ids: readonly string[]) => ids.map((id) => ({ id, status: 'PASS' as const }))
const proof = () => ({
  route: { kind: 'response', status: 404 },
  base: { kind: 'response', status: 200, authenticated: true, identified: true },
  registration: { kind: 'inventory', absent: true },
  routeMissingContract: 'dsh-client-connection@0.2.0-rc.2:404',
})

describe('actual collector formatting/scroll mapping', () => {
  const metrics = { hasLiteralEscapeInText: false, transLineCount: 3, defLineCount: 4, transRects: [{ top: 1 }, { top: 2 }, { top: 3 }], defRects: [{ top: 1 }, { top: 2 }, { top: 3 }, { top: 4 }], hasDuplicatePos: false, firstTransLine: 'n. pass' }
  it.each([
    ['literal-escaping', { hasLiteralEscapeInText: true }], ['line-count', { transLineCount: 2 }],
    ['line-count', { defLineCount: 3 }], ['vertical-layout', { transRects: [{ top: 1 }, { top: 1 }, { top: 3 }] }],
    ['vertical-layout', { defRects: [{ top: 1 }, { top: 2 }, { top: 3 }, { top: 3 }] }],
    ['pos', { hasDuplicatePos: true }], ['pos', { firstTransLine: 'v.n. pass' }],
  ])('the actual %s measurement fails independently', (id, change) => {
    const rows = formattingObservations({ ...metrics, ...change })
    expect(rows.find((row) => row.id === id)?.status).toBe('FAIL')
    expect(evaluateSmokeVerdict(rows, ['literal-escaping', 'line-count', 'vertical-layout', 'pos'])).toBe('FAIL')
  })
  it('valid measured formatting passes and malformed geometry fails closed', () => {
    expect(formattingObservations(metrics).every((row) => row.status === 'PASS')).toBe(true)
    expect(formattingObservations({ ...metrics, transRects: [{ top: NaN }, { top: 2 }, { top: 3 }] }).some((row) => row.status === 'FAIL')).toBe(true)
  })
  const scroll = { scrollHeight: 900, clientHeight: 400, scrollWidth: 300, clientWidth: 300, beforeScroll: 0, afterScroll: 120 }
  it.each([{ scrollHeight: 400 }, { afterScroll: 0 }, { clientHeight: 500 }, { scrollWidth: 310 }, { afterScroll: NaN }, { clientHeight: 0 }])('strict scroll rejects %j even with forged success booleans', (change) => {
    expect(scrollObservation({ ...scroll, ...change, isScrollable: true, didScroll: true }).status).toBe('FAIL')
  })
  it('passes real positive scroll geometry and changed scrollTop', () => {
    expect(scrollObservation(scroll).status).toBe('PASS')
  })
})

describe('observation-derived smoke verdict', () => {
  it('requires exactly one PASS for every fixed ID', () => {
    expect(evaluateSmokeVerdict(passes(['a', 'b']), ['a', 'b'])).toBe('PASS')
    for (const rows of [passes(['a']), passes(['a', 'a', 'b']), passes(['a', 'b', 'unknown']), [{ id: 'a', status: 'NOT_EXECUTED' }, ...passes(['b'])]]) {
      expect(evaluateSmokeVerdict(rows, ['a', 'b'])).toBe('INCOMPLETE')
    }
  })
  it('FAIL takes precedence over incomplete or unknown IDs', () => {
    expect(evaluateSmokeVerdict([{ id: 'unknown', status: 'FAIL' }], ['a'])).toBe('FAIL')
  })
  it('declared optional skip stays distinct from executed PASS', () => {
    const rows = [...passes(['a']), { id: 'optional', status: 'SKIPPED' }]
    expect(evaluateSmokeVerdict(rows, ['a', { id: 'optional', optional: true }])).toBe('PASS')
    expect(rows[1]?.status).toBe('SKIPPED')
    expect(evaluateSmokeVerdict(rows, ['a', 'optional'])).toBe('INCOMPLETE')
  })
  it.each([null, {}, [{ id: 'a' }], [{ status: 'PASS' }]])('fails closed on malformed observations %j', (rows) => {
    expect(evaluateSmokeVerdict(rows, ['a'])).toBe('INCOMPLETE')
  })
})

describe('actual runner aggregation/report/exit seams (no browser or DSH)', () => {
  for (const [name, run, ids] of [
    ['maintenance', runMaintenanceSmoke, MAINTENANCE_REQUIRED_IDS],
    ['release', runReleaseSmoke, RELEASE_REQUIRED_IDS],
  ] as const) {
    it.each(ids)(`${name}: failed %s affects saved JSON, console and exit`, async (failedId) => {
      let saved: { verdict: string } | undefined
      const output: string[] = []
      const result = await run({
        execute: async (report) => { report.observations.push(...passes(ids).map((row) => row.id === failedId ? { ...row, status: 'FAIL' } : row)) },
        writeReport: (report) => { saved = JSON.parse(JSON.stringify(report)) },
        log: (line) => { output.push(line) },
      })
      expect(result.exitCode).toBe(1)
      expect(saved?.verdict).toBe('FAIL')
      expect(output.join('\n')).toContain('verdict: FAIL')
    })
    it(`${name}: missing/NOT_EXECUTED and exceptions are durably nonzero`, async () => {
      for (const mode of ['missing', 'not-executed', 'throw']) {
        let saved: { verdict: string; observations: unknown[] } | undefined
        const result = await run({ execute: async (report) => {
          if (mode === 'throw') throw new Error('synthetic interruption')
          report.observations.push(...passes(ids).slice(1))
          if (mode === 'not-executed') report.observations.push({ id: ids[0]!, status: 'NOT_EXECUTED' })
        }, writeReport: (report) => { saved = JSON.parse(JSON.stringify(report)) }, log: () => {} })
        expect(result.exitCode).toBe(1)
        expect(saved?.verdict).toBe(mode === 'throw' ? 'FAIL' : 'INCOMPLETE')
      }
    })
    it(`${name}: all observed PASS produces consistent success`, async () => {
      const result = await run({ execute: async (report) => { report.observations.push(...passes(ids)) }, writeReport: () => {}, log: () => {} })
      expect(result.report.verdict).toBe('PASS')
      expect(result.exitCode).toBe(0)
    })
  }
  it('report writer failure propagates instead of claiming success', async () => {
    await expect(runObservedSmoke({ requiredIds: ['a'], evidence: { observations: passes(['a']) }, execute: async () => {}, writeReport: () => { throw new Error('disk-full') }, log: () => {} })).rejects.toThrow('disk-full')
  })
})

describe('positive uninstall proof', () => {
  it('accepts only identified authenticated healthy service, absent inventory and supported 404', () => {
    expect(evaluateUninstallProof(proof())).toBe('PASS')
  })
  it.each([undefined, null, {}, { kind: 'transport-error', message: 'offline' }, ...[200, 401, 403, 500, 0, 418, '404', NaN].map((status) => ({ kind: 'response', status }))])('rejects bad/unknown route %j', (route) => {
    expect(evaluateUninstallProof({ ...proof(), route })).toBe('FAIL')
  })
  it.each([
    { base: { kind: 'transport-error', message: 'offline' } },
    { base: { kind: 'response', status: 401, authenticated: false, identified: true } },
    { base: { kind: 'response', status: 200, authenticated: false, identified: true } },
    { base: { kind: 'response', status: 200, authenticated: true, identified: false } },
    { registration: { kind: 'inventory', absent: false } },
    { registration: { kind: 'inventory', absent: 'true' } },
    { registration: { kind: 'unknown' } }, { routeMissingContract: 'guessed' },
  ])('rejects 404 with unproven service or plugin state %j', (change) => {
    expect(evaluateUninstallProof({ ...proof(), ...change })).toBe('FAIL')
  })
})

describe('release HTTP/inventory acquisition seam', () => {
  const origin = 'http://127.0.0.1:50995'
  const entry = { entryId: 'plugin-a', moduleName: 'other-plugin', enabled: true, fiberPhase: 'active' }
  async function collect(change: Record<string, unknown> = {}, anonymous: unknown = { kind: 'response', status: 401 }, inventoryChange: Record<string, unknown> = {}) {
    return collectUninstallProof({
      service: { origin, identified: true }, routeContract: { contract: 'dsh-client-connection@0.2.0-rc.2:404' },
      anonymousProbe: async () => anonymous,
      probe: async (rpcId) => ({
        base: { kind: 'response', status: 200, origin, body: { type: 'server-response', rpcId, result: { ok: true, value: { entries: [entry], ...inventoryChange } } } },
        route: { kind: 'response', status: 404, origin }, pageOrigin: origin, pluginGlobalAbsent: true,
        ...change,
      }),
    })
  }
  it('uses correlated authenticated inventory, exact origin and anonymous rejection', async () => {
    expect(evaluateUninstallProof(await collect())).toBe('PASS')
  })
  it.each([
    { entries: [{ ...entry, moduleName: 'dsh-word-lookup' }] },
    { entries: [{ ...entry, moduleName: 'dsh-word-lookup', enabled: false, fiberPhase: 'failed' }] },
    { entries: null }, { entries: [{}] }, { entries: [{ ...entry, enabled: 'yes' }] },
    { entries: [{ ...entry, fiberPhase: 'unknown' }] }, { agentPresets: null },
    { agentPresets: [{ id: 'preset', isDefault: true, rows: [{ ...entry, moduleName: 'dsh-word-lookup' }] }] },
    { agentPresets: [{ id: 'preset', isDefault: true, broken: 'unknown composition', rows: [] }] },
  ])('cannot claim absent from registered or malformed inventory %j', async (inventory) => {
    expect(evaluateUninstallProof(await collect({}, undefined, inventory))).toBe('FAIL')
  })
  it.each([
    { base: { kind: 'transport-error', message: 'offline' } },
    { base: { kind: 'response', status: 200, origin, body: { type: 'server-response', rpcId: 'wrong', result: { ok: true, value: { entries: [] } } } } },
    { pageOrigin: 'http://127.0.0.1:9999' }, { pluginGlobalAbsent: false },
    { route: { kind: 'response', status: 404, origin: 'http://127.0.0.1:9999' } },
    { route: { kind: 'transport-error', message: 'offline' } },
  ])('rejects uncorrelated, failed or foreign service responses %j', async (change) => {
    expect(evaluateUninstallProof(await collect(change))).toBe('FAIL')
  })
  it.each([{ kind: 'response', status: 200 }, { kind: 'transport-error', message: 'offline' }, {}])('requires anonymous authentication control %j', async (anonymous) => {
    expect(evaluateUninstallProof(await collect({}, anonymous))).toBe('FAIL')
  })
  it('acquired uninstall failure participates in the actual release finalizer', async () => {
    const result = await runReleaseSmoke({ execute: async (report) => {
      const observation = await collect({ route: { kind: 'transport-error', message: 'offline' } })
      report.observations.push(...passes(RELEASE_REQUIRED_IDS).filter((row) => row.id !== 'uninstallationClean'), { id: 'uninstallationClean', status: evaluateUninstallProof(observation) })
    }, writeReport: () => {}, log: () => {} })
    expect(result.report.verdict).toBe('FAIL')
    expect(result.exitCode).toBe(1)
  })
})

describe('actual browser probe request and response discrimination', () => {
  afterEach(() => vi.unstubAllGlobals())
  const page = { evaluate: async (fn: (input: { rpcId: string }) => Promise<unknown>, input: { rpcId: string }) => fn(input) }
  it('sends the source-supported Remote args payload and separates HTTP from transport failure', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:50995' })
    vi.stubGlobal('window', { fetch: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) })
      return { status: path.endsWith('/list') ? 200 : 404, url: `http://127.0.0.1:50995/${path}`, json: async () => ({}) }
    } })
    const observed = await probeUninstallPage(page, 'synthetic-rpc-id') as { base: { kind: string; status: number }; route: { kind: string; status: number } }
    expect(calls[0]?.body).toEqual({ type: 'client-request', rpcId: 'synthetic-rpc-id', method: 'pluginInventory/list', payload: { args: {} } })
    expect(calls.map((call) => call.path)).toEqual(['api/pluginInventory/list', 'api/dsh-word-lookup'])
    expect(observed.base).toMatchObject({ kind: 'response', status: 200 })
    expect(observed.route).toMatchObject({ kind: 'response', status: 404 })
  })
  it('returns transport-error without inventing an HTTP status', async () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:50995' })
    vi.stubGlobal('window', { fetch: async () => { throw new Error('synthetic offline') } })
    const observed = await probeUninstallPage(page, 'synthetic-rpc-id') as { route: object }
    expect(observed.route).toMatchObject({ kind: 'transport-error' })
    expect(observed.route).not.toHaveProperty('status')
  })
})
