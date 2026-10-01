/**
 * Request handling for the exact Fetch route `POST /api/dsh-word-lookup`.
 *
 * The handler is a plain function of `(Request) => Promise<Response>` so that it
 * can be exercised without a DSH process, a connection service, or a browser.
 * It performs no I/O beyond reading the request body: there is no model call, no
 * network call, and no filesystem access on this path, and Phase 1 must be able
 * to prove that by reading the module.
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
/**
 * Create the route handler bound to one loader entry's configuration.
 *
 * @param config - the parsed configuration of this loader entry. Read at request
 * time through {@link readSwitch}, so an accepted settings write is observable on
 * the very next lookup.
 * @returns the Fetch handler the route registers.
 */
export declare function createLookupHandler(config: HostConfig | undefined): (request: Request) => Promise<Response>;
