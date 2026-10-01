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
 *   gesture into drag / double-click / other, and record it locally.
 *
 * It deliberately does **not** contribute: any automatic trigger, any dictionary
 * UI, any lookup history, or any model call.
 *
 * The I/O invariant is the one thing in this file that must stay obvious:
 *
 * ```text
 * selectionchange  -> local snapshot only
 * pointer events   -> local gesture state only
 * dblclick         -> local gesture state only
 * shortcut run     -> the only call site of runLookup
 * ```
 *
 * Classification exists so that a later phase *can* gate the two automatic
 * switches on a real gesture. Phase 2 does not act on the classification: both
 * switches remain inert however they are set, and a drag or a double click
 * still produces zero requests.
 *
 * @module dsh-word-lookup/client
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client';
import type { ClientContext } from './contracts.js';
import { type GestureCounters, type GestureSnapshot } from './gesture.js';
import { type SelectionRect } from './selection.js';
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
 * `false` for either field means the corresponding automatic trigger is off. In
 * Phase 1 the mirror is read and republished but drives nothing: the automatic
 * paths do not exist yet, and the manual command is deliberately not gated by
 * them.
 */
export interface LookupGates {
    /** Mirror value of `Config.autoDoubleClick`. */
    readonly autoDoubleClick: boolean;
    /** Mirror value of `Config.autoSelection`. */
    readonly autoSelection: boolean;
}
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
    /** How many lookups this plugin has issued since page load. */
    lookups(): number;
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
