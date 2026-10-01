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
 * @module dsh-word-lookup/client/store
 */
import type { LookupResult, LookupTransportFailure } from './transport.js';
/** What the overlay occupant is currently showing. */
export type CardState = {
    readonly status: 'idle';
} | {
    readonly status: 'loading';
    readonly query: string;
} | {
    readonly status: 'ready';
    readonly query: string;
    readonly result: LookupResult;
} | {
    readonly status: 'failed';
    readonly query: string;
    readonly failure: LookupTransportFailure;
};
/**
 * Replaceable snapshot holder for the overlay occupant.
 *
 * Nothing here touches the DOM, React, or the network, so the ordering rules the
 * card depends on can be tested directly.
 */
export declare class LookupCardStore {
    #private;
    /**
     * @returns the current snapshot. The reference is stable until {@link set}.
     */
    readonly getSnapshot: () => CardState;
    /**
     * Observe snapshot replacements.
     *
     * @param listener - invoked after each change.
     * @returns the disposer removing this listener.
     */
    readonly subscribe: (listener: () => void) => (() => void);
    /**
     * Publish a new snapshot.
     *
     * @param next - the state to publish.
     */
    set(next: CardState): void;
    /** Return the card to its idle, zero-render state. */
    clear(): void;
}
