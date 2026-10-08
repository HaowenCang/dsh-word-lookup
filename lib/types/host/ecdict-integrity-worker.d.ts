/**
 * Static Companion Worker for ECDICT candidate SQLite integrity verification.
 *
 * Implements Architecture Exception 1 (Phase 7A.5R4):
 * - Runs in an isolated Worker thread so that C-level SQLite PRAGMA integrity_check
 *   does not block the main thread event loop.
 * - Opens candidate database strictly with `{ readOnly: true }`.
 * - Executes full, unfiltered `PRAGMA integrity_check` (no quick_check, no partial check).
 * - Enforces that .all() returns exactly one row with value strictly equal to 'ok'.
 * - Closes the SQLite connection in a try/finally block BEFORE posting success message
 *   to ensure Windows OS file handles are completely released.
 * - Uses zero external npm dependencies and makes zero network or credentials calls.
 *
 * @module dsh-word-lookup/host/ecdict-integrity-worker
 */
/** Request payload sent to this worker. */
export interface IntegrityRequest {
    readonly requestId: string;
    readonly candidatePath: string;
}
/** Success response payload sent back to main thread. */
export interface IntegritySuccessResponse {
    readonly requestId: string;
    readonly success: true;
    readonly integrityResult: 'ok';
    readonly durationMs: number;
}
/** Failure response payload sent back to main thread. */
export interface IntegrityFailureResponse {
    readonly requestId: string;
    readonly success: false;
    readonly errorCode: string;
    readonly message: string;
    readonly durationMs?: number;
}
/** Discriminated union of integrity responses. */
export type IntegrityResponse = IntegritySuccessResponse | IntegrityFailureResponse;
