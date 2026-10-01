/**
 * The stub dictionary.
 *
 * Phase 1's dictionary is a fixture, and these tests exist so that a failing
 * integration run can never be blamed on it: the mapping from a surface form to
 * a headword is pinned here, and the T10/T11 fixtures the test matrix names
 * (`derived` → `derive`, `went` → `go`) are asserted directly.
 */

import { describe, expect, it } from 'vitest'

import { lookupStub, STUB_HEADWORDS } from '../src/host/dictionary.js'

describe('lookupStub', () => {
  it('finds a headword directly', () => {
    const entry = lookupStub('derive')
    expect(entry?.headword).toBe('derive')
    expect(entry?.phonetic.length).toBeGreaterThan(0)
    expect(entry?.meanings.length).toBeGreaterThan(0)
    expect(entry?.examples.length).toBeGreaterThan(0)
  })

  it('resolves the T10 fixture: derived resolves to derive', () => {
    expect(lookupStub('derived')?.headword).toBe('derive')
  })

  it('resolves the T11 fixture: went resolves to go', () => {
    expect(lookupStub('went')?.headword).toBe('go')
  })

  it('resolves the other inflections it declares', () => {
    for (const form of ['derives', 'deriving', 'goes', 'going', 'gone', 'looked', 'words']) {
      expect(lookupStub(form), form).toBeDefined()
    }
  })

  it('returns undefined for a word it does not contain', () => {
    expect(lookupStub('zzz-not-a-word')).toBeUndefined()
    expect(lookupStub('')).toBeUndefined()
  })

  it('is case sensitive by contract: the caller normalizes first', () => {
    // The handler always passes `normalizeHeadword` output; a capitalized key
    // must not accidentally match.
    expect(lookupStub('Derive')).toBeUndefined()
  })

  it('exposes every headword it claims to know', () => {
    expect(STUB_HEADWORDS.length).toBeGreaterThan(0)
    for (const headword of STUB_HEADWORDS) {
      expect(lookupStub(headword)?.headword, headword).toBe(headword)
    }
  })

  it('returns stable references, so the same word is never rebuilt per request', () => {
    expect(lookupStub('derive')).toBe(lookupStub('derived'))
  })
})
