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
export const LOOKUP_PATH = '/api/dsh-word-lookup'
