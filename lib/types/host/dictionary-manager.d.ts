/**
 * Atomic dictionary management and active reference lifecycle.
 *
 * This module is the seam between the host's lookup route and the underlying
 * queryable dictionary implementations (fixture or production corpus).
 *
 * Layering:
 *
 * ```text
 * route  →  Dictionary (interface)  →  DictionaryManager  →  active Dictionary
 * ```
 *
 * Responsibilities:
 * - Owns the lifecycle of the currently active dictionary handle.
 * - Implements {@link Dictionary} so the lookup handler retains a stable
 *   reference and does not need recreation on dictionary hot swap.
 * - Executes atomic active reference replacement: candidate dictionaries are
 *   opened and validated before activation; candidate reference commits before
 *   the retired dictionary is closed; no intermediate "no active dictionary" gap.
 * - Enforces fail-closed semantics: rejections do not mutate active state, and
 *   rejected candidate dictionaries are closed to prevent handle leaks.
 * - Enforces ownership invariants: reusing the currently active dictionary handle
 *   as an activation candidate is rejected as an ownership violation without
 *   closing the active dictionary or mutating manager state.
 * - Safely handles retirement close errors without rolling back committed state,
 *   preserving diagnostic error observability.
 *
 * @module dsh-word-lookup/host/dictionary-manager
 */
import type { DictionaryMode } from './config.js';
import { type Dictionary, type DictionaryLookup, type DictionarySource } from './dictionary.js';
/**
 * Descriptor passed to activate a new dictionary or construct the manager.
 */
export interface DictionaryActivation {
    /** Active dictionary operational mode. */
    readonly mode: DictionaryMode;
    /**
     * Opaque non-empty identifier for this dictionary activation.
     *
     * Must not be empty after trimming. Does not carry filesystem path semantics.
     */
    readonly identity: string;
    /**
     * An already-opened, fully-validated {@link Dictionary} instance.
     */
    readonly dictionary: Dictionary;
}
/**
 * Result returned upon committing an activation.
 */
export interface DictionaryActivationResult {
    /** Manager generation after the commit. */
    readonly generation: number;
    /** Outcome of retiring the previous dictionary handle. */
    readonly retirement: {
        /** True if the previous dictionary closed without error. */
        readonly closed: boolean;
        /** Error message if closing the previous dictionary failed, or `null`. */
        readonly error: string | null;
    };
}
/**
 * Diagnostic snapshot of the manager state.
 *
 * Returns an immutable plain object with no internal handles or paths.
 */
export interface DictionaryManagerSnapshot {
    /** Manager lifecycle state. */
    readonly lifecycle: 'ready' | 'closed';
    /** Monotonically increasing generation number, starting at 1. */
    readonly generation: number;
    /** Active dictionary operational mode. */
    readonly activeMode: DictionaryMode;
    /** Identifier of the active dictionary. */
    readonly identity: string;
    /** Source provenance of the active dictionary. */
    readonly source: DictionarySource;
    /** Last retirement close error message, or `null`. */
    readonly lastRetirementError: string | null;
}
/**
 * Manages active dictionary lifecycle and provides atomic hot switching.
 *
 * Implements {@link Dictionary} to present a stable queryable interface.
 */
export declare class DictionaryManager implements Dictionary {
    #private;
    /**
     * Create a new DictionaryManager with an initial dictionary.
     *
     * Once constructed, the manager assumes exclusive ownership of the dictionary handle.
     * If construction fails validation, the initial dictionary is closed to prevent leaks.
     *
     * @param initial - initial activation descriptor.
     */
    constructor(initial: DictionaryActivation);
    /**
     * Source provenance of the currently active dictionary.
     */
    get source(): DictionarySource;
    /**
     * Resolve one query against the currently active dictionary.
     *
     * Captures the active dictionary reference in a local variable to ensure
     * the lookup is bound to a single generation.
     *
     * @param normalizedQuery - normalized headword query.
     * @returns dictionary lookup result.
     * @throws {DictionaryUnavailableError} if the manager has been closed.
     */
    lookup(normalizedQuery: string): DictionaryLookup;
    /**
     * Atomically activate a new dictionary candidate.
     *
     * Candidate ownership contract:
     * - Distinct candidate:
     *   Ownership transfers to manager on activate() invocation.
     * - Aliased currently-active candidate:
     *   Rejected as an ownership violation (TypeError);
     *   remains manager-owned; must not be closed by rejection cleanup.
     *
     * Requirements:
     * - Candidate dictionary must already be opened and validated prior to calling `activate()`.
     * - If the manager is already closed, candidate is closed immediately and
     *   `DictionaryUnavailableError` is thrown.
     * - A candidate whose dictionary is identical to the currently active dictionary
     *   handle (`candidate.dictionary === this.#active.dictionary`) is rejected as an
     *   ownership violation before descriptor validation. The active handle is NOT closed,
     *   state and generation remain unchanged.
     * - Validates mode/source consistency and identity before mutating active state.
     * - On descriptor validation failure, distinct candidate is closed immediately
     *   to prevent handle leaks, leaving active state untouched.
     * - The new active reference commits before the retired dictionary is closed.
     * - If closing the retired dictionary throws, the new active dictionary remains committed,
     *   generation remains advanced, and the retirement failure is observable without rollback.
     *
     * @param candidate - candidate activation descriptor.
     * @returns structured activation result with generation and retirement status.
     * @throws {DictionaryUnavailableError} if manager is already closed.
     * @throws {TypeError} if candidate reuses the currently active dictionary handle,
     *   or if candidate descriptor is invalid.
     */
    activate(candidate: DictionaryActivation): DictionaryActivationResult;
    /**
     * Return an immutable diagnostic snapshot of manager state.
     */
    snapshot(): DictionaryManagerSnapshot;
    /**
     * Release the manager and close the currently active dictionary.
     *
     * Idempotent: safe to call multiple times.
     * Sets lifecycle state to closed before calling underlying close, ensuring
     * fail-closed semantics even if the underlying close throws.
     */
    close(): void;
}
