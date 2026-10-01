/**
 * Request handling for the exact Fetch route `POST /api/dsh-word-lookup`.
 *
 * The handler is a plain function of `(Request) => Promise<Response>` so that it
 * can be exercised without a DSH process, a connection service, or a browser.
 * It performs no I/O of its own beyond reading the request body: there is no
 * model call, no network call, and no filesystem access on this path. The only
 * external resource it touches is the {@link Dictionary} it was handed, which is
 * why the route cannot grow a second data source without someone editing this
 * file.
 *
 * This module is the **lookup service** in the layering the brief requires:
 *
 * ```text
 * route  →  this module  →  Dictionary  →  SQLite fixture
 * ```
 *
 * It owns HTTP semantics, request validation, the wire mapping and the settings
 * echo. It owns no SQL and no storage detail: `dictionary.ts` states what a
 * dictionary is, `sqlite-dictionary.ts` says how one is built, and neither knows
 * what a `Response` is.
 *
 * Refusals are controlled and machine-readable. Every malformed input produces
 * a 400 with a stable `error` code from {@link LookupFailureCode} rather than an
 * exception, because an unhandled throw inside a Fetch route surfaces to the
 * browser as an opaque transport error and would make the failure modes
 * indistinguishable from a broken route.
 *
 * @module dsh-word-lookup/host/lookup
 */

import {
  LOOKUP_MEDIA_TYPE,
  MAX_QUERY_CODE_POINTS,
  MAX_REQUEST_BYTES,
  type LookupErrorResponse,
  type LookupFailureCode,
  type LookupFoundResponse,
  type LookupResponse,
} from '../shared/protocol.js'
import { countCodePoints, normalizeHeadword } from '../shared/text.js'
import { readSwitch, type HostConfig } from './config.js'
import { DictionaryUnavailableError, type Dictionary, type DictionaryHit } from './dictionary.js'

/** Bodies and headers are never cached: a lookup answers about a live selection. */
const NO_STORE = 'no-store'

/**
 * Build one controlled refusal.
 *
 * @param status - HTTP status; 400 for a malformed request, 405 for a method the
 * route does not own, 500 for a dictionary that cannot answer.
 * @param error - stable machine-readable reason.
 * @param message - human-readable detail, for logs and for the browser console.
 * @returns the response the route returns.
 */
function refusal(status: 400 | 405 | 500, error: LookupFailureCode, message: string): Response {
  const body: LookupErrorResponse = { ok: false, error, message }
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE } })
}

/**
 * Build one successful response.
 *
 * @param body - the found or not-found payload.
 * @returns a 200 with the shared no-store policy.
 */
function success(body: LookupResponse): Response {
  return Response.json(body, { status: 200, headers: { 'cache-control': NO_STORE } })
}

/**
 * Read `query` out of an already-parsed body.
 *
 * @param raw - the parsed JSON value.
 * @returns the raw query string, or a stable failure code when the body does not
 * carry one.
 */
function extractQuery(raw: unknown): { readonly query: string } | { readonly error: LookupFailureCode } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'malformed-body' }
  const value = (raw as { query?: unknown }).query
  if (value === undefined) return { error: 'missing-query' }
  if (typeof value !== 'string') return { error: 'missing-query' }
  return { query: value }
}

/**
 * Project a dictionary hit onto the wire contract.
 *
 * The dictionary's record carries provenance and ranking fields the browser has
 * no use for; the wire carries only what a card renders. Doing the projection in
 * one named function is what keeps a storage change from silently changing the
 * payload.
 *
 * @param hit - the dictionary's answer.
 * @param settings - the host's live switch values.
 * @returns the payload the route returns.
 */
function toWire(hit: DictionaryHit, settings: LookupFoundResponse['settings']): LookupFoundResponse {
  return {
    ok: true,
    found: true,
    query: hit.query,
    headword: hit.headword,
    phonetic: hit.phonetic,
    meanings: hit.senses.map((sense) => ({
      partOfSpeech: sense.partOfSpeech,
      definition: sense.definition,
      translation: sense.translation,
    })),
    forms: hit.forms.map((form) => ({ form: form.form, kind: form.kind })),
    matchedForm: hit.matchedForm,
    examples: hit.examples.map((example) => ({ en: example.en, zh: example.zh })),
    source: 'sqlite-fixture',
    settings,
  }
}

/**
 * Create the route handler bound to one loader entry's configuration and one
 * dictionary.
 *
 * The dictionary is injected rather than constructed here. That is what lets a
 * unit test answer from an in-memory fixture with the same code the DSH process
 * runs, and it is what keeps the handler free of any path, file or driver
 * knowledge.
 *
 * @param config - the parsed configuration of this loader entry. Read at request
 * time through {@link readSwitch}, so an accepted settings write is observable on
 * the very next lookup.
 * @param dictionary - the store this handler answers from. The handler never
 * closes it; whoever opened it owns its lifetime.
 * @returns the Fetch handler the route registers.
 */
export function createLookupHandler(
  config: HostConfig | undefined,
  dictionary: Dictionary,
): (request: Request) => Promise<Response> {
  return async function handleLookup(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return refusal(405, 'method-not-allowed', `dsh-word-lookup accepts POST, not ${request.method}`)
    }

    const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (contentType !== LOOKUP_MEDIA_TYPE) {
      return refusal(400, 'unsupported-content-type', `expected ${LOOKUP_MEDIA_TYPE}, received "${contentType}"`)
    }

    const declaredLength = Number(request.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return refusal(400, 'body-too-large', `body exceeds ${MAX_REQUEST_BYTES} bytes`)
    }

    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      return refusal(400, 'body-too-large', `body exceeds ${MAX_REQUEST_BYTES} bytes`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return refusal(400, 'malformed-body', 'request body is not valid JSON')
    }

    const extracted = extractQuery(parsed)
    if ('error' in extracted) {
      return refusal(400, extracted.error, 'request body must be a JSON object with a string "query" field')
    }

    const query = normalizeHeadword(extracted.query)
    if (query.length === 0) {
      return refusal(400, 'empty-query', 'query is empty after normalization')
    }
    if (countCodePoints(extracted.query.trim()) > MAX_QUERY_CODE_POINTS) {
      return refusal(400, 'query-too-long', `query exceeds ${MAX_QUERY_CODE_POINTS} code points`)
    }

    const settings = {
      autoDoubleClick: readSwitch(config, 'autoDoubleClick'),
      autoSelection: readSwitch(config, 'autoSelection'),
    }

    let answer
    try {
      answer = dictionary.lookup(query)
    } catch (error) {
      // A closed or unreadable store is a server fault, not a miss. Reporting it
      // as `found: false` would present a lifecycle bug as a small vocabulary.
      if (error instanceof DictionaryUnavailableError) {
        return refusal(500, 'dictionary-unavailable', error.message)
      }
      throw error
    }

    if (!answer.found) {
      return success({ ok: true, found: false, query, source: dictionary.source, settings })
    }
    return success(toWire(answer, settings))
  }
}
