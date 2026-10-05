#!/usr/bin/env node
/**
 * Production dictionary query latency benchmark using the real product path:
 * openProductionDictionary() → SqliteDictionary.lookup()
 *
 * Implements Phase 6.1.1 benchmark requirements:
 * - Read-only production database access.
 * - Benchmarks real product path (openProductionDictionary() -> SqliteDictionary.lookup()).
 * - Separately reports:
 *   - database open & metadata validation startup latency (ms)
 *   - steady-state lookup latency (µs)
 * - Samples query categories:
 *   - common word
 *   - rare word
 *   - mixed-case word
 *   - form
 *   - irregular form
 *   - phrase
 *   - unknown
 *   - long unknown
 * - Records min, median, p95, and max lookup latencies.
 * - Emits machine-readable evidence to docs/evidence/phase611-corpus-benchmark.json.
 *
 * @module dsh-word-lookup/scripts/benchmark-corpus
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { openProductionDictionary } from '../lib/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB_PATH = join(ROOT, 'build', 'corpus', 'ecdict.db')
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence')
const EVIDENCE_FILE_611 = join(EVIDENCE_DIR, 'phase611-corpus-benchmark.json')
const EVIDENCE_FILE_6 = join(EVIDENCE_DIR, 'phase6-corpus-benchmark.json')

const SAMPLES = {
  commonWord: ['go', 'wave', 'function', 'time', 'world'],
  rareWord: ['syzygy', 'oxymoron', 'quokka', 'zygote'],
  mixedCase: ['Go', 'WavE', 'FunCTIon', 'tEeTh', 'WaVe FuNcTiOn'],
  form: ['functions', 'waves', 'derives', 'apples'],
  irregularForm: ['went', 'teeth', 'gone', 'feet'],
  phrase: ['wave function', 'point of view', 'ice cream'],
  unknown: ['unknownprobe123xyz', 'nonexistenttermabc'],
  longUnknown: ['a'.repeat(64), 'b'.repeat(100), 'unusuallylongtoken'.repeat(5)],
}

export async function runBenchmark(iterations = 200, options = {}) {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Production database not found at ${DB_PATH}; run "npm run corpus:build" first`)
  }

  console.log(`benchmark-corpus: starting production dictionary benchmark (${iterations} iterations per word)...`)

  // 1. Measure startup: openProductionDictionary() (connection open + schema & metadata validation)
  const openStart = process.hrtime.bigint()
  const dictionary = openProductionDictionary({ path: DB_PATH })
  const openEnd = process.hrtime.bigint()
  const databaseOpenValidationMs = Number(openEnd - openStart) / 1_000_000

  console.log(`  Database open & validation duration: ${databaseOpenValidationMs.toFixed(2)} ms`)

  // Warm-up queries (5 queries)
  for (const warmupWord of ['warmup', 'test', 'run', 'dictionary', 'sqlite']) {
    dictionary.lookup(warmupWord)
  }

  // 2. Measure steady-state lookup latency through SqliteDictionary.lookup()
  const categoryResults = {}
  const allDurationsUs = []

  for (const [category, words] of Object.entries(SAMPLES)) {
    const durations = []

    for (let i = 0; i < iterations; i += 1) {
      for (const word of words) {
        const t0 = process.hrtime.bigint()
        const res = dictionary.lookup(word)
        const t1 = process.hrtime.bigint()
        const us = Number(t1 - t0) / 1000
        durations.push(us)
        allDurationsUs.push(us)
      }
    }

    durations.sort((a, b) => a - b)
    const min = durations[0]
    const median = durations[Math.floor(durations.length * 0.5)]
    const p95 = durations[Math.floor(durations.length * 0.95)]
    const max = durations[durations.length - 1]

    categoryResults[category] = {
      sampleCount: durations.length,
      minUs: Number(min.toFixed(1)),
      medianUs: Number(median.toFixed(1)),
      p95Us: Number(p95.toFixed(1)),
      maxUs: Number(max.toFixed(1)),
    }

    console.log(
      `  [${category.padEnd(14)}] samples: ${durations.length} | min: ${min.toFixed(1)}µs | median: ${median.toFixed(1)}µs | p95: ${p95.toFixed(1)}µs | max: ${max.toFixed(1)}µs`,
    )
  }

  allDurationsUs.sort((a, b) => a - b)
  const overallMin = allDurationsUs[0]
  const overallMedian = allDurationsUs[Math.floor(allDurationsUs.length * 0.5)]
  const overallP95 = allDurationsUs[Math.floor(allDurationsUs.length * 0.95)]
  const overallMax = allDurationsUs[allDurationsUs.length - 1]

  console.log('------------------------------------------------------------')
  console.log(
    `  Overall steady-state lookup summary: total queries: ${allDurationsUs.length} | min: ${overallMin.toFixed(1)}µs | median: ${overallMedian.toFixed(1)}µs | p95: ${overallP95.toFixed(1)}µs | max: ${overallMax.toFixed(1)}µs`,
  )

  dictionary.close()

  // Read DB identity
  const stats = statSync(DB_PATH)
  const dbHash = createHash('sha256').update(readFileSync(DB_PATH)).digest('hex')
  const hostBundleHash = createHash('sha256').update(readFileSync(join(ROOT, 'lib', 'index.js'))).digest('hex')

  let testedCodeGitSha = 'UNKNOWN'
  try {
    testedCodeGitSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {}

  const rawDb = new DatabaseSync(DB_PATH, { readOnly: true })
  const metaRows = rawDb.prepare('SELECT key, value FROM meta').all()
  const metaMap = new Map(metaRows.map((r) => [r.key, r.value]))
  rawDb.close()

  const summary = {
    benchmarkTarget: 'SqliteDictionary.lookup via openProductionDictionary()',
    testedCodeGitSha,
    testedHostBundleSha256: hostBundleHash,
    database: {
      path: 'build/corpus/ecdict.db',
      byteSize: stats.size,
      fileSha256: dbHash,
      logicalSha256: metaMap.get('logical_sha256'),
      sourceSha256: metaMap.get('source_sha256'),
      upstreamCommit: metaMap.get('upstream_commit'),
      entryCount: Number(metaMap.get('entry_count')),
      formCount: Number(metaMap.get('form_count')),
    },
    startupLatency: {
      databaseOpenValidationMs: Number(databaseOpenValidationMs.toFixed(2)),
      description: 'One-time startup cost to open read-only database and perform strict schema, index, and metadata validation',
    },
    steadyStateLookup: {
      iterationsPerWord: iterations,
      totalQueriesExecuted: allDurationsUs.length,
      overall: {
        minUs: Number(overallMin.toFixed(1)),
        medianUs: Number(overallMedian.toFixed(1)),
        p95Us: Number(overallP95.toFixed(1)),
        maxUs: Number(overallMax.toFixed(1)),
      },
      categories: categoryResults,
    },
  }

  if (options.out) {
    const outPath = resolve(options.out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')
    console.log(`Saved benchmark evidence to: ${outPath}`)
  } else {
    writeFileSync(EVIDENCE_FILE_611, JSON.stringify(summary, null, 2) + '\n', 'utf8')
    writeFileSync(EVIDENCE_FILE_6, JSON.stringify(summary, null, 2) + '\n', 'utf8')
    console.log(`Saved benchmark evidence to: ${EVIDENCE_FILE_611}`)
  }
  return summary
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[token.slice(2)] = 'true'
    } else {
      options[token.slice(2)] = value
      index += 1
    }
  }
  return options
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2))
  const iters = options.iterations ? Number(options.iterations) : 200
  runBenchmark(iters, options).catch((err) => {
    console.error('benchmark-corpus failed:', err)
    process.exit(1)
  })
}
