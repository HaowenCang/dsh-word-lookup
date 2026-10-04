#!/usr/bin/env node
/**
 * Pinned upstream corpus fetcher with strict SHA-256 integrity verification.
 *
 * Enforces Phase 6 provenance rules:
 * - Only downloads the pinned artifact specified in `corpus/ecdict.manifest.json`.
 * - Requires HTTPS.
 * - Streams directly to `.cache/corpus/ecdict.csv` while hashing SHA-256.
 * - Rejects any byte mismatch and deletes partial files.
 * - Prohibits silent downloads of unpinned / latest releases.
 *
 * @module dsh-word-lookup/scripts/fetch-corpus
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
const CACHE_DIR = join(ROOT, '.cache', 'corpus')
const TARGET_FILE = join(CACHE_DIR, 'ecdict.csv')

async function run() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`fetch-corpus: manifest not found at ${MANIFEST_PATH}`)
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const { sourceRepository, sourceCommit, sourcePath, sourceSha256 } = manifest

  if (!sourceCommit || !sourceSha256) {
    console.error('fetch-corpus: manifest missing required commit or sha256')
    process.exit(1)
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  // Check if target file already exists with exact hash
  if (existsSync(TARGET_FILE)) {
    console.log(`fetch-corpus: checking existing cached file at ${TARGET_FILE}...`)
    const hash = createHash('sha256')
    const buf = readFileSync(TARGET_FILE)
    hash.update(buf)
    const existingSha = hash.digest('hex')
    if (existingSha === sourceSha256) {
      console.log(`fetch-corpus: cached file verified (SHA-256: ${existingSha}). No download needed.`)
      process.exit(0)
    } else {
      console.warn(`fetch-corpus: cached file hash mismatch (${existingSha} != ${sourceSha256}). Re-downloading...`)
      rmSync(TARGET_FILE, { force: true })
    }
  }

  const url = `https://raw.githubusercontent.com/skywind3000/ECDICT/${sourceCommit}/${sourcePath}`
  console.log(`fetch-corpus: fetching pinned source artifact from ${url}...`)

  const response = await fetch(url)
  if (!response.ok) {
    console.error(`fetch-corpus: HTTP error ${response.status} ${response.statusText}`)
    process.exit(1)
  }

  const fileStream = createWriteStream(TARGET_FILE)
  const hash = createHash('sha256')
  let bytesDownloaded = 0

  for await (const chunk of response.body) {
    bytesDownloaded += chunk.length
    hash.update(chunk)
    fileStream.write(chunk)
  }
  fileStream.end()
  await new Promise((resolve) => fileStream.on('finish', resolve))

  const calculatedSha = hash.digest('hex')
  console.log(`fetch-corpus: downloaded ${bytesDownloaded} bytes. Computed SHA-256: ${calculatedSha}`)

  if (calculatedSha !== sourceSha256) {
    console.error(`fetch-corpus: FATAL SHA-256 MISMATCH! Expected ${sourceSha256}, got ${calculatedSha}`)
    rmSync(TARGET_FILE, { force: true })
    process.exit(1)
  }

  console.log('fetch-corpus: source artifact downloaded and verified successfully.')
}

run().catch((err) => {
  console.error('fetch-corpus failed:', err)
  process.exit(1)
})
