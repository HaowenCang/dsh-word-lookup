import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { buildCorpus } from '../scripts/build-production-db.mjs'
import {
  EXPECTED_CORPUS_HEADER,
  validateCorpusHeader,
} from '../scripts/lib/corpus-source.mjs'

describe('Corpus Builder Safety & Source Provenance Gates', () => {
  const scratchDir = join(tmpdir(), `dsh-corpus-safety-${Date.now()}`)
  mkdirSync(scratchDir, { recursive: true })

  // Synthetic 13-column valid CSV data
  function makeCsv(rows: string[][], includeBom = false): string {
    const lines = rows.map((r) => r.map((c) => (c.includes(',') || c.includes('"') || c.includes('\n') ? `"${c.replaceAll('"', '""')}"` : c)).join(','))
    const content = lines.join('\n') + '\n'
    return includeBom ? '\uFEFF' + content : content
  }

  function hashBuffer(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex')
  }

  const validHeader = [...EXPECTED_CORPUS_HEADER]
  const sampleRow1 = ['alpha', 'ˈælfə', 'first letter', '阿尔法', '', '', '', '', '100', '1', '', '', '']
  const sampleRow2 = ['beta', 'ˈbeɪtə', 'second letter', '贝塔', '', '', '', '', '200', '2', '', '', '']

  describe('Header Schema & Adversarial Validation', () => {
    it('accepts exact 13-column expected header', () => {
      const sanitized = validateCorpusHeader([...EXPECTED_CORPUS_HEADER])
      expect(sanitized).toEqual(EXPECTED_CORPUS_HEADER)
    })

    it('accepts header with UTF-8 BOM on first column and strips BOM cleanly', () => {
      const bomHeader = ['\uFEFF' + EXPECTED_CORPUS_HEADER[0], ...EXPECTED_CORPUS_HEADER.slice(1)]
      const sanitized = validateCorpusHeader(bomHeader)
      expect(sanitized).toEqual(EXPECTED_CORPUS_HEADER)
      expect(sanitized[0]).toBe('word')
    })

    it('rejects reordered columns with BLOCKED — CORPUS HEADER MISMATCH', () => {
      const reordered = [...EXPECTED_CORPUS_HEADER]
      // Swap phonetic and definition
      reordered[1] = EXPECTED_CORPUS_HEADER[2]!
      reordered[2] = EXPECTED_CORPUS_HEADER[1]!

      expect(() => validateCorpusHeader(reordered)).toThrow(/BLOCKED — CORPUS HEADER MISMATCH/)
    })

    it('rejects renamed column with BLOCKED — CORPUS HEADER MISMATCH', () => {
      const renamed = [...EXPECTED_CORPUS_HEADER]
      renamed[0] = 'term' // was 'word'

      expect(() => validateCorpusHeader(renamed)).toThrow(/BLOCKED — CORPUS HEADER MISMATCH/)
    })

    it('rejects missing column with BLOCKED — CORPUS HEADER MISMATCH', () => {
      const missing = EXPECTED_CORPUS_HEADER.slice(0, 12) // 12 columns instead of 13
      expect(() => validateCorpusHeader(missing)).toThrow(/BLOCKED — CORPUS HEADER MISMATCH/)
    })

    it('rejects extra column with BLOCKED — CORPUS HEADER MISMATCH', () => {
      const extra = [...EXPECTED_CORPUS_HEADER, 'extra_col']
      expect(() => validateCorpusHeader(extra)).toThrow(/BLOCKED — CORPUS HEADER MISMATCH/)
    })
  })

  describe('Source Hash Gating & Existing DB Protection', () => {
    it('SOURCE-HASH-1: correct source allows build', async () => {
      const testDir = join(scratchDir, 'sh1')
      mkdirSync(testDir, { recursive: true })

      const csvContent = makeCsv([validHeader, sampleRow1, sampleRow2])
      const csvBuf = Buffer.from(csvContent, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      writeFileSync(csvPath, csvBuf)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        sourceSha256: hashBuffer(csvBuf),
        sourceByteSize: csvBuf.length,
        licensePath: 'LICENSE',
        licenseSha256: 'f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f',
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const dbPath = join(testDir, 'output.db')
      const result = await buildCorpus({
        manifestPath,
        sourceFile: csvPath,
        outDb: dbPath,
        writeEvidence: false,
      })

      expect(result.corpusBuild.importedEntries).toBe(2)
      expect(existsSync(dbPath)).toBe(true)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'source_sha256'").get() as { value: string }
      expect(metaRow.value).toBe(manifest.sourceSha256)
      db.close()
    })

    it('SOURCE-HASH-2: modify one byte refuses build BEFORE mutating existing DB', async () => {
      const testDir = join(scratchDir, 'sh2')
      mkdirSync(testDir, { recursive: true })

      // Create a sentinel "existing valid DB" with unique content
      const dbPath = join(testDir, 'existing.db')
      const dbInit = new DatabaseSync(dbPath)
      dbInit.exec('CREATE TABLE sentinel (marker TEXT)')
      dbInit.exec("INSERT INTO sentinel VALUES ('DO_NOT_TOUCH_ME')")
      dbInit.close()
      const originalDbBytes = readFileSync(dbPath)

      // CSV has byte modified
      const csvContent = makeCsv([validHeader, sampleRow1, sampleRow2])
      const csvBuf = Buffer.from(csvContent, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      // Modify one byte
      csvBuf[csvBuf.length - 2] = 0x58
      writeFileSync(csvPath, csvBuf)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        // Manifest expects the original hash, but file has 1 byte changed (same length!)
        sourceSha256: hashBuffer(Buffer.from(csvContent, 'utf8')),
        sourceByteSize: csvBuf.length,
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      await expect(
        buildCorpus({
          manifestPath,
          sourceFile: csvPath,
          outDb: dbPath,
          writeEvidence: false,
        }),
      ).rejects.toThrow(/SHA-256 MISMATCH/)

      // Verify existing DB is untouched byte-for-byte!
      expect(readFileSync(dbPath)).toEqual(originalDbBytes)
      const dbCheck = new DatabaseSync(dbPath, { readOnly: true })
      const markerRow = dbCheck.prepare('SELECT marker FROM sentinel').get() as { marker: string }
      expect(markerRow.marker).toBe('DO_NOT_TOUCH_ME')
      dbCheck.close()
    })

    it('SOURCE-HASH-3: same byte size but different contents refuses build', async () => {
      const testDir = join(scratchDir, 'sh3')
      mkdirSync(testDir, { recursive: true })

      const csvContentA = makeCsv([validHeader, sampleRow1, sampleRow2])
      // row with same length but different chars:
      const sampleRow2Mod = ['beta', 'ˈbeɪtə', 'second latter', '贝塔', '', '', '', '', '200', '2', '', '', '']
      const csvContentB = makeCsv([validHeader, sampleRow1, sampleRow2Mod])
      expect(csvContentA.length).toBe(csvContentB.length)

      const csvBufB = Buffer.from(csvContentB, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      writeFileSync(csvPath, csvBufB)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        sourceSha256: hashBuffer(Buffer.from(csvContentA, 'utf8')), // expects A
        sourceByteSize: csvBufB.length,
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const dbPath = join(testDir, 'output.db')
      await expect(
        buildCorpus({
          manifestPath,
          sourceFile: csvPath,
          outDb: dbPath,
          writeEvidence: false,
        }),
      ).rejects.toThrow(/SHA-256 MISMATCH/)
    })

    it('SOURCE-HASH-4: wrong manifest hash refuses build', async () => {
      const testDir = join(scratchDir, 'sh4')
      mkdirSync(testDir, { recursive: true })

      const csvContent = makeCsv([validHeader, sampleRow1, sampleRow2])
      const csvBuf = Buffer.from(csvContent, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      writeFileSync(csvPath, csvBuf)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        sourceSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        sourceByteSize: csvBuf.length,
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const dbPath = join(testDir, 'output.db')
      await expect(
        buildCorpus({
          manifestPath,
          sourceFile: csvPath,
          outDb: dbPath,
          writeEvidence: false,
        }),
      ).rejects.toThrow(/SHA-256 MISMATCH/)
    })
  })

  describe('Field-size bound enforcement', () => {
    it('rejects rows with protected text field > 65536 deterministically', async () => {
      const testDir = join(scratchDir, 'field-size')
      mkdirSync(testDir, { recursive: true })

      const oversizedDef = 'x'.repeat(65537)
      const oversizedRow = ['huge', 'hjuːdʒ', oversizedDef, '巨大的', '', '', '', '', '300', '3', '', '', '']
      const csvContent = makeCsv([validHeader, sampleRow1, oversizedRow, sampleRow2])
      const csvBuf = Buffer.from(csvContent, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      writeFileSync(csvPath, csvBuf)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        sourceSha256: hashBuffer(csvBuf),
        sourceByteSize: csvBuf.length,
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const dbPath = join(testDir, 'output.db')
      const result = await buildCorpus({
        manifestPath,
        sourceFile: csvPath,
        outDb: dbPath,
        writeEvidence: false,
      })

      expect(result.corpusBuild.importedEntries).toBe(2) // alpha and beta inserted
      expect(result.corpusBuild.rejectedRows).toBe(1) // huge rejected
      expect(result.corpusQuality.rejectionReasons['field-too-large']).toBe(1)

      const db = new DatabaseSync(dbPath, { readOnly: true })
      const hugeEntry = db.prepare("SELECT word FROM entries WHERE word = 'huge'").get()
      expect(hugeEntry).toBeUndefined()
      const alphaEntry = db.prepare("SELECT word FROM entries WHERE word = 'alpha'").get()
      expect(alphaEntry).toBeDefined()
      db.close()
    })
  })

  describe('Exact batch-boundary transaction lifecycle', () => {
    it('completes cleanly when data row count is an exact multiple of batchSize (N * BATCH_SIZE)', async () => {
      const testDir = join(scratchDir, 'batch-boundary')
      mkdirSync(testDir, { recursive: true })

      // Generate exactly 6 rows
      const rows = [
        ['word1', '', 'def1', 'trans1', '', '', '', '', '', '', '', '', ''],
        ['word2', '', 'def2', 'trans2', '', '', '', '', '', '', '', '', ''],
        ['word3', '', 'def3', 'trans3', '', '', '', '', '', '', '', '', ''],
        ['word4', '', 'def4', 'trans4', '', '', '', '', '', '', '', '', ''],
        ['word5', '', 'def5', 'trans5', '', '', '', '', '', '', '', '', ''],
        ['word6', '', 'def6', 'trans6', '', '', '', '', '', '', '', '', ''],
      ]
      const csvContent = makeCsv([validHeader, ...rows])
      const csvBuf = Buffer.from(csvContent, 'utf8')
      const csvPath = join(testDir, 'source.csv')
      writeFileSync(csvPath, csvBuf)

      const manifestPath = join(testDir, 'manifest.json')
      const manifest = {
        sourceName: 'ECDICT',
        sourceRepository: 'https://github.com/skywind3000/ECDICT',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourcePath: 'ecdict.csv',
        sourceSha256: hashBuffer(csvBuf),
        sourceByteSize: csvBuf.length,
        schemaVersion: 1,
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const dbPath = join(testDir, 'output.db')
      // batchSize: 2 divides 6 exactly (6 % 2 == 0)
      const result = await buildCorpus({
        manifestPath,
        sourceFile: csvPath,
        outDb: dbPath,
        batchSize: 2,
        writeEvidence: false,
      })

      expect(result.corpusBuild.importedEntries).toBe(6)
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const countRow = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }
      expect(countRow.c).toBe(6)
      db.close()
    })
  })
})
