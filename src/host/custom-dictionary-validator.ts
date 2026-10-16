/**
 * Supervisor and lifecycle manager for custom SQLite snapshot creation and worker validation.
 *
 * Implements Phase 7A.8.1A Task B & Task C:
 * - Worker supervisor with unique request ID tracking.
 * - Strict worker lifecycle management: timeout, AbortSignal cancellation, crash handling.
 * - Bounded concurrency constraint (default 1 concurrent worker, configurable).
 * - Guaranteed worker termination and Windows file handle release proof.
 * - Fail-closed error classification (TIMEOUT, CANCELLED, INVALID_SQLITE_FILE, INVALID_DATABASE_SCHEMA, MISSING_REQUIRED_INDEX, etc.).
 * - Graceful host disposal without unhandled rejections or dangling worker threads.
 *
 * @module dsh-word-lookup/host/custom-dictionary-validator
 */

import { randomUUID } from 'node:crypto'
import type { URL } from 'node:url'
import {
  spawnIntegrityWorker,
  type WorkerLike,
} from './ecdict-integrity-verifier.js'
import type {
  CompanionWorkerRequest,
  CustomSnapshotCreateRequest,
  CustomSnapshotCreateSuccessResponse,
  CustomSnapshotValidateRequest,
  CustomSnapshotValidateSuccessResponse,
  CustomWorkerFailureResponse,
} from './ecdict-integrity-worker.js'

/** Error thrown when a validation worker times out. */
export class ValidatorTimeoutError extends Error {
  readonly code = 'TIMEOUT'
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.name = 'ValidatorTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Error thrown when a validation worker task is aborted via AbortSignal. */
export class ValidatorCancelledError extends Error {
  readonly code = 'CANCELLED'

  constructor(message: string) {
    super(message)
    this.name = 'ValidatorCancelledError'
  }
}

/** Error thrown when a validation worker task crashes abnormally. */
export class ValidatorCrashError extends Error {
  readonly code = 'WORKER_CRASHED'
  readonly exitCode: number | null

  constructor(message: string, exitCode: number | null) {
    super(message)
    this.name = 'ValidatorCrashError'
    this.exitCode = exitCode
  }
}

/** Error thrown when a validator supervisor is disposed. */
export class ValidatorDisposedError extends Error {
  readonly code = 'HOST_DISPOSED'

  constructor(message: string = 'Validator supervisor has been disposed') {
    super(message)
    this.name = 'ValidatorDisposedError'
  }
}

/** Error thrown when worker execution fails with a classified failure response. */
export class ValidatorExecutionError extends Error {
  readonly code: string
  readonly durationMs?: number

  constructor(message: string, code: string, durationMs?: number) {
    super(message)
    this.name = 'ValidatorExecutionError'
    this.code = code
    this.durationMs = durationMs
  }
}

/** Options for configuring the CustomDictionaryValidator. */
export interface CustomDictionaryValidatorOptions {
  /** Maximum concurrent worker tasks. Defaults to 1 (serial isolation). */
  readonly maxConcurrency?: number
  /** Default timeout in milliseconds for operations. Defaults to 30,000 ms. */
  readonly defaultTimeoutMs?: number
  /** Optional Worker adapter factory (for testing). */
  readonly workerAdapter?: (request: CompanionWorkerRequest) => WorkerLike
  /** Optional worker URL override. */
  readonly workerUrl?: URL
}

/** Options for individual validation or snapshot tasks. */
export interface CustomValidatorTaskOptions {
  /** Specific timeout in milliseconds for this task. */
  readonly timeoutMs?: number
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal
  /** Maximum allowed size of candidate database in bytes. */
  readonly maxSizeBytes?: number
}

interface QueuedTask<T> {
  readonly execute: () => Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly signal?: AbortSignal
}

/**
 * Supervisor for custom SQLite snapshot creation and validation in worker threads.
 */
export class CustomDictionaryValidator {
  readonly #maxConcurrency: number
  readonly #defaultTimeoutMs: number
  readonly #workerAdapter?: (request: CompanionWorkerRequest) => WorkerLike
  readonly #workerUrl?: URL

  #activeWorkers = new Set<WorkerLike>()
  #queue: Array<QueuedTask<any>> = []
  #runningCount = 0
  #disposed = false

  constructor(options?: CustomDictionaryValidatorOptions) {
    this.#maxConcurrency = Math.max(1, Math.min(2, options?.maxConcurrency ?? 1))
    this.#defaultTimeoutMs = Math.max(1000, options?.defaultTimeoutMs ?? 30000)
    this.#workerAdapter = options?.workerAdapter
    this.#workerUrl = options?.workerUrl
  }

  /**
   * Check whether supervisor is disposed.
   */
  get isDisposed(): boolean {
    return this.#disposed
  }

  /**
   * Number of operations currently running.
   */
  get runningCount(): number {
    return this.#runningCount
  }

  /**
   * Execute snapshot creation using worker thread.
   */
  async createSnapshot(
    sourcePath: string,
    stagingPath: string,
    options?: CustomValidatorTaskOptions,
  ): Promise<CustomSnapshotCreateSuccessResponse> {
    const requestId = randomUUID()
    const request: CustomSnapshotCreateRequest = {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      sourcePath,
      stagingPath,
      maxSizeBytes: options?.maxSizeBytes,
    }

    return this.#scheduleTask(request, options) as Promise<CustomSnapshotCreateSuccessResponse>
  }

  /**
   * Execute comprehensive snapshot validation using worker thread.
   */
  async validateSnapshot(
    snapshotPath: string,
    options?: CustomValidatorTaskOptions,
  ): Promise<CustomSnapshotValidateSuccessResponse> {
    const requestId = randomUUID()
    const request: CustomSnapshotValidateRequest = {
      action: 'CUSTOM_SNAPSHOT_VALIDATE',
      requestId,
      snapshotPath,
      maxSizeBytes: options?.maxSizeBytes,
    }

    return this.#scheduleTask(request, options) as Promise<CustomSnapshotValidateSuccessResponse>
  }

  /**
   * Dispose supervisor, aborting in-flight workers and rejecting queued tasks.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true

    // Reject queued tasks
    const queued = [...this.#queue]
    this.#queue = []
    for (const task of queued) {
      task.reject(new ValidatorDisposedError())
    }

    // Terminate all active workers
    const active = [...this.#activeWorkers]
    this.#activeWorkers.clear()
    await Promise.all(
      active.map(async (worker) => {
        try {
          await worker.terminate()
        } catch {
          // Ignore
        }
      }),
    )
  }

  #scheduleTask<T>(
    request: CompanionWorkerRequest,
    options?: CustomValidatorTaskOptions,
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new ValidatorDisposedError())
    }

    if (options?.signal?.aborted) {
      return Promise.reject(new ValidatorCancelledError('Operation aborted before start'))
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        execute: () => this.#runWorkerTask<T>(request, options),
        resolve,
        reject,
        signal: options?.signal,
      }

      this.#queue.push(task)
      this.#drainQueue()
    })
  }

  #drainQueue(): void {
    if (this.#disposed) return

    while (this.#runningCount < this.#maxConcurrency && this.#queue.length > 0) {
      const nextTask = this.#queue.shift()
      if (!nextTask) break

      if (nextTask.signal?.aborted) {
        nextTask.reject(new ValidatorCancelledError('Operation aborted in queue'))
        continue
      }

      this.#runningCount++
      nextTask
        .execute()
        .then(nextTask.resolve, nextTask.reject)
        .finally(() => {
          this.#runningCount--
          this.#drainQueue()
        })
    }
  }

  #runWorkerTask<T>(
    request: CompanionWorkerRequest,
    options?: CustomValidatorTaskOptions,
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new ValidatorDisposedError())
    }

    const signal = options?.signal
    if (signal?.aborted) {
      return Promise.reject(new ValidatorCancelledError('Operation aborted before execution'))
    }

    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs

    return new Promise<T>((resolve, reject) => {
      let phase: 'RUNNING' | 'TERMINATING' | 'SETTLED' = 'RUNNING'
      let timer: ReturnType<typeof setTimeout> | null = null
      let worker: WorkerLike | null = null
      let receivedResponse: any = null
      let terminationOutcome:
        | { success: true; result: T }
        | { success: false; error: unknown }
        | null = null

      const finalize = () => {
        if (phase === 'SETTLED') return
        phase = 'SETTLED'
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
        if (worker) {
          this.#activeWorkers.delete(worker)
        }
        if (terminationOutcome) {
          if (terminationOutcome.success) {
            resolve(terminationOutcome.result)
          } else {
            reject(terminationOutcome.error)
          }
        }
      }

      const initiateTermination = (
        outcome: { success: true; result: T } | { success: false; error: unknown },
      ) => {
        if (phase !== 'RUNNING') return
        phase = 'TERMINATING'
        terminationOutcome = outcome
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
        if (worker) {
          void worker.terminate().finally(() => {
            finalize()
          })
        } else {
          finalize()
        }
      }

      const onAbort = () => {
        initiateTermination({
          success: false,
          error: new ValidatorCancelledError('Operation was cancelled by AbortSignal'),
        })
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      timer = setTimeout(() => {
        initiateTermination({
          success: false,
          error: new ValidatorTimeoutError(
            `Custom SQLite worker operation timed out after ${timeoutMs}ms`,
            timeoutMs,
          ),
        })
      }, timeoutMs)

      try {
        if (this.#workerAdapter) {
          worker = this.#workerAdapter(request)
        } else {
          worker = spawnIntegrityWorker(request, {
            workerUrl: this.#workerUrl,
          }) as unknown as WorkerLike
        }

        this.#activeWorkers.add(worker)

        worker.on('message', (msg: unknown) => {
          if (phase !== 'RUNNING') return
          receivedResponse = msg
        })

        worker.on('error', (err: unknown) => {
          if (phase !== 'RUNNING') return
          const rawMessage = err instanceof Error ? err.message : String(err)
          initiateTermination({
            success: false,
            error: new ValidatorExecutionError(rawMessage, 'WORKER_ERROR'),
          })
        })

        worker.on('exit', (code: number) => {
          if (phase === 'TERMINATING') {
            finalize()
            return
          }
          if (phase !== 'RUNNING') return

          // Successful completion: message was received
          if (receivedResponse !== null) {
            if (receivedResponse.success === true) {
              initiateTermination({
                success: true,
                result: receivedResponse as T,
              })
            } else {
              const failResp = receivedResponse as CustomWorkerFailureResponse
              initiateTermination({
                success: false,
                error: new ValidatorExecutionError(
                  failResp.message || 'Worker operation failed',
                  failResp.errorCode || 'VALIDATION_FAILED',
                  failResp.durationMs,
                ),
              })
            }
            return
          }

          // Exited without message
          if (code !== 0) {
            initiateTermination({
              success: false,
              error: new ValidatorCrashError(
                `Worker exited abnormally with code ${code} without sending response`,
                code,
              ),
            })
          } else {
            initiateTermination({
              success: false,
              error: new ValidatorCrashError(
                'Worker exited cleanly (code 0) without sending response',
                code,
              ),
            })
          }
        })
      } catch (spawnErr: unknown) {
        const raw = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
        initiateTermination({
          success: false,
          error: new ValidatorExecutionError(`Failed to spawn worker: ${raw}`, 'SPAWN_FAILED'),
        })
      }
    })
  }
}
