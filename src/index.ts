/**
 * Host half of `dsh-word-lookup` (`exports "."`).
 *
 * Loaded by the DSH host Loader as a normal entry and activated with the parsed
 * {@link Config} output. It contributes exactly two things:
 *
 * 1. `Config` — the schema the settings service projects to the browser. It is a
 *    module-level export read from `entry.fiber.runtime.Config`; there is no
 *    config class and no `ctx.config` service in this DSH generation.
 * 2. one exact Fetch route `POST /api/dsh-word-lookup`, registered on the
 *    `connection` service inside a single `ctx.effect`.
 *
 * `connection.rpc.handle` and `connection.rpc.intercept('/api', …)` are
 * deliberately unused: the interceptor slot on `/api` is held by
 * `dsh-api-gateway` in the shipped Web composition, so a second registration
 * throws at plugin load, and `rpc.handle` has no first-party call site to model
 * against.
 *
 * **Phase 3 lifecycle.** The route is answered by a real local SQLite
 * dictionary, and this module owns it. One `ctx.effect` opens the database,
 * registers the route, and returns a disposer that unregisters the route and
 * closes the database — in that order, and `close()` is idempotent, so a load/
 * unload cycle cannot accumulate handles. The open happens before the
 * registration so that a dictionary that cannot be opened fails the load
 * outright instead of leaving a route whose every request answers 500.
 *
 * The database path is not configuration. It is derived from this package's own
 * location by `resolveFixtureDatabasePath`; see `src/host/fixture-db.ts` for why
 * Phase 3 deliberately adds no `dictionaryPath` setting.
 *
 * This module is imported by the Node host process and must never reach a
 * browser-only dependency. The browser half lives behind `exports "./client"` and
 * shares only the type-only contract in `src/shared/protocol.ts`.
 *
 * @module dsh-word-lookup
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.connection` declaration into the program without
// importing a runtime value from the connection package.
import type {} from '@deepseek-ai/dsh-client-connection'

import { Config, type HostConfig } from './host/config.js'
import {
  openProductionDictionary,
  resolveProductionDatabasePath,
} from './host/corpus-db.js'
import { DictionaryUnavailableError } from './host/dictionary.js'
import {
  DictionaryManager,
  type DictionaryActivation,
  type DictionaryActivationResult,
  type DictionaryManagerSnapshot,
} from './host/dictionary-manager.js'
import { openFixtureDictionary } from './host/fixture-db.js'
import { createLookupHandler } from './host/lookup.js'
import {
  ensureManagedStorageDirectories,
  managedDatabaseFileName,
  managedDatabasePath,
  readActiveMetadata,
  readInstalledEcdictMetadata,
  removeInstalledEcdictMetadata,
  removeStaleTemporaryArtifacts,
  resolveDshHomeFromContext,
  resolveManagedStoragePaths,
  validateActiveMetadata,
  validateCustomSnapshotPath,
  validateInstalledEcdictMetadata,
  writeActiveMetadataAtomically,
  writeInstalledEcdictMetadataAtomically,
  STAGING_SNAPSHOT_FILENAME_PATTERN,
  PUBLISHED_SNAPSHOT_FILENAME_PATTERN,
  CUSTOM_SNAPSHOT_FILENAME_PATTERN,
  type ActiveMetadata,
  type CustomActiveMetadata,
  type InstalledEcdictMetadata,
  type ManagedActiveMetadata,
  type ActiveMetadataSource,
  type ManagedStoragePaths,
  type ResolveManagedStorageOptions,
  type SettingsSyncState,
} from './host/managed-storage.js'
import {
  CustomDictionaryValidator,
  ValidatorCancelledError,
  ValidatorCrashError,
  ValidatorDisposedError,
  ValidatorExecutionError,
  ValidatorTimeoutError,
  type CustomDictionaryValidatorOptions,
  type CustomValidatorTaskOptions,
} from './host/custom-dictionary-validator.js'
import {
  CustomSnapshotManager,
  SnapshotTamperingError,
  SnapshotActiveReferenceError,
  SnapshotPublishConflictError,
  SnapshotCleanupError,
  _setCustomSnapshotHooksForTesting,
  _getHostProcessInstanceIdForTesting,
  _resetActiveManagersForTesting,
  type CustomSnapshotManagerOptions,
  type CustomSnapshotRecord,
  type SnapshotPublishOptions,
  type SnapshotState,
  type StagingOwnershipPayload,
  type StagingCleanupOptions,
} from './host/custom-snapshot-manager.js'
import {
  descriptorToActiveMetadataSource,
  loadPinnedEcdictSourceDescriptor,
  type EcdictSourceDescriptor,
} from './host/ecdict-source.js'
import {
  downloadPinnedEcdict,
  verifyCachedEcdictSource,
  EcdictDownloadInProgressError,
  type DownloadPinnedEcdictOptions,
  type EcdictDownloadProgress,
  type EcdictDownloadProgressCallback,
  type EcdictDownloadProgressPhase,
  type EcdictDownloadResult,
} from './host/ecdict-downloader.js'
import {
  buildManagedEcdictDatabase,
  EcdictImportInProgressError,
  type BuildManagedEcdictDatabaseOptions,
  type EcdictImportProgress,
  type EcdictImportProgressCallback,
  type EcdictImportProgressPhase,
  type ManagedEcdictBuildResult,
  type PostPublicationCleanupResult,
} from './host/ecdict-importer.js'
import {
  LOOKUP_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
} from './host/route.js'
import {
  ActivationCoordinator,
  ActivationRollbackError,
  type ActivationCoordinatorOptions,
  type ActivationStateSummary,
  type CustomDatabaseVerificationResult,
  type CustomActivationResult,
  type ModeSelectionResult,
} from './host/dictionary-activation.js'
import {
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationDrainTimeoutError,
  type OperationDrainSummary,
  OperationInProgressError,
  OperationNotCancellableError,
  OperationNotFoundError,
  sanitizeErrorMessage,
  type DictionaryOperationManagerOptions,
} from './host/dictionary-operations.js'
import {
  registerDictionaryManagementRoutes,
  createStatusHandler,
  createInstallHandler,
  createCancelHandler,
  createRemoveHandler,
  createVerifyHandler,
  createActivateCustomHandler,
  createSelectModeHandler,
} from './host/dictionary-management-route.js'
import type {
  DictionaryActivateCustomRequest,
  DictionaryActivateCustomResponse,
  DictionaryCancelRequest,
  DictionaryCancelResponse,
  DictionaryErrorResponse,
  DictionaryInstallResponse,
  DictionaryOperationError,
  DictionaryOperationPhase,
  DictionaryOperationProgress,
  DictionaryOperationSnapshot,
  DictionaryOperationStatus,
  DictionaryRemoveResponse,
  DictionarySelectModeRequest,
  DictionarySelectModeResponse,
  DictionaryStatusResponse,
  DictionaryVerifyRequest,
  DictionaryVerifyResponse,
  InstalledCorpusInfo,
  ManagementErrorCode,
} from './shared/dictionary-management-protocol.js'

export { Config }
export type { HostConfig }
export {
  openFixtureDictionary,
  openProductionDictionary,
  resolveProductionDatabasePath,
  DictionaryUnavailableError,
  DictionaryManager,
  type DictionaryActivation,
  type DictionaryActivationResult,
  type DictionaryManagerSnapshot,
  ensureManagedStorageDirectories,
  managedDatabaseFileName,
  managedDatabasePath,
  readActiveMetadata,
  readInstalledEcdictMetadata,
  removeInstalledEcdictMetadata,
  removeStaleTemporaryArtifacts,
  resolveDshHomeFromContext,
  resolveManagedStoragePaths,
  validateActiveMetadata,
  validateInstalledEcdictMetadata,
  writeActiveMetadataAtomically,
  writeInstalledEcdictMetadataAtomically,
  type ActiveMetadata,
  type CustomActiveMetadata,
  type InstalledEcdictMetadata,
  type ManagedActiveMetadata,
  type ActiveMetadataSource,
  type ManagedStoragePaths,
  type ResolveManagedStorageOptions,
  type SettingsSyncState,
  descriptorToActiveMetadataSource,
  loadPinnedEcdictSourceDescriptor,
  type EcdictSourceDescriptor,
  downloadPinnedEcdict,
  verifyCachedEcdictSource,
  EcdictDownloadInProgressError,
  type DownloadPinnedEcdictOptions,
  type EcdictDownloadProgress,
  type EcdictDownloadProgressCallback,
  type EcdictDownloadProgressPhase,
  type EcdictDownloadResult,
  buildManagedEcdictDatabase,
  EcdictImportInProgressError,
  type BuildManagedEcdictDatabaseOptions,
  type EcdictImportProgress,
  type EcdictImportProgressCallback,
  type EcdictImportProgressPhase,
  type ManagedEcdictBuildResult,
  type PostPublicationCleanupResult,
  LOOKUP_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
  ActivationCoordinator,
  ActivationRollbackError,
  type ActivationCoordinatorOptions,
  type ActivationStateSummary,
  type CustomDatabaseVerificationResult,
  type CustomActivationResult,
  type ModeSelectionResult,
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationDrainTimeoutError,
  type OperationDrainSummary,
  OperationInProgressError,
  OperationNotCancellableError,
  OperationNotFoundError,
  sanitizeErrorMessage,
  type DictionaryOperationManagerOptions,
  registerDictionaryManagementRoutes,
  createStatusHandler,
  createInstallHandler,
  createCancelHandler,
  createRemoveHandler,
  createVerifyHandler,
  createActivateCustomHandler,
  createSelectModeHandler,
  createLookupHandler,
  type DictionaryActivateCustomRequest,
  type DictionaryActivateCustomResponse,
  type DictionaryCancelRequest,
  type DictionaryCancelResponse,
  type DictionaryErrorResponse,
  type DictionaryInstallResponse,
  type DictionaryOperationError,
  type DictionaryOperationPhase,
  type DictionaryOperationProgress,
  type DictionaryOperationSnapshot,
  type DictionaryOperationStatus,
  type DictionaryRemoveResponse,
  type DictionarySelectModeRequest,
  type DictionarySelectModeResponse,
  type DictionaryStatusResponse,
  type DictionaryVerifyRequest,
  type DictionaryVerifyResponse,
  type InstalledCorpusInfo,
  type ManagementErrorCode,
  validateCustomSnapshotPath,
  STAGING_SNAPSHOT_FILENAME_PATTERN,
  PUBLISHED_SNAPSHOT_FILENAME_PATTERN,
  CUSTOM_SNAPSHOT_FILENAME_PATTERN,
  CustomDictionaryValidator,
  ValidatorCancelledError,
  ValidatorCrashError,
  ValidatorDisposedError,
  ValidatorExecutionError,
  ValidatorTimeoutError,
  type CustomDictionaryValidatorOptions,
  type CustomValidatorTaskOptions,
  CustomSnapshotManager,
  SnapshotTamperingError,
  SnapshotActiveReferenceError,
  SnapshotPublishConflictError,
  SnapshotCleanupError,
  _setCustomSnapshotHooksForTesting,
  _getHostProcessInstanceIdForTesting,
  _resetActiveManagersForTesting,
  type CustomSnapshotManagerOptions,
  type CustomSnapshotRecord,
  type SnapshotPublishOptions,
  type SnapshotState,
  type StagingOwnershipPayload,
  type StagingCleanupOptions,
}

/** Package name; equals the Loader entry id and the settings namespace. */
export const name = 'dsh-word-lookup'

/** Host services required before this entry activates. */
export const inject: readonly string[] = ['connection']

/**
 * Register the host contributions.
 *
 * One effect owns the whole host surface, so unloading the loader entry closes
 * the database, safely aborts and drains in-flight operations, and unregisters all
 * Fetch routes.
 *
 * @param ctx - the host plugin context.
 * @param config - the parsed {@link Config} output for this loader entry.
 */
export function apply(ctx: Context, config: HostConfig): void {
  ctx.effect(() => {
    let paths: ManagedStoragePaths | null = null
    try {
      paths = resolveManagedStoragePaths({ ctx })
    } catch {
      // In minimal test harnesses or environments where DSH home is not supplied,
      // paths remains null and host gracefully operates in fixture-only mode.
    }

    const fixture = openFixtureDictionary()
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: fixture,
    })

    const coordinator = new ActivationCoordinator({
      ctx,
      paths,
      manager,
      config,
    })

    const operationManager = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
      logger: (ctx as { logger?: DictionaryOperationManagerOptions['logger'] }).logger,
    })

    if ((ctx as { _testInstances?: unknown })._testInstances) {
      Object.assign((ctx as unknown as { _testInstances: Record<string, unknown> })._testInstances, {
        manager,
        coordinator,
        operationManager,
      })
    }

    // Initiate startup recovery check
    const recoveryPromise = coordinator.recoverOnStartup().catch(() => {
      // Recovery errors are tracked inside coordinator diagnostic state
    })

    let disposeManagement: (() => Promise<void>) | undefined
    let disposeLookup: (() => Promise<void>) | undefined

    try {
      // 1. Register five dictionary management routes
      disposeManagement = registerDictionaryManagementRoutes(ctx, operationManager, coordinator)

      // 2. Register lookup route
      disposeLookup = ctx.connection.fetch.register({
        path: LOOKUP_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createLookupHandler(config, manager),
      })
    } catch (error) {
      try { void disposeManagement?.() } catch { /* ignore */ }
      try { void disposeLookup?.() } catch { /* ignore */ }
      void operationManager.dispose()
      void coordinator.dispose()
      manager.close()
      throw error
    }

    return async () => {
      try {
        await recoveryPromise
      } catch {
        // ignore
      }

      const errors: unknown[] = []
      try {
        await disposeLookup?.()
      } catch (err) {
        errors.push(err)
      }
      try {
        await disposeManagement?.()
      } catch (err) {
        errors.push(err)
      }

      let drained = false
      try {
        const drainTimeoutMs = (ctx as { drainTimeoutMs?: number }).drainTimeoutMs ?? 5000
        await operationManager.dispose(drainTimeoutMs)
        drained = true
      } catch (err) {
        errors.push(err)
      }

      try {
        await coordinator.dispose()
      } catch (err) {
        errors.push(err)
      }

      if (drained && !operationManager.isBusy()) {
        try {
          manager.close()
        } catch (err) {
          errors.push(err)
        }
      } else {
        // Drain timed out or operations are still in flight.
        // DO NOT close manager now: in-flight operations may still be referencing or dependent on manager.
        // Premature manager closure is avoided, and deferred closure runs once in-flight tasks settle.
        void operationManager.whenSettled().finally(() => {
          try {
            manager.close()
          } catch (deferredErr) {
            console.warn('[dsh-word-lookup] Deferred dictionary manager close failed:', deferredErr)
          }
        })
      }

      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to cleanly unregister dsh-word-lookup routes and manager')
      }
    }
  }, 'dsh-word-lookup: local sqlite dictionary, exact fetch route and dictionary management api')
}
