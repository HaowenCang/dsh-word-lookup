/**
 * Gesture identity: which sequence a verdict belongs to, and when an identity
 * may be reused.
 *
 * Phase 4 de-duplicates automatic lookups by identity, so the identity has to be
 * sound in two directions that are easy to get wrong and hard to notice:
 *
 * ```text
 * a verdict must never be offered under an identity it was not produced for
 * a new gesture must never reuse an identity that is already spent
 * ```
 *
 * The first is what stops a stray release 鈥?a window that lost focus mid-drag, a
 * right-button release, a synthetic event 鈥?from re-offering the previous
 * gesture's verdict under a fresh identity and buying a lookup for a gesture that
 * never happened. The second is what stops two separate platform gestures from
 * collapsing into one lookup.
 *
 * Every case below is a pure state relation: no DOM, no clock, no I/O.
 */

import { describe, expect, it } from 'vitest'

import {
  beginPointer,
  cancelGesture,
  classificationOf,
  endPointer,
  IDLE_GESTURE,
  observeCancel,
  observeDoubleClick,
  observePointerDown,
  observePointerMove,
  observePointerUp,
  registerDoubleClick,
  type GestureCounters,
  type GestureObservation,
  type GestureState,
} from '../src/client/gesture.js'

/** The zero counters, spelled out so the fold cases below stay readable. */
const ZERO_COUNTERS: GestureCounters = Object.freeze({
  pointerdowns: 0,
  pointerups: 0,
  mouseDowns: 0,
  drags: 0,
  doubleClicks: 0,
  doubleClickGestures: 0,
  simpleGestures: 0,
  cancels: 0,
})

/** A pointer position at a fixed instant. */
function at(x: number, y: number, time = 1000) {
  return { x, y, at: time }
}

/** Replay one complete drag and return the state it left. */
function drag(): GestureState {
  const state = beginPointer(IDLE_GESTURE, at(100, 100, 1000))
  return endPointer(state, at(140, 100, 1010), true)
}

/** Wrap a state as the observation the folds consume. */
function observation(state: GestureState): GestureObservation {
  return { state, counters: ZERO_COUNTERS }
}

describe('a verdict is offered under the identity it was produced for', () => {
  it('offers nothing before any gesture', () => {
    expect(classificationOf(IDLE_GESTURE)).toBeNull()
  })

  it('offers the drag with the identity of the press that produced it', () => {
    const state = drag()
    expect(state.gestureId).toBe(1)
    expect(classificationOf(state)).toEqual({
      id: 1,
      kind: 'drag',
      pointerType: 'unknown',
      clickMultiplicity: 'unknown',
      at: 1010,
    })
  })

  it('offers nothing while a press is in flight, even though the previous verdict is still readable', () => {
    // The defect this asserts against: `beginPointer` allocates a new identity
    // while `kind`/`completedAt` still describe the previous gesture, so reading
    // the identity off the state would pair them.
    const afterDrag = drag()
    const pressed = beginPointer(afterDrag, at(300, 300, 2000))
    expect(pressed.gestureId).toBe(2)
    expect(pressed.kind).toBe('drag')
    expect(classificationOf(pressed)).toBeNull()
  })

  it('offers nothing after a press is abandoned', () => {
    let state = drag()
    state = beginPointer(state, at(300, 300, 2000))
    state = cancelGesture(state)
    expect(state.kind).toBe('drag')
    expect(classificationOf(state)).toBeNull()
  })

  it('never re-offers the previous verdict after a cancelled press', () => {
    let state = drag()
    state = beginPointer(state, at(300, 300, 2000))
    const cancelled = observeCancel(observation(state))
    // A release that closes nothing: the fold returns the state untouched, so the
    // runtime offers nothing and no identity is spent.
    const released = observePointerUp(cancelled, at(300, 300, 2010), true)
    expect(released.state).toBe(cancelled.state)
    expect(classificationOf(released.state)).toBeNull()
  })
})

describe('identity reuse across a double click', () => {
  it('reuses the second press鈥檚 identity when the platform promotes it', () => {
    let state = beginPointer(IDLE_GESTURE, at(200, 200, 2000))
    state = endPointer(state, at(200, 200, 2003), false)
    state = beginPointer(state, at(200, 200, 2100))
    state = endPointer(state, at(200, 200, 2103), true)
    const secondId = state.gestureId
    state = registerDoubleClick(state, at(200, 200, 2110), true)
    expect(state.gestureId).toBe(secondId)
    expect(classificationOf(state)).toEqual({
      id: secondId,
      kind: 'double-click',
      pointerType: 'unknown',
      clickMultiplicity: 'unknown',
      at: 2110,
    })
  })

  it('allocates a fresh identity when it promotes nothing', () => {
    const first = registerDoubleClick(IDLE_GESTURE, at(10, 10, 100), true)
    expect(first.gestureId).toBe(1)

    // A second platform double click with no pointer events at all: it is a
    // second gesture, so it must be a second identity rather than a duplicate of
    // the first.
    const second = registerDoubleClick(first, at(10, 10, 200), true)
    expect(second.gestureId).toBe(2)
    expect(classificationOf(second)?.id).toBe(2)
  })

  it('does not reuse the previous double click鈥檚 identity a third time', () => {
    let state = registerDoubleClick(IDLE_GESTURE, at(10, 10, 100), true)
    const ids = [state.gestureId]
    for (let index = 0; index < 4; index += 1) {
      state = registerDoubleClick(state, at(10, 10, 100 + index), true)
      ids.push(state.gestureId)
    }
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })

  it('promotes an open press even when no release was folded', () => {
    const pressed = beginPointer(IDLE_GESTURE, at(50, 50, 10))
    const state = registerDoubleClick(pressed, at(50, 50, 20), true)
    expect(state.gestureId).toBe(1)
    expect(state.sequence).toBe(1)
  })

  it('clears the promotion flag so a later stray double click is not absorbed', () => {
    let state = registerDoubleClick(IDLE_GESTURE, at(10, 10, 100), true)
    expect(state.promotable).toBe(false)
    state = registerDoubleClick(state, at(10, 10, 200), true)
    expect(state.promotable).toBe(false)
  })
})

describe('identities are never reused', () => {
  it('allocates a distinct identity for every press', () => {
    let state: GestureState = IDLE_GESTURE
    const ids: number[] = []
    for (let index = 0; index < 5; index += 1) {
      state = beginPointer(state, at(index, 0, index * 10))
      ids.push(state.gestureId)
      state = endPointer(state, at(index, 0, index * 10 + 1), true)
    }
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })

  it('does not free an identity when a gesture is cancelled', () => {
    let state = beginPointer(IDLE_GESTURE, at(0, 0, 1))
    state = cancelGesture(state)
    state = beginPointer(state, at(0, 0, 2))
    expect(state.gestureId).toBe(2)
  })

  it('does not rewind the allocator when a verdict is dropped', () => {
    let state = drag()
    state = beginPointer(state, at(0, 0, 5000))
    state = cancelGesture(state)
    expect(state.sequence).toBe(2)
    state = beginPointer(state, at(0, 0, 6000))
    expect(state.gestureId).toBe(3)
  })
})

describe('the observation folds keep the pairing sound', () => {
  it('does not report a classification for a release that closed nothing', () => {
    const observation = observePointerUp({ state: IDLE_GESTURE, counters: ZERO_COUNTERS }, at(0, 0, 1), true)
    expect(observation.state).toBe(IDLE_GESTURE)
    expect(classificationOf(observation.state)).toBeNull()
  })

  it('reports the drag for the release that actually closed it', () => {
    let observation = observePointerDown({ state: IDLE_GESTURE, counters: ZERO_COUNTERS }, at(0, 0, 1))
    observation = observePointerMove(observation, at(50, 0, 2))
    observation = observePointerUp(observation, at(50, 0, 3), true)
    expect(classificationOf(observation.state)).toMatchObject({ id: 1, kind: 'drag' })
  })

  it('drops the offer when the press is cancelled, without losing the last verdict', () => {
    let observation = observePointerDown({ state: IDLE_GESTURE, counters: ZERO_COUNTERS }, at(0, 0, 1))
    observation = observePointerMove(observation, at(50, 0, 2))
    observation = observePointerUp(observation, at(50, 0, 3), true)
    observation = observePointerDown(observation, at(0, 0, 10))
    observation = observeCancel(observation)
    expect(observation.state.kind).toBe('drag')
    expect(classificationOf(observation.state)).toBeNull()
  })

  it('always reports the platform double click', () => {
    const observation = observeDoubleClick(
      { state: IDLE_GESTURE, counters: ZERO_COUNTERS },
      at(0, 0, 5),
      true,
    )
    expect(classificationOf(observation.state)).toMatchObject({ id: 1, kind: 'double-click' })
  })
})
