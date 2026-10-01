/**
 * The SQLite-backed implementation of {@link Dictionary}.
 *
 * This is the **only** module in the package that touches `node:sqlite`, and it
 * is reachable only from the host half. The browser bundle must never import it:
 * a database in the page would mean shipping the dictionary to the client, and
 * `scripts/check-bundle.mjs` asserts that it does not happen.
 *
 * Three properties shape the code below:
 *
 * - **Every value is bound, never interpolated.** Each statement is a fixed
 *   string prepared once; the query arrives as a parameter. A selection of
 *   `'; DROP TABLE entries; --` is therefore just a word the dictionary has
 *   never heard of. SQLite's `exec` does run multiple statements, so `exec` is
 *   used only for schema and transaction control, whose text is a literal, and
 *   never for anything derived from a query.
 * - **The lookup order is fixed and checked in this order**: exact entry first,
 *   then the `forms` table, then the resolved headword's rows. An exact phrase
 *   therefore outranks morphology, which is what stops `wave function` from
 *   being answered as `wave`.
 * - **The handle is owned, not pooled.** One plugin lifecycle opens at most one
 *   connection and {@link SqliteDictionary.close} releases it. There is no
 *   connection pool: a fixture database read once per keystroke does not need
 *   one, and a pool is exactly the construct that would let a load/unload cycle
 *   leak a handle.
 *
 * @module dsh-word-lookup/host/sqlite-dictionary
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DictionaryUnavailableError,
  type Dictionary,
  type DictionaryExample,
  type DictionaryForm,
  type DictionaryLookup,
  type DictionarySense,
} from './dictionary.js'
import {
  SCHEMA_VERSION,
  clearFixture,
  createFixtureSchema,
  seedFixture,
  validateFixture,
} from './fixture.js'

/** The provenance this implementation reports. */
const SOURCE = 'sqlite-fixture' as const

/**
 * Statements, as literals.
 *
 * Kept in one object so a reader can see every query the dictionary can issue
 * without following a call graph, and so the "no assembled SQL" property is
 * checkable at a glance.
 */
const SQL = {
  tableExists: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  metaValue: 'SELECT value FROM meta WHERE key = ?',
  entryByWord:
    'SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?',
  headwordByForm: 'SELECT headword FROM forms WHERE form = ?',
  formsByHeadword: 'SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE',
  // `score DESC` leaves a NULL score last, because SQLite sorts NULL below every
  // other value; `id ASC` then makes the order total, so two equal scores can
  // never come back in a different order between builds.
  examplesByHeadword:
    'SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC',
} as const

/** What one normalized query resolved to, before it is dressed for the wire. */
interface EntryRow {
  readonly word: string
  readonly phonetic: string | null
  readonly definition_en: string | null
  readonly translation_zh: string | null
  readonly pos: string | null
  readonly exchange: string | null
  readonly frequency: number | null
}

/** One row of `forms`. */
interface FormRow {
  readonly form: string
  readonly kind: string | null
}

/** One row of `examples`. */
interface ExampleRow {
  readonly english: string
  readonly chinese: string | null
  readonly source: string | null
  readonly source_id: string | null
  readonly score: number | null
}

/** How the database was brought to its current state, for evidence. */
export interface DictionaryInitialization {
  /** Absolute path of the database file, or `:memory:`. */
  readonly path: string
  /** Whether the schema had to be created on this open. */
  readonly created: boolean
  /** Whether the rows had to be (re)written on this open. */
  readonly seeded: boolean
  /** `schema_version` read back after initialization. */
  readonly schemaVersion: number
  /** `fixture_version` read back after initialization. */
  readonly fixtureVersion: string
  /** Whether the file was already present when the store opened. */
  readonly existed: boolean
}

/** Options accepted by {@link openSqliteDictionary}. */
export interface SqliteDictionaryOptions {
  /**
   * Database file, or `':memory:'`.
   *
   * Never a configuration field: Phase 3 exposes no `dictionaryPath` setting.
   * The production path is resolved by `src/host/fixture-db.ts` from the
   * package's own location, and tests pass a scratch path explicitly.
   */
  readonly path: string
  /**
   * Open read-only, and refuse to modify the file.
   *
   * A read-only open never creates, seeds or repairs anything: a missing or
   * unusable file is an error. Tests use it to prove that a closed database
   * really was persisted rather than quietly rebuilt.
   */
  readonly readOnly?: boolean
}

/**
 * Turn a driver row into an optional-string field.
 *
 * @param value - the column value.
 * @returns the string, or `null` for anything that is not one.
 */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Turn a driver row into an optional-number field.
 *
 * @param value - the column value.
 * @returns the number, or `null` for anything that is not one.
 */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * A SQLite connection that is opened and closed exactly once.
 *
 * Constructed only by {@link openSqliteDictionary}, which is what guarantees the
 * schema and rows were validated before the first query.
 */
export class SqliteDictionary implements Dictionary {
  readonly source = SOURCE

  readonly #db: DatabaseSync
  readonly #closed = { value: false }
  readonly #info: DictionaryInitialization

  /**
   * @param db - an open connection whose schema and rows are already valid.
   * @param info - what initialization did, for evidence.
   */
  constructor(db: DatabaseSync, info: DictionaryInitialization) {
    this.#db = db
    this.#info = info
  }

  /** What opening this database did. Read-only. */
  get initialization(): DictionaryInitialization {
    return this.#info
  }

  /**
   * Resolve one normalized query.
   *
   * @param normalizedQuery - the normalized selection.
   * @returns a hit or a miss.
   * @throws {DictionaryUnavailableError} when the store has been closed.
   */
  lookup(normalizedQuery: string): DictionaryLookup {
    if (this.#closed.value) {
      throw new DictionaryUnavailableError('the dictionary was closed before it answered')
    }

    const exact = this.#db.prepare(SQL.entryByWord).get(normalizedQuery) as unknown as EntryRow | undefined
    if (exact !== undefined) return this.#hit(normalizedQuery, exact, null)

    const form = this.#db.prepare(SQL.headwordByForm).get(normalizedQuery) as unknown as { headword: string } | undefined
    if (form === undefined) return { found: false, query: normalizedQuery }

    const inflected = this.#db.prepare(SQL.entryByWord).get(form.headword) as unknown as EntryRow | undefined
    if (inflected === undefined) {
      // A `forms` row whose headword is missing is a broken fixture, not a miss.
      throw new DictionaryUnavailableError(
        `the fixture maps "${normalizedQuery}" to "${form.headword}", which has no entry`,
      )
    }
    return this.#hit(normalizedQuery, inflected, normalizedQuery)
  }

  /** Release the connection. Idempotent. */
  close(): void {
    if (this.#closed.value) return
    this.#closed.value = true
    this.#db.close()
  }

  /**
   * Assemble a hit from the entry row plus its forms and examples.
   *
   * @param query - the normalized query.
   * @param row - the entry the query resolved to.
   * @param matchedForm - the surface form matched, or `null` for an exact entry.
   * @returns the assembled hit.
   */
  #hit(query: string, row: EntryRow, matchedForm: string | null): DictionaryLookup {
    const sense: DictionarySense = {
      partOfSpeech: asText(row.pos),
      definition: asText(row.definition_en),
      translation: asText(row.translation_zh),
    }

    // A row with neither a definition nor a translation still carries a
    // headword and a phonetic, so it is a hit with no senses rather than a
    // miss — the honest answer to "what does this word look like".
    const senses = sense.definition === null && sense.translation === null ? [] : [sense]

    const forms: DictionaryForm[] = (
      this.#db.prepare(SQL.formsByHeadword).all(row.word) as unknown as FormRow[]
    ).map((form) => ({ form: form.form, kind: asText(form.kind) }))

    const examples: DictionaryExample[] = (
      this.#db.prepare(SQL.examplesByHeadword).all(row.word) as unknown as ExampleRow[]
    ).map((example) => ({
      en: example.english,
      zh: asText(example.chinese),
      source: asText(example.source),
      sourceId: asText(example.source_id),
      score: asNumber(example.score),
    }))

    return {
      found: true,
      query,
      headword: row.word,
      phonetic: asText(row.phonetic),
      senses,
      forms,
      matchedForm,
      examples,
    }
  }
}

/**
 * Read one `meta` value.
 *
 * @param db - an open connection whose `meta` table exists.
 * @param key - the key to read.
 * @returns the value, or `undefined`.
 */
function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare(SQL.metaValue).get(key) as unknown as { value?: unknown } | undefined
  return typeof row?.value === 'string' ? row.value : undefined
}

/**
 * Run `body` inside a transaction, rolling back if it throws.
 *
 * `node:sqlite` exposes no transaction helper, so the statements are issued
 * directly. `BEGIN IMMEDIATE` takes the write lock up front rather than
 * upgrading mid-transaction, which turns a would-be `SQLITE_BUSY` at the last
 * statement into a clean failure at the first.
 *
 * @param db - the connection.
 * @param body - the work to perform.
 */
function inTransaction(db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    body()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A failed rollback means the transaction is already gone; the original
      // error is the one worth propagating.
    }
    throw error
  }
}

/**
 * Bring an open connection to a valid, current fixture.
 *
 * The rule is one sentence: **if the database is not a valid, current fixture,
 * rebuild it from the bundled literals.** Validity is decided by
 * {@link validateFixture}, not by a version comparison alone, because a version
 * string can only catch the changes someone remembered to bump it for — an
 * earlier iteration of this module changed the `meta` keys without changing
 * `fixture_version`, and a version-only check happily served the stale file.
 * Rebuilding is safe here precisely because the fixture is derived rather than
 * authored: nothing in it is data a reader could lose.
 *
 * @param db - the connection.
 * @returns what was done.
 * @throws {DictionaryUnavailableError} when the result is still not usable.
 */
function initialize(db: DatabaseSync): { created: boolean; seeded: boolean } {
  const hasMeta = db.prepare(SQL.tableExists).get('meta') !== undefined
  let created = false

  if (!hasMeta) {
    createFixtureSchema(db)
    created = true
  }

  const before = validateFixture(db)
  if (!before.ok) {
    // Either the file was empty or it was built by a different revision of the
    // fixture. Both are rebuilt inside one transaction, so a failure leaves the
    // previous content untouched rather than a half-seeded file.
    createFixtureSchema(db)
    inTransaction(db, () => {
      clearFixture(db)
      seedFixture(db)
    })
  }

  const after = validateFixture(db)
  if (!after.ok) {
    throw new DictionaryUnavailableError(
      `the fixture database is not usable after initialization: ${after.problems.join('; ')}`,
    )
  }

  return { created, seeded: !before.ok }
}

/**
 * Open the SQLite dictionary.
 *
 * The connection is closed again if anything after it fails, so a failed open
 * never leaves a half-open handle behind — which is the property that makes
 * "repeated load/unload does not accumulate handles" a consequence of the code
 * rather than of careful calling.
 *
 * @param options - where the database lives and whether to initialize it.
 * @returns an open dictionary.
 * @throws {DictionaryUnavailableError} when the store cannot be opened or is
 * not a usable fixture.
 */
export function openSqliteDictionary(options: SqliteDictionaryOptions): SqliteDictionary {
  const readOnly = options.readOnly === true
  const inMemory = options.path === ':memory:'
  if (!inMemory && !readOnly) mkdirSync(dirname(options.path), { recursive: true })
  const existed = inMemory ? false : existsSync(options.path)

  if (readOnly && !existed) {
    throw new DictionaryUnavailableError(`no fixture database at ${options.path}`)
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(options.path, readOnly ? { readOnly: true } : {})

    // A read-only open inspects; any other open is allowed to materialise the
    // fixture, because the fixture is derived from literals rather than
    // authored, so rebuilding it can destroy nothing.
    const setup = readOnly ? { created: false, seeded: false } : initialize(db)

    const schemaVersion = Number(readMeta(db, 'schema_version'))
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new DictionaryUnavailableError(
        `the fixture database at ${options.path} is schema ${String(schemaVersion)}, expected ${String(SCHEMA_VERSION)}`,
      )
    }
    const fixtureVersion = readMeta(db, 'fixture_version') ?? ''

    return new SqliteDictionary(db, {
      path: options.path,
      created: setup.created,
      seeded: setup.seeded,
      schemaVersion,
      fixtureVersion,
      existed,
    })
  } catch (error) {
    // Release the handle before propagating: a caller that receives an
    // exception must not also be holding an open connection it cannot reach.
    try {
      db?.close()
    } catch {
      // Already closed, or never opened far enough to close.
    }
    if (error instanceof DictionaryUnavailableError) throw error
    throw new DictionaryUnavailableError(
      `cannot open the fixture dictionary at ${options.path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
