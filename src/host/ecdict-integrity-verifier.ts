/**
 * Host-side Worker executor and lifecycle manager for ECDICT integrity verification.
 *
 * Implements Phase 7A.5R4:
 * - Spawns the static companion worker (`ecdict-integrity-worker.js`) in an isolated thread.
 * - Manages IPC request/response with strict runtime payload validation.
 * - Implements fail-closed finite state machine with timeout, AbortSignal, and exit handling.
 * - Guarantees worker termination and OS handle release before resolving verification.
 * - Shields against premature exit, uncaught worker exceptions, and invalid messages.
 *
 * @module dsh-word-lookup/host/ecdict-integrity-verifier
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import type {
  IntegrityRequest,
  IntegrityResponse,
} from './ecdict-integrity-worker.js'

/**
 * Result of successful candidate database integrity verification.
 */
export interface IntegrityVerificationResult {
  readonly success: boolean
  readonly integrityResult: 'ok'
  readonly durationMs: number
}

/**
 * Error thrown when integrity verification fails or cannot complete safely.
 */
export class IntegrityVerificationError extends Error {
  readonly errorCode: string
  readonly durationMs?: number

  constructor(message: string, errorCode = 'INTEGRITY_VERIFICATION_FAILED', durationMs?: number) {
    super(message)
    this.name = 'IntegrityVerificationError'
    this.errorCode = errorCode
    this.durationMs = durationMs
  }
}

/**
 * Options for spawning the integrity worker.
 */
export interface SpawnIntegrityWorkerOptions {
  /** Optional custom worker URL (for internal fault-injection tests only). */
  readonly workerUrl?: URL
  /** Optional execArgv overrides. */
  readonly execArgv?: string[]
}

/**
 * Options for executing candidate database verification.
 */
export interface VerifyCandidateOptions {
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal
  /** Maximum time in milliseconds before timing out (defaults to 30000). */
  readonly timeoutMs?: number
  /** Optional custom worker URL (for internal fault-injection tests only). */
  readonly workerUrl?: URL
}

/**
 * Create an AbortError with standard DOMException behavior.
 */
function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const error = new DOMException('This operation was aborted', 'AbortError')
  if (reason !== undefined) {
    try {
      Object.defineProperty(error, 'cause', { value: reason, configurable: true, writable: true })
    } catch {
      // ignore
    }
  }
  return error
}

/**
 * Validate that an unknown value matches the expected IntegrityResponse IPC structure.
 */
function isValidIntegrityResponse(value: unknown): value is IntegrityResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const resp = value as Record<string, unknown>
  if (typeof resp.requestId !== 'string' || resp.requestId.length === 0) {
    return false
  }
  if (typeof resp.success !== 'boolean') {
    return false
  }
  if (resp.success) {
    return resp.integrityResult === 'ok' && typeof resp.durationMs === 'number'
  }
  return typeof resp.errorCode === 'string' && typeof resp.message === 'string'
}

/**
 * Spawn the static companion worker for integrity verification.
 *
 * Uses the exact approved static entry URL:
 * `new URL('./ecdict-integrity-worker.js', import.meta.url)`
 *
 * @param request - verified request payload.
 */
declare const __PROD_BUNDLE__: boolean | undefined

/**
 * Spawn the static companion worker for integrity verification.
 *
 * In production bundle (`lib/index.js`), compiles exclusively to:
 * `new Worker(new URL('./ecdict-integrity-worker.js', import.meta.url), approvedOptions)`
 *
 * @param request - verified request payload.
 * @param options - optional test options (dev/test only).
 */
export function spawnIntegrityWorker(
  request: IntegrityRequest,
  options?: SpawnIntegrityWorkerOptions,
): Worker {
  if (typeof __PROD_BUNDLE__ !== 'undefined' && __PROD_BUNDLE__) {
    return new Worker(
      new URL('./ecdict-integrity-worker.js', import.meta.url),
      {
        workerData: request,
        execArgv: [],
      },
    )
  }

  // Development/test execution from TypeScript
  const targetUrl = options?.workerUrl ?? new URL('../../lib/ecdict-integrity-worker.js', import.meta.url)
  return new Worker(
    targetUrl,
    {
      workerData: request,
      execArgv: options?.execArgv ?? [],
    },
  )
}

/**
 * Execute full PRAGMA integrity_check against a candidate SQLite database in a dedicated Worker.
 *
 * Enforces:
 * - Candidate database file must exist and be normalized.
 * - Single settlement promise lifecycle.
 * - RequestId correlation matching.
 * - Fail-closed handling of errors, non-zero exits, timeouts, and AbortSignals.
 * - Strict await worker.terminate() before returning success to release Windows file locks.
 *
 * @param candidatePath - absolute filesystem path to candidate SQLite database.
 * @param options - optional cancellation, timeout, or worker URL.
 * @returns verification outcome including duration.
 */
export async function verifyCandidateDatabaseWithWorker(
  candidatePath: string,
  options?: VerifyCandidateOptions,
): Promise<IntegrityVerificationResult> {
  const signal = options?.signal
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }

  const resolvedCandidatePath = resolve(candidatePath)
  if (!existsSync(resolvedCandidatePath)) {
    throw new IntegrityVerificationError(
      `Candidate SQLite database does not exist: ${resolvedCandidatePath}`,
      'CANDIDATE_NOT_FOUND',
    )
  }

  const requestId = randomUUID()
  const request: IntegrityRequest = {
    requestId,
    candidatePath: resolvedCandidatePath,
  }

  const timeoutMs = options?.timeoutMs ?? 30000
  let worker: Worker
  try {
    worker = spawnIntegrityWorker(request, { workerUrl: options?.workerUrl })
  } catch (spawnErr) {
    throw new IntegrityVerificationError(
      `Failed to spawn integrity worker: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
      'WORKER_SPAWN_FAILED',
    )
  }

  return new Promise<IntegrityVerificationResult>((resolvePromise, rejectPromise) => {
    let settled = false
    let timeoutTimer: NodeJS.Timeout | null = null

    const cleanupResources = (): void => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      signal?.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
    }

    const settleAndTerminate = async (
      action: 'resolve' | 'reject',
      payload: IntegrityVerificationResult | Error,
    ): Promise<void> => {
      if (settled) return
      settled = true
      cleanupResources()

      try {
        await worker.terminate()
      } catch (termErr) {
        const termError = new Error(`Integrity worker termination failed: ${String(termErr)}`)
        if (action === 'resolve') {
          rejectPromise(termError)
        } else {
          rejectPromise(
            new AggregateError(
              [payload as Error, termError],
              'Integrity check failed and worker termination failed',
            ),
          )
        }
        return
      }

      if (action === 'resolve') {
        resolvePromise(payload as IntegrityVerificationResult)
      } else {
        rejectPromise(payload as Error)
      }
    }

    const onAbort = (): void => {
      void settleAndTerminate('reject', createAbortError(signal?.reason))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timeoutTimer = setTimeout(() => {
      void settleAndTerminate(
        'reject',
        new IntegrityVerificationError(
          `Candidate SQLite integrity verification timed out after ${timeoutMs}ms`,
          'VERIFICATION_TIMEOUT',
        ),
      )
    }, timeoutMs)

    worker.on('message', (value: unknown) => {
      if (settled) return
      if (!isValidIntegrityResponse(value)) {
        void settleAndTerminate(
          'reject',
          new IntegrityVerificationError(
            'Integrity worker returned invalid or unrecognized IPC response structure',
            'INVALID_IPC_RESPONSE',
          ),
        )
        return
      }

      if (value.requestId !== requestId) {
        void settleAndTerminate(
          'reject',
          new IntegrityVerificationError(
            `Integrity worker response requestId mismatch: expected ${requestId}, got ${value.requestId}`,
            'REQUEST_ID_MISMATCH',
          ),
        )
        return
      }

      if (!value.success) {
        void settleAndTerminate(
          'reject',
          new IntegrityVerificationError(
            value.message,
            value.errorCode,
            value.durationMs,
          ),
        )
        return
      }

      if (value.integrityResult !== 'ok') {
        void settleAndTerminate(
          'reject',
          new IntegrityVerificationError(
            `Candidate SQLite PRAGMA integrity_check failed: ${value.integrityResult}`,
            'INTEGRITY_RESULT_NOT_OK',
            value.durationMs,
          ),
        )
        return
      }

      void settleAndTerminate('resolve', {
        success: true,
        integrityResult: 'ok',
        durationMs: value.durationMs,
      })
    })

    worker.on('error', (err: Error) => {
      if (settled) return
      void settleAndTerminate(
        'reject',
        new IntegrityVerificationError(
          `Integrity worker encountered an uncaught error: ${err.message}`,
          'WORKER_UNCAUGHT_ERROR',
        ),
      )
    })

    worker.on('exit', (code: number) => {
      if (!settled) {
        void settleAndTerminate(
          'reject',
          new IntegrityVerificationError(
            `Integrity worker exited prematurely before returning verification response (exit code ${code})`,
            'WORKER_PREMATURE_EXIT',
          ),
        )
      }
    })
  })
}
