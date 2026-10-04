/**
 * Production corpus database resolution, metadata validation, and opening.
 *
 * Implements Phase 6.1 production corpus loading with strict guarantees:
 * - Deterministic path resolution via explicit `options.path` or `DSH_WORD_LOOKUP_DB_PATH`.
 * - Validates production metadata against package-owned `corpus/ecdict.manifest.json`:
 *   - `schema_version` matches pinned schema version.
 *   - `corpus_name` === 'ECDICT'.
 *   - `upstream_commit` matches manifest.sourceCommit.
 *   - `source_sha256` matches manifest.sourceSha256.
 *   - Required tables (`meta`, `entries`, `forms`, `examples`) and indexes exist.
 * - Always opened read-only at runtime (`readOnly: true`).
 * - Never mutates production files during runtime or tests.
 * - Never silently downloads or attempts network operations if the database is missing.
 * - Never falls back to fixture database or AI when production database is requested but missing/invalid.
 * - Reports dictionary provenance as `'ecdict-local'`.
 * - Throws a clean {@link DictionaryUnavailableError} on failure.
 *
 * @module dsh-word-lookup/host/corpus-db
 */
import { type SqliteDictionary } from './sqlite-dictionary.js';
/** Default relative directory holding the built production corpus database. */
export declare const CORPUS_DIRECTORY: string;
/** Default file name of the production corpus database. */
export declare const CORPUS_FILE_NAME = "ecdict.db";
/** Environment variable name allowing path override in isolated test environments. */
export declare const CORPUS_PATH_ENV = "DSH_WORD_LOOKUP_DB_PATH";
/** Relative path to the package-owned manifest. */
export declare const MANIFEST_RELATIVE_PATH: string;
export interface CorpusManifestData {
    readonly sourceName: string;
    readonly sourceCommit: string;
    readonly sourceSha256: string;
    readonly schemaVersion: number;
}
export interface OpenProductionDictionaryOptions {
    /** Explicit absolute or relative database path (takes precedence). */
    readonly path?: string;
    /** Explicit manifest data override (used in isolated tests). */
    readonly manifest?: CorpusManifestData;
    /** Base URL used to resolve the package root (defaults to `import.meta.url`). */
    readonly fromUrl?: string;
}
/**
 * Load the package-owned corpus manifest for runtime production metadata validation.
 *
 * @param fromUrl - base URL used to resolve the package root.
 * @returns parsed {@link CorpusManifestData}.
 */
export declare function loadRuntimeCorpusManifest(fromUrl?: string): CorpusManifestData;
/**
 * Resolve the absolute path to the production corpus SQLite database.
 *
 * Precedence:
 * 1. Explicit `options.path`
 * 2. Process environment variable `DSH_WORD_LOOKUP_DB_PATH`
 * 3. Default `<package root>/build/corpus/ecdict.db`
 *
 * @param options - path resolution options.
 * @returns absolute resolved path.
 */
export declare function resolveProductionDatabasePath(options?: OpenProductionDictionaryOptions): string;
/**
 * Open the production corpus SQLite dictionary.
 *
 * Enforces read-only mode, strict metadata validation against pinned manifest,
 * and fail-clean semantics without silent fallback or automatic rebuilding.
 *
 * @param options - configuration options.
 * @returns open {@link SqliteDictionary} with provenance `'ecdict-local'`.
 * @throws {DictionaryUnavailableError} if the database is missing, corrupted, or incompatible.
 */
export declare function openProductionDictionary(options?: OpenProductionDictionaryOptions): SqliteDictionary;
