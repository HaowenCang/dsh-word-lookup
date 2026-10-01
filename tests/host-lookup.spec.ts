/**
 * The exact Fetch route's request handling.
 *
 * Every case here is one of the Phase 1 acceptance conditions or one of the
 * test-matrix rows the handler owns: a malformed request is a controlled 400
 * (T13), an over-long query is a 400 (T14), an unknown word is a 200 with
 * `found: false` (T12), and the payload carries the host's live switch values so
 * that a settings write is observable through the route.
 *
 * The handler is exercised directly, with no DSH process and no transport, which
 * is the reason it was written as a plain `(Request) => Promise<Response>`.
 */

import { describe, expect, it } from 'vitest'

import { Config } from '../src/host/config.js'
import { createLookupHandler } from '../src/host/lookup.js'
import { MAX_QUERY_CODE_POINTS } from '../src/shared/protocol.js'

/** Build one request against the route's absolute path. */
function post(body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  return new Request('http://127.0.0.1:50001/api/dsh-word-lookup', { method: 'POST', headers, body })
}

/** Invoke the handler with the default (all-off) configuration. */
const handle = createLookupHandler(Config({}))

describe('POST /api/dsh-word-lookup — success', () => {
  it('returns a found entry for a known word', async () => {
    const response = await handle(post(JSON.stringify({ query: 'derive' })))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, found: true, query: 'derive', headword: 'derive', source: 'stub' })
    expect(Array.isArray(body.meanings)).toBe(true)
    expect(Array.isArray(body.examples)).toBe(true)
  })

  it('normalizes the query before looking it up', async () => {
    const response = await handle(post(JSON.stringify({ query: '  "Derived."  ' })))
    const body = await response.json()
    expect(body.query).toBe('derived')
    expect(body.headword).toBe('derive')
  })

  it('returns 200 with found:false for an unknown word, never an error', async () => {
    const response = await handle(post(JSON.stringify({ query: 'zzz-not-a-word' })))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, found: false, query: 'zzz-not-a-word' })
  })

  it('marks every success as non-cacheable', async () => {
    const response = await handle(post(JSON.stringify({ query: 'derive' })))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('POST /api/dsh-word-lookup — controlled refusals', () => {
  it('refuses a body that is not JSON with 400 malformed-body', async () => {
    const response = await handle(post('{not json'))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: 'malformed-body' })
  })

  it('refuses a JSON body that is not an object with 400 malformed-body', async () => {
    for (const body of ['[]', '"derive"', '17', 'null']) {
      const response = await handle(post(body))
      expect(response.status, body).toBe(400)
      expect((await response.json()).error, body).toBe('malformed-body')
    }
  })

  it('refuses a body without a query with 400 missing-query', async () => {
    const response = await handle(post(JSON.stringify({ query: 17 })))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('missing-query')
  })

  it('refuses a query that normalizes to nothing with 400 empty-query', async () => {
    for (const query of ['', '   ', '...']) {
      const response = await handle(post(JSON.stringify({ query })))
      expect(response.status, query).toBe(400)
      expect((await response.json()).error, query).toBe('empty-query')
    }
  })

  it('refuses an over-long query with 400 query-too-long, measured in code points', async () => {
    const tooLong = 'a'.repeat(MAX_QUERY_CODE_POINTS + 1)
    const response = await handle(post(JSON.stringify({ query: tooLong })))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('query-too-long')

    const atCeiling = 'a'.repeat(MAX_QUERY_CODE_POINTS)
    const accepted = await handle(post(JSON.stringify({ query: atCeiling })))
    expect(accepted.status).toBe(200)
  })

  it('refuses a non-JSON content type with 400 unsupported-content-type', async () => {
    const response = await handle(post(JSON.stringify({ query: 'derive' }), { 'content-type': 'text/plain' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('unsupported-content-type')
  })

  it('accepts a content type carrying a charset parameter', async () => {
    const response = await handle(
      post(JSON.stringify({ query: 'derive' }), { 'content-type': 'application/json; charset=utf-8' }),
    )
    expect(response.status).toBe(200)
  })

  it('refuses an over-long body regardless of whether the length was declared', async () => {
    const padded = JSON.stringify({ query: 'derive', pad: 'x'.repeat(8192) })
    const response = await handle(post(padded))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('body-too-large')

    const declared = new Request('http://127.0.0.1:50001/api/dsh-word-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99999' },
      body: JSON.stringify({ query: 'derive' }),
    })
    const declaredResponse = await handle(declared)
    expect(declaredResponse.status).toBe(400)
    expect((await declaredResponse.json()).error).toBe('body-too-large')
  })

  it('refuses a method the route does not own with 405', async () => {
    const request = new Request('http://127.0.0.1:50001/api/dsh-word-lookup', { method: 'GET' })
    const response = await handle(request)
    expect(response.status).toBe(405)
    expect((await response.json()).error).toBe('method-not-allowed')
  })

  it('refuses without an exception, whatever the caller sends', async () => {
    // A throw inside a Fetch route reaches the browser as an opaque transport
    // error, which is indistinguishable from a broken route.
    const cases: Request[] = [
      post(''),
      post('{}'),
      post(JSON.stringify({ query: 'derive' }), {}),
      new Request('http://127.0.0.1:50001/api/dsh-word-lookup', { method: 'POST' }),
    ]
    for (const request of cases) {
      const response = await handle(request)
      expect(response.status, request.url).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    }
  })
})

describe('POST /api/dsh-word-lookup — live configuration echo', () => {
  it('reports the composed defaults when both switches are off', async () => {
    const response = await handle(post(JSON.stringify({ query: 'derive' })))
    const body = await response.json()
    expect(body.settings).toEqual({ autoDoubleClick: false, autoSelection: false })
  })

  it('reports the current value on every request, without rebinding the handler', async () => {
    // `createLookupHandler` captures the config object, not its values; a write
    // accepted by the settings service updates the reference in place, so the
    // next request through the same handler sees it.
    let autoSelection = false
    const mutable = {
      autoDoubleClick: { get: () => false },
      autoSelection: { get: () => autoSelection },
    }
    const liveHandle = createLookupHandler(mutable)

    const before = await (await liveHandle(post(JSON.stringify({ query: 'derive' })))).json()
    expect(before.settings).toEqual({ autoDoubleClick: false, autoSelection: false })

    autoSelection = true

    const after = await (await liveHandle(post(JSON.stringify({ query: 'derive' })))).json()
    expect(after.settings).toEqual({ autoDoubleClick: false, autoSelection: true })
  })
})
