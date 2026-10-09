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
import { type Stats } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { IntegrityRequest, IntegrityResponse } from './ecdict-integrity-worker.js';
export type { IntegrityRequest, IntegrityResponse, };
/**
 * Worker termination status distinguishing confirmed exit from unconfirmed/failed termination.
 */
export type WorkerTerminationStatus = 'TERMINATED_CONFIRMED' | 'TERMINATION_UNCONFIRMED';
/**
 * Result of successful candidate database integrity verification.
 */
export interface IntegrityVerificationResult {
    readonly success: boolean;
    readonly integrityResult: 'ok';
    readonly durationMs: number;
}
/**
 * File identity signature used to verify candidate file authenticity before deletion.
 */
export interface CandidateFileIdentity {
    readonly dev: number;
    readonly ino: number;
    readonly birthtimeMs: number;
    readonly mtimeMs: number;
    readonly size: number;
}
/**
 * Capture file identity signature for candidate database path.
 */
export declare function captureCandidateFileIdentity(filePath: string): CandidateFileIdentity | null;
/**
 * Check whether a file's current stat matches the recorded candidate file identity.
 */
export declare function matchesCandidateFileIdentity(currentStat: Stats, recorded: CandidateFileIdentity): boolean;
/**
 * Private symbol brand ensuring authentic supervisor provenance for worker exit proofs.
 */
export declare const EXIT_PROOF_BRAND: unique symbol;
/**
 * Structurally reliable proof of worker termination.
 */
export interface WorkerExitProof {
    readonly workerId: string;
    readonly exitCode: number;
    readonly confirmedAt: number;
    readonly proofSource: 'terminate' | 'exit_event';
    /** @internal Private cryptographic/symbol token guaranteeing supervisor provenance. */
    readonly [EXIT_PROOF_BRAND]?: boolean;
}
/**
 * Options for constructing {@link WorkerTerminationError}.
 */
export interface WorkerTerminationErrorOptions {
    readonly cause?: unknown;
    readonly workerId?: string;
    readonly candidatePath?: string;
    readonly candidateFileIdentity?: CandidateFileIdentity | null;
}
/**
 * Error thrown when worker termination fails or cannot be confirmed within deadline.
 */
export declare class WorkerTerminationError extends Error {
    readonly errorCode = "WORKER_TERMINATION_FAILED";
    readonly terminationStatus: WorkerTerminationStatus;
    readonly workerId?: string;
    readonly candidatePath?: string;
    readonly candidateFileIdentity?: CandidateFileIdentity | null;
    constructor(message: string, terminationStatus?: WorkerTerminationStatus, options?: WorkerTerminationErrorOptions);
}
/**
 * Error thrown when quarantine recovery cannot be safely completed.
 */
export declare class QuarantineRecoveryError extends WorkerTerminationError {
    readonly directory: string;
    constructor(message: string, errorCode?: string, directory?: string, candidatePath?: string, workerId?: string, options?: {
        cause?: unknown;
        candidateFileIdentity?: CandidateFileIdentity | null;
    });
}
/**
 * Options for constructing {@link IntegrityVerificationError}.
 */
export interface IntegrityVerificationErrorOptions {
    readonly cause?: unknown;
    readonly workerId?: string;
    readonly candidatePath?: string;
    readonly candidateFileIdentity?: CandidateFileIdentity | null;
}
/**
 * Error thrown when integrity verification fails or cannot complete safely.
 */
export declare class IntegrityVerificationError extends Error {
    readonly errorCode: string;
    readonly durationMs?: number;
    terminationStatus: WorkerTerminationStatus;
    readonly workerId?: string;
    readonly candidatePath?: string;
    readonly candidateFileIdentity?: CandidateFileIdentity | null;
    constructor(message: string, errorCode?: string, durationMs?: number, terminationStatus?: WorkerTerminationStatus, options?: IntegrityVerificationErrorOptions);
}
/**
 * Check whether an error or aggregate error indicates unconfirmed worker termination.
 */
export declare function isTerminationUnconfirmed(err: unknown): boolean;
/**
 * Extract worker termination identifiers and candidate metadata from an error or aggregate error.
 */
export declare function extractWorkerTerminationInfo(err: unknown): {
    workerId?: string;
    candidatePath?: string;
    candidateFileIdentity?: CandidateFileIdentity | null;
} | null;
/**
 * Structural interface for worker instances, enabling internal adapter injection.
 */
export interface WorkerLike {
    on(event: 'message', listener: (value: any) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'exit', listener: (exitCode: number) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    removeListener?(event: string, listener: (...args: any[]) => void): this;
    removeAllListeners(event?: string): this;
    terminate(): Promise<number>;
}
/**
 * Active session tracking a worker instance during candidate verification.
 */
export interface WorkerSupervisorSession {
    readonly workerId: string;
    readonly candidatePath: string;
    readonly candidateFileIdentity: CandidateFileIdentity | null;
    readonly worker: WorkerLike;
    readonly status: WorkerTerminationStatus | 'RUNNING' | 'TERMINATING';
    readonly exitProof: WorkerExitProof | null;
    readonly lateErrors: readonly Error[];
    waitForExit(timeoutMs?: number): Promise<WorkerExitProof>;
    cleanupListeners?: () => void;
}
/**
 * Registration parameters for the worker supervisor.
 */
export interface WorkerSupervisorRegistrationParams {
    readonly worker: WorkerLike;
    readonly candidatePath: string;
    readonly candidateFileIdentity?: CandidateFileIdentity | null;
    readonly workerId?: string;
}
/**
 * Supervisor tracking active and terminating worker lifecycles, exit proofs,
 * and candidate file associations.
 */
export declare class WorkerSupervisor {
    private readonly records;
    private readonly byCandidate;
    registerWorker(params: WorkerSupervisorRegistrationParams): WorkerSupervisorSession;
    getExitProof(workerId: string): WorkerExitProof | null;
    getSession(workerId: string): WorkerSupervisorSession | null;
    getSessionByCandidatePath(candidatePath: string): WorkerSupervisorSession | null;
    private recordTerminationConfirmedInternal;
    recordTerminationViaTerminate(workerId: string, exitCode: number): WorkerExitProof | null;
    recordTerminationConfirmed(workerId: string, exitCode: number, proofSource?: 'terminate' | 'exit_event'): WorkerExitProof;
    _injectTerminationConfirmedForTesting(workerId: string, exitCode: number, proofSource?: 'terminate' | 'exit_event'): WorkerExitProof;
    isExitProofAuthentic(proof: unknown): proof is WorkerExitProof;
    recordTerminationUnconfirmed(workerId: string, error?: Error): void;
    waitForExit(workerId: string, timeoutMs?: number): Promise<WorkerExitProof>;
    unregisterWorker(workerId: string): void;
    getActiveSessionCount(): number;
    hasSession(workerId: string): boolean;
    getTrackedWorkerIds(): string[];
    resetForTesting(): void;
}
/** Global singleton worker supervisor. */
export declare const workerSupervisor: WorkerSupervisor;
/**
 * Access the global worker supervisor.
 */
export declare function getWorkerSupervisor(): WorkerSupervisor;
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
    /** Maximum time in milliseconds before worker termination times out (defaults to 5000). */
    readonly terminationTimeoutMs?: number;
    /** Optional custom worker URL (for internal fault-injection tests only). */
    readonly workerUrl?: URL;
    /** Optional expected directory containing candidate database. */
    readonly expectedDirectory?: string;
    /** @internal Internal test seam: custom worker adapter for deterministic lifecycle testing. */
    readonly workerAdapter?: (request: IntegrityRequest) => WorkerLike;
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
export declare function verifyCandidateDatabaseWithWorker(candidatePath: string, options?: VerifyCandidateOptions): Promise<IntegrityVerificationResult>;
