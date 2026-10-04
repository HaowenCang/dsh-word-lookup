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
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client';
import type { ClientContext } from './contracts.js';
import { type GestureCounters, type GestureSnapshot } from './gesture.js';
import { type LookupCounts } from './lookup.js';
import { type SelectionRect } from './selection.js';
import { type CardState } from './store.js';
import { type LookupOrigin, type TriggerGates } from './trigger.js';
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
export declare const inject: readonly string[];
/** Loader entry id; equals the settings namespace and the host route's owner. */
export declare const namespace = "dsh-word-lookup";
/** The manual command's identity in the DSH shortcut catalog. */
export declare const LOOKUP_COMMAND_ID: ShortcutCommandId;
/** Registration id of the card inside the frame-wide overlay list. */
export declare const CARD_ENTRY_ID = "dsh-word-lookup:card";
/**
 * Ascending render order inside `shell.overlay`.
 *
 * Chosen to sit above the shipped toasts and notices — the card answers a
 * gesture the reader just made, so it must not be covered by an unrelated
 * notification — while staying well below a modal's z-index.
 */
export declare const CARD_ORDER = 900;
/**
 * The two switches as the browser sees them.
 *
 * `false` for either field means the corresponding automatic trigger is off. The
 * mirror is refreshed from the settings form's subscription, and the gate reads
 * the current value at each gesture rather than one captured at plugin load, so
 * a change in the settings UI takes effect on the reader's next gesture with no
 * reload. The manual command is deliberately not gated by either switch.
 */
export type LookupGates = TriggerGates;
/** The settings section this plugin's namespace carries. */
interface HostSettings {
    readonly autoDoubleClick?: boolean;
    readonly autoSelection?: boolean;
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
    readonly present: boolean;
    /** Whether that selection passed every qualification rule. */
    readonly eligible: boolean;
    /** The eligible text, truncated for transport-free diagnostics. */
    readonly text: string;
    /** When the selection facts were last refreshed. */
    readonly at: number;
    /** Geometry of the live range at capture time; `null` when there is none. */
    readonly rect: SelectionRect | null;
    /** The last completed gesture. */
    readonly gesture: GestureSnapshot;
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
    readonly plugin: string;
    /** The settings namespace this plugin reads and owns. */
    readonly namespace: string;
    /** The live settings snapshot, as the card would read it. */
    snapshot(): {
        readonly status: string;
        readonly mode: string;
        readonly writable: boolean;
        readonly revision: number | undefined;
        readonly value: HostSettings | undefined;
    };
    /** The gates derived from {@link WordLookupDiagnostics.snapshot}. */
    gates(): LookupGates;
    /** The last observed selection snapshot, including the last gesture. */
    selection(): SelectionSnapshot;
    /**
     * What the gesture listeners observed and how they classified it.
     *
     * `counters` proves the listeners are alive; `last` proves the classifier
     * reached a verdict. Both are needed to make "a drag produced no request"
     * mean something.
     */
    gestures(): {
        readonly counters: GestureCounters;
        readonly last: GestureSnapshot;
    };
    /**
     * The overlay contribution's progress.
     *
     * `declarationSeen` distinguishes "the frame has not declared `shell.overlay`
     * yet" from "the registration failed": `slots.inject` runs its callback only
     * once the declaration exists, and a plugin whose callback never ran has
     * contributed nothing at all.
     */
    overlay(): {
        readonly entryId: string;
        readonly order: number;
        readonly declarationSeen: boolean;
        readonly registrationCount: number;
    };
    /** This plugin's row in the live shortcut catalog. */
    catalog(): {
        readonly size: number;
        readonly row: {
            readonly id: string;
            readonly label: string;
            readonly keys: readonly string[];
            readonly binding: unknown;
            readonly conflicts: readonly string[];
            readonly issue: unknown;
        } | null;
    };
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
        readonly resolveCalls: number;
        readonly passReturns: number;
        readonly handledReturns: number;
        readonly runCalls: number;
        readonly lastOutcome: 'pass' | 'handled' | null;
        readonly lastContext: {
            readonly region: string;
            readonly modal: string | null;
            readonly target: string | null;
        } | null;
    };
    /** Monotonic surface generation identity. */
    surfaceGeneration?(): number;
    /** Dismiss the card surface programmatically. */
    dismiss?(): void;
    /** Run a lookup programmatically for diagnostics/tests. */
    runLookup?(query: string, origin?: LookupOrigin): Promise<void>;
    /** How many lookups this plugin has issued since page load. */
    lookups(): number;
    /**
     * The same count, split by which path asked.
     *
     * This is the measurement that makes the four-state settings matrix checkable:
     * a total alone cannot tell "the drag triggered" from "the double click did",
     * and the two switches are only honest if each one moves its own counter.
     */
    lookupsByOrigin(): LookupCounts;
    /** The origins a lookup can come from, for a report that iterates them. */
    origins(): readonly LookupOrigin[];
    /**
     * The last automatic evaluation, accepted or suppressed.
     *
     * `reason` is what distinguishes "the gate refused this gesture" from "the gate
     * never saw it". A request count of zero means the former and could never prove
     * the latter, which is exactly the failure a missing trigger would produce.
     */
    trigger(): {
        readonly decision: 'lookup' | 'ignored';
        readonly reason: string;
        readonly origin: LookupOrigin | null;
        readonly gestureId: number;
        readonly query: string;
    } | null;
    /**
     * The selection captured with the last automatic evaluation.
     *
     * The decision reports a query only when it accepted one, so this is what
     * separates "the gate refused the right gesture" from "the gate was handed the
     * wrong text": both produce zero requests.
     */
    capture(): {
        readonly eligible: boolean;
        readonly text: string;
        readonly rect: SelectionRect | null;
    };
    /**
     * Identity of the request currently allowed to publish to the card.
     *
     * Requests are numbered monotonically and only the newest may publish, so this
     * value alone decides whether a slow answer is shown or dropped.
     */
    requestId(): number;
    /** Whether the card is waiting on the request that owns it. */
    loading(): boolean;
    /**
     * The card's current state.
     *
     * The browser harness reads the rendered card out of the DOM instead; this is
     * the same value one step earlier, which is what a test without a DOM needs to
     * tell "the newest answer is on screen" from "an answer arrived".
     */
    card(): CardState;
    /** The last lookup outcome's discriminant, or `null`. */
    lastOutcome(): string | null;
    /** Write one switch through the same form the settings UI uses. */
    set(field: keyof HostSettings, value: unknown): Promise<boolean>;
}
/**
 * Apply the plugin's browser contributions.
 *
 * One `ctx.effect` owns the whole runtime, so the Cordis fiber has exactly one
 * thing to unwind when the plugin unloads or reloads.
 *
 * @param ctx - the client root context DSH hands to a browser plugin.
 */
export declare function apply(ctx: ClientContext): void;
export {};
