/**
 * The `shell.overlay` occupant.
 *
 * `shell.overlay` is a **list** slot at `root` scope whose layer is
 * click-through: the frame itself ignores pointer events and each entry opts
 * back in. The card therefore sets `pointer-events: auto` on its own root and
 * nowhere else, and it never covers the composer: the panel is anchored to the
 * lower right, clear of the input column.
 *
 * Two properties this component must keep:
 *
 * 1. **Idle renders nothing.** `shell.overlay` is mounted for the whole
 *    application lifetime, so an occupant that rendered a container node while
 *    idle would put a permanent element into every page. Returning `null` keeps
 *    the layer at zero children until a lookup actually produces something.
 * 2. **The style sheet is inline.** An external client plugin is served as one
 *    classic script; there is no second asset a stylesheet could travel in, and
 *    the shipped class names are hashed and must never be relied on.
 *
 * @module dsh-word-lookup/client/card
 */
import type { ReactElement } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { LookupCardStore } from './store.js';
/** Props the overlay seat supplies plus the store injected at registration. */
export type WordLookupCardProps = PropsRuntime<'shell.overlay'> & {
    /** The card's observable state. */
    readonly store: LookupCardStore;
};
/**
 * Render the current lookup state.
 *
 * @param props - overlay seat props plus the injected store.
 * @returns the card, or `null` while idle.
 */
export declare function WordLookupCard(props: WordLookupCardProps): ReactElement | null;
