/**
 * Secure SQLite Snapshot Manager for custom user dictionaries.
 *
 * Implements Phase 7A.8.1A & Phase 7A.8.1AR Security Contracts:
 * - Deterministic Snapshot Lifecycle State Machine:
 *   STAGING / CREATING -> CREATED_UNVERIFIED -> VERIFYING -> VERIFIED -> PUBLISHING -> PUBLISHED_INACTIVE
 *   Active reference states: ACTIVE / PUBLISHED_LEASED, RETIRING.
 *   Terminal/cleanup states: CLEANUP_PENDING, DELETED, REJECTED.
 * - Anti-Overwrite Publication & Identity Separation:
 *   - File identity is strictly determined by an unpredictable internal UUID (`custom-<uuid>.sqlite3`).
 *   - User/caller `identity` token is preserved strictly as logical metadata, never as an overwrite target.
 *   - Atomic fail-closed publication prevents race-condition overwrites.
 * - Active Snapshot Reference & Lease Protection:
 *   - Leased snapshots cannot be unlinked while query connections remain active.
 *   - Idempotent close and idempotent cleanup.
 *   - Explicit error handling for Windows file locks (EBUSY/EPERM).
 * - Offloaded Non-Blocking Pre-Publish Integrity Verification:
 *   - Pre-publish SHA-256 and byte size verification executes in an isolated Worker thread.
 *   - Host main-thread event loop remains completely unblocked.
 * - Multi-Instance Staging Ownership Isolation:
 *   - Explicit staging ownership tracking prevents cross-manager or cross-operation staging deletion.
 *   - Manager disposal preserves published snapshots for future restart restoration.
 * - Strict User File Immutability:
 *   - User source files are strictly read-only: never deleted, moved, renamed, or truncated.
 *
 * @module dsh-word-lookup/host/custom-snapshot-manager
 */
import { type ManagedStoragePaths } from './managed-storage.js';
import { CustomDictionaryValidator, SnapshotTamperingError, type CustomValidatorTaskOptions } from './custom-dictionary-validator.js';
import { type SqliteDictionary } from './sqlite-dictionary.js';
export { SnapshotTamperingError };
/**
 * Valid states of the snapshot lifecycle state machine.
 */
export type SnapshotState = 'STAGING' | 'CREATING' | 'CREATED_UNVERIFIED' | 'VERIFYING' | 'VERIFIED' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISHED_INACTIVE' | 'PUBLISHED_LEASED' | 'ACTIVE' | 'RETIRING' | 'CLEANUP_PENDING' | 'DELETED' | 'REJECTED';
/**
 * Immutable snapshot record tracking the complete lifecycle, ownership, and provenance.
 */
export interface CustomSnapshotRecord {
    readonly id: string;
    readonly identity: string;
    readonly sourcePath: string;
    readonly stagingPath: string;
    readonly publishedPath: string | null;
    readonly state: SnapshotState;
    readonly activeLeases: number;
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
    /** Optional target filename override (used exclusively for collision/conflict injection testing). */
    readonly targetFileName?: string;
}
/** Options for constructing CustomSnapshotManager. */
export interface CustomSnapshotManagerOptions {
    readonly paths: ManagedStoragePaths;
    readonly validator?: CustomDictionaryValidator;
    readonly maxSizeBytes?: number;
}
/** Error thrown when attempting to clean up a snapshot that currently has active dictionary references. */
export declare class SnapshotActiveReferenceError extends Error {
    readonly code = "SNAPSHOT_ACTIVE_REFERENCE";
    readonly activeLeases: number;
    constructor(message: string, activeLeases: number);
}
/** Error thrown when the atomic publish destination already exists or collides. */
export declare class SnapshotPublishConflictError extends Error {
    readonly code = "SNAPSHOT_PUBLISH_CONFLICT";
    constructor(message: string);
}
/** Error thrown when snapshot cleanup fails due to operating system file locks or errors. */
export declare class SnapshotCleanupError extends Error {
    readonly code = "SNAPSHOT_CLEANUP_FAILED";
    readonly originalCode?: string;
    constructor(message: string, originalCode?: string);
}
/**
 * Manages the lifecycle, creation, verification, and storage of custom SQLite snapshots.
 */
export declare class CustomSnapshotManager {
    #private;
    constructor(options: CustomSnapshotManagerOptions);
    get managerId(): string;
    get isDisposed(): boolean;
    get paths(): ManagedStoragePaths;
    /**
     * Retrieve a snapshot record by ID.
     */
    getSnapshot(id: string): CustomSnapshotRecord | undefined;
    /**
     * Retrieve a snapshot record by logical identity.
     */
    getSnapshotByIdentity(identity: string): CustomSnapshotRecord | undefined;
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
     * 5. PUBLISHING: Staging file hash reverified in Worker (anti-TOCTOU) and atomically published.
     * 6. PUBLISHED_INACTIVE: Published custom snapshot ready for dictionary activation.
     *
     * Failure transitions:
     * State transitions to REJECTED -> CLEANUP_PENDING -> staging file unlinked.
     * User source database is NEVER deleted, renamed, or modified.
     */
    createAndPublishSnapshot(sourcePath: string, options?: SnapshotPublishOptions): Promise<CustomSnapshotRecord>;
    /**
     * Open an already-published snapshot as a queryable SqliteDictionary with source `'custom-local'`.
     * Acquires a lease on the snapshot to protect it against deletion while active.
     */
    openSnapshotDictionary(snapshotId: string): SqliteDictionary;
    /**
     * Retire a published snapshot, marking it for safe deactivation once current active references drain.
     */
    retireSnapshot(snapshotId: string): void;
    /**
     * Safely delete a published custom snapshot.
     *
     * Rejects deletion if active dictionary references exist or if the snapshot is in RETIRING state.
     * Handles Windows file locks explicitly.
     */
    cleanupSnapshot(snapshotId: string): Promise<boolean>;
    /**
     * Scan customSnapshotDirectory and safely remove orphaned staging files.
     * Never deletes staging files actively owned by another manager instance or process.
     */
    cleanupStagingFiles(): Promise<number>;
    /**
     * Dispose manager and validator.
     * Cancels in-flight tasks and cleans up ONLY staging files owned by this manager instance.
     * Published snapshots are strictly preserved for future restarts.
     */
    dispose(): Promise<void>;
}
