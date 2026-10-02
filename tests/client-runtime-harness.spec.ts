/**
 * The browser runtime, driven end to end without a browser.
 *
 * `tests/client-trigger.spec.ts` covers the gate as a value relation and
 * `tests/client-lookup.spec.ts` covers request ordering behind an injected
 * transport. Neither one proves the two are *wired to the right listeners*: a
 * runtime that consulted the gate from `selectionchange`, or that forgot to
 * remove its listeners on unload, would pass both.
 *
 * This suite supplies the missing half. It applies the real `apply()` against a
 * minimal fake `document`/`window` and a fake DSH context, then replays the
 * measured event orders from Phase 0 §7.3 and observes the real request count, the
 * real trigger decisions and the real card state. The `fetch` global is stubbed,
 * so a lookup is observable on the wire without a host.
 *
 * What is real here: the listeners, their capture-phase registration and
 * disposal, the classifier, the selection qualification rule, the settings
 * mirror and its subscription, the trigger gate, the request controller and the
 * card store. What is fake: the DOM, the host, and the settings transport.
 *
 * The browser-level half of the same matrix — real Chromium, a real DSH process
 * and a real SQLite answer — is `scripts/phase1-verify.mjs`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apply,
  LOOKUP_COMMAND_ID,
  namespace as PLUGIN_NAMESPACE,
  type LookupGates,
  type WordLookupDiagnostics,
} from '../src/client/index.js'
import {
  CONVERSATION_FLOW_SELECTOR,
  INTERACTIVE_SURFACE_SELECTOR,
  type SelectionRect,
} from '../src/client/selection.js'

// --- fake DOM ---------------------------------------------------------------

/** Which ancestor facts an element reports. */
type Surface = 'flow' | 'loose' | 'composer'

/** The smallest element that can answer the two `closest()` questions. */
class FakeElement {
  readonly nodeType = 1
  readonly parentElement: FakeElement | null = null
  readonly #surface: Surface

  /**
   * @param surface - what this element is inside of.
   */
  constructor(surface: Surface) {
    this.#surface = surface
  }

  /**
   * @param selector - one of the two selectors the plugin uses.
   * @returns this element when it matches, `null` otherwise.
   */
  closest(selector: string): FakeElement | null {
    if (selector === CONVERSATION_FLOW_SELECTOR) return this.#surface === 'flow' ? this : null
    if (selector === INTERACTIVE_SURFACE_SELECTOR) return this.#surface === 'composer' ? this : null
    return null
  }
}

/** A `Range` stand-in; only the geometry read is used. */
function fakeRange(rect: SelectionRect): { collapsed: boolean; getBoundingClientRect: () => SelectionRect } {
  return { collapsed: false, getBoundingClientRect: () => rect }
}

/** The document's selection, as the plugin reads it. */
class FakeSelection {
  anchorNode: FakeElement | null = null
  focusNode: FakeElement | null = null
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
    return fakeRange(this.#rect)
  }

  /**
   * Replace the selection.
   *
   * @param node - the endpoint node.
   * @param text - the selected text.
   * @param rect - the geometry the live range reports.
   */
  replace(node: FakeElement, text: string, rect?: SelectionRect): void {
    this.anchorNode = node
    this.focusNode = node
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

/** An event target that records what it was subscribed to. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(event: never) => void>>()

  /**
   * @param type - the event type.
   * @param handler - the listener.
   */
  addEventListener(type: string, handler: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  /**
   * @param type - the event type.
   * @param handler - the listener.
   */
  removeEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  /**
   * Deliver one event to every subscriber.
   *
   * @param type - the event type.
   * @param event - the event object.
   */
  emit(type: string, event: unknown = {}): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) (handler as (value: unknown) => void)(event)
  }

  /**
   * @param type - the event type.
   * @returns how many listeners are registered for it.
   */
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

/** The product document. */
class FakeDocument extends FakeTarget {
  readonly selection = new FakeSelection()

  /** @returns the live selection. */
  getSelection(): FakeSelection {
    return this.selection
  }
}

// --- fake host context ------------------------------------------------------

/** The settings section the form carries. */
interface HostSettings {
  autoDoubleClick?: boolean
  autoSelection?: boolean
}

/** The `configForms` face, with a write path the test can drive. */
class FakeForm {
  value: HostSettings = { autoDoubleClick: false, autoSelection: false }
  revision = 1
  readonly #listeners = new Set<() => void>()
  /** Every write the runtime asked for, in order. */
  readonly writes: { field: string; value: unknown }[] = []

  /** @returns the form snapshot the runtime reads. */
  getSnapshot() {
    return {
      status: 'ready' as const,
      mode: 'host' as const,
      writable: true,
      revision: this.revision,
      value: { ...this.value },
    }
  }

  /**
   * @param listener - invoked after each accepted write.
   * @returns the disposer removing it.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Accept one switch write, exactly as the settings UI path does.
   *
   * @param field - the field to write.
   * @param value - the value to write.
   * @returns whether the write was accepted.
   */
  async set(field: string, value: unknown): Promise<boolean> {
    this.writes.push({ field, value })
    this.value = { ...this.value, [field]: value }
    this.revision += 1
    for (const listener of [...this.#listeners]) listener()
    return true
  }
}

/** One registered shortcut command, as the runtime declared it. */
interface RegisteredCommand {
  readonly id: string
  resolve(context: { region: string; modal: string | null; target: EventTarget | null }):
    | { status: 'pass' }
    | { status: 'handled'; run: () => void }
}

/** Everything one booted runtime exposes to a test. */
interface Harness {
  readonly doc: FakeDocument
  readonly win: FakeTarget
  readonly form: FakeForm
  readonly flow: FakeElement
  readonly loose: FakeElement
  readonly composer: FakeElement
  readonly requests: string[]
  /** Boot the plugin into this harness. */
  boot(): void
  /** Unwind the plugin. */
  dispose(): void
  /** The plugin's published diagnostics, or `null` when not applied. */
  diagnostics(): WordLookupDiagnostics | null
  /** Replace the selection and let the runtime observe it, as a browser does. */
  select(node: FakeElement, text: string, rect?: SelectionRect): void
  /** The registered command, or `null`. */
  command(): RegisteredCommand | null
}

/** Let every pending microtask and the queued continuation run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Options for a harness.
 *
 * `transport` replaces the default immediate-answer stub; a test that needs to
 * control *when* an answer arrives supplies its own, so there is never a second
 * `fetch` stub racing the first.
 */
interface HarnessOptions {
  /** How to answer a query; defaults to a deterministic hit. */
  readonly answer?: (query: string) => unknown
  /** A complete `fetch` replacement, for deferred and failing transports. */
  readonly transport?: (url: string, init?: RequestInit) => Promise<Response>
}

/**
 * Create a harness with a stubbed `fetch`.
 *
 * @param options - the answer shape and/or a custom transport.
 * @returns the harness.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const doc = new FakeDocument()
  const win = new FakeTarget()
  const form = new FakeForm()
  const flow = new FakeElement('flow')
  const loose = new FakeElement('loose')
  const composer = new FakeElement('composer')
  const requests: string[] = []
  const effects: (() => void)[] = []
  let command: RegisteredCommand | null = null
  let applied = false

  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal(
    'fetch',
    options.transport ??
      (async (_url: string, init?: RequestInit) => {
        const query = String(JSON.parse(String(init?.body)).query)
        requests.push(query)
        const body =
          options.answer?.(query) ??
          ({
            ok: true,
            found: true,
            query,
            headword: query,
            phonetic: null,
            meanings: [],
            forms: [],
            matchedForm: null,
            examples: [],
            source: 'sqlite-fixture',
            settings: { autoDoubleClick: false, autoSelection: false },
          } as const)
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }),
  )

  const ctx = {
    effect(effect: () => (() => void) | void) {
      const disposer = effect()
      if (typeof disposer === 'function') effects.push(disposer)
    },
    slots: {
      inject(_name: string, callback: () => (() => void) | void) {
        const disposer = callback()
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      register() {
        return () => {}
      },
    },
    shortcuts: {
      register(spec: RegisteredCommand) {
        command = spec
        return () => {
          command = null
        }
      },
      catalog: { getSnapshot: () => [] },
    },
    configForms: { get: () => form },
  }

  return {
    doc,
    win,
    form,
    flow,
    loose,
    composer,
    requests,
    boot() {
      apply(ctx as never)
      applied = true
    },
    dispose() {
      for (const disposer of effects.splice(0).reverse()) disposer()
      applied = false
    },
    diagnostics() {
      if (!applied) return null
      return (Reflect.get(globalThis, '__DSH_WORD_LOOKUP__') as WordLookupDiagnostics | undefined) ?? null
    },
    select(node, text, rect) {
      doc.selection.replace(node, text, rect)
      doc.emit('selectionchange')
    },
    command() {
      return command
    },
  }
}

/** The diagnostics of a booted harness. */
function view(harness: Harness): WordLookupDiagnostics {
  const diagnostics = harness.diagnostics()
  if (diagnostics === null) throw new Error('the runtime is not applied')
  return diagnostics
}

// --- gesture drivers --------------------------------------------------------

/** One pointer event, as a real mouse reports it. */
function pointer(x: number, y: number, pointerType = 'mouse') {
  return { clientX: x, clientY: y, button: 0, pointerType }
}

/**
 * Replay the measured pointer-drag order from Phase 0 §7.3.
 *
 * The selection is updated while the pointer is down, which is what a real drag
 * does; the runtime reads it at `pointerup`. The compatibility `mousedown`
 * between `pointerdown` and the travel is part of that measured order, and since
 * Phase 4.1 it also carries the platform's click multiplicity — a press whose
 * multiplicity was never observed is refused by the gate, so a driver that
 * omitted it would be replaying a sequence no real mouse produces.
 *
 * @param harness - the harness.
 * @param options - the word to select, where, with which pointer, how far it
 * travels, whether to wait for the request accounting, and which click
 * multiplicity to replay (`mouseDown: false` omits the event entirely).
 * @returns nothing.
 */
async function drag(
  harness: Harness,
  options: {
    text: string
    node?: FakeElement
    pointerType?: string
    distance?: number
    quiet?: boolean
    multiClick?: boolean
    mouseDown?: boolean
  } = {
    text: 'derive',
  },
): Promise<void> {
  const node = options.node ?? harness.flow
  const pointerType = options.pointerType ?? 'mouse'
  const distance = options.distance ?? 40
  harness.doc.selection.clear()
  harness.doc.emit('pointerdown', pointer(100, 100, pointerType))
  if (options.mouseDown !== false) harness.doc.emit('mousedown', { detail: options.multiClick === true ? 2 : 1, button: 0 })
  harness.select(node, options.text)
  harness.doc.emit('pointermove', pointer(100 + distance, 100, pointerType))
  harness.doc.emit('pointerup', pointer(100 + distance, 100, pointerType))
  if (options.quiet !== true) await settle()
}

/**
 * Replay the measured double-click order from Phase 0 §7.3.
 *
 * Two presses, two releases, then the platform's `dblclick`, then the trailing
 * `selectionchange` — in that order, which is the order Phase 0 recorded. Each
 * press carries the click multiplicity the platform really reports: `1` for the
 * first, `2` for the second, which is what makes the pair recognisable as one
 * gesture rather than two clicks.
 *
 * @param harness - the harness.
 * @param options - the word to select, where, with which pointer, whether to
 * wait for the request accounting, and how far the second press travels.
 * @returns nothing.
 */
async function doubleClick(
  harness: Harness,
  options: { text: string; node?: FakeElement; pointerType?: string; quiet?: boolean; drift?: number } = {
    text: 'derive',
  },
): Promise<void> {
  const node = options.node ?? harness.flow
  const pointerType = options.pointerType ?? 'mouse'
  const drift = options.drift ?? 0
  harness.doc.selection.clear()
  harness.doc.emit('pointerdown', pointer(200, 200, pointerType))
  harness.doc.emit('mousedown', { detail: 1, button: 0 })
  harness.doc.emit('pointerup', pointer(200, 200, pointerType))
  harness.doc.emit('pointerdown', pointer(200, 200, pointerType))
  harness.doc.emit('mousedown', { detail: 2, button: 0 })
  harness.select(node, options.text)
  if (drift > 0) harness.doc.emit('pointermove', pointer(200 + drift, 200, pointerType))
  harness.doc.emit('pointerup', pointer(200 + drift, 200, pointerType))
  harness.doc.emit('dblclick', { clientX: 200, clientY: 200 })
  // The trailing change the browser dispatches after `dblclick`.
  harness.select(node, options.text)
  if (options.quiet !== true) await settle()
}

/**
 * Run the manual command against the current selection.
 *
 * @param harness - the harness.
 * @returns whether the command handled the key.
 */
async function shortcut(harness: Harness): Promise<boolean> {
  const command = harness.command()
  if (command === null) throw new Error('the command is not registered')
  const resolution = command.resolve({ region: 'page', modal: null, target: null })
  if (resolution.status !== 'handled') return false
  resolution.run()
  await settle()
  return true
}

/** Set one switch through the same form the settings UI writes. */
async function setSwitch(harness: Harness, field: keyof HostSettings, value: boolean): Promise<void> {
  await view(harness).set(field, value)
  await settle()
}

/** The four states, named the way the test matrix names them. */
const STATES = {
  S00: { autoSelection: false, autoDoubleClick: false },
  S10: { autoSelection: true, autoDoubleClick: false },
  S01: { autoSelection: false, autoDoubleClick: true },
  S11: { autoSelection: true, autoDoubleClick: true },
} as const

/** Drive a harness into one of the four states. */
async function useState(harness: Harness, gates: LookupGates): Promise<void> {
  await setSwitch(harness, 'autoSelection', gates.autoSelection)
  await setSwitch(harness, 'autoDoubleClick', gates.autoDoubleClick)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, '__DSH_WORD_LOOKUP__')
})

describe('the settings matrix, through the real runtime', () => {
  it('S00: both switches off — a drag and a double click each produce nothing, the shortcut produces one', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S00)

    await drag(harness)
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 0 })
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'switch-off', gestureId: 1 })
    // The listeners ran: zero requests must not be zero observations.
    expect(view(harness).gestures().counters.drags).toBe(1)

    await doubleClick(harness)
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
    expect(view(harness).gestures().counters.doubleClickGestures).toBe(1)

    harness.select(harness.flow, 'derive')
    expect(await shortcut(harness)).toBe(true)
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 1, 'auto-selection': 0, 'auto-double-click': 0 })
    expect(harness.requests).toEqual(['derive'])
  })

  it('S10: autoSelection only — the drag fires, the double click does not', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 1, 'auto-double-click': 0 })
    expect(view(harness).trigger()).toMatchObject({
      decision: 'lookup',
      reason: 'accepted',
      origin: 'auto-selection',
      query: 'derive',
    })
    expect(harness.requests).toEqual(['derive'])

    await doubleClick(harness, { text: 'went' })
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 1, 'auto-double-click': 0 })
    expect(harness.requests).toEqual(['derive'])
  })

  it('S01: autoDoubleClick only — the double click fires, the drag does not', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    await drag(harness, { text: 'derive' })
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 0 })

    await doubleClick(harness, { text: 'went' })
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 1 })
    expect(view(harness).trigger()).toMatchObject({ origin: 'auto-double-click', query: 'went' })
    expect(harness.requests).toEqual(['went'])
  })

  it('S11: both on — one drag is one lookup and one double click is one lookup', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await drag(harness, { text: 'derive' })
    await doubleClick(harness, { text: 'went' })
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 1, 'auto-double-click': 1 })
    expect(harness.requests).toEqual(['derive', 'went'])
  })

  it('S11: the trailing selectionchange of a double click adds nothing', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
    // Deliver the trailing change several more times: a selection event is not a
    // trigger, so there is nothing left for it to produce.
    for (let index = 0; index < 5; index += 1) harness.select(harness.flow, 'derive')
    await settle()
    expect(view(harness).lookups()).toBe(1)
    expect(harness.requests).toEqual(['derive'])
  })

  it('S10: a storm of programmatic selection changes produces nothing', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    for (let index = 0; index < 50; index += 1) harness.select(harness.flow, `word${String(index)}`)
    await settle()
    expect(view(harness).lookups()).toBe(0)
    expect(harness.requests).toEqual([])
    // ...and the same document still looks a real drag up, so the silence is the
    // gate refusing selection events rather than the listener being dead.
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
  })
})

describe('live settings transitions need no reload', () => {
  it('follows autoSelection false → true → false on consecutive drags', async () => {
    const harness = createHarness()
    harness.boot()

    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(0)

    await setSwitch(harness, 'autoSelection', true)
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)

    await setSwitch(harness, 'autoSelection', false)
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
  })

  it('follows autoDoubleClick false → true → false on consecutive double clicks', async () => {
    const harness = createHarness()
    harness.boot()

    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(0)

    await setSwitch(harness, 'autoDoubleClick', true)
    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)

    await setSwitch(harness, 'autoDoubleClick', false)
    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
  })

  it('reads the switch at the gesture, never at boot', async () => {
    const harness = createHarness()
    // Boot with the values the profile composes, then change one *without* any
    // reload: the next gesture must follow the new value, which it can only do if
    // the gate reads the form rather than a boolean captured at plugin load.
    harness.form.value = { autoSelection: false, autoDoubleClick: false }
    harness.boot()
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(0)

    await setSwitch(harness, 'autoSelection', true)
    expect(view(harness).gates()).toEqual({ autoDoubleClick: false, autoSelection: true })
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
    expect(harness.form.writes).toEqual([{ field: 'autoSelection', value: true }])
  })
})

/**
 * The overlap semantic.
 *
 * One sequence, four platforms facts, and the rule the product actually states:
 *
 * ```text
 * pointerdown  mousedown(detail 2)  selection  move > DRAG_THRESHOLD  pointerup  dblclick
 * ```
 *
 * The press travels far enough to be a `drag` **and** the platform's own click
 * counter says it is the second press of a double click, and the platform then
 * delivers its `dblclick`. Phase 4 allowed this to be answered by
 * `autoSelection` (the release was consumed as a drag, and the `dblclick` that
 * followed was refused as `duplicate-gesture`); the product says the
 * `autoDoubleClick` switch owns every gesture the platform calls a double click.
 * These cases replace that assertion.
 */
describe('the overlap: a double click that also travels', () => {
  /** The overlap sequence, with the platform's `dblclick` at the end. */
  async function overlappingDoubleClick(harness: Harness, word = 'derive'): Promise<void> {
    harness.doc.selection.clear()
    harness.doc.emit('pointerdown', pointer(200, 200))
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', pointer(200, 200))
    harness.doc.emit('pointerdown', pointer(200, 200))
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.select(harness.flow, word)
    harness.doc.emit('pointermove', pointer(240, 200))
    harness.doc.emit('pointerup', pointer(240, 200))
    harness.doc.emit('dblclick', { clientX: 240, clientY: 200 })
    await settle()
  }

  it('S10: autoSelection alone answers nothing, even though the press moved far enough to be a drag', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await overlappingDoubleClick(harness)

    expect(view(harness).lookups()).toBe(0)
    expect(harness.requests).toEqual([])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 0 })
    // The sequence really happened: the movement verdict exists, and the
    // platform really reported one double click. A zero request count on its own
    // would also be satisfied by a dead listener.
    expect(view(harness).gestures().counters.drags).toBe(1)
    expect(view(harness).gestures().counters.doubleClickGestures).toBe(1)
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
  })

  it('S01: autoDoubleClick alone answers exactly one lookup, from its own path', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    await overlappingDoubleClick(harness)

    expect(harness.requests).toEqual(['derive'])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 1 })
    expect(view(harness).gestures().counters.doubleClickGestures).toBe(1)
    expect(view(harness).trigger()).toMatchObject({
      decision: 'lookup',
      reason: 'accepted',
      origin: 'auto-double-click',
      query: 'derive',
    })
  })

  it('S11: both switches on answer exactly one lookup, and it is the double-click path that answers it', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await overlappingDoubleClick(harness)

    expect(harness.requests).toEqual(['derive'])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 1 })
    expect(view(harness).gestures().counters.doubleClickGestures).toBe(1)
    expect(view(harness).trigger()).toMatchObject({ origin: 'auto-double-click', gestureId: view(harness).gestures().last.gestureId })
  })

  it('S11: the drag verdict is refused, not consumed, so the gesture identity survives to be answered as a double click', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    // The multi-click press and release, with no platform `dblclick` after it —
    // the sequence that must not become an `auto-selection` lookup.
    harness.doc.selection.clear()
    harness.doc.emit('pointerdown', pointer(200, 200))
    harness.doc.emit('mousedown', { detail: 1, button: 0 })
    harness.doc.emit('pointerup', pointer(200, 200))
    harness.doc.emit('pointerdown', pointer(200, 200))
    harness.doc.emit('mousedown', { detail: 2, button: 0 })
    harness.select(harness.flow, 'derive')
    harness.doc.emit('pointermove', pointer(240, 200))
    harness.doc.emit('pointerup', pointer(240, 200))
    await settle()

    expect(view(harness).gestures().counters.drags).toBe(1)
    expect(view(harness).lookups()).toBe(0)
    expect(harness.requests).toEqual([])
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'multi-click-sequence' })

    // The same identity is still free, so the platform's `dblclick` — which is
    // what a reader who made this gesture was actually asking for — is answered
    // once, on its own path.
    harness.doc.emit('dblclick', { clientX: 240, clientY: 200 })
    await settle()
    expect(harness.requests).toEqual(['derive'])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 1 })

    // ...and the next real drag is unaffected.
    await drag(harness, { text: 'went' })
    expect(harness.requests).toEqual(['derive', 'went'])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 0, 'auto-selection': 1, 'auto-double-click': 1 })
  })

  it('S10: a drag whose click multiplicity was never observed is refused, and the next real drag still fires', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    // A synthetic or automation-delivered drag: the press and the release are
    // real to the classifier, but no `mousedown` ever carried the platform's
    // click counter, so this build cannot tell whether the press was a second
    // click. It must not guess.
    await drag(harness, { text: 'derive', mouseDown: false })
    expect(view(harness).gestures().counters.drags).toBe(1)
    expect(view(harness).gestures().counters.mouseDowns).toBe(0)
    expect(harness.requests).toEqual([])
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'unverified-click-multiplicity' })

    await drag(harness, { text: 'derive' })
    expect(harness.requests).toEqual(['derive'])
    expect(view(harness).gestures().counters.mouseDowns).toBe(1)
  })

  it('S11: a multi-click press that travelled and was classified as a drag cannot buy an auto-selection lookup', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await drag(harness, { text: 'derive', multiClick: true })
    expect(view(harness).gestures().counters.drags).toBe(1)
    expect(harness.requests).toEqual([])
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'multi-click-sequence' })
    // Nothing was consumed: the ledger only holds what produced a lookup.
    expect(view(harness).lookups()).toBe(0)
  })
})

describe('de-duplication', () => {
  it('treats a second platform double click as a second gesture, not as a duplicate event', async () => {
    // Two `dblclick` events are two gestures: the plugin has no timer and no
    // other way to tell a synthesised repeat from a reader double-clicking twice,
    // and collapsing them would swallow the second lookup the brief requires.
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    await doubleClick(harness, { text: 'derive' })
    const first = view(harness).gestures().last.gestureId
    harness.doc.emit('dblclick', { clientX: 200, clientY: 200 })
    await settle()
    const second = view(harness).gestures().last.gestureId

    expect(first).not.toBe(second)
    expect(view(harness).lookups()).toBe(2)
  })

  it('absorbs a stray release after a double click rather than turning it into a drag', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await doubleClick(harness, { text: 'derive' })
    const after = view(harness).lookups()
    harness.doc.emit('pointerup', pointer(500, 500))
    await settle()
    expect(view(harness).lookups()).toBe(after)
    expect(view(harness).gestures().counters.drags).toBe(0)
  })

  it('never offers a verdict for a press that has not been released', async () => {
    // The defect this guards: a press allocates an identity while the state still
    // carries the previous verdict, so a stray release could offer that verdict
    // under the new identity — a lookup for a gesture that never happened, and
    // one that burns an identity the real release afterwards needs.
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)

    // An abandoned press, then a release that closes nothing.
    harness.doc.emit('pointerdown', pointer(300, 300))
    harness.doc.emit('pointercancel', {})
    harness.doc.emit('pointerup', pointer(300, 300))
    await settle()
    expect(view(harness).lookups()).toBe(1)

    // A right-button release never opened a gesture either.
    harness.doc.emit('pointerup', { clientX: 400, clientY: 400, button: 2, pointerType: 'mouse' })
    await settle()
    expect(view(harness).lookups()).toBe(1)

    // ...and the next real drag still works, with a fresh identity.
    await drag(harness, { text: 'went' })
    expect(view(harness).lookups()).toBe(2)
    expect(harness.requests).toEqual(['derive', 'went'])
  })

  it('does not let a refused gesture re-fire later under a new identity', async () => {
    // The sharpest form of the same defect, and the one a switch change exposes:
    // a drag the switched-off gate refused is *not* consumed, so if a later stray
    // release re-offered that verdict under a fresh identity, turning the switch
    // on would buy a lookup for text the reader never dragged over for it.
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S00)

    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(0)
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'switch-off' })

    harness.doc.emit('pointerdown', pointer(300, 300))
    harness.doc.emit('pointercancel', {})
    await setSwitch(harness, 'autoSelection', true)

    // A release that closes nothing, carrying an entirely unrelated selection.
    harness.select(harness.flow, 'unrelated')
    harness.doc.emit('pointerup', pointer(300, 300))
    await settle()
    expect(view(harness).lookups()).toBe(0)
    expect(harness.requests).toEqual([])

    // The gesture that really completes afterwards is the first to be consumed.
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
    expect(harness.requests).toEqual(['derive'])
  })

  it('lets two independent double clicks on the same word produce two lookups', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    await doubleClick(harness, { text: 'derive' })
    const first = view(harness).gestures().last.gestureId
    await doubleClick(harness, { text: 'derive' })
    const second = view(harness).gestures().last.gestureId

    expect(first).not.toBe(second)
    expect(view(harness).lookups()).toBe(2)
    expect(harness.requests).toEqual(['derive', 'derive'])
  })

  it('lets two independent drags over the same word produce two lookups', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    const first = view(harness).gestures().last.gestureId
    await drag(harness, { text: 'derive' })
    const second = view(harness).gestures().last.gestureId

    expect(first).not.toBe(second)
    expect(view(harness).lookups()).toBe(2)
    expect(harness.requests).toEqual(['derive', 'derive'])
  })

  it('does not de-duplicate on text, geometry or time', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    const rect = { x: 10, y: 10, width: 40, height: 16 }
    for (let index = 0; index < 3; index += 1) {
      await doubleClick(harness, { text: 'derive' })
      harness.doc.selection.replace(harness.flow, 'derive', rect)
    }
    expect(view(harness).lookups()).toBe(3)
  })

  it('numbers every gesture identity monotonically and never reuses one', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    const ids: number[] = []
    for (const word of ['a', 'b', 'c']) {
      await drag(harness, { text: word })
      ids.push(view(harness).gestures().last.gestureId)
    }
    expect(ids).toEqual([1, 2, 3])

    // A cancelled gesture does not free its identity for reuse.
    harness.doc.emit('pointerdown', pointer(0, 0))
    harness.doc.emit('pointercancel', {})
    await drag(harness, { text: 'd' })
    expect(view(harness).gestures().last.gestureId).toBe(5)
  })
})

describe('the automatic path uses the same qualification rule as the shortcut', () => {
  it('refuses a drag inside the composer', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive', node: harness.composer })
    expect(view(harness).lookups()).toBe(0)
    expect(harness.requests).toEqual([])
  })

  it('refuses a double click inside the composer', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await doubleClick(harness, { text: 'derive', node: harness.composer })
    expect(view(harness).lookups()).toBe(0)
  })

  it('refuses a selection outside the conversation', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive', node: harness.loose })
    expect(view(harness).lookups()).toBe(0)
  })

  it('refuses a drag that moved too little to be a drag', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive', distance: 1 })
    expect(view(harness).lookups()).toBe(0)
    expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'not-a-trigger-gesture' })
  })

  it('refuses a double click that selected nothing usable', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)

    await doubleClick(harness, { text: '', node: harness.composer })
    expect(view(harness).lookups()).toBe(0)
  })

  it('still lets the manual shortcut through in the composer', async () => {
    // The shortcut is the first-class path and is not gated by either switch:
    // with both off, a composer selection is refused by the qualification rule,
    // and the pass/handled contract reports it.
    const harness = createHarness()
    harness.boot()
    harness.select(harness.composer, 'derive')
    expect(await shortcut(harness)).toBe(false)
    expect(view(harness).lookups()).toBe(0)
  })

  it('still lets the manual shortcut through after an automatic lookup completed', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)

    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)

    harness.select(harness.flow, 'derive')
    expect(await shortcut(harness)).toBe(true)
    expect(view(harness).lookups()).toBe(2)
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 1, 'auto-selection': 0, 'auto-double-click': 1 })
  })
})

describe('unverified pointer kinds produce no automatic I/O', () => {
  for (const pointerType of ['touch', 'pen', '']) {
    it(`refuses an automatic lookup for pointerType "${pointerType || '(empty)'}"`, async () => {
      const harness = createHarness()
      harness.boot()
      await useState(harness, STATES.S11)

      await drag(harness, { text: 'derive', pointerType })
      await doubleClick(harness, { text: 'derive', pointerType })
      expect(view(harness).lookups()).toBe(0)
      expect(view(harness).trigger()).toMatchObject({ decision: 'ignored', reason: 'unverified-pointer-kind' })
    })
  }

  it('still answers the manual shortcut from an unverified pointer', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)
    harness.select(harness.flow, 'derive')
    expect(await shortcut(harness)).toBe(true)
    expect(harness.requests).toEqual(['derive'])
  })
})

describe('lifecycle: repeated load and unload cannot multiply a gesture', () => {
  it('removes every listener it added', () => {
    const harness = createHarness()
    harness.boot()
    for (const type of ['pointerdown', 'mousedown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'selectionchange']) {
      expect(harness.doc.count(type), type).toBe(1)
    }
    expect(harness.win.count('blur')).toBe(1)
    expect(harness.diagnostics()).not.toBeNull()

    harness.dispose()
    for (const type of ['pointerdown', 'mousedown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'selectionchange']) {
      expect(harness.doc.count(type), type).toBe(0)
    }
    expect(harness.win.count('blur')).toBe(0)
    expect(harness.diagnostics()).toBeNull()
  })

  it('replaces the command registration rather than stacking it', () => {
    const harness = createHarness()
    harness.boot()
    expect(harness.command()?.id).toBe(LOOKUP_COMMAND_ID)
    harness.dispose()
    expect(harness.command()).toBeNull()
  })

  it('produces exactly one lookup per gesture after an unload and reload', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)
    harness.dispose()

    harness.boot()
    await useState(harness, STATES.S11)
    await drag(harness, { text: 'derive' })
    expect(view(harness).lookups()).toBe(1)
    expect(harness.requests).toEqual(['derive'])

    await doubleClick(harness, { text: 'went' })
    expect(view(harness).lookups()).toBe(2)
    expect(harness.requests).toEqual(['derive', 'went'])
  })

  it('publishes nothing from a lookup that outlives the runtime', async () => {
    let release!: (value: Response) => void
    const harness = createHarness({
      transport: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    expect(view(harness).loading()).toBe(true)
    harness.dispose()
    release(new Response(JSON.stringify({ ok: true, found: false, query: 'derive' }), { status: 200 }))
    await settle()
    expect(harness.diagnostics()).toBeNull()
  })
})

describe('request ordering through the real runtime', () => {
  /**
   * Build a harness whose transport answers only when the test says so.
   *
   * @returns the harness and the deferred answers, in issue order.
   */
  function deferredHarness() {
    const pending: { query: string; respond: (found: boolean) => void }[] = []
    const harness = createHarness({
      transport: (_url: string, init?: RequestInit) => {
        const query = String(JSON.parse(String(init?.body)).query)
        return new Promise<Response>((resolve) => {
          pending.push({
            query,
            respond: (found: boolean) => {
              const body = found
                ? {
                    ok: true,
                    found: true,
                    query,
                    headword: query,
                    phonetic: null,
                    meanings: [],
                    forms: [],
                    matchedForm: null,
                    examples: [],
                    source: 'sqlite-fixture',
                    settings: { autoDoubleClick: false, autoSelection: false },
                  }
                : { ok: true, found: false, query, source: 'sqlite-fixture' }
              resolve(new Response(JSON.stringify(body), { status: 200 }))
            },
          })
        })
      },
    })
    harness.boot()
    return { harness, pending }
  }

  it('shows the newest gesture’s answer and never rolls back to the older one', async () => {
    const { harness, pending } = deferredHarness()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    await drag(harness, { text: 'went' })
    expect(pending.map((entry) => entry.query)).toEqual(['derive', 'went'])
    expect(view(harness).loading()).toBe(true)

    pending[1]?.respond(true)
    await settle()
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })

    // The superseded request has been aborted, so in a real browser its fetch
    // rejects; here it is answered anyway, which is the strictly harder case —
    // an abort is a courtesy, and the identity check is what must hold.
    pending[0]?.respond(true)
    await settle()
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })
    expect(view(harness).lastOutcome()).toBe('found')
  })

  it('keeps the newest loading state when the older request finishes first', async () => {
    const { harness, pending } = deferredHarness()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    await drag(harness, { text: 'went' })
    pending[0]?.respond(true)
    await settle()
    expect(view(harness).loading()).toBe(true)
    expect(view(harness).card()).toMatchObject({ status: 'loading', query: 'went' })

    pending[1]?.respond(true)
    await settle()
    expect(view(harness).loading()).toBe(false)
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })
  })

  it('a stale failure cannot replace a newer success', async () => {
    let rejectA!: (error: unknown) => void
    const pending: { query: string; respond: (found: boolean) => void }[] = []
    const harness = createHarness({
      transport: (_url: string, init?: RequestInit) => {
        const query = String(JSON.parse(String(init?.body)).query)
        if (pending.length === 0) {
          return new Promise<Response>((_resolve, reject) => {
            pending.push({ query, respond: () => {} })
            rejectA = reject
          })
        }
        return new Promise<Response>((resolve) => {
          pending.push({
            query,
            respond: () =>
              resolve(
                new Response(
                  JSON.stringify({
                    ok: true,
                    found: true,
                    query,
                    headword: 'go',
                    phonetic: null,
                    meanings: [],
                    forms: [],
                    matchedForm: null,
                    examples: [],
                    source: 'sqlite-fixture',
                    settings: { autoDoubleClick: false, autoSelection: false },
                  }),
                  { status: 200 },
                ),
              ),
          })
        })
      },
    })
    harness.boot()
    await useState(harness, STATES.S10)

    await drag(harness, { text: 'derive' })
    await drag(harness, { text: 'went' })
    pending[1]?.respond(true)
    await settle()
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })

    rejectA(new TypeError('Failed to fetch'))
    await settle()
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })
    expect(view(harness).lastOutcome()).toBe('found')
  })
})

describe('stress: 100 drags and 100 double clicks in every settings state', () => {
  /** Replay the storm and return what it produced. */
  async function storm(harness: Harness) {
    const before = view(harness).gestures().counters
    // The batch is driven without awaiting each gesture: the counters and the
    // issue counts are updated synchronously by the listeners, and the request
    // accounting is flushed in slices so the pending promise chain stays bounded.
    for (let index = 0; index < 100; index += 1) {
      await drag(harness, { text: `drag${String(index)}`, quiet: true })
      if (index % 25 === 24) await settle()
    }
    for (let index = 0; index < 100; index += 1) {
      await doubleClick(harness, { text: `click${String(index)}`, quiet: true })
      if (index % 25 === 24) await settle()
    }
    await settle()
    const after = view(harness).gestures().counters
    return {
      drags: after.drags - before.drags,
      doubleClicks: after.doubleClickGestures - before.doubleClickGestures,
      lookups: view(harness).lookups(),
      origins: view(harness).lookupsByOrigin(),
    }
  }

  it('S00: 100 and 100 produce zero requests', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S00)
    const result = await storm(harness)
    expect(result.drags).toBe(100)
    expect(result.doubleClicks).toBe(100)
    expect(result.lookups).toBe(0)
    expect(harness.requests).toEqual([])
  })

  it('S10: 100 and 100 produce exactly 100 requests, all from auto-selection', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)
    const result = await storm(harness)
    expect(result.drags).toBe(100)
    expect(result.doubleClicks).toBe(100)
    expect(result.lookups).toBe(100)
    expect(result.origins).toEqual({ shortcut: 0, 'auto-selection': 100, 'auto-double-click': 0 })
  })

  it('S01: 100 and 100 produce exactly 100 requests, all from auto-double-click', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S01)
    const result = await storm(harness)
    expect(result.drags).toBe(100)
    expect(result.doubleClicks).toBe(100)
    expect(result.lookups).toBe(100)
    expect(result.origins).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 100 })
  })

  it('S11: 100 and 100 produce exactly 200 requests — never 300 and never 400', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S11)
    const result = await storm(harness)
    expect(result.drags).toBe(100)
    expect(result.doubleClicks).toBe(100)
    expect(result.lookups).toBe(200)
    expect(result.origins).toEqual({ shortcut: 0, 'auto-selection': 100, 'auto-double-click': 100 })
  })

  it('the shortcut still works after 200 gestures, and still once', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S00)
    await storm(harness)
    harness.requests.length = 0
    harness.select(harness.flow, 'derive')
    expect(await shortcut(harness)).toBe(true)
    expect(harness.requests).toEqual(['derive'])
    expect(view(harness).lookupsByOrigin()).toEqual({ shortcut: 1, 'auto-selection': 0, 'auto-double-click': 0 })
  })
})

describe('errors never disable the trigger path', () => {
  it('survives a transport failure and looks the next gesture up', async () => {
    let fail = true
    const harness = createHarness({
      transport: async (_url: string, init?: RequestInit) => {
        if (fail) throw new TypeError('Failed to fetch')
        const query = String(JSON.parse(String(init?.body)).query)
        return new Response(JSON.stringify({ ok: true, found: false, query }), { status: 200 })
      },
    })
    harness.boot()
    await useState(harness, STATES.S01)

    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).card()).toMatchObject({ status: 'failed', failure: { kind: 'network' } })

    fail = false
    await doubleClick(harness, { text: 'went' })
    expect(view(harness).card()).toMatchObject({ status: 'ready', query: 'went' })
    expect(view(harness).lookups()).toBe(2)
  })

  it('reports an unknown word as a normal miss and keeps going', async () => {
    const harness = createHarness({
      answer: (query) =>
        query === 'unknowntoken'
          ? { ok: true, found: false, query, source: 'sqlite-fixture' }
          : {
              ok: true,
              found: true,
              query,
              headword: 'derive',
              phonetic: null,
              meanings: [],
              forms: [],
              matchedForm: null,
              examples: [],
              source: 'sqlite-fixture',
              settings: { autoDoubleClick: true, autoSelection: false },
            },
    })
    harness.boot()
    await useState(harness, STATES.S01)

    await doubleClick(harness, { text: 'unknowntoken' })
    expect(view(harness).card()).toMatchObject({ status: 'ready', result: { kind: 'not-found' } })
    expect(view(harness).lastOutcome()).toBe('not-found')

    await doubleClick(harness, { text: 'derive' })
    expect(view(harness).card()).toMatchObject({ status: 'ready', result: { kind: 'found' } })
    expect(view(harness).lookups()).toBe(2)
  })
})

describe('diagnostics', () => {
  it('names the namespace and the origins', async () => {
    const harness = createHarness()
    harness.boot()
    expect(view(harness).plugin).toBe(PLUGIN_NAMESPACE)
    expect(view(harness).namespace).toBe(PLUGIN_NAMESPACE)
    expect(view(harness).origins()).toEqual(['shortcut', 'auto-selection', 'auto-double-click'])
  })

  it('reports no trigger before any gesture', async () => {
    const harness = createHarness()
    harness.boot()
    expect(view(harness).trigger()).toBeNull()
    expect(view(harness).requestId()).toBe(0)
    expect(view(harness).loading()).toBe(false)
  })

  it('hands the card to the newest request', async () => {
    const harness = createHarness()
    harness.boot()
    await useState(harness, STATES.S10)
    await drag(harness, { text: 'derive' })
    expect(view(harness).requestId()).toBe(1)
    await drag(harness, { text: 'went' })
    expect(view(harness).requestId()).toBe(2)
  })
})
