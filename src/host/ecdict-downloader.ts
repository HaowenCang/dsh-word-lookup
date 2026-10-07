/**
 * Secure streaming downloader for authoritative pinned ECDICT corpus with streaming verification.
 *
 * Implements strict Phase 7A.4 download, integrity, and cache lifecycles:
 * - Pinned canonical HTTPS download from `raw.githubusercontent.com`.
 * - Strict URL validation, HTTPS-only, no credentials, safe port, and manual bounded redirects (<= 3).
 * - Simultaneous streaming SHA-256, fatal UTF-8 decoding, and exact byte size verification.
 * - Absolute hard byte cap enforced chunk-by-chunk (no full-source buffering in memory).
 * - Unique temporary `.part` file per attempt (`ecdict.csv.<uuid>.part`) with exclusive creation (`wx`).
 * - Backpressure-safe, partial-write-safe disk streaming with explicit flush/sync before publish.
 * - Cache verification & reuse: pre-existing valid cache short-circuits network fetch (zero requests).
 * - Safe invalid cache handling: invalid pre-existing files are never deleted prior to verified replacement.
 * - Same-process concurrency gating via {@link EcdictDownloadInProgressError}.
 * - Cross-process race resilience with convergence verification and isolated own-artifact cleanup.
 * - Full `AbortSignal` cancellation support with standard `AbortError` semantics.
 * - Non-leaking progress callback seam throttled to <= 10 updates/sec with observer exception shielding.
 *
 * Invariants:
 * - Zero automatic execution: this downloader is an internal callable primitive invoked only
 *   by explicit future user actions (Phase 7A.6/7A.7).
 * - Does NOT write `active.json` or create SQLite databases (Phase 7A.5 responsibility).
 * - Zero external npm network dependencies (Node.js 24 built-in `fetch`, `crypto`, `fs`).
 * - No credentials or auth headers transmitted or logged.
 *
 * @module dsh-word-lookup/host/ecdict-downloader
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  ALLOWED_DOWNLOAD_HOSTNAME,
  loadPinnedEcdictSourceDescriptor,
  type EcdictSourceDescriptor,
} from './ecdict-source.js'
import type { ManagedStoragePaths } from './managed-storage.js'

/** Maximum permitted redirects before failing closed. */
export const MAX_REDIRECTS = 3

/**
 * Independent hard security ceiling on any streamed source bytes (80 MiB = 83,886,080 bytes).
 * Enforced unconditionally chunk-by-chunk during network retrieval to prevent resource exhaustion
 * and runaway/infinite streams, completely independent of expected integrity byte size.
 */
export const MAX_STREAMED_SOURCE_BYTES = 80 * 1024 * 1024

/** Allowed HTTP redirect status codes. */
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

/** Allowed network hostname set. */
const ALLOWED_HOSTNAMES = new Set([ALLOWED_DOWNLOAD_HOSTNAME])

/** Minimum interval between throttled progress updates in milliseconds (10 updates/sec). */
const PROGRESS_THROTTLE_INTERVAL_MS = 100

/**
 * Error thrown when a concurrent download for the same destination is already in flight in the current process.
 */
export class EcdictDownloadInProgressError extends Error {
  /** Target cache destination path. */
  readonly destinationPath: string

  constructor(destinationPath: string) {
    super(`ECDICT download already in progress for destination: ${destinationPath}`)
    this.name = 'EcdictDownloadInProgressError'
    this.destinationPath = destinationPath
  }
}

/**
 * Progress lifecycle phases for ECDICT source verification and download.
 */
export type EcdictDownloadProgressPhase =
  | 'checking-cache'
  | 'downloading'
  | 'verifying'
  | 'complete'

/**
 * Immutable progress event emitted to observers during download lifecycle.
 */
export interface EcdictDownloadProgress {
  /** Current operation phase. */
  readonly phase: EcdictDownloadProgressPhase
  /** Number of bytes processed or downloaded so far. */
  readonly bytesProcessed: number
  /** Expected total byte size of the source corpus. */
  readonly totalBytes: number
}

/**
 * Callback function type for download progress updates.
 */
export type EcdictDownloadProgressCallback = (progress: EcdictDownloadProgress) => void

/**
 * Immutable outcome descriptor returned upon successful verification or download.
 */
export interface EcdictDownloadResult {
  /** Normalized absolute path to the verified source file on disk (`ecdict.csv`). */
  readonly path: string
  /** Git commit hash of the verified corpus source. */
  readonly sourceCommit: string
  /** Verified 64-character lowercase SHA-256 digest. */
  readonly sha256: string
  /** Verified exact byte size. */
  readonly byteSize: number
  /** Whether an existing valid cache was reused without network download. */
  readonly reused: boolean
  /** Number of HTTP redirects observed during network retrieval (0 if reused). */
  readonly redirectCount: number
}

/**
 * Options for production-facing {@link downloadPinnedEcdict}.
 *
 * Production callers can only provide cancellation signals and progress observers.
 * Production callers cannot override source URL, commit, hash, byte size, fetch, or UUID generation.
 */
export interface DownloadPinnedEcdictOptions {
  /** Cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional observer callback for download progress. */
  readonly onProgress?: EcdictDownloadProgressCallback
}

/**
 * @internal Test-only seams for exercising streaming verification, failure modes, and edge cases.
 * Strictly forbidden from package root exports and production callers.
 */
export interface DownloadPinnedEcdictInternalOptions {
  /** Cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional observer callback for download progress. */
  readonly onProgress?: EcdictDownloadProgressCallback
  /** @internal Test-only seam to override fetch implementation. */
  readonly fetch?: typeof globalThis.fetch
  /** @internal Test-only seam to override UUID factory. */
  readonly generateId?: () => string
}

/** Set of normalized destination file paths currently being downloaded in this process. */
const activeDownloads = new Set<string>()

/**
 * Helper to construct an Error with `AbortError` name and standard DOMException behavior.
 */
function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const error = new DOMException('This operation was aborted', 'AbortError')
  if (reason !== undefined) {
    try {
      Object.defineProperty(error, 'cause', { value: reason, configurable: true, writable: true })
    } catch {
      // ignore property definition failure
    }
  }
  return error
}

/**
 * Check whether an error represents an abortion.
 */
function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) return true
  if (typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') return true
  return false
}

/**
 * Safely invoke a progress callback, catching and ignoring observer exceptions so
 * UI or listener errors cannot disrupt the download or corrupt filesystem state.
 */
function notifyProgress(
  callback: EcdictDownloadProgressCallback | undefined,
  progress: EcdictDownloadProgress,
): void {
  if (!callback) return
  try {
    callback(progress)
  } catch {
    // Observer exceptions are deliberately shielded
  }
}

/**
 * Detect whether a URL contains embedded userinfo (username, password-only, or username:password).
 *
 * Implements strict protocol validation per RFC 3986 §3.2 and §3.2.1:
 * Checks standard WHATWG URL `username` property, and verifies whether the authority
 * component (between scheme and path/query/fragment) contains the userinfo delimiter `@`.
 *
 * @param url - parsed URL object.
 * @returns true if userinfo is present, false otherwise.
 */
export function hasEmbeddedUserInfo(url: URL): boolean {
  if (url.username !== '') {
    return true
  }
  // RFC 3986 §3.2 & §3.2.1 authority inspection for userinfo delimiter '@'
  const prefix = `${url.protocol}//`
  if (!url.href.startsWith(prefix)) {
    return true
  }
  const authorityAndRest = url.href.slice(prefix.length)
  const authorityEnd = authorityAndRest.search(/[/?#]/)
  const authority = authorityEnd === -1 ? authorityAndRest : authorityAndRest.slice(0, authorityEnd)
  return authority.includes('@')
}

/**
 * Strict Content-Length header parser.
 *
 * Rejects non-digits (e.g. "123garbage"), negative numbers, non-integers,
 * and unsafe integers. Returns null if header is not present.
 */
export function parseContentLengthHeader(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null
  }
  const trimmed = headerValue.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid Content-Length header value: "${headerValue}"`)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Content-Length value out of safe integer range: "${headerValue}"`)
  }
  return parsed
}

/**
 * Strict URL security validation:
 * - Must be https:
 * - Hostname must be in allowed list (`raw.githubusercontent.com`)
 * - No username or password embedded in URL
 * - Default or standard 443 port
 */
function validateTargetUrl(urlStr: string): URL {
  let urlObj: URL
  try {
    urlObj = new URL(urlStr)
  } catch (cause) {
    throw new Error(`Invalid URL: ${urlStr} (${String(cause)})`)
  }

  if (urlObj.protocol !== 'https:') {
    throw new Error(`Insecure protocol "${urlObj.protocol}": HTTPS is strictly required`)
  }

  if (!ALLOWED_HOSTNAMES.has(urlObj.hostname)) {
    throw new Error(`Forbidden hostname "${urlObj.hostname}": only allowed hosts (${[...ALLOWED_HOSTNAMES].join(', ')}) are permitted`)
  }

  if (hasEmbeddedUserInfo(urlObj)) {
    throw new Error('URL must not contain embedded user credentials')
  }

  if (urlObj.port !== '' && urlObj.port !== '443') {
    throw new Error(`Non-standard port "${urlObj.port}" is not allowed for secure corpus downloads`)
  }

  return urlObj
}

/**
 * Verify an existing source file on disk against expected byte size and SHA-256 digest
 * with single-pass fatal UTF-8 decoding.
 *
 * Serves three crucial roles across the plugin lifecycle:
 * 1. Existing cache verification and zero-request reuse.
 * 2. Post-concurrency verification if another process won the rename race.
 * 3. Precondition verification for future Phase 7A.5 SQLite import.
 *
 * @param filePath - absolute path to candidate file.
 * @param expected - expected size and SHA-256 digest.
 * @param options - optional signal and progress callback.
 * @returns true if file exists and matches size, SHA-256, and UTF-8 validity exactly; false otherwise.
 */
export async function verifyCachedEcdictSource(
  filePath: string,
  expected: { byteSize: number; sha256: string },
  options?: {
    signal?: AbortSignal
    onProgress?: EcdictDownloadProgressCallback
  },
): Promise<boolean> {
  if (options?.signal?.aborted) {
    throw createAbortError(options.signal.reason)
  }

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return false
  }

  if (!fileStat.isFile() || fileStat.size !== expected.byteSize) {
    return false
  }

  notifyProgress(options?.onProgress, {
    phase: 'checking-cache',
    bytesProcessed: 0,
    totalBytes: expected.byteSize,
  })

  const hash = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesProcessed = 0
  let lastProgressTime = 0

  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      if (options?.signal?.aborted) {
        throw createAbortError(options.signal.reason)
      }
      const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
      bytesProcessed += bufferChunk.byteLength
      if (bytesProcessed > expected.byteSize) {
        return false
      }

      hash.update(bufferChunk)
      decoder.decode(bufferChunk, { stream: true })

      const now = Date.now()
      if (now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL_MS) {
        lastProgressTime = now
        notifyProgress(options?.onProgress, {
          phase: 'checking-cache',
          bytesProcessed,
          totalBytes: expected.byteSize,
        })
      }
    }

    if (bytesProcessed !== expected.byteSize) {
      return false
    }

    // Flush decoder; fatal: true will throw if ending with incomplete multibyte sequence
    decoder.decode()

    const digest = hash.digest('hex').toLowerCase()
    return digest === expected.sha256.toLowerCase()
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return false
  } finally {
    if (!stream.destroyed) {
      stream.destroy()
    }
  }
}

/**
 * Execute network fetch with manual bounded redirect resolution and security enforcement.
 */
async function fetchWithRedirectPolicy(
  initialUrl: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ response: Response; redirectCount: number }> {
  let currentUrl = initialUrl
  let redirectCount = 0

  while (true) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }

    validateTargetUrl(currentUrl)

    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'Accept-Encoding': 'gzip, deflate, br',
      },
    })

    if (REDIRECT_STATUS_CODES.has(response.status)) {
      redirectCount++
      if (redirectCount > MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Exceeded maximum redirect limit of ${MAX_REDIRECTS}`)
      }

      const location = response.headers.get('location')
      if (!location) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status} redirect missing Location header from ${currentUrl}`)
      }

      // Best-effort response body cancellation before following next hop
      await response.body?.cancel().catch(() => {})

      const resolvedUrl = new URL(location, currentUrl).href
      currentUrl = resolvedUrl
      continue
    }

    return { response, redirectCount }
  }
}

/**
 * Download and verify the authoritative packaged pinned ECDICT corpus into managed cache storage.
 *
 * Production entrypoint:
 * - Automatically loads and strictly validates packaged `corpus/ecdict.manifest.json`.
 * - Constructs canonical source descriptor bound to authoritative commit and SHA-256.
 * - Downloads exclusively that canonical source.
 * - Production callers cannot override source URL, commit, hash, byte size, fetch, or UUID generation.
 *
 * @param paths - resolved managed storage paths.
 * @param options - optional cancellation signal and progress observer.
 * @returns frozen {@link EcdictDownloadResult}.
 */
export async function downloadPinnedEcdict(
  paths: ManagedStoragePaths,
  options?: DownloadPinnedEcdictOptions,
): Promise<EcdictDownloadResult> {
  const descriptor = loadPinnedEcdictSourceDescriptor()
  return downloadPinnedEcdictInternal(paths, descriptor, {
    signal: options?.signal,
    onProgress: options?.onProgress,
  })
}

/**
 * @internal Test-only internal core downloader accepting arbitrary descriptors and test seams.
 * Strictly forbidden from package root exports (src/index.ts).
 *
 * Sequence:
 * 1. Pre-network security ceiling check: fails immediately if descriptor sourceByteSize > 80 MiB.
 * 2. Concurrency check: fails immediately if destination is already active in this process.
 * 3. Directory check: ensures `<home>/cache/dsh-word-lookup/sources` exists.
 * 4. Pre-flight cache verification: if `ecdict.csv` already exists and matches exact size,
 *    SHA-256, and fatal UTF-8, returns immediately with `reused: true` (zero network calls).
 * 5. Partial file preparation: opens unique `ecdict.csv.<uuid>.part` with exclusive `'wx'` flag.
 * 6. Secure network fetch: fetches canonical URL with manual redirects (<= 3) and HTTPS validation.
 * 7. Content-Length check: parses strictly and rejects if exceeding ceiling or expected size.
 * 8. Streaming verification: reads chunks, enforces independent ceiling + exact size,
 *    writes to `.part` disk handle with partial-write loops, updates SHA-256, validates fatal UTF-8.
 * 9. Publication linearization: checks abort at multiple gates prior to rename publication.
 * 10. Verification completion: syncs and closes `.part` file handle.
 * 11. Atomic publication commit: renames `.part` to `ecdict.csv`.
 * 12. Concurrency convergence: if rename fails, verifies whether another concurrent process published
 *    valid final cache before throwing.
 *
 * @param paths - resolved managed storage paths.
 * @param descriptor - source descriptor to download.
 * @param options - optional signal, progress observer, and test seams.
 * @returns frozen {@link EcdictDownloadResult}.
 */
export async function downloadPinnedEcdictInternal(
  paths: ManagedStoragePaths,
  descriptor: EcdictSourceDescriptor,
  options?: DownloadPinnedEcdictInternalOptions,
): Promise<EcdictDownloadResult> {
  const signal = options?.signal
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }

  if (
    typeof descriptor.sourceByteSize !== 'number' ||
    !Number.isSafeInteger(descriptor.sourceByteSize) ||
    descriptor.sourceByteSize <= 0
  ) {
    throw new TypeError(`Invalid descriptor sourceByteSize: must be a positive safe integer`)
  }

  // Pre-network security ceiling check: descriptor over absolute ceiling rejected pre-network
  if (descriptor.sourceByteSize > MAX_STREAMED_SOURCE_BYTES) {
    throw new Error(
      `Descriptor sourceByteSize ${descriptor.sourceByteSize} exceeds maximum allowed ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`,
    )
  }

  const finalCachePath = resolve(join(paths.sourceCacheDirectory, 'ecdict.csv'))

  // 1. Same-process concurrency guard
  if (activeDownloads.has(finalCachePath)) {
    throw new EcdictDownloadInProgressError(finalCachePath)
  }
  activeDownloads.add(finalCachePath)

  try {
    // 2. Ensure cache directory exists
    await mkdir(paths.sourceCacheDirectory, { recursive: true })

    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }

    // 3. Pre-flight existing cache verification
    const existingValid = await verifyCachedEcdictSource(
      finalCachePath,
      { byteSize: descriptor.sourceByteSize, sha256: descriptor.sourceSha256 },
      { signal, onProgress: options?.onProgress },
    )

    if (existingValid) {
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }
      notifyProgress(options?.onProgress, {
        phase: 'complete',
        bytesProcessed: descriptor.sourceByteSize,
        totalBytes: descriptor.sourceByteSize,
      })
      return Object.freeze({
        path: finalCachePath,
        sourceCommit: descriptor.sourceCommit,
        sha256: descriptor.sourceSha256,
        byteSize: descriptor.sourceByteSize,
        reused: true,
        redirectCount: 0,
      })
    }

    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }

    // 4. Unique partial file preparation with exclusive creation
    const uuid = options?.generateId ? options.generateId() : randomUUID()
    const partPath = join(paths.sourceCacheDirectory, `ecdict.csv.${uuid}.part`)

    const fileHandle = await open(partPath, 'wx')
    let fileHandleClosed = false
    let downloadCompletedSuccessfully = false

    try {
      // 5. Network fetch with manual redirects
      const fetchImpl = options?.fetch ?? globalThis.fetch
      const { response, redirectCount } = await fetchWithRedirectPolicy(
        descriptor.canonicalDownloadUrl,
        fetchImpl,
        signal,
      )

      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Downloader received non-200 HTTP status ${response.status} from ${descriptor.canonicalDownloadUrl}`)
      }

      if (!response.body) {
        throw new Error('Downloader received null response body')
      }

      // Early Content-Length check if present
      const clHeader = response.headers.get('content-length')
      if (clHeader !== null) {
        let declaredLength: number | null
        try {
          declaredLength = parseContentLengthHeader(clHeader)
        } catch (error) {
          await response.body.cancel().catch(() => {})
          throw error
        }
        if (declaredLength !== null) {
          if (declaredLength > MAX_STREAMED_SOURCE_BYTES) {
            await response.body.cancel().catch(() => {})
            throw new Error(
              `Content-Length ${declaredLength} exceeds maximum allowed ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`,
            )
          }
          if (declaredLength > descriptor.sourceByteSize) {
            await response.body.cancel().catch(() => {})
            throw new Error(
              `Content-Length ${declaredLength} exceeds authoritative corpus size ${descriptor.sourceByteSize}`,
            )
          }
        }
      }

      // 6. Streaming verification and disk write
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
      let bytesReceived = 0
      let lastProgressTime = 0

      notifyProgress(options?.onProgress, {
        phase: 'downloading',
        bytesProcessed: 0,
        totalBytes: descriptor.sourceByteSize,
      })

      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {})
          throw createAbortError(signal.reason)
        }

        const { done, value } = await reader.read()
        if (done) break

        if (!value || value.byteLength === 0) continue

        bytesReceived += value.byteLength

        // 1. Independent hard security ceiling check
        if (bytesReceived > MAX_STREAMED_SOURCE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error(
            `Streamed bytes ${bytesReceived} exceeded absolute security ceiling of ${MAX_STREAMED_SOURCE_BYTES} bytes (80 MiB)`,
          )
        }

        // 2. Exact expected byte integrity check
        if (bytesReceived > descriptor.sourceByteSize) {
          await reader.cancel().catch(() => {})
          throw new Error(
            `Streamed bytes ${bytesReceived} exceeded authoritative corpus size ${descriptor.sourceByteSize}`,
          )
        }

        // Handle partial writes safely
        let writeOffset = 0
        while (writeOffset < value.byteLength) {
          const { bytesWritten } = await fileHandle.write(
            value,
            writeOffset,
            value.byteLength - writeOffset,
          )
          writeOffset += bytesWritten
        }

        hash.update(value)
        utf8Decoder.decode(value, { stream: true })

        const now = Date.now()
        if (now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL_MS) {
          lastProgressTime = now
          notifyProgress(options?.onProgress, {
            phase: 'downloading',
            bytesProcessed: bytesReceived,
            totalBytes: descriptor.sourceByteSize,
          })
        }
      }

      // Publication Gate 1: After EOF (stream fully read)
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      if (bytesReceived !== descriptor.sourceByteSize) {
        throw new Error(
          `Truncated download: expected exactly ${descriptor.sourceByteSize} bytes, received ${bytesReceived}`,
        )
      }

      notifyProgress(options?.onProgress, {
        phase: 'verifying',
        bytesProcessed: bytesReceived,
        totalBytes: descriptor.sourceByteSize,
      })

      // Publication Gate 2: Immediately after notifying 'verifying' phase
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      // Fatal UTF-8 final sequence flush
      utf8Decoder.decode()

      // SHA-256 digest verification
      const digest = hash.digest('hex').toLowerCase()
      if (digest !== descriptor.sourceSha256) {
        throw new Error(
          `SHA-256 integrity verification failed: expected ${descriptor.sourceSha256}, calculated ${digest}`,
        )
      }

      // Publication Gate 3: After verification stage / before sync
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      // Explicit flush and close before rename publish
      await fileHandle.sync()

      // Publication Gate 4: After sync / before close
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      await fileHandle.close()
      fileHandleClosed = true

      // Publication Gate 5: After sync+close / immediately before rename publication
      if (signal?.aborted) {
        throw createAbortError(signal.reason)
      }

      // 7. Atomic publication via same-directory rename commit
      try {
        await rename(partPath, finalCachePath)
        downloadCompletedSuccessfully = true
      } catch (renameError) {
        // Concurrency race: check if another concurrent attempt published the valid source
        const converged = await verifyCachedEcdictSource(
          finalCachePath,
          { byteSize: descriptor.sourceByteSize, sha256: descriptor.sourceSha256 },
        )
        if (converged) {
          notifyProgress(options?.onProgress, {
            phase: 'complete',
            bytesProcessed: descriptor.sourceByteSize,
            totalBytes: descriptor.sourceByteSize,
          })
          return Object.freeze({
            path: finalCachePath,
            sourceCommit: descriptor.sourceCommit,
            sha256: descriptor.sourceSha256,
            byteSize: descriptor.sourceByteSize,
            reused: true,
            redirectCount,
          })
        }
        throw renameError
      }

      notifyProgress(options?.onProgress, {
        phase: 'complete',
        bytesProcessed: descriptor.sourceByteSize,
        totalBytes: descriptor.sourceByteSize,
      })

      return Object.freeze({
        path: finalCachePath,
        sourceCommit: descriptor.sourceCommit,
        sha256: descriptor.sourceSha256,
        byteSize: descriptor.sourceByteSize,
        reused: false,
        redirectCount,
      })
    } finally {
      if (!fileHandleClosed) {
        try {
          await fileHandle.close()
        } catch {
          // ignore handle close error
        }
      }
      if (!downloadCompletedSuccessfully) {
        try {
          await unlink(partPath)
        } catch {
          // ignore unlink error
        }
      }
    }
  } finally {
    activeDownloads.delete(finalCachePath)
  }
}
