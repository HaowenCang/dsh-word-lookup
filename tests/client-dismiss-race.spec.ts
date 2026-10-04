/**
 * Dismiss / Request Race Correctness unit tests.
 *
 * Verifies Phase 5 mandatory race matrix:
 * D1: A starts -> close -> A success -> result: closed
 * D2: A starts -> close -> A error   -> result: closed
 * D3: A starts -> close -> B starts  -> B success -> result: B visible
 * D4: A found  -> close -> same word queried again -> result: visible again
 *
 * Plus stale settlement, loading ownership, and surface generation independence.
 */

import { describe, expect, it } from 'vitest'

import { LookupController } from '../src/client/lookup.js'
import { LookupCardStore } from '../src/client/store.js'
import type { LookupResult, LookupTransportFailure } from '../src/client/transport.js'

interface Deferred {
  readonly promise: Promise<LookupResult | LookupTransportFailure>
  readonly resolve: (value: LookupResult | LookupTransportFailure) => void
  readonly reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: LookupResult | LookupTransportFailure) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<LookupResult | LookupTransportFailure>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deferredTransport() {
  const calls: Deferred[] = []
  const queries: string[] = []
  const request = (query: string): Promise<LookupResult | LookupTransportFailure> => {
    const entry = deferred()
    queries.push(query)
    calls.push(entry)
    return entry.promise
  }
  return { calls, queries, request }
}

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

function network(message = 'Network error'): LookupTransportFailure {
  return { kind: 'network', message }
}

function build() {
  const store = new LookupCardStore()
  const transport = deferredTransport()
  const controller = new LookupController({ store, request: transport.request })
  return { store, transport, controller }
}

describe('Dismiss / Request Race Matrix (D1-D4)', () => {
  it('D1: A starts -> close -> A success -> result: closed', async () => {
    const { store, transport, controller } = build()

    const a = controller.run('derive', 'shortcut')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'derive' })

    // User closes the card before A finishes
    controller.dismiss()
    expect(store.getSnapshot()).toEqual({ status: 'idle' })

    // A resolves successfully
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a

    // Card MUST remain closed / idle, cannot reopen from dismissed A
    expect(store.getSnapshot()).toEqual({ status: 'idle' })
    expect(controller.loading()).toBe(false)
  })

  it('D2: A starts -> close -> A error -> result: closed', async () => {
    const { store, transport, controller } = build()

    const a = controller.run('derive', 'auto-double-click')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'derive' })

    // Close before settlement
    controller.dismiss()
    expect(store.getSnapshot()).toEqual({ status: 'idle' })

    // A fails with network error
    transport.calls[0]?.resolve(network('Failed to fetch'))
    await a

    // Card MUST remain closed, error cannot reopen surface
    expect(store.getSnapshot()).toEqual({ status: 'idle' })
  })

  it('D3: A starts -> close -> B starts -> B success -> result: B visible', async () => {
    const { store, transport, controller } = build()

    const a = controller.run('derive', 'shortcut')
    controller.dismiss()
    expect(store.getSnapshot()).toEqual({ status: 'idle' })

    // New lookup for B starts (opens a new surface generation)
    const b = controller.run('went', 'auto-selection')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })

    // A finishes late
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    // A finishing must not alter B's loading state
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'went' })

    // B resolves successfully
    transport.calls[1]?.resolve(found('went', 'go'))
    await b

    // B is visible!
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })

  it('D4: A found -> close -> same word queried again -> result: visible again', async () => {
    const { store, transport, controller } = build()

    // First lookup for 'derive'
    const a = controller.run('derive', 'auto-double-click')
    transport.calls[0]?.resolve(found('derive', 'derive'))
    await a
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'derive' })

    // User closes the card
    controller.dismiss()
    expect(store.getSnapshot()).toEqual({ status: 'idle' })

    // User queries the EXACT SAME word again
    const a2 = controller.run('derive', 'auto-double-click')
    expect(store.getSnapshot()).toEqual({ status: 'loading', query: 'derive' })

    transport.calls[1]?.resolve(found('derive', 'derive'))
    await a2

    // Must be visible again! (Dismissal is not bound to query text string)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'derive' })
  })

  it('drops stale failure after dismiss without reopening', async () => {
    const { store, transport, controller } = build()

    const a = controller.run('derive', 'shortcut')
    store.clear() // Dismiss via store directly (e.g. close button)

    transport.calls[0]?.reject(new Error('transport dropped'))
    await a

    expect(store.getSnapshot()).toEqual({ status: 'idle' })
  })

  it('tracks distinct generations across dismissals and runs', async () => {
    const { store, transport, controller } = build()

    expect(controller.generation()).toBe(0)

    const a = controller.run('derive', 'shortcut')
    expect(controller.generation()).toBe(1)
    expect(store.isDismissed(1)).toBe(false)

    controller.dismiss()
    expect(store.isDismissed(1)).toBe(true)

    const b = controller.run('went', 'shortcut')
    expect(controller.generation()).toBe(2)
    expect(store.isDismissed(2)).toBe(false)
    expect(store.isDismissed(1)).toBe(true)

    transport.calls[0]?.resolve(found('derive', 'derive'))
    transport.calls[1]?.resolve(found('went', 'go'))
    await a
    await b

    expect(store.getSnapshot()).toMatchObject({ status: 'ready', query: 'went' })
  })
})
