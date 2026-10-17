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
import type { DictionarySource } from './dictionary.js';
import { DictionaryManager } from './dictionary-manager.js';
import { type ManagedStoragePaths, type SettingsSyncState } from './managed-storage.js';
import { CustomSnapshotManager } from './custom-snapshot-manager.js';
import { type DictionaryMode, type HostConfig } from './config.js';
import type { FixtureCorpusInfo, InstalledCorpusInfo, ManagementErrorCode } from '../shared/dictionary-management-protocol.js';
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
    /** Optional CustomSnapshotManager instance. If omitted and paths is provided, one is created. */
    readonly customSnapshotManager?: CustomSnapshotManager | null;
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
 * Result returned by custom dictionary activation.
 */
export interface CustomActivationResult {
    readonly snapshotId: string;
    readonly identity: string;
    readonly activeMode: 'custom';
    readonly generation: number;
}
/**
 * Result returned by operational mode selection.
 */
export interface ModeSelectionResult {
    readonly activeMode: DictionaryMode;
    readonly generation: number;
}
/**
 * Diagnostic summary of the coordinator state.
 */
export interface ActivationStateSummary {
    readonly activeMode: DictionaryMode;
    readonly configuredMode: DictionaryMode;
    readonly activeSource: DictionarySource;
    readonly activeIdentity: string;
    readonly activeSnapshotId: string | null;
    readonly customSnapshotStatus: {
        readonly snapshotId: string;
        readonly activeLeases: number;
    } | null;
    readonly installed: boolean;
    readonly installedCorpus: InstalledCorpusInfo | null;
    readonly fixtureStats: FixtureCorpusInfo;
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
     * Return the custom snapshot manager instance, or null if storage is unavailable.
     */
    get customSnapshotManager(): CustomSnapshotManager | null;
    /**
     * Return the active custom snapshot ID, or null if custom mode is not active.
     */
    get activeSnapshotId(): string | null;
    /**
     * Return whether the coordinator has been disposed.
     */
    get isDisposed(): boolean;
    /**
     * Mark coordinator as disposed, preventing future activations or mutations.
     */
    dispose(): void;
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
     * Commit a verified custom snapshot database and activate it in DictionaryManager.
     *
     * Transaction Sequence:
     * 1. Validate snapshot existence and open candidate dictionary with lease tracking.
     * 2. Probe candidate dictionary with verification headwords.
     * 3. Atomically write `active.json` with CustomActiveMetadata (Commit Point 1: Durability).
     * 4. Atomically hot-switch `DictionaryManager` active reference (Commit Point 2: Runtime).
     * 5. Best-effort update Host Config `dictionaryMode` to 'custom' (Commit Point 3).
     *
     * On failure at Commit Point 2, executes rollback compensation to restore previous metadata
     * and previous active dictionary. If compensation fails, throws ActivationRollbackError.
     *
     * @param snapshotId - published snapshot identifier.
     * @param options - execution options (signal, commit boundary callback).
     * @returns custom activation result.
     */
    activateCustomDatabase(snapshotId: string, options?: {
        signal?: AbortSignal;
        onCommitBoundary?: () => void;
    }): Promise<CustomActivationResult>;
    /**
     * Safely switch between dictionary operational modes ('fixture', 'managed-ecdict', 'custom').
     *
     * Rules:
     * - Switching to 'fixture': activates built-in fixture dictionary, unlinks `active.json`, resets activeSnapshotId.
     * - Switching to 'managed-ecdict': verifies installed ECDICT database exists on disk, activates it, persists metadata.
     * - Switching to 'custom': verifies requested snapshot (or activeSnapshotId) exists and is leased/activated.
     * - Uninterrupted query capability during hot-swap.
     *
     * @param mode - target operational mode.
     * @param options - optional snapshotId (for custom mode) and cancellation/commit signals.
     * @returns mode selection result.
     */
    selectMode(mode: DictionaryMode, options?: {
        snapshotId?: string;
        signal?: AbortSignal;
        onCommitBoundary?: () => void;
    }): Promise<ModeSelectionResult>;
    /**
     * Safely remove the managed ECDICT database.
     *
     * Decoupled semantics:
     * - If activeMode is 'custom': does NOT revert to fixture; custom dictionary remains active,
     *   active.json is NOT deleted. Only managed ECDICT files and installed-ecdict.json are unlinked.
     * - If activeMode is 'managed-ecdict' or 'fixture': hot-switches to fixture, unlinks active.json,
     *   installed-ecdict.json, and managed ECDICT database file.
     *
     * @returns removal outcome including settled activeMode.
     */
    removeManagedDatabase(): Promise<{
        removed: boolean;
        activeMode: 'fixture' | 'custom';
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
