/**
 * Static Companion Worker for ECDICT candidate SQLite integrity verification.
 *
 * Implements Architecture Exception 1 (Phase 7A.5R4):
 * - Runs in an isolated Worker thread so that C-level SQLite PRAGMA integrity_check
 *   does not block the main thread event loop.
 * - Opens candidate database strictly with `{ readOnly: true }`.
 * - Executes full, unfiltered `PRAGMA integrity_check` (no quick_check, no partial check).
 * - Enforces that .all() returns exactly one row with value strictly equal to 'ok'.
 * - Closes the SQLite connection in a try/finally block BEFORE posting success message
 *   to ensure Windows OS file handles are completely released.
 * - Uses zero external npm dependencies and makes zero network or credentials calls.
 *
 * @module dsh-word-lookup/host/ecdict-integrity-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/** Request payload sent to this worker. */
export interface IntegrityRequest {
  readonly requestId: string
  readonly candidatePath: string
}

/** Success response payload sent back to main thread. */
export interface IntegritySuccessResponse {
  readonly requestId: string
  readonly success: true
  readonly integrityResult: 'ok'
  readonly durationMs: number
}

/** Failure response payload sent back to main thread. */
export interface IntegrityFailureResponse {
  readonly requestId: string
  readonly success: false
  readonly errorCode: string
  readonly message: string
  readonly durationMs?: number
}

/** Discriminated union of integrity responses. */
export type IntegrityResponse = IntegritySuccessResponse | IntegrityFailureResponse

/**
 * Validates request object structure at runtime without trusting raw IPC types.
 */
function isValidIntegrityRequest(data: unknown): data is IntegrityRequest {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  const req = data as Record<string, unknown>
  return (
    typeof req.requestId === 'string' &&
    req.requestId.length > 0 &&
    typeof req.candidatePath === 'string' &&
    req.candidatePath.length > 0
  )
}

/**
 * Main worker execution routine.
 */
function runIntegrityWorker(): void {
  if (!parentPort) {
    throw new Error('ecdict-integrity-worker must be executed as a Worker thread with parentPort')
  }

  if (!isValidIntegrityRequest(workerData)) {
    const rawRequestId =
      typeof workerData === 'object' && workerData !== null
        ? String((workerData as Record<string, unknown>).requestId ?? 'unknown')
        : 'unknown'
    const failResp: IntegrityFailureResponse = {
      requestId: rawRequestId,
      success: false,
      errorCode: 'INVALID_REQUEST_PAYLOAD',
      message: 'Worker received invalid or missing integrity request payload',
    }
    parentPort.postMessage(failResp)
    return
  }

  const { requestId, candidatePath } = workerData
  const startNs = process.hrtime.bigint()
  let db: DatabaseSync | null = null

  try {
    db = new DatabaseSync(candidatePath, { readOnly: true })

    try {
      db.exec('PRAGMA mmap_size = 268435456')
      db.exec('PRAGMA cache_size = -64000')
    } catch {
      // Ignore optional pragma tuning failures if unsupported
    }

    const rows = db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[]
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)

    // Close SQLite connection before sending message to guarantee OS handle release
    db.close()
    db = null

    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
      const errorDetails = rows
        .slice(0, 3)
        .map((r) => String(Object.values(r)[0] ?? 'unknown integrity diagnostic'))
        .join('; ')
      const failResp: IntegrityFailureResponse = {
        requestId,
        success: false,
        errorCode: 'INTEGRITY_CHECK_FAILED',
        message: `Candidate SQLite PRAGMA integrity_check failed: ${errorDetails || 'empty result'}`,
        durationMs,
      }
      parentPort.postMessage(failResp)
      return
    }

    const okResp: IntegritySuccessResponse = {
      requestId,
      success: true,
      integrityResult: 'ok',
      durationMs,
    }
    parentPort.postMessage(okResp)
  } catch (err: unknown) {
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)
    const rawMessage = err instanceof Error ? err.message : String(err)
    // Sanitize message: limit length to 500 characters and avoid credentials
    const safeMessage = rawMessage.replace(/[\r\n]+/g, ' ').slice(0, 500)
    const failResp: IntegrityFailureResponse = {
      requestId,
      success: false,
      errorCode: 'WORKER_EXECUTION_ERROR',
      message: safeMessage,
      durationMs,
    }
    parentPort.postMessage(failResp)
  } finally {
    if (db !== null) {
      try {
        db.close()
      } catch {
        // Suppress secondary close errors in finally
      }
    }
  }
}

runIntegrityWorker()
