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
  | 'dictionary-unavailable'

/**
 * Provenance of a lookup payload.
 *
 * - `'sqlite-fixture'` — built-in deterministic test fixture.
 * - `'ecdict-local'` — local production ECDICT database build.
 */
export type LookupSource = 'sqlite-fixture' | 'ecdict-local'

/**
 * One sense of a headword.
 *
 * Every field is nullable because the storage layer treats them that way: the
 * `entries` row may carry a translation and no English definition, or the
 * reverse. A field with nothing behind it is `null`, never an empty string and
 * never invented prose — the card renders what is there.
 */
export interface LookupMeaning {
  /** Part of speech, e.g. `verb`; `null` when the row does not name one. */
  readonly partOfSpeech: string | null
  /** English definition; `null` when the row has none. */
  readonly definition: string | null
  /** Chinese translation; `null` when the row has none. */
  readonly translation: string | null
}

/** One inflected surface form of the returned headword. */
export interface LookupForm {
  /** The surface form, e.g. `went`. */
  readonly form: string
  /** Grammatical label, e.g. `past`; `null` when unnamed. */
  readonly kind: string | null
}

/** One bilingual example sentence. */
export interface LookupExample {
  /** English sentence. */
  readonly en: string
  /** Chinese rendering; `null` when the fixture has none. */
  readonly zh: string | null
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
  /** Canonical headword the query resolved to. */
  readonly headword: string
  /** IPA transcription; `null` when the entry has none. */
  readonly phonetic: string | null
  /** Senses in a stable order; empty when the entry carries no text. */
  readonly meanings: readonly LookupMeaning[]
  /** Inflected forms of {@link headword}, in a stable order. */
  readonly forms: readonly LookupForm[]
  /**
   * The surface form the query matched, when it matched one.
   *
   * `null` when the query was already the headword. Together with
   * {@link headword} this is the inflection → lemma relationship: a lookup of
   * `went` answers `headword: "go"` with `matchedForm: "went"`.
   */
  readonly matchedForm: string | null
  /** Example sentences, most relevant first. */
  readonly examples: readonly LookupExample[]
  /** Provenance of the payload. */
  readonly source: LookupSource
  readonly settings: LookupSettingsEcho
}

/** Well-formed request for a word the dictionary does not contain. */
export interface LookupNotFoundResponse {
  readonly ok: true
  readonly found: false
  /** Normalized query the host actually looked up. */
  readonly query: string
  readonly source: LookupSource
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
