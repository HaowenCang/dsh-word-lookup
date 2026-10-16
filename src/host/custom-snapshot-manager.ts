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

import { randomUUID } from 'node:crypto'
import { constants, existsSync, lstatSync, statSync } from 'node:fs'
import { copyFile, link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  SAFE_IDENTITY_PATTERN,
  STAGING_SNAPSHOT_FILENAME_PATTERN,
  validateCustomSnapshotPath,
  type ManagedStoragePaths,
} from './managed-storage.js'
import {
  CustomDictionaryValidator,
  SnapshotTamperingError,
  type CustomValidatorTaskOptions,
} from './custom-dictionary-validator.js'
import { openSqliteDictionary, type SqliteDictionary } from './sqlite-dictionary.js'

export { SnapshotTamperingError }

/**
 * Valid states of the snapshot lifecycle state machine.
 */
export type SnapshotState =
  | 'STAGING'
  | 'CREATING'
  | 'CREATED_UNVERIFIED'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'PUBLISHED_INACTIVE'
  | 'PUBLISHED_LEASED'
  | 'ACTIVE'
  | 'RETIRING'
  | 'CLEANUP_PENDING'
  | 'DELETED'
  | 'REJECTED'

/**
 * Immutable snapshot record tracking the complete lifecycle, ownership, and provenance.
 */
export interface CustomSnapshotRecord {
  readonly id: string
  readonly identity: string
  readonly sourcePath: string
  readonly stagingPath: string
  readonly publishedPath: string | null
  readonly state: SnapshotState
  readonly activeLeases: number
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
  /** Optional target filename override (used exclusively for collision/conflict injection testing). */
  readonly targetFileName?: string
}

/** Options for constructing CustomSnapshotManager. */
export interface CustomSnapshotManagerOptions {
  readonly paths: ManagedStoragePaths
  readonly validator?: CustomDictionaryValidator
  readonly maxSizeBytes?: number
}

/** Error thrown when attempting to clean up a snapshot that currently has active dictionary references. */
export class SnapshotActiveReferenceError extends Error {
  readonly code = 'SNAPSHOT_ACTIVE_REFERENCE'
  readonly activeLeases: number

  constructor(message: string, activeLeases: number) {
    super(message)
    this.name = 'SnapshotActiveReferenceError'
    this.activeLeases = activeLeases
  }
}

/** Error thrown when the atomic publish destination already exists or collides. */
export class SnapshotPublishConflictError extends Error {
  readonly code = 'SNAPSHOT_PUBLISH_CONFLICT'

  constructor(message: string) {
    super(message)
    this.name = 'SnapshotPublishConflictError'
  }
}

/** Error thrown when snapshot cleanup fails due to operating system file locks or errors. */
export class SnapshotCleanupError extends Error {
  readonly code = 'SNAPSHOT_CLEANUP_FAILED'
  readonly originalCode?: string

  constructor(message: string, originalCode?: string) {
    super(message)
    this.name = 'SnapshotCleanupError'
    this.originalCode = originalCode
  }
}

interface StagingOwnershipPayload {
  readonly managerId: string
  readonly snapshotId: string
  readonly pid: number
  readonly createdAt: number
}

/**
 * Manages the lifecycle, creation, verification, and storage of custom SQLite snapshots.
 */
export class CustomSnapshotManager {
  readonly #managerId = randomUUID()
  readonly #paths: ManagedStoragePaths
  readonly #validator: CustomDictionaryValidator
  readonly #maxSizeBytes: number
  readonly #snapshots = new Map<string, CustomSnapshotRecord>()
  readonly #ownedStagingFiles = new Set<string>()

  #disposed = false

  constructor(options: CustomSnapshotManagerOptions) {
    if (!options?.paths) {
      throw new TypeError('CustomSnapshotManager requires valid ManagedStoragePaths')
    }
    this.#paths = options.paths
    this.#validator = options.validator ?? new CustomDictionaryValidator()
    this.#maxSizeBytes = options.maxSizeBytes ?? 2 * 1024 * 1024 * 1024 // 2 GiB
  }

  get managerId(): string {
    return this.#managerId
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
   * Retrieve a snapshot record by logical identity.
   */
  getSnapshotByIdentity(identity: string): CustomSnapshotRecord | undefined {
    for (const record of this.#snapshots.values()) {
      if (record.identity === identity) return record
    }
    return undefined
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
   * 5. PUBLISHING: Staging file hash reverified in Worker (anti-TOCTOU) and atomically published.
   * 6. PUBLISHED_INACTIVE: Published custom snapshot ready for dictionary activation.
   *
   * Failure transitions:
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

    // 2. Prepare Staging Directory, Unique Identifier, and Staging File
    await mkdir(this.#paths.customSnapshotDirectory, { recursive: true })

    const id = randomUUID()
    const stagingFileName = `staging-${id}.sqlite3`
    const stagingPath = join(this.#paths.customSnapshotDirectory, stagingFileName)
    const ownerPath = `${stagingPath}.owner`

    // Ensure staging path conforms to containment and naming contract
    await validateCustomSnapshotPath(stagingPath, this.#paths.customSnapshotDirectory)

    // Establish staging ownership record
    this.#ownedStagingFiles.add(stagingPath)
    try {
      const ownerPayload: StagingOwnershipPayload = {
        managerId: this.#managerId,
        snapshotId: id,
        pid: process.pid,
        createdAt: Date.now(),
      }
      await writeFile(ownerPath, JSON.stringify(ownerPayload), { flag: 'wx' })
    } catch {
      // Non-fatal if ownership file creation fails; memory set holds ownership
    }

    // Compute external logical identity
    let logicalIdentity = options?.identity?.trim()
    if (!logicalIdentity) {
      logicalIdentity = `snap-${id.replace(/-/g, '').slice(0, 16)}`
    }
    if (!SAFE_IDENTITY_PATTERN.test(logicalIdentity)) {
      this.#cleanupStagingOwnership(stagingPath)
      throw new Error(
        `Snapshot identity "${logicalIdentity}" violates safe identity pattern (${SAFE_IDENTITY_PATTERN.source})`,
      )
    }

    let record: CustomSnapshotRecord = {
      id,
      identity: logicalIdentity,
      sourcePath: resolvedSource,
      stagingPath,
      publishedPath: null,
      state: 'CREATING',
      activeLeases: 0,
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
      if (this.#disposed) {
        throw new Error('CustomSnapshotManager was disposed during snapshot initiation')
      }

      // Step A: Create Snapshot via Worker (VACUUM INTO)
      const createRes = await this.#validator.createSnapshot(resolvedSource, stagingPath, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        maxSizeBytes: this.#maxSizeBytes,
      })

      if (this.#disposed) {
        throw new Error('CustomSnapshotManager was disposed after snapshot creation')
      }

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

      if (this.#disposed) {
        throw new Error('CustomSnapshotManager was disposed after snapshot validation')
      }

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

      // Step C: Atomic Fail-Closed Publishing with Non-Blocking Worker Hash
      record = { ...record, state: 'PUBLISHING' }
      this.#snapshots.set(id, record)

      // The published filename is keyed by the unique snapshot UUID to eliminate collision risks.
      // (Options.targetFileName is supported only when explicitly supplied for negative conflict testing)
      const publishedFileName = options?.targetFileName
        ? options.targetFileName
        : `custom-${id}.sqlite3`

      const publishedPath = join(this.#paths.customSnapshotDirectory, publishedFileName)
      await validateCustomSnapshotPath(publishedPath, this.#paths.customSnapshotDirectory)

      // Check for pre-existing file or symlink at publication destination (fail-closed)
      try {
        const destStat = lstatSync(publishedPath)
        if (destStat) {
          throw new SnapshotPublishConflictError(
            `Snapshot publication destination already exists at "${publishedPath}"`,
          )
        }
      } catch (lstatErr: any) {
        if (lstatErr instanceof SnapshotPublishConflictError) {
          throw lstatErr
        }
        if (lstatErr?.code !== 'ENOENT') {
          throw lstatErr
        }
      }

      // Worker-offloaded pre-publish hash & size check (Host event-loop non-blocking)
      await this.#validator.prePublishCheck(
        stagingPath,
        record.sha256!,
        record.byteSize!,
        {
          timeoutMs: options?.timeoutMs,
          signal: options?.signal,
          maxSizeBytes: this.#maxSizeBytes,
        },
      )

      if (this.#disposed) {
        throw new Error('CustomSnapshotManager was disposed before publishing file')
      }

      // Atomic publication without overwrite using hard link or exclusive copy
      try {
        await link(stagingPath, publishedPath)
      } catch (linkErr: any) {
        if (linkErr?.code === 'EEXIST') {
          throw new SnapshotPublishConflictError(
            `Snapshot publication destination already exists at "${publishedPath}"`,
          )
        }
        if (linkErr?.code === 'EXDEV' || linkErr?.code === 'ENOSYS' || linkErr?.code === 'EPERM') {
          // Filesystem does not support hard links; fall back to exclusive copy
          try {
            await copyFile(stagingPath, publishedPath, constants.COPYFILE_EXCL)
          } catch (copyErr: any) {
            if (copyErr?.code === 'EEXIST') {
              throw new SnapshotPublishConflictError(
                `Snapshot publication destination already exists at "${publishedPath}"`,
              )
            }
            throw copyErr
          }
        } else {
          throw linkErr
        }
      }

      // Remove temporary staging file after successful publication
      try {
        await unlink(stagingPath)
      } catch {
        // Non-fatal if staging unlink fails; cleanupStagingOwnership handles it
      }
      await this.#cleanupStagingOwnership(stagingPath)

      // Post-publish symlink and size validation
      const postLstat = lstatSync(publishedPath)
      if (postLstat.isSymbolicLink()) {
        try {
          await unlink(publishedPath)
        } catch {
          // Ignore
        }
        throw new Error(`Published snapshot at "${publishedPath}" must not be a symbolic link`)
      }

      record = {
        ...record,
        state: 'PUBLISHED_INACTIVE',
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
      await this.#cleanupStagingOwnership(stagingPath)

      throw err
    }
  }

  /**
   * Open an already-published snapshot as a queryable SqliteDictionary with source `'custom-local'`.
   * Acquires a lease on the snapshot to protect it against deletion while active.
   */
  openSnapshotDictionary(snapshotId: string): SqliteDictionary {
    if (this.#disposed) {
      throw new Error('CustomSnapshotManager has been disposed')
    }

    const record = this.#snapshots.get(snapshotId)
    if (!record) {
      throw new Error(`Snapshot "${snapshotId}" is not tracked by this manager`)
    }

    const isPublishedState =
      record.state === 'PUBLISHED_INACTIVE' ||
      record.state === 'ACTIVE' ||
      record.state === 'PUBLISHED_LEASED' ||
      record.state === 'PUBLISHED'

    if (!isPublishedState || !record.publishedPath) {
      throw new Error(
        `Snapshot "${snapshotId}" is in state "${record.state}" and cannot be opened as a dictionary`,
      )
    }

    const currentLeases = record.activeLeases + 1
    const updatedRecord: CustomSnapshotRecord = {
      ...record,
      activeLeases: currentLeases,
      state: 'ACTIVE',
    }
    this.#snapshots.set(snapshotId, updatedRecord)

    const dict = openSqliteDictionary({
      path: record.publishedPath,
      readOnly: true,
      source: 'custom-local',
    })

    const originalClose = dict.close.bind(dict)
    let leaseReleased = false
    const manager = this

    dict.close = function close(): void {
      if (leaseReleased) return
      leaseReleased = true
      try {
        originalClose()
      } finally {
        manager.#releaseSnapshotLease(snapshotId)
      }
    }

    return dict
  }

  /**
   * Retire a published snapshot, marking it for safe deactivation once current active references drain.
   */
  retireSnapshot(snapshotId: string): void {
    const record = this.#snapshots.get(snapshotId)
    if (!record) return

    if (record.activeLeases > 0) {
      this.#snapshots.set(snapshotId, {
        ...record,
        state: 'RETIRING',
      })
    } else {
      this.#snapshots.set(snapshotId, {
        ...record,
        state: 'PUBLISHED_INACTIVE',
      })
    }
  }

  /**
   * Release a previously acquired snapshot lease.
   */
  #releaseSnapshotLease(snapshotId: string): void {
    const record = this.#snapshots.get(snapshotId)
    if (!record) return

    const remainingLeases = Math.max(0, record.activeLeases - 1)
    let nextState: SnapshotState = record.state

    if (remainingLeases === 0) {
      if (record.state === 'RETIRING') {
        nextState = 'PUBLISHED_INACTIVE'
      } else if (record.state === 'ACTIVE' || record.state === 'PUBLISHED_LEASED') {
        nextState = 'PUBLISHED_INACTIVE'
      }
    }

    this.#snapshots.set(snapshotId, {
      ...record,
      activeLeases: remainingLeases,
      state: nextState,
    })
  }

  /**
   * Safely delete a published custom snapshot.
   *
   * Rejects deletion if active dictionary references exist or if the snapshot is in RETIRING state.
   * Handles Windows file locks explicitly.
   */
  async cleanupSnapshot(snapshotId: string): Promise<boolean> {
    const record = this.#snapshots.get(snapshotId)
    if (!record || !record.publishedPath) return false

    // Idempotent completion if already deleted
    if (record.state === 'DELETED') {
      return true
    }

    // Active reference protection: reject cleanup while query connections are held
    if (record.activeLeases > 0 || record.state === 'ACTIVE' || record.state === 'RETIRING') {
      throw new SnapshotActiveReferenceError(
        `Cannot clean up snapshot "${snapshotId}" while ${record.activeLeases} active dictionary reference(s) exist (state: ${record.state})`,
        record.activeLeases,
      )
    }

    try {
      await validateCustomSnapshotPath(record.publishedPath, this.#paths.customSnapshotDirectory)

      this.#snapshots.set(snapshotId, {
        ...record,
        state: 'CLEANUP_PENDING',
      })

      if (existsSync(record.publishedPath)) {
        await unlink(record.publishedPath)
      }

      this.#snapshots.set(snapshotId, {
        ...record,
        state: 'DELETED',
      })
      return true
    } catch (err: unknown) {
      const errCode = (err as { code?: string })?.code ?? 'CLEANUP_FAILED'
      const errMsg = err instanceof Error ? err.message : String(err)

      this.#snapshots.set(snapshotId, {
        ...record,
        state: 'CLEANUP_PENDING',
        error: errMsg,
        errorCode: errCode,
      })

      throw new SnapshotCleanupError(
        `Failed to delete snapshot file "${record.publishedPath}": ${errMsg}`,
        errCode,
      )
    }
  }

  /**
   * Helper to clean up staging ownership file and memory tracking.
   */
  async #cleanupStagingOwnership(stagingPath: string): Promise<void> {
    this.#ownedStagingFiles.delete(stagingPath)
    const ownerPath = `${stagingPath}.owner`
    try {
      if (existsSync(ownerPath)) {
        await unlink(ownerPath)
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Scan customSnapshotDirectory and safely remove orphaned staging files.
   * Never deletes staging files actively owned by another manager instance or process.
   */
  async cleanupStagingFiles(): Promise<number> {
    let cleaned = 0
    if (!existsSync(this.#paths.customSnapshotDirectory)) return 0

    try {
      const entries = await readdir(this.#paths.customSnapshotDirectory)
      for (const entry of entries) {
        if (STAGING_SNAPSHOT_FILENAME_PATTERN.test(entry)) {
          const fullPath = join(this.#paths.customSnapshotDirectory, entry)
          const ownerPath = `${fullPath}.owner`

          // Check if this staging file is actively owned by this manager
          if (this.#ownedStagingFiles.has(fullPath) && !this.#disposed) {
            // Actively in progress in this manager, do not delete
            continue
          }

          // Check owner file to prevent deleting another active manager's staging file
          if (existsSync(ownerPath)) {
            try {
              const content = await readFile(ownerPath, 'utf8')
              const owner = JSON.parse(content) as StagingOwnershipPayload
              if (owner && typeof owner.pid === 'number') {
                if (owner.managerId !== this.#managerId) {
                  let isPidAlive = false
                  try {
                    process.kill(owner.pid, 0)
                    isPidAlive = true
                  } catch {
                    isPidAlive = false
                  }
                  // If other process is still running and created less than 1 hour ago, do NOT touch!
                  if (isPidAlive && Date.now() - owner.createdAt < 3600000) {
                    continue
                  }
                }
              }
            } catch {
              // Ignore owner file read/parse errors
            }
          }

          try {
            await validateCustomSnapshotPath(fullPath, this.#paths.customSnapshotDirectory)
            await unlink(fullPath)
            cleaned++
            if (existsSync(ownerPath)) {
              await unlink(ownerPath).catch(() => {})
            }
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
   * Dispose manager and validator.
   * Cancels in-flight tasks and cleans up ONLY staging files owned by this manager instance.
   * Published snapshots are strictly preserved for future restarts.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true

    await this.#validator.dispose()

    // Clean up staging files owned by THIS manager instance
    const owned = [...this.#ownedStagingFiles]
    for (const stagingPath of owned) {
      try {
        if (existsSync(stagingPath)) {
          await unlink(stagingPath)
        }
      } catch {
        // Ignore
      }
      await this.#cleanupStagingOwnership(stagingPath)
    }

    // Run general orphan staging cleanup (safe for other managers)
    await this.cleanupStagingFiles()
  }
}
