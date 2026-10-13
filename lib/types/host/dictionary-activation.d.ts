/**
 * Activation coordination, persistence consistency, startup recovery, and managed corpus removal.
 *
 * Implements the atomic activation transaction protocol and fail-closed state consistency:
 * - Validates candidate databases read-only before committing activation.
 * - Commits `active.json` atomically via {@link writeActiveMetadataAtomically}.
 * - Atomically switches live {@link DictionaryManager} active reference.
 * - Best-effort syncs Host Config `dictionaryMode` via DSH settings service without blocking activation.
 * - Enforces startup recovery: checks metadata and database health on plugin boot, gracefully degrading
 *   to fixture if corrupt or missing without corrupting disk state or triggering unauthorized network downloads.
 * - Enforces safe removal: hot-switches manager to fixture to release Windows SQLite file locks before unlinking.
 * - Preserves verified source cache upon removal for future re-installations.
 * - Provides read-only verification for custom SQLite databases without file mutation.
 *
 * Invariants:
 * - Zero network access in this module.
 * - Fail-closed: rejections preserve existing active dictionary.
 * - Safe on Windows: handles closed before unlinking.
 *
 * @module dsh-word-lookup/host/dictionary-activation
 */
import type { Context } from '@deepseek-ai/cordis';
import { DictionaryManager } from './dictionary-manager.js';
import { type ManagedStoragePaths, type SettingsSyncState } from './managed-storage.js';
import { type DictionaryMode, type HostConfig } from './config.js';
import type { InstalledCorpusInfo, ManagementErrorCode } from '../shared/dictionary-management-protocol.js';
import type { ManagedEcdictBuildResult } from './ecdict-importer.js';
/**
 * Error thrown when an activation attempt fails and rollback of previous state also fails.
 */
export declare class ActivationRollbackError extends Error {
    readonly code = "ACTIVATION_ROLLBACK_FAILED";
    readonly originalError: unknown;
    readonly rollbackError: unknown;
    constructor(message: string, originalError: unknown, rollbackError: unknown);
}
/**
 * Options for constructing {@link ActivationCoordinator}.
 */
export interface ActivationCoordinatorOptions {
    /** Owning Cordis Context. */
    readonly ctx?: Context;
    /** Resolved managed storage paths, or null/undefined if storage is unavailable. */
    readonly paths?: ManagedStoragePaths | null;
    /** Live dictionary manager instance. */
    readonly manager: DictionaryManager;
    /** Plugin host configuration. */
    readonly config?: HostConfig;
}
/**
 * Result returned by custom dictionary database verification.
 */
export interface CustomDatabaseVerificationResult {
    readonly valid: boolean;
    readonly schemaVersion: number;
    readonly entryCount: number;
    readonly formCount: number;
    readonly headwordsSample: readonly string[];
    readonly error?: string;
    readonly errorCode?: ManagementErrorCode;
}
/**
 * Diagnostic summary of the coordinator state.
 */
export interface ActivationStateSummary {
    readonly activeMode: DictionaryMode;
    readonly configuredMode: DictionaryMode;
    readonly activeSource: 'sqlite-fixture' | 'ecdict-local';
    readonly activeIdentity: string;
    readonly installed: boolean;
    readonly installedCorpus: InstalledCorpusInfo | null;
    readonly quarantined: boolean;
    readonly quarantineReason: string | null;
    readonly recoveryError: string | null;
    readonly settingsSyncState: SettingsSyncState;
    readonly settingsSyncError: string | null;
    readonly lastRetirementError: string | null;
    readonly lastRollbackError: string | null;
    readonly generation: number;
}
/**
 * Test-only failure injection and race orchestration hooks for activation coordinator.
 */
export interface ActivationHooks {
    readonly beforeReadMetadata?: () => Promise<void>;
    readonly beforeCommitMetadata?: () => Promise<void>;
    readonly duringRollbackCompensation?: () => Promise<void>;
}
/**
 * Configure test-only activation hooks.
 * @internal
 */
export declare function _setActivationHooksForTesting(hooks: ActivationHooks | null): void;
/**
 * Coordinates atomic activation, persistence consistency, recovery, and removal.
 */
export declare class ActivationCoordinator {
    #private;
    constructor(options: ActivationCoordinatorOptions);
    /**
     * Return storage paths used by this coordinator.
     */
    get paths(): ManagedStoragePaths | null;
    /**
     * Return the underlying live DictionaryManager.
     */
    get manager(): DictionaryManager;
    /**
     * Return whether startup recovery is currently in flight.
     */
    get isRecovering(): boolean;
    /**
     * Await completion of in-flight startup recovery, ensuring subsequent operations
     * observe settled state and never race or interleave with recovery.
     */
    ensureReady(): Promise<void>;
    /**
     * Startup recovery check: inspects active.json and managed database health.
     *
     * Rules:
     * - If active.json is absent: remains on fixture (fresh install).
     * - If active.json is malformed or corrupt: remains on fixture, records recoveryError.
     * - If active.json exists but database file is missing: remains on fixture, records recoveryError.
     * - If database exists but fails integrity/schema checks: remains on fixture, records recoveryError.
     * - If database is fully verified:
     *   - If configured dictionaryMode === 'managed-ecdict': activates managed dictionary into manager.
     *   - If configured dictionaryMode === 'fixture' and previous settings sync failed (A02/A03):
     *     recovers committed managed activation intent, activates managed dictionary, preserves settingsSyncError.
     *   - If configured dictionaryMode === 'fixture' and settings was cleanly synced (A04):
     *     honors explicit user choice, keeps fixture active, caches verified installed corpus info.
     *   - Else: caches verified installed corpus info without activating.
     */
    recoverOnStartup(): Promise<void>;
    /**
     * Commit a newly built managed database and activate it in DictionaryManager.
     *
     * Transaction Sequence:
     * 1. Validate published SQLite database read-only.
     * 2. Atomically write `active.json` (Commit Point 1: Durability).
     * 3. Atomically switch `DictionaryManager` active reference (Commit Point 2: Runtime).
     * 4. Best-effort update Host Config `dictionaryMode` via DSH settings service (Commit Point 3).
     *
     * On Step 3 failure, rolls back `active.json` and closes the candidate.
     *
     * @param buildResult - verified outcome from buildManagedEcdictDatabase.
     */
    activateManagedDatabase(buildResult: ManagedEcdictBuildResult, options?: {
        signal?: AbortSignal;
        onCommitBoundary?: () => void;
    }): Promise<void>;
    /**
     * Safely remove the managed ECDICT database and revert active dictionary to fixture.
     *
     * Sequence:
     * 1. Safe hot-switch to fixture in DictionaryManager, releasing Windows file locks on SQLite files.
     * 2. Remove `active.json`.
     * 3. Unlink versioned SQLite file `ecdict-<identity>.sqlite3`.
     * 4. Clean stale temporary artifacts.
     * 5. Preserve source cache in `cache/dsh-word-lookup/sources/ecdict.csv`.
     * 6. Best-effort update Host Config `dictionaryMode` to 'fixture'.
     */
    removeManagedDatabase(): Promise<{
        removed: boolean;
    }>;
    /**
     * Verify an arbitrary custom SQLite dictionary path without mutation or activation.
     *
     * Validates:
     * - Path existence, format, and extension (`.sqlite3`, `.sqlite`, `.db`).
     * - SQLite header and schema (tables `meta`, `entries`, `forms`, `examples`).
     * - Query compatibility via sample lookups.
     * - Never mutates candidate file.
     *
     * @param candidatePath - host filesystem path to candidate database.
     */
    verifyCustomDatabase(candidatePath: string): Promise<CustomDatabaseVerificationResult>;
    /**
     * Return a diagnostic state snapshot.
     */
    getStatusSummary(): ActivationStateSummary;
}
