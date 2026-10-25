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
import type { URL } from 'node:url';
import { WorkerTerminationError, type WorkerLike } from './ecdict-integrity-verifier.js';
import type { CompanionWorkerRequest, CustomSnapshotCreateSuccessResponse, CustomSnapshotValidateSuccessResponse, CustomSnapshotPrePublishCheckSuccessResponse } from './ecdict-integrity-worker.js';
/** Error thrown when TOCTOU tampering or file modification is detected during verification or publishing. */
export declare class SnapshotTamperingError extends Error {
    readonly code = "SNAPSHOT_TAMPERING_DETECTED";
    constructor(message: string);
}
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
/** Comparison key only: retain original spellings for I/O and existing containment checks. */
export declare function customWorkerPathIdentity(path: string): string;
/** Caller failure is distinct from physical exit; compatible with managed uncertainty consumers. */
export declare class CustomWorkerTerminationError extends WorkerTerminationError {
    readonly code = "TERMINATION_UNCONFIRMED";
    readonly terminationError: unknown;
    constructor(primary: unknown, terminationError: unknown);
}
/** Options for configuring the CustomDictionaryValidator. */
export interface CustomDictionaryValidatorOptions {
    /** Maximum concurrent worker tasks. Defaults to 1 (serial isolation). */
    readonly maxConcurrency?: number;
    /** Default timeout in milliseconds for operations. Defaults to 30,000 ms. */
    readonly defaultTimeoutMs?: number;
    /** Exit-confirmation deadline after cancellation/failure. Defaults to 5000ms, like the managed verifier. */
    readonly terminationTimeoutMs?: number;
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
     * Execute pre-publish hash and size verification using worker thread.
     */
    prePublishCheck(stagingPath: string, expectedSha256: string, expectedByteSize: number, options?: CustomValidatorTaskOptions): Promise<CustomSnapshotPrePublishCheckSuccessResponse>;
    /**
     * Dispose supervisor, aborting in-flight workers and rejecting queued tasks.
     */
    dispose(): Promise<void>;
    /** Paths stay protected after caller failure and disposal until physical exit is observed. */
    isPathInUse(path: string): boolean;
    get hasUnconfirmedWorkers(): boolean;
}
