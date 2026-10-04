/**
 * Pure logic and assertions for the Phase 4.2.1/4.2.2 native-input probe.
 *
 * This module isolates the instrument's pure algorithms — monotonic gap wait
 * scheduling, row freshness validation, spatial-row integrity, and validity-control
 * evaluation — so they can be regression-tested without a live desktop or browser.
 *
 * @module dsh-word-lookup/scripts/phase421-instrument-logic
 */

/** Default timing tolerance for requested vs measured gaps in milliseconds. */
export const DEFAULT_TIMING_TOLERANCE_MS = 30

/** Default cooldown safety margin added to GetDoubleClickTime() in milliseconds. */
export const DEFAULT_SAFETY_MARGIN_MS = 100

/**
 * Calculate the wait duration needed to land the second down event at the target.
 *
 * Both firstReleaseMs and currentTraceMs must share the single monotonic trace
 * clock origin (e.g., `performance.now() - window.__PHASE421__.started`).
 *
 * @param {number} firstReleaseMs - trace-relative timestamp of the first pointerup.
 * @param {number} requestedGapMs - the commanded gap in milliseconds.
 * @param {number} currentTraceMs - trace-relative timestamp when scheduling starts.
 * @returns {{ targetTraceMs: number, remainingMs: number, canWait: boolean }}
 */
export function calculateGapWait(firstReleaseMs, requestedGapMs, currentTraceMs) {
  if (typeof firstReleaseMs !== 'number' || typeof requestedGapMs !== 'number' || typeof currentTraceMs !== 'number') {
    throw new TypeError('calculateGapWait: firstReleaseMs, requestedGapMs, and currentTraceMs must be numbers')
  }
  const targetTraceMs = Math.round((firstReleaseMs + requestedGapMs) * 100) / 100
  const remainingMs = Math.round((targetTraceMs - currentTraceMs) * 100) / 100
  return {
    targetTraceMs,
    remainingMs,
    canWait: remainingMs >= 0,
  }
}

/**
 * Calculate the gap timing error between measured and requested.
 *
 * @param {number | null} requestedGapMs - commanded gap in ms.
 * @param {number | null} measuredGapMs - measured gap in ms.
 * @returns {number | null} signed error in ms (measured - requested), or null.
 */
export function calculateGapError(requestedGapMs, measuredGapMs) {
  if (typeof requestedGapMs !== 'number' || typeof measuredGapMs !== 'number') {
    return null
  }
  return Math.round((measuredGapMs - requestedGapMs) * 100) / 100
}

/**
 * Check whether a measured gap is within tolerance of the requested gap.
 *
 * @param {number | null} requestedGapMs - commanded gap in ms.
 * @param {number | null} measuredGapMs - measured gap in ms.
 * @param {number} [toleranceMs=DEFAULT_TIMING_TOLERANCE_MS] - allowable error.
 * @returns {boolean} true if error is within tolerance.
 */
export function isGapWithinTolerance(requestedGapMs, measuredGapMs, toleranceMs = DEFAULT_TIMING_TOLERANCE_MS) {
  const error = calculateGapError(requestedGapMs, measuredGapMs)
  if (error === null) return false
  return Math.abs(error) <= toleranceMs
}

/**
 * Calculate the inter-row cooldown required to reset the OS/browser click sequence.
 *
 * @param {number} doubleClickTimeMs - system double click time in ms.
 * @param {number} [safetyMarginMs=DEFAULT_SAFETY_MARGIN_MS] - extra margin.
 * @returns {number} required cooldown in ms.
 */
export function calculateRowCooldownMs(doubleClickTimeMs, safetyMarginMs = DEFAULT_SAFETY_MARGIN_MS) {
  if (typeof doubleClickTimeMs !== 'number' || doubleClickTimeMs <= 0) {
    throw new TypeError(`calculateRowCooldownMs: expected positive number, got ${String(doubleClickTimeMs)}`)
  }
  return doubleClickTimeMs + safetyMarginMs
}

/**
 * Validate that a measurement row began with a fresh click sequence (detail === 1).
 *
 * @param {any} row - the measurement row.
 * @returns {{ valid: boolean, detail: number | null, reason?: string }}
 */
export function validateRowFreshness(row) {
  if (!row || typeof row !== 'object') {
    return { valid: false, detail: null, reason: 'row is null or not an object' }
  }
  if (row.contaminated === true) {
    return { valid: false, detail: null, reason: 'row marked contaminated' }
  }
  const details = row.first?.mouseDownDetail
  if (!Array.isArray(details) || details.length === 0) {
    return { valid: false, detail: null, reason: 'first press has no mousedown events recorded' }
  }
  const firstDetail = details[0]
  if (firstDetail !== 1) {
    return {
      valid: false,
      detail: firstDetail,
      reason: `first mousedown.detail was ${String(firstDetail)} (expected 1)`,
    }
  }
  return { valid: true, detail: firstDetail }
}

/**
 * Assert that all spatial rows retain numeric offsetPx (fail-loud invariant).
 *
 * @param {any[]} spatialRows - array of spatial control/sweep rows.
 * @throws {Error} if any row lacks a numeric offsetPx.
 * @returns {true}
 */
export function assertSpatialRowsIntegrity(spatialRows) {
  if (!Array.isArray(spatialRows) || spatialRows.length === 0) {
    throw new Error('BLOCKED — INSTRUMENT INTERNAL ERROR: spatialRows is empty or not an array')
  }
  for (const row of spatialRows) {
    if (typeof row?.offsetPx !== 'number' || Number.isNaN(row.offsetPx)) {
      throw new Error(
        `BLOCKED — INSTRUMENT INTERNAL ERROR: control-space row ${row?.id ?? 'unknown'} missing numeric offsetPx (got ${String(row?.offsetPx)})`,
      )
    }
  }
  return true
}

/**
 * Evaluate the timeout positive and negative controls with click multiplicity and timing assertions.
 *
 * @param {any[]} timeoutRows - the timeout test rows.
 * @param {number} doubleClickTimeMs - the system double click time.
 * @param {number} [toleranceMs=DEFAULT_TIMING_TOLERANCE_MS] - timing tolerance.
 * @returns {{ pass: boolean, doubleClickTimeMs: number, toleranceMs: number, reasons: string[], belowTimeout: any, aboveTimeout: any }}
 */
export function evaluateTimeoutControl(timeoutRows, doubleClickTimeMs, toleranceMs = DEFAULT_TIMING_TOLERANCE_MS) {
  const below = timeoutRows?.find?.((row) => row.id === 'T-BELOW') ?? null
  const above = timeoutRows?.find?.((row) => row.id === 'T-ABOVE') ?? null
  const reasons = []

  if (!below) reasons.push('T-BELOW row not found')
  if (!above) reasons.push('T-ABOVE row not found')

  const belowFreshness = validateRowFreshness(below)
  if (!belowFreshness.valid) reasons.push(`T-BELOW freshness failed: ${belowFreshness.reason}`)

  const aboveFreshness = validateRowFreshness(above)
  if (!aboveFreshness.valid) reasons.push(`T-ABOVE freshness failed: ${aboveFreshness.reason}`)

  const belowTimingValid = below?.gapErrorMs !== null && Math.abs(below?.gapErrorMs ?? Infinity) <= toleranceMs
  if (!belowTimingValid) {
    reasons.push(
      `T-BELOW timing out of tolerance: requested=${String(below?.requestedGapMs)}, measured=${String(below?.measuredGapMs)}, error=${String(below?.gapErrorMs)} (tolerance <= ${String(toleranceMs)} ms)`,
    )
  }

  const aboveTimingValid = above?.gapErrorMs !== null && Math.abs(above?.gapErrorMs ?? Infinity) <= toleranceMs
  if (!aboveTimingValid) {
    reasons.push(
      `T-ABOVE timing out of tolerance: requested=${String(above?.requestedGapMs)}, measured=${String(above?.measuredGapMs)}, error=${String(above?.gapErrorMs)} (tolerance <= ${String(toleranceMs)} ms)`,
    )
  }

  const belowClickValid =
    below?.first?.mouseDownDetail?.[0] === 1 &&
    below?.second?.mouseDownDetail?.[0] === 2 &&
    below?.second?.emittedDoubleClick === true
  if (!belowClickValid) {
    reasons.push(
      `T-BELOW click multiplicity invalid: expected 1->2 with dblclick=true, got first=${JSON.stringify(below?.first?.mouseDownDetail)}, second=${JSON.stringify(below?.second?.mouseDownDetail)}, dblclick=${String(below?.second?.emittedDoubleClick)}`,
    )
  }

  const aboveClickValid =
    above?.first?.mouseDownDetail?.[0] === 1 &&
    above?.second?.mouseDownDetail?.[0] === 1 &&
    above?.second?.emittedDoubleClick === false
  if (!aboveClickValid) {
    reasons.push(
      `T-ABOVE click multiplicity invalid: expected 1->1 with dblclick=false, got first=${JSON.stringify(above?.first?.mouseDownDetail)}, second=${JSON.stringify(above?.second?.mouseDownDetail)}, dblclick=${String(above?.second?.emittedDoubleClick)}`,
    )
  }

  const pass =
    below !== null &&
    above !== null &&
    belowFreshness.valid &&
    aboveFreshness.valid &&
    belowTimingValid &&
    aboveTimingValid &&
    belowClickValid &&
    aboveClickValid

  return {
    pass,
    doubleClickTimeMs,
    toleranceMs,
    reasons,
    belowTimeout: {
      id: 'T-BELOW',
      requestedGapMs: below?.requestedGapMs ?? null,
      measuredGapMs: below?.measuredGapMs ?? null,
      gapErrorMs: below?.gapErrorMs ?? null,
      firstDetail: below?.first?.mouseDownDetail ?? [],
      secondDetail: below?.second?.mouseDownDetail ?? [],
      doubleClick: below?.second?.emittedDoubleClick ?? null,
      valid: belowFreshness.valid && belowTimingValid && belowClickValid,
    },
    aboveTimeout: {
      id: 'T-ABOVE',
      requestedGapMs: above?.requestedGapMs ?? null,
      measuredGapMs: above?.measuredGapMs ?? null,
      gapErrorMs: above?.gapErrorMs ?? null,
      firstDetail: above?.first?.mouseDownDetail ?? [],
      secondDetail: above?.second?.mouseDownDetail ?? [],
      doubleClick: above?.second?.emittedDoubleClick ?? null,
      valid: aboveFreshness.valid && aboveTimingValid && aboveClickValid,
    },
  }
}

/**
 * Evaluate the spatial positive and spatial far negative controls with multiplicity assertions.
 *
 * @param {any[]} spatialRows - all spatial sweep/control rows.
 * @param {number} [spatialFarPx=60] - far negative offset threshold.
 * @param {number} [toleranceMs=DEFAULT_TIMING_TOLERANCE_MS] - timing tolerance if timed.
 * @returns {{ pass: boolean, spatialFarPx: number, reasons: string[], samePoint: any, farPoint: any }}
 */
export function evaluateSpatialControl(spatialRows, spatialFarPx = 60, toleranceMs = DEFAULT_TIMING_TOLERANCE_MS) {
  assertSpatialRowsIntegrity(spatialRows)

  const near = spatialRows.find((row) => row.offsetPx === 0) ?? null
  const far = spatialRows.find((row) => row.offsetPx === spatialFarPx) ?? null
  const reasons = []

  if (!near) reasons.push('Spatial near (offset 0) row not found')
  if (!far) reasons.push(`Spatial far (offset ${String(spatialFarPx)}) row not found`)

  const nearFreshness = validateRowFreshness(near)
  if (!nearFreshness.valid) reasons.push(`Spatial near freshness failed: ${nearFreshness.reason}`)

  const farFreshness = validateRowFreshness(far)
  if (!farFreshness.valid) reasons.push(`Spatial far freshness failed: ${farFreshness.reason}`)

  const nearTimingValid = near?.gapErrorMs === null || Math.abs(near?.gapErrorMs ?? Infinity) <= toleranceMs
  if (!nearTimingValid) reasons.push(`Spatial near timing out of tolerance: error=${String(near?.gapErrorMs)}`)

  const farTimingValid = far?.gapErrorMs === null || Math.abs(far?.gapErrorMs ?? Infinity) <= toleranceMs
  if (!farTimingValid) reasons.push(`Spatial far timing out of tolerance: error=${String(far?.gapErrorMs)}`)

  const nearClickValid =
    near?.first?.mouseDownDetail?.[0] === 1 &&
    near?.second?.mouseDownDetail?.[0] === 2 &&
    near?.second?.emittedDoubleClick === true
  if (!nearClickValid) {
    reasons.push(
      `Spatial near click multiplicity invalid: expected 1->2 with dblclick=true, got first=${JSON.stringify(near?.first?.mouseDownDetail)}, second=${JSON.stringify(near?.second?.mouseDownDetail)}, dblclick=${String(near?.second?.emittedDoubleClick)}`,
    )
  }

  const farClickValid =
    far?.first?.mouseDownDetail?.[0] === 1 &&
    far?.second?.mouseDownDetail?.[0] === 1 &&
    far?.second?.emittedDoubleClick === false
  if (!farClickValid) {
    reasons.push(
      `Spatial far click multiplicity invalid: expected 1->1 with dblclick=false, got first=${JSON.stringify(far?.first?.mouseDownDetail)}, second=${JSON.stringify(far?.second?.mouseDownDetail)}, dblclick=${String(far?.second?.emittedDoubleClick)}`,
    )
  }

  const pass =
    near !== null &&
    far !== null &&
    nearFreshness.valid &&
    farFreshness.valid &&
    nearTimingValid &&
    farTimingValid &&
    nearClickValid &&
    farClickValid

  return {
    pass,
    spatialFarPx,
    reasons,
    samePoint: {
      id: near?.id ?? 'S-000',
      offsetPx: 0,
      gapErrorMs: near?.gapErrorMs ?? null,
      firstDetail: near?.first?.mouseDownDetail ?? [],
      secondDetail: near?.second?.mouseDownDetail ?? [],
      doubleClick: near?.second?.emittedDoubleClick ?? null,
      valid: nearFreshness.valid && nearTimingValid && nearClickValid,
    },
    farPoint: {
      id: far?.id ?? `S-${String(spatialFarPx).padStart(3, '0')}`,
      offsetPx: spatialFarPx,
      gapErrorMs: far?.gapErrorMs ?? null,
      firstDetail: far?.first?.mouseDownDetail ?? [],
      secondDetail: far?.second?.mouseDownDetail ?? [],
      doubleClick: far?.second?.emittedDoubleClick ?? null,
      valid: farFreshness.valid && farTimingValid && farClickValid,
    },
  }
}

/**
 * Determine the empirical boundary where Windows/Chromium stops recognising double click.
 *
 * @param {any[]} spatialRows - the spatial sweep rows.
 * @returns {{ maxDblClickOffsetPx: number | null, minNoDblClickOffsetPx: number | null, transitionSummary: string }}
 */
export function findEmpiricalSpatialBoundary(spatialRows) {
  assertSpatialRowsIntegrity(spatialRows)
  const sorted = [...spatialRows].sort((a, b) => a.offsetPx - b.offsetPx)
  let maxDblClickOffsetPx = null
  let minNoDblClickOffsetPx = null
  for (const row of sorted) {
    if (row.second?.emittedDoubleClick === true) {
      maxDblClickOffsetPx = row.offsetPx
    } else if (row.second?.emittedDoubleClick === false && minNoDblClickOffsetPx === null) {
      minNoDblClickOffsetPx = row.offsetPx
    }
  }
  return {
    maxDblClickOffsetPx,
    minNoDblClickOffsetPx,
    transitionSummary:
      maxDblClickOffsetPx === null
        ? 'no double-click observed at any tested offset'
        : minNoDblClickOffsetPx === null
          ? 'double-click observed at all tested offsets'
          : `double-click observed up to ${String(maxDblClickOffsetPx)} px, dropped at ${String(minNoDblClickOffsetPx)} px`,
  }
}
