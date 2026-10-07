import z from "@deepseek-ai/schemastery";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
		}
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
/** Absolute security ceiling for corpus byte size (128 MiB = 134,217,728 bytes). */
const MAX_MANIFEST_BYTE_SIZE = 134217728;
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
	if (sourceByteSize > 134217728) throw new TypeError(`Manifest sourceByteSize ${sourceByteSize} exceeds maximum security ceiling of ${MAX_MANIFEST_BYTE_SIZE} bytes (128 MiB)`);
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
/**
* Load and validate the authoritative ECDICT source descriptor.
*
* Reads `corpus/ecdict.manifest.json` from the package tree (or explicit test path)
* and produces a frozen {@link EcdictSourceDescriptor}.
*
* @param options - optional explicit manifest path or fromUrl.
* @returns validated, frozen descriptor.
*/
function loadPinnedEcdictSourceDescriptor(options) {
	const manifestPath = options?.manifestPath ?? resolvePackagedManifestPath(options?.fromUrl);
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
* Safely invoke a progress callback, catching and ignoring observer exceptions so
* UI or listener errors cannot disrupt the download or corrupt filesystem state.
*/
function notifyProgress(callback, progress) {
	if (!callback) return;
	try {
		callback(progress);
	} catch {}
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
	if (urlObj.username !== "" || urlObj["password"] !== "") throw new Error("URL must not contain embedded user credentials");
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
	if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
	let fileStat;
	try {
		fileStat = await stat(filePath);
	} catch {
		return false;
	}
	if (!fileStat.isFile() || fileStat.size !== expected.byteSize) return false;
	notifyProgress(options?.onProgress, {
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
			if (options?.signal?.aborted) throw createAbortError(options.signal.reason);
			const bufferChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			bytesProcessed += bufferChunk.byteLength;
			if (bytesProcessed > expected.byteSize) return false;
			hash.update(bufferChunk);
			decoder.decode(bufferChunk, { stream: true });
			const now = Date.now();
			if (now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL_MS) {
				lastProgressTime = now;
				notifyProgress(options?.onProgress, {
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
		if (isAbortError(error)) throw error;
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
		if (signal?.aborted) throw createAbortError(signal.reason);
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
* Download and verify the authoritative pinned ECDICT corpus into managed cache storage.
*
* Sequence:
* 1. Concurrency check: fails immediately if destination is already active in this process.
* 2. Directory check: ensures `<home>/cache/dsh-word-lookup/sources` exists.
* 3. Pre-flight cache verification: if `ecdict.csv` already exists and matches exact size,
*    SHA-256, and fatal UTF-8, returns immediately with `reused: true` (zero network calls).
* 4. Partial file preparation: opens unique `ecdict.csv.<uuid>.part` with exclusive `'wx'` flag.
* 5. Secure network fetch: fetches canonical URL with manual redirects (<= 3) and HTTPS validation.
* 6. Streaming verification: reads chunks, writes to `.part` disk handle with partial-write loops,
*    updates SHA-256, validates fatal UTF-8, and strictly enforces byte ceiling.
* 7. Verification completion: syncs and closes `.part` file handle.
* 8. Atomic publication: renames `.part` to `ecdict.csv`.
* 9. Concurrency convergence: if rename fails, verifies whether another concurrent process published
*    valid final cache before throwing.
*
* @param paths - resolved managed storage paths.
* @param options - optional signal, progress observer, descriptor, and test seams.
* @returns frozen {@link EcdictDownloadResult}.
*/
async function downloadPinnedEcdict(paths, options) {
	const signal = options?.signal;
	if (signal?.aborted) throw createAbortError(signal.reason);
	const descriptor = options?.descriptor ?? loadPinnedEcdictSourceDescriptor();
	const finalCachePath = resolve(join(paths.sourceCacheDirectory, "ecdict.csv"));
	if (activeDownloads.has(finalCachePath)) throw new EcdictDownloadInProgressError(finalCachePath);
	activeDownloads.add(finalCachePath);
	try {
		await mkdir(paths.sourceCacheDirectory, { recursive: true });
		if (signal?.aborted) throw createAbortError(signal.reason);
		if (await verifyCachedEcdictSource(finalCachePath, {
			byteSize: descriptor.sourceByteSize,
			sha256: descriptor.sourceSha256
		}, {
			signal,
			onProgress: options?.onProgress
		})) {
			if (signal?.aborted) throw createAbortError(signal.reason);
			notifyProgress(options?.onProgress, {
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
		if (signal?.aborted) throw createAbortError(signal.reason);
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
				const declaredLength = Number.parseInt(clHeader, 10);
				if (Number.isSafeInteger(declaredLength) && declaredLength > descriptor.sourceByteSize) {
					await response.body.cancel().catch(() => {});
					throw new Error(`Content-Length ${declaredLength} exceeds authoritative corpus size ${descriptor.sourceByteSize}`);
				}
			}
			const reader = response.body.getReader();
			const hash = createHash("sha256");
			const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
			let bytesReceived = 0;
			let lastProgressTime = 0;
			notifyProgress(options?.onProgress, {
				phase: "downloading",
				bytesProcessed: 0,
				totalBytes: descriptor.sourceByteSize
			});
			while (true) {
				if (signal?.aborted) {
					await reader.cancel().catch(() => {});
					throw createAbortError(signal.reason);
				}
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				bytesReceived += value.byteLength;
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
					notifyProgress(options?.onProgress, {
						phase: "downloading",
						bytesProcessed: bytesReceived,
						totalBytes: descriptor.sourceByteSize
					});
				}
			}
			if (bytesReceived !== descriptor.sourceByteSize) throw new Error(`Truncated download: expected exactly ${descriptor.sourceByteSize} bytes, received ${bytesReceived}`);
			notifyProgress(options?.onProgress, {
				phase: "verifying",
				bytesProcessed: bytesReceived,
				totalBytes: descriptor.sourceByteSize
			});
			utf8Decoder.decode();
			const digest = hash.digest("hex").toLowerCase();
			if (digest !== descriptor.sourceSha256) throw new Error(`SHA-256 integrity verification failed: expected ${descriptor.sourceSha256}, calculated ${digest}`);
			await fileHandle.sync();
			await fileHandle.close();
			fileHandleClosed = true;
			try {
				await rename(partPath, finalCachePath);
				downloadCompletedSuccessfully = true;
			} catch (renameError) {
				if (await verifyCachedEcdictSource(finalCachePath, {
					byteSize: descriptor.sourceByteSize,
					sha256: descriptor.sourceSha256
				})) {
					notifyProgress(options?.onProgress, {
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
			notifyProgress(options?.onProgress, {
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
* the database and removes the route exactly once. A second registration of the
* same path would throw `connection: exact Fetch route "…" is already
* registered`, which is a load-time signal rather than a silent duplicate.
*
* @param ctx - the host plugin context.
* @param config - the parsed {@link Config} output for this loader entry.
*/
function apply(ctx, config) {
	ctx.effect(() => {
		const manager = new DictionaryManager({
			mode: "fixture",
			identity: "fixture",
			dictionary: openFixtureDictionary()
		});
		let disposeRoute;
		try {
			disposeRoute = ctx.connection.fetch.register({
				path: LOOKUP_PATH,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: createLookupHandler(config, manager)
			});
		} catch (error) {
			manager.close();
			throw error;
		}
		return async () => {
			try {
				await disposeRoute?.();
			} finally {
				manager.close();
			}
		};
	}, "dsh-word-lookup: local sqlite dictionary and exact fetch route");
}
//#endregion
export { Config, DictionaryManager, DictionaryUnavailableError, EcdictDownloadInProgressError, apply, descriptorToActiveMetadataSource, downloadPinnedEcdict, ensureManagedStorageDirectories, inject, loadPinnedEcdictSourceDescriptor, managedDatabaseFileName, managedDatabasePath, name, openProductionDictionary, readActiveMetadata, removeStaleTemporaryArtifacts, resolveDshHomeFromContext, resolveManagedStoragePaths, resolvePackagedManifestPath, resolveProductionDatabasePath, validateActiveMetadata, validateEcdictManifest, verifyCachedEcdictSource, writeActiveMetadataAtomically };
