/**
 * The selection qualification rule.
 *
 * The rule is asserted as a truth table over {@link SelectionEndpointFacts}
 * rather than through a DOM, because the decision — "inside a conversation flow
 * item **and** outside every interactive text surface" — is what the plugin
 * actually depends on. The DOM walk that produces those facts is covered by the
 * real-browser verification, where the shipped conversation markup exists.
 */

import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_FLOW_SELECTOR,
  INTERACTIVE_SURFACE_SELECTOR,
  isEligibleEndpoint,
  readRangeRect,
  type RangeLike,
  type SelectionEndpointFacts,
} from '../src/client/selection.js'

/** The two facts, in the four combinations that exist. */
const CASES: readonly (SelectionEndpointFacts & { readonly expected: boolean; readonly label: string })[] = [
  {
    label: 'in the transcript, outside any text surface',
    insideConversationFlow: true,
    insideInteractiveSurface: false,
    expected: true,
  },
  {
    label: 'in the transcript but inside a text surface (the composer case)',
    insideConversationFlow: true,
    insideInteractiveSurface: true,
    expected: false,
  },
  {
    label: 'outside the transcript (sidebar, dialog, toolbar)',
    insideConversationFlow: false,
    insideInteractiveSurface: false,
    expected: false,
  },
  {
    label: 'outside the transcript and inside a text surface',
    insideConversationFlow: false,
    insideInteractiveSurface: true,
    expected: false,
  },
]

describe('isEligibleEndpoint', () => {
  for (const testCase of CASES) {
    it(`${testCase.expected ? 'accepts' : 'rejects'} an endpoint ${testCase.label}`, () => {
      expect(
        isEligibleEndpoint({
          insideConversationFlow: testCase.insideConversationFlow,
          insideInteractiveSurface: testCase.insideInteractiveSurface,
        }),
      ).toBe(testCase.expected)
    })
  }
})

describe('selectors', () => {
  it('anchors the conversation test on the attribute Phase 0 measured as reliable', () => {
    expect(CONVERSATION_FLOW_SELECTOR).toBe('[data-chat-flow-kind]')
  })

  it('does not depend on the unreliable message-body anchor', () => {
    expect(CONVERSATION_FLOW_SELECTOR).not.toContain('message-body')
  })

  it('excludes every interactive text surface the composer and form controls use', () => {
    for (const part of [
      'input',
      'textarea',
      'select',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ]) {
      expect(INTERACTIVE_SURFACE_SELECTOR).toContain(part)
    }
  })

  it('uses no hashed class name', () => {
    // The shipped class names are content-hashed and change between builds.
    expect(INTERACTIVE_SURFACE_SELECTOR).not.toMatch(/\._[a-z0-9]+_/)
    expect(CONVERSATION_FLOW_SELECTOR).not.toMatch(/\._[a-z0-9]+_/)
  })
})

/**
 * Build a range-like value for the geometry tests.
 *
 * @param collapsed - whether the range reports itself collapsed.
 * @param rect - the rectangle the range reports.
 * @returns the range-like value.
 */
function rangeLike(collapsed: boolean, rect: { x: number; y: number; width: number; height: number }): RangeLike {
  return { collapsed, getBoundingClientRect: () => rect }
}

describe('readRangeRect', () => {
  it('returns the live rectangle for a one-line selection', () => {
    const rect = readRangeRect(rangeLike(false, { x: 604.6, y: 104, width: 41.5, height: 17 }))
    expect(rect).toEqual({ x: 604.6, y: 104, width: 41.5, height: 17 })
  })

  it('returns the bounding box of a multi-line selection', () => {
    // Phase 0 §7.4 measured a four-rect, 1239 px-wide paragraph selection;
    // getBoundingClientRect has already folded those into one box.
    const rect = readRangeRect(rangeLike(false, { x: 280, y: 76, width: 1239, height: 68 }))
    expect(rect).toEqual({ x: 280, y: 76, width: 1239, height: 68 })
  })

  it('returns null for a collapsed range rather than a zero-area rect', () => {
    expect(readRangeRect(rangeLike(true, { x: 10, y: 20, width: 0, height: 17 }))).toBeNull()
  })

  it('returns null when the range has no area at all', () => {
    expect(readRangeRect(rangeLike(false, { x: 0, y: 0, width: 0, height: 0 }))).toBeNull()
  })

  it('re-reads the range rather than remembering a previous rectangle', () => {
    // Phase 0 §7.4: scrolling the transcript by 200 px moved rect.y by exactly
    // 200 for the same selection. A cached rect plus a delta would be wrong
    // after a streaming re-render, so the value must come from the range.
    let y = 279
    const scrolling: RangeLike = {
      collapsed: false,
      getBoundingClientRect: () => ({ x: 600, y, width: 41, height: 17 }),
    }
    expect(readRangeRect(scrolling)?.y).toBe(279)
    y = 479
    expect(readRangeRect(scrolling)?.y).toBe(479)
  })

  it('preserves a zero-width but non-empty rect, which is a real caret box', () => {
    expect(readRangeRect(rangeLike(false, { x: 5, y: 5, width: 0, height: 17 }))).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 17,
    })
  })
})
