/**
 * Wire contract shared by the two halves of `dsh-word-lookup`.
 *
 * This module is a leaf: it imports nothing, so both bundles may include it
 * without either half reaching the other's runtime. Everything here is either a
 * compile-time type or a constant that is identical in both processes.
 *
 * @module dsh-word-lookup/shared
 */

/**
 * Document-relative URL of the lookup route, used by the browser half.
 *
 * `dsh-host-frontend-static` serves the application with `<base href="./">`, so a
 * leading slash would address the server root rather than the application's mount
 * directory; first-party callers strip the same leading slash before calling
 * `fetch`.
 *
 * The browser bundle carries **this** literal and never the absolute path. The
 * host's `/api`-prefixed form lives in `src/host/route.ts`, and a unit test
 * asserts the two are the same route; stating the browser's URL as a derived
 * value would have put the absolute string into the one bundle that must not
 * contain it.
 */
export const LOOKUP_DOCUMENT_PATH = 'api/dsh-word-lookup'

/** Media type the route accepts. Any other request content type is a 400. */
export const LOOKUP_MEDIA_TYPE = 'application/json'

/**
 * Maximum number of Unicode code points accepted in `query`.
 *
 * Counted in code points rather than UTF-16 units so that a selection of CJK or
 * astral characters is measured the way a reader counts it.
 */
export const MAX_QUERY_CODE_POINTS = 96

/**
 * Maximum accepted request body size, in bytes.
 *
 * The transport buffers request bodies in memory before the handler runs, so
 * the route states its own far smaller ceiling and refuses anything above it.
 */
export const MAX_REQUEST_BYTES = 4096

/** Stable machine-readable reasons a lookup request is refused. */
export type LookupFailureCode =
  | 'method-not-allowed'
  | 'unsupported-content-type'
  | 'body-too-large'
  | 'malformed-body'
  | 'missing-query'
  | 'empty-query'
  | 'query-too-long'

/** One sense of a headword. */
export interface LookupMeaning {
  /** Part of speech, as printed by the stub dictionary. */
  readonly partOfSpeech: string
  /** Definition text. */
  readonly definition: string
}

/** One bilingual example sentence. */
export interface LookupExample {
  /** English sentence. */
  readonly en: string
  /** Chinese rendering of {@link en}. */
  readonly zh: string
}

/**
 * Phase 1 diagnostic echo of the host's live volatile configuration.
 *
 * It exists so that a browser session can observe `config.<field>.get()` on the
 * host without a second route, which is what Phase 1 must prove; the dictionary
 * phases drop it once the payload carries real content.
 */
export interface LookupSettingsEcho {
  /** Live value of `Config.autoDoubleClick`. */
  readonly autoDoubleClick: boolean
  /** Live value of `Config.autoSelection`. */
  readonly autoSelection: boolean
}

/** Successful hit. */
export interface LookupFoundResponse {
  readonly ok: true
  readonly found: true
  /** Normalized query the host actually looked up. */
  readonly query: string
  readonly headword: string
  readonly phonetic: string
  readonly meanings: readonly LookupMeaning[]
  readonly examples: readonly LookupExample[]
  /** Provenance of the payload; `stub` until the real dictionary lands. */
  readonly source: 'stub'
  readonly settings: LookupSettingsEcho
}

/** Well-formed request for a word the dictionary does not contain. */
export interface LookupNotFoundResponse {
  readonly ok: true
  readonly found: false
  /** Normalized query the host actually looked up. */
  readonly query: string
  readonly source: 'stub'
  readonly settings: LookupSettingsEcho
}

/**
 * Controlled refusal: 400 for every malformed request, 405 for a method the
 * route does not own. Either way the `error` code is stable.
 */
export interface LookupErrorResponse {
  readonly ok: false
  readonly error: LookupFailureCode
  readonly message: string
}

/** Every body the route can produce. */
export type LookupResponse = LookupFoundResponse | LookupNotFoundResponse | LookupErrorResponse
