/**
 * The deterministic Phase 3 fixture dictionary, as data plus the SQL that
 * materialises it.
 *
 * This module is deliberately **self-contained**: it imports nothing, in either
 * direction. Two very different callers consume it —
 *
 * 1. the host bundle, which ships it to the DSH process as
 *    `src/host/fixture.js`, and
 * 2. `scripts/build-fixture-db.mjs`, which imports this file *directly* as
 *    TypeScript and lets Node's type stripping erase it.
 *
 * — and the second caller is why the "no imports" rule is a contract rather
 * than a style preference. Node's type stripping does not rewrite `.js`
 * specifiers to `.ts`, so a single relative import here would make the builder
 * script unrunnable without a bundler step. Keeping the fixture definition
 * import-free is what lets one source of truth produce both the runtime data and
 * the on-disk fixture database; duplicating the table would let the two drift
 * apart, which is the one failure a fixture-based test cannot detect.
 *
 * Everything in here is deterministic: the rows are literals, the insert order
 * is fixed, the example ids are explicit rather than rowid-assigned, and no
 * timestamp, random value or environment fact is recorded. Rebuilding the
 * database therefore reproduces the same *logical* content, which is what
 * `scripts/build-fixture-db.mjs` verifies — the SQLite file's bytes are not
 * promised to be identical, because SQLite is free to lay pages out differently.
 *
 * The vocabulary is chosen to cover the six lookup shapes Phase 3 must
 * demonstrate:
 *
 * | fixture | covers |
 * | --- | --- |
 * | `derive` | plain exact entry |
 * | `derived`, `deriving`, `derives` | regular morphology through `forms` |
 * | `go` ← `went`, `gone` | irregular morphology |
 * | `tooth` ← `teeth` | an irregular plural |
 * | `conservation` | single-word physics vocabulary |
 * | `wave function` | a multi-word phrase that must outrank splitting |
 * | `wave`, `function` | the words a splitter would wrongly answer with |
 *
 * `wave` and `function` are present on purpose. Without them, an implementation
 * that split `wave function` into two queries would fail only by returning
 * nothing; with them it fails by returning the *wrong headword*, which is a
 * much sharper test.
 *
 * @module dsh-word-lookup/host/fixture
 */

/** Schema revision of the tables below; bumped when their shape changes. */
export const SCHEMA_VERSION = 1

/** Revision of the fixture *contents*; bumped when a row changes. */
export const FIXTURE_VERSION = 'phase3-fixture-1'

/** Provenance recorded for every example row. Never a third-party corpus. */
export const FIXTURE_EXAMPLE_SOURCE = 'dsh-word-lookup-fixture'

/** One headword row. Every optional column is nullable, as the schema says. */
export interface FixtureEntry {
  /** Canonical headword; the primary key. */
  readonly word: string
  /** IPA transcription, plain text between slashes. */
  readonly phonetic: string | null
  /** English definition. */
  readonly definitionEn: string | null
  /** Chinese translation; several glosses are separated by `；`. */
  readonly translationZh: string | null
  /** Part of speech, spelled out. */
  readonly pos: string | null
  /** Inflection summary, in the ECDICT `d:/p:/i:/3:` shorthand. */
  readonly exchange: string | null
  /** Corpus frequency hint; larger is more common. */
  readonly frequency: number | null
}

/** One surface form that resolves to a headword. */
export interface FixtureForm {
  /** The inflected surface form; the primary key, matched case-insensitively. */
  readonly form: string
  /** The headword this form belongs to. */
  readonly headword: string
  /** Grammatical label, or `null` when the relationship needs no name. */
  readonly kind: string | null
}

/** One bilingual example sentence. */
export interface FixtureExample {
  /** Explicit surrogate key, so ordering never depends on insert order. */
  readonly id: number
  /** The headword this sentence illustrates. */
  readonly headword: string
  /** English sentence. */
  readonly english: string
  /** Chinese rendering, or `null` when none was written. */
  readonly chinese: string | null
  /** Provenance; always {@link FIXTURE_EXAMPLE_SOURCE} for this fixture. */
  readonly source: string
  /** Stable identifier of this sentence within {@link source}. */
  readonly sourceId: string | null
  /** Retrieval score; higher sorts first. */
  readonly score: number | null
}

/** Headwords, in the order they are inserted. */
export const FIXTURE_ENTRIES: readonly FixtureEntry[] = [
  {
    word: 'derive',
    phonetic: '/dɪˈraɪv/',
    definitionEn: 'obtain something from a specified source; originate in',
    translationZh: '导出；派生；源自',
    pos: 'verb',
    exchange: 'd:derived/p:derived/i:deriving/3:derives',
    frequency: 8200,
  },
  {
    word: 'go',
    phonetic: '/ɡəʊ/',
    definitionEn: 'move or travel from one place to another',
    translationZh: '去；走；进行',
    pos: 'verb',
    exchange: 'd:went/p:gone/i:going/3:goes',
    frequency: 100_000,
  },
  {
    word: 'tooth',
    phonetic: '/tuːθ/',
    definitionEn: 'each of a set of hard structures set in the jaws',
    translationZh: '牙齿；齿',
    pos: 'noun',
    exchange: 's:teeth',
    frequency: 12_000,
  },
  {
    word: 'conservation',
    phonetic: '/ˌkɒnsəˈveɪʃn/',
    definitionEn: 'the principle that a quantity of a closed system stays constant',
    translationZh: '守恒；保存；保护',
    pos: 'noun',
    exchange: null,
    frequency: 5400,
  },
  {
    word: 'wave function',
    phonetic: '/weɪv ˈfʌŋkʃn/',
    definitionEn: 'a mathematical description of the quantum state of a system',
    translationZh: '波函数',
    pos: 'noun phrase',
    exchange: 's:wave functions',
    frequency: 2100,
  },
  {
    word: 'wave',
    phonetic: '/weɪv/',
    definitionEn: 'a disturbance that transfers energy through a medium',
    translationZh: '波；波浪',
    pos: 'noun',
    exchange: 's:waves',
    frequency: 40_000,
  },
  {
    word: 'function',
    phonetic: '/ˈfʌŋkʃn/',
    definitionEn: 'a relation that assigns exactly one output to each input',
    translationZh: '函数；功能',
    pos: 'noun',
    exchange: 's:functions',
    frequency: 60_000,
  },
]

/** Surface forms and the headword each resolves to, in insert order. */
export const FIXTURE_FORMS: readonly FixtureForm[] = [
  { form: 'derived', headword: 'derive', kind: 'past' },
  { form: 'derives', headword: 'derive', kind: 'third-person singular' },
  { form: 'deriving', headword: 'derive', kind: 'present participle' },
  { form: 'went', headword: 'go', kind: 'past' },
  { form: 'gone', headword: 'go', kind: 'past participle' },
  { form: 'goes', headword: 'go', kind: 'third-person singular' },
  { form: 'going', headword: 'go', kind: 'present participle' },
  { form: 'teeth', headword: 'tooth', kind: 'plural' },
  { form: 'wave functions', headword: 'wave function', kind: 'plural' },
  { form: 'waves', headword: 'wave', kind: 'plural' },
  { form: 'functions', headword: 'function', kind: 'plural' },
]

/**
 * Example sentences, written for this project.
 *
 * Nothing here is copied from a corpus: the Phase 3 brief forbids importing
 * ECDICT or Tatoeba, and an example that claimed a third-party `source` would
 * misrepresent where it came from.
 */
export const FIXTURE_EXAMPLES: readonly FixtureExample[] = [
  {
    id: 1,
    headword: 'derive',
    english: 'The result must derive from the boundary conditions alone.',
    chinese: '该结果只能由边界条件导出。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'derive-1',
    score: 0.9,
  },
  {
    id: 2,
    headword: 'derive',
    english: 'This identity derives from Gauss\u2019s law.',
    chinese: '这一恒等式源自高斯定律。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'derive-2',
    score: 0.8,
  },
  {
    id: 3,
    headword: 'go',
    english: 'The measurement went the other way.',
    chinese: '测量结果朝相反方向变化了。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'go-1',
    score: 0.7,
  },
  {
    id: 4,
    headword: 'tooth',
    english: 'Each tooth has a crown and one or more roots.',
    chinese: '每颗牙齿都有一个牙冠和一条或多条牙根。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'tooth-1',
    score: 0.6,
  },
  {
    id: 5,
    headword: 'conservation',
    english: 'Charge conservation follows from the symmetry of the Lagrangian.',
    chinese: '电荷守恒来自拉格朗日量的对称性。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'conservation-1',
    score: 0.85,
  },
  {
    id: 6,
    headword: 'conservation',
    english: 'Energy conservation forbids that transition.',
    chinese: '能量守恒禁戒该跃迁。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'conservation-2',
    score: 0.5,
  },
  {
    id: 7,
    headword: 'wave function',
    english: 'The wave function collapses on measurement.',
    chinese: '波函数在测量时坍缩。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'wavefunction-1',
    score: 0.95,
  },
  {
    id: 8,
    headword: 'wave function',
    english: 'A normalizable wave function belongs to the Hilbert space.',
    chinese: '可归一化的波函数属于希尔伯特空间。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'wavefunction-2',
    score: 0.4,
  },
  {
    id: 9,
    headword: 'wave',
    english: 'The wave carries energy without carrying matter.',
    chinese: '波传递能量而不传递物质。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'wave-1',
    score: 0.55,
  },
  {
    id: 10,
    headword: 'function',
    english: 'A function maps every input to exactly one output.',
    chinese: '函数把每个输入映射到恰好一个输出。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'function-1',
    score: 0.65,
  },
  {
    id: 11,
    headword: 'function',
    english: 'The delta function is not a function in the classical sense.',
    chinese: 'δ 函数在经典意义下并不是函数。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'function-2',
    score: 0.3,
  },
  {
    id: 12,
    headword: 'tooth',
    english: 'A chipped tooth can usually be repaired.',
    chinese: '缺损的牙齿通常可以修复。',
    source: FIXTURE_EXAMPLE_SOURCE,
    sourceId: 'tooth-2',
    score: 0.2,
  },
]

/**
 * Metadata rows written into `meta`.
 *
 * `schema_version` is the number a future migration reads; the `*_count` rows
 * let a reader detect a truncated file without scanning every table. The counts
 * are derived from the arrays rather than written out, so a row added above
 * cannot leave the metadata lying about the file's size.
 */
export const FIXTURE_META: Readonly<Record<string, string>> = {
  schema_version: String(SCHEMA_VERSION),
  fixture_version: FIXTURE_VERSION,
  generator: 'scripts/build-fixture-db.mjs',
  example_source: FIXTURE_EXAMPLE_SOURCE,
  entries_count: String(FIXTURE_ENTRIES.length),
  forms_count: String(FIXTURE_FORMS.length),
  examples_count: String(FIXTURE_EXAMPLES.length),
}

/**
 * Data-definition statements, executed in order.
 *
 * `IF NOT EXISTS` makes materialising an already-initialized database a no-op
 * rather than an error; the builder clears the tables before seeding, so the
 * clause is about idempotence, not about tolerating a half-built file.
 */
export const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS entries (
     word           TEXT PRIMARY KEY COLLATE NOCASE,
     phonetic       TEXT,
     definition_en  TEXT,
     translation_zh TEXT,
     pos            TEXT,
     exchange       TEXT,
     frequency      INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS forms (
     form      TEXT PRIMARY KEY COLLATE NOCASE,
     headword  TEXT NOT NULL,
     kind      TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS examples (
     id        INTEGER PRIMARY KEY,
     headword  TEXT NOT NULL COLLATE NOCASE,
     english   TEXT NOT NULL,
     chinese   TEXT,
     source    TEXT,
     source_id TEXT,
     score     REAL
   )`,
]

/**
 * Indexes, created after the tables.
 *
 * Three indexes, each justified by a query the dictionary actually issues:
 * `forms(form)` is already the primary key, so the lookup path needs
 * `forms(headword)` only when listing a headword's forms; `examples` is scanned
 * by headword in a fixed order. Nothing else is indexed: Phase 3 is not a
 * production corpus optimisation, and an index nothing reads is a cost with no
 * benefit.
 */
export const INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_forms_headword ON forms (headword COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_examples_headword ON examples (headword COLLATE NOCASE)`,
]

/** The tables a fixture database must contain, in creation order. */
export const FIXTURE_TABLES: readonly string[] = ['meta', 'entries', 'forms', 'examples']

/** A prepared statement, reduced to what the fixture code uses. */
export interface FixtureStatement {
  /** Execute with bound parameters; returns driver-specific detail. */
  run(...parameters: (string | number | null)[]): unknown
  /** Fetch one row, or `undefined`. */
  get(...parameters: (string | number | null)[]): unknown
  /** Fetch every row. */
  all(...parameters: (string | number | null)[]): unknown[]
}

/** The slice of a SQLite connection the fixture code needs. */
export interface FixtureDatabase {
  /** Execute SQL with no parameters. Never receives caller-supplied text. */
  exec(sql: string): void
  /** Prepare a statement for parameterized use. */
  prepare(sql: string): FixtureStatement
}

/** Create every table and index. Safe to call on an initialized database. */
export function createFixtureSchema(db: FixtureDatabase): void {
  for (const statement of SCHEMA_SQL) db.exec(statement)
  for (const statement of INDEX_SQL) db.exec(statement)
}

/**
 * Remove every row, leaving the schema in place.
 *
 * The statements are literals rather than assembled from a table list: every
 * piece of SQL this module executes is a fixed string, which is what lets a
 * reader check by inspection that no query is ever built from caller input.
 */
export function clearFixture(db: FixtureDatabase): void {
  db.exec('DELETE FROM examples')
  db.exec('DELETE FROM forms')
  db.exec('DELETE FROM entries')
  db.exec('DELETE FROM meta')
}

/**
 * Write the fixture into an already-schema'd database.
 *
 * The whole write is one transaction issued by the caller, so a failure part way
 * through leaves the previous content intact rather than a half-seeded file.
 * Every value is bound, never interpolated.
 *
 * @param db - the target database.
 */
export function seedFixture(db: FixtureDatabase): void {
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  const insertEntry = db.prepare(
    'INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertForm = db.prepare('INSERT INTO forms (form, headword, kind) VALUES (?, ?, ?)')
  const insertExample = db.prepare(
    'INSERT INTO examples (id, headword, english, chinese, source, source_id, score) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )

  for (const [key, value] of Object.entries(FIXTURE_META)) insertMeta.run(key, value)

  for (const entry of FIXTURE_ENTRIES) {
    insertEntry.run(
      entry.word,
      entry.phonetic,
      entry.definitionEn,
      entry.translationZh,
      entry.pos,
      entry.exchange,
      entry.frequency,
    )
  }

  for (const form of FIXTURE_FORMS) insertForm.run(form.form, form.headword, form.kind)

  for (const example of FIXTURE_EXAMPLES) {
    insertExample.run(example.id, example.headword, example.english, example.chinese, example.source, example.sourceId, example.score)
  }
}

/** Row counts a correct fixture database must have. */
export interface FixtureCounts {
  readonly entries: number
  readonly forms: number
  readonly examples: number
}

/** The counts {@link FIXTURE_ENTRIES} and friends imply. */
export function expectedFixtureCounts(): FixtureCounts {
  return { entries: FIXTURE_ENTRIES.length, forms: FIXTURE_FORMS.length, examples: FIXTURE_EXAMPLES.length }
}

/** Outcome of {@link validateFixture}. */
export interface FixtureValidation {
  /** Whether every structural and row-level expectation held. */
  readonly ok: boolean
  /** Human-readable failures, empty when {@link ok}. */
  readonly problems: readonly string[]
  /** Counts actually read from the database. */
  readonly counts: FixtureCounts
  /** Counts the fixture definition implies. */
  readonly expected: FixtureCounts
  /** Raw `meta` rows, for the report. */
  readonly meta: Readonly<Record<string, string>>
}

/**
 * Row counts of the three data tables.
 *
 * The statements are literals keyed by table name rather than built from it, so
 * this module contains no SQL assembled from a variable — a property the SQL
 * safety test asserts by scanning the source.
 */
const COUNT_SQL: Readonly<Record<keyof FixtureCounts, string>> = {
  entries: 'SELECT COUNT(*) AS n FROM entries',
  forms: 'SELECT COUNT(*) AS n FROM forms',
  examples: 'SELECT COUNT(*) AS n FROM examples',
}

/** Read one `COUNT(*)`, treating anything unexpected as a failure. */
function readCount(db: FixtureDatabase, table: keyof FixtureCounts): number {
  const row = db.prepare(COUNT_SQL[table]).get()
  const value = (row as { n?: unknown } | undefined)?.n
  return typeof value === 'number' ? value : -1
}

/** Read the whole `meta` table as a plain object. */
function readMeta(db: FixtureDatabase): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all() as { key: string; value: string }[]
  const meta: Record<string, string> = {}
  for (const row of rows) meta[row.key] = row.value
  return meta
}

/**
 * Check a database against the fixture definition.
 *
 * The checks are structural first and row-level second, so a report from a
 * broken file says *what* is wrong rather than only that the counts differ.
 *
 * @param db - the database to inspect. It must be open.
 * @returns a structured report; never throws for a merely incorrect database.
 */
export function validateFixture(db: FixtureDatabase): FixtureValidation {
  const problems: string[] = []
  const expected = expectedFixtureCounts()

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  )
  for (const table of FIXTURE_TABLES) {
    if (!tables.includes(table)) problems.push(`missing table: ${table}`)
  }

  let counts: FixtureCounts = { entries: -1, forms: -1, examples: -1 }
  let meta: Record<string, string> = {}
  if (problems.length === 0) {
    counts = {
      entries: readCount(db, 'entries'),
      forms: readCount(db, 'forms'),
      examples: readCount(db, 'examples'),
    }
    meta = readMeta(db)

    if (meta.schema_version !== String(SCHEMA_VERSION)) {
      problems.push(`meta.schema_version is ${String(meta.schema_version)}, expected ${String(SCHEMA_VERSION)}`)
    }
    if (meta.fixture_version !== FIXTURE_VERSION) {
      problems.push(`meta.fixture_version is ${String(meta.fixture_version)}, expected ${FIXTURE_VERSION}`)
    }
    for (const column of ['entries', 'forms', 'examples'] as const) {
      const declared = Number(meta[`${column}_count`])
      if (declared !== expected[column]) {
        problems.push(`meta.${column}_count is ${String(meta[`${column}_count`])}, expected ${String(expected[column])}`)
      }
      if (counts[column] !== expected[column]) {
        problems.push(`${column} holds ${String(counts[column])} rows, expected ${String(expected[column])}`)
      }
    }

    // Every form must resolve to a headword that exists, and every example must
    // belong to one. A dangling reference is the failure that would make an
    // unknown word answer with another word's sentence.
    const orphans = db
      .prepare('SELECT form FROM forms WHERE headword NOT IN (SELECT word FROM entries) ORDER BY form')
      .all() as { form: string }[]
    for (const orphan of orphans) problems.push(`form "${orphan.form}" points at a missing headword`)

    const strayExamples = db
      .prepare('SELECT id FROM examples WHERE headword NOT IN (SELECT word FROM entries) ORDER BY id')
      .all() as { id: number }[]
    for (const stray of strayExamples) problems.push(`example ${String(stray.id)} belongs to a missing headword`)
  }

  return { ok: problems.length === 0, problems, counts, expected, meta }
}

/**
 * A canonical, order-independent dump of every fixture table.
 *
 * Two databases hold the same dictionary exactly when their dumps are deeply
 * equal. It exists because the SQLite *file* is not a stable artifact — page
 * layout, free-list state and the header's change counter may differ between two
 * builds of identical content — so "did the rebuild reproduce the fixture?" has
 * to be asked of the logical content, not the bytes.
 *
 * @param db - an open fixture database.
 * @returns JSON-serializable rows, each table sorted by its own key.
 */
export function dumpFixture(db: FixtureDatabase): Record<string, unknown[]> {
  return {
    meta: db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
    entries: db
      .prepare('SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries ORDER BY word COLLATE NOCASE')
      .all(),
    forms: db.prepare('SELECT form, headword, kind FROM forms ORDER BY form COLLATE NOCASE').all(),
    examples: db
      .prepare('SELECT id, headword, english, chinese, source, source_id, score FROM examples ORDER BY id')
      .all(),
  }
}
