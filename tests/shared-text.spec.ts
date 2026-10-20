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
  hasExplicitPosPrefix,
  isEligibleSelectionText,
  normalizeHeadword,
  splitDefinitionLines,
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

describe('splitDefinitionLines', () => {
  it('returns empty array for null, undefined, empty string, and whitespace-only text', () => {
    expect(splitDefinitionLines(null)).toEqual([])
    expect(splitDefinitionLines(undefined)).toEqual([])
    expect(splitDefinitionLines('')).toEqual([])
    expect(splitDefinitionLines('   ')).toEqual([])
    expect(splitDefinitionLines('\n\n\r\n')).toEqual([])
    expect(splitDefinitionLines('\\n\\n')).toEqual([])
  })

  it('returns a single line unchanged when no line break exists', () => {
    expect(splitDefinitionLines('single definition line')).toEqual(['single definition line'])
    expect(splitDefinitionLines('  trimmed definition  ')).toEqual(['trimmed definition'])
    expect(splitDefinitionLines('波函数；量子态')).toEqual(['波函数；量子态'])
  })

  it('splits on real LF (\\n)', () => {
    expect(splitDefinitionLines('first line\nsecond line\nthird line')).toEqual([
      'first line',
      'second line',
      'third line',
    ])
  })

  it('splits on real CRLF (\\r\\n) and real CR (\\r)', () => {
    expect(splitDefinitionLines('line 1\r\nline 2\rline 3')).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('splits on literal \\n escape sequence', () => {
    expect(splitDefinitionLines('first line\\nsecond line\\nthird line')).toEqual([
      'first line',
      'second line',
      'third line',
    ])
  })

  it('splits on literal \\r\\n and literal \\r escape sequences', () => {
    expect(splitDefinitionLines('line 1\\r\\nline 2\\rline 3')).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('splits on mixed real and literal line breaks', () => {
    expect(splitDefinitionLines('line 1\nline 2\\nline 3\r\nline 4\\r\\nline 5')).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ])
  })

  it('preserves double-escaped backslash (\\\\n remains literal \\n and does not split)', () => {
    expect(splitDefinitionLines('literal\\\\nnot-a-break')).toEqual(['literal\\nnot-a-break'])
  })

  it('handles triple-escaped backslash (\\\\\\n yields literal backslash and splits)', () => {
    expect(splitDefinitionLines('escaped-slash\\\\\\nsecond-line')).toEqual([
      'escaped-slash\\',
      'second-line',
    ])
  })

  it('preserves legitimate backslashes without splitting (e.g. \\lambda, C:\\dir)', () => {
    expect(splitDefinitionLines('formula: \\lambda + \\mu')).toEqual(['formula: \\lambda + \\mu'])
    expect(splitDefinitionLines('path: C:\\dir\\file.txt')).toEqual(['path: C:\\dir\\file.txt'])
    expect(splitDefinitionLines('operator \\ backslash')).toEqual(['operator \\ backslash'])
  })

  it('handles real tabs by controlled substitution to a space while preserving legitimate text', () => {
    expect(splitDefinitionLines('col1\tcol2\tcol3')).toEqual(['col1 col2 col3'])
    expect(splitDefinitionLines('word \\to another')).toEqual(['word \\to another'])
  })

  it('trims lines and collapses consecutive empty lines without ghost rows', () => {
    expect(splitDefinitionLines('line 1\n\n\nline 2')).toEqual(['line 1', 'line 2'])
    expect(splitDefinitionLines('line 1\\n\\nline 2')).toEqual(['line 1', 'line 2'])
    expect(splitDefinitionLines('line 1\r\n  \r\nline 2')).toEqual(['line 1', 'line 2'])
  })

  it('strips leading and trailing line breaks', () => {
    expect(splitDefinitionLines('\n\nline 1\nline 2\n\n')).toEqual(['line 1', 'line 2'])
    expect(splitDefinitionLines('\\n\\nline 1\\nline 2\\n\\n')).toEqual(['line 1', 'line 2'])
  })

  it('preserves HTML tags and special characters as raw text without decoding or injection', () => {
    const raw = '<script>alert(1)</script>\\n<div class="test">content</div>'
    expect(splitDefinitionLines(raw)).toEqual([
      '<script>alert(1)</script>',
      '<div class="test">content</div>',
    ])
  })

  it('splits synthetic pass entry with multiple POS segments and Chinese glosses', () => {
    const passTranslation =
      'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口\\nvt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准\\nvi. 经过, 穿过, 变化, 终止, 传递, 被通过'
    expect(splitDefinitionLines(passTranslation)).toEqual([
      'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口',
      'vt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准',
      'vi. 经过, 穿过, 变化, 终止, 传递, 被通过',
    ])
  })
})

describe('R3: Backslash newline parsing and legitimate backslash boundary', () => {
  it('verifies character encoding distinction: literal \\n (0x5C 0x6E) vs LF (0x0A) vs CRLF (0x0D 0x0A)', () => {
    const literalEscape = 'line1\\nline2'
    const realLf = 'line1\nline2'
    const realCrlf = 'line1\r\nline2'

    // Verify UTF-8 byte differences
    const literalBytes = Buffer.from(literalEscape, 'utf8')
    const realLfBytes = Buffer.from(realLf, 'utf8')
    const realCrlfBytes = Buffer.from(realCrlf, 'utf8')

    expect(literalBytes).toEqual(Buffer.from([0x6c, 0x69, 0x6e, 0x65, 0x31, 0x5c, 0x6e, 0x6c, 0x69, 0x6e, 0x65, 0x32]))
    expect(realLfBytes).toEqual(Buffer.from([0x6c, 0x69, 0x6e, 0x65, 0x31, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32]))
    expect(realCrlfBytes).toEqual(Buffer.from([0x6c, 0x69, 0x6e, 0x65, 0x31, 0x0d, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32]))

    // Under plugin parsing rules accommodating ECDICT literal escapes and standard newlines, all three normalize to the same split result
    expect(splitDefinitionLines(literalEscape)).toEqual(['line1', 'line2'])
    expect(splitDefinitionLines(realLf)).toEqual(['line1', 'line2'])
    expect(splitDefinitionLines(realCrlf)).toEqual(['line1', 'line2'])
  })

  it('preserves non-newline backslash sequences without double-escaping (e.g. \\lambda, \\alpha, C:\\dir)', () => {
    expect(splitDefinitionLines('\\lambda + \\mu')).toEqual(['\\lambda + \\mu'])
    expect(splitDefinitionLines('\\alpha + \\beta = \\gamma')).toEqual(['\\alpha + \\beta = \\gamma'])
    expect(splitDefinitionLines('word \\to definition')).toEqual(['word \\to definition'])
    expect(splitDefinitionLines('path: C:\\dir\\file.txt')).toEqual(['path: C:\\dir\\file.txt'])
    expect(splitDefinitionLines('D:\\tools\\bin\\app.exe')).toEqual(['D:\\tools\\bin\\app.exe'])
  })

  it('characterizes ambiguity boundary: unescaped single \\n and \\r vs double-escaped literal backslashes', () => {
    // LaTeX commands: \nu, \rho, \nabla
    // Unescaped: \n and \r are interpreted as line breaks under plugin parsing rules
    expect(splitDefinitionLines('\\nu')).toEqual(['u'])
    expect(splitDefinitionLines('\\rho')).toEqual(['ho'])
    expect(splitDefinitionLines('\\nabla')).toEqual(['abla'])

    // Plugin parsing rule: double-backslash strictly preserves literal LaTeX commands without splitting
    expect(splitDefinitionLines('\\\\nu')).toEqual(['\\nu'])
    expect(splitDefinitionLines('\\\\rho')).toEqual(['\\rho'])
    expect(splitDefinitionLines('\\\\nabla')).toEqual(['\\nabla'])

    // Windows paths: C:\new, C:\reports
    // Unescaped: \n and \r split under plugin parsing rules
    expect(splitDefinitionLines('C:\\new\\folder')).toEqual(['C:', 'ew\\folder'])
    expect(splitDefinitionLines('C:\\reports\\data')).toEqual(['C:', 'eports\\data'])

    // Plugin parsing rule: double-backslash strictly preserves Windows path without splitting
    expect(splitDefinitionLines('C:\\\\new\\\\folder')).toEqual(['C:\\new\\folder'])
    expect(splitDefinitionLines('C:\\\\reports\\\\data')).toEqual(['C:\\reports\\data'])
  })
})

describe('hasExplicitPosPrefix', () => {
  it('recognizes standard bare POS prefixes with dot at start of line', () => {
    expect(hasExplicitPosPrefix('n. 穿过, 通过')).toBe(true)
    expect(hasExplicitPosPrefix('v. 穿过, 通过')).toBe(true)
    expect(hasExplicitPosPrefix('vt. 批准')).toBe(true)
    expect(hasExplicitPosPrefix('vi. 变化, 终止')).toBe(true)
    expect(hasExplicitPosPrefix('adj. 漂亮的')).toBe(true)
    expect(hasExplicitPosPrefix('adv. 快速地')).toBe(true)
    expect(hasExplicitPosPrefix('a. 好的')).toBe(true)
    expect(hasExplicitPosPrefix('ad. 慢速地')).toBe(true)
    expect(hasExplicitPosPrefix('prep. 在...上')).toBe(true)
    expect(hasExplicitPosPrefix('pron. 他')).toBe(true)
    expect(hasExplicitPosPrefix('conj. 和')).toBe(true)
    expect(hasExplicitPosPrefix('interj. 哎呀')).toBe(true)
    expect(hasExplicitPosPrefix('int. 喂')).toBe(true)
    expect(hasExplicitPosPrefix('num. 第一')).toBe(true)
    expect(hasExplicitPosPrefix('art. 定冠词')).toBe(true)
    expect(hasExplicitPosPrefix('abbr. 缩写')).toBe(true)
    expect(hasExplicitPosPrefix('pl. 复数')).toBe(true)
  })

  it('recognizes Chinese POS prefixes without space per dictionary convention', () => {
    expect(hasExplicitPosPrefix('n.穿过')).toBe(true)
    expect(hasExplicitPosPrefix('vt.打倒')).toBe(true)
    expect(hasExplicitPosPrefix('vi.登广告')).toBe(true)
    expect(hasExplicitPosPrefix('conj.虽然')).toBe(true)
    expect(hasExplicitPosPrefix('v.& n.穿过')).toBe(true)
  })

  it('recognizes compound POS prefixes (e.g. v.& n., vt. / vi.)', () => {
    expect(hasExplicitPosPrefix('v.& n. 穿过')).toBe(true)
    expect(hasExplicitPosPrefix('vt. / vi. 通过')).toBe(true)
    expect(hasExplicitPosPrefix('adj.& adv. 快速')).toBe(true)
  })

  it('recognizes bracketed POS prefixes', () => {
    expect(hasExplicitPosPrefix('[n.] 穿过')).toBe(true)
    expect(hasExplicitPosPrefix('[n] 穿过')).toBe(true)
    expect(hasExplicitPosPrefix('(vt.) 通过')).toBe(true)
    expect(hasExplicitPosPrefix('(vi) 经过')).toBe(true)
    expect(hasExplicitPosPrefix('[adj.] 漂亮的')).toBe(true)
    expect(hasExplicitPosPrefix('【动】 穿过')).toBe(true)
    expect(hasExplicitPosPrefix('【名】 关口')).toBe(true)
    expect(hasExplicitPosPrefix('【名词】 关口')).toBe(true)
    expect(hasExplicitPosPrefix('〔副〕 快速')).toBe(true)
    expect(hasExplicitPosPrefix('（代） 他')).toBe(true)
  })

  it('rejects ordinary words and sentences (never falsely matches regular text)', () => {
    expect(hasExplicitPosPrefix('得到；源于')).toBe(false)
    expect(hasExplicitPosPrefix('穿过, 通过, 经过')).toBe(false)
    expect(hasExplicitPosPrefix('波函数')).toBe(false)
    expect(hasExplicitPosPrefix('apple is a fruit')).toBe(false)
    expect(hasExplicitPosPrefix('a method of calculating')).toBe(false)
    expect(hasExplicitPosPrefix('an example of usage')).toBe(false)
    expect(hasExplicitPosPrefix('variable name')).toBe(false)
    expect(hasExplicitPosPrefix('nice weather')).toBe(false)
    expect(hasExplicitPosPrefix('1. first definition')).toBe(false)
    expect(hasExplicitPosPrefix('2. second definition')).toBe(false)
    expect(hasExplicitPosPrefix('e.g. for example')).toBe(false)
    expect(hasExplicitPosPrefix('i.e. that is')).toBe(false)
    expect(hasExplicitPosPrefix('etc. and so forth')).toBe(false)
    expect(hasExplicitPosPrefix('C:\\dir\\file.txt')).toBe(false)
    expect(hasExplicitPosPrefix('\\lambda + \\mu')).toBe(false)
  })

  it('rejects non-POS lexical tokens and false positives (e.g. n.example, v.2026)', () => {
    expect(hasExplicitPosPrefix('n.example')).toBe(false)
    expect(hasExplicitPosPrefix('v.2026')).toBe(false)
    expect(hasExplicitPosPrefix('v.1.0')).toBe(false)
    expect(hasExplicitPosPrefix('n.foo')).toBe(false)
    expect(hasExplicitPosPrefix('a.method')).toBe(false)
  })

  it('rejects empty and non-POS bracketed patterns', () => {
    expect(hasExplicitPosPrefix('【】')).toBe(false)
    expect(hasExplicitPosPrefix('【】 穿过')).toBe(false)
    expect(hasExplicitPosPrefix('〔〕')).toBe(false)
    expect(hasExplicitPosPrefix('（）')).toBe(false)
    expect(hasExplicitPosPrefix('【词】')).toBe(false)
    expect(hasExplicitPosPrefix('【其他】')).toBe(false)
    expect(hasExplicitPosPrefix('【化学】')).toBe(false)
  })

  it('handles empty, null, and whitespace inputs safely', () => {
    expect(hasExplicitPosPrefix(null)).toBe(false)
    expect(hasExplicitPosPrefix(undefined)).toBe(false)
    expect(hasExplicitPosPrefix('')).toBe(false)
    expect(hasExplicitPosPrefix('   ')).toBe(false)
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
