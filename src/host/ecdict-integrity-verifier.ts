/**
 * Host-side Worker executor and lifecycle manager for ECDICT integrity verification.
 *
 * Implements Phase 7A.5R4 & 7A.5R4.1:
 * - Spawns the static companion worker (`ecdict-integrity-worker.js`) in an isolated thread.
 * - Manages IPC request/response with strict runtime payload validation.
 * - Implements fail-closed finite state machine with timeout, AbortSignal, and exit handling.
 * - Preserves error and exit handling capabilities until worker exit is confirmed.
 * - Eliminates listener cleanup races, multiple settlements, and unhandled late error crashes.
 * - Distinguishes TERMINATED_CONFIRMED from TERMINATION_UNCONFIRMED with typed error objects.
 * - Enforces candidate database path containment within the managed storage directory.
 * - Guarantees worker termination and OS handle release before resolving verification.
 *
 * @module dsh-word-lookup/host/ecdict-integrity-verifier
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import type {
  IntegrityRequest,
  IntegrityResponse,
} from './ecdict-integrity-worker.js'

export type {
  IntegrityRequest,
  IntegrityResponse,
}
import { validateCandidateDatabasePath } from './managed-storage.js'

/**
 * Worker termination status distinguishing confirmed exit from unconfirmed/failed termination.
 */
export type WorkerTerminationStatus = 'TERMINATED_CONFIRMED' | 'TERMINATION_UNCONFIRMED'

/**
 * Result of successful candidate database integrity verification.
 */
export interface IntegrityVerificationResult {
  readonly success: boolean
  readonly integrityResult: 'ok'
  readonly durationMs: number
}

/**
 * Error thrown when worker termination fails or cannot be confirmed within deadline.
 */
export class WorkerTerminationError extends Error {
  readonly errorCode = 'WORKER_TERMINATION_FAILED'
  readonly terminationStatus: WorkerTerminationStatus

  constructor(
    message: string,
    terminationStatus: WorkerTerminationStatus = 'TERMINATION_UNCONFIRMED',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WorkerTerminationError'
    this.terminationStatus = terminationStatus
  }
}

/**
 * Error thrown when integrity verification fails or cannot complete safely.
 */
export class IntegrityVerificationError extends Error {
  readonly errorCode: string
  readonly durationMs?: number
  readonly terminationStatus: WorkerTerminationStatus

  constructor(
    message: string,
    errorCode = 'INTEGRITY_VERIFICATION_FAILED',
    durationMs?: number,
    terminationStatus: WorkerTerminationStatus = 'TERMINATED_CONFIRMED',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'IntegrityVerificationError'
    this.errorCode = errorCode
    this.durationMs = durationMs
    this.terminationStatus = terminationStatus
  }
}

/**
 * Check whether an error or aggregate error indicates unconfirmed worker termination.
 */
export function isTerminationUnconfirmed(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  if ('terminationStatus' in err && (err as { terminationStatus: unknown }).terminationStatus === 'TERMINATION_UNCONFIRMED') {
    return true
  }
  if (err instanceof AggregateError) {
    return err.errors.some((e) => isTerminationUnconfirmed(e))
  }
  return false
}

/**
 * Structural interface for worker instances, enabling internal adapter injection.
 */
export interface WorkerLike {
  on(event: 'message', listener: (value: any) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  removeAllListeners(event?: string): this
  terminate(): Promise<number>
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
  /** Maximum time in milliseconds before worker termination times out (defaults to 5000). */
  readonly terminationTimeoutMs?: number
  /** Optional custom worker URL (for internal fault-injection tests only). */
  readonly workerUrl?: URL
  /** Optional expected directory containing candidate database. */
  readonly expectedDirectory?: string
  /** @internal Internal test seam: custom worker adapter for deterministic lifecycle testing. */
  readonly workerAdapter?: (request: IntegrityRequest) => WorkerLike
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
 * In production bundle (`lib/index.js`), compiles exclusively to:
 * `new Worker(new URL('./ecdict-integrity-worker.js', import.meta.url), approvedOptions)`
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
 * - Candidate database file must exist, be normalized, and reside strictly within expected directory.
 * - Single settlement promise lifecycle (no multi-settle on message/error/exit/abort/timeout).
 * - RequestId correlation matching.
 * - Fail-closed handling of errors, non-zero exits, timeouts, and AbortSignals.
 * - Preservation of error and exit handling capabilities until worker exit is confirmed.
 * - Strict await worker.terminate() before returning success to release Windows file locks.
 * - Distinguishes TERMINATED_CONFIRMED from TERMINATION_UNCONFIRMED via typed status.
 *
 * @param candidatePath - absolute filesystem path to candidate SQLite database.
 * @param options - optional cancellation, timeout, expected directory, or worker adapter.
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

  if (
    typeof candidatePath !== 'string' ||
    candidatePath.trim().length === 0 ||
    candidatePath.includes('\0') ||
    candidatePath.includes('..')
  ) {
    throw new IntegrityVerificationError(
      `Invalid candidate SQLite database path: ${String(candidatePath)}`,
      'INVALID_CANDIDATE_PATH',
      undefined,
      'TERMINATED_CONFIRMED',
    )
  }

  if (options?.expectedDirectory) {
    await validateCandidateDatabasePath(candidatePath, options.expectedDirectory)
  }

  const resolvedCandidatePath = resolve(candidatePath)
  if (!existsSync(resolvedCandidatePath)) {
    throw new IntegrityVerificationError(
      `Candidate SQLite database does not exist: ${resolvedCandidatePath}`,
      'CANDIDATE_NOT_FOUND',
      undefined,
      'TERMINATED_CONFIRMED',
    )
  }

  try {
    const st = lstatSync(resolvedCandidatePath)
    if (st.isSymbolicLink()) {
      throw new IntegrityVerificationError(
        `Candidate SQLite database must not be a symbolic link: ${resolvedCandidatePath}`,
        'INVALID_CANDIDATE_PATH',
        undefined,
        'TERMINATED_CONFIRMED',
      )
    }
  } catch (statErr: any) {
    if (statErr instanceof IntegrityVerificationError) {
      throw statErr
    }
    if (statErr?.code !== 'ENOENT') {
      throw statErr
    }
  }

  const requestId = randomUUID()
  const request: IntegrityRequest = {
    requestId,
    candidatePath: resolvedCandidatePath,
  }

  const timeoutMs = options?.timeoutMs ?? 30000
  const terminationTimeoutMs = options?.terminationTimeoutMs ?? 5000

  let worker: WorkerLike
  try {
    if (options?.workerAdapter) {
      worker = options.workerAdapter(request)
    } else {
      worker = spawnIntegrityWorker(request, { workerUrl: options?.workerUrl })
    }
  } catch (spawnErr) {
    throw new IntegrityVerificationError(
      `Failed to spawn integrity worker: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
      'WORKER_SPAWN_FAILED',
      undefined,
      'TERMINATED_CONFIRMED',
      { cause: spawnErr },
    )
  }

  return new Promise<IntegrityVerificationResult>((resolvePromise, rejectPromise) => {
    let phase: 'RUNNING' | 'TERMINATING' | 'SETTLED' = 'RUNNING'
    let terminationStatus: WorkerTerminationStatus = 'TERMINATION_UNCONFIRMED'
    let primaryOutcome:
      | { kind: 'success'; result: IntegrityVerificationResult }
      | { kind: 'failure'; error: Error }
      | null = null
    const lateErrors: Error[] = []
    let timeoutTimer: NodeJS.Timeout | null = null

    const onAbort = (): void => {
      initiateTermination({
        kind: 'failure',
        error: createAbortError(signal?.reason),
      })
    }

    const initiateTermination = (
      outcome:
        | { kind: 'success'; result: IntegrityVerificationResult }
        | { kind: 'failure'; error: Error },
    ): void => {
      if (phase !== 'RUNNING') {
        return // Ignore duplicate messages or competing events
      }
      phase = 'TERMINATING'
      primaryOutcome = outcome

      // Clear external timers and listeners immediately
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }

      // Worker listeners remain ACTIVE during termination!
      void executeTermination()
    }

    const executeTermination = async (): Promise<void> => {
      let terminateError: Error | null = null
      let termTimeoutTimer: NodeJS.Timeout | null = null

      try {
        const termPromise = worker.terminate()

        const timeoutPromise = new Promise<never>((_, reject) => {
          termTimeoutTimer = setTimeout(() => {
            reject(
              new WorkerTerminationError(
                `Integrity worker termination timed out after ${terminationTimeoutMs}ms`,
                'TERMINATION_UNCONFIRMED',
              ),
            )
          }, terminationTimeoutMs)
        })

        await Promise.race([termPromise, timeoutPromise])
        terminationStatus = 'TERMINATED_CONFIRMED'
      } catch (termErr) {
        terminationStatus = 'TERMINATION_UNCONFIRMED'
        terminateError =
          termErr instanceof WorkerTerminationError
            ? termErr
            : new WorkerTerminationError(
                `Integrity worker termination failed: ${termErr instanceof Error ? termErr.message : String(termErr)}`,
                'TERMINATION_UNCONFIRMED',
                { cause: termErr },
              )
      } finally {
        if (termTimeoutTimer !== null) {
          clearTimeout(termTimeoutTimer)
          termTimeoutTimer = null
        }
      }

      // Only clean up worker listeners once termination completes/fails
      if (terminationStatus === 'TERMINATED_CONFIRMED') {
        worker.removeAllListeners()
      } else {
        worker.removeAllListeners()
        // Retain no-op error shield on unconfirmed worker to prevent late unhandled 'error' crash
        worker.on('error', () => {})
      }

      phase = 'SETTLED'

      // Evaluate late errors
      if (lateErrors.length > 0) {
        if (primaryOutcome?.kind === 'success') {
          const firstLate = lateErrors[0]!
          const lateErr = new IntegrityVerificationError(
            `Integrity worker encountered late error: ${firstLate.message}`,
            'WORKER_UNCAUGHT_ERROR',
            primaryOutcome.result.durationMs,
            terminationStatus,
            { cause: firstLate },
          )
          if (lateErrors.length === 1 && !terminateError) {
            rejectPromise(lateErr)
          } else {
            const all = [
              lateErr,
              ...lateErrors.slice(1),
              ...(terminateError ? [terminateError] : []),
            ]
            rejectPromise(
              new AggregateError(all, 'Integrity worker encountered late errors during termination'),
            )
          }
          return
        } else {
          const base = primaryOutcome?.error ?? new Error('Unknown verification failure')
          const all = [
            base,
            ...lateErrors,
            ...(terminateError ? [terminateError] : []),
          ]
          rejectPromise(
            new AggregateError(
              all,
              'Integrity verification failed and worker encountered errors during termination',
            ),
          )
          return
        }
      }

      // Evaluate termination failure
      if (terminateError !== null) {
        if (primaryOutcome?.kind === 'success') {
          rejectPromise(terminateError)
        } else {
          const base = primaryOutcome?.error ?? new Error('Integrity check failed')
          rejectPromise(
            new AggregateError(
              [base, terminateError],
              'Integrity check failed and worker termination failed',
            ),
          )
        }
        return
      }

      // Clean successful termination
      if (primaryOutcome?.kind === 'success') {
        resolvePromise(primaryOutcome.result)
      } else {
        rejectPromise(primaryOutcome?.error ?? new Error('Unknown verification failure'))
      }
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    timeoutTimer = setTimeout(() => {
      initiateTermination({
        kind: 'failure',
        error: new IntegrityVerificationError(
          `Candidate SQLite integrity verification timed out after ${timeoutMs}ms`,
          'VERIFICATION_TIMEOUT',
          undefined,
          'TERMINATION_UNCONFIRMED',
        ),
      })
    }, timeoutMs)

    worker.on('message', (value: unknown) => {
      if (phase !== 'RUNNING') return

      if (!isValidIntegrityResponse(value)) {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            'Integrity worker returned invalid or unrecognized IPC response structure',
            'INVALID_IPC_RESPONSE',
            undefined,
            'TERMINATION_UNCONFIRMED',
          ),
        })
        return
      }

      if (value.requestId !== requestId) {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Integrity worker response requestId mismatch: expected ${requestId}, got ${value.requestId}`,
            'REQUEST_ID_MISMATCH',
            undefined,
            'TERMINATION_UNCONFIRMED',
          ),
        })
        return
      }

      if (!value.success) {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            value.message,
            value.errorCode,
            value.durationMs,
            'TERMINATION_UNCONFIRMED',
          ),
        })
        return
      }

      if (value.integrityResult !== 'ok') {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Candidate SQLite PRAGMA integrity_check failed: ${value.integrityResult}`,
            'INTEGRITY_RESULT_NOT_OK',
            value.durationMs,
            'TERMINATION_UNCONFIRMED',
          ),
        })
        return
      }

      initiateTermination({
        kind: 'success',
        result: {
          success: true,
          integrityResult: 'ok',
          durationMs: value.durationMs,
        },
      })
    })

    worker.on('error', (err: Error) => {
      if (phase === 'RUNNING') {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Integrity worker encountered an uncaught error: ${err.message}`,
            'WORKER_UNCAUGHT_ERROR',
            undefined,
            'TERMINATION_UNCONFIRMED',
            { cause: err },
          ),
        })
      } else {
        lateErrors.push(err)
      }
    })

    worker.on('exit', (code: number) => {
      if (phase === 'RUNNING') {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Integrity worker exited prematurely before returning verification response (exit code ${code})`,
            'WORKER_PREMATURE_EXIT',
            undefined,
            'TERMINATION_UNCONFIRMED',
          ),
        })
      } else if (phase === 'TERMINATING') {
        if (code !== 0 && code !== 1) {
          const exitErr = new IntegrityVerificationError(
            `Integrity worker exited prematurely with abnormal exit code ${code}`,
            'WORKER_PREMATURE_EXIT',
            undefined,
            'TERMINATION_UNCONFIRMED',
          )
          lateErrors.push(exitErr)
        }
      }
    })
  })
}
