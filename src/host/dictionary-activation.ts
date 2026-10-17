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
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, stat, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { openProductionDictionary } from './corpus-db.js'
import type { Dictionary, DictionarySource } from './dictionary.js'
import { DictionaryManager } from './dictionary-manager.js'
import { openFixtureDictionary } from './fixture-db.js'
import { FIXTURE_ENTRIES, FIXTURE_FORMS, FIXTURE_VERSION } from './fixture.js'
import {
  getQuarantineRecord,
} from './ecdict-importer.js'
import {
  readActiveMetadata,
  readInstalledEcdictMetadata,
  removeInstalledEcdictMetadata,
  removeStaleTemporaryArtifacts,
  validateCustomSnapshotPath,
  writeActiveMetadataAtomically,
  writeInstalledEcdictMetadataAtomically,
  type ActiveMetadata,
  type CustomActiveMetadata,
  type InstalledEcdictMetadata,
  type ManagedActiveMetadata,
  type ManagedStoragePaths,
  type SettingsSyncState,
} from './managed-storage.js'
import {
  CustomSnapshotManager,
} from './custom-snapshot-manager.js'
import {
  readDictionaryMode,
  type DictionaryMode,
  type HostConfig,
} from './config.js'
import type {
  FixtureCorpusInfo,
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
  /** Optional CustomSnapshotManager instance. If omitted and paths is provided, one is created. */
  readonly customSnapshotManager?: CustomSnapshotManager | null
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
 * Result returned by custom dictionary activation.
 */
export interface CustomActivationResult {
  readonly snapshotId: string
  readonly identity: string
  readonly activeMode: 'custom'
  readonly generation: number
}

/**
 * Result returned by operational mode selection.
 */
export interface ModeSelectionResult {
  readonly activeMode: DictionaryMode
  readonly generation: number
}

/**
 * Diagnostic summary of the coordinator state.
 */
export interface ActivationStateSummary {
  readonly activeMode: DictionaryMode
  readonly configuredMode: DictionaryMode
  readonly activeSource: DictionarySource
  readonly activeIdentity: string
  readonly activeSnapshotId: string | null
  readonly customSnapshotStatus: {
    readonly snapshotId: string
    readonly activeLeases: number
  } | null
  readonly installed: boolean
  readonly installedCorpus: InstalledCorpusInfo | null
  readonly fixtureStats: FixtureCorpusInfo
  readonly quarantined: boolean
  readonly quarantineReason: string | null
  readonly recoveryError: string | null
  readonly settingsSyncState: SettingsSyncState
  readonly settingsSyncError: string | null
  readonly lastRetirementError: string | null
  readonly lastRollbackError: string | null
  readonly generation: number
}

/**
 * Test-only failure injection and race orchestration hooks for activation coordinator.
 */
export interface ActivationHooks {
  readonly beforeReadMetadata?: () => Promise<void>
  readonly beforeCommitMetadata?: () => Promise<void>
  readonly duringRollbackCompensation?: () => Promise<void>
}

let activationHooks: ActivationHooks | null = null

/**
 * Configure test-only activation hooks.
 * @internal
 */
export function _setActivationHooksForTesting(hooks: ActivationHooks | null): void {
  activationHooks = hooks
}

/**
 * Coordinates atomic activation, persistence consistency, recovery, and removal.
 */
export class ActivationCoordinator {
  readonly #ctx?: Context
  readonly #paths: ManagedStoragePaths | null
  readonly #manager: DictionaryManager
  readonly #config?: HostConfig
  readonly #customSnapshotManager: CustomSnapshotManager | null
  readonly #ownsSnapshotManager: boolean

  #recoveryPromise: Promise<void> | null = null
  #isRecovering = false
  #disposed = false
  #recoveryError: string | null = null
  #settingsSyncState: SettingsSyncState = 'pending'
  #settingsSyncError: string | null = null
  #lastRollbackError: string | null = null
  #cachedInstalledCorpus: InstalledCorpusInfo | null = null
  #activeSnapshotId: string | null = null

  constructor(options: ActivationCoordinatorOptions) {
    this.#ctx = options.ctx
    this.#paths = options.paths ?? null
    this.#manager = options.manager
    this.#config = options.config
    if (options.customSnapshotManager !== undefined) {
      this.#customSnapshotManager = options.customSnapshotManager
      this.#ownsSnapshotManager = false
    } else if (this.#paths) {
      this.#customSnapshotManager = new CustomSnapshotManager({ paths: this.#paths })
      this.#ownsSnapshotManager = true
    } else {
      this.#customSnapshotManager = null
      this.#ownsSnapshotManager = false
    }
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
   * Return the custom snapshot manager instance, or null if storage is unavailable.
   */
  get customSnapshotManager(): CustomSnapshotManager | null {
    return this.#customSnapshotManager
  }

  /**
   * Return the active custom snapshot ID, or null if custom mode is not active.
   */
  get activeSnapshotId(): string | null {
    return this.#activeSnapshotId
  }

  /**
   * Return whether the coordinator has been disposed.
   */
  get isDisposed(): boolean {
    return this.#disposed
  }

  /**
   * Mark coordinator as disposed, preventing future activations or mutations.
   */
  dispose(): void {
    this.#disposed = true
    if (this.#ownsSnapshotManager && this.#customSnapshotManager) {
      void this.#customSnapshotManager.dispose()
    }
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
    this.#activeSnapshotId = null

    if (!this.#paths) {
      return
    }

    // Step 0: Recover installed ECDICT inventory
    try {
      const installedMeta = await readInstalledEcdictMetadata(this.#paths)
      if (installedMeta) {
        const ecdictPath = join(this.#paths.databaseDirectory, installedMeta.databaseFile)
        if (existsSync(ecdictPath)) {
          let testDict: Dictionary | null = null
          try {
            testDict = openProductionDictionary({ path: ecdictPath })
            for (const probe of ACTIVATION_PROBE_HEADWORDS) {
              testDict.lookup(probe)
            }
            let stats: { entryCount?: number; formCount?: number; byteSize?: number } = {
              entryCount: installedMeta.entryCount,
              formCount: installedMeta.formCount,
              byteSize: installedMeta.byteSize,
            }
            if (stats.entryCount === undefined || stats.byteSize === undefined) {
              try {
                const fileStat = statSync(ecdictPath)
                const rawDb = new DatabaseSync(ecdictPath, { readOnly: true, open: true })
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
                // ignore
              }
            }
            this.#cachedInstalledCorpus = Object.freeze({
              name: installedMeta.source.name,
              commit: installedMeta.source.commit,
              sha256: installedMeta.source.sha256,
              schemaVersion: installedMeta.source.schemaVersion,
              databaseFile: installedMeta.databaseFile,
              entryCount: stats.entryCount,
              formCount: stats.formCount,
              byteSize: stats.byteSize,
              publishedAt: installedMeta.installedAt,
            })
          } catch {
            this.#cachedInstalledCorpus = null
          } finally {
            if (testDict) {
              try { testDict.close() } catch {}
            }
          }
        }
      }
    } catch {
      // non-fatal installed inventory recovery
    }

    let metadata: ActiveMetadata | null
    try {
      metadata = await readActiveMetadata(this.#paths)
    } catch (error) {
      this.#recoveryError = `Corrupt active metadata: ${error instanceof Error ? error.message : String(error)}`
      return
    }

    if (!metadata) {
      // Fresh install or uninstalled or explicit fixture: normal fixture operation
      return
    }

    if (metadata.settingsSyncError) {
      this.#settingsSyncError = metadata.settingsSyncError
    }
    if (metadata.settingsSyncState) {
      this.#settingsSyncState = metadata.settingsSyncState
    } else if (metadata.settingsSynced === true) {
      this.#settingsSyncState = 'synced'
    } else if (metadata.settingsSynced === false) {
      this.#settingsSyncState = 'failed'
    } else if (metadata.settingsSyncError) {
      this.#settingsSyncState = 'failed'
    } else {
      // Legacy metadata without settings fields: treat as confirmed synced
      this.#settingsSyncState = 'synced'
    }

    const userMode = readDictionaryMode(this.#config)
    const isSyncConfirmed = this.#settingsSyncState === 'synced' && metadata.settingsSynced !== false && !metadata.settingsSyncError
    const settingsSyncFailed = !isSyncConfirmed

    // Branch A: Managed ECDICT active mode
    if (metadata.activeMode === 'managed-ecdict') {
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
        this.#cachedInstalledCorpus = null
        this.#recoveryError = `Corrupt or incompatible managed database: ${error instanceof Error ? error.message : String(error)}`
        return
      }

      // If cachedInstalledCorpus was missing, populate from metadata and persist inventory
      if (!this.#cachedInstalledCorpus) {
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
        } catch {}

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

        try {
          await writeInstalledEcdictMetadataAtomically(this.#paths, {
            version: 1,
            identity: metadata.identity,
            databaseFile: metadata.databaseFile,
            source: metadata.source,
            entryCount: stats.entryCount,
            formCount: stats.formCount,
            byteSize: stats.byteSize,
            installedAt: metadata.lastActivatedAt,
          })
        } catch {}
      }

      if (userMode === 'managed-ecdict' || (userMode === 'fixture' && settingsSyncFailed)) {
        try {
          this.#manager.activate({
            mode: 'managed-ecdict',
            identity: metadata.identity,
            dictionary: openedDict,
          })
          if (settingsSyncFailed) {
            const retryState = await this.#persistHostConfigMode('managed-ecdict')
            if (retryState === 'synced') {
              try {
                await writeActiveMetadataAtomically(this.#paths, {
                  ...metadata,
                  settingsSynced: true,
                  settingsSyncState: 'synced',
                  settingsSyncError: null,
                })
              } catch {
                // non-fatal
              }
            }
          }
        } catch (error) {
          openedDict.close()
          this.#recoveryError = `Activation failed during startup: ${error instanceof Error ? error.message : String(error)}`
        }
      } else {
        // User explicitly configured 'fixture' (A04) or 'custom': close candidate, keep fixture live
        openedDict.close()
      }
      return
    }

    // Branch B: Custom active mode
    if (metadata.activeMode === 'custom') {
      if (!this.#customSnapshotManager) {
        this.#recoveryError = 'Custom snapshot manager unavailable'
        return
      }

      const snapPath = join(this.#paths.customSnapshotDirectory, metadata.databaseFile)
      if (!existsSync(snapPath)) {
        this.#recoveryError = `Active custom snapshot file missing: ${metadata.databaseFile}`
        return
      }

      // Security boundary validation
      try {
        await validateCustomSnapshotPath(snapPath, this.#paths.customSnapshotDirectory)
      } catch (err) {
        this.#recoveryError = `Active custom snapshot path validation failed: ${err instanceof Error ? err.message : String(err)}`
        return
      }

      let fileStat
      try {
        fileStat = statSync(snapPath)
        if (!fileStat.isFile()) {
          this.#recoveryError = `Active custom snapshot is not a regular file: ${metadata.databaseFile}`
          return
        }
        if (metadata.byteSize !== undefined && fileStat.size !== metadata.byteSize) {
          this.#recoveryError = `Active custom snapshot byte size mismatch: expected ${metadata.byteSize}, got ${fileStat.size}`
          return
        }
      } catch (err) {
        this.#recoveryError = `Cannot stat custom snapshot file: ${err instanceof Error ? err.message : String(err)}`
        return
      }

      // SHA-256 digest validation
      try {
        const fileBuf = await readFile(snapPath)
        const computedSha = createHash('sha256').update(fileBuf).digest('hex').toLowerCase()
        if (metadata.sha256 && computedSha !== metadata.sha256.toLowerCase()) {
          this.#recoveryError = `Active custom snapshot SHA-256 digest mismatch: expected ${metadata.sha256}, got ${computedSha}`
          return
        }
      } catch (err) {
        this.#recoveryError = `Failed to compute custom snapshot digest: ${err instanceof Error ? err.message : String(err)}`
        return
      }

      // Adopt snapshot into manager
      try {
        await this.#customSnapshotManager.adoptPublishedSnapshot(metadata.snapshotId, {
          identity: metadata.identity,
          publishedPath: snapPath,
          sha256: metadata.sha256,
          byteSize: metadata.byteSize,
          schemaVersion: metadata.schemaVersion,
        })
      } catch (err) {
        this.#recoveryError = `Failed to adopt published snapshot: ${err instanceof Error ? err.message : String(err)}`
        return
      }

      // Open snapshot dictionary with lease
      let openedDict: Dictionary | null = null
      try {
        openedDict = this.#customSnapshotManager.openSnapshotDictionary(metadata.snapshotId)
        for (const probe of ACTIVATION_PROBE_HEADWORDS) {
          openedDict.lookup(probe)
        }
      } catch (error) {
        if (openedDict) {
          try { openedDict.close() } catch {}
        }
        this.#recoveryError = `Corrupt or incompatible custom snapshot database: ${error instanceof Error ? error.message : String(error)}`
        return
      }

      if (userMode === 'custom' || (userMode === 'fixture' && settingsSyncFailed)) {
        try {
          this.#manager.activate({
            mode: 'custom',
            identity: metadata.identity,
            dictionary: openedDict,
          })
          this.#activeSnapshotId = metadata.snapshotId

          if (settingsSyncFailed) {
            const retryState = await this.#persistHostConfigMode('custom')
            if (retryState === 'synced') {
              try {
                await writeActiveMetadataAtomically(this.#paths, {
                  ...metadata,
                  settingsSynced: true,
                  settingsSyncState: 'synced',
                  settingsSyncError: null,
                })
              } catch {}
            }
          }
        } catch (error) {
          openedDict.close()
          this.#recoveryError = `Activation failed during startup: ${error instanceof Error ? error.message : String(error)}`
        }
      } else {
        openedDict.close()
      }
      return
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
  async activateManagedDatabase(
    buildResult: ManagedEcdictBuildResult,
    options?: { signal?: AbortSignal; onCommitBoundary?: () => void },
  ): Promise<void> {
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    if (!this.#paths) {
      throw new Error('Managed storage unavailable: cannot activate database')
    }

    const publishedPath = buildResult.path
    if (!existsSync(publishedPath)) {
      throw new Error(`Published database file not found at: ${publishedPath}`)
    }

    if (activationHooks?.beforeReadMetadata) {
      await activationHooks.beforeReadMetadata()
    }
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    // Capture previous metadata before attempting activation
    let previousMetadata: ActiveMetadata | null = null
    try {
      previousMetadata = await readActiveMetadata(this.#paths)
    } catch {
      // previous metadata missing or invalid
    }

    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
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

    if (activationHooks?.beforeCommitMetadata) {
      await activationHooks.beforeCommitMetadata()
    }
    if (signal?.aborted || this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
      publishedDict.close()
      const err = new Error(
        this.#disposed || this.#manager.snapshot().lifecycle === 'closed'
          ? 'Activation cancelled: coordinator is disposed or manager is closed'
          : 'The operation was aborted',
      )
      err.name = 'AbortError'
      throw err
    }

    options?.onCommitBoundary?.()

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
      settingsSyncState: 'pending',
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
      if (this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
        throw new Error('Activation cancelled: coordinator is disposed or manager is closed')
      }
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

      if (activationHooks?.duringRollbackCompensation) {
        try {
          await activationHooks.duringRollbackCompensation()
        } catch {
          // ignore hook error to proceed with compensation
        }
      }

      // Rollback compensation: restore previous active metadata
      if (previousMetadata !== null) {
        try {
          await writeActiveMetadataAtomically(this.#paths, previousMetadata)
        } catch (rollbackErr) {
          const origMsg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
          const rollbackMsg = sanitizeErrorMessage(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))
          this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`
          throw new ActivationRollbackError(
            `Activation failed (${origMsg}) and rollback of previous active metadata also failed: ${rollbackMsg}`,
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
    this.#activeSnapshotId = null
    this.#recoveryError = null

    // Persist installed ECDICT inventory record independently
    const installedMeta: InstalledEcdictMetadata = {
      version: 1,
      identity: buildResult.identity,
      databaseFile: buildResult.databaseFile,
      source: {
        name: 'ECDICT',
        commit: buildResult.sourceCommit,
        sha256: buildResult.sourceSha256,
        schemaVersion: buildResult.schemaVersion,
      },
      entryCount: buildResult.entryCount,
      formCount: buildResult.formCount,
      byteSize: buildResult.byteSize,
      installedAt: new Date().toISOString(),
    }
    try {
      await writeInstalledEcdictMetadataAtomically(this.#paths, installedMeta)
    } catch {
      // non-fatal
    }

    // 4. Best-effort Host Config persistence
    const syncState = await this.#persistHostConfigMode('managed-ecdict')

    // Persist final settings sync state into active.json
    try {
      await writeActiveMetadataAtomically(this.#paths, {
        ...metadata,
        settingsSynced: syncState === 'synced',
        settingsSyncState: syncState,
        settingsSyncError: this.#settingsSyncError,
      })
    } catch {
      // non-fatal
    }
  }

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
  async activateCustomDatabase(
    snapshotId: string,
    options?: { signal?: AbortSignal; onCommitBoundary?: () => void },
  ): Promise<CustomActivationResult> {
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    if (!this.#paths) {
      throw new Error('Managed storage unavailable: cannot activate custom database')
    }
    if (!this.#customSnapshotManager) {
      throw new Error('Custom snapshot manager unavailable: cannot activate custom database')
    }

    if (typeof snapshotId !== 'string' || snapshotId.trim().length === 0) {
      throw new TypeError('snapshotId must be a non-empty string')
    }
    const cleanId = snapshotId.trim()

    const snapshot = this.#customSnapshotManager.getSnapshot(cleanId)
    if (!snapshot || !snapshot.publishedPath) {
      const error = new Error(`Snapshot not found: ${cleanId}`)
      ;(error as unknown as { code: string }).code = 'SNAPSHOT_NOT_FOUND'
      throw error
    }

    if (!existsSync(snapshot.publishedPath)) {
      const error = new Error(`Published snapshot file not found on disk: ${snapshot.publishedPath}`)
      ;(error as unknown as { code: string }).code = 'SNAPSHOT_NOT_FOUND'
      throw error
    }

    if (activationHooks?.beforeReadMetadata) {
      await activationHooks.beforeReadMetadata()
    }
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    // Capture previous metadata before attempting activation
    let previousMetadata: ActiveMetadata | null = null
    try {
      previousMetadata = await readActiveMetadata(this.#paths)
    } catch {
      // previous metadata missing or invalid
    }

    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    // 1. Open snapshot dictionary (leases candidate snapshot)
    const publishedDict = this.#customSnapshotManager.openSnapshotDictionary(cleanId)
    try {
      for (const probe of ACTIVATION_PROBE_HEADWORDS) {
        publishedDict.lookup(probe)
      }
    } catch (error) {
      publishedDict.close()
      throw new Error(
        `Custom snapshot probe verification failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    if (activationHooks?.beforeCommitMetadata) {
      await activationHooks.beforeCommitMetadata()
    }
    if (signal?.aborted || this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
      publishedDict.close()
      const err = new Error(
        this.#disposed || this.#manager.snapshot().lifecycle === 'closed'
          ? 'Activation cancelled: coordinator is disposed or manager is closed'
          : 'The operation was aborted',
      )
      err.name = 'AbortError'
      throw err
    }

    options?.onCommitBoundary?.()

    // 2. Commit metadata atomically
    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: snapshot.identity,
      snapshotId: cleanId,
      databaseFile: basename(snapshot.publishedPath),
      source: 'custom-local',
      schemaVersion: snapshot.schemaVersion ?? 1,
      sha256: snapshot.sha256 ?? '',
      byteSize: snapshot.byteSize ?? 0,
      lastActivatedAt: new Date().toISOString(),
      settingsSynced: false,
      settingsSyncState: 'pending',
      settingsSyncError: null,
    }

    try {
      await writeActiveMetadataAtomically(this.#paths, metadata)
    } catch (error) {
      publishedDict.close()
      throw new Error(
        `Failed to commit active metadata atomically: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    // 3. Atomically activate in DictionaryManager
    try {
      if (this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
        throw new Error('Activation cancelled: coordinator is disposed or manager is closed')
      }
      this.#manager.activate({
        mode: 'custom',
        identity: snapshot.identity,
        dictionary: publishedDict,
      })
    } catch (error) {
      try {
        publishedDict.close()
      } catch {
        // ignore
      }

      if (activationHooks?.duringRollbackCompensation) {
        try {
          await activationHooks.duringRollbackCompensation()
        } catch {
          // ignore hook error to proceed with compensation
        }
      }

      // Rollback compensation: restore previous active metadata
      if (previousMetadata !== null) {
        try {
          await writeActiveMetadataAtomically(this.#paths, previousMetadata)
        } catch (rollbackErr) {
          const origMsg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
          const rollbackMsg = sanitizeErrorMessage(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))
          this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`
          throw new ActivationRollbackError(
            `Activation failed (${origMsg}) and rollback of previous active metadata also failed: ${rollbackMsg}`,
            error,
            rollbackErr,
          )
        }
      } else {
        try {
          await unlink(this.#paths.activeMetadataPath)
        } catch {
          // best effort
        }
      }

      throw error
    }

    this.#activeSnapshotId = cleanId
    this.#recoveryError = null

    // 4. Best-effort Host Config persistence
    const syncState = await this.#persistHostConfigMode('custom')
    try {
      await writeActiveMetadataAtomically(this.#paths, {
        ...metadata,
        settingsSynced: syncState === 'synced',
        settingsSyncState: syncState,
        settingsSyncError: this.#settingsSyncError,
      })
    } catch {
      // non-fatal
    }

    return {
      snapshotId: cleanId,
      identity: snapshot.identity,
      activeMode: 'custom',
      generation: this.#manager.snapshot().generation,
    }
  }

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
  async selectMode(
    mode: DictionaryMode,
    options?: { snapshotId?: string; signal?: AbortSignal; onCommitBoundary?: () => void },
  ): Promise<ModeSelectionResult> {
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    if (!this.#paths) {
      throw new Error('Managed storage unavailable: cannot switch mode')
    }

    if (mode === 'custom') {
      const targetSnapshotId = options?.snapshotId?.trim() || this.#activeSnapshotId
      if (!targetSnapshotId) {
        const error = new Error('A snapshotId must be provided to switch to custom dictionary mode')
        ;(error as unknown as { code: string }).code = 'INVALID_ARGUMENT'
        throw error
      }
      const result = await this.activateCustomDatabase(targetSnapshotId, options)
      return {
        activeMode: 'custom',
        generation: result.generation,
      }
    }

    if (mode === 'managed-ecdict') {
      const installedMeta = await readInstalledEcdictMetadata(this.#paths)
      if (!installedMeta) {
        const error = new Error('ECDICT database is not installed')
        ;(error as unknown as { code: string }).code = 'ECDICT_NOT_INSTALLED'
        throw error
      }

      const dbPath = join(this.#paths.databaseDirectory, installedMeta.databaseFile)
      if (!existsSync(dbPath)) {
        const error = new Error(`Managed database file missing on disk: ${installedMeta.databaseFile}`)
        ;(error as unknown as { code: string }).code = 'ECDICT_NOT_INSTALLED'
        throw error
      }

      if (activationHooks?.beforeReadMetadata) {
        await activationHooks.beforeReadMetadata()
      }
      if (signal?.aborted) {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }

      let previousMetadata: ActiveMetadata | null = null
      try {
        previousMetadata = await readActiveMetadata(this.#paths)
      } catch {
        // ignore
      }

      const openedDict = openProductionDictionary({ path: dbPath })
      try {
        for (const probe of ACTIVATION_PROBE_HEADWORDS) {
          openedDict.lookup(probe)
        }
      } catch (err) {
        openedDict.close()
        throw new Error(`Managed database probe failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }

      if (activationHooks?.beforeCommitMetadata) {
        await activationHooks.beforeCommitMetadata()
      }
      if (signal?.aborted || this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
        openedDict.close()
        const err = new Error(
          this.#disposed || this.#manager.snapshot().lifecycle === 'closed'
            ? 'Activation cancelled: coordinator is disposed or manager is closed'
            : 'The operation was aborted',
        )
        err.name = 'AbortError'
        throw err
      }

      options?.onCommitBoundary?.()

      const metadata: ManagedActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: installedMeta.identity,
        databaseFile: installedMeta.databaseFile,
        source: installedMeta.source,
        lastActivatedAt: new Date().toISOString(),
        settingsSynced: false,
        settingsSyncState: 'pending',
        settingsSyncError: null,
      }

      try {
        await writeActiveMetadataAtomically(this.#paths, metadata)
      } catch (error) {
        openedDict.close()
        throw new Error(`Failed to commit active metadata atomically: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }

      try {
        if (this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
          throw new Error('Activation cancelled: coordinator is disposed or manager is closed')
        }
        this.#manager.activate({
          mode: 'managed-ecdict',
          identity: installedMeta.identity,
          dictionary: openedDict,
        })
      } catch (error) {
        try {
          openedDict.close()
        } catch {}

        if (activationHooks?.duringRollbackCompensation) {
          try {
            await activationHooks.duringRollbackCompensation()
          } catch {}
        }

        if (previousMetadata !== null) {
          try {
            await writeActiveMetadataAtomically(this.#paths, previousMetadata)
          } catch (rollbackErr) {
            const origMsg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
            const rollbackMsg = sanitizeErrorMessage(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))
            this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`
            throw new ActivationRollbackError(
              `Activation failed (${origMsg}) and rollback of previous active metadata also failed: ${rollbackMsg}`,
              error,
              rollbackErr,
            )
          }
        } else {
          try {
            await unlink(this.#paths.activeMetadataPath)
          } catch {}
        }

        throw error
      }

      this.#activeSnapshotId = null
      this.#recoveryError = null

      const syncState = await this.#persistHostConfigMode('managed-ecdict')
      try {
        await writeActiveMetadataAtomically(this.#paths, {
          ...metadata,
          settingsSynced: syncState === 'synced',
          settingsSyncState: syncState,
          settingsSyncError: this.#settingsSyncError,
        })
      } catch {}

      return {
        activeMode: 'managed-ecdict',
        generation: this.#manager.snapshot().generation,
      }
    }

    if (mode === 'fixture') {
      const fixtureDict = openFixtureDictionary()
      try {
        for (const probe of ACTIVATION_PROBE_HEADWORDS) {
          fixtureDict.lookup(probe)
        }
      } catch (err) {
        fixtureDict.close()
        throw err
      }

      if (activationHooks?.beforeReadMetadata) {
        await activationHooks.beforeReadMetadata()
      }
      if (signal?.aborted) {
        fixtureDict.close()
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }

      let previousMetadata: ActiveMetadata | null = null
      try {
        previousMetadata = await readActiveMetadata(this.#paths)
      } catch {}

      if (activationHooks?.beforeCommitMetadata) {
        await activationHooks.beforeCommitMetadata()
      }
      if (signal?.aborted || this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
        fixtureDict.close()
        const err = new Error(
          this.#disposed || this.#manager.snapshot().lifecycle === 'closed'
            ? 'Activation cancelled: coordinator is disposed or manager is closed'
            : 'The operation was aborted',
        )
        err.name = 'AbortError'
        throw err
      }

      options?.onCommitBoundary?.()

      // Unlink active.json (for fixture mode)
      try {
        await unlink(this.#paths.activeMetadataPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          fixtureDict.close()
          throw err
        }
      }

      try {
        if (this.#disposed || this.#manager.snapshot().lifecycle === 'closed') {
          throw new Error('Activation cancelled: coordinator is disposed or manager is closed')
        }
        this.#manager.activate({
          mode: 'fixture',
          identity: 'fixture',
          dictionary: fixtureDict,
        })
      } catch (error) {
        try {
          fixtureDict.close()
        } catch {}

        if (previousMetadata !== null) {
          try {
            await writeActiveMetadataAtomically(this.#paths, previousMetadata)
          } catch (rollbackErr) {
            const origMsg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
            const rollbackMsg = sanitizeErrorMessage(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))
            this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`
            throw new ActivationRollbackError(
              `Activation failed (${origMsg}) and rollback of previous active metadata also failed: ${rollbackMsg}`,
              error,
              rollbackErr,
            )
          }
        }
        throw error
      }

      this.#activeSnapshotId = null
      this.#recoveryError = null

      await this.#persistHostConfigMode('fixture')

      return {
        activeMode: 'fixture',
        generation: this.#manager.snapshot().generation,
      }
    }

    throw new Error(`Unsupported dictionary mode: "${String(mode)}"`)
  }

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
  async removeManagedDatabase(): Promise<{ removed: boolean; activeMode: 'fixture' | 'custom' }> {
    const currentActiveMode = this.#manager.snapshot().activeMode

    if (currentActiveMode === 'custom') {
      // Custom is active: do NOT hot-switch to fixture! Custom remains active!
      if (!this.#paths) {
        this.#cachedInstalledCorpus = null
        return { removed: false, activeMode: 'custom' }
      }

      // Read installed-ecdict.json to identify file to delete
      let installedMeta: InstalledEcdictMetadata | null = null
      try {
        installedMeta = await readInstalledEcdictMetadata(this.#paths)
      } catch {}

      // Unlink installed-ecdict.json
      await removeInstalledEcdictMetadata(this.#paths)

      // Unlink managed ECDICT database file if known
      const dbFile = installedMeta?.databaseFile ?? this.#cachedInstalledCorpus?.databaseFile
      if (dbFile) {
        const dbPath = join(this.#paths.databaseDirectory, dbFile)
        try {
          await unlink(dbPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }

      // Clean stale temporary files
      await removeStaleTemporaryArtifacts(this.#paths)

      // Reset cached installed corpus
      this.#cachedInstalledCorpus = null

      return { removed: true, activeMode: 'custom' }
    }

    // Active mode is managed-ecdict or fixture: hot-switch to fixture
    const fixture = openFixtureDictionary()
    this.#manager.activate({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: fixture,
    })

    if (!this.#paths) {
      this.#cachedInstalledCorpus = null
      this.#recoveryError = null
      this.#settingsSyncState = 'pending'
      this.#settingsSyncError = null
      this.#lastRollbackError = null
      await this.#persistHostConfigMode('fixture')
      return { removed: false, activeMode: 'fixture' }
    }

    // Read current metadata to identify file
    let currentMetadata: ActiveMetadata | null = null
    try {
      currentMetadata = await readActiveMetadata(this.#paths)
    } catch {}

    let installedMeta: InstalledEcdictMetadata | null = null
    try {
      installedMeta = await readInstalledEcdictMetadata(this.#paths)
    } catch {}

    // Unlink active.json
    try {
      await unlink(this.#paths.activeMetadataPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    // Unlink installed-ecdict.json
    await removeInstalledEcdictMetadata(this.#paths)

    // Unlink database file if known
    const dbFile =
      (currentMetadata?.activeMode === 'managed-ecdict' ? currentMetadata.databaseFile : null) ??
      installedMeta?.databaseFile ??
      this.#cachedInstalledCorpus?.databaseFile

    if (dbFile) {
      const dbPath = join(this.#paths.databaseDirectory, dbFile)
      try {
        await unlink(dbPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    // Clean stale temporary files
    await removeStaleTemporaryArtifacts(this.#paths)

    // Reset cached state
    this.#cachedInstalledCorpus = null
    this.#recoveryError = null
    this.#settingsSyncState = 'pending'
    this.#settingsSyncError = null
    this.#lastRollbackError = null

    // Best-effort update Host Config to fixture
    await this.#persistHostConfigMode('fixture')

    return { removed: true, activeMode: 'fixture' }
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

    const activeSnapshotId = this.#activeSnapshotId
    const customSnapshotStatus =
      activeSnapshotId && this.#customSnapshotManager
        ? {
            snapshotId: activeSnapshotId,
            activeLeases: this.#customSnapshotManager.getActiveLeases(activeSnapshotId),
          }
        : null

    return Object.freeze({
      activeMode: snap.activeMode,
      configuredMode,
      activeSource: snap.source,
      activeIdentity: snap.identity,
      activeSnapshotId,
      customSnapshotStatus,
      installed: isInstalled,
      installedCorpus: this.#cachedInstalledCorpus,
      fixtureStats: Object.freeze({
        entryCount: FIXTURE_ENTRIES.length,
        formCount: FIXTURE_FORMS.length,
        version: FIXTURE_VERSION,
      }),
      quarantined: quarantineRecord !== null,
      quarantineReason: quarantineRecord?.reason ?? null,
      recoveryError: this.#recoveryError,
      settingsSyncState: this.#settingsSyncState,
      settingsSyncError: this.#settingsSyncError,
      lastRetirementError: snap.lastRetirementError,
      lastRollbackError: this.#lastRollbackError,
      generation: snap.generation,
    })
  }

  /**
   * Best-effort persistence of dictionaryMode to Host settings.
   */
  async #persistHostConfigMode(mode: DictionaryMode): Promise<SettingsSyncState> {
    const settings = (this.#ctx as { get?: (s: string) => { update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown> } } | undefined)?.get?.('settings')
    if (!settings || typeof settings.update !== 'function') {
      // Settings service not present on context: distinguish clearly as 'unavailable'
      this.#settingsSyncState = 'unavailable'
      return 'unavailable'
    }
    try {
      await settings.update('dsh-word-lookup', { dictionaryMode: mode })
      this.#settingsSyncState = 'synced'
      this.#settingsSyncError = null
      return 'synced'
    } catch (err) {
      // Non-fatal: settings persistence failure does not roll back active state
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
      this.#settingsSyncState = 'failed'
      this.#settingsSyncError = `Settings update failed: ${msg}`
      return 'failed'
    }
  }
}
