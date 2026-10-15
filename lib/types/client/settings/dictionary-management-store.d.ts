/**
 * Reactive observable store for dictionary management state and background polling.
 *
 * Implements:
 * - Dynamic adaptive polling: high frequency (800ms) during active operations,
 *   low frequency (10,000ms) when idle.
 * - Window focus refresh trigger.
 * - Out-of-order request protection and stale response rejection.
 * - Graceful connection error retention without wiping last known status.
 * - Full lifecycle cleanup with AbortController on disposal.
 *
 * @module dsh-word-lookup/client/settings/dictionary-management-store
 */
import type { DictionaryStatusResponse } from '../../shared/dictionary-management-protocol.js';
/**
 * State snapshot of the dictionary management store.
 */
export interface DictionaryManagementStoreState {
    /** The latest authoritative status from the host, or null before initial fetch. */
    readonly status: DictionaryStatusResponse | null;
    /** Whether the initial load or a manual refresh is in flight. */
    readonly isLoading: boolean;
    /** Whether an install, cancel, or remove action is in flight. */
    readonly isActing: boolean;
    /** Error message resulting from a user action (install, cancel, remove), or null. */
    readonly actionError: string | null;
    /** Transient connection or transport error during polling, or null. */
    readonly connectionError: string | null;
    /** Timestamp of the last successful status fetch. */
    readonly lastRefreshedAt: number;
}
/** Configuration options for the management store. */
export interface DictionaryManagementStoreOptions {
    /** High-frequency polling interval during active operations in ms (default 800). */
    readonly activeIntervalMs?: number;
    /** Low-frequency polling interval during idle state in ms (default 10000). */
    readonly idleIntervalMs?: number;
    /** Whether to start polling immediately upon construction (default true). */
    readonly autoStart?: boolean;
}
export declare class DictionaryManagementStore {
    #private;
    constructor(options?: DictionaryManagementStoreOptions);
    /**
     * Subscribe to store state changes.
     */
    subscribe: (listener: () => void) => (() => void);
    /**
     * Return the current immutable snapshot.
     */
    getSnapshot: () => DictionaryManagementStoreState;
    /**
     * Immediately refresh dictionary status from the host.
     */
    refresh(): Promise<void>;
    /**
     * Request installation of the managed ECDICT corpus.
     */
    install(): Promise<boolean>;
    /**
     * Request cancellation of the active operation.
     */
    cancel(targetOperationId?: string): Promise<boolean>;
    /**
     * Request removal of the installed managed ECDICT corpus.
     */
    remove(): Promise<boolean>;
    /**
     * Clear any outstanding action errors.
     */
    clearActionError(): void;
    /** Whether this store has been disposed. */
    get isDisposed(): boolean;
    /** Whether a background polling timer is currently scheduled. */
    get hasScheduledTimer(): boolean;
    /**
     * Dispose store, stop all timers and abort outstanding requests.
     */
    dispose(): void;
}
