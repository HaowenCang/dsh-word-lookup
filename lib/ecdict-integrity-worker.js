import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
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
