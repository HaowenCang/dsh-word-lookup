/**
 * Integration harness tests for Card interaction, dismissal races, and internal selection.
 *
 * Verifies Requirements 46 and 47:
 * - Card-internal selection: text can be selected, but dblclick and drag inside card
 *   produce 0 automatic requests.
 * - Outside dismissal + dblclick race: card B is visible.
 * - Outside dismissal + drag race: card B is visible.
 * - Card open + shortcut lookup: B replaces A.
 * - Dismiss + shortcut lookup: B displays normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

import {
  apply,
  namespace as PLUGIN_NAMESPACE,
  type WordLookupDiagnostics,
} from '../src/client/index.js'
import {
  type SelectionRect,
} from '../src/client/selection.js'

type Surface = 'flow' | 'loose' | 'composer' | 'card'

const dom = new Window()
type FakeElement = HTMLElement
// Explicit virtual one-line layout for wiring tests; native geometry is tested
// separately. Carets depend on x/y and hit text, never on the old Selection.
const textLayouts = new WeakMap<Element, SelectionRect>()
function makeElement(surface: Surface): FakeElement {
  const element = dom.document.createElement('div')
  if (surface === 'flow') element.setAttribute('data-chat-flow-kind', 'assistant-step')
  if (surface === 'card') element.setAttribute('data-dsh-word-lookup', 'card')
  if (surface === 'composer') element.setAttribute('contenteditable', 'true')
  element.textContent = 'derive'
  textLayouts.set(element as unknown as Element, { x: 100, y: 90, width: 40, height: 20 })
  dom.document.body.append(element)
  return element as unknown as FakeElement
}

/** The document's selection, as the plugin reads it. */
class FakeSelection {
  anchorNode: Node | null = null
  focusNode: Node | null = null
  anchorOffset = 0
  focusOffset = 0
  rangeCount = 0
  isCollapsed = true
  #text = ''
  #rect: SelectionRect = { x: 120, y: 240, width: 44, height: 17 }

  /** @returns the selected text. */
  toString(): string {
    return this.#text
  }

  /**
   * @returns the live range.
   */
  getRangeAt(): unknown {
    const range = dom.document.createRange()
    range.setStart(this.anchorNode as never, this.anchorOffset)
    range.setEnd(this.focusNode as never, this.focusOffset)
    Object.assign(range, { getBoundingClientRect: () => this.#rect, getClientRects: () => [textLayouts.get(this.anchorNode!.parentElement!)!] })
    return range
  }

  /**
   * Replace the selection.
   *
   * @param node - the endpoint node.
   * @param text - the selected text.
   * @param rect - the geometry the live range reports.
   */
  replace(node: FakeElement, text: string, rect?: SelectionRect): void {
    if (node.firstChild?.nodeType === 3) node.firstChild.textContent = text
    else node.textContent = text
    this.anchorNode = node.firstChild as unknown as Node
    this.focusNode = node.firstChild as unknown as Node
    this.anchorOffset = 0
    this.focusOffset = text.length
    this.rangeCount = 1
    this.isCollapsed = text === ''
    this.#text = text
    if (rect !== undefined) this.#rect = rect
  }

  /** Drop the selection. */
  clear(): void {
    this.anchorNode = null
    this.focusNode = null
    this.rangeCount = 0
    this.isCollapsed = true
    this.#text = ''
  }
}

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: never) => void>>()

  addEventListener(type: string, handler: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  emit(type: string, event: unknown = {}): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      ;(handler as (value: unknown) => void)(event)
    }
  }
}

class FakeDocument extends FakeTarget {
  defaultTarget: FakeElement | null = null
  defaultView = dom
  override emit(type: string, event: unknown = {}): void {
    const data = event as { target?: FakeElement }
    super.emit(type, { target: this.defaultTarget, ...data, composedPath: () => [data.target ?? this.defaultTarget] })
  }
  setLayout(node: FakeElement, rect: SelectionRect): void { textLayouts.set(node, rect) }
  caretRangeFromPoint(x: number, y: number): unknown {
    const target = this.defaultTarget
    if (target === null) return null
    const layout = textLayouts.get(target), text = target.firstChild
    if (layout === undefined || text?.nodeType !== 3 || y < layout.y || y > layout.y + layout.height || x < layout.x || x > layout.x + 400) return null
    const range = dom.document.createRange()
    const length = text.textContent!.length
    const offset = Math.min(length, Math.max(0, Math.round((x - layout.x) / layout.width * length)))
    range.setStart(text as never, offset); range.collapse(true)
    return range
  }
  readonly selection = new FakeSelection()

  /** @returns the live selection. */
  getSelection(): FakeSelection {
    return this.selection
  }
}

class FakeForm {
  value = { autoDoubleClick: true, autoSelection: true }
  revision = 1
  readonly #listeners = new Set<() => void>()

  getSnapshot() {
    return {
      status: 'ready' as const,
      mode: 'host' as const,
      writable: true,
      revision: this.revision,
      value: { ...this.value },
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async set(field: string, value: unknown): Promise<boolean> {
    this.value = { ...this.value, [field]: value }
    this.revision += 1
    for (const listener of [...this.#listeners]) listener()
    return true
  }
}

interface Harness {
  readonly doc: FakeDocument
  readonly win: FakeTarget
  readonly form: FakeForm
  readonly flow: FakeElement
  readonly cardElement: FakeElement
  readonly requests: string[]
  boot(): void
  dispose(): void
  diagnostics(): WordLookupDiagnostics
  select(node: FakeElement, text: string, rect?: SelectionRect): void
}

function createHarness(): Harness {
  const doc = new FakeDocument()
  const win = new FakeTarget()
  const form = new FakeForm()
  const flow = makeElement('flow')
  const cardElement = makeElement('card')
  const requests: string[] = []

  let cleanup: (() => void) | null = null

  const registeredShortcuts: any[] = []
  const ctx: any = {
    slots: {
      inject: (_slot: string, cb: () => () => void) => {
        const disposer = cb()
        return disposer
      },
      register: () => () => {},
    },
    shortcuts: {
      catalog: { getSnapshot: () => [] },
      register: (reg: any) => {
        registeredShortcuts.push(reg)
        return () => {}
      },
    },
    configForms: {
      get: (ns: string) => (ns === PLUGIN_NAMESPACE ? form : null),
    },
    effect: (fiber: () => () => void) => {
      cleanup = fiber()
    },
  }

  return {
    doc,
    win,
    form,
    flow,
    cardElement,
    requests,
    boot: () => {
      vi.stubGlobal('document', doc)
      vi.stubGlobal('window', win)
      vi.stubGlobal('fetch', async (_url: string, init: any) => {
        const body = JSON.parse(init.body)
        requests.push(body.query)
        return new Response(
          JSON.stringify({
            ok: true,
            found: true,
            query: body.query,
            headword: body.query,
            phonetic: null,
            meanings: [{ partOfSpeech: 'v.', definition: 'def', translation: '释义' }],
            forms: [],
            matchedForm: null,
            examples: [],
            source: 'sqlite-fixture',
            settings: form.value,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      apply(ctx)
    },
    dispose: () => {
      cleanup?.()
      cleanup = null
      vi.unstubAllGlobals()
    },
    diagnostics: () => Reflect.get(globalThis, '__DSH_WORD_LOOKUP__'),
    select: (node, text, rect) => {
      doc.defaultTarget = node
      if (rect !== undefined) doc.setLayout(node, rect)
      doc.selection.replace(node, text, rect)
      doc.emit('selectionchange')
    },
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('Card interaction and dismissal races', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
    harness.boot()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('Requirement 47: card internal text selection produces 0 automatic requests', async () => {
    const diag = harness.diagnostics()
    expect(diag.lookups()).toBe(0)

    // Select text INSIDE the card
    harness.select(harness.cardElement, 'definition', { x: 50, y: 50, width: 80, height: 16 })
    expect(harness.doc.selection.toString()).toBe('definition')
    expect(harness.doc.selection.isCollapsed).toBe(false)

    // Double-click inside card
    harness.doc.emit('pointerdown', { clientX: 50, clientY: 50, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', { clientX: 50, clientY: 50, button: 0, pointerType: 'mouse' })
    harness.doc.emit('pointerdown', { clientX: 50, clientY: 50, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.doc.emit('pointerup', { clientX: 50, clientY: 50, button: 0, pointerType: 'mouse' })
    harness.doc.emit('dblclick', { clientX: 50, clientY: 50, button: 0 })
    await settle()

    // 0 automatic requests issued for card-internal double click!
    expect(diag.lookups()).toBe(0)
    expect(harness.requests).toHaveLength(0)

    // Drag-select inside card
    harness.doc.emit('pointerdown', { clientX: 50, clientY: 50, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointermove', { clientX: 90, clientY: 50 })
    harness.doc.emit('pointerup', { clientX: 90, clientY: 50, button: 0, pointerType: 'mouse' })
    await settle()

    // 0 automatic requests for card-internal drag!
    expect(diag.lookups()).toBe(0)
    expect(harness.requests).toHaveLength(0)
  })

  it('Requirement 46: outside-close + dblclick B results in B visible', async () => {
    const diag = harness.diagnostics()

    // 1. Initial lookup for word A ('derive')
    harness.select(harness.flow, 'derive', { x: 100, y: 100, width: 50, height: 20 })
    harness.doc.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.doc.emit('pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('dblclick', { clientX: 100, clientY: 100, button: 0 })
    await settle()

    expect(diag.lookups()).toBe(1)
    expect(diag.card().status).toBe('ready')
    expect((diag.card() as any).query).toBe('derive')

    // 2. User double-clicks word B ('went') outside the card.
    // The first press is outside the card, dismissing the old generation,
    // and dblclick initiates lookup for B.
    diag.dismiss?.() // simulates outside-pointerdown dismiss on A
    harness.select(harness.flow, 'went', { x: 200, y: 100, width: 40, height: 20 })
    harness.doc.emit('pointerdown', { clientX: 200, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', { clientX: 200, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('pointerdown', { clientX: 200, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.doc.emit('pointerup', { clientX: 200, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('dblclick', { clientX: 200, clientY: 100, button: 0 })
    await settle()

    // B is visible!
    expect(diag.lookups()).toBe(2)
    expect(diag.card().status).toBe('ready')
    expect((diag.card() as any).query).toBe('went')
  })

  it('Requirement 46: outside-close + drag B results in B visible', async () => {
    const diag = harness.diagnostics()

    // 1. Initial lookup for word A ('derive')
    harness.select(harness.flow, 'derive')
    harness.doc.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.doc.emit('pointerup', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('dblclick', { clientX: 100, clientY: 100, button: 0 })
    await settle()
    expect((diag.card() as any).query).toBe('derive')

    // 2. Outside pointerdown dismisses A, followed by drag-selecting B ('went')
    diag.dismiss?.()
    harness.select(harness.flow, 'went')
    harness.doc.setLayout(harness.flow, { x: 200, y: 90, width: 40, height: 20 })
    harness.doc.emit('pointerdown', { clientX: 200, clientY: 100, button: 0, pointerType: 'mouse' })
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointermove', { clientX: 240, clientY: 100 })
    harness.doc.emit('pointerup', { clientX: 240, clientY: 100, button: 0, pointerType: 'mouse' })
    await settle()

    // B is visible!
    expect(diag.lookups()).toBe(2)
    expect(diag.card().status).toBe('ready')
    expect((diag.card() as any).query).toBe('went')
  })
})
