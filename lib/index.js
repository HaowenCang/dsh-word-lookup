import z from "@deepseek-ai/schemastery";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
//#region src/host/config.ts
/**
* Host configuration of `dsh-word-lookup`.
*
* The DSH settings service reads this schema from the loader entry's runtime
* (`entry.fiber.runtime.Config`) and projects **only** the fields carrying
* `.volatile()` metadata as a browser-editable form. The entry id in
* `cordis.patch.yml` — `dsh-word-lookup` — is the namespace those writes address,
* which is why the two strings must stay equal.
*
* v0.2.0 expands the configuration model to manage the dictionary operational
* mode (`fixture`, `managed-ecdict`, `custom`) and optional custom SQLite path
* alongside the existing automatic gesture switches (`autoDoubleClick`, `autoSelection`).
* All fields are top-level independent `.volatile()` declarations so that DSH
* settings forms can project and edit them without remounting the host entry.
*
* Defaults:
* - `dictionaryMode = 'fixture'`
* - `customDictionaryPath = ''`
* - `autoDoubleClick = false`
* - `autoSelection = false`
*
* @module dsh-word-lookup/host/config
*/
/** The plugin's configuration schema, exported under the name DSH looks for. */
const Config = z.object({
	/**
	* Active dictionary operational mode.
	*
	* Supported modes:
	* - 'fixture': deterministic built-in offline fixture dictionary (default).
	* - 'managed-ecdict': downloaded and managed full ECDICT corpus (Phase 7A.2+).
	* - 'custom': user-supplied custom SQLite dictionary file path (Phase 7A.8).
	*
	* In Phase 7A.1, the runtime defaults to and always executes against fixture.
	*/
	dictionaryMode: z.union([
		"fixture",
		"managed-ecdict",
		"custom"
	]).default("fixture").description("Active dictionary mode (fixture, managed-ecdict, or custom)").volatile(),
	/**
	* Host filesystem path to an advanced custom SQLite dictionary.
	*
	* Only takes effect when dictionaryMode === 'custom' (activation deferred to Phase 7A.8).
	* Defaults to empty string on fresh install (absent or logically empty).
	*/
	customDictionaryPath: z.string().default("").description("Host filesystem path to a custom SQLite dictionary database").volatile(),
	/**
	* Automatic lookup after a completed double click. Off by default.
	*
	* The description is not decoration. Phase 3 shipped this switch with no
	* behaviour behind it, so the settings row was a promise the plugin did not
	* keep; Phase 4 makes it true, and the text says exactly which gesture it
	* answers — a double click — so the row cannot be read as "look up whenever
	* the selection changes".
	*/
	autoDoubleClick: z.boolean().default(false).description("Automatically look up a word after double-clicking it").volatile(),
	/**
	* Automatic lookup after a completed drag selection. Off by default.
	*
	* "after dragging to select text" is the load-bearing phrase: this switch
	* answers a finished pointer drag, not a `selectionchange` event. A keyboard
	* selection, a programmatic one and the selection a double click produces are
	* all deliberately outside it.
	*/
	autoSelection: z.boolean().default(false).description("Automatically look up after dragging to select text").volatile()
});
/**
* Read one live volatile boolean switch.
*
* The settings service rewrites the same reference in place when a browser write
* is accepted, so a read at request time observes the newest value without any
* subscription on the host side.
*
* @param config - the parsed plugin configuration, or `undefined` before the
* first parse.
* @param field - the boolean switch field to read.
* @returns the current boolean value, or `false` when the configuration is absent.
*/
function readSwitch(config, field) {
	const value = config?.[field];
	return value === void 0 ? false : value.get() === true;
}
/**
* Read the current live dictionary mode from volatile configuration.
*
* @param config - the parsed plugin configuration, or `undefined`.
* @returns the active DictionaryMode ('fixture' | 'managed-ecdict' | 'custom'), defaulting to 'fixture'.
*/
function readDictionaryMode(config) {
	const value = config?.dictionaryMode?.get();
	return value === "managed-ecdict" || value === "custom" || value === "fixture" ? value : "fixture";
}
//#endregion
//#region src/host/dictionary.ts
/**
* Raised when a dictionary cannot answer because its store is unusable.
*
* Distinguished from a miss on purpose: "this word is not in the dictionary" is
* a `200` with `found: false`, while "the dictionary is not open" is a server
* fault. Collapsing the two would let a lifecycle bug look like a small
* vocabulary.
*/
var DictionaryUnavailableError = class extends Error {
	/** Stable machine-readable reason, safe to put on the wire. */
	code = "dictionary-unavailable";
	/**
	* @param message - what was wrong with the store.
	*/
	constructor(message) {
		super(message);
		this.name = "DictionaryUnavailableError";
	}
};
/** Revision of the fixture *contents*; bumped when a row changes. */
const FIXTURE_VERSION = "phase3-fixture-1";
/** Provenance recorded for every example row. Never a third-party corpus. */
const FIXTURE_EXAMPLE_SOURCE = "dsh-word-lookup-fixture";
/** Headwords, in the order they are inserted. */
const FIXTURE_ENTRIES = [
	{
		word: "derive",
		phonetic: "/dɪˈraɪv/",
		definitionEn: "obtain something from a specified source; originate in",
		translationZh: "导出；派生；源自",
		pos: "verb",
		exchange: "d:derived/p:derived/i:deriving/3:derives",
		frequency: 8200
	},
	{
		word: "go",
		phonetic: "/ɡəʊ/",
		definitionEn: "move or travel from one place to another",
		translationZh: "去；走；进行",
		pos: "verb",
		exchange: "d:went/p:gone/i:going/3:goes",
		frequency: 1e5
	},
	{
		word: "tooth",
		phonetic: "/tuːθ/",
		definitionEn: "each of a set of hard structures set in the jaws",
		translationZh: "牙齿；齿",
		pos: "noun",
		exchange: "s:teeth",
		frequency: 12e3
	},
	{
		word: "conservation",
		phonetic: "/ˌkɒnsəˈveɪʃn/",
		definitionEn: "the principle that a quantity of a closed system stays constant",
		translationZh: "守恒；保存；保护",
		pos: "noun",
		exchange: null,
		frequency: 5400
	},
	{
		word: "wave function",
		phonetic: "/weɪv ˈfʌŋkʃn/",
		definitionEn: "a mathematical description of the quantum state of a system",
		translationZh: "波函数",
		pos: "noun phrase",
		exchange: "s:wave functions",
		frequency: 2100
	},
	{
		word: "wave",
		phonetic: "/weɪv/",
		definitionEn: "a disturbance that transfers energy through a medium",
		translationZh: "波；波浪",
		pos: "noun",
		exchange: "s:waves",
		frequency: 4e4
	},
	{
		word: "function",
		phonetic: "/ˈfʌŋkʃn/",
		definitionEn: "a relation that assigns exactly one output to each input",
		translationZh: "函数；功能",
		pos: "noun",
		exchange: "s:functions",
		frequency: 6e4
	}
];
/** Surface forms and the headword each resolves to, in insert order. */
const FIXTURE_FORMS = [
	{
		form: "derived",
		headword: "derive",
		kind: "past"
	},
	{
		form: "derives",
		headword: "derive",
		kind: "third-person singular"
	},
	{
		form: "deriving",
		headword: "derive",
		kind: "present participle"
	},
	{
		form: "went",
		headword: "go",
		kind: "past"
	},
	{
		form: "gone",
		headword: "go",
		kind: "past participle"
	},
	{
		form: "goes",
		headword: "go",
		kind: "third-person singular"
	},
	{
		form: "going",
		headword: "go",
		kind: "present participle"
	},
	{
		form: "teeth",
		headword: "tooth",
		kind: "plural"
	},
	{
		form: "wave functions",
		headword: "wave function",
		kind: "plural"
	},
	{
		form: "waves",
		headword: "wave",
		kind: "plural"
	},
	{
		form: "functions",
		headword: "function",
		kind: "plural"
	}
];
/**
* Example sentences, written for this project.
*
* Nothing here is copied from a corpus: the Phase 3 brief forbids importing
* ECDICT or Tatoeba, and an example that claimed a third-party `source` would
* misrepresent where it came from.
*/
const FIXTURE_EXAMPLES = [
	{
		id: 1,
		headword: "derive",
		english: "The result must derive from the boundary conditions alone.",
		chinese: "该结果只能由边界条件导出。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "derive-1",
		score: .9
	},
	{
		id: 2,
		headword: "derive",
		english: "This identity derives from Gauss’s law.",
		chinese: "这一恒等式源自高斯定律。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "derive-2",
		score: .8
	},
	{
		id: 3,
		headword: "go",
		english: "The measurement went the other way.",
		chinese: "测量结果朝相反方向变化了。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "go-1",
		score: .7
	},
	{
		id: 4,
		headword: "tooth",
		english: "Each tooth has a crown and one or more roots.",
		chinese: "每颗牙齿都有一个牙冠和一条或多条牙根。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "tooth-1",
		score: .6
	},
	{
		id: 5,
		headword: "conservation",
		english: "Charge conservation follows from the symmetry of the Lagrangian.",
		chinese: "电荷守恒来自拉格朗日量的对称性。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "conservation-1",
		score: .85
	},
	{
		id: 6,
		headword: "conservation",
		english: "Energy conservation forbids that transition.",
		chinese: "能量守恒禁戒该跃迁。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "conservation-2",
		score: .5
	},
	{
		id: 7,
		headword: "wave function",
		english: "The wave function collapses on measurement.",
		chinese: "波函数在测量时坍缩。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "wavefunction-1",
		score: .95
	},
	{
		id: 8,
		headword: "wave function",
		english: "A normalizable wave function belongs to the Hilbert space.",
		chinese: "可归一化的波函数属于希尔伯特空间。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "wavefunction-2",
		score: .4
	},
	{
		id: 9,
		headword: "wave",
		english: "The wave carries energy without carrying matter.",
		chinese: "波传递能量而不传递物质。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "wave-1",
		score: .55
	},
	{
		id: 10,
		headword: "function",
		english: "A function maps every input to exactly one output.",
		chinese: "函数把每个输入映射到恰好一个输出。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "function-1",
		score: .65
	},
	{
		id: 11,
		headword: "function",
		english: "The delta function is not a function in the classical sense.",
		chinese: "δ 函数在经典意义下并不是函数。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "function-2",
		score: .3
	},
	{
		id: 12,
		headword: "tooth",
		english: "A chipped tooth can usually be repaired.",
		chinese: "缺损的牙齿通常可以修复。",
		source: FIXTURE_EXAMPLE_SOURCE,
		sourceId: "tooth-2",
		score: .2
	}
];
/**
* Metadata rows written into `meta`.
*
* `schema_version` is the number a future migration reads; the `*_count` rows
* let a reader detect a truncated file without scanning every table. The counts
* are derived from the arrays rather than written out, so a row added above
* cannot leave the metadata lying about the file's size.
*/
const FIXTURE_META = {
	schema_version: String(1),
	fixture_version: FIXTURE_VERSION,
	generator: "scripts/build-fixture-db.mjs",
	example_source: FIXTURE_EXAMPLE_SOURCE,
	entries_count: String(FIXTURE_ENTRIES.length),
	forms_count: String(FIXTURE_FORMS.length),
	examples_count: String(FIXTURE_EXAMPLES.length)
};
/**
* Data-definition statements, executed in order.
*
* `IF NOT EXISTS` makes materialising an already-initialized database a no-op
* rather than an error; the builder clears the tables before seeding, so the
* clause is about idempotence, not about tolerating a half-built file.
*/
const SCHEMA_SQL = [
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
   )`
];
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
const INDEX_SQL = [`CREATE INDEX IF NOT EXISTS idx_forms_headword ON forms (headword COLLATE NOCASE)`, `CREATE INDEX IF NOT EXISTS idx_examples_headword ON examples (headword COLLATE NOCASE)`];
/** The tables a fixture database must contain, in creation order. */
const FIXTURE_TABLES = [
	"meta",
	"entries",
	"forms",
	"examples"
];
/** Create every table and index. Safe to call on an initialized database. */
function createFixtureSchema(db) {
	for (const statement of SCHEMA_SQL) db.exec(statement);
	for (const statement of INDEX_SQL) db.exec(statement);
}
/**
* Remove every row, leaving the schema in place.
*
* The statements are literals rather than assembled from a table list: every
* piece of SQL this module executes is a fixed string, which is what lets a
* reader check by inspection that no query is ever built from caller input.
*/
function clearFixture(db) {
	db.exec("DELETE FROM examples");
	db.exec("DELETE FROM forms");
	db.exec("DELETE FROM entries");
	db.exec("DELETE FROM meta");
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
function seedFixture(db) {
	const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
	const insertEntry = db.prepare("INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency) VALUES (?, ?, ?, ?, ?, ?, ?)");
	const insertForm = db.prepare("INSERT INTO forms (form, headword, kind) VALUES (?, ?, ?)");
	const insertExample = db.prepare("INSERT INTO examples (id, headword, english, chinese, source, source_id, score) VALUES (?, ?, ?, ?, ?, ?, ?)");
	for (const [key, value] of Object.entries(FIXTURE_META)) insertMeta.run(key, value);
	for (const entry of FIXTURE_ENTRIES) insertEntry.run(entry.word, entry.phonetic, entry.definitionEn, entry.translationZh, entry.pos, entry.exchange, entry.frequency);
	for (const form of FIXTURE_FORMS) insertForm.run(form.form, form.headword, form.kind);
	for (const example of FIXTURE_EXAMPLES) insertExample.run(example.id, example.headword, example.english, example.chinese, example.source, example.sourceId, example.score);
}
/** The counts {@link FIXTURE_ENTRIES} and friends imply. */
function expectedFixtureCounts() {
	return {
		entries: FIXTURE_ENTRIES.length,
		forms: FIXTURE_FORMS.length,
		examples: FIXTURE_EXAMPLES.length
	};
}
/**
* Row counts of the three data tables.
*
* The statements are literals keyed by table name rather than built from it, so
* this module contains no SQL assembled from a variable — a property the SQL
* safety test asserts by scanning the source.
*/
const COUNT_SQL = {
	entries: "SELECT COUNT(*) AS n FROM entries",
	forms: "SELECT COUNT(*) AS n FROM forms",
	examples: "SELECT COUNT(*) AS n FROM examples"
};
/** Read one `COUNT(*)`, treating anything unexpected as a failure. */
function readCount(db, table) {
	const value = db.prepare(COUNT_SQL[table]).get()?.n;
	return typeof value === "number" ? value : -1;
}
/** Read the whole `meta` table as a plain object. */
function readMeta$1(db) {
	const rows = db.prepare("SELECT key, value FROM meta ORDER BY key").all();
	const meta = {};
	for (const row of rows) meta[row.key] = row.value;
	return meta;
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
function validateFixture(db) {
	const problems = [];
	const expected = expectedFixtureCounts();
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
	for (const table of FIXTURE_TABLES) if (!tables.includes(table)) problems.push(`missing table: ${table}`);
	let counts = {
		entries: -1,
		forms: -1,
		examples: -1
	};
	let meta = {};
	if (problems.length === 0) {
		counts = {
			entries: readCount(db, "entries"),
			forms: readCount(db, "forms"),
			examples: readCount(db, "examples")
		};
		meta = readMeta$1(db);
		if (meta.schema_version !== String(1)) problems.push(`meta.schema_version is ${String(meta.schema_version)}, expected ${String(1)}`);
		if (meta.fixture_version !== "phase3-fixture-1") problems.push(`meta.fixture_version is ${String(meta.fixture_version)}, expected ${FIXTURE_VERSION}`);
		for (const column of [
			"entries",
			"forms",
			"examples"
		]) {
			if (Number(meta[`${column}_count`]) !== expected[column]) problems.push(`meta.${column}_count is ${String(meta[`${column}_count`])}, expected ${String(expected[column])}`);
			if (counts[column] !== expected[column]) problems.push(`${column} holds ${String(counts[column])} rows, expected ${String(expected[column])}`);
		}
		const orphans = db.prepare("SELECT form FROM forms WHERE headword NOT IN (SELECT word FROM entries) ORDER BY form").all();
		for (const orphan of orphans) problems.push(`form "${orphan.form}" points at a missing headword`);
		const strayExamples = db.prepare("SELECT id FROM examples WHERE headword NOT IN (SELECT word FROM entries) ORDER BY id").all();
		for (const stray of strayExamples) problems.push(`example ${String(stray.id)} belongs to a missing headword`);
	}
	return {
		ok: problems.length === 0,
		problems,
		counts,
		expected,
		meta
	};
}
//#endregion
//#region src/host/sqlite-dictionary.ts
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
/**
* Statements, as literals.
*
* Kept in one object so a reader can see every query the dictionary can issue
* without following a call graph, and so the "no assembled SQL" property is
* checkable at a glance.
*/
const SQL = {
	tableExists: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
	metaValue: "SELECT value FROM meta WHERE key = ?",
	entryByWord: "SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?",
	headwordByForm: "SELECT headword FROM forms WHERE form = ?",
	formsByHeadword: "SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE",
	examplesByHeadword: "SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC"
};
/**
* Turn a driver row into an optional-string field.
*
* @param value - the column value.
* @returns the string, or `null` for anything that is not one.
*/
function asText(value) {
	return typeof value === "string" ? value : null;
}
/**
* Turn a driver row into an optional-number field.
*
* @param value - the column value.
* @returns the number, or `null` for anything that is not one.
*/
function asNumber(value) {
	return typeof value === "number" ? value : null;
}
/**
* A SQLite connection that is opened and closed exactly once.
*
* Constructed only by {@link openSqliteDictionary}, which is what guarantees the
* schema and rows were validated before the first query.
*/
var SqliteDictionary = class {
	source;
	#db;
	#closed = { value: false };
	#info;
	/**
	* @param db - an open connection whose schema and rows are already valid.
	* @param info - what initialization did, for evidence.
	* @param source - dictionary provenance identifier.
	*/
	constructor(db, info, source = "sqlite-fixture") {
		this.#db = db;
		this.#info = info;
		this.source = source;
	}
	/** What opening this database did. Read-only. */
	get initialization() {
		return this.#info;
	}
	/**
	* Resolve one normalized query.
	*
	* @param normalizedQuery - the normalized selection.
	* @returns a hit or a miss.
	* @throws {DictionaryUnavailableError} when the store has been closed.
	*/
	lookup(normalizedQuery) {
		if (this.#closed.value) throw new DictionaryUnavailableError("the dictionary was closed before it answered");
		const exact = this.#db.prepare(SQL.entryByWord).get(normalizedQuery);
		if (exact !== void 0) return this.#hit(normalizedQuery, exact, null);
		const form = this.#db.prepare(SQL.headwordByForm).get(normalizedQuery);
		if (form === void 0) return {
			found: false,
			query: normalizedQuery
		};
		const inflected = this.#db.prepare(SQL.entryByWord).get(form.headword);
		if (inflected === void 0) throw new DictionaryUnavailableError(`the fixture maps "${normalizedQuery}" to "${form.headword}", which has no entry`);
		return this.#hit(normalizedQuery, inflected, normalizedQuery);
	}
	/** Release the connection. Idempotent. */
	close() {
		if (this.#closed.value) return;
		this.#closed.value = true;
		this.#db.close();
	}
	/**
	* Assemble a hit from the entry row plus its forms and examples.
	*
	* @param query - the normalized query.
	* @param row - the entry the query resolved to.
	* @param matchedForm - the surface form matched, or `null` for an exact entry.
	* @returns the assembled hit.
	*/
	#hit(query, row, matchedForm) {
		const sense = {
			partOfSpeech: asText(row.pos),
			definition: asText(row.definition_en),
			translation: asText(row.translation_zh)
		};
		const senses = sense.definition === null && sense.translation === null ? [] : [sense];
		const forms = this.#db.prepare(SQL.formsByHeadword).all(row.word).map((form) => ({
			form: form.form,
			kind: asText(form.kind)
		}));
		const examples = this.#db.prepare(SQL.examplesByHeadword).all(row.word).map((example) => ({
			en: example.english,
			zh: asText(example.chinese),
			source: asText(example.source),
			sourceId: asText(example.source_id),
			score: asNumber(example.score)
		}));
		return {
			found: true,
			query,
			headword: row.word,
			phonetic: asText(row.phonetic),
			senses,
			forms,
			matchedForm,
			examples
		};
	}
};
/**
* Read one `meta` value.
*
* @param db - an open connection whose `meta` table exists.
* @param key - the key to read.
* @returns the value, or `undefined`.
*/
function readMeta(db, key) {
	const row = db.prepare(SQL.metaValue).get(key);
	return typeof row?.value === "string" ? row.value : void 0;
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
function inTransaction(db, body) {
	db.exec("BEGIN IMMEDIATE");
	try {
		body();
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
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
function initialize(db) {
	const hasMeta = db.prepare(SQL.tableExists).get("meta") !== void 0;
	let created = false;
	if (!hasMeta) {
		createFixtureSchema(db);
		created = true;
	}
	const before = validateFixture(db);
	if (!before.ok) {
		createFixtureSchema(db);
		inTransaction(db, () => {
			clearFixture(db);
			seedFixture(db);
		});
	}
	const after = validateFixture(db);
	if (!after.ok) throw new DictionaryUnavailableError(`the fixture database is not usable after initialization: ${after.problems.join("; ")}`);
	return {
		created,
		seeded: !before.ok
	};
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
function openSqliteDictionary(options) {
	const readOnly = options.readOnly === true;
	const inMemory = options.path === ":memory:";
	if (!inMemory && !readOnly) mkdirSync(dirname(options.path), { recursive: true });
	const existed = inMemory ? false : existsSync(options.path);
	if (readOnly && !existed) throw new DictionaryUnavailableError(`no fixture database at ${options.path}`);
	let db;
	try {
		db = new DatabaseSync(options.path, readOnly ? { readOnly: true } : {});
		const setup = readOnly ? {
			created: false,
			seeded: false
		} : initialize(db);
		const schemaVersion = Number(readMeta(db, "schema_version"));
		if (schemaVersion !== 1) throw new DictionaryUnavailableError(`the fixture database at ${options.path} is schema ${String(schemaVersion)}, expected ${String(1)}`);
		const fixtureVersion = readMeta(db, "fixture_version") ?? "";
		return new SqliteDictionary(db, {
			path: options.path,
			created: setup.created,
			seeded: setup.seeded,
			schemaVersion,
			fixtureVersion,
			existed
		}, options.source ?? "sqlite-fixture");
	} catch (error) {
		try {
			db?.close();
		} catch {}
		if (error instanceof DictionaryUnavailableError) throw error;
		throw new DictionaryUnavailableError(`cannot open the fixture dictionary at ${options.path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
//#endregion
//#region src/host/fixture-db.ts
/**
* Where the fixture database lives, and how the host opens it.
*
* Phase 3 adds **no configuration field** for the database location. The
* verified Phase 0 contract for this DSH generation exposes exactly
* `autoDoubleClick` and `autoSelection`, and a `dictionaryPath` a reader could
* point at an arbitrary file would be both an unverified settings surface and a
* way to make a lookup read something that is not the dictionary. The path is
* therefore *derived from the package's own location*, which is the one place
* the plugin can be sure about:
*
* ```text
* <package root>/fixtures/dictionary.fixture.db
* ```
*
* The package root is found by walking up from this module's own URL until a
* `package.json` naming this package is reached. That works unchanged from the
* two positions this module is loaded from — `src/host/` under vitest and
* `lib/index.js` in the published bundle — and it follows the junction an
* isolated DSH profile installs, because Node resolves module paths to their
* real location by default.
*
* A production corpus is a later phase's problem. When it lands it must not
* reuse this function: the file name asserts what the file is, and a corpus is
* not a fixture.
*
* @module dsh-word-lookup/host/fixture-db
*/
/** Package name the root search matches against `package.json`. */
const PACKAGE_NAME = "dsh-word-lookup";
/** Directory holding generated, package-owned test data. */
const FIXTURE_DIRECTORY = "fixtures";
/** File name of the generated fixture database. */
const FIXTURE_FILE_NAME = "dictionary.fixture.db";
/** How many directory levels the root search will climb before giving up. */
const MAX_SEARCH_DEPTH = 12;
/**
* Find the package root by climbing from a module URL.
*
* @param fromUrl - a `file:` URL inside the package; defaults to this module.
* @returns the absolute package root.
* @throws {DictionaryUnavailableError} when no ancestor `package.json` names
* this package, which means the module is not being loaded from its own tree.
*/
function findPackageRoot(fromUrl = import.meta.url) {
	let directory = dirname(fileURLToPath(fromUrl));
	for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest) && statSync(manifest).isFile()) try {
			if (JSON.parse(readFileSync(manifest, "utf8")).name === "dsh-word-lookup") return directory;
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new DictionaryUnavailableError(`cannot locate the ${PACKAGE_NAME} package root from ${fromUrl}`);
}
/**
* Absolute path of the package-owned fixture database.
*
* The path is not configurable and is not read from the environment. It is a
* pure function of where the package is installed.
*
* @param fromUrl - a `file:` URL inside the package; defaults to this module.
* @returns the absolute path the host opens.
*/
function resolveFixtureDatabasePath(fromUrl = import.meta.url) {
	return join(findPackageRoot(fromUrl), FIXTURE_DIRECTORY, FIXTURE_FILE_NAME);
}
/**
* Open the host's production dictionary: the package-owned SQLite fixture.
*
* This is the only call site the plugin's runtime uses, and it is deliberately
* the only place the production path is named. Everything else takes a
* `Dictionary` and does not know what backs it.
*
* @param options - test-only overrides.
* @returns an open dictionary over the package's fixture database.
* @throws {DictionaryUnavailableError} when the fixture cannot be opened.
*/
function openFixtureDictionary(options = {}) {
	return openSqliteDictionary({
		path: resolveFixtureDatabasePath(options.fromUrl ?? import.meta.url),
		readOnly: options.readOnly === true
	});
}
//#endregion
//#region src/host/corpus-db.ts
/**
* Production corpus database resolution, metadata validation, and opening.
*
* Implements production corpus loading and validation with strict guarantees:
* - Deterministic path resolution via explicit `options.path` or default package corpus path.
* - Validates production metadata against package-owned `corpus/ecdict.manifest.json`:
*   - `schema_version` matches pinned schema version.
*   - `corpus_name` === 'ECDICT'.
*   - `upstream_commit` matches manifest.sourceCommit.
*   - `source_sha256` matches manifest.sourceSha256.
*   - Required tables (`meta`, `entries`, `forms`, `examples`) and indexes exist.
* - Always opened read-only at runtime (`readOnly: true`).
* - Never mutates production files during runtime or tests.
* - Never silently downloads or attempts network operations if the database is missing.
* - Never falls back to fixture database or AI when production database is requested but missing/invalid.
* - Reports dictionary provenance as `'ecdict-local'`.
* - Throws a clean {@link DictionaryUnavailableError} on failure.
*
* @module dsh-word-lookup/host/corpus-db
*/
/** Default relative directory holding the built production corpus database. */
const CORPUS_DIRECTORY$1 = join("build", "corpus");
/** Default file name of the production corpus database. */
const CORPUS_FILE_NAME = "ecdict.db";
/** Relative path to the package-owned manifest. */
const MANIFEST_RELATIVE_PATH = join("corpus", "ecdict.manifest.json");
/**
* Load the package-owned corpus manifest for runtime production metadata validation.
*
* @param fromUrl - base URL used to resolve the package root.
* @returns parsed {@link CorpusManifestData}.
*/
function loadRuntimeCorpusManifest(fromUrl) {
	const root = findPackageRoot(fromUrl ?? import.meta.url);
	const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
	if (!existsSync(manifestPath)) throw new DictionaryUnavailableError(`corpus manifest not found at "${manifestPath}"`);
	try {
		const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
		return {
			sourceName: String(raw.sourceName ?? ""),
			sourceCommit: raw.sourceCommit,
			sourceSha256: raw.sourceSha256,
			schemaVersion: Number(raw.schemaVersion)
		};
	} catch (err) {
		throw new DictionaryUnavailableError(`failed to read corpus manifest at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`);
	}
}
/**
* Resolve the absolute path to the production corpus SQLite database.
*
* Precedence:
* 1. Explicit `options.path`
* 2. Default `<package root>/build/corpus/ecdict.db`
*
* @param options - path resolution options.
* @returns absolute resolved path.
*/
function resolveProductionDatabasePath(options = {}) {
	if (options.path) return options.path;
	const root = findPackageRoot(options.fromUrl ?? import.meta.url);
	return join(root, CORPUS_DIRECTORY$1, CORPUS_FILE_NAME);
}
/**
* Validate that an opened SQLite database matches the pinned production corpus metadata and schema.
*
* @param db - open DatabaseSync connection.
* @param expectedManifest - expected manifest metadata.
* @param dbPath - path to database for error reporting.
*/
function validateProductionMetadata(db, expectedManifest, dbPath) {
	const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
	for (const table of [
		"meta",
		"entries",
		"forms",
		"examples"
	]) if (!tableStmt.get(table)) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" is missing required table "${table}"`);
	for (const [table, spec] of Object.entries({
		meta: {
			pk: "key",
			columns: ["key", "value"]
		},
		entries: {
			pk: "word",
			columns: [
				"word",
				"phonetic",
				"definition_en",
				"translation_zh",
				"pos",
				"exchange",
				"frequency"
			]
		},
		forms: {
			pk: "form",
			columns: [
				"form",
				"headword",
				"kind"
			]
		},
		examples: {
			pk: "id",
			columns: [
				"id",
				"headword",
				"english",
				"chinese",
				"source",
				"source_id",
				"score"
			]
		}
	})) {
		const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
		const colNames = new Set(cols.map((c) => c.name));
		for (const col of spec.columns) if (!colNames.has(col)) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" table "${table}" is missing required column "${col}"`);
		const pkCol = cols.find((c) => c.name === spec.pk);
		if (!pkCol || pkCol.pk <= 0) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" table "${table}" column "${spec.pk}" must be primary key`);
	}
	const metaStmt = db.prepare("SELECT key, value FROM meta");
	const meta = /* @__PURE__ */ new Map();
	try {
		const rows = metaStmt.all();
		for (const r of rows) meta.set(r.key, r.value);
	} catch (err) {
		throw new DictionaryUnavailableError(`cannot read meta table in production corpus database at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`);
	}
	const schemaVersion = Number(meta.get("schema_version"));
	if (schemaVersion !== expectedManifest.schemaVersion) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has schema_version ${schemaVersion}, expected ${expectedManifest.schemaVersion}`);
	const corpusName = meta.get("corpus_name");
	if (corpusName !== expectedManifest.sourceName) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has corpus_name "${corpusName}", expected "${expectedManifest.sourceName}"`);
	const upstreamCommit = meta.get("upstream_commit");
	if (upstreamCommit !== expectedManifest.sourceCommit) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has upstream_commit "${upstreamCommit}", expected "${expectedManifest.sourceCommit}"`);
	const sourceSha256 = meta.get("source_sha256");
	if (sourceSha256 !== expectedManifest.sourceSha256) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has source_sha256 "${sourceSha256}", expected "${expectedManifest.sourceSha256}"`);
	for (const countKey of [
		"entry_count",
		"form_count",
		"example_count"
	]) {
		const val = meta.get(countKey);
		if (val === void 0 || !/^\d+$/.test(val)) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has invalid or missing metadata count "${countKey}": ${val}`);
	}
	const logicalSha256 = meta.get("logical_sha256");
	if (!logicalSha256 || typeof logicalSha256 !== "string" || logicalSha256.length !== 64) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" has invalid or missing metadata logical_sha256: ${logicalSha256}`);
	const indexStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?");
	for (const index of ["idx_forms_headword_raw", "idx_examples_headword"]) if (!indexStmt.get(index)) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" is missing required index "${index}"`);
}
/**
* Open the production corpus SQLite dictionary.
*
* Enforces read-only mode, strict metadata validation against pinned manifest,
* and fail-clean semantics without silent fallback or automatic rebuilding.
*
* @param options - configuration options.
* @returns open {@link SqliteDictionary} with provenance `'ecdict-local'`.
* @throws {DictionaryUnavailableError} if the database is missing, corrupted, or incompatible.
*/
function openProductionDictionary(options = {}) {
	const dbPath = resolveProductionDatabasePath(options);
	if (!existsSync(dbPath)) throw new DictionaryUnavailableError(`production corpus database not found at "${dbPath}"; run "npm run corpus:build" first (silent download / fallback is prohibited)`);
	try {
		const stats = statSync(dbPath);
		if (!stats.isFile() || stats.size === 0) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" is empty or invalid`);
	} catch (err) {
		if (err instanceof DictionaryUnavailableError) throw err;
		throw new DictionaryUnavailableError(`cannot access production corpus database at "${dbPath}": ${err instanceof Error ? err.message : String(err)}`);
	}
	const manifest = options.manifest ?? loadRuntimeCorpusManifest(options.fromUrl);
	let rawDb;
	try {
		rawDb = new DatabaseSync(dbPath, { readOnly: true });
		validateProductionMetadata(rawDb, manifest, dbPath);
	} catch (err) {
		try {
			rawDb?.close();
		} catch {}
		if (err instanceof DictionaryUnavailableError) throw err;
		throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" is invalid: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		try {
			rawDb?.close();
		} catch {}
	}
	return openSqliteDictionary({
		path: dbPath,
		readOnly: true,
		source: "ecdict-local"
	});
}
//#endregion
//#region src/host/dictionary-manager.ts
/**
* Validate descriptor metadata and mode/source consistency.
*
* Throws on invalid descriptor.
*/
function validateDescriptor(descriptor) {
	if (!descriptor || typeof descriptor !== "object") throw new TypeError("DictionaryActivation descriptor must be an object");
	const { mode, identity, dictionary } = descriptor;
	if (typeof identity !== "string" || identity.trim().length === 0) throw new TypeError("DictionaryActivation identity must be a non-empty string");
	if (!dictionary || typeof dictionary.lookup !== "function" || typeof dictionary.close !== "function") throw new TypeError("DictionaryActivation dictionary must implement Dictionary interface");
	if (mode === "fixture") {
		if (dictionary.source !== "sqlite-fixture") throw new Error(`mode "fixture" requires dictionary source "sqlite-fixture", received "${dictionary.source}"`);
	} else if (mode === "managed-ecdict" || mode === "custom") {
		if (dictionary.source !== "ecdict-local") throw new Error(`mode "${mode}" requires dictionary source "ecdict-local", received "${dictionary.source}"`);
	} else throw new Error(`unsupported dictionary mode: "${String(mode)}"`);
	return {
		mode,
		identity: identity.trim(),
		dictionary
	};
}
/**
* Manages active dictionary lifecycle and provides atomic hot switching.
*
* Implements {@link Dictionary} to present a stable queryable interface.
*/
var DictionaryManager = class {
	#active;
	#generation = 1;
	#closed = false;
	#lastRetirementError = null;
	/**
	* Create a new DictionaryManager with an initial dictionary.
	*
	* Once constructed, the manager assumes exclusive ownership of the dictionary handle.
	* If construction fails validation, the initial dictionary is closed to prevent leaks.
	*
	* @param initial - initial activation descriptor.
	*/
	constructor(initial) {
		try {
			const validated = validateDescriptor(initial);
			this.#active = validated;
		} catch (error) {
			try {
				initial?.dictionary?.close?.();
			} catch {}
			throw error;
		}
	}
	/**
	* Source provenance of the currently active dictionary.
	*/
	get source() {
		return this.#active.dictionary.source;
	}
	/**
	* Resolve one query against the currently active dictionary.
	*
	* Captures the active dictionary reference in a local variable to ensure
	* the lookup is bound to a single generation.
	*
	* @param normalizedQuery - normalized headword query.
	* @returns dictionary lookup result.
	* @throws {DictionaryUnavailableError} if the manager has been closed.
	*/
	lookup(normalizedQuery) {
		if (this.#closed) throw new DictionaryUnavailableError("dictionary manager has been closed");
		return this.#active.dictionary.lookup(normalizedQuery);
	}
	/**
	* Atomically activate a new dictionary candidate.
	*
	* Candidate ownership contract:
	* - Distinct candidate:
	*   Ownership transfers to manager on activate() invocation.
	* - Aliased currently-active candidate:
	*   Rejected as an ownership violation (TypeError);
	*   remains manager-owned; must not be closed by rejection cleanup.
	*
	* Requirements:
	* - Candidate dictionary must already be opened and validated prior to calling `activate()`.
	* - If the manager is already closed, candidate is closed immediately and
	*   `DictionaryUnavailableError` is thrown.
	* - A candidate whose dictionary is identical to the currently active dictionary
	*   handle (`candidate.dictionary === this.#active.dictionary`) is rejected as an
	*   ownership violation before descriptor validation. The active handle is NOT closed,
	*   state and generation remain unchanged.
	* - Validates mode/source consistency and identity before mutating active state.
	* - On descriptor validation failure, distinct candidate is closed immediately
	*   to prevent handle leaks, leaving active state untouched.
	* - The new active reference commits before the retired dictionary is closed.
	* - If closing the retired dictionary throws, the new active dictionary remains committed,
	*   generation remains advanced, and the retirement failure is observable without rollback.
	*
	* @param candidate - candidate activation descriptor.
	* @returns structured activation result with generation and retirement status.
	* @throws {DictionaryUnavailableError} if manager is already closed.
	* @throws {TypeError} if candidate reuses the currently active dictionary handle,
	*   or if candidate descriptor is invalid.
	*/
	activate(candidate) {
		if (this.#closed) {
			try {
				candidate?.dictionary?.close?.();
			} catch {}
			throw new DictionaryUnavailableError("cannot activate dictionary: manager is closed");
		}
		if (candidate && typeof candidate === "object" && candidate.dictionary === this.#active.dictionary) throw new TypeError("DictionaryActivation cannot reuse the currently active dictionary handle");
		let validated;
		try {
			validated = validateDescriptor(candidate);
		} catch (error) {
			try {
				candidate?.dictionary?.close?.();
			} catch {}
			throw error;
		}
		const previous = this.#active;
		this.#active = validated;
		this.#generation += 1;
		let retirementClosed = false;
		let retirementError = null;
		try {
			previous.dictionary.close();
			retirementClosed = true;
			this.#lastRetirementError = null;
		} catch (error) {
			retirementClosed = false;
			retirementError = error instanceof Error ? error.message : String(error);
			this.#lastRetirementError = retirementError;
		}
		return {
			generation: this.#generation,
			retirement: {
				closed: retirementClosed,
				error: retirementError
			}
		};
	}
	/**
	* Return an immutable diagnostic snapshot of manager state.
	*/
	snapshot() {
		return Object.freeze({
			lifecycle: this.#closed ? "closed" : "ready",
			generation: this.#generation,
			activeMode: this.#active.mode,
			identity: this.#active.identity,
			source: this.#active.dictionary.source,
			lastRetirementError: this.#lastRetirementError
		});
	}
	/**
	* Release the manager and close the currently active dictionary.
	*
	* Idempotent: safe to call multiple times.
	* Sets lifecycle state to closed before calling underlying close, ensuring
	* fail-closed semantics even if the underlying close throws.
	*/
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#active.dictionary.close();
	}
};
//#endregion
//#region src/shared/protocol.ts
/** Media type the route accepts. Any other request content type is a 400. */
const LOOKUP_MEDIA_TYPE = "application/json";
/**
* Maximum accepted request body size, in bytes.
*
* The transport buffers request bodies in memory before the handler runs, so
* the route states its own far smaller ceiling and refuses anything above it.
*/
const MAX_REQUEST_BYTES = 4096;
//#endregion
//#region src/shared/text.ts
/**
* Punctuation removed from both ends of a raw selection.
*
* Written as two alternatives rather than a single class with a `^`/`$` anchor
* pair so that one pass removes a run of characters from each end. ASCII
* punctuation is listed literally; the Unicode block covers the curly quotes,
* dashes and ellipsis a document export or an LLM transcript actually produces.
*/
const EDGE_PUNCTUATION = /^(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)|(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)$/g;
/** Matches any run of Unicode whitespace. */
const WHITESPACE_RUN = /\s+/gu;
/**
* Count the Unicode code points in a string.
*
* `String.prototype.length` counts UTF-16 code units, so a selection of astral
* characters (emoji, rare CJK extensions) would be measured at twice its length
* and rejected earlier than {@link MAX_QUERY_CODE_POINTS} promises.
*
* @param value - the string to measure.
* @returns the number of code points.
*/
function countCodePoints(value) {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}
/**
* Normalize one raw selection into a headword candidate.
*
* The steps and their order are the product specification's:
*
* ```text
* raw selection
*   -> NFKC                     fold compatibility characters
*   -> collapse whitespace      a line break becomes one space
*   -> strip edge punctuation   a sentence-final period is not part of the word
*   -> lowercase                the lookup is case-normalized
* ```
*
* `NFKC` runs first because it *creates* characters the later steps must then
* see: a full-width `．` folds to `.` and only then reads as edge punctuation, a
* no-break space folds to a space and only then collapses, and the ligature `ﬁ`
* folds to `fi` so a selection from a typeset document reaches the dictionary as
* the word it looks like. Folding after the strip would leave each of those
* unfixed.
*
* What NFKC deliberately does **not** do is fold `’` to `'`. Both survive, and
* because only *edge* punctuation is removed, an apostrophe or hyphen inside a
* word is part of the word: `don't` and `time-dependent` are looked up as
* themselves.
*
* @param raw - the text the reader selected.
* @returns the normalized candidate; the empty string when nothing survives.
*/
function normalizeHeadword(raw) {
	return raw.normalize("NFKC").replace(WHITESPACE_RUN, " ").trim().replace(EDGE_PUNCTUATION, "").trim().replace(WHITESPACE_RUN, " ").toLowerCase();
}
//#endregion
//#region src/host/lookup.ts
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
/** Bodies and headers are never cached: a lookup answers about a live selection. */
const NO_STORE = "no-store";
/**
* Build one controlled refusal.
*
* @param status - HTTP status; 400 for a malformed request, 405 for a method the
* route does not own, 500 for a dictionary that cannot answer.
* @param error - stable machine-readable reason.
* @param message - human-readable detail, for logs and for the browser console.
* @returns the response the route returns.
*/
function refusal(status, error, message) {
	const body = {
		ok: false,
		error,
		message
	};
	return Response.json(body, {
		status,
		headers: { "cache-control": NO_STORE }
	});
}
/**
* Build one successful response.
*
* @param body - the found or not-found payload.
* @returns a 200 with the shared no-store policy.
*/
function success(body) {
	return Response.json(body, {
		status: 200,
		headers: { "cache-control": NO_STORE }
	});
}
/**
* Read `query` out of an already-parsed body.
*
* @param raw - the parsed JSON value.
* @returns the raw query string, or a stable failure code when the body does not
* carry one.
*/
function extractQuery(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "malformed-body" };
	const value = raw.query;
	if (value === void 0) return { error: "missing-query" };
	if (typeof value !== "string") return { error: "missing-query" };
	return { query: value };
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
function toWire(hit, settings, source) {
	return {
		ok: true,
		found: true,
		query: hit.query,
		headword: hit.headword,
		phonetic: hit.phonetic,
		meanings: hit.senses.map((sense) => ({
			partOfSpeech: sense.partOfSpeech,
			definition: sense.definition,
			translation: sense.translation
		})),
		forms: hit.forms.map((form) => ({
			form: form.form,
			kind: form.kind
		})),
		matchedForm: hit.matchedForm,
		examples: hit.examples.map((example) => ({
			en: example.en,
			zh: example.zh
		})),
		source,
		settings
	};
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
function createLookupHandler(config, dictionary) {
	return async function handleLookup(request) {
		if (request.method !== "POST") return refusal(405, "method-not-allowed", `dsh-word-lookup accepts POST, not ${request.method}`);
		const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
		if (contentType !== "application/json") return refusal(400, "unsupported-content-type", `expected ${LOOKUP_MEDIA_TYPE}, received "${contentType}"`);
		const declaredLength = Number(request.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > 4096) return refusal(400, "body-too-large", `body exceeds ${MAX_REQUEST_BYTES} bytes`);
		const text = await request.text();
		if (Buffer.byteLength(text, "utf8") > 4096) return refusal(400, "body-too-large", `body exceeds ${MAX_REQUEST_BYTES} bytes`);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return refusal(400, "malformed-body", "request body is not valid JSON");
		}
		const extracted = extractQuery(parsed);
		if ("error" in extracted) return refusal(400, extracted.error, "request body must be a JSON object with a string \"query\" field");
		const query = normalizeHeadword(extracted.query);
		if (query.length === 0) return refusal(400, "empty-query", "query is empty after normalization");
		if (countCodePoints(extracted.query.trim()) > 96) return refusal(400, "query-too-long", `query exceeds 96 code points`);
		const settings = {
			autoDoubleClick: readSwitch(config, "autoDoubleClick"),
			autoSelection: readSwitch(config, "autoSelection")
		};
		let answer;
		try {
			answer = dictionary.lookup(query);
		} catch (error) {
			if (error instanceof DictionaryUnavailableError) return refusal(500, "dictionary-unavailable", error.message);
			throw error;
		}
		if (!answer.found) return success({
			ok: true,
			found: false,
			query,
			source: dictionary.source,
			settings
		});
		return success(toWire(answer, settings, dictionary.source));
	};
}
//#endregion
//#region src/host/managed-storage.ts
/**
* Profile-aware managed dictionary storage layout and atomic active metadata persistence.
*
* Implements the filesystem storage contracts for Phase 7A.3:
*
* Layout:
* ```text
* <DSH_HOME>/
*   cache/
*     dsh-word-lookup/
*       sources/
*         ... (downloaded ECDICT source artifacts, e.g. ecdict.csv, *.part)
*   storages/
*     dsh-word-lookup/
*       databases/
*         ecdict-<identity>.sqlite3
*       active.json
* ```
*
* Invariants:
* - Resolved DSH home is obtained through official host context surfaces
*   (`ctx.get('profileContext')?.home` or `ctx.get('dshHomePath')?.()`) or explicit injection.
* - Zero ambient environment access in active package runtime to maintain Store contract `credentials = false`.
* - Versioned database naming: databases are never overwritten in place (`ecdict-<identity>.sqlite3`),
*   ensuring Windows open SQLite handle safety during atomic hot-swapping.
* - Atomic metadata persistence: `active.json` is updated via sibling temporary file rename
*   (`active.json.tmp-<uuid>` -> `active.json`).
* - Metadata database references are relative basenames only (`databaseFile`), preventing
*   machine path leakage and traversal vulnerabilities.
* - Malformed metadata fails closed without mutating or destroying existing files.
*
* @module dsh-word-lookup/host/managed-storage
*/
/** Safe identity token pattern: alphanumeric plus dots, underscores, dashes (1-64 chars). */
const SAFE_IDENTITY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
/** Versioned managed SQLite filename pattern. */
const MANAGED_DATABASE_FILENAME_PATTERN = /^ecdict-[a-zA-Z0-9._-]{1,64}\.sqlite3$/;
/** Recognized temporary artifact pattern for safe cleanup. */
const STALE_TEMPORARY_ARTIFACT_PATTERN = /^(?:active\.json\.tmp-[a-zA-Z0-9_-]+|.*\.tmp-[a-zA-Z0-9_-]+|.*\.part)$/;
/** Candidate temporary database filename pattern during build (`ecdict-<identity>.sqlite3.tmp-<candidateId>`). */
const CANDIDATE_DATABASE_FILENAME_PATTERN = /^ecdict-[a-zA-Z0-9._-]{1,64}\.sqlite3\.tmp-[a-zA-Z0-9_-]{1,64}$/;
/**
* Validate that a candidate path resides strictly within the managed database directory,
* conforms to the candidate filename pattern, and does not escape via traversal, symlinks, or junctions.
*
* @param candidatePath - candidate database path.
* @param databaseDirectory - expected managed database directory.
* @returns normalized resolved candidate path.
*/
async function validateCandidateDatabasePath(candidatePath, databaseDirectory) {
	if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) throw new TypeError("Candidate database path must be a non-empty string");
	if (typeof databaseDirectory !== "string" || databaseDirectory.trim().length === 0) throw new TypeError("Database directory must be a non-empty string");
	if (candidatePath.includes("\0") || databaseDirectory.includes("\0")) throw new Error("Path contains null bytes");
	const normalizedDbDir = resolve(databaseDirectory);
	const resolvedCandidate = resolve(candidatePath);
	const candidateName = basename(resolvedCandidate);
	if (!CANDIDATE_DATABASE_FILENAME_PATTERN.test(candidateName)) throw new Error(`Candidate database filename "${candidateName}" violates candidate naming contract (${CANDIDATE_DATABASE_FILENAME_PATTERN.source})`);
	if (resolve(resolvedCandidate, "..") !== normalizedDbDir) throw new Error(`Candidate database path "${resolvedCandidate}" escapes managed database directory "${normalizedDbDir}"`);
	try {
		if ((await lstat(resolvedCandidate)).isSymbolicLink()) throw new Error(`Candidate database path "${resolvedCandidate}" must not be a symbolic link`);
		const realCandidatePath = await realpath(resolvedCandidate);
		const realDbDir = await realpath(normalizedDbDir);
		if (resolve(realCandidatePath, "..") !== realDbDir || basename(realCandidatePath) !== candidateName) throw new Error(`Candidate database realpath "${realCandidatePath}" escapes managed database realpath "${realDbDir}"`);
	} catch (err) {
		if (err?.code !== "ENOENT") throw err;
	}
	return resolvedCandidate;
}
/**
* Attempt to extract the resolved DSH home from official host context surfaces.
*
* Supported surfaces in DSH 0.2.0-rc.2:
* 1. `ctx.get('profileContext')?.home` (provided by `profile-boot` on profile launch).
* 2. `ctx.get('dshHomePath')?.()` (provided by `app-boot` on boot).
*
* Returns `null` when neither surface is present on the context.
*/
function resolveDshHomeFromContext(ctx) {
	if (!ctx) return null;
	const profileContext = ctx.get?.("profileContext") ?? ctx.profileContext;
	if (profileContext && typeof profileContext.home === "string" && profileContext.home.trim().length > 0) return resolve(profileContext.home.trim());
	const dshHomePath = ctx.get?.("dshHomePath") ?? ctx.dshHomePath;
	if (typeof dshHomePath === "function") {
		const res = dshHomePath();
		if (typeof res === "string" && res.trim().length > 0) return resolve(res.trim());
	}
	return null;
}
/**
* Resolve managed dictionary filesystem layout paths.
*
* Precedence:
* 1. `options.home` (explicit override).
* 2. `options.ctx` official host services (`profileContext.home` or `dshHomePath`).
*
* Throws if no home can be resolved through supported official surfaces.
* Fails closed without falling back to ambient process environment or unverified `~/.dsh`.
*
* @param options - optional explicit home or context.
* @returns validated immutable paths object.
*/
function resolveManagedStoragePaths(options) {
	let home = null;
	if (options?.home !== void 0 && typeof options.home === "string") {
		const trimmed = options.home.trim();
		if (trimmed.length > 0) home = resolve(trimmed);
	}
	if (home === null && options?.ctx !== void 0) home = resolveDshHomeFromContext(options.ctx);
	if (home === null) throw new Error("Cannot resolve DSH home: no explicit home provided and context does not supply profileContext.home or dshHomePath");
	const sourceCacheDirectory = join(home, "cache", "dsh-word-lookup", "sources");
	const storageDirectory = join(home, "storages", "dsh-word-lookup");
	const databaseDirectory = join(storageDirectory, "databases");
	const activeMetadataPath = join(storageDirectory, "active.json");
	return Object.freeze({
		home,
		sourceCacheDirectory,
		storageDirectory,
		databaseDirectory,
		activeMetadataPath
	});
}
/**
* Ensure storage and cache directories exist on disk.
*
* Creates:
* - `<home>/cache/dsh-word-lookup/sources`
* - `<home>/storages/dsh-word-lookup/databases`
*
* @param paths - resolved managed storage paths.
*/
async function ensureManagedStorageDirectories(paths) {
	await mkdir(paths.sourceCacheDirectory, { recursive: true });
	await mkdir(paths.databaseDirectory, { recursive: true });
}
/**
* Generate a validated, filesystem-safe versioned SQLite database filename.
*
* Enforces strict character and length constraints to prevent path traversal and collisions:
* - Must match {@link SAFE_IDENTITY_PATTERN}.
* - Must not contain path separators (`/`, `\`), traversal segments (`.`, `..`), or drive letters (`:`).
*
* @param identity - safe versioned identity string (e.g. 'v1-a7013d658fb101bc').
* @returns basename filename formatted as `ecdict-<identity>.sqlite3`.
*/
function managedDatabaseFileName(identity) {
	if (typeof identity !== "string" || identity.trim().length === 0) throw new TypeError("Dictionary identity must be a non-empty string");
	const trimmed = identity.trim();
	if (!SAFE_IDENTITY_PATTERN.test(trimmed)) throw new TypeError(`Invalid dictionary identity "${identity}": must match ${SAFE_IDENTITY_PATTERN.source} without slashes or path traversal`);
	if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(":")) throw new TypeError(`Path traversal detected in dictionary identity: "${identity}"`);
	return `ecdict-${trimmed}.sqlite3`;
}
/**
* Return the absolute path to a versioned database file inside `databaseDirectory`.
*
* @param paths - resolved managed storage paths.
* @param identity - safe versioned identity string.
* @returns absolute normalized database path.
*/
function managedDatabasePath(paths, identity) {
	const fileName = managedDatabaseFileName(identity);
	return join(paths.databaseDirectory, fileName);
}
/**
* Validate an unknown object against the {@link ActiveMetadata} schema.
*
* Throws detailed TypeError if any required field is missing or invalid.
*/
function validateActiveMetadata(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Active metadata must be a non-null object");
	const record = raw;
	if (record.version !== 1) throw new TypeError(`Unsupported active metadata schema version: expected 1, got ${String(record.version)}`);
	if (record.activeMode !== "managed-ecdict") throw new TypeError(`Invalid activeMode: expected "managed-ecdict", got "${String(record.activeMode)}"`);
	if (typeof record.identity !== "string" || !SAFE_IDENTITY_PATTERN.test(record.identity.trim())) throw new TypeError(`Invalid active metadata identity: "${String(record.identity)}"`);
	const identity = record.identity.trim();
	if (typeof record.databaseFile !== "string") throw new TypeError("Active metadata databaseFile must be a string");
	const dbFile = record.databaseFile.trim();
	if (isAbsolute(dbFile) || dbFile.includes("/") || dbFile.includes("\\") || basename(dbFile) !== dbFile || !MANAGED_DATABASE_FILENAME_PATTERN.test(dbFile)) throw new TypeError(`Invalid active metadata databaseFile "${record.databaseFile}": must be a relative basename matching ${MANAGED_DATABASE_FILENAME_PATTERN.source}`);
	const expectedDbFile = managedDatabaseFileName(identity);
	if (dbFile !== expectedDbFile) throw new TypeError(`Active metadata databaseFile "${dbFile}" does not match identity "${identity}" (expected "${expectedDbFile}")`);
	if (!record.source || typeof record.source !== "object" || Array.isArray(record.source)) throw new TypeError("Active metadata source must be an object");
	const source = record.source;
	if (typeof source.name !== "string" || source.name.trim().length === 0) throw new TypeError("Active metadata source.name must be a non-empty string");
	if (typeof source.commit !== "string" || !/^[0-9a-fA-F]{40}$/.test(source.commit.trim())) throw new TypeError("Active metadata source.commit must be a 40-character hex commit string");
	if (typeof source.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(source.sha256.trim())) throw new TypeError("Active metadata source.sha256 must be a 64-character hex string");
	if (typeof source.schemaVersion !== "number" || !Number.isInteger(source.schemaVersion) || source.schemaVersion < 1) throw new TypeError("Active metadata source.schemaVersion must be a positive integer >= 1");
	const settingsSynced = typeof record.settingsSynced === "boolean" ? record.settingsSynced : void 0;
	const validSyncStates = /* @__PURE__ */ new Set([
		"synced",
		"failed",
		"unavailable",
		"pending"
	]);
	let settingsSyncState = typeof record.settingsSyncState === "string" && validSyncStates.has(record.settingsSyncState) ? record.settingsSyncState : void 0;
	if (settingsSyncState === void 0) {
		if (settingsSynced === true) settingsSyncState = "synced";
		else if (settingsSynced === false) settingsSyncState = "failed";
		else if (typeof record.settingsSyncError === "string" && record.settingsSyncError.trim().length > 0) settingsSyncState = "failed";
	}
	const settingsSyncError = typeof record.settingsSyncError === "string" ? record.settingsSyncError.trim() : record.settingsSyncError === null ? null : void 0;
	const lastActivatedAt = typeof record.lastActivatedAt === "string" ? record.lastActivatedAt.trim() : void 0;
	return {
		version: 1,
		activeMode: "managed-ecdict",
		identity,
		databaseFile: dbFile,
		source: {
			name: source.name.trim(),
			commit: source.commit.trim().toLowerCase(),
			sha256: source.sha256.trim().toLowerCase(),
			schemaVersion: source.schemaVersion
		},
		...settingsSynced !== void 0 ? { settingsSynced } : {},
		...settingsSyncState !== void 0 ? { settingsSyncState } : {},
		...settingsSyncError !== void 0 ? { settingsSyncError } : {},
		...lastActivatedAt !== void 0 ? { lastActivatedAt } : {}
	};
}
/**
* Read and validate active dictionary metadata from `<home>/storages/dsh-word-lookup/active.json`.
*
* Fail-closed behavior:
* - If `active.json` does not exist (ENOENT): returns `null`.
* - If `active.json` is malformed JSON or fails schema validation: throws without modifying disk.
*
* @param paths - resolved managed storage paths.
* @returns validated metadata object, or `null` if no active metadata exists.
*/
async function readActiveMetadata(paths) {
	let content;
	try {
		content = await readFile(paths.activeMetadataPath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new Error(`Malformed active metadata JSON at ${paths.activeMetadataPath}: ${String(cause)}`, { cause });
	}
	return validateActiveMetadata(parsed);
}
/**
* Atomically write active dictionary metadata to `<home>/storages/dsh-word-lookup/active.json`.
*
* Sequence:
* 1. Validate metadata schema before disk operations.
* 2. Ensure storage directory exists.
* 3. Write serialized JSON to a sibling temporary file (`active.json.tmp-<randomUUID>`) with explicit `flush: true`.
* 4. Atomically rename temporary file to `active.json` (atomic replacement on Windows and POSIX).
* 5. On failure, best-effort cleanup of temporary file without corrupting existing `active.json`.
*
* @param paths - resolved managed storage paths.
* @param metadata - valid active metadata descriptor.
*/
async function writeActiveMetadataAtomically(paths, metadata) {
	const validated = validateActiveMetadata(metadata);
	const serialized = JSON.stringify(validated, null, 2) + "\n";
	await ensureManagedStorageDirectories(paths);
	const tempName = `active.json.tmp-${randomUUID()}`;
	const tempPath = join(paths.storageDirectory, tempName);
	const doWriteFile = writeFile;
	const doRename = rename;
	const doUnlink = unlink;
	try {
		await doWriteFile(tempPath, serialized, {
			encoding: "utf8",
			flush: true
		});
		await doRename(tempPath, paths.activeMetadataPath);
	} catch (error) {
		try {
			await doUnlink(tempPath);
		} catch {}
		throw error;
	}
}
/**
* Clean up stale temporary artifacts in managed storage and cache directories.
*
* Cleans only recognized temporary files matching {@link STALE_TEMPORARY_ARTIFACT_PATTERN}:
* - `active.json.tmp-*`
* - `*.tmp-*`
* - `*.part`
*
* Never modifies or deletes:
* - `active.json`
* - `*.sqlite3`
* - Unknown user or system files.
*
* @param paths - resolved managed storage paths.
* @returns summary of unlinked file paths.
*/
async function removeStaleTemporaryArtifacts(paths) {
	const removed = [];
	const targetDirs = [
		paths.storageDirectory,
		paths.databaseDirectory,
		paths.sourceCacheDirectory
	];
	for (const dir of targetDirs) {
		let entries;
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) if (STALE_TEMPORARY_ARTIFACT_PATTERN.test(entry)) {
			const fullPath = join(dir, entry);
			try {
				await unlink(fullPath);
				removed.push(fullPath);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	return { removed };
}
//#endregion
//#region src/host/ecdict-source.ts
/**
* Pinned ECDICT corpus source manifest reader, validator, and canonical source descriptor.
*
* Implements strict Phase 7A.4 source-byte provenance binding:
* - Locates packaged `corpus/ecdict.manifest.json` relative to package installation root.
* - Parses and strictly validates manifest schema, repo identity, commit, hash, and byte bounds.
* - Produces canonical immutable source descriptor with canonical raw GitHub download URL.
* - Enforces absolute security ceiling on declared corpus byte size (<= 128 MiB).
* - Bridgeable to `ActiveMetadataSource` for future Phase 7A.5/7A.6 database management.
*
* Invariants:
* - Single source of truth: corpus identity is loaded exclusively from the packaged manifest.
* - Immutable pins: no configuration, settings, query parameter, environment variable,
*   or user payload can alter the source repository, commit, path, SHA-256, or byte size.
* - Zero network access: this module only inspects local packaged files and constructs descriptors.
*
* @module dsh-word-lookup/host/ecdict-source
*/
/** Canonical ECDICT corpus source name. */
const ALLOWED_SOURCE_NAME = "ECDICT";
/** Pinned authoritative repository URL. */
const ALLOWED_SOURCE_REPOSITORY = "https://github.com/skywind3000/ECDICT";
/** Pinned authoritative repository file path. */
const ALLOWED_SOURCE_PATH = "ecdict.csv";
/** Strict network hostname allowlist for canonical downloads. */
const ALLOWED_DOWNLOAD_HOSTNAME = "raw.githubusercontent.com";
/** Absolute security ceiling for corpus byte size (80 MiB = 83,886,080 bytes). */
const MAX_MANIFEST_BYTE_SIZE = 83886080;
/** Expected relative directory of the packaged manifest within the package. */
const CORPUS_DIRECTORY = "corpus";
/** Packaged manifest file basename. */
const MANIFEST_FILE_NAME = "ecdict.manifest.json";
/** Exact 40-character hexadecimal commit hash pattern. */
const COMMIT_HASH_PATTERN = /^[0-9a-fA-F]{40}$/;
/** Exact 64-character hexadecimal SHA-256 hash pattern. */
const SHA256_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
/**
* Resolve the absolute filesystem path to the packaged `corpus/ecdict.manifest.json`.
*
* Walks up directory hierarchy from `fromUrl` to find `package.json`, then
* joins with `corpus/ecdict.manifest.json`.
*
* @param fromUrl - module URL to start search from (defaults to import.meta.url).
* @returns absolute normalized path to manifest.
*/
function resolvePackagedManifestPath(fromUrl = import.meta.url) {
	const root = findPackageRoot(fromUrl);
	const manifestPath = join(root, CORPUS_DIRECTORY, MANIFEST_FILE_NAME);
	if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) throw new Error(`Packaged ECDICT manifest not found at: ${manifestPath}`);
	return manifestPath;
}
/**
* Validate an unknown object against the authoritative ECDICT manifest contract.
*
* Throws TypeError with descriptive message if any field fails strict validation.
*
* @param raw - parsed JSON value from manifest.
* @returns frozen, immutable {@link EcdictSourceDescriptor}.
*/
function validateEcdictManifest(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("ECDICT manifest must be a non-null object");
	const record = raw;
	if (record.sourceName !== "ECDICT") throw new TypeError(`Invalid manifest sourceName: expected "${ALLOWED_SOURCE_NAME}", got "${String(record.sourceName)}"`);
	if (record.sourceRepository !== "https://github.com/skywind3000/ECDICT") throw new TypeError(`Invalid manifest sourceRepository: expected "${ALLOWED_SOURCE_REPOSITORY}", got "${String(record.sourceRepository)}"`);
	if (record.sourcePath !== "ecdict.csv") throw new TypeError(`Invalid manifest sourcePath: expected "${ALLOWED_SOURCE_PATH}", got "${String(record.sourcePath)}"`);
	if (typeof record.sourceCommit !== "string" || !COMMIT_HASH_PATTERN.test(record.sourceCommit.trim())) throw new TypeError(`Invalid manifest sourceCommit: must be a 40-character hex commit string, got "${String(record.sourceCommit)}"`);
	const sourceCommit = record.sourceCommit.trim().toLowerCase();
	if (typeof record.sourceSha256 !== "string" || !SHA256_HASH_PATTERN.test(record.sourceSha256.trim())) throw new TypeError(`Invalid manifest sourceSha256: must be a 64-character hex digest, got "${String(record.sourceSha256)}"`);
	const sourceSha256 = record.sourceSha256.trim().toLowerCase();
	if (typeof record.sourceByteSize !== "number" || !Number.isSafeInteger(record.sourceByteSize) || record.sourceByteSize <= 0) throw new TypeError(`Invalid manifest sourceByteSize: must be a positive safe integer, got ${String(record.sourceByteSize)}`);
	const sourceByteSize = record.sourceByteSize;
	if (sourceByteSize > 83886080) throw new TypeError(`Manifest sourceByteSize ${sourceByteSize} exceeds maximum security ceiling of ${MAX_MANIFEST_BYTE_SIZE} bytes (80 MiB)`);
	if (typeof record.schemaVersion !== "number" || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion !== 1) throw new TypeError(`Invalid manifest schemaVersion: expected 1, got ${String(record.schemaVersion)}`);
	const canonicalDownloadUrl = `https://${ALLOWED_DOWNLOAD_HOSTNAME}/skywind3000/ECDICT/${sourceCommit}/${ALLOWED_SOURCE_PATH}`;
	const parsedUrl = new URL(canonicalDownloadUrl);
	if (parsedUrl.protocol !== "https:") throw new TypeError(`Canonical URL must use https:, got "${parsedUrl.protocol}"`);
	if (parsedUrl.hostname !== "raw.githubusercontent.com") throw new TypeError(`Canonical URL host mismatch: expected "${ALLOWED_DOWNLOAD_HOSTNAME}", got "${parsedUrl.hostname}"`);
	return Object.freeze({
		sourceName: "ECDICT",
		sourceRepository: ALLOWED_SOURCE_REPOSITORY,
		sourceCommit,
		sourcePath: ALLOWED_SOURCE_PATH,
		sourceSha256,
		sourceByteSize,
		schemaVersion: 1,
		canonicalDownloadUrl
	});
}
function loadDescriptorFromManifestPath(manifestPath) {
	let content;
	try {
		content = readFileSync(manifestPath, "utf8");
	} catch (error) {
		throw new Error(`Failed to read ECDICT manifest at ${manifestPath}: ${String(error)}`, { cause: error });
	}
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new Error(`Malformed ECDICT manifest JSON at ${manifestPath}: ${String(cause)}`, { cause });
	}
	return validateEcdictManifest(parsed);
}
/**
* Load and validate the authoritative ECDICT source descriptor from the packaged manifest.
*
* Reads `corpus/ecdict.manifest.json` relative to package installation root.
* In production, does not accept any parameters or overrides.
*
* @returns validated, frozen descriptor.
*/
function loadPinnedEcdictSourceDescriptor() {
	return loadDescriptorFromManifestPath(resolvePackagedManifestPath());
}
/**
* Convert a validated {@link EcdictSourceDescriptor} to an {@link ActiveMetadataSource}
* compatible with Phase 7A.3 active metadata storage contracts.
*
* @param descriptor - validated ECDICT source descriptor.
* @returns frozen active metadata source provenance object.
*/
function descriptorToActiveMetadataSource(descriptor) {
	return Object.freeze({
		name: descriptor.sourceName,
		commit: descriptor.sourceCommit,
		sha256: descriptor.sourceSha256,
		schemaVersion: descriptor.schemaVersion
	});
}
/**
* Independent hard security ceiling on any streamed source bytes (80 MiB = 83,886,080 bytes).
* Enforced unconditionally chunk-by-chunk during network retrieval to prevent resource exhaustion
* and runaway/infinite streams, completely independent of expected integrity byte size.
*/
const MAX_STREAMED_SOURCE_BYTES = 83886080;
/** Allowed HTTP redirect status codes. */
const REDIRECT_STATUS_CODES = /* @__PURE__ */ new Set([
	301,
	302,
	303,
	307,
	308
]);
/** Allowed network hostname set. */
const ALLOWED_HOSTNAMES = /* @__PURE__ */ new Set([ALLOWED_DOWNLOAD_HOSTNAME]);
/** Minimum interval between throttled progress updates in milliseconds (10 updates/sec). */
const PROGRESS_THROTTLE_INTERVAL_MS = 100;
/**
* Error thrown when a concurrent download for the same destination is already in flight in the current process.
*/
var EcdictDownloadInProgressError = class extends Error {
	/** Target cache destination path. */
	destinationPath;
	constructor(destinationPath) {
		super(`ECDICT download already in progress for destination: ${destinationPath}`);
		this.name = "EcdictDownloadInProgressError";
		this.destinationPath = destinationPath;
	}
};
/** Set of normalized destination file paths currently being downloaded in this process. */
const activeDownloads = /* @__PURE__ */ new Set();
/**
* Helper to construct an Error with `AbortError` name and standard DOMException behavior.
*/
function createAbortError$2(reason) {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new DOMException("This operation was aborted", "AbortError");
	if (reason !== void 0) try {
		Object.defineProperty(error, "cause", {
			value: reason,
			configurable: true,
			writable: true
		});
	} catch {}
	return error;
}
/**
* Check whether an error represents an abortion.
*/
function isAbortError$1(err) {
	if (!err) return false;
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) return true;
	if (typeof err === "object" && "name" in err && err.name === "AbortError") return true;
	return false;
}
/**
* Safely invoke a progress callback, catching and ignoring observer exceptions so
* UI or listener errors cannot disrupt the download or corrupt filesystem state.
*/
function notifyProgress$1(callback, progress) {
	if (!callback) return;
	try {
		callback(progress);
	} catch {}
}
/**
* Detect whether a URL contains embedded userinfo (username, password-only, or username:password).
*
* Implements strict protocol validation per RFC 3986 §3.2 and §3.2.1:
* Checks standard WHATWG URL `username` property, and verifies whether the authority
* component (between scheme and path/query/fragment) contains the userinfo delimiter `@`.
*
* @param url - parsed URL object.
* @returns true if userinfo is present, false otherwise.
*/
function hasEmbeddedUserInfo(url) {
	if (url.username !== "") return true;
	const prefix = `${url.protocol}//`;
	if (!url.href.startsWith(prefix)) return true;
	const authorityAndRest = url.href.slice(prefix.length);
	const authorityEnd = authorityAndRest.search(/[/?#]/);
	return (authorityEnd === -1 ? authorityAndRest : authorityAndRest.slice(0, authorityEnd)).includes("@");
}
/**
* Strict Content-Length header parser.
*
* Rejects non-digits (e.g. "123garbage"), negative numbers, non-integers,
* and unsafe integers. Returns null if header is not present.
*/
function parseContentLengthHeader(headerValue) {
	if (headerValue === null) return null;
	const trimmed = headerValue.trim();
	if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid Content-Length header value: "${headerValue}"`);
	const parsed = Number(trimmed);
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Content-Length value out of safe integer range: "${headerValue}"`);
	return parsed;
}
/**
* Strict URL security validation:
* - Must be https:
* - Hostname must be in allowed list (`raw.githubusercontent.com`)
* - No username or password embedded in URL
* - Default or standard 443 port
*/
function validateTargetUrl(urlStr) {
	let urlObj;
	try {
		urlObj = new URL(urlStr);
	} catch (cause) {
		throw new Error(`Invalid URL: ${urlStr} (${String(cause)})`);
	}
	if (urlObj.protocol !== "https:") throw new Error(`Insecure protocol "${urlObj.protocol}": HTTPS is strictly required`);
	if (!ALLOWED_HOSTNAMES.has(urlObj.hostname)) throw new Error(`Forbidden hostname "${urlObj.hostname}": only allowed hosts (${[...ALLOWED_HOSTNAMES].join(", ")}) are permitted`);
	if (hasEmbeddedUserInfo(urlObj)) throw new Error("URL must not contain embedded user credentials");
	if (urlObj.port !== "" && urlObj.port !== "443") throw new Error(`Non-standard port "${urlObj.port}" is not allowed for secure corpus downloads`);
	return urlObj;
}
/**
* Verify an existing source file on disk against expected byte size and SHA-256 digest
* with single-pass fatal UTF-8 decoding.
*
* Serves three crucial roles across the plugin lifecycle:
* 1. Existing cache verification and zero-request reuse.
* 2. Post-concurrency verification if another process won the rename race.
* 3. Precondition verification for future Phase 7A.5 SQLite import.
*
* @param filePath - absolute path to candidate file.
* @param expected - expected size and SHA-256 digest.
* @param options - optional signal and progress callback.
* @returns true if file exists and matches size, SHA-256, and UTF-8 validity exactly; false otherwise.
*/
async function verifyCachedEcdictSource(filePath, expected, options) {
	if (options?.signal?.aborted) throw createAbortError$2(options.signal.reason);
	let fileStat;
	try {
		fileStat = await stat(filePath);
	} catch {
		return false;
	}
	if (!fileStat.isFile() || fileStat.size !== expected.byteSize) return false;
	notifyProgress$1(options?.onProgress, {
		phase: "checking-cache",
		bytesProcessed: 0,
		totalBytes: expected.byteSize
	});
	const hash = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytesProcessed = 0;
	let lastProgressTime = 0;
	const stream = createReadStream(filePath);
	try {
		for await (const chunk of stream) {
			if (options?.signal?.aborted) throw createAbortError$2(options.signal.reason);
			const bufferChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			bytesProcessed += bufferChunk.byteLength;
			if (bytesProcessed > expected.byteSize) return false;
			hash.update(bufferChunk);
			decoder.decode(bufferChunk, { stream: true });
			const now = Date.now();
			if (now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL_MS) {
				lastProgressTime = now;
				notifyProgress$1(options?.onProgress, {
					phase: "checking-cache",
					bytesProcessed,
					totalBytes: expected.byteSize
				});
			}
		}
		if (bytesProcessed !== expected.byteSize) return false;
		decoder.decode();
		return hash.digest("hex").toLowerCase() === expected.sha256.toLowerCase();
	} catch (error) {
		if (isAbortError$1(error)) throw error;
		return false;
	} finally {
		if (!stream.destroyed) stream.destroy();
	}
}
/**
* Execute network fetch with manual bounded redirect resolution and security enforcement.
*/
async function fetchWithRedirectPolicy(initialUrl, fetchImpl, signal) {
	let currentUrl = initialUrl;
	let redirectCount = 0;
	while (true) {
		if (signal?.aborted) throw createAbortError$2(signal.reason);
		validateTargetUrl(currentUrl);
		const response = await fetchImpl(currentUrl, {
			method: "GET",
			redirect: "manual",
			signal,
			headers: { "Accept-Encoding": "gzip, deflate, br" }
		});
		if (REDIRECT_STATUS_CODES.has(response.status)) {
			redirectCount++;
			if (redirectCount > 3) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`Exceeded maximum redirect limit of 3`);
			}
			const location = response.headers.get("location");
			if (!location) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`HTTP ${response.status} redirect missing Location header from ${currentUrl}`);
			}
			await response.body?.cancel().catch(() => {});
			currentUrl = new URL(location, currentUrl).href;
			continue;
		}
		return {
			response,
			redirectCount
		};
	}
}
/**
* Download and verify the authoritative packaged pinned ECDICT corpus into managed cache storage.
*
* Production entrypoint:
* - Automatically loads and strictly validates packaged `corpus/ecdict.manifest.json`.
* - Constructs canonical source descriptor bound to authoritative commit and SHA-256.
* - Downloads exclusively that canonical source.
* - Production callers cannot override source URL, commit, hash, byte size, fetch, or UUID generation.
*
* @param paths - resolved managed storage paths.
* @param options - optional cancellation signal and progress observer.
* @returns frozen {@link EcdictDownloadResult}.
*/
async function downloadPinnedEcdict(paths, options) {
	return downloadPinnedEcdictInternal(paths, loadPinnedEcdictSourceDescriptor(), {
		signal: options?.signal,
		onProgress: options?.onProgress
	});
}
/**
* @internal Test-only internal core downloader accepting arbitrary descriptors and test seams.
* Strictly forbidden from package root exports (src/index.ts).
*
* Sequence:
* 1. Pre-network security ceiling check: fails immediately if descriptor sourceByteSize > 80 MiB.
* 2. Concurrency check: fails immediately if destination is already active in this process.
* 3. Directory check: ensures `<home>/cache/dsh-word-lookup/sources` exists.
* 4. Pre-flight cache verification: if `ecdict.csv` already exists and matches exact size,
*    SHA-256, and fatal UTF-8, returns immediately with `reused: true` (zero network calls).
* 5. Partial file preparation: opens unique `ecdict.csv.<uuid>.part` with exclusive `'wx'` flag.
* 6. Secure network fetch: fetches canonical URL with manual redirects (<= 3) and HTTPS validation.
* 7. Content-Length check: parses strictly and rejects if exceeding ceiling or expected size.
* 8. Streaming verification: reads chunks, enforces independent ceiling + exact size,
*    writes to `.part` disk handle with partial-write loops, updates SHA-256, validates fatal UTF-8.
* 9. Publication linearization: checks abort at multiple gates prior to rename publication.
* 10. Verification completion: syncs and closes `.part` file handle.
* 11. Atomic publication commit: renames `.part` to `ecdict.csv`.
* 12. Concurrency convergence: if rename fails, verifies whether another concurrent process published
*    valid final cache before throwing.
*
* @param paths - resolved managed storage paths.
* @param descriptor - source descriptor to download.
* @param options - optional signal, progress observer, and test seams.
* @returns frozen {@link EcdictDownloadResult}.
*/
async function downloadPinnedEcdictInternal(paths, descriptor, options) {
	const signal = options?.signal;
	if (signal?.aborted) throw createAbortError$2(signal.reason);
	if (typeof descriptor.sourceByteSize !== "number" || !Number.isSafeInteger(descriptor.sourceByteSize) || descriptor.sourceByteSize <= 0) throw new TypeError(`Invalid descriptor sourceByteSize: must be a positive safe integer`);
	if (descriptor.sourceByteSize > 83886080) throw new Error(`Descriptor sourceByteSize ${descriptor.sourceByteSize} exceeds maximum allowed ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`);
	const finalCachePath = resolve(join(paths.sourceCacheDirectory, "ecdict.csv"));
	if (activeDownloads.has(finalCachePath)) throw new EcdictDownloadInProgressError(finalCachePath);
	activeDownloads.add(finalCachePath);
	try {
		await mkdir(paths.sourceCacheDirectory, { recursive: true });
		if (signal?.aborted) throw createAbortError$2(signal.reason);
		if (await verifyCachedEcdictSource(finalCachePath, {
			byteSize: descriptor.sourceByteSize,
			sha256: descriptor.sourceSha256
		}, {
			signal,
			onProgress: options?.onProgress
		})) {
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			notifyProgress$1(options?.onProgress, {
				phase: "complete",
				bytesProcessed: descriptor.sourceByteSize,
				totalBytes: descriptor.sourceByteSize
			});
			return Object.freeze({
				path: finalCachePath,
				sourceCommit: descriptor.sourceCommit,
				sha256: descriptor.sourceSha256,
				byteSize: descriptor.sourceByteSize,
				reused: true,
				redirectCount: 0
			});
		}
		if (signal?.aborted) throw createAbortError$2(signal.reason);
		const uuid = options?.generateId ? options.generateId() : randomUUID();
		const partPath = join(paths.sourceCacheDirectory, `ecdict.csv.${uuid}.part`);
		const fileHandle = await open(partPath, "wx");
		let fileHandleClosed = false;
		let downloadCompletedSuccessfully = false;
		try {
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const { response, redirectCount } = await fetchWithRedirectPolicy(descriptor.canonicalDownloadUrl, fetchImpl, signal);
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`Downloader received non-200 HTTP status ${response.status} from ${descriptor.canonicalDownloadUrl}`);
			}
			if (!response.body) throw new Error("Downloader received null response body");
			const clHeader = response.headers.get("content-length");
			if (clHeader !== null) {
				let declaredLength;
				try {
					declaredLength = parseContentLengthHeader(clHeader);
				} catch (error) {
					await response.body.cancel().catch(() => {});
					throw error;
				}
				if (declaredLength !== null) {
					if (declaredLength > 83886080) {
						await response.body.cancel().catch(() => {});
						throw new Error(`Content-Length ${declaredLength} exceeds maximum allowed ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`);
					}
					if (declaredLength > descriptor.sourceByteSize) {
						await response.body.cancel().catch(() => {});
						throw new Error(`Content-Length ${declaredLength} exceeds authoritative corpus size ${descriptor.sourceByteSize}`);
					}
				}
			}
			const reader = response.body.getReader();
			const hash = createHash("sha256");
			const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
			let bytesReceived = 0;
			let lastProgressTime = 0;
			notifyProgress$1(options?.onProgress, {
				phase: "downloading",
				bytesProcessed: 0,
				totalBytes: descriptor.sourceByteSize
			});
			while (true) {
				if (signal?.aborted) {
					await reader.cancel().catch(() => {});
					throw createAbortError$2(signal.reason);
				}
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				bytesReceived += value.byteLength;
				if (bytesReceived > 83886080) {
					await reader.cancel().catch(() => {});
					throw new Error(`Streamed bytes ${bytesReceived} exceeded absolute security ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`);
				}
				if (bytesReceived > descriptor.sourceByteSize) {
					await reader.cancel().catch(() => {});
					throw new Error(`Streamed bytes ${bytesReceived} exceeded authoritative corpus size ${descriptor.sourceByteSize}`);
				}
				let writeOffset = 0;
				while (writeOffset < value.byteLength) {
					const { bytesWritten } = await fileHandle.write(value, writeOffset, value.byteLength - writeOffset);
					writeOffset += bytesWritten;
				}
				hash.update(value);
				utf8Decoder.decode(value, { stream: true });
				const now = Date.now();
				if (now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL_MS) {
					lastProgressTime = now;
					notifyProgress$1(options?.onProgress, {
						phase: "downloading",
						bytesProcessed: bytesReceived,
						totalBytes: descriptor.sourceByteSize
					});
				}
			}
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			if (bytesReceived !== descriptor.sourceByteSize) throw new Error(`Truncated download: expected exactly ${descriptor.sourceByteSize} bytes, received ${bytesReceived}`);
			notifyProgress$1(options?.onProgress, {
				phase: "verifying",
				bytesProcessed: bytesReceived,
				totalBytes: descriptor.sourceByteSize
			});
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			utf8Decoder.decode();
			const digest = hash.digest("hex").toLowerCase();
			if (digest !== descriptor.sourceSha256) throw new Error(`SHA-256 integrity verification failed: expected ${descriptor.sourceSha256}, calculated ${digest}`);
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			await fileHandle.sync();
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			await fileHandle.close();
			fileHandleClosed = true;
			if (signal?.aborted) throw createAbortError$2(signal.reason);
			try {
				await rename(partPath, finalCachePath);
				downloadCompletedSuccessfully = true;
			} catch (renameError) {
				if (await verifyCachedEcdictSource(finalCachePath, {
					byteSize: descriptor.sourceByteSize,
					sha256: descriptor.sourceSha256
				})) {
					notifyProgress$1(options?.onProgress, {
						phase: "complete",
						bytesProcessed: descriptor.sourceByteSize,
						totalBytes: descriptor.sourceByteSize
					});
					return Object.freeze({
						path: finalCachePath,
						sourceCommit: descriptor.sourceCommit,
						sha256: descriptor.sourceSha256,
						byteSize: descriptor.sourceByteSize,
						reused: true,
						redirectCount
					});
				}
				throw renameError;
			}
			notifyProgress$1(options?.onProgress, {
				phase: "complete",
				bytesProcessed: descriptor.sourceByteSize,
				totalBytes: descriptor.sourceByteSize
			});
			return Object.freeze({
				path: finalCachePath,
				sourceCommit: descriptor.sourceCommit,
				sha256: descriptor.sourceSha256,
				byteSize: descriptor.sourceByteSize,
				reused: false,
				redirectCount
			});
		} finally {
			if (!fileHandleClosed) try {
				await fileHandle.close();
			} catch {}
			if (!downloadCompletedSuccessfully) try {
				await unlink(partPath);
			} catch {}
		}
	} finally {
		activeDownloads.delete(finalCachePath);
	}
}
//#endregion
//#region src/host/ecdict-integrity-verifier.ts
/**
* Host-side Worker executor and lifecycle manager for ECDICT integrity verification.
*
* Implements Phase 7A.5R4 & 7A.5R4.1:
* - Spawns the static companion worker (`ecdict-integrity-worker.js`) in an isolated thread.
* - Manages IPC request/response with strict runtime payload validation.
* - Implements fail-closed finite state machine with timeout, AbortSignal, and exit handling.
* - Preserves error and exit handling capabilities until worker exit is confirmed.
* - Eliminates listener cleanup races, multiple settlements, and unhandled late error crashes.
* - Distinguishes TERMINATED_CONFIRMED from TERMINATION_UNCONFIRMED with typed error objects.
* - Enforces candidate database path containment within the managed storage directory.
* - Guarantees worker termination and OS handle release before resolving verification.
*
* @module dsh-word-lookup/host/ecdict-integrity-verifier
*/
/**
* Capture file identity signature for candidate database path.
*/
function captureCandidateFileIdentity(filePath) {
	try {
		const st = statSync(filePath);
		return {
			dev: st.dev,
			ino: st.ino,
			birthtimeMs: st.birthtimeMs,
			mtimeMs: st.mtimeMs,
			size: st.size
		};
	} catch {
		return null;
	}
}
/**
* Private symbol brand ensuring authentic supervisor provenance for worker exit proofs.
*/
const EXIT_PROOF_BRAND = Symbol("dsh.worker.exit_proof_brand");
/**
* Module-private symbol token guaranteeing authentic supervisor provenance.
* Kept strictly inside module scope (unexported) so no external code can forge it.
*/
const AUTHENTIC_EXIT_PROOF_TOKEN = Symbol("dsh.worker.authentic_exit_proof_token");
/**
* Closed-scope WeakSet maintaining referential identity of authentic exit proofs.
* Unreachable outside this module closure.
*/
const authenticExitProofs = /* @__PURE__ */ new WeakSet();
/**
* Error thrown when worker termination fails or cannot be confirmed within deadline.
*/
var WorkerTerminationError = class extends Error {
	errorCode = "WORKER_TERMINATION_FAILED";
	terminationStatus;
	workerId;
	candidatePath;
	candidateFileIdentity;
	constructor(message, terminationStatus = "TERMINATION_UNCONFIRMED", options) {
		super(message, options ? { cause: options.cause } : void 0);
		this.name = "WorkerTerminationError";
		this.terminationStatus = terminationStatus;
		this.workerId = options?.workerId;
		this.candidatePath = options?.candidatePath;
		this.candidateFileIdentity = options?.candidateFileIdentity ?? null;
	}
};
/**
* Error thrown when integrity verification fails or cannot complete safely.
*/
var IntegrityVerificationError = class extends Error {
	errorCode;
	durationMs;
	terminationStatus;
	workerId;
	candidatePath;
	candidateFileIdentity;
	constructor(message, errorCode = "INTEGRITY_VERIFICATION_FAILED", durationMs, terminationStatus = "TERMINATED_CONFIRMED", options) {
		super(message, options ? { cause: options.cause } : void 0);
		this.name = "IntegrityVerificationError";
		this.errorCode = errorCode;
		this.durationMs = durationMs;
		this.terminationStatus = terminationStatus;
		this.workerId = options?.workerId;
		this.candidatePath = options?.candidatePath;
		this.candidateFileIdentity = options?.candidateFileIdentity ?? null;
	}
};
/**
* Check whether an error or aggregate error indicates unconfirmed worker termination.
*/
function isTerminationUnconfirmed(err) {
	if (!err || typeof err !== "object") return false;
	if ("terminationStatus" in err && err.terminationStatus === "TERMINATION_UNCONFIRMED") return true;
	if (err instanceof AggregateError) return err.errors.some((e) => isTerminationUnconfirmed(e));
	return false;
}
/**
* Extract worker termination identifiers and candidate metadata from an error or aggregate error.
*/
function extractWorkerTerminationInfo(err) {
	if (!err || typeof err !== "object") return null;
	const obj = err;
	const workerId = typeof obj.workerId === "string" ? obj.workerId : void 0;
	const candidatePath = typeof obj.candidatePath === "string" ? obj.candidatePath : void 0;
	const candidateFileIdentity = obj.candidateFileIdentity && typeof obj.candidateFileIdentity === "object" ? obj.candidateFileIdentity : null;
	if (workerId || candidatePath || candidateFileIdentity) return {
		workerId,
		candidatePath,
		candidateFileIdentity
	};
	if (err instanceof AggregateError) for (const sub of err.errors) {
		const extracted = extractWorkerTerminationInfo(sub);
		if (extracted?.workerId || extracted?.candidatePath || extracted?.candidateFileIdentity) return extracted;
	}
	return null;
}
/**
* Supervisor tracking active and terminating worker lifecycles, exit proofs,
* and candidate file associations.
*/
var WorkerSupervisor = class {
	#records = /* @__PURE__ */ new Map();
	#byCandidate = /* @__PURE__ */ new Map();
	registerWorker(params) {
		const workerId = params.workerId ?? randomUUID();
		const resolvedPath = resolve(params.candidatePath);
		const fileIdentity = params.candidateFileIdentity ?? captureCandidateFileIdentity(resolvedPath);
		let resolveExitPromise;
		let rejectExitPromise;
		const exitPromise = new Promise((res, rej) => {
			resolveExitPromise = res;
			rejectExitPromise = rej;
		});
		const record = {
			workerId,
			candidatePath: resolvedPath,
			candidateFileIdentity: fileIdentity,
			worker: params.worker,
			spawnedAt: Date.now(),
			status: "RUNNING",
			exitProof: null,
			lateErrors: [],
			exitPromise,
			resolveExit: resolveExitPromise,
			rejectExit: rejectExitPromise,
			exitListenersCleaned: false
		};
		const confirmExit = (exitCode, proofSource) => {
			if (!record.exitProof) {
				const proof = Object.freeze({
					workerId,
					exitCode: typeof exitCode === "number" ? exitCode : 0,
					confirmedAt: Date.now(),
					proofSource,
					[EXIT_PROOF_BRAND]: true,
					[AUTHENTIC_EXIT_PROOF_TOKEN]: true
				});
				authenticExitProofs.add(proof);
				record.exitProof = proof;
				record.status = "TERMINATED_CONFIRMED";
				record.cleanupListeners?.();
				record.resolveExit(proof);
			}
			return record.exitProof;
		};
		const onExit = (code) => {
			confirmExit(code, "exit_event");
		};
		const onError = (err) => {
			record.lateErrors.push(err);
		};
		params.worker.on("exit", onExit);
		params.worker.on("error", onError);
		if (typeof params.worker.terminate === "function") {
			const originalTerminate = params.worker.terminate.bind(params.worker);
			const wrappedTerminate = async function() {
				try {
					const result = await originalTerminate();
					const code = typeof result === "number" ? result : 0;
					confirmExit(code, "terminate");
					return code;
				} catch (termErr) {
					if (record.status !== "TERMINATED_CONFIRMED") {
						record.status = "TERMINATION_UNCONFIRMED";
						record.lateErrors.push(termErr instanceof Error ? termErr : new Error(String(termErr)));
					}
					throw termErr;
				}
			};
			try {
				params.worker.terminate = wrappedTerminate;
			} catch {
				Object.defineProperty(params.worker, "terminate", {
					value: wrappedTerminate,
					writable: true,
					configurable: true
				});
			}
		}
		record.cleanupListeners = () => {
			if (!record.exitListenersCleaned) {
				record.exitListenersCleaned = true;
				try {
					if (typeof params.worker.removeListener === "function") {
						params.worker.removeListener("exit", onExit);
						params.worker.removeListener("error", onError);
					}
				} catch {}
				try {
					if (typeof params.worker.on === "function") params.worker.on("error", (err) => {
						record.lateErrors.push(err);
					});
				} catch {}
			}
		};
		this.#records.set(workerId, record);
		this.#byCandidate.set(resolvedPath, workerId);
		return {
			workerId,
			candidatePath: resolvedPath,
			candidateFileIdentity: fileIdentity,
			worker: params.worker,
			get status() {
				return record.status;
			},
			get exitProof() {
				return record.exitProof;
			},
			get lateErrors() {
				return record.lateErrors;
			},
			waitForExit: (timeoutMs) => this.waitForExit(workerId, timeoutMs),
			cleanupListeners: () => record.cleanupListeners?.()
		};
	}
	getExitProof(workerId) {
		return this.#records.get(workerId)?.exitProof ?? null;
	}
	getSession(workerId) {
		const rec = this.#records.get(workerId);
		if (!rec) return null;
		return {
			workerId: rec.workerId,
			candidatePath: rec.candidatePath,
			candidateFileIdentity: rec.candidateFileIdentity,
			worker: rec.worker,
			get status() {
				return rec.status;
			},
			get exitProof() {
				return rec.exitProof;
			},
			get lateErrors() {
				return rec.lateErrors;
			},
			waitForExit: (timeoutMs) => this.waitForExit(rec.workerId, timeoutMs),
			cleanupListeners: () => rec.cleanupListeners?.()
		};
	}
	getSessionByCandidatePath(candidatePath) {
		const workerId = this.#byCandidate.get(resolve(candidatePath));
		if (!workerId) return null;
		return this.getSession(workerId);
	}
	/**
	* Refuses manual termination confirmation via terminate.
	* Authentic exit proofs can ONLY originate from genuine worker exit events
	* or settled terminate() promises bound at registration time.
	*/
	recordTerminationViaTerminate(workerId, _exitCode) {
		throw new WorkerTerminationError(`Cannot record termination via terminate: manual proof generation is forbidden for workerId "${workerId}". Exit proofs must originate from authentic worker exit events or settled terminate() promises.`, "TERMINATION_UNCONFIRMED", { workerId });
	}
	/**
	* Refuses manual termination confirmation.
	* Authentic exit proofs can ONLY originate from genuine worker exit events
	* or settled terminate() promises bound at registration time.
	*/
	recordTerminationConfirmed(workerId, _exitCode, _proofSource = "exit_event") {
		throw new WorkerTerminationError(`Cannot record termination confirmation: manual proof generation is forbidden for workerId "${workerId}". Exit proofs must originate from authentic worker exit events or settled terminate() promises.`, "TERMINATION_UNCONFIRMED", { workerId });
	}
	/**
	* Refuses test injection into production supervisor provenance.
	*/
	_injectTerminationConfirmedForTesting(workerId, _exitCode, _proofSource = "exit_event") {
		throw new WorkerTerminationError(`Cannot inject termination confirmation: test injection is segregated from authentic supervisor provenance for workerId "${workerId}".`, "TERMINATION_UNCONFIRMED", { workerId });
	}
	isExitProofAuthentic(proof) {
		if (!proof || typeof proof !== "object") return false;
		const p = proof;
		if (!authenticExitProofs.has(p)) return false;
		if (p[AUTHENTIC_EXIT_PROOF_TOKEN] !== true) return false;
		if (typeof p.workerId !== "string") return false;
		const rec = this.#records.get(p.workerId);
		if (!rec || !rec.exitProof) return false;
		if (rec.exitProof !== p) return false;
		return rec.exitProof.workerId === p.workerId && rec.exitProof.exitCode === p.exitCode && rec.exitProof.confirmedAt === p.confirmedAt && rec.exitProof.proofSource === p.proofSource;
	}
	recordTerminationUnconfirmed(workerId, error) {
		const rec = this.#records.get(workerId);
		if (rec && rec.status !== "TERMINATED_CONFIRMED") {
			rec.status = "TERMINATION_UNCONFIRMED";
			if (error) rec.lateErrors.push(error);
		}
	}
	async waitForExit(workerId, timeoutMs = 5e3) {
		const rec = this.#records.get(workerId);
		if (!rec) throw new WorkerTerminationError(`No tracked worker found for workerId "${workerId}"`, "TERMINATION_UNCONFIRMED");
		if (rec.exitProof) return rec.exitProof;
		if (timeoutMs <= 0) throw new WorkerTerminationError(`Worker "${workerId}" has not exited and wait timeout is 0ms`, "TERMINATION_UNCONFIRMED", {
			workerId,
			candidatePath: rec.candidatePath,
			candidateFileIdentity: rec.candidateFileIdentity
		});
		let timer = null;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new WorkerTerminationError(`Timed out after ${timeoutMs}ms waiting for worker exit confirmation (workerId: ${workerId})`, "TERMINATION_UNCONFIRMED", {
					workerId,
					candidatePath: rec.candidatePath,
					candidateFileIdentity: rec.candidateFileIdentity
				}));
			}, timeoutMs);
		});
		try {
			return await Promise.race([rec.exitPromise, timeoutPromise]);
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}
	unregisterWorker(workerId) {
		const rec = this.#records.get(workerId);
		if (rec) {
			rec.cleanupListeners?.();
			this.#byCandidate.delete(rec.candidatePath);
			this.#records.delete(workerId);
		}
	}
	getActiveSessionCount() {
		return this.#records.size;
	}
	hasSession(workerId) {
		return this.#records.has(workerId);
	}
	getTrackedWorkerIds() {
		return Array.from(this.#records.keys());
	}
	resetForTesting() {
		for (const rec of this.#records.values()) rec.cleanupListeners?.();
		this.#records.clear();
		this.#byCandidate.clear();
	}
};
/** Global singleton worker supervisor. */
const workerSupervisor = new WorkerSupervisor();
/**
* Create an AbortError with standard DOMException behavior.
*/
function createAbortError$1(reason) {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new DOMException("This operation was aborted", "AbortError");
	if (reason !== void 0) try {
		Object.defineProperty(error, "cause", {
			value: reason,
			configurable: true,
			writable: true
		});
	} catch {}
	return error;
}
/**
* Validate that an unknown value matches the expected IntegrityResponse IPC structure.
*/
function isValidIntegrityResponse(value) {
	if (typeof value !== "object" || value === null) return false;
	const resp = value;
	if (typeof resp.requestId !== "string" || resp.requestId.length === 0) return false;
	if (typeof resp.success !== "boolean") return false;
	if (resp.success) return resp.integrityResult === "ok" && typeof resp.durationMs === "number";
	return typeof resp.errorCode === "string" && typeof resp.message === "string";
}
/**
* Spawn the static companion worker for integrity verification.
*
* In production bundle (`lib/index.js`), compiles exclusively to:
* `new Worker(new URL('./ecdict-integrity-worker.js', import.meta.url), approvedOptions)`
*
* @param request - verified request payload.
* @param options - optional test options (dev/test only).
*/
function spawnIntegrityWorker(request, options) {
	return new Worker(new URL("./ecdict-integrity-worker.js", import.meta.url), {
		workerData: request,
		execArgv: []
	});
}
/**
* Execute full PRAGMA integrity_check against a candidate SQLite database in a dedicated Worker.
*
* Enforces:
* - Candidate database file must exist, be normalized, and reside strictly within expected directory.
* - Single settlement promise lifecycle (no multi-settle on message/error/exit/abort/timeout).
* - RequestId correlation matching.
* - Fail-closed handling of errors, non-zero exits, timeouts, and AbortSignals.
* - Preservation of error and exit handling capabilities until worker exit is confirmed.
* - Strict await worker.terminate() before returning success to release Windows file locks.
* - Distinguishes TERMINATED_CONFIRMED from TERMINATION_UNCONFIRMED via typed status.
*
* @param candidatePath - absolute filesystem path to candidate SQLite database.
* @param options - optional cancellation, timeout, expected directory, or worker adapter.
* @returns verification outcome including duration.
*/
async function verifyCandidateDatabaseWithWorker(candidatePath, options) {
	const signal = options?.signal;
	if (signal?.aborted) throw createAbortError$1(signal.reason);
	if (typeof candidatePath !== "string" || candidatePath.trim().length === 0 || candidatePath.includes("\0") || candidatePath.includes("..")) throw new IntegrityVerificationError(`Invalid candidate SQLite database path: ${String(candidatePath)}`, "INVALID_CANDIDATE_PATH", void 0, "TERMINATED_CONFIRMED");
	if (options?.expectedDirectory) await validateCandidateDatabasePath(candidatePath, options.expectedDirectory);
	const resolvedCandidatePath = resolve(candidatePath);
	if (!existsSync(resolvedCandidatePath)) throw new IntegrityVerificationError(`Candidate SQLite database does not exist: ${resolvedCandidatePath}`, "CANDIDATE_NOT_FOUND", void 0, "TERMINATED_CONFIRMED");
	try {
		if (lstatSync(resolvedCandidatePath).isSymbolicLink()) throw new IntegrityVerificationError(`Candidate SQLite database must not be a symbolic link: ${resolvedCandidatePath}`, "INVALID_CANDIDATE_PATH", void 0, "TERMINATED_CONFIRMED");
	} catch (statErr) {
		if (statErr instanceof IntegrityVerificationError) throw statErr;
		if (statErr?.code !== "ENOENT") throw statErr;
	}
	const requestId = randomUUID();
	const request = {
		requestId,
		candidatePath: resolvedCandidatePath
	};
	const candidateFileIdentity = captureCandidateFileIdentity(resolvedCandidatePath);
	const timeoutMs = options?.timeoutMs ?? 3e4;
	const terminationTimeoutMs = options?.terminationTimeoutMs ?? 5e3;
	let worker;
	try {
		if (options?.workerAdapter) worker = options.workerAdapter(request);
		else worker = spawnIntegrityWorker(request, { workerUrl: options?.workerUrl });
	} catch (spawnErr) {
		throw new IntegrityVerificationError(`Failed to spawn integrity worker: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`, "WORKER_SPAWN_FAILED", void 0, "TERMINATED_CONFIRMED", {
			cause: spawnErr,
			candidatePath: resolvedCandidatePath,
			candidateFileIdentity
		});
	}
	const session = workerSupervisor.registerWorker({
		worker,
		candidatePath: resolvedCandidatePath,
		candidateFileIdentity
	});
	const workerId = session.workerId;
	return new Promise((resolvePromise, rejectPromise) => {
		let phase = "RUNNING";
		let terminationStatus = "TERMINATION_UNCONFIRMED";
		let primaryOutcome = null;
		const lateErrors = [];
		let timeoutTimer = null;
		const onAbort = () => {
			initiateTermination({
				kind: "failure",
				error: createAbortError$1(signal?.reason)
			});
		};
		const initiateTermination = (outcome) => {
			if (phase !== "RUNNING") return;
			phase = "TERMINATING";
			primaryOutcome = outcome;
			if (timeoutTimer !== null) {
				clearTimeout(timeoutTimer);
				timeoutTimer = null;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
			executeTermination();
		};
		const executeTermination = async () => {
			let terminateError = null;
			let termTimeoutTimer = null;
			try {
				const termPromise = worker.terminate();
				const timeoutPromise = new Promise((_, reject) => {
					termTimeoutTimer = setTimeout(() => {
						reject(new WorkerTerminationError(`Integrity worker termination timed out after ${terminationTimeoutMs}ms`, "TERMINATION_UNCONFIRMED", {
							workerId,
							candidatePath: resolvedCandidatePath,
							candidateFileIdentity
						}));
					}, terminationTimeoutMs);
				});
				await Promise.race([termPromise, timeoutPromise]);
				terminationStatus = "TERMINATED_CONFIRMED";
			} catch (termErr) {
				terminationStatus = "TERMINATION_UNCONFIRMED";
				workerSupervisor.recordTerminationUnconfirmed(workerId, termErr instanceof Error ? termErr : new Error(String(termErr)));
				terminateError = termErr instanceof WorkerTerminationError ? termErr : new WorkerTerminationError(`Integrity worker termination failed: ${termErr instanceof Error ? termErr.message : String(termErr)}`, "TERMINATION_UNCONFIRMED", {
					cause: termErr,
					workerId,
					candidatePath: resolvedCandidatePath,
					candidateFileIdentity
				});
			} finally {
				if (termTimeoutTimer !== null) {
					clearTimeout(termTimeoutTimer);
					termTimeoutTimer = null;
				}
			}
			if (terminationStatus === "TERMINATED_CONFIRMED") {
				session.cleanupListeners?.();
				try {
					if (typeof worker.removeAllListeners === "function") worker.removeAllListeners();
					if (typeof worker.on === "function") worker.on("error", () => {});
				} catch {}
			} else try {
				if (typeof worker.removeListener === "function") {
					worker.removeListener("message", onMessage);
					worker.removeListener("error", onErrorVerification);
					worker.removeListener("exit", onExitVerification);
				} else if (typeof worker.removeAllListeners === "function") worker.removeAllListeners("message");
			} catch {}
			phase = "SETTLED";
			if (primaryOutcome?.kind === "failure") {
				const err = primaryOutcome.error;
				if (err instanceof IntegrityVerificationError) err.terminationStatus = terminationStatus;
			}
			if (lateErrors.length > 0) {
				if (primaryOutcome?.kind === "success") {
					const firstLate = lateErrors[0];
					const lateErr = new IntegrityVerificationError(`Integrity worker encountered late error: ${firstLate.message}`, "WORKER_UNCAUGHT_ERROR", primaryOutcome.result.durationMs, terminationStatus, {
						cause: firstLate,
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					});
					if (terminationStatus === "TERMINATED_CONFIRMED") workerSupervisor.unregisterWorker(workerId);
					if (lateErrors.length === 1 && !terminateError) rejectPromise(lateErr);
					else {
						const all = [
							lateErr,
							...lateErrors.slice(1),
							...terminateError ? [terminateError] : []
						];
						rejectPromise(new AggregateError(all, "Integrity worker encountered late errors during termination"));
					}
					return;
				} else {
					const base = primaryOutcome?.error ?? /* @__PURE__ */ new Error("Unknown verification failure");
					if (base instanceof IntegrityVerificationError) base.terminationStatus = terminationStatus;
					const all = [
						base,
						...lateErrors,
						...terminateError ? [terminateError] : []
					];
					if (terminationStatus === "TERMINATED_CONFIRMED") workerSupervisor.unregisterWorker(workerId);
					rejectPromise(new AggregateError(all, "Integrity verification failed and worker encountered errors during termination"));
					return;
				}
			}
			if (terminateError !== null) {
				if (primaryOutcome?.kind === "success") rejectPromise(terminateError);
				else {
					const base = primaryOutcome?.error ?? /* @__PURE__ */ new Error("Integrity check failed");
					if (base instanceof IntegrityVerificationError) base.terminationStatus = "TERMINATION_UNCONFIRMED";
					rejectPromise(new AggregateError([base, terminateError], "Integrity check failed and worker termination failed"));
				}
				return;
			}
			if (primaryOutcome?.kind === "success") {
				workerSupervisor.unregisterWorker(workerId);
				resolvePromise(primaryOutcome.result);
			} else {
				if (terminationStatus === "TERMINATED_CONFIRMED") workerSupervisor.unregisterWorker(workerId);
				rejectPromise(primaryOutcome?.error ?? /* @__PURE__ */ new Error("Unknown verification failure"));
			}
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		timeoutTimer = setTimeout(() => {
			initiateTermination({
				kind: "failure",
				error: new IntegrityVerificationError(`Candidate SQLite integrity verification timed out after ${timeoutMs}ms`, "VERIFICATION_TIMEOUT", void 0, "TERMINATION_UNCONFIRMED", {
					workerId,
					candidatePath: resolvedCandidatePath,
					candidateFileIdentity
				})
			});
		}, timeoutMs);
		const onMessage = (value) => {
			if (phase !== "RUNNING") return;
			if (!isValidIntegrityResponse(value)) {
				initiateTermination({
					kind: "failure",
					error: new IntegrityVerificationError("Integrity worker returned invalid or unrecognized IPC response structure", "INVALID_IPC_RESPONSE", void 0, "TERMINATION_UNCONFIRMED", {
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					})
				});
				return;
			}
			if (value.requestId !== requestId) {
				initiateTermination({
					kind: "failure",
					error: new IntegrityVerificationError(`Integrity worker response requestId mismatch: expected ${requestId}, got ${value.requestId}`, "REQUEST_ID_MISMATCH", void 0, "TERMINATION_UNCONFIRMED", {
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					})
				});
				return;
			}
			if (!value.success) {
				initiateTermination({
					kind: "failure",
					error: new IntegrityVerificationError(value.message, value.errorCode, value.durationMs, "TERMINATION_UNCONFIRMED", {
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					})
				});
				return;
			}
			if (value.integrityResult !== "ok") {
				initiateTermination({
					kind: "failure",
					error: new IntegrityVerificationError(`Candidate SQLite PRAGMA integrity_check failed: ${value.integrityResult}`, "INTEGRITY_RESULT_NOT_OK", value.durationMs, "TERMINATION_UNCONFIRMED", {
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					})
				});
				return;
			}
			initiateTermination({
				kind: "success",
				result: {
					success: true,
					integrityResult: "ok",
					durationMs: value.durationMs
				}
			});
		};
		const onErrorVerification = (err) => {
			if (phase === "RUNNING") initiateTermination({
				kind: "failure",
				error: new IntegrityVerificationError(`Integrity worker encountered an uncaught error: ${err.message}`, "WORKER_UNCAUGHT_ERROR", void 0, "TERMINATION_UNCONFIRMED", {
					cause: err,
					workerId,
					candidatePath: resolvedCandidatePath,
					candidateFileIdentity
				})
			});
			else lateErrors.push(err);
		};
		const onExitVerification = (code) => {
			if (phase === "RUNNING") initiateTermination({
				kind: "failure",
				error: new IntegrityVerificationError(`Integrity worker exited prematurely before returning verification response (exit code ${code})`, "WORKER_PREMATURE_EXIT", void 0, "TERMINATION_UNCONFIRMED", {
					workerId,
					candidatePath: resolvedCandidatePath,
					candidateFileIdentity
				})
			});
			else if (phase === "TERMINATING") {
				if (code !== 0 && code !== 1) {
					const exitErr = new IntegrityVerificationError(`Integrity worker exited prematurely with abnormal exit code ${code}`, "WORKER_PREMATURE_EXIT", void 0, "TERMINATION_UNCONFIRMED", {
						workerId,
						candidatePath: resolvedCandidatePath,
						candidateFileIdentity
					});
					lateErrors.push(exitErr);
				}
			}
		};
		worker.on("message", onMessage);
		worker.on("error", onErrorVerification);
		worker.on("exit", onExitVerification);
	});
}
//#endregion
//#region src/host/csv-parser.ts
var StreamingCsvParser = class {
	#delimiter;
	#onRow;
	#decoder = new TextDecoder("utf-8", { fatal: true });
	#inQuote = false;
	#afterQuote = false;
	#currentField = "";
	#currentRow = [];
	#pendingCr = false;
	#rowCount = 0;
	constructor(onRow, options = {}) {
		this.#onRow = onRow;
		this.#delimiter = options.delimiter ?? ",";
	}
	/**
	* Push a binary Buffer, Uint8Array or string chunk into the parser.
	* Binary chunks are decoded with { fatal: true }, throwing on invalid UTF-8.
	*/
	push(chunk) {
		const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		this.#parseString(text);
	}
	/**
	* Signal end of stream. Flushes any pending fields and decoders.
	* Throws if an incomplete multibyte sequence remains at EOF.
	*/
	end() {
		const finalStr = this.#decoder.decode();
		if (finalStr.length > 0) this.#parseString(finalStr);
		if (this.#afterQuote) {
			this.#inQuote = false;
			this.#afterQuote = false;
		}
		if (this.#currentRow.length > 0 || this.#currentField.length > 0) {
			this.#currentRow.push(this.#currentField);
			this.#currentField = "";
			this.#rowCount += 1;
			this.#onRow(this.#currentRow, this.#rowCount);
			this.#currentRow = [];
		}
	}
	get rowCount() {
		return this.#rowCount;
	}
	#parseString(str) {
		const len = str.length;
		for (let i = 0; i < len; i += 1) {
			const c = str[i];
			if (this.#pendingCr) {
				this.#pendingCr = false;
				if (c === "\n") continue;
			}
			if (this.#afterQuote) {
				this.#afterQuote = false;
				if (c === "\"") {
					this.#currentField += "\"";
					continue;
				} else {
					this.#inQuote = false;
					if (c === this.#delimiter) {
						this.#currentRow.push(this.#currentField);
						this.#currentField = "";
						continue;
					} else if (c === "\r") {
						this.#currentRow.push(this.#currentField);
						this.#currentField = "";
						this.#rowCount += 1;
						this.#onRow(this.#currentRow, this.#rowCount);
						this.#currentRow = [];
						this.#pendingCr = true;
						continue;
					} else if (c === "\n") {
						this.#currentRow.push(this.#currentField);
						this.#currentField = "";
						this.#rowCount += 1;
						this.#onRow(this.#currentRow, this.#rowCount);
						this.#currentRow = [];
						continue;
					} else {
						this.#currentField += c;
						continue;
					}
				}
			}
			if (c === "\"") {
				if (!this.#inQuote) {
					if (this.#currentField.length === 0) this.#inQuote = true;
					else this.#currentField += "\"";
				} else this.#afterQuote = true;
			} else if (this.#inQuote) this.#currentField += c;
			else if (c === this.#delimiter) {
				this.#currentRow.push(this.#currentField);
				this.#currentField = "";
			} else if (c === "\r") {
				this.#currentRow.push(this.#currentField);
				this.#currentField = "";
				this.#rowCount += 1;
				this.#onRow(this.#currentRow, this.#rowCount);
				this.#currentRow = [];
				this.#pendingCr = true;
			} else if (c === "\n") {
				this.#currentRow.push(this.#currentField);
				this.#currentField = "";
				this.#rowCount += 1;
				this.#onRow(this.#currentRow, this.#rowCount);
				this.#currentRow = [];
			} else this.#currentField += c;
		}
	}
};
//#endregion
//#region src/host/exchange-parser.ts
const FORWARD_TAGS = /* @__PURE__ */ new Set([
	"p",
	"d",
	"i",
	"3",
	"r",
	"t",
	"s"
]);
var ExchangeCollector = class {
	#formMap = /* @__PURE__ */ new Map();
	#totalParsedForms = 0;
	#selfReferentialExcluded = 0;
	/**
	* Process one dictionary entry's exchange string.
	*
	* @param canonical - The entry headword.
	* @param exchange - The raw exchange string from CSV.
	*/
	addEntry(canonical, exchange) {
		if (!exchange || typeof exchange !== "string") return;
		const trimmed = exchange.trim();
		if (!trimmed) return;
		const parts = trimmed.split("/");
		let lemma0 = null;
		let lemma1 = null;
		for (const part of parts) {
			if (!part) continue;
			const colonIdx = part.indexOf(":");
			if (colonIdx === -1) continue;
			const type = part.slice(0, colonIdx).trim();
			const val = part.slice(colonIdx + 1).trim();
			if (!val) continue;
			if (type === "0") lemma0 = val;
			else if (type === "1") lemma1 = val;
			else if (FORWARD_TAGS.has(type)) this.#addMapping(val, canonical, type);
		}
		if (lemma0) this.#addMapping(canonical, lemma0, lemma1 ?? null);
	}
	#addMapping(form, headword, kind) {
		const trimmedForm = form.trim();
		const trimmedHw = headword.trim();
		if (!trimmedForm || !trimmedHw) return;
		this.#totalParsedForms += 1;
		const formLower = trimmedForm.toLowerCase();
		const hwLower = trimmedHw.toLowerCase();
		if (formLower === hwLower) {
			this.#selfReferentialExcluded += 1;
			return;
		}
		let hwMap = this.#formMap.get(formLower);
		if (!hwMap) {
			hwMap = /* @__PURE__ */ new Map();
			this.#formMap.set(formLower, hwMap);
		}
		let record = hwMap.get(hwLower);
		if (!record) {
			record = {
				headword: trimmedHw,
				originalForms: /* @__PURE__ */ new Set(),
				kinds: /* @__PURE__ */ new Set()
			};
			hwMap.set(hwLower, record);
		}
		record.originalForms.add(trimmedForm);
		if (kind) record.kinds.add(kind);
	}
	/**
	* Resolve all collected mappings into unambiguous forms and ambiguous collisions.
	*/
	resolve() {
		const forms = [];
		const ambiguous = [];
		const sortedFormKeys = Array.from(this.#formMap.keys()).sort((a, b) => a.localeCompare(b));
		for (const formKey of sortedFormKeys) {
			const hwMap = this.#formMap.get(formKey);
			if (hwMap.size === 1) {
				const [, entry] = Array.from(hwMap.entries())[0];
				const form = Array.from(entry.originalForms).sort()[0] ?? formKey;
				const kinds = Array.from(entry.kinds).sort();
				const kind = kinds.length > 0 ? kinds.join("") : null;
				forms.push({
					form,
					headword: entry.headword,
					kind
				});
			} else {
				const candidates = Array.from(hwMap.values()).map((v) => ({
					headword: v.headword,
					kinds: Array.from(v.kinds).sort()
				})).sort((a, b) => a.headword.localeCompare(b.headword));
				const sampleForm = Array.from(hwMap.values())[0].originalForms.values().next().value ?? formKey;
				ambiguous.push({
					form: sampleForm,
					candidates
				});
			}
		}
		return {
			forms,
			ambiguous,
			stats: {
				totalParsedForms: this.#totalParsedForms,
				uniqueForms: this.#formMap.size,
				unambiguousForms: forms.length,
				ambiguousForms: ambiguous.length,
				selfReferentialExcluded: this.#selfReferentialExcluded
			}
		};
	}
};
/** Authoritative 13-column ECDICT CSV header schema in exact order. */
const EXPECTED_CORPUS_HEADER = Object.freeze([
	"word",
	"phonetic",
	"definition",
	"translation",
	"pos",
	"collins",
	"oxford",
	"tag",
	"bnc",
	"frq",
	"exchange",
	"detail",
	"audio"
]);
/** Authoritative probe words required to be found in verified candidate databases. */
const REQUIRED_PROBE_WORDS = Object.freeze([
	"go",
	"went",
	"gone",
	"tooth",
	"teeth",
	"derive",
	"derived",
	"conservation",
	"wave",
	"function",
	"wave function"
]);
/** Canonical morphological mappings verified via headword form relationships. */
const CANONICAL_FORM_RELATIONSHIPS = Object.freeze([
	{
		headword: "go",
		expectedForms: ["went", "gone"]
	},
	{
		headword: "tooth",
		expectedForms: ["teeth"]
	},
	{
		headword: "derive",
		expectedForms: ["derived"]
	}
]);
/**
* Error thrown when an ECDICT import is already in progress for the target database directory.
*/
var EcdictImportInProgressError = class extends Error {
	/** Database directory for which import is locked. */
	databaseDirectory;
	constructor(databaseDirectory) {
		super(`ECDICT import already in progress for database directory: ${databaseDirectory}`);
		this.name = "EcdictImportInProgressError";
		this.databaseDirectory = databaseDirectory;
	}
};
/**
* Error thrown when an ECDICT import is attempted on a quarantined database directory.
*/
var EcdictImportQuarantinedError = class extends EcdictImportInProgressError {
	/** Candidate path associated with the quarantine. */
	candidatePath;
	/** Reason for quarantine. */
	reason;
	constructor(databaseDirectory, reason, candidatePath) {
		super(databaseDirectory);
		this.name = "EcdictImportQuarantinedError";
		this.reason = reason;
		this.candidatePath = candidatePath;
		this.message = `ECDICT import directory is quarantined due to unconfirmed worker termination: "${databaseDirectory}" (candidate: "${candidatePath}"). Reason: ${reason}`;
	}
};
/** Set of normalized database directories currently being built in this process. */
const activeImports = /* @__PURE__ */ new Set();
/** Map of in-progress recovery operations per normalized database directory. */
const activeRecoveries = /* @__PURE__ */ new Map();
/** Map of normalized database directories quarantined due to unconfirmed worker termination. */
const quarantinedDirectories = /* @__PURE__ */ new Map();
/**
* Check whether a database directory is currently quarantined.
*/
function isDatabaseDirectoryQuarantined(databaseDirectory) {
	return quarantinedDirectories.has(resolve(databaseDirectory));
}
/**
* Get active quarantine record for a database directory, if any.
*/
function getQuarantineRecord(databaseDirectory) {
	return quarantinedDirectories.get(resolve(databaseDirectory)) ?? null;
}
/**
* Yield control to the Node.js event loop via `setImmediate`.
*/
function defaultYieldToEventLoop() {
	return new Promise((r) => setImmediate(r));
}
/**
* Helper to construct an Error with `AbortError` name and standard DOMException behavior.
*/
function createAbortError(reason) {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new DOMException("This operation was aborted", "AbortError");
	if (reason !== void 0) try {
		Object.defineProperty(error, "cause", {
			value: reason,
			configurable: true,
			writable: true
		});
	} catch {}
	return error;
}
/**
* Check whether an error represents an abortion.
*/
function isAbortError(err) {
	if (!err) return false;
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) return true;
	if (typeof err === "object" && "name" in err && err.name === "AbortError") return true;
	return false;
}
/**
* Check abort signal and throw standard AbortError if triggered.
*/
function checkAbort(signal) {
	if (signal?.aborted) throw createAbortError(signal.reason);
}
/**
* Safely notify progress callback, isolating observer exceptions.
*/
function notifyProgress(callback, progress) {
	if (!callback) return;
	try {
		callback(progress);
	} catch {}
}
/**
* Clean up candidate database file and its SQLite sidecars.
* Only ENOENT may be ignored; other filesystem errors must be reported.
*/
async function cleanupCandidateArtifacts(candidatePath, unlinkFn = unlink) {
	const suffixes = [
		"",
		"-journal",
		"-wal",
		"-shm"
	];
	const errors = [];
	for (const suffix of suffixes) try {
		await unlinkFn(candidatePath + suffix);
	} catch (err) {
		if (err?.code !== "ENOENT") errors.push(err);
	}
	if (errors.length > 0) {
		if (errors.length === 1) throw errors[0];
		throw new AggregateError(errors, `Failed to clean up candidate artifacts for ${candidatePath}`);
	}
}
/**
* Compute SHA-256 digest of a file on disk via streaming.
*/
async function computeFileSha256(filePath) {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk);
	return hash.digest("hex").toLowerCase();
}
/**
* Generate a deterministic versioned safe managed database identity string.
*
* Format: `s<schemaVersion>-<commitPrefix12>-<shaPrefix12>-<nonce12>`
* Matches {@link SAFE_IDENTITY_PATTERN}.
*/
function generateManagedDatabaseIdentity(schemaVersion, sourceCommit, sourceSha256, nonce) {
	const identity = `s${schemaVersion}-${sourceCommit.trim().slice(0, 12).toLowerCase()}-${sourceSha256.trim().slice(0, 12).toLowerCase()}-${(nonce ?? randomUUID().replace(/-/g, "")).trim().slice(0, 12).toLowerCase()}`;
	if (!SAFE_IDENTITY_PATTERN.test(identity)) throw new Error(`Generated managed database identity "${identity}" violates safe identity pattern`);
	return identity;
}
/**
* Execute standard validation probes against an opened SQLite dictionary candidate.
*
* Verifies exact headwords, case-insensitivity, inflected forms, and unknown word misses.
*
* @param dictionary - opened {@link SqliteDictionary}.
*/
function verifyCandidateProbes(dictionary) {
	for (const word of REQUIRED_PROBE_WORDS) if (!dictionary.lookup(word).found) throw new Error(`Candidate probe failed for probe word "${word}": word not found`);
	const wave = dictionary.lookup("wave");
	if (!wave.found || wave.headword !== "wave" || wave.matchedForm !== null) throw new Error("Candidate probe failed for exact canonical precedence: \"wave\"");
	const wf = dictionary.lookup("Wave Function");
	if (!wf.found || wf.headword.toLowerCase() !== "wave function") throw new Error("Candidate probe failed for case-insensitive headword \"Wave Function\"");
	for (const { headword, expectedForms } of CANONICAL_FORM_RELATIONSHIPS) {
		const res = dictionary.lookup(headword);
		if (!res.found) throw new Error(`Candidate probe failed for canonical headword "${headword}": not found`);
		const observedForms = new Set(res.forms.map((f) => f.form.toLowerCase()));
		for (const expectedForm of expectedForms) if (!observedForms.has(expectedForm.toLowerCase())) throw new Error(`Candidate probe failed for "${headword}": expected morphological form "${expectedForm}" not linked`);
	}
	if (dictionary.lookup("nonexistentword123456789xyz").found) throw new Error("Candidate probe failed for non-existent word: expected miss");
}
/**
* Build a verified, versioned managed ECDICT SQLite database from the cached source artifact.
*
* Production entrypoint:
* - Automatically loads authoritative pinned `corpus/ecdict.manifest.json`.
* - Resolves cached source artifact `<home>/cache/dsh-word-lookup/sources/ecdict.csv`.
* - Strictly verifies source preflight and actual import-pass TOCTOU digests.
* - Compiles entries, forms, and indexes in managed candidate database.
* - Validates schema, metadata, PRAGMA integrity, and read-only dictionary probes.
* - Atomically publishes immutable `ecdict-<identity>.sqlite3` database artifact.
* - Does NOT mutate `active.json` or activate the database in `DictionaryManager`.
*
* @param paths - resolved managed storage paths.
* @param options - optional cancellation signal and progress observer.
* @returns frozen {@link ManagedEcdictBuildResult}.
*/
async function buildManagedEcdictDatabase(paths, options) {
	return buildManagedEcdictDatabaseInternal(paths, {
		signal: options?.signal,
		onProgress: options?.onProgress
	});
}
/**
* @internal Test-only internal importer core allowing descriptors and test seams.
* Strictly forbidden from package root exports (`src/index.ts`).
*/
async function buildManagedEcdictDatabaseInternal(paths, options) {
	const signal = options?.signal;
	checkAbort(signal);
	const descriptor = options?.descriptor ?? loadPinnedEcdictSourceDescriptor();
	const sourcePath = options?.sourcePath ?? join(paths.sourceCacheDirectory, "ecdict.csv");
	const batchSize = options?.batchSize ?? 2500;
	const yieldInterval = options?.yieldInterval ?? 2500;
	let yieldCount = 0;
	const baseYieldToEventLoop = options?.yieldFn ?? defaultYieldToEventLoop;
	const yieldToEventLoop = async () => {
		yieldCount++;
		await baseYieldToEventLoop();
	};
	const verifyProbes = options?.verifyProbes !== false;
	const normalizedDbDir = resolve(paths.databaseDirectory);
	if (activeImports.has(normalizedDbDir)) throw new EcdictImportInProgressError(normalizedDbDir);
	if (quarantinedDirectories.has(normalizedDbDir)) {
		const record = quarantinedDirectories.get(normalizedDbDir);
		throw new EcdictImportQuarantinedError(normalizedDbDir, record.reason, record.candidatePath);
	}
	if (activeRecoveries.has(normalizedDbDir)) throw new EcdictImportQuarantinedError(normalizedDbDir, "Recovery is currently in progress for quarantined directory", "");
	activeImports.add(normalizedDbDir);
	let candidatePath = null;
	let db = null;
	let dbOpen = false;
	let inTx = false;
	let published = false;
	const phaseTimings = {};
	try {
		notifyProgress(options?.onProgress, {
			phase: "verifying-source",
			sourceBytesProcessed: 0,
			sourceBytesTotal: descriptor.sourceByteSize
		});
		if (!await verifyCachedEcdictSource(sourcePath, {
			byteSize: descriptor.sourceByteSize,
			sha256: descriptor.sourceSha256
		}, { signal })) throw new Error(`ECDICT cached source file missing or failed verification at: ${sourcePath}`);
		checkAbort(signal);
		notifyProgress(options?.onProgress, { phase: "preflighting" });
		await mkdir(paths.databaseDirectory, { recursive: true });
		const identity = generateManagedDatabaseIdentity(descriptor.schemaVersion, descriptor.sourceCommit, descriptor.sourceSha256, options?.generateNonce?.());
		const finalFileName = managedDatabaseFileName(identity);
		const finalPath = managedDatabasePath(paths, identity);
		if (existsSync(finalPath)) throw new Error(`Managed database already exists at destination: ${finalPath}`);
		const candidateIdGen = options?.generateCandidateId ?? (() => randomUUID());
		let candidateOwned = false;
		let candidatePathChosen = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			const candidateFileName = `${finalFileName}.tmp-${candidateIdGen()}`;
			const proposedPath = join(paths.databaseDirectory, candidateFileName);
			try {
				await (await open(proposedPath, "wx")).close();
				candidatePathChosen = proposedPath;
				candidateOwned = true;
				break;
			} catch (err) {
				if (err?.code === "EEXIST") {
					if (options?.generateCandidateId) throw new Error(`Candidate file reservation collision (EEXIST) for path: ${proposedPath}`);
					continue;
				}
				throw err;
			}
		}
		if (!candidateOwned) throw new Error("Failed to acquire exclusive candidate file reservation after retries");
		await validateCandidateDatabasePath(candidatePathChosen, paths.databaseDirectory);
		candidatePath = candidatePathChosen;
		checkAbort(signal);
		db = (options?.sqliteFactory ?? ((p) => new DatabaseSync(p)))(candidatePath);
		dbOpen = true;
		db.exec("PRAGMA page_size = 4096");
		db.exec("PRAGMA cache_size = -64000");
		db.exec("PRAGMA journal_mode = MEMORY");
		db.exec("PRAGMA synchronous = OFF");
		db.exec("PRAGMA temp_store = MEMORY");
		db.exec("PRAGMA mmap_size = 268435456");
		db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE entries (
        word           TEXT PRIMARY KEY COLLATE NOCASE,
        phonetic       TEXT,
        definition_en  TEXT,
        translation_zh TEXT,
        pos            TEXT,
        exchange       TEXT,
        frequency      INTEGER
      );

      CREATE TABLE forms (
        form      TEXT PRIMARY KEY COLLATE NOCASE,
        headword  TEXT NOT NULL,
        kind      TEXT
      );

      CREATE TABLE examples (
        id        INTEGER PRIMARY KEY,
        headword  TEXT NOT NULL COLLATE NOCASE,
        english   TEXT NOT NULL,
        chinese   TEXT,
        source    TEXT,
        source_id TEXT,
        score     REAL
      );
    `);
		const insertEntryStmt = db.prepare(`
      INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
		const insertFormStmt = db.prepare(`
      INSERT INTO forms (form, headword, kind)
      VALUES (?, ?, ?)
    `);
		const insertMetaStmt = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
		function ensureTx() {
			if (!inTx) {
				db?.exec("BEGIN TRANSACTION");
				inTx = true;
			}
		}
		function commitTx() {
			if (inTx) {
				db?.exec("COMMIT");
				inTx = false;
			}
		}
		notifyProgress(options?.onProgress, {
			phase: "importing-entries",
			processed: 0,
			sourceBytesProcessed: 0,
			sourceBytesTotal: descriptor.sourceByteSize
		});
		const sourceHash = createHash("sha256");
		let bytesImported = 0;
		let validRows = 0;
		let rejectedRowsCount = 0;
		let headerValidated = false;
		let currentBatch = 0;
		let exchangeCollector = new ExchangeCollector();
		const importStart = Date.now();
		const parser = new StreamingCsvParser((row) => {
			if (!headerValidated) {
				headerValidated = true;
				const sanitized = [...row];
				if (sanitized.length > 0 && typeof sanitized[0] === "string" && sanitized[0].charCodeAt(0) === 65279) sanitized[0] = sanitized[0].slice(1);
				if (sanitized.length !== EXPECTED_CORPUS_HEADER.length) throw new Error(`ECDICT CSV header mismatch: expected ${EXPECTED_CORPUS_HEADER.length} columns, got ${sanitized.length}`);
				for (let i = 0; i < EXPECTED_CORPUS_HEADER.length; i++) if (sanitized[i] !== EXPECTED_CORPUS_HEADER[i]) throw new Error(`ECDICT CSV header mismatch: column ${i} expected "${EXPECTED_CORPUS_HEADER[i]}", got "${sanitized[i]}"`);
				return;
			}
			if (row.length !== EXPECTED_CORPUS_HEADER.length) {
				rejectedRowsCount++;
				return;
			}
			const [word, phonetic, definition, translation, pos, , , , bnc, , exchange] = row;
			if (!word || !word.trim()) {
				rejectedRowsCount++;
				return;
			}
			const cleanWord = word.trim();
			if (cleanWord.length > 128) {
				rejectedRowsCount++;
				return;
			}
			let fieldOversized = false;
			for (let i = 0; i < row.length; i++) {
				const fieldVal = row[i];
				if (fieldVal && fieldVal.length > 65536) {
					fieldOversized = true;
					break;
				}
			}
			if (fieldOversized) {
				rejectedRowsCount++;
				return;
			}
			const cleanPhonetic = phonetic && phonetic.trim() ? phonetic.trim() : null;
			const cleanDef = definition && definition.trim() ? definition.trim() : null;
			const cleanTrans = translation && translation.trim() ? translation.trim() : null;
			const cleanPos = pos && pos.trim() ? pos.trim() : null;
			const cleanExchange = exchange && exchange.trim() ? exchange.trim() : null;
			let freqNumber = null;
			if (bnc && bnc.trim()) {
				const parsedBnc = parseInt(bnc.trim(), 10);
				if (!Number.isNaN(parsedBnc) && parsedBnc > 0) freqNumber = parsedBnc;
			}
			ensureTx();
			try {
				insertEntryStmt.run(cleanWord, cleanPhonetic, cleanDef, cleanTrans, cleanPos, cleanExchange, freqNumber);
				validRows++;
				if (cleanExchange) exchangeCollector?.addEntry(cleanWord, cleanExchange);
			} catch (insertError) {
				if (insertError instanceof Error && (insertError.message.includes("UNIQUE constraint failed") || insertError.message.includes("PRIMARY KEY"))) rejectedRowsCount++;
				else throw insertError;
			}
			currentBatch++;
			if (currentBatch >= batchSize) {
				commitTx();
				currentBatch = 0;
			}
		});
		const stream = createReadStream(sourcePath, { highWaterMark: 65536 });
		try {
			for await (const chunk of stream) {
				checkAbort(signal);
				const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				bytesImported += buf.byteLength;
				sourceHash.update(buf);
				parser.push(buf);
				await yieldToEventLoop();
			}
		} finally {
			if (!stream.destroyed) stream.destroy();
		}
		checkAbort(signal);
		parser.end();
		commitTx();
		phaseTimings["entryImport"] = Date.now() - importStart;
		if (!headerValidated) throw new Error(`ECDICT source CSV is empty: ${sourcePath}`);
		const importPassSha256 = sourceHash.digest("hex").toLowerCase();
		if (bytesImported !== descriptor.sourceByteSize) throw new Error(`Import pass byte size verification failed: expected ${descriptor.sourceByteSize}, consumed ${bytesImported}`);
		if (importPassSha256 !== descriptor.sourceSha256.toLowerCase()) throw new Error(`Import pass SHA-256 verification failed: expected ${descriptor.sourceSha256}, calculated ${importPassSha256}`);
		notifyProgress(options?.onProgress, {
			phase: "resolving-forms",
			processed: validRows
		});
		checkAbort(signal);
		const formResStart = Date.now();
		const exchangeResult = exchangeCollector.resolve();
		exchangeCollector = null;
		phaseTimings["formResolution"] = Date.now() - formResStart;
		const { forms } = exchangeResult;
		notifyProgress(options?.onProgress, {
			phase: "inserting-forms",
			processed: 0,
			total: forms.length
		});
		const formInsStart = Date.now();
		let formBatch = 0;
		let insertedForms = 0;
		ensureTx();
		for (const formRecord of forms) {
			checkAbort(signal);
			insertFormStmt.run(formRecord.form, formRecord.headword, formRecord.kind);
			insertedForms++;
			formBatch++;
			if (formBatch >= batchSize) {
				commitTx();
				await yieldToEventLoop();
				ensureTx();
				formBatch = 0;
			}
		}
		commitTx();
		await yieldToEventLoop();
		phaseTimings["formInsertion"] = Date.now() - formInsStart;
		notifyProgress(options?.onProgress, { phase: "indexing" });
		checkAbort(signal);
		const indexStart = Date.now();
		db.exec("CREATE INDEX idx_forms_headword_raw ON forms (headword);");
		await yieldToEventLoop();
		checkAbort(signal);
		db.exec("CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);");
		await yieldToEventLoop();
		phaseTimings["indexCreation"] = Date.now() - indexStart;
		checkAbort(signal);
		const logicalHash = createHash("sha256");
		const logicalHashStartNs = process.hrtime.bigint();
		const dumpEntries = db.prepare(`
      SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency
      FROM entries
      ORDER BY word COLLATE NOCASE ASC
    `);
		let entryIterCount = 0;
		for (const row of dumpEntries.iterate()) {
			checkAbort(signal);
			logicalHash.update(`entry:${row.word}\0${row.phonetic ?? ""}\0${row.definition_en ?? ""}\0${row.translation_zh ?? ""}\0${row.pos ?? ""}\0${row.exchange ?? ""}\0${row.frequency ?? ""}\n`);
			entryIterCount++;
			if (entryIterCount % yieldInterval === 0) await yieldToEventLoop();
		}
		const dumpForms = db.prepare(`
      SELECT form, headword, kind
      FROM forms
      ORDER BY form COLLATE NOCASE ASC
    `);
		let formIterCount = 0;
		for (const row of dumpForms.iterate()) {
			checkAbort(signal);
			logicalHash.update(`form:${row.form}\0${row.headword}\0${row.kind ?? ""}\n`);
			formIterCount++;
			if (formIterCount % yieldInterval === 0) await yieldToEventLoop();
		}
		const dumpExamples = db.prepare(`
      SELECT id, headword, english, chinese, source, source_id, score
      FROM examples
      ORDER BY id ASC
    `);
		for (const row of dumpExamples.iterate()) {
			checkAbort(signal);
			logicalHash.update(`example:${row.id}\0${row.headword}\0${row.english}\0${row.chinese ?? ""}\0${row.source ?? ""}\0${row.source_id ?? ""}\0${row.score ?? ""}\n`);
		}
		const logicalSha256 = logicalHash.digest("hex").toLowerCase();
		const logicalHashEndNs = process.hrtime.bigint();
		phaseTimings["logicalHashing"] = Math.round(Number(logicalHashEndNs - logicalHashStartNs) / 1e6);
		checkAbort(signal);
		const metaStart = Date.now();
		ensureTx();
		insertMetaStmt.run("schema_version", String(descriptor.schemaVersion));
		insertMetaStmt.run("corpus_name", descriptor.sourceName);
		insertMetaStmt.run("upstream_commit", descriptor.sourceCommit);
		insertMetaStmt.run("source_sha256", importPassSha256);
		insertMetaStmt.run("builder_version", "1.1.0");
		insertMetaStmt.run("parser_version", "1.1.0");
		insertMetaStmt.run("entry_count", String(validRows));
		insertMetaStmt.run("form_count", String(forms.length));
		insertMetaStmt.run("example_count", "0");
		insertMetaStmt.run("logical_sha256", logicalSha256);
		commitTx();
		phaseTimings["metadata"] = Date.now() - metaStart;
		await yieldToEventLoop();
		db.close();
		dbOpen = false;
		await yieldToEventLoop();
		notifyProgress(options?.onProgress, { phase: "validating" });
		checkAbort(signal);
		await yieldToEventLoop();
		let integrityCheckDurationMs = 0;
		if (options?.sqliteFactory) {
			const validationDb = options.sqliteFactory(candidatePath);
			try {
				try {
					validationDb.exec("PRAGMA mmap_size = 268435456");
					validationDb.exec("PRAGMA cache_size = -64000");
				} catch {}
				checkAbort(signal);
				const integrityStartNs = process.hrtime.bigint();
				const rows = validationDb.prepare("PRAGMA integrity_check").all();
				const integrityEndNs = process.hrtime.bigint();
				integrityCheckDurationMs = Math.round(Number(integrityEndNs - integrityStartNs) / 1e6);
				if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
					const errorDetails = rows.map((r) => String(Object.values(r)[0] ?? "unknown integrity error")).join("; ");
					throw new Error(`Candidate SQLite PRAGMA integrity_check failed: ${errorDetails || "empty result"}`);
				}
			} finally {
				validationDb.close();
			}
		} else if (options?.integrityVerifier) integrityCheckDurationMs = (await options.integrityVerifier(candidatePath, signal)).durationMs;
		else integrityCheckDurationMs = (await verifyCandidateDatabaseWithWorker(candidatePath, {
			signal,
			workerUrl: options?.workerUrl,
			expectedDirectory: paths.databaseDirectory,
			workerAdapter: options?.workerAdapter,
			terminationTimeoutMs: options?.terminationTimeoutMs
		})).durationMs;
		phaseTimings["integrityCheck"] = integrityCheckDurationMs;
		checkAbort(signal);
		await yieldToEventLoop();
		checkAbort(signal);
		await yieldToEventLoop();
		checkAbort(signal);
		const syncStart = Date.now();
		const fh = await open(candidatePath, "r+");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		phaseTimings["fileSync"] = Date.now() - syncStart;
		await yieldToEventLoop();
		checkAbort(signal);
		const valStart = Date.now();
		if (verifyProbes) {
			const dict = openProductionDictionary({
				path: candidatePath,
				manifest: {
					sourceName: descriptor.sourceName,
					sourceCommit: descriptor.sourceCommit,
					sourceSha256: importPassSha256,
					schemaVersion: descriptor.schemaVersion
				}
			});
			try {
				verifyCandidateProbes(dict);
			} finally {
				dict.close();
			}
		}
		phaseTimings["productValidation"] = Date.now() - valStart;
		await yieldToEventLoop();
		checkAbort(signal);
		const statStart = Date.now();
		const candidateStats = await stat(candidatePath);
		const fileSha256 = await computeFileSha256(candidatePath);
		const byteSize = candidateStats.size;
		phaseTimings["physicalDigest"] = Date.now() - statStart;
		await yieldToEventLoop();
		checkAbort(signal);
		notifyProgress(options?.onProgress, { phase: "publishing" });
		checkAbort(signal);
		await validateCandidateDatabasePath(candidatePath, paths.databaseDirectory);
		const pubStart = Date.now();
		await link(candidatePath, finalPath);
		published = true;
		phaseTimings["publication"] = Date.now() - pubStart;
		let candidateRemoved = false;
		let sidecarsRemoved = true;
		let sidecarErrorCode;
		let candidateErrorCode;
		const candidateUnlinkFn = options?.unlinkFn ?? unlink;
		for (const suffix of [
			"-journal",
			"-wal",
			"-shm"
		]) {
			const sidecarPath = candidatePath + suffix;
			try {
				await candidateUnlinkFn(sidecarPath);
				if (existsSync(sidecarPath)) {
					sidecarsRemoved = false;
					if (!sidecarErrorCode) sidecarErrorCode = "UNKNOWN";
				}
			} catch (scErr) {
				if (scErr?.code !== "ENOENT") {
					sidecarsRemoved = false;
					if (!sidecarErrorCode) sidecarErrorCode = typeof scErr?.code === "string" ? scErr.code : "UNKNOWN";
				} else if (existsSync(sidecarPath)) {
					sidecarsRemoved = false;
					if (!sidecarErrorCode) sidecarErrorCode = "ENOENT";
				}
			}
		}
		const MAX_CLEANUP_ATTEMPTS = 3;
		for (let attempt = 1; attempt <= MAX_CLEANUP_ATTEMPTS; attempt++) {
			try {
				await candidateUnlinkFn(candidatePath);
				if (!existsSync(candidatePath)) {
					candidateRemoved = true;
					candidateErrorCode = void 0;
					break;
				}
			} catch (unlinkErr) {
				if (unlinkErr?.code === "ENOENT") {
					if (!existsSync(candidatePath)) {
						candidateRemoved = true;
						candidateErrorCode = void 0;
						break;
					} else candidateErrorCode = "ENOENT";
				} else candidateErrorCode = typeof unlinkErr?.code === "string" ? unlinkErr.code : "UNKNOWN";
			}
			if (attempt < MAX_CLEANUP_ATTEMPTS) await yieldToEventLoop();
		}
		if (!candidateRemoved && !candidateErrorCode) candidateErrorCode = "UNKNOWN";
		const effectiveErrorCode = sidecarErrorCode ?? candidateErrorCode;
		const postPublicationCleanup = Object.freeze(effectiveErrorCode || !candidateRemoved || !sidecarsRemoved ? {
			candidateRemoved,
			sidecarsRemoved,
			errorCode: effectiveErrorCode ?? "UNKNOWN"
		} : {
			candidateRemoved: true,
			sidecarsRemoved: true
		});
		notifyProgress(options?.onProgress, {
			phase: "complete",
			processed: validRows,
			total: validRows
		});
		return Object.freeze({
			identity,
			path: finalPath,
			databaseFile: finalFileName,
			sourceCommit: descriptor.sourceCommit,
			sourceSha256: importPassSha256,
			schemaVersion: descriptor.schemaVersion,
			entryCount: validRows,
			formCount: forms.length,
			exampleCount: 0,
			ambiguousFormCount: exchangeResult.ambiguous.length,
			rejectedRowCount: rejectedRowsCount,
			sourceRowCount: validRows + rejectedRowsCount,
			logicalSha256,
			fileSha256,
			byteSize,
			yieldCount,
			integrityCheckDurationMs,
			phaseTimings: Object.freeze({ ...phaseTimings }),
			postPublicationCleanup
		});
	} catch (err) {
		if (inTx) {
			try {
				db?.exec("ROLLBACK");
			} catch {}
			inTx = false;
		}
		if (dbOpen) {
			try {
				db?.close();
			} catch {}
			dbOpen = false;
		}
		const terminationUnconfirmed = isTerminationUnconfirmed(err);
		if (terminationUnconfirmed && candidatePath !== null) {
			const termInfo = extractWorkerTerminationInfo(err);
			const capturedIdentity = termInfo?.candidateFileIdentity ?? captureCandidateFileIdentity(candidatePath);
			quarantinedDirectories.set(normalizedDbDir, {
				directory: normalizedDbDir,
				candidatePath,
				quarantinedAt: Date.now(),
				reason: "Worker termination unconfirmed: possible lingering SQLite file handle",
				error: err,
				workerId: termInfo?.workerId,
				candidateFileIdentity: capturedIdentity
			});
		}
		let cleanupError = null;
		if (!published && candidatePath !== null && !terminationUnconfirmed) try {
			await cleanupCandidateArtifacts(candidatePath, options?.unlinkFn);
		} catch (cErr) {
			cleanupError = cErr;
		}
		if (cleanupError !== null) {
			if (err) {
				const errors = [err, ...cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]];
				throw new AggregateError(errors, `ECDICT import failed and candidate cleanup failed: ${String(err)}`);
			}
			throw cleanupError;
		}
		if (isAbortError(err)) throw createAbortError(signal?.reason);
		throw err;
	} finally {
		activeImports.delete(normalizedDbDir);
	}
}
//#endregion
//#region src/host/route.ts
/**
* The host's route path.
*
* The `/api` prefix is not added by the transport: `assertFetchRoute` rejects a
* path whose first segment is not `api`, and a route without the prefix would
* fail at plugin load rather than at request time.
*
* This module exists so the absolute string lives in the host half only. The
* browser half addresses the same route through the document-relative literal in
* `src/shared/protocol.ts`, and `tests/host-route.spec.ts` asserts that the two
* spell the same route — the browser bundle must never contain the absolute form,
* which a value derived from a shared constant would have put there.
*
* @module dsh-word-lookup/host/route
*/
/** Absolute path of the exact Fetch route owned by this plugin. */
const LOOKUP_PATH = "/api/dsh-word-lookup";
/** Absolute path of dictionary management status route. */
const MANAGEMENT_STATUS_PATH = "/api/dsh-word-lookup/dictionary/status";
/** Absolute path of dictionary installation route. */
const MANAGEMENT_INSTALL_PATH = "/api/dsh-word-lookup/dictionary/install";
/** Absolute path of dictionary cancellation route. */
const MANAGEMENT_CANCEL_PATH = "/api/dsh-word-lookup/dictionary/cancel";
/** Absolute path of dictionary removal route. */
const MANAGEMENT_REMOVE_PATH = "/api/dsh-word-lookup/dictionary/remove";
/** Absolute path of dictionary verification route. */
const MANAGEMENT_VERIFY_PATH = "/api/dsh-word-lookup/dictionary/verify";
//#endregion
//#region src/host/dictionary-activation.ts
/**
* Activation coordination, persistence consistency, startup recovery, and managed corpus removal.
*
* Implements the atomic activation transaction protocol and fail-closed state consistency:
* - Validates candidate databases read-only before committing activation.
* - Commits `active.json` atomically via {@link writeActiveMetadataAtomically}.
* - Atomically switches live {@link DictionaryManager} active reference.
* - Best-effort syncs Host Config `dictionaryMode` via DSH settings service without blocking activation.
* - Enforces startup recovery: checks metadata and database health on plugin boot, gracefully degrading
*   to fixture if corrupt or missing without corrupting disk state or triggering unauthorized network downloads.
* - Enforces safe removal: hot-switches manager to fixture to release Windows SQLite file locks before unlinking.
* - Preserves verified source cache upon removal for future re-installations.
* - Provides read-only verification for custom SQLite databases without file mutation.
*
* Invariants:
* - Zero network access in this module.
* - Fail-closed: rejections preserve existing active dictionary.
* - Safe on Windows: handles closed before unlinking.
*
* @module dsh-word-lookup/host/dictionary-activation
*/
/** Probe headwords queried to verify query capability on candidate databases. */
const ACTIVATION_PROBE_HEADWORDS = Object.freeze([
	"go",
	"derive",
	"wave"
]);
/** Supported extensions for custom SQLite dictionary verification. */
const VALID_SQLITE_EXTENSIONS = /* @__PURE__ */ new Set([
	".sqlite3",
	".sqlite",
	".db"
]);
/**
* Sanitize error message to prevent leaking machine-specific paths, credentials, or stack traces.
*/
function sanitizeErrorMessage$1(rawMessage) {
	if (!rawMessage || typeof rawMessage !== "string") return "Unknown error occurred";
	return rawMessage.replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, "[local-path]").replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, "[local-path]").trim();
}
/**
* Error thrown when an activation attempt fails and rollback of previous state also fails.
*/
var ActivationRollbackError = class extends Error {
	code = "ACTIVATION_ROLLBACK_FAILED";
	originalError;
	rollbackError;
	constructor(message, originalError, rollbackError) {
		super(message);
		this.name = "ActivationRollbackError";
		this.originalError = originalError;
		this.rollbackError = rollbackError;
	}
};
/**
* Coordinates atomic activation, persistence consistency, recovery, and removal.
*/
var ActivationCoordinator = class {
	#ctx;
	#paths;
	#manager;
	#config;
	#recoveryPromise = null;
	#isRecovering = false;
	#disposed = false;
	#recoveryError = null;
	#settingsSyncState = "pending";
	#settingsSyncError = null;
	#lastRollbackError = null;
	#cachedInstalledCorpus = null;
	constructor(options) {
		this.#ctx = options.ctx;
		this.#paths = options.paths ?? null;
		this.#manager = options.manager;
		this.#config = options.config;
	}
	/**
	* Return storage paths used by this coordinator.
	*/
	get paths() {
		return this.#paths;
	}
	/**
	* Return the underlying live DictionaryManager.
	*/
	get manager() {
		return this.#manager;
	}
	/**
	* Return whether the coordinator has been disposed.
	*/
	get isDisposed() {
		return this.#disposed;
	}
	/**
	* Mark coordinator as disposed, preventing future activations or mutations.
	*/
	dispose() {
		this.#disposed = true;
	}
	/**
	* Return whether startup recovery is currently in flight.
	*/
	get isRecovering() {
		return this.#isRecovering;
	}
	/**
	* Await completion of in-flight startup recovery, ensuring subsequent operations
	* observe settled state and never race or interleave with recovery.
	*/
	async ensureReady() {
		if (this.#recoveryPromise) try {
			await this.#recoveryPromise;
		} catch {}
	}
	/**
	* Startup recovery check: inspects active.json and managed database health.
	*
	* Rules:
	* - If active.json is absent: remains on fixture (fresh install).
	* - If active.json is malformed or corrupt: remains on fixture, records recoveryError.
	* - If active.json exists but database file is missing: remains on fixture, records recoveryError.
	* - If database exists but fails integrity/schema checks: remains on fixture, records recoveryError.
	* - If database is fully verified:
	*   - If configured dictionaryMode === 'managed-ecdict': activates managed dictionary into manager.
	*   - If configured dictionaryMode === 'fixture' and previous settings sync failed (A02/A03):
	*     recovers committed managed activation intent, activates managed dictionary, preserves settingsSyncError.
	*   - If configured dictionaryMode === 'fixture' and settings was cleanly synced (A04):
	*     honors explicit user choice, keeps fixture active, caches verified installed corpus info.
	*   - Else: caches verified installed corpus info without activating.
	*/
	recoverOnStartup() {
		if (this.#recoveryPromise) return this.#recoveryPromise;
		this.#isRecovering = true;
		this.#recoveryPromise = this.#runStartupRecovery().finally(() => {
			this.#isRecovering = false;
		});
		return this.#recoveryPromise;
	}
	async #runStartupRecovery() {
		this.#recoveryError = null;
		this.#cachedInstalledCorpus = null;
		if (!this.#paths) return;
		let metadata;
		try {
			metadata = await readActiveMetadata(this.#paths);
		} catch (error) {
			this.#recoveryError = `Corrupt active metadata: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		if (!metadata) return;
		if (metadata.settingsSyncError) this.#settingsSyncError = metadata.settingsSyncError;
		if (metadata.settingsSyncState) this.#settingsSyncState = metadata.settingsSyncState;
		else if (metadata.settingsSynced === true) this.#settingsSyncState = "synced";
		else if (metadata.settingsSynced === false) this.#settingsSyncState = "failed";
		else if (metadata.settingsSyncError) this.#settingsSyncState = "failed";
		else this.#settingsSyncState = "synced";
		const dbPath = join(this.#paths.databaseDirectory, metadata.databaseFile);
		if (!existsSync(dbPath)) {
			this.#recoveryError = `Managed database file missing: ${metadata.databaseFile}`;
			return;
		}
		let openedDict = null;
		try {
			openedDict = openProductionDictionary({ path: dbPath });
			for (const probe of ACTIVATION_PROBE_HEADWORDS) openedDict.lookup(probe);
		} catch (error) {
			if (openedDict) try {
				openedDict.close();
			} catch {}
			this.#recoveryError = `Corrupt or incompatible managed database: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		let stats = {};
		try {
			const fileStat = statSync(dbPath);
			const rawDb = new DatabaseSync(dbPath, {
				readOnly: true,
				open: true
			});
			try {
				const entryRow = rawDb.prepare("SELECT COUNT(*) as c FROM entries").get();
				const formRow = rawDb.prepare("SELECT COUNT(*) as c FROM forms").get();
				stats = {
					entryCount: entryRow?.c,
					formCount: formRow?.c,
					byteSize: fileStat.size
				};
			} finally {
				rawDb.close();
			}
		} catch {}
		this.#cachedInstalledCorpus = Object.freeze({
			name: metadata.source.name,
			commit: metadata.source.commit,
			sha256: metadata.source.sha256,
			schemaVersion: metadata.source.schemaVersion,
			databaseFile: metadata.databaseFile,
			entryCount: stats.entryCount,
			formCount: stats.formCount,
			byteSize: stats.byteSize
		});
		const userMode = readDictionaryMode(this.#config);
		const settingsSyncFailed = !(this.#settingsSyncState === "synced" && metadata.settingsSynced !== false && !metadata.settingsSyncError);
		if (userMode === "managed-ecdict" || userMode === "fixture" && settingsSyncFailed) try {
			this.#manager.activate({
				mode: "managed-ecdict",
				identity: metadata.identity,
				dictionary: openedDict
			});
			if (settingsSyncFailed) {
				if (await this.#persistHostConfigMode("managed-ecdict") === "synced") try {
					await writeActiveMetadataAtomically(this.#paths, {
						...metadata,
						settingsSynced: true,
						settingsSyncState: "synced",
						settingsSyncError: null
					});
				} catch {}
			}
		} catch (error) {
			openedDict.close();
			this.#recoveryError = `Activation failed during startup: ${error instanceof Error ? error.message : String(error)}`;
		}
		else openedDict.close();
	}
	/**
	* Commit a newly built managed database and activate it in DictionaryManager.
	*
	* Transaction Sequence:
	* 1. Validate published SQLite database read-only.
	* 2. Atomically write `active.json` (Commit Point 1: Durability).
	* 3. Atomically switch `DictionaryManager` active reference (Commit Point 2: Runtime).
	* 4. Best-effort update Host Config `dictionaryMode` via DSH settings service (Commit Point 3).
	*
	* On Step 3 failure, rolls back `active.json` and closes the candidate.
	*
	* @param buildResult - verified outcome from buildManagedEcdictDatabase.
	*/
	async activateManagedDatabase(buildResult, options) {
		const signal = options?.signal;
		if (signal?.aborted) {
			const err = /* @__PURE__ */ new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		}
		if (!this.#paths) throw new Error("Managed storage unavailable: cannot activate database");
		const publishedPath = buildResult.path;
		if (!existsSync(publishedPath)) throw new Error(`Published database file not found at: ${publishedPath}`);
		if (signal?.aborted) {
			const err = /* @__PURE__ */ new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		}
		let previousMetadata = null;
		try {
			previousMetadata = await readActiveMetadata(this.#paths);
		} catch {}
		if (signal?.aborted) {
			const err = /* @__PURE__ */ new Error("The operation was aborted");
			err.name = "AbortError";
			throw err;
		}
		const publishedDict = openProductionDictionary({ path: publishedPath });
		try {
			for (const probe of ACTIVATION_PROBE_HEADWORDS) publishedDict.lookup(probe);
		} catch (error) {
			publishedDict.close();
			throw new Error(`Candidate database probe verification failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		if (signal?.aborted || this.#disposed || this.#manager.snapshot().lifecycle === "closed") {
			publishedDict.close();
			const err = /* @__PURE__ */ new Error(this.#disposed || this.#manager.snapshot().lifecycle === "closed" ? "Activation cancelled: coordinator is disposed or manager is closed" : "The operation was aborted");
			err.name = "AbortError";
			throw err;
		}
		options?.onCommitBoundary?.();
		const metadata = {
			version: 1,
			activeMode: "managed-ecdict",
			identity: buildResult.identity,
			databaseFile: buildResult.databaseFile,
			source: {
				name: "ECDICT",
				commit: buildResult.sourceCommit,
				sha256: buildResult.sourceSha256,
				schemaVersion: buildResult.schemaVersion
			},
			lastActivatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			settingsSynced: false,
			settingsSyncState: "pending",
			settingsSyncError: null
		};
		try {
			await writeActiveMetadataAtomically(this.#paths, metadata);
		} catch (error) {
			publishedDict.close();
			throw new Error(`Failed to commit active metadata atomically: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		try {
			if (this.#disposed || this.#manager.snapshot().lifecycle === "closed") throw new Error("Activation cancelled: coordinator is disposed or manager is closed");
			this.#manager.activate({
				mode: "managed-ecdict",
				identity: buildResult.identity,
				dictionary: publishedDict
			});
		} catch (error) {
			try {
				publishedDict.close();
			} catch {}
			if (previousMetadata !== null) try {
				await writeActiveMetadataAtomically(this.#paths, previousMetadata);
			} catch (rollbackErr) {
				const origMsg = sanitizeErrorMessage$1(error instanceof Error ? error.message : String(error));
				const rollbackMsg = sanitizeErrorMessage$1(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
				this.#lastRollbackError = `Rollback failed: unable to restore previous active metadata: ${rollbackMsg}`;
				throw new ActivationRollbackError(`Activation failed (${origMsg}) and rollback of previous active metadata also failed: ${rollbackMsg}`, error, rollbackErr);
			}
			else try {
				await unlink(this.#paths.activeMetadataPath);
			} catch {}
			throw error;
		}
		this.#cachedInstalledCorpus = Object.freeze({
			name: metadata.source.name,
			commit: metadata.source.commit,
			sha256: metadata.source.sha256,
			schemaVersion: metadata.source.schemaVersion,
			databaseFile: metadata.databaseFile,
			entryCount: buildResult.entryCount,
			formCount: buildResult.formCount,
			byteSize: buildResult.byteSize,
			publishedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		this.#recoveryError = null;
		const syncState = await this.#persistHostConfigMode("managed-ecdict");
		try {
			await writeActiveMetadataAtomically(this.#paths, {
				...metadata,
				settingsSynced: syncState === "synced",
				settingsSyncState: syncState,
				settingsSyncError: this.#settingsSyncError
			});
		} catch {}
	}
	/**
	* Safely remove the managed ECDICT database and revert active dictionary to fixture.
	*
	* Sequence:
	* 1. Safe hot-switch to fixture in DictionaryManager, releasing Windows file locks on SQLite files.
	* 2. Remove `active.json`.
	* 3. Unlink versioned SQLite file `ecdict-<identity>.sqlite3`.
	* 4. Clean stale temporary artifacts.
	* 5. Preserve source cache in `cache/dsh-word-lookup/sources/ecdict.csv`.
	* 6. Best-effort update Host Config `dictionaryMode` to 'fixture'.
	*/
	async removeManagedDatabase() {
		const fixture = openFixtureDictionary();
		this.#manager.activate({
			mode: "fixture",
			identity: "fixture",
			dictionary: fixture
		});
		if (!this.#paths) {
			this.#cachedInstalledCorpus = null;
			this.#recoveryError = null;
			this.#settingsSyncState = "pending";
			this.#settingsSyncError = null;
			this.#lastRollbackError = null;
			await this.#persistHostConfigMode("fixture");
			return { removed: false };
		}
		let currentMetadata = null;
		try {
			currentMetadata = await readActiveMetadata(this.#paths);
		} catch {}
		try {
			await unlink(this.#paths.activeMetadataPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (currentMetadata?.databaseFile) {
			const dbPath = join(this.#paths.databaseDirectory, currentMetadata.databaseFile);
			try {
				await unlink(dbPath);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		await removeStaleTemporaryArtifacts(this.#paths);
		this.#cachedInstalledCorpus = null;
		this.#recoveryError = null;
		this.#settingsSyncState = "pending";
		this.#settingsSyncError = null;
		this.#lastRollbackError = null;
		await this.#persistHostConfigMode("fixture");
		return { removed: true };
	}
	/**
	* Verify an arbitrary custom SQLite dictionary path without mutation or activation.
	*
	* Validates:
	* - Path existence, format, and extension (`.sqlite3`, `.sqlite`, `.db`).
	* - SQLite header and schema (tables `meta`, `entries`, `forms`, `examples`).
	* - Query compatibility via sample lookups.
	* - Never mutates candidate file.
	*
	* @param candidatePath - host filesystem path to candidate database.
	*/
	async verifyCustomDatabase(candidatePath) {
		if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) return {
			valid: false,
			schemaVersion: 0,
			entryCount: 0,
			formCount: 0,
			headwordsSample: [],
			error: "Candidate database path must be a non-empty string",
			errorCode: "INVALID_PATH"
		};
		const trimmedPath = candidatePath.trim();
		if (trimmedPath.includes("\0")) return {
			valid: false,
			schemaVersion: 0,
			entryCount: 0,
			formCount: 0,
			headwordsSample: [],
			error: "Candidate database path contains null bytes",
			errorCode: "INVALID_PATH"
		};
		const resolvedPath = resolve(trimmedPath);
		const base = basename(resolvedPath).toLowerCase();
		if (![...VALID_SQLITE_EXTENSIONS].some((ext) => base.endsWith(ext))) return {
			valid: false,
			schemaVersion: 0,
			entryCount: 0,
			formCount: 0,
			headwordsSample: [],
			error: `Database filename must have a valid SQLite extension (${[...VALID_SQLITE_EXTENSIONS].join(", ")})`,
			errorCode: "INVALID_SQLITE_FILE"
		};
		try {
			if (!(await stat(resolvedPath)).isFile()) return {
				valid: false,
				schemaVersion: 0,
				entryCount: 0,
				formCount: 0,
				headwordsSample: [],
				error: "Target path is not a regular file",
				errorCode: "NOT_A_FILE"
			};
		} catch (error) {
			if (error.code === "ENOENT") return {
				valid: false,
				schemaVersion: 0,
				entryCount: 0,
				formCount: 0,
				headwordsSample: [],
				error: "Candidate database file does not exist",
				errorCode: "FILE_NOT_FOUND"
			};
			return {
				valid: false,
				schemaVersion: 0,
				entryCount: 0,
				formCount: 0,
				headwordsSample: [],
				error: `Cannot access candidate file: ${error.message}`,
				errorCode: "INVALID_PATH"
			};
		}
		let db = null;
		try {
			db = new DatabaseSync(resolvedPath, {
				readOnly: true,
				open: true
			});
			const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
			for (const table of [
				"meta",
				"entries",
				"forms",
				"examples"
			]) if (!tableStmt.get(table)) return {
				valid: false,
				schemaVersion: 0,
				entryCount: 0,
				formCount: 0,
				headwordsSample: [],
				error: `Database is missing required table: "${table}"`,
				errorCode: "INVALID_DATABASE_SCHEMA"
			};
			const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
			const schemaVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 1;
			const entryCountRow = db.prepare("SELECT COUNT(*) as c FROM entries").get();
			const formCountRow = db.prepare("SELECT COUNT(*) as c FROM forms").get();
			return {
				valid: true,
				schemaVersion,
				entryCount: entryCountRow?.c ?? 0,
				formCount: formCountRow?.c ?? 0,
				headwordsSample: db.prepare("SELECT word FROM entries LIMIT 5").all().map((r) => r.word)
			};
		} catch (error) {
			return {
				valid: false,
				schemaVersion: 0,
				entryCount: 0,
				formCount: 0,
				headwordsSample: [],
				error: `Failed to verify SQLite database: ${error instanceof Error ? error.message : String(error)}`,
				errorCode: "INVALID_DATABASE_SCHEMA"
			};
		} finally {
			if (db) try {
				db.close();
			} catch {}
		}
	}
	/**
	* Return a diagnostic state snapshot.
	*/
	getStatusSummary() {
		const snap = this.#manager.snapshot();
		const configuredMode = readDictionaryMode(this.#config);
		const isInstalled = this.#paths !== null && this.#cachedInstalledCorpus !== null && existsSync(join(this.#paths.databaseDirectory, this.#cachedInstalledCorpus.databaseFile));
		const quarantineRecord = this.#paths ? getQuarantineRecord(this.#paths.databaseDirectory) : null;
		return Object.freeze({
			activeMode: snap.activeMode,
			configuredMode,
			activeSource: snap.source,
			activeIdentity: snap.identity,
			installed: isInstalled,
			installedCorpus: this.#cachedInstalledCorpus,
			quarantined: quarantineRecord !== null,
			quarantineReason: quarantineRecord?.reason ?? null,
			recoveryError: this.#recoveryError,
			settingsSyncState: this.#settingsSyncState,
			settingsSyncError: this.#settingsSyncError,
			lastRetirementError: snap.lastRetirementError,
			lastRollbackError: this.#lastRollbackError,
			generation: snap.generation
		});
	}
	/**
	* Best-effort persistence of dictionaryMode to Host settings.
	*/
	async #persistHostConfigMode(mode) {
		const settings = this.#ctx?.get?.("settings");
		if (!settings || typeof settings.update !== "function") {
			this.#settingsSyncState = "unavailable";
			return "unavailable";
		}
		try {
			await settings.update("dsh-word-lookup", { dictionaryMode: mode });
			this.#settingsSyncState = "synced";
			this.#settingsSyncError = null;
			return "synced";
		} catch (err) {
			const msg = sanitizeErrorMessage$1(err instanceof Error ? err.message : String(err));
			this.#settingsSyncState = "failed";
			this.#settingsSyncError = `Settings update failed: ${msg}`;
			return "failed";
		}
	}
};
//#endregion
//#region src/host/dictionary-operations.ts
/**
* Host Dictionary Operation Manager for asynchronous lifecycle orchestration.
*
* Implements Phase 7A.6 DictionaryOperationManager:
* - Single-instance task manager owned by Host lifecycle.
* - Manages ECDICT download, source verification, static Worker build, and atomic activation.
* - Enforces strict finite state machine with monotonic progress phases.
* - Single in-flight operation mutex gating (no concurrent download/import pipelines).
* - Safe cancellation dispatch with AbortSignal and idempotent cancel semantics.
* - Throttles external progress notification to <= 10 Hz with observer error isolation.
* - Bounded retention of last operation outcome.
* - Clean disposal and drain support on plugin unload.
*
* @module dsh-word-lookup/host/dictionary-operations
*/
/** Minimum interval between throttled progress emissions in milliseconds (10 Hz). */
const PROGRESS_THROTTLE_MS = 100;
/**
* Error thrown when an install operation is requested while another is already running.
*/
var OperationInProgressError = class extends Error {
	code = "OPERATION_IN_PROGRESS";
	operationId;
	constructor(operationId) {
		super(`Dictionary operation already in progress (operationId: ${operationId})`);
		this.name = "OperationInProgressError";
		this.operationId = operationId;
	}
};
/**
* Error thrown when an operation is requested on a quarantined storage directory.
*/
var OperationDirectoryQuarantinedError = class extends Error {
	code = "DIRECTORY_QUARANTINED";
	directory;
	reason;
	constructor(directory, reason) {
		super(`Cannot start operation: storage directory is quarantined (${reason})`);
		this.name = "OperationDirectoryQuarantinedError";
		this.directory = directory;
		this.reason = reason;
	}
};
/**
* Error thrown when attempting to cancel an unknown or settled operation.
*/
var OperationNotFoundError = class extends Error {
	code = "OPERATION_NOT_FOUND";
	operationId;
	constructor(operationId) {
		super(`Operation not found: ${operationId}`);
		this.name = "OperationNotFoundError";
		this.operationId = operationId;
	}
};
/**
* Error thrown when attempting to cancel an operation that has passed the commit boundary.
*/
var OperationNotCancellableError = class extends Error {
	code = "OPERATION_NOT_CANCELLABLE";
	operationId;
	constructor(operationId) {
		super(`Operation "${operationId}" has passed the linearizable commit boundary and cannot be cancelled`);
		this.name = "OperationNotCancellableError";
		this.operationId = operationId;
	}
};
/**
* Error thrown when draining in-flight operations times out during dispose.
*/
var OperationDrainTimeoutError = class extends Error {
	code = "DRAIN_TIMEOUT";
	timeoutMs;
	constructor(timeoutMs, message) {
		super(message ?? `Dictionary operation failed to drain within ${timeoutMs}ms: worker or network exit status unknown`);
		this.name = "OperationDrainTimeoutError";
		this.timeoutMs = timeoutMs;
	}
};
/**
* Sanitize error message to prevent leaking machine-specific paths, credentials, or stack traces.
*/
function sanitizeErrorMessage(rawMessage) {
	if (!rawMessage || typeof rawMessage !== "string") return "Unknown error occurred";
	return rawMessage.replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, "[local-path]").replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, "[local-path]").trim();
}
/**
* Host-lifecycle single-instance operation manager.
*/
var DictionaryOperationManager = class {
	#paths;
	#activationCoordinator;
	#logger;
	#currentOp = null;
	#lastOp = null;
	#activeRemove = null;
	#drainSummary = null;
	#disposed = false;
	#lastEmitTime = 0;
	#listeners = /* @__PURE__ */ new Set();
	constructor(options) {
		this.#paths = options.paths ?? null;
		this.#activationCoordinator = options.activationCoordinator;
		this.#logger = options.logger;
	}
	/**
	* Whether the manager has been disposed.
	*/
	get isDisposed() {
		return this.#disposed;
	}
	/**
	* Return the snapshot of the currently running operation, if any.
	*/
	getCurrentOperation() {
		return this.#currentOp ? Object.freeze({ ...this.#currentOp.snapshot }) : null;
	}
	/**
	* Return the snapshot of the most recently settled operation, if any.
	*/
	getLastOperation() {
		return this.#lastOp ? Object.freeze({ ...this.#lastOp }) : null;
	}
	/**
	* Return diagnostic drain summary after disposal.
	*/
	getDrainSummary() {
		return this.#drainSummary ? Object.freeze({ ...this.#drainSummary }) : null;
	}
	/**
	* Return a promise that settles when all current in-flight operations (install and remove) settle.
	* Resolves immediately if no operations are active.
	*/
	async whenSettled() {
		const promises = [];
		if (this.#currentOp) promises.push(this.#currentOp.promise);
		if (this.#activeRemove) promises.push(this.#activeRemove.promise);
		if (promises.length === 0) return;
		await Promise.allSettled(promises);
	}
	/**
	* Check whether an installation operation can currently be accepted.
	*/
	canInstall() {
		if (this.#disposed) return false;
		if (!this.#paths) return false;
		if (this.isBusy()) return false;
		if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) return false;
		return true;
	}
	/**
	* Check whether the managed dictionary can currently be removed.
	*/
	canRemove() {
		if (this.#disposed) return false;
		if (!this.#paths) return false;
		if (this.isBusy()) return false;
		if (isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) || getQuarantineRecord(this.#paths.databaseDirectory) !== null) return false;
		return this.#activationCoordinator.getStatusSummary().installed;
	}
	/**
	* Check whether an active operation can be cancelled.
	*/
	canCancel() {
		return this.#currentOp !== null && this.#currentOp.snapshot.status === "running" && !this.#currentOp.nonCancellable;
	}
	/**
	* Check whether an operation (install or remove) is currently active.
	*/
	isBusy() {
		return this.#activeRemove !== null || this.#currentOp !== null && this.#currentOp.snapshot.status === "running";
	}
	/**
	* Subscribe to operation snapshot updates.
	*
	* @param listener - callback receiving updated snapshots.
	* @returns unsubscribe function.
	*/
	subscribe(listener) {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	/**
	* Request installation of ECDICT corpus.
	*
	* Asynchronously initiates verification, download, build, integrity check, and activation.
	* Returns immediately with the assigned operation identifier.
	*
	* @returns initial operation descriptor.
	*/
	install() {
		if (this.#disposed) throw new Error("DictionaryOperationManager is disposed");
		if (!this.#paths) throw new Error("Managed storage is unavailable: DSH home cannot be resolved");
		const quarantine = getQuarantineRecord(this.#paths.databaseDirectory);
		if (quarantine) throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason);
		if (this.isBusy()) throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? "remove");
		const operationId = `install-${Date.now()}-${randomUUID().slice(0, 8)}`;
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const abortController = new AbortController();
		const initialSnapshot = {
			operationId,
			kind: "install",
			phase: "queued",
			status: "running",
			progress: {
				phase: "queued",
				percent: 0,
				unit: "steps",
				message: "ECDICT installation queued"
			},
			startedAt: now,
			updatedAt: now
		};
		let resolveSettled;
		const ctx = {
			operationId,
			abortController,
			startedAt: now,
			snapshot: initialSnapshot,
			promise: new Promise((resolve) => {
				resolveSettled = resolve;
			}),
			cancelRequested: false,
			nonCancellable: false
		};
		this.#currentOp = ctx;
		this.#notifyListeners(true);
		this.#runInstallWorkflow(ctx).finally(() => {
			resolveSettled();
		});
		return {
			operationId,
			status: "running",
			phase: "queued",
			message: "ECDICT installation accepted and running in background"
		};
	}
	/**
	* Request cancellation of an in-flight operation.
	*
	* Idempotent: safe to call multiple times for the same operation.
	*
	* @param operationId - operation identifier to cancel.
	* @returns cancellation status descriptor.
	*/
	cancel(operationId) {
		if (typeof operationId !== "string" || operationId.trim().length === 0) throw new TypeError("operationId must be a non-empty string");
		if (this.#currentOp && this.#currentOp.operationId === operationId) {
			if (this.#currentOp.snapshot.status !== "running") return {
				operationId,
				status: "cancelled",
				message: "Operation is already terminated"
			};
			if (this.#currentOp.nonCancellable) throw new OperationNotCancellableError(operationId);
			this.#currentOp.cancelRequested = true;
			this.#currentOp.abortController.abort();
			this.#updateProgress(this.#currentOp, {
				phase: this.#currentOp.snapshot.phase,
				subphase: "cancelling",
				message: "Cancellation requested, waiting for worker and network to abort..."
			}, true);
			return {
				operationId,
				status: "cancelling",
				message: "Cancellation signal dispatched to background operation"
			};
		}
		if (this.#lastOp && this.#lastOp.operationId === operationId) return {
			operationId,
			status: this.#lastOp.status === "cancelled" ? "cancelled" : "cancelling",
			message: `Operation has already finished with status: ${this.#lastOp.status}`
		};
		throw new OperationNotFoundError(operationId);
	}
	/**
	* Request removal of managed ECDICT database and reversion to fixture.
	*
	* Executes under exclusive operation mutex:
	* - Operation ownership claimed synchronously before any await yielding execution.
	* - Cannot run concurrently with installation or another removal.
	* - Awaits startup recovery to settle before mutating state.
	* - Releases Windows file locks prior to unlinking.
	*
	* @returns removal outcome.
	*/
	async remove() {
		if (this.#disposed) throw new Error("DictionaryOperationManager is disposed");
		if (!this.#paths) throw new Error("Managed storage is unavailable: DSH home cannot be resolved");
		const quarantine = getQuarantineRecord(this.#paths.databaseDirectory);
		if (quarantine) throw new OperationDirectoryQuarantinedError(this.#paths.databaseDirectory, quarantine.reason);
		if (this.isBusy()) throw new OperationInProgressError(this.#currentOp?.operationId ?? this.#activeRemove?.operationId ?? "remove");
		const operationId = `remove-${Date.now()}-${randomUUID().slice(0, 8)}`;
		const abortController = new AbortController();
		let resolveSettled;
		let rejectSettled;
		const settledPromise = new Promise((res, rej) => {
			resolveSettled = res;
			rejectSettled = rej;
		});
		settledPromise.catch(() => {});
		const removeCtx = {
			operationId,
			abortController,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			promise: settledPromise
		};
		this.#activeRemove = removeCtx;
		try {
			if (this.#activationCoordinator.isRecovering) await this.#activationCoordinator.ensureReady();
			if (this.#disposed || removeCtx.abortController.signal.aborted) throw new Error("DictionaryOperationManager was disposed before remove execution");
			if (this.#disposed || removeCtx.abortController.signal.aborted) throw new Error("DictionaryOperationManager was disposed before remove execution");
			const outcome = await this.#activationCoordinator.removeManagedDatabase();
			resolveSettled(outcome);
			return outcome;
		} catch (error) {
			rejectSettled(error);
			throw error;
		} finally {
			this.#activeRemove = null;
		}
	}
	/**
	* Dispose operation manager and await safe drainage of in-flight tasks.
	*
	* @param timeoutMs - maximum wait duration for active worker/download drainage (defaults to 5000ms).
	*/
	async dispose(timeoutMs = 5e3) {
		if (this.#disposed) {
			if (this.isBusy() || this.#drainSummary && !this.#drainSummary.workflowSettled) {
				if (this.isBusy()) {
					let retryTimer;
					const retryTimeoutPromise = new Promise((resolve) => {
						retryTimer = setTimeout(() => resolve("timeout"), timeoutMs);
					});
					try {
						if (await Promise.race([this.whenSettled().then(() => "settled"), retryTimeoutPromise]) === "timeout") throw new OperationDrainTimeoutError(timeoutMs, this.#drainSummary?.error);
					} finally {
						if (retryTimer) clearTimeout(retryTimer);
					}
				}
				if (this.#drainSummary && !this.#drainSummary.workflowSettled) throw new OperationDrainTimeoutError(timeoutMs, this.#drainSummary?.error);
			}
			return;
		}
		this.#disposed = true;
		this.#activationCoordinator.dispose?.();
		const isQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false;
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		try {
			if (this.#currentOp && this.#currentOp.snapshot.status === "running") {
				const opCtx = this.#currentOp;
				opCtx.cancelRequested = true;
				const trackedWorkerIds = workerSupervisor.getTrackedWorkerIds();
				const workerExitWaiters = trackedWorkerIds.map((id) => workerSupervisor.waitForExit(id, timeoutMs).catch(() => null));
				opCtx.abortController.abort();
				if (await Promise.race([opCtx.promise.then(() => "settled").catch(() => "settled"), timeoutPromise]) === "timeout") {
					const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false;
					this.#drainSummary = {
						requestedCancel: true,
						workflowSettled: false,
						workerExited: false,
						timedOut: true,
						statusUnknown: true,
						quarantined: finalQuar,
						operationKind: "install",
						error: `Install operation failed to drain within ${timeoutMs}ms: worker or network exit status unknown`
					};
					throw new OperationDrainTimeoutError(timeoutMs);
				}
				const exitProofs = await Promise.all(workerExitWaiters);
				const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false;
				let workerExited = false;
				let statusUnknown = finalQuar;
				if (trackedWorkerIds.length > 0) {
					if (exitProofs.every((p) => p !== null && workerSupervisor.isExitProofAuthentic(p)) && !finalQuar) {
						workerExited = true;
						statusUnknown = false;
					} else {
						workerExited = false;
						statusUnknown = true;
					}
				} else {
					workerExited = false;
					statusUnknown = finalQuar;
				}
				this.#drainSummary = {
					requestedCancel: true,
					workflowSettled: true,
					workerExited,
					timedOut: false,
					statusUnknown,
					quarantined: finalQuar,
					operationKind: "install"
				};
				return;
			}
			if (this.#activeRemove !== null) {
				const remCtx = this.#activeRemove;
				remCtx.abortController.abort();
				if (await Promise.race([remCtx.promise.then(() => "settled").catch(() => "settled"), timeoutPromise]) === "timeout") {
					const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false;
					this.#drainSummary = {
						requestedCancel: true,
						workflowSettled: false,
						workerExited: false,
						timedOut: true,
						statusUnknown: true,
						quarantined: finalQuar,
						operationKind: "remove",
						error: `Remove operation failed to drain within ${timeoutMs}ms`
					};
					throw new OperationDrainTimeoutError(timeoutMs);
				}
				const finalQuar = this.#paths ? isDatabaseDirectoryQuarantined(this.#paths.databaseDirectory) : false;
				this.#drainSummary = {
					requestedCancel: true,
					workflowSettled: true,
					workerExited: false,
					timedOut: false,
					statusUnknown: finalQuar,
					quarantined: finalQuar,
					operationKind: "remove"
				};
				return;
			}
			this.#drainSummary = {
				requestedCancel: false,
				workflowSettled: true,
				workerExited: false,
				timedOut: false,
				statusUnknown: isQuar,
				quarantined: isQuar,
				operationKind: "none"
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	/**
	* Run the end-to-end installation pipeline.
	*/
	async #runInstallWorkflow(ctx) {
		const signal = ctx.abortController.signal;
		let committed = false;
		let buildResult = null;
		try {
			const paths = this.#paths;
			if (!paths) throw new Error("Managed storage unavailable: DSH home cannot be resolved");
			if (this.#activationCoordinator.isRecovering) await this.#activationCoordinator.ensureReady();
			if (this.#disposed || signal.aborted) throw this.#createAbortError();
			this.#transitionPhase(ctx, "checking-cache", "Verifying local ECDICT source cache...");
			if (this.#disposed || signal.aborted) throw this.#createAbortError();
			await downloadPinnedEcdict(paths, {
				signal,
				onProgress: (dlProgress) => {
					this.#handleDownloadProgress(ctx, dlProgress);
				}
			});
			if (this.#disposed || signal.aborted) throw this.#createAbortError();
			this.#transitionPhase(ctx, "building", "Building managed SQLite database from source...");
			buildResult = await buildManagedEcdictDatabase(paths, {
				signal,
				onProgress: (importProgress) => {
					this.#handleImportProgress(ctx, importProgress);
				}
			});
			if (this.#disposed || signal.aborted) throw this.#createAbortError();
			this.#transitionPhase(ctx, "activating", "Validating and activating managed dictionary...");
			if (this.#disposed || signal.aborted) throw this.#createAbortError();
			await this.#activationCoordinator.activateManagedDatabase(buildResult, {
				signal,
				onCommitBoundary: () => {
					ctx.nonCancellable = true;
				}
			});
			committed = true;
			this.#settleOperation(ctx, "completed", "completed", {
				phase: "completed",
				percent: 100,
				unit: "steps",
				message: `ECDICT corpus successfully installed (${buildResult.entryCount.toLocaleString()} entries)`
			});
		} catch (error) {
			if (!committed && !ctx.nonCancellable && (signal.aborted || this.#isAbortError(error))) this.#settleOperation(ctx, "cancelled", "cancelled", {
				phase: "cancelled",
				unit: "steps",
				message: "Operation cancelled by user before commit point"
			});
			else {
				const errorRecord = this.#formatError(error);
				this.#logger?.error?.("ECDICT installation failed: %s", errorRecord.message);
				this.#settleOperation(ctx, "failed", "failed", {
					phase: "failed",
					unit: "steps",
					message: errorRecord.message
				}, errorRecord);
			}
		} finally {
			this.#lastOp = ctx.snapshot;
			this.#currentOp = null;
			this.#notifyListeners(true);
		}
	}
	/**
	* Handle progress events from ECDICT downloader.
	*/
	#handleDownloadProgress(ctx, p) {
		let phase = "downloading";
		let message = "Downloading ECDICT corpus...";
		let percent;
		if (p.phase === "checking-cache") {
			phase = "checking-cache";
			message = "Checking local cache...";
		} else if (p.phase === "verifying") {
			phase = "verifying-source";
			message = "Verifying source hash and UTF-8 validity...";
		} else if (p.phase === "downloading") {
			phase = "downloading";
			percent = p.totalBytes > 0 ? Math.min(100, Math.round(p.bytesProcessed / p.totalBytes * 100)) : void 0;
			message = `Downloading ECDICT corpus (${(p.bytesProcessed / 1048576).toFixed(1)} MB)...`;
		}
		this.#updateProgress(ctx, {
			phase,
			subphase: p.phase,
			processed: p.bytesProcessed,
			total: p.totalBytes,
			percent,
			unit: "bytes",
			message
		});
	}
	/**
	* Handle progress events from ECDICT importer.
	*/
	#handleImportProgress(ctx, p) {
		let phase = "building";
		let unit = "entries";
		let percent;
		let message = "Constructing SQLite database...";
		if (p.phase === "verifying-source" || p.phase === "preflighting") {
			phase = "verifying-source";
			unit = "bytes";
			message = "Preflighting source CSV schema...";
		} else if (p.phase === "importing-entries") {
			phase = "building";
			unit = "entries";
			percent = p.total && p.total > 0 && p.processed !== void 0 ? Math.min(100, Math.round(p.processed / p.total * 100)) : void 0;
			message = `Importing dictionary entries (${(p.processed ?? 0).toLocaleString()} / ${(p.total ?? 0).toLocaleString()})...`;
		} else if (p.phase === "resolving-forms" || p.phase === "inserting-forms" || p.phase === "indexing") {
			phase = "building";
			unit = "entries";
			message = `Indexing morphological forms (${p.phase})...`;
		} else if (p.phase === "validating" || p.phase === "publishing") {
			phase = "validating-database";
			unit = "steps";
			message = p.phase === "validating" ? "Running static Worker PRAGMA integrity_check..." : "Publishing verified SQLite database...";
		}
		this.#updateProgress(ctx, {
			phase,
			subphase: p.phase,
			processed: p.processed,
			total: p.total,
			percent,
			unit,
			message
		});
	}
	/**
	* Transition the operation to a new phase.
	*/
	#transitionPhase(ctx, phase, message) {
		ctx.snapshot = {
			...ctx.snapshot,
			phase,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			progress: {
				phase,
				unit: "steps",
				message
			}
		};
		this.#notifyListeners(true);
	}
	/**
	* Update operation progress with throttling.
	*/
	#updateProgress(ctx, progress, force = false) {
		ctx.snapshot = {
			...ctx.snapshot,
			phase: progress.phase,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			progress
		};
		this.#notifyListeners(force);
	}
	/**
	* Finalize operation status upon completion, cancellation, or failure.
	*/
	#settleOperation(ctx, phase, status, progress, error) {
		const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
		ctx.snapshot = {
			...ctx.snapshot,
			phase,
			status,
			updatedAt: finishedAt,
			finishedAt,
			progress,
			error
		};
	}
	/**
	* Format and classify an unknown error into a structured error record.
	*/
	#formatError(err) {
		const code = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : err instanceof Error ? err.name : "INSTALL_FAILED";
		const sanitized = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
		return {
			code,
			message: sanitized,
			retryable: !sanitized.includes("CORRUPT") && !sanitized.includes("SCHEMA")
		};
	}
	/**
	* Check if an error represents an AbortError.
	*/
	#isAbortError(err) {
		if (!err || typeof err !== "object") return false;
		const name = err.name;
		const code = err.code;
		return name === "AbortError" || code === "ABORT_ERR" || code === "ERR_ABORTED";
	}
	/**
	* Create standard AbortError.
	*/
	#createAbortError() {
		const error = /* @__PURE__ */ new Error("The operation was aborted");
		error.name = "AbortError";
		return error;
	}
	/**
	* Notify registered listeners of snapshot updates, throttled to <= 10 Hz.
	*/
	#notifyListeners(force = false) {
		const now = Date.now();
		if (!force && now - this.#lastEmitTime < PROGRESS_THROTTLE_MS) return;
		this.#lastEmitTime = now;
		const currentSnapshot = this.#currentOp ? this.#currentOp.snapshot : this.#lastOp;
		if (!currentSnapshot) return;
		const immutableSnapshot = Object.freeze({ ...currentSnapshot });
		for (const listener of this.#listeners) try {
			listener(immutableSnapshot);
		} catch (err) {
			this.#logger?.warn?.("Observer error in dictionary operation listener: %s", String(err));
		}
	}
};
//#endregion
//#region src/shared/dictionary-management-protocol.ts
/** Maximum accepted request body size in bytes for management endpoints (64 KiB). */
const MAX_MANAGEMENT_REQUEST_BYTES = 65536;
//#endregion
//#region src/host/dictionary-management-route.ts
/** Standard headers for all management API responses. */
const MANAGEMENT_RESPONSE_HEADERS = Object.freeze({
	"cache-control": "no-store",
	"content-type": "application/json; charset=utf-8"
});
/**
* Build a successful JSON response with standard headers.
*/
function jsonResponse(body, status = 200) {
	return Response.json(body, {
		status,
		headers: MANAGEMENT_RESPONSE_HEADERS
	});
}
/**
* Build a structured machine-readable error response.
*/
function errorResponse(status, error, rawMessage, details) {
	const body = {
		ok: false,
		error,
		message: sanitizeErrorMessage(rawMessage),
		...details ? { details } : {}
	};
	return Response.json(body, {
		status,
		headers: MANAGEMENT_RESPONSE_HEADERS
	});
}
/**
* Safely parse a buffered JSON request body with size and schema limits.
*/
async function parseJsonBody(req, maxBytes = MAX_MANAGEMENT_REQUEST_BYTES) {
	const contentLengthHeader = req.headers.get("content-length");
	if (contentLengthHeader !== null) {
		const contentLength = Number.parseInt(contentLengthHeader, 10);
		if (!Number.isNaN(contentLength) && contentLength > maxBytes) return {
			ok: false,
			status: 413,
			error: "BODY_TOO_LARGE",
			message: `Request body exceeds maximum limit of ${maxBytes} bytes`
		};
	}
	const contentType = req.headers.get("content-type");
	if (contentType && !contentType.toLowerCase().includes("application/json")) return {
		ok: false,
		status: 415,
		error: "UNSUPPORTED_MEDIA_TYPE",
		message: "Content-Type must be application/json"
	};
	let text;
	try {
		text = await req.text();
	} catch (err) {
		return {
			ok: false,
			status: 400,
			error: "BAD_REQUEST",
			message: `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`
		};
	}
	if (new TextEncoder().encode(text).length > maxBytes) return {
		ok: false,
		status: 413,
		error: "BODY_TOO_LARGE",
		message: `Request body exceeds maximum limit of ${maxBytes} bytes`
	};
	const trimmed = text.trim();
	if (trimmed.length === 0) return {
		ok: true,
		data: {}
	};
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch (cause) {
		return {
			ok: false,
			status: 400,
			error: "BAD_REQUEST",
			message: `Malformed JSON in request body: ${cause instanceof Error ? cause.message : String(cause)}`
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {
		ok: false,
		status: 400,
		error: "BAD_REQUEST",
		message: "Request body must be a JSON object"
	};
	return {
		ok: true,
		data: parsed
	};
}
/**
* Create handler for GET /api/dsh-word-lookup/dictionary/status.
*/
function createStatusHandler(operationManager, activationCoordinator) {
	return async (req) => {
		if (req.method !== "GET") return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed (expected GET)");
		try {
			const summary = activationCoordinator.getStatusSummary();
			const currentOp = operationManager.getCurrentOperation();
			const lastOp = operationManager.getLastOperation();
			const canInstall = operationManager.canInstall();
			const canCancel = operationManager.canCancel();
			const canRemove = !canCancel && !summary.quarantined && summary.installed;
			return jsonResponse({
				ok: true,
				activeMode: summary.activeMode,
				configuredMode: summary.configuredMode,
				activeSource: summary.activeSource,
				activeIdentity: summary.activeIdentity,
				installed: summary.installed,
				installedCorpus: summary.installedCorpus,
				currentOperation: currentOp,
				lastOperation: lastOp,
				canInstall,
				canCancel,
				canRemove,
				quarantined: summary.quarantined,
				quarantineReason: summary.quarantineReason,
				recoveryError: summary.recoveryError,
				settingsSyncState: summary.settingsSyncState,
				settingsSyncError: summary.settingsSyncError,
				lastRollbackError: summary.lastRollbackError,
				lastRetirementError: summary.lastRetirementError,
				generation: summary.generation
			}, 200);
		} catch (err) {
			return errorResponse(500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
		}
	};
}
/**
* Forbidden override keys rejected on install endpoint.
*/
const FORBIDDEN_INSTALL_KEYS = Object.freeze([
	"downloadUrl",
	"sourceCommit",
	"sourceSha256",
	"sourceByteSize",
	"fetch",
	"candidatePath",
	"workerUrl",
	"batchSize"
]);
/**
* Create handler for POST /api/dsh-word-lookup/dictionary/install.
*/
function createInstallHandler(operationManager) {
	return async (req) => {
		if (req.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed (expected POST)");
		const parseResult = await parseJsonBody(req);
		if (!parseResult.ok) return errorResponse(parseResult.status, parseResult.error, parseResult.message);
		const passedForbidden = FORBIDDEN_INSTALL_KEYS.filter((key) => key in parseResult.data);
		if (passedForbidden.length > 0) return errorResponse(400, "BAD_REQUEST", `Custom installation parameters are strictly forbidden: ${passedForbidden.join(", ")}`);
		try {
			const outcome = operationManager.install();
			return jsonResponse({
				ok: true,
				operationId: outcome.operationId,
				status: outcome.status,
				phase: outcome.phase,
				message: outcome.message
			}, 200);
		} catch (err) {
			if (err instanceof OperationInProgressError) return errorResponse(409, "OPERATION_IN_PROGRESS", err.message, { operationId: err.operationId });
			if (err instanceof OperationDirectoryQuarantinedError) return errorResponse(409, "DIRECTORY_QUARANTINED", err.message, {
				directory: err.directory,
				reason: err.reason
			});
			return errorResponse(500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
		}
	};
}
/**
* Create handler for POST /api/dsh-word-lookup/dictionary/cancel.
*/
function createCancelHandler(operationManager) {
	return async (req) => {
		if (req.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed (expected POST)");
		const parseResult = await parseJsonBody(req);
		if (!parseResult.ok) return errorResponse(parseResult.status, parseResult.error, parseResult.message);
		const rawOpId = parseResult.data.operationId;
		if (typeof rawOpId !== "string" || rawOpId.trim().length === 0) return errorResponse(400, "INVALID_OPERATION_ID", "Request body must contain non-empty \"operationId\"");
		const operationId = rawOpId.trim();
		try {
			const outcome = operationManager.cancel(operationId);
			return jsonResponse({
				ok: true,
				operationId: outcome.operationId,
				status: outcome.status,
				message: outcome.message
			}, 200);
		} catch (err) {
			if (err instanceof OperationNotFoundError) return errorResponse(404, "OPERATION_NOT_FOUND", err.message);
			if (err instanceof OperationNotCancellableError) return errorResponse(409, "OPERATION_NOT_CANCELLABLE", err.message, { operationId: err.operationId });
			return errorResponse(500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
		}
	};
}
/**
* Create handler for POST /api/dsh-word-lookup/dictionary/remove.
*/
function createRemoveHandler(operationManager, activationCoordinator) {
	return async (req) => {
		if (req.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed (expected POST)");
		if (activationCoordinator.getStatusSummary().quarantined) return errorResponse(409, "DIRECTORY_QUARANTINED", "Cannot remove dictionary while storage directory is quarantined");
		try {
			return jsonResponse({
				ok: true,
				removed: (await operationManager.remove()).removed,
				activeMode: "fixture",
				message: "Managed ECDICT database removed and active dictionary reverted to fixture"
			}, 200);
		} catch (err) {
			if (err instanceof OperationInProgressError) return errorResponse(409, "OPERATION_IN_PROGRESS", "Cannot remove managed dictionary while an operation is in progress", { operationId: err.operationId });
			if (err instanceof OperationDirectoryQuarantinedError) return errorResponse(409, "DIRECTORY_QUARANTINED", err.message);
			return errorResponse(500, "REMOVE_FAILED", err instanceof Error ? err.message : String(err));
		}
	};
}
/**
* Create handler for POST /api/dsh-word-lookup/dictionary/verify.
*/
function createVerifyHandler(activationCoordinator) {
	return async (req) => {
		if (req.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed (expected POST)");
		const parseResult = await parseJsonBody(req);
		if (!parseResult.ok) return errorResponse(parseResult.status, parseResult.error, parseResult.message);
		const rawPath = parseResult.data.path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) return errorResponse(400, "INVALID_PATH", "Request body must contain non-empty \"path\"");
		const candidatePath = rawPath.trim();
		if (candidatePath.length > 1024) return errorResponse(400, "INVALID_PATH", "Path length exceeds maximum limit of 1024 characters");
		try {
			const outcome = await activationCoordinator.verifyCustomDatabase(candidatePath);
			if (!outcome.valid) return errorResponse(400, outcome.errorCode ?? "INVALID_SQLITE_FILE", outcome.error ?? "Verification failed");
			return jsonResponse({
				ok: true,
				valid: true,
				schemaVersion: outcome.schemaVersion,
				entryCount: outcome.entryCount,
				formCount: outcome.formCount,
				headwordsSample: outcome.headwordsSample,
				message: "Database passed schema and query capability verification"
			}, 200);
		} catch (err) {
			return errorResponse(500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
		}
	};
}
/**
* Register all five dictionary management Fetch routes onto `ctx.connection.fetch`.
*
* Implements atomic registration: if any route registration throws, all previously
* registered routes in this batch are safely unregistered before the error propagates.
*
* @param ctx - host Cordis context providing `connection` service.
* @param operationManager - active operation manager.
* @param activationCoordinator - active activation coordinator.
* @returns unified async disposer unregistering all five management routes.
*/
function registerDictionaryManagementRoutes(ctx, operationManager, activationCoordinator) {
	const disposers = [];
	try {
		disposers.push(ctx.connection.fetch.register({
			path: MANAGEMENT_STATUS_PATH,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: createStatusHandler(operationManager, activationCoordinator)
		}));
		disposers.push(ctx.connection.fetch.register({
			path: MANAGEMENT_INSTALL_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: createInstallHandler(operationManager)
		}));
		disposers.push(ctx.connection.fetch.register({
			path: MANAGEMENT_CANCEL_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: createCancelHandler(operationManager)
		}));
		disposers.push(ctx.connection.fetch.register({
			path: MANAGEMENT_REMOVE_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: createRemoveHandler(operationManager, activationCoordinator)
		}));
		disposers.push(ctx.connection.fetch.register({
			path: MANAGEMENT_VERIFY_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: createVerifyHandler(activationCoordinator)
		}));
	} catch (registrationError) {
		for (const dispose of disposers.reverse()) try {
			dispose();
		} catch {}
		throw registrationError;
	}
	return async () => {
		const errors = [];
		for (const dispose of disposers.reverse()) try {
			await dispose();
		} catch (err) {
			errors.push(err);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Failed to unregister some dictionary management routes");
	};
}
//#endregion
//#region src/index.ts
/** Package name; equals the Loader entry id and the settings namespace. */
const name = "dsh-word-lookup";
/** Host services required before this entry activates. */
const inject = ["connection"];
/**
* Register the host contributions.
*
* One effect owns the whole host surface, so unloading the loader entry closes
* the database, safely aborts and drains in-flight operations, and unregisters all
* Fetch routes.
*
* @param ctx - the host plugin context.
* @param config - the parsed {@link Config} output for this loader entry.
*/
function apply(ctx, config) {
	ctx.effect(() => {
		let paths = null;
		try {
			paths = resolveManagedStoragePaths({ ctx });
		} catch {}
		const manager = new DictionaryManager({
			mode: "fixture",
			identity: "fixture",
			dictionary: openFixtureDictionary()
		});
		const coordinator = new ActivationCoordinator({
			ctx,
			paths,
			manager,
			config
		});
		const operationManager = new DictionaryOperationManager({
			paths,
			activationCoordinator: coordinator,
			logger: ctx.logger
		});
		if (ctx._testInstances) Object.assign(ctx._testInstances, {
			manager,
			coordinator,
			operationManager
		});
		const recoveryPromise = coordinator.recoverOnStartup().catch(() => {});
		let disposeManagement;
		let disposeLookup;
		try {
			disposeManagement = registerDictionaryManagementRoutes(ctx, operationManager, coordinator);
			disposeLookup = ctx.connection.fetch.register({
				path: LOOKUP_PATH,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: createLookupHandler(config, manager)
			});
		} catch (error) {
			try {
				disposeManagement?.();
			} catch {}
			try {
				disposeLookup?.();
			} catch {}
			operationManager.dispose();
			coordinator.dispose();
			manager.close();
			throw error;
		}
		return async () => {
			try {
				await recoveryPromise;
			} catch {}
			const errors = [];
			try {
				await disposeLookup?.();
			} catch (err) {
				errors.push(err);
			}
			try {
				await disposeManagement?.();
			} catch (err) {
				errors.push(err);
			}
			let drained = false;
			try {
				const drainTimeoutMs = ctx.drainTimeoutMs ?? 5e3;
				await operationManager.dispose(drainTimeoutMs);
				drained = true;
			} catch (err) {
				errors.push(err);
			}
			try {
				coordinator.dispose();
			} catch (err) {
				errors.push(err);
			}
			if (drained && !operationManager.isBusy()) try {
				manager.close();
			} catch (err) {
				errors.push(err);
			}
			else operationManager.whenSettled().finally(() => {
				try {
					manager.close();
				} catch (deferredErr) {
					console.warn("[dsh-word-lookup] Deferred dictionary manager close failed:", deferredErr);
				}
			});
			if (errors.length > 0) throw new AggregateError(errors, "Failed to cleanly unregister dsh-word-lookup routes and manager");
		};
	}, "dsh-word-lookup: local sqlite dictionary, exact fetch route and dictionary management api");
}
//#endregion
export { ActivationCoordinator, ActivationRollbackError, Config, DictionaryManager, DictionaryOperationManager, DictionaryUnavailableError, EcdictDownloadInProgressError, EcdictImportInProgressError, LOOKUP_PATH, MANAGEMENT_CANCEL_PATH, MANAGEMENT_INSTALL_PATH, MANAGEMENT_REMOVE_PATH, MANAGEMENT_STATUS_PATH, MANAGEMENT_VERIFY_PATH, OperationDirectoryQuarantinedError, OperationDrainTimeoutError, OperationInProgressError, OperationNotCancellableError, OperationNotFoundError, apply, buildManagedEcdictDatabase, createCancelHandler, createInstallHandler, createLookupHandler, createRemoveHandler, createStatusHandler, createVerifyHandler, descriptorToActiveMetadataSource, downloadPinnedEcdict, ensureManagedStorageDirectories, inject, loadPinnedEcdictSourceDescriptor, managedDatabaseFileName, managedDatabasePath, name, openFixtureDictionary, openProductionDictionary, readActiveMetadata, registerDictionaryManagementRoutes, removeStaleTemporaryArtifacts, resolveDshHomeFromContext, resolveManagedStoragePaths, resolveProductionDatabasePath, sanitizeErrorMessage, validateActiveMetadata, verifyCachedEcdictSource, writeActiveMetadataAtomically };
