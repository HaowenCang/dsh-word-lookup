#!/usr/bin/env node
/**
 * Deterministic production SQLite corpus builder with fail-closed source verification.
 *
 * Implements Phase 6.1 production corpus ingestion:
 * - Loads and validates pinned `corpus/ecdict.manifest.json`.
 * - Verifies source byte size and SHA-256 BEFORE touching the output database.
 * - Preflights and enforces exact 13-column CSV header schema with UTF-8 BOM stripping.
 * - Streams pinned `.cache/corpus/ecdict.csv` via fatal `StreamingCsvParser`.
 * - Enforces field-size safety bounds (deterministic rejection of oversized fields).
 * - Manages clean SQLite transactions without batch-boundary leakage.
 * - Extracts morphological inflections via `ExchangeCollector`.
 * - Filters self-referential forms and disambiguates collisions.
 * - Emits `entries`, `forms`, and `examples` conforming to the product schema.
 * - Indexes:
 *   - `idx_forms_headword`
 *   - `idx_forms_headword_raw`
 *   - `idx_examples_headword`
 * - Computes logical database SHA-256 and physical file SHA-256.
 * - Writes verified source SHA-256 into DB `meta` table.
 * - Runs `PRAGMA integrity_check`.
 *
 * @module dsh-word-lookup/scripts/build-production-db
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { StreamingCsvParser } from '../src/host/csv-parser.ts'
import { ExchangeCollector } from '../src/host/exchange-parser.ts'
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  EXPECTED_CORPUS_HEADER,
  loadCorpusManifest,
  preflightCorpusHeader,
  validateCorpusHeader,
  verifyCorpusSource,
} from './lib/corpus-source.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST_PATH = join(ROOT, 'corpus', 'ecdict.manifest.json')
const SOURCE_FILE = join(ROOT, '.cache', 'corpus', 'ecdict.csv')
const OUT_DIR = join(ROOT, 'build', 'corpus')
const OUT_DB = join(OUT_DIR, 'ecdict.db')
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence')

// Safety bounds
const MAX_WORD_LENGTH = 128
const MAX_FIELD_LENGTH = 65536
const DEFAULT_BATCH_SIZE = 25000

export async function buildCorpus(options = {}) {
  const startTime = Date.now()
  console.log('build-production-db: starting production corpus build...')

  const manifestPath = options.manifestPath ?? MANIFEST_PATH
  const sourceFile = options.sourceFile ?? SOURCE_FILE
  const outDb = options.outDb ?? OUT_DB
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const evidenceDir = options.evidenceDir ?? EVIDENCE_DIR
  const writeEvidence = options.writeEvidence !== false

  // 1. Load and validate manifest
  const manifest = loadCorpusManifest(manifestPath)

  // 2. HARD GATE: Verify source artifact size and SHA-256 BEFORE mutating any database
  console.log(`build-production-db: verifying source artifact ${sourceFile}...`)
  const { actualByteSize, actualSha256: verifiedSourceSha256 } = await verifyCorpusSource(sourceFile, manifest)
  console.log(`build-production-db: source artifact verified (${verifiedSourceSha256}, ${actualByteSize} bytes).`)

  // 3. HARD GATE: Preflight header schema before touching output DB
  console.log('build-production-db: preflighting CSV header schema...')
  const verifiedHeader = await preflightCorpusHeader(sourceFile)
  console.log(`build-production-db: CSV header preflight PASS (${verifiedHeader.length} columns).`)

  // 4. NOW safe to prepare output directory and remove existing DB
  mkdirSync(dirname(outDb), { recursive: true })
  if (writeEvidence) {
    mkdirSync(evidenceDir, { recursive: true })
  }

  if (options.cleanExisting !== false) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(outDb + suffix, { force: true })
    }
  }

  const db = new DatabaseSync(outDb)

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

  // Robust transaction lifecycle helper
  let inTransaction = false
  function ensureTx() {
    if (!inTransaction) {
      db.exec('BEGIN TRANSACTION')
      inTransaction = true
    }
  }
  function commitTx() {
    if (inTransaction) {
      db.exec('COMMIT')
      inTransaction = false
    }
  }

  let currentBatch = 0

  const parser = new StreamingCsvParser((row, rowIndex) => {
    sourceTotalRows += 1
    if (sourceTotalRows === 1) {
      // Validate header exact match at runtime parser level
      validateCorpusHeader(row)
      return
    }

    if (row.length !== EXPECTED_CORPUS_HEADER.length) {
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

    // Deterministic field-size bound policy: reject rows with any oversized text field
    let fieldOversized = false
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] && row[c].length > MAX_FIELD_LENGTH) {
        fieldOversized = true
        break
      }
    }
    if (fieldOversized) {
      oversizedFieldsCount += 1
      rejectedRowsCount += 1
      const reason = 'field-too-large'
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

    // Frequency from BNC or FRQ rank
    let freqNumber = null
    if (bnc && bnc.trim()) {
      const num = parseInt(bnc.trim(), 10)
      if (!Number.isNaN(num) && num > 0) freqNumber = num
    }

    ensureTx()
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
    if (currentBatch >= batchSize) {
      commitTx()
      currentBatch = 0
    }
  })

  const stream = createReadStream(sourceFile)
  for await (const chunk of stream) {
    parser.push(chunk)
  }
  parser.end()

  // Commit any pending entries cleanly
  commitTx()

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

  // Write Metadata into DB — using verifiedSourceSha256 (not blind manifest string)
  const insertMetaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  db.exec('BEGIN TRANSACTION')
  insertMetaStmt.run('schema_version', String(manifest.schemaVersion))
  insertMetaStmt.run('corpus_name', 'ECDICT')
  insertMetaStmt.run('upstream_commit', manifest.sourceCommit)
  insertMetaStmt.run('source_sha256', verifiedSourceSha256)
  insertMetaStmt.run('builder_version', '1.1.0')
  insertMetaStmt.run('parser_version', '1.1.0')
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
  const fileStats = statSync(outDb)
  const fileHash = createHash('sha256')
  const fileStream = createReadStream(outDb)
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
    utf8Validation: 'fatal decoder; complete source parsed successfully',
    fieldSizePolicy: 'reject-row-field-too-large',
  }

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
    sourceVerification: {
      verifiedBeforeMutation: true,
      actualSourceSha256: verifiedSourceSha256,
      actualSourceBytes: actualByteSize,
      hashMatch: verifiedSourceSha256 === manifest.sourceSha256,
      sizeMatch: actualByteSize === manifest.sourceByteSize,
    },
    headerValidation: {
      expected: EXPECTED_CORPUS_HEADER,
      observed: verifiedHeader,
      match: true,
    },
    schemaVersion: manifest.schemaVersion,
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

  if (writeEvidence) {
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
      join(evidenceDir, 'phase6-form-collisions.json'),
      JSON.stringify(formCollisionsDoc, null, 2) + '\n',
      'utf8',
    )

    // 2. Corpus quality
    writeFileSync(
      join(evidenceDir, 'phase6-corpus-quality.json'),
      JSON.stringify(corpusQualityDoc, null, 2) + '\n',
      'utf8',
    )

    // 3. Corpus build summary
    writeFileSync(
      join(evidenceDir, 'phase6-corpus-build.json'),
      JSON.stringify(corpusBuildDoc, null, 2) + '\n',
      'utf8',
    )
  }

  return {
    corpusBuild: corpusBuildDoc,
    corpusQuality: corpusQualityDoc,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildCorpus().catch((err) => {
    console.error('build-production-db failed:', err)
    process.exit(1)
  })
}
