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
export const STALE_TEMPORARY_ARTIFACT_PATTERN = /^(?:active\.json\.tmp-[a-zA-Z0-9_-]+|.*\.tmp-[a-zA-Z0-9_-]+|.*\.part|staging-[0-9a-fA-F-]{36}\.sqlite3)$/

/** Candidate temporary database filename pattern during build (`ecdict-<identity>.sqlite3.tmp-<candidateId>`). */
export const CANDIDATE_DATABASE_FILENAME_PATTERN = /^ecdict-[a-zA-Z0-9._-]{1,64}\.sqlite3\.tmp-[a-zA-Z0-9_-]{1,64}$/

/** Staging custom snapshot temporary database filename pattern (`staging-<uuid>.sqlite3`). */
export const STAGING_SNAPSHOT_FILENAME_PATTERN = /^staging-[0-9a-fA-F-]{36}\.sqlite3$/

/** Published custom snapshot filename pattern (`custom-<identity>.sqlite3`). */
export const PUBLISHED_SNAPSHOT_FILENAME_PATTERN = /^custom-[a-zA-Z0-9._-]{1,64}\.sqlite3$/

/** Recognized snapshot filename pattern for custom database directory. */
export const CUSTOM_SNAPSHOT_FILENAME_PATTERN = /^(?:staging-[0-9a-fA-F-]{36}\.sqlite3|custom-[a-zA-Z0-9._-]{1,64}\.sqlite3)$/

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
 * Validate that a custom snapshot path resides strictly within the managed custom-snapshots directory,
 * conforms to the staging or published snapshot filename pattern, and does not escape via traversal, symlinks, or junctions.
 *
 * @param snapshotPath - snapshot database path.
 * @param customSnapshotDirectory - expected managed custom-snapshots directory.
 * @returns normalized resolved snapshot path.
 */
export async function validateCustomSnapshotPath(
  snapshotPath: string,
  customSnapshotDirectory: string,
): Promise<string> {
  if (typeof snapshotPath !== 'string' || snapshotPath.trim().length === 0) {
    throw new TypeError('Snapshot database path must be a non-empty string')
  }
  if (typeof customSnapshotDirectory !== 'string' || customSnapshotDirectory.trim().length === 0) {
    throw new TypeError('Custom snapshot directory must be a non-empty string')
  }

  if (snapshotPath.includes('\0') || customSnapshotDirectory.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  const isWin = process.platform === 'win32'
  const arePathsEqual = (p1: string, p2: string): boolean =>
    isWin ? p1.toLowerCase() === p2.toLowerCase() : p1 === p2

  const normalizedDir = resolve(customSnapshotDirectory)
  const resolvedSnapshot = resolve(snapshotPath)

  // 1. Filename contract
  const snapshotName = basename(resolvedSnapshot)
  if (!CUSTOM_SNAPSHOT_FILENAME_PATTERN.test(snapshotName)) {
    throw new Error(
      `Snapshot database filename "${snapshotName}" violates snapshot naming contract (${CUSTOM_SNAPSHOT_FILENAME_PATTERN.source})`,
    )
  }

  // 2. Directory containment check (pre-realpath)
  const snapshotDir = resolve(resolvedSnapshot, '..')
  if (!arePathsEqual(snapshotDir, normalizedDir)) {
    throw new Error(
      `Snapshot database path "${resolvedSnapshot}" escapes managed custom snapshot directory "${normalizedDir}"`,
    )
  }

  // 3. Directory and ancestor symlink & junction inspection (even if snapshot file or directory does not exist yet)
  let curr = normalizedDir
  while (curr && curr !== resolve(curr, '..')) {
    try {
      const stat = await lstat(curr)
      if (stat.isSymbolicLink()) {
        throw new Error(`Custom snapshot directory path "${curr}" must not be a symbolic link or junction`)
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err
      }
    }
    curr = resolve(curr, '..')
  }

  let realSnapDir = normalizedDir
  try {
    realSnapDir = await realpath(normalizedDir)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err
    }
  }

  // 4. Target file symlink and junction protection (post-creation inspection)
  try {
    const fileStat = await lstat(resolvedSnapshot)
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Snapshot database path "${resolvedSnapshot}" must not be a symbolic link`)
    }

    const realSnapshotPath = await realpath(resolvedSnapshot)
    const realParentDir = resolve(realSnapshotPath, '..')
    const realBaseName = basename(realSnapshotPath)

    const parentMatches = arePathsEqual(realParentDir, realSnapDir)
    const baseMatches = isWin
      ? realBaseName.toLowerCase() === snapshotName.toLowerCase()
      : realBaseName === snapshotName

    if (!parentMatches || !baseMatches) {
      throw new Error(
        `Snapshot database realpath "${realSnapshotPath}" escapes managed custom snapshot realpath "${realSnapDir}"`,
      )
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err
    }
  }

  return resolvedSnapshot
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
  /** Directory for custom SQLite snapshots (`<home>/storages/dsh-word-lookup/custom-snapshots`). */
  readonly customSnapshotDirectory: string
  /** Path to the active metadata file (`<home>/storages/dsh-word-lookup/active.json`). */
  readonly activeMetadataPath: string
  /** Path to the installed ECDICT inventory file (`<home>/storages/dsh-word-lookup/installed-ecdict.json`). */
  readonly installedEcdictPath: string
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
 * Settings synchronization state descriptor.
 */
export type SettingsSyncState = 'synced' | 'failed' | 'unavailable' | 'pending'

/**
 * Persisted active metadata for managed ECDICT dictionary mode.
 */
export interface ManagedActiveMetadata {
  /** Metadata schema version (currently 1). */
  readonly version: 1
  /** Active dictionary mode ('managed-ecdict'). */
  readonly activeMode: 'managed-ecdict'
  /** Safe identifier matching the database identity. */
  readonly identity: string
  /** Basename only of the active SQLite database (e.g. 'ecdict-v1-abcdef.sqlite3'). */
  readonly databaseFile: string
  /** Source provenance details. */
  readonly source: ActiveMetadataSource
  /** Whether host configuration settings were successfully synced. */
  readonly settingsSynced?: boolean
  /** Distinct verifiable persistence state for host settings synchronization. */
  readonly settingsSyncState?: SettingsSyncState
  /** Sanitized error diagnostic if host settings sync failed. */
  readonly settingsSyncError?: string | null
  /** ISO timestamp when activation was committed. */
  readonly lastActivatedAt?: string
}

/**
 * Persisted active metadata for custom SQLite dictionary mode.
 */
export interface CustomActiveMetadata {
  /** Metadata schema version (currently 1). */
  readonly version: 1
  /** Active dictionary mode ('custom'). */
  readonly activeMode: 'custom'
  /** Logical identity label. */
  readonly identity: string
  /** Unique published snapshot identifier UUID. */
  readonly snapshotId: string
  /** Basename only of the published snapshot SQLite database (`custom-<snapshotId>.sqlite3`). */
  readonly databaseFile: string
  /** Provenance source token (strictly 'custom-local'). */
  readonly source: 'custom-local'
  /** Verified SQLite database schema version. */
  readonly schemaVersion: number
  /** Verified SHA-256 digest of published snapshot file. */
  readonly sha256: string
  /** Verified physical byte size of published snapshot file. */
  readonly byteSize: number
  /** Whether host configuration settings were successfully synced. */
  readonly settingsSynced?: boolean
  /** Distinct verifiable persistence state for host settings synchronization. */
  readonly settingsSyncState?: SettingsSyncState
  /** Sanitized error diagnostic if host settings sync failed. */
  readonly settingsSyncError?: string | null
  /** ISO timestamp when activation was committed. */
  readonly lastActivatedAt?: string
}

/**
 * Schema of persisted `active.json` metadata across dictionary modes.
 */
export type ActiveMetadata = ManagedActiveMetadata | CustomActiveMetadata

/**
 * Schema of persisted `installed-ecdict.json` inventory metadata.
 * Tracks installed ECDICT corpus independent of the currently active dictionary mode.
 */
export interface InstalledEcdictMetadata {
  /** Schema version (currently 1). */
  readonly version: 1
  /** Managed database identity. */
  readonly identity: string
  /** Relative basename of installed managed SQLite database. */
  readonly databaseFile: string
  /** Source provenance details. */
  readonly source: ActiveMetadataSource
  /** Total valid headword entry count if known. */
  readonly entryCount?: number
  /** Total morphological form count if known. */
  readonly formCount?: number
  /** Physical database byte size on disk. */
  readonly byteSize?: number
  /** ISO timestamp when installation was completed. */
  readonly installedAt?: string
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
  const customSnapshotDirectory = join(storageDirectory, 'custom-snapshots')
  const activeMetadataPath = join(storageDirectory, 'active.json')
  const installedEcdictPath = join(storageDirectory, 'installed-ecdict.json')

  return Object.freeze({
    home,
    sourceCacheDirectory,
    storageDirectory,
    databaseDirectory,
    customSnapshotDirectory,
    activeMetadataPath,
    installedEcdictPath,
  })
}

/**
 * Ensure storage and cache directories exist on disk.
 *
 * Creates:
 * - `<home>/cache/dsh-word-lookup/sources`
 * - `<home>/storages/dsh-word-lookup/databases`
 * - `<home>/storages/dsh-word-lookup/custom-snapshots`
 *
 * @param paths - resolved managed storage paths.
 */
export async function ensureManagedStorageDirectories(paths: ManagedStoragePaths): Promise<void> {
  await mkdir(paths.sourceCacheDirectory, { recursive: true })
  await mkdir(paths.databaseDirectory, { recursive: true })
  await mkdir(paths.customSnapshotDirectory, { recursive: true })
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

  if (record.activeMode === 'managed-ecdict') {
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

    const settingsSynced = typeof record.settingsSynced === 'boolean' ? record.settingsSynced : undefined
    const validSyncStates = new Set(['synced', 'failed', 'unavailable', 'pending'])
    let settingsSyncState: SettingsSyncState | undefined =
      typeof record.settingsSyncState === 'string' && validSyncStates.has(record.settingsSyncState)
        ? (record.settingsSyncState as SettingsSyncState)
        : undefined

    // Schema compatibility: infer settingsSyncState from legacy metadata if absent
    if (settingsSyncState === undefined) {
      if (settingsSynced === true) {
        settingsSyncState = 'synced'
      } else if (settingsSynced === false) {
        settingsSyncState = 'failed'
      } else if (typeof record.settingsSyncError === 'string' && record.settingsSyncError.trim().length > 0) {
        settingsSyncState = 'failed'
      }
    }

    const settingsSyncError = typeof record.settingsSyncError === 'string'
      ? record.settingsSyncError.trim()
      : record.settingsSyncError === null
        ? null
        : undefined
    const lastActivatedAt = typeof record.lastActivatedAt === 'string' ? record.lastActivatedAt.trim() : undefined

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
      ...(settingsSynced !== undefined ? { settingsSynced } : {}),
      ...(settingsSyncState !== undefined ? { settingsSyncState } : {}),
      ...(settingsSyncError !== undefined ? { settingsSyncError } : {}),
      ...(lastActivatedAt !== undefined ? { lastActivatedAt } : {}),
    }
  }

  if (record.activeMode === 'custom') {
    if (typeof record.identity !== 'string' || !SAFE_IDENTITY_PATTERN.test(record.identity.trim())) {
      throw new TypeError(`Invalid custom active metadata identity: "${String(record.identity)}"`)
    }
    const identity = record.identity.trim()

    if (typeof record.snapshotId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(record.snapshotId.trim())) {
      throw new TypeError(`Invalid custom active metadata snapshotId: "${String(record.snapshotId)}"`)
    }
    const snapshotId = record.snapshotId.trim()

    if (typeof record.databaseFile !== 'string') {
      throw new TypeError('Custom active metadata databaseFile must be a string')
    }
    const dbFile = record.databaseFile.trim()

    // Must be a relative basename matching custom snapshot filename pattern
    if (
      isAbsolute(dbFile) ||
      dbFile.includes('/') ||
      dbFile.includes('\\') ||
      basename(dbFile) !== dbFile ||
      !PUBLISHED_SNAPSHOT_FILENAME_PATTERN.test(dbFile)
    ) {
      throw new TypeError(
        `Invalid custom active metadata databaseFile "${record.databaseFile}": must be a relative basename matching ${PUBLISHED_SNAPSHOT_FILENAME_PATTERN.source}`,
      )
    }

    if (record.source !== 'custom-local') {
      throw new TypeError(`Invalid custom active metadata source: expected "custom-local", got "${String(record.source)}"`)
    }

    if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
      throw new TypeError('Custom active metadata schemaVersion must be a positive integer >= 1')
    }

    if (typeof record.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(record.sha256.trim())) {
      throw new TypeError('Custom active metadata sha256 must be a 64-character hex string')
    }
    const sha256 = record.sha256.trim().toLowerCase()

    if (typeof record.byteSize !== 'number' || !Number.isInteger(record.byteSize) || record.byteSize <= 0) {
      throw new TypeError('Custom active metadata byteSize must be a positive integer > 0')
    }
    const byteSize = record.byteSize

    const settingsSynced = typeof record.settingsSynced === 'boolean' ? record.settingsSynced : undefined
    const validSyncStates = new Set(['synced', 'failed', 'unavailable', 'pending'])
    let settingsSyncState: SettingsSyncState | undefined =
      typeof record.settingsSyncState === 'string' && validSyncStates.has(record.settingsSyncState)
        ? (record.settingsSyncState as SettingsSyncState)
        : undefined

    if (settingsSyncState === undefined) {
      if (settingsSynced === true) {
        settingsSyncState = 'synced'
      } else if (settingsSynced === false) {
        settingsSyncState = 'failed'
      } else if (typeof record.settingsSyncError === 'string' && record.settingsSyncError.trim().length > 0) {
        settingsSyncState = 'failed'
      }
    }

    const settingsSyncError = typeof record.settingsSyncError === 'string'
      ? record.settingsSyncError.trim()
      : record.settingsSyncError === null
        ? null
        : undefined
    const lastActivatedAt = typeof record.lastActivatedAt === 'string' ? record.lastActivatedAt.trim() : undefined

    return {
      version: 1,
      activeMode: 'custom',
      identity,
      snapshotId,
      databaseFile: dbFile,
      source: 'custom-local',
      schemaVersion: record.schemaVersion,
      sha256,
      byteSize,
      ...(settingsSynced !== undefined ? { settingsSynced } : {}),
      ...(settingsSyncState !== undefined ? { settingsSyncState } : {}),
      ...(settingsSyncError !== undefined ? { settingsSyncError } : {}),
      ...(lastActivatedAt !== undefined ? { lastActivatedAt } : {}),
    }
  }

  throw new TypeError(
    `Invalid activeMode: expected "managed-ecdict" or "custom", got "${String(record.activeMode)}"`,
  )
}

/**
 * Validate an unknown object against the {@link InstalledEcdictMetadata} schema.
 *
 * Throws detailed TypeError if any required field is missing or invalid.
 */
export function validateInstalledEcdictMetadata(raw: unknown): InstalledEcdictMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Installed ECDICT metadata must be a non-null object')
  }

  const record = raw as Record<string, unknown>

  if (record.version !== 1) {
    throw new TypeError(
      `Unsupported installed ECDICT metadata schema version: expected 1, got ${String(record.version)}`,
    )
  }

  if (typeof record.identity !== 'string' || !SAFE_IDENTITY_PATTERN.test(record.identity.trim())) {
    throw new TypeError(`Invalid installed ECDICT metadata identity: "${String(record.identity)}"`)
  }
  const identity = record.identity.trim()

  if (typeof record.databaseFile !== 'string') {
    throw new TypeError('Installed ECDICT metadata databaseFile must be a string')
  }
  const dbFile = record.databaseFile.trim()

  if (
    isAbsolute(dbFile) ||
    dbFile.includes('/') ||
    dbFile.includes('\\') ||
    basename(dbFile) !== dbFile ||
    !MANAGED_DATABASE_FILENAME_PATTERN.test(dbFile)
  ) {
    throw new TypeError(
      `Invalid installed ECDICT metadata databaseFile "${record.databaseFile}": must be a relative basename matching ${MANAGED_DATABASE_FILENAME_PATTERN.source}`,
    )
  }

  const expectedDbFile = managedDatabaseFileName(identity)
  if (dbFile !== expectedDbFile) {
    throw new TypeError(
      `Installed ECDICT metadata databaseFile "${dbFile}" does not match identity "${identity}" (expected "${expectedDbFile}")`,
    )
  }

  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
    throw new TypeError('Installed ECDICT metadata source must be an object')
  }
  const source = record.source as Record<string, unknown>

  if (typeof source.name !== 'string' || source.name.trim().length === 0) {
    throw new TypeError('Installed ECDICT metadata source.name must be a non-empty string')
  }
  if (typeof source.commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(source.commit.trim())) {
    throw new TypeError('Installed ECDICT metadata source.commit must be a 40-character hex commit string')
  }
  if (typeof source.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(source.sha256.trim())) {
    throw new TypeError('Installed ECDICT metadata source.sha256 must be a 64-character hex string')
  }
  if (typeof source.schemaVersion !== 'number' || !Number.isInteger(source.schemaVersion) || source.schemaVersion < 1) {
    throw new TypeError('Installed ECDICT metadata source.schemaVersion must be a positive integer >= 1')
  }

  const entryCount =
    typeof record.entryCount === 'number' && Number.isInteger(record.entryCount) && record.entryCount >= 0
      ? record.entryCount
      : undefined
  const formCount =
    typeof record.formCount === 'number' && Number.isInteger(record.formCount) && record.formCount >= 0
      ? record.formCount
      : undefined
  const byteSize =
    typeof record.byteSize === 'number' && Number.isInteger(record.byteSize) && record.byteSize > 0
      ? record.byteSize
      : undefined
  const installedAt = typeof record.installedAt === 'string' ? record.installedAt.trim() : undefined

  return {
    version: 1,
    identity,
    databaseFile: dbFile,
    source: {
      name: source.name.trim(),
      commit: source.commit.trim().toLowerCase(),
      sha256: source.sha256.trim().toLowerCase(),
      schemaVersion: source.schemaVersion,
    },
    ...(entryCount !== undefined ? { entryCount } : {}),
    ...(formCount !== undefined ? { formCount } : {}),
    ...(byteSize !== undefined ? { byteSize } : {}),
    ...(installedAt !== undefined ? { installedAt } : {}),
  }
}

/**
 * Read and validate installed ECDICT inventory metadata from `<home>/storages/dsh-word-lookup/installed-ecdict.json`.
 *
 * Fallback backward compatibility:
 * - If `installed-ecdict.json` does not exist (ENOENT): inspects `active.json`. If `active.json` contains
 *   a valid `managed-ecdict` entry, derives the installed metadata record to preserve upgrade continuity.
 * - Returns `null` if neither file exists.
 *
 * @param paths - resolved managed storage paths.
 * @returns validated installed metadata, or `null`.
 */
export async function readInstalledEcdictMetadata(
  paths: ManagedStoragePaths,
): Promise<InstalledEcdictMetadata | null> {
  let content: string
  try {
    content = await readFile(paths.installedEcdictPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const activeMeta = await readActiveMetadata(paths)
        if (activeMeta && activeMeta.activeMode === 'managed-ecdict') {
          return {
            version: 1,
            identity: activeMeta.identity,
            databaseFile: activeMeta.databaseFile,
            source: activeMeta.source,
            installedAt: activeMeta.lastActivatedAt,
          }
        }
      } catch {
        // ignore fallback errors
      }
      return null
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (cause) {
    throw new Error(
      `Malformed installed ECDICT metadata JSON at ${paths.installedEcdictPath}: ${String(cause)}`,
      { cause },
    )
  }

  return validateInstalledEcdictMetadata(parsed)
}

/**
 * Atomically write installed ECDICT inventory metadata to `<home>/storages/dsh-word-lookup/installed-ecdict.json`.
 *
 * @param paths - resolved managed storage paths.
 * @param metadata - valid installed inventory metadata.
 */
export async function writeInstalledEcdictMetadataAtomically(
  paths: ManagedStoragePaths,
  metadata: InstalledEcdictMetadata,
): Promise<void> {
  const validated = validateInstalledEcdictMetadata(metadata)
  const serialized = JSON.stringify(validated, null, 2) + '\n'

  await ensureManagedStorageDirectories(paths)

  const tempName = `installed-ecdict.json.tmp-${randomUUID()}`
  const tempPath = join(paths.storageDirectory, tempName)

  const doWriteFile = storageFsHooks?.writeFile ?? writeFile
  const doRename = storageFsHooks?.rename ?? rename
  const doUnlink = storageFsHooks?.unlink ?? unlink

  try {
    await doWriteFile(tempPath, serialized, {
      encoding: 'utf8',
      flush: true,
    })
    await doRename(tempPath, paths.installedEcdictPath)
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
 * Remove installed ECDICT inventory metadata file (`installed-ecdict.json`).
 * Idempotent: ignores ENOENT.
 *
 * @param paths - resolved managed storage paths.
 */
export async function removeInstalledEcdictMetadata(paths: ManagedStoragePaths): Promise<void> {
  const doUnlink = storageFsHooks?.unlink ?? unlink
  try {
    await doUnlink(paths.installedEcdictPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
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
  const targetDirs = [paths.storageDirectory, paths.databaseDirectory, paths.sourceCacheDirectory, paths.customSnapshotDirectory]

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
