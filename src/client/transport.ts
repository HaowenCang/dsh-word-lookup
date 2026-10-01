/**
 * Browser transport for the exact Fetch route.
 *
 * The URL is **document-relative** (`api/dsh-word-lookup`, no leading slash):
 * `dsh-host-frontend-static` serves the application with `<base href="./">`, so a
 * leading slash would leave the application's mount directory. First-party code
 * strips the same slash before calling `fetch`.
 *
 * No `credentials` option is set: the same-origin default already sends the
 * signed, authority-bound `HttpOnly` cookie the connection fence requires, and
 * there is no `Authorization` header path in this DSH generation.
 *
 * Every outcome is returned as a value. A rejected promise is reserved for the
 * two cases the caller cannot act on — an aborted request and a transport
 * failure — so a controlled host refusal never has to be distinguished from a
 * broken route by catching an exception.
 *
 * @module dsh-word-lookup/client/transport
 */

import {
  LOOKUP_DOCUMENT_PATH,
  LOOKUP_MEDIA_TYPE,
  type LookupErrorResponse,
  type LookupFailureCode,
  type LookupFoundResponse,
  type LookupNotFoundResponse,
} from '../shared/protocol.js'

/** A lookup that reached the host and produced a body. */
export type LookupResult =
  | { readonly kind: 'found'; readonly body: LookupFoundResponse }
  | { readonly kind: 'not-found'; readonly body: LookupNotFoundResponse }
  | {
      readonly kind: 'refused'
      readonly httpStatus: number
      readonly code: LookupFailureCode | 'unexpected-response'
      readonly message: string
    }

/** Why a transport-level request ended without a body. */
export type LookupTransportFailure =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'network'; readonly message: string }

/**
 * Narrow an unknown parsed body to a controlled refusal.
 *
 * @param value - the parsed JSON body.
 * @returns the error code when the body is a well-formed refusal.
 */
function refusalCode(value: unknown): LookupFailureCode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<LookupErrorResponse>
  if (record.ok !== false) return undefined
  return typeof record.error === 'string' ? record.error : undefined
}

/**
 * POST one query and classify the response.
 *
 * @param query - the raw selected text; the host normalizes it.
 * @param signal - cancels a superseded request. A newer lookup must abort the
 * previous one rather than race it, which is what T15 asks for.
 * @returns the classified result.
 * @throws never — transport failures resolve to a value; only a programming
 * error inside the classifier would propagate.
 */
export async function requestLookup(
  query: string,
  signal?: AbortSignal,
): Promise<LookupResult | LookupTransportFailure> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': LOOKUP_MEDIA_TYPE },
    body: JSON.stringify({ query }),
  }
  if (signal !== undefined) init.signal = signal

  let response: Response
  try {
    response = await fetch(LOOKUP_DOCUMENT_PATH, init)
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'aborted' }
    return { kind: 'network', message: error instanceof Error ? error.message : String(error) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }

  if (response.ok) {
    if (typeof parsed === 'object' && parsed !== null) {
      const { found } = parsed as { found?: unknown }
      if (found === true) return { kind: 'found', body: parsed as LookupFoundResponse }
      if (found === false) return { kind: 'not-found', body: parsed as LookupNotFoundResponse }
    }
  }

  return {
    kind: 'refused',
    httpStatus: response.status,
    code: refusalCode(parsed) ?? 'unexpected-response',
    message: `dsh-word-lookup host answered ${response.status}`,
  }
}
