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
import { type HostConfig } from './config.js';
import { type Dictionary } from './dictionary.js';
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
export declare function createLookupHandler(config: HostConfig | undefined, dictionary: Dictionary): (request: Request) => Promise<Response>;
