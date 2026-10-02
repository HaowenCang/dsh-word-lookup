/**
 * The automatic trigger gate.
 *
 * This is Phase 4's core contract, and it is asserted as a truth table over
 * plain values rather than through a browser: the four-state settings matrix,
 * the "one gesture, one lookup" rule and the "two gestures, two lookups" rule are
 * all decided by `evaluateAutomaticTrigger`, so they are covered here and
 * re-measured in a real Chromium by `scripts/phase1-verify.mjs`.
 *
 * The cases that matter most are the ones a careless implementation passes by
 * accident:
 *
 * - a refusal must not consume the identity, or switching a switch on would
 *   leave the first gesture after the change permanently unable to fire;
 * - a repeat must be refused by **identity**, not by text or by a time window,
 *   or a reader double-clicking the same word twice would only ever get one
 *   lookup;
 * - `other` (a plain click) must never become a trigger, or a single click would
 *   reach the dictionary.
 */

import { describe, expect, it } from 'vitest'

import type { GestureClassification } from '../src/client/gesture.js'
import {
  consumeGesture,
  EMPTY_LEDGER,
  evaluateAutomaticTrigger,
  isConsumed,
  LEDGER_CAPACITY,
  type AutomaticTriggerInput,
  type TriggerGates,
  type TriggerReason,
  type TriggerSelection,
} from '../src/client/trigger.js'

/** A pointer position with the time it was observed. */
function classification(
  id: number,
  kind: GestureClassification['kind'],
  overrides: Partial<GestureClassification> = {},
): GestureClassification {
  // `single` by default: every case below is about a press the platform reported
  // as a first click, which is what a real drag carries. The multi-click cases
  // say so explicitly.
  return { id, kind, pointerType: 'mouse', clickMultiplicity: 'single', at: 1000 + id, ...overrides }
}

/** A selection that passed qualification. */
function eligible(text = 'derive'): TriggerSelection {
  return { eligible: true, text, rect: { x: 10, y: 20, width: 42, height: 17 } }
}

/** The four switch states, named the way the test matrix names them. */
const S00: TriggerGates = { autoSelection: false, autoDoubleClick: false }
const S10: TriggerGates = { autoSelection: true, autoDoubleClick: false }
const S01: TriggerGates = { autoSelection: false, autoDoubleClick: true }
const S11: TriggerGates = { autoSelection: true, autoDoubleClick: true }

/** Evaluate one ticket against a state and a ledger. */
function evaluate(input: AutomaticTriggerInput, gates: TriggerGates, ledger = EMPTY_LEDGER) {
  return evaluateAutomaticTrigger(input, gates, ledger)
}

describe('the switch decides, and only its own gesture', () => {
  it('refuses both gestures with both switches off', () => {
    const drag = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S00)
    const double = evaluate({ classification: classification(2, 'double-click'), selection: eligible() }, S00)
    expect(drag).toMatchObject({ decision: 'ignored', reason: 'switch-off', origin: null })
    expect(double).toMatchObject({ decision: 'ignored', reason: 'switch-off', origin: null })
  })

  it('accepts a drag and refuses a double click with autoSelection alone', () => {
    const drag = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S10)
    const double = evaluate({ classification: classification(2, 'double-click'), selection: eligible() }, S10)
    expect(drag).toMatchObject({ decision: 'lookup', reason: 'accepted', origin: 'auto-selection', query: 'derive' })
    expect(double).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
  })

  it('accepts a double click and refuses a drag with autoDoubleClick alone', () => {
    const drag = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S01)
    const double = evaluate({ classification: classification(2, 'double-click'), selection: eligible() }, S01)
    expect(drag).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
    expect(double).toMatchObject({
      decision: 'lookup',
      reason: 'accepted',
      origin: 'auto-double-click',
      query: 'derive',
    })
  })

  it('accepts each gesture once with both switches on, and never more than once', () => {
    let ledger = EMPTY_LEDGER
    const drag = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S11, ledger)
    ledger = drag.ledger
    const double = evaluate({ classification: classification(2, 'double-click'), selection: eligible() }, S11, ledger)
    ledger = double.ledger

    expect(drag).toMatchObject({ decision: 'lookup', origin: 'auto-selection' })
    expect(double).toMatchObject({ decision: 'lookup', origin: 'auto-double-click' })
    expect(ledger.consumed).toEqual([2, 1])
  })

  it('answers a double click through the double-click path only, so the two switches do not add up', () => {
    // The case the brief calls out: with both switches on a single double click
    // must be exactly one lookup, not one per switch. The gate cannot produce
    // two, because one classification yields one origin.
    const decision = evaluate({ classification: classification(7, 'double-click'), selection: eligible() }, S11)
    expect(decision.decision).toBe('lookup')
    expect(decision.origin).toBe('auto-double-click')
    expect(decision.origin).not.toBe('auto-selection')
  })
})

describe('one gesture cannot be consumed twice', () => {
  it('refuses a repeated identity with duplicate-gesture', () => {
    const first = evaluate({ classification: classification(5, 'drag'), selection: eligible() }, S10)
    const second = evaluate({ classification: classification(5, 'drag'), selection: eligible() }, S10, first.ledger)
    expect(first).toMatchObject({ decision: 'lookup' })
    expect(second).toMatchObject({ decision: 'ignored', reason: 'duplicate-gesture', origin: null })
  })

  it('refuses a repeated identity however the selection changed in between', () => {
    // A trailing selectionchange may leave a different selection behind. Identity
    // must still be the only thing that decides, so a re-evaluated classification
    // is refused even when it now carries different text and a different rect.
    const first = evaluate({ classification: classification(5, 'drag'), selection: eligible('derive') }, S10)
    const second = evaluate(
      {
        classification: classification(5, 'drag'),
        selection: { eligible: true, text: 'something else', rect: { x: 900, y: 900, width: 1, height: 1 } },
      },
      S10,
      first.ledger,
    )
    expect(second).toMatchObject({ decision: 'ignored', reason: 'duplicate-gesture' })
  })

  it('allows the same text again under a new identity', () => {
    const first = evaluate({ classification: classification(5, 'drag'), selection: eligible('derive') }, S10)
    const second = evaluate({ classification: classification(6, 'drag'), selection: eligible('derive') }, S10, first.ledger)
    expect(second).toMatchObject({ decision: 'lookup', origin: 'auto-selection', query: 'derive' })
    expect(second.ledger.consumed).toEqual([6, 5])
  })

  it('never lets geometry or text stand in for identity', () => {
    // Two gestures over the very same characters, at the very same instant, with
    // the very same rectangle: this is what a text-and-time de-duplicator would
    // collapse into one lookup, and it must stay two.
    const rect = { x: 100, y: 200, width: 42, height: 17 }
    const selection: TriggerSelection = { eligible: true, text: 'derive', rect }
    const first = evaluate({ classification: classification(11, 'double-click', { at: 5000 }), selection }, S01)
    const second = evaluate(
      { classification: classification(12, 'double-click', { at: 5000 }), selection },
      S01,
      first.ledger,
    )
    expect(first.decision).toBe('lookup')
    expect(second.decision).toBe('lookup')
  })

  it('keeps the ledger bounded, and the oldest identity falls out first', () => {
    let ledger = EMPTY_LEDGER
    for (let id = 1; id <= LEDGER_CAPACITY + 8; id += 1) ledger = consumeGesture(ledger, id)
    expect(ledger.consumed).toHaveLength(LEDGER_CAPACITY)
    expect(isConsumed(ledger, LEDGER_CAPACITY + 8)).toBe(true)
    expect(isConsumed(ledger, 1)).toBe(false)
  })

  it('does not grow the ledger from a refusal', () => {
    const decision = evaluate({ classification: classification(5, 'drag'), selection: eligible() }, S00)
    expect(decision.ledger).toBe(EMPTY_LEDGER)
  })
})

describe('only a real gesture qualifies', () => {
  it('refuses when nothing was classified at all', () => {
    const decision = evaluate({ classification: null, selection: eligible() }, S11)
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'no-classification', gestureId: 0 })
  })

  it('never treats a plain click as a trigger', () => {
    for (const gates of [S00, S10, S01, S11]) {
      const decision = evaluate({ classification: classification(3, 'other'), selection: eligible() }, gates)
      expect(decision).toMatchObject({ decision: 'ignored', reason: 'not-a-trigger-gesture' })
    }
  })

  it('refuses an unclassified kind even when an identity exists', () => {
    const decision = evaluate({ classification: classification(3, 'none'), selection: eligible() }, S11)
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'not-a-trigger-gesture' })
  })
})

describe('a multi-click press never buys an auto-selection lookup', () => {
  it('refuses a drag whose press the platform reported as a second click', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag', { clickMultiplicity: 'multi' }), selection: eligible() },
      S10,
    )
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'multi-click-sequence', origin: null })
    expect(decision.ledger).toBe(EMPTY_LEDGER)
  })

  it('refuses a drag whose press multiplicity was never observed', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag', { clickMultiplicity: 'unknown' }), selection: eligible() },
      S10,
    )
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'unverified-click-multiplicity', origin: null })
    expect(decision.ledger).toBe(EMPTY_LEDGER)
  })

  it('lets the double click the same press belongs to through, on its own switch', () => {
    // The identity was refused, not consumed, so the platform's own recognition
    // of the gesture is still answered — and by the switch that owns it.
    const refused = evaluate(
      { classification: classification(7, 'drag', { clickMultiplicity: 'multi' }), selection: eligible() },
      S11,
    )
    const accepted = evaluate(
      { classification: classification(7, 'double-click', { clickMultiplicity: 'multi' }), selection: eligible() },
      S11,
      refused.ledger,
    )
    expect(accepted).toMatchObject({ decision: 'lookup', origin: 'auto-double-click', query: 'derive' })
    expect(accepted.ledger.consumed).toEqual([7])
  })

  it('never applies the rule to the double-click path', () => {
    // A `double-click` classification is the platform's own recognition; it is
    // answered by its own switch whatever the press counter said, including
    // `unknown` for a `dblclick` delivered with no pointer events at all.
    for (const clickMultiplicity of ['single', 'multi', 'unknown'] as const) {
      const decision = evaluate(
        { classification: classification(2, 'double-click', { clickMultiplicity }), selection: eligible() },
        S01,
      )
      expect(decision, clickMultiplicity).toMatchObject({ decision: 'lookup', origin: 'auto-double-click' })
    }
  })

  it('reports the switch first and the pointer kind second, so each refusal keeps its own name', () => {
    const off = evaluate(
      { classification: classification(1, 'drag', { clickMultiplicity: 'multi' }), selection: eligible() },
      S00,
    )
    const unverifiedPointer = evaluate(
      {
        classification: classification(2, 'drag', { clickMultiplicity: 'multi', pointerType: 'touch' }),
        selection: eligible(),
      },
      S11,
    )
    expect(off.reason).toBe('switch-off')
    expect(unverifiedPointer.reason).toBe('unverified-pointer-kind')
  })

  it('holds the four-state matrix for a multi-click drag, state by state', () => {
    for (const gates of [S00, S10, S01, S11]) {
      const decision = evaluate(
        { classification: classification(1, 'drag', { clickMultiplicity: 'multi' }), selection: eligible() },
        gates,
      )
      expect(decision.decision, JSON.stringify(gates)).toBe('ignored')
      expect(decision.origin).toBeNull()
    }
  })

  it('accepts the one press kind a drag may come from', () => {
    for (const gates of [S10, S11]) {
      const decision = evaluate(
        { classification: classification(1, 'drag', { clickMultiplicity: 'single' }), selection: eligible() },
        gates,
      )
      expect(decision).toMatchObject({ decision: 'lookup', origin: 'auto-selection' })
    }
  })
})

describe('selection eligibility is the product rule, applied to the snapshot', () => {
  it('refuses an ineligible capture', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag'), selection: { eligible: false, text: 'derive', rect: null } },
      S10,
    )
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'ineligible-selection' })
  })

  it('refuses a capture with no text', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag'), selection: { eligible: true, text: '', rect: null } },
      S10,
    )
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'ineligible-selection' })
  })

  it('refuses a capture that is only whitespace', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag'), selection: { eligible: true, text: '  \n ', rect: null } },
      S10,
    )
    expect(decision).toMatchObject({ decision: 'ignored', reason: 'ineligible-selection' })
  })

  it('passes the raw text through rather than normalizing it', () => {
    // Normalization belongs to the host, which does it authoritatively and is
    // tested for it. A second implementation here is how the two halves drift.
    const decision = evaluate(
      { classification: classification(1, 'drag'), selection: eligible('  Wave   Function. ') },
      S10,
    )
    expect(decision.query).toBe('  Wave   Function. ')
  })

  it('does not consume the identity of an ineligible gesture', () => {
    const refused = evaluate(
      { classification: classification(4, 'drag'), selection: { eligible: false, text: '', rect: null } },
      S10,
    )
    const retried = evaluate({ classification: classification(4, 'drag'), selection: eligible() }, S10, refused.ledger)
    expect(retried).toMatchObject({ decision: 'lookup' })
  })
})

describe('unverified pointer kinds produce no automatic I/O', () => {
  for (const pointerType of ['touch', 'pen', 'unknown'] as const) {
    it(`refuses a ${pointerType} gesture on both automatic paths`, () => {
      const drag = evaluate(
        { classification: classification(1, 'drag', { pointerType }), selection: eligible() },
        S10,
      )
      const double = evaluate(
        { classification: classification(2, 'double-click', { pointerType }), selection: eligible() },
        S01,
      )
      expect(drag).toMatchObject({ decision: 'ignored', reason: 'unverified-pointer-kind' })
      expect(double).toMatchObject({ decision: 'ignored', reason: 'unverified-pointer-kind' })
    })
  }

  it('does not consume the identity of a refused pointer kind', () => {
    const refused = evaluate(
      { classification: classification(9, 'drag', { pointerType: 'touch' }), selection: eligible() },
      S10,
    )
    expect(refused.ledger).toBe(EMPTY_LEDGER)
  })

  it('accepts the one pointer kind this build measured', () => {
    const decision = evaluate(
      { classification: classification(1, 'drag', { pointerType: 'mouse' }), selection: eligible() },
      S10,
    )
    expect(decision.decision).toBe('lookup')
  })
})

describe('the switches are read at evaluation time, never captured', () => {
  it('lets the next gesture through after a switch is turned on', () => {
    const off = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S00)
    expect(off).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
    const on = evaluate({ classification: classification(2, 'drag'), selection: eligible() }, S10, off.ledger)
    expect(on).toMatchObject({ decision: 'lookup' })
  })

  it('refuses the next gesture after a switch is turned off again', () => {
    const on = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S10)
    const off = evaluate({ classification: classification(2, 'drag'), selection: eligible() }, S00, on.ledger)
    expect(off).toMatchObject({ decision: 'ignored', reason: 'switch-off' })
  })

  it('does not consume an identity it refused for a switched-off path', () => {
    // The identity of a gesture the switch refused stays unconsumed, so a later
    // evaluation of that same gesture (a repeated classification event, say) is
    // still refused — but for the switch, not as a duplicate. Nothing was
    // consumed, which is the property the ledger has to preserve.
    const refused = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, S00)
    expect(refused.ledger.consumed).toEqual([])
  })
})

describe('the four-state matrix, as a table', () => {
  /** One row per state, with what each gesture must produce. */
  const MATRIX: readonly {
    readonly name: string
    readonly gates: TriggerGates
    readonly drag: TriggerReason
    readonly double: TriggerReason
  }[] = [
    { name: 'S00', gates: S00, drag: 'switch-off', double: 'switch-off' },
    { name: 'S10', gates: S10, drag: 'accepted', double: 'switch-off' },
    { name: 'S01', gates: S01, drag: 'switch-off', double: 'accepted' },
    { name: 'S11', gates: S11, drag: 'accepted', double: 'accepted' },
  ]

  for (const row of MATRIX) {
    it(`${row.name}: a drag reasons "${row.drag}" and a double click reasons "${row.double}"`, () => {
      const drag = evaluate({ classification: classification(1, 'drag'), selection: eligible() }, row.gates)
      const double = evaluate({ classification: classification(2, 'double-click'), selection: eligible() }, row.gates, drag.ledger)
      expect(drag.reason).toBe(row.drag)
      expect(double.reason).toBe(row.double)
    })
  }

  it('S11 over 100 drags and 100 double clicks yields exactly 200 lookups', () => {
    let ledger = EMPTY_LEDGER
    let lookups = 0
    const origins = { 'auto-selection': 0, 'auto-double-click': 0, shortcut: 0 }
    for (let index = 0; index < 100; index += 1) {
      const drag = evaluate({ classification: classification(index * 2 + 1, 'drag'), selection: eligible() }, S11, ledger)
      ledger = drag.ledger
      if (drag.decision === 'lookup' && drag.origin !== null) {
        lookups += 1
        origins[drag.origin] += 1
      }
      const double = evaluate(
        { classification: classification(index * 2 + 2, 'double-click'), selection: eligible() },
        S11,
        ledger,
      )
      ledger = double.ledger
      if (double.decision === 'lookup' && double.origin !== null) {
        lookups += 1
        origins[double.origin] += 1
      }
    }
    expect(lookups).toBe(200)
    expect(origins['auto-selection']).toBe(100)
    expect(origins['auto-double-click']).toBe(100)
  })

  it('S00 over 100 drags and 100 double clicks yields nothing and consumes nothing', () => {
    let ledger = EMPTY_LEDGER
    let lookups = 0
    for (let index = 0; index < 100; index += 1) {
      const drag = evaluate({ classification: classification(index * 2 + 1, 'drag'), selection: eligible() }, S00, ledger)
      ledger = drag.ledger
      const double = evaluate(
        { classification: classification(index * 2 + 2, 'double-click'), selection: eligible() },
        S00,
        ledger,
      )
      ledger = double.ledger
      if (drag.decision === 'lookup') lookups += 1
      if (double.decision === 'lookup') lookups += 1
    }
    expect(lookups).toBe(0)
    expect(ledger.consumed).toEqual([])
  })
})
