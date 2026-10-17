/**
 * Host Dictionary Operation Manager for asynchronous lifecycle orchestration.
 *
 * Implements Phase 7A.6 DictionaryOperationManager:
 * - Single-instance task manager owned by Host lifecycle.
 * - Manages ECDICT download, source verification, static Worker build, and atomic activation.
 * - Enforces strict finite state machine with monotonic progress phases.
 * - Single in-flight operation mutex gating (no concurrent download/import pipelines).
 * - Safe cancellation dispatch with AbortSignal and idempotent cancel semantics.
 * - Throttles external progress notification to <= 10 Hz with observer error isolation.
 * - Bounded retention of last operation outcome.
 * - Clean disposal and drain support on plugin unload.
 *
 * @module dsh-word-lookup/host/dictionary-operations
 */

import { randomUUID } from 'node:crypto'
import type {
  DictionaryActivateCustomResponse,
  DictionaryOperationError,
  DictionaryOperationPhase,
  DictionaryOperationProgress,
  DictionaryOperationSnapshot,
  DictionaryOperationStatus,
  DictionaryRemoveResponse,
  DictionarySelectModeResponse,
} from '../shared/dictionary-management-protocol.js'
import type { ManagedStoragePaths } from './managed-storage.js'
import type { DictionaryMode } from './config.js'
import {
  downloadPinnedEcdict,
  type EcdictDownloadProgress,
} from './ecdict-downloader.js'
import {
  buildManagedEcdictDatabase,
  getQuarantineRecord,
  isDatabaseDirectoryQuarantined,
  type EcdictImportProgress,
  type ManagedEcdictBuildResult,
} from './ecdict-importer.js'
import { workerSupervisor } from './ecdict-integrity-verifier.js'
import type { ActivationCoordinator } from './dictionary-activation.js'

/** Minimum interval between throttled progress emissions in milliseconds (10 Hz). */
const PROGRESS_THROTTLE_MS = 100

/**
 * Error thrown when an install operation is requested while another is already running.
 */
export class OperationInProgressError extends Error {
  readonly code = 'OPERATION_IN_PROGRESS'
  readonly operationId: string

  constructor(operationId: string) {
    super(`Dictionary operation already in progress (operationId: ${operationId})`)
    this.name = 'OperationInProgressError'
    this.operationId = operationId
  }
}

/**
 * Error thrown when an operation is requested on a quarantined storage directory.
 */
export class OperationDirectoryQuarantinedError extends Error {
  readonly code = 'DIRECTORY_QUARANTINED'
  readonly directory: string
  readonly reason: string

  constructor(directory: string, reason: string) {
    super(`Cannot start operation: storage directory is quarantined (${reason})`)
    this.name = 'OperationDirectoryQuarantinedError'
    this.directory = directory
    this.reason = reason
  }
}

/**
 * Error thrown when attempting to cancel an unknown or settled operation.
 */
export class OperationNotFoundError extends Error {
  readonly code = 'OPERATION_NOT_FOUND'
  readonly operationId: string

  constructor(operationId: string) {
    super(`Operation not found: ${operationId}`)
    this.name = 'OperationNotFoundError'
    this.operationId = operationId
  }
}

/**
 * Error thrown when attempting to cancel an operation that has passed the commit boundary.
 */
export class OperationNotCancellableError extends Error {
  readonly code = 'OPERATION_NOT_CANCELLABLE'
  readonly operationId: string

  constructor(operationId: string) {
    super(`Operation "${operationId}" has passed the linearizable commit boundary and cannot be cancelled`)
    this.name = 'OperationNotCancellableError'
    this.operationId = operationId
  }
}

/**
 * Error thrown when draining in-flight operations times out during dispose.
 */
export class OperationDrainTimeoutError extends Error {
  readonly code = 'DRAIN_TIMEOUT'
  readonly timeoutMs: number

  constructor(timeoutMs: number, message?: string) {
    super(message ?? `Dictionary operation failed to drain within ${timeoutMs}ms: worker or network exit status unknown`)
    this.name = 'OperationDrainTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Diagnostic summary of resource drain and worker lifecycle status upon disposal.
 */
export interface OperationDrainSummary {
  /** Whether cancellation signal was dispatched. */
  readonly requestedCancel: boolean
  /** Whether the operation workflow settled completely. */
  readonly workflowSettled: boolean
  /** Whether worker termination was authentically confirmed via supervisor proof. */
  readonly workerExited: boolean
  /** Whether drain timed out before settlement. */
  readonly timedOut: boolean
  /** Whether worker or resource status is unknown (fail-closed). */
  readonly statusUnknown: boolean
  /** Whether database directory was left quarantined. */
  readonly quarantined: boolean
  /** Operation kind drained ('install' | 'remove' | 'none'). */
  readonly operationKind?: 'install' | 'remove' | 'none'
  /** Diagnostic error explanation if drain encountered issues. */
  readonly error?: string
}

/**
 * Internal hooks interface for concurrency failure injection in tests.
 */
export interface OperationHooks {
  readonly beforeRemoveDiskMutation?: () => Promise<void>
}

let operationHooks: OperationHooks | null = null

/**
 * Configure internal operation hooks for failure-injection testing.
 * @internal Test-only helper. Pass `null` to reset.
 */
export function _setOperationHooksForTesting(hooks: OperationHooks | null): void {
  operationHooks = hooks
}

/**
 * Sanitize error message to prevent leaking machine-specific paths, credentials, or stack traces.
 */
export function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') return 'Unknown error occurred'
  return rawMessage
    // Strip Windows drive paths (e.g., C:\... or E:\...)
    .replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, '[local-path]')
    // Strip POSIX absolute paths (e.g., /home/... or /tmp/...)
    .replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, '[local-path]')
    .trim()
}

/**
 * Internal execution context for an active install operation.
 */
interface ActiveOperationContext {
  readonly operationId: string
  readonly abortController: AbortController
  readonly startedAt: string
  readonly promise: Promise<void>
  snapshot: DictionaryOperationSnapshot
  cancelRequested: boolean
  nonCancellable: boolean
}

/**
 * Internal execution context for an active remove operation.
 */
interface ActiveRemoveContext {
  readonly operationId: string
  readonly abortController: AbortController
  readonly startedAt: string
  readonly promise: Promise<DictionaryRemoveResponse>
}

/**
 * Options for constructing {@link DictionaryOperationManager}.
 */
export interface DictionaryOperationManagerOptions {
  readonly paths?: ManagedStoragePaths | null
  readonly activationCoordinator: ActivationCoordinator
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void
    warn?: (msg: string, ...args: unknown[]) => void
    error?: (msg: string, ...args: unknown[]) => void
  }
}

/**
 * Host-lifecycle single-instance operation manager.
 */
export class DictionaryOperationManager {
  readonly #paths: ManagedStoragePaths | null
  readonly #activationCoordinator: ActivationCoordinator
  readonly #logger?: DictionaryOperationManagerOptions['logger']

  #currentOp: ActiveOperationContext | null = null
  #lastOp: DictionaryOperationSnapshot | null = null
  #activeRemove: ActiveRemoveContext | null = null
  #drainSummary: OperationDrainSummary | null = null
  #disposed = false
  #lastEmitTime = 0
  readonly #listeners = new Set<(snapshot: DictionaryOperationSnapshot) => void>()

  constructor(options: DictionaryOperationManagerOptions) {
    this.#paths = options.paths ?? null
    this.#activationCoordinator = options.activationCoordinator
    this.#logger = options.logger
  }

  /**
   * Whether the manager has been disposed.
   */
  get isDisposed(): boolean {
    return this.#disposed
  }

  /**
   * Return the snapshot of the currently running operation, if any.
   */
  getCurrentOperation(): DictionaryOperationSnapshot | null {
    return this.#currentOp ? Object.freeze({ ...this.#currentOp.snapshot }) : null
  }

  /**
   * Return the snapshot of the most recently settled operation, if any.
   */
  getLastOperation(): DictionaryOperationSnapshot | null {
    return this.#lastOp ? Object.freeze({ ...this.#lastOp }) : null
  }

  /**
   * Return diagnostic drain summary after disposal.
   */
  getDrainSummary(): OperationDrainSummary | null {
    return this.#drainSummary ? Object.freeze({ ...this.#drainSummary }) : null
  }

  /**
   * Return a promise that settles when all current in-flight operations (install and remove) settle.
   * Resolves immediately if no operations are active.
   */
  async whenSettled(): Promise<void> {
    const promises: Promise<unknown>[] = []
    if (this.#currentOp) {
      promises.push(this.#currentOp.promise)
    }
    if (this.#activeRemove) {
      promises.push(this.#activeRemove.promise)
    }
    if (promises.length === 0) return
    await Promise.allSettled(promises)
  }

  /**
   * Check whether an installation operation can currently be accepted.
   */
  canInstall(): boolean {
    if (this.#disposed) return false
    if (!this.#paths) return false
    if (this.isBusy()) return false
    if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) {
      return false
    }
    return true
  }

  /**
   * Check whether the managed dictionary can currently be removed.
   */
  canRemove(): boolean {
    if (this.#disposed) return false
    if (!this.#paths) return false
    if (this.isBusy()) return false
    if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) {
      return false
    }
    const summary = this.#activationCoordinator.getStatusSummary()
    return summary.installed
  }

  /**
   * Check whether a custom dictionary can currently be activated.
   */
  canActivateCustom(): boolean {
    if (this.#disposed) return false
    if (!this.#paths) return false
    if (this.isBusy()) return false
    if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) {
      return false
    }
    return true
  }

  /**
   * Check whether the dictionary operational mode can currently be switched.
   */
  canSwitchMode(): boolean {
    if (this.#disposed) return false
    if (!this.#paths) return false
    if (this.isBusy()) return false
    if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) {
      return false
    }
    return true
  }

  /**
   * Check whether an active operation can be cancelled.
   */
  canCancel(): boolean {
    return (
      this.#currentOp !== null &&
      this.#currentOp.snapshot.status === 'running' &&
      !this.#currentOp.nonCancellable
    )
  }

  /**
   * Check whether an operation (install or remove) is currently active.
   */
  isBusy(): boolean {
    return this.#activeRemove !== null || (this.#currentOp !== null && this.#currentOp.snapshot.status === 'running')
  }

  /**
   * Subscribe to operation snapshot updates.
   *
   * @param listener - callback receiving updated snapshots.
   * @returns unsubscribe function.
   */
  subscribe(listener: (snapshot: DictionaryOperationSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Request installation of ECDICT corpus.
   *
   * Asynchronously initiates verification, download, build, integrity check, and activation.
   * Returns immediately with the assigned operation identifier.
   *
   * @returns initial operation descriptor.
   */
  install(): { operationId: string; status: 'running'; phase: 'queued'; message: string } {
    if (this.#disposed) {
      throw new Error('DictionaryOperationManager is disposed')
    }

    if (!this.#paths) {
      throw new Error('Managed storage is unavailable: DSH home cannot be resolved')
    }

    // 1. Quarantine check
    const quarantine = getQuarantineRecord(this.#paths.databaseDirectory)
    if (quarantine) {
      throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason)
    }

    // 2. Concurrency check across all operations
    if (this.isBusy()) {
      throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? 'remove')
    }

    // 3. Allocate operationId and initial snapshot
    const operationId = `install-${Date.now()}-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const abortController = new AbortController()

    const initialSnapshot: DictionaryOperationSnapshot = {
      operationId,
      kind: 'install',
      phase: 'queued',
      status: 'running',
      progress: {
        phase: 'queued',
        percent: 0,
        unit: 'steps',
        message: 'ECDICT installation queued',
      },
      startedAt: now,
      updatedAt: now,
    }

    // 4. Create and start operation context
    let resolveSettled!: () => void
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })

    const ctx: ActiveOperationContext = {
      operationId,
      abortController,
      startedAt: now,
      snapshot: initialSnapshot,
      promise: settledPromise,
      cancelRequested: false,
      nonCancellable: false,
    }

    this.#currentOp = ctx
    this.#notifyListeners(true)

    // Execute background workflow asynchronously
    void this.#runInstallWorkflow(ctx).finally(() => {
      resolveSettled()
    })

    return {
      operationId,
      status: 'running',
      phase: 'queued',
      message: 'ECDICT installation accepted and running in background',
    }
  }

  /**
   * Request cancellation of an in-flight operation.
   *
   * Idempotent: safe to call multiple times for the same operation.
   *
   * @param operationId - operation identifier to cancel.
   * @returns cancellation status descriptor.
   */
  cancel(operationId: string): { operationId: string; status: 'cancelling' | 'cancelled'; message: string } {
    if (typeof operationId !== 'string' || operationId.trim().length === 0) {
      throw new TypeError('operationId must be a non-empty string')
    }

    // Check if matching current operation
    if (this.#currentOp && this.#currentOp.operationId === operationId) {
      if (this.#currentOp.snapshot.status !== 'running') {
        return {
          operationId,
          status: 'cancelled',
          message: 'Operation is already terminated',
        }
      }

      if (this.#currentOp.nonCancellable) {
        throw new OperationNotCancellableError(operationId)
      }

      this.#currentOp.cancelRequested = true
      this.#currentOp.abortController.abort()

      this.#updateProgress(this.#currentOp, {
        phase: this.#currentOp.snapshot.phase,
        subphase: 'cancelling',
        message: 'Cancellation requested, waiting for worker and network to abort...',
      }, true)

      return {
        operationId,
        status: 'cancelling',
        message: 'Cancellation signal dispatched to background operation',
      }
    }

    // Check if matching recently settled operation
    if (this.#lastOp && this.#lastOp.operationId === operationId) {
      return {
        operationId,
        status: this.#lastOp.status === 'cancelled' ? 'cancelled' : 'cancelling',
        message: `Operation has already finished with status: ${this.#lastOp.status}`,
      }
    }

    throw new OperationNotFoundError(operationId)
  }

  /**
   * Request removal of managed ECDICT database and reversion to fixture.
   *
   * Executes under exclusive operation mutex:
   * - Operation ownership claimed synchronously before any await yielding execution.
   * - Cannot run concurrently with installation or another removal.
   * - Awaits startup recovery to settle before mutating state.
   * - Releases Windows file locks prior to unlinking.
   *
   * @returns removal outcome.
   */
  async remove(): Promise<DictionaryRemoveResponse> {
    if (this.#disposed) {
      throw new Error('DictionaryOperationManager is disposed')
    }

    if (!this.#paths) {
      throw new Error('Managed storage is unavailable: DSH home cannot be resolved')
    }

    // 1. Quarantine check
    const quarantine = getQuarantineRecord(this.#paths.databaseDirectory)
    if (quarantine) {
      throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason)
    }

    // 2. Concurrency check across all operations
    if (this.isBusy()) {
      throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? 'remove')
    }

    // 3. Synchronously claim exclusive operation ownership BEFORE any await
    const operationId = `remove-${Date.now()}-${randomUUID().slice(0, 8)}`
    const abortController = new AbortController()
    let resolveSettled!: (val: DictionaryRemoveResponse) => void
    let rejectSettled!: (err: unknown) => void
    const settledPromise = new Promise<DictionaryRemoveResponse>((res, rej) => {
      resolveSettled = res
      rejectSettled = rej
    })
    settledPromise.catch(() => {})

    const removeCtx: ActiveRemoveContext = {
      operationId,
      abortController,
      startedAt: new Date().toISOString(),
      promise: settledPromise,
    }
    this.#activeRemove = removeCtx

    try {
      // Step A: Ensure startup recovery settled before proceeding if active
      if (this.#activationCoordinator.isRecovering) {
        await this.#activationCoordinator.ensureReady()
      }

      // Step B: Check if disposed or cancelled while waiting for recovery
      if (this.#disposed || removeCtx.abortController.signal.aborted) {
        throw new Error('DictionaryOperationManager was disposed before remove execution')
      }

      // Step C: Test hook for B-R3-04 (post-recovery, pre-mutation race)
      if (operationHooks?.beforeRemoveDiskMutation) {
        await operationHooks.beforeRemoveDiskMutation()
      }
      if (this.#disposed || removeCtx.abortController.signal.aborted) {
        throw new Error('DictionaryOperationManager was disposed before remove execution')
      }

      // Step D: Execute removal in coordinator
      const outcome = await this.#activationCoordinator.removeManagedDatabase()
      const resolvedMode = outcome.activeMode ?? 'fixture'
      const response: DictionaryRemoveResponse = {
        ok: true,
        removed: outcome.removed,
        activeMode: resolvedMode,
        message: outcome.removed
          ? (resolvedMode === 'custom'
              ? 'Managed ECDICT database removed; custom dictionary remains active'
              : 'Managed ECDICT database removed and active dictionary reverted to fixture')
          : 'No managed database was installed',
      }
      resolveSettled(response)
      return response
    } catch (error) {
      rejectSettled(error)
      throw error
    } finally {
      this.#activeRemove = null
    }
  }

  /**
   * Request activation of a custom SQLite dictionary database.
   *
   * Executes under exclusive operation mutex:
   * - Stages snapshot via VACUUM INTO.
   * - Verifies schema and integrity in Worker.
   * - Atomically publishes snapshot.
   * - Atomically activates in DictionaryManager with lease tracking.
   * - Raw source database is NEVER modified or deleted.
   *
   * @param rawSourcePath - host filesystem path to user SQLite database.
   * @param identity - optional logical identity label.
   * @returns settled activation response.
   */
  async activateCustom(
    rawSourcePath: string,
    identity?: string,
  ): Promise<DictionaryActivateCustomResponse> {
    if (this.#disposed) {
      throw new Error('DictionaryOperationManager is disposed')
    }

    if (!this.#paths) {
      throw new Error('Managed storage is unavailable: DSH home cannot be resolved')
    }

    const quarantine = getQuarantineRecord(this.#paths.databaseDirectory)
    if (quarantine) {
      throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason)
    }

    if (this.isBusy()) {
      throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? 'operation')
    }

    const snapshotMgr = this.#activationCoordinator.customSnapshotManager
    if (!snapshotMgr) {
      throw new Error('Custom snapshot manager is unavailable')
    }

    const operationId = `activate-custom-${Date.now()}-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const abortController = new AbortController()
    const signal = abortController.signal

    const initialSnapshot: DictionaryOperationSnapshot = {
      operationId,
      kind: 'activate-custom',
      phase: 'validating-database',
      status: 'running',
      progress: {
        phase: 'validating-database',
        percent: 0,
        unit: 'steps',
        message: 'Validating and staging custom SQLite database...',
      },
      startedAt: now,
      updatedAt: now,
    }

    let resolveSettled!: () => void
    const settledPromise = new Promise<void>((res) => {
      resolveSettled = res
    })

    const ctx: ActiveOperationContext = {
      operationId,
      abortController,
      startedAt: now,
      snapshot: initialSnapshot,
      promise: settledPromise,
      cancelRequested: false,
      nonCancellable: false,
    }

    this.#currentOp = ctx
    this.#notifyListeners(true)

    try {
      if (this.#activationCoordinator.isRecovering) {
        await this.#activationCoordinator.ensureReady()
      }
      if (signal.aborted || this.#disposed) throw this.#createAbortError()

      // Step 1: Create, verify in worker, and publish snapshot
      this.#transitionPhase(ctx, 'validating-database', 'Validating SQLite integrity and publishing snapshot...')
      const record = await snapshotMgr.createAndPublishSnapshot(rawSourcePath, {
        identity,
        signal,
      })

      if (signal.aborted || this.#disposed) throw this.#createAbortError()

      // Step 2: Activate custom database
      this.#transitionPhase(ctx, 'activating', 'Activating custom dictionary snapshot...')
      const result = await this.#activationCoordinator.activateCustomDatabase(record.id, {
        signal,
        onCommitBoundary: () => {
          ctx.nonCancellable = true
        },
      })

      // Step 3: Settle
      this.#settleOperation(ctx, 'completed', 'completed', {
        phase: 'completed',
        percent: 100,
        unit: 'steps',
        message: `Custom dictionary successfully activated (${record.identity})`,
      })

      return {
        ok: true,
        operationId,
        activeMode: 'custom',
        identity: result.identity,
        snapshotId: result.snapshotId,
        message: 'Custom dictionary activated successfully',
      }
    } catch (error) {
      if (!ctx.nonCancellable && (signal.aborted || this.#isAbortError(error))) {
        this.#settleOperation(ctx, 'cancelled', 'cancelled', {
          phase: 'cancelled',
          unit: 'steps',
          message: 'Operation cancelled by user before commit point',
        })
        const abortErr = new Error('Operation was cancelled')
        ;(abortErr as unknown as { code: string }).code = 'OPERATION_CANCELLED'
        throw abortErr
      }
      const errorRecord = this.#formatError(error)
      this.#settleOperation(ctx, 'failed', 'failed', {
        phase: 'failed',
        unit: 'steps',
        message: errorRecord.message,
      }, errorRecord)
      throw error
    } finally {
      this.#lastOp = ctx.snapshot
      this.#currentOp = null
      this.#notifyListeners(true)
      resolveSettled()
    }
  }

  /**
   * Request safe operational mode switch between 'fixture', 'managed-ecdict', and 'custom'.
   *
   * Executes under exclusive operation mutex.
   *
   * @param mode - target operational mode.
   * @param snapshotId - target snapshot UUID (required when mode is 'custom').
   * @returns settled mode switch response.
   */
  async selectMode(
    mode: DictionaryMode,
    snapshotId?: string,
  ): Promise<DictionarySelectModeResponse> {
    if (this.#disposed) {
      throw new Error('DictionaryOperationManager is disposed')
    }

    if (!this.#paths) {
      throw new Error('Managed storage is unavailable: DSH home cannot be resolved')
    }

    const quarantine = getQuarantineRecord(this.#paths.databaseDirectory)
    if (quarantine) {
      throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason)
    }

    if (this.isBusy()) {
      throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? 'operation')
    }

    const operationId = `switch-mode-${Date.now()}-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const abortController = new AbortController()
    const signal = abortController.signal

    const initialSnapshot: DictionaryOperationSnapshot = {
      operationId,
      kind: 'switch-mode',
      phase: 'activating',
      status: 'running',
      progress: {
        phase: 'activating',
        percent: 0,
        unit: 'steps',
        message: `Switching dictionary mode to "${mode}"...`,
      },
      startedAt: now,
      updatedAt: now,
    }

    let resolveSettled!: () => void
    const settledPromise = new Promise<void>((res) => {
      resolveSettled = res
    })

    const ctx: ActiveOperationContext = {
      operationId,
      abortController,
      startedAt: now,
      snapshot: initialSnapshot,
      promise: settledPromise,
      cancelRequested: false,
      nonCancellable: false,
    }

    this.#currentOp = ctx
    this.#notifyListeners(true)

    try {
      if (this.#activationCoordinator.isRecovering) {
        await this.#activationCoordinator.ensureReady()
      }
      if (signal.aborted || this.#disposed) throw this.#createAbortError()

      const result = await this.#activationCoordinator.selectMode(mode, {
        snapshotId,
        signal,
        onCommitBoundary: () => {
          ctx.nonCancellable = true
        },
      })

      const summary = this.#activationCoordinator.getStatusSummary()

      this.#settleOperation(ctx, 'completed', 'completed', {
        phase: 'completed',
        percent: 100,
        unit: 'steps',
        message: `Dictionary mode switched to "${result.activeMode}"`,
      })

      return {
        ok: true,
        operationId,
        activeMode: result.activeMode,
        identity: summary.activeIdentity,
        message: `Successfully switched to "${result.activeMode}" dictionary mode`,
      }
    } catch (error) {
      if (!ctx.nonCancellable && (signal.aborted || this.#isAbortError(error))) {
        this.#settleOperation(ctx, 'cancelled', 'cancelled', {
          phase: 'cancelled',
          unit: 'steps',
          message: 'Operation cancelled by user before commit point',
        })
        const abortErr = new Error('Operation was cancelled')
        ;(abortErr as unknown as { code: string }).code = 'OPERATION_CANCELLED'
        throw abortErr
      }
      const errorRecord = this.#formatError(error)
      this.#settleOperation(ctx, 'failed', 'failed', {
        phase: 'failed',
        unit: 'steps',
        message: errorRecord.message,
      }, errorRecord)
      throw error
    } finally {
      this.#lastOp = ctx.snapshot
      this.#currentOp = null
      this.#notifyListeners(true)
      resolveSettled()
    }
  }

  /**
   * Dispose operation manager and await safe drainage of in-flight tasks.
   *
   * @param timeoutMs - maximum wait duration for active worker/download drainage (defaults to 5000ms).
   */
  async dispose(timeoutMs = 5000): Promise<void> {
    if (this.#disposed) {
      if (this.isBusy() || (this.#drainSummary && !this.#drainSummary.workflowSettled)) {
        if (this.isBusy()) {
          let retryTimer: NodeJS.Timeout | undefined
          const retryTimeoutPromise = new Promise<'timeout'>((resolve) => {
            retryTimer = setTimeout(() => resolve('timeout'), timeoutMs)
          })
          try {
            const outcome = await Promise.race([
              this.whenSettled().then(() => 'settled' as const),
              retryTimeoutPromise,
            ])
            if (outcome === 'timeout') {
              throw new OperationDrainTimeoutError(timeoutMs, this.#drainSummary?.error)
            }
          } finally {
            if (retryTimer) clearTimeout(retryTimer)
          }
        }
        if (this.#drainSummary && !this.#drainSummary.workflowSettled) {
          throw new OperationDrainTimeoutError(timeoutMs, this.#drainSummary?.error)
        }
      }
      return
    }
    this.#disposed = true
    this.#activationCoordinator.dispose?.()

    const isQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false

    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      // 1. Drain active install operation if running
      if (this.#currentOp && this.#currentOp.snapshot.status === 'running') {
        const opCtx = this.#currentOp
        opCtx.cancelRequested = true

        // Capture tracked workers before aborting
        const trackedWorkerIds = workerSupervisor.getTrackedWorkerIds()
        const workerExitWaiters = trackedWorkerIds.map((id) =>
          workerSupervisor.waitForExit(id, timeoutMs).catch(() => null)
        )

        opCtx.abortController.abort()

        const outcome = await Promise.race([
          opCtx.promise.then(() => 'settled' as const).catch(() => 'settled' as const),
          timeoutPromise,
        ])

        if (outcome === 'timeout') {
          const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false
          this.#drainSummary = {
            requestedCancel: true,
            workflowSettled: false,
            workerExited: false,
            timedOut: true,
            statusUnknown: true,
            quarantined: finalQuar,
            operationKind: 'install',
            error: `Install operation failed to drain within ${timeoutMs}ms: worker or network exit status unknown`,
          }
          throw new OperationDrainTimeoutError(timeoutMs)
        }

        // Settled within timeout: determine genuine worker exit proof
        const exitProofs = await Promise.all(workerExitWaiters)
        const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false

        let workerExited = false
        let statusUnknown = finalQuar

        if (trackedWorkerIds.length > 0) {
          const allConfirmed = exitProofs.every(
            (p) => p !== null && workerSupervisor.isExitProofAuthentic(p)
          )
          if (allConfirmed && !finalQuar) {
            workerExited = true
            statusUnknown = false
          } else {
            workerExited = false
            statusUnknown = true
          }
        } else {
          // No worker was running in supervisor (e.g. download or cache phase)
          workerExited = false
          statusUnknown = finalQuar
        }

        this.#drainSummary = {
          requestedCancel: true,
          workflowSettled: true,
          workerExited,
          timedOut: false,
          statusUnknown,
          quarantined: finalQuar,
          operationKind: 'install',
        }
        return
      }

      // 2. Drain active remove operation if running
      if (this.#activeRemove !== null) {
        const remCtx = this.#activeRemove
        remCtx.abortController.abort()

        const outcome = await Promise.race([
          remCtx.promise.then(() => 'settled' as const).catch(() => 'settled' as const),
          timeoutPromise,
        ])

        if (outcome === 'timeout') {
          const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false
          this.#drainSummary = {
            requestedCancel: true,
            workflowSettled: false,
            workerExited: false,
            timedOut: true,
            statusUnknown: true,
            quarantined: finalQuar,
            operationKind: 'remove',
            error: `Remove operation failed to drain within ${timeoutMs}ms`,
          }
          throw new OperationDrainTimeoutError(timeoutMs)
        }

        const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false
        this.#drainSummary = {
          requestedCancel: true,
          workflowSettled: true,
          workerExited: false,
          timedOut: false,
          statusUnknown: finalQuar,
          quarantined: finalQuar,
          operationKind: 'remove',
        }
        return
      }

      // 3. No operation in flight
      this.#drainSummary = {
        requestedCancel: false,
        workflowSettled: true,
        workerExited: false,
        timedOut: false,
        statusUnknown: isQuar,
        quarantined: isQuar,
        operationKind: 'none',
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Run the end-to-end installation pipeline.
   */
  async #runInstallWorkflow(ctx: ActiveOperationContext): Promise<void> {
    const signal = ctx.abortController.signal
    let committed = false
    let buildResult: ManagedEcdictBuildResult | null = null

    try {
      const paths = this.#paths
      if (!paths) {
        throw new Error('Managed storage unavailable: DSH home cannot be resolved')
      }

      // Step 0: Ensure startup recovery settled before proceeding if active
      if (this.#activationCoordinator.isRecovering) {
        await this.#activationCoordinator.ensureReady()
      }

      if (this.#disposed || signal.aborted) throw this.#createAbortError()

      // Step 1: Check cache & Download if needed
      this.#transitionPhase(ctx, 'checking-cache', 'Verifying local ECDICT source cache...')
      if (this.#disposed || signal.aborted) throw this.#createAbortError()

      await downloadPinnedEcdict(paths, {
        signal,
        onProgress: (dlProgress: EcdictDownloadProgress) => {
          this.#handleDownloadProgress(ctx, dlProgress)
        },
      })

      if (this.#disposed || signal.aborted) throw this.#createAbortError()

      // Step 2: Build Database with static Worker integrity check
      this.#transitionPhase(ctx, 'building', 'Building managed SQLite database from source...')

      buildResult = await buildManagedEcdictDatabase(paths, {
        signal,
        onProgress: (importProgress: EcdictImportProgress) => {
          this.#handleImportProgress(ctx, importProgress)
        },
      })

      if (this.#disposed || signal.aborted) throw this.#createAbortError()

      // Step 3: Validate database & Atomic Activation
      this.#transitionPhase(ctx, 'activating', 'Validating and activating managed dictionary...')

      // Final pre-commit check: if disposed or aborted before commit point, do not commit!
      if (this.#disposed || signal.aborted) throw this.#createAbortError()

      await this.#activationCoordinator.activateManagedDatabase(buildResult, {
        signal,
        onCommitBoundary: () => {
          ctx.nonCancellable = true
        },
      })
      committed = true

      // Step 4: Settle as Completed
      this.#settleOperation(ctx, 'completed', 'completed', {
        phase: 'completed',
        percent: 100,
        unit: 'steps',
        message: `ECDICT corpus successfully installed (${buildResult.entryCount.toLocaleString()} entries)`,
      })
    } catch (error) {
      if (!committed && !ctx.nonCancellable && (signal.aborted || this.#isAbortError(error))) {
        this.#settleOperation(ctx, 'cancelled', 'cancelled', {
          phase: 'cancelled',
          unit: 'steps',
          message: 'Operation cancelled by user before commit point',
        })
      } else {
        const errorRecord = this.#formatError(error)
        this.#logger?.error?.('ECDICT installation failed: %s', errorRecord.message)
        this.#settleOperation(ctx, 'failed', 'failed', {
          phase: 'failed',
          unit: 'steps',
          message: errorRecord.message,
        }, errorRecord)
      }
    } finally {
      this.#lastOp = ctx.snapshot
      this.#currentOp = null
      this.#notifyListeners(true)
    }
  }

  /**
   * Handle progress events from ECDICT downloader.
   */
  #handleDownloadProgress(ctx: ActiveOperationContext, p: EcdictDownloadProgress): void {
    let phase: DictionaryOperationPhase = 'downloading'
    let message = 'Downloading ECDICT corpus...'
    let percent: number | undefined

    if (p.phase === 'checking-cache') {
      phase = 'checking-cache'
      message = 'Checking local cache...'
    } else if (p.phase === 'verifying') {
      phase = 'verifying-source'
      message = 'Verifying source hash and UTF-8 validity...'
    } else if (p.phase === 'downloading') {
      phase = 'downloading'
      percent = p.totalBytes > 0 ? Math.min(100, Math.round((p.bytesProcessed / p.totalBytes) * 100)) : undefined
      message = `Downloading ECDICT corpus (${(p.bytesProcessed / (1024 * 1024)).toFixed(1)} MB)...`
    }

    this.#updateProgress(ctx, {
      phase,
      subphase: p.phase,
      processed: p.bytesProcessed,
      total: p.totalBytes,
      percent,
      unit: 'bytes',
      message,
    })
  }

  /**
   * Handle progress events from ECDICT importer.
   */
  #handleImportProgress(ctx: ActiveOperationContext, p: EcdictImportProgress): void {
    let phase: DictionaryOperationPhase = 'building'
    let unit: 'entries' | 'bytes' | 'steps' = 'entries'
    let percent: number | undefined
    let message = 'Constructing SQLite database...'

    if (p.phase === 'verifying-source' || p.phase === 'preflighting') {
      phase = 'verifying-source'
      unit = 'bytes'
      message = 'Preflighting source CSV schema...'
    } else if (p.phase === 'importing-entries') {
      phase = 'building'
      unit = 'entries'
      percent = p.total && p.total > 0 && p.processed !== undefined
        ? Math.min(100, Math.round((p.processed / p.total) * 100))
        : undefined
      message = `Importing dictionary entries (${(p.processed ?? 0).toLocaleString()} / ${(p.total ?? 0).toLocaleString()})...`
    } else if (p.phase === 'resolving-forms' || p.phase === 'inserting-forms' || p.phase === 'indexing') {
      phase = 'building'
      unit = 'entries'
      message = `Indexing morphological forms (${p.phase})...`
    } else if (p.phase === 'validating' || p.phase === 'publishing') {
      phase = 'validating-database'
      unit = 'steps'
      message = p.phase === 'validating'
        ? 'Running static Worker PRAGMA integrity_check...'
        : 'Publishing verified SQLite database...'
    }

    this.#updateProgress(ctx, {
      phase,
      subphase: p.phase,
      processed: p.processed,
      total: p.total,
      percent,
      unit,
      message,
    })
  }

  /**
   * Transition the operation to a new phase.
   */
  #transitionPhase(ctx: ActiveOperationContext, phase: DictionaryOperationPhase, message: string): void {
    ctx.snapshot = {
      ...ctx.snapshot,
      phase,
      updatedAt: new Date().toISOString(),
      progress: {
        phase,
        unit: 'steps',
        message,
      },
    }
    this.#notifyListeners(true)
  }

  /**
   * Update operation progress with throttling.
   */
  #updateProgress(ctx: ActiveOperationContext, progress: DictionaryOperationProgress, force = false): void {
    ctx.snapshot = {
      ...ctx.snapshot,
      phase: progress.phase,
      updatedAt: new Date().toISOString(),
      progress,
    }
    this.#notifyListeners(force)
  }

  /**
   * Finalize operation status upon completion, cancellation, or failure.
   */
  #settleOperation(
    ctx: ActiveOperationContext,
    phase: DictionaryOperationPhase,
    status: DictionaryOperationStatus,
    progress: DictionaryOperationProgress,
    error?: DictionaryOperationError,
  ): void {
    const finishedAt = new Date().toISOString()
    ctx.snapshot = {
      ...ctx.snapshot,
      phase,
      status,
      updatedAt: finishedAt,
      finishedAt,
      progress,
      error,
    }
  }

  /**
   * Format and classify an unknown error into a structured error record.
   */
  #formatError(err: unknown): DictionaryOperationError {
    const code = (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string')
      ? (err as { code: string }).code
      : (err instanceof Error ? err.name : 'INSTALL_FAILED')

    const rawMessage = err instanceof Error ? err.message : String(err)
    const sanitized = sanitizeErrorMessage(rawMessage)

    // Classify retryability: transient network errors vs unrecoverable corruptions
    const retryable = !sanitized.includes('CORRUPT') && !sanitized.includes('SCHEMA')

    return {
      code,
      message: sanitized,
      retryable,
    }
  }

  /**
   * Check if an error represents an AbortError.
   */
  #isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const name = (err as { name?: string }).name
    const code = (err as { code?: string }).code
    return name === 'AbortError' || code === 'ABORT_ERR' || code === 'ERR_ABORTED'
  }

  /**
   * Create standard AbortError.
   */
  #createAbortError(): Error {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    return error
  }

  /**
   * Notify registered listeners of snapshot updates, throttled to <= 10 Hz.
   */
  #notifyListeners(force = false): void {
    const now = Date.now()
    if (!force && now - this.#lastEmitTime < PROGRESS_THROTTLE_MS) {
      return
    }
    this.#lastEmitTime = now

    const currentSnapshot = this.#currentOp ? this.#currentOp.snapshot : this.#lastOp
    if (!currentSnapshot) return

    const immutableSnapshot = Object.freeze({ ...currentSnapshot })

    for (const listener of this.#listeners) {
      try {
        listener(immutableSnapshot)
      } catch (err) {
        // Shield operation manager from observer exceptions
        this.#logger?.warn?.('Observer error in dictionary operation listener: %s', String(err))
      }
    }
  }
}
