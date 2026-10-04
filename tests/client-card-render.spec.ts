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
})
