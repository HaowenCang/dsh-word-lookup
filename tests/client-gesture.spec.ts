/**
 * The gesture classifier.
 *
 * This is the Phase 2 contract that keeps the two automatic switches
 * expressible: a browser event is not a gesture, and the trailing
 * `selectionchange` of a double click must never be readable as a drag.
 *
 * The event orders replayed below are the ones Phase 0 §7.3 recorded in real
 * Chromium, so the tests assert the classifier against measured browser
 * behaviour rather than against an assumed one.
 */

import { describe, expect, it } from 'vitest'

import * as gestureModule from '../src/client/gesture.js'
import {
  DRAG_THRESHOLD_PX,
  gestureSnapshot,
  IDLE_GESTURE,
  IDLE_OBSERVATION,
  isDragDistance,
  observeCancel,
  observeDoubleClick,
  observePointerDown,
  observePointerMove,
  observePointerUp,
  type GestureObservation,
} from '../src/client/gesture.js'

/** A pointer position at a fixed instant. */
function at(x: number, y: number, time = 1000) {
  return { x, y, at: time }
}

/**
 * Replay the measured pointer-drag order from Phase 0 §7.3.
 *
 * @param selectionAtRelease - whether the drag selected usable text.
 * @param distance - how far the pointer travelled.
 * @returns the observation after the gesture.
 */
function replayDrag(selectionAtRelease: boolean, distance = 40): GestureObservation {
  let observation = IDLE_OBSERVATION
  observation = observePointerDown(observation, at(100, 100, 1000))
  observation = observePointerMove(observation, at(100 + distance, 100, 1005))
  observation = observePointerUp(observation, at(100 + distance, 100, 1010), selectionAtRelease)
  return observation
}

/**
 * Replay the measured double-click order from Phase 0 §7.3.
 *
 * The second press and release happen first, the platform then reports
 * `dblclick`, and only afterwards does the trailing `selectionchange` arrive.
 *
 * @param selectionAtDoubleClick - whether a word is selected when `dblclick` fires.
 * @returns the observation after the trailing selectionchange.
 */
function replayDoubleClick(selectionAtDoubleClick = true): GestureObservation {
  let observation = IDLE_OBSERVATION
  // First click of the pair.
  observation = observePointerDown(observation, at(200, 200, 2000))
  observation = observePointerUp(observation, at(200, 200, 2003), false)
  // Second click: the word is already selected by the time it ends.
  observation = observePointerDown(observation, at(200, 200, 2100))
  observation = observePointerUp(observation, at(200, 200, 2103), selectionAtDoubleClick)
  // The platform's own recognition.
  observation = observeDoubleClick(observation, at(200, 200, 2110), selectionAtDoubleClick)
  // The trailing `selectionchange` carries no pointer event at all, so nothing
  // here may be invoked for it. Re-asserting the release proves the point.
  observation = observePointerUp(observation, at(200, 200, 2112), selectionAtDoubleClick)
  return observation
}

describe('drag threshold', () => {
  it('is a named constant rather than a literal at the call site', () => {
    expect(DRAG_THRESHOLD_PX).toBe(5)
  })

  it('classifies travel below the threshold as no drag', () => {
    expect(isDragDistance(DRAG_THRESHOLD_PX - 0.1)).toBe(false)
    expect(isDragDistance(0)).toBe(false)
  })

  it('classifies travel at or above the threshold as a drag', () => {
    expect(isDragDistance(DRAG_THRESHOLD_PX)).toBe(true)
    expect(isDragDistance(DRAG_THRESHOLD_PX + 50)).toBe(true)
  })
})

describe('drag', () => {
  it('classifies a long press-and-release over usable text as a drag', () => {
    const { state } = replayDrag(true, 40)
    expect(state.kind).toBe('drag')
    expect(state.phase).toBe('idle')
    expect(state.completedAt).toBe(1010)
    expect(state.pointer).toEqual({ startX: 100, startY: 100, endX: 140, endY: 100, distance: 40 })
  })

  it('does not classify a below-threshold movement as a drag', () => {
    const { state } = replayDrag(true, DRAG_THRESHOLD_PX - 1)
    expect(state.kind).toBe('other')
  })

  it('classifies travel exactly at the threshold as a drag', () => {
    const { state } = replayDrag(true, DRAG_THRESHOLD_PX)
    expect(state.kind).toBe('drag')
  })

  it('does not classify a long movement that selected nothing as a drag', () => {
    const { state } = replayDrag(false, 120)
    expect(state.kind).toBe('other')
  })

  it('measures peak travel, so a drag that curves back is still a drag', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(0, 0, 1))
    observation = observePointerMove(observation, at(100, 0, 2))
    observation = observePointerMove(observation, at(0, 0, 3))
    observation = observePointerUp(observation, at(0, 0, 4), true)
    expect(observation.state.kind).toBe('drag')
    expect(observation.state.pointer?.distance).toBe(100)
  })

  it('ignores a diagonal distance component below the threshold', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(0, 0, 1))
    observation = observePointerMove(observation, at(3, 3, 2))
    observation = observePointerUp(observation, at(3, 3, 3), true)
    // hypot(3, 3) is 4.24, below the 5 px threshold.
    expect(observation.state.kind).toBe('other')
  })
})

describe('simple click', () => {
  it('classifies a press and release with no movement as other, never drag', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(50, 50, 1))
    observation = observePointerUp(observation, at(50, 50, 2), true)
    expect(observation.state.kind).toBe('other')
  })

  it('ignores a non-primary button entirely', () => {
    const observation = observePointerDown(IDLE_OBSERVATION, at(50, 50, 1), 2)
    expect(observation).toBe(IDLE_OBSERVATION)
    expect(observation.counters.pointerdowns).toBe(0)
  })

  it('does not let a release with no open gesture classify anything', () => {
    const observation = observePointerUp(IDLE_OBSERVATION, at(50, 50, 1), true)
    expect(observation.state).toBe(IDLE_GESTURE)
    expect(observation.state.kind).toBe('none')
    expect(observation.counters.drags).toBe(0)
  })
})

describe('double click', () => {
  it('classifies the platform signal as a double click when a word is selected', () => {
    const observation = replayDoubleClick(true)
    expect(observation.state.kind).toBe('double-click')
    expect(observation.state.completedAt).toBe(2110)
  })

  it('does not claim a double click that selected nothing usable', () => {
    const observation = replayDoubleClick(false)
    expect(observation.state.kind).toBe('other')
  })

  it('classifies a double click even when it was never preceded by a pointerdown', () => {
    const observation = observeDoubleClick(IDLE_OBSERVATION, at(10, 10, 5), true)
    expect(observation.state.kind).toBe('double-click')
    expect(observation.state.pointer).toBeNull()
  })
})

describe('double-click precedence over its trailing selectionchange', () => {
  it('keeps the double click classification after the trailing release', () => {
    const observation = replayDoubleClick(true)
    expect(observation.state.kind).toBe('double-click')
  })

  it('seals the gesture so a later release cannot reinterpret it as a drag', () => {
    let observation = observeDoubleClick(IDLE_OBSERVATION, at(200, 200, 2110), true)
    const sealed = observation
    // A stray release far from the origin: without the seal this would be a drag.
    observation = observePointerUp(observation, at(500, 500, 2115), true)
    expect(observation.state).toBe(sealed.state)
    expect(observation.state.kind).toBe('double-click')
    expect(observation.counters.drags).toBe(0)
  })

  it('reopens only on a fresh pointerdown, so a drag after a double click still classifies', () => {
    let observation = observeDoubleClick(IDLE_OBSERVATION, at(200, 200, 2110), true)
    observation = observePointerDown(observation, at(300, 300, 3000))
    expect(observation.state.phase).toBe('tracking')
    observation = observePointerMove(observation, at(360, 300, 3005))
    observation = observePointerUp(observation, at(360, 300, 3010), true)
    expect(observation.state.kind).toBe('drag')
  })

  it('never derives a gesture from a selection event, because none is accepted', () => {
    // The classifier's inputs are pointer positions only; there is no function
    // here that takes a selection and names a gesture. A drag therefore cannot
    // be produced by running the double-click sequence a second time.
    const first = replayDoubleClick(true)
    const second = replayDoubleClick(true)
    expect(second.state.kind).toBe(first.state.kind)
    expect(second.counters.drags).toBe(0)
  })
})

describe('cancellation', () => {
  it('abandons an in-flight gesture without leaving half-built state', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(0, 0, 1))
    observation = observePointerMove(observation, at(80, 0, 2))
    observation = observeCancel(observation)
    expect(observation.state.phase).toBe('idle')
    expect(observation.state.originX).toBe(0)
    expect(observation.state.originY).toBe(0)
    expect(observation.state.moved).toBe(0)
    expect(observation.counters.cancels).toBe(1)
  })

  it('keeps the last completed classification readable after a cancel', () => {
    let observation = replayDrag(true, 40)
    observation = observePointerDown(observation, at(0, 0, 5000))
    observation = observeCancel(observation)
    expect(observation.state.kind).toBe('drag')
    expect(gestureSnapshot(observation.state).kind).toBe('drag')
  })

  it('is idempotent, so blur plus pointercancel counts once', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(0, 0, 1))
    observation = observeCancel(observation)
    const once = observation
    observation = observeCancel(observation)
    expect(observation).toBe(once)
    expect(observation.counters.cancels).toBe(1)
  })

  it('does not let a cancelled drag later classify on release', () => {
    let observation = observePointerDown(IDLE_OBSERVATION, at(0, 0, 1))
    observation = observePointerMove(observation, at(90, 0, 2))
    observation = observeCancel(observation)
    observation = observePointerUp(observation, at(90, 0, 3), true)
    expect(observation.state.kind).toBe('none')
    expect(observation.counters.drags).toBe(0)
  })
})

describe('counters', () => {
  it('start at zero', () => {
    expect(IDLE_OBSERVATION.counters).toEqual({
      pointerdowns: 0,
      pointerups: 0,
      drags: 0,
      doubleClicks: 0,
      doubleClickGestures: 0,
      simpleGestures: 0,
      cancels: 0,
    })
  })

  it('count a drag exactly once', () => {
    const { counters } = replayDrag(true, 40)
    expect(counters.pointerdowns).toBe(1)
    expect(counters.pointerups).toBe(1)
    expect(counters.drags).toBe(1)
    expect(counters.simpleGestures).toBe(0)
  })

  it('count the double click pair as two short releases and one double click', () => {
    const { counters } = replayDoubleClick(true)
    expect(counters.pointerdowns).toBe(2)
    // Three releases: one per click of the pair, plus the sealed trailing one.
    expect(counters.pointerups).toBe(3)
    expect(counters.doubleClicks).toBe(1)
    expect(counters.doubleClickGestures).toBe(1)
    // Both releases of the pair are, at the moment they happen, short releases
    // that selected text — indistinguishable from a simple click until the
    // platform reports `dblclick` afterwards. Recording that honestly is the
    // point: neither is ever counted as a drag, so nothing that could drive the
    // automatic paths is inferred from a double click.
    expect(counters.simpleGestures).toBe(2)
    expect(counters.drags).toBe(0)
  })

  it('do not drift when the same observation is folded many times', () => {
    let observation = IDLE_OBSERVATION
    for (let index = 0; index < 100; index += 1) {
      observation = observePointerMove(observation, at(index, index, index))
    }
    // No gesture was ever opened, so nothing but the pointer positions changed.
    expect(observation.counters).toEqual(IDLE_OBSERVATION.counters)
    expect(observation.state).toBe(IDLE_GESTURE)
  })
})

describe('100 drags + 100 double clicks', () => {
  /**
   * Replay the Phase 2 regression count through the pure classifier.
   *
   * @returns the observation after every gesture.
   */
  function replayAll(): GestureObservation {
    let observation = IDLE_OBSERVATION
    for (let index = 0; index < 100; index += 1) {
      let step: GestureObservation = { state: observation.state, counters: observation.counters }
      step = observePointerDown(step, at(index, 100, index * 10))
      step = observePointerMove(step, at(index + 60, 100, index * 10 + 1))
      step = observePointerUp(step, at(index + 60, 100, index * 10 + 2), true)
      observation = step
    }
    for (let index = 0; index < 100; index += 1) {
      let step: GestureObservation = { state: observation.state, counters: observation.counters }
      step = observePointerDown(step, at(index, 200, 10_000 + index * 10))
      step = observePointerUp(step, at(index, 200, 10_000 + index * 10 + 1), true)
      step = observeDoubleClick(step, at(index, 200, 10_000 + index * 10 + 2), true)
      observation = step
    }
    return observation
  }

  const final = replayAll()

  it('classifies every drag', () => {
    expect(final.counters.drags).toBe(100)
  })

  it('classifies every double click', () => {
    expect(final.counters.doubleClickGestures).toBe(100)
  })

  it('observed every event it was given', () => {
    expect(final.counters.pointerdowns).toBe(200)
    expect(final.counters.doubleClicks).toBe(100)
  })

  it('issues nothing, because the classifier exposes no I/O surface at all', () => {
    // Structural half of the regression. The behavioural half is measured in
    // the isolated runtime, where 100 real drags and 100 real double clicks must
    // leave the request count unchanged; this asserts the module offers no way
    // to make a request in the first place.
    const surface = Object.keys(gestureModule)
    expect(surface.filter((name) => /request|fetch|lookup|transport|send|post|abort/i.test(name))).toEqual([])
    expect(final.state.kind).toBe('double-click')
  })
})
