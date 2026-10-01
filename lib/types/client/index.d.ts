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
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client';
import type { ClientContext } from './contracts.js';
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
/** Local snapshot of the last observed selection. Never triggers a request. */
interface SelectionSnapshot {
    readonly present: boolean;
    readonly eligible: boolean;
    readonly text: string;
    /** Which surface the selection was last seen in, for diagnostics. */
    readonly at: number;
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
    /** The last observed selection snapshot. */
    selection(): SelectionSnapshot;
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
