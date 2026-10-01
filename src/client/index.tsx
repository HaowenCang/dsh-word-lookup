/**
 * Browser half of `dsh-word-lookup` (`exports "./client"`).
 *
 * Served by `dsh-client-modules` as **one classic script** and consumed only
 * through `window.__ModuleLoader__.load({ id, factory })`. The build wraps this
 * module in that envelope (see `tsdown.config.ts`), so nothing here may leave a
 * top-level `import`/`export` behind — `react` and `react/jsx-runtime` are
 * supplied by the envelope's `require`.
 *
 * Contributions:
 *
 * - one `shell.overlay` occupant that renders nothing until a lookup produces
 *   something (`shell.overlay` is mounted for the whole application lifetime);
 * - the first-class manual command `wordLookup.lookupSelection`, bound to
 *   `Primary+Shift+L` on the five applicable profiles, with the sealed
 *   pass/handled behaviour;
 * - a read of the two host switches through the shared settings mirror;
 * - a `selectionchange` listener that refreshes a local snapshot of the text and
 *   its live geometry, and nothing else;
 * - Phase 2: pointer and `dblclick` listeners that classify the last completed
 *   gesture into drag / double-click / other, each carrying a monotonic identity;
 * - Phase 4: a trigger gate that turns a completed classification into a lookup
 *   when — and only when — the switch that owns it is on, the pointer is one this
 *   build measured, the selection captured at completion is eligible, and that
 *   gesture identity has not already been consumed.
 *
 * It deliberately does **not** contribute: any dictionary UI, any lookup history,
 * any model call, or any timer that re-derives what the browser already knows.
 *
 * The I/O invariant is the one thing in this file that must stay obvious:
 *
 * ```text
 * selectionchange  -> local snapshot only          (no ticket, no gate, no I/O)
 * pointer events   -> local gesture state only
 * dblclick         -> local gesture state only
 * gesture completion -> trigger gate -> maybe runLookup
 * shortcut run     -> runLookup
 * ```
 *
 * `selectionchange` is deliberately **not** a trigger. The product's
 * `autoSelection` means a completed pointer drag, not "the selection changed":
 * a double click produces a `selectionchange` too, a keyboard selection produces
 * one, and a programmatic one produces one. Gating on the event would make
 * `autoSelection` mean something the reader never asked for and would fire a
 * second lookup for the trailing change of every double click.
 *
 * @module dsh-word-lookup/client
 */

import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'

import { WordLookupCard } from './card.js'
import type { ClientContext } from './contracts.js'
import {
  classificationOf,
  gestureSnapshot,
  IDLE_OBSERVATION,
  observeCancel,
  observeDoubleClick,
  observePointerDown,
  observePointerMove,
  observePointerUp,
  pointerKind,
  type GestureCounters,
  type GestureObservation,
  type GestureSnapshot,
} from './gesture.js'
import { Disposer } from './lifecycle.js'
import { LookupController, LOOKUP_ORIGINS, type LookupCounts } from './lookup.js'
import { readEligibleSelection, type SelectionRect } from './selection.js'
import { LookupCardStore, type CardState } from './store.js'
import {
  EMPTY_LEDGER,
  EMPTY_SELECTION,
  evaluateAutomaticTrigger,
  type LookupOrigin,
  type TriggerDecision,
  type TriggerGates,
  type TriggerLedger,
  type TriggerSelection,
} from './trigger.js'
import { requestLookup } from './transport.js'

/**
 * Client services this half requires before activation.
 *
 * `slots` is mandatory: a slot contribution made before the registry exists
 * throws instead of waiting. `shortcuts` and `configForms` are equally
 * load-bearing — the command registration and the settings mirror both fail
 * loudly without them.
 *
 * `locale` is **not** declared: Phase 1 ships no localized copy, and waiting on a
 * service the plugin does not read would make activation depend on a composition
 * detail for no benefit. The package-level `dsh.client.inject` list keeps
 * `@deepseek-ai/dsh-client-locale`, which is a module-load ordering statement
 * rather than a cordis dependency.
 */
export const inject: readonly string[] = ['slots', 'shortcuts', 'configForms']

/** Loader entry id; equals the settings namespace and the host route's owner. */
export const namespace = 'dsh-word-lookup'

/** The manual command's identity in the DSH shortcut catalog. */
export const LOOKUP_COMMAND_ID = 'wordLookup.lookupSelection' as ShortcutCommandId

/** Registration id of the card inside the frame-wide overlay list. */
export const CARD_ENTRY_ID = 'dsh-word-lookup:card'

/**
 * Ascending render order inside `shell.overlay`.
 *
 * Chosen to sit above the shipped toasts and notices — the card answers a
 * gesture the reader just made, so it must not be covered by an unrelated
 * notification — while staying well below a modal's z-index.
 */
export const CARD_ORDER = 900

/**
 * Regions the manual command is available in: the page and editable surfaces.
 *
 * Typed by the literal array rather than by importing `ShortcutRegion`: that
 * name is declared in `dsh-client-shortcuts`' protocol layer but is not
 * re-exported from its public `./client` entry, and reaching for the private
 * declaration file is exactly the import this project forbids.
 */
const COMMAND_REGIONS = ['page', 'editable'] as const

/** The command owns no modal; it must not fire from inside a dialog. */
const COMMAND_MODALS = [] as const

/**
 * The two switches as the browser sees them.
 *
 * `false` for either field means the corresponding automatic trigger is off. The
 * mirror is refreshed from the settings form's subscription, and the gate reads
 * the current value at each gesture rather than one captured at plugin load, so
 * a change in the settings UI takes effect on the reader's next gesture with no
 * reload. The manual command is deliberately not gated by either switch.
 */
export type LookupGates = TriggerGates

/** The settings section this plugin's namespace carries. */
interface HostSettings {
  readonly autoDoubleClick?: boolean
  readonly autoSelection?: boolean
}

/**
 * Local snapshot of the last observed selection. Never triggers a request.
 *
 * The selection facts and the gesture facts are two independent pieces of state
 * — one advances on `selectionchange`, the other on pointer events — and are
 * merged only when read, so neither write path has to reconstruct the other.
 */
export interface SelectionSnapshot {
  /** Whether the document reports a non-collapsed selection at all. */
  readonly present: boolean
  /** Whether that selection passed every qualification rule. */
  readonly eligible: boolean
  /** The eligible text, truncated for transport-free diagnostics. */
  readonly text: string
  /** When the selection facts were last refreshed. */
  readonly at: number
  /** Geometry of the live range at capture time; `null` when there is none. */
  readonly rect: SelectionRect | null
  /** The last completed gesture. */
  readonly gesture: GestureSnapshot
}

/**
 * The verification surface.
 *
 * Its acceptance criteria require observing client-side state that has no
 * product affordance — the live settings snapshot, the switch values, how many
 * lookups a gesture sequence produced and *which path asked for each*. This
 * object is the instrument for that, and it is the only global the plugin
 * publishes. It is scheduled for removal once the card carries every value here
 * on screen (a later phase), at which point nothing here is invisible.
 */
export interface WordLookupDiagnostics {
  /** Package id. */
  readonly plugin: string
  /** The settings namespace this plugin reads and owns. */
  readonly namespace: string
  /** The live settings snapshot, as the card would read it. */
  snapshot(): {
    readonly status: string
    readonly mode: string
    readonly writable: boolean
    readonly revision: number | undefined
    readonly value: HostSettings | undefined
  }
  /** The gates derived from {@link WordLookupDiagnostics.snapshot}. */
  gates(): LookupGates
  /** The last observed selection snapshot, including the last gesture. */
  selection(): SelectionSnapshot
  /**
   * What the gesture listeners observed and how they classified it.
   *
   * `counters` proves the listeners are alive; `last` proves the classifier
   * reached a verdict. Both are needed to make "a drag produced no request"
   * mean something.
   */
  gestures(): {
    readonly counters: GestureCounters
    readonly last: GestureSnapshot
  }
  /**
   * The overlay contribution's progress.
   *
   * `declarationSeen` distinguishes "the frame has not declared `shell.overlay`
   * yet" from "the registration failed": `slots.inject` runs its callback only
   * once the declaration exists, and a plugin whose callback never ran has
   * contributed nothing at all.
   */
  overlay(): {
    readonly entryId: string
    readonly order: number
    readonly declarationSeen: boolean
    readonly registrationCount: number
  }
  /** This plugin's row in the live shortcut catalog. */
  catalog(): {
    readonly size: number
    readonly row: {
      readonly id: string
      readonly label: string
      readonly keys: readonly string[]
      readonly binding: unknown
      readonly conflicts: readonly string[]
      readonly issue: unknown
    } | null
  }
  /**
   * What the command's `resolve` was asked and what it answered.
   *
   * `resolveCalls` against `runCalls` is the difference between "the dispatcher
   * never reached this command" and "it resolved to handled and the action ran":
   * those two produce the same request count, so a request count alone cannot
   * tell them apart. `lastContext` records the region and modal the dispatcher
   * resolved, which is what decides whether the command is consulted at all.
   */
  shortcut(): {
    readonly resolveCalls: number
    readonly passReturns: number
    readonly handledReturns: number
    readonly runCalls: number
    readonly lastOutcome: 'pass' | 'handled' | null
    readonly lastContext: { readonly region: string; readonly modal: string | null; readonly target: string | null } | null
  }
  /** How many lookups this plugin has issued since page load. */
  lookups(): number
  /**
   * The same count, split by which path asked.
   *
   * This is the measurement that makes the four-state settings matrix checkable:
   * a total alone cannot tell "the drag triggered" from "the double click did",
   * and the two switches are only honest if each one moves its own counter.
   */
  lookupsByOrigin(): LookupCounts
  /** The origins a lookup can come from, for a report that iterates them. */
  origins(): readonly LookupOrigin[]
  /**
   * The last automatic evaluation, accepted or suppressed.
   *
   * `reason` is what distinguishes "the gate refused this gesture" from "the gate
   * never saw it". A request count of zero means the former and could never prove
   * the latter, which is exactly the failure a missing trigger would produce.
   */
  trigger(): {
    readonly decision: 'lookup' | 'ignored'
    readonly reason: string
    readonly origin: LookupOrigin | null
    readonly gestureId: number
    readonly query: string
  } | null
  /**
   * The selection captured with the last automatic evaluation.
   *
   * The decision reports a query only when it accepted one, so this is what
   * separates "the gate refused the right gesture" from "the gate was handed the
   * wrong text": both produce zero requests.
   */
  capture(): {
    readonly eligible: boolean
    readonly text: string
    readonly rect: SelectionRect | null
  }
  /**
   * Identity of the request currently allowed to publish to the card.
   *
   * Requests are numbered monotonically and only the newest may publish, so this
   * value alone decides whether a slow answer is shown or dropped.
   */
  requestId(): number
  /** Whether the card is waiting on the request that owns it. */
  loading(): boolean
  /**
   * The card's current state.
   *
   * The browser harness reads the rendered card out of the DOM instead; this is
   * the same value one step earlier, which is what a test without a DOM needs to
   * tell "the newest answer is on screen" from "an answer arrived".
   */
  card(): CardState
  /** The last lookup outcome's discriminant, or `null`. */
  lastOutcome(): string | null
  /** Write one switch through the same form the settings UI uses. */
  set(field: keyof HostSettings, value: unknown): Promise<boolean>
}

/** The global slot the diagnostics object occupies. */
const DIAGNOSTICS_KEY = '__DSH_WORD_LOOKUP__'

/**
 * Create the browser runtime and return its single disposer.
 *
 * Registration is all-or-nothing: a failure anywhere releases everything
 * registered before it and rethrows, so a partially installed runtime — the
 * state no test can distinguish from a working boot — cannot be produced.
 *
 * @param ctx - the client root context.
 * @returns the disposer releasing every contribution.
 */
function createRuntime(ctx: ClientContext): () => void {
  const store = new LookupCardStore()
  const disposer = new Disposer()

  try {
    let gates: LookupGates = { autoDoubleClick: false, autoSelection: false }
    /** Selection facts only; the gesture is merged in when the snapshot is read. */
    let selectionFacts: Omit<SelectionSnapshot, 'gesture'> = {
      present: false,
      eligible: false,
      text: '',
      at: 0,
      rect: null,
    }
    let gesture: GestureObservation = IDLE_OBSERVATION
    /** The trigger gate's memory of which gesture identities it has consumed. */
    let ledger: TriggerLedger = EMPTY_LEDGER
    /** The last automatic evaluation, accepted or refused; `null` before any. */
    let lastTrigger: TriggerDecision | null = null
    /**
     * The selection captured with that evaluation.
     *
     * Recorded separately from the decision because the decision deliberately
     * reports a query only when it accepted one: "the gate refused this gesture"
     * and "the gate was handed the wrong text" produce the same request count and
     * are only distinguishable if the capture is kept.
     */
    let lastCapture: TriggerSelection = EMPTY_SELECTION

    const lookup = new LookupController({ store, request: requestLookup })

    const form = ctx.configForms.get<HostSettings>(namespace)

    /**
     * Republish the gate values from the live form snapshot.
     *
     * The host emits `settings/document-updated` when a write is accepted, the
     * event reaches the browser over the remote multiplexer, and the shared
     * mirror folds it in; the subscription below is therefore the whole of the
     * client's live-propagation work.
     */
    const readGates = (): void => {
      const value = form.getSnapshot().value
      gates = {
        autoDoubleClick: value?.autoDoubleClick === true,
        autoSelection: value?.autoSelection === true,
      }
    }
    readGates()
    disposer.add(form.subscribe(readGates))

    /**
     * Issue one lookup.
     *
     * The thinnest possible wrapper: request identity, supersession and the
     * stale-result policy all live in {@link LookupController}, and this exists
     * only so the two call sites below read alike.
     *
     * @param query - raw selected text; the host normalizes it.
     * @param origin - which path asked, for client-side accounting.
     */
    const runLookup = (query: string, origin: LookupOrigin): void => {
      void lookup.run(query, origin)
    }

    // --- overlay occupant -------------------------------------------------
    // `slots.inject` is a declaration-lifetime hook: the callback runs
    // synchronously when `shell.overlay` is already declared, and otherwise
    // inside the declaring `register()` call. Counting the runs is what makes
    // "the occupant is registered exactly once" observable from outside.
    let overlayDeclarationSeen = false
    let overlayRegistrationCount = 0
    disposer.add(
      ctx.slots.inject('shell.overlay', () => {
        overlayDeclarationSeen = true
        const unregister = ctx.slots.register(
          {
            name: 'shell.overlay',
            id: CARD_ENTRY_ID,
            order: CARD_ORDER,
            label: 'Dictionary card',
            inject: () => ({ store }),
          },
          WordLookupCard,
        )
        overlayRegistrationCount += 1
        return () => {
          overlayRegistrationCount -= 1
          unregister()
        }
      }),
    )

    // --- first-class manual command ---------------------------------------
    let resolveCalls = 0
    let passReturns = 0
    let handledReturns = 0
    let runCalls = 0
    let lastShortcutOutcome: 'pass' | 'handled' | null = null
    let lastShortcutContext: { region: string; modal: string | null; target: string | null } | null = null

    disposer.add(
      ctx.shortcuts.register({
        id: LOOKUP_COMMAND_ID,
        // A plain English label: Phase 1 ships no locale dictionary, so the row
        // reads in the product's source language until the copy lands.
        label: () => 'Look up selection',
        aliases: ['word', 'lookup', 'dictionary'],
        defaults: {
          // `primary` is Command on macOS and Control elsewhere. Two modifiers
          // including primary+shift are inside the Web ceiling, and KeyL appears
          // in no shipped default binding, so registration cannot collide.
          'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          'web:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          'desktop:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          'desktop:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          'desktop:linux': { code: 'KeyL', modifiers: ['primary', 'shift'] },
          // `web:linux` is deliberately absent: `isWebBindingAllowed` admits only
          // three exact combinations there, and a rejected default throws rather
          // than degrading.
        },
        regions: COMMAND_REGIONS,
        modals: COMMAND_MODALS,
        resolve: (context) => {
          resolveCalls += 1
          lastShortcutContext = {
            region: context.region,
            modal: context.modal,
            target: context.target === null ? null : context.target.tagName.toLowerCase(),
          }
          // The selection is captured here, at resolve time, not when the action
          // runs: the browser may drop it in the interval between the two.
          const selection = readEligibleSelection(document)
          if (selection === null) {
            passReturns += 1
            lastShortcutOutcome = 'pass'
            return { status: 'pass' }
          }
          handledReturns += 1
          lastShortcutOutcome = 'handled'
          return {
            status: 'handled',
            run: () => {
              runCalls += 1
              void runLookup(selection.text, 'shortcut')
            },
          }
        },
      }),
    )

    // --- selection snapshot only ------------------------------------------
    // No lookup is issued from this listener, and Phase 4 did not change that.
    // `selectionchange` carries no pointer position, so it can never say what the
    // reader did; a double click produces one, a keyboard selection produces one
    // and a programmatic one produces one. Gating a lookup on it would make
    // `autoSelection` mean "the selection changed" — a different product — and
    // would fire a second lookup for the trailing change of every double click.
    //
    // The geometry is re-read from the live range here, at capture time, because
    // a scroll or a streaming re-render invalidates anything remembered.
    const onSelectionChange = (): void => {
      const selection = readEligibleSelection(document)
      selectionFacts = {
        present: document.getSelection()?.isCollapsed === false,
        eligible: selection !== null,
        text: selection === null ? '' : selection.text.slice(0, 96),
        at: Date.now(),
        rect: selection === null ? null : selection.rect,
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    disposer.add(() => {
      document.removeEventListener('selectionchange', onSelectionChange)
    })

    // --- gesture classification, then the trigger gate --------------------
    // `captureSelection()` reads the live selection *inside* the event that ends
    // the gesture, so the verdict describes what was selected at that moment —
    // Phase 0 §7.4 measured that a drag's selection can be collapsed again within
    // ~250 ms of `pointerup`, so a late read is not equivalent to this one. It
    // projects the live `Range` onto plain data immediately: no `Range`, `Node`
    // or `Selection` object survives the handler.
    //
    // Only the two classification handlers consult the gate. That is the whole
    // I/O boundary of this file, and two tests assert it rather than this
    // comment: an AST check that the `selectionchange` body reaches no I/O, and a
    // browser measurement that a storm of programmatic selection changes issues
    // zero requests with `autoSelection` on.
    const captureSelection = (): TriggerSelection => {
      const selection = readEligibleSelection(document)
      if (selection === null) return EMPTY_SELECTION
      return { eligible: true, text: selection.text, rect: selection.rect }
    }

    /**
     * Offer one completed classification to the gate and act on its decision.
     *
     * @param selection - the selection captured in the same event.
     */
    const considerAutomatic = (selection: TriggerSelection): void => {
      lastCapture = selection
      const decision = evaluateAutomaticTrigger(
        { classification: classificationOf(gesture.state), selection },
        gates,
        ledger,
      )
      ledger = decision.ledger
      lastTrigger = decision
      if (decision.decision === 'lookup' && decision.origin !== null) {
        runLookup(decision.query, decision.origin)
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      gesture = observePointerDown(
        gesture,
        { x: event.clientX, y: event.clientY, at: Date.now() },
        event.button,
        pointerKind(event.pointerType),
      )
    }

    const onPointerMove = (event: PointerEvent): void => {
      gesture = observePointerMove(gesture, { x: event.clientX, y: event.clientY, at: Date.now() })
    }

    const onPointerUp = (event: PointerEvent): void => {
      const selection = captureSelection()
      const previous = gesture.state
      gesture = observePointerUp(gesture, { x: event.clientX, y: event.clientY, at: Date.now() }, selection.eligible)
      // Only a release that actually closed a gesture offers a classification.
      // A stray release — no press was tracked, or a `dblclick` already sealed the
      // gesture — leaves the state untouched, and re-offering the previous verdict
      // from here would be a lookup for a gesture that never happened. The
      // reducers return the same state object when they change nothing, which is
      // the contract this relies on.
      if (gesture.state !== previous) considerAutomatic(selection)
    }

    const onDoubleClick = (event: MouseEvent): void => {
      const selection = captureSelection()
      // `dblclick` *is* the platform's completed gesture, so this fold always
      // produces a classification and is always offered.
      gesture = observeDoubleClick(gesture, { x: event.clientX, y: event.clientY, at: Date.now() }, selection.eligible)
      considerAutomatic(selection)
    }

    const onCancelGesture = (): void => {
      gesture = observeCancel(gesture)
    }

    // Capture phase, matching how Phase 0 recorded the real orderings: a
    // listener on the bubble phase would miss a gesture the transcript consumed.
    const GESTURE_OPTIONS = { capture: true } as const
    document.addEventListener('pointerdown', onPointerDown, GESTURE_OPTIONS)
    document.addEventListener('pointermove', onPointerMove, GESTURE_OPTIONS)
    document.addEventListener('pointerup', onPointerUp, GESTURE_OPTIONS)
    document.addEventListener('pointercancel', onCancelGesture, GESTURE_OPTIONS)
    document.addEventListener('dblclick', onDoubleClick, GESTURE_OPTIONS)
    // A window that loses focus mid-drag never delivers the release.
    window.addEventListener('blur', onCancelGesture)
    disposer.add(() => {
      document.removeEventListener('pointerdown', onPointerDown, GESTURE_OPTIONS)
      document.removeEventListener('pointermove', onPointerMove, GESTURE_OPTIONS)
      document.removeEventListener('pointerup', onPointerUp, GESTURE_OPTIONS)
      document.removeEventListener('pointercancel', onCancelGesture, GESTURE_OPTIONS)
      document.removeEventListener('dblclick', onDoubleClick, GESTURE_OPTIONS)
      window.removeEventListener('blur', onCancelGesture)
      gesture = observeCancel(gesture)
    })

    // --- Phase 1 verification surface -------------------------------------
    const diagnostics: WordLookupDiagnostics = {
      plugin: namespace,
      namespace,
      snapshot: () => {
        const snapshot = form.getSnapshot()
        return {
          status: snapshot.status,
          mode: snapshot.mode,
          writable: snapshot.writable,
          revision: snapshot.revision,
          value: snapshot.value,
        }
      },
      gates: () => gates,
      selection: () => ({ ...selectionFacts, gesture: gestureSnapshot(gesture.state) }),
      gestures: () => ({ counters: gesture.counters, last: gestureSnapshot(gesture.state) }),
      overlay: () => ({
        entryId: CARD_ENTRY_ID,
        order: CARD_ORDER,
        declarationSeen: overlayDeclarationSeen,
        registrationCount: overlayRegistrationCount,
      }),
      catalog: () => {
        const catalog = ctx.shortcuts.catalog.getSnapshot()
        const own = catalog.find((row) => row.id === LOOKUP_COMMAND_ID)
        return {
          size: catalog.length,
          row:
            own === undefined
              ? null
              : {
                  id: own.id,
                  label: own.label,
                  keys: own.keys,
                  binding: own.binding,
                  conflicts: own.conflicts,
                  issue: own.issue,
                },
        }
      },
      lookups: () => lookup.issued(),
      lookupsByOrigin: () => lookup.counts(),
      origins: () => LOOKUP_ORIGINS,
      trigger: () =>
        lastTrigger === null
          ? null
          : {
              decision: lastTrigger.decision,
              reason: lastTrigger.reason,
              origin: lastTrigger.origin,
              gestureId: lastTrigger.gestureId,
              query: lastTrigger.query,
            },
      capture: () => ({ eligible: lastCapture.eligible, text: lastCapture.text, rect: lastCapture.rect }),
      requestId: () => lookup.current(),
      loading: () => lookup.loading(),
      card: () => lookup.card(),
      lastOutcome: () => lookup.lastOutcome(),
      shortcut: () => ({
        resolveCalls,
        passReturns,
        handledReturns,
        runCalls,
        lastOutcome: lastShortcutOutcome,
        lastContext: lastShortcutContext,
      }),
      set: (field, value) => form.set(field, value),
    }
    Reflect.set(globalThis, DIAGNOSTICS_KEY, diagnostics)
    disposer.add(() => {
      if (Reflect.get(globalThis, DIAGNOSTICS_KEY) === diagnostics) {
        Reflect.deleteProperty(globalThis, DIAGNOSTICS_KEY)
      }
    })

    return () => {
      lookup.dispose()
      store.clear()
      disposer.disposeAll()
    }
  } catch (error: unknown) {
    disposer.disposeAll()
    throw error
  }
}

/**
 * Apply the plugin's browser contributions.
 *
 * One `ctx.effect` owns the whole runtime, so the Cordis fiber has exactly one
 * thing to unwind when the plugin unloads or reloads.
 *
 * @param ctx - the client root context DSH hands to a browser plugin.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => createRuntime(ctx), 'dsh-word-lookup: client runtime')
}
