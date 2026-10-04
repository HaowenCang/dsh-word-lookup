/**
 * Shared corpus source artifact verification and header validation library.
 *
 * Implements strict Phase 6.1 source-byte provenance binding:
 * - Deterministic SHA-256 and size verification of raw source artifacts.
 * - Fail-closed manifest parsing and validation.
 * - Exact 13-column RFC 4180 header schema enforcement (with clean UTF-8 BOM stripping).
 *
 * @module dsh-word-lookup/scripts/lib/corpus-source
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { StreamingCsvParser } from '../../src/host/csv-parser.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DEFAULT_MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
export const DEFAULT_SOURCE_PATH = join(ROOT, '.cache', 'corpus', 'ecdict.csv')

/** Pinned expected ECDICT CSV column names in exact order. */
export const EXPECTED_CORPUS_HEADER = [
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
]

/**
 * Load and validate the pinned corpus manifest.
 *
 * @param {string} [manifestPath] - path to ecdict.manifest.json.
 * @returns {object} parsed and validated manifest.
 */
export function loadCorpusManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Corpus manifest not found at ${manifestPath}`)
  }
  const content = readFileSync(manifestPath, 'utf8')
  let manifest
  try {
    manifest = JSON.parse(content)
  } catch (err) {
    throw new Error(`Corpus manifest at ${manifestPath} is not valid JSON: ${err.message}`)
  }

  if (!manifest.sourceSha256 || typeof manifest.sourceSha256 !== 'string' || manifest.sourceSha256.length !== 64) {
    throw new Error(`Corpus manifest at ${manifestPath} missing valid 64-char sourceSha256`)
  }
  if (!manifest.sourceByteSize || typeof manifest.sourceByteSize !== 'number' || manifest.sourceByteSize <= 0) {
    throw new Error(`Corpus manifest at ${manifestPath} missing positive sourceByteSize`)
  }
  if (!manifest.sourceCommit || typeof manifest.sourceCommit !== 'string' || manifest.sourceCommit.length < 7) {
    throw new Error(`Corpus manifest at ${manifestPath} missing valid sourceCommit`)
  }
  if (manifest.schemaVersion === undefined || typeof manifest.schemaVersion !== 'number') {
    throw new Error(`Corpus manifest at ${manifestPath} missing valid integer schemaVersion`)
  }

  return manifest
}

/**
 * Compute the SHA-256 hash of a file or stream.
 *
 * @param {string} filePath - path of the file to hash.
 * @returns {Promise<{ actualByteSize: number, actualSha256: string }>}
 */
export async function hashFile(filePath) {
  const stats = statSync(filePath)
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return {
    actualByteSize: stats.size,
    actualSha256: hash.digest('hex'),
  }
}

/**
 * Verify source artifact exists, matches expected size, and matches expected SHA-256 byte-for-byte.
 *
 * @param {string} [sourcePath] - path to raw source file (.cache/corpus/ecdict.csv).
 * @param {object} [manifest] - manifest object (loaded from DEFAULT_MANIFEST_PATH if omitted).
 * @returns {Promise<{ actualByteSize: number, actualSha256: string }>}
 */
export async function verifyCorpusSource(sourcePath = DEFAULT_SOURCE_PATH, manifest = null) {
  const effectiveManifest = manifest ?? loadCorpusManifest()

  if (!existsSync(sourcePath)) {
    throw new Error(`source artifact not found at ${sourcePath}; run "npm run corpus:fetch" first`)
  }

  const stats = statSync(sourcePath)
  if (!stats.isFile()) {
    throw new Error(`source artifact at ${sourcePath} is not a regular file`)
  }

  if (effectiveManifest.sourceByteSize && stats.size !== effectiveManifest.sourceByteSize) {
    throw new Error(
      `source artifact size mismatch: expected ${effectiveManifest.sourceByteSize} bytes, found ${stats.size} bytes`,
    )
  }

  const { actualByteSize, actualSha256 } = await hashFile(sourcePath)

  if (actualSha256 !== effectiveManifest.sourceSha256) {
    throw new Error(
      `source artifact SHA-256 MISMATCH! Expected ${effectiveManifest.sourceSha256}, got ${actualSha256}`,
    )
  }

  return {
    actualByteSize,
    actualSha256,
  }
}

/**
 * Validate that an observed CSV header row matches the pinned 13-column schema exactly.
 *
 * Allows and strips a UTF-8 BOM on the first column name only.
 * Throws with "BLOCKED — CORPUS HEADER MISMATCH" on any deviation.
 *
 * @param {string[]} row - header row parsed from CSV.
 * @returns {string[]} sanitized header row with BOM stripped.
 */
export function validateCorpusHeader(row) {
  if (!Array.isArray(row)) {
    throw new Error('BLOCKED — CORPUS HEADER MISMATCH: header row must be an array')
  }

  const sanitized = [...row]
  if (sanitized.length > 0 && typeof sanitized[0] === 'string' && sanitized[0].charCodeAt(0) === 0xfeff) {
    sanitized[0] = sanitized[0].slice(1)
  }

  if (sanitized.length !== EXPECTED_CORPUS_HEADER.length) {
    throw new Error(
      `BLOCKED — CORPUS HEADER MISMATCH: expected ${EXPECTED_CORPUS_HEADER.length} columns, observed ${sanitized.length} ` +
        `[expected: ${EXPECTED_CORPUS_HEADER.join(',')}; observed: ${sanitized.join(',')}]`,
    )
  }

  for (let i = 0; i < EXPECTED_CORPUS_HEADER.length; i += 1) {
    if (sanitized[i] !== EXPECTED_CORPUS_HEADER[i]) {
      throw new Error(
        `BLOCKED — CORPUS HEADER MISMATCH: column ${i} mismatch; expected "${EXPECTED_CORPUS_HEADER[i]}", observed "${sanitized[i]}" ` +
          `[expected: ${EXPECTED_CORPUS_HEADER.join(',')}; observed: ${sanitized.join(',')}]`,
      )
    }
  }

  return sanitized
}

/**
 * Read the first row from a CSV file and validate it against the expected corpus header.
 *
 * Uses StreamingCsvParser with fatal UTF-8 decoding to ensure even the header is verified
 * before any database mutations occur.
 *
 * @param {string} sourcePath - path to CSV file.
 * @returns {Promise<string[]>} verified header columns.
 */
export async function preflightCorpusHeader(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`source artifact not found at ${sourcePath}`)
  }

  let observedHeader = null
  let parseError = null

  await new Promise((resolve, reject) => {
    const stream = createReadStream(sourcePath, { highWaterMark: 64 * 1024 })
    const parser = new StreamingCsvParser((row) => {
      if (observedHeader === null) {
        observedHeader = row
        stream.destroy()
        resolve(null)
      }
    })

    stream.on('data', (chunk) => {
      try {
        parser.push(chunk)
      } catch (err) {
        parseError = err
        stream.destroy()
        reject(err)
      }
    })

    stream.on('error', (err) => {
      reject(err)
    })

    stream.on('close', () => {
      if (observedHeader !== null) {
        resolve(null)
      } else if (!parseError) {
        reject(new Error('BLOCKED — CORPUS HEADER MISMATCH: empty CSV source file'))
      }
    })
  })

  if (!observedHeader) {
    throw new Error('BLOCKED — CORPUS HEADER MISMATCH: could not extract header row')
  }

  return validateCorpusHeader(observedHeader)
}
