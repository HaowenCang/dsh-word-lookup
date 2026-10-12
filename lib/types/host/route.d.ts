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
export declare const LOOKUP_PATH = "/api/dsh-word-lookup";
/** Absolute path of dictionary management status route. */
export declare const MANAGEMENT_STATUS_PATH = "/api/dsh-word-lookup/dictionary/status";
/** Absolute path of dictionary installation route. */
export declare const MANAGEMENT_INSTALL_PATH = "/api/dsh-word-lookup/dictionary/install";
/** Absolute path of dictionary cancellation route. */
export declare const MANAGEMENT_CANCEL_PATH = "/api/dsh-word-lookup/dictionary/cancel";
/** Absolute path of dictionary removal route. */
export declare const MANAGEMENT_REMOVE_PATH = "/api/dsh-word-lookup/dictionary/remove";
/** Absolute path of dictionary verification route. */
export declare const MANAGEMENT_VERIFY_PATH = "/api/dsh-word-lookup/dictionary/verify";
