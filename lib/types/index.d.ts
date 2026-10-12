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
import type { Context } from '@deepseek-ai/cordis';
import { Config, type HostConfig } from './host/config.js';
import { openProductionDictionary, resolveProductionDatabasePath } from './host/corpus-db.js';
import { DictionaryUnavailableError } from './host/dictionary.js';
import { DictionaryManager, type DictionaryActivation, type DictionaryActivationResult, type DictionaryManagerSnapshot } from './host/dictionary-manager.js';
import { openFixtureDictionary } from './host/fixture-db.js';
import { createLookupHandler } from './host/lookup.js';
import { ensureManagedStorageDirectories, managedDatabaseFileName, managedDatabasePath, readActiveMetadata, removeStaleTemporaryArtifacts, resolveDshHomeFromContext, resolveManagedStoragePaths, validateActiveMetadata, writeActiveMetadataAtomically, type ActiveMetadata, type ActiveMetadataSource, type ManagedStoragePaths, type ResolveManagedStorageOptions } from './host/managed-storage.js';
import { descriptorToActiveMetadataSource, loadPinnedEcdictSourceDescriptor, type EcdictSourceDescriptor } from './host/ecdict-source.js';
import { downloadPinnedEcdict, verifyCachedEcdictSource, EcdictDownloadInProgressError, type DownloadPinnedEcdictOptions, type EcdictDownloadProgress, type EcdictDownloadProgressCallback, type EcdictDownloadProgressPhase, type EcdictDownloadResult } from './host/ecdict-downloader.js';
import { buildManagedEcdictDatabase, EcdictImportInProgressError, type BuildManagedEcdictDatabaseOptions, type EcdictImportProgress, type EcdictImportProgressCallback, type EcdictImportProgressPhase, type ManagedEcdictBuildResult, type PostPublicationCleanupResult } from './host/ecdict-importer.js';
import { LOOKUP_PATH, MANAGEMENT_CANCEL_PATH, MANAGEMENT_INSTALL_PATH, MANAGEMENT_REMOVE_PATH, MANAGEMENT_STATUS_PATH, MANAGEMENT_VERIFY_PATH } from './host/route.js';
import { ActivationCoordinator, type ActivationCoordinatorOptions, type ActivationStateSummary, type CustomDatabaseVerificationResult } from './host/dictionary-activation.js';
import { DictionaryOperationManager, OperationDirectoryQuarantinedError, OperationInProgressError, OperationNotFoundError, sanitizeErrorMessage, type DictionaryOperationManagerOptions } from './host/dictionary-operations.js';
import { registerDictionaryManagementRoutes, createStatusHandler, createInstallHandler, createCancelHandler, createRemoveHandler, createVerifyHandler } from './host/dictionary-management-route.js';
import type { DictionaryCancelRequest, DictionaryCancelResponse, DictionaryErrorResponse, DictionaryInstallResponse, DictionaryOperationError, DictionaryOperationPhase, DictionaryOperationProgress, DictionaryOperationSnapshot, DictionaryOperationStatus, DictionaryRemoveResponse, DictionaryStatusResponse, DictionaryVerifyRequest, DictionaryVerifyResponse, InstalledCorpusInfo, ManagementErrorCode } from './shared/dictionary-management-protocol.js';
export { Config };
export type { HostConfig };
export { openFixtureDictionary, openProductionDictionary, resolveProductionDatabasePath, DictionaryUnavailableError, DictionaryManager, type DictionaryActivation, type DictionaryActivationResult, type DictionaryManagerSnapshot, ensureManagedStorageDirectories, managedDatabaseFileName, managedDatabasePath, readActiveMetadata, removeStaleTemporaryArtifacts, resolveDshHomeFromContext, resolveManagedStoragePaths, validateActiveMetadata, writeActiveMetadataAtomically, type ActiveMetadata, type ActiveMetadataSource, type ManagedStoragePaths, type ResolveManagedStorageOptions, descriptorToActiveMetadataSource, loadPinnedEcdictSourceDescriptor, type EcdictSourceDescriptor, downloadPinnedEcdict, verifyCachedEcdictSource, EcdictDownloadInProgressError, type DownloadPinnedEcdictOptions, type EcdictDownloadProgress, type EcdictDownloadProgressCallback, type EcdictDownloadProgressPhase, type EcdictDownloadResult, buildManagedEcdictDatabase, EcdictImportInProgressError, type BuildManagedEcdictDatabaseOptions, type EcdictImportProgress, type EcdictImportProgressCallback, type EcdictImportProgressPhase, type ManagedEcdictBuildResult, type PostPublicationCleanupResult, LOOKUP_PATH, MANAGEMENT_CANCEL_PATH, MANAGEMENT_INSTALL_PATH, MANAGEMENT_REMOVE_PATH, MANAGEMENT_STATUS_PATH, MANAGEMENT_VERIFY_PATH, ActivationCoordinator, type ActivationCoordinatorOptions, type ActivationStateSummary, type CustomDatabaseVerificationResult, DictionaryOperationManager, OperationDirectoryQuarantinedError, OperationInProgressError, OperationNotFoundError, sanitizeErrorMessage, type DictionaryOperationManagerOptions, registerDictionaryManagementRoutes, createStatusHandler, createInstallHandler, createCancelHandler, createRemoveHandler, createVerifyHandler, createLookupHandler, type DictionaryCancelRequest, type DictionaryCancelResponse, type DictionaryErrorResponse, type DictionaryInstallResponse, type DictionaryOperationError, type DictionaryOperationPhase, type DictionaryOperationProgress, type DictionaryOperationSnapshot, type DictionaryOperationStatus, type DictionaryRemoveResponse, type DictionaryStatusResponse, type DictionaryVerifyRequest, type DictionaryVerifyResponse, type InstalledCorpusInfo, type ManagementErrorCode, };
/** Package name; equals the Loader entry id and the settings namespace. */
export declare const name = "dsh-word-lookup";
/** Host services required before this entry activates. */
export declare const inject: readonly string[];
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
export declare function apply(ctx: Context, config: HostConfig): void;
