#!/usr/bin/env node
/**
 * Offline source artifact verification script.
 *
 * Checks that `.cache/corpus/ecdict.csv` exists and verifies byte-for-byte SHA-256
 * against `corpus/ecdict.manifest.json`.
 *
 * @module dsh-word-lookup/scripts/verify-source
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
const SOURCE_FILE = join(ROOT, '.cache', 'corpus', 'ecdict.csv')

async function run() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`verify-source: manifest not found at ${MANIFEST_PATH}`)
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const { sourceSha256, sourceByteSize } = manifest

  if (!existsSync(SOURCE_FILE)) {
    console.error(`verify-source: source artifact not found at ${SOURCE_FILE}; run "npm run corpus:fetch" first`)
    process.exit(1)
  }

  const stats = statSync(SOURCE_FILE)
  if (sourceByteSize && stats.size !== sourceByteSize) {
    console.error(`verify-source: size mismatch: expected ${sourceByteSize} bytes, found ${stats.size} bytes`)
    process.exit(1)
  }

  console.log(`verify-source: hashing ${SOURCE_FILE} (${stats.size} bytes)...`)
  const hash = createHash('sha256')
  const stream = createReadStream(SOURCE_FILE)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  const computedSha = hash.digest('hex')
  console.log(`verify-source: computed SHA-256: ${computedSha}`)

  if (computedSha !== sourceSha256) {
    console.error(`verify-source: SHA-256 MISMATCH! Expected ${sourceSha256}, got ${computedSha}`)
    process.exit(1)
  }

  console.log('verify-source: PASS (source artifact SHA-256 match)')
}

run().catch((err) => {
  console.error('verify-source failed:', err)
  process.exit(1)
})
