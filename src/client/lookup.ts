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
 * Phase 5 adds surface generation identity:
 * A card closed before its request settles must remain closed upon settlement (D1, D2).
 * However, a new lookup request initiates a newer surface generation that displays
 * its result normally (D3), even for the exact same query text (D4).
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

import type { SelectionRect } from './selection.js'
import type { CardState, LookupCardStore } from './store.js'
import type { LookupOrigin } from './trigger.js'
import type { LookupResult, LookupTransportFailure } from './transport.js'

/** One request function, matching the transport's signature. */
export type LookupRequest = (query: string, signal?: AbortSignal) => Promise<LookupResult | LookupTransportFailure>

/** What the controller needs from its caller. */
export interface LookupControllerOptions {
  /** The card's observable state; the only thing the controller publishes to. */
  readonly store: LookupCardStore
  /** How to reach the host. Injected so a test can defer or fail it at will. */
  readonly request: LookupRequest
  /** Abort primitive; injectable so a test can observe supersession directly. */
  readonly createAbortController?: () => AbortController
}

/** How many lookups have been issued, by origin. */
export type LookupCounts = Readonly<Record<LookupOrigin, number>>

/** The origins, in a fixed order, so a report can iterate over all of them. */
export const LOOKUP_ORIGINS: readonly LookupOrigin[] = Object.freeze([
  'shortcut',
  'auto-selection',
  'auto-double-click',
])

/**
 * Owns request identity, supersession, surface generation, and the card's published state.
 *
 * One instance per plugin lifecycle. {@link LookupController.dispose} makes every
 * outstanding request stale, so a lookup that outlives an unload cannot republish
 * into a store the next lifecycle now owns.
 */
export class LookupController {
  readonly #store: LookupCardStore
  readonly #request: LookupRequest
  readonly #createAbortController: () => AbortController
  readonly #counts: Record<LookupOrigin, number> = { shortcut: 0, 'auto-selection': 0, 'auto-double-click': 0 }

  /** Monotonic allocator. Never decreases, never reused. */
  #issued = 0
  /** The request allowed to publish; `0` when none is (initially, and after dispose). */
  #owner = 0
  /** The request in flight, kept only so the next one can abort it. */
  #inflight: AbortController | null = null
  #lastOutcome: string | null = null

  /**
   * @param options - the card store, the request function and the abort factory.
   */
  constructor(options: LookupControllerOptions) {
    this.#store = options.store
    this.#request = options.request
    this.#createAbortController = options.createAbortController ?? (() => new AbortController())
  }

  /**
   * Issue one lookup for a query the caller already qualified.
   *
   * The card moves to `loading` for this query synchronously, before the request
   * is awaited, so a caller can observe the new owner immediately. When the
   * request settles it publishes **only if it is still the owner AND its generation
   * has not been dismissed**; otherwise it is dropped, success and failure alike.
   *
   * The returned promise never rejects: a transport that throws is turned into
   * the same `network` failure the transport itself reports, so an automatic
   * gesture can never surface an unhandled rejection.
   *
   * @param query - raw selected text; the host normalizes it.
   * @param origin - which path asked, for client-side accounting.
   * @param anchorRect - selection bounds captured at gesture time, or null.
   * @returns settlement after the card has been updated, or after this request
   * was recognised as stale or dismissed.
   */
  async run(query: string, origin: LookupOrigin, anchorRect: SelectionRect | null = null): Promise<void> {
    this.#issued += 1
    const id = this.#issued
    this.#owner = id
    const gen = this.#store.beginGeneration(anchorRect)
    this.#counts[origin] += 1

    this.#inflight?.abort()
    const controller = this.#createAbortController()
    this.#inflight = controller
    this.#store.set({ status: 'loading', query })

    let outcome: LookupResult | LookupTransportFailure
    try {
      outcome = await this.#request(query, controller.signal)
    } catch (error: unknown) {
      outcome = { kind: 'network', message: error instanceof Error ? error.message : String(error) }
    }

    // Phase 4 latest-wins check: superseded requests are dropped.
    if (this.#owner !== id) return

    // Phase 5 surface dismissal check: closed surface cannot reopen on settlement.
    if (this.#store.isDismissed(gen)) return

    this.#inflight = null
    this.#lastOutcome = outcome.kind
    if (outcome.kind === 'aborted' || outcome.kind === 'network') {
      this.#store.set({ status: 'failed', query, failure: outcome })
      return
    }
    this.#store.set({ status: 'ready', query, result: outcome })
  }

  /**
   * Dismiss the active surface. Aborts any request in flight and clears store.
   */
  dismiss(): void {
    this.#inflight?.abort()
    this.#inflight = null
    this.#store.clear()
  }

  /** @returns the identity of the request that owns the card; `0` when none does. */
  current(): number {
    return this.#owner
  }

  /** @returns how many lookups have been issued in total. */
  issued(): number {
    return this.#issued
  }

  /** @returns the active or last issued surface generation. */
  generation(): number {
    return this.#store.currentGeneration()
  }

  /** @returns how many lookups have been issued, by origin. */
  counts(): LookupCounts {
    return { ...this.#counts }
  }

  /** @returns the discriminant of the outcome the card is showing, or `null`. */
  lastOutcome(): string | null {
    return this.#lastOutcome
  }

  /**
   * Whether the card is waiting on the request that owns it.
   *
   * Read from the card's own snapshot rather than shadowed here: there is exactly
   * one loading state in this plugin, and it belongs to the owner that published
   * it.
   *
   * @returns whether the owning request is still pending.
   */
  loading(): boolean {
    return this.#store.getSnapshot().status === 'loading'
  }

  /** @returns the card state, for diagnostics and tests. */
  card(): CardState {
    return this.#store.getSnapshot()
  }

  /**
   * Abandon the request in flight and refuse every later publication.
   *
   * Called from the runtime's disposer. After it, a resolving request finds
   * itself superseded and publishes nothing.
   */
  dispose(): void {
    this.#owner = 0
    this.#inflight?.abort()
    this.#inflight = null
  }
}
