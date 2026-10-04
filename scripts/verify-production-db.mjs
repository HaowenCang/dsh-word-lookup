#!/usr/bin/env node
/**
 * Production corpus database verification script.
 *
 * Verifies:
 * - Read-only open
 * - PRAGMA integrity_check
 * - Metadata keys and counts
 * - Source SHA-256 bound to manifest
 * - Source CSV verification (when available)
 * - Logical database digest
 * - Query execution plans (index usage)
 * - Required probes: go, went, gone, tooth, teeth, derive, derived, conservation, wave, function, wave function
 * - Exact canonical precedence over forms
 * - Case-insensitive lookup
 *
 * @module dsh-word-lookup/scripts/verify-production-db
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCorpusManifest, verifyCorpusSource } from './lib/corpus-source.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB_PATH = join(ROOT, 'build', 'corpus', 'ecdict.db')
const MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
const SOURCE_FILE = join(ROOT, '.cache', 'corpus', 'ecdict.csv')

export async function verifyProductionDb(options = {}) {
  console.log('verify-production-db: verifying production SQLite corpus...')

  const dbPath = options.dbPath ?? DB_PATH
  const manifestPath = options.manifestPath ?? MANIFEST_PATH
  const sourceFile = options.sourceFile ?? SOURCE_FILE

  if (!existsSync(dbPath)) {
    throw new Error(`Production database not found at ${dbPath}; run "npm run corpus:build" first`)
  }

  const manifest = loadCorpusManifest(manifestPath)
  const stats = statSync(dbPath)
  console.log(`  Database file size: ${stats.size} bytes`)

  // 1. If source CSV artifact is present, verify source SHA-256 against manifest
  if (existsSync(sourceFile)) {
    console.log(`  Verifying source artifact at ${sourceFile}...`)
    const sourceResult = await verifyCorpusSource(sourceFile, manifest)
    console.log(`  Source artifact verified: ${sourceResult.actualSha256}`)
  } else {
    console.log(`  Source artifact not present at ${sourceFile}; proceeding with database metadata audit.`)
  }

  // Open raw SQLite connection read-only for metadata & integrity inspection
  const db = new DatabaseSync(dbPath, { readOnly: true })

  // 2. PRAGMA integrity_check
  const integrityRow = db.prepare('PRAGMA integrity_check').get()
  const integrity = Object.values(integrityRow ?? {})[0]
  console.log(`  PRAGMA integrity_check: ${integrity}`)
  if (integrity !== 'ok') {
    throw new Error(`integrity_check failed: ${integrity}`)
  }

  // 3. Metadata verification
  const metaMap = new Map()
  for (const row of db.prepare('SELECT key, value FROM meta').all()) {
    metaMap.set(row.key, row.value)
  }

  console.log('  Meta table verification:')
  console.log('    schema_version:', metaMap.get('schema_version'))
  console.log('    corpus_name:', metaMap.get('corpus_name'))
  console.log('    upstream_commit:', metaMap.get('upstream_commit'))
  console.log('    source_sha256:', metaMap.get('source_sha256'))
  console.log('    entry_count:', metaMap.get('entry_count'))
  console.log('    form_count:', metaMap.get('form_count'))
  console.log('    example_count:', metaMap.get('example_count'))
  console.log('    logical_sha256:', metaMap.get('logical_sha256'))

  if (metaMap.get('schema_version') !== String(manifest.schemaVersion)) {
    throw new Error(`schema_version mismatch: expected ${manifest.schemaVersion}, found ${metaMap.get('schema_version')}`)
  }
  if (metaMap.get('corpus_name') !== 'ECDICT') {
    throw new Error(`corpus_name mismatch: expected ECDICT, found ${metaMap.get('corpus_name')}`)
  }
  if (metaMap.get('upstream_commit') !== manifest.sourceCommit) {
    throw new Error(`upstream_commit mismatch: expected ${manifest.sourceCommit}, found ${metaMap.get('upstream_commit')}`)
  }
  if (metaMap.get('source_sha256') !== manifest.sourceSha256) {
    throw new Error(`source_sha256 mismatch: expected ${manifest.sourceSha256}, found ${metaMap.get('source_sha256')}`)
  }
  if (metaMap.get('entry_count') !== '770611') {
    throw new Error(`entry_count mismatch: expected 770611, found ${metaMap.get('entry_count')}`)
  }
  if (metaMap.get('form_count') !== '57689') {
    throw new Error(`form_count mismatch: expected 57689, found ${metaMap.get('form_count')}`)
  }

  // 4. Verify Logical Digest
  console.log('  Recomputing logical digest for verification...')
  const hash = createHash('sha256')

  const dumpEntries = db.prepare(`
    SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency
    FROM entries
    ORDER BY word COLLATE NOCASE ASC
  `)
  for (const row of dumpEntries.all()) {
    hash.update(
      `entry:${row.word}\0${row.phonetic ?? ''}\0${row.definition_en ?? ''}\0${row.translation_zh ?? ''}\0${row.pos ?? ''}\0${row.exchange ?? ''}\0${row.frequency ?? ''}\n`,
    )
  }

  const dumpForms = db.prepare(`
    SELECT form, headword, kind
    FROM forms
    ORDER BY form COLLATE NOCASE ASC
  `)
  for (const row of dumpForms.all()) {
    hash.update(`form:${row.form}\0${row.headword}\0${row.kind ?? ''}\n`)
  }

  const dumpExamples = db.prepare(`
    SELECT id, headword, english, chinese, source, source_id, score
    FROM examples
    ORDER BY id ASC
  `)
  for (const row of dumpExamples.all()) {
    hash.update(
      `example:${row.id}\0${row.headword}\0${row.english}\0${row.chinese ?? ''}\0${row.source ?? ''}\0${row.source_id ?? ''}\0${row.score ?? ''}\n`,
    )
  }

  const computedLogicalSha = hash.digest('hex')
  if (computedLogicalSha !== metaMap.get('logical_sha256')) {
    throw new Error(`Logical digest mismatch! Stored: ${metaMap.get('logical_sha256')}, Computed: ${computedLogicalSha}`)
  }
  console.log('  Logical digest matches stored meta digest.')

  // 5. Query Plan Inspection (Index usage)
  console.log('  Inspecting query execution plans...')
  const plans = [
    {
      name: 'exact entry by word',
      query: 'EXPLAIN QUERY PLAN SELECT * FROM entries WHERE word = ?',
    },
    {
      name: 'form by form key',
      query: 'EXPLAIN QUERY PLAN SELECT headword FROM forms WHERE form = ?',
    },
    {
      name: 'forms by headword',
      query: 'EXPLAIN QUERY PLAN SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE',
    },
    {
      name: 'examples by headword',
      query: 'EXPLAIN QUERY PLAN SELECT * FROM examples WHERE headword = ? ORDER BY score DESC, id ASC',
    },
  ]

  for (const plan of plans) {
    const rows = db.prepare(plan.query).all('test')
    const detail = rows.map((r) => r.detail).join('; ')
    console.log(`    ${plan.name}: ${detail}`)
    if (detail.includes('SCAN') && !detail.includes('USING INDEX')) {
      throw new Error(`Query plan for "${plan.name}" does not use an index: ${detail}`)
    }
  }

  // 6. Lookup Compatibility using identical product SQL semantics
  console.log('  Testing lookup compatibility via product SQL semantics...')
  const entryStmt = db.prepare(
    'SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?',
  )
  const formStmt = db.prepare('SELECT headword FROM forms WHERE form = ?')
  const formsByHwStmt = db.prepare('SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE')

  function lookup(query) {
    const exact = entryStmt.get(query)
    if (exact) {
      const forms = formsByHwStmt.all(exact.word)
      return { found: true, headword: exact.word, phonetic: exact.phonetic, matchedForm: null, forms }
    }
    const form = formStmt.get(query)
    if (form) {
      const inflected = entryStmt.get(form.headword)
      if (inflected) {
        const forms = formsByHwStmt.all(inflected.word)
        return { found: true, headword: inflected.word, phonetic: inflected.phonetic, matchedForm: query, forms }
      }
    }
    return { found: false, query }
  }

  const probes = [
    'go',
    'went',
    'gone',
    'tooth',
    'teeth',
    'derive',
    'derived',
    'conservation',
    'wave',
    'function',
    'wave function',
  ]

  for (const probe of probes) {
    const result = lookup(probe)
    if (!result.found) {
      throw new Error(`Expected probe "${probe}" to be found in production corpus, but lookup returned not found`)
    }
    console.log(
      `    probe "${probe}" -> found headword: "${result.headword}", phonetic: ${result.phonetic ? `"${result.phonetic}"` : 'null'}, matchedForm: ${result.matchedForm ? `"${result.matchedForm}"` : 'null'}`,
    )
  }

  // Exact canonical precedence probe
  const exactResult = lookup('wave')
  if (!exactResult.found || exactResult.headword !== 'wave' || exactResult.matchedForm !== null) {
    throw new Error('Exact canonical precedence failed for "wave"')
  }

  // Phrase probe with mixed case
  const phraseResult = lookup('Wave Function')
  if (!phraseResult.found || phraseResult.headword.toLowerCase() !== 'wave function') {
    throw new Error('Phrase lookup failed for "Wave Function"')
  }

  // Unknown probe
  const unknownResult = lookup('thisworddefinitelydoesnotexistinanydictionaryxyz')
  if (unknownResult.found) {
    throw new Error('Unknown word test failed')
  }
  console.log('    probe unknown word -> correctly reported not found.')

  db.close()
  console.log('verify-production-db: ALL VERIFICATIONS PASSED.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyProductionDb().catch((err) => {
    console.error('verify-production-db failed:', err)
    process.exit(1)
  })
}
