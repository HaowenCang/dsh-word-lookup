/**
 * Text normalization shared by both halves of `dsh-word-lookup`.
 *
 * A browser selection arrives with whatever punctuation the reader dragged over:
 * a trailing period from the end of a sentence, a leading quotation mark, or a
 * line break from a wrapped paragraph. Normalization is deliberately narrow — it
 * strips edge punctuation, folds case, and collapses internal whitespace, and it
 * does not attempt stemming. Inflection handling belongs to the dictionary
 * (Phase 3), not to the transport.
 *
 * The browser half calls the same functions only to decide whether a selection
 * is worth sending; the host calls them again as the authoritative normalization
 * of whatever arrives. One implementation, so the two cannot disagree about what
 * "an eligible selection" is.
 *
 * @module dsh-word-lookup/shared/text
 */

import { MAX_QUERY_CODE_POINTS } from './protocol.js'

/**
 * Punctuation removed from both ends of a raw selection.
 *
 * Written as two alternatives rather than a single class with a `^`/`$` anchor
 * pair so that one pass removes a run of characters from each end. ASCII
 * punctuation is listed literally; the Unicode block covers the curly quotes,
 * dashes and ellipsis a document export or an LLM transcript actually produces.
 */
const EDGE_PUNCTUATION =
  /^(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)|(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)$/g

/** Matches any run of Unicode whitespace. */
const WHITESPACE_RUN = /\s+/gu

/**
 * Count the Unicode code points in a string.
 *
 * `String.prototype.length` counts UTF-16 code units, so a selection of astral
 * characters (emoji, rare CJK extensions) would be measured at twice its length
 * and rejected earlier than {@link MAX_QUERY_CODE_POINTS} promises.
 *
 * @param value - the string to measure.
 * @returns the number of code points.
 */
export function countCodePoints(value: string): number {
  let count = 0
  for (const _ of value) count += 1
  return count
}

/**
 * Normalize one raw selection into a headword candidate.
 *
 * The steps are ordered: whitespace is collapsed first so that a selection
 * spanning a line break becomes a single space, then edge punctuation is
 * stripped so that a sentence-final period after a collapsed break is still
 * removed, and finally the result is lowercased. Lowercasing last keeps the
 * strip from depending on the case of the input.
 *
 * @param raw - the text the reader selected.
 * @returns the normalized candidate; the empty string when nothing survives.
 */
export function normalizeHeadword(raw: string): string {
  const collapsed = raw.replace(WHITESPACE_RUN, ' ').trim()
  const stripped = collapsed.replace(EDGE_PUNCTUATION, '').trim()
  return stripped.replace(WHITESPACE_RUN, ' ').toLowerCase()
}

/**
 * Whether a raw selection would survive normalization as a query.
 *
 * Used by the browser half to decide that `resolve()` should return
 * `{ status: 'pass' }` rather than send a request the host would refuse with
 * `empty-query` or `query-too-long`. Returning `pass` consumes nothing, so a
 * keypress with no usable selection keeps its normal meaning (T07).
 *
 * @param raw - the text the reader selected.
 * @returns whether a lookup should be attempted.
 */
export function isEligibleSelectionText(raw: string): boolean {
  if (countCodePoints(raw.trim()) > MAX_QUERY_CODE_POINTS) return false
  return normalizeHeadword(raw).length > 0
}
