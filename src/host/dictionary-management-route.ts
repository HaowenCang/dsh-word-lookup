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

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

import {
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
} from './route.js'
import {
  MAX_MANAGEMENT_REQUEST_BYTES,
  type DictionaryCancelResponse,
  type DictionaryErrorResponse,
  type DictionaryInstallResponse,
  type DictionaryRemoveResponse,
  type DictionaryStatusResponse,
  type DictionaryVerifyResponse,
  type ManagementErrorCode,
} from '../shared/dictionary-management-protocol.js'
import {
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationInProgressError,
  OperationNotFoundError,
  sanitizeErrorMessage,
} from './dictionary-operations.js'
import type { ActivationCoordinator } from './dictionary-activation.js'

/** Standard headers for all management API responses. */
const MANAGEMENT_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
})

/**
 * Build a successful JSON response with standard headers.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: MANAGEMENT_RESPONSE_HEADERS,
  })
}

/**
 * Build a structured machine-readable error response.
 */
function errorResponse(
  status: number,
  error: ManagementErrorCode,
  rawMessage: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  const body: DictionaryErrorResponse = {
    ok: false,
    error,
    message: sanitizeErrorMessage(rawMessage),
    ...(details ? { details } : {}),
  }
  return Response.json(body, {
    status,
    headers: MANAGEMENT_RESPONSE_HEADERS,
  })
}

/**
 * Safely parse a buffered JSON request body with size and schema limits.
 */
async function parseJsonBody(
  req: Request,
  maxBytes = MAX_MANAGEMENT_REQUEST_BYTES,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: ManagementErrorCode; message: string }
> {
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10)
    if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: 'BODY_TOO_LARGE',
        message: `Request body exceeds maximum limit of ${maxBytes} bytes`,
      }
    }
  }

  const contentType = req.headers.get('content-type')
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      status: 415,
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type must be application/json',
    }
  }

  let text: string
  try {
    text = await req.text()
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: 'BAD_REQUEST',
      message: `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (new TextEncoder().encode(text).length > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: 'BODY_TOO_LARGE',
      message: `Request body exceeds maximum limit of ${maxBytes} bytes`,
    }
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: true, data: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return {
      ok: false,
      status: 400,
      error: 'BAD_REQUEST',
      message: `Malformed JSON in request body: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      error: 'BAD_REQUEST',
      message: 'Request body must be a JSON object',
    }
  }

  return { ok: true, data: parsed as Record<string, unknown> }
}

/**
 * Create handler for GET /api/dsh-word-lookup/dictionary/status.
 */
export function createStatusHandler(
  operationManager: DictionaryOperationManager,
  activationCoordinator: ActivationCoordinator,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'GET') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed (expected GET)')
    }

    try {
      const summary = activationCoordinator.getStatusSummary()
      const currentOp = operationManager.getCurrentOperation()
      const lastOp = operationManager.getLastOperation()

      const canInstall = operationManager.canInstall()
      const canCancel = operationManager.canCancel()
      const canRemove = !canCancel && !summary.quarantined && summary.installed

      const body: DictionaryStatusResponse = {
        ok: true,
        activeMode: summary.activeMode,
        configuredMode: summary.configuredMode,
        activeSource: summary.activeSource,
        activeIdentity: summary.activeIdentity,
        installed: summary.installed,
        installedCorpus: summary.installedCorpus,
        currentOperation: currentOp,
        lastOperation: lastOp,
        canInstall,
        canCancel,
        canRemove,
        quarantined: summary.quarantined,
        quarantineReason: summary.quarantineReason,
        recoveryError: summary.recoveryError,
        lastRetirementError: summary.lastRetirementError,
        generation: summary.generation,
      }

      return jsonResponse(body, 200)
    } catch (err) {
      return errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Forbidden override keys rejected on install endpoint.
 */
const FORBIDDEN_INSTALL_KEYS = Object.freeze([
  'downloadUrl',
  'sourceCommit',
  'sourceSha256',
  'sourceByteSize',
  'fetch',
  'candidatePath',
  'workerUrl',
  'batchSize',
])

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/install.
 */
export function createInstallHandler(
  operationManager: DictionaryOperationManager,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed (expected POST)')
    }

    const parseResult = await parseJsonBody(req)
    if (!parseResult.ok) {
      return errorResponse(parseResult.status, parseResult.error, parseResult.message)
    }

    // Gating: check for forbidden override parameters
    const passedForbidden = FORBIDDEN_INSTALL_KEYS.filter((key) => key in parseResult.data)
    if (passedForbidden.length > 0) {
      return errorResponse(
        400,
        'BAD_REQUEST',
        `Custom installation parameters are strictly forbidden: ${passedForbidden.join(', ')}`,
      )
    }

    try {
      const outcome = operationManager.install()
      const body: DictionaryInstallResponse = {
        ok: true,
        operationId: outcome.operationId,
        status: outcome.status,
        phase: outcome.phase,
        message: outcome.message,
      }
      return jsonResponse(body, 200)
    } catch (err) {
      if (err instanceof OperationInProgressError) {
        return errorResponse(409, 'OPERATION_IN_PROGRESS', err.message, { operationId: err.operationId })
      }
      if (err instanceof OperationDirectoryQuarantinedError) {
        return errorResponse(409, 'DIRECTORY_QUARANTINED', err.message, {
          directory: err.directory,
          reason: err.reason,
        })
      }
      return errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/cancel.
 */
export function createCancelHandler(
  operationManager: DictionaryOperationManager,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed (expected POST)')
    }

    const parseResult = await parseJsonBody(req)
    if (!parseResult.ok) {
      return errorResponse(parseResult.status, parseResult.error, parseResult.message)
    }

    const rawOpId = parseResult.data.operationId
    if (typeof rawOpId !== 'string' || rawOpId.trim().length === 0) {
      return errorResponse(400, 'INVALID_OPERATION_ID', 'Request body must contain non-empty "operationId"')
    }

    const operationId = rawOpId.trim()

    try {
      const outcome = operationManager.cancel(operationId)
      const body: DictionaryCancelResponse = {
        ok: true,
        operationId: outcome.operationId,
        status: outcome.status,
        message: outcome.message,
      }
      return jsonResponse(body, 200)
    } catch (err) {
      if (err instanceof OperationNotFoundError) {
        return errorResponse(404, 'OPERATION_NOT_FOUND', err.message)
      }
      return errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/remove.
 */
export function createRemoveHandler(
  operationManager: DictionaryOperationManager,
  activationCoordinator: ActivationCoordinator,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed (expected POST)')
    }

    // Concurrency check
    if (operationManager.canCancel()) {
      return errorResponse(
        409,
        'OPERATION_IN_PROGRESS',
        'Cannot remove managed dictionary while an installation operation is in progress',
      )
    }

    // Quarantine check
    const summary = activationCoordinator.getStatusSummary()
    if (summary.quarantined) {
      return errorResponse(
        409,
        'DIRECTORY_QUARANTINED',
        'Cannot remove dictionary while storage directory is quarantined',
      )
    }

    try {
      const result = await activationCoordinator.removeManagedDatabase()
      const body: DictionaryRemoveResponse = {
        ok: true,
        removed: result.removed,
        activeMode: 'fixture',
        message: 'Managed ECDICT database removed and active dictionary reverted to fixture',
      }
      return jsonResponse(body, 200)
    } catch (err) {
      return errorResponse(500, 'REMOVE_FAILED', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/verify.
 */
export function createVerifyHandler(
  activationCoordinator: ActivationCoordinator,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed (expected POST)')
    }

    const parseResult = await parseJsonBody(req)
    if (!parseResult.ok) {
      return errorResponse(parseResult.status, parseResult.error, parseResult.message)
    }

    const rawPath = parseResult.data.path
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return errorResponse(400, 'INVALID_PATH', 'Request body must contain non-empty "path"')
    }

    const candidatePath = rawPath.trim()
    if (candidatePath.length > 1024) {
      return errorResponse(400, 'INVALID_PATH', 'Path length exceeds maximum limit of 1024 characters')
    }

    try {
      const outcome = await activationCoordinator.verifyCustomDatabase(candidatePath)
      if (!outcome.valid) {
        return errorResponse(400, outcome.errorCode ?? 'INVALID_SQLITE_FILE', outcome.error ?? 'Verification failed')
      }

      const body: DictionaryVerifyResponse = {
        ok: true,
        valid: true,
        schemaVersion: outcome.schemaVersion,
        entryCount: outcome.entryCount,
        formCount: outcome.formCount,
        headwordsSample: outcome.headwordsSample,
        message: 'Database passed schema and query capability verification',
      }
      return jsonResponse(body, 200)
    } catch (err) {
      return errorResponse(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Register all five dictionary management Fetch routes onto `ctx.connection.fetch`.
 *
 * Implements atomic registration: if any route registration throws, all previously
 * registered routes in this batch are safely unregistered before the error propagates.
 *
 * @param ctx - host Cordis context providing `connection` service.
 * @param operationManager - active operation manager.
 * @param activationCoordinator - active activation coordinator.
 * @returns unified async disposer unregistering all five management routes.
 */
export function registerDictionaryManagementRoutes(
  ctx: Context,
  operationManager: DictionaryOperationManager,
  activationCoordinator: ActivationCoordinator,
): () => Promise<void> {
  const disposers: Array<() => Promise<void>> = []

  try {
    // 1. GET status
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_STATUS_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: createStatusHandler(operationManager, activationCoordinator),
      }),
    )

    // 2. POST install
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_INSTALL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createInstallHandler(operationManager),
      }),
    )

    // 3. POST cancel
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_CANCEL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createCancelHandler(operationManager),
      }),
    )

    // 4. POST remove
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_REMOVE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createRemoveHandler(operationManager, activationCoordinator),
      }),
    )

    // 5. POST verify
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_VERIFY_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createVerifyHandler(activationCoordinator),
      }),
    )
  } catch (registrationError) {
    // Rollback already-registered routes on failure
    for (const dispose of disposers.reverse()) {
      try {
        void dispose()
      } catch {
        // ignore rollback errors
      }
    }
    throw registrationError
  }

  return async (): Promise<void> => {
    const errors: unknown[] = []
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch (err) {
        errors.push(err)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to unregister some dictionary management routes')
    }
  }
}
