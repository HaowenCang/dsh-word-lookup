/**
 * The card's observable state.
 *
 * A hand-written store rather than a React context: the overlay occupant is
 * mounted by the shell, not by this plugin, so the state has to be reachable
 * from a component the plugin does not render itself. It is consumed through
 * `useSyncExternalStore`, which requires a stable `getSnapshot` identity and a
 * snapshot reference that only changes when the value changes — both are
 * properties of this class rather than conventions the caller has to respect.
 *
 * Phase 5 adds surface generation, dismissal identity, and anchor geometry:
 * When the user dismisses a card, its surface generation is marked dismissed so
 * that an in-flight request belonging to that generation cannot reopen the card
 * upon settlement, while a subsequent lookup initiates a newer generation that is
 * displayed normally.
 *
 * @module dsh-word-lookup/client/store
 */

import type { SelectionRect } from './selection.js'
import type { LookupResult, LookupTransportFailure } from './transport.js'

/** What the overlay occupant is currently showing. */
export type CardState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly query: string }
  | { readonly status: 'ready'; readonly query: string; readonly result: LookupResult }
  | { readonly status: 'failed'; readonly query: string; readonly failure: LookupTransportFailure }

/**
 * Replaceable snapshot holder for the overlay occupant.
 *
 * Nothing here touches the DOM, React, or the network, so the ordering rules the
 * card depends on can be tested directly.
 */
export class LookupCardStore {
  #state: CardState = { status: 'idle' }
  #anchorRect: SelectionRect | null = null
  #currentGeneration = 0
  #dismissedGeneration = 0
  readonly #listeners = new Set<() => void>()

  /**
   * @returns the current snapshot. The reference is stable until {@link set} or {@link clear}.
   */
  readonly getSnapshot = (): CardState => this.#state

  /**
   * Observe snapshot replacements.
   *
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Publish a new snapshot.
   *
   * @param next - the state to publish.
   */
  set(next: CardState): void {
    this.#state = next
    for (const listener of [...this.#listeners]) listener()
  }

  /**
   * Return the card to its idle, zero-render state and mark the active
   * surface generation as dismissed.
   */
  clear(): void {
    this.#dismissedGeneration = Math.max(this.#dismissedGeneration, this.#currentGeneration)
    this.#state = { status: 'idle' }
    for (const listener of [...this.#listeners]) listener()
  }

  /**
   * Explicitly dismiss the current surface.
   */
  dismiss(): void {
    this.clear()
  }

  /**
   * Advance the active surface generation for a new lookup.
   *
   * @param anchorRect - Selection rectangle captured at trigger time.
   * @returns the newly allocated surface generation number.
   */
  beginGeneration(anchorRect: SelectionRect | null = null): number {
    this.#currentGeneration += 1
    this.#anchorRect = anchorRect
    return this.#currentGeneration
  }

  /**
   * Whether a given generation has been dismissed.
   *
   * @param generation - the request surface generation.
   * @returns true if this generation was dismissed.
   */
  isDismissed(generation?: number): boolean {
    if (typeof generation !== 'number') return false
    return generation <= this.#dismissedGeneration
  }

  /** @returns the latest captured anchor rectangle, or null. */
  anchorRect(): SelectionRect | null {
    return this.#anchorRect
  }

  /** @returns the highest seen surface generation. */
  currentGeneration(): number {
    return this.#currentGeneration
  }

  /** @returns the highest dismissed surface generation. */
  dismissedGeneration(): number {
    return this.#dismissedGeneration
  }
}
