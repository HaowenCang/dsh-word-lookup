/**
 * Shared text normalization.
 *
 * These are the rules that decide whether a raw selection becomes a query and
 * what headword the host actually looks up. Both halves call the same functions,
 * so a change here is visible to the browser predicate and the host handler at
 * once; the cases below pin the behaviour they must agree on.
 */

import { afterAll, describe, expect, it } from 'vitest'

import { openSqliteDictionary } from '../src/host/sqlite-dictionary.js'
import { MAX_QUERY_CODE_POINTS } from '../src/shared/protocol.js'
import {
  countCodePoints,
  isEligibleSelectionText,
  normalizeHeadword,
  splitGlosses,
} from '../src/shared/text.js'

describe('normalizeHeadword', () => {
  it('folds case and trims surrounding whitespace', () => {
    expect(normalizeHeadword('  Derive  ')).toBe('derive')
  })

  it('collapses internal whitespace, including the break a wrapped paragraph produces', () => {
    expect(normalizeHeadword('boundary\n  conditions')).toBe('boundary conditions')
    expect(normalizeHeadword('boundary\tconditions')).toBe('boundary conditions')
  })

  it('strips edge punctuation a reader drags over', () => {
    expect(normalizeHeadword('derive.')).toBe('derive')
    expect(normalizeHeadword('"derive,"')).toBe('derive')
    expect(normalizeHeadword('(derive)')).toBe('derive')
    expect(normalizeHeadword('\u2018derive\u2019')).toBe('derive')
    expect(normalizeHeadword('\u2014 derive \u2026')).toBe('derive')
  })

  it('strips punctuation on both sides at once, after collapsing the break', () => {
    expect(normalizeHeadword('  "derive."\n')).toBe('derive')
  })

  it('returns the empty string when nothing survives', () => {
    expect(normalizeHeadword('')).toBe('')
    expect(normalizeHeadword('   ')).toBe('')
    expect(normalizeHeadword('...')).toBe('')
    expect(normalizeHeadword('" "')).toBe('')
  })

  it('keeps internal punctuation, which is what makes a hyphenated term one word', () => {
    expect(normalizeHeadword('well-known')).toBe('well-known')
  })
})

describe('normalizeHeadword — NFKC folding (product specification)', () => {
  it('folds full-width Latin to ASCII', () => {
    expect(normalizeHeadword('\uff44\uff45\uff52\uff49\uff56\uff45')).toBe('derive')
    expect(normalizeHeadword('WAVE FUNCTION')).toBe('wave function')
  })

  it('folds full-width punctuation, then strips it as edge punctuation', () => {
    // The fold has to happen before the strip: `．` is not in the ASCII edge set.
    expect(normalizeHeadword('\uff44\uff45\uff52\uff49\uff56\uff45\uff0e')).toBe('derive')
    expect(normalizeHeadword('\uff02derive\uff02')).toBe('derive')
    expect(normalizeHeadword('\uff08derive\uff09')).toBe('derive')
  })

  it('folds a ligature, so a typeset word reaches the dictionary as the word it looks like', () => {
    expect(normalizeHeadword('\ufb01le')).toBe('file')
    expect(normalizeHeadword('o\ufb03ce')).toBe('office')
  })

  it('composes a combining sequence', () => {
    expect(normalizeHeadword('cafe\u0301')).toBe('caf\u00e9')
    // U+FB01 (ﬁ) folded to "fi", then case-folded.
    expect(normalizeHeadword('\ufb01Nal')).toBe('final')
  })

  it('folds a no-break space, then collapses it like any other whitespace', () => {
    expect(normalizeHeadword('wave\u00a0function')).toBe('wave function')
    expect(normalizeHeadword('\u2007derive\u2007')).toBe('derive')
  })

  it('keeps an apostrophe inside a word, straight or curly', () => {
    // NFKC does not fold U+2019 to U+0027, and only *edge* punctuation is
    // removed, so both spellings stay one word rather than being truncated.
    expect(normalizeHeadword("don't")).toBe("don't")
    expect(normalizeHeadword('don\u2019t')).toBe('don\u2019t')
    expect(normalizeHeadword("don't.")).toBe("don't")
  })

  it('keeps a hyphen inside a word', () => {
    expect(normalizeHeadword('time-dependent')).toBe('time-dependent')
    expect(normalizeHeadword('time-dependent,')).toBe('time-dependent')
  })

  it('folds an abbreviation to the form the dictionary holds, without inventing one', () => {
    // Folding is character-level only: it turns `No.` into `no`, and leaves the
    // dictionary to decide whether `no` is a word. It never expands `e.g.`.
    expect(normalizeHeadword('No.')).toBe('no')
    expect(normalizeHeadword('e.g.')).toBe('e.g')
  })
})

describe('splitGlosses', () => {
  it('splits a multi-gloss cell on the full-width semicolon', () => {
    expect(splitGlosses('\u5bfc\u51fa\uff1b\u6d3e\u751f\uff1b\u6e90\u81ea')).toEqual([
      '\u5bfc\u51fa',
      '\u6d3e\u751f',
      '\u6e90\u81ea',
    ])
  })

  it('returns a single gloss unchanged', () => {
    expect(splitGlosses('\u6ce2\u51fd\u6570')).toEqual(['\u6ce2\u51fd\u6570'])
  })

  it('accepts the ASCII semicolon too, and trims each gloss', () => {
    expect(splitGlosses('a ; b')).toEqual(['a', 'b'])
  })

  it('returns nothing for an empty cell', () => {
    expect(splitGlosses('  ')).toEqual([])
    expect(splitGlosses('')).toEqual([])
    expect(splitGlosses(null)).toEqual([])
  })
})

describe('countCodePoints', () => {
  it('counts code points rather than UTF-16 units', () => {
    expect(countCodePoints('abc')).toBe(3)
    expect(countCodePoints('\u4e2d\u6587')).toBe(2)
    // An astral character is two UTF-16 units and one code point.
    expect(countCodePoints('\u{1f600}')).toBe(1)
    expect('\u{1f600}'.length).toBe(2)
  })
})

describe('isEligibleSelectionText', () => {
  it('accepts ordinary words and phrases', () => {
    expect(isEligibleSelectionText('derive')).toBe(true)
    expect(isEligibleSelectionText('  derive. ')).toBe(true)
  })

  it('rejects selections that normalize to nothing', () => {
    expect(isEligibleSelectionText('')).toBe(false)
    expect(isEligibleSelectionText('   ')).toBe(false)
    expect(isEligibleSelectionText('...')).toBe(false)
  })

  it('accepts a selection at exactly the code-point ceiling', () => {
    const atCeiling = 'a'.repeat(MAX_QUERY_CODE_POINTS)
    expect(isEligibleSelectionText(atCeiling)).toBe(true)
  })

  it('rejects a selection above the ceiling, measured in code points', () => {
    expect(isEligibleSelectionText('a'.repeat(MAX_QUERY_CODE_POINTS + 1))).toBe(false)
    // 96 astral characters are 192 UTF-16 units but still exactly at the ceiling.
    expect(isEligibleSelectionText('\u{1f600}'.repeat(MAX_QUERY_CODE_POINTS))).toBe(true)
    expect(isEligibleSelectionText('\u{1f600}'.repeat(MAX_QUERY_CODE_POINTS + 1))).toBe(false)
  })
})

describe('normalization feeds the dictionary exactly as the phase requires', () => {
  /** The store the whole normalization → lookup path is measured against. */
  const dictionary = openSqliteDictionary({ path: ':memory:' })

  afterAll(() => {
    dictionary.close()
  })

  /**
   * Run one raw selection through the whole path.
   *
   * @param raw - the text a reader selected.
   * @returns the normalized query and the headword it resolved to.
   */
  function resolve(raw: string): { query: string; headword: string | null } {
    const query = normalizeHeadword(raw)
    const result = dictionary.lookup(query)
    return { query, headword: result.found ? result.headword : null }
  }

  it('" derive " becomes a lookup of derive', () => {
    expect(resolve('  derive  ')).toEqual({ query: 'derive', headword: 'derive' })
  })

  it('"derived" is looked up as itself and resolved to derive', () => {
    expect(resolve('derived')).toEqual({ query: 'derived', headword: 'derive' })
  })

  it('"WENT" is folded, looked up as went and resolved to go', () => {
    expect(resolve('WENT')).toEqual({ query: 'went', headword: 'go' })
  })

  it('"wave function" resolves to the exact phrase', () => {
    expect(resolve('wave function')).toEqual({ query: 'wave function', headword: 'wave function' })
    expect(resolve('  Wave   Function. ')).toEqual({ query: 'wave function', headword: 'wave function' })
  })

  it('does not stem: an unlisted inflection is a miss, not a guess', () => {
    // `conservations` is a plausible English word and is deliberately not in the
    // fixture. A stemmer would answer `conservation`; this must not.
    expect(resolve('conservations')).toEqual({ query: 'conservations', headword: null })
  })

  it('does not correct spelling: a near miss stays a miss', () => {
    for (const typo of ['derve', 'drived', 'teath', 'conversation']) {
      expect(resolve(typo).headword, typo).toBeNull()
    }
  })

  it('does not invent a lemma: an unknown inflection is not mapped to a headword', () => {
    expect(resolve('wented').headword).toBeNull()
    expect(resolve('goed').headword).toBeNull()
  })

  it('never splits a phrase into separate word queries', () => {
    // `wave` and `function` are both entries. A splitter would answer one of
    // them, so the headword is what proves the phrase was not split.
    expect(resolve('wave function').headword).toBe('wave function')
    expect(resolve('wave function').headword).not.toBe('wave')
    expect(resolve('wave function').headword).not.toBe('function')
  })
})
