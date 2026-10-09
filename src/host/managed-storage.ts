/**
 * Profile-aware managed dictionary storage layout and atomic active metadata persistence.
 *
 * Implements the filesystem storage contracts for Phase 7A.3:
 *
 * Layout:
 * ```text
 * <DSH_HOME>/
 *   cache/
 *     dsh-word-lookup/
 *       sources/
 *         ... (downloaded ECDICT source artifacts, e.g. ecdict.csv, *.part)
 *   storages/
 *     dsh-word-lookup/
 *       databases/
 *         ecdict-<identity>.sqlite3
 *       active.json
 * ```
 *
 * Invariants:
 * - Resolved DSH home is obtained through official host context surfaces
 *   (`ctx.get('profileContext')?.home` or `ctx.get('dshHomePath')?.()`) or explicit injection.
 * - Zero ambient environment access in active package runtime to maintain Store contract `credentials = false`.
 * - Versioned database naming: databases are never overwritten in place (`ecdict-<identity>.sqlite3`),
 *   ensuring Windows open SQLite handle safety during atomic hot-swapping.
 * - Atomic metadata persistence: `active.json` is updated via sibling temporary file rename
 *   (`active.json.tmp-<uuid>` -> `active.json`).
 * - Metadata database references are relative basenames only (`databaseFile`), preventing
 *   machine path leakage and traversal vulnerabilities.
 * - Malformed metadata fails closed without mutating or destroying existing files.
 *
 * @module dsh-word-lookup/host/managed-storage
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Safe identity token pattern: alphanumeric plus dots, underscores, dashes (1-64 chars). */
export const SAFE_IDENTITY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/

/** Versioned managed SQLite filename pattern. */
export const MANAGED_DATABASE_FILENAME_PATTERN = /^ecdict-[a-zA-Z0-9._-]{1,64}\.sqlite3$/

/** Recognized temporary artifact pattern for safe cleanup. */
export const STALE_TEMPORARY_ARTIFACT_PATTERN = /^(?:active\.json\.tmp-[a-zA-Z0-9_-]+|.*\.tmp-[a-zA-Z0-9_-]+|.*\.part)$/

/** Candidate temporary database filename pattern during build (`ecdict-<identity>.sqlite3.tmp-<candidateId>`). */
export const CANDIDATE_DATABASE_FILENAME_PATTERN = /^ecdict-[a-zA-Z0-9._-]{1,64}\.sqlite3\.tmp-[a-zA-Z0-9_-]{1,64}$/

/**
 * Check whether a filename matches the candidate temporary database contract.
 */
export function isCandidateDatabaseFileName(fileName: string): boolean {
  return CANDIDATE_DATABASE_FILENAME_PATTERN.test(fileName)
}

/**
 * Validate that a candidate path resides strictly within the managed database directory,
 * conforms to the candidate filename pattern, and does not escape via traversal, symlinks, or junctions.
 *
 * @param candidatePath - candidate database path.
 * @param databaseDirectory - expected managed database directory.
 * @returns normalized resolved candidate path.
 */
export async function validateCandidateDatabasePath(
  candidatePath: string,
  databaseDirectory: string,
): Promise<string> {
  if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) {
    throw new TypeError('Candidate database path must be a non-empty string')
  }
  if (typeof databaseDirectory !== 'string' || databaseDirectory.trim().length === 0) {
    throw new TypeError('Database directory must be a non-empty string')
  }

  if (candidatePath.includes('\0') || databaseDirectory.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  const normalizedDbDir = resolve(databaseDirectory)
  const resolvedCandidate = resolve(candidatePath)

  // 1. Filename contract
  const candidateName = basename(resolvedCandidate)
  if (!CANDIDATE_DATABASE_FILENAME_PATTERN.test(candidateName)) {
    throw new Error(
      `Candidate database filename "${candidateName}" violates candidate naming contract (${CANDIDATE_DATABASE_FILENAME_PATTERN.source})`,
    )
  }

  // 2. Directory containment check (pre-realpath)
  const candidateDir = resolve(resolvedCandidate, '..')
  if (candidateDir !== normalizedDbDir) {
    throw new Error(
      `Candidate database path "${resolvedCandidate}" escapes managed database directory "${normalizedDbDir}"`,
    )
  }

  // 3. Symlink and junction protection (post-creation inspection)
  try {
    const fileStat = await lstat(resolvedCandidate)
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Candidate database path "${resolvedCandidate}" must not be a symbolic link`)
    }

    const realCandidatePath = await realpath(resolvedCandidate)
    const realDbDir = await realpath(normalizedDbDir)

    const realCandidateDir = resolve(realCandidatePath, '..')
    if (realCandidateDir !== realDbDir || basename(realCandidatePath) !== candidateName) {
      throw new Error(
        `Candidate database realpath "${realCandidatePath}" escapes managed database realpath "${realDbDir}"`,
      )
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err
    }
  }

  return resolvedCandidate
}

/**
 * Resolved directory and file paths for managed dictionary storage.
 */
export interface ManagedStoragePaths {
  /** Root DSH home directory. */
  readonly home: string
  /** Directory for downloaded source artifacts (`<home>/cache/dsh-word-lookup/sources`). */
  readonly sourceCacheDirectory: string
  /** Root storage directory (`<home>/storages/dsh-word-lookup`). */
  readonly storageDirectory: string
  /** Directory for versioned SQLite databases (`<home>/storages/dsh-word-lookup/databases`). */
  readonly databaseDirectory: string
  /** Path to the active metadata file (`<home>/storages/dsh-word-lookup/active.json`). */
  readonly activeMetadataPath: string
}

/**
 * Options for resolving managed storage paths.
 */
export interface ResolveManagedStorageOptions {
  /** Explicit DSH home override (highest precedence; used for testing and synthetic roots). */
  readonly home?: string
  /** Host Cordis context to resolve profileContext or dshHomePath from. */
  readonly ctx?: Context
}

/**
 * Source provenance descriptor in active metadata.
 */
export interface ActiveMetadataSource {
  /** Canonical corpus source name (e.g. 'ECDICT'). */
  readonly name: string
  /** 40-character git commit hash of the corpus artifact. */
  readonly commit: string
  /** 64-character lowercase SHA-256 digest of the source artifact. */
  readonly sha256: string
  /** SQLite schema version. */
  readonly schemaVersion: number
}

/**
 * Schema of persisted `active.json` metadata.
 */
export interface ActiveMetadata {
  /** Metadata schema version (currently 1). */
  readonly version: 1
  /** Active dictionary mode (must be 'managed-ecdict'). */
  readonly activeMode: 'managed-ecdict'
  /** Safe identifier matching the database identity. */
  readonly identity: string
  /** Basename only of the active SQLite database (e.g. 'ecdict-v1-abcdef.sqlite3'). */
  readonly databaseFile: string
  /** Source provenance details. */
  readonly source: ActiveMetadataSource
}

/**
 * Attempt to extract the resolved DSH home from official host context surfaces.
 *
 * Supported surfaces in DSH 0.2.0-rc.2:
 * 1. `ctx.get('profileContext')?.home` (provided by `profile-boot` on profile launch).
 * 2. `ctx.get('dshHomePath')?.()` (provided by `app-boot` on boot).
 *
 * Returns `null` when neither surface is present on the context.
 */
export function resolveDshHomeFromContext(ctx?: Context): string | null {
  if (!ctx) return null

  // 1. profileContext.home
  const profileContext = (ctx.get?.('profileContext') ?? (ctx as unknown as Record<string, unknown>).profileContext) as
    | { home?: unknown }
    | undefined
  if (profileContext && typeof profileContext.home === 'string' && profileContext.home.trim().length > 0) {
    return resolve(profileContext.home.trim())
  }

  // 2. dshHomePath function
  const dshHomePath = (ctx.get?.('dshHomePath') ?? (ctx as unknown as Record<string, unknown>).dshHomePath) as
    | ((...segments: string[]) => unknown)
    | undefined
  if (typeof dshHomePath === 'function') {
    const res = dshHomePath()
    if (typeof res === 'string' && res.trim().length > 0) {
      return resolve(res.trim())
    }
  }

  return null
}

/**
 * Resolve managed dictionary filesystem layout paths.
 *
 * Precedence:
 * 1. `options.home` (explicit override).
 * 2. `options.ctx` official host services (`profileContext.home` or `dshHomePath`).
 *
 * Throws if no home can be resolved through supported official surfaces.
 * Fails closed without falling back to ambient process environment or unverified `~/.dsh`.
 *
 * @param options - optional explicit home or context.
 * @returns validated immutable paths object.
 */
export function resolveManagedStoragePaths(options?: ResolveManagedStorageOptions): ManagedStoragePaths {
  let home: string | null = null

  if (options?.home !== undefined && typeof options.home === 'string') {
    const trimmed = options.home.trim()
    if (trimmed.length > 0) {
      home = resolve(trimmed)
    }
  }

  if (home === null && options?.ctx !== undefined) {
    home = resolveDshHomeFromContext(options.ctx)
  }

  if (home === null) {
    throw new Error(
      'Cannot resolve DSH home: no explicit home provided and context does not supply profileContext.home or dshHomePath',
    )
  }

  const sourceCacheDirectory = join(home, 'cache', 'dsh-word-lookup', 'sources')
  const storageDirectory = join(home, 'storages', 'dsh-word-lookup')
  const databaseDirectory = join(storageDirectory, 'databases')
  const activeMetadataPath = join(storageDirectory, 'active.json')

  return Object.freeze({
    home,
    sourceCacheDirectory,
    storageDirectory,
    databaseDirectory,
    activeMetadataPath,
  })
}

/**
 * Ensure storage and cache directories exist on disk.
 *
 * Creates:
 * - `<home>/cache/dsh-word-lookup/sources`
 * - `<home>/storages/dsh-word-lookup/databases`
 *
 * @param paths - resolved managed storage paths.
 */
export async function ensureManagedStorageDirectories(paths: ManagedStoragePaths): Promise<void> {
  await mkdir(paths.sourceCacheDirectory, { recursive: true })
  await mkdir(paths.databaseDirectory, { recursive: true })
}

/**
 * Generate a validated, filesystem-safe versioned SQLite database filename.
 *
 * Enforces strict character and length constraints to prevent path traversal and collisions:
 * - Must match {@link SAFE_IDENTITY_PATTERN}.
 * - Must not contain path separators (`/`, `\`), traversal segments (`.`, `..`), or drive letters (`:`).
 *
 * @param identity - safe versioned identity string (e.g. 'v1-a7013d658fb101bc').
 * @returns basename filename formatted as `ecdict-<identity>.sqlite3`.
 */
export function managedDatabaseFileName(identity: string): string {
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    throw new TypeError('Dictionary identity must be a non-empty string')
  }

  const trimmed = identity.trim()
  if (!SAFE_IDENTITY_PATTERN.test(trimmed)) {
    throw new TypeError(
      `Invalid dictionary identity "${identity}": must match ${SAFE_IDENTITY_PATTERN.source} without slashes or path traversal`,
    )
  }

  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes(':')
  ) {
    throw new TypeError(`Path traversal detected in dictionary identity: "${identity}"`)
  }

  return `ecdict-${trimmed}.sqlite3`
}

/**
 * Return the absolute path to a versioned database file inside `databaseDirectory`.
 *
 * @param paths - resolved managed storage paths.
 * @param identity - safe versioned identity string.
 * @returns absolute normalized database path.
 */
export function managedDatabasePath(paths: ManagedStoragePaths, identity: string): string {
  const fileName = managedDatabaseFileName(identity)
  return join(paths.databaseDirectory, fileName)
}

/**
 * Validate an unknown object against the {@link ActiveMetadata} schema.
 *
 * Throws detailed TypeError if any required field is missing or invalid.
 */
export function validateActiveMetadata(raw: unknown): ActiveMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Active metadata must be a non-null object')
  }

  const record = raw as Record<string, unknown>

  if (record.version !== 1) {
    throw new TypeError(`Unsupported active metadata schema version: expected 1, got ${String(record.version)}`)
  }

  if (record.activeMode !== 'managed-ecdict') {
    throw new TypeError(`Invalid activeMode: expected "managed-ecdict", got "${String(record.activeMode)}"`)
  }

  if (typeof record.identity !== 'string' || !SAFE_IDENTITY_PATTERN.test(record.identity.trim())) {
    throw new TypeError(`Invalid active metadata identity: "${String(record.identity)}"`)
  }
  const identity = record.identity.trim()

  if (typeof record.databaseFile !== 'string') {
    throw new TypeError('Active metadata databaseFile must be a string')
  }
  const dbFile = record.databaseFile.trim()

  // Must be a relative basename matching managed database filename pattern
  if (
    isAbsolute(dbFile) ||
    dbFile.includes('/') ||
    dbFile.includes('\\') ||
    basename(dbFile) !== dbFile ||
    !MANAGED_DATABASE_FILENAME_PATTERN.test(dbFile)
  ) {
    throw new TypeError(
      `Invalid active metadata databaseFile "${record.databaseFile}": must be a relative basename matching ${MANAGED_DATABASE_FILENAME_PATTERN.source}`,
    )
  }

  const expectedDbFile = managedDatabaseFileName(identity)
  if (dbFile !== expectedDbFile) {
    throw new TypeError(
      `Active metadata databaseFile "${dbFile}" does not match identity "${identity}" (expected "${expectedDbFile}")`,
    )
  }

  // Validate source object
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
    throw new TypeError('Active metadata source must be an object')
  }
  const source = record.source as Record<string, unknown>

  if (typeof source.name !== 'string' || source.name.trim().length === 0) {
    throw new TypeError('Active metadata source.name must be a non-empty string')
  }

  if (typeof source.commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(source.commit.trim())) {
    throw new TypeError('Active metadata source.commit must be a 40-character hex commit string')
  }

  if (typeof source.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(source.sha256.trim())) {
    throw new TypeError('Active metadata source.sha256 must be a 64-character hex string')
  }

  if (typeof source.schemaVersion !== 'number' || !Number.isInteger(source.schemaVersion) || source.schemaVersion < 1) {
    throw new TypeError('Active metadata source.schemaVersion must be a positive integer >= 1')
  }

  return {
    version: 1,
    activeMode: 'managed-ecdict',
    identity,
    databaseFile: dbFile,
    source: {
      name: source.name.trim(),
      commit: source.commit.trim().toLowerCase(),
      sha256: source.sha256.trim().toLowerCase(),
      schemaVersion: source.schemaVersion,
    },
  }
}

/**
 * Read and validate active dictionary metadata from `<home>/storages/dsh-word-lookup/active.json`.
 *
 * Fail-closed behavior:
 * - If `active.json` does not exist (ENOENT): returns `null`.
 * - If `active.json` is malformed JSON or fails schema validation: throws without modifying disk.
 *
 * @param paths - resolved managed storage paths.
 * @returns validated metadata object, or `null` if no active metadata exists.
 */
export async function readActiveMetadata(paths: ManagedStoragePaths): Promise<ActiveMetadata | null> {
  let content: string
  try {
    content = await readFile(paths.activeMetadataPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (cause) {
    throw new Error(`Malformed active metadata JSON at ${paths.activeMetadataPath}: ${String(cause)}`, { cause })
  }

  return validateActiveMetadata(parsed)
}

/** Internal hooks interface for filesystem operation failure injection in tests. */
export interface StorageFsHooks {
  readonly writeFile?: (
    path: string,
    data: string,
    options: { encoding: 'utf8'; flush: boolean },
  ) => Promise<void>
  readonly rename?: (oldPath: string, newPath: string) => Promise<void>
  readonly unlink?: (path: string) => Promise<void>
}

let storageFsHooks: StorageFsHooks | null = null

/**
 * Configure internal filesystem hooks for failure-injection testing.
 * @internal Test-only helper. Pass `null` to reset to standard `node:fs/promises` operations.
 */
export function _setStorageFsHooksForTesting(hooks: StorageFsHooks | null): void {
  storageFsHooks = hooks
}

/**
 * Atomically write active dictionary metadata to `<home>/storages/dsh-word-lookup/active.json`.
 *
 * Sequence:
 * 1. Validate metadata schema before disk operations.
 * 2. Ensure storage directory exists.
 * 3. Write serialized JSON to a sibling temporary file (`active.json.tmp-<randomUUID>`) with explicit `flush: true`.
 * 4. Atomically rename temporary file to `active.json` (atomic replacement on Windows and POSIX).
 * 5. On failure, best-effort cleanup of temporary file without corrupting existing `active.json`.
 *
 * @param paths - resolved managed storage paths.
 * @param metadata - valid active metadata descriptor.
 */
export async function writeActiveMetadataAtomically(
  paths: ManagedStoragePaths,
  metadata: ActiveMetadata,
): Promise<void> {
  const validated = validateActiveMetadata(metadata)
  const serialized = JSON.stringify(validated, null, 2) + '\n'

  await ensureManagedStorageDirectories(paths)

  const tempName = `active.json.tmp-${randomUUID()}`
  const tempPath = join(paths.storageDirectory, tempName)

  const doWriteFile = storageFsHooks?.writeFile ?? writeFile
  const doRename = storageFsHooks?.rename ?? rename
  const doUnlink = storageFsHooks?.unlink ?? unlink

  try {
    await doWriteFile(tempPath, serialized, {
      encoding: 'utf8',
      flush: true,
    })
    await doRename(tempPath, paths.activeMetadataPath)
  } catch (error) {
    try {
      await doUnlink(tempPath)
    } catch {
      // best-effort cleanup
    }
    throw error
  }
}

/**
 * Clean up stale temporary artifacts in managed storage and cache directories.
 *
 * Cleans only recognized temporary files matching {@link STALE_TEMPORARY_ARTIFACT_PATTERN}:
 * - `active.json.tmp-*`
 * - `*.tmp-*`
 * - `*.part`
 *
 * Never modifies or deletes:
 * - `active.json`
 * - `*.sqlite3`
 * - Unknown user or system files.
 *
 * @param paths - resolved managed storage paths.
 * @returns summary of unlinked file paths.
 */
export async function removeStaleTemporaryArtifacts(paths: ManagedStoragePaths): Promise<{ removed: string[] }> {
  const removed: string[] = []
  const targetDirs = [paths.storageDirectory, paths.databaseDirectory, paths.sourceCacheDirectory]

  for (const dir of targetDirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }

    for (const entry of entries) {
      if (STALE_TEMPORARY_ARTIFACT_PATTERN.test(entry)) {
        const fullPath = join(dir, entry)
        try {
          await unlink(fullPath)
          removed.push(fullPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
    }
  }

  return { removed }
}
