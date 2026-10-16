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
import type { URL } from 'node:url';
import { type WorkerLike } from './ecdict-integrity-verifier.js';
import type { CompanionWorkerRequest, CustomSnapshotCreateSuccessResponse, CustomSnapshotValidateSuccessResponse } from './ecdict-integrity-worker.js';
/** Error thrown when a validation worker times out. */
export declare class ValidatorTimeoutError extends Error {
    readonly code = "TIMEOUT";
    readonly timeoutMs: number;
    constructor(message: string, timeoutMs: number);
}
/** Error thrown when a validation worker task is aborted via AbortSignal. */
export declare class ValidatorCancelledError extends Error {
    readonly code = "CANCELLED";
    constructor(message: string);
}
/** Error thrown when a validation worker task crashes abnormally. */
export declare class ValidatorCrashError extends Error {
    readonly code = "WORKER_CRASHED";
    readonly exitCode: number | null;
    constructor(message: string, exitCode: number | null);
}
/** Error thrown when a validator supervisor is disposed. */
export declare class ValidatorDisposedError extends Error {
    readonly code = "HOST_DISPOSED";
    constructor(message?: string);
}
/** Error thrown when worker execution fails with a classified failure response. */
export declare class ValidatorExecutionError extends Error {
    readonly code: string;
    readonly durationMs?: number;
    constructor(message: string, code: string, durationMs?: number);
}
/** Options for configuring the CustomDictionaryValidator. */
export interface CustomDictionaryValidatorOptions {
    /** Maximum concurrent worker tasks. Defaults to 1 (serial isolation). */
    readonly maxConcurrency?: number;
    /** Default timeout in milliseconds for operations. Defaults to 30,000 ms. */
    readonly defaultTimeoutMs?: number;
    /** Optional Worker adapter factory (for testing). */
    readonly workerAdapter?: (request: CompanionWorkerRequest) => WorkerLike;
    /** Optional worker URL override. */
    readonly workerUrl?: URL;
}
/** Options for individual validation or snapshot tasks. */
export interface CustomValidatorTaskOptions {
    /** Specific timeout in milliseconds for this task. */
    readonly timeoutMs?: number;
    /** Optional cancellation signal. */
    readonly signal?: AbortSignal;
    /** Maximum allowed size of candidate database in bytes. */
    readonly maxSizeBytes?: number;
}
/**
 * Supervisor for custom SQLite snapshot creation and validation in worker threads.
 */
export declare class CustomDictionaryValidator {
    #private;
    constructor(options?: CustomDictionaryValidatorOptions);
    /**
     * Check whether supervisor is disposed.
     */
    get isDisposed(): boolean;
    /**
     * Number of operations currently running.
     */
    get runningCount(): number;
    /**
     * Execute snapshot creation using worker thread.
     */
    createSnapshot(sourcePath: string, stagingPath: string, options?: CustomValidatorTaskOptions): Promise<CustomSnapshotCreateSuccessResponse>;
    /**
     * Execute comprehensive snapshot validation using worker thread.
     */
    validateSnapshot(snapshotPath: string, options?: CustomValidatorTaskOptions): Promise<CustomSnapshotValidateSuccessResponse>;
    /**
     * Dispose supervisor, aborting in-flight workers and rejecting queued tasks.
     */
    dispose(): Promise<void>;
}
