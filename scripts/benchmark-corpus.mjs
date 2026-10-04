#!/usr/bin/env node
/**
 * Process-level query latency benchmark for the production SQLite corpus.
 *
 * Implements Phase 6 benchmark requirements:
 * - Read-only database access.
 * - Measures process-level cold-ish open time.
 * - Samples query categories:
 *   - common word
 *   - rare word
 *   - mixed-case word
 *   - form
 *   - irregular form
 *   - phrase
 *   - unknown
 *   - long unknown
 * - Calculates min, median, p95, and max lookup latencies.
 * - Outputs structured report and optional JSON evidence.
 *
 * @module dsh-word-lookup/scripts/benchmark-corpus
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB_PATH = join(ROOT, 'build', 'corpus', 'ecdict.db')
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence')

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

export async function runBenchmark(iterations = 200) {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Production database not found at ${DB_PATH}; run "npm run corpus:build" first`)
  }

  console.log(`benchmark-corpus: starting process-level lookup benchmark (${iterations} iterations per sample)...`)

  const openStart = process.hrtime.bigint()
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const entryStmt = db.prepare(
    'SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?',
  )
  const formStmt = db.prepare('SELECT headword FROM forms WHERE form = ?')
  const formsByHwStmt = db.prepare('SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE')

  function lookup(query) {
    const exact = entryStmt.get(query)
    if (exact) {
      const forms = formsByHwStmt.all(exact.word)
      return { found: true, headword: exact.word, phonetic: exact.phonetic, forms }
    }
    const form = formStmt.get(query)
    if (form) {
      const inflected = entryStmt.get(form.headword)
      if (inflected) {
        const forms = formsByHwStmt.all(inflected.word)
        return { found: true, headword: inflected.word, phonetic: inflected.phonetic, forms }
      }
    }
    return { found: false, query }
  }

  // Measure first query as cold-ish
  const firstQueryStart = process.hrtime.bigint()
  lookup('conservation')
  const firstQueryDurationUs = Number(process.hrtime.bigint() - firstQueryStart) / 1000

  const openDurationMs = Number(process.hrtime.bigint() - openStart) / 1_000_000

  console.log(`  Database open duration: ${openDurationMs.toFixed(2)} ms`)
  console.log(`  First query latency (cold-ish): ${firstQueryDurationUs.toFixed(1)} µs`)

  const categoryResults = {}
  const allDurationsUs = []

  for (const [category, words] of Object.entries(SAMPLES)) {
    const durations = []

    for (let i = 0; i < iterations; i += 1) {
      for (const word of words) {
        const t0 = process.hrtime.bigint()
        const res = lookup(word)
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
  const overallMedian = allDurationsUs[Math.floor(allDurationsUs.length * 0.5)]
  const overallP95 = allDurationsUs[Math.floor(allDurationsUs.length * 0.95)]
  const overallMax = allDurationsUs[allDurationsUs.length - 1]

  console.log('------------------------------------------------------------')
  console.log(
    `  Overall benchmark summary: total queries: ${allDurationsUs.length} | median: ${overallMedian.toFixed(1)}µs | p95: ${overallP95.toFixed(1)}µs | max: ${overallMax.toFixed(1)}µs`,
  )

  db.close()

  const summary = {
    benchmarkType: 'process-level lookup benchmark',
    databasePath: 'build/corpus/ecdict.db',
    openDurationMs: Number(openDurationMs.toFixed(2)),
    firstQueryDurationUs: Number(firstQueryDurationUs.toFixed(1)),
    iterationsPerWord: iterations,
    totalQueriesExecuted: allDurationsUs.length,
    overall: {
      medianUs: Number(overallMedian.toFixed(1)),
      p95Us: Number(overallP95.toFixed(1)),
      maxUs: Number(overallMax.toFixed(1)),
    },
    categories: categoryResults,
  }

  writeFileSync(
    join(EVIDENCE_DIR, 'phase6-corpus-benchmark.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  )

  return summary
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runBenchmark().catch((err) => {
    console.error('benchmark-corpus failed:', err)
    process.exit(1)
  })
}
