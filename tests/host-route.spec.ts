/**
 * The route path, stated in two halves.
 *
 * The browser half must not carry the absolute `/api/...` string: the page is
 * served with `<base href="./">`, so an absolute URL would leave the
 * application's mount directory. That requirement is why the two halves name the
 * route separately instead of deriving one from the other, and this test is what
 * keeps the two spellings from drifting apart.
 */

import { describe, expect, it } from 'vitest'

import { LOOKUP_PATH } from '../src/host/route.js'
import { LOOKUP_DOCUMENT_PATH } from '../src/shared/protocol.js'

describe('lookup route path', () => {
  it('spells the same route in both halves', () => {
    expect(LOOKUP_PATH).toBe(`/${LOOKUP_DOCUMENT_PATH}`)
  })

  it('addresses the shared /api channel, which the transport requires literally', () => {
    // `assertFetchRoute` rejects any path whose first segment is not `api`, and
    // `/api` alone is rejected too.
    expect(LOOKUP_PATH.startsWith('/api/')).toBe(true)
    expect(LOOKUP_PATH).not.toBe('/api')
    expect(LOOKUP_PATH).toBe('/api/dsh-word-lookup')
  })

  it('keeps the browser half relative', () => {
    expect(LOOKUP_DOCUMENT_PATH.startsWith('/')).toBe(false)
    expect(LOOKUP_DOCUMENT_PATH).toBe('api/dsh-word-lookup')
  })

  it('contains no empty, "." or ".." segment, all of which the transport rejects', () => {
    const segments = LOOKUP_PATH.split('/').slice(1)
    expect(segments.length).toBeGreaterThan(0)
    for (const segment of segments) {
      expect(segment).not.toBe('')
      expect(segment).not.toBe('.')
      expect(segment).not.toBe('..')
    }
  })
})
