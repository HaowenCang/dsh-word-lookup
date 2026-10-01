/**
 * Issuing lookups, and deciding which answer the card is allowed to show.
 *
 * Phase 1 had a single trigger, so "the last lookup" and "the only lookup" were
 * the same thing and the runtime could compare an `AbortController` reference to
 * spot a superseded request. Phase 4 adds automatic triggers and a reader can now
 * produce lookups faster than the host answers them. Two rules have to hold from
 * that moment on, and neither is free:
 *
 * ```text
 * latest request wins     A slow answer for A never rolls the card back from B
 * stale results are inert a superseded success and a superseded failure are
 *                         both unobservable — an old error cannot bury a new hit
 * ```
 *
 * Both are decided by a **logical request identity** rather than by abort alone.
 * Aborting is still done — it stops work that no longer matters — but it is not
 * the safety net: an abort cannot promise that every stage of the transport has
 * already stopped, so a request that resolves after being aborted must still be
 * recognised as stale and dropped. That is what {@link LookupController.owner}
 * is for.
 *
 * Loading is request-scoped for free, and deliberately not tracked separately:
 * the card's loading state is only ever published by the request that owns it, so
 * an older request finishing cannot clear a newer request's loading. Deriving
 * {@link LookupController.loading} from the card's own snapshot keeps the two
 * from ever disagreeing.
 *
 * The controller is DOM-free and transport-agnostic: the request function is
 * injected, so the concurrency matrix can be driven by a deferred promise
 * without a server.
 *
 * @module dsh-word-lookup/client/lookup
 */
import type { CardState, LookupCardStore } from './store.js';
import type { LookupOrigin } from './trigger.js';
import type { LookupResult, LookupTransportFailure } from './transport.js';
/** One request function, matching the transport's signature. */
export type LookupRequest = (query: string, signal?: AbortSignal) => Promise<LookupResult | LookupTransportFailure>;
/** What the controller needs from its caller. */
export interface LookupControllerOptions {
    /** The card's observable state; the only thing the controller publishes to. */
    readonly store: LookupCardStore;
    /** How to reach the host. Injected so a test can defer or fail it at will. */
    readonly request: LookupRequest;
    /** Abort primitive; injectable so a test can observe supersession directly. */
    readonly createAbortController?: () => AbortController;
}
/** How many lookups have been issued, by origin. */
export type LookupCounts = Readonly<Record<LookupOrigin, number>>;
/** The origins, in a fixed order, so a report can iterate over all of them. */
export declare const LOOKUP_ORIGINS: readonly LookupOrigin[];
/**
 * Owns request identity, supersession and the card's published state.
 *
 * One instance per plugin lifecycle. {@link LookupController.dispose} makes every
 * outstanding request stale, so a lookup that outlives an unload cannot republish
 * into a store the next lifecycle now owns.
 */
export declare class LookupController {
    #private;
    /**
     * @param options - the card store, the request function and the abort factory.
     */
    constructor(options: LookupControllerOptions);
    /**
     * Issue one lookup for a query the caller already qualified.
     *
     * The card moves to `loading` for this query synchronously, before the request
     * is awaited, so a caller can observe the new owner immediately. When the
     * request settles it publishes **only if it is still the owner**; otherwise it
     * is a superseded result and is dropped whole, success and failure alike.
     *
     * The returned promise never rejects: a transport that throws is turned into
     * the same `network` failure the transport itself reports, so an automatic
     * gesture can never surface an unhandled rejection.
     *
     * @param query - raw selected text; the host normalizes it.
     * @param origin - which path asked, for client-side accounting.
     * @returns settlement after the card has been updated, or after this request
     * was recognised as stale.
     */
    run(query: string, origin: LookupOrigin): Promise<void>;
    /** @returns the identity of the request that owns the card; `0` when none does. */
    current(): number;
    /** @returns how many lookups have been issued in total. */
    issued(): number;
    /** @returns how many lookups have been issued, by origin. */
    counts(): LookupCounts;
    /** @returns the discriminant of the outcome the card is showing, or `null`. */
    lastOutcome(): string | null;
    /**
     * Whether the card is waiting on the request that owns it.
     *
     * Read from the card's own snapshot rather than shadowed here: there is exactly
     * one loading state in this plugin, and it belongs to the owner that published
     * it.
     *
     * @returns whether the owning request is still pending.
     */
    loading(): boolean;
    /** @returns the card state, for diagnostics and tests. */
    card(): CardState;
    /**
     * Abandon the request in flight and refuse every later publication.
     *
     * Called from the runtime's disposer. After it, a resolving request finds
     * itself superseded and publishes nothing.
     */
    dispose(): void;
}
