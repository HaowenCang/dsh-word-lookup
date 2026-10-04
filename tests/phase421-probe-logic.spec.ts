/**
 * Pure-logic regression tests for the Phase 4.2.1/4.2.2 native-input probe.
 *
 * Exercises the three confirmed defects and their invariants:
 * - DEFECT A: offsetPx survives row projection and fail-loud on missing offsetPx
 * - DEFECT B: single-origin monotonic gap scheduling; out-of-tolerance gaps fail
 * - DEFECT C: row freshness requires detail === 1; multi-click contamination rejected
 * - Positive/negative validity controls require correct click multiplicity and dblclick flags.
 */

import { describe, expect, it } from 'vitest'

import {
  assertSpatialRowsIntegrity,
  calculateGapError,
  calculateGapWait,
  calculateRowCooldownMs,
  DEFAULT_TIMING_TOLERANCE_MS,
  evaluateSpatialControl,
  evaluateTimeoutControl,
  findEmpiricalSpatialBoundary,
  isGapWithinTolerance,
  validateRowFreshness,
} from '../scripts/phase421-instrument-logic.mjs'

describe('Phase 4.2.2 native-input probe pure logic', () => {
  describe('DEFECT A — offsetPx preservation and spatial row integrity', () => {
    it('offsetPx survives row projection', () => {
      const spec = { id: 'S-060', offsetPx: 60, distancePx: 0 }
      const projected = {
        id: spec.id,
        offsetPx: spec.offsetPx ?? null,
      }
      expect(projected.offsetPx).toBe(60)

      const zeroSpec = { id: 'S-000', offsetPx: 0, distancePx: 0 }
      const zeroProjected = {
        id: zeroSpec.id,
        offsetPx: zeroSpec.offsetPx ?? null,
      }
      expect(zeroProjected.offsetPx).toBe(0)

      const nonSpatialSpec = { id: 'T-090', distancePx: 0 }
      const nonSpatialProjected = {
        id: nonSpatialSpec.id,
        offsetPx: (nonSpatialSpec as { offsetPx?: number }).offsetPx ?? null,
      }
      expect(nonSpatialProjected.offsetPx).toBeNull()
    })

    it('assertSpatialRowsIntegrity throws fail-loud on missing or non-numeric offsetPx', () => {
      const invalidRows = [
        { id: 'S-000', offsetPx: 0 },
        { id: 'S-001', offsetPx: null }, // defective row
      ]
      expect(() => assertSpatialRowsIntegrity(invalidRows as any)).toThrow(
        /BLOCKED — INSTRUMENT INTERNAL ERROR.*missing numeric offsetPx/,
      )

      const missingPropRows = [
        { id: 'S-000', offsetPx: 0 },
        { id: 'S-001' },
      ]
      expect(() => assertSpatialRowsIntegrity(missingPropRows as any)).toThrow(
        /BLOCKED — INSTRUMENT INTERNAL ERROR.*missing numeric offsetPx/,
      )

      const validRows = [
        { id: 'S-000', offsetPx: 0 },
        { id: 'S-060', offsetPx: 60 },
      ]
      expect(assertSpatialRowsIntegrity(validRows)).toBe(true)
    })
  })

  describe('DEFECT B — single clock origin and gap scheduling', () => {
    it('schedules monotonic gap wait using shared trace origin', () => {
      const firstReleaseMs = 1250.5
      const requestedGapMs = 410.0
      const currentTraceMs = 1265.0 // 14.5 ms after release

      const wait = calculateGapWait(firstReleaseMs, requestedGapMs, currentTraceMs)
      expect(wait.targetTraceMs).toBe(1660.5)
      expect(wait.remainingMs).toBe(395.5)
      expect(wait.canWait).toBe(true)
    })

    it('410 ms requested cannot validate as 10 ms measured', () => {
      const requested = 410.0
      const measured = 10.0
      const error = calculateGapError(requested, measured)
      expect(error).toBe(-400.0)
      expect(isGapWithinTolerance(requested, measured, DEFAULT_TIMING_TOLERANCE_MS)).toBe(false)
      expect(isGapWithinTolerance(requested, measured, 50)).toBe(false)
    })

    it('700 ms requested cannot validate as 36 ms measured', () => {
      const requested = 700.0
      const measured = 36.6
      const error = calculateGapError(requested, measured)
      expect(error).toBe(-663.4)
      expect(isGapWithinTolerance(requested, measured, DEFAULT_TIMING_TOLERANCE_MS)).toBe(false)
      expect(isGapWithinTolerance(requested, measured, 50)).toBe(false)
    })

    it('accepts measured gap within tolerance', () => {
      expect(isGapWithinTolerance(410.0, 412.5, 30)).toBe(true)
      expect(isGapWithinTolerance(700.0, 698.0, 30)).toBe(true)
      expect(isGapWithinTolerance(90.0, 91.2, 30)).toBe(true)
    })
  })

  describe('DEFECT C — row freshness and click sequence isolation', () => {
    it('first detail 3 invalidates a fresh row', () => {
      const contaminatedRow = {
        id: 'T-ABOVE',
        first: { mouseDownDetail: [3] },
        second: { mouseDownDetail: [4] },
      }
      const validation = validateRowFreshness(contaminatedRow)
      expect(validation.valid).toBe(false)
      expect(validation.detail).toBe(3)
      expect(validation.reason).toContain('expected 1')
    })

    it('accepts first detail 1 as fresh', () => {
      const freshRow = {
        id: 'T-BELOW',
        first: { mouseDownDetail: [1] },
        second: { mouseDownDetail: [2] },
      }
      const validation = validateRowFreshness(freshRow)
      expect(validation.valid).toBe(true)
      expect(validation.detail).toBe(1)
    })

    it('calculates row cooldown based on GetDoubleClickTime + safety margin', () => {
      const doubleClickTimeMs = 500
      const cooldown = calculateRowCooldownMs(doubleClickTimeMs, 100)
      expect(cooldown).toBe(600)
    })
  })

  describe('Validity control evaluations', () => {
    it('positive timeout requires 1 -> 2 with dblclick=true and valid gap', () => {
      const validTimeoutRows = [
        {
          id: 'T-BELOW',
          requestedGapMs: 410,
          measuredGapMs: 412,
          gapErrorMs: 2,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true },
        },
        {
          id: 'T-ABOVE',
          requestedGapMs: 700,
          measuredGapMs: 703,
          gapErrorMs: 3,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [1], emittedDoubleClick: false },
        },
      ]
      const evalResult = evaluateTimeoutControl(validTimeoutRows, 500, 30)
      expect(evalResult.pass).toBe(true)
      expect(evalResult.belowTimeout.valid).toBe(true)
      expect(evalResult.aboveTimeout.valid).toBe(true)

      // Detail 1 -> 1 on positive control must fail
      const badPositiveRows = [
        {
          id: 'T-BELOW',
          requestedGapMs: 410,
          measuredGapMs: 412,
          gapErrorMs: 2,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [1], emittedDoubleClick: false }, // should have been 2 & true
        },
        validTimeoutRows[1],
      ]
      expect(evaluateTimeoutControl(badPositiveRows, 500, 30).pass).toBe(false)
    })

    it('negative timeout requires 1 -> 1 with dblclick=false and valid gap', () => {
      // If T-ABOVE has 3 -> 4 (old contamination), it must fail
      const contaminatedNegativeRows = [
        {
          id: 'T-BELOW',
          requestedGapMs: 410,
          measuredGapMs: 412,
          gapErrorMs: 2,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true },
        },
        {
          id: 'T-ABOVE',
          requestedGapMs: 700,
          measuredGapMs: 703,
          gapErrorMs: 3,
          first: { mouseDownDetail: [3] }, // contaminated!
          second: { mouseDownDetail: [4], emittedDoubleClick: false },
        },
      ]
      const evalResult = evaluateTimeoutControl(contaminatedNegativeRows, 500, 30)
      expect(evalResult.pass).toBe(false)
      expect(evalResult.aboveTimeout.valid).toBe(false)
      expect(evalResult.reasons.some((r: string) => r.includes('freshness failed'))).toBe(true)

      // If T-ABOVE has dblclick=true, it must fail
      const dblClickNegativeRows = [
        contaminatedNegativeRows[0],
        {
          id: 'T-ABOVE',
          requestedGapMs: 700,
          measuredGapMs: 703,
          gapErrorMs: 3,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true }, // should have been 1 & false
        },
      ]
      expect(evaluateTimeoutControl(dblClickNegativeRows, 500, 30).pass).toBe(false)
    })

    it('spatial positive requires 1 -> 2 with dblclick=true', () => {
      const spatialRows = [
        {
          id: 'S-000',
          offsetPx: 0,
          gapErrorMs: 1,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true },
        },
        {
          id: 'S-060',
          offsetPx: 60,
          gapErrorMs: 1,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [1], emittedDoubleClick: false },
        },
      ]
      const evalResult = evaluateSpatialControl(spatialRows, 60, 30)
      expect(evalResult.pass).toBe(true)
      expect(evalResult.samePoint.valid).toBe(true)

      // If S-000 produces no dblclick or detail [1], fails
      const badNearRows = [
        {
          id: 'S-000',
          offsetPx: 0,
          gapErrorMs: 1,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [1], emittedDoubleClick: false },
        },
        spatialRows[1],
      ]
      expect(evaluateSpatialControl(badNearRows, 60, 30).pass).toBe(false)
    })

    it('spatial far requires 1 -> 1 with dblclick=false', () => {
      const spatialRows = [
        {
          id: 'S-000',
          offsetPx: 0,
          gapErrorMs: 1,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true },
        },
        {
          id: 'S-060',
          offsetPx: 60,
          gapErrorMs: 1,
          first: { mouseDownDetail: [1] },
          second: { mouseDownDetail: [2], emittedDoubleClick: true }, // should be 1 & false
        },
      ]
      const evalResult = evaluateSpatialControl(spatialRows, 60, 30)
      expect(evalResult.pass).toBe(false)
      expect(evalResult.farPoint.valid).toBe(false)
    })

    it('computes empirical spatial boundary from sweep', () => {
      const sweepRows = [
        { id: 'S-000', offsetPx: 0, second: { emittedDoubleClick: true } },
        { id: 'S-001', offsetPx: 1, second: { emittedDoubleClick: true } },
        { id: 'S-002', offsetPx: 2, second: { emittedDoubleClick: true } },
        { id: 'S-003', offsetPx: 3, second: { emittedDoubleClick: false } },
        { id: 'S-004', offsetPx: 4, second: { emittedDoubleClick: false } },
        { id: 'S-060', offsetPx: 60, second: { emittedDoubleClick: false } },
      ]
      const boundary = findEmpiricalSpatialBoundary(sweepRows)
      expect(boundary.maxDblClickOffsetPx).toBe(2)
      expect(boundary.minNoDblClickOffsetPx).toBe(3)
    })
  })
})
