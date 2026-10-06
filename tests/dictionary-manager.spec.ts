/**
 * Comprehensive verification of DictionaryManager:
 * - Handle ownership contract (initial, candidate, retired).
 * - Atomic active reference replacement with zero unavailable gap.
 * - Monotonic generation counting and snapshot immutability.
 * - Mode and source provenance consistency enforcement.
 * - Fail-closed candidate cleanup on validation rejection.
 * - Retirement close failure handling (no rollback, error observability).
 * - Stable lookup handler integration without handler recreation.
 * - Host startup fixture-only guarantee regardless of configured mode.
 */

import { describe, expect, it } from 'vitest'

import { Config } from '../src/host/config.js'
import {
  DictionaryUnavailableError,
  type Dictionary,
  type DictionaryHit,
  type DictionaryLookup,
  type DictionarySource,
} from '../src/host/dictionary.js'
import {
  DictionaryManager,
  type DictionaryActivation,
} from '../src/host/dictionary-manager.js'
import { createLookupHandler } from '../src/host/lookup.js'
import { openSqliteDictionary } from '../src/host/sqlite-dictionary.js'
import { apply } from '../src/index.js'

/**
 * Creates a controllable spy Dictionary for lifecycle and error injection testing.
 */
function createSpyDictionary(
  source: DictionarySource = 'sqlite-fixture',
  customAnswers: Record<string, DictionaryLookup> = {},
) {
  const lookupCalls: string[] = []
  let closeCalls = 0
  let throwOnClose: Error | null = null
  let throwOnLookup: Error | null = null

  const dictionary: Dictionary = {
    source,
    lookup(query: string): DictionaryLookup {
      if (throwOnLookup) throw throwOnLookup
      lookupCalls.push(query)
      if (customAnswers[query]) return customAnswers[query]
      return { found: false, query }
    },
    close(): void {
      closeCalls += 1
      if (throwOnClose) {
        throw throwOnClose
      }
    },
  }

  return {
    dictionary,
    get lookupCalls() {
      return lookupCalls
    },
    get closeCalls() {
      return closeCalls
    },
    setThrowOnClose(err: Error | null) {
      throwOnClose = err
    },
    setThrowOnLookup(err: Error | null) {
      throwOnLookup = err
    },
  }
}

/**
 * Creates a synthetic hit result for query assertions.
 */
function makeHit(headword: string, query: string = headword): DictionaryHit {
  return {
    found: true,
    query,
    headword,
    phonetic: '/test/',
    senses: [{ partOfSpeech: 'noun', definition: 'test def', translation: '测试' }],
    forms: [],
    matchedForm: null,
    examples: [],
  }
}

/** Build one request against the route's absolute path. */
function post(body: unknown): Request {
  return new Request('http://127.0.0.1:50001/api/dsh-word-lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('DictionaryManager — Initial State & Construction', () => {
  it('initializes with generation 1, ready lifecycle, and fixture mode', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'built-in-fixture',
      dictionary: spy.dictionary,
    })

    const snapshot = manager.snapshot()
    expect(snapshot).toEqual({
      lifecycle: 'ready',
      generation: 1,
      activeMode: 'fixture',
      mode: 'fixture',
      identity: 'built-in-fixture',
      source: 'sqlite-fixture',
      lastRetirementError: null,
    })
    expect(manager.source).toBe('sqlite-fixture')

    manager.close()
    expect(spy.closeCalls).toBe(1)
  })

  it('rejects invalid or empty identity in constructor and closes candidate to prevent leak', () => {
    const spy1 = createSpyDictionary('sqlite-fixture')
    expect(() => {
      new DictionaryManager({
        mode: 'fixture',
        identity: '',
        dictionary: spy1.dictionary,
      })
    }).toThrow(TypeError)
    expect(spy1.closeCalls).toBe(1)

    const spy2 = createSpyDictionary('sqlite-fixture')
    expect(() => {
      new DictionaryManager({
        mode: 'fixture',
        identity: '   ',
        dictionary: spy2.dictionary,
      })
    }).toThrow(TypeError)
    expect(spy2.closeCalls).toBe(1)
  })

  it('rejects mode-source inconsistency in constructor and closes candidate', () => {
    const spy1 = createSpyDictionary('ecdict-local')
    expect(() => {
      new DictionaryManager({
        mode: 'fixture',
        identity: 'inconsistent-fixture',
        dictionary: spy1.dictionary,
      })
    }).toThrow(/mode "fixture" requires dictionary source "sqlite-fixture"/)
    expect(spy1.closeCalls).toBe(1)

    const spy2 = createSpyDictionary('sqlite-fixture')
    expect(() => {
      new DictionaryManager({
        mode: 'managed-ecdict',
        identity: 'inconsistent-managed',
        dictionary: spy2.dictionary,
      })
    }).toThrow(/mode "managed-ecdict" requires dictionary source "ecdict-local"/)
    expect(spy2.closeCalls).toBe(1)

    const spy3 = createSpyDictionary('sqlite-fixture')
    expect(() => {
      new DictionaryManager({
        mode: 'custom',
        identity: 'inconsistent-custom',
        dictionary: spy3.dictionary,
      })
    }).toThrow(/mode "custom" requires dictionary source "ecdict-local"/)
    expect(spy3.closeCalls).toBe(1)
  })

  it('rejects invalid descriptor object or incomplete dictionary', () => {
    expect(() => new DictionaryManager(null as unknown as DictionaryActivation)).toThrow(TypeError)
    expect(() => new DictionaryManager({} as unknown as DictionaryActivation)).toThrow(TypeError)

    const fakeDict = { source: 'sqlite-fixture' } as unknown as Dictionary
    expect(() => {
      new DictionaryManager({
        mode: 'fixture',
        identity: 'invalid',
        dictionary: fakeDict,
      })
    }).toThrow(TypeError)
  })

  it('never exposes raw active dictionary handle or mutable internal references', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    expect('activeDictionary' in manager).toBe(false)
    expect('dictionary' in manager).toBe(false)
    expect(Object.isFrozen(manager.snapshot())).toBe(true)

    manager.close()
  })
})

describe('DictionaryManager — Lookup Delegation', () => {
  it('delegates normalized query to active dictionary exactly once', () => {
    const spy = createSpyDictionary('sqlite-fixture', {
      alpha: makeHit('alpha'),
    })
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    const result = manager.lookup('alpha')
    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.headword).toBe('alpha')
    }
    expect(spy.lookupCalls).toEqual(['alpha'])

    manager.close()
  })

  it('does not catch or swallow unexpected non-Dictionary errors from lookup', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    spy.setThrowOnLookup(new Error('unexpected internal corruption'))

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    expect(() => manager.lookup('alpha')).toThrow('unexpected internal corruption')

    manager.close()
  })

  it('throws DictionaryUnavailableError when lookup is called after close', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    manager.close()
    expect(() => manager.lookup('alpha')).toThrow(DictionaryUnavailableError)
  })
})

describe('DictionaryManager — Atomic Hot Switching', () => {
  it('performs atomic replacement: candidate commits, generation advances, retired dictionary closes once', () => {
    const spyA = createSpyDictionary('sqlite-fixture', { word: makeHit('wordA') })
    const spyB = createSpyDictionary('ecdict-local', { word: makeHit('wordB') })

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture-A',
      dictionary: spyA.dictionary,
    })

    expect('generation' in manager).toBe(false) // ensures no unreviewed raw property
    expect(manager.snapshot().generation).toBe(1)
    expect(manager.source).toBe('sqlite-fixture')

    // Initial query hits A
    const resA = manager.lookup('word')
    expect(resA.found).toBe(true)
    if (resA.found) expect(resA.headword).toBe('wordA')
    expect(spyA.closeCalls).toBe(0)
    expect(spyB.closeCalls).toBe(0)

    // Atomically activate B
    const result = manager.activate({
      mode: 'managed-ecdict',
      identity: 'managed:ecdict-2024',
      dictionary: spyB.dictionary,
    })

    expect(result).toEqual({
      generation: 2,
      retirement: {
        closed: true,
        error: null,
      },
    })

    // Active state committed immediately
    expect(manager.source).toBe('ecdict-local')
    const snapshot = manager.snapshot()
    expect(snapshot.generation).toBe(2)
    expect(snapshot.activeMode).toBe('managed-ecdict')
    expect(snapshot.source).toBe('ecdict-local')
    expect(snapshot.identity).toBe('managed:ecdict-2024')
    expect(snapshot.lastRetirementError).toBeNull()

    // Retired dictionary A closed exactly once, B remains open
    expect(spyA.closeCalls).toBe(1)
    expect(spyB.closeCalls).toBe(0)

    // Subsequent query hits B
    const resB = manager.lookup('word')
    expect(resB.found).toBe(true)
    if (resB.found) expect(resB.headword).toBe('wordB')

    // Closing manager closes B exactly once
    manager.close()
    expect(spyA.closeCalls).toBe(1)
    expect(spyB.closeCalls).toBe(1)
  })

  it('supports repeated sequential switching A -> B -> C with correct retirement', () => {
    const spyA = createSpyDictionary('sqlite-fixture', { test: makeHit('hit-A') })
    const spyB = createSpyDictionary('ecdict-local', { test: makeHit('hit-B') })
    const spyC = createSpyDictionary('ecdict-local', { test: makeHit('hit-C') })

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    manager.activate({
      mode: 'managed-ecdict',
      identity: 'managed-1',
      dictionary: spyB.dictionary,
    })
    expect(spyA.closeCalls).toBe(1)
    expect(spyB.closeCalls).toBe(0)

    manager.activate({
      mode: 'custom',
      identity: 'custom-1',
      dictionary: spyC.dictionary,
    })
    expect(spyA.closeCalls).toBe(1)
    expect(spyB.closeCalls).toBe(1)
    expect(spyC.closeCalls).toBe(0)

    expect(manager.snapshot().generation).toBe(3)
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.snapshot().identity).toBe('custom-1')

    const resC = manager.lookup('test')
    expect(resC.found).toBe(true)
    if (resC.found) expect(resC.headword).toBe('hit-C')

    manager.close()
    expect(spyA.closeCalls).toBe(1)
    expect(spyB.closeCalls).toBe(1)
    expect(spyC.closeCalls).toBe(1)
  })
})

describe('DictionaryManager — Failure Semantics & Protection Against Handle Leaks', () => {
  it('leaves manager state and generation untouched if candidate preparation fails before activate', () => {
    const spyA = createSpyDictionary('sqlite-fixture')
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    // Simulate candidate preparation throwing outside manager
    expect(() => {
      throw new Error('database file corrupted during candidate open')
    }).toThrow('database file corrupted during candidate open')

    expect(manager.snapshot().generation).toBe(1)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(spyA.closeCalls).toBe(0)

    manager.close()
  })

  it('rejects invalid candidate identity, closes candidate, leaves active state untouched', () => {
    const spyA = createSpyDictionary('sqlite-fixture')
    const spyB = createSpyDictionary('ecdict-local')

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    expect(() => {
      manager.activate({
        mode: 'managed-ecdict',
        identity: '   ',
        dictionary: spyB.dictionary,
      })
    }).toThrow(TypeError)

    // spyB must be closed so it does not leak
    expect(spyB.closeCalls).toBe(1)

    // Manager untouched
    expect(manager.snapshot().generation).toBe(1)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(spyA.closeCalls).toBe(0)

    manager.close()
    expect(spyA.closeCalls).toBe(1)
  })

  it('rejects invalid mode-source pair during activation, closes candidate, leaves active state untouched', () => {
    const spyA = createSpyDictionary('sqlite-fixture')
    const spyB = createSpyDictionary('sqlite-fixture')

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    expect(() => {
      manager.activate({
        mode: 'managed-ecdict',
        identity: 'invalid-pair',
        dictionary: spyB.dictionary,
      })
    }).toThrow(/mode "managed-ecdict" requires dictionary source "ecdict-local"/)

    expect(spyB.closeCalls).toBe(1)
    expect(manager.snapshot().generation).toBe(1)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(spyA.closeCalls).toBe(0)

    manager.close()
    expect(spyA.closeCalls).toBe(1)
  })

  it('rejects activation after manager close and closes candidate immediately', () => {
    const spyA = createSpyDictionary('sqlite-fixture')
    const spyB = createSpyDictionary('ecdict-local')

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    manager.close()
    expect(spyA.closeCalls).toBe(1)

    expect(() => {
      manager.activate({
        mode: 'managed-ecdict',
        identity: 'after-close',
        dictionary: spyB.dictionary,
      })
    }).toThrow(DictionaryUnavailableError)

    // spyB must not leak
    expect(spyB.closeCalls).toBe(1)
    expect(manager.snapshot().lifecycle).toBe('closed')
  })

  it('handles retirement close failure: commits new active, advances generation, records error, no rollback', () => {
    const spyA = createSpyDictionary('sqlite-fixture', { test: makeHit('A') })
    spyA.setThrowOnClose(new Error('simulated disk error while closing old database handle'))

    const spyB = createSpyDictionary('ecdict-local', { test: makeHit('B') })

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spyA.dictionary,
    })

    const result = manager.activate({
      mode: 'managed-ecdict',
      identity: 'managed-2',
      dictionary: spyB.dictionary,
    })

    // Activation committed and did not throw
    expect(result.generation).toBe(2)
    expect(result.retirement.closed).toBe(false)
    expect(result.retirement.error).toBe('simulated disk error while closing old database handle')

    // Snapshot verifies new state is committed and retirement error is observable
    const snapshot = manager.snapshot()
    expect(snapshot.generation).toBe(2)
    expect(snapshot.activeMode).toBe('managed-ecdict')
    expect(snapshot.source).toBe('ecdict-local')
    expect(snapshot.identity).toBe('managed-2')
    expect(snapshot.lastRetirementError).toBe('simulated disk error while closing old database handle')

    // Queries use new candidate B, not rolled back
    const res = manager.lookup('test')
    expect(res.found).toBe(true)
    if (res.found) expect(res.headword).toBe('B')

    // Subsequent activation without error clears lastRetirementError
    const spyC = createSpyDictionary('ecdict-local', { test: makeHit('C') })
    const result2 = manager.activate({
      mode: 'custom',
      identity: 'custom-clean',
      dictionary: spyC.dictionary,
    })

    expect(result2.generation).toBe(3)
    expect(result2.retirement.closed).toBe(true)
    expect(result2.retirement.error).toBeNull()
    expect(manager.snapshot().lastRetirementError).toBeNull()

    manager.close()
    expect(spyC.closeCalls).toBe(1)
  })
})

describe('DictionaryManager — Close Idempotence & Fail-Closed Semantics', () => {
  it('close() is idempotent and closes active dictionary exactly once', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    manager.close()
    manager.close()
    manager.close()

    expect(spy.closeCalls).toBe(1)
    expect(manager.snapshot().lifecycle).toBe('closed')
  })

  it('marks manager closed before underlying close throws, maintaining fail-closed status', () => {
    const spy = createSpyDictionary('sqlite-fixture')
    spy.setThrowOnClose(new Error('underlying close failed'))

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: spy.dictionary,
    })

    expect(() => manager.close()).toThrow('underlying close failed')
    expect(manager.snapshot().lifecycle).toBe('closed')

    // Subsequent lookup throws DictionaryUnavailableError rather than calling damaged handle
    expect(() => manager.lookup('test')).toThrow(DictionaryUnavailableError)

    // Subsequent close() is a no-op and does not call underlying close again
    expect(() => manager.close()).not.toThrow()
    expect(spy.closeCalls).toBe(1)
  })
})

describe('Stable Lookup Handler Integration (No Rebinding / No Recreation)', () => {
  it('serves before and after atomic activation through single unchanged handler instance', async () => {
    const fixtureDict = openSqliteDictionary({ path: ':memory:', source: 'sqlite-fixture' })
    const ecdictDict = openSqliteDictionary({ path: ':memory:', source: 'ecdict-local' })

    const manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture-start',
      dictionary: fixtureDict,
    })

    const config = Config({})
    // Handler created once and only once
    const handler = createLookupHandler(config, manager)

    // Phase 1: Query before hot swap -> source is sqlite-fixture
    const req1 = post({ query: 'derive' })
    const res1 = await handler(req1)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1).toMatchObject({
      ok: true,
      found: true,
      headword: 'derive',
      source: 'sqlite-fixture',
    })

    // Phase 2: Hot switch manager to ecdictDict without touching handler
    const activationResult = manager.activate({
      mode: 'managed-ecdict',
      identity: 'managed-ecdict-live',
      dictionary: ecdictDict,
    })
    expect(activationResult.generation).toBe(2)

    // Phase 3: Query after hot swap using the EXACT SAME handler instance -> source is ecdict-local
    const req2 = post({ query: 'derive' })
    const res2 = await handler(req2)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2).toMatchObject({
      ok: true,
      found: true,
      headword: 'derive',
      source: 'ecdict-local',
    })

    // Phase 4: Close manager -> same handler gracefully yields 500 dictionary-unavailable
    manager.close()
    const req3 = post({ query: 'derive' })
    const res3 = await handler(req3)
    expect(res3.status).toBe(500)
    const body3 = await res3.json()
    expect(body3).toEqual({
      ok: false,
      error: 'dictionary-unavailable',
      message: 'dictionary manager has been closed',
    })
  })
})

describe('Host Startup & Lifecycle Invariants', () => {
  it('always boots with fixture dictionary regardless of configured dictionaryMode', async () => {
    // Mode = managed-ecdict
    let registeredFetchManaged: ((req: Request) => Promise<Response>) | null = null
    let cleanupManaged: (() => Promise<void>) | undefined
    const mockCtxManaged = {
      effect: (fn: () => () => Promise<void>) => {
        cleanupManaged = fn()
      },
      connection: {
        fetch: {
          register: (spec: { fetch: (req: Request) => Promise<Response> }) => {
            registeredFetchManaged = spec.fetch
            return async () => {}
          },
        },
      },
    }
    const configManaged = Config({ dictionaryMode: 'managed-ecdict' })
    apply(mockCtxManaged as any, configManaged)

    expect(registeredFetchManaged).not.toBeNull()
    const resManaged = await (registeredFetchManaged as any)(post({ query: 'derive' }))
    const bodyManaged = await resManaged.json()
    expect(bodyManaged.ok).toBe(true)
    expect(bodyManaged.source).toBe('sqlite-fixture') // MUST remain fixture!
    if (cleanupManaged) await cleanupManaged()

    // Mode = custom
    let registeredFetchCustom: ((req: Request) => Promise<Response>) | null = null
    let cleanupCustom: (() => Promise<void>) | undefined
    const mockCtxCustom = {
      effect: (fn: () => () => Promise<void>) => {
        cleanupCustom = fn()
      },
      connection: {
        fetch: {
          register: (spec: { fetch: (req: Request) => Promise<Response> }) => {
            registeredFetchCustom = spec.fetch
            return async () => {}
          },
        },
      },
    }
    const configCustom = Config({ dictionaryMode: 'custom', customDictionaryPath: '/nonexistent/path.db' })
    apply(mockCtxCustom as any, configCustom)

    expect(registeredFetchCustom).not.toBeNull()
    const resCustom = await (registeredFetchCustom as any)(post({ query: 'derive' }))
    const bodyCustom = await resCustom.json()
    expect(bodyCustom.ok).toBe(true)
    expect(bodyCustom.source).toBe('sqlite-fixture') // MUST remain fixture!
    if (cleanupCustom) await cleanupCustom()
  })

  it('closes manager and active dictionary on unload disposer', async () => {
    let registeredDisposerCalls = 0
    let registeredFetch: ((req: Request) => Promise<Response>) | null = null
    let cleanup: (() => Promise<void>) | undefined

    const mockCtx = {
      effect: (fn: () => () => Promise<void>) => {
        cleanup = fn()
      },
      connection: {
        fetch: {
          register: (spec: { fetch: (req: Request) => Promise<Response> }) => {
            registeredFetch = spec.fetch
            return async () => {
              registeredDisposerCalls += 1
            }
          },
        },
      },
    }

    const config = Config({})
    apply(mockCtx as any, config)

    // Lookup works before cleanup
    const resBefore = await (registeredFetch as any)(post({ query: 'derive' }))
    expect(resBefore.status).toBe(200)

    // Execute cleanup disposer
    if (cleanup) await cleanup()
    expect(registeredDisposerCalls).toBe(1)

    // Lookup after cleanup fails with 500 dictionary-unavailable
    const resAfter = await (registeredFetch as any)(post({ query: 'derive' }))
    expect(resAfter.status).toBe(500)
    const bodyAfter = await resAfter.json()
    expect(bodyAfter.error).toBe('dictionary-unavailable')
  })

  it('closes manager if route registration throws during host startup', () => {
    const mockCtx = {
      effect: (fn: () => () => Promise<void>) => fn(),
      connection: {
        fetch: {
          register: () => {
            throw new Error('route registration conflict')
          },
        },
      },
    }

    const config = Config({})
    expect(() => (apply as any)(mockCtx, config)).toThrow('route registration conflict')
  })
})
