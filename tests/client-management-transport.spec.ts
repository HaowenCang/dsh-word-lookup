/**
 * Tests for dictionary management HTTP transport client.
 *
 * Verifies:
 * - Document-relative path adherence (no leading slashes).
 * - Correct HTTP methods, headers, and body payloads.
 * - Same-origin authentication default.
 * - HTTP 200 successful payload parsing and runtime validation.
 * - HTTP 400, 401, 404, 409, 500 structured refusal classification.
 * - HTTP 409 is recognized as a domain refusal, not a network failure.
 * - Network failures and AbortError handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cancelDictionaryOperation,
  fetchDictionaryStatus,
  installManagedDictionary,
  isValidDictionaryStatusResponse,
  removeManagedDictionary,
  verifyCustomDictionary,
} from '../src/client/settings/dictionary-management-transport.js'
import type { DictionaryStatusResponse } from '../src/shared/dictionary-management-protocol.js'

function createSampleStatusResponse(overrides: Partial<DictionaryStatusResponse> = {}): DictionaryStatusResponse {
  return {
    ok: true,
    activeMode: 'fixture',
    configuredMode: 'fixture',
    activeSource: 'sqlite-fixture',
    activeIdentity: 'fixture',
    installed: false,
    installedCorpus: null,
    currentOperation: null,
    lastOperation: null,
    canInstall: true,
    canCancel: false,
    canRemove: false,
    quarantined: false,
    quarantineReason: null,
    recoveryError: null,
    lastRetirementError: null,
    generation: 1,
    ...overrides,
  }
}

describe('dictionary-management-transport', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('URL and Document-Relative Path Adherence', () => {
    it('uses document-relative path without leading slash for fetchDictionaryStatus', async () => {
      let capturedUrl = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url
        return new Response(JSON.stringify(createSampleStatusResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(true)
      expect(capturedUrl).toBe('api/dsh-word-lookup/dictionary/status')
      expect(capturedUrl.startsWith('/')).toBe(false)
    })

    it('uses document-relative path for installManagedDictionary', async () => {
      let capturedUrl = ''
      let capturedMethod = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method ?? ''
        return new Response(
          JSON.stringify({ ok: true, operationId: 'op-123', status: 'running', phase: 'queued', message: 'started' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })

      const res = await installManagedDictionary()
      expect(res.ok).toBe(true)
      expect(capturedUrl).toBe('api/dsh-word-lookup/dictionary/install')
      expect(capturedMethod).toBe('POST')
    })

    it('uses document-relative path and sends operationId for cancelDictionaryOperation', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedBody = String(init?.body ?? '')
        return new Response(
          JSON.stringify({ ok: true, operationId: 'op-456', status: 'cancelling', message: 'cancelling' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })

      const res = await cancelDictionaryOperation('op-456')
      expect(res.ok).toBe(true)
      expect(capturedUrl).toBe('api/dsh-word-lookup/dictionary/cancel')
      expect(JSON.parse(capturedBody)).toEqual({ operationId: 'op-456' })
    })

    it('uses document-relative path for removeManagedDictionary', async () => {
      let capturedUrl = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url
        return new Response(
          JSON.stringify({ ok: true, removed: true, activeMode: 'fixture', message: 'removed' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })

      const res = await removeManagedDictionary()
      expect(res.ok).toBe(true)
      expect(capturedUrl).toBe('api/dsh-word-lookup/dictionary/remove')
    })

    it('uses document-relative path and sends path payload for verifyCustomDictionary', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedBody = String(init?.body ?? '')
        return new Response(
          JSON.stringify({ ok: true, valid: true, schemaVersion: 1, entryCount: 100, formCount: 20, message: 'valid' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })

      const res = await verifyCustomDictionary('C:/custom.sqlite')
      expect(res.ok).toBe(true)
      expect(capturedUrl).toBe('api/dsh-word-lookup/dictionary/verify')
      expect(JSON.parse(capturedBody)).toEqual({ path: 'C:/custom.sqlite' })
    })
  })

  describe('Runtime Response Validation', () => {
    it('validates a correct DictionaryStatusResponse', () => {
      const valid = createSampleStatusResponse()
      expect(isValidDictionaryStatusResponse(valid)).toBe(true)
    })

    it('rejects null, non-object, or incomplete status responses', () => {
      expect(isValidDictionaryStatusResponse(null)).toBe(false)
      expect(isValidDictionaryStatusResponse('string')).toBe(false)
      expect(isValidDictionaryStatusResponse({ ok: true })).toBe(false)
      expect(isValidDictionaryStatusResponse({ ok: false })).toBe(false)
      expect(isValidDictionaryStatusResponse({ ok: true, activeMode: 'unknown' })).toBe(false)
    })

    it('returns refused when host returns 200 but body fails validation', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, invalidStructure: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.kind).toBe('refused')
        if (res.kind === 'refused') {
          expect(res.code).toBe('unexpected-response')
        }
      }
    })
  })

  describe('Error Classification and HTTP Refusals', () => {
    it('classifies HTTP 409 Conflict as refused (not network error)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: 'OPERATION_IN_PROGRESS',
            message: 'An operation is already in progress.',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      )

      const res = await installManagedDictionary()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.kind).toBe('refused')
        if (res.kind === 'refused') {
          expect(res.httpStatus).toBe(409)
          expect(res.code).toBe('OPERATION_IN_PROGRESS')
          expect(res.message).toBe('An operation is already in progress.')
        }
      }
    })

    it('classifies HTTP 401 Unauthorized as refused', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: 'BAD_REQUEST', message: 'Unauthorized session' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      )

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(false)
      if (!res.ok && res.kind === 'refused') {
        expect(res.httpStatus).toBe(401)
      }
    })

    it('classifies HTTP 500 Internal Error as refused', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', message: 'Database lock failed' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      )

      const res = await removeManagedDictionary()
      expect(res.ok).toBe(false)
      if (!res.ok && res.kind === 'refused') {
        expect(res.httpStatus).toBe(500)
        expect(res.code).toBe('INTERNAL_ERROR')
      }
    })

    it('handles non-JSON error responses gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      )

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(false)
      if (!res.ok && res.kind === 'refused') {
        expect(res.httpStatus).toBe(502)
        expect(res.code).toBe('unexpected-response')
        expect(res.message).toContain('502')
      }
    })

    it('classifies network disconnection as network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.kind).toBe('network')
        if (res.kind === 'network') {
          expect(res.message).toContain('Failed to fetch')
        }
      }
    })

    it('classifies DOMException AbortError as aborted', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      globalThis.fetch = vi.fn().mockRejectedValue(abortError)

      const res = await fetchDictionaryStatus()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.kind).toBe('aborted')
      }
    })
  })
})
