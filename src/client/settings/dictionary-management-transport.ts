/**
 * Browser transport client for dictionary management endpoints.
 *
 * All endpoints use document-relative paths (`api/dsh-word-lookup/dictionary/...`,
 * no leading slash) conforming to DSH <base href="./"> architecture.
 * Authentication uses standard same-origin cookie credentials.
 *
 * @module dsh-word-lookup/client/settings/dictionary-management-transport
 */

import {
  MANAGEMENT_CANCEL_DOCUMENT_PATH,
  MANAGEMENT_INSTALL_DOCUMENT_PATH,
  MANAGEMENT_MEDIA_TYPE,
  MANAGEMENT_REMOVE_DOCUMENT_PATH,
  MANAGEMENT_STATUS_DOCUMENT_PATH,
  MANAGEMENT_VERIFY_DOCUMENT_PATH,
  type DictionaryCancelRequest,
  type DictionaryCancelResponse,
  type DictionaryErrorResponse,
  type DictionaryInstallResponse,
  type DictionaryRemoveResponse,
  type DictionaryStatusResponse,
  type DictionaryVerifyRequest,
  type DictionaryVerifyResponse,
  type ManagementErrorCode,
} from '../../shared/dictionary-management-protocol.js'

/**
 * Successful management API result.
 */
export interface ManagementApiSuccess<T> {
  readonly ok: true
  readonly data: T
}

/**
 * Host refused the request with an HTTP error response (e.g. 400, 401, 404, 409, 500).
 */
export interface ManagementApiRefusal {
  readonly ok: false
  readonly kind: 'refused'
  readonly httpStatus: number
  readonly code: ManagementErrorCode | 'unexpected-response'
  readonly message: string
}

/**
 * Network connection failed or server is unreachable.
 */
export interface ManagementApiNetworkError {
  readonly ok: false
  readonly kind: 'network'
  readonly message: string
}

/**
 * Request was aborted via AbortSignal.
 */
export interface ManagementApiAborted {
  readonly ok: false
  readonly kind: 'aborted'
}

/**
 * Unified result type for management API calls.
 */
export type ManagementApiResult<T> =
  | ManagementApiSuccess<T>
  | ManagementApiRefusal
  | ManagementApiNetworkError
  | ManagementApiAborted

/**
 * Validate that an unknown value conforms to DictionaryStatusResponse structure.
 */
export function isValidDictionaryStatusResponse(value: unknown): value is DictionaryStatusResponse {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<DictionaryStatusResponse>
  return (
    r.ok === true &&
    (r.activeMode === 'fixture' || r.activeMode === 'managed-ecdict' || r.activeMode === 'custom') &&
    typeof r.installed === 'boolean' &&
    typeof r.canInstall === 'boolean' &&
    typeof r.canCancel === 'boolean' &&
    typeof r.canRemove === 'boolean' &&
    typeof r.generation === 'number'
  )
}

/**
 * Validate that an unknown value conforms to DictionaryErrorResponse.
 */
function parseRefusalBody(value: unknown): { code: ManagementErrorCode; message: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Partial<DictionaryErrorResponse>
  if (r.ok === false && typeof r.error === 'string' && typeof r.message === 'string') {
    return { code: r.error as ManagementErrorCode, message: r.message }
  }
  return undefined
}

/**
 * Generic fetch wrapper for management endpoints.
 */
async function sendManagementRequest<T>(
  url: string,
  options: {
    method: 'GET' | 'POST'
    body?: unknown
    signal?: AbortSignal
    validator?: (val: unknown) => val is T
  },
): Promise<ManagementApiResult<T>> {
  const init: RequestInit = {
    method: options.method,
    headers: {
      accept: MANAGEMENT_MEDIA_TYPE,
      ...(options.body !== undefined ? { 'content-type': MANAGEMENT_MEDIA_TYPE } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, kind: 'aborted' }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, kind: 'network', message }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }

  if (response.ok) {
    if (options.validator !== undefined) {
      if (options.validator(parsed)) {
        return { ok: true, data: parsed }
      }
      return {
        ok: false,
        kind: 'refused',
        httpStatus: response.status,
        code: 'unexpected-response',
        message: 'Host returned an unexpected response structure.',
      }
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true) {
      return { ok: true, data: parsed as T }
    }
  }

  const refusal = parseRefusalBody(parsed)
  return {
    ok: false,
    kind: 'refused',
    httpStatus: response.status,
    code: refusal?.code ?? 'unexpected-response',
    message: refusal?.message ?? `Host answered with HTTP ${response.status}`,
  }
}

/**
 * Fetch current dictionary status from the host.
 */
export async function fetchDictionaryStatus(
  signal?: AbortSignal,
): Promise<ManagementApiResult<DictionaryStatusResponse>> {
  return sendManagementRequest<DictionaryStatusResponse>(MANAGEMENT_STATUS_DOCUMENT_PATH, {
    method: 'GET',
    signal,
    validator: isValidDictionaryStatusResponse,
  })
}

/**
 * Initiate an installation of the managed ECDICT corpus.
 */
export async function installManagedDictionary(
  signal?: AbortSignal,
): Promise<ManagementApiResult<DictionaryInstallResponse>> {
  return sendManagementRequest<DictionaryInstallResponse>(MANAGEMENT_INSTALL_DOCUMENT_PATH, {
    method: 'POST',
    signal,
  })
}

/**
 * Cancel an in-flight background operation.
 */
export async function cancelDictionaryOperation(
  operationId: string,
  signal?: AbortSignal,
): Promise<ManagementApiResult<DictionaryCancelResponse>> {
  const body: DictionaryCancelRequest = { operationId }
  return sendManagementRequest<DictionaryCancelResponse>(MANAGEMENT_CANCEL_DOCUMENT_PATH, {
    method: 'POST',
    body,
    signal,
  })
}

/**
 * Remove the installed managed ECDICT corpus and revert to fixture mode.
 */
export async function removeManagedDictionary(
  signal?: AbortSignal,
): Promise<ManagementApiResult<DictionaryRemoveResponse>> {
  return sendManagementRequest<DictionaryRemoveResponse>(MANAGEMENT_REMOVE_DOCUMENT_PATH, {
    method: 'POST',
    signal,
  })
}

/**
 * Verify a custom SQLite dictionary path.
 */
export async function verifyCustomDictionary(
  path: string,
  signal?: AbortSignal,
): Promise<ManagementApiResult<DictionaryVerifyResponse>> {
  const body: DictionaryVerifyRequest = { path }
  return sendManagementRequest<DictionaryVerifyResponse>(MANAGEMENT_VERIFY_DOCUMENT_PATH, {
    method: 'POST',
    body,
    signal,
  })
}
