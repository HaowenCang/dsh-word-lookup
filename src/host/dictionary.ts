/**
 * Deterministic stub dictionary for Phase 1.
 *
 * Its only purpose is to make the host → Fetch → client → overlay data path
 * observable end to end. It is not the v0.1.0 dictionary: there is no ECDICT
 * import, no lemma table, no exchange resolution, and no example corpus. The
 * entries below are hand-written constants, so a lookup is reproducible across
 * machines and a failing integration test cannot be confused with a data
 * problem.
 *
 * The inflection map exists so that the Phase 3 form resolution has a shape to
 * replace: 'derived', 'derives' and 'deriving' all resolve to 'derive', which is
 * the fixture behaviour the test matrix names for T10.
 *
 * @module dsh-word-lookup/host/dictionary
 */

import type { LookupExample, LookupMeaning } from '../shared/protocol.js'

/** One stub headword and everything the card can render for it. */
export interface StubEntry {
  /** Canonical headword; the key of {@link STUB_ENTRIES}. */
  readonly headword: string
  /** IPA transcription, as plain text between slashes. */
  readonly phonetic: string
  /** Senses in print order. */
  readonly meanings: readonly LookupMeaning[]
  /** Example sentences, most illustrative first. */
  readonly examples: readonly LookupExample[]
}

/**
 * Inflected surface forms the stub resolves to a headword.
 *
 * A flat table rather than a rule engine: Phase 1 must not grow a stemmer it
 * cannot test, and Phase 3 replaces this wholesale with the ECDICT `exchange`
 * column.
 */
const STUB_INFLECTIONS: Readonly<Record<string, string>> = {
  derived: 'derive',
  derives: 'derive',
  deriving: 'derive',
  deriveds: 'derive',
  went: 'go',
  goes: 'go',
  going: 'go',
  gone: 'go',
  looked: 'look',
  looking: 'look',
  looks: 'look',
  selected: 'select',
  selecting: 'select',
  selects: 'select',
  selections: 'selection',
  dictionaries: 'dictionary',
  words: 'word',
}

/** The stub's content, keyed by canonical headword. */
const STUB_ENTRIES: Readonly<Record<string, StubEntry>> = {
  derive: {
    headword: 'derive',
    phonetic: '/dɪˈraɪv/',
    meanings: [
      { partOfSpeech: 'verb', definition: 'obtain something from (a specified source)' },
      { partOfSpeech: 'verb', definition: 'base a concept on an extension or modification of another' },
      { partOfSpeech: 'verb', definition: 'originate in or be caused by' },
    ],
    examples: [
      { en: 'The result must derive from the boundary conditions alone.', zh: '该结果只能由边界条件导出。' },
      { en: 'This identity derives from Gauss\u2019s law.', zh: '这一恒等式源自高斯定律。' },
    ],
  },
  go: {
    headword: 'go',
    phonetic: '/ɡəʊ/',
    meanings: [
      { partOfSpeech: 'verb', definition: 'move from one place to another' },
      { partOfSpeech: 'verb', definition: 'come to be in a specified state' },
    ],
    examples: [{ en: 'The measurement went the other way.', zh: '测量结果朝相反方向变化了。' }],
  },
  look: {
    headword: 'look',
    phonetic: '/lʊk/',
    meanings: [{ partOfSpeech: 'verb', definition: 'direct the eyes toward something in order to see it' }],
    examples: [{ en: 'Look at the figure before reading the proof.', zh: '先看图，再读证明。' }],
  },
  select: {
    headword: 'select',
    phonetic: '/sɪˈlekt/',
    meanings: [{ partOfSpeech: 'verb', definition: 'carefully choose as being the best or most suitable' }],
    examples: [{ en: 'Select the term to look up.', zh: '选中要查询的词。' }],
  },
  selection: {
    headword: 'selection',
    phonetic: '/sɪˈlekʃn/',
    meanings: [{ partOfSpeech: 'noun', definition: 'a carefully chosen group or item' }],
    examples: [{ en: 'The selection is passed to the host unchanged.', zh: '选区原样传给宿主。' }],
  },
  dictionary: {
    headword: 'dictionary',
    phonetic: '/ˈdɪkʃənri/',
    meanings: [{ partOfSpeech: 'noun', definition: 'a book or electronic resource listing words with meanings' }],
    examples: [{ en: 'The dictionary is queried locally.', zh: '词典在本地查询。' }],
  },
  word: {
    headword: 'word',
    phonetic: '/wɜːd/',
    meanings: [{ partOfSpeech: 'noun', definition: 'a single distinct meaningful element of speech or writing' }],
    examples: [{ en: 'One word is enough to demonstrate the path.', zh: '一个词就足以验证这条链路。' }],
  },
}

/** Every headword the stub knows, for tests and diagnostics. */
export const STUB_HEADWORDS: readonly string[] = Object.keys(STUB_ENTRIES).sort()

/**
 * Resolve and fetch one already-normalized query.
 *
 * @param normalized - output of `normalizeHeadword`, or any lowercase key.
 * @returns the stub entry, or `undefined` when the dictionary has no such word.
 */
export function lookupStub(normalized: string): StubEntry | undefined {
  const direct = STUB_ENTRIES[normalized]
  if (direct !== undefined) return direct
  const base = STUB_INFLECTIONS[normalized]
  return base === undefined ? undefined : STUB_ENTRIES[base]
}
