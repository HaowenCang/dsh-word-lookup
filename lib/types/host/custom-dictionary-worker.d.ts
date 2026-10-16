/**
 * Isolated Worker implementation for custom SQLite snapshot creation and validation.
 *
 * Implements Phase 7A.8.1A Tasks A, B, C, D:
 * - Executes SQLite snapshot creation via `VACUUM INTO` on `{ readOnly: true }` source connection.
 * - Enforces SQLite security parameters: `PRAGMA trusted_schema = OFF`, `enableDefensive(true)`, `PRAGMA busy_timeout = 5000`.
 * - Validates schema contract: required tables (`meta`, `entries`, `forms`, `examples`), required columns, schema version.
 * - Validates query performance and index coverage via `EXPLAIN QUERY PLAN` (requires B-Tree SEARCH, forbids SCAN).
 * - Executes read-only query compatibility probes across headwords, forms, and examples.
 * - Employs fail-closed cleanup: unlinks partially created staging files on error.
 * - Guarantees SQLite connection closure before messaging and termination to ensure Windows handle release.
 *
 * @module dsh-word-lookup/host/custom-dictionary-worker
 */
/** Request payload for snapshot creation. */
export interface CustomSnapshotCreateRequest {
    readonly action: 'CUSTOM_SNAPSHOT_CREATE';
    readonly requestId: string;
    readonly sourcePath: string;
    readonly stagingPath: string;
    readonly maxSizeBytes?: number;
}
/** Success response payload for snapshot creation. */
export interface CustomSnapshotCreateSuccessResponse {
    readonly action: 'CUSTOM_SNAPSHOT_CREATE';
    readonly requestId: string;
    readonly success: true;
    readonly sha256: string;
    readonly byteSize: number;
    readonly durationMs: number;
}
/** Request payload for snapshot validation. */
export interface CustomSnapshotValidateRequest {
    readonly action: 'CUSTOM_SNAPSHOT_VALIDATE';
    readonly requestId: string;
    readonly snapshotPath: string;
    readonly maxSizeBytes?: number;
}
/** Success response payload for snapshot validation. */
export interface CustomSnapshotValidateSuccessResponse {
    readonly action: 'CUSTOM_SNAPSHOT_VALIDATE';
    readonly requestId: string;
    readonly success: true;
    readonly schemaVersion: number;
    readonly entryCount: number;
    readonly formCount: number;
    readonly exampleCount: number;
    readonly headwordsSample: readonly string[];
    readonly sha256: string;
    readonly byteSize: number;
    readonly durationMs: number;
}
/** Generic failure response payload for custom worker operations. */
export interface CustomWorkerFailureResponse {
    readonly action: 'CUSTOM_SNAPSHOT_CREATE' | 'CUSTOM_SNAPSHOT_VALIDATE';
    readonly requestId: string;
    readonly success: false;
    readonly errorCode: string;
    readonly message: string;
    readonly durationMs?: number;
}
export type CustomWorkerResponse = CustomSnapshotCreateSuccessResponse | CustomSnapshotValidateSuccessResponse | CustomWorkerFailureResponse;
/** Compute full SHA-256 digest of a file in 64 KB chunks to minimize RSS. */
export declare function computeFileSha256(filePath: string): string;
/** Sanitize worker error messages to prevent leaking local paths or credentials. */
export declare function sanitizeWorkerError(raw: string): string;
/**
 * Determine if a query plan step requires scanning rather than indexed search on the target table.
 */
export declare function requiresTableScan(planText: string, table: string): boolean;
/**
 * Execute snapshot creation from sourcePath to stagingPath using VACUUM INTO.
 */
export declare function executeCustomSnapshotCreate(request: CustomSnapshotCreateRequest): CustomSnapshotCreateSuccessResponse | CustomWorkerFailureResponse;
/**
 * Execute comprehensive schema, integrity, query plan, and compatibility validation on a snapshot database.
 */
export declare function executeCustomSnapshotValidate(request: CustomSnapshotValidateRequest): CustomSnapshotValidateSuccessResponse | CustomWorkerFailureResponse;
