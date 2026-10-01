/**
 * The lookup controller: request identity, supersession and the stale-result
 * policy.
 *
 * Phase 4 makes lookups producible faster than the host answers them, so the
 * ordering rules stop being hypothetical. Each case below is one of the orderings
 * the brief names, driven through a deferred transport rather than a real server:
 *
 * ```text
 * C1  A starts, B starts, B resolves, A resolves  -> B is shown
 * C2  A starts, B starts, B succeeds,  A fails    -> B is shown
 * C3  A succeeds, B starts, B fails               -> B's failure is shown
 * C4  A/B overlap                                 -> A cannot clear B's loading
 * ```
 *
 * A test that only asserted "B is shown" would pass against an implementation
 * that also rolled back to A and then forward again; every case therefore asserts
 * the card *after every settlement*, not only at the end.
 */

import { describe, expect, it, vi } from 'vitest'

import { LookupController, LOOKUP_ORIGINS } from '../src/client/lookup.js'
import { LookupCardStore } from '../src/client/store.js'
import type { LookupResult, LookupTransportFailure } from '../src/client/transport.js'

/** A promise with its settlement exposed. */
interface Deferred {
  readonly promise: Promise<LookupResult | LookupTransportFailure>
  readonly resolve: (value: LookupResult | LookupTransportFailure) => void
  readonly reject: (error: unknown) => void
}

/** Create a deferred lookup answer. */
function deferred(): Deferred {
  let resolve!: (value: LookupResult | LookupTransportFailure) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<LookupResult | LookupTransportFailure>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A transport that hands out one deferred per call, in issue order. */
function deferredTransport() {
  const calls: Deferred[] = []
  const queries: { query: string; signal: AbortSignal | undefined }[] = []
  const request = (query: string, signal?: AbortSignal): Promise<LookupResult | LookupTransportFailure> => {
    const entry = deferred()
    queries.push({ query, signal })
    calls.push(entry)
    return entry.promise
  }
  return { calls, queries, request }
}

/** A found answer for one headword. */
function found(query: string, headword: string): LookupResult {
  return {
    kind: 'found',
    body: {
      ok: true,
      found: true,
      query,
      headword,
      phonetic: null,
      meanings: [],
      forms: [],
      matchedForm: null,
      examples: [],
      source: 'sqlite-fixture',
      settings: { autoDoubleClick: false, autoSelection: false },
    },
  }
}

/** A dictionary miss. */
function notFound(query: string): LookupResult {
  return {
    kind: 'not-found',
    body: { ok: true, found: false, query, source: 'sqlite-fixture', settings: { autoDoubleClick: false, autoSelection: false } },
  }
}

/** A controlled refusal. */
function refused(code: 'query-too-long'): LookupResult {
  return { kind: 'refused', httpStatus: 400, code, message: 'refused' }
}

/** A transport-level failure. */
function network(message = 'Failed to fetch'): LookupTransportFailure {
  return { kind: 'network', message }
}

/** Build a controller over a fresh store and a deferred transport. */
function build() {
  const store = new LookupCardStore()
  const transport = deferredTransport()
  const controller = new LookupController({ store, request: transport.request })
  return { store, transport, controller }
}

/** Let every already-settled continuation run. */
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('C1 — out-of-order success: the latest request wins', () => {
  it('shows B and never rolls back to A', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-double-click')
    const b = controller.run('went', 'auto-selection')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })

    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })

    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
    expect(controller.lastOutcome()).toBe('found')
  })

  it('aborts the superseded request rather than only ignoring it', async () => {
    const { transport, controller } = build()
    const a = controller.run('derive', 'shortcut')
    const signalA = transport.queries[0]?.signal
    expect(signalA?.aborted).toBe(false)
    const b = controller.run('went', 'shortcut')
    expect(signalA?.aborted).toBe(true)
    expect(transport.queries[1]?.signal?.aborted).toBe(false)
    transport.calls[1]?.resolve(found('went', 'go'))
    transport.calls[0]?.resolve({ kind: 'aborted' })
    await Promise.all([a, b])
  })

  it('numbers requests monotonically and hands ownership to the newest', async () => {
    const { transport, controller } = build()
    const a = controller.run('a', 'shortcut')
    expect(controller.current()).toBe(1)
    const b = controller.run('b', 'shortcut')
    expect(controller.current()).toBe(2)
    expect(controller.issued()).toBe(2)
    transport.calls[1]?.resolve(notFound('b'))
    await b
    expect(controller.current()).toBe(2)
    transport.calls[0]?.resolve(notFound('a'))
    await a
    expect(controller.current()).toBe(2)
  })
})

describe('C2 — a stale failure cannot bury a newer success', () => {
  it('keeps B when the superseded A fails afterwards', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-selection')
    const b = controller.run('went', 'auto-selection')
    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    expect(store.getSnapshot()).toMatchObject({ status: 'ready' })

    transport.calls[0]?.resolve(network())
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })

  it('keeps B when the superseded A rejects', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-selection')
    const b = controller.run('went', 'auto-selection')
    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    transport.calls[0]?.reject(new TypeError('boom'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })
})

describe('C3 — the current request’s failure is displayed', () => {
  it('shows B’s failure after A’s success', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'shortcut')
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'derive' })

    const b = controller.run('went', 'auto-double-click')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })
    transport.calls[1]?.resolve(network('host unreachable'))
    await b
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed',
      query: 'went',
      failure: { kind: 'network', message: 'host unreachable' },
    })
    expect(controller.lastOutcome()).toBe('network')
  })

  it('shows a controlled refusal as a ready state carrying the refusal', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('x'.repeat(200), 'shortcut')
    transport.calls[0]?.resolve(refused('query-too-long'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'refused', httpStatus: 400 } })
    expect(controller.lastOutcome()).toBe('refused')
  })

  it('shows an unknown word as a normal miss rather than an error', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('unknowntoken', 'auto-double-click')
    transport.calls[0]?.resolve(notFound('unknowntoken'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', result: { kind: 'not-found' } })
    expect(controller.lastOutcome()).toBe('not-found')
  })
})

describe('C4 — loading belongs to the request that owns the card', () => {
  it('does not let a finishing request clear a newer one’s loading', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-selection')
    const b = controller.run('went', 'auto-selection')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })
    expect(controller.loading()).toBe(true)

    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    await flush()
    // A finished. B is still out, so the card is still loading — with B's query.
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })
    expect(controller.loading()).toBe(true)

    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    expect(controller.loading()).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })

  it('does not clear loading when a superseded request fails', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-selection')
    const b = controller.run('went', 'auto-selection')
    transport.calls[0]?.reject(new Error('late failure'))
    await a
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })
    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    expect(store.getSnapshot()).toMatchObject({ status: 'ready' })
  })
})

describe('transport failure never escapes as a rejection', () => {
  it('turns a throwing transport into a displayed network failure', async () => {
    const store = new LookupCardStore()
    const controller = new LookupController({
      store,
      request: () => {
        throw new Error('synchronous explosion')
      },
    })
    await expect(controller.run('derive', 'shortcut')).resolves.toBeUndefined()
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed',
      failure: { kind: 'network', message: 'synchronous explosion' },
    })
  })

  it('recovers: the next lookup is issued normally after a failure', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-double-click')
    transport.calls[0]?.reject(new TypeError('Failed to fetch'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'failed' })

    const b = controller.run('went', 'auto-double-click')
    transport.calls[1]?.resolve(found('went', 'go'))
    await b
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })

  it('stringifies a non-Error rejection rather than losing it', async () => {
    const store = new LookupCardStore()
    const controller = new LookupController({
      store,
      request: () => Promise.reject('plain string'),
    })
    await controller.run('derive', 'shortcut')
    expect(store.getSnapshot()).toMatchObject({ status: 'failed', failure: { kind: 'network', message: 'plain string' } })
  })
})

describe('accounting and lifetime', () => {
  it('counts every origin separately, starting from zero', async () => {
    const { transport, controller } = build()
    expect(controller.counts()).toEqual({ shortcut: 0, 'auto-selection': 0, 'auto-double-click': 0 })
    const runs = [
      controller.run('a', 'shortcut'),
      controller.run('b', 'auto-selection'),
      controller.run('c', 'auto-double-click'),
      controller.run('d', 'auto-selection'),
    ]
    transport.calls.forEach((call, index) => {
      call.resolve(notFound(String(index)))
    })
    await Promise.all(runs)
    expect(controller.counts()).toEqual({ shortcut: 1, 'auto-selection': 2, 'auto-double-click': 1 })
    expect(controller.issued()).toBe(4)
  })

  it('exposes the origins in a stable order for a report to iterate', () => {
    expect(LOOKUP_ORIGINS).toEqual(['shortcut', 'auto-selection', 'auto-double-click'])
  })

  it('publishes nothing after dispose, even for a request that was in flight', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'auto-selection')
    controller.dispose()
    expect(transport.queries[0]?.signal?.aborted).toBe(true)
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'derive' })
    expect(controller.current()).toBe(0)
  })

  it('does not let a disposed runtime adopt a later request', async () => {
    const { store, transport, controller } = build()
    controller.dispose()
    const a = controller.run('derive', 'shortcut')
    expect(controller.current()).toBe(1)
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready' })
  })

  it('keeps a stable card snapshot reference until it actually changes', async () => {
    const { store, transport, controller } = build()
    const a = controller.run('derive', 'shortcut')
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).not.toBe(first)
  })
})

describe('injected abort factory', () => {
  it('uses the supplied abort primitive, so supersession is observable in a test', async () => {
    const abort = vi.fn()
    const created: AbortController[] = []
    const store = new LookupCardStore()
    const controller = new LookupController({
      store,
      request: () => Promise.resolve(notFound('x')),
      createAbortController: () => {
        const controller2 = new AbortController()
        const original = controller2.abort.bind(controller2)
        controller2.abort = () => {
          abort()
          original()
        }
        created.push(controller2)
        return controller2
      },
    })
    // Both runs are started without awaiting the first: a run that has already
    // settled has nothing left to supersede, so the overlap is the point.
    const a = controller.run('a', 'shortcut')
    const b = controller.run('b', 'shortcut')
    await Promise.all([a, b])
    expect(created).toHaveLength(2)
    expect(abort).toHaveBeenCalledTimes(1)
  })
})
