/**
 * Supervisor and lifecycle manager for custom SQLite snapshot creation and worker validation.
 *
 * Implements Phase 7A.8.1A Task B & Task C:
 * - Worker supervisor with unique request ID tracking.
 * - Strict worker lifecycle management: timeout, AbortSignal cancellation, crash handling.
 * - Bounded concurrency constraint (default 1 concurrent worker, configurable).
 * - Bounded caller settlement, with physical exit tracking retained until an exit event.
 * - Fail-closed error classification (TIMEOUT, CANCELLED, INVALID_SQLITE_FILE, INVALID_DATABASE_SCHEMA, MISSING_REQUIRED_INDEX, etc.).
 * - Graceful host disposal without unhandled rejections or dangling worker threads.
 *
 * @module dsh-word-lookup/host/custom-dictionary-validator
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { URL } from 'node:url'
import {
  spawnIntegrityWorker,
  WorkerTerminationError,
  type WorkerLike,
} from './ecdict-integrity-verifier.js'
import type {
  CompanionWorkerRequest,
  CustomSnapshotCreateRequest,
  CustomSnapshotCreateSuccessResponse,
  CustomSnapshotValidateRequest,
  CustomSnapshotValidateSuccessResponse,
  CustomSnapshotPrePublishCheckRequest,
  CustomSnapshotPrePublishCheckSuccessResponse,
  CustomWorkerFailureResponse,
  CustomWorkerResponse,
} from './ecdict-integrity-worker.js'

/** Error thrown when TOCTOU tampering or file modification is detected during verification or publishing. */
export class SnapshotTamperingError extends Error {
  readonly code = 'SNAPSHOT_TAMPERING_DETECTED'

  constructor(message: string) {
    super(message)
    this.name = 'SnapshotTamperingError'
  }
}

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

/** Comparison key only: retain original spellings for I/O and existing containment checks. */
export function customWorkerPathIdentity(path: string): string {
  const absolute = resolvePath(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Caller failure is distinct from physical exit; compatible with managed uncertainty consumers. */
export class CustomWorkerTerminationError extends WorkerTerminationError {
  readonly code = 'TERMINATION_UNCONFIRMED'
  readonly terminationError: unknown

  constructor(primary: unknown, terminationError: unknown) {
    super('Custom worker exit is unconfirmed; files and worker capacity remain retained',
      'TERMINATION_UNCONFIRMED', { cause: primary })
    this.name = 'CustomWorkerTerminationError'
    this.terminationError = terminationError
  }
}

interface ActiveCustomWorker {
  readonly paths: readonly string[]
  readonly cancel: () => void
  readonly settled: Promise<void>
  uncertainty: CustomWorkerTerminationError | null
}

// A completed Worker can still emit a late error; this shield captures no task/file state.
const absorbLateWorkerError = () => {}

/** Options for configuring the CustomDictionaryValidator. */
export interface CustomDictionaryValidatorOptions {
  /** Maximum concurrent worker tasks. Defaults to 1 (serial isolation). */
  readonly maxConcurrency?: number
  /** Default timeout in milliseconds for operations. Defaults to 30,000 ms. */
  readonly defaultTimeoutMs?: number
  /** Exit-confirmation deadline after cancellation/failure. Defaults to 5000ms, like the managed verifier. */
  readonly terminationTimeoutMs?: number
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
  cleanupAbort?: () => void
}

/** Validate IPC identity and the success fields required by the requested action. */
function isValidCustomWorkerResponse(
  value: unknown,
  request: CompanionWorkerRequest,
): value is CustomWorkerResponse {
  if (typeof value !== 'object' || value === null || !('action' in request)) return false
  const response = value as Record<string, unknown>
  if (response.requestId !== request.requestId || response.action !== request.action) return false
  const isDuration = (duration: unknown) => typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
  const isCount = (count: unknown) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  if (response.success === false) {
    return typeof response.errorCode === 'string' && response.errorCode.length > 0 &&
      typeof response.message === 'string' &&
      (response.durationMs === undefined || isDuration(response.durationMs))
  }
  if (response.success !== true || !isDuration(response.durationMs) ||
    typeof response.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(response.sha256) ||
    !isCount(response.byteSize)) return false

  switch (request.action) {
    case 'CUSTOM_SNAPSHOT_CREATE':
      return true
    case 'CUSTOM_SNAPSHOT_VALIDATE':
      return isCount(response.schemaVersion) && response.schemaVersion !== 0 &&
        isCount(response.entryCount) && isCount(response.formCount) && isCount(response.exampleCount) &&
        Array.isArray(response.headwordsSample) && response.headwordsSample.every((word) => typeof word === 'string')
    case 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK':
      return response.matches === true
    default:
      return false
  }
}

/**
 * Supervisor for custom SQLite snapshot creation and validation in worker threads.
 */
export class CustomDictionaryValidator {
  readonly #maxConcurrency: number
  readonly #defaultTimeoutMs: number
  readonly #terminationTimeoutMs: number
  readonly #workerAdapter?: (request: CompanionWorkerRequest) => WorkerLike
  readonly #workerUrl?: URL

  #activeWorkers = new Map<WorkerLike, ActiveCustomWorker>()
  #queue: Array<QueuedTask<any>> = []
  #runningCount = 0
  #disposed = false

  constructor(options?: CustomDictionaryValidatorOptions) {
    this.#maxConcurrency = Math.max(1, Math.min(2, options?.maxConcurrency ?? 1))
    this.#defaultTimeoutMs = Math.max(1000, options?.defaultTimeoutMs ?? 30000)
    this.#terminationTimeoutMs = Number.isFinite(options?.terminationTimeoutMs)
      ? Math.max(1, options!.terminationTimeoutMs!) : 5000
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
   * Execute pre-publish hash and size verification using worker thread.
   */
  async prePublishCheck(
    stagingPath: string,
    expectedSha256: string,
    expectedByteSize: number,
    options?: CustomValidatorTaskOptions,
  ): Promise<CustomSnapshotPrePublishCheckSuccessResponse> {
    const requestId = randomUUID()
    const request: CustomSnapshotPrePublishCheckRequest = {
      action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
      requestId,
      stagingPath,
      expectedSha256,
      expectedByteSize,
      maxSizeBytes: options?.maxSizeBytes,
    }

    return this.#scheduleTask(request, options) as Promise<CustomSnapshotPrePublishCheckSuccessResponse>
  }

  /**
   * Dispose supervisor, aborting in-flight workers and rejecting queued tasks.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#rejectQueue(new ValidatorDisposedError())
    const active = [...this.#activeWorkers.values()]
    for (const record of active) record.cancel()
    await Promise.all(active.map(record => record.settled))
    const uncertainty = this.#uncertainty
    if (uncertainty) throw uncertainty
  }

  /** Paths stay protected after caller failure and disposal until physical exit is observed. */
  isPathInUse(path: string): boolean {
    const resolved = customWorkerPathIdentity(path)
    return [...this.#activeWorkers.values()].some(record => record.paths.includes(resolved))
  }

  get hasUnconfirmedWorkers(): boolean {
    return this.#uncertainty !== null
  }

  get #uncertainty(): CustomWorkerTerminationError | null {
    return [...this.#activeWorkers.values()].find(record => record.uncertainty)?.uncertainty ?? null
  }

  #rejectQueue(error: unknown): void {
    const queued = this.#queue.splice(0)
    for (const task of queued) { task.cleanupAbort?.(); task.reject(error) }
  }

  #scheduleTask<T>(
    request: CompanionWorkerRequest,
    options?: CustomValidatorTaskOptions,
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new ValidatorDisposedError())
    }

    if (this.#uncertainty) return Promise.reject(this.#uncertainty)

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

      if (options?.signal) {
        const signal = options.signal
        const abortQueued = () => {
          const index = this.#queue.indexOf(task)
          if (index < 0) return
          this.#queue.splice(index, 1)
          task.cleanupAbort?.()
          reject(new ValidatorCancelledError('Operation aborted in queue'))
        }
        signal.addEventListener('abort', abortQueued, { once: true })
        task.cleanupAbort = () => signal.removeEventListener('abort', abortQueued)
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
      nextTask.cleanupAbort?.()

      if (nextTask.signal?.aborted) {
        nextTask.reject(new ValidatorCancelledError('Operation aborted in queue'))
        continue
      }

      this.#runningCount++
      nextTask
        .execute()
        .then(nextTask.resolve, nextTask.reject)
    }
  }

  #runWorkerTask<T>(
    request: CompanionWorkerRequest,
    options?: CustomValidatorTaskOptions,
  ): Promise<T> {
    const signal = options?.signal
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs
    return new Promise<T>((resolve, reject) => {
      let worker: WorkerLike | null = null
      let response: CustomWorkerResponse | null = null
      let responseSeen = false
      let protocolError: ValidatorExecutionError | null = null
      let primary: unknown = null
      let terminating = false
      let settled = false
      let exited = false
      let released = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      let markSettled!: () => void
      const record: ActiveCustomWorker = {
        paths: Object.entries(request).filter(([key, value]) => key.endsWith('Path') && typeof value === 'string')
          .map(([, value]) => customWorkerPathIdentity(value as string)),
        cancel: () => terminate(new ValidatorDisposedError()),
        settled: new Promise<void>(r => { markSettled = r }),
        uncertainty: null,
      }
      const clearTaskControls = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        signal?.removeEventListener('abort', onAbort)
      }
      const settle = (error: unknown, value?: T) => {
        if (settled) return
        settled = true
        clearTaskControls()
        if (terminationTimer) clearTimeout(terminationTimer)
        terminationTimer = undefined
        markSettled()
        if (error) reject(error)
        else resolve(value!)
      }
      const release = () => {
        if (released) return
        released = true
        if (worker) {
          this.#activeWorkers.delete(worker)
          worker.removeListener?.('message', onMessage)
          worker.removeListener?.('exit', onExit)
          // Keep only a stateless late-error shield on the now-completed Worker.
          worker.on('error', absorbLateWorkerError)
          worker.removeListener?.('error', onError)
        }
        this.#runningCount--
        this.#drainQueue()
      }
      const unconfirmed = (terminationError: unknown) => {
        if (exited || settled) return
        record.uncertainty = new CustomWorkerTerminationError(primary, terminationError)
        settle(record.uncertainty)
        // A retained physical worker must not allow an indefinitely waiting queue or new work.
        this.#rejectQueue(record.uncertainty)
      }
      const terminate = (error: unknown) => {
        if (terminating || settled) return
        terminating = true
        primary = error
        clearTaskControls()
        if (!worker || exited) { release(); settle(primary); return }
        terminationTimer = setTimeout(() => unconfirmed(new Error(
          `Custom worker termination timed out after ${this.#terminationTimeoutMs}ms`)), this.#terminationTimeoutMs)
        try {
          // Terminate completion alone is not custom IPC/exit proof. Observe and handle every
          // promise, including a rejection arriving after the caller deadline or actual exit.
          void Promise.resolve(worker.terminate()).then(
            () => {},
            error => { unconfirmed(error) },
          )
        } catch (error) { unconfirmed(error) }
      }
      const onAbort = () => {
        // An adapter may abort synchronously while it is returning the Worker.
        if (worker) terminate(new ValidatorCancelledError('Operation was cancelled by AbortSignal'))
      }
      const onMessage = (value: unknown) => {
        if (terminating || settled) return
        if (responseSeen || !isValidCustomWorkerResponse(value, request)) {
          protocolError ??= new ValidatorExecutionError(
            responseSeen ? 'Worker sent more than one terminal response' : 'Worker response identity or payload is invalid',
            'WORKER_PROTOCOL_ERROR')
          responseSeen = true
          return
        }
        responseSeen = true
        response = value
      }
      const onError = (error: unknown) => {
        if (terminating || settled) return // listener also shields retained late errors
        terminate(new ValidatorExecutionError(error instanceof Error ? error.message : String(error), 'WORKER_ERROR'))
      }
      const onExit = (code: number) => {
        // Native Workers may report negative exit codes; missing/malformed payloads are not proof.
        if (!Number.isInteger(code) || exited) return
        exited = true
        release()
        if (settled) return // reclaim only; caller result cannot be overwritten
        if (terminating) { settle(primary); return }
        if (protocolError) { settle(protocolError); return }
        if (code !== 0 && response?.success === true) {
          settle(new ValidatorCrashError(`Worker exited abnormally with code ${code}`, code)); return
        }
        if (!response) {
          settle(new ValidatorCrashError(`Worker exited with code ${code} without sending response`, code)); return
        }
        if (response.success) { settle(null, response as T); return }
        const failure = response as CustomWorkerFailureResponse
        settle(failure.errorCode === 'SNAPSHOT_TAMPERING_DETECTED'
          ? new SnapshotTamperingError(failure.message || 'Snapshot tampering detected')
          : new ValidatorExecutionError(failure.message || 'Worker operation failed', failure.errorCode || 'VALIDATION_FAILED', failure.durationMs))
      }
      if (this.#disposed || signal?.aborted) {
        release()
        settle(this.#disposed ? new ValidatorDisposedError() : new ValidatorCancelledError('Operation aborted before execution'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => terminate(new ValidatorTimeoutError(
        `Custom SQLite worker operation timed out after ${timeoutMs}ms`, timeoutMs)), timeoutMs)
      try {
        worker = this.#workerAdapter ? this.#workerAdapter(request)
          : spawnIntegrityWorker(request, { workerUrl: this.#workerUrl }) as unknown as WorkerLike
        this.#activeWorkers.set(worker, record)
        worker.on('message', onMessage)
        worker.on('error', onError)
        worker.on('exit', onExit)
        if (this.#disposed) terminate(new ValidatorDisposedError())
        else if (signal?.aborted) onAbort()
      } catch (error) {
        terminate(new ValidatorExecutionError(`Failed to spawn worker: ${error instanceof Error ? error.message : String(error)}`, 'SPAWN_FAILED'))
      }
    })
  }
}
