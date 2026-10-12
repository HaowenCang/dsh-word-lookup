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
     * Check whether an installation operation can currently be accepted.
     */
    canInstall(): boolean;
    /**
     * Check whether an active operation can be cancelled.
     */
    canCancel(): boolean;
    /**
     * Check whether an operation is currently active.
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
     * Dispose operation manager and await safe drainage of in-flight tasks.
     *
     * @param timeoutMs - maximum wait duration for active worker/download drainage (defaults to 5000ms).
     */
    dispose(timeoutMs?: number): Promise<void>;
}
