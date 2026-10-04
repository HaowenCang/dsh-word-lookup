import { describe, expect, it } from 'vitest'

import { computeCardPosition, type CardSize, type ViewportSize } from '../src/client/position.js'

describe('computeCardPosition', () => {
  const defaultCard: CardSize = { width: 340, height: 200 }
  const defaultViewport: ViewportSize = { width: 1200, height: 800 }

  it('places card below when space below fits', () => {
    const anchor = { x: 200, y: 150, width: 60, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport)
    expect(result.placement).toBe('below')
    expect(result.x).toBe(200)
    // anchor bottom is 170, default gap is 8 -> y = 178
    expect(result.y).toBe(178)
  })

  it('places card above when below does not fit but above fits', () => {
    // Near bottom: y=680, height=20 -> bottom=700. space below=800-12-700 = 88 < 208
    // space above = 680-12 = 668 >= 208
    const anchor = { x: 300, y: 680, width: 80, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport)
    expect(result.placement).toBe('above')
    expect(result.x).toBe(300)
    // anchor top is 680, gap is 8, card height is 200 -> y = 680 - 8 - 200 = 472
    expect(result.y).toBe(472)
  })

  it('clamps left edge when anchor is too close to left or negative', () => {
    const anchor = { x: 4, y: 150, width: 40, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport, { margin: 16 })
    expect(result.x).toBe(16) // clamped to margin
  })

  it('clamps right edge when anchor would push card beyond viewport', () => {
    // x = 1100, card width = 340. 1100 + 340 = 1440 > 1200 - 12 (1188)
    const anchor = { x: 1100, y: 200, width: 50, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport)
    expect(result.x).toBe(1200 - 12 - 340) // 848
    expect(result.x + defaultCard.width).toBe(1200 - 12)
  })

  it('clamps to top margin when space above is constrained', () => {
    // Anchor near top, e.g. y = 30, height = 20. If above placement forced, clamps to margin
    const anchor = { x: 200, y: 50, width: 50, height: 20 }
    // Force tiny viewport where neither fits cleanly
    const smallViewport: ViewportSize = { width: 800, height: 220 }
    const result = computeCardPosition(anchor, defaultCard, smallViewport, { margin: 10, gap: 5 })
    expect(result.y).toBeGreaterThanOrEqual(10)
  })

  it('clamps to bottom margin when placed near bottom', () => {
    const anchor = { x: 200, y: 750, width: 50, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport, { margin: 12 })
    expect(result.y + defaultCard.height).toBeLessThanOrEqual(defaultViewport.height - 12)
  })

  it('clamps horizontally within narrow viewport', () => {
    const narrowViewport: ViewportSize = { width: 360, height: 600 }
    const anchor = { x: 50, y: 100, width: 60, height: 20 }
    const result = computeCardPosition(anchor, defaultCard, narrowViewport, { margin: 10 })
    // 360 - 10 - 340 = 10
    expect(result.x).toBe(10)
    expect(result.x + defaultCard.width).toBeLessThanOrEqual(360)
  })

  it('handles multiline selection rect correctly', () => {
    // Multi-line selection height = 75
    const anchor = { x: 150, y: 100, width: 220, height: 75 }
    const result = computeCardPosition(anchor, defaultCard, defaultViewport, { gap: 10 })
    expect(result.placement).toBe('below')
    expect(result.y).toBe(100 + 75 + 10) // 185
    expect(result.x).toBe(150)
  })

  it('uses upper-center fallback when anchor rect is null', () => {
    const result = computeCardPosition(null, defaultCard, defaultViewport, { margin: 15 })
    expect(result.placement).toBe('fallback')
    // Centered: (1200 - 340) / 2 = 430
    expect(result.x).toBe(430)
    // Upper-center: margin + 48 = 15 + 48 = 63
    expect(result.y).toBe(63)
  })

  it('clamps within viewport when card is taller than available height', () => {
    const tallCard: CardSize = { width: 300, height: 700 }
    const shortViewport: ViewportSize = { width: 800, height: 500 }
    const anchor = { x: 100, y: 200, width: 60, height: 20 }
    const result = computeCardPosition(anchor, tallCard, shortViewport, { margin: 12 })
    expect(result.y).toBe(12) // Clamped to minimum margin
  })

  it('re-clamps cleanly on viewport resize', () => {
    const anchor = { x: 900, y: 200, width: 50, height: 20 }
    const initialPos = computeCardPosition(anchor, defaultCard, { width: 1400, height: 900 })
    expect(initialPos.x).toBe(900)

    // Viewport shrunk to width 1000
    const resizedPos = computeCardPosition(anchor, defaultCard, { width: 1000, height: 900 }, { margin: 16 })
    // Max x allowed: 1000 - 16 - 340 = 644
    expect(resizedPos.x).toBe(644)
    expect(resizedPos.x + defaultCard.width).toBeLessThanOrEqual(1000 - 16)
  })
})
