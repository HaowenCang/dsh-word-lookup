/**
 * Viewport-safe card positioning pure function.
 *
 * Computes viewport coordinates (client-space) for the dictionary card relative
 * to an anchor selection rectangle or viewport fallback.
 *
 * Rules:
 * 1. Default to placing below the selection.
 * 2. If below does not fit and above fits, place above.
 * 3. Near-bottom selection chooses above to avoid covering the composer.
 * 4. Horizontal and vertical coordinates clamp strictly to viewport margins.
 * 5. When anchorRect is null, fallback to upper-center of the viewport.
 *
 * @module dsh-word-lookup/client/position
 */
import type { SelectionRect } from './selection.js';
/** Card dimensions in CSS pixels. */
export interface CardSize {
    readonly width: number;
    readonly height: number;
}
/** Viewport dimensions in CSS pixels. */
export interface ViewportSize {
    readonly width: number;
    readonly height: number;
}
/** Configurable positioning margins and gap. */
export interface PositioningOptions {
    /** Distance in CSS pixels from viewport edges. Defaults to 12. */
    readonly margin?: number;
    /** Space in CSS pixels between anchor rectangle and card. Defaults to 8. */
    readonly gap?: number;
}
/** Placement orientation relative to anchor. */
export type CardPlacement = 'below' | 'above' | 'fallback';
/** Final calculated card position in viewport coordinates. */
export interface CardPosition {
    readonly x: number;
    readonly y: number;
    readonly placement: CardPlacement;
}
/** Default minimum margin from viewport edges in CSS pixels. */
export declare const DEFAULT_VIEWPORT_MARGIN = 12;
/** Default gap between selection rectangle and card in CSS pixels. */
export declare const DEFAULT_ANCHOR_GAP = 8;
/**
 * Pure function computing card position.
 *
 * @param anchorRect - Selection bounding rectangle in client coordinates, or null.
 * @param cardSize - Measured or estimated card size.
 * @param viewportSize - Current viewport width and height.
 * @param options - Optional custom margin and gap.
 * @returns Viewport coordinates and placement direction.
 */
export declare function computeCardPosition(anchorRect: SelectionRect | null, cardSize: CardSize, viewportSize: ViewportSize, options?: PositioningOptions): CardPosition;
