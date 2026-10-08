/**
 * Host-side Worker executor and lifecycle manager for ECDICT integrity verification.
 *
 * Implements Phase 7A.5R4:
 * - Spawns the static companion worker (`ecdict-integrity-worker.js`) in an isolated thread.
 * - Manages IPC request/response with strict runtime payload validation.
 * - Implements fail-closed finite state machine with timeout, AbortSignal, and exit handling.
 * - Guarantees worker termination and OS handle release before resolving verification.
 * - Shields against premature exit, uncaught worker exceptions, and invalid messages.
 *
 * @module dsh-word-lookup/host/ecdict-integrity-verifier
 */
import { Worker } from 'node:worker_threads';
import type { IntegrityRequest } from './ecdict-integrity-worker.js';
/**
 * Result of successful candidate database integrity verification.
 */
export interface IntegrityVerificationResult {
    readonly success: boolean;
    readonly integrityResult: 'ok';
    readonly durationMs: number;
}
/**
 * Error thrown when integrity verification fails or cannot complete safely.
 */
export declare class IntegrityVerificationError extends Error {
    readonly errorCode: string;
    readonly durationMs?: number;
    constructor(message: string, errorCode?: string, durationMs?: number);
}
/**
 * Options for spawning the integrity worker.
 */
export interface SpawnIntegrityWorkerOptions {
    /** Optional custom worker URL (for internal fault-injection tests only). */
    readonly workerUrl?: URL;
    /** Optional execArgv overrides. */
    readonly execArgv?: string[];
}
/**
 * Options for executing candidate database verification.
 */
export interface VerifyCandidateOptions {
    /** Optional cancellation signal. */
    readonly signal?: AbortSignal;
    /** Maximum time in milliseconds before timing out (defaults to 30000). */
    readonly timeoutMs?: number;
    /** Optional custom worker URL (for internal fault-injection tests only). */
    readonly workerUrl?: URL;
}
/**
 * Spawn the static companion worker for integrity verification.
 *
 * In production bundle (`lib/index.js`), compiles exclusively to:
 * `new Worker(new URL('./ecdict-integrity-worker.js', import.meta.url), approvedOptions)`
 *
 * @param request - verified request payload.
 * @param options - optional test options (dev/test only).
 */
export declare function spawnIntegrityWorker(request: IntegrityRequest, options?: SpawnIntegrityWorkerOptions): Worker;
/**
 * Execute full PRAGMA integrity_check against a candidate SQLite database in a dedicated Worker.
 *
 * Enforces:
 * - Candidate database file must exist and be normalized.
 * - Single settlement promise lifecycle.
 * - RequestId correlation matching.
 * - Fail-closed handling of errors, non-zero exits, timeouts, and AbortSignals.
 * - Strict await worker.terminate() before returning success to release Windows file locks.
 *
 * @param candidatePath - absolute filesystem path to candidate SQLite database.
 * @param options - optional cancellation, timeout, or worker URL.
 * @returns verification outcome including duration.
 */
export declare function verifyCandidateDatabaseWithWorker(candidatePath: string, options?: VerifyCandidateOptions): Promise<IntegrityVerificationResult>;
