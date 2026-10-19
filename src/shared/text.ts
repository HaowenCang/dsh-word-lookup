/**
 * Text normalization shared by both halves of `dsh-word-lookup`.
 *
 * A browser selection arrives with whatever punctuation the reader dragged over:
 * a trailing period from the end of a sentence, a leading quotation mark, or a
 * line break from a wrapped paragraph. Normalization is deliberately narrow — it
 * folds compatibility characters, strips edge punctuation, folds case, and
 * collapses internal whitespace, and it does not attempt stemming. Inflection
 * handling belongs to the dictionary (Phase 3), not to the transport.
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
 * The steps and their order are the product specification's:
 *
 * ```text
 * raw selection
 *   -> NFKC                     fold compatibility characters
 *   -> collapse whitespace      a line break becomes one space
 *   -> strip edge punctuation   a sentence-final period is not part of the word
 *   -> lowercase                the lookup is case-normalized
 * ```
 *
 * `NFKC` runs first because it *creates* characters the later steps must then
 * see: a full-width `．` folds to `.` and only then reads as edge punctuation, a
 * no-break space folds to a space and only then collapses, and the ligature `ﬁ`
 * folds to `fi` so a selection from a typeset document reaches the dictionary as
 * the word it looks like. Folding after the strip would leave each of those
 * unfixed.
 *
 * What NFKC deliberately does **not** do is fold `’` to `'`. Both survive, and
 * because only *edge* punctuation is removed, an apostrophe or hyphen inside a
 * word is part of the word: `don't` and `time-dependent` are looked up as
 * themselves.
 *
 * @param raw - the text the reader selected.
 * @returns the normalized candidate; the empty string when nothing survives.
 */
export function normalizeHeadword(raw: string): string {
  const folded = raw.normalize('NFKC')
  const collapsed = folded.replace(WHITESPACE_RUN, ' ').trim()
  const stripped = collapsed.replace(EDGE_PUNCTUATION, '').trim()
  return stripped.replace(WHITESPACE_RUN, ' ').toLowerCase()
}

/**
 * Split a Chinese translation cell into individual glosses.
 *
 * A dictionary cell carries several glosses separated by a full-width
 * semicolon — `导出；派生；源自` — which is the convention the source
 * dictionaries use and the shape the product specification renders as
 * "中文义项 1 / 2 / …". Splitting is presentational and lives here rather than in
 * the storage layer so both halves can render the same list.
 *
 * @param translation - the raw cell, or `null`.
 * @returns the glosses, in order; empty when the cell is `null` or blank.
 */
export function splitGlosses(translation: string | null): readonly string[] {
  if (translation === null) return []
  return translation
    .split(/[；;]/)
    .map((gloss) => gloss.trim())
    .filter((gloss) => gloss.length > 0)
}

/**
 * Split dictionary definitions or translations into distinct, displayable lines.
 *
 * Normalizes multiple newline conventions without multiple or recursive unescaping passes:
 * - Real LF (`\n`), CRLF (`\r\n`), CR (`\r`)
 * - Escaped string literals `\n`, `\r\n`, `\r`
 * - Controlled tab (`\t` and `\t`) substitution (normalized to single space)
 * - Preserves double-escaped backslashes (`\\n` remains literal `\n`)
 * - Preserves legitimate backslashes (e.g. `\lambda`, `C:\dir`)
 * - Trims individual lines and collapses consecutive empty lines
 *
 * @param text - The raw translation or definition string, or null/undefined.
 * @returns Array of non-empty line strings.
 */
export function splitDefinitionLines(text: string | null | undefined): readonly string[] {
  if (text === null || text === undefined) return []

  const lines: string[] = []
  let currentLine = ''
  const len = text.length
  let i = 0

  const pushCurrentLine = (): void => {
    const trimmed = currentLine.trim()
    if (trimmed.length > 0) {
      lines.push(trimmed)
    }
    currentLine = ''
  }

  while (i < len) {
    const c = text[i]!

    // Check for real newlines
    if (c === '\r') {
      if (i + 1 < len && text[i + 1] === '\n') {
        i += 2
      } else {
        i += 1
      }
      pushCurrentLine()
      continue
    }

    if (c === '\n') {
      i += 1
      pushCurrentLine()
      continue
    }

    // Check for real tab
    if (c === '\t') {
      currentLine += ' '
      i += 1
      continue
    }

    // Check for backslash escape sequences
    if (c === '\\') {
      let backslashCount = 0
      while (i < len && text[i] === '\\') {
        backslashCount += 1
        i += 1
      }

      // Append pairs of backslashes as literal backslashes
      const literalBackslashes = Math.floor(backslashCount / 2)
      if (literalBackslashes > 0) {
        currentLine += '\\'.repeat(literalBackslashes)
      }

      // If odd number of backslashes, inspect escaped char
      if (backslashCount % 2 === 1) {
        if (i < len) {
          const next = text[i]!
          if (next === 'n') {
            i += 1
            pushCurrentLine()
            continue
          } else if (next === 'r') {
            i += 1
            // Check if followed by literal \n or real \n
            if (i < len && text[i] === '\n') {
              i += 1
            } else if (i + 1 < len && text[i] === '\\' && text[i + 1] === 'n') {
              i += 2
            }
            pushCurrentLine()
            continue
          } else {
            // Legitimate backslash followed by other char (e.g. \lambda, \to, \alpha)
            currentLine += '\\' + next
            i += 1
            continue
          }
        } else {
          // Trailing single backslash
          currentLine += '\\'
          continue
        }
      }

      continue
    }

    // Normal character
    currentLine += c
    i += 1
  }

  pushCurrentLine()
  return lines
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
