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
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
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
import { SAFE_IDENTITY_PATTERN } from './managed-storage.js'
import {
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationInProgressError,
  OperationNotCancellableError,
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

function sanitizeValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return sanitizeErrorMessage(val)
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue)
  }
  if (val && typeof val === 'object' && Object.getPrototypeOf(val) === Object.prototype) {
    const res: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      res[k] = sanitizeValue(v)
    }
    return res
  }
  return val
}

/**
 * Sanitize structured error details to prevent machine paths or sensitive data leakage.
 */
function sanitizeDetails(details?: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (!details) return undefined
  return sanitizeValue(details) as Record<string, unknown>
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
    ...(details ? { details: sanitizeDetails(details) } : {}),
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
      const canRemove = operationManager.canRemove()
      const canActivateCustom = operationManager.canActivateCustom()
      const canSwitchMode = operationManager.canSwitchMode()

      const body: DictionaryStatusResponse = {
        ok: true,
        activeMode: summary.activeMode,
        configuredMode: summary.configuredMode,
        activeSource: summary.activeSource,
        activeIdentity: summary.activeIdentity,
        activeSnapshotId: summary.activeSnapshotId,
        customSnapshotStatus: summary.customSnapshotStatus,
        customSnapshots: summary.customSnapshots ?? [],
        installed: summary.installed,
        installedCorpus: summary.installedCorpus,
        fixtureStats: summary.fixtureStats,
        currentOperation: currentOp,
        lastOperation: lastOp,
        canInstall,
        canCancel,
        canRemove,
        canActivateCustom,
        canSwitchMode,
        quarantined: summary.quarantined,
        quarantineReason: summary.quarantineReason,
        recoveryError: summary.recoveryError,
        settingsSyncState: summary.settingsSyncState,
        settingsSyncError: summary.settingsSyncError,
        lastRollbackError: summary.lastRollbackError,
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
      if (err instanceof OperationNotCancellableError) {
        return errorResponse(409, 'OPERATION_NOT_CANCELLABLE', err.message, {
          operationId: err.operationId,
        })
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
      const result = await operationManager.remove()
      const body: DictionaryRemoveResponse = {
        ok: true,
        removed: result.removed,
        activeMode: result.activeMode,
        message: result.message,
      }
      return jsonResponse(body, 200)
    } catch (err) {
      if (err instanceof OperationInProgressError) {
        return errorResponse(
          409,
          'OPERATION_IN_PROGRESS',
          'Cannot remove managed dictionary while an operation is in progress',
          { operationId: err.operationId },
        )
      }
      if (err instanceof OperationDirectoryQuarantinedError) {
        return errorResponse(409, 'DIRECTORY_QUARANTINED', err.message)
      }
      return errorResponse(500, 'REMOVE_FAILED', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/activate-custom.
 */
export function createActivateCustomHandler(
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

    const rawPath = parseResult.data.path
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return errorResponse(400, 'INVALID_PATH', 'Request body must contain non-empty "path"')
    }

    const candidatePath = rawPath.trim()
    if (candidatePath.length > 1024) {
      return errorResponse(400, 'INVALID_PATH', 'Path length exceeds maximum limit of 1024 characters')
    }

    let identity: string | undefined
    if ('identity' in parseResult.data) {
      const rawIdentity = parseResult.data.identity
      if (typeof rawIdentity !== 'string' || !SAFE_IDENTITY_PATTERN.test(rawIdentity.trim())) {
        return errorResponse(
          400,
          'INVALID_ARGUMENT',
          `Identity must match safe pattern (${SAFE_IDENTITY_PATTERN.source})`,
        )
      }
      identity = rawIdentity.trim()
    }

    try {
      const outcome = await operationManager.activateCustom(candidatePath, identity)
      return jsonResponse(outcome, 200)
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
      const code = (err as { code?: string })?.code
      if (code === 'OPERATION_CANCELLED') {
        return errorResponse(409, 'OPERATION_CANCELLED', 'Operation was cancelled')
      }
      if (code === 'SNAPSHOT_NOT_FOUND') {
        return errorResponse(404, 'SNAPSHOT_NOT_FOUND', err instanceof Error ? err.message : String(err))
      }
      if (code === 'INVALID_PATH' || code === 'INVALID_SQLITE_FILE' || code === 'INVALID_DATABASE_SCHEMA') {
        return errorResponse(400, code as ManagementErrorCode, err instanceof Error ? err.message : String(err))
      }
      return errorResponse(500, 'ACTIVATE_CUSTOM_FAILED', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Create handler for POST /api/dsh-word-lookup/dictionary/select-mode.
 */
export function createSelectModeHandler(
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

    const rawMode = parseResult.data.mode
    if (typeof rawMode !== 'string' || !['fixture', 'managed-ecdict', 'custom'].includes(rawMode.trim())) {
      return errorResponse(
        400,
        'INVALID_ARGUMENT',
        'Request body must contain valid "mode" ("fixture" | "managed-ecdict" | "custom")',
      )
    }

    const mode = rawMode.trim() as 'fixture' | 'managed-ecdict' | 'custom'

    let snapshotId: string | undefined
    if ('snapshotId' in parseResult.data) {
      const rawSnapshotId = parseResult.data.snapshotId
      if (typeof rawSnapshotId !== 'string' || rawSnapshotId.trim().length === 0) {
        return errorResponse(400, 'INVALID_ARGUMENT', 'snapshotId must be a non-empty string')
      }
      snapshotId = rawSnapshotId.trim()
    } else if (mode === 'custom') {
      return errorResponse(400, 'INVALID_ARGUMENT', 'snapshotId is required when mode is "custom"')
    }

    try {
      const outcome = await operationManager.selectMode(mode, snapshotId)
      return jsonResponse(outcome, 200)
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
      const code = (err as { code?: string })?.code
      if (code === 'ECDICT_NOT_INSTALLED') {
        return errorResponse(400, 'ECDICT_NOT_INSTALLED', err instanceof Error ? err.message : String(err))
      }
      if (code === 'SNAPSHOT_NOT_FOUND') {
        return errorResponse(404, 'SNAPSHOT_NOT_FOUND', err instanceof Error ? err.message : String(err))
      }
      if (code === 'OPERATION_CANCELLED') {
        return errorResponse(409, 'OPERATION_CANCELLED', 'Operation was cancelled')
      }
      return errorResponse(500, 'SWITCH_MODE_FAILED', err instanceof Error ? err.message : String(err))
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
 * Register all seven dictionary management Fetch routes onto `ctx.connection.fetch`.
 *
 * Implements atomic registration: if any route registration throws, all previously
 * registered routes in this batch are safely unregistered before the error propagates.
 *
 * @param ctx - host Cordis context providing `connection` service.
 * @param operationManager - active operation manager.
 * @param activationCoordinator - active activation coordinator.
 * @returns unified async disposer unregistering all seven management routes.
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

    // 6. POST activate-custom
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_ACTIVATE_CUSTOM_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createActivateCustomHandler(operationManager),
      }),
    )

    // 7. POST select-mode
    disposers.push(
      ctx.connection.fetch.register({
        path: MANAGEMENT_SELECT_MODE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createSelectModeHandler(operationManager),
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
