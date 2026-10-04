/**
 * Production Result Card UI for `shell.overlay`.
 *
 * Implements Phase 5 Production Result Card:
 * - Mutually exclusive 5-state model: idle, loading, found, not-found, error.
 * - Viewport-safe positioning relative to selection anchor with fallback.
 * - Dismissal: Escape, outside pointer/click (no shield), and close button.
 * - Dismiss / request race correctness via surface generation.
 * - Accessibility: semantic region, accessible close label, readable contrast.
 * - No focus stealing on card appearance.
 * - Card text selectable and copyable; 0 automatic lookups for internal selection.
 * - Responsive narrow-viewport safety and scrollable long content.
 * - Self-contained light and dark theme support.
 *
 * @module dsh-word-lookup/client/card
 */
import type { ReactElement } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CardState, LookupCardStore } from './store.js';
/** Props the overlay seat supplies plus the store injected at registration. */
export type WordLookupCardProps = Partial<PropsRuntime<'shell.overlay'>> & {
    /** The card's observable state. */
    readonly store: LookupCardStore;
};
/** Formal card UI display states. */
export type CardUiState = 'idle' | 'loading' | 'found' | 'not-found' | 'error';
/**
 * Classify CardState into formal UI display state.
 *
 * @param state - The current store snapshot.
 * @returns One of the five mutually exclusive UI states.
 */
export declare function getCardUiState(state: CardState): CardUiState;
/**
 * Render the Production Dictionary Result Card.
 *
 * @param props - Overlay seat props plus the injected store.
 * @returns The dictionary card element, or null while idle.
 */
export declare function WordLookupCard(props: WordLookupCardProps): ReactElement | null;
