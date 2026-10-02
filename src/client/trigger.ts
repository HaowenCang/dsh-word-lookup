/**
 * The automatic trigger gate.
 *
 * Phase 2 answered *what did the reader do*. This module answers the next
 * question — *may that be turned into a lookup, and has it already been?* — and
 * it answers it as a pure function over plain values, so the whole behaviour
 * matrix in `docs/06-test-matrix.md` is decided somewhere a unit test can reach
 * without a browser, a DOM or a network.
 *
 * Three boundaries are deliberate and each one is load-bearing:
 *
 * 1. **No DOM.** The gate never reads `document`, never re-reads the selection
 *    and never takes a `Range`. It consumes the selection facts the runtime
 *    captured *at the moment the gesture completed* — Phase 0 §7.4 measured that
 *    a drag's selection can be collapsed again within ~250 ms of `pointerup`, so
 *    a late read is not equivalent to this one.
 * 2. **No I/O.** Nothing here calls `fetch`, the transport or the runtime's
 *    lookup path; the gate returns a decision value and the caller acts on it.
 *    A `selectionchange` handler has no way to reach the network through this
 *    module, because there is nothing here to reach it with.
 * 3. **No clock, no text, no geometry.** The one fact that de-duplicates a
 *    gesture is its identity. Deciding "duplicate" from `same text within
 *    300 ms` would swallow a reader deliberately double-clicking the same word
 *    twice, and deciding it from rectangle equality would mis-identify a
 *    gesture the moment the transcript reflowed or the page scrolled.
 *
 * What it *does* consume about a gesture is a closed list of platform facts: the
 * kind the classifier reached, the pointer kind that produced it, the
 * platform's own click multiplicity for the press, and the selection captured
 * with it. Every one of those is either measured in a real browser or refused —
 * never guessed at.
 *
 * The two switches are read as values on every evaluation rather than captured
 * once, so a settings change takes effect on the reader's next gesture with no
 * reload: see {@link TriggerGates}.
 *
 * @module dsh-word-lookup/client/trigger
 */

import type { GestureClassification } from './gesture.js'
import type { SelectionRect } from './selection.js'

/**
 * Which path asked for a lookup.
 *
 * The origin never crosses the wire. The host has no use for it — it would put
 * an interaction concern into a route whose only job is to answer a query — so
 * it lives in client state and in the tests, and the HTTP contract is unchanged
 * by Phase 4.
 */
export type LookupOrigin = 'shortcut' | 'auto-selection' | 'auto-double-click'

/** The two switches, as the gate reads them at evaluation time. */
export interface TriggerGates {
  /** `Config.autoDoubleClick`: a completed double click may look itself up. */
  readonly autoDoubleClick: boolean
  /** `Config.autoSelection`: a completed drag selection may look itself up. */
  readonly autoSelection: boolean
}

/**
 * The selection facts captured when a gesture completed.
 *
 * Pure data by construction: the runtime projects the live `Selection` and
 * `Range` onto this value *inside* the classifying event handler and drops the
 * DOM handles immediately, so no `Range`, `Node` or `Selection` object outlives
 * the event that produced it.
 */
export interface TriggerSelection {
  /** Whether the selection passed every qualification rule at capture time. */
  readonly eligible: boolean
  /** The captured text. Raw; the host normalizes it authoritatively. */
  readonly text: string
  /** The live geometry at capture time; positioning metadata, never identity. */
  readonly rect: SelectionRect | null
}

/** A capture that found nothing usable. Frozen because it is the shared literal. */
export const EMPTY_SELECTION: TriggerSelection = Object.freeze({ eligible: false, text: '', rect: null })

/** Everything one automatic evaluation is allowed to depend on. */
export interface AutomaticTriggerInput {
  /** The classification just completed, or `null` when nothing completed. */
  readonly classification: GestureClassification | null
  /** The selection captured at the moment that classification completed. */
  readonly selection: TriggerSelection
}

/**
 * Why an automatic evaluation ended the way it did.
 *
 * Every value is a distinct, checkable reason, so "no request happened" can be
 * told apart from "the gate never ran": `switch-off` is the gate working, and an
 * absent reason would be the gate missing.
 */
export type TriggerReason =
  | 'accepted'
  | 'no-classification'
  | 'not-a-trigger-gesture'
  | 'duplicate-gesture'
  | 'switch-off'
  | 'unverified-pointer-kind'
  | 'multi-click-sequence'
  | 'unverified-click-multiplicity'
  | 'ineligible-selection'

/**
 * The identities already consumed, most recent first.
 *
 * A bounded ring rather than a single `lastConsumedId`: a ring tolerates the
 * events arriving in an order the runtime did not anticipate, while one scalar
 * would silently accept a repeat. {@link LEDGER_CAPACITY} is far larger than the
 * number of gestures that can be in flight at once — a gesture is consumed
 * within the event that completes it — and far smaller than anything that could
 * grow without bound.
 */
export interface TriggerLedger {
  readonly consumed: readonly number[]
}

/** How many identities the ledger remembers. */
export const LEDGER_CAPACITY = 32

/** The ledger before any gesture has been consumed. */
export const EMPTY_LEDGER: TriggerLedger = Object.freeze({ consumed: Object.freeze([]) })

/**
 * Whether an identity has already produced an automatic lookup.
 *
 * @param ledger - the consumption record.
 * @param gestureId - the identity to test.
 * @returns whether it was already consumed.
 */
export function isConsumed(ledger: TriggerLedger, gestureId: number): boolean {
  return ledger.consumed.includes(gestureId)
}

/**
 * Record one identity as consumed, keeping the record bounded.
 *
 * @param ledger - the consumption record.
 * @param gestureId - the identity to record.
 * @returns the next record.
 */
export function consumeGesture(ledger: TriggerLedger, gestureId: number): TriggerLedger {
  return { consumed: [gestureId, ...ledger.consumed].slice(0, LEDGER_CAPACITY) }
}

/** What the gate decided, plus the state the caller must carry forward. */
export interface TriggerDecision {
  /** Whether the caller should issue a lookup. */
  readonly decision: 'lookup' | 'ignored'
  /** Why. `accepted` exactly when {@link TriggerDecision.decision} is `lookup`. */
  readonly reason: TriggerReason
  /** Which automatic path asked, or `null` when nothing was asked. */
  readonly origin: LookupOrigin | null
  /** The captured text to look up; empty when nothing was accepted. */
  readonly query: string
  /** Identity of the gesture the decision is about; `0` when there was none. */
  readonly gestureId: number
  /** The record to carry into the next evaluation. */
  readonly ledger: TriggerLedger
}

/**
 * Decide whether a completed gesture may become an automatic lookup.
 *
 * The order of the checks is part of the contract:
 *
 * 1. a classification has to exist at all;
 * 2. only `drag` and `double-click` are trigger gestures — a plain click is
 *    `other` and must never become one, which is what keeps a single click from
 *    reaching the dictionary;
 * 3. an identity already consumed stays consumed, whatever the switches say,
 *    so one gesture can never buy two lookups;
 * 4. the switch that owns this gesture must be on **now** — read from the value
 *    passed in, never from a value captured at plugin load;
 * 5. the pointer kind must be one this build has measured. Phase 4 verified
 *    `mouse`; `pen`, `touch` and an unidentifiable pointer are refused rather
 *    than guessed at, because an unverified gesture type must not produce
 *    automatic I/O;
 * 6. an `auto-selection` lookup additionally requires the platform's own click
 *    counter to say the press was a **single** click. This is step 6 rather than
 *    an earlier one on purpose: a `drag` classification is a movement fact, and
 *    only the drag path cares whose press it was. A `double-click`
 *    classification is the platform's own recognition and is answered by its own
 *    switch;
 * 7. the selection captured at completion must be eligible and non-empty.
 *
 * Step 6 is what keeps the two switches semantically independent. A double click
 * whose second press drifted past the drag threshold is still classified `drag`
 * by movement, and the platform still reports it as a multi-click press; without
 * this check the drag path would consume the identity, and the `dblclick` that
 * followed — the platform's own, unambiguous recognition of the gesture the
 * reader made — would be refused as a duplicate of it. The reader asked for
 * `autoDoubleClick` semantics and would have got `autoSelection`'s.
 *
 * The refusal is deliberately the *safe* direction in the ambiguous cases: a
 * press reported as part of a multi-click sequence that never completes one
 * produces no automatic lookup at all, and neither does a press whose
 * multiplicity was never observed. (Phase 4.1 measured that this Chromium emits
 * its `dblclick` from the press's click count, so the first shape is hard to
 * produce through automation input; the rule exists for the platforms and input
 * paths where it is not.) A missed automatic lookup is recoverable with the
 * manual command; an unexpected one is the thing both switches exist to
 * prevent.
 *
 * A refusal never consumes the identity unless it was already consumed. That is
 * what lets `autoSelection` be switched on and the *next* drag work, and it is
 * why a double click whose second release was classified as `other` is still
 * free to be consumed by its own `dblclick`.
 *
 * @param input - the classification and the selection captured with it.
 * @param gates - the switch values as they are right now.
 * @param ledger - the identities consumed so far.
 * @returns the decision and the ledger to carry forward.
 */
export function evaluateAutomaticTrigger(
  input: AutomaticTriggerInput,
  gates: TriggerGates,
  ledger: TriggerLedger,
): TriggerDecision {
  const classification = input.classification
  if (classification === null) {
    return { decision: 'ignored', reason: 'no-classification', origin: null, query: '', gestureId: 0, ledger }
  }

  const gestureId = classification.id
  const origin: LookupOrigin | null =
    classification.kind === 'drag'
      ? 'auto-selection'
      : classification.kind === 'double-click'
        ? 'auto-double-click'
        : null

  if (origin === null) {
    return { decision: 'ignored', reason: 'not-a-trigger-gesture', origin: null, query: '', gestureId, ledger }
  }
  if (isConsumed(ledger, gestureId)) {
    return { decision: 'ignored', reason: 'duplicate-gesture', origin: null, query: '', gestureId, ledger }
  }

  const enabled = origin === 'auto-selection' ? gates.autoSelection : gates.autoDoubleClick
  if (!enabled) {
    return { decision: 'ignored', reason: 'switch-off', origin: null, query: '', gestureId, ledger }
  }
  if (classification.pointerType !== 'mouse') {
    return { decision: 'ignored', reason: 'unverified-pointer-kind', origin: null, query: '', gestureId, ledger }
  }
  if (origin === 'auto-selection' && classification.clickMultiplicity !== 'single') {
    return {
      decision: 'ignored',
      reason: classification.clickMultiplicity === 'multi' ? 'multi-click-sequence' : 'unverified-click-multiplicity',
      origin: null,
      query: '',
      gestureId,
      ledger,
    }
  }

  const selection = input.selection
  if (!selection.eligible || selection.text.trim() === '') {
    return { decision: 'ignored', reason: 'ineligible-selection', origin: null, query: '', gestureId, ledger }
  }

  return {
    decision: 'lookup',
    reason: 'accepted',
    origin,
    query: selection.text,
    gestureId,
    ledger: consumeGesture(ledger, gestureId),
  }
}
