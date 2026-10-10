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
import { existsSync, lstatSync, statSync, type Stats } from 'node:fs'
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
 * File identity signature used to verify candidate file authenticity before deletion.
 */
export interface CandidateFileIdentity {
  readonly dev: number
  readonly ino: number
  readonly birthtimeMs: number
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Capture file identity signature for candidate database path.
 */
export function captureCandidateFileIdentity(filePath: string): CandidateFileIdentity | null {
  try {
    const st = statSync(filePath)
    return {
      dev: st.dev,
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs,
      size: st.size,
    }
  } catch {
    return null
  }
}

/**
 * Check whether a file's current stat matches the recorded candidate file identity.
 */
export function matchesCandidateFileIdentity(
  currentStat: Stats,
  recorded: CandidateFileIdentity,
): boolean {
  if (recorded.ino !== 0 && currentStat.ino !== 0) {
    return currentStat.dev === recorded.dev && currentStat.ino === recorded.ino
  }
  return (
    currentStat.dev === recorded.dev &&
    Math.abs(currentStat.birthtimeMs - recorded.birthtimeMs) < 10 &&
    currentStat.size === recorded.size
  )
}

/**
 * Private symbol brand ensuring authentic supervisor provenance for worker exit proofs.
 */
export const EXIT_PROOF_BRAND = Symbol('dsh.worker.exit_proof_brand')

/**
 * Module-private symbol token guaranteeing authentic supervisor provenance.
 * Kept strictly inside module scope (unexported) so no external code can forge it.
 */
const AUTHENTIC_EXIT_PROOF_TOKEN = Symbol('dsh.worker.authentic_exit_proof_token')

/**
 * Closed-scope WeakSet maintaining referential identity of authentic exit proofs.
 * Unreachable outside this module closure.
 */
const authenticExitProofs = new WeakSet<object>()

/**
 * Structurally reliable proof of worker termination.
 */
export interface WorkerExitProof {
  readonly workerId: string
  readonly exitCode: number
  readonly confirmedAt: number
  readonly proofSource: 'terminate' | 'exit_event'
  /** @internal Private cryptographic/symbol token guaranteeing supervisor provenance. */
  readonly [EXIT_PROOF_BRAND]?: boolean
}

/**
 * Options for constructing {@link WorkerTerminationError}.
 */
export interface WorkerTerminationErrorOptions {
  readonly cause?: unknown
  readonly workerId?: string
  readonly candidatePath?: string
  readonly candidateFileIdentity?: CandidateFileIdentity | null
}

/**
 * Error thrown when worker termination fails or cannot be confirmed within deadline.
 */
export class WorkerTerminationError extends Error {
  readonly errorCode = 'WORKER_TERMINATION_FAILED'
  readonly terminationStatus: WorkerTerminationStatus
  readonly workerId?: string
  readonly candidatePath?: string
  readonly candidateFileIdentity?: CandidateFileIdentity | null

  constructor(
    message: string,
    terminationStatus: WorkerTerminationStatus = 'TERMINATION_UNCONFIRMED',
    options?: WorkerTerminationErrorOptions,
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'WorkerTerminationError'
    this.terminationStatus = terminationStatus
    this.workerId = options?.workerId
    this.candidatePath = options?.candidatePath
    this.candidateFileIdentity = options?.candidateFileIdentity ?? null
  }
}

/**
 * Error thrown when quarantine recovery cannot be safely completed.
 */
export class QuarantineRecoveryError extends WorkerTerminationError {
  readonly directory: string

  constructor(
    message: string,
    errorCode = 'QUARANTINE_RECOVERY_REFUSED',
    directory = '',
    candidatePath?: string,
    workerId?: string,
    options?: { cause?: unknown; candidateFileIdentity?: CandidateFileIdentity | null },
  ) {
    super(message, 'TERMINATION_UNCONFIRMED', {
      cause: options?.cause,
      workerId,
      candidatePath,
      candidateFileIdentity: options?.candidateFileIdentity,
    })
    this.name = 'QuarantineRecoveryError'
    Object.defineProperty(this, 'errorCode', {
      value: errorCode,
      writable: true,
      configurable: true,
    })
    this.directory = directory
  }
}

/**
 * Options for constructing {@link IntegrityVerificationError}.
 */
export interface IntegrityVerificationErrorOptions {
  readonly cause?: unknown
  readonly workerId?: string
  readonly candidatePath?: string
  readonly candidateFileIdentity?: CandidateFileIdentity | null
}

/**
 * Error thrown when integrity verification fails or cannot complete safely.
 */
export class IntegrityVerificationError extends Error {
  readonly errorCode: string
  readonly durationMs?: number
  terminationStatus: WorkerTerminationStatus
  readonly workerId?: string
  readonly candidatePath?: string
  readonly candidateFileIdentity?: CandidateFileIdentity | null

  constructor(
    message: string,
    errorCode = 'INTEGRITY_VERIFICATION_FAILED',
    durationMs?: number,
    terminationStatus: WorkerTerminationStatus = 'TERMINATED_CONFIRMED',
    options?: IntegrityVerificationErrorOptions,
  ) {
    super(message, options ? { cause: options.cause } : undefined)
    this.name = 'IntegrityVerificationError'
    this.errorCode = errorCode
    this.durationMs = durationMs
    this.terminationStatus = terminationStatus
    this.workerId = options?.workerId
    this.candidatePath = options?.candidatePath
    this.candidateFileIdentity = options?.candidateFileIdentity ?? null
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
 * Extract worker termination identifiers and candidate metadata from an error or aggregate error.
 */
export function extractWorkerTerminationInfo(err: unknown): {
  workerId?: string
  candidatePath?: string
  candidateFileIdentity?: CandidateFileIdentity | null
} | null {
  if (!err || typeof err !== 'object') {
    return null
  }
  const obj = err as Record<string, unknown>
  const workerId = typeof obj.workerId === 'string' ? obj.workerId : undefined
  const candidatePath = typeof obj.candidatePath === 'string' ? obj.candidatePath : undefined
  const candidateFileIdentity =
    obj.candidateFileIdentity && typeof obj.candidateFileIdentity === 'object'
      ? (obj.candidateFileIdentity as CandidateFileIdentity)
      : null

  if (workerId || candidatePath || candidateFileIdentity) {
    return { workerId, candidatePath, candidateFileIdentity }
  }

  if (err instanceof AggregateError) {
    for (const sub of err.errors) {
      const extracted = extractWorkerTerminationInfo(sub)
      if (extracted?.workerId || extracted?.candidatePath || extracted?.candidateFileIdentity) {
        return extracted
      }
    }
  }

  return null
}

/**
 * Structural interface for worker instances, enabling internal adapter injection.
 */
export interface WorkerLike {
  on(event: 'message', listener: (value: any) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  removeListener?(event: string, listener: (...args: any[]) => void): this
  removeAllListeners(event?: string): this
  terminate(): Promise<number>
}

/**
 * Active session tracking a worker instance during candidate verification.
 */
export interface WorkerSupervisorSession {
  readonly workerId: string
  readonly candidatePath: string
  readonly candidateFileIdentity: CandidateFileIdentity | null
  readonly worker: WorkerLike
  readonly status: WorkerTerminationStatus | 'RUNNING' | 'TERMINATING'
  readonly exitProof: WorkerExitProof | null
  readonly lateErrors: readonly Error[]
  waitForExit(timeoutMs?: number): Promise<WorkerExitProof>
  cleanupListeners?: () => void
}

/**
 * Registration parameters for the worker supervisor.
 */
export interface WorkerSupervisorRegistrationParams {
  readonly worker: WorkerLike
  readonly candidatePath: string
  readonly candidateFileIdentity?: CandidateFileIdentity | null
  readonly workerId?: string
}

interface WorkerTrackingRecordInternal {
  readonly workerId: string
  readonly candidatePath: string
  readonly candidateFileIdentity: CandidateFileIdentity | null
  readonly worker: WorkerLike
  readonly spawnedAt: number
  status: WorkerTerminationStatus | 'RUNNING' | 'TERMINATING'
  exitProof: WorkerExitProof | null
  readonly lateErrors: Error[]
  readonly exitPromise: Promise<WorkerExitProof>
  readonly resolveExit: (proof: WorkerExitProof) => void
  readonly rejectExit: (err: Error) => void
  exitListenersCleaned: boolean
  cleanupListeners?: () => void
}

/**
 * Supervisor tracking active and terminating worker lifecycles, exit proofs,
 * and candidate file associations.
 */
export class WorkerSupervisor {
  readonly #records = new Map<string, WorkerTrackingRecordInternal>()
  readonly #byCandidate = new Map<string, string>()

  registerWorker(params: WorkerSupervisorRegistrationParams): WorkerSupervisorSession {
    const workerId = params.workerId ?? randomUUID()
    const resolvedPath = resolve(params.candidatePath)
    const fileIdentity = params.candidateFileIdentity ?? captureCandidateFileIdentity(resolvedPath)

    let resolveExitPromise!: (proof: WorkerExitProof) => void
    let rejectExitPromise!: (err: Error) => void
    const exitPromise = new Promise<WorkerExitProof>((res, rej) => {
      resolveExitPromise = res
      rejectExitPromise = rej
    })

    const record: WorkerTrackingRecordInternal = {
      workerId,
      candidatePath: resolvedPath,
      candidateFileIdentity: fileIdentity,
      worker: params.worker,
      spawnedAt: Date.now(),
      status: 'RUNNING',
      exitProof: null,
      lateErrors: [],
      exitPromise,
      resolveExit: resolveExitPromise,
      rejectExit: rejectExitPromise,
      exitListenersCleaned: false,
    }

    // Closed-scope authentic exit proof creator.
    // Can ONLY be invoked by the worker's own authentic exit event or settled terminate() promise.
    const confirmExit = (exitCode: number, proofSource: 'terminate' | 'exit_event'): WorkerExitProof => {
      if (!record.exitProof) {
        const proof: WorkerExitProof = Object.freeze({
          workerId,
          exitCode: typeof exitCode === 'number' ? exitCode : 0,
          confirmedAt: Date.now(),
          proofSource,
          [EXIT_PROOF_BRAND]: true,
          [AUTHENTIC_EXIT_PROOF_TOKEN]: true,
        })
        authenticExitProofs.add(proof)
        record.exitProof = proof
        record.status = 'TERMINATED_CONFIRMED'
        record.cleanupListeners?.()
        record.resolveExit(proof)
      }
      return record.exitProof
    }

    const onExit = (code: number) => {
      confirmExit(code, 'exit_event')
    }

    const onError = (err: Error) => {
      record.lateErrors.push(err)
    }

    params.worker.on('exit', onExit)
    params.worker.on('error', onError)

    if (typeof params.worker.terminate === 'function') {
      const originalTerminate = params.worker.terminate.bind(params.worker)
      const wrappedTerminate = async function (): Promise<number> {
        try {
          const result = await originalTerminate()
          const code = typeof result === 'number' ? result : 0
          confirmExit(code, 'terminate')
          return code
        } catch (termErr) {
          if (record.status !== 'TERMINATED_CONFIRMED') {
            record.status = 'TERMINATION_UNCONFIRMED'
            record.lateErrors.push(termErr instanceof Error ? termErr : new Error(String(termErr)))
          }
          throw termErr
        }
      }
      try {
        params.worker.terminate = wrappedTerminate
      } catch {
        Object.defineProperty(params.worker, 'terminate', {
          value: wrappedTerminate,
          writable: true,
          configurable: true,
        })
      }
    }

    record.cleanupListeners = () => {
      if (!record.exitListenersCleaned) {
        record.exitListenersCleaned = true
        try {
          if (typeof params.worker.removeListener === 'function') {
            params.worker.removeListener('exit', onExit)
            params.worker.removeListener('error', onError)
          }
        } catch {
          // ignore
        }
        // Safe late-error absorber: prevent unhandled 'error' event crash
        try {
          if (typeof params.worker.on === 'function') {
            params.worker.on('error', (err: Error) => {
              record.lateErrors.push(err)
            })
          }
        } catch {
          // ignore
        }
      }
    }

    this.#records.set(workerId, record)
    this.#byCandidate.set(resolvedPath, workerId)

    return {
      workerId,
      candidatePath: resolvedPath,
      candidateFileIdentity: fileIdentity,
      worker: params.worker,
      get status() {
        return record.status
      },
      get exitProof() {
        return record.exitProof
      },
      get lateErrors() {
        return record.lateErrors
      },
      waitForExit: (timeoutMs) => this.waitForExit(workerId, timeoutMs),
      cleanupListeners: () => record.cleanupListeners?.(),
    }
  }

  getExitProof(workerId: string): WorkerExitProof | null {
    const rec = this.#records.get(workerId)
    return rec?.exitProof ?? null
  }

  getSession(workerId: string): WorkerSupervisorSession | null {
    const rec = this.#records.get(workerId)
    if (!rec) return null
    return {
      workerId: rec.workerId,
      candidatePath: rec.candidatePath,
      candidateFileIdentity: rec.candidateFileIdentity,
      worker: rec.worker,
      get status() {
        return rec.status
      },
      get exitProof() {
        return rec.exitProof
      },
      get lateErrors() {
        return rec.lateErrors
      },
      waitForExit: (timeoutMs) => this.waitForExit(rec.workerId, timeoutMs),
      cleanupListeners: () => rec.cleanupListeners?.(),
    }
  }

  getSessionByCandidatePath(candidatePath: string): WorkerSupervisorSession | null {
    const workerId = this.#byCandidate.get(resolve(candidatePath))
    if (!workerId) return null
    return this.getSession(workerId)
  }

  /**
   * Refuses manual termination confirmation via terminate.
   * Authentic exit proofs can ONLY originate from genuine worker exit events
   * or settled terminate() promises bound at registration time.
   */
  recordTerminationViaTerminate(workerId: string, _exitCode: number): never {
    throw new WorkerTerminationError(
      `Cannot record termination via terminate: manual proof generation is forbidden for workerId "${workerId}". ` +
      'Exit proofs must originate from authentic worker exit events or settled terminate() promises.',
      'TERMINATION_UNCONFIRMED',
      { workerId },
    )
  }

  /**
   * Refuses manual termination confirmation.
   * Authentic exit proofs can ONLY originate from genuine worker exit events
   * or settled terminate() promises bound at registration time.
   */
  recordTerminationConfirmed(
    workerId: string,
    _exitCode: number,
    _proofSource: 'terminate' | 'exit_event' = 'exit_event',
  ): never {
    throw new WorkerTerminationError(
      `Cannot record termination confirmation: manual proof generation is forbidden for workerId "${workerId}". ` +
      'Exit proofs must originate from authentic worker exit events or settled terminate() promises.',
      'TERMINATION_UNCONFIRMED',
      { workerId },
    )
  }

  /**
   * Refuses test injection into production supervisor provenance.
   */
  _injectTerminationConfirmedForTesting(
    workerId: string,
    _exitCode: number,
    _proofSource: 'terminate' | 'exit_event' = 'exit_event',
  ): never {
    throw new WorkerTerminationError(
      `Cannot inject termination confirmation: test injection is segregated from authentic supervisor provenance for workerId "${workerId}".`,
      'TERMINATION_UNCONFIRMED',
      { workerId },
    )
  }

  isExitProofAuthentic(proof: unknown): proof is WorkerExitProof {
    if (!proof || typeof proof !== 'object') return false
    const p = proof as WorkerExitProof & Record<symbol, unknown>
    if (!authenticExitProofs.has(p)) return false
    if (p[AUTHENTIC_EXIT_PROOF_TOKEN] !== true) return false
    if (typeof p.workerId !== 'string') return false
    const rec = this.#records.get(p.workerId)
    if (!rec || !rec.exitProof) return false
    if (rec.exitProof !== p) return false
    return (
      rec.exitProof.workerId === p.workerId &&
      rec.exitProof.exitCode === p.exitCode &&
      rec.exitProof.confirmedAt === p.confirmedAt &&
      rec.exitProof.proofSource === p.proofSource
    )
  }

  recordTerminationUnconfirmed(workerId: string, error?: Error): void {
    const rec = this.#records.get(workerId)
    if (rec && rec.status !== 'TERMINATED_CONFIRMED') {
      rec.status = 'TERMINATION_UNCONFIRMED'
      if (error) {
        rec.lateErrors.push(error)
      }
    }
  }

  async waitForExit(workerId: string, timeoutMs = 5000): Promise<WorkerExitProof> {
    const rec = this.#records.get(workerId)
    if (!rec) {
      throw new WorkerTerminationError(
        `No tracked worker found for workerId "${workerId}"`,
        'TERMINATION_UNCONFIRMED',
      )
    }

    if (rec.exitProof) {
      return rec.exitProof
    }

    if (timeoutMs <= 0) {
      throw new WorkerTerminationError(
        `Worker "${workerId}" has not exited and wait timeout is 0ms`,
        'TERMINATION_UNCONFIRMED',
        { workerId, candidatePath: rec.candidatePath, candidateFileIdentity: rec.candidateFileIdentity },
      )
    }

    let timer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new WorkerTerminationError(
            `Timed out after ${timeoutMs}ms waiting for worker exit confirmation (workerId: ${workerId})`,
            'TERMINATION_UNCONFIRMED',
            { workerId, candidatePath: rec.candidatePath, candidateFileIdentity: rec.candidateFileIdentity },
          ),
        )
      }, timeoutMs)
    })

    try {
      return await Promise.race([rec.exitPromise, timeoutPromise])
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }

  unregisterWorker(workerId: string): void {
    const rec = this.#records.get(workerId)
    if (rec) {
      rec.cleanupListeners?.()
      this.#byCandidate.delete(rec.candidatePath)
      this.#records.delete(workerId)
    }
  }

  getActiveSessionCount(): number {
    return this.#records.size
  }

  hasSession(workerId: string): boolean {
    return this.#records.has(workerId)
  }

  getTrackedWorkerIds(): string[] {
    return Array.from(this.#records.keys())
  }

  resetForTesting(): void {
    for (const rec of this.#records.values()) {
      rec.cleanupListeners?.()
    }
    this.#records.clear()
    this.#byCandidate.clear()
  }
}

/** Global singleton worker supervisor. */
export const workerSupervisor = new WorkerSupervisor()

/**
 * Access the global worker supervisor.
 */
export function getWorkerSupervisor(): WorkerSupervisor {
  return workerSupervisor
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

  const candidateFileIdentity = captureCandidateFileIdentity(resolvedCandidatePath)
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
      { cause: spawnErr, candidatePath: resolvedCandidatePath, candidateFileIdentity },
    )
  }

  const session = workerSupervisor.registerWorker({
    worker,
    candidatePath: resolvedCandidatePath,
    candidateFileIdentity,
  })
  const workerId = session.workerId

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
                { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
              ),
            )
          }, terminationTimeoutMs)
        })

        await Promise.race([termPromise, timeoutPromise])
        terminationStatus = 'TERMINATED_CONFIRMED'
      } catch (termErr) {
        terminationStatus = 'TERMINATION_UNCONFIRMED'
        workerSupervisor.recordTerminationUnconfirmed(
          workerId,
          termErr instanceof Error ? termErr : new Error(String(termErr)),
        )
        terminateError =
          termErr instanceof WorkerTerminationError
            ? termErr
            : new WorkerTerminationError(
                `Integrity worker termination failed: ${termErr instanceof Error ? termErr.message : String(termErr)}`,
                'TERMINATION_UNCONFIRMED',
                {
                  cause: termErr,
                  workerId,
                  candidatePath: resolvedCandidatePath,
                  candidateFileIdentity,
                },
              )
      } finally {
        if (termTimeoutTimer !== null) {
          clearTimeout(termTimeoutTimer)
          termTimeoutTimer = null
        }
      }

      // Only clean up worker listeners once termination completes/fails
      if (terminationStatus === 'TERMINATED_CONFIRMED') {
        session.cleanupListeners?.()
        try {
          if (typeof worker.removeAllListeners === 'function') {
            worker.removeAllListeners()
          }
          if (typeof worker.on === 'function') {
            worker.on('error', () => {})
          }
        } catch {
          // ignore
        }
      } else {
        // Retain supervisor exit tracking and error shield on unconfirmed worker
        try {
          if (typeof worker.removeListener === 'function') {
            worker.removeListener('message', onMessage)
            worker.removeListener('error', onErrorVerification)
            worker.removeListener('exit', onExitVerification)
          } else if (typeof worker.removeAllListeners === 'function') {
            worker.removeAllListeners('message')
          }
        } catch {
          // ignore
        }
      }

      phase = 'SETTLED'

      // Separate integrity verification outcome from worker termination outcome:
      // Update terminationStatus on primaryOutcome.error to reflect actual termination outcome
      if (primaryOutcome?.kind === 'failure') {
        const err = primaryOutcome.error
        if (err instanceof IntegrityVerificationError) {
          err.terminationStatus = terminationStatus
        }
      }

      // Evaluate late errors
      if (lateErrors.length > 0) {
        if (primaryOutcome?.kind === 'success') {
          const firstLate = lateErrors[0]!
          const lateErr = new IntegrityVerificationError(
            `Integrity worker encountered late error: ${firstLate.message}`,
            'WORKER_UNCAUGHT_ERROR',
            primaryOutcome.result.durationMs,
            terminationStatus,
            { cause: firstLate, workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
          )
          if (terminationStatus === 'TERMINATED_CONFIRMED') {
            workerSupervisor.unregisterWorker(workerId)
          }
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
          if (base instanceof IntegrityVerificationError) {
            base.terminationStatus = terminationStatus
          }
          const all = [
            base,
            ...lateErrors,
            ...(terminateError ? [terminateError] : []),
          ]
          if (terminationStatus === 'TERMINATED_CONFIRMED') {
            workerSupervisor.unregisterWorker(workerId)
          }
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
          if (base instanceof IntegrityVerificationError) {
            base.terminationStatus = 'TERMINATION_UNCONFIRMED'
          }
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
        workerSupervisor.unregisterWorker(workerId)
        resolvePromise(primaryOutcome.result)
      } else {
        if (terminationStatus === 'TERMINATED_CONFIRMED') {
          workerSupervisor.unregisterWorker(workerId)
        }
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
          { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
        ),
      })
    }, timeoutMs)

    const onMessage = (value: unknown): void => {
      if (phase !== 'RUNNING') return

      if (!isValidIntegrityResponse(value)) {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            'Integrity worker returned invalid or unrecognized IPC response structure',
            'INVALID_IPC_RESPONSE',
            undefined,
            'TERMINATION_UNCONFIRMED',
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
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
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
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
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
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
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
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
    }

    const onErrorVerification = (err: Error): void => {
      if (phase === 'RUNNING') {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Integrity worker encountered an uncaught error: ${err.message}`,
            'WORKER_UNCAUGHT_ERROR',
            undefined,
            'TERMINATION_UNCONFIRMED',
            { cause: err, workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
          ),
        })
      } else {
        lateErrors.push(err)
      }
    }

    const onExitVerification = (code: number): void => {
      if (phase === 'RUNNING') {
        initiateTermination({
          kind: 'failure',
          error: new IntegrityVerificationError(
            `Integrity worker exited prematurely before returning verification response (exit code ${code})`,
            'WORKER_PREMATURE_EXIT',
            undefined,
            'TERMINATION_UNCONFIRMED',
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
          ),
        })
      } else if (phase === 'TERMINATING') {
        if (code !== 0 && code !== 1) {
          const exitErr = new IntegrityVerificationError(
            `Integrity worker exited prematurely with abnormal exit code ${code}`,
            'WORKER_PREMATURE_EXIT',
            undefined,
            'TERMINATION_UNCONFIRMED',
            { workerId, candidatePath: resolvedCandidatePath, candidateFileIdentity },
          )
          lateErrors.push(exitErr)
        }
      }
    }

    worker.on('message', onMessage)
    worker.on('error', onErrorVerification)
    worker.on('exit', onExitVerification)
  })
}
