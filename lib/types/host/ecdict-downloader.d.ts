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
import { type EcdictSourceDescriptor } from './ecdict-source.js';
import type { ManagedStoragePaths } from './managed-storage.js';
/** Maximum permitted redirects before failing closed. */
export declare const MAX_REDIRECTS = 3;
/**
 * Independent hard security ceiling on any streamed source bytes (80 MiB = 83,886,080 bytes).
 * Enforced unconditionally chunk-by-chunk during network retrieval to prevent resource exhaustion
 * and runaway/infinite streams, completely independent of expected integrity byte size.
 */
export declare const MAX_STREAMED_SOURCE_BYTES: number;
/**
 * Error thrown when a concurrent download for the same destination is already in flight in the current process.
 */
export declare class EcdictDownloadInProgressError extends Error {
    /** Target cache destination path. */
    readonly destinationPath: string;
    constructor(destinationPath: string);
}
/**
 * Progress lifecycle phases for ECDICT source verification and download.
 */
export type EcdictDownloadProgressPhase = 'checking-cache' | 'downloading' | 'verifying' | 'complete';
/**
 * Immutable progress event emitted to observers during download lifecycle.
 */
export interface EcdictDownloadProgress {
    /** Current operation phase. */
    readonly phase: EcdictDownloadProgressPhase;
    /** Number of bytes processed or downloaded so far. */
    readonly bytesProcessed: number;
    /** Expected total byte size of the source corpus. */
    readonly totalBytes: number;
}
/**
 * Callback function type for download progress updates.
 */
export type EcdictDownloadProgressCallback = (progress: EcdictDownloadProgress) => void;
/**
 * Immutable outcome descriptor returned upon successful verification or download.
 */
export interface EcdictDownloadResult {
    /** Normalized absolute path to the verified source file on disk (`ecdict.csv`). */
    readonly path: string;
    /** Git commit hash of the verified corpus source. */
    readonly sourceCommit: string;
    /** Verified 64-character lowercase SHA-256 digest. */
    readonly sha256: string;
    /** Verified exact byte size. */
    readonly byteSize: number;
    /** Whether an existing valid cache was reused without network download. */
    readonly reused: boolean;
    /** Number of HTTP redirects observed during network retrieval (0 if reused). */
    readonly redirectCount: number;
}
/**
 * Options for production-facing {@link downloadPinnedEcdict}.
 *
 * Production callers can only provide cancellation signals and progress observers.
 * Production callers cannot override source URL, commit, hash, byte size, fetch, or UUID generation.
 */
export interface DownloadPinnedEcdictOptions {
    /** Cancellation signal. */
    readonly signal?: AbortSignal;
    /** Optional observer callback for download progress. */
    readonly onProgress?: EcdictDownloadProgressCallback;
}
/**
 * @internal Test-only seams for exercising streaming verification, failure modes, and edge cases.
 * Strictly forbidden from package root exports and production callers.
 */
export interface DownloadPinnedEcdictInternalOptions {
    /** Cancellation signal. */
    readonly signal?: AbortSignal;
    /** Optional observer callback for download progress. */
    readonly onProgress?: EcdictDownloadProgressCallback;
    /** @internal Test-only seam to override fetch implementation. */
    readonly fetch?: typeof globalThis.fetch;
    /** @internal Test-only seam to override UUID factory. */
    readonly generateId?: () => string;
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
export declare function hasEmbeddedUserInfo(url: URL): boolean;
/**
 * Strict Content-Length header parser.
 *
 * Rejects non-digits (e.g. "123garbage"), negative numbers, non-integers,
 * and unsafe integers. Returns null if header is not present.
 */
export declare function parseContentLengthHeader(headerValue: string | null): number | null;
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
export declare function verifyCachedEcdictSource(filePath: string, expected: {
    byteSize: number;
    sha256: string;
}, options?: {
    signal?: AbortSignal;
    onProgress?: EcdictDownloadProgressCallback;
}): Promise<boolean>;
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
export declare function downloadPinnedEcdict(paths: ManagedStoragePaths, options?: DownloadPinnedEcdictOptions): Promise<EcdictDownloadResult>;
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
export declare function downloadPinnedEcdictInternal(paths: ManagedStoragePaths, descriptor: EcdictSourceDescriptor, options?: DownloadPinnedEcdictInternalOptions): Promise<EcdictDownloadResult>;
