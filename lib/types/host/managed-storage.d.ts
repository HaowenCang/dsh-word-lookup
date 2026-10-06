/**
 * Profile-aware managed dictionary storage layout and atomic active metadata persistence.
 *
 * Implements the filesystem storage contracts for Phase 7A.3:
 *
 * Layout:
 * ```text
 * <DSH_HOME>/
 *   cache/
 *     dsh-word-lookup/
 *       sources/
 *         ... (downloaded ECDICT source artifacts, e.g. ecdict.csv, *.part)
 *   storages/
 *     dsh-word-lookup/
 *       databases/
 *         ecdict-<identity>.sqlite3
 *       active.json
 * ```
 *
 * Invariants:
 * - Resolved DSH home is obtained through official host context surfaces
 *   (`ctx.get('profileContext')?.home` or `ctx.get('dshHomePath')?.()`) or explicit injection.
 * - Zero ambient environment access in active package runtime to maintain Store contract `credentials = false`.
 * - Versioned database naming: databases are never overwritten in place (`ecdict-<identity>.sqlite3`),
 *   ensuring Windows open SQLite handle safety during atomic hot-swapping.
 * - Atomic metadata persistence: `active.json` is updated via sibling temporary file rename
 *   (`active.json.tmp-<uuid>` -> `active.json`).
 * - Metadata database references are relative basenames only (`databaseFile`), preventing
 *   machine path leakage and traversal vulnerabilities.
 * - Malformed metadata fails closed without mutating or destroying existing files.
 *
 * @module dsh-word-lookup/host/managed-storage
 */
import type { Context } from '@deepseek-ai/cordis';
/** Safe identity token pattern: alphanumeric plus dots, underscores, dashes (1-64 chars). */
export declare const SAFE_IDENTITY_PATTERN: RegExp;
/** Versioned managed SQLite filename pattern. */
export declare const MANAGED_DATABASE_FILENAME_PATTERN: RegExp;
/** Recognized temporary artifact pattern for safe cleanup. */
export declare const STALE_TEMPORARY_ARTIFACT_PATTERN: RegExp;
/**
 * Resolved directory and file paths for managed dictionary storage.
 */
export interface ManagedStoragePaths {
    /** Root DSH home directory. */
    readonly home: string;
    /** Directory for downloaded source artifacts (`<home>/cache/dsh-word-lookup/sources`). */
    readonly sourceCacheDirectory: string;
    /** Root storage directory (`<home>/storages/dsh-word-lookup`). */
    readonly storageDirectory: string;
    /** Directory for versioned SQLite databases (`<home>/storages/dsh-word-lookup/databases`). */
    readonly databaseDirectory: string;
    /** Path to the active metadata file (`<home>/storages/dsh-word-lookup/active.json`). */
    readonly activeMetadataPath: string;
}
/**
 * Options for resolving managed storage paths.
 */
export interface ResolveManagedStorageOptions {
    /** Explicit DSH home override (highest precedence; used for testing and synthetic roots). */
    readonly home?: string;
    /** Host Cordis context to resolve profileContext or dshHomePath from. */
    readonly ctx?: Context;
}
/**
 * Source provenance descriptor in active metadata.
 */
export interface ActiveMetadataSource {
    /** Canonical corpus source name (e.g. 'ECDICT'). */
    readonly name: string;
    /** 40-character git commit hash of the corpus artifact. */
    readonly commit: string;
    /** 64-character lowercase SHA-256 digest of the source artifact. */
    readonly sha256: string;
    /** SQLite schema version. */
    readonly schemaVersion: number;
}
/**
 * Schema of persisted `active.json` metadata.
 */
export interface ActiveMetadata {
    /** Metadata schema version (currently 1). */
    readonly version: 1;
    /** Active dictionary mode (must be 'managed-ecdict'). */
    readonly activeMode: 'managed-ecdict';
    /** Safe identifier matching the database identity. */
    readonly identity: string;
    /** Basename only of the active SQLite database (e.g. 'ecdict-v1-abcdef.sqlite3'). */
    readonly databaseFile: string;
    /** Source provenance details. */
    readonly source: ActiveMetadataSource;
}
/**
 * Attempt to extract the resolved DSH home from official host context surfaces.
 *
 * Supported surfaces in DSH 0.2.0-rc.2:
 * 1. `ctx.get('profileContext')?.home` (provided by `profile-boot` on profile launch).
 * 2. `ctx.get('dshHomePath')?.()` (provided by `app-boot` on boot).
 *
 * Returns `null` when neither surface is present on the context.
 */
export declare function resolveDshHomeFromContext(ctx?: Context): string | null;
/**
 * Resolve managed dictionary filesystem layout paths.
 *
 * Precedence:
 * 1. `options.home` (explicit override).
 * 2. `options.ctx` official host services (`profileContext.home` or `dshHomePath`).
 *
 * Throws if no home can be resolved through supported official surfaces.
 * Fails closed without falling back to ambient process environment or unverified `~/.dsh`.
 *
 * @param options - optional explicit home or context.
 * @returns validated immutable paths object.
 */
export declare function resolveManagedStoragePaths(options?: ResolveManagedStorageOptions): ManagedStoragePaths;
/**
 * Ensure storage and cache directories exist on disk.
 *
 * Creates:
 * - `<home>/cache/dsh-word-lookup/sources`
 * - `<home>/storages/dsh-word-lookup/databases`
 *
 * @param paths - resolved managed storage paths.
 */
export declare function ensureManagedStorageDirectories(paths: ManagedStoragePaths): Promise<void>;
/**
 * Generate a validated, filesystem-safe versioned SQLite database filename.
 *
 * Enforces strict character and length constraints to prevent path traversal and collisions:
 * - Must match {@link SAFE_IDENTITY_PATTERN}.
 * - Must not contain path separators (`/`, `\`), traversal segments (`.`, `..`), or drive letters (`:`).
 *
 * @param identity - safe versioned identity string (e.g. 'v1-a7013d658fb101bc').
 * @returns basename filename formatted as `ecdict-<identity>.sqlite3`.
 */
export declare function managedDatabaseFileName(identity: string): string;
/**
 * Return the absolute path to a versioned database file inside `databaseDirectory`.
 *
 * @param paths - resolved managed storage paths.
 * @param identity - safe versioned identity string.
 * @returns absolute normalized database path.
 */
export declare function managedDatabasePath(paths: ManagedStoragePaths, identity: string): string;
/**
 * Validate an unknown object against the {@link ActiveMetadata} schema.
 *
 * Throws detailed TypeError if any required field is missing or invalid.
 */
export declare function validateActiveMetadata(raw: unknown): ActiveMetadata;
/**
 * Read and validate active dictionary metadata from `<home>/storages/dsh-word-lookup/active.json`.
 *
 * Fail-closed behavior:
 * - If `active.json` does not exist (ENOENT): returns `null`.
 * - If `active.json` is malformed JSON or fails schema validation: throws without modifying disk.
 *
 * @param paths - resolved managed storage paths.
 * @returns validated metadata object, or `null` if no active metadata exists.
 */
export declare function readActiveMetadata(paths: ManagedStoragePaths): Promise<ActiveMetadata | null>;
/**
 * Atomically write active dictionary metadata to `<home>/storages/dsh-word-lookup/active.json`.
 *
 * Sequence:
 * 1. Validate metadata schema before disk operations.
 * 2. Ensure storage directory exists.
 * 3. Write serialized JSON to a sibling temporary file (`active.json.tmp-<randomUUID>`).
 * 4. Atomically rename temporary file to `active.json` (atomic replacement on Windows and POSIX).
 * 5. On failure, best-effort cleanup of temporary file without corrupting existing `active.json`.
 *
 * @param paths - resolved managed storage paths.
 * @param metadata - valid active metadata descriptor.
 */
export declare function writeActiveMetadataAtomically(paths: ManagedStoragePaths, metadata: ActiveMetadata): Promise<void>;
/**
 * Clean up stale temporary artifacts in managed storage and cache directories.
 *
 * Cleans only recognized temporary files matching {@link STALE_TEMPORARY_ARTIFACT_PATTERN}:
 * - `active.json.tmp-*`
 * - `*.tmp-*`
 * - `*.part`
 *
 * Never modifies or deletes:
 * - `active.json`
 * - `*.sqlite3`
 * - Unknown user or system files.
 *
 * @param paths - resolved managed storage paths.
 * @returns summary of unlinked file paths.
 */
export declare function removeStaleTemporaryArtifacts(paths: ManagedStoragePaths): Promise<{
    removed: string[];
}>;
