/**
 * Browser selection reader.
 *
 * This module answers one question: *is there a usable selection right now, and
 * where is it?* It returns the text, the live `Range`, and the range's geometry
 * as read at capture time.
 *
 * Two boundaries are worth stating because they are easy to cross by accident:
 *
 * - **Nothing here issues a request.** Whether a gesture should *cause* a lookup
 *   is a separate question, answered in `./gesture.js`, and Phase 2 answers it
 *   without acting on it.
 * - **Nothing here mutates the document.** Only `getSelection()` and ancestor
 *   walks are used; no wrapper element is inserted and no `Range` is
 *   constructed.
 *
 * The geometry is deliberately re-read from the live range on every capture
 * rather than remembered: Phase 0 §7.4 measured that a scroll moves a
 * selection's rect one-for-one with `scrollTop`, and that streaming re-renders
 * the transcript underneath a selection. A remembered rect plus a scroll delta
 * would therefore be wrong in exactly the case the product cares about.
 *
 * The predicate is split in two so that the decision can be unit-tested as a
 * value relation. {@link isEligibleEndpoint} consumes plain facts, not DOM nodes,
 * and {@link readRangeRect} accepts any {@link RangeLike}, which is why neither
 * the eligibility rule nor the geometry rule needs a DOM implementation to be
 * covered.
 *
 * @module dsh-word-lookup/client/selection
 */
/**
 * Conversation flow-item anchor.
 *
 * Taken from the Phase 0 DOM census: every flow item carries
 * `[data-chat-flow-kind]` (`user`, `turn-process`, `assistant-step`, `tool-call`,
 * `context`, `model-retry`) and `[data-chat-node-key]`.
 *
 * `[data-dsh-part="message-body"]` is **not** used: on a freshly loaded client it
 * matched 0 elements while `[data-chat-node-key]` matched 188, so a predicate
 * gated on it would silently stop qualifying.
 */
export declare const CONVERSATION_FLOW_SELECTOR = "[data-chat-flow-kind]";
/**
 * Interactive text surfaces a selection is never eligible in.
 *
 * The DSH composer is a Lexical `contenteditable="true"` region carrying
 * `role="textbox"`, so the selector has to cover the attribute both as an empty
 * string and as `"true"`, as well as the plain form controls. Matching is done
 * over the whole ancestor chain, because a selection endpoint is usually a text
 * node several levels inside the surface.
 */
export declare const INTERACTIVE_SURFACE_SELECTOR = "input, textarea, select, [contenteditable=\"\"], [contenteditable=\"true\"], [role=\"textbox\"]";
/** What one endpoint of a selection is inside of. */
export interface SelectionEndpointFacts {
    /** The endpoint lies within a conversation flow item. */
    readonly insideConversationFlow: boolean;
    /** The endpoint lies within an interactive text surface. */
    readonly insideInteractiveSurface: boolean;
}
/** A selection rectangle in client coordinates. */
export interface SelectionRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
/**
 * The part of `Range` this module reads.
 *
 * Declared structurally rather than as `Range` so that {@link readRangeRect} can
 * be tested against a plain object. A real `Range` satisfies it as-is; no cast
 * is needed at the call site.
 */
export interface RangeLike {
    readonly collapsed: boolean;
    getBoundingClientRect(): SelectionRect;
}
/** A selection that passed every qualification rule. */
export interface EligibleSelection {
    /** The unmodified selected text. The host normalizes it authoritatively. */
    readonly text: string;
    /** The live range, for Phase 2 geometry. Never cached across renders. */
    readonly range: Range;
    /** Geometry of the live range at capture time, or `null` when it has none. */
    readonly rect: SelectionRect | null;
}
/**
 * Read the geometry of a live range.
 *
 * Returns `null` for a collapsed range and for an empty rect, which is how a
 * lost selection and an insertion point both present. The position is read from
 * the range itself, never reconstructed from an earlier measurement.
 *
 * @param range - the live range to measure.
 * @returns the bounding rectangle, or `null` when the range has no area.
 */
export declare function readRangeRect(range: RangeLike): SelectionRect | null;
/**
 * Decide whether one endpoint may participate in a lookup.
 *
 * Both conditions are required: the endpoint has to be inside a conversation
 * flow item (otherwise the selection is in the sidebar, a dialog, or the
 * composer) **and** outside every interactive text surface.
 *
 * @param facts - the ancestor facts for one endpoint.
 * @returns whether the endpoint is eligible.
 */
export declare function isEligibleEndpoint(facts: SelectionEndpointFacts): boolean;
/**
 * Collect the ancestor facts of one endpoint.
 *
 * @param node - an anchor or focus node from the live selection.
 * @returns the facts {@link isEligibleEndpoint} consumes.
 */
export declare function describeEndpoint(node: Node | null): SelectionEndpointFacts;
/**
 * Read the document's current selection and decide whether it is usable.
 *
 * The geometry is captured in the same pass as the text, from the same live
 * range, so a caller can never pair one gesture's text with another's position.
 *
 * @param doc - the product document to read. Passed in rather than reached for,
 * so the reader stays a pure function of its input.
 * @returns the eligible selection, or `null` when there is nothing to look up.
 */
export declare function readEligibleSelection(doc: Document): EligibleSelection | null;
