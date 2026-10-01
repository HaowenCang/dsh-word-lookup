/**
 * Gesture classification — the Phase 2 state machine.
 *
 * The whole point of this module is that a browser event is **not** a gesture.
 * Phase 0 recorded the real orderings (§7.3) and three facts decide the design:
 *
 * 1. `selectionchange` fires many times during a drag and carries no pointer
 *    position, so it can never by itself say what the reader did;
 * 2. a double click *necessarily* produces a `selectionchange` too, so
 *    "selection changed ⇒ drag" would fire on a double click;
 * 3. `dblclick` fires **before** its trailing `selectionchange`.
 *
 * So classification runs on pointer input, and the trailing `selectionchange`
 * is structurally unable to reclassify anything: no reducer here is reachable
 * from a selection event. That property is what makes the two automatic
 * switches in `docs/01-product-spec.md` expressible at all.
 *
 * Everything in this module is a pure function over an immutable state value.
 * No DOM, no timers, no globals — the deciding logic is therefore fully covered
 * by tests that need no browser, which is where the regressions that matter
 * would otherwise hide.
 *
 * **Identity.** Since Phase 4 every gesture carries a monotonic `gestureId`,
 * allocated when its press opens the sequence, and {@link classificationOf}
 * projects the state onto the `{ id, kind, pointerType, at }` a trigger gate
 * consumes. That is what makes "one semantic gesture, at most one automatic
 * lookup" provable without consulting the clock, the text or the geometry.
 *
 * **This module still classifies only.** Nothing here issues a request or knows
 * that a dictionary exists; the decision to look something up lives in
 * `./trigger.js`, and the request itself in `./lookup.js`.
 *
 * @module dsh-word-lookup/client/gesture
 */

/**
 * How far the pointer must travel from its origin before a press-and-release
 * counts as a drag rather than a click.
 *
 * Five CSS pixels: larger than the 1–3 px of jitter a real click carries on a
 * trackpad or a touch screen, and far below the tens of pixels a deliberate
 * text drag covers. It is a named constant rather than a literal so that the
 * unit tests decide on the same value the product does.
 *
 * Deliberately **not** derived from the platform double-click interval: the
 * browser already performs that recognition and reports it as `dblclick`, and
 * re-deriving it in user space would duplicate a decision the platform makes
 * better.
 */
export const DRAG_THRESHOLD_PX = 5

/** The semantic gestures the product distinguishes. */
export type GestureKind = 'none' | 'drag' | 'double-click' | 'other'

/**
 * The pointer kinds the classifier distinguishes.
 *
 * `unknown` is a real category rather than a placeholder: it is what a
 * `pointerdown` reports when the platform omits `pointerType` (synthetic events,
 * and older engines). Phase 4 gates every automatic lookup on `mouse` and treats
 * anything else as unverified, so this value is load-bearing for safety rather
 * than cosmetic — see `evaluateAutomaticTrigger`.
 */
export type PointerKind = 'mouse' | 'pen' | 'touch' | 'unknown'

/**
 * Narrow a DOM `pointerType` string to a {@link PointerKind}.
 *
 * @param pointerType - the `PointerEvent.pointerType` value, if any.
 * @returns the narrowed kind; `unknown` for anything not measured.
 */
export function pointerKind(pointerType: string | undefined): PointerKind {
  if (pointerType === 'mouse' || pointerType === 'pen' || pointerType === 'touch') return pointerType
  return 'unknown'
}

/**
 * Identity and verdict of one completed classification.
 *
 * The identity is a **pointer-sequence identity**, allocated when a primary
 * pointer press opens a gesture and carried by every classification that
 * sequence produces. It is deliberately not a function of the text, the
 * geometry or the time: two deliberate gestures on the same word are two
 * gestures and must produce two lookups, and a reflow must not silently
 * re-identify a gesture.
 */
export interface GestureClassification {
  /**
   * The pointer sequence's identity, allocated from a monotonic counter.
   *
   * A double click's `dblclick` carries the identity of the second press of the
   * pair, which is the sequence it physically belongs to; the first press gets
   * its own identity and never produces a lookup on its own.
   */
  readonly id: number
  /** What the classification decided. */
  readonly kind: GestureKind
  /** The pointer kind that opened the sequence. */
  readonly pointerType: PointerKind
  /** When the classification completed, from the same clock as the event. */
  readonly at: number
}

/**
 * Where the gesture phase currently is.
 *
 * `tracking` — a primary pointer is down and moving.
 * `sealed` — a `dblclick` has been classified and the gesture that produced it
 *   is closed; nothing may overwrite the classification until the next
 *   `pointerdown` opens a new one. This is the precedence rule of §8.
 * `idle` — nothing in flight.
 */
export type GesturePhase = 'idle' | 'tracking' | 'sealed'

/** One pointer position with the time it was observed. */
export interface GesturePoint {
  readonly x: number
  readonly y: number
  readonly at: number
}

/** Geometry of a completed gesture, in client coordinates. */
export interface PointerSpan {
  readonly startX: number
  readonly startY: number
  readonly endX: number
  readonly endY: number
  /**
   * The greatest distance the pointer reached from its origin — the quantity
   * {@link DRAG_THRESHOLD_PX} is compared against.
   *
   * Peak travel rather than the straight-line start-to-end distance, because a
   * drag that curves back towards where it began is still a drag: measuring the
   * chord would reclassify it as a click.
   */
  readonly distance: number
}

/** The public, serializable view of the classifier. */
export interface GestureSnapshot {
  readonly kind: GestureKind
  /** When the last classification completed, or `null` before the first one. */
  readonly completedAt: number | null
  /** The last completed gesture's geometry, or `null` before the first one. */
  readonly pointer: PointerSpan | null
  /**
   * Identity of the gesture the last classification belongs to; `0` before any
   * gesture has been opened.
   *
   * Exposed because it is the single fact Phase 4's de-duplication is built on:
   * a reader can see that two lookups came from two identities rather than from
   * one identity consumed twice.
   */
  readonly gestureId: number
}

/** The classifier's full state, including what is in flight. */
export interface GestureState extends GestureSnapshot {
  readonly phase: GesturePhase
  /** Origin of the in-flight pointer. Meaningless unless `phase` is tracking. */
  readonly originX: number
  readonly originY: number
  /** Peak travel of the in-flight pointer. Meaningless unless tracking. */
  readonly moved: number
  /**
   * Monotonic allocator for {@link GestureSnapshot.gestureId}.
   *
   * It only ever increases and is never reset, including by a cancel or a
   * disposal: an identity that could be handed out twice would make the
   * consumption ledger unsound.
   */
  readonly sequence: number
  /** The pointer kind that opened the sequence {@link gestureId} names. */
  readonly pointerType: PointerKind
}

/**
 * The state before any gesture.
 *
 * Frozen because it is shared as the initial value and must never be mutated in
 * place; every reducer returns a new object instead.
 */
export const IDLE_GESTURE: GestureState = Object.freeze({
  kind: 'none',
  completedAt: null,
  pointer: null,
  phase: 'idle',
  originX: 0,
  originY: 0,
  moved: 0,
  gestureId: 0,
  sequence: 0,
  pointerType: 'unknown',
})

/**
 * Project the full state onto the public snapshot.
 *
 * @param state - the classifier state.
 * @returns the serializable gesture view.
 */
export function gestureSnapshot(state: GestureState): GestureSnapshot {
  return { kind: state.kind, completedAt: state.completedAt, pointer: state.pointer, gestureId: state.gestureId }
}

/**
 * Project the classifier state onto the classification a trigger gate consumes.
 *
 * `null` means "this state carries no classification at all", which is what the
 * initial state and a cancelled-before-release state both report. A state that
 * still carries an **earlier** classification reports it again — with the same
 * identity, so a gate that de-duplicates by identity can only ever act on it
 * once. That is deliberate: re-reading is safe, re-acting is not.
 *
 * @param state - the classifier state.
 * @returns the classification, or `null` when there is none.
 */
export function classificationOf(state: GestureState): GestureClassification | null {
  if (state.completedAt === null || state.kind === 'none') return null
  return { id: state.gestureId, kind: state.kind, pointerType: state.pointerType, at: state.completedAt }
}

/**
 * Whether a pointer travelled far enough to be a drag.
 *
 * @param distance - peak travel in CSS pixels.
 * @returns whether the distance clears the drag threshold.
 */
export function isDragDistance(distance: number): boolean {
  return distance >= DRAG_THRESHOLD_PX
}

/**
 * Distance between two points.
 *
 * @param ax - first x.
 * @param ay - first y.
 * @param bx - second x.
 * @param by - second y.
 * @returns the Euclidean distance.
 */
function distanceBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay)
}

/**
 * Open a gesture on a primary pointer press.
 *
 * A non-primary button is ignored rather than tracked: a right-click drag
 * carries no text selection, and letting it open a gesture would let it close
 * one too.
 *
 * Opening a gesture **allocates its identity**. That is the whole reason the
 * allocation lives here rather than at classification time: the two pointer
 * presses of a double click are two sequences with two identities, and the
 * `dblclick` that follows the second one can be attributed to it exactly.
 *
 * The previous classification is deliberately preserved: the snapshot always
 * describes the last *completed* gesture, so opening a new one does not blank
 * what the reader last did.
 *
 * @param state - the current state.
 * @param point - the press position.
 * @param button - the DOM `button` value; `0` is the primary button.
 * @param pointerType - the pointer kind that produced the press.
 * @returns the next state.
 */
export function beginPointer(
  state: GestureState,
  point: GesturePoint,
  button = 0,
  pointerType: PointerKind = 'unknown',
): GestureState {
  if (button !== 0) return state
  const sequence = state.sequence + 1
  return {
    ...state,
    phase: 'tracking',
    originX: point.x,
    originY: point.y,
    moved: 0,
    sequence,
    gestureId: sequence,
    pointerType,
  }
}

/**
 * Record pointer travel while a gesture is open.
 *
 * Returns the same object when nothing changed, so a caller may assign the
 * result unconditionally without publishing spurious updates.
 *
 * @param state - the current state.
 * @param point - the current position.
 * @returns the next state.
 */
export function movePointer(state: GestureState, point: GesturePoint): GestureState {
  if (state.phase !== 'tracking') return state
  const moved = Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y))
  if (moved === state.moved) return state
  return { ...state, moved }
}

/**
 * Close a gesture on pointer release and classify it.
 *
 * A release with enough travel **and** an eligible selection is a `drag`. Every
 * other release is `other`: a click too short to be a drag, or a long movement
 * that selected nothing usable. Neither is ever reported as `drag`, which is
 * what keeps a simple click out of the automatic path.
 *
 * A sealed state is returned untouched — that is the double-click precedence
 * rule. Once `dblclick` has classified the gesture, the release that produced it
 * cannot reinterpret it.
 *
 * The identity is carried over unchanged: a release classifies the gesture the
 * press opened, and it is never given an identity of its own.
 *
 * @param state - the current state.
 * @param point - the release position.
 * @param hasEligibleSelection - whether a usable selection exists at release.
 * @returns the next state.
 */
export function endPointer(state: GestureState, point: GesturePoint, hasEligibleSelection: boolean): GestureState {
  if (state.phase !== 'tracking') return state

  const distance = Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y))
  const dragged = isDragDistance(distance) && hasEligibleSelection

  return {
    kind: dragged ? 'drag' : 'other',
    completedAt: point.at,
    pointer: {
      startX: state.originX,
      startY: state.originY,
      endX: point.x,
      endY: point.y,
      distance,
    },
    phase: 'idle',
    originX: 0,
    originY: 0,
    moved: 0,
    gestureId: state.gestureId,
    sequence: state.sequence,
    pointerType: state.pointerType,
  }
}

/**
 * Classify a platform-recognised double click.
 *
 * `dblclick` is the browser's own, high-confidence word-selection gesture, so it
 * outranks anything inferred from pointer movement. The state is **sealed**
 * afterwards: the `selectionchange` the browser dispatches next — and any stray
 * pointer release — must not turn this back into a drag.
 *
 * Without an eligible selection at the moment of the double click there is
 * nothing to look up, so the gesture is recorded as `other` rather than claimed
 * as a usable double click.
 *
 * **Identity.** `dblclick` is reported by the platform after the second release,
 * so it belongs to the sequence the second press opened: the state still carries
 * that identity and it is reused rather than replaced. The first press of the
 * pair keeps the identity it was given when it opened, and — since a short
 * release is `other` — never produces a lookup of its own. When no press was
 * observed at all (a synthetic `dblclick`, or an engine that delivers the event
 * without pointer events) a fresh identity is allocated, so the gesture is still
 * individually addressable and still de-duplicated exactly once.
 *
 * @param state - the current state.
 * @param point - the double click position.
 * @param hasEligibleSelection - whether a usable selection exists right now.
 * @returns the next state.
 */
export function registerDoubleClick(
  state: GestureState,
  point: GesturePoint,
  hasEligibleSelection: boolean,
): GestureState {
  const inFlight =
    state.phase === 'tracking'
      ? Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y))
      : null

  const pointer =
    inFlight === null
      ? state.pointer
      : {
          startX: state.originX,
          startY: state.originY,
          endX: point.x,
          endY: point.y,
          distance: inFlight,
        }

  const sequence = state.gestureId === 0 ? state.sequence + 1 : state.sequence

  return {
    kind: hasEligibleSelection ? 'double-click' : 'other',
    completedAt: point.at,
    pointer,
    phase: 'sealed',
    originX: 0,
    originY: 0,
    moved: 0,
    gestureId: state.gestureId === 0 ? sequence : state.gestureId,
    sequence,
    pointerType: state.pointerType,
  }
}

/**
 * Abandon an in-flight gesture.
 *
 * Used for `pointercancel`, window blur and disposal. A cancelled gesture leaves
 * no half-built state behind — no origin, no travel, no open phase — while the
 * last completed classification stays readable, because "what did the reader
 * last do" is still true after an unrelated cancellation.
 *
 * @param state - the current state.
 * @returns the next state.
 */
export function cancelGesture(state: GestureState): GestureState {
  if (state.phase === 'idle') return state
  return { ...state, phase: 'idle', originX: 0, originY: 0, moved: 0 }
}

/**
 * How many events and classifications the listeners have seen.
 *
 * Counted so that "zero lookups" can be told apart from "the listeners never
 * ran". A test asserting only that no request was made would pass just as
 * happily against a plugin whose gesture path was entirely dead — the failure
 * mode this instrument exists to rule out.
 */
export interface GestureCounters {
  /** `pointerdown` events observed. */
  readonly pointerdowns: number
  /** `pointerup` events observed. */
  readonly pointerups: number
  /** Completed gestures classified as `drag`. */
  readonly drags: number
  /** `dblclick` events observed. */
  readonly doubleClicks: number
  /** Completed gestures classified as `double-click`. */
  readonly doubleClickGestures: number
  /** Completed gestures classified as `other` (clicks and empty drags). */
  readonly simpleGestures: number
  /** Cancellations that abandoned an in-flight gesture. */
  readonly cancels: number
}

/** The classifier state together with what it has observed. */
export interface GestureObservation {
  readonly state: GestureState
  readonly counters: GestureCounters
}

/** The observation before any event, frozen because it is the shared initial value. */
export const IDLE_OBSERVATION: GestureObservation = Object.freeze({
  state: IDLE_GESTURE,
  counters: Object.freeze({
    pointerdowns: 0,
    pointerups: 0,
    drags: 0,
    doubleClicks: 0,
    doubleClickGestures: 0,
    simpleGestures: 0,
    cancels: 0,
  }),
})

/**
 * Count a classification that has just completed.
 *
 * @param counters - the counters to advance.
 * @param kind - the classification that completed.
 * @returns the next counters.
 */
function countClassification(counters: GestureCounters, kind: GestureKind): GestureCounters {
  if (kind === 'drag') return { ...counters, drags: counters.drags + 1 }
  if (kind === 'double-click') return { ...counters, doubleClickGestures: counters.doubleClickGestures + 1 }
  return { ...counters, simpleGestures: counters.simpleGestures + 1 }
}

/**
 * Fold a primary pointer press into the observation.
 *
 * @param observation - the current observation.
 * @param point - the press position.
 * @param button - the DOM `button` value.
 * @param pointerType - the pointer kind that produced the press.
 * @returns the next observation.
 */
export function observePointerDown(
  observation: GestureObservation,
  point: GesturePoint,
  button = 0,
  pointerType: PointerKind = 'unknown',
): GestureObservation {
  const state = beginPointer(observation.state, point, button, pointerType)
  if (state === observation.state) return observation
  return { state, counters: { ...observation.counters, pointerdowns: observation.counters.pointerdowns + 1 } }
}

/**
 * Fold pointer travel into the observation.
 *
 * @param observation - the current observation.
 * @param point - the current position.
 * @returns the next observation.
 */
export function observePointerMove(observation: GestureObservation, point: GesturePoint): GestureObservation {
  const state = movePointer(observation.state, point)
  return state === observation.state ? observation : { state, counters: observation.counters }
}

/**
 * Fold a pointer release into the observation, counting the classification.
 *
 * A release that classified nothing — no open gesture, or a state sealed by a
 * preceding double click — still counts as an observed `pointerup`, so the
 * counter cannot be mistaken for "the listener never fired".
 *
 * @param observation - the current observation.
 * @param point - the release position.
 * @param hasEligibleSelection - whether a usable selection exists at release.
 * @returns the next observation.
 */
export function observePointerUp(
  observation: GestureObservation,
  point: GesturePoint,
  hasEligibleSelection: boolean,
): GestureObservation {
  const counters = { ...observation.counters, pointerups: observation.counters.pointerups + 1 }
  const state = endPointer(observation.state, point, hasEligibleSelection)
  if (state === observation.state) return { state, counters }
  return { state, counters: countClassification(counters, state.kind) }
}

/**
 * Fold a platform double click into the observation.
 *
 * @param observation - the current observation.
 * @param point - the double click position.
 * @param hasEligibleSelection - whether a usable selection exists right now.
 * @returns the next observation.
 */
export function observeDoubleClick(
  observation: GestureObservation,
  point: GesturePoint,
  hasEligibleSelection: boolean,
): GestureObservation {
  const state = registerDoubleClick(observation.state, point, hasEligibleSelection)
  return {
    state,
    counters: countClassification(
      { ...observation.counters, doubleClicks: observation.counters.doubleClicks + 1 },
      state.kind,
    ),
  }
}

/**
 * Fold a cancellation into the observation.
 *
 * @param observation - the current observation.
 * @returns the next observation.
 */
export function observeCancel(observation: GestureObservation): GestureObservation {
  const state = cancelGesture(observation.state)
  if (state === observation.state) return observation
  return { state, counters: { ...observation.counters, cancels: observation.counters.cancels + 1 } }
}
