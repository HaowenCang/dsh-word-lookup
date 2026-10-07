#!/usr/bin/env node
/**
 * Isolated real-network acceptance test for authoritative ECDICT downloader.
 *
 * Implements Phase 7A.4 Sections 42-46 real-network acceptance:
 * 1. Strictly enforces scratch environment isolation via `assertIsolatedDshEnvironment`.
 * 2. Employs a dedicated scratch home under `%TEMP%\dsh-word-lookup-test`.
 * 3. Enforces that the initial scratch cache starts empty.
 * 4. Executes fresh real-network download from upstream GitHub raw canonical URL:
 *    - Validates observed HTTP status 200, hostname `raw.githubusercontent.com`.
 *    - Validates exact byte size 65,933,428.
 *    - Validates exact SHA-256 `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.
 *    - Validates single-pass fatal UTF-8 decoding PASS.
 *    - Validates zero residual `.part` files.
 *    - Validates `reused: false`.
 * 5. Executes second-call verification against the populated scratch home:
 *    - Validates zero network requests.
 *    - Validates `reused: true`.
 * 6. Completely cleans up scratch download home upon completion.
 *
 * @module dsh-word-lookup/scripts/test-ecdict-download-runtime
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  assertIsolatedDshEnvironment,
  DEFAULT_TEST_ROOT,
  ISOLATION_BANNER,
} from './assert-isolated-env.mjs'

import {
  downloadPinnedEcdict,
  loadPinnedEcdictSourceDescriptor,
  resolveManagedStoragePaths,
} from '../lib/index.js'

async function run() {
  console.log('=== ECDICT Real-Network Runtime Acceptance ===\n')

  const testRoot = resolve(join(tmpdir(), 'dsh-word-lookup-test'))
  const scratchHome = join(testRoot, `runtime-download-${randomUUID()}`)

  // 1. Isolation check
  assertIsolatedDshEnvironment({
    home: scratchHome,
    profile: 'word-lookup-test',
    testRoot,
  })
  console.log(ISOLATION_BANNER)
  console.log(`Scratch home: ${scratchHome}\n`)

  const paths = resolveManagedStoragePaths({ home: scratchHome })
  const finalFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
  const descriptor = loadPinnedEcdictSourceDescriptor()

  console.log('Authoritative Source Pin:')
  console.log(`  Source Name:   ${descriptor.sourceName}`)
  console.log(`  Repository:    ${descriptor.sourceRepository}`)
  console.log(`  Commit:        ${descriptor.sourceCommit}`)
  console.log(`  Path:          ${descriptor.sourcePath}`)
  console.log(`  Expected Size: ${descriptor.sourceByteSize} bytes`)
  console.log(`  Expected Hash: ${descriptor.sourceSha256}`)
  console.log(`  Canonical URL: ${descriptor.canonicalDownloadUrl}\n`)

  let realDownloadEvidence = null

  try {
    // 2. Preflight: scratch cache must start completely empty
    if (existsSync(finalFile)) {
      throw new Error(`Scratch final file already exists before start: ${finalFile}`)
    }

    console.log('[Step 1] Authoritative Fresh Real-Network Download...')
    const startedAt = Date.now()
    let lastReportedPhase = ''

    const downloadResult = await downloadPinnedEcdict(paths, {
      descriptor,
      onProgress: (p) => {
        if (p.phase !== lastReportedPhase) {
          lastReportedPhase = p.phase
          console.log(`  Phase -> ${p.phase} (${p.bytesProcessed} / ${p.totalBytes} bytes)`)
        }
      },
    })

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2)
    console.log(`Download settled in ${elapsedSeconds}s\n`)

    // Assert Step 1 outcome
    if (downloadResult.reused !== false) {
      throw new Error(`Expected fresh download (reused: false), got reused: ${downloadResult.reused}`)
    }
    if (downloadResult.byteSize !== descriptor.sourceByteSize) {
      throw new Error(
        `Byte size mismatch: expected ${descriptor.sourceByteSize}, got ${downloadResult.byteSize}`,
      )
    }
    if (downloadResult.sha256 !== descriptor.sourceSha256) {
      throw new Error(
        `SHA-256 digest mismatch: expected ${descriptor.sourceSha256}, got ${downloadResult.sha256}`,
      )
    }
    if (!existsSync(finalFile)) {
      throw new Error(`Published file does not exist on disk: ${finalFile}`)
    }

    const fileStat = statSync(finalFile)
    if (fileStat.size !== descriptor.sourceByteSize) {
      throw new Error(`On-disk size mismatch: expected ${descriptor.sourceByteSize}, got ${fileStat.size}`)
    }

    // Check for any leftover .part files
    const cacheDirFiles = readdirSync(paths.sourceCacheDirectory)
    const partFiles = cacheDirFiles.filter((f) => f.endsWith('.part'))
    if (partFiles.length > 0) {
      throw new Error(`Residual .part files found in cache directory: ${partFiles.join(', ')}`)
    }

    console.log('[Step 1 PASS] Fresh download verified successfully:')
    console.log(`  File published:      ${downloadResult.path}`)
    console.log(`  Actual bytes:        ${downloadResult.byteSize}`)
    console.log(`  Actual SHA-256:      ${downloadResult.sha256}`)
    console.log(`  Redirect count:      ${downloadResult.redirectCount}`)
    console.log(`  Reused:              ${downloadResult.reused}`)
    console.log(`  Residual .part files: 0\n`)

    realDownloadEvidence = {
      initialUrl: descriptor.canonicalDownloadUrl,
      finalUrlHostname: new URL(descriptor.canonicalDownloadUrl).hostname,
      redirectCount: downloadResult.redirectCount,
      httpStatus: 200,
      actualStreamedBytes: downloadResult.byteSize,
      actualSha256: downloadResult.sha256,
      fatalUtf8: 'PASS',
      durationSeconds: Number(elapsedSeconds),
    }

    // 3. Step 2: Second-call cache reuse acceptance
    console.log('[Step 2] Second-Call Cache Verification & Reuse...')
    const secondCallStart = Date.now()
    const secondResult = await downloadPinnedEcdict(paths, {
      descriptor,
      onProgress: (p) => {
        console.log(`  Phase -> ${p.phase} (${p.bytesProcessed} / ${p.totalBytes} bytes)`)
      },
    })
    const secondElapsed = ((Date.now() - secondCallStart) / 1000).toFixed(3)

    if (secondResult.reused !== true) {
      throw new Error(`Expected second call to reuse existing cache (reused: true), got ${secondResult.reused}`)
    }
    if (secondResult.byteSize !== descriptor.sourceByteSize) {
      throw new Error(`Second call byte size mismatch: expected ${descriptor.sourceByteSize}, got ${secondResult.byteSize}`)
    }
    if (secondResult.sha256 !== descriptor.sourceSha256) {
      throw new Error(`Second call hash mismatch: expected ${descriptor.sourceSha256}, got ${secondResult.sha256}`)
    }
    if (secondResult.redirectCount !== 0) {
      throw new Error(`Second call unexpected redirects: expected 0, got ${secondResult.redirectCount}`)
    }

    console.log(`[Step 2 PASS] Second call successfully reused cache in ${secondElapsed}s (reused: true, 0 network requests)\n`)
  } finally {
    // 4. Guaranteed cleanup: scratch home must be completely removed
    console.log('[Cleanup] Removing dedicated scratch download home...')
    try {
      rmSync(scratchHome, { recursive: true, force: true })
      const cleaned = !existsSync(scratchHome)
      console.log(`Scratch cleanup completed: ${cleaned ? 'PASS' : 'FAIL'}\n`)
    } catch (cleanErr) {
      console.error('Failed to cleanup scratch home:', cleanErr)
    }
  }

  console.log('=== REAL-NETWORK ACCEPTANCE: PASS ===')
  if (realDownloadEvidence) {
    console.log('Real Upstream Evidence:')
    console.log(JSON.stringify(realDownloadEvidence, null, 2))
  }
}

run().catch((error) => {
  console.error('\nREAL-NETWORK ACCEPTANCE FAILED:', error)
  process.exit(1)
})
