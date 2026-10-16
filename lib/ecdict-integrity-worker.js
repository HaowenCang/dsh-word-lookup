import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
		if (!metaRow || typeof metaRow.value !== "string") return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_SCHEMA_VERSION",
			message: "Table \"meta\" is missing valid \"schema_version\" entry"
		};
		const schemaVersion = Number.parseInt(metaRow.value, 10);
		if (Number.isNaN(schemaVersion) || schemaVersion !== 1) return {
			action: "CUSTOM_SNAPSHOT_VALIDATE",
			requestId,
			success: false,
			errorCode: "INVALID_SCHEMA_VERSION",
			message: `Database schema_version is ${metaRow.value}, expected 1`
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
if (parentPort && workerData && typeof workerData === "object" && "action" in workerData) {
	const req = workerData;
	if (req.action === "CUSTOM_SNAPSHOT_CREATE") {
		const res = executeCustomSnapshotCreate(req);
		parentPort.postMessage(res);
	} else if (req.action === "CUSTOM_SNAPSHOT_VALIDATE") {
		const res = executeCustomSnapshotValidate(req);
		parentPort.postMessage(res);
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
