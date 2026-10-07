/**
 * Pinned ECDICT corpus source manifest reader, validator, and canonical source descriptor.
 *
 * Implements strict Phase 7A.4 source-byte provenance binding:
 * - Locates packaged `corpus/ecdict.manifest.json` relative to package installation root.
 * - Parses and strictly validates manifest schema, repo identity, commit, hash, and byte bounds.
 * - Produces canonical immutable source descriptor with canonical raw GitHub download URL.
 * - Enforces absolute security ceiling on declared corpus byte size (<= 128 MiB).
 * - Bridgeable to `ActiveMetadataSource` for future Phase 7A.5/7A.6 database management.
 *
 * Invariants:
 * - Single source of truth: corpus identity is loaded exclusively from the packaged manifest.
 * - Immutable pins: no configuration, settings, query parameter, environment variable,
 *   or user payload can alter the source repository, commit, path, SHA-256, or byte size.
 * - Zero network access: this module only inspects local packaged files and constructs descriptors.
 *
 * @module dsh-word-lookup/host/ecdict-source
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { findPackageRoot } from './fixture-db.js'
import type { ActiveMetadataSource } from './managed-storage.js'

/** Canonical ECDICT corpus source name. */
export const ALLOWED_SOURCE_NAME = 'ECDICT'

/** Pinned authoritative repository URL. */
export const ALLOWED_SOURCE_REPOSITORY = 'https://github.com/skywind3000/ECDICT'

/** Pinned authoritative repository file path. */
export const ALLOWED_SOURCE_PATH = 'ecdict.csv'

/** Strict network hostname allowlist for canonical downloads. */
export const ALLOWED_DOWNLOAD_HOSTNAME = 'raw.githubusercontent.com'

/** Absolute security ceiling for corpus byte size (128 MiB = 134,217,728 bytes). */
export const MAX_MANIFEST_BYTE_SIZE = 128 * 1024 * 1024

/** Expected relative directory of the packaged manifest within the package. */
export const CORPUS_DIRECTORY = 'corpus'

/** Packaged manifest file basename. */
export const MANIFEST_FILE_NAME = 'ecdict.manifest.json'

/** Exact 40-character hexadecimal commit hash pattern. */
export const COMMIT_HASH_PATTERN = /^[0-9a-fA-F]{40}$/

/** Exact 64-character hexadecimal SHA-256 hash pattern. */
export const SHA256_HASH_PATTERN = /^[0-9a-fA-F]{64}$/

/**
 * Pinned, immutable ECDICT source descriptor.
 */
export interface EcdictSourceDescriptor {
  /** Pinned source name (must be 'ECDICT'). */
  readonly sourceName: 'ECDICT'
  /** Pinned source repository (must be 'https://github.com/skywind3000/ECDICT'). */
  readonly sourceRepository: string
  /** Pinned 40-character lowercase hexadecimal Git commit hash. */
  readonly sourceCommit: string
  /** Pinned corpus filename inside the repository (must be 'ecdict.csv'). */
  readonly sourcePath: string
  /** Pinned 64-character lowercase hexadecimal SHA-256 digest. */
  readonly sourceSha256: string
  /** Pinned exact byte size of the raw uncompressed corpus. */
  readonly sourceByteSize: number
  /** Schema version of the manifest (must be 1). */
  readonly schemaVersion: number
  /** Canonical, validated HTTPS raw GitHub download URL. */
  readonly canonicalDownloadUrl: string
}

/**
 * Options for locating and loading the packaged ECDICT manifest.
 */
export interface LoadEcdictManifestOptions {
  /** Explicit manifest file path override (test-only). */
  readonly manifestPath?: string
  /** Module file URL used to locate package root (defaults to this module's import.meta.url). */
  readonly fromUrl?: string
}

/**
 * Resolve the absolute filesystem path to the packaged `corpus/ecdict.manifest.json`.
 *
 * Walks up directory hierarchy from `fromUrl` to find `package.json`, then
 * joins with `corpus/ecdict.manifest.json`.
 *
 * @param fromUrl - module URL to start search from (defaults to import.meta.url).
 * @returns absolute normalized path to manifest.
 */
export function resolvePackagedManifestPath(fromUrl: string = import.meta.url): string {
  const root = findPackageRoot(fromUrl)
  const manifestPath = join(root, CORPUS_DIRECTORY, MANIFEST_FILE_NAME)
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    throw new Error(`Packaged ECDICT manifest not found at: ${manifestPath}`)
  }
  return manifestPath
}

/**
 * Validate an unknown object against the authoritative ECDICT manifest contract.
 *
 * Throws TypeError with descriptive message if any field fails strict validation.
 *
 * @param raw - parsed JSON value from manifest.
 * @returns frozen, immutable {@link EcdictSourceDescriptor}.
 */
export function validateEcdictManifest(raw: unknown): EcdictSourceDescriptor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('ECDICT manifest must be a non-null object')
  }

  const record = raw as Record<string, unknown>

  if (record.sourceName !== ALLOWED_SOURCE_NAME) {
    throw new TypeError(`Invalid manifest sourceName: expected "${ALLOWED_SOURCE_NAME}", got "${String(record.sourceName)}"`)
  }

  if (record.sourceRepository !== ALLOWED_SOURCE_REPOSITORY) {
    throw new TypeError(
      `Invalid manifest sourceRepository: expected "${ALLOWED_SOURCE_REPOSITORY}", got "${String(record.sourceRepository)}"`,
    )
  }

  if (record.sourcePath !== ALLOWED_SOURCE_PATH) {
    throw new TypeError(`Invalid manifest sourcePath: expected "${ALLOWED_SOURCE_PATH}", got "${String(record.sourcePath)}"`)
  }

  if (typeof record.sourceCommit !== 'string' || !COMMIT_HASH_PATTERN.test(record.sourceCommit.trim())) {
    throw new TypeError(
      `Invalid manifest sourceCommit: must be a 40-character hex commit string, got "${String(record.sourceCommit)}"`,
    )
  }
  const sourceCommit = record.sourceCommit.trim().toLowerCase()

  if (typeof record.sourceSha256 !== 'string' || !SHA256_HASH_PATTERN.test(record.sourceSha256.trim())) {
    throw new TypeError(
      `Invalid manifest sourceSha256: must be a 64-character hex digest, got "${String(record.sourceSha256)}"`,
    )
  }
  const sourceSha256 = record.sourceSha256.trim().toLowerCase()

  if (
    typeof record.sourceByteSize !== 'number' ||
    !Number.isSafeInteger(record.sourceByteSize) ||
    record.sourceByteSize <= 0
  ) {
    throw new TypeError(
      `Invalid manifest sourceByteSize: must be a positive safe integer, got ${String(record.sourceByteSize)}`,
    )
  }
  const sourceByteSize = record.sourceByteSize

  if (sourceByteSize > MAX_MANIFEST_BYTE_SIZE) {
    throw new TypeError(
      `Manifest sourceByteSize ${sourceByteSize} exceeds maximum security ceiling of ${MAX_MANIFEST_BYTE_SIZE} bytes (128 MiB)`,
    )
  }

  if (
    typeof record.schemaVersion !== 'number' ||
    !Number.isSafeInteger(record.schemaVersion) ||
    record.schemaVersion !== 1
  ) {
    throw new TypeError(`Invalid manifest schemaVersion: expected 1, got ${String(record.schemaVersion)}`)
  }

  // Construct canonical raw download URL
  const canonicalDownloadUrl = `https://${ALLOWED_DOWNLOAD_HOSTNAME}/skywind3000/ECDICT/${sourceCommit}/${ALLOWED_SOURCE_PATH}`

  // Re-verify canonical URL structure
  const parsedUrl = new URL(canonicalDownloadUrl)
  if (parsedUrl.protocol !== 'https:') {
    throw new TypeError(`Canonical URL must use https:, got "${parsedUrl.protocol}"`)
  }
  if (parsedUrl.hostname !== ALLOWED_DOWNLOAD_HOSTNAME) {
    throw new TypeError(`Canonical URL host mismatch: expected "${ALLOWED_DOWNLOAD_HOSTNAME}", got "${parsedUrl.hostname}"`)
  }

  return Object.freeze({
    sourceName: 'ECDICT',
    sourceRepository: ALLOWED_SOURCE_REPOSITORY,
    sourceCommit,
    sourcePath: ALLOWED_SOURCE_PATH,
    sourceSha256,
    sourceByteSize,
    schemaVersion: 1,
    canonicalDownloadUrl,
  })
}

/**
 * Load and validate the authoritative ECDICT source descriptor.
 *
 * Reads `corpus/ecdict.manifest.json` from the package tree (or explicit test path)
 * and produces a frozen {@link EcdictSourceDescriptor}.
 *
 * @param options - optional explicit manifest path or fromUrl.
 * @returns validated, frozen descriptor.
 */
export function loadPinnedEcdictSourceDescriptor(options?: LoadEcdictManifestOptions): EcdictSourceDescriptor {
  const manifestPath = options?.manifestPath ?? resolvePackagedManifestPath(options?.fromUrl)

  let content: string
  try {
    content = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`Failed to read ECDICT manifest at ${manifestPath}: ${String(error)}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (cause) {
    throw new Error(`Malformed ECDICT manifest JSON at ${manifestPath}: ${String(cause)}`, { cause })
  }

  return validateEcdictManifest(parsed)
}

/**
 * Convert a validated {@link EcdictSourceDescriptor} to an {@link ActiveMetadataSource}
 * compatible with Phase 7A.3 active metadata storage contracts.
 *
 * @param descriptor - validated ECDICT source descriptor.
 * @returns frozen active metadata source provenance object.
 */
export function descriptorToActiveMetadataSource(descriptor: EcdictSourceDescriptor): ActiveMetadataSource {
  return Object.freeze({
    name: descriptor.sourceName,
    commit: descriptor.sourceCommit,
    sha256: descriptor.sourceSha256,
    schemaVersion: descriptor.schemaVersion,
  })
}
