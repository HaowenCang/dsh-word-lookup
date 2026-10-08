/**
 * Runtime streaming ECDICT corpus importer for DeepSeek Harness (DSH).
 *
 * Implements Phase 7A.5 runtime-safe streaming import lifecycle:
 * - Fail-closed cached source preflight verification before any database mutation.
 * - Same-process concurrency gating via {@link EcdictImportInProgressError}.
 * - Unique versioned managed candidate database creation (`ecdict-<identity>.sqlite3.tmp-<uuid>`).
 * - Streaming RFC 4180 CSV parsing with fatal UTF-8 decoding (no whole-file buffering).
 * - TOCTOU stream verification: streaming SHA-256 and byte count computed on raw consumed chunks.
 * - Morphological inflection extraction via {@link ExchangeCollector} with deterministic resolution.
 * - Bounded row batching and cooperative event-loop yielding to guarantee host responsiveness.
 * - Streaming row-by-row logical database SHA-256 computation via `StatementSync.iterate()`.
 * - Full PRAGMA integrity verification, read-only product opening, and canonical probe validation.
 * - Explicit candidate file sync (`FileHandle.sync()`) before atomic same-directory publication.
 * - Cancellation support via standard `AbortSignal` with clean candidate and sidecar cleanup.
 * - Isolated progress callback seam shielding caller exceptions.
 *
 * Invariants:
 * - Zero network access: this importer operates strictly on local verified cached source artifacts.
 * - Does NOT write `active.json` or activate the database in `DictionaryManager`.
 * - Host startup remains fixture-only.
 * - Zero external runtime dependencies (Node.js 24 `crypto`, `fs`, `path`, `sqlite`).
 *
 * @module dsh-word-lookup/host/ecdict-importer
 */
import { DatabaseSync } from 'node:sqlite';
import { type IntegrityVerificationResult } from './ecdict-integrity-verifier.js';
import { type EcdictSourceDescriptor } from './ecdict-source.js';
import { type ManagedStoragePaths } from './managed-storage.js';
import type { SqliteDictionary } from './sqlite-dictionary.js';
/** Maximum permitted length of a headword. */
export declare const MAX_WORD_LENGTH = 128;
/** Maximum permitted length of any individual CSV field. */
export declare const MAX_FIELD_LENGTH = 65536;
/** Default transaction commit batch size for bulk insertion. */
export declare const DEFAULT_BATCH_SIZE = 2500;
/** Default interval of processed rows between cooperative event loop yields. */
export declare const DEFAULT_YIELD_ROW_INTERVAL = 2500;
/** Authoritative 13-column ECDICT CSV header schema in exact order. */
export declare const EXPECTED_CORPUS_HEADER: readonly string[];
/** Authoritative probe words required to be found in verified candidate databases. */
export declare const REQUIRED_PROBE_WORDS: readonly string[];
/** Canonical morphological mappings verified via headword form relationships. */
export declare const CANONICAL_FORM_RELATIONSHIPS: readonly {
    headword: string;
    expectedForms: string[];
}[];
/**
 * Error thrown when an ECDICT import is already in progress for the target database directory.
 */
export declare class EcdictImportInProgressError extends Error {
    /** Database directory for which import is locked. */
    readonly databaseDirectory: string;
    constructor(databaseDirectory: string);
}
/**
 * Progress lifecycle phases during database construction.
 */
export type EcdictImportProgressPhase = 'verifying-source' | 'preflighting' | 'importing-entries' | 'resolving-forms' | 'inserting-forms' | 'indexing' | 'validating' | 'publishing' | 'complete';
/**
 * Immutable progress event emitted to observers during import.
 */
export interface EcdictImportProgress {
    /** Current operation phase. */
    readonly phase: EcdictImportProgressPhase;
    /** Number of entries/items processed in this phase, if applicable. */
    readonly processed?: number;
    /** Total number of entries/items expected in this phase, if applicable. */
    readonly total?: number;
    /** Number of source raw bytes processed so far. */
    readonly sourceBytesProcessed?: number;
    /** Expected total source byte size. */
    readonly sourceBytesTotal?: number;
}
/**
 * Callback function type for import progress updates.
 */
export type EcdictImportProgressCallback = (progress: EcdictImportProgress) => void;
/**
 * Outcome of post-publication candidate file and sidecar cleanup.
 */
export interface PostPublicationCleanupResult {
    /** Whether own candidate database file was confirmed unlinked and absent from disk. */
    readonly candidateRemoved: boolean;
    /** Whether all candidate sidecars were confirmed absent or unlinked from disk. */
    readonly sidecarsRemoved: boolean;
    /** System error code if unlinking failed (e.g. `EPERM`, `EACCES`, `EBUSY`). */
    readonly errorCode?: string;
}
/**
 * Immutable build outcome descriptor returned upon successful managed database publication.
 */
export interface ManagedEcdictBuildResult {
    /** Safe identity token matching database filename. */
    readonly identity: string;
    /** Normalized absolute path to the published SQLite database file. */
    readonly path: string;
    /** Basename only of the database file (`ecdict-<identity>.sqlite3`). */
    readonly databaseFile: string;
    /** Authoritative Git commit hash of the imported source. */
    readonly sourceCommit: string;
    /** Verified SHA-256 digest of the raw source bytes consumed by the parser. */
    readonly sourceSha256: string;
    /** Database schema version. */
    readonly schemaVersion: number;
    /** Count of valid headword entries imported into `entries` table. */
    readonly entryCount: number;
    /** Count of unambiguous morphological forms imported into `forms` table. */
    readonly formCount: number;
    /** Count of examples imported into `examples` table (0 for ECDICT). */
    readonly exampleCount: number;
    /** Count of excluded ambiguous morphological forms colliding across headwords. */
    readonly ambiguousFormCount: number;
    /** Count of rejected rows during CSV parsing. */
    readonly rejectedRowCount: number;
    /** Count of all source CSV rows processed (valid + rejected). */
    readonly sourceRowCount: number;
    /** Logical database SHA-256 digest computed across ordered tables. */
    readonly logicalSha256: string;
    /** Physical SQLite file SHA-256 digest. */
    readonly fileSha256: string;
    /** Physical SQLite database byte size on disk. */
    readonly byteSize: number;
    /** Number of cooperative event-loop yields executed during the build. */
    readonly yieldCount: number;
    /** Duration in milliseconds of synchronous PRAGMA integrity_check verification. */
    readonly integrityCheckDurationMs?: number;
    /** Detailed timing breakdown per build phase in milliseconds. */
    readonly phaseTimings?: Readonly<Record<string, number>>;
    /** Post-publication candidate temporary file and sidecars cleanup outcome. */
    readonly postPublicationCleanup: PostPublicationCleanupResult;
}
/**
 * Options for production {@link buildManagedEcdictDatabase}.
 */
export interface BuildManagedEcdictDatabaseOptions {
    /** Cancellation signal. */
    readonly signal?: AbortSignal;
    /** Optional observer callback for import progress. */
    readonly onProgress?: EcdictImportProgressCallback;
}
/**
 * @internal Test-only options for internal importer core.
 * Strictly forbidden from package root exports (`src/index.ts`).
 */
export interface BuildManagedEcdictDatabaseInternalOptions {
    /** Cancellation signal. */
    readonly signal?: AbortSignal;
    /** Optional observer callback for import progress. */
    readonly onProgress?: EcdictImportProgressCallback;
    /** @internal Custom source path override (test only). */
    readonly sourcePath?: string;
    /** @internal Custom source descriptor override (test only). */
    readonly descriptor?: EcdictSourceDescriptor;
    /** @internal Custom batch size (test only). */
    readonly batchSize?: number;
    /** @internal Custom yield row interval (test only). */
    readonly yieldInterval?: number;
    /** @internal Custom nonce generator for identity (test only). */
    readonly generateNonce?: () => string;
    /** @internal Custom candidate ID generator (test only). */
    readonly generateCandidateId?: () => string;
    /** @internal Whether to execute standard probe lookups (defaults to true; set false for synthetic small tests). */
    readonly verifyProbes?: boolean;
    /** @internal Custom SQLite factory hook (test only). */
    readonly sqliteFactory?: (path: string) => DatabaseSync;
    /** @internal Custom yield function hook (test only). */
    readonly yieldFn?: () => Promise<void>;
    /** @internal Custom candidate unlink hook for cleanup error testing (test only). */
    readonly unlinkFn?: (path: string) => Promise<void>;
    /** @internal Custom integrity verifier hook (test only). */
    readonly integrityVerifier?: (candidatePath: string, signal?: AbortSignal) => Promise<IntegrityVerificationResult>;
    /** @internal Custom worker URL for fault-injection testing (test only). */
    readonly workerUrl?: URL;
}
/**
 * Generate a deterministic versioned safe managed database identity string.
 *
 * Format: `s<schemaVersion>-<commitPrefix12>-<shaPrefix12>-<nonce12>`
 * Matches {@link SAFE_IDENTITY_PATTERN}.
 */
export declare function generateManagedDatabaseIdentity(schemaVersion: number, sourceCommit: string, sourceSha256: string, nonce?: string): string;
/**
 * Execute standard validation probes against an opened SQLite dictionary candidate.
 *
 * Verifies exact headwords, case-insensitivity, inflected forms, and unknown word misses.
 *
 * @param dictionary - opened {@link SqliteDictionary}.
 */
export declare function verifyCandidateProbes(dictionary: SqliteDictionary): void;
/**
 * Build a verified, versioned managed ECDICT SQLite database from the cached source artifact.
 *
 * Production entrypoint:
 * - Automatically loads authoritative pinned `corpus/ecdict.manifest.json`.
 * - Resolves cached source artifact `<home>/cache/dsh-word-lookup/sources/ecdict.csv`.
 * - Strictly verifies source preflight and actual import-pass TOCTOU digests.
 * - Compiles entries, forms, and indexes in managed candidate database.
 * - Validates schema, metadata, PRAGMA integrity, and read-only dictionary probes.
 * - Atomically publishes immutable `ecdict-<identity>.sqlite3` database artifact.
 * - Does NOT mutate `active.json` or activate the database in `DictionaryManager`.
 *
 * @param paths - resolved managed storage paths.
 * @param options - optional cancellation signal and progress observer.
 * @returns frozen {@link ManagedEcdictBuildResult}.
 */
export declare function buildManagedEcdictDatabase(paths: ManagedStoragePaths, options?: BuildManagedEcdictDatabaseOptions): Promise<ManagedEcdictBuildResult>;
/**
 * @internal Test-only internal importer core allowing descriptors and test seams.
 * Strictly forbidden from package root exports (`src/index.ts`).
 */
export declare function buildManagedEcdictDatabaseInternal(paths: ManagedStoragePaths, options?: BuildManagedEcdictDatabaseInternalOptions): Promise<ManagedEcdictBuildResult>;
