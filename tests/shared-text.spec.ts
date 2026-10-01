/**
 * Shared text normalization.
 *
 * These are the rules that decide whether a raw selection becomes a query and
 * what headword the host actually looks up. Both halves call the same functions,
 * so a change here is visible to the browser predicate and the host handler at
 * once; the cases below pin the behaviour they must agree on.
 */

import { describe, expect, it } from 'vitest'

import { MAX_QUERY_CODE_POINTS } from '../src/shared/protocol.js'
import { countCodePoints, isEligibleSelectionText, normalizeHeadword } from '../src/shared/text.js'

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
