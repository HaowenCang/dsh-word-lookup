import { describe, expect, it } from 'vitest'
import { runEventLoopAndWorkerProbes } from '../../../scripts/probes/phase7a8-0/p08-p09-event-loop-worker.mjs'

describe('Phase 7A.8.0 Probes P08 - P09: Event-Loop Delay & Worker Thread Isolation', () => {
  it('executes probes P08 and P09 and verifies worker isolation invariants', async () => {
    const results = await runEventLoopAndWorkerProbes()
    expect(results).toHaveLength(2)

    for (const r of results) {
      expect(r.status, `Probe ${r.probeId} failed: ${JSON.stringify(r.details)}`).toBe('PASS')
    }

    const p08 = results.find((r) => r.probeId === 'P08')!
    expect(p08.details.slaEvaluation.rssOk).toBe(true)
    expect(p08.details.slaEvaluation.p99Ok).toBe(true)

    const p09 = results.find((r) => r.probeId === 'P09')!
    expect(p09.details.normalVerificationSuccess).toBe(true)
    expect(p09.details.timeoutTerminationWorked).toBe(true)
    expect(p09.details.handleReleasedOnWorkerTerminate).toBe(true)
  })
})
