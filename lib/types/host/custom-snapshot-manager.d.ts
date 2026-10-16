/**
 * Secure SQLite Snapshot Manager for custom user dictionaries.
 *
 * Implements Phase 7A.8.1A Tasks A, C, D, E:
 * - Deterministic Snapshot State Machine:
 *   CREATING -> CREATED_UNVERIFIED -> VERIFYING -> VERIFIED -> PUBLISHING -> PUBLISHED
 *   Failure states: REJECTED, CLEANUP_PENDING.
 * - Strict File Ownership Model:
 *   - USER_SOURCE_DATABASE: READ_ONLY, NEVER deleted, NEVER moved, NEVER renamed, NEVER truncated.
 *   - PLUGIN_STAGING_SNAPSHOT: PLUGIN_OWNED, unlinked on failure or rejection.
 *   - PLUGIN_PUBLISHED_SNAPSHOT: PLUGIN_OWNED, safely managed in customSnapshotDirectory.
 * - Anti-TOCTOU Protection: Staging file hash and identity verified before atomic publishing.
 * - Path traversal, symlink, and junction guards via `validateCustomSnapshotPath`.
 * - Integration with `SqliteDictionary` under source `'custom-local'`.
 *
 * @module dsh-word-lookup/host/custom-snapshot-manager
 */
import { type ManagedStoragePaths } from './managed-storage.js';
import { CustomDictionaryValidator, type CustomValidatorTaskOptions } from './custom-dictionary-validator.js';
import { type SqliteDictionary } from './sqlite-dictionary.js';
/**
 * Valid states of the snapshot lifecycle state machine.
 */
export type SnapshotState = 'CREATING' | 'CREATED_UNVERIFIED' | 'VERIFYING' | 'VERIFIED' | 'PUBLISHING' | 'PUBLISHED' | 'REJECTED' | 'CLEANUP_PENDING';
/**
 * Immutable snapshot record tracking the complete lifecycle and provenance.
 */
export interface CustomSnapshotRecord {
    readonly id: string;
    readonly sourcePath: string;
    readonly stagingPath: string;
    readonly publishedPath: string | null;
    readonly state: SnapshotState;
    readonly sha256: string | null;
    readonly byteSize: number | null;
    readonly schemaVersion: number | null;
    readonly entryCount: number | null;
    readonly formCount: number | null;
    readonly exampleCount: number | null;
    readonly headwordsSample: readonly string[];
    readonly createdAt: number;
    readonly verifiedAt: number | null;
    readonly publishedAt: number | null;
    readonly error: string | null;
    readonly errorCode: string | null;
}
/** Options for creating and publishing a snapshot. */
export interface SnapshotPublishOptions extends CustomValidatorTaskOptions {
    /** Optional custom alphanumeric identity token (matching SAFE_IDENTITY_PATTERN). */
    readonly identity?: string;
}
/** Options for constructing CustomSnapshotManager. */
export interface CustomSnapshotManagerOptions {
    readonly paths: ManagedStoragePaths;
    readonly validator?: CustomDictionaryValidator;
    readonly maxSizeBytes?: number;
}
/** Error thrown when TOCTOU tampering or file modification is detected during publishing. */
export declare class SnapshotTamperingError extends Error {
    readonly code = "SNAPSHOT_TAMPERING_DETECTED";
    constructor(message: string);
}
/**
 * Manages the lifecycle, creation, verification, and storage of custom SQLite snapshots.
 */
export declare class CustomSnapshotManager {
    #private;
    constructor(options: CustomSnapshotManagerOptions);
    get isDisposed(): boolean;
    get paths(): ManagedStoragePaths;
    /**
     * Retrieve a snapshot record by ID.
     */
    getSnapshot(id: string): CustomSnapshotRecord | undefined;
    /**
     * List all tracked snapshots.
     */
    listSnapshots(): readonly CustomSnapshotRecord[];
    /**
     * Create, verify, and publish a secure transaction-consistent snapshot from a user SQLite file.
     *
     * State transitions:
     * 1. CREATING: Staging path prepared; worker initiates `VACUUM INTO`.
     * 2. CREATED_UNVERIFIED: Snapshot created on staging; not yet verified.
     * 3. VERIFYING: Worker runs integrity check, schema validation, query plans, and probes.
     * 4. VERIFIED: Validation succeeded; file digest captured.
     * 5. PUBLISHING: Staging file hash reverified (anti-TOCTOU) and atomically renamed.
     * 6. PUBLISHED: Published custom snapshot ready for dictionary activation.
     *
     * If any step fails:
     * State transitions to REJECTED -> CLEANUP_PENDING -> staging file unlinked.
     * User source database is NEVER deleted, renamed, or modified.
     */
    createAndPublishSnapshot(sourcePath: string, options?: SnapshotPublishOptions): Promise<CustomSnapshotRecord>;
    /**
     * Open an already-published snapshot as a queryable SqliteDictionary with source `'custom-local'`.
     */
    openSnapshotDictionary(snapshotId: string): SqliteDictionary;
    /**
     * Safely delete a published custom snapshot.
     */
    cleanupSnapshot(snapshotId: string): Promise<boolean>;
    /**
     * Scan customSnapshotDirectory and safely remove any orphaned `staging-*.sqlite3` files.
     */
    cleanupStagingFiles(): Promise<number>;
    /**
     * Dispose manager and validator, and cleanup staging files.
     */
    dispose(): Promise<void>;
}
