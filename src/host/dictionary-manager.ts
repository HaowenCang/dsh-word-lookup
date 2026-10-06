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

import type { DictionaryMode } from './config.js'
import {
  DictionaryUnavailableError,
  type Dictionary,
  type DictionaryLookup,
  type DictionarySource,
} from './dictionary.js'

/**
 * Descriptor passed to activate a new dictionary or construct the manager.
 */
export interface DictionaryActivation {
  /** Active dictionary operational mode. */
  readonly mode: DictionaryMode
  /**
   * Opaque non-empty identifier for this dictionary activation.
   *
   * Must not be empty after trimming. Does not carry filesystem path semantics.
   */
  readonly identity: string
  /**
   * An already-opened, fully-validated {@link Dictionary} instance.
   */
  readonly dictionary: Dictionary
}

/**
 * Result returned upon committing an activation.
 */
export interface DictionaryActivationResult {
  /** Manager generation after the commit. */
  readonly generation: number
  /** Outcome of retiring the previous dictionary handle. */
  readonly retirement: {
    /** True if the previous dictionary closed without error. */
    readonly closed: boolean
    /** Error message if closing the previous dictionary failed, or `null`. */
    readonly error: string | null
  }
}

/**
 * Diagnostic snapshot of the manager state.
 *
 * Returns an immutable plain object with no internal handles or paths.
 */
export interface DictionaryManagerSnapshot {
  /** Manager lifecycle state. */
  readonly lifecycle: 'ready' | 'closed'
  /** Monotonically increasing generation number, starting at 1. */
  readonly generation: number
  /** Active dictionary operational mode. */
  readonly activeMode: DictionaryMode
  /** Identifier of the active dictionary. */
  readonly identity: string
  /** Source provenance of the active dictionary. */
  readonly source: DictionarySource
  /** Last retirement close error message, or `null`. */
  readonly lastRetirementError: string | null
}

/**
 * Validate descriptor metadata and mode/source consistency.
 *
 * Throws on invalid descriptor.
 */
function validateDescriptor(descriptor: DictionaryActivation): {
  mode: DictionaryMode
  identity: string
  dictionary: Dictionary
} {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError('DictionaryActivation descriptor must be an object')
  }

  const { mode, identity, dictionary } = descriptor

  if (typeof identity !== 'string' || identity.trim().length === 0) {
    throw new TypeError('DictionaryActivation identity must be a non-empty string')
  }

  if (!dictionary || typeof dictionary.lookup !== 'function' || typeof dictionary.close !== 'function') {
    throw new TypeError('DictionaryActivation dictionary must implement Dictionary interface')
  }

  if (mode === 'fixture') {
    if (dictionary.source !== 'sqlite-fixture') {
      throw new Error(`mode "fixture" requires dictionary source "sqlite-fixture", received "${dictionary.source}"`)
    }
  } else if (mode === 'managed-ecdict' || mode === 'custom') {
    if (dictionary.source !== 'ecdict-local') {
      throw new Error(`mode "${mode}" requires dictionary source "ecdict-local", received "${dictionary.source}"`)
    }
  } else {
    throw new Error(`unsupported dictionary mode: "${String(mode)}"`)
  }

  return {
    mode,
    identity: identity.trim(),
    dictionary,
  }
}

/**
 * Manages active dictionary lifecycle and provides atomic hot switching.
 *
 * Implements {@link Dictionary} to present a stable queryable interface.
 */
export class DictionaryManager implements Dictionary {
  #active: {
    readonly mode: DictionaryMode
    readonly identity: string
    readonly dictionary: Dictionary
  }

  #generation: number = 1
  #closed: boolean = false
  #lastRetirementError: string | null = null

  /**
   * Create a new DictionaryManager with an initial dictionary.
   *
   * Once constructed, the manager assumes exclusive ownership of the dictionary handle.
   * If construction fails validation, the initial dictionary is closed to prevent leaks.
   *
   * @param initial - initial activation descriptor.
   */
  constructor(initial: DictionaryActivation) {
    try {
      const validated = validateDescriptor(initial)
      this.#active = validated
    } catch (error) {
      try {
        initial?.dictionary?.close?.()
      } catch {
        // swallow close error during constructor rejection
      }
      throw error
    }
  }

  /**
   * Source provenance of the currently active dictionary.
   */
  get source(): DictionarySource {
    return this.#active.dictionary.source
  }

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
  lookup(normalizedQuery: string): DictionaryLookup {
    if (this.#closed) {
      throw new DictionaryUnavailableError('dictionary manager has been closed')
    }
    const active = this.#active
    return active.dictionary.lookup(normalizedQuery)
  }

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
  activate(candidate: DictionaryActivation): DictionaryActivationResult {
    if (this.#closed) {
      try {
        candidate?.dictionary?.close?.()
      } catch {
        // swallow close error
      }
      throw new DictionaryUnavailableError('cannot activate dictionary: manager is closed')
    }

    if (candidate && typeof candidate === 'object' && candidate.dictionary === this.#active.dictionary) {
      throw new TypeError('DictionaryActivation cannot reuse the currently active dictionary handle')
    }

    let validated: { mode: DictionaryMode; identity: string; dictionary: Dictionary }
    try {
      validated = validateDescriptor(candidate)
    } catch (error) {
      try {
        candidate?.dictionary?.close?.()
      } catch {
        // swallow close error
      }
      throw error
    }

    const previous = this.#active
    this.#active = validated
    this.#generation += 1

    let retirementClosed = false
    let retirementError: string | null = null

    try {
      previous.dictionary.close()
      retirementClosed = true
      this.#lastRetirementError = null
    } catch (error) {
      retirementClosed = false
      retirementError = error instanceof Error ? error.message : String(error)
      this.#lastRetirementError = retirementError
    }

    return {
      generation: this.#generation,
      retirement: {
        closed: retirementClosed,
        error: retirementError,
      },
    }
  }

  /**
   * Return an immutable diagnostic snapshot of manager state.
   */
  snapshot(): DictionaryManagerSnapshot {
    return Object.freeze({
      lifecycle: this.#closed ? 'closed' : 'ready',
      generation: this.#generation,
      activeMode: this.#active.mode,
      identity: this.#active.identity,
      source: this.#active.dictionary.source,
      lastRetirementError: this.#lastRetirementError,
    })
  }

  /**
   * Release the manager and close the currently active dictionary.
   *
   * Idempotent: safe to call multiple times.
   * Sets lifecycle state to closed before calling underlying close, ensuring
   * fail-closed semantics even if the underlying close throws.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    const active = this.#active
    active.dictionary.close()
  }
}
