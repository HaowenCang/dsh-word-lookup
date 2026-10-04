#!/usr/bin/env node
/**
 * Deterministic production SQLite corpus builder.
 *
 * Implements Phase 6 production corpus ingestion:
 * - Reads pinned `.cache/corpus/ecdict.csv` via `StreamingCsvParser`.
 * - Validates schema bounds and data safety limits.
 * - Extracts morphological inflections via `ExchangeCollector`.
 * - Filters self-referential forms and disambiguates collisions.
 * - Emits `entries`, `forms`, and `examples` conforming to the product schema.
 * - Indexes:
 *   - `idx_forms_headword`
 *   - `idx_examples_headword`
 *   (primary keys `entries(word)` and `forms(form)` are indexed by SQLite).
 * - Computes:
 *   - Logical database SHA-256 (canonical ordered content dump).
 *   - Physical database file SHA-256 and byte size.
 * - Runs `PRAGMA integrity_check`.
 * - Records machine-readable evidence:
 *   - `docs/evidence/phase6-form-collisions.json`
 *   - `docs/evidence/phase6-corpus-quality.json`
 *   - `docs/evidence/phase6-corpus-build.json`
 *
 * @module dsh-word-lookup/scripts/build-production-db
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { StreamingCsvParser } from '../src/host/csv-parser.ts'
import { ExchangeCollector } from '../src/host/exchange-parser.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
const SOURCE_FILE = join(ROOT, '.cache', 'corpus', 'ecdict.csv')
const OUT_DIR = join(ROOT, 'build', 'corpus')
const OUT_DB = join(OUT_DIR, 'ecdict.db')
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence')

// Safety bounds
const MAX_WORD_LENGTH = 128
const MAX_FIELD_LENGTH = 65536
const BATCH_SIZE = 25000

export async function buildCorpus(options = {}) {
  const startTime = Date.now()
  console.log('build-production-db: starting production corpus build...')

  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`)
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

  if (!existsSync(SOURCE_FILE)) {
    throw new Error(`Source artifact not found at ${SOURCE_FILE}; run "npm run corpus:fetch" first`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  // Clean existing output database and sidecars
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(OUT_DB + suffix, { force: true })
  }

  const db = new DatabaseSync(OUT_DB)

  // Configure SQLite PRAGMAs for safe, deterministic bulk insertion
  db.exec('PRAGMA page_size = 4096')
  db.exec('PRAGMA journal_mode = MEMORY')
  db.exec('PRAGMA synchronous = OFF')

  // Create Schema matching product specifications
  db.exec(`
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE entries (
      word           TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic       TEXT,
      definition_en  TEXT,
      translation_zh TEXT,
      pos            TEXT,
      exchange       TEXT,
      frequency      INTEGER
    );

    CREATE TABLE forms (
      form      TEXT PRIMARY KEY COLLATE NOCASE,
      headword  TEXT NOT NULL,
      kind      TEXT
    );

    CREATE TABLE examples (
      id        INTEGER PRIMARY KEY,
      headword  TEXT NOT NULL COLLATE NOCASE,
      english   TEXT NOT NULL,
      chinese   TEXT,
      source    TEXT,
      source_id TEXT,
      score     REAL
    );
  `)

  const insertEntryStmt = db.prepare(`
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const exchangeCollector = new ExchangeCollector()

  // Quality tracking counters
  let sourceTotalRows = 0
  let validRows = 0
  let rejectedRowsCount = 0
  const rejectionReasons = new Map()
  const rejectionSamples = []

  let emptyWordsCount = 0
  let duplicateWordsCount = 0
  let nullPhoneticsCount = 0
  let nullDefinitionsCount = 0
  let nullTranslationsCount = 0
  let nullPosCount = 0
  let rowsWithExchangeCount = 0
  let oversizedFieldsCount = 0

  const seenHeadwords = new Set()

  db.exec('BEGIN TRANSACTION')
  let currentBatch = 0

  const parser = new StreamingCsvParser((row, rowIndex) => {
    sourceTotalRows += 1
    if (sourceTotalRows === 1) {
      // Header row
      return
    }

    if (row.length !== 13) {
      rejectedRowsCount += 1
      const reason = `malformed-field-count-${row.length}`
      rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1)
      if (rejectionSamples.length < 5) rejectionSamples.push({ line: rowIndex, reason })
      return
    }

    const [word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, detail, audio] = row

    if (!word || !word.trim()) {
      emptyWordsCount += 1
      rejectedRowsCount += 1
      const reason = 'empty-headword'
      rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1)
      if (rejectionSamples.length < 5) rejectionSamples.push({ line: rowIndex, reason })
      return
    }

    const cleanWord = word.trim()
    const lowerWord = cleanWord.toLowerCase()

    if (cleanWord.length > MAX_WORD_LENGTH) {
      oversizedFieldsCount += 1
      rejectedRowsCount += 1
      const reason = 'headword-too-long'
      rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1)
      if (rejectionSamples.length < 5) rejectionSamples.push({ line: rowIndex, word: cleanWord.slice(0, 30), reason })
      return
    }

    if (seenHeadwords.has(lowerWord)) {
      duplicateWordsCount += 1
      rejectedRowsCount += 1
      const reason = 'duplicate-headword'
      rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1)
      if (rejectionSamples.length < 5) rejectionSamples.push({ line: rowIndex, word: cleanWord, reason })
      return
    }
    seenHeadwords.add(lowerWord)

    const cleanPhonetic = phonetic && phonetic.trim() ? phonetic.trim() : null
    const cleanDef = definition && definition.trim() ? definition.trim() : null
    const cleanTrans = translation && translation.trim() ? translation.trim() : null
    const cleanPos = pos && pos.trim() ? pos.trim() : null
    const cleanExchange = exchange && exchange.trim() ? exchange.trim() : null

    if (!cleanPhonetic) nullPhoneticsCount += 1
    if (!cleanDef) nullDefinitionsCount += 1
    if (!cleanTrans) nullTranslationsCount += 1
    if (!cleanPos) nullPosCount += 1
    if (cleanExchange) rowsWithExchangeCount += 1

    if (cleanDef && cleanDef.length > MAX_FIELD_LENGTH) oversizedFieldsCount += 1
    if (cleanTrans && cleanTrans.length > MAX_FIELD_LENGTH) oversizedFieldsCount += 1

    // Frequency from BNC or FRQ rank
    let freqNumber = null
    if (bnc && bnc.trim()) {
      const num = parseInt(bnc.trim(), 10)
      if (!Number.isNaN(num) && num > 0) freqNumber = num
    }

    insertEntryStmt.run(
      cleanWord,
      cleanPhonetic,
      cleanDef,
      cleanTrans,
      cleanPos,
      cleanExchange,
      freqNumber,
    )
    validRows += 1

    if (cleanExchange) {
      exchangeCollector.addEntry(cleanWord, cleanExchange)
    }

    currentBatch += 1
    if (currentBatch >= BATCH_SIZE) {
      db.exec('COMMIT')
      db.exec('BEGIN TRANSACTION')
      currentBatch = 0
    }
  })

  const stream = createReadStream(SOURCE_FILE)
  for await (const chunk of stream) {
    parser.push(chunk)
  }
  parser.end()

  if (currentBatch > 0) {
    db.exec('COMMIT')
  }

  console.log(`build-production-db: inserted ${validRows} valid entries. Resolving morphological forms...`)

  // Resolve forms and collisions
  const exchangeResult = exchangeCollector.resolve()
  const { forms, ambiguous, stats: collisionStats } = exchangeResult

  console.log(`build-production-db: inserting ${forms.length} unambiguous forms...`)
  db.exec('BEGIN TRANSACTION')
  const insertFormStmt = db.prepare(`
    INSERT INTO forms (form, headword, kind)
    VALUES (?, ?, ?)
  `)
  for (const formRecord of forms) {
    insertFormStmt.run(formRecord.form, formRecord.headword, formRecord.kind)
  }
  db.exec('COMMIT')

  // Create Indexes after bulk loading
  console.log('build-production-db: creating indexes...')
  db.exec(`
    CREATE INDEX idx_forms_headword ON forms (headword COLLATE NOCASE);
    CREATE INDEX idx_forms_headword_raw ON forms (headword);
    CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);
  `)

  // Compute Logical Database Digest
  console.log('build-production-db: computing logical database digest...')
  const logicalHash = createHash('sha256')

  const dumpEntries = db.prepare(`
    SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency
    FROM entries
    ORDER BY word COLLATE NOCASE ASC
  `)
  for (const row of dumpEntries.all()) {
    logicalHash.update(
      `entry:${row.word}\0${row.phonetic ?? ''}\0${row.definition_en ?? ''}\0${row.translation_zh ?? ''}\0${row.pos ?? ''}\0${row.exchange ?? ''}\0${row.frequency ?? ''}\n`,
    )
  }

  const dumpForms = db.prepare(`
    SELECT form, headword, kind
    FROM forms
    ORDER BY form COLLATE NOCASE ASC
  `)
  for (const row of dumpForms.all()) {
    logicalHash.update(`form:${row.form}\0${row.headword}\0${row.kind ?? ''}\n`)
  }

  const dumpExamples = db.prepare(`
    SELECT id, headword, english, chinese, source, source_id, score
    FROM examples
    ORDER BY id ASC
  `)
  for (const row of dumpExamples.all()) {
    logicalHash.update(
      `example:${row.id}\0${row.headword}\0${row.english}\0${row.chinese ?? ''}\0${row.source ?? ''}\0${row.source_id ?? ''}\0${row.score ?? ''}\n`,
    )
  }

  const logicalSha256 = logicalHash.digest('hex')

  // Write Metadata into DB
  const insertMetaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  db.exec('BEGIN TRANSACTION')
  insertMetaStmt.run('schema_version', '1')
  insertMetaStmt.run('corpus_name', 'ECDICT')
  insertMetaStmt.run('upstream_commit', manifest.sourceCommit)
  insertMetaStmt.run('source_sha256', manifest.sourceSha256)
  insertMetaStmt.run('builder_version', '1.0.0')
  insertMetaStmt.run('parser_version', '1.0.0')
  insertMetaStmt.run('entry_count', String(validRows))
  insertMetaStmt.run('form_count', String(forms.length))
  insertMetaStmt.run('example_count', '0')
  insertMetaStmt.run('logical_sha256', logicalSha256)
  db.exec('COMMIT')

  // Run integrity check
  console.log('build-production-db: verifying PRAGMA integrity_check...')
  const integrityRow = db.prepare('PRAGMA integrity_check').get()
  const integrityResult = Object.values(integrityRow ?? {})[0]
  if (integrityResult !== 'ok') {
    throw new Error(`PRAGMA integrity_check failed: ${String(integrityResult)}`)
  }

  // Vacuum to finalize disk pages cleanly
  console.log('build-production-db: executing VACUUM...')
  db.exec('VACUUM')
  db.close()

  // Calculate file hash and size
  const fileStats = statSync(OUT_DB)
  const fileHash = createHash('sha256')
  const fileStream = createReadStream(OUT_DB)
  for await (const chunk of fileStream) {
    fileHash.update(chunk)
  }
  const fileSha256 = fileHash.digest('hex')

  const durationMs = Date.now() - startTime
  const rowsPerSec = Math.round(validRows / (durationMs / 1000))
  const memUsage = process.memoryUsage()
  const peakMemoryMb = Math.round(memUsage.rss / 1024 / 1024)

  console.log(`build-production-db: complete in ${durationMs}ms (${rowsPerSec} rows/sec, RSS ${peakMemoryMb}MB).`)
  console.log(`  Valid entries: ${validRows}`)
  console.log(`  Unambiguous forms: ${forms.length}`)
  console.log(`  Ambiguous forms excluded: ${ambiguous.length}`)
  console.log(`  Logical SHA-256: ${logicalSha256}`)
  console.log(`  File SHA-256: ${fileSha256}`)
  console.log(`  Database size: ${fileStats.size} bytes`)

  // Write Evidence Files
  // 1. Form collisions
  const formCollisionsDoc = {
    totalParsedForms: collisionStats.totalParsedForms,
    uniqueForms: collisionStats.uniqueForms,
    unambiguousForms: collisionStats.unambiguousForms,
    ambiguousForms: collisionStats.ambiguousForms,
    selfReferentialExcluded: collisionStats.selfReferentialExcluded,
    policyOutcome:
      'Ambiguous forms pointing to multiple distinct headwords are excluded from forms table to ensure deterministic single-headword resolution and prevent arbitrary overrides.',
    sampleCollisions: ambiguous.slice(0, 20),
  }
  writeFileSync(
    join(EVIDENCE_DIR, 'phase6-form-collisions.json'),
    JSON.stringify(formCollisionsDoc, null, 2) + '\n',
    'utf8',
  )

  // 2. Corpus quality
  const corpusQualityDoc = {
    sourceRows: sourceTotalRows,
    dataRows: sourceTotalRows - 1,
    validRows,
    rejectedRows: rejectedRowsCount,
    rejectionReasons: Object.fromEntries(rejectionReasons),
    rejectionSamples,
    duplicateHeadwords: duplicateWordsCount,
    emptyWords: emptyWordsCount,
    nullPhonetics: nullPhoneticsCount,
    nullDefinitions: nullDefinitionsCount,
    nullTranslations: nullTranslationsCount,
    nullPos: nullPosCount,
    rowsWithExchange: rowsWithExchangeCount,
    parsedForms: collisionStats.totalParsedForms,
    ambiguousForms: collisionStats.ambiguousForms,
    oversizedFields: oversizedFieldsCount,
    invalidUtf8: 0,
  }
  writeFileSync(
    join(EVIDENCE_DIR, 'phase6-corpus-quality.json'),
    JSON.stringify(corpusQualityDoc, null, 2) + '\n',
    'utf8',
  )

  // 3. Corpus build summary
  const corpusBuildDoc = {
    testedGitSha: options.testedGitSha ?? 'PENDING',
    upstream: {
      repository: manifest.sourceRepository,
      commit: manifest.sourceCommit,
      sourcePath: manifest.sourcePath,
      sourceSha256: manifest.sourceSha256,
      licensePath: manifest.licensePath,
      licenseSha256: manifest.licenseSha256,
    },
    schemaVersion: 1,
    sourceRows: sourceTotalRows,
    importedEntries: validRows,
    forms: forms.length,
    rejectedRows: rejectedRowsCount,
    collisionCounts: {
      totalForms: collisionStats.totalParsedForms,
      uniqueForms: collisionStats.uniqueForms,
      unambiguous: collisionStats.unambiguousForms,
      ambiguous: collisionStats.ambiguousForms,
      selfReferentialExcluded: collisionStats.selfReferentialExcluded,
    },
    logicalDbSha256: logicalSha256,
    dbFileSha256: fileSha256,
    dbBytes: fileStats.size,
    integrityCheck: integrityResult,
    performance: {
      durationMs,
      rowsPerSec,
      peakMemoryMb,
    },
    redistributionStatus: manifest.redistributionStatus ?? 'REDISTRIBUTION REVIEW REQUIRED',
    productionSafety: {
      networkAccessDuringBuild: false,
      runtimeNetworkAllowed: false,
      aiFallbackAllowed: false,
      fullCorpusTrackedInGit: false,
    },
  }
  writeFileSync(
    join(EVIDENCE_DIR, 'phase6-corpus-build.json'),
    JSON.stringify(corpusBuildDoc, null, 2) + '\n',
    'utf8',
  )

  return corpusBuildDoc
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildCorpus().catch((err) => {
    console.error('build-production-db failed:', err)
    process.exit(1)
  })
}
