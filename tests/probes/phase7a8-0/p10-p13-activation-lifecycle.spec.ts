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
    expect(p10.details.allPassed).toBe(true)

    const p11 = results.find((r) => r.probeId === 'P11')!
    expect(p11.details.legacyMetadataCompatibility).toBe(true)
    expect(p11.details.currentCodeStrictlyRejectsCustom).toBe(true)

    const p12 = results.find((r) => r.probeId === 'P12')!
    expect(p12.details.customManagerActivationThrew).toBe(true)

    const p13 = results.find((r) => r.probeId === 'P13')!
    expect(p13.details.coordinatorMarkedDisposed).toBe(true)
  })
})
