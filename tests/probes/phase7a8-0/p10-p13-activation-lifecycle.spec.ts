import { describe, expect, it } from 'vitest'
import { runActivationLifecycleProbes } from '../../../scripts/probes/phase7a8-0/p10-p13-activation-lifecycle.mjs'

describe('Phase 7A.8.0 Probes P10 - P13: Activation Transaction Contract & Lifecycle', () => {
  it('executes probes P10 through P13 and verifies state transition invariants', async () => {
    const results = await runActivationLifecycleProbes()
    expect(results).toHaveLength(4)

    for (const r of results) {
      expect(r.status, `Probe ${r.probeId} failed: ${JSON.stringify(r.details)}`).toBe('PASS')
    }

    const p10 = results.find((r) => r.probeId === 'P10')!
    expect(p10.details.allExecutedPassed).toBe(true)
    expect(p10.details.totalScenariosInMatrix).toBe(13)
    expect(p10.details.scenariosExecutedCount).toBe(11)
    expect(p10.details.scenariosUnexecutedCount).toBe(2)

    // Verify S05 genuine pre-state and handle release
    const s05 = p10.details.scenarios.find((s: any) => s.scenarioId === 'S05')!
    expect(s05.observedState.PRE_ACTIVE_MODE).toBe('managed-ecdict')
    expect(s05.observedState.PRE_ACTIVE_IDENTITY).toBe('initial-db')
    expect(s05.observedState.POST_ACTIVE_MODE).toBe('managed-ecdict')
    expect(s05.observedState.POST_ACTIVE_IDENTITY).toBe('initial-db')
    expect(s05.observedState.HANDLE_STATE.oldDictionaryActiveAndFunctional).toBe(true)
    expect(s05.observedState.HANDLE_STATE.candidateHandleClosedOnFailure).toBe(true)

    // Verify S04 and S12 are design-only
    const s04 = p10.details.scenarios.find((s: any) => s.scenarioId === 'S04')!
    expect(s04.evidenceLevel).toBe('DESIGN_ONLY')
    expect(s04.verdict).toBe('NOT_EXECUTED')

    const s12 = p10.details.scenarios.find((s: any) => s.scenarioId === 'S12')!
    expect(s12.evidenceLevel).toBe('DESIGN_ONLY')
    expect(s12.verdict).toBe('NOT_EXECUTED')

    const p11 = results.find((r) => r.probeId === 'P11')!
    expect(p11.details.legacyMetadataCompatibility).toBe(true)
    expect(p11.details.currentCodeStrictlyRejectsCustom).toBe(true)

    const p12 = results.find((r) => r.probeId === 'P12')!
    expect(p12.details.operationManagerGating.initialCanInstall).toBe(true)
    expect(p12.details.operationManagerGating.initialCanRemove).toBe(false)
    expect(p12.details.operationManagerGating.canRemoveAfterInstall).toBe(true)
    expect(p12.details.modeSourceAlignment.customManagerActivationThrew).toBe(true)

    const p13 = results.find((r) => r.probeId === 'P13')!
    expect(p13.details.lateActivationRejected).toBe(true)
    expect(p13.details.inFlightCancellation.hookTriggered).toBe(true)
    expect(p13.details.inFlightCancellation.activationRejectedOnDispose).toBe(true)
    expect(p13.details.inFlightCancellation.candidateHandleClosedAndUnlinkedOnWindows).toBe(true)
    expect(p13.details.drainLifecycle.withinTimeoutSla).toBe(true)
  })
})
