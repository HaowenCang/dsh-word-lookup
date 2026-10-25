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
import { Window } from 'happy-dom'

import {
  CONVERSATION_FLOW_SELECTOR,
  INTERACTIVE_SURFACE_SELECTOR,
  isEligibleEndpoint,
  readRangeRect,
  readAutomaticSurface,
  readSelectionEndpoints,
  readPointCaret,
  readEligibleSelection,
  isSelectionRelatedToGesture,
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

// Real DOM/Range relations: no fake closest() predicate or copied production rule.
describe('BUG-005 live DOM association', () => {
  function fixture() {
    const win = new Window()
    win.document.body.innerHTML = '<div data-chat-flow-kind="user"><span id="a"><b>de</b></span><span id="sibling">other</span></div><div data-chat-flow-kind="assistant-step"><span id="b">rive</span></div>'
    const doc = win.document as unknown as Document
    const a = doc.querySelector('#a b')!, b = doc.querySelector('#b')!, sibling = doc.querySelector('#sibling')!
    const range = doc.createRange()
    range.setStart(a.firstChild!, 0); range.setEnd(b.firstChild!, 4)
    Object.assign(range, { getBoundingClientRect: () => ({ x: 10, y: 10, width: 60, height: 20 }), getClientRects: () => [{ x: 10, y: 10, width: 60, height: 20 }] })
    doc.getSelection()!.addRange(range)
    const event = (target: Element, x = 60) => ({ target, clientX: x, clientY: 20, composedPath: () => [target] }) as unknown as MouseEvent
    return { doc, a, b, sibling, event }
  }
  it('allows nested inline endpoints in different flows without requiring endpoint changes', () => {
    const { doc, a, b, event } = fixture()
    const surface = readAutomaticSurface(doc, event(a))!
    const before = readSelectionEndpoints(doc)
    const selection = readEligibleSelection(doc)!
    expect(isSelectionRelatedToGesture(doc, selection, { surface, caret: null, before, x: 10, y: 20 }, event(b))).toBe(true)
  })
  it('rejects the same flow container when the gesture points are away from the live text', () => {
    const { doc, a, b, event } = fixture()
    const surface = readAutomaticSurface(doc, event(a.parentElement!.parentElement!))!
    expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret: null, before: null, x: 400, y: 20 }, event(b))).toBe(false)
  })
  it('rejects a selectable sibling in the same flow unrelated to the selected range', () => {
    const { doc, a, sibling, event } = fixture()
    const selection = doc.getSelection()!, range = selection.getRangeAt(0)
    range.setEnd(a.firstChild!, 2)
    const surface = readAutomaticSurface(doc, event(sibling))!
    expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret: null, before: null, x: 10, y: 20 }, event(sibling))).toBe(false)
  })
  it('uses the composed path to refuse an interactive retargeted ancestor', () => {
    const { doc, a, event } = fixture()
    const button = doc.createElement('button')
    const e = { ...event(a), composedPath: () => [a, button] } as unknown as MouseEvent
    expect(readAutomaticSurface(doc, e)).toBeNull()
  })
  it('excludes plaintext-only contenteditable automatically', () => {
    const { doc, a, event } = fixture()
    a.setAttribute('contenteditable', 'plaintext-only')
    expect(readAutomaticSurface(doc, event(a))).toBeNull()
  })
  it('does not apply automatic link exclusions to the manual selection reader', () => {
    const { doc, a, event } = fixture()
    const link = doc.createElement('a'); a.parentElement!.append(link); link.append(a)
    expect(readAutomaticSurface(doc, event(a))).toBeNull()
    expect(readEligibleSelection(doc)).not.toBeNull()
  })
})

// Round 1: explicit virtual caret map for one line; coordinates resolve to real
// DOM node/offset values. Native Chromium confirmation is separate evidence.
describe('BUG-005 review caret endpoints and selectable islands', () => {
  function fixture() {
    const win = new Window()
    win.document.body.innerHTML = '<div data-chat-flow-kind="assistant-step" id="flow"><p id="word">derive</p><span id="other">outside</span></div>'
    const doc = win.document as unknown as Document
    const word = doc.querySelector('#word')!, other = doc.querySelector('#other')!
    const text = word.firstChild!, otherText = other.firstChild!
    const range = doc.createRange(); range.selectNodeContents(word)
    Object.assign(range, { getBoundingClientRect: () => ({ x: 100, y: 100, width: 60, height: 20 }), getClientRects: () => [{ x: 100, y: 100, width: 60, height: 20 }] })
    doc.getSelection()!.addRange(range)
    Object.assign(doc, { caretRangeFromPoint: (x: number, y: number) => {
      if (x < 100 || x > 300 || y < 100 || y > 160) return null
      const caret = doc.createRange()
      const node = y <= 120 ? text : otherText
      caret.setStart(node, Math.min(node.textContent!.length, Math.max(0, Math.round((x - 100) / 10))))
      caret.collapse(true); return caret
    } })
    const event = (target: Element, x: number, y = 110) => ({ target, clientX: x, clientY: y, composedPath: () => [target, target.parentElement] }) as unknown as MouseEvent
    return { doc, word, other, event }
  }
  for (const direction of ['forward', 'reverse']) {
    it(`accepts a ${direction} drag with a blank-space caret at the word endpoint`, () => {
      const { doc, word, event } = fixture()
      const start = direction === 'forward' ? 101 : 175, end = direction === 'forward' ? 175 : 101
      const surface = readAutomaticSurface(doc, event(word, start))!
      expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret: null, before: null, x: start, y: 110 }, event(word, end))).toBe(true)
    })
  }
  it('refuses an unrelated point resolving to other text even in the same flow', () => {
    const { doc, word, event } = fixture()
    const surface = readAutomaticSurface(doc, event(word, 101))!
    expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret: null, before: null, x: 101, y: 110 }, event(word.parentElement!, 175, 150))).toBe(false)
  })
  it('keeps the browser-resolved down caret when later coordinates hit different text', () => {
    const { doc, word, other, event } = fixture()
    const surface = readAutomaticSurface(doc, event(word, 101))!
    const caret = readPointCaret(doc, 101, 110)!
    const resolver = (doc as Document & { caretRangeFromPoint: (x: number, y: number) => Range | null }).caretRangeFromPoint
    Object.assign(doc, { caretRangeFromPoint: (x: number, y: number) => {
      if (x >= 160) return resolver(x, y)
      const moved = doc.createRange(); moved.setStart(other.firstChild!, 0); return moved
    } })
    expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret, before: null, x: 101, y: 110 }, event(word, 175))).toBe(true)
  })
  it('honors explicit user-select:text inside an otherwise unselectable flow', () => {
    const { doc, word, event } = fixture()
    ;(word.parentElement as HTMLElement).style.userSelect = 'none'
    ;(word as HTMLElement).style.userSelect = 'text'
    expect(readAutomaticSurface(doc, event(word, 101))).not.toBeNull()
  })
  it('still refuses adjacent inherited-none text with an old eligible selection', () => {
    const { doc, word, other, event } = fixture()
    ;(word.parentElement as HTMLElement).style.userSelect = 'none'
    ;(word as HTMLElement).style.userSelect = 'text'
    expect(readEligibleSelection(doc)?.text).toBe('derive')
    expect(readAutomaticSurface(doc, event(other, 175, 150))).toBeNull()
  })
})

// Round 2: a saved caret is a value snapshot and may outlive valid DOM offsets.
describe('BUG-005 review invalidated caret', () => {
  for (const mutation of ['shortened-text', 'shortened-children', 'replaced-node']) {
    it(`safely refuses a ${mutation} saved boundary without clamping`, () => {
      const win = new Window(), doc = win.document as unknown as Document
      doc.body.innerHTML = '<div data-chat-flow-kind="assistant-step"><p>derive</p></div>'
      const word = doc.querySelector('p')!, oldText = word.firstChild!
      let caret = { node: oldText, offset: 6 }
      if (mutation === 'shortened-children') {
        word.append(doc.createElement('i')); caret = { node: word, offset: 2 }; word.lastChild!.remove()
      } else if (mutation === 'shortened-text') oldText.textContent = 'go'
      else word.replaceChildren(doc.createTextNode('go'))
      const range = doc.createRange(); range.selectNodeContents(word)
      Object.assign(range, { getBoundingClientRect: () => ({ x: 100, y: 100, width: 60, height: 20 }), getClientRects: () => [{ x: 100, y: 100, width: 60, height: 20 }] })
      // Match Chromium's documented native IndexSizeError at a stale boundary;
      // happy-dom itself does not enforce every Range boundary exception.
      const original = range.isPointInRange.bind(range)
      Object.assign(range, { isPointInRange(node: Node, offset: number) {
        const length = node.nodeType === 3 ? node.nodeValue!.length : node.childNodes.length
        if (offset > length) throw new DOMException('stale offset', 'IndexSizeError')
        return original(node, offset)
      } })
      doc.getSelection()!.addRange(range)
      Object.assign(doc, { caretRangeFromPoint: (x: number, y: number) => {
        if (y !== 110 || x < 100 || x > 180) return null
        const point = doc.createRange(); point.setStart(word.firstChild!, x <= 110 ? 0 : word.firstChild!.textContent!.length); return point
      } })
      const event = { target: word, clientX: 101, clientY: 110, composedPath: () => [word] } as unknown as MouseEvent
      const surface = readAutomaticSurface(doc, event)!
      expect(isSelectionRelatedToGesture(doc, readEligibleSelection(doc)!, { surface, caret, before: null, x: 160, y: 110 }, event)).toBe(false)
    })
  }
})
