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

import type { SelectionRect } from './selection.js'

/** Card dimensions in CSS pixels. */
export interface CardSize {
  readonly width: number
  readonly height: number
}

/** Viewport dimensions in CSS pixels. */
export interface ViewportSize {
  readonly width: number
  readonly height: number
}

/** Configurable positioning margins and gap. */
export interface PositioningOptions {
  /** Distance in CSS pixels from viewport edges. Defaults to 12. */
  readonly margin?: number
  /** Space in CSS pixels between anchor rectangle and card. Defaults to 8. */
  readonly gap?: number
}

/** Placement orientation relative to anchor. */
export type CardPlacement = 'below' | 'above' | 'fallback'

/** Final calculated card position in viewport coordinates. */
export interface CardPosition {
  readonly x: number
  readonly y: number
  readonly placement: CardPlacement
}

/** Default minimum margin from viewport edges in CSS pixels. */
export const DEFAULT_VIEWPORT_MARGIN = 12

/** Default gap between selection rectangle and card in CSS pixels. */
export const DEFAULT_ANCHOR_GAP = 8

/**
 * Pure function computing card position.
 *
 * @param anchorRect - Selection bounding rectangle in client coordinates, or null.
 * @param cardSize - Measured or estimated card size.
 * @param viewportSize - Current viewport width and height.
 * @param options - Optional custom margin and gap.
 * @returns Viewport coordinates and placement direction.
 */
export function computeCardPosition(
  anchorRect: SelectionRect | null,
  cardSize: CardSize,
  viewportSize: ViewportSize,
  options?: PositioningOptions,
): CardPosition {
  const margin = options?.margin ?? DEFAULT_VIEWPORT_MARGIN
  const gap = options?.gap ?? DEFAULT_ANCHOR_GAP

  const minX = margin
  const maxX = Math.max(margin, viewportSize.width - margin - cardSize.width)
  const minY = margin
  const maxY = Math.max(margin, viewportSize.height - margin - cardSize.height)

  if (anchorRect === null) {
    const fallbackX = (viewportSize.width - cardSize.width) / 2
    const clampedFallbackX = Math.max(minX, Math.min(maxX, fallbackX))
    // Upper-center placement clears composer at bottom while staying clearly visible.
    const fallbackY = margin + 48
    const clampedFallbackY = Math.max(minY, Math.min(maxY, fallbackY))
    return {
      x: Math.round(clampedFallbackX),
      y: Math.round(clampedFallbackY),
      placement: 'fallback',
    }
  }

  // Horizontal position: align with anchor start, clamp to viewport margins.
  const clampedX = Math.max(minX, Math.min(maxX, anchorRect.x))

  // Vertical calculation:
  const anchorBottom = anchorRect.y + anchorRect.height
  const spaceBelow = viewportSize.height - margin - anchorBottom
  const spaceAbove = anchorRect.y - margin
  const neededHeight = cardSize.height + gap

  const belowFits = spaceBelow >= neededHeight
  const aboveFits = spaceAbove >= neededHeight

  let y: number
  let placement: CardPlacement

  if (belowFits) {
    placement = 'below'
    y = anchorBottom + gap
  } else if (aboveFits) {
    placement = 'above'
    y = anchorRect.y - gap - cardSize.height
  } else {
    // Neither fits without clipping: choose whichever has more available room
    if (spaceAbove >= spaceBelow) {
      placement = 'above'
      y = anchorRect.y - gap - cardSize.height
    } else {
      placement = 'below'
      y = anchorBottom + gap
    }
  }

  const clampedY = Math.max(minY, Math.min(maxY, y))

  return {
    x: Math.round(clampedX),
    y: Math.round(clampedY),
    placement,
  }
}
