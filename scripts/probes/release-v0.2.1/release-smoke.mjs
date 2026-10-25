#!/usr/bin/env node
/**
 * Release Smoke Verification Probe for v0.2.1
 *
 * Provides a clean-room, isolated runtime smoke verification suite for
 * `dsh-word-lookup@0.2.1` on DeepSeek Harness (DSH).
 *
 * Supports:
 * - `--source local-tarball`: Installs and verifies the candidate `.tgz` archive
 * - `--source npm`: Queries official npm registry, downloads tarball, verifies SHA-256,
 *   and executes post-publication smoke acceptance. (Fails closed on E404 when not yet published).
 *
 * Supports custom DSH binary via `--dsh-bin` for targeted DSH 0.2.1-rc.2 verification.
 *
 * @module scripts/probes/release-v0.2.1/release-smoke
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createRequire } from 'node:module'
import { runObservedSmoke, evaluateUninstallProof, ROUTE_MISSING_CONTRACT, formattingObservations, scrollObservation, waitForSmokeStartup, smokeLifecycleFailure } from '../../smoke-verdict.mjs'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  DEFAULT_TEST_ROOT,
  FORBIDDEN_PROFILES,
  isPortFree,
  ISOLATION_BANNER,
  IsolationError,
  PRODUCTION_PORTS,
  isInsideOrEqual,
  assertDisjointProductionPaths,
} from '../../assert-isolated-env.mjs'
import { createOwnedTestRoot, createOwnedHome, cleanupOwnedHome, cleanupOwnedTestRoot } from '../../isolated-run-directory.mjs'

const ownedDshChildren = new Set()

/** Register both directories before any DSH profile or loader writes. */
export async function createReleaseTestRoot(options = {}) {
  const owner = await createOwnedTestRoot(options)
  await createOwnedHome(owner, join(owner.path, 'home'))
  return owner
}

/** Called only after evidence is durable outside the deletion range. */
export async function cleanupReleaseTestRoot(owner, { children, ports, evidencePaths }) {
  for (const child of children) {
    const exited = Number.isInteger(child.exitCode) || (typeof child.signalCode === 'string' && child.signalCode.length > 0)
    if (!exited) throw new Error('cleanup refused: child exit is unconfirmed; directory retained')
  }
  for (const port of ports) {
    if (!await isPortFree(port)) throw new Error(`cleanup refused: port ${port} is still occupied; directory retained`)
  }
  for (const evidence of evidencePaths) {
    if (isInsideOrEqual(evidence, owner.path) || isInsideOrEqual(owner.path, evidence)) throw new Error('cleanup refused: evidence overlaps the scratch directory')
  }
  await cleanupOwnedHome(owner, join(owner.path, 'home'))
  await cleanupOwnedTestRoot(owner)
}

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const EXPECTED_PACKAGE_NAME = 'dsh-word-lookup'
const EXPECTED_VERSION = '0.2.1'
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = 'true'
    } else {
      options[key] = next
      i++
    }
  }
  return options
}

async function findAvailablePort(startPort = 50995) {
  for (let port = startPort; port < 60000; port++) {
    if (PRODUCTION_PORTS.includes(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error('Unable to find an available high port between 50995 and 60000')
}

function resolveDshInvocation(dshBinOption) {
  if (!dshBinOption || dshBinOption === 'dsh') {
    const defaultNpmBin = join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (existsSync(defaultNpmBin)) {
      return { cmd: process.execPath, baseArgs: [defaultNpmBin], isNodeScript: true }
    }
    return { cmd: 'dsh', baseArgs: [], isNodeScript: false }
  }
  if (dshBinOption.endsWith('.js') || dshBinOption.endsWith('.mjs') || dshBinOption.endsWith('.cjs')) {
    return { cmd: process.execPath, baseArgs: [resolve(dshBinOption)], isNodeScript: true }
  }
  return { cmd: dshBinOption, baseArgs: [], isNodeScript: false }
}

export async function bootReleaseDsh(verified, port, cwd, dshInvocation, timeoutMs = 90000, dependencies = {}) {
  const env = dependencies.env ?? buildIsolatedEnv(verified, process.env, { PORT: String(port) })
  const args = [...dshInvocation.baseArgs, '--profile', verified.profile, '--no-open', '--port', String(port)]
  const child = (dependencies.spawnChild ?? spawn)(dshInvocation.cmd, args, {
    cwd,
    env,
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownedDshChildren.add(child)

  const started = await waitForSmokeStartup(child, {
    label: 'DSH', timeoutMs,
    stopChild: (ownedChild) => (dependencies.stopChild ?? stopDsh)(ownedChild, port),
    setTimer: dependencies.setTimer, clearTimer: dependencies.clearTimer,
    onChildError: dependencies.onChildError,
  })
  await (dependencies.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1200)
  return started
}

async function stopDsh(child, port) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
  await new Promise((r) => setTimeout(r, 1000))

  if (port) {
    const free = await isPortFree(port)
    if (!free) {
      console.warn(`[WARNING] Port ${port} is still occupied after stopping DSH PID ${child.pid}. Waiting...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error(`DSH child ${child.pid} exit unconfirmed; retaining test root`)
  if (port && !await isPortFree(port)) throw new Error(`DSH port ${port} remains occupied; retaining test root`)
}

/** Close runtime resources; same-file seam keeps controlled tests off real processes. */
export async function cleanupReleaseSmokeResources({ context, dshInstance, downloadedTarballPath, testPort }, dependencies = {}, primaryError) {
  const cleanupErrors = []
  try { if (context) await context.close() } catch (error) { cleanupErrors.push(error) }
  // Browser shutdown failure must never bypass the owned child stop attempt.
  try { if (dshInstance) await (dependencies.stopChild ?? stopDsh)(dshInstance.child, testPort) } catch (error) { cleanupErrors.push(error) }
  try {
    if (!primaryError && cleanupErrors.length === 0 && downloadedTarballPath && (dependencies.exists ?? existsSync)(downloadedTarballPath)) {
      (dependencies.removeTarball ?? rmSync)(downloadedTarballPath, { force: true })
    }
  } catch (error) { cleanupErrors.push(error) }
  if (primaryError || cleanupErrors.length) throw smokeLifecycleFailure(primaryError, cleanupErrors)
}

const DISMISS_LABEL = /configure later|not now|skip|later|close|dismiss|got it|continue|ok|稍后配置|跳过/i
async function dismissAllModals(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const dialogs = page.locator('[role="dialog"]')
    const count = await dialogs.count()
    if (count === 0) break

    const dialog = dialogs.last()
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()

    let clicked = false
    for (let index = 0; index < buttonCount; index++) {
      const text = ((await buttons.nth(index).textContent()) ?? '').trim()
      if (DISMISS_LABEL.test(text)) {
        await buttons.nth(index).click().catch(() => {})
        await page.waitForTimeout(600)
        clicked = true
        break
      }
    }
    if (!clicked) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  }
}

function checkNpmRegistry(packageName, version, registry = OFFICIAL_NPM_REGISTRY) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const spec = `${packageName}@${version}`
  const res = spawnSync(npmCmd, ['view', spec, '--registry', registry, '--json'], {
    encoding: 'utf8',
    shell: true,
  })

  let parsed = null
  try {
    if (res.stdout && res.stdout.trim().startsWith('{')) {
      parsed = JSON.parse(res.stdout.trim())
    }
  } catch {}

  if (parsed && parsed.error) {
    const code = parsed.error.code
    if (code === 'E404') {
      return { state: 'NOT_PUBLISHED', error: parsed.error }
    }
    if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)) {
      return { state: 'NETWORK_ERROR', error: parsed.error }
    }
    return { state: 'REGISTRY_ERROR', error: parsed.error }
  }

  if (res.status === 0 && parsed && parsed.version === version) {
    return { state: 'PUBLISHED', data: parsed }
  }

  const stderr = (res.stderr || '').trim()
  if (stderr.includes('E404') || stderr.includes('404 Not Found') || stderr.includes('No match found for version')) {
    return { state: 'NOT_PUBLISHED', error: { code: 'E404', detail: stderr } }
  }
  if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT') || stderr.includes('ECONNREFUSED')) {
    return { state: 'NETWORK_ERROR', error: { code: 'NETWORK_ERROR', detail: stderr } }
  }

  return { state: 'REGISTRY_ERROR', error: { code: 'UNKNOWN_ERROR', detail: stderr || res.stdout } }
}

export const RELEASE_REQUIRED_IDS = Object.freeze([
  'pluginLoaded', 'settingsNavVisible', 'settingsSectionVisible', 'settingsUpdatedBadgesVerified',
  'fixtureModeActive', 'lookupSuccessful', 'autoDoubleClickDefaultOff', 'autoSelectionDefaultOff',
  'literal-escaping', 'line-count', 'vertical-layout', 'pos',
  'narrowViewportVerified', 'scrollabilityVerified', 'zero-auto-download', 'uninstallationClean',
])

/** The CLI and controlled collectors share the same report/verdict/exit operation. */
export async function runReleaseSmoke(options = {}) {
  const runId = randomUUID()
  const evidence = {
    runId, timestamp: new Date().toISOString(), phase: 'RELEASE_V021', observations: [],
    runtime: { nodeVersion: process.version, dshVersion: 'UNKNOWN / NOT_EXECUTED', execution: 'NOT_EXECUTED' },
    classification: { formatting: 'CONTROLLED_LOOKUP_RESPONSE', fixtureQuery: 'NOT_EXECUTED', realEcdictQuery: 'NOT_EXECUTED', zeroAutoDownload: 'NOT_VERIFIED', collector: options.execute ? 'SYNTHETIC' : 'RUNTIME' },
  }
  const fallbackDir = join(tmpdir(), 'dsh-release-smoke-evidence', 'run-' + runId)
  return runObservedSmoke({ evidence, requiredIds: RELEASE_REQUIRED_IDS,
    execute: options.execute ?? (async (report) => {
      try { await executeReleaseSmoke(report) }
      catch (error) { console.error(String(error.message).replace(/([?&]token=)[^\s&]+/g, '$1REDACTED')); throw error }
    }),
    writeReport: options.writeReport ?? ((report) => {
      const reportPath = report.reportPath ?? join(fallbackDir, 'smoke-execution-report.json')
      assertDisjointProductionPaths([reportPath])
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' })
      console.log('Evidence report written to: ' + reportPath)
    }), log: options.log,
  })
}

// Source: @deepseek-ai/dsh-client-connection/lib/index.js:606-624,832-842.
// Pin the exact locally inspected rc.2 connection implementation. A custom
// invocation whose transport cannot be resolved or differs remains unsupported.
const SUPPORTED_CONNECTION_SHA256 = '3950f524aed44e28240140a254cd928ea40eba8e2d04cc8fd04f92a687f5c91d'
function resolveRouteContract(invocation) {
  if (!invocation.isNodeScript || !invocation.baseArgs[0]) return { contract: 'UNKNOWN' }
  try {
    const entry = createRequire(resolve(invocation.baseArgs[0])).resolve('@deepseek-ai/dsh-client-connection')
    const sha256 = sha256File(entry)
    return { entry, sha256, contract: sha256 === SUPPORTED_CONNECTION_SHA256 ? ROUTE_MISSING_CONTRACT : 'UNKNOWN' }
  } catch { return { contract: 'UNKNOWN' } }
}

/** Request the supported inventory Remote and removed plugin route in one page. */
export async function probeUninstallPage(page, rpcId) {
  return page.evaluate(async ({ rpcId }) => {
    const request = async (path, body) => {
      try {
        const response = await window.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' })
        let data
        if (path.endsWith('pluginInventory/list')) data = await response.json().catch(() => null)
        return { kind: 'response', status: response.status, origin: new URL(response.url).origin, body: data }
      } catch { return { kind: 'transport-error', message: 'HTTP request failed' } }
    }
    const base = await request('api/pluginInventory/list', { type: 'client-request', rpcId, method: 'pluginInventory/list', payload: { args: {} } })
    const route = await request('api/dsh-word-lookup', { query: 'derive' })
    return { base, route, pageOrigin: location.origin, pluginGlobalAbsent: typeof window.__DSH_WORD_LOOKUP__ === 'undefined' }
  }, { rpcId })
}

/** Collect discriminated HTTP results and validate inventory before declaring absence. */
export async function collectUninstallProof({ probe, anonymousProbe, service, routeContract }) {
  const rpcId = randomUUID()
  const observed = await probe(rpcId)
  const anonymous = await anonymousProbe()
  const base = observed?.base
  const envelope = base?.body
  const inventory = envelope?.result?.value
  const phases = ['pending', 'loading', 'active', 'failed', 'unloading', null]
  const validEntry = (row) => row && typeof row.entryId === 'string' && typeof row.moduleName === 'string' && typeof row.enabled === 'boolean' && phases.includes(row.fiberPhase)
  const validPresetRow = (row) => row && (row.entryId === null || typeof row.entryId === 'string') && typeof row.moduleName === 'string' && [true, false, 'conditional'].includes(row.enabled) && phases.includes(row.fiberPhase)
  const validPresets = inventory?.agentPresets === undefined || (Array.isArray(inventory.agentPresets) && inventory.agentPresets.every((preset) => preset && typeof preset.id === 'string' && typeof preset.isDefault === 'boolean' && preset.broken === undefined && Array.isArray(preset.rows) && preset.rows.every(validPresetRow)))
  const validInventory = envelope?.type === 'server-response' && envelope.rpcId === rpcId && envelope.result?.ok === true && Array.isArray(inventory?.entries) && inventory.entries.every(validEntry) && validPresets
  const rows = validInventory ? [...inventory.entries, ...(inventory.agentPresets ?? []).flatMap((preset) => preset.rows)] : []
  const registration = validInventory ? { kind: 'inventory', absent: !rows.some((row) => row.moduleName === EXPECTED_PACKAGE_NAME || row.moduleName.startsWith(EXPECTED_PACKAGE_NAME + '/')) && observed.pluginGlobalAbsent === true } : { kind: 'unknown' }
  const originMatches = service?.identified === true && typeof service.origin === 'string' && observed?.pageOrigin === service.origin && base?.origin === service.origin && observed?.route?.origin === service.origin
  return {
    route: observed?.route ?? { kind: 'transport-error', message: 'missing route observation' },
    base: { kind: base?.kind, status: base?.status,
      authenticated: validInventory && anonymous?.kind === 'response' && [401, 403].includes(anonymous.status),
      identified: originMatches,
    }, registration, routeMissingContract: routeContract?.contract ?? 'UNKNOWN',
  }
}

async function executeReleaseSmoke(report) {
  const startTime = Date.now()
  const options = parseArgs(process.argv.slice(2))
  const sourceMode = options.source
  report.mode = sourceMode ?? 'UNKNOWN'
  report.packageIdentity = { expectedName: EXPECTED_PACKAGE_NAME, expectedVersion: EXPECTED_VERSION, sourceMode: sourceMode ?? 'UNKNOWN', tarballSha256: 'NOT_VERIFIED', installedPath: 'NOT_VERIFIED' }
  const requestedTestRoot = resolve(options['test-root'] ?? join(tmpdir(), `dsh-release-smoke-v021-${randomUUID()}`))
  const evidenceDir = resolve(REPO_ROOT, options['evidence-dir'] || join('docs/evidence/release-v0.2.1', `run-${report.runId}`))
  // Validate write/deletion boundaries before evidence directories or downloads.
  assertDisjointProductionPaths([requestedTestRoot, evidenceDir])
  if (isInsideOrEqual(evidenceDir, requestedTestRoot) || isInsideOrEqual(requestedTestRoot, evidenceDir)) {
    throw new IsolationError(['evidence directory overlaps the test root; choose a separate evidence directory'])
  }
  if (options['evidence-name'] && (options['evidence-name'].includes('/') || options['evidence-name'].includes('\\') || options['evidence-name'] === '..')) {
    throw new IsolationError(['evidence-name must be a filename inside the evidence directory'])
  }
  try {
    lstatSync(requestedTestRoot)
    throw new IsolationError(['test root already exists; a new run requires an exclusive directory'])
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  console.log('======================================================================')
  console.log(' Release v0.2.1: Isolated Smoke Test Execution Probe')
  console.log('======================================================================\n')

  if (!sourceMode || !['local-tarball', 'npm'].includes(sourceMode)) {
    console.error('ERROR: Missing or invalid --source argument.')
    console.error('Usage:')
    console.error('  node scripts/probes/release-v0.2.1/release-smoke.mjs --source local-tarball [--tarball <path>]')
    console.error('  node scripts/probes/release-v0.2.1/release-smoke.mjs --source npm [--registry <url>]')
    throw new Error('Missing or invalid --source argument')
  }

  const dshInvocation = resolveDshInvocation(options['dsh-bin'])
  console.log(`Execution Mode:    --source ${sourceMode}`)
  console.log(`Repository Root:   ${REPO_ROOT}`)
  console.log(`Target Package:    ${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`)
  console.log(`DSH Command:       ${dshInvocation.cmd} ${dshInvocation.baseArgs.join(' ')}`)

  mkdirSync(dirname(evidenceDir), { recursive: true })
  mkdirSync(evidenceDir) // independent run evidence must never overwrite a previous run
  report.reportPath = join(evidenceDir, options['evidence-name'] || 'smoke-execution-report.json')
  report.runtime.invocation = { cmd: dshInvocation.cmd, baseArgs: [...dshInvocation.baseArgs] }
  report.runtime.routeContract = resolveRouteContract(dshInvocation)
  const screenshotsDir = join(evidenceDir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })

  let registryMetadata = null
  let downloadedTarballPath = null
  let expectedTarballSha256 = options['expected-sha256'] || null
  let expectedTarballSize = options['expected-size'] ? Number(options['expected-size']) : null

  // ---------------------------------------------------------------------------
  // [Gate 1] npm preflight handling for --source npm
  // ---------------------------------------------------------------------------
  if (sourceMode === 'npm') {
    const registry = options.registry || OFFICIAL_NPM_REGISTRY
    console.log(`\n[npm-preflight] Querying official registry: ${registry}...`)
    const registryCheck = checkNpmRegistry(EXPECTED_PACKAGE_NAME, EXPECTED_VERSION, registry)

    if (registryCheck.state === 'NOT_PUBLISHED') {
      console.log(`\n[NPM_PREFLIGHT_STATUS] NOT_PUBLISHED`)
      console.log(`Reason: Package ${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION} is not yet published on ${registry} (E404).`)
      console.log('Pre-publication read-only preflight check passed (E404 strictly confirmed).')
      console.log('Per release specification, npm smoke test cannot be executed prior to publication.')
      console.log('Execution safely aborted (FAIL-CLOSED, zero simulated success).')

      report.preflight = { status: 'NOT_EXECUTED_PRE_PUBLICATION', reason: 'NOT_PUBLISHED (E404 confirmed from official registry)' }
      report.observations.push({ id: 'pluginLoaded', status: 'NOT_EXECUTED' })
      return

    }

    if (registryCheck.state === 'NETWORK_ERROR') {
      console.error(`\n[FATAL] npm registry network error: ${JSON.stringify(registryCheck.error)}`)
      throw new Error('Smoke preflight failed; see preceding diagnostics')
    }

    if (registryCheck.state !== 'PUBLISHED') {
      console.error(`\n[FATAL] Unexpected registry state: ${registryCheck.state}: ${JSON.stringify(registryCheck.error)}`)
      throw new Error('Smoke preflight failed; see preceding diagnostics')
    }

    registryMetadata = registryCheck.data
    console.log(`[PASS] Registry metadata retrieved for version ${registryMetadata.version}`)
    console.log(`  dist.shasum:    ${registryMetadata.dist?.shasum}`)
    console.log(`  dist.integrity: ${registryMetadata.dist?.integrity}`)
    console.log(`  dist.tarball:   ${registryMetadata.dist?.tarball}`)

    const tarballUrl = registryMetadata.dist?.tarball
    if (!tarballUrl) throw new Error('Registry metadata missing dist.tarball URL')

    const downloadTemp = join(tmpdir(), `npm-download-v021-${Date.now()}-${randomUUID().slice(0, 6)}.tgz`)
    assertDisjointProductionPaths([downloadTemp])
    console.log(`Downloading published tarball from ${tarballUrl}...`)
    const dlFetch = await fetch(tarballUrl)
    if (!dlFetch.ok) {
      throw new Error(`Failed to download published tarball from ${tarballUrl}: HTTP ${dlFetch.status}`)
    }
    const dlBuf = Buffer.from(await dlFetch.arrayBuffer())
    writeFileSync(downloadTemp, dlBuf, { flag: 'wx' })
    downloadedTarballPath = downloadTemp
    const downloadedHash = sha256File(downloadedTarballPath)
    console.log(`Downloaded tarball SHA-256: ${downloadedHash}`)

    if (expectedTarballSha256 && downloadedHash !== expectedTarballSha256) {
      throw new Error(`Downloaded npm tarball SHA-256 mismatch! Expected ${expectedTarballSha256}, got ${downloadedHash}`)
    }
    report.packageIdentity.tarballSha256 = downloadedHash
    expectedTarballSha256 = downloadedHash
    console.log('PASS: Downloaded npm tarball retrieved and verified.')
  }

  // ---------------------------------------------------------------------------
  // [Gate 2] Candidate package verification for --source local-tarball
  // ---------------------------------------------------------------------------
  let localTarballPath = null
  if (sourceMode === 'local-tarball') {
    const candidateArg = options.tarball || 'build/rc-v0.2.1/dsh-word-lookup-0.2.1.tgz'
    localTarballPath = resolve(REPO_ROOT, candidateArg)
    console.log(`\n[candidate-verification] Candidate Tarball: ${localTarballPath}`)

    if (!existsSync(localTarballPath)) {
      throw new Error(`Candidate tarball does not exist: ${localTarballPath}`)
    }

    const tgzStat = statSync(localTarballPath)
    const tgzHash = sha256File(localTarballPath)

    console.log(`  Byte size: ${tgzStat.size} bytes`)
    console.log(`  SHA-256:   ${tgzHash}`)

    if (expectedTarballSize && tgzStat.size !== expectedTarballSize) {
      throw new Error(`Candidate tarball size mismatch! Expected ${expectedTarballSize}, got ${tgzStat.size}`)
    }
    if (expectedTarballSha256 && tgzHash !== expectedTarballSha256) {
      throw new Error(`Candidate tarball SHA-256 mismatch! Expected ${expectedTarballSha256}, got ${tgzHash}`)
    }
    report.packageIdentity.tarballSha256 = tgzHash
    expectedTarballSha256 = tgzHash
    expectedTarballSize = tgzStat.size
    console.log('PASS: Local candidate tarball verified.')
  }

  // ---------------------------------------------------------------------------
  // [Gate 3] Isolated Environment Setup & Assertion
  // ---------------------------------------------------------------------------
  console.log('\n[isolation-setup] Establishing isolated DSH environment...')
  const testRoot = requestedTestRoot
  const testHome = join(testRoot, 'home')
  const testProfile = `smoke-v021-${randomUUID().slice(0, 6)}`
  const profileDir = join(testHome, 'profiles', testProfile)
  const testPort = await findAvailablePort(options.port ? Number(options.port) : 50995)

  let verified = null
  try {
    verified = assertIsolatedDshEnvironment({
      home: testHome,
      profile: testProfile,
      port: testPort,
      profileDir,
      testRoot,
    })
  } catch (error) {
    if (error instanceof IsolationError) {
      console.error('\n' + error.message)
      console.error('Refusing to execute: target failed isolation contract.')
      throw new Error('Smoke preflight failed; see preceding diagnostics')
    }
    throw error
  }
  console.log(ISOLATION_BANNER)
  console.log(`  Test Root:   ${testRoot}`)
  console.log(`  DSH_HOME:    ${testHome}`)
  console.log(`  Profile:     ${testProfile}`)
  console.log(`  Port:        ${testPort}`)

  report.isolation = { testRoot, dshHome: testHome, profile: testProfile, port: testPort }
  const ownedRoot = await createReleaseTestRoot({ requestedRoot: testRoot })
  mkdirSync(join(testHome, 'profiles'), { recursive: true })

  // ---------------------------------------------------------------------------
  // [Gate 4] Profile Initialization & Package Installation
  // ---------------------------------------------------------------------------
  console.log('\n[profile-setup] Initializing DSH Web profile from default template...')
  const isolatedEnv = buildIsolatedEnv(verified, process.env)

  const initArgs = [...dshInvocation.baseArgs, testProfile, '--from-default-profile', 'web', '--dump-config']
  const initRes = spawnSync(dshInvocation.cmd, initArgs, {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
  })
  if (initRes.status !== 0 && !existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`Failed to initialize isolated profile: ${initRes.stderr}`)
  }
  console.log('PASS: Profile initialized with baseline Web bundles.')

  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# Isolated release smoke profile: bind verified test port only.',
      '- id: webserver',
      '  config:',
      "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
      `    port: !!js ctx.webStartup.port ?? ${String(testPort)}`,
      '',
    ].join('\n'),
    'utf8',
  )

  console.log('\n[package-install] Installing plugin into isolated profile via DSH CLI...')
  let installArgs = []
  if (sourceMode === 'local-tarball') {
    installArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'add', localTarballPath]
  } else {
    installArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'add', `${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`, '--registry', OFFICIAL_NPM_REGISTRY]
  }

  const installRes = spawnSync(dshInvocation.cmd, installArgs, {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
  })
  if (installRes.status !== 0) {
    throw new Error(`dsh plugin add failed:\n${installRes.stderr}\n${installRes.stdout}`)
  }
  console.log('PASS: dsh plugin add executed successfully.')

  const installedDir = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
  if (!existsSync(installedDir)) {
    throw new Error(`Expected installed directory not found: ${installedDir}`)
  }

  const stat = lstatSync(installedDir)
  const isSymlink = stat.isSymbolicLink()
  const realInstalledPath = realpathSync.native(installedDir)
  console.log(`Installed Package Location: ${realInstalledPath}`)
  console.log(`  isSymbolicLink/Junction:   ${isSymlink}`)

  if (isSymlink) {
    throw new Error(`PROVENANCE VIOLATION: Installed package is a symlink/junction! Refusing execution.`)
  }

  const repoRootNorm = resolve(REPO_ROOT).toLowerCase()
  const realNorm = resolve(realInstalledPath).toLowerCase()
  if (realNorm === repoRootNorm || realNorm.startsWith(repoRootNorm + sep)) {
    throw new Error(`WORKSPACE LEAKAGE VIOLATION: Installed package resolves inside dev repo: ${realInstalledPath}`)
  }

  const installedPkgJson = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  if (installedPkgJson.name !== EXPECTED_PACKAGE_NAME || installedPkgJson.version !== EXPECTED_VERSION) {
    throw new Error(`Installed manifest mismatch: ${installedPkgJson.name}@${installedPkgJson.version}`)
  }
  report.packageIdentity = { name: installedPkgJson.name, version: installedPkgJson.version, sourceMode, tarballSha256: expectedTarballSha256, installedPath: installedDir, isSymlink }
  report.pluginBundleSha256 = { source: 'ISOLATED_INSTALLED_PACKAGE', host: sha256File(join(installedDir, 'lib/index.js')), client: sha256File(join(installedDir, 'lib/client.js')) }
  console.log(`PASS: Installed package confirmed genuine isolated unpack of version ${installedPkgJson.version}.`)

  // ---------------------------------------------------------------------------
  // [Gate 5] Live DSH Boot & Minimal Acceptance Verification
  // ---------------------------------------------------------------------------
  console.log('\n[smoke-boot] Booting isolated DSH Web instance...')
  let dshInstance = null
  let context = null
  let page = null

  let primaryError
  const verificationEvidence = report.verificationEvidence = {
    lookupHeadword: null,
    lookupSource: null,
    screenshots: {},
  }

  try {
    report.runtime.execution = 'ATTEMPTED'
    report.runtime.invocation.args = [...dshInvocation.baseArgs, '--profile', testProfile, '--no-open', '--port', String(testPort)]
    dshInstance = await bootReleaseDsh(verified, testPort, testRoot, dshInvocation, 90_000, { onChildError: (error) => report.observations.push({ id: 'runtime-child-error', status: 'FAIL', message: String(error.message).replace(/([?&]token=)[^\s&]+/g, '$1REDACTED') }) })
    report.runtime.execution = 'EXECUTED'
    console.log(`DSH running at ${dshInstance.url.replace(/token=.*/, 'token=REDACTED')} (PID: ${dshInstance.child.pid})`)

    const browserUserData = join(testRoot, 'chrome-user-data')
    mkdirSync(browserUserData, { recursive: true })
    context = await chromium.launchPersistentContext(browserUserData, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    })
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()

    // Route interceptor for controlled synthetic word lookups (multiline & scroll testing)
    await page.route('**/api/dsh-word-lookup**', async (route) => {
      const req = route.request()
      if (req.method() === 'POST') {
        const postData = JSON.parse(req.postData() ?? '{}')
        if (postData.query === 'pass') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              found: true,
              query: 'pass',
              headword: 'pass',
              phonetic: '/pɑːs, pæs/',
              meanings: [
                {
                  partOfSpeech: 'v.',
                  translation:
                    'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口\\nvt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准\\nvi. 经过, 穿过, 变化, 终止, 传递, 被通过',
                  definition:
                    'n. (sports) the act of throwing the ball to another member of your team\\nn. a success in a test or exam\\nv. to move past something or someone\\nv. to give something to someone using your hands',
                },
              ],
              forms: [
                { form: 'passed', kind: 'past' },
                { form: 'passing', kind: 'participle' },
              ],
              matchedForm: null,
              examples: [
                { en: 'Time passes quickly.', zh: '光阴似箭。' },
                { en: 'The bill passed in parliament.', zh: '该法案在议会获得通过。' },
              ],
              source: 'ecdict-local',
              settings: { autoDoubleClick: false, autoSelection: false },
            }),
          })
        }
        if (postData.query === 'long-entry') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              found: true,
              query: 'long-entry',
              headword: 'long-entry',
              phonetic: '/lɔːŋ ˈɛntri/',
              meanings: [
                {
                  partOfSpeech: 'n.',
                  translation: Array.from(
                    { length: 12 },
                    (_, i) =>
                      `释义行 ${i + 1}：用于验证长释义卡片垂直滚动的详细中文翻译条目，包含丰富上下文`,
                  ).join('\\n'),
                  definition: Array.from(
                    { length: 12 },
                    (_, i) =>
                      `Definition line ${i + 1}: detailed English explanation sense to enforce card scrollHeight exceeding clientHeight constraint`,
                  ).join('\\n'),
                },
              ],
              forms: [{ form: 'long-entries', kind: 'plural' }],
              matchedForm: null,
              examples: [
                {
                  en: 'Comprehensive test example to ensure container scrollability is verified.',
                  zh: '用于确保容器可滚动性得到严格验证的综合测试用例。',
                },
                {
                  en: 'Second example validating maximum height enforcement.',
                  zh: '验证卡片最大高度限制的第二个示例。',
                },
              ],
              source: 'ecdict-local',
              settings: { autoDoubleClick: false, autoSelection: false },
            }),
          })
        }
      }
      return route.continue()
    })

    console.log('Navigating to DSH Web UI...')
    await page.goto(dshInstance.url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(1000)
    await dismissAllModals(page)

    // Acceptance 1: Plugin loads cleanly
    console.log('\n--- [Acceptance 1] Checking Plugin Diagnostics API & Load Status ---')
    const diagReady = await page.waitForFunction(() => {
      return typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null
    }, { timeout: 10000 }).then(() => true).catch(() => false)

    if (!diagReady) {
      throw new Error('Plugin failed to load: window.__DSH_WORD_LOOKUP__ diagnostics interface not found')
    }
    report.observations.push({ id: 'pluginLoaded', status: 'PASS' })
    console.log('PASS: Plugin loaded cleanly, window.__DSH_WORD_LOOKUP__ exposed.')

    // Acceptance 2: Settings entry appears in UI & check updated status badge
    console.log('\n--- [Acceptance 2] Verifying Settings Navigation & Section Rendering ---')
    await page.keyboard.press('Control+Alt+,')
    await page.waitForTimeout(600)
    if ((await page.locator('nav button').count()) === 0) {
      const settingsTrigger = page.locator('button[aria-label="Settings"], button:has-text("设置")').first()
      if (await settingsTrigger.isVisible().catch(() => false)) {
        await settingsTrigger.click({ force: true })
      }
    }
    await page.waitForSelector('nav button', { timeout: 8000 })
    const dictNavButton = page.locator('nav button:has-text("词典"), nav button:has-text("Dictionary")')
    await dictNavButton.waitFor({ state: 'visible', timeout: 5000 })
    report.observations.push({ id: 'settingsNavVisible', status: 'PASS' })
    console.log('PASS: Settings navigation item "词典/Dictionary" visible.')

    await dictNavButton.click()
    const settingsSection = page.locator('.dsh-wl-settings')
    await settingsSection.waitFor({ state: 'visible', timeout: 5000 })
    report.observations.push({ id: 'settingsSectionVisible', status: 'PASS' })
    console.log('PASS: Plugin settings panel (.dsh-wl-settings) successfully rendered.')

    // Check Settings badges and description updates
    await page.waitForTimeout(800)
    const settingsAudit = await page.evaluate(() => {
      const root = document.querySelector('.dsh-wl-settings') || document.body
      const text = root.textContent || ''
      const hasPhase7A8 = text.includes('Phase 7A.8 开放') || text.includes('Phase 7A.8')
      const hasSupportedBadge = text.includes('已支持')
      const hasUpdatedDesc = text.includes('请在上方“自定义 SQLite 词典管理”区域配置并挂载使用')
      return { hasPhase7A8, hasSupportedBadge, hasUpdatedDesc, hasCustomRow: text.includes('自定义外部 SQLite 词典') }
    })

    if (!settingsAudit.hasPhase7A8 && settingsAudit.hasSupportedBadge && settingsAudit.hasUpdatedDesc && settingsAudit.hasCustomRow) {
      report.observations.push({ id: 'settingsUpdatedBadgesVerified', status: 'PASS' })
      console.log('PASS: Settings UI accurately shows "已支持" and obsolete "Phase 7A.8 开放" is absent.')
    } else {
      throw new Error(`Settings UI text audit failed: ${JSON.stringify(settingsAudit)}`)
    }

    const settingsShot = join(screenshotsDir, '04-settings-ui-support-badge.png')
    await page.screenshot({ path: settingsShot, fullPage: true })
    verificationEvidence.screenshots.settings = settingsShot

    // Acceptance 3: Default Fixture mode normal
    console.log('\n--- [Acceptance 3] Verifying Deterministic Fixture Mode ---')
    const dictStatus = await page.evaluate(async () => {
      const res = await window.fetch('api/dsh-word-lookup/dictionary/status')
      return await res.json()
    })
    console.log('Dictionary Status:', dictStatus)
    if (dictStatus?.activeMode === 'fixture' && dictStatus?.installed === false) {
      report.observations.push({ id: 'fixtureModeActive', status: 'PASS' })
      console.log('PASS: Initial dictionary mode is strictly "fixture" (installed: false).')
    } else {
      throw new Error(`Unexpected dictionary status: ${JSON.stringify(dictStatus)}`)
    }

    // Acceptance 4: Legal word query test (Real Fixture Lookup: "derive")
    console.log('\n--- [Acceptance 4] Executing Real Word Lookup Query ("derive") ---')
    const lookupResponse = await page.evaluate(async () => {
      const res = await window.fetch('api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      })
      return await res.json()
    })
    console.log('Word Lookup Response:', lookupResponse)
    if (
      lookupResponse?.found === true &&
      lookupResponse?.headword === 'derive' &&
      lookupResponse?.source === 'sqlite-fixture'
    ) {
      report.observations.push({ id: 'lookupSuccessful', status: 'PASS' })
      report.classification.fixtureQuery = 'EXECUTED'
      verificationEvidence.lookupHeadword = lookupResponse.headword
      verificationEvidence.lookupSource = lookupResponse.source
      console.log(`PASS: Lookup succeeded for "${lookupResponse.headword}" via ${lookupResponse.source}.`)
    } else {
      throw new Error(`Word lookup failed: ${JSON.stringify(lookupResponse)}`)
    }

    // Acceptance 5: Auto-double-click and auto-selection switches default OFF
    console.log('\n--- [Acceptance 5] Verifying Gesture Trigger Gates Default OFF ---')
    const dblSwitch = page.locator('#switch-auto-double-click')
    const selSwitch = page.locator('#switch-auto-selection')
    const dblChecked = await dblSwitch.getAttribute('aria-checked')
    const selChecked = await selSwitch.getAttribute('aria-checked')
    const hostGates = await page.evaluate(() => window.__DSH_WORD_LOOKUP__?.gates?.())

    console.log(`  #switch-auto-double-click aria-checked: ${dblChecked}`)
    console.log(`  #switch-auto-selection    aria-checked: ${selChecked}`)
    console.log(`  window.__DSH_WORD_LOOKUP__.gates():     ${JSON.stringify(hostGates)}`)

    if (dblChecked === 'false' && hostGates?.autoDoubleClick === false) {
      report.observations.push({ id: 'autoDoubleClickDefaultOff', status: 'PASS' })
    } else {
      throw new Error(`autoDoubleClick not default off: aria-checked=${dblChecked}, gates=${JSON.stringify(hostGates)}`)
    }

    if (selChecked === 'false' && hostGates?.autoSelection === false) {
      report.observations.push({ id: 'autoSelectionDefaultOff', status: 'PASS' })
    } else {
      throw new Error(`autoSelection not default off: aria-checked=${selChecked}, gates=${JSON.stringify(hostGates)}`)
    }
    console.log('PASS: Both gesture switches default strictly to OFF.')

    // Close settings dialog to test card overlays
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // Acceptance 6: FMT-01 Card Multiline Rendering & POS Badge Deduplication
    console.log('\n--- [Acceptance 6] Verifying Card Multiline Formatting & POS Dedup ---')
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('pass', 'shortcut')
    })
    await page.waitForSelector('[data-dsh-word-lookup="card"]', { timeout: 10_000 })
    await page.waitForSelector('[data-dsh-word-lookup="translation-line"]', { timeout: 10_000 })

    const cardMetrics = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const transLines = Array.from(document.querySelectorAll('[data-dsh-word-lookup="translation-line"]'))
      const defLines = Array.from(document.querySelectorAll('[data-dsh-word-lookup="definition-line"]'))
      const cardRect = card.getBoundingClientRect()
      const transRects = transLines.map((el) => ({
        text: el.textContent.trim(),
        top: el.getBoundingClientRect().top,
        height: el.getBoundingClientRect().height,
      }))
      const defRects = defLines.map((el) => ({
        text: el.textContent.trim(),
        top: el.getBoundingClientRect().top,
        height: el.getBoundingClientRect().height,
      }))
      return {
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
        transLineCount: transLines.length,
        defLineCount: defLines.length,
        transRects,
        defRects,
        hasLiteralEscapeInText: card.textContent.includes('\\n'),
        firstTransLine: transLines[0]?.textContent.trim() ?? '',
        hasDuplicatePos: (transLines[0]?.textContent ?? '').includes('v.n.'),
      }
    })

    console.log(`Card dimensions: ${cardMetrics.cardWidth}px x ${cardMetrics.cardHeight}px`)
    console.log(`Translation lines count: ${cardMetrics.transLineCount}`)
    console.log(`Definition lines count: ${cardMetrics.defLineCount}`)
    console.log(`Literal \\n in text: ${cardMetrics.hasLiteralEscapeInText}`)

    report.observations.push(...formattingObservations(cardMetrics))

    const cardNormalShot = join(screenshotsDir, '01-card-multiline-normal-360px.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNormalShot })
    verificationEvidence.screenshots.cardNormal = cardNormalShot

    // Narrow Viewport test (320px)
    console.log('\n--- [Acceptance 7] Testing Narrow Viewport Responsiveness ---')
    await page.setViewportSize({ width: 320, height: 600 })
    await page.waitForTimeout(500)
    const narrowCardWidth = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      return card.getBoundingClientRect().width
    })
    console.log(`Narrow viewport card width: ${narrowCardWidth}px (<= 320px)`)
    const narrowPassed = Number.isFinite(narrowCardWidth) && narrowCardWidth > 0 && narrowCardWidth <= 320
    report.observations.push({ id: 'narrowViewportVerified', status: narrowPassed ? 'PASS' : 'FAIL', narrowCardWidth })
    if (narrowPassed) {
      console.log('PASS: Card layout adapts cleanly to narrow 320px viewport without horizontal overflow.')
    } else {
      throw new Error(`Card width ${narrowCardWidth}px exceeds 320px viewport limit`)
    }
    const cardNarrowShot = join(screenshotsDir, '02-card-multiline-narrow-viewport.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNarrowShot })
    verificationEvidence.screenshots.cardNarrow = cardNarrowShot

    // Reset viewport and dismiss card
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // Long entry scroll test
    console.log('\n--- [Acceptance 8] Testing Long Entry Scrollability ---')
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('long-entry', 'shortcut')
    })
    await page.waitForSelector('[data-dsh-word-lookup="card"]', { timeout: 10_000 })
    await page.waitForSelector('[data-dsh-word-lookup="translation-line"]', { timeout: 10_000 })
    await page.waitForTimeout(400)

    const scrollInfo = await page.evaluate(async () => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const beforeScroll = card.scrollTop
      const scrollHeight = card.scrollHeight
      const clientHeight = card.clientHeight
      const scrollWidth = card.scrollWidth
      const clientWidth = card.clientWidth

      card.scrollTop = 120
      await new Promise((r) => requestAnimationFrame(r))
      const afterScroll = card.scrollTop

      return {
        scrollHeight,
        clientHeight,
        scrollWidth,
        clientWidth,
        beforeScroll,
        afterScroll,
        isScrollable: scrollHeight > clientHeight,
        didScroll: afterScroll > beforeScroll,
        withinMaxHeightLimit: clientHeight <= 440,
        noHorizontalOverflow: scrollWidth <= clientWidth + 1,
      }
    })

    console.log(`Scrollability: scrollHeight=${scrollInfo.scrollHeight}, clientHeight=${scrollInfo.clientHeight}`)
    console.log(`Scroll action: before=${scrollInfo.beforeScroll}, after=${scrollInfo.afterScroll}`)

    const scrollRow = scrollObservation(scrollInfo, 'scrollabilityVerified')
    report.observations.push(scrollRow)
    if (scrollRow.status === 'PASS') {
      console.log('PASS: Long entry scrolling strictly verified (scrollHeight > clientHeight, scrollTop moved, maxHeight <= 440px).')
    } else {
      throw new Error(`Scrollability verification failed: ${JSON.stringify(scrollInfo)}`)
    }

    const cardScrollShot = join(screenshotsDir, '03-card-multiline-scroll.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardScrollShot })
    verificationEvidence.screenshots.cardScroll = cardScrollShot

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Startup dictionary status cannot prove absence of later network activity.
    report.startupDictionaryStatus = { installed: dictStatus.installed, canInstall: dictStatus.canInstall }
    report.observations.push({ id: 'zero-auto-download', status: 'NOT_VERIFIED', reason: 'Full observation-window outbound network proof was not collected' })

    // Close browser & shutdown DSH for uninstallation test
    await context.close()
    context = null
    await stopDsh(dshInstance.child, testPort)
    dshInstance = null

    // Acceptance 10: Clean uninstallation test
    if (options['skip-uninstall'] !== 'true') {
      console.log('\n--- [Acceptance 10] Verifying Clean Uninstallation Lifecycle ---')
      console.log('Executing dsh plugin remove...')
      const removeArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'remove', EXPECTED_PACKAGE_NAME]
      const removeRes = spawnSync(dshInvocation.cmd, removeArgs, {
        cwd: testRoot,
        env: isolatedEnv,
        encoding: 'utf8',
        shell: !dshInvocation.isNodeScript && process.platform === 'win32',
      })
      if (removeRes.status !== 0) {
        throw new Error(`dsh plugin remove failed:\n${removeRes.stderr}\n${removeRes.stdout}`)
      }
      console.log('PASS: Plugin uninstalled via DSH CLI.')

      console.log('Rebooting isolated DSH without plugin to verify clean removal...')
      dshInstance = await bootReleaseDsh(verified, testPort, testRoot, dshInvocation, 90_000, { onChildError: (error) => report.observations.push({ id: 'runtime-child-error', status: 'FAIL', message: String(error.message).replace(/([?&]token=)[^\s&]+/g, '$1REDACTED') }) })

      context = await chromium.launchPersistentContext(browserUserData, {
        headless: true,
        viewport: { width: 1280, height: 800 },
      })
      page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()
      await page.goto(dshInstance.url, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(1000)

      const expectedOrigin = new URL(dshInstance.url).origin
      const proof = await collectUninstallProof({
        service: { origin: expectedOrigin, identified: dshInstance.child.exitCode === null && dshInstance.child.signalCode === null && new URL(expectedOrigin).hostname === '127.0.0.1' && Number(new URL(expectedOrigin).port) === testPort },
        routeContract: report.runtime.routeContract,
        probe: (rpcId) => probeUninstallPage(page, rpcId),
        anonymousProbe: async () => {
          try {
            const response = await fetch(new URL('/api/pluginInventory/list', expectedOrigin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error' })
            await response.body?.cancel()
            return { kind: 'response', status: response.status }
          } catch { return { kind: 'transport-error', message: 'Anonymous authentication control failed' } }
        },
      })
      report.uninstallProof = proof
      const uninstallStatus = evaluateUninstallProof(proof)
      report.observations.push({ id: 'uninstallationClean', status: uninstallStatus })
      console.log('Uninstall observation: ' + uninstallStatus)

      await context.close()
      context = null
      await stopDsh(dshInstance.child, testPort)
      dshInstance = null
    } else {
      report.observations.push({ id: 'uninstallationClean', status: 'NOT_EXECUTED', reason: '--skip-uninstall was declared' })
    }
  } catch (error) {
    primaryError = error
  } finally {
    await cleanupReleaseSmokeResources({ context, dshInstance, downloadedTarballPath, testPort }, {}, primaryError)
  }

  // ---------------------------------------------------------------------------
  // [Gate 6] Record Final Smoke Execution Report & Clean Up
  // ---------------------------------------------------------------------------
  const durationMs = Date.now() - startTime
  Object.assign(report, {
    durationMs, mode: sourceMode,
    packageIdentity: { name: EXPECTED_PACKAGE_NAME, version: EXPECTED_VERSION, sourceMode, tarballSha256: expectedTarballSha256, installedPath: installedDir, isSymlink },
    isolation: { testRoot, dshHome: testHome, profile: testProfile, port: testPort },
  })
  // Persist observations outside the deletion range before invoking TEST001 cleanup.
  // Final verdict is still written by the shared finalizer, including cleanup failures.
  const beforeCleanupPath = join(evidenceDir, 'observations-before-cleanup.json')
  writeFileSync(beforeCleanupPath, JSON.stringify({ ...report, verdict: 'INCOMPLETE', cleanup: 'PENDING' }, null, 2), { encoding: 'utf8', flag: 'wx' })
  if (options['keep-evidence'] !== 'true') {
    await cleanupReleaseTestRoot(ownedRoot, { children: [...ownedDshChildren], ports: [testPort], evidencePaths: [evidenceDir, screenshotsDir, report.reportPath, beforeCleanupPath] })
    report.cleanup = { status: 'PASS' }
  } else {
    report.cleanup = { status: 'RETAINED', reason: '--keep-evidence' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseSmoke().then(({ exitCode }) => { process.exitCode = exitCode }).catch((error) => {
    console.error('Smoke report could not be saved:', error.message)
    process.exitCode = 1
  })
}
