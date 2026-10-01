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
export declare const SCHEMA_VERSION = 1;
/** Revision of the fixture *contents*; bumped when a row changes. */
export declare const FIXTURE_VERSION = "phase3-fixture-1";
/** Provenance recorded for every example row. Never a third-party corpus. */
export declare const FIXTURE_EXAMPLE_SOURCE = "dsh-word-lookup-fixture";
/** One headword row. Every optional column is nullable, as the schema says. */
export interface FixtureEntry {
    /** Canonical headword; the primary key. */
    readonly word: string;
    /** IPA transcription, plain text between slashes. */
    readonly phonetic: string | null;
    /** English definition. */
    readonly definitionEn: string | null;
    /** Chinese translation; several glosses are separated by `；`. */
    readonly translationZh: string | null;
    /** Part of speech, spelled out. */
    readonly pos: string | null;
    /** Inflection summary, in the ECDICT `d:/p:/i:/3:` shorthand. */
    readonly exchange: string | null;
    /** Corpus frequency hint; larger is more common. */
    readonly frequency: number | null;
}
/** One surface form that resolves to a headword. */
export interface FixtureForm {
    /** The inflected surface form; the primary key, matched case-insensitively. */
    readonly form: string;
    /** The headword this form belongs to. */
    readonly headword: string;
    /** Grammatical label, or `null` when the relationship needs no name. */
    readonly kind: string | null;
}
/** One bilingual example sentence. */
export interface FixtureExample {
    /** Explicit surrogate key, so ordering never depends on insert order. */
    readonly id: number;
    /** The headword this sentence illustrates. */
    readonly headword: string;
    /** English sentence. */
    readonly english: string;
    /** Chinese rendering, or `null` when none was written. */
    readonly chinese: string | null;
    /** Provenance; always {@link FIXTURE_EXAMPLE_SOURCE} for this fixture. */
    readonly source: string;
    /** Stable identifier of this sentence within {@link source}. */
    readonly sourceId: string | null;
    /** Retrieval score; higher sorts first. */
    readonly score: number | null;
}
/** Headwords, in the order they are inserted. */
export declare const FIXTURE_ENTRIES: readonly FixtureEntry[];
/** Surface forms and the headword each resolves to, in insert order. */
export declare const FIXTURE_FORMS: readonly FixtureForm[];
/**
 * Example sentences, written for this project.
 *
 * Nothing here is copied from a corpus: the Phase 3 brief forbids importing
 * ECDICT or Tatoeba, and an example that claimed a third-party `source` would
 * misrepresent where it came from.
 */
export declare const FIXTURE_EXAMPLES: readonly FixtureExample[];
/**
 * Metadata rows written into `meta`.
 *
 * `schema_version` is the number a future migration reads; the `*_count` rows
 * let a reader detect a truncated file without scanning every table. The counts
 * are derived from the arrays rather than written out, so a row added above
 * cannot leave the metadata lying about the file's size.
 */
export declare const FIXTURE_META: Readonly<Record<string, string>>;
/**
 * Data-definition statements, executed in order.
 *
 * `IF NOT EXISTS` makes materialising an already-initialized database a no-op
 * rather than an error; the builder clears the tables before seeding, so the
 * clause is about idempotence, not about tolerating a half-built file.
 */
export declare const SCHEMA_SQL: readonly string[];
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
export declare const INDEX_SQL: readonly string[];
/** The tables a fixture database must contain, in creation order. */
export declare const FIXTURE_TABLES: readonly string[];
/** A prepared statement, reduced to what the fixture code uses. */
export interface FixtureStatement {
    /** Execute with bound parameters; returns driver-specific detail. */
    run(...parameters: (string | number | null)[]): unknown;
    /** Fetch one row, or `undefined`. */
    get(...parameters: (string | number | null)[]): unknown;
    /** Fetch every row. */
    all(...parameters: (string | number | null)[]): unknown[];
}
/** The slice of a SQLite connection the fixture code needs. */
export interface FixtureDatabase {
    /** Execute SQL with no parameters. Never receives caller-supplied text. */
    exec(sql: string): void;
    /** Prepare a statement for parameterized use. */
    prepare(sql: string): FixtureStatement;
}
/** Create every table and index. Safe to call on an initialized database. */
export declare function createFixtureSchema(db: FixtureDatabase): void;
/**
 * Remove every row, leaving the schema in place.
 *
 * The statements are literals rather than assembled from a table list: every
 * piece of SQL this module executes is a fixed string, which is what lets a
 * reader check by inspection that no query is ever built from caller input.
 */
export declare function clearFixture(db: FixtureDatabase): void;
/**
 * Write the fixture into an already-schema'd database.
 *
 * The whole write is one transaction issued by the caller, so a failure part way
 * through leaves the previous content intact rather than a half-seeded file.
 * Every value is bound, never interpolated.
 *
 * @param db - the target database.
 */
export declare function seedFixture(db: FixtureDatabase): void;
/** Row counts a correct fixture database must have. */
export interface FixtureCounts {
    readonly entries: number;
    readonly forms: number;
    readonly examples: number;
}
/** The counts {@link FIXTURE_ENTRIES} and friends imply. */
export declare function expectedFixtureCounts(): FixtureCounts;
/** Outcome of {@link validateFixture}. */
export interface FixtureValidation {
    /** Whether every structural and row-level expectation held. */
    readonly ok: boolean;
    /** Human-readable failures, empty when {@link ok}. */
    readonly problems: readonly string[];
    /** Counts actually read from the database. */
    readonly counts: FixtureCounts;
    /** Counts the fixture definition implies. */
    readonly expected: FixtureCounts;
    /** Raw `meta` rows, for the report. */
    readonly meta: Readonly<Record<string, string>>;
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
export declare function validateFixture(db: FixtureDatabase): FixtureValidation;
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
export declare function dumpFixture(db: FixtureDatabase): Record<string, unknown[]>;
