/**
 * Browser selection reader — Phase 1 skeleton.
 *
 * Phase 1 answers exactly one question: *is there a usable selection right now?*
 * The gesture classifier that decides whether a completed drag or double click
 * should trigger a lookup is Phase 2 work and is deliberately absent here; so is
 * any automatic trigger. Nothing in this module issues a request, and nothing
 * mutates the document: it reads `document.getSelection()` and walks ancestor
 * chains.
 *
 * The predicate is split in two so that the decision can be unit-tested as a
 * value relation. {@link isEligibleEndpoint} consumes plain facts, not DOM nodes,
 * which is why the test suite needs no DOM implementation to cover the rule that
 * actually decides eligibility.
 *
 * @module dsh-word-lookup/client/selection
 */

import { isEligibleSelectionText } from '../shared/text.js'

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
export const CONVERSATION_FLOW_SELECTOR = '[data-chat-flow-kind]'

/**
 * Interactive text surfaces a selection is never eligible in.
 *
 * The DSH composer is a Lexical `contenteditable="true"` region carrying
 * `role="textbox"`, so the selector has to cover the attribute both as an empty
 * string and as `"true"`, as well as the plain form controls. Matching is done
 * over the whole ancestor chain, because a selection endpoint is usually a text
 * node several levels inside the surface.
 */
export const INTERACTIVE_SURFACE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'

/** What one endpoint of a selection is inside of. */
export interface SelectionEndpointFacts {
  /** The endpoint lies within a conversation flow item. */
  readonly insideConversationFlow: boolean
  /** The endpoint lies within an interactive text surface. */
  readonly insideInteractiveSurface: boolean
}

/** A selection that passed every qualification rule. */
export interface EligibleSelection {
  /** The unmodified selected text. The host normalizes it authoritatively. */
  readonly text: string
  /** The live range, for Phase 2 geometry. Never cached across renders. */
  readonly range: Range
}

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
export function isEligibleEndpoint(facts: SelectionEndpointFacts): boolean {
  return facts.insideConversationFlow && !facts.insideInteractiveSurface
}

/**
 * Resolve the element a selection endpoint should be tested against.
 *
 * @param node - an anchor or focus node, which may be `null` or a text node.
 * @returns the element to walk from, or `null` when the node has none.
 */
function elementFor(node: Node | null): Element | null {
  if (node === null) return null
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/**
 * Collect the ancestor facts of one endpoint.
 *
 * @param node - an anchor or focus node from the live selection.
 * @returns the facts {@link isEligibleEndpoint} consumes.
 */
export function describeEndpoint(node: Node | null): SelectionEndpointFacts {
  const element = elementFor(node)
  if (element === null) {
    return { insideConversationFlow: false, insideInteractiveSurface: false }
  }
  return {
    insideConversationFlow: element.closest(CONVERSATION_FLOW_SELECTOR) !== null,
    insideInteractiveSurface: element.closest(INTERACTIVE_SURFACE_SELECTOR) !== null,
  }
}

/**
 * Read the document's current selection and decide whether it is usable.
 *
 * @param doc - the product document to read. Passed in rather than reached for,
 * so the reader stays a pure function of its input.
 * @returns the eligible selection, or `null` when there is nothing to look up.
 */
export function readEligibleSelection(doc: Document): EligibleSelection | null {
  const selection = doc.getSelection()
  if (selection === null) return null
  if (selection.rangeCount === 0 || selection.isCollapsed) return null

  const text = selection.toString()
  if (!isEligibleSelectionText(text)) return null

  if (!isEligibleEndpoint(describeEndpoint(selection.anchorNode))) return null
  if (!isEligibleEndpoint(describeEndpoint(selection.focusNode))) return null

  return { text, range: selection.getRangeAt(0) }
}
