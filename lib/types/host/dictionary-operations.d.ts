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
import type { DictionaryOperationSnapshot } from '../shared/dictionary-management-protocol.js';
import type { ManagedStoragePaths } from './managed-storage.js';
import type { ActivationCoordinator } from './dictionary-activation.js';
/**
 * Error thrown when an install operation is requested while another is already running.
 */
export declare class OperationInProgressError extends Error {
    readonly code = "OPERATION_IN_PROGRESS";
    readonly operationId: string;
    constructor(operationId: string);
}
/**
 * Error thrown when an operation is requested on a quarantined storage directory.
 */
export declare class OperationDirectoryQuarantinedError extends Error {
    readonly code = "DIRECTORY_QUARANTINED";
    readonly directory: string;
    readonly reason: string;
    constructor(directory: string, reason: string);
}
/**
 * Error thrown when attempting to cancel an unknown or settled operation.
 */
export declare class OperationNotFoundError extends Error {
    readonly code = "OPERATION_NOT_FOUND";
    readonly operationId: string;
    constructor(operationId: string);
}
/**
 * Error thrown when attempting to cancel an operation that has passed the commit boundary.
 */
export declare class OperationNotCancellableError extends Error {
    readonly code = "OPERATION_NOT_CANCELLABLE";
    readonly operationId: string;
    constructor(operationId: string);
}
/**
 * Error thrown when draining in-flight operations times out during dispose.
 */
export declare class OperationDrainTimeoutError extends Error {
    readonly code = "DRAIN_TIMEOUT";
    readonly timeoutMs: number;
    constructor(timeoutMs: number, message?: string);
}
/**
 * Diagnostic summary of resource drain and worker lifecycle status upon disposal.
 */
export interface OperationDrainSummary {
    /** Whether cancellation signal was dispatched. */
    readonly requestedCancel: boolean;
    /** Whether the operation workflow settled completely. */
    readonly workflowSettled: boolean;
    /** Whether worker termination was authentically confirmed via supervisor proof. */
    readonly workerExited: boolean;
    /** Whether drain timed out before settlement. */
    readonly timedOut: boolean;
    /** Whether worker or resource status is unknown (fail-closed). */
    readonly statusUnknown: boolean;
    /** Whether database directory was left quarantined. */
    readonly quarantined: boolean;
    /** Operation kind drained ('install' | 'remove' | 'none'). */
    readonly operationKind?: 'install' | 'remove' | 'none';
    /** Diagnostic error explanation if drain encountered issues. */
    readonly error?: string;
}
/**
 * Internal hooks interface for concurrency failure injection in tests.
 */
export interface OperationHooks {
    readonly beforeRemoveDiskMutation?: () => Promise<void>;
}
/**
 * Configure internal operation hooks for failure-injection testing.
 * @internal Test-only helper. Pass `null` to reset.
 */
export declare function _setOperationHooksForTesting(hooks: OperationHooks | null): void;
/**
 * Sanitize error message to prevent leaking machine-specific paths, credentials, or stack traces.
 */
export declare function sanitizeErrorMessage(rawMessage: string): string;
/**
 * Options for constructing {@link DictionaryOperationManager}.
 */
export interface DictionaryOperationManagerOptions {
    readonly paths?: ManagedStoragePaths | null;
    readonly activationCoordinator: ActivationCoordinator;
    readonly logger?: {
        info?: (msg: string, ...args: unknown[]) => void;
        warn?: (msg: string, ...args: unknown[]) => void;
        error?: (msg: string, ...args: unknown[]) => void;
    };
}
/**
 * Host-lifecycle single-instance operation manager.
 */
export declare class DictionaryOperationManager {
    #private;
    constructor(options: DictionaryOperationManagerOptions);
    /**
     * Whether the manager has been disposed.
     */
    get isDisposed(): boolean;
    /**
     * Return the snapshot of the currently running operation, if any.
     */
    getCurrentOperation(): DictionaryOperationSnapshot | null;
    /**
     * Return the snapshot of the most recently settled operation, if any.
     */
    getLastOperation(): DictionaryOperationSnapshot | null;
    /**
     * Return diagnostic drain summary after disposal.
     */
    getDrainSummary(): OperationDrainSummary | null;
    /**
     * Return a promise that settles when all current in-flight operations (install and remove) settle.
     * Resolves immediately if no operations are active.
     */
    whenSettled(): Promise<void>;
    /**
     * Check whether an installation operation can currently be accepted.
     */
    canInstall(): boolean;
    /**
     * Check whether the managed dictionary can currently be removed.
     */
    canRemove(): boolean;
    /**
     * Check whether an active operation can be cancelled.
     */
    canCancel(): boolean;
    /**
     * Check whether an operation (install or remove) is currently active.
     */
    isBusy(): boolean;
    /**
     * Subscribe to operation snapshot updates.
     *
     * @param listener - callback receiving updated snapshots.
     * @returns unsubscribe function.
     */
    subscribe(listener: (snapshot: DictionaryOperationSnapshot) => void): () => void;
    /**
     * Request installation of ECDICT corpus.
     *
     * Asynchronously initiates verification, download, build, integrity check, and activation.
     * Returns immediately with the assigned operation identifier.
     *
     * @returns initial operation descriptor.
     */
    install(): {
        operationId: string;
        status: 'running';
        phase: 'queued';
        message: string;
    };
    /**
     * Request cancellation of an in-flight operation.
     *
     * Idempotent: safe to call multiple times for the same operation.
     *
     * @param operationId - operation identifier to cancel.
     * @returns cancellation status descriptor.
     */
    cancel(operationId: string): {
        operationId: string;
        status: 'cancelling' | 'cancelled';
        message: string;
    };
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
    remove(): Promise<{
        removed: boolean;
    }>;
    /**
     * Dispose operation manager and await safe drainage of in-flight tasks.
     *
     * @param timeoutMs - maximum wait duration for active worker/download drainage (defaults to 5000ms).
     */
    dispose(timeoutMs?: number): Promise<void>;
}
