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
import type { CustomSnapshotValidateSuccessResponse } from './ecdict-integrity-worker.js';
import type { CustomSnapshotSummary } from '../shared/dictionary-management-protocol.js';
import { type SqliteDictionary } from './sqlite-dictionary.js';
export { SnapshotTamperingError, type CustomSnapshotSummary };
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
/** Error thrown when persistent catalog registration or synchronization fails. */
export declare class CatalogPersistenceError extends Error {
    readonly code = "CATALOG_PERSISTENCE_FAILED";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export interface StagingOwnershipPayload {
    readonly version: 1;
    readonly managerId: string;
    readonly snapshotId: string;
    readonly pid: number;
    readonly processStartTime: number;
    readonly createdAt: number;
    readonly hostInstanceId: string;
}
export interface StagingCleanupOptions {
    /**
     * Explicit recovery of unverified staging files (missing or malformed owner records).
     * Default is false (fail-closed: do not delete unverified files).
     */
    readonly allowUnverifiedRecovery?: boolean;
    /**
     * Optional liveness check override for testing cross-process PID reuse or dead owners.
     */
    readonly isOwnerAlive?: (owner: StagingOwnershipPayload) => boolean;
}
export interface CustomSnapshotHooks {
    readonly onBeforeValidateCleanup?: (snapshotId: string) => Promise<void> | void;
    readonly onBeforeUnlinkCleanup?: (snapshotId: string) => Promise<void> | void;
    readonly onBeforeWriteOwner?: (ownerPath: string) => Promise<void> | void;
    readonly onAfterCreateStaging?: (stagingPath: string) => Promise<void> | void;
    readonly onAfterValidateBeforeOpen?: (snapshotId: string, publishedPath: string) => Promise<void> | void;
    readonly onBeforePersistCatalog?: (record: CustomSnapshotRecord) => Promise<void> | void;
    readonly openSqliteDictionary?: (options: any) => SqliteDictionary;
    readonly now?: () => number;
}
export declare function _setCustomSnapshotHooksForTesting(hooks: CustomSnapshotHooks | null): void;
export declare function _getHostProcessInstanceIdForTesting(): string;
export declare function _getProcessStartTimeForTesting(): number;
export declare function _resetActiveManagersForTesting(): void;
/**
 * Manages the lifecycle, creation, verification, and storage of custom SQLite snapshots.
 */
export declare class CustomSnapshotManager {
    #private;
    constructor(options: CustomSnapshotManagerOptions);
    get managerId(): string;
    get isDisposed(): boolean;
    get catalogError(): string | null;
    get validator(): CustomDictionaryValidator;
    /**
     * Validate an existing published snapshot file via isolated worker thread.
     */
    validatePublishedSnapshot(publishedPath: string, options?: CustomValidatorTaskOptions): Promise<CustomSnapshotValidateSuccessResponse>;
    /**
     * Validate a user candidate database file via isolated worker thread without modifying disk.
     */
    validateCandidateDatabase(candidatePath: string, options?: CustomValidatorTaskOptions): Promise<CustomSnapshotValidateSuccessResponse>;
    /**
     * Load snapshots from persistent catalog into in-memory registry.
     *
     * Invariants:
     * - B21: If catalog is missing but legacy active.json references a valid custom snapshot, migrates and persists catalog.
     * - B22: If catalog file is corrupt or unparseable, safely degrades without throwing, recording degradation status.
     * - B24: If an entry in catalog references a missing or corrupt file, records state gracefully without crashing.
     * - Adopted snapshots start in PUBLISHED_INACTIVE state with 0 leases.
     */
    loadCatalog(): Promise<void>;
    /**
     * Reconcile physically published snapshot databases on disk with the persistent catalog.
     * If a valid custom database file (custom-<id>.sqlite3) exists in customSnapshotDirectory
     * but is missing from index.json (e.g. from a crash during catalog persistence or failure recovery),
     * this method verifies its SQLite integrity via worker, recovers its metadata, and durably registers
     * it into the catalog.
     */
    reconcileUnregisteredSnapshots(): Promise<readonly string[]>;
    /**
     * List all custom snapshots as public summaries without sensitive source paths.
     */
    listCustomSnapshots(): readonly CustomSnapshotSummary[];
    /**
     * Retrieve a custom snapshot summary by ID without sensitive source paths.
     */
    getCustomSnapshot(snapshotId: string): CustomSnapshotSummary | undefined;
    isStagingActive(stagingPath: string): boolean;
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
     * Return the current active lease count for a tracked snapshot.
     */
    getActiveLeases(snapshotId: string): number;
    /**
     * Adopt an existing published snapshot file into this manager's tracking table.
     *
     * Used during startup recovery or mode switching to load a pre-existing published snapshot.
     * Enforces security boundaries:
     * - snapshotId must be a valid non-empty string.
     * - publishedPath must be an absolute path inside customSnapshotDirectory conforming to naming contracts.
     * - publishedPath must exist on disk and must not be a symlink or directory.
     *
     * @param snapshotId - unique snapshot UUID.
     * @param metadata - snapshot metadata.
     * @returns tracked CustomSnapshotRecord.
     */
    adoptPublishedSnapshot(snapshotId: string, metadata: {
        identity: string;
        publishedPath: string;
        sha256?: string | null;
        byteSize?: number | null;
        schemaVersion?: number | null;
        entryCount?: number | null;
        formCount?: number | null;
        exampleCount?: number | null;
        headwordsSample?: readonly string[];
    }): Promise<CustomSnapshotRecord>;
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
     * Fully validate a dormant or published custom snapshot before dictionary activation (B15).
     *
     * Security & Integrity Contract:
     * 1. Snapshot ID and basename strictly bound.
     * 2. Path containment, ancestor directory symlinks, and file symlink/junction inspection.
     * 3. File type and byte size validation against catalog.
     * 4. Companion Worker streaming SHA-256 calculation (zero full-file Buffer in Host).
     * 5. Catalog SHA-256 digest matching (rejects tampered or replaced databases).
     * 6. Catalog byteSize matching.
     * 7. Full SQLite PRAGMA integrity_check(100) via Worker.
     * 8. SQLite schema, required indexes (rejects SCAN), and query compatibility verification.
     * 9. Anti-TOCTOU protection between verification and opening; returns SqliteDictionary holding active lease.
     * 10. Fail-closed: if validation fails, zero leases are leaked, in-memory state is marked REJECTED,
     *     and the caller does NOT commit active.json or switch active dictionary.
     */
    validatePublishedSnapshotForActivation(snapshotId: string, options?: CustomValidatorTaskOptions): Promise<SqliteDictionary>;
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
    /** Shared capability and execution eligibility; cleanup still revalidates disk identity. */
    canCleanupSnapshot(snapshotId: string, activeSnapshotId?: string | null): boolean;
    cleanupSnapshot(snapshotId: string): Promise<boolean>;
    /**
     * Scan customSnapshotDirectory and safely remove orphaned staging files.
     * Never deletes staging files actively owned by another manager instance or process.
     */
    cleanupStagingFiles(options?: StagingCleanupOptions): Promise<number>;
    /**
     * Dispose manager and validator.
     * Cancels in-flight tasks and cleans up ONLY staging files owned by this manager instance.
     * Published snapshots are strictly preserved for future restarts.
     */
    dispose(): Promise<void>;
}
