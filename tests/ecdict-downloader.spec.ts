import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'

import {
  EcdictDownloadInProgressError,
  MAX_STREAMED_SOURCE_BYTES,
  downloadPinnedEcdict,
  downloadPinnedEcdictInternal,
  hasEmbeddedUserInfo,
  parseContentLengthHeader,
  type EcdictDownloadProgress,
} from '../src/host/ecdict-downloader.js'
import {
  loadPinnedEcdictSourceDescriptor,
  type EcdictSourceDescriptor,
} from '../src/host/ecdict-source.js'
import { resolveManagedStoragePaths, type ManagedStoragePaths } from '../src/host/managed-storage.js'
import { apply } from '../src/index.js'
import * as indexExports from '../src/index.js'
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

function createMockStream(chunks: Uint8Array[], onCancel?: (reason?: any) => void): any {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    },
    cancel(reason) {
      onCancel?.(reason)
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

  describe('BUG-003 response ownership', () => {
    function openBody(bytes: Uint8Array, cancel: () => void | Promise<void> = () => {}) {
      return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes) }, cancel })
    }

    it.each(['decode', 'write', 'write-cancel-rejection', 'read', 'limit', 'cancel-rejection'])('releases reader and aborts transport on %s failure', async (failure) => {
      setupTestPaths()
      const original = new Error('original disk failure')
      const caller = new AbortController()
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      let transport: AbortSignal | undefined
      let cancelled = 0
      let ownedHandle: FileHandle | undefined
      const writing = failure.startsWith('write')
      const body = failure === 'read'
        ? new ReadableStream<Uint8Array>({ pull(c) { c.error(original) } })
        : openBody(writing ? Buffer.from('ok') : failure === 'limit' ? Buffer.from('long') : Buffer.from([0xff]), () => {
          cancelled++
          if (failure.includes('cancel-rejection')) return Promise.reject(new Error('cancel failed'))
        })
      const { descriptor } = createSyntheticDescriptor('ok')
      try {
        const outcome = await downloadPinnedEcdictInternal(paths, descriptor, {
          signal: caller.signal,
          fetch: (async (_url, init) => { transport = init?.signal as AbortSignal; return new Response(body as any) }) as typeof fetch,
          ...(writing ? { writeChunk: async (handle: FileHandle) => {
            ownedHandle = handle
            const close = handle.close.bind(handle)
            handle.close = async () => {
              expect(readdirSync(paths.sourceCacheDirectory).some(name => name.endsWith('.part'))).toBe(true)
              await close()
            }
            throw original
          } } : {}),
        } as any).catch(error => error)
        if (writing || failure === 'read') expect(outcome).toBe(original)
        else expect(outcome).toBeInstanceOf(Error)
        if (failure !== 'read') expect(cancelled).toBe(1)
        expect(body.locked).toBe(false)
        expect(transport).not.toBe(caller.signal)
        expect(transport?.aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
        if (writing) expect(ownedHandle?.fd).toBe(-1)
        expect(readdirSync(paths.sourceCacheDirectory)).toEqual([])
      } finally { cleanupTestPaths() }
    })

    it.each(['decode', 'status', 'length', 'redirect'])('bounds pending cancel at 1000ms for %s and preserves the original error', async (failure) => {
      setupTestPaths()
      let entered!: () => void
      const cancelEntered = new Promise<void>(resolve => { entered = resolve })
      let finish!: () => void
      const pending = new Promise<void>((_resolve, reject) => { finish = () => reject(new Error('late cancel rejection')) })
      let cancelCalls = 0
      const body = openBody(Buffer.from([0xff]), () => { cancelCalls++; entered(); return pending })
      let transport: AbortSignal | undefined
      const { descriptor } = createSyntheticDescriptor('ok')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let settled = false
      let error: unknown
      const operation = downloadPinnedEcdictInternal(paths, descriptor, {
        fetch: (async (_url, init) => {
          transport = init?.signal as AbortSignal
          return new Response(body as any, failure === 'status' ? { status: 503 } : failure === 'length' ? { headers: { 'content-length': 'bad' } } : failure === 'redirect' ? { status: 302, headers: { location: 'https://raw.githubusercontent.com/next' } } : {})
        }) as typeof fetch,
      }).catch(e => { settled = true; error = e })
      try {
        const first = await Promise.race([
          cancelEntered.then(() => 'cancel-entered'),
          operation.then(() => 'operation-settled'),
        ])
        expect(first).toBe('cancel-entered')
        expect(cancelCalls).toBe(1)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(transport?.aborted).toBe(true)
        expect(body.locked).toBe(false)
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('unconfirmed'))
        await operation // Real disk cleanup follows the already completed bounded stream cleanup.
        expect(settled).toBe(true)
        expect(error).toBeInstanceOf(Error)
        if (failure === 'decode') expect(error).toBeInstanceOf(TypeError)
        if (failure === 'status') expect((error as Error).message).toContain('non-200 HTTP status 503')
        if (failure === 'length') expect((error as Error).message).toContain('Invalid Content-Length')
        expect(readdirSync(paths.sourceCacheDirectory)).toEqual([])
      } finally {
        if (cancelCalls > 0) finish()
        await operation; await new Promise<void>(resolve => setImmediate(resolve)); vi.useRealTimers(); warning.mockRestore(); cleanupTestPaths()
      }
    })

    it('forwards abort while read is pending and removes caller listener', async () => {
      setupTestPaths()
      const caller = new AbortController()
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      let transport: AbortSignal | undefined
      let ready!: () => void
      const fetched = new Promise<void>(resolve => { ready = resolve })
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({ start(c) { streamController = c } })
      const { descriptor } = createSyntheticDescriptor('ok')
      const operation = downloadPinnedEcdictInternal(paths, descriptor, {
        signal: caller.signal,
        fetch: (async (_url, init) => {
          transport = init?.signal as AbortSignal
          // Match fetch's transport contract: abort rejects an outstanding body read.
          transport.addEventListener('abort', () => streamController.error(new DOMException('aborted', 'AbortError')), { once: true })
          ready(); return new Response(body as any)
        }) as typeof fetch,
      })
      try {
        await fetched; await new Promise<void>(resolve => setImmediate(resolve)); caller.abort('caller reason')
        await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
        expect(transport).not.toBe(caller.signal)
        expect(body.locked).toBe(false)
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
        expect(readdirSync(paths.sourceCacheDirectory)).toEqual([])
      } finally { cleanupTestPaths() }
    })

    it('releases normal EOF without cancel, including hash failure, then succeeds and reuses valid cache', async () => {
      setupTestPaths()
      const { descriptor, rawBytes } = createSyntheticDescriptor('ok')
      const caller = new AbortController()
      const add = vi.spyOn(caller.signal, 'addEventListener')
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      try {
        for (const badHash of [true, true, false]) {
          let cancelled = 0
          const body = createMockStream([rawBytes], () => { cancelled++ })
          const promise = downloadPinnedEcdictInternal(paths, badHash ? { ...descriptor, sourceSha256: '0'.repeat(64) } : descriptor, { signal: caller.signal, fetch: (async () => new Response(body)) as typeof fetch })
          if (badHash) await expect(promise).rejects.toThrow(/SHA-256/)
          else await expect(promise).resolves.toMatchObject({ reused: false })
          expect(body.locked).toBe(false)
          expect(cancelled).toBe(0)
        }
        const network = vi.fn(() => { throw new Error('cache reuse must not fetch') })
        await expect(downloadPinnedEcdictInternal(paths, descriptor, { signal: caller.signal, fetch: network })).resolves.toMatchObject({ reused: true })
        expect(readFileSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toEqual(rawBytes)
        expect(readdirSync(paths.sourceCacheDirectory)).toEqual(['ecdict.csv'])
        expect(remove.mock.calls.length).toBe(add.mock.calls.length)
      } finally { cleanupTestPaths() }
    })

    it('recovers the same destination after consecutive open-stream failures and a cancelled redirect', async () => {
      setupTestPaths()
      const { descriptor, rawBytes } = createSyntheticDescriptor('ok')
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const body = openBody(Buffer.from([0xff]), () => attempt === 1 ? Promise.reject(new Error('cancel rejected')) : undefined)
          await expect(downloadPinnedEcdictInternal(paths, descriptor, { fetch: (async () => new Response(body as any)) as typeof fetch })).rejects.toBeInstanceOf(TypeError)
          expect(body.locked).toBe(false)
          expect(readdirSync(paths.sourceCacheDirectory)).toEqual([])
        }
        let redirectCancelled = 0
        const redirectBody = openBody(Buffer.from('redirect'), () => { redirectCancelled++ })
        const finalBody = createMockStream([rawBytes])
        const signals: AbortSignal[] = []
        const responseQueue = [new Response(redirectBody as any, { status: 302, headers: { location: '/next' } }), new Response(finalBody)]
        const result = await downloadPinnedEcdictInternal(paths, descriptor, {
          fetch: (async (_url, init) => { signals.push(init?.signal as AbortSignal); return responseQueue.shift()! }) as typeof fetch,
        })
        expect(result).toMatchObject({ redirectCount: 1, reused: false })
        expect(redirectCancelled).toBe(1)
        expect(redirectBody.locked).toBe(false)
        expect(finalBody.locked).toBe(false)
        expect(signals[0]).toBe(signals[1])
        expect(signals[0]?.aborted).toBe(false)
        expect(readFileSync(result.path)).toEqual(rawBytes)
      } finally { cleanupTestPaths() }
    })

    it('retains its part if closing its handle fails and preserves the original write error', async () => {
      setupTestPaths()
      const { descriptor } = createSyntheticDescriptor('ok')
      const original = new Error('disk write failed')
      let closeOwned: (() => Promise<void>) | undefined
      const body = openBody(Buffer.from('ok'))
      try {
        await expect(downloadPinnedEcdictInternal(paths, descriptor, {
          fetch: (async () => new Response(body as any)) as typeof fetch,
          writeChunk: async handle => {
            closeOwned = handle.close.bind(handle)
            handle.close = async () => { throw new Error('close failed') }
            throw original
          },
        })).rejects.toBe(original)
        expect(body.locked).toBe(false)
        expect(readdirSync(paths.sourceCacheDirectory).filter(name => name.endsWith('.part'))).toHaveLength(1)
        expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(false)
      } finally { await closeOwned?.(); cleanupTestPaths() }
    })
  })

  describe('BUG-003 actual Host artifact', () => {
    it('keeps the packaged pin and private seams while cancelling invalid open UTF-8 through the public root', async () => {
      setupTestPaths()
      const artifact = await import(new URL('../lib/index.js', import.meta.url).href)
      const caller = new AbortController()
      const remove = vi.spyOn(caller.signal, 'removeEventListener')
      let cancelled = 0
      let transport: AbortSignal | undefined
      let requested: unknown
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from([0xff])) }, cancel() { cancelled++ } })
      const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requested = url; transport = init?.signal as AbortSignal
        return new Response(body as any)
      })
      const foreignSeam = vi.fn(() => { throw new Error('private override reached production') })
      try {
        for (const internal of ['downloadPinnedEcdictInternal', 'DownloadPinnedEcdictInternalOptions', 'writeChunk', 'validateEcdictManifest']) expect(internal in artifact).toBe(false)
        await expect(artifact.downloadPinnedEcdict(paths, {
          signal: caller.signal, fetch: foreignSeam, writeChunk: foreignSeam,
          descriptor: createSyntheticDescriptor('foreign').descriptor,
        })).rejects.toBeInstanceOf(TypeError)
        expect(requested).toBe('https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv')
        expect(foreignSeam).not.toHaveBeenCalled()
        expect(cancelled).toBe(1)
        expect(body.locked).toBe(false)
        expect(transport).not.toBe(caller.signal)
        expect(transport?.aborted).toBe(true)
        expect(caller.signal.aborted).toBe(false)
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
        expect(readdirSync(paths.sourceCacheDirectory)).toEqual([])
      } finally { network.mockRestore(); cleanupTestPaths() }
    })
  })

  it('rejects insecure protocol (non-HTTPS)', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      const insecureDescriptor: EcdictSourceDescriptor = {
        ...descriptor,
        canonicalDownloadUrl: 'http://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
      }

      await expect(
        downloadPinnedEcdictInternal(paths, insecureDescriptor),
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
        downloadPinnedEcdictInternal(paths, badHostDescriptor),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
      ).rejects.toThrow(/null response body/)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects early when declared Content-Length exceeds sourceByteSize', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello world')
      let cancelCalled = false
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(
          createMockStream([Buffer.from('hello world')], () => {
            cancelCalled = true
          }),
          {
            status: 200,
            headers: { 'content-length': String(descriptor.sourceByteSize + 100) },
          },
        ),
      )

      await expect(
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
      ).rejects.toThrow(/exceeds authoritative corpus size/)

      expect(cancelCalled).toBe(true)
      const finalCachePath = join(paths.sourceCacheDirectory, 'ecdict.csv')
      expect(existsSync(finalCachePath)).toBe(false)
      const partFiles = readdirSync(paths.sourceCacheDirectory).filter((f) => f.includes('.part'))
      expect(partFiles).toEqual([])
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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
      const result = await downloadPinnedEcdictInternal(paths, descriptor, {
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

      const result = await downloadPinnedEcdictInternal(paths, descriptor, {
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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

      const result = await downloadPinnedEcdictInternal(paths, descriptor, {
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
        downloadPinnedEcdictInternal(paths, descriptor, {
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
        downloadPinnedEcdictInternal(paths, descriptor, {
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
      const attemptA = downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any })

      // Attempt B should be immediately rejected with EcdictDownloadInProgressError
      await expect(
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
      ).rejects.toBeInstanceOf(EcdictDownloadInProgressError)

      // Resolve attempt A
      resolveFetch(new Response(createMockStream([rawBytes]), { status: 200 }))
      const resultA = await attemptA
      expect(resultA.reused).toBe(false)

      // Subsequent attempt C after A completes succeeds (finding valid cache)
      const resultC = await downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any })
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
        downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
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

      const result = await downloadPinnedEcdictInternal(paths, descriptor, {
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

  describe('Remediation A: Cancellation linearization & abort-before-publication', () => {
    it('aborts cleanly from verifying progress callback without publishing final file and removes .part', async () => {
      setupTestPaths()
      try {
        const { descriptor, rawBytes } = createSyntheticDescriptor('verifying phase abort test')
        const controller = new AbortController()

        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(createMockStream([rawBytes]), { status: 200 }),
        )

        const finalFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
        expect(existsSync(finalFile)).toBe(false)

        let abortedInVerifying = false
        const downloadPromise = downloadPinnedEcdictInternal(paths, descriptor, {
          fetch: mockFetch as any,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === 'verifying') {
              abortedInVerifying = true
              controller.abort()
            }
          },
        })

        await expect(downloadPromise).rejects.toThrow(/aborted/)
        expect(abortedInVerifying).toBe(true)

        // Final file must NOT exist (publication was prevented)
        expect(existsSync(finalFile)).toBe(false)

        // Own .part file must be cleaned up
        const residualParts = readdirSync(paths.sourceCacheDirectory).filter((f) => f.endsWith('.part'))
        expect(residualParts).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('preserves existing invalid final cache byte-for-byte when abort occurs at verifying stage', async () => {
      setupTestPaths()
      try {
        const { descriptor, rawBytes } = createSyntheticDescriptor('new valid content')
        const controller = new AbortController()

        const finalFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
        const corruptedOriginalBytes = Buffer.from('corrupted-invalid-cache-bytes-must-not-be-overwritten')
        writeFileSync(finalFile, corruptedOriginalBytes)

        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(createMockStream([rawBytes]), { status: 200 }),
        )

        let abortedInVerifying = false
        const downloadPromise = downloadPinnedEcdictInternal(paths, descriptor, {
          fetch: mockFetch as any,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.phase === 'verifying') {
              abortedInVerifying = true
              controller.abort()
            }
          },
        })

        await expect(downloadPromise).rejects.toThrow(/aborted/)
        expect(abortedInVerifying).toBe(true)

        // Existing invalid cache file must remain 100% byte-for-byte identical
        expect(existsSync(finalFile)).toBe(true)
        const currentBytes = readFileSync(finalFile)
        expect(currentBytes).toEqual(corruptedOriginalBytes)

        // Own .part file must be cleaned up
        const residualParts = readdirSync(paths.sourceCacheDirectory).filter((f) => f.endsWith('.part'))
        expect(residualParts).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('releases same-process concurrency guard immediately after abort at verifying stage', async () => {
      setupTestPaths()
      try {
        const { descriptor, rawBytes } = createSyntheticDescriptor('concurrency release test')
        const controller = new AbortController()

        const mockFetch1 = vi.fn().mockResolvedValueOnce(
          new Response(createMockStream([rawBytes]), { status: 200 }),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, {
            fetch: mockFetch1 as any,
            signal: controller.signal,
            onProgress: (p) => {
              if (p.phase === 'verifying') {
                controller.abort()
              }
            },
          }),
        ).rejects.toThrow(/aborted/)

        // Concurrency guard MUST be released: a subsequent download attempt must NOT throw EcdictDownloadInProgressError
        const mockFetch2 = vi.fn().mockResolvedValueOnce(
          new Response(createMockStream([rawBytes]), { status: 200 }),
        )

        const result2 = await downloadPinnedEcdictInternal(paths, descriptor, {
          fetch: mockFetch2 as any,
        })
        expect(result2.reused).toBe(false)
        expect(existsSync(join(paths.sourceCacheDirectory, 'ecdict.csv'))).toBe(true)
      } finally {
        cleanupTestPaths()
      }
    })
  })

  describe('Remediation B: Production provenance boundary & test seam isolation', () => {
    it('ensures root package exports (src/index.ts) do not expose internal testing seams', () => {
      expect('downloadPinnedEcdictInternal' in indexExports).toBe(false)
      expect('validateEcdictManifest' in indexExports).toBe(false)
      expect('resolvePackagedManifestPath' in indexExports).toBe(false)
      expect('LoadEcdictManifestOptions' in indexExports).toBe(false)
      expect('DownloadPinnedEcdictInternalOptions' in indexExports).toBe(false)
      expect(typeof indexExports.downloadPinnedEcdict).toBe('function')
      expect(typeof indexExports.loadPinnedEcdictSourceDescriptor).toBe('function')
    })

    it('production downloadPinnedEcdict always resolves packaged manifest pin and ignores foreign descriptor options', async () => {
      setupTestPaths()
      try {
        const packagedDesc = indexExports.loadPinnedEcdictSourceDescriptor()
        expect(packagedDesc.sourceName).toBe('ECDICT')
        expect(packagedDesc.sourceCommit).toBe('bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b')
        expect(packagedDesc.sourceSha256).toBe('1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf')

        // Preflight abort to verify packaged pin resolution without starting actual network transfer
        const controller = new AbortController()
        controller.abort('preflight-aborted')

        await expect(
          downloadPinnedEcdict(paths, { signal: controller.signal }),
        ).rejects.toThrow(/aborted/)
      } finally {
        cleanupTestPaths()
      }
    })
  })

  describe('Remediation C: Independent hard streamed-byte ceiling & strict Content-Length', () => {
    it('defines distinct manifest sourceByteSize and MAX_STREAMED_SOURCE_BYTES ceiling', () => {
      const descriptor = loadPinnedEcdictSourceDescriptor()
      expect(descriptor.sourceByteSize).toBe(65933428)
      expect(MAX_STREAMED_SOURCE_BYTES).toBe(80 * 1024 * 1024)
      expect(MAX_STREAMED_SOURCE_BYTES).toBeGreaterThan(descriptor.sourceByteSize)
    })

    it('rejects pre-network when descriptor expected size exceeds absolute ceiling (80 MiB)', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test')
        const oversizedDescriptor: EcdictSourceDescriptor = {
          ...descriptor,
          sourceByteSize: MAX_STREAMED_SOURCE_BYTES + 1,
        }

        const mockFetch = vi.fn()
        await expect(
          downloadPinnedEcdictInternal(paths, oversizedDescriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/exceeds maximum allowed ceiling of 83886080 bytes/)

        expect(mockFetch).not.toHaveBeenCalled()
      } finally {
        cleanupTestPaths()
      }
    })

    it('rejects early when Content-Length exceeds absolute security ceiling (80 MiB)', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test')
        let cancelCalled = false
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(
            createMockStream([Buffer.from('test')], () => {
              cancelCalled = true
            }),
            {
              status: 200,
              headers: { 'content-length': String(MAX_STREAMED_SOURCE_BYTES + 500) },
            },
          ),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/Content-Length.*exceeds maximum allowed ceiling of 83886080 bytes/)

        expect(cancelCalled).toBe(true)
        const finalCachePath = join(paths.sourceCacheDirectory, 'ecdict.csv')
        expect(existsSync(finalCachePath)).toBe(false)
        const partFiles = readdirSync(paths.sourceCacheDirectory).filter((f) => f.includes('.part'))
        expect(partFiles).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('strictly parses Content-Length and rejects malformed values like "123garbage"', () => {
      expect(parseContentLengthHeader(null)).toBeNull()
      expect(parseContentLengthHeader('12345')).toBe(12345)
      expect(parseContentLengthHeader(' 65933428 ')).toBe(65933428)
      expect(() => parseContentLengthHeader('123garbage')).toThrow(/Invalid Content-Length header value/)
      expect(() => parseContentLengthHeader('-50')).toThrow(/Invalid Content-Length header value/)
      expect(() => parseContentLengthHeader('12.34')).toThrow(/Invalid Content-Length header value/)
      expect(() => parseContentLengthHeader('abc')).toThrow(/Invalid Content-Length header value/)
    })

    it('cancels response body and cleans up .part when Content-Length is malformed ("123garbage") without touching absent final', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test payload')
        let cancelCalled = false
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(
            createMockStream([Buffer.from('test payload')], () => {
              cancelCalled = true
            }),
            {
              status: 200,
              headers: { 'content-length': '123garbage' },
            },
          ),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/Invalid Content-Length header value: "123garbage"/)

        expect(cancelCalled).toBe(true)
        const finalCachePath = join(paths.sourceCacheDirectory, 'ecdict.csv')
        expect(existsSync(finalCachePath)).toBe(false)
        const partFiles = readdirSync(paths.sourceCacheDirectory).filter((f) => f.includes('.part'))
        expect(partFiles).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('cancels response body, cleans up .part, and preserves existing invalid final cache byte-for-byte on malformed Content-Length', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test payload')
        const finalCachePath = join(paths.sourceCacheDirectory, 'ecdict.csv')
        const corruptedFinal = Buffer.from('preserved corrupted final bytes sequence')
        writeFileSync(finalCachePath, corruptedFinal)

        let cancelCalled = false
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(
            createMockStream([Buffer.from('test payload')], () => {
              cancelCalled = true
            }),
            {
              status: 200,
              headers: { 'content-length': '-50' },
            },
          ),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/Invalid Content-Length header value: "-50"/)

        expect(cancelCalled).toBe(true)
        expect(existsSync(finalCachePath)).toBe(true)
        expect(readFileSync(finalCachePath)).toEqual(corruptedFinal)
        const partFiles = readdirSync(paths.sourceCacheDirectory).filter((f) => f.includes('.part'))
        expect(partFiles).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('cancels response body and cleans up .part when Content-Length is an unsafe integer', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test payload')
        let cancelCalled = false
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(
            createMockStream([Buffer.from('test payload')], () => {
              cancelCalled = true
            }),
            {
              status: 200,
              headers: { 'content-length': '9007199254740992' },
            },
          ),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/Content-Length value out of safe integer range/)

        expect(cancelCalled).toBe(true)
        const finalCachePath = join(paths.sourceCacheDirectory, 'ecdict.csv')
        expect(existsSync(finalCachePath)).toBe(false)
        const partFiles = readdirSync(paths.sourceCacheDirectory).filter((f) => f.includes('.part'))
        expect(partFiles).toEqual([])
      } finally {
        cleanupTestPaths()
      }
    })

    it('rejects in stream loop with explicit security ceiling error when bytes exceed 80 MiB', async () => {
      setupTestPaths()
      try {
        // Stream that emits a chunk exceeding MAX_STREAMED_SOURCE_BYTES
        // To avoid creating an 80+ MiB Buffer in memory, we construct a chunk whose byteLength property is > 80 MiB
        const { descriptor } = createSyntheticDescriptor('test')
        const fakeOversizedChunk = {
          byteLength: MAX_STREAMED_SOURCE_BYTES + 10,
        } as Uint8Array
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(createMockStream([fakeOversizedChunk]), { status: 200 }),
        )

        await expect(
          downloadPinnedEcdictInternal(paths, descriptor, { fetch: mockFetch as any }),
        ).rejects.toThrow(/exceeded absolute security ceiling of 83886080 bytes/)
      } finally {
        cleanupTestPaths()
      }
    })
  })

  describe('Remediation D: Clean un-obfuscated URL credentials rejection', () => {
    it('detects embedded userinfo via hasEmbeddedUserInfo without scanner obfuscation', () => {
      expect(hasEmbeddedUserInfo(new URL('https://user@raw.githubusercontent.com/test'))).toBe(true)
      expect(hasEmbeddedUserInfo(new URL('https://user:secret@raw.githubusercontent.com/test'))).toBe(true)
      expect(hasEmbeddedUserInfo(new URL('https://:secret@raw.githubusercontent.com/test'))).toBe(true)
      expect(hasEmbeddedUserInfo(new URL('https://raw.githubusercontent.com/test'))).toBe(false)
    })

    it('fails closed for all variations of URL embedded credentials', async () => {
      setupTestPaths()
      try {
        const { descriptor } = createSyntheticDescriptor('test')

        const testUrls = [
          'https://user@raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
          'https://user:secret@raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
          'https://:secret@raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
        ]

        for (const badUrl of testUrls) {
          const badDescriptor = { ...descriptor, canonicalDownloadUrl: badUrl }
          await expect(
            downloadPinnedEcdictInternal(paths, badDescriptor),
          ).rejects.toThrow(/URL must not contain embedded user credentials/)
        }
      } finally {
        cleanupTestPaths()
      }
    })

    it('confirms source code contains zero Store-scanner string-splitting obfuscation', () => {
      const downloaderSource = readFileSync(join(__dirname, '../src/host/ecdict-downloader.ts'), 'utf8')
      expect(downloaderSource).not.toMatch(/['"]pass['"]\s*\+\s*['"]word['"]/i)
      expect(downloaderSource).not.toMatch(/\\u00/i)
    })
  })
})
