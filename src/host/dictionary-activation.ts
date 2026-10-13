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

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { openProductionDictionary } from './corpus-db.js'
import type { Dictionary } from './dictionary.js'
import { DictionaryManager } from './dictionary-manager.js'
import { openFixtureDictionary } from './fixture-db.js'
import {
  getQuarantineRecord,
} from './ecdict-importer.js'
import {
  readActiveMetadata,
  removeStaleTemporaryArtifacts,
  writeActiveMetadataAtomically,
  type ActiveMetadata,
  type ManagedStoragePaths,
} from './managed-storage.js'
import {
  readDictionaryMode,
  type DictionaryMode,
  type HostConfig,
} from './config.js'
import type {
  InstalledCorpusInfo,
  ManagementErrorCode,
} from '../shared/dictionary-management-protocol.js'
import type { ManagedEcdictBuildResult } from './ecdict-importer.js'

/** Probe headwords queried to verify query capability on candidate databases. */
const ACTIVATION_PROBE_HEADWORDS = Object.freeze(['go', 'derive', 'wave'])

/** Supported extensions for custom SQLite dictionary verification. */
const VALID_SQLITE_EXTENSIONS = new Set(['.sqlite3', '.sqlite', '.db'])

/**
 * Sanitize error message to prevent leaking machine-specific paths, credentials, or stack traces.
 */
function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') return 'Unknown error occurred'
  return rawMessage
    .replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, '[local-path]')
    .replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, '[local-path]')
    .trim()
}

/**
 * Error thrown when an activation attempt fails and rollback of previous state also fails.
 */
export class ActivationRollbackError extends Error {
  readonly code = 'ACTIVATION_ROLLBACK_FAILED'
  readonly originalError: unknown
  readonly rollbackError: unknown

  constructor(message: string, originalError: unknown, rollbackError: unknown) {
    super(message)
    this.name = 'ActivationRollbackError'
    this.originalError = originalError
    this.rollbackError = rollbackError
  }
}

/**
 * Options for constructing {@link ActivationCoordinator}.
 */
export interface ActivationCoordinatorOptions {
  /** Owning Cordis Context. */
  readonly ctx?: Context
  /** Resolved managed storage paths, or null/undefined if storage is unavailable. */
  readonly paths?: ManagedStoragePaths | null
  /** Live dictionary manager instance. */
  readonly manager: DictionaryManager
  /** Plugin host configuration. */
  readonly config?: HostConfig
}

/**
 * Result returned by custom dictionary database verification.
 */
export interface CustomDatabaseVerificationResult {
  readonly valid: boolean
  readonly schemaVersion: number
  readonly entryCount: number
  readonly formCount: number
  readonly headwordsSample: readonly string[]
  readonly error?: string
  readonly errorCode?: ManagementErrorCode
}

/**
 * Diagnostic summary of the coordinator state.
 */
export interface ActivationStateSummary {
  readonly activeMode: DictionaryMode
  readonly configuredMode: DictionaryMode
  readonly activeSource: 'sqlite-fixture' | 'ecdict-local'
  readonly activeIdentity: string
  readonly installed: boolean
  readonly installedCorpus: InstalledCorpusInfo | null
  readonly quarantined: boolean
  readonly quarantineReason: string | null
  readonly recoveryError: string | null
  readonly settingsSyncError: string | null
  readonly lastRetirementError: string | null
  readonly lastRollbackError: string | null
  readonly generation: number
}

/**
 * Coordinates atomic activation, persistence consistency, recovery, and removal.
 */
export class ActivationCoordinator {
  readonly #ctx?: Context
  readonly #paths: ManagedStoragePaths | null
  readonly #manager: DictionaryManager
  readonly #config?: HostConfig

  #recoveryPromise: Promise<void> | null = null
  #isRecovering = false
  #recoveryError: string | null = null
  #settingsSyncError: string | null = null
  #lastRollbackError: string | null = null
  #cachedInstalledCorpus: InstalledCorpusInfo | null = null

  constructor(options: ActivationCoordinatorOptions) {
    this.#ctx = options.ctx
    this.#paths = options.paths ?? null
    this.#manager = options.manager
    this.#config = options.config
  }

  /**
   * Return storage paths used by this coordinator.
   */
  get paths(): ManagedStoragePaths | null {
    return this.#paths
  }

  /**
   * Return the underlying live DictionaryManager.
   */
  get manager(): DictionaryManager {
    return this.#manager
  }

  /**
   * Return whether startup recovery is currently in flight.
   */
  get isRecovering(): boolean {
    return this.#isRecovering
  }

  /**
   * Await completion of in-flight startup recovery, ensuring subsequent operations
   * observe settled state and never race or interleave with recovery.
   */
  async ensureReady(): Promise<void> {
    if (this.#recoveryPromise) {
      try {
        await this.#recoveryPromise
      } catch {
        // Recovery errors are tracked in coordinator diagnostic state
      }
    }
  }

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
  recoverOnStartup(): Promise<void> {
    if (this.#recoveryPromise) {
      return this.#recoveryPromise
    }
    this.#isRecovering = true
    this.#recoveryPromise = this.#runStartupRecovery().finally(() => {
      this.#isRecovering = false
    })
    return this.#recoveryPromise
  }

  async #runStartupRecovery(): Promise<void> {
    this.#recoveryError = null
    this.#cachedInstalledCorpus = null

    if (!this.#paths) {
      return
    }

    let metadata: ActiveMetadata | null
    try {
      metadata = await readActiveMetadata(this.#paths)
    } catch (error) {
      this.#recoveryError = `Corrupt active metadata: ${error instanceof Error ? error.message : String(error)}`
      return
    }

    if (!metadata) {
      // Fresh install or uninstalled: normal fixture operation
      return
    }

    if (metadata.settingsSyncError) {
      this.#settingsSyncError = metadata.settingsSyncError
    }

    const dbPath = join(this.#paths.databaseDirectory, metadata.databaseFile)
    if (!existsSync(dbPath)) {
      this.#recoveryError = `Managed database file missing: ${metadata.databaseFile}`
      return
    }

    let openedDict: Dictionary | null = null
    try {
      openedDict = openProductionDictionary({ path: dbPath })
      // Probe query verification
      for (const probe of ACTIVATION_PROBE_HEADWORDS) {
        openedDict.lookup(probe)
      }
    } catch (error) {
      if (openedDict) {
        try { openedDict.close() } catch { /* ignore */ }
      }
      this.#recoveryError = `Corrupt or incompatible managed database: ${error instanceof Error ? error.message : String(error)}`
      return
    }

    // Inspect database stats for installedCorpus summary
    let stats: { entryCount?: number; formCount?: number; byteSize?: number } = {}
    try {
      const fileStat = statSync(dbPath)
      const rawDb = new DatabaseSync(dbPath, { readOnly: true, open: true })
      try {
        const entryRow = rawDb.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number } | undefined
        const formRow = rawDb.prepare('SELECT COUNT(*) as c FROM forms').get() as { c: number } | undefined
        stats = {
          entryCount: entryRow?.c,
          formCount: formRow?.c,
          byteSize: fileStat.size,
        }
      } finally {
        rawDb.close()
      }
    } catch {
      // Non-fatal metadata enrichment
    }

    this.#cachedInstalledCorpus = Object.freeze({
      name: metadata.source.name,
      commit: metadata.source.commit,
      sha256: metadata.source.sha256,
      schemaVersion: metadata.source.schemaVersion,
      databaseFile: metadata.databaseFile,
      entryCount: stats.entryCount,
      formCount: stats.formCount,
      byteSize: stats.byteSize,
    })

    const userMode = readDictionaryMode(this.#config)

    // Check if previous settings sync failed (A02, A03)
    const settingsSyncFailed =
      metadata.settingsSynced === false ||
      (typeof metadata.settingsSyncError === 'string' && metadata.settingsSyncError.length > 0) ||
      (this.#settingsSyncError !== null)

    if (userMode === 'managed-ecdict' || (userMode === 'fixture' && settingsSyncFailed)) {
      try {
        this.#manager.activate({
          mode: 'managed-ecdict',
          identity: metadata.identity,
          dictionary: openedDict,
        })
        // Attempt to re-sync host settings if it was previously failed
        if (settingsSyncFailed) {
          await this.#persistHostConfigMode('managed-ecdict')
        }
      } catch (error) {
        openedDict.close()
        this.#recoveryError = `Activation failed during startup: ${error instanceof Error ? error.message : String(error)}`
      }
    } else {
      // User explicitly configured 'fixture' (A04) or 'custom': close candidate, keep fixture live
      openedDict.close()
    }
  }

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
  async activateManagedDatabase(buildResult: ManagedEcdictBuildResult): Promise<void> {
    if (!this.#paths) {
      throw new Error('Managed storage unavailable: cannot activate database')
    }

    const publishedPath = buildResult.path
    if (!existsSync(publishedPath)) {
      throw new Error(`Published database file not found at: ${publishedPath}`)
    }

    // Capture previous metadata before attempting activation
    let previousMetadata: ActiveMetadata | null = null
    try {
      previousMetadata = await readActiveMetadata(this.#paths)
    } catch {
      // previous metadata missing or invalid
    }

    // 1. Open and validate published database
    const publishedDict = openProductionDictionary({ path: publishedPath })
    try {
      for (const probe of ACTIVATION_PROBE_HEADWORDS) {
        publishedDict.lookup(probe)
      }
    } catch (error) {
      publishedDict.close()
      throw new Error(`Candidate database probe verification failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }

    // 2. Commit metadata atomically
    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: buildResult.identity,
      databaseFile: buildResult.databaseFile,
      source: {
        name: 'ECDICT',
        commit: buildResult.sourceCommit,
        sha256: buildResult.sourceSha256,
        schemaVersion: buildResult.schemaVersion,
      },
      lastActivatedAt: new Date().toISOString(),
      settingsSynced: false,
      settingsSyncError: null,
    }

    try {
      await writeActiveMetadataAtomically(this.#paths, metadata)
    } catch (error) {
      publishedDict.close()
      throw new Error(`Failed to commit active metadata atomically: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }

    // 3. Atomically activate in DictionaryManager
    try {
      this.#manager.activate({
        mode: 'managed-ecdict',
        identity: buildResult.identity,
        dictionary: publishedDict,
      })
    } catch (error) {
      // Candidate was closed by DictionaryManager (or close it if still open)
      try {
        publishedDict.close()
      } catch {
        // ignore
      }

      // Rollback compensation: restore previous active metadata
      if (previousMetadata !== null) {
        try {
          await writeActiveMetadataAtomically(this.#paths, previousMetadata)
        } catch (rollbackErr) {
          const rollbackMsg = sanitizeErrorMessage(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))
          this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`
          throw new ActivationRollbackError(
            `Activation failed and rollback of previous active metadata also failed: ${rollbackMsg}`,
            error,
            rollbackErr,
          )
        }
      } else {
        // First install: remove candidate active.json
        try {
          await unlink(this.#paths.activeMetadataPath)
        } catch {
          // best effort
        }
      }

      throw error
    }

    // Update internal cached summary
    this.#cachedInstalledCorpus = Object.freeze({
      name: metadata.source.name,
      commit: metadata.source.commit,
      sha256: metadata.source.sha256,
      schemaVersion: metadata.source.schemaVersion,
      databaseFile: metadata.databaseFile,
      entryCount: buildResult.entryCount,
      formCount: buildResult.formCount,
      byteSize: buildResult.byteSize,
      publishedAt: new Date().toISOString(),
    })
    this.#recoveryError = null

    // 4. Best-effort Host Config persistence
    await this.#persistHostConfigMode('managed-ecdict')

    // Persist final settings sync state into active.json
    try {
      await writeActiveMetadataAtomically(this.#paths, {
        ...metadata,
        settingsSynced: this.#settingsSyncError === null,
        settingsSyncError: this.#settingsSyncError,
      })
    } catch {
      // non-fatal
    }
  }

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
  async removeManagedDatabase(): Promise<{ removed: boolean }> {
    // 1. Hot switch to fixture to release handle
    const fixture = openFixtureDictionary()
    this.#manager.activate({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: fixture,
    })

    if (!this.#paths) {
      this.#cachedInstalledCorpus = null
      this.#recoveryError = null
      this.#settingsSyncError = null
      this.#lastRollbackError = null
      await this.#persistHostConfigMode('fixture')
      return { removed: false }
    }

    // Read current metadata to identify file
    let currentMetadata: ActiveMetadata | null = null
    try {
      currentMetadata = await readActiveMetadata(this.#paths)
    } catch {
      // proceed with best effort cleanup
    }

    // 2. Unlink active.json
    try {
      await unlink(this.#paths.activeMetadataPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    // 3. Unlink database file if known
    if (currentMetadata?.databaseFile) {
      const dbPath = join(this.#paths.databaseDirectory, currentMetadata.databaseFile)
      try {
        await unlink(dbPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    // 4. Clean stale temporary files
    await removeStaleTemporaryArtifacts(this.#paths)

    // Reset cached state
    this.#cachedInstalledCorpus = null
    this.#recoveryError = null
    this.#settingsSyncError = null
    this.#lastRollbackError = null

    // 5. Best-effort update Host Config to fixture
    await this.#persistHostConfigMode('fixture')

    return { removed: true }
  }

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
  async verifyCustomDatabase(candidatePath: string): Promise<CustomDatabaseVerificationResult> {
    if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
      return {
        valid: false,
        schemaVersion: 0,
        entryCount: 0,
        formCount: 0,
        headwordsSample: [],
        error: 'Candidate database path must be a non-empty string',
        errorCode: 'INVALID_PATH',
      }
    }

    const trimmedPath = candidatePath.trim()
    if (trimmedPath.includes('\0')) {
      return {
        valid: false,
        schemaVersion: 0,
        entryCount: 0,
        formCount: 0,
        headwordsSample: [],
        error: 'Candidate database path contains null bytes',
        errorCode: 'INVALID_PATH',
      }
    }

    const resolvedPath = resolve(trimmedPath)

    // Check extension
    const base = basename(resolvedPath).toLowerCase()
    const hasValidExt = [...VALID_SQLITE_EXTENSIONS].some((ext) => base.endsWith(ext))
    if (!hasValidExt) {
      return {
        valid: false,
        schemaVersion: 0,
        entryCount: 0,
        formCount: 0,
        headwordsSample: [],
        error: `Database filename must have a valid SQLite extension (${[...VALID_SQLITE_EXTENSIONS].join(', ')})`,
        errorCode: 'INVALID_SQLITE_FILE',
      }
    }

    // Check existence
    try {
      const fileStat = await stat(resolvedPath)
      if (!fileStat.isFile()) {
        return {
          valid: false,
          schemaVersion: 0,
          entryCount: 0,
          formCount: 0,
          headwordsSample: [],
          error: 'Target path is not a regular file',
          errorCode: 'NOT_A_FILE',
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          valid: false,
          schemaVersion: 0,
          entryCount: 0,
          formCount: 0,
          headwordsSample: [],
          error: 'Candidate database file does not exist',
          errorCode: 'FILE_NOT_FOUND',
        }
      }
      return {
        valid: false,
        schemaVersion: 0,
        entryCount: 0,
        formCount: 0,
        headwordsSample: [],
        error: `Cannot access candidate file: ${(error as Error).message}`,
        errorCode: 'INVALID_PATH',
      }
    }

    // Open read-only with SQLite
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(resolvedPath, { readOnly: true, open: true })

      // 1. Verify required tables
      const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      for (const table of ['meta', 'entries', 'forms', 'examples']) {
        if (!tableStmt.get(table)) {
          return {
            valid: false,
            schemaVersion: 0,
            entryCount: 0,
            formCount: 0,
            headwordsSample: [],
            error: `Database is missing required table: "${table}"`,
            errorCode: 'INVALID_DATABASE_SCHEMA',
          }
        }
      }

      // 2. Read schema_version from meta
      const metaStmt = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      const versionRow = metaStmt.get() as { value: string } | undefined
      const schemaVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 1

      // 3. Count entries and forms
      const entryCountRow = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number } | undefined
      const formCountRow = db.prepare('SELECT COUNT(*) as c FROM forms').get() as { c: number } | undefined

      const entryCount = entryCountRow?.c ?? 0
      const formCount = formCountRow?.c ?? 0

      // 4. Sample headwords
      const sampleRows = db.prepare('SELECT word FROM entries LIMIT 5').all() as Array<{ word: string }>
      const headwordsSample = sampleRows.map((r) => r.word)

      return {
        valid: true,
        schemaVersion,
        entryCount,
        formCount,
        headwordsSample,
      }
    } catch (error) {
      return {
        valid: false,
        schemaVersion: 0,
        entryCount: 0,
        formCount: 0,
        headwordsSample: [],
        error: `Failed to verify SQLite database: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'INVALID_DATABASE_SCHEMA',
      }
    } finally {
      if (db) {
        try { db.close() } catch { /* ignore */ }
      }
    }
  }

  /**
   * Return a diagnostic state snapshot.
   */
  getStatusSummary(): ActivationStateSummary {
    const snap = this.#manager.snapshot()
    const configuredMode = readDictionaryMode(this.#config)

    const isInstalled = this.#paths !== null &&
      this.#cachedInstalledCorpus !== null &&
      existsSync(join(this.#paths.databaseDirectory, this.#cachedInstalledCorpus.databaseFile))

    const quarantineRecord = this.#paths ? getQuarantineRecord(this.#paths.databaseDirectory) : null

    return Object.freeze({
      activeMode: snap.activeMode,
      configuredMode,
      activeSource: snap.source,
      activeIdentity: snap.identity,
      installed: isInstalled,
      installedCorpus: this.#cachedInstalledCorpus,
      quarantined: quarantineRecord !== null,
      quarantineReason: quarantineRecord?.reason ?? null,
      recoveryError: this.#recoveryError,
      settingsSyncError: this.#settingsSyncError,
      lastRetirementError: snap.lastRetirementError,
      lastRollbackError: this.#lastRollbackError,
      generation: snap.generation,
    })
  }

  /**
   * Best-effort persistence of dictionaryMode to Host settings.
   */
  async #persistHostConfigMode(mode: DictionaryMode): Promise<void> {
    const settings = (this.#ctx as { get?: (s: string) => { update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown> } } | undefined)?.get?.('settings')
    if (!settings || typeof settings.update !== 'function') {
      // Settings service not present on context; preserve existing error state if any
      return
    }
    try {
      await settings.update('dsh-word-lookup', { dictionaryMode: mode })
      this.#settingsSyncError = null
    } catch (err) {
      // Non-fatal: settings persistence failure does not roll back active state
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
      this.#settingsSyncError = `Settings update failed: ${msg}`
    }
  }
}
