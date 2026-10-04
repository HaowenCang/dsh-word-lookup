import z from "@deepseek-ai/schemastery";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
* Both switches are `default(false)`: with neither automatic trigger enabled the
* manual `Primary+Shift+L` path is the only way a lookup can happen, which is the
* v0.1.0 default interaction.
*
* The two fields are independent top-level booleans on purpose. Nesting a
* volatile field under another volatile field is a hard parse error in the
* settings form projection, and a single switch covering both gestures could not
* express the truth table in `docs/06-test-matrix.md`.
*
* @module dsh-word-lookup/host/config
*/
/** The plugin's configuration schema, exported under the name DSH looks for. */
const Config = z.object({
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
* Read one live volatile field.
*
* The settings service rewrites the same reference in place when a browser write
* is accepted, so a read at request time observes the newest value without any
* subscription on the host side.
*
* @param config - the parsed plugin configuration, or `undefined` before the
* first parse.
* @param field - the field to read.
* @returns the current value, or `false` when the configuration is absent.
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
* Implements Phase 6.1 production corpus loading with strict guarantees:
* - Deterministic path resolution via explicit `options.path` or `DSH_WORD_LOOKUP_DB_PATH`.
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
const CORPUS_DIRECTORY = join("build", "corpus");
/** Default file name of the production corpus database. */
const CORPUS_FILE_NAME = "ecdict.db";
/** Environment variable name allowing path override in isolated test environments. */
const CORPUS_PATH_ENV = "DSH_WORD_LOOKUP_DB_PATH";
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
* 2. Process environment variable `DSH_WORD_LOOKUP_DB_PATH`
* 3. Default `<package root>/build/corpus/ecdict.db`
*
* @param options - path resolution options.
* @returns absolute resolved path.
*/
function resolveProductionDatabasePath(options = {}) {
	if (options.path) return options.path;
	const envPath = process.env[CORPUS_PATH_ENV];
	if (envPath && envPath.trim().length > 0) return envPath.trim();
	const root = findPackageRoot(options.fromUrl ?? import.meta.url);
	return join(root, CORPUS_DIRECTORY, CORPUS_FILE_NAME);
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
	const indexStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?");
	for (const index of ["idx_forms_headword", "idx_examples_headword"]) if (!indexStmt.get(index)) throw new DictionaryUnavailableError(`production corpus database at "${dbPath}" is missing required index "${index}"`);
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
		const explicitProductionPath = process.env[CORPUS_PATH_ENV]?.trim();
		const dictionary = explicitProductionPath && explicitProductionPath.length > 0 ? openProductionDictionary({ path: explicitProductionPath }) : openFixtureDictionary();
		let disposeRoute;
		try {
			disposeRoute = ctx.connection.fetch.register({
				path: LOOKUP_PATH,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: createLookupHandler(config, dictionary)
			});
		} catch (error) {
			dictionary.close();
			throw error;
		}
		return async () => {
			try {
				await disposeRoute?.();
			} finally {
				dictionary.close();
			}
		};
	}, "dsh-word-lookup: local sqlite dictionary and exact fetch route");
}
//#endregion
export { Config, apply, inject, name };
