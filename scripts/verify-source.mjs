#!/usr/bin/env node
/**
 * Offline source artifact verification script.
 *
 * Checks that `.cache/corpus/ecdict.csv` exists and verifies byte-for-byte SHA-256
 * against `corpus/ecdict.manifest.json` using the shared corpus-source helper.
 *
 * @module dsh-word-lookup/scripts/verify-source
 */

import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  loadCorpusManifest,
  verifyCorpusSource,
} from './lib/corpus-source.mjs'

async function run() {
  const manifest = loadCorpusManifest(DEFAULT_MANIFEST_PATH)
  console.log(`verify-source: verifying ${DEFAULT_SOURCE_PATH} (${manifest.sourceByteSize} bytes expected)...`)
  const result = await verifyCorpusSource(DEFAULT_SOURCE_PATH, manifest)
  console.log(`verify-source: computed SHA-256: ${result.actualSha256}`)
  console.log('verify-source: PASS (source artifact SHA-256 match)')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error('verify-source failed:', err.message)
    process.exit(1)
  })
}

export { run }
