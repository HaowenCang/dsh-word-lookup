import { describe, expect, it } from 'vitest'
import {
  evaluateP05Predicate,
  runSqliteSafetyProbes,
} from '../../../scripts/probes/phase7a8-0/p01-p07-sqlite-safety.mjs'

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
    expect(p05.details.deleteSucceedsAfterClose).toBe(true)

    const p06 = results.find((r) => r.probeId === 'P06')!
    expect(p06.details.userDbPreserved).toBe(true)
    expect(p06.details.userDbOutsideStorage).toBe(true)

    const p07 = results.find((r) => r.probeId === 'P07')!
    expect(p07.details.conclusion.FINGERPRINT_SUFFICIENT_FOR_TOCTOU_ELIMINATION).toBe('NO')
    expect(p07.details.fingerprintCheckAnalysis.fingerprintBypassDemonstrated).toBe(true)
    expect(p07.details.fingerprintCheckAnalysis.sizeMatch).toBe(true)
    expect(p07.details.fingerprintCheckAnalysis.headerSha256Match).toBe(true)
    expect(p07.details.fingerprintCheckAnalysis.fullContentMatch).toBe(false)
  })

  describe('R03: P05 Operator Precedence & Counterexample Guard', () => {
    const validBaseline = {
      unicodeValid: true,
      missingHandledCleanly: true,
      directoryHandledCleanly: true,
      deleteFailedWhileLocked: true,
      deleteLockError: 'EBUSY',
      deleteSucceededAfterClose: true,
    }

    it('passes when all conditions and valid lock error (EBUSY) hold', () => {
      expect(evaluateP05Predicate(validBaseline)).toBe(true)
    })

    it('passes when valid lock error is EPERM', () => {
      expect(evaluateP05Predicate({ ...validBaseline, deleteLockError: 'EPERM' })).toBe(true)
    })

    it('fails when deleteLockError is EBUSY but other conditions fail (EBUSY alone is insufficient)', () => {
      // Counterexample 1: unicode handling failed
      expect(evaluateP05Predicate({ ...validBaseline, unicodeValid: false })).toBe(false)
      // Counterexample 2: missing file check failed
      expect(evaluateP05Predicate({ ...validBaseline, missingHandledCleanly: false })).toBe(false)
      // Counterexample 3: directory check failed
      expect(evaluateP05Predicate({ ...validBaseline, directoryHandledCleanly: false })).toBe(false)
    })

    it('fails if delete after close does not succeed (resource leak / handle not released)', () => {
      expect(evaluateP05Predicate({ ...validBaseline, deleteSucceededAfterClose: false })).toBe(false)
    })

    it('fails if delete while open did not fail (Windows lock did not protect open handle)', () => {
      expect(evaluateP05Predicate({ ...validBaseline, deleteFailedWhileLocked: false })).toBe(false)
    })

    it('fails when deleteLockError is an unrecognized error code', () => {
      expect(evaluateP05Predicate({ ...validBaseline, deleteLockError: 'ENOENT' })).toBe(false)
      expect(evaluateP05Predicate({ ...validBaseline, deleteLockError: null })).toBe(false)
    })
  })
})
