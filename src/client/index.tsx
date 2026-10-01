/**
 * Browser half of `dsh-word-lookup` (`exports "./client"`).
 *
 * Served by `dsh-client-modules` as **one classic script** and consumed only
 * through `window.__ModuleLoader__.load({ id, factory })`. The build wraps this
 * module in that envelope (see `tsdown.config.ts`), so nothing here may leave a
 * top-level `import`/`export` behind — `react` and `react/jsx-runtime` are
 * supplied by the envelope's `require`.
 *
 * Phase 1 contributes:
 *
 * - one `shell.overlay` occupant that renders nothing until a lookup produces
 *   something (`shell.overlay` is mounted for the whole application lifetime);
 * - the first-class manual command `wordLookup.lookupSelection`, bound to
 *   `Primary+Shift+L` on the five applicable profiles, with the sealed
 *   pass/handled behaviour;
 * - a read of the two host switches through the shared settings mirror;
 * - a `selectionchange` listener that updates a local snapshot and nothing else.
 *
 * It deliberately does **not** contribute: any automatic trigger, any gesture
 * classifier, any dictionary UI, any lookup history, or any model call.
 *
 * @module dsh-word-lookup/client
 */

import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'

import { WordLookupCard } from './card.js'
import type { ClientContext } from './contracts.js'
import { Disposer } from './lifecycle.js'
import { readEligibleSelection } from './selection.js'
import { LookupCardStore } from './store.js'
import { requestLookup, type LookupResult, type LookupTransportFailure } from './transport.js'

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
 * `false` for either field means the corresponding automatic trigger is off. In
 * Phase 1 the mirror is read and republished but drives nothing: the automatic
 * paths do not exist yet, and the manual command is deliberately not gated by
 * them.
 */
export interface LookupGates {
  /** Mirror value of `Config.autoDoubleClick`. */
  readonly autoDoubleClick: boolean
  /** Mirror value of `Config.autoSelection`. */
  readonly autoSelection: boolean
}

/** The settings section this plugin's namespace carries. */
interface HostSettings {
  readonly autoDoubleClick?: boolean
  readonly autoSelection?: boolean
}

/** Local snapshot of the last observed selection. Never triggers a request. */
interface SelectionSnapshot {
  readonly present: boolean
  readonly eligible: boolean
  readonly text: string
  /** Which surface the selection was last seen in, for diagnostics. */
  readonly at: number
}

/**
 * Phase 1 verification surface.
 *
 * Phase 1's acceptance criteria require observing client-side state that has no
 * product affordance yet — the live settings snapshot, the gate values, and how
 * many lookups a gesture sequence produced. This object is the instrument for
 * that, and it is the only global the plugin publishes. It is scheduled for
 * removal once the automatic triggers and the real card exist (Phase 5), at
 * which point every value here has a visible surface.
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
  /** The last observed selection snapshot. */
  selection(): SelectionSnapshot
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
    let selectionSnapshot: SelectionSnapshot = { present: false, eligible: false, text: '', at: 0 }
    let lookupCount = 0
    let lastOutcome: string | null = null
    let inflight: AbortController | null = null

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
     * Issue one lookup for a selection the reader already qualified.
     *
     * A newer request aborts the previous one, so a slow answer for A cannot
     * overwrite the answer for B.
     *
     * @param query - raw selected text; the host normalizes it.
     * @param origin - which path asked, for diagnostics.
     */
    const runLookup = async (query: string, origin: 'shortcut'): Promise<void> => {
      void origin
      inflight?.abort()
      const controller = new AbortController()
      inflight = controller
      lookupCount += 1
      store.set({ status: 'loading', query })

      const outcome: LookupResult | LookupTransportFailure = await requestLookup(query, controller.signal)
      if (inflight !== controller) return
      inflight = null
      lastOutcome = outcome.kind

      if (outcome.kind === 'aborted' || outcome.kind === 'network') {
        store.set({ status: 'failed', query, failure: outcome })
        return
      }
      store.set({ status: 'ready', query, result: outcome })
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
    // No lookup is issued from this listener. With both switches off the plugin
    // must produce exactly zero requests for any selection gesture, and Phase 1
    // has no trigger gate at all, so the listener stores and returns.
    const onSelectionChange = (): void => {
      const selection = readEligibleSelection(document)
      selectionSnapshot = {
        present: document.getSelection()?.isCollapsed === false,
        eligible: selection !== null,
        text: selection === null ? '' : selection.text.slice(0, 96),
        at: Date.now(),
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    disposer.add(() => {
      document.removeEventListener('selectionchange', onSelectionChange)
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
      selection: () => selectionSnapshot,
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
      lookups: () => lookupCount,
      lastOutcome: () => lastOutcome,
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
      inflight?.abort()
      inflight = null
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
