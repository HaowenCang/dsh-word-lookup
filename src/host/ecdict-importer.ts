/**
 * Runtime streaming ECDICT corpus importer for DeepSeek Harness (DSH).
 *
 * Implements Phase 7A.5 runtime-safe streaming import lifecycle:
 * - Fail-closed cached source preflight verification before any database mutation.
 * - Same-process concurrency gating via {@link EcdictImportInProgressError}.
 * - Unique versioned managed candidate database creation (`ecdict-<identity>.sqlite3.tmp-<uuid>`).
 * - Streaming RFC 4180 CSV parsing with fatal UTF-8 decoding (no whole-file buffering).
 * - TOCTOU stream verification: streaming SHA-256 and byte count computed on raw consumed chunks.
 * - Morphological inflection extraction via {@link ExchangeCollector} with deterministic resolution.
 * - Bounded row batching and cooperative event-loop yielding to guarantee host responsiveness.
 * - Streaming row-by-row logical database SHA-256 computation via `StatementSync.iterate()`.
 * - Full PRAGMA integrity verification, read-only product opening, and canonical probe validation.
 * - Explicit candidate file sync (`FileHandle.sync()`) before atomic same-directory publication.
 * - Cancellation support via standard `AbortSignal` with clean candidate and sidecar cleanup.
 * - Isolated progress callback seam shielding caller exceptions.
 *
 * Invariants:
 * - Zero network access: this importer operates strictly on local verified cached source artifacts.
 * - Does NOT write `active.json` or activate the database in `DictionaryManager`.
 * - Host startup remains fixture-only.
 * - Zero external runtime dependencies (Node.js 24 `crypto`, `fs`, `path`, `sqlite`).
 *
 * @module dsh-word-lookup/host/ecdict-importer
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  captureCandidateFileIdentity,
  extractWorkerTerminationInfo,
  isTerminationUnconfirmed,
  matchesCandidateFileIdentity,
  QuarantineRecoveryError,
  verifyCandidateDatabaseWithWorker,
  workerSupervisor,
  type CandidateFileIdentity,
  type IntegrityRequest,
  type IntegrityVerificationResult,
  type WorkerExitProof,
  type WorkerLike,
} from './ecdict-integrity-verifier.js'
import { openProductionDictionary } from './corpus-db.js'
import { StreamingCsvParser } from './csv-parser.js'
import { loadPinnedEcdictSourceDescriptor, type EcdictSourceDescriptor } from './ecdict-source.js'
import { verifyCachedEcdictSource } from './ecdict-downloader.js'
import { ExchangeCollector } from './exchange-parser.js'
import {
  managedDatabaseFileName,
  managedDatabasePath,
  SAFE_IDENTITY_PATTERN,
  validateCandidateDatabasePath,
  type ManagedStoragePaths,
} from './managed-storage.js'
import type { SqliteDictionary } from './sqlite-dictionary.js'

/** Maximum permitted length of a headword. */
export const MAX_WORD_LENGTH = 128

/** Maximum permitted length of any individual CSV field. */
export const MAX_FIELD_LENGTH = 65536

/** Default transaction commit batch size for bulk insertion. */
export const DEFAULT_BATCH_SIZE = 2500

/** Default interval of processed rows between cooperative event loop yields. */
export const DEFAULT_YIELD_ROW_INTERVAL = 2500

/** Authoritative 13-column ECDICT CSV header schema in exact order. */
export const EXPECTED_CORPUS_HEADER = Object.freeze([
  'word',
  'phonetic',
  'definition',
  'translation',
  'pos',
  'collins',
  'oxford',
  'tag',
  'bnc',
  'frq',
  'exchange',
  'detail',
  'audio',
])

/** Authoritative probe words required to be found in verified candidate databases. */
export const REQUIRED_PROBE_WORDS = Object.freeze([
  'go',
  'went',
  'gone',
  'tooth',
  'teeth',
  'derive',
  'derived',
  'conservation',
  'wave',
  'function',
  'wave function',
])

/** Canonical morphological mappings verified via headword form relationships. */
export const CANONICAL_FORM_RELATIONSHIPS = Object.freeze([
  { headword: 'go', expectedForms: ['went', 'gone'] },
  { headword: 'tooth', expectedForms: ['teeth'] },
  { headword: 'derive', expectedForms: ['derived'] },
])

/**
 * Error thrown when an ECDICT import is already in progress for the target database directory.
 */
export class EcdictImportInProgressError extends Error {
  /** Database directory for which import is locked. */
  readonly databaseDirectory: string

  constructor(databaseDirectory: string) {
    super(`ECDICT import already in progress for database directory: ${databaseDirectory}`)
    this.name = 'EcdictImportInProgressError'
    this.databaseDirectory = databaseDirectory
  }
}

/**
 * Record describing a database directory quarantined due to unconfirmed worker termination.
 */
export interface QuarantineRecord {
  /** Quarantined database directory. */
  readonly directory: string
  /** Candidate path that was being checked when termination failed. */
  readonly candidatePath: string
  /** Timestamp when quarantine was engaged. */
  readonly quarantinedAt: number
  /** Reason for quarantine. */
  readonly reason: string
  /** Underlying error that caused unconfirmed termination. */
  readonly error: unknown
  /** Tracked worker ID associated with the quarantine, if any. */
  readonly workerId?: string
  /** Captured candidate file identity at quarantine time. */
  readonly candidateFileIdentity?: CandidateFileIdentity | null
  /** Validated worker exit proof confirming termination, if already proven. */
  readonly exitProof?: WorkerExitProof | null
}

/**
 * Error thrown when an ECDICT import is attempted on a quarantined database directory.
 */
export class EcdictImportQuarantinedError extends EcdictImportInProgressError {
  /** Candidate path associated with the quarantine. */
  readonly candidatePath: string
  /** Reason for quarantine. */
  readonly reason: string

  constructor(databaseDirectory: string, reason: string, candidatePath: string) {
    super(databaseDirectory)
    this.name = 'EcdictImportQuarantinedError'
    this.reason = reason
    this.candidatePath = candidatePath
    this.message = `ECDICT import directory is quarantined due to unconfirmed worker termination: "${databaseDirectory}" (candidate: "${candidatePath}"). Reason: ${reason}`
  }
}

/**
 * Progress lifecycle phases during database construction.
 */
export type EcdictImportProgressPhase =
  | 'verifying-source'
  | 'preflighting'
  | 'importing-entries'
  | 'resolving-forms'
  | 'inserting-forms'
  | 'indexing'
  | 'validating'
  | 'publishing'
  | 'complete'

/**
 * Immutable progress event emitted to observers during import.
 */
export interface EcdictImportProgress {
  /** Current operation phase. */
  readonly phase: EcdictImportProgressPhase
  /** Number of entries/items processed in this phase, if applicable. */
  readonly processed?: number
  /** Total number of entries/items expected in this phase, if applicable. */
  readonly total?: number
  /** Number of source raw bytes processed so far. */
  readonly sourceBytesProcessed?: number
  /** Expected total source byte size. */
  readonly sourceBytesTotal?: number
}

/**
 * Callback function type for import progress updates.
 */
export type EcdictImportProgressCallback = (progress: EcdictImportProgress) => void

/**
 * Outcome of post-publication candidate file and sidecar cleanup.
 */
export interface PostPublicationCleanupResult {
  /** Whether own candidate database file was confirmed unlinked and absent from disk. */
  readonly candidateRemoved: boolean
  /** Whether all candidate sidecars were confirmed absent or unlinked from disk. */
  readonly sidecarsRemoved: boolean
  /** System error code if unlinking failed (e.g. `EPERM`, `EACCES`, `EBUSY`). */
  readonly errorCode?: string
}

/**
 * Immutable build outcome descriptor returned upon successful managed database publication.
 */
export interface ManagedEcdictBuildResult {
  /** Safe identity token matching database filename. */
  readonly identity: string
  /** Normalized absolute path to the published SQLite database file. */
  readonly path: string
  /** Basename only of the database file (`ecdict-<identity>.sqlite3`). */
  readonly databaseFile: string
  /** Authoritative Git commit hash of the imported source. */
  readonly sourceCommit: string
  /** Verified SHA-256 digest of the raw source bytes consumed by the parser. */
  readonly sourceSha256: string
  /** Database schema version. */
  readonly schemaVersion: number
  /** Count of valid headword entries imported into `entries` table. */
  readonly entryCount: number
  /** Count of unambiguous morphological forms imported into `forms` table. */
  readonly formCount: number
  /** Count of examples imported into `examples` table (0 for ECDICT). */
  readonly exampleCount: number
  /** Count of excluded ambiguous morphological forms colliding across headwords. */
  readonly ambiguousFormCount: number
  /** Count of rejected rows during CSV parsing. */
  readonly rejectedRowCount: number
  /** Count of all source CSV rows processed (valid + rejected). */
  readonly sourceRowCount: number
  /** Logical database SHA-256 digest computed across ordered tables. */
  readonly logicalSha256: string
  /** Physical SQLite file SHA-256 digest. */
  readonly fileSha256: string
  /** Physical SQLite database byte size on disk. */
  readonly byteSize: number
  /** Number of cooperative event-loop yields executed during the build. */
  readonly yieldCount: number
  /** Duration in milliseconds of synchronous PRAGMA integrity_check verification. */
  readonly integrityCheckDurationMs?: number
  /** Detailed timing breakdown per build phase in milliseconds. */
  readonly phaseTimings?: Readonly<Record<string, number>>
  /** Post-publication candidate temporary file and sidecars cleanup outcome. */
  readonly postPublicationCleanup: PostPublicationCleanupResult
}

/**
 * Options for production {@link buildManagedEcdictDatabase}.
 */
export interface BuildManagedEcdictDatabaseOptions {
  /** Cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional observer callback for import progress. */
  readonly onProgress?: EcdictImportProgressCallback
}

/**
 * @internal Test-only options for internal importer core.
 * Strictly forbidden from package root exports (`src/index.ts`).
 */
export interface BuildManagedEcdictDatabaseInternalOptions {
  /** Cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional observer callback for import progress. */
  readonly onProgress?: EcdictImportProgressCallback
  /** @internal Custom source path override (test only). */
  readonly sourcePath?: string
  /** @internal Custom source descriptor override (test only). */
  readonly descriptor?: EcdictSourceDescriptor
  /** @internal Custom batch size (test only). */
  readonly batchSize?: number
  /** @internal Custom yield row interval (test only). */
  readonly yieldInterval?: number
  /** @internal Custom nonce generator for identity (test only). */
  readonly generateNonce?: () => string
  /** @internal Custom candidate ID generator (test only). */
  readonly generateCandidateId?: () => string
  /** @internal Whether to execute standard probe lookups (defaults to true; set false for synthetic small tests). */
  readonly verifyProbes?: boolean
  /** @internal Custom SQLite factory hook (test only). */
  readonly sqliteFactory?: (path: string) => DatabaseSync
  /** @internal Custom yield function hook (test only). */
  readonly yieldFn?: () => Promise<void>
  /** @internal Custom candidate unlink hook for cleanup error testing (test only). */
  readonly unlinkFn?: (path: string) => Promise<void>
  /** @internal Custom integrity verifier hook (test only). */
  readonly integrityVerifier?: (
    candidatePath: string,
    signal?: AbortSignal,
  ) => Promise<IntegrityVerificationResult>
  /** @internal Custom worker URL for fault-injection testing (test only). */
  readonly workerUrl?: URL
  /** @internal Custom worker adapter for deterministic lifecycle testing (test only). */
  readonly workerAdapter?: (request: IntegrityRequest) => WorkerLike
  /** @internal Custom termination timeout in milliseconds (test only). */
  readonly terminationTimeoutMs?: number
}

/** Set of normalized database directories currently being built in this process. */
const activeImports = new Set<string>()

/** Map of in-progress recovery operations per normalized database directory. */
const activeRecoveries = new Map<
  string,
  Promise<RecoverQuarantinedDirectoryResult>
>()

/** Map of normalized database directories quarantined due to unconfirmed worker termination. */
const quarantinedDirectories = new Map<string, QuarantineRecord>()

/**
 * Check whether a database directory is currently quarantined.
 */
export function isDatabaseDirectoryQuarantined(databaseDirectory: string): boolean {
  return quarantinedDirectories.has(resolve(databaseDirectory))
}

/**
 * Check whether a quarantine recovery is currently active for a database directory.
 */
export function isRecoveryInProgress(databaseDirectory: string): boolean {
  return activeRecoveries.has(resolve(databaseDirectory))
}

/**
 * Get active quarantine record for a database directory, if any.
 */
export function getQuarantineRecord(databaseDirectory: string): QuarantineRecord | null {
  return quarantinedDirectories.get(resolve(databaseDirectory)) ?? null
}

/**
 * Options for recovering a quarantined database directory.
 */
export interface RecoverQuarantinedDirectoryOptions {
  /** Optional custom unlink function for testing file deletion errors. */
  readonly unlinkFn?: (path: string) => Promise<void>
  /** Optional wait timeout in milliseconds to await worker exit proof. */
  readonly timeoutMs?: number
  /** Optional explicit worker exit proof object. */
  readonly exitProof?: WorkerExitProof
}

/**
 * Result of quarantine recovery attempt.
 */
export interface RecoverQuarantinedDirectoryResult {
  readonly recovered: boolean
  readonly candidateCleaned: boolean
  readonly exitProof?: WorkerExitProof
}

/**
 * Verify termination and safely recover a quarantined database directory.
 *
 * Requirements for safe release (Strict Proof-First Invariant):
 * 1. Checks that the directory is currently quarantined.
 * 2. Confirms authentic worker exit proof before any file modification or quarantine release:
 *    - Worker exit event confirmed, OR
 *    - terminate() Promise settled with confirmed exit.
 *    - Unconfirmed worker status REFUSES recovery and PRESERVES quarantine and candidate.
 * 3. Validates candidate database path containment within the database directory.
 * 4. Validates candidate database file identity against captured quarantine signature
 *    to prevent deleting substituted or foreign files.
 * 5. Cleans up candidate file and sidecars using safe cleanup contracts.
 * 6. Only releases directory from quarantine after cleanup reaches safe state.
 *
 * @param databaseDirectory - database directory to recover.
 * @param options - optional recovery options.
 * @returns outcome of recovery attempt.
 */
export async function recoverQuarantinedDirectory(
  databaseDirectory: string,
  options?: RecoverQuarantinedDirectoryOptions,
): Promise<RecoverQuarantinedDirectoryResult> {
  const normalized = resolve(databaseDirectory)

  // 1. Concurrency deduplication: if recovery is already in progress, await the same promise
  const inFlight = activeRecoveries.get(normalized)
  if (inFlight) {
    return inFlight
  }

  const recoveryPromise = (async (): Promise<RecoverQuarantinedDirectoryResult> => {
    const record = quarantinedDirectories.get(normalized)
    if (!record) {
      return { recovered: false, candidateCleaned: false }
    }

    // 2. Strict Worker Exit Proof Verification
    let confirmedProof: WorkerExitProof | null = null

    if (options?.exitProof) {
      const p = options.exitProof
      if (typeof p !== 'object' || !p.workerId || typeof p.exitCode !== 'number') {
        throw new QuarantineRecoveryError(
          'Supplied exitProof is invalid or malformed',
          'INVALID_EXIT_PROOF',
          normalized,
          record.candidatePath,
          record.workerId,
          { candidateFileIdentity: record.candidateFileIdentity },
        )
      }
      if (record.workerId && p.workerId !== record.workerId) {
        throw new QuarantineRecoveryError(
          `Supplied exitProof workerId "${p.workerId}" does not match quarantined workerId "${record.workerId}"`,
          'WORKER_ID_MISMATCH',
          normalized,
          record.candidatePath,
          record.workerId,
          { candidateFileIdentity: record.candidateFileIdentity },
        )
      }
      const supProof = workerSupervisor.getExitProof(p.workerId)
      if (!supProof) {
        throw new QuarantineRecoveryError(
          `Supplied exitProof cannot be validated against worker supervisor records for workerId "${p.workerId}"`,
          'UNVERIFIED_EXIT_PROOF',
          normalized,
          record.candidatePath,
          record.workerId,
          { candidateFileIdentity: record.candidateFileIdentity },
        )
      }
      confirmedProof = supProof
    } else if (record.workerId) {
      let supProof = workerSupervisor.getExitProof(record.workerId)
      if (!supProof && options?.timeoutMs && options.timeoutMs > 0) {
        try {
          supProof = await workerSupervisor.waitForExit(record.workerId, options.timeoutMs)
        } catch {
          supProof = null
        }
      }
      if (!supProof) {
        throw new QuarantineRecoveryError(
          `Worker exit proof not confirmed for worker "${record.workerId}". Worker may still be alive with open file handles.`,
          'WORKER_EXIT_UNCONFIRMED',
          normalized,
          record.candidatePath,
          record.workerId,
          { candidateFileIdentity: record.candidateFileIdentity },
        )
      }
      confirmedProof = supProof
    } else {
      throw new QuarantineRecoveryError(
        'Quarantined directory cannot be recovered: no verifiable worker tracking record associated with quarantine',
        'WORKER_EXIT_UNCONFIRMED',
        normalized,
        record.candidatePath,
        undefined,
        { candidateFileIdentity: record.candidateFileIdentity },
      )
    }

    // 3. Verify Candidate Path Containment
    await validateCandidateDatabasePath(record.candidatePath, normalized)

    // 4. Verify Candidate File Identity and Cleanup
    let candidateCleaned = false
    if (existsSync(record.candidatePath)) {
      const currentStat = statSync(record.candidatePath)
      if (record.candidateFileIdentity) {
        if (!matchesCandidateFileIdentity(currentStat, record.candidateFileIdentity)) {
          throw new QuarantineRecoveryError(
            `Candidate file identity mismatch for "${record.candidatePath}": file on disk differs from quarantined candidate (possible foreign replacement)`,
            'CANDIDATE_FILE_IDENTITY_MISMATCH',
            normalized,
            record.candidatePath,
            record.workerId,
            { candidateFileIdentity: record.candidateFileIdentity },
          )
        }
      }

      // 5. Clean up candidate file and sidecars
      await cleanupCandidateArtifacts(record.candidatePath, options?.unlinkFn)
      candidateCleaned = true
    } else {
      await cleanupCandidateSidecars(record.candidatePath, options?.unlinkFn)
    }

    // 6. Release directory from quarantine upon successful cleanup
    quarantinedDirectories.delete(normalized)
    return { recovered: true, candidateCleaned, exitProof: confirmedProof }
  })()

  activeRecoveries.set(normalized, recoveryPromise)
  try {
    return await recoveryPromise
  } finally {
    activeRecoveries.delete(normalized)
  }
}

/**
 * @internal Reset active imports, recoveries, and quarantined directories (test only).
 */
export function _resetQuarantinesForTesting(): void {
  quarantinedDirectories.clear()
  activeImports.clear()
  activeRecoveries.clear()
  workerSupervisor.resetForTesting()
}

/**
 * Yield control to the Node.js event loop via `setImmediate`.
 */
function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

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
      // ignore
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
 * Check abort signal and throw standard AbortError if triggered.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
}

/**
 * Safely notify progress callback, isolating observer exceptions.
 */
function notifyProgress(
  callback: EcdictImportProgressCallback | undefined,
  progress: EcdictImportProgress,
): void {
  if (!callback) return
  try {
    callback(progress)
  } catch {
    // Observer exceptions shielded
  }
}

/**
 * Clean up candidate database file and its SQLite sidecars.
 * Only ENOENT may be ignored; other filesystem errors must be reported.
 */
async function cleanupCandidateArtifacts(
  candidatePath: string,
  unlinkFn: (path: string) => Promise<void> = unlink,
): Promise<void> {
  const suffixes = ['', '-journal', '-wal', '-shm']
  const errors: unknown[] = []
  for (const suffix of suffixes) {
    try {
      await unlinkFn(candidatePath + suffix)
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        errors.push(err)
      }
    }
  }
  if (errors.length > 0) {
    if (errors.length === 1) {
      throw errors[0]
    }
    throw new AggregateError(errors, `Failed to clean up candidate artifacts for ${candidatePath}`)
  }
}

/**
 * Clean up candidate SQLite sidecars when candidate file is absent.
 */
async function cleanupCandidateSidecars(
  candidatePath: string,
  unlinkFn: (path: string) => Promise<void> = unlink,
): Promise<void> {
  const suffixes = ['-journal', '-wal', '-shm']
  const errors: unknown[] = []
  for (const suffix of suffixes) {
    try {
      await unlinkFn(candidatePath + suffix)
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        errors.push(err)
      }
    }
  }
  if (errors.length > 0) {
    if (errors.length === 1) {
      throw errors[0]
    }
    throw new AggregateError(errors, `Failed to clean up candidate sidecars for ${candidatePath}`)
  }
}

/**
 * Compute SHA-256 digest of a file on disk via streaming.
 */
async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex').toLowerCase()
}

/**
 * Generate a deterministic versioned safe managed database identity string.
 *
 * Format: `s<schemaVersion>-<commitPrefix12>-<shaPrefix12>-<nonce12>`
 * Matches {@link SAFE_IDENTITY_PATTERN}.
 */
export function generateManagedDatabaseIdentity(
  schemaVersion: number,
  sourceCommit: string,
  sourceSha256: string,
  nonce?: string,
): string {
  const commitPrefix = sourceCommit.trim().slice(0, 12).toLowerCase()
  const shaPrefix = sourceSha256.trim().slice(0, 12).toLowerCase()
  const randomSuffix = (nonce ?? randomUUID().replace(/-/g, '')).trim().slice(0, 12).toLowerCase()
  const identity = `s${schemaVersion}-${commitPrefix}-${shaPrefix}-${randomSuffix}`

  if (!SAFE_IDENTITY_PATTERN.test(identity)) {
    throw new Error(`Generated managed database identity "${identity}" violates safe identity pattern`)
  }

  return identity
}

/**
 * Execute standard validation probes against an opened SQLite dictionary candidate.
 *
 * Verifies exact headwords, case-insensitivity, inflected forms, and unknown word misses.
 *
 * @param dictionary - opened {@link SqliteDictionary}.
 */
export function verifyCandidateProbes(dictionary: SqliteDictionary): void {
  for (const word of REQUIRED_PROBE_WORDS) {
    const res = dictionary.lookup(word)
    if (!res.found) {
      throw new Error(`Candidate probe failed for probe word "${word}": word not found`)
    }
  }

  // Exact canonical precedence for "wave"
  const wave = dictionary.lookup('wave')
  if (!wave.found || wave.headword !== 'wave' || wave.matchedForm !== null) {
    throw new Error('Candidate probe failed for exact canonical precedence: "wave"')
  }

  // Case-insensitive exact probe
  const wf = dictionary.lookup('Wave Function')
  if (!wf.found || wf.headword.toLowerCase() !== 'wave function') {
    throw new Error('Candidate probe failed for case-insensitive headword "Wave Function"')
  }

  // Morphological mapping verification: canonical headwords must link to their expected forms
  for (const { headword, expectedForms } of CANONICAL_FORM_RELATIONSHIPS) {
    const res = dictionary.lookup(headword)
    if (!res.found) {
      throw new Error(`Candidate probe failed for canonical headword "${headword}": not found`)
    }
    const observedForms = new Set(res.forms.map((f) => f.form.toLowerCase()))
    for (const expectedForm of expectedForms) {
      if (!observedForms.has(expectedForm.toLowerCase())) {
        throw new Error(
          `Candidate probe failed for "${headword}": expected morphological form "${expectedForm}" not linked`,
        )
      }
    }
  }

  // Miss probe
  const miss = dictionary.lookup('nonexistentword123456789xyz')
  if (miss.found) {
    throw new Error('Candidate probe failed for non-existent word: expected miss')
  }
}

/**
 * Build a verified, versioned managed ECDICT SQLite database from the cached source artifact.
 *
 * Production entrypoint:
 * - Automatically loads authoritative pinned `corpus/ecdict.manifest.json`.
 * - Resolves cached source artifact `<home>/cache/dsh-word-lookup/sources/ecdict.csv`.
 * - Strictly verifies source preflight and actual import-pass TOCTOU digests.
 * - Compiles entries, forms, and indexes in managed candidate database.
 * - Validates schema, metadata, PRAGMA integrity, and read-only dictionary probes.
 * - Atomically publishes immutable `ecdict-<identity>.sqlite3` database artifact.
 * - Does NOT mutate `active.json` or activate the database in `DictionaryManager`.
 *
 * @param paths - resolved managed storage paths.
 * @param options - optional cancellation signal and progress observer.
 * @returns frozen {@link ManagedEcdictBuildResult}.
 */
export async function buildManagedEcdictDatabase(
  paths: ManagedStoragePaths,
  options?: BuildManagedEcdictDatabaseOptions,
): Promise<ManagedEcdictBuildResult> {
  return buildManagedEcdictDatabaseInternal(paths, {
    signal: options?.signal,
    onProgress: options?.onProgress,
  })
}

/**
 * @internal Test-only internal importer core allowing descriptors and test seams.
 * Strictly forbidden from package root exports (`src/index.ts`).
 */
export async function buildManagedEcdictDatabaseInternal(
  paths: ManagedStoragePaths,
  options?: BuildManagedEcdictDatabaseInternalOptions,
): Promise<ManagedEcdictBuildResult> {
  const signal = options?.signal
  checkAbort(signal)

  const descriptor = options?.descriptor ?? loadPinnedEcdictSourceDescriptor()
  const sourcePath = options?.sourcePath ?? join(paths.sourceCacheDirectory, 'ecdict.csv')
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const yieldInterval = options?.yieldInterval ?? DEFAULT_YIELD_ROW_INTERVAL
  let yieldCount = 0
  const baseYieldToEventLoop = options?.yieldFn ?? defaultYieldToEventLoop
  const yieldToEventLoop = async (): Promise<void> => {
    yieldCount++
    await baseYieldToEventLoop()
  }
  const verifyProbes = options?.verifyProbes !== false

  // 1. Same-process concurrency guard & quarantine check
  const normalizedDbDir = resolve(paths.databaseDirectory)
  if (activeImports.has(normalizedDbDir)) {
    throw new EcdictImportInProgressError(normalizedDbDir)
  }
  if (quarantinedDirectories.has(normalizedDbDir)) {
    const record = quarantinedDirectories.get(normalizedDbDir)!
    throw new EcdictImportQuarantinedError(normalizedDbDir, record.reason, record.candidatePath)
  }
  if (activeRecoveries.has(normalizedDbDir)) {
    throw new EcdictImportQuarantinedError(
      normalizedDbDir,
      'Recovery is currently in progress for quarantined directory',
      '',
    )
  }
  activeImports.add(normalizedDbDir)

  let candidatePath: string | null = null
  let db: DatabaseSync | null = null
  let dbOpen = false
  let inTx = false
  let published = false
  const phaseTimings: Record<string, number> = {}

  try {
    // 2. Preflight source verification BEFORE any database mutation or candidate creation
    notifyProgress(options?.onProgress, {
      phase: 'verifying-source',
      sourceBytesProcessed: 0,
      sourceBytesTotal: descriptor.sourceByteSize,
    })

    const sourceValid = await verifyCachedEcdictSource(
      sourcePath,
      { byteSize: descriptor.sourceByteSize, sha256: descriptor.sourceSha256 },
      { signal },
    )

    if (!sourceValid) {
      throw new Error(`ECDICT cached source file missing or failed verification at: ${sourcePath}`)
    }

    checkAbort(signal)

    // 3. Prepare database directory and generate safe unique candidate layout
    notifyProgress(options?.onProgress, { phase: 'preflighting' })
    await mkdir(paths.databaseDirectory, { recursive: true })

    const identity = generateManagedDatabaseIdentity(
      descriptor.schemaVersion,
      descriptor.sourceCommit,
      descriptor.sourceSha256,
      options?.generateNonce?.(),
    )
    const finalFileName = managedDatabaseFileName(identity)
    const finalPath = managedDatabasePath(paths, identity)

    if (existsSync(finalPath)) {
      throw new Error(`Managed database already exists at destination: ${finalPath}`)
    }

    const candidateIdGen = options?.generateCandidateId ?? (() => randomUUID())
    let candidateOwned = false
    let candidatePathChosen = ''

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidateId = candidateIdGen()
      const candidateFileName = `${finalFileName}.tmp-${candidateId}`
      const proposedPath = join(paths.databaseDirectory, candidateFileName)

      try {
        const reservation = await open(proposedPath, 'wx')
        await reservation.close()
        candidatePathChosen = proposedPath
        candidateOwned = true
        break
      } catch (err: any) {
        if (err?.code === 'EEXIST') {
          if (options?.generateCandidateId) {
            throw new Error(`Candidate file reservation collision (EEXIST) for path: ${proposedPath}`)
          }
          continue
        }
        throw err
      }
    }

    if (!candidateOwned) {
      throw new Error('Failed to acquire exclusive candidate file reservation after retries')
    }

    await validateCandidateDatabasePath(candidatePathChosen, paths.databaseDirectory)
    candidatePath = candidatePathChosen
    checkAbort(signal)

    // 4. Create SQLite candidate database and schemas
    const sqliteFactory = options?.sqliteFactory ?? ((p: string) => new DatabaseSync(p))
    db = sqliteFactory(candidatePath)
    dbOpen = true

    db.exec('PRAGMA page_size = 4096')
    db.exec('PRAGMA cache_size = -64000')
    db.exec('PRAGMA journal_mode = MEMORY')
    db.exec('PRAGMA synchronous = OFF')
    db.exec('PRAGMA temp_store = MEMORY')
    db.exec('PRAGMA mmap_size = 268435456')

    db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE entries (
        word           TEXT PRIMARY KEY COLLATE NOCASE,
        phonetic       TEXT,
        definition_en  TEXT,
        translation_zh TEXT,
        pos            TEXT,
        exchange       TEXT,
        frequency      INTEGER
      );

      CREATE TABLE forms (
        form      TEXT PRIMARY KEY COLLATE NOCASE,
        headword  TEXT NOT NULL,
        kind      TEXT
      );

      CREATE TABLE examples (
        id        INTEGER PRIMARY KEY,
        headword  TEXT NOT NULL COLLATE NOCASE,
        english   TEXT NOT NULL,
        chinese   TEXT,
        source    TEXT,
        source_id TEXT,
        score     REAL
      );
    `)

    const insertEntryStmt = db.prepare(`
      INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFormStmt = db.prepare(`
      INSERT INTO forms (form, headword, kind)
      VALUES (?, ?, ?)
    `)

    const insertMetaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')

    function ensureTx(): void {
      if (!inTx) {
        db?.exec('BEGIN TRANSACTION')
        inTx = true
      }
    }

    function commitTx(): void {
      if (inTx) {
        db?.exec('COMMIT')
        inTx = false
      }
    }

    // 5. Streaming CSV parsing with simultaneous TOCTOU hash and count verification
    notifyProgress(options?.onProgress, {
      phase: 'importing-entries',
      processed: 0,
      sourceBytesProcessed: 0,
      sourceBytesTotal: descriptor.sourceByteSize,
    })

    const sourceHash = createHash('sha256')
    let bytesImported = 0
    let validRows = 0
    let rejectedRowsCount = 0
    let headerValidated = false
    let currentBatch = 0
    let exchangeCollector: ExchangeCollector | null = new ExchangeCollector()

    const importStart = Date.now()
    const parser = new StreamingCsvParser((row) => {
      if (!headerValidated) {
        headerValidated = true
        // Strip UTF-8 BOM on first column name if present
        const sanitized = [...row]
        if (sanitized.length > 0 && typeof sanitized[0] === 'string' && sanitized[0].charCodeAt(0) === 0xfeff) {
          sanitized[0] = sanitized[0].slice(1)
        }

        if (sanitized.length !== EXPECTED_CORPUS_HEADER.length) {
          throw new Error(
            `ECDICT CSV header mismatch: expected ${EXPECTED_CORPUS_HEADER.length} columns, got ${sanitized.length}`,
          )
        }

        for (let i = 0; i < EXPECTED_CORPUS_HEADER.length; i++) {
          if (sanitized[i] !== EXPECTED_CORPUS_HEADER[i]) {
            throw new Error(
              `ECDICT CSV header mismatch: column ${i} expected "${EXPECTED_CORPUS_HEADER[i]}", got "${sanitized[i]}"`,
            )
          }
        }
        return
      }

      if (row.length !== EXPECTED_CORPUS_HEADER.length) {
        rejectedRowsCount++
        return
      }

      const [word, phonetic, definition, translation, pos, , , , bnc, , exchange] = row

      if (!word || !word.trim()) {
        rejectedRowsCount++
        return
      }

      const cleanWord = word.trim()
      if (cleanWord.length > MAX_WORD_LENGTH) {
        rejectedRowsCount++
        return
      }

      let fieldOversized = false
      for (let i = 0; i < row.length; i++) {
        const fieldVal = row[i]
        if (fieldVal && fieldVal.length > MAX_FIELD_LENGTH) {
          fieldOversized = true
          break
        }
      }
      if (fieldOversized) {
        rejectedRowsCount++
        return
      }

      const cleanPhonetic = phonetic && phonetic.trim() ? phonetic.trim() : null
      const cleanDef = definition && definition.trim() ? definition.trim() : null
      const cleanTrans = translation && translation.trim() ? translation.trim() : null
      const cleanPos = pos && pos.trim() ? pos.trim() : null
      const cleanExchange = exchange && exchange.trim() ? exchange.trim() : null

      let freqNumber: number | null = null
      if (bnc && bnc.trim()) {
        const parsedBnc = parseInt(bnc.trim(), 10)
        if (!Number.isNaN(parsedBnc) && parsedBnc > 0) {
          freqNumber = parsedBnc
        }
      }

      ensureTx()
      try {
        insertEntryStmt.run(
          cleanWord,
          cleanPhonetic,
          cleanDef,
          cleanTrans,
          cleanPos,
          cleanExchange,
          freqNumber,
        )
        validRows++

        if (cleanExchange) {
          exchangeCollector?.addEntry(cleanWord, cleanExchange)
        }
      } catch (insertError) {
        // Enforce deterministic duplicate rejection: no silent overwrite
        if (
          insertError instanceof Error &&
          (insertError.message.includes('UNIQUE constraint failed') ||
            insertError.message.includes('PRIMARY KEY'))
        ) {
          rejectedRowsCount++
        } else {
          throw insertError
        }
      }

      currentBatch++
      if (currentBatch >= batchSize) {
        commitTx()
        currentBatch = 0
      }
    })

    const stream = createReadStream(sourcePath, { highWaterMark: 64 * 1024 })
    try {
      for await (const chunk of stream) {
        checkAbort(signal)
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
        bytesImported += buf.byteLength
        sourceHash.update(buf)
        parser.push(buf)
        await yieldToEventLoop()
      }
    } finally {
      if (!stream.destroyed) {
        stream.destroy()
      }
    }

    checkAbort(signal)
    parser.end()
    commitTx()
    phaseTimings['entryImport'] = Date.now() - importStart

    if (!headerValidated) {
      throw new Error(`ECDICT source CSV is empty: ${sourcePath}`)
    }

    // TOCTOU verification against consumed stream bytes
    const importPassSha256 = sourceHash.digest('hex').toLowerCase()
    if (bytesImported !== descriptor.sourceByteSize) {
      throw new Error(
        `Import pass byte size verification failed: expected ${descriptor.sourceByteSize}, consumed ${bytesImported}`,
      )
    }
    if (importPassSha256 !== descriptor.sourceSha256.toLowerCase()) {
      throw new Error(
        `Import pass SHA-256 verification failed: expected ${descriptor.sourceSha256}, calculated ${importPassSha256}`,
      )
    }

    // 6. Resolve and insert morphological forms
    notifyProgress(options?.onProgress, { phase: 'resolving-forms', processed: validRows })
    checkAbort(signal)

    const formResStart = Date.now()
    const exchangeResult = exchangeCollector!.resolve()
    exchangeCollector = null
    phaseTimings['formResolution'] = Date.now() - formResStart
    const { forms } = exchangeResult

    notifyProgress(options?.onProgress, {
      phase: 'inserting-forms',
      processed: 0,
      total: forms.length,
    })

    const formInsStart = Date.now()
    let formBatch = 0
    let insertedForms = 0
    ensureTx()
    for (const formRecord of forms) {
      checkAbort(signal)
      insertFormStmt.run(formRecord.form, formRecord.headword, formRecord.kind)
      insertedForms++
      formBatch++
      if (formBatch >= batchSize) {
        commitTx()
        await yieldToEventLoop()
        ensureTx()
        formBatch = 0
      }
    }
    commitTx()
    await yieldToEventLoop()
    phaseTimings['formInsertion'] = Date.now() - formInsStart

    // 7. Create indexes after bulk data loading
    notifyProgress(options?.onProgress, { phase: 'indexing' })
    checkAbort(signal)
    const indexStart = Date.now()
    db.exec('CREATE INDEX idx_forms_headword_raw ON forms (headword);')
    await yieldToEventLoop()

    checkAbort(signal)
    db.exec('CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);')
    await yieldToEventLoop()
    phaseTimings['indexCreation'] = Date.now() - indexStart

    // 8. Streaming Logical Database Digest computation via StatementSync.iterate()
    checkAbort(signal)
    const logicalHash = createHash('sha256')
    const logicalHashStartNs = process.hrtime.bigint()

    const dumpEntries = db.prepare(`
      SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency
      FROM entries
      ORDER BY word COLLATE NOCASE ASC
    `)

    let entryIterCount = 0
    interface EntryIterRow {
      word: string
      phonetic: string | null
      definition_en: string | null
      translation_zh: string | null
      pos: string | null
      exchange: string | null
      frequency: number | null
    }

    for (const row of dumpEntries.iterate() as Iterable<EntryIterRow>) {
      checkAbort(signal)
      logicalHash.update(
        `entry:${row.word}\0${row.phonetic ?? ''}\0${row.definition_en ?? ''}\0${row.translation_zh ?? ''}\0${row.pos ?? ''}\0${row.exchange ?? ''}\0${row.frequency ?? ''}\n`,
      )
      entryIterCount++
      if (entryIterCount % yieldInterval === 0) {
        await yieldToEventLoop()
      }
    }

    const dumpForms = db.prepare(`
      SELECT form, headword, kind
      FROM forms
      ORDER BY form COLLATE NOCASE ASC
    `)

    let formIterCount = 0
    interface FormIterRow {
      form: string
      headword: string
      kind: string | null
    }

    for (const row of dumpForms.iterate() as Iterable<FormIterRow>) {
      checkAbort(signal)
      logicalHash.update(`form:${row.form}\0${row.headword}\0${row.kind ?? ''}\n`)
      formIterCount++
      if (formIterCount % yieldInterval === 0) {
        await yieldToEventLoop()
      }
    }

    const dumpExamples = db.prepare(`
      SELECT id, headword, english, chinese, source, source_id, score
      FROM examples
      ORDER BY id ASC
    `)

    interface ExampleIterRow {
      id: number
      headword: string
      english: string
      chinese: string | null
      source: string | null
      source_id: string | null
      score: number | null
    }

    for (const row of dumpExamples.iterate() as Iterable<ExampleIterRow>) {
      checkAbort(signal)
      logicalHash.update(
        `example:${row.id}\0${row.headword}\0${row.english}\0${row.chinese ?? ''}\0${row.source ?? ''}\0${row.source_id ?? ''}\0${row.score ?? ''}\n`,
      )
    }

    const logicalSha256 = logicalHash.digest('hex').toLowerCase()
    const logicalHashEndNs = process.hrtime.bigint()
    phaseTimings['logicalHashing'] = Math.round(Number(logicalHashEndNs - logicalHashStartNs) / 1e6)

    // 9. Write authoritative metadata into candidate meta table
    checkAbort(signal)
    const metaStart = Date.now()
    ensureTx()
    insertMetaStmt.run('schema_version', String(descriptor.schemaVersion))
    insertMetaStmt.run('corpus_name', descriptor.sourceName)
    insertMetaStmt.run('upstream_commit', descriptor.sourceCommit)
    insertMetaStmt.run('source_sha256', importPassSha256)
    insertMetaStmt.run('builder_version', '1.1.0')
    insertMetaStmt.run('parser_version', '1.1.0')
    insertMetaStmt.run('entry_count', String(validRows))
    insertMetaStmt.run('form_count', String(forms.length))
    insertMetaStmt.run('example_count', '0')
    insertMetaStmt.run('logical_sha256', logicalSha256)
    commitTx()
    phaseTimings['metadata'] = Date.now() - metaStart
    await yieldToEventLoop()

    // 10. Close write connection to flush database to disk before validation
    db.close()
    dbOpen = false
    await yieldToEventLoop()

    // 11. Run full PRAGMA integrity_check in static companion worker on isolated thread
    notifyProgress(options?.onProgress, { phase: 'validating' })
    checkAbort(signal)
    await yieldToEventLoop()

    let integrityCheckDurationMs = 0
    if (options?.sqliteFactory) {
      // Backward-compatible internal test seam: execute custom SQLite factory
      const validationDb = options.sqliteFactory(candidatePath)
      try {
        try {
          validationDb.exec('PRAGMA mmap_size = 268435456')
          validationDb.exec('PRAGMA cache_size = -64000')
        } catch {
          // ignore if not supported
        }

        checkAbort(signal)
        const integrityStartNs = process.hrtime.bigint()
        const rows = validationDb.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[]
        const integrityEndNs = process.hrtime.bigint()
        integrityCheckDurationMs = Math.round(Number(integrityEndNs - integrityStartNs) / 1e6)

        if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
          const errorDetails = rows
            .map((r) => String(Object.values(r)[0] ?? 'unknown integrity error'))
            .join('; ')
          throw new Error(
            `Candidate SQLite PRAGMA integrity_check failed: ${errorDetails || 'empty result'}`,
          )
        }
      } finally {
        validationDb.close()
      }
    } else if (options?.integrityVerifier) {
      // Internal test seam: execute injected verifier adapter
      const verifierRes = await options.integrityVerifier(candidatePath, signal)
      integrityCheckDurationMs = verifierRes.durationMs
    } else {
      // Production path: execute static companion worker in isolated thread
      const verifierRes = await verifyCandidateDatabaseWithWorker(candidatePath, {
        signal,
        workerUrl: options?.workerUrl,
        expectedDirectory: paths.databaseDirectory,
        workerAdapter: options?.workerAdapter,
        terminationTimeoutMs: options?.terminationTimeoutMs,
      })
      integrityCheckDurationMs = verifierRes.durationMs
    }

    phaseTimings['integrityCheck'] = integrityCheckDurationMs
    checkAbort(signal)
    await yieldToEventLoop()

    checkAbort(signal)
    await yieldToEventLoop()

    // 12. Explicitly sync candidate bytes to disk before product validation and publication
    checkAbort(signal)
    const syncStart = Date.now()
    const fh = await open(candidatePath, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    phaseTimings['fileSync'] = Date.now() - syncStart
    await yieldToEventLoop()

    // 13. Read-only product compatibility opening and probe validation
    checkAbort(signal)
    const valStart = Date.now()
    if (verifyProbes) {
      const dict = openProductionDictionary({
        path: candidatePath,
        manifest: {
          sourceName: descriptor.sourceName,
          sourceCommit: descriptor.sourceCommit,
          sourceSha256: importPassSha256,
          schemaVersion: descriptor.schemaVersion,
        },
      })
      try {
        verifyCandidateProbes(dict)
      } finally {
        dict.close()
      }
    }
    phaseTimings['productValidation'] = Date.now() - valStart
    await yieldToEventLoop()

    // 14. Compute physical file hash and stats on candidate BEFORE publication commit
    checkAbort(signal)
    const statStart = Date.now()
    const candidateStats = await stat(candidatePath)
    const fileSha256 = await computeFileSha256(candidatePath)
    const byteSize = candidateStats.size
    phaseTimings['physicalDigest'] = Date.now() - statStart
    await yieldToEventLoop()

    checkAbort(signal)

    // 15. Atomic no-replace publication via same-directory hard link
    notifyProgress(options?.onProgress, { phase: 'publishing' })
    checkAbort(signal)

    // Strict boundary validation: verify candidate before publication
    await validateCandidateDatabasePath(candidatePath, paths.databaseDirectory)

    const pubStart = Date.now()
    await link(candidatePath, finalPath)
    published = true
    phaseTimings['publication'] = Date.now() - pubStart

    // Clean up own candidate temp file and sidecars after committed publication
    let candidateRemoved = false
    let sidecarsRemoved = true
    let sidecarErrorCode: string | undefined
    let candidateErrorCode: string | undefined

    const candidateUnlinkFn = options?.unlinkFn ?? unlink

    // Clean up sidecars if any exist
    const sidecarSuffixes = ['-journal', '-wal', '-shm']
    for (const suffix of sidecarSuffixes) {
      const sidecarPath = candidatePath + suffix
      try {
        await candidateUnlinkFn(sidecarPath)
        if (existsSync(sidecarPath)) {
          sidecarsRemoved = false
          if (!sidecarErrorCode) {
            sidecarErrorCode = 'UNKNOWN'
          }
        }
      } catch (scErr: any) {
        if (scErr?.code !== 'ENOENT') {
          sidecarsRemoved = false
          if (!sidecarErrorCode) {
            sidecarErrorCode = typeof scErr?.code === 'string' ? scErr.code : 'UNKNOWN'
          }
        } else {
          if (existsSync(sidecarPath)) {
            sidecarsRemoved = false
            if (!sidecarErrorCode) {
              sidecarErrorCode = 'ENOENT'
            }
          }
        }
      }
    }

    // Bounded retries for candidate file cleanup
    const MAX_CLEANUP_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_CLEANUP_ATTEMPTS; attempt++) {
      try {
        await candidateUnlinkFn(candidatePath)
        if (!existsSync(candidatePath)) {
          candidateRemoved = true
          candidateErrorCode = undefined
          break
        }
      } catch (unlinkErr: any) {
        if (unlinkErr?.code === 'ENOENT') {
          if (!existsSync(candidatePath)) {
            candidateRemoved = true
            candidateErrorCode = undefined
            break
          } else {
            candidateErrorCode = 'ENOENT'
          }
        } else {
          candidateErrorCode = typeof unlinkErr?.code === 'string' ? unlinkErr.code : 'UNKNOWN'
        }
      }

      if (attempt < MAX_CLEANUP_ATTEMPTS) {
        await yieldToEventLoop()
      }
    }

    if (!candidateRemoved && !candidateErrorCode) {
      candidateErrorCode = 'UNKNOWN'
    }

    const effectiveErrorCode = sidecarErrorCode ?? candidateErrorCode

    const postPublicationCleanup: PostPublicationCleanupResult = Object.freeze(
      effectiveErrorCode || !candidateRemoved || !sidecarsRemoved
        ? {
            candidateRemoved,
            sidecarsRemoved,
            errorCode: effectiveErrorCode ?? 'UNKNOWN',
          }
        : {
            candidateRemoved: true,
            sidecarsRemoved: true,
          },
    )

    notifyProgress(options?.onProgress, {
      phase: 'complete',
      processed: validRows,
      total: validRows,
    })

    return Object.freeze({
      identity,
      path: finalPath,
      databaseFile: finalFileName,
      sourceCommit: descriptor.sourceCommit,
      sourceSha256: importPassSha256,
      schemaVersion: descriptor.schemaVersion,
      entryCount: validRows,
      formCount: forms.length,
      exampleCount: 0,
      ambiguousFormCount: exchangeResult.ambiguous.length,
      rejectedRowCount: rejectedRowsCount,
      sourceRowCount: validRows + rejectedRowsCount,
      logicalSha256,
      fileSha256,
      byteSize,
      yieldCount,
      integrityCheckDurationMs,
      phaseTimings: Object.freeze({ ...phaseTimings }),
      postPublicationCleanup,
    })
  } catch (err) {
    if (inTx) {
      try {
        db?.exec('ROLLBACK')
      } catch {
        // ignore
      }
      inTx = false
    }

    if (dbOpen) {
      try {
        db?.close()
      } catch {
        // ignore
      }
      dbOpen = false
    }

    const terminationUnconfirmed = isTerminationUnconfirmed(err)

    if (terminationUnconfirmed && candidatePath !== null) {
      const termInfo = extractWorkerTerminationInfo(err)
      const capturedIdentity =
        termInfo?.candidateFileIdentity ?? captureCandidateFileIdentity(candidatePath)
      quarantinedDirectories.set(normalizedDbDir, {
        directory: normalizedDbDir,
        candidatePath,
        quarantinedAt: Date.now(),
        reason: 'Worker termination unconfirmed: possible lingering SQLite file handle',
        error: err,
        workerId: termInfo?.workerId,
        candidateFileIdentity: capturedIdentity,
      })
    }

    let cleanupError: unknown = null
    if (!published && candidatePath !== null && !terminationUnconfirmed) {
      try {
        await cleanupCandidateArtifacts(candidatePath, options?.unlinkFn)
      } catch (cErr) {
        cleanupError = cErr
      }
    }

    if (cleanupError !== null) {
      if (err) {
        const errors = [
          err,
          ...(cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]),
        ]
        throw new AggregateError(
          errors,
          `ECDICT import failed and candidate cleanup failed: ${String(err)}`,
        )
      }
      throw cleanupError
    }

    if (isAbortError(err)) {
      throw createAbortError(signal?.reason)
    }
    throw err
  } finally {
    activeImports.delete(normalizedDbDir)
  }
}
