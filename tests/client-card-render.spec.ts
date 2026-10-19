/**
 * Unit tests for Result Card state rendering and information hierarchy.
 *
 * Verifies Requirement 45:
 * - loading
 * - found
 * - phonetic null (omitted)
 * - POS null (omitted)
 * - meaning and multiple meanings (order preserved)
 * - matchedForm present vs absent
 * - examples (en only vs en + zh)
 * - translation null
 * - not found (friendly message)
 * - error (no sensitive leaks)
 * - no undefined, null, N/A, [object Object] in user-visible text.
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WordLookupCard, getCardUiState } from '../src/client/card.js'
import { LookupCardStore } from '../src/client/store.js'
import type { LookupFoundResponse } from '../src/shared/protocol.js'

function renderCard(store: LookupCardStore): string {
  return renderToStaticMarkup(React.createElement(WordLookupCard, { store }))
}

function baseFound(overrides: Partial<LookupFoundResponse> = {}): LookupFoundResponse {
  return {
    ok: true,
    found: true,
    query: 'derive',
    headword: 'derive',
    phonetic: '/dɪˈraɪv/',
    meanings: [
      {
        partOfSpeech: 'v.',
        definition: 'obtain something from a specified source.',
        translation: '得到；源于',
      },
    ],
    forms: [{ form: 'derived', kind: 'past' }],
    matchedForm: null,
    examples: [{ en: 'They derive great comfort from this.', zh: '他们从中获得极大安慰。' }],
    source: 'sqlite-fixture',
    settings: { autoDoubleClick: false, autoSelection: false },
    ...overrides,
  }
}

describe('WordLookupCard rendering', () => {
  it('renders nothing (null / empty string) when idle', () => {
    const store = new LookupCardStore()
    expect(renderCard(store)).toBe('')
    expect(getCardUiState(store.getSnapshot())).toBe('idle')
  })

  it('renders loading state immediately with query and clean status', () => {
    const store = new LookupCardStore()
    store.set({ status: 'loading', query: 'derive' })
    const html = renderCard(store)

    expect(getCardUiState(store.getSnapshot())).toBe('loading')
    expect(html).toContain('data-dsh-word-lookup-state="loading"')
    expect(html).toContain('data-dsh-word-lookup-ui-state="loading"')
    expect(html).toContain('derive')
    expect(html).toContain('looking up...')
    expect(html).toContain('data-dsh-word-lookup="close"')
    expect(html).toContain('aria-label="Close dictionary"')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('null')
  })

  it('renders full found entry with headword, phonetic, POS, meanings, and examples', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'derive',
      result: { kind: 'found', body: baseFound() },
    })
    const html = renderCard(store)

    expect(getCardUiState(store.getSnapshot())).toBe('found')
    expect(html).toContain('data-dsh-word-lookup-state="ready"')
    expect(html).toContain('data-dsh-word-lookup-ui-state="found"')
    expect(html).toContain('data-dsh-word-lookup="headword"')
    expect(html).toContain('derive')
    expect(html).toContain('/dɪˈraɪv/')
    expect(html).toContain('v.')
    expect(html).toContain('得到')
    expect(html).toContain('源于')
    expect(html).toContain('They derive great comfort from this.')
    expect(html).toContain('他们从中获得极大安慰。')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('null')
    expect(html).not.toContain('[object Object]')
  })

  it('omits phonetic visually when phonetic is null', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'derive',
      result: { kind: 'found', body: baseFound({ phonetic: null }) },
    })
    const html = renderCard(store)

    expect(html).not.toContain('data-dsh-word-lookup="phonetic"')
    expect(html).not.toContain('/dɪˈraɪv/')
    expect(html).not.toContain('null')
    expect(html).not.toContain('undefined')
  })

  it('omits POS visually when POS is null', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'derive',
      result: {
        kind: 'found',
        body: baseFound({
          meanings: [{ partOfSpeech: null, definition: 'A meaning without POS', translation: '无词性释义' }],
        }),
      },
    })
    const html = renderCard(store)

    expect(html).toContain('无词性释义')
    expect(html).not.toContain('<span style="display:inline-block;padding:1px 5px')
    expect(html).not.toContain('null')
  })

  it('preserves order of multiple meanings', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'derive',
      result: {
        kind: 'found',
        body: baseFound({
          meanings: [
            { partOfSpeech: 'v.', definition: 'first sense', translation: '第一义项' },
            { partOfSpeech: 'n.', definition: 'second sense', translation: '第二义项' },
            { partOfSpeech: 'adj.', definition: 'third sense', translation: '第三义项' },
          ],
        }),
      },
    })
    const html = renderCard(store)

    const posFirst = html.indexOf('第一义项')
    const posSecond = html.indexOf('第二义项')
    const posThird = html.indexOf('第三义项')

    expect(posFirst).toBeGreaterThan(0)
    expect(posSecond).toBeGreaterThan(posFirst)
    expect(posThird).toBeGreaterThan(posSecond)
  })

  it('renders matchedForm relation when query matches an inflection (e.g. went -> go)', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'went',
      result: {
        kind: 'found',
        body: baseFound({
          query: 'went',
          headword: 'go',
          matchedForm: 'went',
        }),
      },
    })
    const html = renderCard(store)

    expect(html).toContain('data-dsh-word-lookup="lemma"')
    expect(html).toContain('went')
    expect(html).toContain('\u2192')
    expect(html).toContain('go')
  })

  it('does NOT render matchedForm when matchedForm is null or identical to headword', () => {
    const storeNull = new LookupCardStore()
    storeNull.set({
      status: 'ready',
      query: 'derive',
      result: { kind: 'found', body: baseFound({ matchedForm: null }) },
    })
    expect(renderCard(storeNull)).not.toContain('data-dsh-word-lookup="lemma"')

    const storeSame = new LookupCardStore()
    storeSame.set({
      status: 'ready',
      query: 'derive',
      result: { kind: 'found', body: baseFound({ matchedForm: 'derive' }) },
    })
    expect(renderCard(storeSame)).not.toContain('data-dsh-word-lookup="lemma"')
  })

  it('renders example English only when example Chinese translation is null', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'derive',
      result: {
        kind: 'found',
        body: baseFound({
          examples: [{ en: 'English example only.', zh: null }],
        }),
      },
    })
    const html = renderCard(store)

    expect(html).toContain('English example only.')
    expect(html).not.toContain('null')
    expect(html).not.toContain('undefined')
  })

  it('renders clean not-found message without error styling or trace', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'unknownword',
      result: {
        kind: 'not-found',
        body: {
          ok: true,
          found: false,
          query: 'unknownword',
          source: 'sqlite-fixture',
          settings: { autoDoubleClick: false, autoSelection: false },
        },
      },
    })
    const html = renderCard(store)

    expect(getCardUiState(store.getSnapshot())).toBe('not-found')
    expect(html).toContain('data-dsh-word-lookup-state="ready"')
    expect(html).toContain('data-dsh-word-lookup-ui-state="not-found"')
    expect(html).toContain('data-dsh-word-lookup="not-found"')
    expect(html).toContain('no entry for')
    expect(html).toContain('unknownword')
    expect(html).not.toContain('error')
    expect(html).not.toContain('stack')
  })

  it('renders error state cleanly without leaking internal tokens, paths or SQL', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'failed',
      query: 'derive',
      failure: { kind: 'network', message: 'Failed to fetch /api/dsh-word-lookup?token=secret' },
    })
    const html = renderCard(store)

    expect(getCardUiState(store.getSnapshot())).toBe('error')
    expect(html).toContain('data-dsh-word-lookup-ui-state="error"')
    expect(html).toContain('data-dsh-word-lookup="error"')
    // Should render a clean, sanitized message
    expect(html).toContain('Dictionary service unavailable')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('/api/dsh-word-lookup')
    expect(html).not.toContain('SELECT')
  })

  it('renders controlled refusal error with clean status code', () => {
    const store = new LookupCardStore()
    store.set({
      status: 'ready',
      query: 'a'.repeat(120),
      result: {
        kind: 'refused',
        httpStatus: 400,
        code: 'query-too-long',
        message: 'refused',
      },
    })
    const html = renderCard(store)

    expect(getCardUiState(store.getSnapshot())).toBe('error')
    expect(html).toContain('Request refused (400)')
    expect(html).not.toContain('undefined')
  })

  describe('FMT-01: Line break and multiline formatting for definitions and translations', () => {
    function countOccurrences(text: string, search: string): number {
      let count = 0
      let pos = text.indexOf(search)
      while (pos !== -1) {
        count += 1
        pos = text.indexOf(search, pos + search.length)
      }
      return count
    }

    it('renders pass entry with literal \\n escape sequences as distinct visible block lines', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'pass',
        result: {
          kind: 'found',
          body: baseFound({
            headword: 'pass',
            phonetic: '/pɑːs/',
            meanings: [
              {
                partOfSpeech: null,
                translation:
                  'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口\\nvt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准\\nvi. 经过, 穿过, 变化, 终止, 传递, 被通过',
                definition:
                  'n. (sports) the act of throwing the ball to another member of your team\\nn. a success in a test or exam\\nv. to move past something or someone\\nv. to give something to someone using your hands',
              },
            ],
            forms: [
              { form: 'passed', kind: 'past' },
              { form: 'passing', kind: 'participle' },
            ],
            examples: [],
          }),
        },
      })
      const html = renderCard(store)

      // 3 translation lines and 4 definition lines in DOM structure
      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(3)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(4)

      // Translation lines content and ordering
      expect(html).toContain('n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口')
      expect(html).toContain('vt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准')
      expect(html).toContain('vi. 经过, 穿过, 变化, 终止, 传递, 被通过')

      const posN = html.indexOf('n. 穿过')
      const posVt = html.indexOf('vt. 通过')
      const posVi = html.indexOf('vi. 经过')
      expect(posN).toBeGreaterThan(0)
      expect(posVt).toBeGreaterThan(posN)
      expect(posVi).toBeGreaterThan(posVt)

      // Definition lines content and ordering
      expect(html).toContain('the act of throwing the ball')
      expect(html).toContain('a success in a test or exam')
      expect(html).toContain('to move past something or someone')
      expect(html).toContain('to give something to someone using your hands')

      // Must not display literal \n in visible text
      expect(html).not.toContain('\\n')
    })

    it('renders pass entry with real LF (\\n) line breaks identically to literal \\n', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'pass',
        result: {
          kind: 'found',
          body: baseFound({
            headword: 'pass',
            phonetic: '/pɑːs/',
            meanings: [
              {
                partOfSpeech: null,
                translation:
                  'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口\nvt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准\nvi. 经过, 穿过, 变化, 终止, 传递, 被通过',
                definition:
                  'n. (sports) the act of throwing the ball to another member of your team\nn. a success in a test or exam\nv. to move past something or someone\nv. to give something to someone using your hands',
              },
            ],
            forms: [],
            examples: [],
          }),
        },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(3)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(4)
      expect(html).toContain('n. 穿过, 通过, 经过')
      expect(html).toContain('vt. 通过, 经过, 穿过')
      expect(html).toContain('vi. 经过, 穿过, 变化')
    })

    it('handles CRLF, CR, and mixed line breaks cleanly', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'test',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [
              {
                partOfSpeech: 'v.',
                translation: '段落一\r\n段落二\r段落三\\r\\n段落四',
                definition: 'def 1\r\ndef 2\rdef 3\\r\\ndef 4',
              },
            ],
          }),
        },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(4)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(4)
      expect(html).toContain('段落一')
      expect(html).toContain('段落二')
      expect(html).toContain('段落三')
      expect(html).toContain('段落四')
    })

    it('correctly nests semicolon glosses within multiline translation blocks', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'pass',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [
              {
                partOfSpeech: 'v.',
                translation: 'n. 穿过；通行证\\nvt. 通过；传递',
                definition: 'to move past\\nto give over',
              },
            ],
          }),
        },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(2)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(2)
      // Each line has 2 gloss spans -> 4 total
      expect(countOccurrences(html, 'data-dsh-word-lookup="gloss"')).toBe(4)
      expect(html).toContain('n. 穿过')
      expect(html).toContain('通行证')
      expect(html).toContain('vt. 通过')
      expect(html).toContain('传递')
    })

    it('collapses consecutive empty lines and strips leading/trailing blanks', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'test',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [
              {
                partOfSpeech: 'n.',
                translation: '\\n\\nline 1\\n\\n\\nline 2\\n\\n',
                definition: '\n\ndef 1\n   \n\ndef 2\n\n',
              },
            ],
          }),
        },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(2)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(2)
      expect(html).toContain('line 1')
      expect(html).toContain('line 2')
      expect(html).toContain('def 1')
      expect(html).toContain('def 2')
    })

    it('preserves legitimate and double-escaped backslashes', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'test',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [
              {
                partOfSpeech: null,
                translation: '公式 \\lambda + \\mu\\n路径 C:\\path\\to\\dir',
                definition: 'literal\\\\nnot-newline\\nactual-newline',
              },
            ],
          }),
        },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(2)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(2)
      expect(html).toContain('\\lambda + \\mu')
      expect(html).toContain('C:\\path\\to\\dir')
      expect(html).toContain('literal\\nnot-newline')
      expect(html).toContain('actual-newline')
    })

    it('guarantees React safe escaping for HTML payloads (pure text, no XSS)', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'xss-probe',
        result: {
          kind: 'found',
          body: baseFound({
            headword: 'xss-probe',
            meanings: [
              {
                partOfSpeech: '<script>alert(1)</script>',
                translation: '<img src=x onerror=alert(2)>\\n<b onclick="evil()">bold</b>',
                definition: '<iframe src="javascript:evil()"></iframe>',
              },
            ],
          }),
        },
      })
      const html = renderCard(store)

      // Verifies HTML is strictly escaped
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).not.toContain('<img src=x')
      expect(html).not.toContain('<iframe')
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
      expect(html).toContain('&lt;b onclick=&quot;evil()&quot;&gt;bold&lt;/b&gt;')
      expect(html).toContain('&lt;iframe src=&quot;javascript:evil()&quot;&gt;&lt;/iframe&gt;')
    })

    it('renders single-line entries without visual regression', () => {
      const store = new LookupCardStore()
      store.set({
        status: 'ready',
        query: 'derive',
        result: { kind: 'found', body: baseFound() },
      })
      const html = renderCard(store)

      expect(countOccurrences(html, 'data-dsh-word-lookup="translation-line"')).toBe(1)
      expect(countOccurrences(html, 'data-dsh-word-lookup="definition-line"')).toBe(1)
      expect(html).toContain('得到')
      expect(html).toContain('源于')
      expect(html).toContain('obtain something from a specified source.')
    })

    it('handles translation null or definition null cleanly', () => {
      const storeTransNull = new LookupCardStore()
      storeTransNull.set({
        status: 'ready',
        query: 'test',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [{ partOfSpeech: 'n.', translation: null, definition: 'only def' }],
          }),
        },
      })
      const htmlTransNull = renderCard(storeTransNull)
      expect(countOccurrences(htmlTransNull, 'data-dsh-word-lookup="translation-line"')).toBe(0)
      expect(countOccurrences(htmlTransNull, 'data-dsh-word-lookup="definition-line"')).toBe(1)
      expect(htmlTransNull).toContain('only def')
      expect(htmlTransNull).toContain('n.')

      const storeDefNull = new LookupCardStore()
      storeDefNull.set({
        status: 'ready',
        query: 'test',
        result: {
          kind: 'found',
          body: baseFound({
            meanings: [{ partOfSpeech: 'n.', translation: '只有翻译', definition: null }],
          }),
        },
      })
      const htmlDefNull = renderCard(storeDefNull)
      expect(countOccurrences(htmlDefNull, 'data-dsh-word-lookup="translation-line"')).toBe(1)
      expect(countOccurrences(htmlDefNull, 'data-dsh-word-lookup="definition-line"')).toBe(0)
      expect(htmlDefNull).toContain('只有翻译')
      expect(htmlDefNull).toContain('n.')
    })
  })
})
