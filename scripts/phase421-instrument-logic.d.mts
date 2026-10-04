/**
 * Type declarations for {@link ./phase421-instrument-logic.mjs}.
 */

export declare const DEFAULT_TIMING_TOLERANCE_MS: number
export declare const DEFAULT_SAFETY_MARGIN_MS: number

export interface GapWaitResult {
  targetTraceMs: number
  remainingMs: number
  canWait: boolean
}

export declare function calculateGapWait(
  firstReleaseMs: number,
  requestedGapMs: number,
  currentTraceMs: number,
): GapWaitResult

export declare function calculateGapError(
  requestedGapMs: number | null,
  measuredGapMs: number | null,
): number | null

export declare function isGapWithinTolerance(
  requestedGapMs: number | null,
  measuredGapMs: number | null,
  toleranceMs?: number,
): boolean

export declare function calculateRowCooldownMs(
  doubleClickTimeMs: number,
  safetyMarginMs?: number,
): number

export interface RowFreshnessResult {
  valid: boolean
  detail: number | null
  reason?: string
}

export declare function validateRowFreshness(row: any): RowFreshnessResult

export declare function assertSpatialRowsIntegrity(spatialRows: any[]): true

export interface TimeoutControlResult {
  pass: boolean
  doubleClickTimeMs: number
  toleranceMs: number
  reasons: string[]
  belowTimeout: any
  aboveTimeout: any
}

export declare function evaluateTimeoutControl(
  timeoutRows: any[],
  doubleClickTimeMs: number,
  toleranceMs?: number,
): TimeoutControlResult

export interface SpatialControlResult {
  pass: boolean
  spatialFarPx: number
  reasons: string[]
  samePoint: any
  farPoint: any
}

export declare function evaluateSpatialControl(
  spatialRows: any[],
  spatialFarPx?: number,
  toleranceMs?: number,
): SpatialControlResult

export interface EmpiricalSpatialBoundary {
  maxDblClickOffsetPx: number | null
  minNoDblClickOffsetPx: number | null
  transitionSummary: string
}

export declare function findEmpiricalSpatialBoundary(
  spatialRows: any[],
): EmpiricalSpatialBoundary
