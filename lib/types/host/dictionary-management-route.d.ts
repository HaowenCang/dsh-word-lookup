/**
 * HTTP request handlers and route registration for dictionary management endpoints.
 *
 * Implements Phase 7A.6 Host Management API:
 * - GET  /api/dsh-word-lookup/dictionary/status
 * - POST /api/dsh-word-lookup/dictionary/install
 * - POST /api/dsh-word-lookup/dictionary/cancel
 * - POST /api/dsh-word-lookup/dictionary/remove
 * - POST /api/dsh-word-lookup/dictionary/verify
 *
 * Security and invariants:
 * - Pure handlers: (Request) => Promise<Response>, fully unit-testable without live DSH instance.
 * - Enforces content-type, method, and request body size ceiling (<= 64 KiB).
 * - Sanitizes all error messages to eliminate local filesystem paths and credentials.
 * - Fail-closed: handles all unexpected exceptions with structured JSON error responses (no raw stack traces).
 * - Full rollback on registration failures.
 *
 * @module dsh-word-lookup/host/dictionary-management-route
 */
import type { Context } from '@deepseek-ai/cordis';
import { DictionaryOperationManager } from './dictionary-operations.js';
import type { ActivationCoordinator } from './dictionary-activation.js';
/**
 * Create handler for GET /api/dsh-word-lookup/dictionary/status.
 */
export declare function createStatusHandler(operationManager: DictionaryOperationManager, activationCoordinator: ActivationCoordinator): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/install.
 */
export declare function createInstallHandler(operationManager: DictionaryOperationManager): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/cancel.
 */
export declare function createCancelHandler(operationManager: DictionaryOperationManager): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/remove.
 */
export declare function createRemoveHandler(operationManager: DictionaryOperationManager, activationCoordinator: ActivationCoordinator): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/activate-custom.
 */
export declare function createActivateCustomHandler(operationManager: DictionaryOperationManager): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/select-mode.
 */
export declare function createSelectModeHandler(operationManager: DictionaryOperationManager): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/verify.
 */
export declare function createVerifyHandler(activationCoordinator: ActivationCoordinator): (req: Request) => Promise<Response>;
/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/remove-custom.
 */
export declare function createRemoveCustomHandler(operationManager: DictionaryOperationManager): (req: Request) => Promise<Response>;
/**
 * Register all eight dictionary management Fetch routes onto `ctx.connection.fetch`.
 *
 * Implements atomic registration: if any route registration throws, all previously
 * registered routes in this batch are safely unregistered before the error propagates.
 *
 * @param ctx - host Cordis context providing `connection` service.
 * @param operationManager - active operation manager.
 * @param activationCoordinator - active activation coordinator.
 * @returns unified async disposer unregistering all eight management routes.
 */
export declare function registerDictionaryManagementRoutes(ctx: Context, operationManager: DictionaryOperationManager, activationCoordinator: ActivationCoordinator): () => Promise<void>;
