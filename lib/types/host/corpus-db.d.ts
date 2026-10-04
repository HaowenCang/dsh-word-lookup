/**
 * Production corpus database resolution and opening.
 *
 * Implements Phase 6 production corpus loading with strict guarantees:
 * - Deterministic path resolution: default is `<package root>/build/corpus/ecdict.db`.
 * - Optional environment override `DSH_WORD_LOOKUP_DB_PATH` for isolated profiles and testing.
 * - Always opened read-only at runtime (`readOnly: true`).
 * - Never mutates production files during runtime or tests.
 * - Never silently downloads or attempts network operations if the database is missing.
 * - Never falls back to fixture database or AI when production database is requested but missing/invalid.
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
export interface OpenProductionDictionaryOptions {
    /** Explicit absolute or relative database path (takes precedence). */
    readonly path?: string;
    /** Base URL used to resolve the package root (defaults to `import.meta.url`). */
    readonly fromUrl?: string;
}
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
 * Enforces read-only mode, schema validation, and fail-clean semantics without
 * silent fallback or automatic rebuilding.
 *
 * @param options - configuration options.
 * @returns open {@link SqliteDictionary}.
 * @throws {DictionaryUnavailableError} if the database is missing, corrupted, or incompatible.
 */
export declare function openProductionDictionary(options?: OpenProductionDictionaryOptions): SqliteDictionary;
