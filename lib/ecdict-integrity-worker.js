import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
String(FIXTURE_ENTRIES.length), String(FIXTURE_FORMS.length), String(FIXTURE_EXAMPLES.length);
//#endregion
//#region src/host/schema-version.ts
/**
* Parse dictionary metadata without truncation or coercing non-string values.
* Supported schema revisions are checked separately by each caller.
*/
function parseDictionarySchemaVersion(value) {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("schema_version must be a non-empty string");
	const version = Number(value);
	if (!Number.isSafeInteger(version) || version <= 0) throw new RangeError("schema_version must be a positive safe integer");
	return version;
}
//#endregion
//#region src/host/custom-dictionary-worker.ts
/**
* Isolated Worker implementation for custom SQLite snapshot creation and validation.
*
* Implements Phase 7A.8.1A Tasks A, B, C, D:
* - Executes SQLite snapshot creation via `VACUUM INTO` on `{ readOnly: true }` source connection.
* - Enforces SQLite security parameters: `PRAGMA trusted_schema = OFF`, `enableDefensive(true)`, `PRAGMA busy_timeout = 5000`.
* - Validates schema contract: required tables (`meta`, `entries`, `forms`, `examples`), required columns, schema version.
* - Validates query performance and index coverage via `EXPLAIN QUERY PLAN` (requires B-Tree SEARCH, forbids SCAN).
* - Executes read-only query compatibility probes across headwords, forms, and examples.
* - Employs fail-closed cleanup: unlinks partially created staging files on error.
* - Guarantees SQLite connection closure before messaging and termination to ensure Windows handle release.
*
* @module dsh-word-lookup/host/custom-dictionary-worker
*/
/** Compute full SHA-256 digest of a file in 64 KB chunks to minimize RSS. */
function computeFileSha256(filePath) {
	const hash = createHash("sha256");
	const fd = openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(65536);
		let bytesRead = 0;
		while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}
/** Sanitize worker error messages to prevent leaking local paths or credentials. */
function sanitizeWorkerError(raw) {
	if (!raw || typeof raw !== "string") return "Unknown worker error";
	return raw.replace(/[a-zA-Z]:\\[^\s"',;>)]+/g, "[local-path]").replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, "[local-path]").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
}
/**
* Determine if a query plan step requires scanning rather than indexed search on the target table.
*/
function requiresTableScan(planText, table) {
	const scanPattern = new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?${table}\\b`, "i");
	const searchPattern = new RegExp(`\\bSEARCH\\s+(?:TABLE\\s+)?${table}\\b`, "i");
	return scanPattern.test(planText) || !searchPattern.test(planText);
}
/**
* Execute snapshot creation from sourcePath to stagingPath using VACUUM INTO.
*/
function executeCustomSnapshotCreate(request) {
	const startNs = process.hrtime.bigint();
	const { requestId, sourcePath, stagingPath } = request;
	const maxSizeBytes = request.maxSizeBytes ?? 2147483648;
	if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) return {
		action: "CUSTOM_SNAPSHOT_CREATE",
		requestId,
		success: false,
		errorCode: "INVALID_PATH",
		message: "Source database path must be a non-empty string",
		durationMs: 0
	};
	if (typeof stagingPath !== "string" || stagingPath.trim().length === 0) return {
		action: "CUSTOM_SNAPSHOT_CREATE",
		requestId,
		success: false,
		errorCode: "INVALID_PATH",
		message: "Staging snapshot path must be a non-empty string",
		durationMs: 0
	};
	try {
		if (!existsSync(sourcePath)) return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode: "FILE_NOT_FOUND",
			message: "Source database file does not exist",
			durationMs: 0
		};
		const st = statSync(sourcePath);
		if (!st.isFile()) return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode: "NOT_A_FILE",
			message: "Source database path is not a regular file",
			durationMs: 0
		};
		if (st.size > maxSizeBytes) return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode: "FILE_TOO_LARGE",
			message: `Source database file size (${st.size} bytes) exceeds maximum limit (${maxSizeBytes} bytes)`,
			durationMs: 0
		};
	} catch (err) {
		return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode: "INVALID_PATH",
			message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
			durationMs: 0
		};
	}
	let db = null;
	try {
		db = new DatabaseSync(sourcePath, { readOnly: true });
		db.exec("PRAGMA trusted_schema = OFF;");
		try {
			db.enableDefensive?.(true);
		} catch {}
		try {
			db.exec("PRAGMA busy_timeout = 5000;");
		} catch {}
		if (existsSync(stagingPath)) try {
			unlinkSync(stagingPath);
		} catch {}
		const escapedStagingPath = stagingPath.replace(/\\/g, "/").replace(/'/g, "''");
		db.exec(`VACUUM INTO '${escapedStagingPath}'`);
		db.close();
		db = null;
		if (!existsSync(stagingPath)) return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode: "SNAPSHOT_FAILED",
			message: "VACUUM INTO completed without writing destination file"
		};
		const snapStat = statSync(stagingPath);
		const sha256 = computeFileSha256(stagingPath);
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: true,
			sha256,
			byteSize: snapStat.size,
			durationMs
		};
	} catch (err) {
		try {
			if (existsSync(stagingPath)) unlinkSync(stagingPath);
		} catch {}
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		const rawMsg = err instanceof Error ? err.message : String(err);
		let errorCode = "SNAPSHOT_FAILED";
		if (/file is not a database|unsupported file format|bad header|malformed/i.test(rawMsg)) errorCode = "INVALID_SQLITE_FILE";
		else if (/attempt to write a readonly database/i.test(rawMsg)) errorCode = "SQLITE_READONLY_ERROR";
		else if (/output file already exists/i.test(rawMsg)) errorCode = "FILE_EXISTS";
		return {
			action: "CUSTOM_SNAPSHOT_CREATE",
			requestId,
			success: false,
			errorCode,
			message: sanitizeWorkerError(rawMsg),
			durationMs
		};
	} finally {
		if (db !== null) try {
			db.close();
		} catch {}
	}
}
/**
* Execute comprehensive schema, integrity, query plan, and compatibility validation on a snapshot database.
*/
function executeCustomSnapshotValidate(request) {
	const startNs = process.hrtime.bigint();
	const { requestId, snapshotPath } = request;
	const maxSizeBytes = request.maxSizeBytes ?? 2147483648;
	if (typeof snapshotPath !== "string" || snapshotPath.trim().length === 0) return {
		action: "CUSTOM_SNAPSHOT_VALIDATE",
		requestId,
		success: false,
		errorCode: "INVALID_PATH",
		message: "Snapshot database path must be a non-empty string",
		durationMs: 0
	};
	try {
		if (!existsSync(snapshotPath)) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "FILE_NOT_FOUND",
			message: "Snapshot file does not exist",
			durationMs: 0
		};
		const st = statSync(snapshotPath);
		if (!st.isFile()) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "NOT_A_FILE",
			message: "Snapshot path is not a regular file",
			durationMs: 0
		};
		if (st.size > maxSizeBytes) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "FILE_TOO_LARGE",
			message: `Snapshot file size (${st.size} bytes) exceeds limit (${maxSizeBytes} bytes)`,
			durationMs: 0
		};
	} catch (err) {
		return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_PATH",
			message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
			durationMs: 0
		};
	}
	let db = null;
	try {
		db = new DatabaseSync(snapshotPath, { readOnly: true });
		db.exec("PRAGMA trusted_schema = OFF;");
		try {
			db.enableDefensive?.(true);
		} catch {}
		try {
			db.exec("PRAGMA busy_timeout = 5000;");
		} catch {}
		const integrityRows = db.prepare("PRAGMA integrity_check(100)").all();
		if (integrityRows.length !== 1 || Object.values(integrityRows[0] ?? {})[0] !== "ok") return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INTEGRITY_CHECK_FAILED",
			message: `PRAGMA integrity_check failed: ${integrityRows.slice(0, 3).map((r) => String(Object.values(r)[0] ?? "")).join("; ") || "empty result"}`
		};
		const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
		for (const table of [
			"meta",
			"entries",
			"forms",
			"examples"
		]) if (!tableStmt.get(table)) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_DATABASE_SCHEMA",
			message: `Database is missing required table: "${table}"`
		};
		const metaCols = db.prepare("PRAGMA table_info('meta')").all().map((c) => c.name);
		if (!metaCols.includes("key") || !metaCols.includes("value")) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_DATABASE_SCHEMA",
			message: "Table \"meta\" is missing required columns \"key\" or \"value\""
		};
		const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
		let schemaVersion;
		try {
			schemaVersion = parseDictionarySchemaVersion(metaRow?.value);
		} catch (error) {
			return {
				action: "CUSTOM_SNAPSHOT_VALIDATE",
				requestId,
				success: false,
				errorCode: "INVALID_SCHEMA_VERSION",
				message: error instanceof Error ? error.message : "Invalid schema_version"
			};
		}
		if (schemaVersion !== 1) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_SCHEMA_VERSION",
			message: `Database schema_version is ${metaRow?.value}, expected 1`
		};
		const requiredEntriesCols = [
			"word",
			"phonetic",
			"definition_en",
			"translation_zh",
			"pos",
			"exchange",
			"frequency"
		];
		const entriesCols = db.prepare("PRAGMA table_info('entries')").all().map((c) => c.name);
		for (const col of requiredEntriesCols) if (!entriesCols.includes(col)) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_DATABASE_SCHEMA",
			message: `Table "entries" is missing required column: "${col}"`
		};
		const requiredFormsCols = [
			"form",
			"headword",
			"kind"
		];
		const formsCols = db.prepare("PRAGMA table_info('forms')").all().map((c) => c.name);
		for (const col of requiredFormsCols) if (!formsCols.includes(col)) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_DATABASE_SCHEMA",
			message: `Table "forms" is missing required column: "${col}"`
		};
		const requiredExamplesCols = [
			"id",
			"headword",
			"english",
			"chinese",
			"source",
			"source_id",
			"score"
		];
		const examplesCols = db.prepare("PRAGMA table_info('examples')").all().map((c) => c.name);
		for (const col of requiredExamplesCols) if (!examplesCols.includes(col)) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_DATABASE_SCHEMA",
			message: `Table "examples" is missing required column: "${col}"`
		};
		const plan1 = db.prepare("EXPLAIN QUERY PLAN SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?").all().map((p) => p.detail).join("; ");
		if (requiresTableScan(plan1, "entries")) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "MISSING_REQUIRED_INDEX",
			message: `Missing required index on entries(word); query plan requires table scan (${plan1})`
		};
		const plan2 = db.prepare("EXPLAIN QUERY PLAN SELECT headword FROM forms WHERE form = ?").all().map((p) => p.detail).join("; ");
		if (requiresTableScan(plan2, "forms")) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "MISSING_REQUIRED_INDEX",
			message: `Missing required index on forms(form); query plan requires table scan (${plan2})`
		};
		const plan3 = db.prepare("EXPLAIN QUERY PLAN SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE").all().map((p) => p.detail).join("; ");
		if (requiresTableScan(plan3, "forms")) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "MISSING_REQUIRED_INDEX",
			message: `Missing required index on forms(headword); query plan requires table scan (${plan3})`
		};
		const plan4 = db.prepare("EXPLAIN QUERY PLAN SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC").all().map((p) => p.detail).join("; ");
		if (requiresTableScan(plan4, "examples")) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "MISSING_REQUIRED_INDEX",
			message: `Missing required index on examples(headword); query plan requires table scan (${plan4})`
		};
		const entryCountRow = db.prepare("SELECT COUNT(*) as c FROM entries").get();
		const formCountRow = db.prepare("SELECT COUNT(*) as c FROM forms").get();
		const exampleCountRow = db.prepare("SELECT COUNT(*) as c FROM examples").get();
		const entryCount = entryCountRow?.c ?? 0;
		const formCount = formCountRow?.c ?? 0;
		const exampleCount = exampleCountRow?.c ?? 0;
		if (db.prepare("SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?").get("__nonexistent_probe_token__") !== void 0) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "QUERY_COMPATIBILITY_FAILED",
			message: "Non-existent word query returned non-empty row"
		};
		if (db.prepare("SELECT headword FROM forms WHERE form = ?").get("__nonexistent_probe_token__") !== void 0) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "QUERY_COMPATIBILITY_FAILED",
			message: "Non-existent form query returned non-empty row"
		};
		let headwordsSample = [];
		if (entryCount > 0) {
			headwordsSample = db.prepare("SELECT word FROM entries LIMIT 5").all().map((r) => typeof r.word === "string" ? r.word : String(r.word));
			for (const word of headwordsSample) {
				if (!db.prepare("SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?").get(word)) return {
					action: "CUSTOM_SNAPSHOT_VALIDATE",
					requestId,
					success: false,
					errorCode: "QUERY_COMPATIBILITY_FAILED",
					message: `Probe failed to query sampled headword "${word}"`
				};
				const forms = db.prepare("SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE").all(word);
				for (const f of forms) if (typeof f.form !== "string") return {
					action: "CUSTOM_SNAPSHOT_VALIDATE",
					requestId,
					success: false,
					errorCode: "QUERY_COMPATIBILITY_FAILED",
					message: `Form row for headword "${word}" contains non-string form`
				};
				const examples = db.prepare("SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC").all(word);
				for (const ex of examples) if (typeof ex.english !== "string") return {
					action: "CUSTOM_SNAPSHOT_VALIDATE",
					requestId,
					success: false,
					errorCode: "QUERY_COMPATIBILITY_FAILED",
					message: `Example row for headword "${word}" contains non-string english field`
				};
			}
		}
		db.close();
		db = null;
		const stat = statSync(snapshotPath);
		const sha256 = computeFileSha256(snapshotPath);
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: true,
			schemaVersion,
			entryCount,
			formCount,
			exampleCount,
			headwordsSample,
			sha256,
			byteSize: stat.size,
			durationMs
		};
	} catch (err) {
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		const rawMsg = err instanceof Error ? err.message : String(err);
		let errorCode = "VALIDATION_FAILED";
		if (/file is not a database|unsupported file format|bad header|malformed/i.test(rawMsg)) errorCode = "INVALID_SQLITE_FILE";
		return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode,
			message: sanitizeWorkerError(rawMsg),
			durationMs
		};
	} finally {
		if (db !== null) try {
			db.close();
		} catch {}
	}
}
/**
* Execute pre-publish hash and size verification in the isolated worker thread.
*/
function executeCustomSnapshotPrePublishCheck(request) {
	const startNs = process.hrtime.bigint();
	const { requestId, stagingPath, expectedSha256, expectedByteSize } = request;
	const maxSizeBytes = request.maxSizeBytes ?? 2147483648;
	if (typeof stagingPath !== "string" || stagingPath.trim().length === 0) return {
		action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
		requestId,
		success: false,
		errorCode: "INVALID_PATH",
		message: "Staging snapshot path must be a non-empty string",
		durationMs: 0
	};
	try {
		if (!existsSync(stagingPath)) return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: false,
			errorCode: "FILE_NOT_FOUND",
			message: "Staging file does not exist for pre-publish check",
			durationMs: 0
		};
		const st = statSync(stagingPath);
		if (!st.isFile()) return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: false,
			errorCode: "NOT_A_FILE",
			message: "Staging path is not a regular file",
			durationMs: 0
		};
		if (st.size > maxSizeBytes) return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: false,
			errorCode: "FILE_TOO_LARGE",
			message: `Staging snapshot file size (${st.size} bytes) exceeds limit (${maxSizeBytes} bytes)`,
			durationMs: 0
		};
		const sha256 = computeFileSha256(stagingPath);
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		if (sha256 !== expectedSha256 || st.size !== expectedByteSize) return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: false,
			errorCode: "SNAPSHOT_TAMPERING_DETECTED",
			message: `Snapshot file was altered between verification and publishing (expected SHA-256 ${expectedSha256}, got ${sha256}; expected size ${expectedByteSize}, got ${st.size})`,
			durationMs
		};
		return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: true,
			sha256,
			byteSize: st.size,
			matches: true,
			durationMs
		};
	} catch (err) {
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		return {
			action: "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK",
			requestId,
			success: false,
			errorCode: "VERIFICATION_FAILED",
			message: sanitizeWorkerError(err instanceof Error ? err.message : String(err)),
			durationMs
		};
	}
}
//#endregion
//#region src/host/ecdict-integrity-worker.ts
/**
* Static Companion Worker for ECDICT candidate SQLite integrity verification.
*
* Implements Architecture Exception 1 (Phase 7A.5R4):
* - Runs in an isolated Worker thread so that C-level SQLite PRAGMA integrity_check
*   does not block the main thread event loop.
* - Opens candidate database strictly with `{ readOnly: true }`.
* - Executes full, unfiltered `PRAGMA integrity_check` (no quick_check, no partial check).
* - Enforces that .all() returns exactly one row with value strictly equal to 'ok'.
* - Closes the SQLite connection in a try/finally block BEFORE posting success message
*   to ensure Windows OS file handles are completely released.
* - Uses zero external npm dependencies and makes zero network or credentials calls.
*
* @module dsh-word-lookup/host/ecdict-integrity-worker
*/
/**
* Validates request object structure at runtime without trusting raw IPC types.
*/
function isValidIntegrityRequest(data) {
	if (typeof data !== "object" || data === null) return false;
	const req = data;
	return typeof req.requestId === "string" && req.requestId.length > 0 && typeof req.candidatePath === "string" && req.candidatePath.length > 0;
}
/**
* Main worker execution routine.
*/
function runIntegrityWorker() {
	if (!parentPort) throw new Error("ecdict-integrity-worker must be executed as a Worker thread with parentPort");
	if (typeof workerData === "object" && workerData !== null && "action" in workerData) {
		const action = workerData.action;
		if (action === "CUSTOM_SNAPSHOT_CREATE") {
			const res = executeCustomSnapshotCreate(workerData);
			parentPort.postMessage(res);
			return;
		}
		if (action === "CUSTOM_SNAPSHOT_VALIDATE") {
			const res = executeCustomSnapshotValidate(workerData);
			parentPort.postMessage(res);
			return;
		}
		if (action === "CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK") {
			const res = executeCustomSnapshotPrePublishCheck(workerData);
			parentPort.postMessage(res);
			return;
		}
		parentPort.postMessage({
			requestId: String(workerData.requestId ?? "unknown"),
			success: false,
			errorCode: "INVALID_REQUEST_PAYLOAD",
			message: "Worker received unsupported action"
		});
		return;
	}
	if (!isValidIntegrityRequest(workerData)) {
		const failResp = {
			requestId: typeof workerData === "object" && workerData !== null ? String(workerData.requestId ?? "unknown") : "unknown",
			success: false,
			errorCode: "INVALID_REQUEST_PAYLOAD",
			message: "Worker received invalid or missing integrity request payload"
		};
		parentPort.postMessage(failResp);
		return;
	}
	const { requestId, candidatePath } = workerData;
	const startNs = process.hrtime.bigint();
	let db = null;
	try {
		db = new DatabaseSync(candidatePath, { readOnly: true });
		try {
			db.exec("PRAGMA mmap_size = 268435456");
			db.exec("PRAGMA cache_size = -64000");
		} catch {}
		const rows = db.prepare("PRAGMA integrity_check").all();
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		db.close();
		db = null;
		if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
			const failResp = {
				requestId,
				success: false,
				errorCode: "INTEGRITY_CHECK_FAILED",
				message: `Candidate SQLite PRAGMA integrity_check failed: ${rows.slice(0, 3).map((r) => String(Object.values(r)[0] ?? "unknown integrity diagnostic")).join("; ") || "empty result"}`,
				durationMs
			};
			parentPort.postMessage(failResp);
			return;
		}
		const okResp = {
			requestId,
			success: true,
			integrityResult: "ok",
			durationMs
		};
		parentPort.postMessage(okResp);
	} catch (err) {
		const endNs = process.hrtime.bigint();
		const durationMs = Math.round(Number(endNs - startNs) / 1e6);
		const failResp = {
			requestId,
			success: false,
			errorCode: "WORKER_EXECUTION_ERROR",
			message: (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, " ").slice(0, 500),
			durationMs
		};
		parentPort.postMessage(failResp);
	} finally {
		if (db !== null) try {
			db.close();
		} catch {}
	}
}
runIntegrityWorker();
//#endregion
export {};
