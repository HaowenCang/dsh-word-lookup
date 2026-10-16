/**
 * Secure SQLite Snapshot Manager for custom user dictionaries.
 *
 * Implements Phase 7A.8.1A Tasks A, C, D, E:
 * - Deterministic Snapshot State Machine:
 *   CREATING -> CREATED_UNVERIFIED -> VERIFYING -> VERIFIED -> PUBLISHING -> PUBLISHED
 *   Failure states: REJECTED, CLEANUP_PENDING.
 * - Strict File Ownership Model:
 *   - USER_SOURCE_DATABASE: READ_ONLY, NEVER deleted, NEVER moved, NEVER renamed, NEVER truncated.
 *   - PLUGIN_STAGING_SNAPSHOT: PLUGIN_OWNED, unlinked on failure or rejection.
 *   - PLUGIN_PUBLISHED_SNAPSHOT: PLUGIN_OWNED, safely managed in customSnapshotDirectory.
 * - Anti-TOCTOU Protection: Staging file hash and identity verified before atomic publishing.
 * - Path traversal, symlink, and junction guards via `validateCustomSnapshotPath`.
 * - Integration with `SqliteDictionary` under source `'custom-local'`.
 *
 * @module dsh-word-lookup/host/custom-snapshot-manager
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  SAFE_IDENTITY_PATTERN,
  STAGING_SNAPSHOT_FILENAME_PATTERN,
  validateCustomSnapshotPath,
  type ManagedStoragePaths,
} from './managed-storage.js'
import {
  CustomDictionaryValidator,
  type CustomValidatorTaskOptions,
} from './custom-dictionary-validator.js'
import { openSqliteDictionary, type SqliteDictionary } from './sqlite-dictionary.js'
import { computeFileSha256 } from './custom-dictionary-worker.js'

/**
 * Valid states of the snapshot lifecycle state machine.
 */
export type SnapshotState =
  | 'CREATING'
  | 'CREATED_UNVERIFIED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'CLEANUP_PENDING'

/**
 * Immutable snapshot record tracking the complete lifecycle and provenance.
 */
export interface CustomSnapshotRecord {
  readonly id: string
  readonly sourcePath: string
  readonly stagingPath: string
  readonly publishedPath: string | null
  readonly state: SnapshotState
  readonly sha256: string | null
  readonly byteSize: number | null
  readonly schemaVersion: number | null
  readonly entryCount: number | null
  readonly formCount: number | null
  readonly exampleCount: number | null
  readonly headwordsSample: readonly string[]
  readonly createdAt: number
  readonly verifiedAt: number | null
  readonly publishedAt: number | null
  readonly error: string | null
  readonly errorCode: string | null
}

/** Options for creating and publishing a snapshot. */
export interface SnapshotPublishOptions extends CustomValidatorTaskOptions {
  /** Optional custom alphanumeric identity token (matching SAFE_IDENTITY_PATTERN). */
  readonly identity?: string
}

/** Options for constructing CustomSnapshotManager. */
export interface CustomSnapshotManagerOptions {
  readonly paths: ManagedStoragePaths
  readonly validator?: CustomDictionaryValidator
  readonly maxSizeBytes?: number
}

/** Error thrown when TOCTOU tampering or file modification is detected during publishing. */
export class SnapshotTamperingError extends Error {
  readonly code = 'SNAPSHOT_TAMPERING_DETECTED'

  constructor(message: string) {
    super(message)
    this.name = 'SnapshotTamperingError'
  }
}

/**
 * Manages the lifecycle, creation, verification, and storage of custom SQLite snapshots.
 */
export class CustomSnapshotManager {
  readonly #paths: ManagedStoragePaths
  readonly #validator: CustomDictionaryValidator
  readonly #maxSizeBytes: number
  readonly #snapshots = new Map<string, CustomSnapshotRecord>()

  #disposed = false

  constructor(options: CustomSnapshotManagerOptions) {
    if (!options?.paths) {
      throw new TypeError('CustomSnapshotManager requires valid ManagedStoragePaths')
    }
    this.#paths = options.paths
    this.#validator = options.validator ?? new CustomDictionaryValidator()
    this.#maxSizeBytes = options.maxSizeBytes ?? 2 * 1024 * 1024 * 1024 // 2 GiB
  }

  get isDisposed(): boolean {
    return this.#disposed
  }

  get paths(): ManagedStoragePaths {
    return this.#paths
  }

  /**
   * Retrieve a snapshot record by ID.
   */
  getSnapshot(id: string): CustomSnapshotRecord | undefined {
    return this.#snapshots.get(id)
  }

  /**
   * List all tracked snapshots.
   */
  listSnapshots(): readonly CustomSnapshotRecord[] {
    return Object.freeze([...this.#snapshots.values()])
  }

  /**
   * Create, verify, and publish a secure transaction-consistent snapshot from a user SQLite file.
   *
   * State transitions:
   * 1. CREATING: Staging path prepared; worker initiates `VACUUM INTO`.
   * 2. CREATED_UNVERIFIED: Snapshot created on staging; not yet verified.
   * 3. VERIFYING: Worker runs integrity check, schema validation, query plans, and probes.
   * 4. VERIFIED: Validation succeeded; file digest captured.
   * 5. PUBLISHING: Staging file hash reverified (anti-TOCTOU) and atomically renamed.
   * 6. PUBLISHED: Published custom snapshot ready for dictionary activation.
   *
   * If any step fails:
   * State transitions to REJECTED -> CLEANUP_PENDING -> staging file unlinked.
   * User source database is NEVER deleted, renamed, or modified.
   */
  async createAndPublishSnapshot(
    sourcePath: string,
    options?: SnapshotPublishOptions,
  ): Promise<CustomSnapshotRecord> {
    if (this.#disposed) {
      throw new Error('CustomSnapshotManager has been disposed')
    }

    // 1. Source Path Validation & Security Pre-flight
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
      throw new TypeError('Source database path must be a non-empty string')
    }
    const trimmedSource = sourcePath.trim()
    if (trimmedSource.includes('\0')) {
      throw new Error('Source database path contains null bytes')
    }
    if (!isAbsolute(trimmedSource)) {
      throw new Error(`Source database path "${trimmedSource}" must be an absolute path`)
    }

    const resolvedSource = resolve(trimmedSource)

    // Check existence and file type
    if (!existsSync(resolvedSource)) {
      throw new Error(`Source database file does not exist at "${resolvedSource}"`)
    }

    try {
      const lstat = lstatSync(resolvedSource)
      if (lstat.isSymbolicLink()) {
        throw new Error(`Source database path "${resolvedSource}" must not be a symbolic link`)
      }
      const st = statSync(resolvedSource)
      if (!st.isFile()) {
        throw new Error(`Source database path "${resolvedSource}" is not a regular file`)
      }
      if (st.size > this.#maxSizeBytes) {
        throw new Error(
          `Source database file size (${st.size} bytes) exceeds limit (${this.#maxSizeBytes} bytes)`,
        )
      }
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err))
    }

    // 2. Prepare Staging Directory & File
    await mkdir(this.#paths.customSnapshotDirectory, { recursive: true })

    const id = randomUUID()
    const stagingFileName = `staging-${id}.sqlite3`
    const stagingPath = join(this.#paths.customSnapshotDirectory, stagingFileName)

    // Ensure staging path conforms to containment and naming contract
    await validateCustomSnapshotPath(stagingPath, this.#paths.customSnapshotDirectory)

    let record: CustomSnapshotRecord = {
      id,
      sourcePath: resolvedSource,
      stagingPath,
      publishedPath: null,
      state: 'CREATING',
      sha256: null,
      byteSize: null,
      schemaVersion: null,
      entryCount: null,
      formCount: null,
      exampleCount: null,
      headwordsSample: Object.freeze([]),
      createdAt: Date.now(),
      verifiedAt: null,
      publishedAt: null,
      error: null,
      errorCode: null,
    }
    this.#snapshots.set(id, record)

    try {
      // Step A: Create Snapshot via Worker (VACUUM INTO)
      const createRes = await this.#validator.createSnapshot(resolvedSource, stagingPath, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        maxSizeBytes: this.#maxSizeBytes,
      })

      record = {
        ...record,
        state: 'CREATED_UNVERIFIED',
        sha256: createRes.sha256,
        byteSize: createRes.byteSize,
      }
      this.#snapshots.set(id, record)

      // Step B: Validate Snapshot via Worker
      record = { ...record, state: 'VERIFYING' }
      this.#snapshots.set(id, record)

      const validateRes = await this.#validator.validateSnapshot(stagingPath, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        maxSizeBytes: this.#maxSizeBytes,
      })

      record = {
        ...record,
        state: 'VERIFIED',
        schemaVersion: validateRes.schemaVersion,
        entryCount: validateRes.entryCount,
        formCount: validateRes.formCount,
        exampleCount: validateRes.exampleCount,
        headwordsSample: Object.freeze([...validateRes.headwordsSample]),
        sha256: validateRes.sha256,
        byteSize: validateRes.byteSize,
        verifiedAt: Date.now(),
      }
      this.#snapshots.set(id, record)

      // Step C: Publish Snapshot Atomically
      record = { ...record, state: 'PUBLISHING' }
      this.#snapshots.set(id, record)

      // Validate publish identity
      let identity = options?.identity?.trim()
      if (!identity) {
        identity = `snap-${id.replace(/-/g, '').slice(0, 16)}`
      }
      if (!SAFE_IDENTITY_PATTERN.test(identity)) {
        throw new Error(
          `Snapshot identity "${identity}" violates safe identity pattern (${SAFE_IDENTITY_PATTERN.source})`,
        )
      }

      const publishedFileName = `custom-${identity}.sqlite3`
      const publishedPath = join(this.#paths.customSnapshotDirectory, publishedFileName)
      await validateCustomSnapshotPath(publishedPath, this.#paths.customSnapshotDirectory)

      // Anti-TOCTOU & Anti-Tampering: Reverify staging file digest before rename
      const prePublishSha = computeFileSha256(stagingPath)
      const prePublishStat = statSync(stagingPath)
      if (prePublishSha !== record.sha256 || prePublishStat.size !== record.byteSize) {
        throw new SnapshotTamperingError(
          `Snapshot file was altered between verification and publishing (expected SHA-256 ${record.sha256}, got ${prePublishSha})`,
        )
      }

      // Atomic rename
      await rename(stagingPath, publishedPath)

      record = {
        ...record,
        state: 'PUBLISHED',
        publishedPath,
        publishedAt: Date.now(),
      }
      this.#snapshots.set(id, record)

      return record
    } catch (err: unknown) {
      const errCode = (err as { code?: string })?.code ?? 'SNAPSHOT_FAILED'
      const errMsg = err instanceof Error ? err.message : String(err)

      record = {
        ...record,
        state: 'REJECTED',
        error: errMsg,
        errorCode: errCode,
      }
      this.#snapshots.set(id, record)

      // Safe cleanup of temporary staging file (never user source file)
      record = { ...record, state: 'CLEANUP_PENDING' }
      this.#snapshots.set(id, record)

      try {
        if (existsSync(stagingPath)) {
          await unlink(stagingPath)
        }
      } catch {
        // Suppress secondary cleanup failure
      }

      throw err
    }
  }

  /**
   * Open an already-published snapshot as a queryable SqliteDictionary with source `'custom-local'`.
   */
  openSnapshotDictionary(snapshotId: string): SqliteDictionary {
    const record = this.#snapshots.get(snapshotId)
    if (!record) {
      throw new Error(`Snapshot "${snapshotId}" is not tracked by this manager`)
    }
    if (record.state !== 'PUBLISHED' || !record.publishedPath) {
      throw new Error(
        `Snapshot "${snapshotId}" is in state "${record.state}" and cannot be opened as a dictionary`,
      )
    }

    return openSqliteDictionary({
      path: record.publishedPath,
      readOnly: true,
      source: 'custom-local',
    })
  }

  /**
   * Safely delete a published custom snapshot.
   */
  async cleanupSnapshot(snapshotId: string): Promise<boolean> {
    const record = this.#snapshots.get(snapshotId)
    if (!record || !record.publishedPath) return false

    try {
      await validateCustomSnapshotPath(record.publishedPath, this.#paths.customSnapshotDirectory)
      if (existsSync(record.publishedPath)) {
        await unlink(record.publishedPath)
      }
      this.#snapshots.delete(snapshotId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Scan customSnapshotDirectory and safely remove any orphaned `staging-*.sqlite3` files.
   */
  async cleanupStagingFiles(): Promise<number> {
    let cleaned = 0
    if (!existsSync(this.#paths.customSnapshotDirectory)) return 0

    try {
      const entries = await readdir(this.#paths.customSnapshotDirectory)
      for (const entry of entries) {
        if (STAGING_SNAPSHOT_FILENAME_PATTERN.test(entry)) {
          const fullPath = join(this.#paths.customSnapshotDirectory, entry)
          try {
            await validateCustomSnapshotPath(fullPath, this.#paths.customSnapshotDirectory)
            await unlink(fullPath)
            cleaned++
          } catch {
            // Ignore individual file unlink errors
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }

    return cleaned
  }

  /**
   * Dispose manager and validator, and cleanup staging files.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#validator.dispose()
    await this.cleanupStagingFiles()
  }
}
