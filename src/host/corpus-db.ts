/**
 * Production corpus database resolution, metadata validation, and opening.
 *
 * Implements production corpus loading and validation with strict guarantees:
 * - Deterministic path resolution via explicit `options.path` or default package corpus path.
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

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DictionaryUnavailableError } from './dictionary.js'
import { findPackageRoot } from './fixture-db.js'
import { openSqliteDictionary, type SqliteDictionary } from './sqlite-dictionary.js'

/** Default relative directory holding the built production corpus database. */
export const CORPUS_DIRECTORY = join('build', 'corpus')

/** Default file name of the production corpus database. */
export const CORPUS_FILE_NAME = 'ecdict.db'

/** Relative path to the package-owned manifest. */
export const MANIFEST_RELATIVE_PATH = join('corpus', 'ecdict.manifest.json')

export interface CorpusManifestData {
  readonly sourceName: string
  readonly sourceCommit: string
  readonly sourceSha256: string
  readonly schemaVersion: number
}

export interface OpenProductionDictionaryOptions {
  /** Explicit absolute or relative database path (takes precedence). */
  readonly path?: string
  /** Explicit manifest data override (used in isolated tests). */
  readonly manifest?: CorpusManifestData
  /** Base URL used to resolve the package root (defaults to `import.meta.url`). */
  readonly fromUrl?: string
}

/**
 * Load the package-owned corpus manifest for runtime production metadata validation.
 *
 * @param fromUrl - base URL used to resolve the package root.
 * @returns parsed {@link CorpusManifestData}.
 */
export function loadRuntimeCorpusManifest(fromUrl?: string): CorpusManifestData {
  const root = findPackageRoot(fromUrl ?? import.meta.url)
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH)

  if (!existsSync(manifestPath)) {
    throw new DictionaryUnavailableError(`corpus manifest not found at "${manifestPath}"`)
  }

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return {
      sourceName: String(raw.sourceName ?? ''),
      sourceCommit: raw.sourceCommit,
      sourceSha256: raw.sourceSha256,
      schemaVersion: Number(raw.schemaVersion),
    }
  } catch (err) {
    throw new DictionaryUnavailableError(
      `failed to read corpus manifest at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Resolve the absolute path to the production corpus SQLite database.
 *
 * Precedence:
 * 1. Explicit `options.path`
 * 2. Default `<package root>/build/corpus/ecdict.db`
 *
 * @param options - path resolution options.
 * @returns absolute resolved path.
 */
export function resolveProductionDatabasePath(options: OpenProductionDictionaryOptions = {}): string {
  if (options.path) {
    return options.path
  }

  const root = findPackageRoot(options.fromUrl ?? import.meta.url)
  return join(root, CORPUS_DIRECTORY, CORPUS_FILE_NAME)
}

/**
 * Validate that an opened SQLite database matches the pinned production corpus metadata and schema.
 *
 * @param db - open DatabaseSync connection.
 * @param expectedManifest - expected manifest metadata.
 * @param dbPath - path to database for error reporting.
 */
function validateProductionMetadata(
  db: DatabaseSync,
  expectedManifest: CorpusManifestData,
  dbPath: string,
): void {
  // 1. Verify required tables exist
  const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
  for (const table of ['meta', 'entries', 'forms', 'examples']) {
    if (!tableStmt.get(table)) {
      throw new DictionaryUnavailableError(
        `production corpus database at "${dbPath}" is missing required table "${table}"`,
      )
    }
  }

  // 2. Verify table schema and primary key semantics required by SqliteDictionary
  const requiredTableSchemas: Record<string, { pk: string; columns: string[] }> = {
    meta: { pk: 'key', columns: ['key', 'value'] },
    entries: {
      pk: 'word',
      columns: ['word', 'phonetic', 'definition_en', 'translation_zh', 'pos', 'exchange', 'frequency'],
    },
    forms: { pk: 'form', columns: ['form', 'headword', 'kind'] },
    examples: {
      pk: 'id',
      columns: ['id', 'headword', 'english', 'chinese', 'source', 'source_id', 'score'],
    },
  }

  for (const [table, spec] of Object.entries(requiredTableSchemas)) {
    interface ColInfo {
      cid: number
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
    }
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as ColInfo[]
    const colNames = new Set(cols.map((c) => c.name))
    for (const col of spec.columns) {
      if (!colNames.has(col)) {
        throw new DictionaryUnavailableError(
          `production corpus database at "${dbPath}" table "${table}" is missing required column "${col}"`,
        )
      }
    }
    const pkCol = cols.find((c) => c.name === spec.pk)
    if (!pkCol || pkCol.pk <= 0) {
      throw new DictionaryUnavailableError(
        `production corpus database at "${dbPath}" table "${table}" column "${spec.pk}" must be primary key`,
      )
    }
  }

  // 3. Read meta table
  const metaStmt = db.prepare('SELECT key, value FROM meta')
  const meta = new Map<string, string>()
  try {
    const rows = metaStmt.all() as Array<{ key: string; value: string }>
    for (const r of rows) {
      meta.set(r.key, r.value)
    }
  } catch (err) {
    throw new DictionaryUnavailableError(
      `cannot read meta table in production corpus database at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 4. Validate metadata contract
  const schemaVersion = Number(meta.get('schema_version'))
  if (schemaVersion !== expectedManifest.schemaVersion) {
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" has schema_version ${schemaVersion}, expected ${expectedManifest.schemaVersion}`,
    )
  }

  const corpusName = meta.get('corpus_name')
  if (corpusName !== expectedManifest.sourceName) {
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" has corpus_name "${corpusName}", expected "${expectedManifest.sourceName}"`,
    )
  }

  const upstreamCommit = meta.get('upstream_commit')
  if (upstreamCommit !== expectedManifest.sourceCommit) {
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" has upstream_commit "${upstreamCommit}", expected "${expectedManifest.sourceCommit}"`,
    )
  }

  const sourceSha256 = meta.get('source_sha256')
  if (sourceSha256 !== expectedManifest.sourceSha256) {
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" has source_sha256 "${sourceSha256}", expected "${expectedManifest.sourceSha256}"`,
    )
  }

  for (const countKey of ['entry_count', 'form_count', 'example_count']) {
    const val = meta.get(countKey)
    if (val === undefined || !/^\d+$/.test(val)) {
      throw new DictionaryUnavailableError(
        `production corpus database at "${dbPath}" has invalid or missing metadata count "${countKey}": ${val}`,
      )
    }
  }

  const logicalSha256 = meta.get('logical_sha256')
  if (!logicalSha256 || typeof logicalSha256 !== 'string' || logicalSha256.length !== 64) {
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" has invalid or missing metadata logical_sha256: ${logicalSha256}`,
    )
  }

  // 5. Verify required indexes exist
  // idx_forms_headword_raw is the raw binary headword index required by the actual product lookup:
  // "SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE"
  // idx_examples_headword is required by "SELECT ... FROM examples WHERE headword = ?"
  const indexStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
  for (const index of ['idx_forms_headword_raw', 'idx_examples_headword']) {
    if (!indexStmt.get(index)) {
      throw new DictionaryUnavailableError(
        `production corpus database at "${dbPath}" is missing required index "${index}"`,
      )
    }
  }
}

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
export function openProductionDictionary(options: OpenProductionDictionaryOptions = {}): SqliteDictionary {
  const dbPath = resolveProductionDatabasePath(options)

  if (!existsSync(dbPath)) {
    throw new DictionaryUnavailableError(
      `production corpus database not found at "${dbPath}"; run "npm run corpus:build" first (silent download / fallback is prohibited)`,
    )
  }

  try {
    const stats = statSync(dbPath)
    if (!stats.isFile() || stats.size === 0) {
      throw new DictionaryUnavailableError(
        `production corpus database at "${dbPath}" is empty or invalid`,
      )
    }
  } catch (err) {
    if (err instanceof DictionaryUnavailableError) throw err
    throw new DictionaryUnavailableError(
      `cannot access production corpus database at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const manifest = options.manifest ?? loadRuntimeCorpusManifest(options.fromUrl)

  // Verify SQLite database and production metadata
  let rawDb: DatabaseSync | undefined
  try {
    rawDb = new DatabaseSync(dbPath, { readOnly: true })
    validateProductionMetadata(rawDb, manifest, dbPath)
  } catch (err) {
    try {
      rawDb?.close()
    } catch {
      // ignore
    }
    if (err instanceof DictionaryUnavailableError) throw err
    throw new DictionaryUnavailableError(
      `production corpus database at "${dbPath}" is invalid: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    try {
      rawDb?.close()
    } catch {
      // ignore
    }
  }

  return openSqliteDictionary({
    path: dbPath,
    readOnly: true,
    source: 'ecdict-local',
  })
}
