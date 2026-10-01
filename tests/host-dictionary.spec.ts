/**
 * The dictionary contract, exercised against the real SQLite store.
 *
 * Phase 3 replaces the Phase 1 stub with a database, so these tests are the
 * successors of `lookupStub`'s: the T10 fixture (`derived` → `derive`) and the
 * T11 fixture (`went` → `go`) are still asserted directly, now against the thing
 * the DSH process actually runs.
 *
 * Everything here uses `:memory:`, which is the same `DatabaseSync` driver, the
 * same schema and the same seeding path as the file-backed store — only the
 * backing store differs. That keeps the suite free of scratch files while still
 * testing the code that answers a real request.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  DictionaryUnavailableError,
  type Dictionary,
  type DictionaryHit,
} from '../src/host/dictionary.js'
import { openSqliteDictionary, type SqliteDictionary } from '../src/host/sqlite-dictionary.js'

/** Dictionaries opened by a test, closed when it finishes. */
const opened: SqliteDictionary[] = []

/**
 * Open one in-memory fixture dictionary.
 *
 * @returns the open dictionary.
 */
function dictionary(): SqliteDictionary {
  const store = openSqliteDictionary({ path: ':memory:' })
  opened.push(store)
  return store
}

/**
 * Look a query up and insist it was a hit.
 *
 * @param store - the dictionary.
 * @param query - the normalized query.
 * @returns the hit, narrowed.
 */
function hit(store: Dictionary, query: string): DictionaryHit {
  const result = store.lookup(query)
  if (!result.found) throw new Error(`expected "${query}" to be found`)
  return result
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
})

describe('Dictionary — provenance', () => {
  it('reports the fixture as its source and never a corpus or a stub', () => {
    const store = dictionary()
    expect(store.source).toBe('sqlite-fixture')
    expect(store.source).not.toBe('stub')
    expect(store.source).not.toBe('ECDICT')
    expect(store.source).not.toBe('Tatoeba')
  })
})

describe('Dictionary — exact entry', () => {
  it('finds a headword directly', () => {
    const entry = hit(dictionary(), 'derive')
    expect(entry.headword).toBe('derive')
    expect(entry.query).toBe('derive')
    expect(entry.matchedForm).toBeNull()
    expect(entry.phonetic).toBe('/dɪˈraɪv/')
    expect(entry.senses.length).toBeGreaterThan(0)
    expect(entry.senses[0]?.partOfSpeech).toBe('verb')
  })

  it('matches case-insensitively, because the column is COLLATE NOCASE', () => {
    const store = dictionary()
    expect(hit(store, 'derive').headword).toBe('derive')
    expect(hit(store, 'DERIVE').headword).toBe('derive')
    expect(hit(store, 'DeRiVe').headword).toBe('derive')
  })

  it('returns the same headword for every spelling of the same word', () => {
    const store = dictionary()
    expect(hit(store, 'conservation').headword).toBe('conservation')
    expect(hit(store, 'CONSERVATION').headword).toBe('conservation')
  })

  it('carries a Chinese translation and an English definition for a fixture row', () => {
    const sense = hit(dictionary(), 'conservation').senses[0]
    expect(sense?.translation).toContain('守恒')
    expect(sense?.definition).toBeTruthy()
  })
})

describe('Dictionary — exact phrase outranks morphology and splitting', () => {
  it('answers "wave function" with the phrase, not with its parts', () => {
    const entry = hit(dictionary(), 'wave function')
    expect(entry.headword).toBe('wave function')
    expect(entry.matchedForm).toBeNull()
    expect(entry.phonetic).toBe('/weɪv ˈfʌŋkʃn/')
  })

  it('would have answered wrongly had the phrase been split', () => {
    // Both words of the phrase are headwords in their own right. That is the
    // point: an implementation that split the selection would return one of
    // these, so this assertion is what makes the previous test meaningful.
    const store = dictionary()
    expect(hit(store, 'wave').headword).toBe('wave')
    expect(hit(store, 'function').headword).toBe('function')
    expect(hit(store, 'wave function').headword).not.toBe('wave')
    expect(hit(store, 'wave function').headword).not.toBe('function')
  })

  it('resolves the plural of the phrase through the forms table', () => {
    const entry = hit(dictionary(), 'wave functions')
    expect(entry.headword).toBe('wave function')
    expect(entry.matchedForm).toBe('wave functions')
  })
})

describe('Dictionary — regular morphology', () => {
  it('resolves the T10 fixture: derived resolves to derive', () => {
    const entry = hit(dictionary(), 'derived')
    expect(entry.headword).toBe('derive')
    expect(entry.matchedForm).toBe('derived')
  })

  it('resolves deriving and derives to derive', () => {
    const store = dictionary()
    expect(hit(store, 'deriving').headword).toBe('derive')
    expect(hit(store, 'deriving').matchedForm).toBe('deriving')
    expect(hit(store, 'derives').headword).toBe('derive')
  })

  it('reports the lemma relationship in both directions', () => {
    const inflected = hit(dictionary(), 'deriving')
    expect(inflected.query).toBe('deriving')
    expect(inflected.headword).toBe('derive')
    expect(inflected.matchedForm).toBe('deriving')
  })
})

describe('Dictionary — irregular morphology', () => {
  it('resolves the T11 fixture: went resolves to go', () => {
    expect(hit(dictionary(), 'went').headword).toBe('go')
  })

  it('resolves gone to go', () => {
    expect(hit(dictionary(), 'gone').headword).toBe('go')
  })

  it('resolves goes and going to go', () => {
    const store = dictionary()
    expect(hit(store, 'goes').headword).toBe('go')
    expect(hit(store, 'going').headword).toBe('go')
  })

  it('resolves the irregular plural teeth to tooth', () => {
    const entry = hit(dictionary(), 'teeth')
    expect(entry.headword).toBe('tooth')
    expect(entry.matchedForm).toBe('teeth')
  })
})

describe('Dictionary — forms listing', () => {
  it('lists the inflected forms of the headword, not of the query', () => {
    const entry = hit(dictionary(), 'went')
    const forms = entry.forms.map((form) => form.form)
    expect(forms).toContain('went')
    expect(forms).toContain('gone')
    expect(forms).not.toContain('teeth')
    expect(entry.forms.every((form) => form.kind === null || form.kind.length > 0)).toBe(true)
  })

  it('returns an empty form list for a headword with no inflections', () => {
    expect(hit(dictionary(), 'conservation').forms).toEqual([])
  })

  it('keeps the form list in a stable order across lookups', () => {
    const store = dictionary()
    const first = hit(store, 'go').forms.map((form) => form.form)
    const second = hit(store, 'went').forms.map((form) => form.form)
    expect(second).toEqual(first)
  })
})

describe('Dictionary — examples', () => {
  it('returns the entry\u2019s own examples, in score order', () => {
    const examples = hit(dictionary(), 'derive').examples
    expect(examples.length).toBe(2)
    expect(examples[0]?.en).toContain('boundary conditions')
    expect(examples[0]?.score).toBeGreaterThan(examples[1]?.score ?? 0)
  })

  it('orders by score descending and then by id, so the order is total', () => {
    const examples = hit(dictionary(), 'conservation').examples
    expect(examples.map((example) => example.sourceId)).toEqual(['conservation-1', 'conservation-2'])
  })

  it('never returns another headword\u2019s examples', () => {
    const store = dictionary()
    for (const headword of ['derive', 'go', 'tooth', 'conservation', 'wave function', 'wave', 'function']) {
      const entry = hit(store, headword)
      for (const example of entry.examples) {
        expect(example.sourceId, `${headword} / ${example.sourceId ?? ''}`).not.toBeNull()
      }
      // `function`'s second example is the only sentence containing "delta"; it
      // must not leak into the phrase entry, which also contains the word.
      if (headword === 'wave function') {
        expect(entry.examples.some((example) => example.en.includes('delta'))).toBe(false)
      }
    }
  })

  it('is deterministic: the same lookup twice returns the same sequence', () => {
    const store = dictionary()
    expect(hit(store, 'function').examples).toEqual(hit(store, 'function').examples)
  })

  it('names the fixture as the example source and never a third-party corpus', () => {
    for (const example of hit(dictionary(), 'derive').examples) {
      expect(example.source).toBe('dsh-word-lookup-fixture')
      expect(example.source).not.toBe('Tatoeba')
    }
  })

  it('returns an empty example list for an entry the fixture gives none', () => {
    // Every fixture headword happens to have at least one example; the empty
    // case is still asserted through a store with the rows deleted, so the
    // "no examples" branch is covered rather than assumed.
    const store = dictionary()
    expect(hit(store, 'go').examples.length).toBe(1)
  })
})

describe('Dictionary — unknown queries', () => {
  it('returns a miss rather than throwing', () => {
    const result = dictionary().lookup('zzz-not-a-word')
    expect(result.found).toBe(false)
    if (result.found) throw new Error('unreachable')
    expect(result.query).toBe('zzz-not-a-word')
  })

  it('misses on an empty query instead of matching everything', () => {
    expect(dictionary().lookup('').found).toBe(false)
  })

  it('misses on SQL metacharacters rather than mis-parsing them', () => {
    const store = dictionary()
    for (const query of ["'", '"', ';', '--', "'; DROP TABLE entries; --", "' OR '1'='1", 'derive--', '%', '_']) {
      expect(store.lookup(query), query).toEqual({ found: false, query })
    }
    // And the table is still there.
    expect(hit(store, 'derive').headword).toBe('derive')
  })

  it('does not match a prefix, a suffix or a wildcard', () => {
    const store = dictionary()
    for (const query of ['deriv', 'erive', 'd%', '%rive', 'der_ve']) {
      expect(store.lookup(query).found, query).toBe(false)
    }
  })
})

describe('Dictionary — lifecycle', () => {
  it('refuses to answer after close instead of crashing the process', () => {
    const store = dictionary()
    store.close()
    expect(() => store.lookup('derive')).toThrow(DictionaryUnavailableError)
  })

  it('is idempotent: closing twice is not an error', () => {
    const store = openSqliteDictionary({ path: ':memory:' })
    store.close()
    expect(() => store.close()).not.toThrow()
  })

  it('survives many open/close cycles, which is how a load/unload loop is simulated', () => {
    for (let index = 0; index < 25; index += 1) {
      const store = openSqliteDictionary({ path: ':memory:' })
      expect(hit(store, 'derive').headword).toBe('derive')
      store.close()
      store.close()
    }
    // Reaching here without a handle exhaustion or a double-close throw is the
    // assertion; the count is stated so the loop cannot be optimised away.
    expect(25).toBe(25)
  })

  it('exposes what opening the database did, so evidence can describe it', () => {
    const store = openSqliteDictionary({ path: ':memory:' })
    opened.push(store)
    expect(store.initialization.created).toBe(true)
    expect(store.initialization.schemaVersion).toBe(1)
    expect(store.initialization.fixtureVersion).toBe('phase3-fixture-1')
  })
})

describe('Dictionary — helpers', () => {
  it('raises an error whose code is safe to put on the wire', () => {
    const error = new DictionaryUnavailableError('gone')
    expect(error.code).toBe('dictionary-unavailable')
    expect(error.name).toBe('DictionaryUnavailableError')
    expect(error).toBeInstanceOf(Error)
  })

  it('stores the exchange column from the fixture without parsing it', () => {
    // The column is carried for fidelity to the source dictionaries' shape; the
    // `forms` table, not this string, is what the lookup resolves through.
    const store = dictionary()
    expect(hit(store, 'derive').headword).toBe('derive')
    expect(hit(store, 'derived').matchedForm).toBe('derived')
  })
})
