/**
 * The card store and the transport classifier.
 *
 * Both are consumed by `useSyncExternalStore` or by the runtime's request
 * ordering, and both have contracts that are easy to violate without noticing:
 * a snapshot reference that changes while the value does not causes React to
 * re-render forever, and a refusal classified as a network failure makes a
 * controlled 400 indistinguishable from a broken route.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LOOKUP_DOCUMENT_PATH, LOOKUP_MEDIA_TYPE } from '../src/shared/protocol.js'
import { LookupCardStore } from '../src/client/store.js'
import { requestLookup } from '../src/client/transport.js'

describe('LookupCardStore', () => {
  it('starts idle', () => {
    expect(new LookupCardStore().getSnapshot()).toEqual({ status: 'idle' })
  })

  it('keeps the snapshot reference stable until a change is published', () => {
    const store = new LookupCardStore()
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    store.set({ status: 'loading', query: 'derive' })
    expect(store.getSnapshot()).not.toBe(first)
  })

  it('notifies every subscriber and stops after unsubscribe', () => {
    const store = new LookupCardStore()
    const seen: string[] = []
    const stop = store.subscribe(() => {
      seen.push(store.getSnapshot().status)
    })
    store.set({ status: 'loading', query: 'derive' })
    store.set({ status: 'idle' })
    stop()
    store.set({ status: 'loading', query: 'go' })
    expect(seen).toEqual(['loading', 'idle'])
  })

  it('clears back to the zero-render state', () => {
    const store = new LookupCardStore()
    store.set({ status: 'loading', query: 'derive' })
    store.clear()
    expect(store.getSnapshot()).toEqual({ status: 'idle' })
  })

  it('tolerates a listener unsubscribing during a publish', () => {
    const store = new LookupCardStore()
    const seen: string[] = []
    const stop = store.subscribe(() => {
      seen.push('first')
      stop()
    })
    store.subscribe(() => {
      seen.push('second')
    })
    store.set({ status: 'loading', query: 'derive' })
    expect(seen).toEqual(['first', 'second'])
    store.set({ status: 'idle' })
    expect(seen).toEqual(['first', 'second', 'second'])
  })
})

/** One stubbed fetch call, recorded for assertion. */
interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** Install a fetch stub and return the calls it received. */
function stubFetch(respond: () => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return await respond()
  })
  return calls
}

/** Build a JSON response. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('requestLookup', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls the document-relative route, never an absolute path', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, found: false, query: 'derive' }))
    await requestLookup('derive')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('api/dsh-word-lookup')
    expect(calls[0]?.url.startsWith('/')).toBe(false)
    expect(calls[0]?.url).toBe(LOOKUP_DOCUMENT_PATH)
  })

  it('posts JSON and asks for nothing else', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, found: false, query: 'derive' }))
    await requestLookup('derive')
    const init = calls[0]?.init
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe(LOOKUP_MEDIA_TYPE)
    expect(init?.body).toBe(JSON.stringify({ query: 'derive' }))
    // No credentials option: the same-origin default already sends the cookie.
    expect(init?.credentials).toBeUndefined()
  })

  it('classifies a found body', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        ok: true,
        found: true,
        query: 'derive',
        headword: 'derive',
        phonetic: '/x/',
        meanings: [],
        examples: [],
        source: 'stub',
        settings: { autoDoubleClick: false, autoSelection: false },
      }),
    )
    const result = await requestLookup('derive')
    expect(result.kind).toBe('found')
  })

  it('classifies a well-formed not-found body', async () => {
    stubFetch(() => jsonResponse(200, { ok: true, found: false, query: 'zzz' }))
    const result = await requestLookup('zzz')
    expect(result.kind).toBe('not-found')
  })

  it('classifies a controlled 400 by its error code, not as a transport failure', async () => {
    stubFetch(() => jsonResponse(400, { ok: false, error: 'query-too-long', message: 'too long' }))
    const result = await requestLookup('x')
    expect(result).toMatchObject({ kind: 'refused', httpStatus: 400, code: 'query-too-long' })
  })

  it('classifies an unrecognised response shape as refused rather than crashing', async () => {
    stubFetch(() => jsonResponse(200, { unexpected: true }))
    const result = await requestLookup('derive')
    expect(result).toMatchObject({ kind: 'refused', httpStatus: 200, code: 'unexpected-response' })
  })

  it('classifies a non-JSON error body as refused', async () => {
    stubFetch(() => new Response('<html>500</html>', { status: 500 }))
    const result = await requestLookup('derive')
    expect(result).toMatchObject({ kind: 'refused', httpStatus: 500 })
  })

  it('classifies a rejected fetch as a network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await requestLookup('derive')
    expect(result).toMatchObject({ kind: 'network' })
  })

  it('classifies an abort as aborted, which is how a superseded request ends', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const result = await requestLookup('derive')
    expect(result.kind).toBe('aborted')
  })

  it('passes the abort signal through to fetch', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true, found: false, query: 'derive' }))
    const controller = new AbortController()
    await requestLookup('derive', controller.signal)
    expect(calls[0]?.init?.signal).toBe(controller.signal)
  })
})
