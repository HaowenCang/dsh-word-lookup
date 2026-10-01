/**
 * The dictionary contract the host's lookup service is written against.
 *
 * This module is the seam between *answering a query* (`src/host/lookup.ts`,
 * which knows about HTTP, JSON bodies and the wire protocol) and *knowing what a
 * word means* (`src/host/sqlite-dictionary.ts`, which knows about SQLite). The
 * route never writes SQL and the storage layer never builds a `Response`.
 *
 * The types here are **host-internal**. They are deliberately not the wire types
 * from `src/shared/protocol.ts`: the wire contract is a leaf both halves
 * compile against and should carry only what a card renders, while a dictionary
 * record also carries provenance and ranking fields — `source`, `sourceId`,
 * `score`, `frequency`, `exchange` — that the browser has no use for. Mapping
 * between the two happens in one place, in the lookup service, which is what
 * keeps a storage change from silently altering the wire.
 *
 * @module dsh-word-lookup/host/dictionary
 */

/**
 * Provenance of a dictionary's answers.
 *
 * Phase 3 ships a deterministic fixture, so the only value is
 * `'sqlite-fixture'`. It exists as a type rather than a bare string so that a
 * later phase importing ECDICT has to state the new value at every site that
 * branches on it, instead of inheriting a claim that is no longer true. Nothing
 * may ever report `'ECDICT'`, `'Tatoeba'` or `'stub'` from this field: the
 * first two would be a lie about the data, the third about the implementation.
 */
export type DictionarySource = 'sqlite-fixture'

/** One sense of a headword, as stored. */
export interface DictionarySense {
  /** Part of speech, e.g. `verb`. */
  readonly partOfSpeech: string | null
  /** English definition, or `null` when the row has none. */
  readonly definition: string | null
  /** Chinese translation, or `null` when the row has none. */
  readonly translation: string | null
}

/** One inflected surface form of a headword. */
export interface DictionaryForm {
  /** The surface form, e.g. `went`. */
  readonly form: string
  /** Grammatical label, e.g. `past`, or `null`. */
  readonly kind: string | null
}

/** One example sentence with its provenance. */
export interface DictionaryExample {
  /** English sentence; never empty. */
  readonly en: string
  /** Chinese rendering, or `null`. */
  readonly zh: string | null
  /** Where the sentence came from. */
  readonly source: string | null
  /** Stable id of the sentence within {@link source}. */
  readonly sourceId: string | null
  /** Ranking score; `null` sorts last. */
  readonly score: number | null
}

/** A query the dictionary knows how to answer. */
export interface DictionaryHit {
  readonly found: true
  /** The normalized query, echoed so a caller never has to re-derive it. */
  readonly query: string
  /** The canonical headword the query resolved to. */
  readonly headword: string
  /** IPA transcription, or `null` when the row has none. */
  readonly phonetic: string | null
  /** Senses in a stable order. Empty when the row carries no definition. */
  readonly senses: readonly DictionarySense[]
  /** Inflected forms of {@link headword}, in a stable order. */
  readonly forms: readonly DictionaryForm[]
  /**
   * The surface form the query matched, when it matched one.
   *
   * `null` when the query was already the headword. This is the whole
   * inflection → lemma relationship in one field: `query: 'went'` with
   * `headword: 'go'` and `matchedForm: 'went'` says the reader selected an
   * inflected form and got the lemma back.
   */
  readonly matchedForm: string | null
  /** Example sentences, most relevant first. */
  readonly examples: readonly DictionaryExample[]
}

/** A well-formed query the dictionary has nothing for. */
export interface DictionaryMiss {
  readonly found: false
  /** The normalized query, echoed. */
  readonly query: string
}

/** Everything {@link Dictionary.lookup} can return. */
export type DictionaryLookup = DictionaryHit | DictionaryMiss

/**
 * A closeable, queryable dictionary.
 *
 * `lookup` is synchronous by design. The Phase 3 store is SQLite in the host
 * process, so there is nothing to await, and a synchronous contract makes the
 * route's precedence rules and the lifecycle tests plain to reason about. A
 * later phase that adds an asynchronous backing store changes this interface
 * deliberately rather than hiding an await behind a promise-shaped wrapper.
 */
export interface Dictionary {
  /** Where the answers come from. */
  readonly source: DictionarySource
  /**
   * Resolve one already-normalized query.
   *
   * @param normalizedQuery - output of `normalizeHeadword`; never empty. The
   * implementation still binds it as a parameter and still matches
   * case-insensitively, so a caller that skipped normalization cannot inject
   * anything.
   * @returns a hit or a miss; never `undefined`.
   * @throws {DictionaryUnavailableError} when the store is closed or otherwise
   * unusable. A miss is a value, an outage is not.
   */
  lookup(normalizedQuery: string): DictionaryLookup
  /**
   * Release the store's resources.
   *
   * Idempotent: calling it twice, or after a failed open, is not an error. The
   * plugin lifecycle calls it on unload, so it must be safe for every path a
   * load can take.
   */
  close(): void
}

/**
 * Raised when a dictionary cannot answer because its store is unusable.
 *
 * Distinguished from a miss on purpose: "this word is not in the dictionary" is
 * a `200` with `found: false`, while "the dictionary is not open" is a server
 * fault. Collapsing the two would let a lifecycle bug look like a small
 * vocabulary.
 */
export class DictionaryUnavailableError extends Error {
  /** Stable machine-readable reason, safe to put on the wire. */
  readonly code = 'dictionary-unavailable'

  /**
   * @param message - what was wrong with the store.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DictionaryUnavailableError'
  }
}
