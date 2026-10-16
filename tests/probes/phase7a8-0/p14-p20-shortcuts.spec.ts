import { describe, expect, it } from 'vitest'
import { runShortcutsProbes } from '../../../scripts/probes/phase7a8-0/p14-p20-shortcuts.mjs'

describe('Phase 7A.8.0 Probes P14 - P20: DSH Shortcuts Service Capabilities', () => {
  it('executes probes P14 through P20 and verifies shortcut contract invariants', async () => {
    const results = await runShortcutsProbes()
    expect(results).toHaveLength(7)

    for (const r of results) {
      expect(r.status, `Probe ${r.probeId} failed: ${JSON.stringify(r.details)}`).toBe('PASS')
    }

    const p14 = results.find((r) => r.probeId === 'P14')!
    expect(p14.details.PUBLIC_SHORTCUT_OVERRIDE_API).toContain('ctx.shortcuts.edit')

    const p15 = results.find((r) => r.probeId === 'P15')!
    expect(p15.details.modified).toBe(false)
    expect(p15.details.effectiveBinding.code).toBe('KeyL')

    const p16 = results.find((r) => r.probeId === 'P16')!
    expect(p16.details.saveStatus).toBe('saved')
    expect(p16.details.modified).toBe(true)

    const p17 = results.find((r) => r.probeId === 'P17')!
    expect(p17.details.storageKey).toBe('dsh.keybindings.v1')
    expect(p17.details.recoveredAfterRestart).toBe(true)

    const p18 = results.find((r) => r.probeId === 'P18')!
    expect(p18.details.collisionDetected).toBe(true)

    const p19 = results.find((r) => r.probeId === 'P19')!
    expect(p19.details.clearedBindingIsNull).toBe(true)
    expect(p19.details.resetRestoresDefaultBinding).toBe(true)

    const p20 = results.find((r) => r.probeId === 'P20')!
    expect(p20.details.platformMatrix['web:windows'].supportsPrimaryShiftL).toBe(true)
    expect(p20.details.platformMatrix['web:linux'].supportsPrimaryShiftL).toBe(false)
  })
})
