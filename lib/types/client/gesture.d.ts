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
 * **Phase 2 classifies only.** Nothing here issues a request, and the runtime
 * that consumes this state does not call the lookup transport from any pointer
 * or double-click path. `requestLookup` remains reachable from the manual
 * command alone.
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
export declare const DRAG_THRESHOLD_PX = 5;
/** The semantic gestures the product distinguishes. */
export type GestureKind = 'none' | 'drag' | 'double-click' | 'other';
/**
 * Where the gesture phase currently is.
 *
 * `tracking` — a primary pointer is down and moving.
 * `sealed` — a `dblclick` has been classified and the gesture that produced it
 *   is closed; nothing may overwrite the classification until the next
 *   `pointerdown` opens a new one. This is the precedence rule of §8.
 * `idle` — nothing in flight.
 */
export type GesturePhase = 'idle' | 'tracking' | 'sealed';
/** One pointer position with the time it was observed. */
export interface GesturePoint {
    readonly x: number;
    readonly y: number;
    readonly at: number;
}
/** Geometry of a completed gesture, in client coordinates. */
export interface PointerSpan {
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
    /**
     * The greatest distance the pointer reached from its origin — the quantity
     * {@link DRAG_THRESHOLD_PX} is compared against.
     *
     * Peak travel rather than the straight-line start-to-end distance, because a
     * drag that curves back towards where it began is still a drag: measuring the
     * chord would reclassify it as a click.
     */
    readonly distance: number;
}
/** The public, serializable view of the classifier. */
export interface GestureSnapshot {
    readonly kind: GestureKind;
    /** When the last classification completed, or `null` before the first one. */
    readonly completedAt: number | null;
    /** The last completed gesture's geometry, or `null` before the first one. */
    readonly pointer: PointerSpan | null;
}
/** The classifier's full state, including what is in flight. */
export interface GestureState extends GestureSnapshot {
    readonly phase: GesturePhase;
    /** Origin of the in-flight pointer. Meaningless unless `phase` is tracking. */
    readonly originX: number;
    readonly originY: number;
    /** Peak travel of the in-flight pointer. Meaningless unless tracking. */
    readonly moved: number;
}
/**
 * The state before any gesture.
 *
 * Frozen because it is shared as the initial value and must never be mutated in
 * place; every reducer returns a new object instead.
 */
export declare const IDLE_GESTURE: GestureState;
/**
 * Project the full state onto the public snapshot.
 *
 * @param state - the classifier state.
 * @returns the serializable gesture view.
 */
export declare function gestureSnapshot(state: GestureState): GestureSnapshot;
/**
 * Whether a pointer travelled far enough to be a drag.
 *
 * @param distance - peak travel in CSS pixels.
 * @returns whether the distance clears the drag threshold.
 */
export declare function isDragDistance(distance: number): boolean;
/**
 * Open a gesture on a primary pointer press.
 *
 * A non-primary button is ignored rather than tracked: a right-click drag
 * carries no text selection, and letting it open a gesture would let it close
 * one too.
 *
 * The previous classification is deliberately preserved: the snapshot always
 * describes the last *completed* gesture, so opening a new one does not blank
 * what the reader last did.
 *
 * @param state - the current state.
 * @param point - the press position.
 * @param button - the DOM `button` value; `0` is the primary button.
 * @returns the next state.
 */
export declare function beginPointer(state: GestureState, point: GesturePoint, button?: number): GestureState;
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
export declare function movePointer(state: GestureState, point: GesturePoint): GestureState;
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
 * @param state - the current state.
 * @param point - the release position.
 * @param hasEligibleSelection - whether a usable selection exists at release.
 * @returns the next state.
 */
export declare function endPointer(state: GestureState, point: GesturePoint, hasEligibleSelection: boolean): GestureState;
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
 * @param state - the current state.
 * @param point - the double click position.
 * @param hasEligibleSelection - whether a usable selection exists right now.
 * @returns the next state.
 */
export declare function registerDoubleClick(state: GestureState, point: GesturePoint, hasEligibleSelection: boolean): GestureState;
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
export declare function cancelGesture(state: GestureState): GestureState;
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
    readonly pointerdowns: number;
    /** `pointerup` events observed. */
    readonly pointerups: number;
    /** Completed gestures classified as `drag`. */
    readonly drags: number;
    /** `dblclick` events observed. */
    readonly doubleClicks: number;
    /** Completed gestures classified as `double-click`. */
    readonly doubleClickGestures: number;
    /** Completed gestures classified as `other` (clicks and empty drags). */
    readonly simpleGestures: number;
    /** Cancellations that abandoned an in-flight gesture. */
    readonly cancels: number;
}
/** The classifier state together with what it has observed. */
export interface GestureObservation {
    readonly state: GestureState;
    readonly counters: GestureCounters;
}
/** The observation before any event, frozen because it is the shared initial value. */
export declare const IDLE_OBSERVATION: GestureObservation;
/**
 * Fold a primary pointer press into the observation.
 *
 * @param observation - the current observation.
 * @param point - the press position.
 * @param button - the DOM `button` value.
 * @returns the next observation.
 */
export declare function observePointerDown(observation: GestureObservation, point: GesturePoint, button?: number): GestureObservation;
/**
 * Fold pointer travel into the observation.
 *
 * @param observation - the current observation.
 * @param point - the current position.
 * @returns the next observation.
 */
export declare function observePointerMove(observation: GestureObservation, point: GesturePoint): GestureObservation;
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
export declare function observePointerUp(observation: GestureObservation, point: GesturePoint, hasEligibleSelection: boolean): GestureObservation;
/**
 * Fold a platform double click into the observation.
 *
 * @param observation - the current observation.
 * @param point - the double click position.
 * @param hasEligibleSelection - whether a usable selection exists right now.
 * @returns the next observation.
 */
export declare function observeDoubleClick(observation: GestureObservation, point: GesturePoint, hasEligibleSelection: boolean): GestureObservation;
/**
 * Fold a cancellation into the observation.
 *
 * @param observation - the current observation.
 * @returns the next observation.
 */
export declare function observeCancel(observation: GestureObservation): GestureObservation;
