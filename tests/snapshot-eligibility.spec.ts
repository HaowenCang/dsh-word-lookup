import { describe, expect, it } from 'vitest'
import type { CustomSnapshotSummary } from '../src/shared/dictionary-management-protocol.js'
import { isSnapshotActivatable } from '../src/client/settings/snapshot-eligibility.js'

describe('BUG006 pure snapshot activation contract', () => {
  it.each([
    [true, undefined, true], [true, false, true], [true, true, false],
    [false, undefined, false], [false, false, false], [false, true, false],
    [undefined, undefined, false], [null, undefined, false], ['true', undefined, false],
    [1, undefined, false], ['unknown', false, false],
  ])('isValid=%s corrupt=%s => %s', (isValid, corrupt, expected) => {
    const summary = { isValid, ...(corrupt === undefined ? {} : { corrupt }) } as CustomSnapshotSummary
    expect(isSnapshotActivatable(summary)).toBe(expected)
  })
  it('leaves activity and busy capability composition to callers', () => {
    expect(isSnapshotActivatable({ isValid: true, isActive: true } as CustomSnapshotSummary)).toBe(true)
  })
})
