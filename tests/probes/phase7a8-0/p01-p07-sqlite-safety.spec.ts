import { describe, expect, it } from 'vitest'
import { runSqliteSafetyProbes } from '../../../scripts/probes/phase7a8-0/p01-p07-sqlite-safety.mjs'

describe('Phase 7A.8.0 Probes P01 - P07: SQLite Safety & File Contract', () => {
  it('executes probes P01 through P07 and verifies contract invariants', async () => {
    const results = await runSqliteSafetyProbes()
    expect(results).toHaveLength(7)

    for (const r of results) {
      expect(r.status, `Probe ${r.probeId} failed: ${JSON.stringify(r.details)}`).toBe('PASS')
    }

    // Verify key architectural findings
    const p02 = results.find((r) => r.probeId === 'P02')!
    expect(p02.details.currentVerifierCheckedColumns).toBe(false)
    expect(p02.details.lookupThrewOnMissingCols).toBe(true)

    const p03 = results.find((r) => r.probeId === 'P03')!
    expect(p03.details.trustedSchemaDefault).toBe(1)
    expect(p03.details.trustedSchemaCanBeDisabled).toBe(true)
    expect(p03.details.fileMutated).toBe(false)

    const p05 = results.find((r) => r.probeId === 'P05')!
    expect(p05.details.windowsLockPreventsDeleteWhileOpen).toBe(true)

    const p06 = results.find((r) => r.probeId === 'P06')!
    expect(p06.details.userDbPreserved).toBe(true)
    expect(p06.details.userDbOutsideStorage).toBe(true)

    const p07 = results.find((r) => r.probeId === 'P07')!
    expect(p07.details.mtimeChangedOnSwap).toBe(true)
  })
})
