import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'

import {
  EcdictDownloadInProgressError,
  downloadPinnedEcdict,
  type EcdictDownloadProgress,
} from '../src/host/ecdict-downloader.js'
import type { EcdictSourceDescriptor } from '../src/host/ecdict-source.js'
import { resolveManagedStoragePaths, type ManagedStoragePaths } from '../src/host/managed-storage.js'
import { apply } from '../src/index.js'
import { Config } from '../src/host/config.js'

function createSyntheticDescriptor(content: string | Buffer): {
  descriptor: EcdictSourceDescriptor
  rawBytes: Buffer
} {
  const rawBytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const hash = createHash('sha256').update(rawBytes).digest('hex')
  const descriptor: EcdictSourceDescriptor = Object.freeze({
    sourceName: 'ECDICT',
    sourceRepository: 'https://github.com/skywind3000/ECDICT',
    sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
    sourcePath: 'ecdict.csv',
    sourceSha256: hash,
    sourceByteSize: rawBytes.byteLength,
    schemaVersion: 1,
    canonicalDownloadUrl: 'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
  })
  return { descriptor, rawBytes }
}

function createMockStream(chunks: Uint8Array[]): any {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    },
  })
}

describe('ECDICT secure downloader', () => {
  let testRoot: string
  let paths: ManagedStoragePaths

  function setupTestPaths() {
    testRoot = join(tmpdir(), `test-ecdict-downloader-${randomUUID()}`)
    mkdirSync(testRoot, { recursive: true })
    paths = resolveManagedStoragePaths({ home: testRoot })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })
  }

  function cleanupTestPaths() {
    try {
      rmSync(testRoot, { recursive: true, force: true })
    } catch {}
  }

  it('rejects insecure protocol (non-HTTPS)', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const insecureDescriptor: EcdictSourceDescriptor = {
        ...descriptor,
        canonicalDownloadUrl: 'http://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
      }

      await expect(
        downloadPinnedEcdict(paths, { descriptor: insecureDescriptor }),
      ).rejects.toThrow(/Insecure protocol/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects unallowlisted hostname', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const badHostDescriptor: EcdictSourceDescriptor = {
        ...descriptor,
        canonicalDownloadUrl: 'https://evil.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
      }

      await expect(
        downloadPinnedEcdict(paths, { descriptor: badHostDescriptor }),
      ).rejects.toThrow(/Forbidden hostname/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects redirect to insecure HTTP protocol', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://raw.githubusercontent.com/target' },
        }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/Insecure protocol/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects redirect to unallowlisted hostname', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.other.com/target' },
        }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/Forbidden hostname/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects exceeding maximum redirects (> 3)', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://raw.githubusercontent.com/next-hop' },
          }),
        ),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/Exceeded maximum redirect limit of 3/)
      expect(mockFetch).toHaveBeenCalledTimes(4) // initial + 3 redirects before 4th exceeds
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects redirect response missing Location header', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: {},
        }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/missing Location header/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects non-200 final HTTP status', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response('Not found', { status: 404 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/non-200 HTTP status 404/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects null response body', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/null response body/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects early when declared Content-Length exceeds sourceByteSize', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([Buffer.from('hello world')]), {
          status: 200,
          headers: { 'content-length': String(descriptor.sourceByteSize + 100) },
        }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/exceeds authoritative corpus size/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects oversized streamed body even with lying small Content-Length', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('small')
      // Stream sends 10 bytes while descriptor size is 5
      const chunk1 = Buffer.from('12345')
      const chunk2 = Buffer.from('67890')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([chunk1, chunk2]), {
          status: 200,
          headers: { 'content-length': '5' },
        }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/exceeded authoritative corpus size/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects truncated streamed body (actual bytes < expected bytes)', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('complete corpus content')
      // Stream sends only first 5 bytes
      const chunk = Buffer.from('compl')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([chunk]), { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/Truncated download/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects download when SHA-256 does not match', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('expected text')
      // Stream sends different text of the exact same length
      const chunk = Buffer.from('tampered text')
      expect(chunk.byteLength).toBe(descriptor.sourceByteSize)

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([chunk]), { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow(/SHA-256 integrity verification failed/)

      // Final cache not published
      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects download with invalid UTF-8 bytes mid-stream', async () => {
    setupTestPaths()
    try {
      const badUtf8Bytes = Buffer.from([0x68, 0x65, 0xff, 0xff, 0x6f])
      const { descriptor } = createSyntheticDescriptor(badUtf8Bytes)
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([badUtf8Bytes]), { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow()

      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects download with incomplete UTF-8 sequence at EOF', async () => {
    setupTestPaths()
    try {
      // 0xe4 0xbd is start of 3-byte Chinese character without 3rd byte
      const incompleteUtf8 = Buffer.from([0x61, 0xe4, 0xbd])
      const { descriptor } = createSyntheticDescriptor(incompleteUtf8)
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([incompleteUtf8]), { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow()

      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('successfully downloads and publishes verified synthetic corpus', async () => {
    setupTestPaths()
    try {
      const validContent = 'word,phonetic,definition\nhello,həˈloʊ,an utterance of hello\n'
      const { descriptor, rawBytes } = createSyntheticDescriptor(validContent)

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([rawBytes.subarray(0, 15), rawBytes.subarray(15)]), {
          status: 200,
          headers: { 'content-length': String(rawBytes.byteLength) },
        }),
      )

      const progressEvents: EcdictDownloadProgress[] = []
      const result = await downloadPinnedEcdict(paths, {
        descriptor,
        fetch: mockFetch as any,
        onProgress: (p) => progressEvents.push(p),
      })

      expect(result.reused).toBe(false)
      expect(result.byteSize).toBe(rawBytes.byteLength)
      expect(result.sha256).toBe(descriptor.sourceSha256)
      expect(result.sourceCommit).toBe(descriptor.sourceCommit)
      expect(result.redirectCount).toBe(0)

      const publishedFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      expect(existsSync(publishedFile)).toBe(true)
      expect(readFileSync(publishedFile, 'utf8')).toBe(validContent)

      // Progress events recorded
      expect(progressEvents.some((p) => p.phase === 'downloading')).toBe(true)
      expect(progressEvents.some((p) => p.phase === 'verifying')).toBe(true)
      expect(progressEvents.at(-1)?.phase).toBe('complete')
    } finally {
      cleanupTestPaths()
    }
  })

  it('reuses existing valid cache without making network calls', async () => {
    setupTestPaths()
    try {
      const validContent = 'cached corpus text'
      const { descriptor, rawBytes } = createSyntheticDescriptor(validContent)

      const cachedFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(cachedFile, rawBytes)

      const mockFetch = vi.fn()
      const progressEvents: EcdictDownloadProgress[] = []

      const result = await downloadPinnedEcdict(paths, {
        descriptor,
        fetch: mockFetch as any,
        onProgress: (p) => progressEvents.push(p),
      })

      expect(result.reused).toBe(true)
      expect(result.byteSize).toBe(rawBytes.byteLength)
      expect(result.sha256).toBe(descriptor.sourceSha256)
      expect(result.redirectCount).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled() // ZERO network calls!

      expect(progressEvents[0]?.phase).toBe('checking-cache')
      expect(progressEvents.at(-1)?.phase).toBe('complete')
    } finally {
      cleanupTestPaths()
    }
  })

  it('leaves existing invalid cache untouched if download fails', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('replacement content')
      const cachedFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      const invalidPreexistingBytes = Buffer.from('invalid pre-existing data')
      writeFileSync(cachedFile, invalidPreexistingBytes)

      // Network download fails
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('Network offline'))

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow('Network offline')

      // Pre-existing invalid file MUST remain intact
      expect(existsSync(cachedFile)).toBe(true)
      expect(readFileSync(cachedFile)).toEqual(invalidPreexistingBytes)
    } finally {
      cleanupTestPaths()
    }
  })

  it('atomically replaces existing invalid cache when download succeeds', async () => {
    setupTestPaths()
    try {
      const newContent = 'verified replacement'
      const { descriptor, rawBytes } = createSyntheticDescriptor(newContent)
      const cachedFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(cachedFile, Buffer.from('old corrupt bytes'))

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([rawBytes]), { status: 200 }),
      )

      const result = await downloadPinnedEcdict(paths, {
        descriptor,
        fetch: mockFetch as any,
      })

      expect(result.reused).toBe(false)
      expect(readFileSync(cachedFile, 'utf8')).toBe(newContent)
    } finally {
      cleanupTestPaths()
    }
  })

  it('cancels immediately if AbortSignal is already aborted', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('test')
      const controller = new AbortController()
      controller.abort()

      const mockFetch = vi.fn()

      await expect(
        downloadPinnedEcdict(paths, {
          descriptor,
          signal: controller.signal,
          fetch: mockFetch as any,
        }),
      ).rejects.toThrow(/aborted/)

      expect(mockFetch).not.toHaveBeenCalled()
      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('cancels mid-stream on AbortSignal and cleans up owned .part file', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('chunk1chunk2chunk3')
      const controller = new AbortController()

      let pullCount = 0
      const abortingStream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          pullCount++
          if (pullCount === 1) {
            ctrl.enqueue(Buffer.from('chunk1'))
            controller.abort()
          } else {
            ctrl.enqueue(Buffer.from('chunk2'))
          }
        },
      })

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(abortingStream as any, { status: 200 }),
      )

      await expect(
        downloadPinnedEcdict(paths, {
          descriptor,
          signal: controller.signal,
          fetch: mockFetch as any,
        }),
      ).rejects.toThrow(/aborted/)

      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('blocks concurrent same-process download attempts for same destination', async () => {
    setupTestPaths()
    try {
      const { descriptor, rawBytes } = createSyntheticDescriptor('slow download content')

      let resolveFetch!: (res: Response) => void
      const slowFetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })

      const mockFetch = vi.fn().mockImplementation(() => slowFetchPromise)

      // Start attempt A (in flight)
      const attemptA = downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any })

      // Attempt B should be immediately rejected with EcdictDownloadInProgressError
      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toBeInstanceOf(EcdictDownloadInProgressError)

      // Resolve attempt A
      resolveFetch(new Response(createMockStream([rawBytes]), { status: 200 }))
      const resultA = await attemptA
      expect(resultA.reused).toBe(false)

      // Subsequent attempt C after A completes succeeds (finding valid cache)
      const resultC = await downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any })
      expect(resultC.reused).toBe(true)
    } finally {
      cleanupTestPaths()
    }
  })

  it('preserves foreign .part files during own cleanup on failure', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('fail test')
      const foreignPartPath = join(paths.sourceCacheDirectory, `ecdict.csv.${randomUUID()}.part`)
      writeFileSync(foreignPartPath, 'foreign partial data from another process')

      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('Network exploded'))

      await expect(
        downloadPinnedEcdict(paths, { descriptor, fetch: mockFetch as any }),
      ).rejects.toThrow('Network exploded')

      // Foreign .part MUST NOT be unlinked
      expect(existsSync(foreignPartPath)).toBe(true)
      expect(readFileSync(foreignPartPath, 'utf8')).toBe('foreign partial data from another process')
    } finally {
      cleanupTestPaths()
    }
  })

  it('ignores progress callback exceptions and completes download successfully', async () => {
    setupTestPaths()
    try {
      const { descriptor, rawBytes } = createSyntheticDescriptor('observer exception safe')
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(createMockStream([rawBytes]), { status: 200 }),
      )

      const buggyProgress = () => {
        throw new Error('Buggy UI callback explosion')
      }

      const result = await downloadPinnedEcdict(paths, {
        descriptor,
        fetch: mockFetch as any,
        onProgress: buggyProgress,
      })

      expect(result.reused).toBe(false)
      expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(true)
    } finally {
      cleanupTestPaths()
    }
  })

  it('verifies that host apply() makes zero external network calls even with managed-ecdict mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      let registeredFetch: unknown = null
      let cleanupDisposer: (() => Promise<void>) | undefined

      const mockCtx = {
        effect: (fn: () => () => Promise<void>) => {
          cleanupDisposer = fn()
        },
        connection: {
          fetch: {
            register: (spec: { fetch: unknown }) => {
              registeredFetch = spec.fetch
              return async () => {}
            },
          },
        },
      }

      const configManaged = Config({ dictionaryMode: 'managed-ecdict' })
      apply(mockCtx as any, configManaged)

      expect(registeredFetch).not.toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled() // ZERO fetch calls on startup!

      if (cleanupDisposer) {
        await cleanupDisposer()
      }
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
