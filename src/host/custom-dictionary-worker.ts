/**
 * Isolated Worker implementation for custom SQLite snapshot creation and validation.
 *
 * Implements Phase 7A.8.1A Tasks A, B, C, D:
 * - Executes SQLite snapshot creation via `VACUUM INTO` on `{ readOnly: true }` source connection.
 * - Enforces SQLite security parameters: `PRAGMA trusted_schema = OFF`, `enableDefensive(true)`, `PRAGMA busy_timeout = 5000`.
 * - Validates schema contract: required tables (`meta`, `entries`, `forms`, `examples`), required columns, schema version.
 * - Validates query performance and index coverage via `EXPLAIN QUERY PLAN` (requires B-Tree SEARCH, forbids SCAN).
 * - Executes read-only query compatibility probes across headwords, forms, and examples.
 * - Employs fail-closed cleanup: unlinks partially created staging files on error.
 * - Guarantees SQLite connection closure before messaging and termination to ensure Windows handle release.
 *
 * @module dsh-word-lookup/host/custom-dictionary-worker
 */

import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION } from './fixture.js'
import { parseDictionarySchemaVersion } from './schema-version.js'

/** Request payload for snapshot creation. */
export interface CustomSnapshotCreateRequest {
  readonly action: 'CUSTOM_SNAPSHOT_CREATE'
  readonly requestId: string
  readonly sourcePath: string
  readonly stagingPath: string
  readonly maxSizeBytes?: number
}

/** Success response payload for snapshot creation. */
export interface CustomSnapshotCreateSuccessResponse {
  readonly action: 'CUSTOM_SNAPSHOT_CREATE'
  readonly requestId: string
  readonly success: true
  readonly sha256: string
  readonly byteSize: number
  readonly durationMs: number
}

/** Request payload for snapshot validation. */
export interface CustomSnapshotValidateRequest {
  readonly action: 'CUSTOM_SNAPSHOT_VALIDATE'
  readonly requestId: string
  readonly snapshotPath: string
  readonly maxSizeBytes?: number
}

/** Success response payload for snapshot validation. */
export interface CustomSnapshotValidateSuccessResponse {
  readonly action: 'CUSTOM_SNAPSHOT_VALIDATE'
  readonly requestId: string
  readonly success: true
  readonly schemaVersion: number
  readonly entryCount: number
  readonly formCount: number
  readonly exampleCount: number
  readonly headwordsSample: readonly string[]
  readonly sha256: string
  readonly byteSize: number
  readonly durationMs: number
}

/** Request payload for pre-publish integrity and digest verification. */
export interface CustomSnapshotPrePublishCheckRequest {
  readonly action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK'
  readonly requestId: string
  readonly stagingPath: string
  readonly expectedSha256: string
  readonly expectedByteSize: number
  readonly maxSizeBytes?: number
}

/** Success response payload for pre-publish check. */
export interface CustomSnapshotPrePublishCheckSuccessResponse {
  readonly action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK'
  readonly requestId: string
  readonly success: true
  readonly sha256: string
  readonly byteSize: number
  readonly matches: boolean
  readonly durationMs: number
}

/** Generic failure response payload for custom worker operations. */
export interface CustomWorkerFailureResponse {
  readonly action: 'CUSTOM_SNAPSHOT_CREATE' | 'CUSTOM_SNAPSHOT_VALIDATE' | 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK'
  readonly requestId: string
  readonly success: false
  readonly errorCode: string
  readonly message: string
  readonly durationMs?: number
}

export type CustomWorkerResponse =
  | CustomSnapshotCreateSuccessResponse
  | CustomSnapshotValidateSuccessResponse
  | CustomSnapshotPrePublishCheckSuccessResponse
  | CustomWorkerFailureResponse

/** Compute full SHA-256 digest of a file in 64 KB chunks to minimize RSS. */
export function computeFileSha256(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let bytesRead = 0
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Sanitize worker error messages to prevent leaking local paths or credentials. */
export function sanitizeWorkerError(raw: string): string {
  if (!raw || typeof raw !== 'string') return 'Unknown worker error'
  return raw
    .replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, '[local-path]')
    .replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, '[local-path]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 500)
}

/**
 * Determine if a query plan step requires scanning rather than indexed search on the target table.
 */
export function requiresTableScan(planText: string, table: string): boolean {
  const scanPattern = new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?${table}\\b`, 'i')
  const searchPattern = new RegExp(`\\bSEARCH\\s+(?:TABLE\\s+)?${table}\\b`, 'i')
  return scanPattern.test(planText) || !searchPattern.test(planText)
}

/**
 * Execute snapshot creation from sourcePath to stagingPath using VACUUM INTO.
 */
export function executeCustomSnapshotCreate(
  request: CustomSnapshotCreateRequest,
): CustomSnapshotCreateSuccessResponse | CustomWorkerFailureResponse {
  const startNs = process.hrtime.bigint()
  const { requestId, sourcePath, stagingPath } = request
  const maxSizeBytes = request.maxSizeBytes ?? 2 * 1024 * 1024 * 1024 // 2 GiB default bound

  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    return {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: 'Source database path must be a non-empty string',
      durationMs: 0,
    }
  }

  if (typeof stagingPath !== 'string' || stagingPath.trim().length === 0) {
    return {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: 'Staging snapshot path must be a non-empty string',
      durationMs: 0,
    }
  }

  // Pre-flight source existence and size check
  try {
    if (!existsSync(sourcePath)) {
      return {
        action: 'CUSTOM_SNAPSHOT_CREATE',
        requestId,
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        message: 'Source database file does not exist',
        durationMs: 0,
      }
    }

    const st = statSync(sourcePath)
    if (!st.isFile()) {
      return {
        action: 'CUSTOM_SNAPSHOT_CREATE',
        requestId,
        success: false,
        errorCode: 'NOT_A_FILE',
        message: 'Source database path is not a regular file',
        durationMs: 0,
      }
    }

    if (st.size > maxSizeBytes) {
      return {
        action: 'CUSTOM_SNAPSHOT_CREATE',
        requestId,
        success: false,
        errorCode: 'FILE_TOO_LARGE',
        message: `Source database file size (${st.size} bytes) exceeds maximum limit (${maxSizeBytes} bytes)`,
        durationMs: 0,
      }
    }
  } catch (err: unknown) {
    return {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
      durationMs: 0,
    }
  }

  let db: DatabaseSync | null = null
  try {
    // Open source strictly read-only
    db = new DatabaseSync(sourcePath, { readOnly: true })

    // Security Pragmas
    db.exec('PRAGMA trusted_schema = OFF;')
    try {
      ;(db as unknown as { enableDefensive?: (active: boolean) => void }).enableDefensive?.(true)
    } catch {
      // Ignore if defensive is not supported or already locked
    }
    try {
      db.exec('PRAGMA busy_timeout = 5000;')
    } catch {
      // Ignore
    }

    // SQLite VACUUM INTO requires non-existent destination
    if (existsSync(stagingPath)) {
      try {
        unlinkSync(stagingPath)
      } catch {
        // Continue and let VACUUM INTO report error if locked
      }
    }

    const escapedStagingPath = stagingPath.replace(/\\/g, '/').replace(/'/g, "''")
    db.exec(`VACUUM INTO '${escapedStagingPath}'`)

    // Release source connection immediately
    db.close()
    db = null

    if (!existsSync(stagingPath)) {
      return {
        action: 'CUSTOM_SNAPSHOT_CREATE',
        requestId,
        success: false,
        errorCode: 'SNAPSHOT_FAILED',
        message: 'VACUUM INTO completed without writing destination file',
      }
    }

    const snapStat = statSync(stagingPath)
    const sha256 = computeFileSha256(stagingPath)
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)

    return {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      success: true,
      sha256,
      byteSize: snapStat.size,
      durationMs,
    }
  } catch (err: unknown) {
    // Clean up partial staging file on failure
    try {
      if (existsSync(stagingPath)) unlinkSync(stagingPath)
    } catch {
      // Ignore secondary cleanup error
    }

    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)
    const rawMsg = err instanceof Error ? err.message : String(err)

    let errorCode = 'SNAPSHOT_FAILED'
    if (/file is not a database|unsupported file format|bad header|malformed/i.test(rawMsg)) {
      errorCode = 'INVALID_SQLITE_FILE'
    } else if (/attempt to write a readonly database/i.test(rawMsg)) {
      errorCode = 'SQLITE_READONLY_ERROR'
    } else if (/output file already exists/i.test(rawMsg)) {
      errorCode = 'FILE_EXISTS'
    }

    return {
      action: 'CUSTOM_SNAPSHOT_CREATE',
      requestId,
      success: false,
      errorCode,
      message: sanitizeWorkerError(rawMsg),
      durationMs,
    }
  } finally {
    if (db !== null) {
      try {
        db.close()
      } catch {
        // Suppress secondary close error
      }
    }
  }
}

/**
 * Execute comprehensive schema, integrity, query plan, and compatibility validation on a snapshot database.
 */
export function executeCustomSnapshotValidate(
  request: CustomSnapshotValidateRequest,
): CustomSnapshotValidateSuccessResponse | CustomWorkerFailureResponse {
  const startNs = process.hrtime.bigint()
  const { requestId, snapshotPath } = request
  const maxSizeBytes = request.maxSizeBytes ?? 2 * 1024 * 1024 * 1024

  if (typeof snapshotPath !== 'string' || snapshotPath.trim().length === 0) {
    return {
      action: 'CUSTOM_SNAPSHOT_VALIDATE',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: 'Snapshot database path must be a non-empty string',
      durationMs: 0,
    }
  }

  try {
    if (!existsSync(snapshotPath)) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        message: 'Snapshot file does not exist',
        durationMs: 0,
      }
    }

    const st = statSync(snapshotPath)
    if (!st.isFile()) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'NOT_A_FILE',
        message: 'Snapshot path is not a regular file',
        durationMs: 0,
      }
    }

    if (st.size > maxSizeBytes) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'FILE_TOO_LARGE',
        message: `Snapshot file size (${st.size} bytes) exceeds limit (${maxSizeBytes} bytes)`,
        durationMs: 0,
      }
    }
  } catch (err: unknown) {
    return {
      action: 'CUSTOM_SNAPSHOT_VALIDATE',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
      durationMs: 0,
    }
  }

  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(snapshotPath, { readOnly: true })

    // Security Pragmas
    db.exec('PRAGMA trusted_schema = OFF;')
    try {
      ;(db as unknown as { enableDefensive?: (active: boolean) => void }).enableDefensive?.(true)
    } catch {
      // Ignore if unsupported
    }
    try {
      db.exec('PRAGMA busy_timeout = 5000;')
    } catch {
      // Ignore
    }

    // 1. PRAGMA integrity_check
    const integrityRows = db.prepare('PRAGMA integrity_check(100)').all() as Array<Record<string, unknown>>
    if (integrityRows.length !== 1 || Object.values(integrityRows[0] ?? {})[0] !== 'ok') {
      const errorDetails = integrityRows.slice(0, 3).map((r) => String(Object.values(r)[0] ?? '')).join('; ')
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'INTEGRITY_CHECK_FAILED',
        message: `PRAGMA integrity_check failed: ${errorDetails || 'empty result'}`,
      }
    }

    // 2. Table presence check in sqlite_master
    const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    for (const table of ['meta', 'entries', 'forms', 'examples']) {
      const row = tableStmt.get(table)
      if (!row) {
        return {
          action: 'CUSTOM_SNAPSHOT_VALIDATE',
          requestId,
          success: false,
          errorCode: 'INVALID_DATABASE_SCHEMA',
          message: `Database is missing required table: "${table}"`,
        }
      }
    }

    // 3. Meta schema_version check
    const metaCols = (db.prepare("PRAGMA table_info('meta')").all() as Array<{ name: string }>).map((c) => c.name)
    if (!metaCols.includes('key') || !metaCols.includes('value')) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'INVALID_DATABASE_SCHEMA',
        message: 'Table "meta" is missing required columns "key" or "value"',
      }
    }

    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined
    let schemaVersion: number
    try {
      schemaVersion = parseDictionarySchemaVersion(metaRow?.value)
    } catch (error: unknown) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'INVALID_SCHEMA_VERSION',
        message: error instanceof Error ? error.message : 'Invalid schema_version',
      }
    }

    if (schemaVersion !== SCHEMA_VERSION) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'INVALID_SCHEMA_VERSION',
        message: `Database schema_version is ${metaRow?.value}, expected ${SCHEMA_VERSION}`,
      }
    }

    // 4. Columns check for entries, forms, examples
    const requiredEntriesCols = ['word', 'phonetic', 'definition_en', 'translation_zh', 'pos', 'exchange', 'frequency']
    const entriesCols = (db.prepare("PRAGMA table_info('entries')").all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of requiredEntriesCols) {
      if (!entriesCols.includes(col)) {
        return {
          action: 'CUSTOM_SNAPSHOT_VALIDATE',
          requestId,
          success: false,
          errorCode: 'INVALID_DATABASE_SCHEMA',
          message: `Table "entries" is missing required column: "${col}"`,
        }
      }
    }

    const requiredFormsCols = ['form', 'headword', 'kind']
    const formsCols = (db.prepare("PRAGMA table_info('forms')").all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of requiredFormsCols) {
      if (!formsCols.includes(col)) {
        return {
          action: 'CUSTOM_SNAPSHOT_VALIDATE',
          requestId,
          success: false,
          errorCode: 'INVALID_DATABASE_SCHEMA',
          message: `Table "forms" is missing required column: "${col}"`,
        }
      }
    }

    const requiredExamplesCols = ['id', 'headword', 'english', 'chinese', 'source', 'source_id', 'score']
    const examplesCols = (db.prepare("PRAGMA table_info('examples')").all() as Array<{ name: string }>).map((c) => c.name)
    for (const col of requiredExamplesCols) {
      if (!examplesCols.includes(col)) {
        return {
          action: 'CUSTOM_SNAPSHOT_VALIDATE',
          requestId,
          success: false,
          errorCode: 'INVALID_DATABASE_SCHEMA',
          message: `Table "examples" is missing required column: "${col}"`,
        }
      }
    }

    // 5. Index & Query Plan verification (EXPLAIN QUERY PLAN)
    // Query 1: exact entry lookup
    const qp1 = db.prepare('EXPLAIN QUERY PLAN SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?').all() as Array<{ detail: string }>
    const plan1 = qp1.map((p) => p.detail).join('; ')
    if (requiresTableScan(plan1, 'entries')) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'MISSING_REQUIRED_INDEX',
        message: `Missing required index on entries(word); query plan requires table scan (${plan1})`,
      }
    }

    // Query 2: headword by form
    const qp2 = db.prepare('EXPLAIN QUERY PLAN SELECT headword FROM forms WHERE form = ?').all() as Array<{ detail: string }>
    const plan2 = qp2.map((p) => p.detail).join('; ')
    if (requiresTableScan(plan2, 'forms')) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'MISSING_REQUIRED_INDEX',
        message: `Missing required index on forms(form); query plan requires table scan (${plan2})`,
      }
    }

    // Query 3: forms by headword
    const qp3 = db.prepare('EXPLAIN QUERY PLAN SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE').all() as Array<{ detail: string }>
    const plan3 = qp3.map((p) => p.detail).join('; ')
    if (requiresTableScan(plan3, 'forms')) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'MISSING_REQUIRED_INDEX',
        message: `Missing required index on forms(headword); query plan requires table scan (${plan3})`,
      }
    }

    // Query 4: examples by headword
    const qp4 = db.prepare('EXPLAIN QUERY PLAN SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC').all() as Array<{ detail: string }>
    const plan4 = qp4.map((p) => p.detail).join('; ')
    if (requiresTableScan(plan4, 'examples')) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'MISSING_REQUIRED_INDEX',
        message: `Missing required index on examples(headword); query plan requires table scan (${plan4})`,
      }
    }

    // 6. Query compatibility probes & sampling
    const entryCountRow = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number } | undefined
    const formCountRow = db.prepare('SELECT COUNT(*) as c FROM forms').get() as { c: number } | undefined
    const exampleCountRow = db.prepare('SELECT COUNT(*) as c FROM examples').get() as { c: number } | undefined

    const entryCount = entryCountRow?.c ?? 0
    const formCount = formCountRow?.c ?? 0
    const exampleCount = exampleCountRow?.c ?? 0

    // Probe miss queries
    const missEntry = db.prepare('SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?').get('__nonexistent_probe_token__')
    if (missEntry !== undefined) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'QUERY_COMPATIBILITY_FAILED',
        message: 'Non-existent word query returned non-empty row',
      }
    }

    const missForm = db.prepare('SELECT headword FROM forms WHERE form = ?').get('__nonexistent_probe_token__')
    if (missForm !== undefined) {
      return {
        action: 'CUSTOM_SNAPSHOT_VALIDATE',
        requestId,
        success: false,
        errorCode: 'QUERY_COMPATIBILITY_FAILED',
        message: 'Non-existent form query returned non-empty row',
      }
    }

    // Sample headwords and verify queries
    let headwordsSample: string[] = []
    if (entryCount > 0) {
      const sampleRows = db.prepare('SELECT word FROM entries LIMIT 5').all() as Array<{ word: unknown }>
      headwordsSample = sampleRows.map((r) => (typeof r.word === 'string' ? r.word : String(r.word)))

      for (const word of headwordsSample) {
        const row = db.prepare('SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?').get(word) as Record<string, unknown> | undefined
        if (!row) {
          return {
            action: 'CUSTOM_SNAPSHOT_VALIDATE',
            requestId,
            success: false,
            errorCode: 'QUERY_COMPATIBILITY_FAILED',
            message: `Probe failed to query sampled headword "${word}"`,
          }
        }

        const forms = db.prepare('SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE').all(word) as Array<Record<string, unknown>>
        for (const f of forms) {
          if (typeof f.form !== 'string') {
            return {
              action: 'CUSTOM_SNAPSHOT_VALIDATE',
              requestId,
              success: false,
              errorCode: 'QUERY_COMPATIBILITY_FAILED',
              message: `Form row for headword "${word}" contains non-string form`,
            }
          }
        }

        const examples = db.prepare('SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC').all(word) as Array<Record<string, unknown>>
        for (const ex of examples) {
          if (typeof ex.english !== 'string') {
            return {
              action: 'CUSTOM_SNAPSHOT_VALIDATE',
              requestId,
              success: false,
              errorCode: 'QUERY_COMPATIBILITY_FAILED',
              message: `Example row for headword "${word}" contains non-string english field`,
            }
          }
        }
      }
    }

    // Close SQLite connection before hashing to ensure handle release
    db.close()
    db = null

    const stat = statSync(snapshotPath)
    const sha256 = computeFileSha256(snapshotPath)
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)

    return {
      action: 'CUSTOM_SNAPSHOT_VALIDATE',
      requestId,
      success: true,
      schemaVersion,
      entryCount,
      formCount,
      exampleCount,
      headwordsSample,
      sha256,
      byteSize: stat.size,
      durationMs,
    }
  } catch (err: unknown) {
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)
    const rawMsg = err instanceof Error ? err.message : String(err)

    let errorCode = 'VALIDATION_FAILED'
    if (/file is not a database|unsupported file format|bad header|malformed/i.test(rawMsg)) {
      errorCode = 'INVALID_SQLITE_FILE'
    }

    return {
      action: 'CUSTOM_SNAPSHOT_VALIDATE',
      requestId,
      success: false,
      errorCode,
      message: sanitizeWorkerError(rawMsg),
      durationMs,
    }
  } finally {
    if (db !== null) {
      try {
        db.close()
      } catch {
        // Suppress secondary close error
      }
    }
  }
}

/**
 * Execute pre-publish hash and size verification in the isolated worker thread.
 */
export function executeCustomSnapshotPrePublishCheck(
  request: CustomSnapshotPrePublishCheckRequest,
): CustomSnapshotPrePublishCheckSuccessResponse | CustomWorkerFailureResponse {
  const startNs = process.hrtime.bigint()
  const { requestId, stagingPath, expectedSha256, expectedByteSize } = request
  const maxSizeBytes = request.maxSizeBytes ?? 2 * 1024 * 1024 * 1024

  if (typeof stagingPath !== 'string' || stagingPath.trim().length === 0) {
    return {
      action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
      requestId,
      success: false,
      errorCode: 'INVALID_PATH',
      message: 'Staging snapshot path must be a non-empty string',
      durationMs: 0,
    }
  }

  try {
    if (!existsSync(stagingPath)) {
      return {
        action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
        requestId,
        success: false,
        errorCode: 'FILE_NOT_FOUND',
        message: 'Staging file does not exist for pre-publish check',
        durationMs: 0,
      }
    }

    const st = statSync(stagingPath)
    if (!st.isFile()) {
      return {
        action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
        requestId,
        success: false,
        errorCode: 'NOT_A_FILE',
        message: 'Staging path is not a regular file',
        durationMs: 0,
      }
    }

    if (st.size > maxSizeBytes) {
      return {
        action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
        requestId,
        success: false,
        errorCode: 'FILE_TOO_LARGE',
        message: `Staging snapshot file size (${st.size} bytes) exceeds limit (${maxSizeBytes} bytes)`,
        durationMs: 0,
      }
    }

    const sha256 = computeFileSha256(stagingPath)
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)

    if (sha256 !== expectedSha256 || st.size !== expectedByteSize) {
      return {
        action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
        requestId,
        success: false,
        errorCode: 'SNAPSHOT_TAMPERING_DETECTED',
        message: `Snapshot file was altered between verification and publishing (expected SHA-256 ${expectedSha256}, got ${sha256}; expected size ${expectedByteSize}, got ${st.size})`,
        durationMs,
      }
    }

    return {
      action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
      requestId,
      success: true,
      sha256,
      byteSize: st.size,
      matches: true,
      durationMs,
    }
  } catch (err: unknown) {
    const endNs = process.hrtime.bigint()
    const durationMs = Math.round(Number(endNs - startNs) / 1e6)
    return {
      action: 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK',
      requestId,
      success: false,
      errorCode: 'VERIFICATION_FAILED',
      message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
      durationMs,
    }
  }
}
