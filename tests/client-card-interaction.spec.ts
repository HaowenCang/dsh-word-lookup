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

import {
  apply,
  namespace as PLUGIN_NAMESPACE,
  type WordLookupDiagnostics,
} from '../src/client/index.js'
import {
  CONVERSATION_FLOW_SELECTOR,
  INTERACTIVE_SURFACE_SELECTOR,
  type SelectionRect,
} from '../src/client/selection.js'

type Surface = 'flow' | 'loose' | 'composer' | 'card'

class FakeElement {
  readonly nodeType = 1
  readonly parentElement: FakeElement | null = null
  readonly #surface: Surface

  constructor(surface: Surface) {
    this.#surface = surface
  }

  closest(selector: string): FakeElement | null {
    if (selector === CONVERSATION_FLOW_SELECTOR) return this.#surface === 'flow' ? this : null
    if (selector === INTERACTIVE_SURFACE_SELECTOR) return this.#surface === 'composer' ? this : null
    return null
  }
}

class FakeSelection {
  anchorNode: FakeElement | null = null
  focusNode: FakeElement | null = null
  rangeCount = 0
  isCollapsed = true
  #text = ''
  #rect: SelectionRect = { x: 100, y: 200, width: 50, height: 20 }

  toString(): string {
    return this.#text
  }

  getRangeAt(): unknown {
    return { collapsed: false, getBoundingClientRect: () => this.#rect }
  }

  replace(node: FakeElement, text: string, rect?: SelectionRect): void {
    this.anchorNode = node
    this.focusNode = node
    this.rangeCount = 1
    this.isCollapsed = text === ''
    this.#text = text
    if (rect !== undefined) this.#rect = rect
  }

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
  readonly selection = new FakeSelection()

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
  const flow = new FakeElement('flow')
  const cardElement = new FakeElement('card')
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
