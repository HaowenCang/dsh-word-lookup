import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { verifyCorpusQueryPlans, verifyProductionDb } from '../scripts/verify-production-db.mjs'
import { EXPECTED_CORPUS_HEADER } from '../scripts/lib/corpus-source.mjs'

describe('Corpus Verification & Source Provenance Binding', () => {
  const scratchDir = join(tmpdir(), `dsh-corpus-verify-${Date.now()}`)
  mkdirSync(scratchDir, { recursive: true })

  function hashBuffer(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex')
  }

  function createTestEnvironment(testId: string) {
    const dir = join(scratchDir, testId)
    mkdirSync(dir, { recursive: true })

    const header = EXPECTED_CORPUS_HEADER.join(',')
    const row1 = 'alpha,ˈælfə,first letter,阿尔法,,,,,100,1,,,'
    const row2 = 'beta,ˈbeɪtə,second letter,贝塔,,,,,200,2,,,'
    const csvContent = `${header}\n${row1}\n${row2}\n`
    const csvBuf = Buffer.from(csvContent, 'utf8')
    const sourceSha256 = hashBuffer(csvBuf)
    const sourceByteSize = csvBuf.length

    const sourceFile = join(dir, 'source.csv')
    writeFileSync(sourceFile, csvBuf)

    const manifest = {
      sourceName: 'ECDICT',
      sourceRepository: 'https://github.com/skywind3000/ECDICT',
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: 'ecdict.csv',
      sourceSha256,
      sourceByteSize,
      licensePath: 'LICENSE',
      licenseSha256: 'f'.repeat(64),
      schemaVersion: 1,
    }
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // Create DB
    const dbPath = join(dir, 'test.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE entries (
        word TEXT PRIMARY KEY COLLATE NOCASE,
        phonetic TEXT,
        definition_en TEXT,
        translation_zh TEXT,
        pos TEXT,
        exchange TEXT,
        frequency INTEGER
      );
      CREATE TABLE forms (
        form TEXT PRIMARY KEY COLLATE NOCASE,
        headword TEXT NOT NULL,
        kind TEXT
      );
      CREATE TABLE examples (
        id INTEGER PRIMARY KEY,
        headword TEXT NOT NULL COLLATE NOCASE,
        english TEXT NOT NULL,
        chinese TEXT,
        source TEXT,
        source_id TEXT,
        score REAL
      );
      CREATE INDEX idx_forms_headword_raw ON forms (headword);
      CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);
    `)

    db.exec(`
      INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('alpha', 'ˈælfə', 'first letter', '阿尔法', null, null, 1),
             ('beta', 'ˈbeɪtə', 'second letter', '贝塔', null, null, 2);
    `)

    // Compute logical sha
    const hash = createHash('sha256')
    for (const r of db.prepare('SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries ORDER BY word COLLATE NOCASE ASC').all() as any[]) {
      hash.update(`entry:${r.word}\0${r.phonetic ?? ''}\0${r.definition_en ?? ''}\0${r.translation_zh ?? ''}\0${r.pos ?? ''}\0${r.exchange ?? ''}\0${r.frequency ?? ''}\n`)
    }
    for (const r of db.prepare('SELECT form, headword, kind FROM forms ORDER BY form COLLATE NOCASE ASC').all() as any[]) {
      hash.update(`form:${r.form}\0${r.headword}\0${r.kind ?? ''}\n`)
    }
    for (const r of db.prepare('SELECT id, headword, english, chinese, source, source_id, score FROM examples ORDER BY id ASC').all() as any[]) {
      hash.update(`example:${r.id}\0${r.headword}\0${r.english}\0${r.chinese ?? ''}\0${r.source ?? ''}\0${r.source_id ?? ''}\0${r.score ?? ''}\n`)
    }
    const logicalSha256 = hash.digest('hex')

    const metaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    metaStmt.run('schema_version', '1')
    metaStmt.run('corpus_name', 'ECDICT')
    metaStmt.run('upstream_commit', manifest.sourceCommit)
    metaStmt.run('source_sha256', sourceSha256)
    metaStmt.run('entry_count', '2')
    metaStmt.run('form_count', '0')
    metaStmt.run('example_count', '0')
    metaStmt.run('logical_sha256', logicalSha256)
    db.close()

    return { dir, sourceFile, manifestPath, dbPath, sourceSha256, sourceByteSize, logicalSha256 }
  }

  it('source present and correct → full PASS', async () => {
    const env = createTestEnvironment('pass-case')
    const result = await verifyProductionDb({
      dbPath: env.dbPath,
      manifestPath: env.manifestPath,
      sourceFile: env.sourceFile,
      expectedEntryCount: 2,
      expectedFormCount: 0,
      skipProbes: true,
    })

    expect(result.status).toBe('PASS')
    expect(result.verified).toBe(true)
    expect(result.sourceBindingReverified).toBe(true)
  })

  it('source missing → full verifier refuses / non-zero exit', async () => {
    const env = createTestEnvironment('missing-source')
    const missingSourcePath = join(env.dir, 'nonexistent-source.csv')

    await expect(
      verifyProductionDb({
        dbPath: env.dbPath,
        manifestPath: env.manifestPath,
        sourceFile: missingSourcePath,
        expectedEntryCount: 2,
        expectedFormCount: 0,
        skipProbes: true,
      }),
    ).rejects.toThrow(/BLOCKED — PINNED SOURCE ARTIFACT MISSING/)
  })

  it('source missing with --metadata-only → returns PARTIAL state and NEVER prints full PASS', async () => {
    const env = createTestEnvironment('metadata-only-case')
    const missingSourcePath = join(env.dir, 'nonexistent-source.csv')

    const result = await verifyProductionDb({
      dbPath: env.dbPath,
      manifestPath: env.manifestPath,
      sourceFile: missingSourcePath,
      expectedEntryCount: 2,
      expectedFormCount: 0,
      skipProbes: true,
      metadataOnly: true,
    })

    expect(result.status).toBe('PARTIAL')
    expect(result.verified).toBe(false)
    expect(result.sourceBindingReverified).toBe(false)
    expect(result.metadataOnly).toBe(true)
  })

  it('source same size but altered bytes → FAIL', async () => {
    const env = createTestEnvironment('altered-bytes')
    // Modify one byte in the middle of source file without changing length
    const content = Buffer.from(EXPECTED_CORPUS_HEADER.join(',') + '\nalpha,ˈælfə,first letter,阿尔法,,,,,100,1,,,\nbeta,ˈbeɪtə,second letter,贝塔,,,,,200,2,,,\n', 'utf8')
    content[content.length - 10] = content[content.length - 10] === 0x31 ? 0x32 : 0x31 // flip byte
    writeFileSync(env.sourceFile, content)

    await expect(
      verifyProductionDb({
        dbPath: env.dbPath,
        manifestPath: env.manifestPath,
        sourceFile: env.sourceFile,
        expectedEntryCount: 2,
        expectedFormCount: 0,
        skipProbes: true,
      }),
    ).rejects.toThrow(/source artifact SHA-256 MISMATCH/)
  })

  it('DB source_sha256 mismatch → FAIL', async () => {
    const env = createTestEnvironment('db-meta-mismatch')
    // Alter DB meta source_sha256
    const db = new DatabaseSync(env.dbPath)
    db.exec("UPDATE meta SET value = '0000000000000000000000000000000000000000000000000000000000000000' WHERE key = 'source_sha256'")
    db.close()

    await expect(
      verifyProductionDb({
        dbPath: env.dbPath,
        manifestPath: env.manifestPath,
        sourceFile: env.sourceFile,
        expectedEntryCount: 2,
        expectedFormCount: 0,
        skipProbes: true,
      }),
    ).rejects.toThrow(/source_sha256 mismatch/)
  })

  describe('Query Plan Regression: SCAN forms USING INDEX cannot be classified as valid', () => {
    it('rejects database where forms-by-headword results in SCAN forms USING INDEX', () => {
      const db = new DatabaseSync(':memory:')
      db.exec(`
        CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, definition_en TEXT, translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER);
        CREATE TABLE forms (form TEXT PRIMARY KEY COLLATE NOCASE, headword TEXT NOT NULL, kind TEXT);
        CREATE TABLE examples (id INTEGER PRIMARY KEY, headword TEXT NOT NULL COLLATE NOCASE, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL);
        CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);
        -- Intentionally omit idx_forms_headword_raw; instead create only NOCASE index
        CREATE INDEX idx_forms_headword ON forms (headword COLLATE NOCASE);
      `)

      // Verify that EXPLAIN QUERY PLAN indeed produces SCAN forms USING INDEX
      const rows = db.prepare('EXPLAIN QUERY PLAN SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE').all('test') as Array<{ detail: string }>
      const detail = rows.map((r) => r.detail).join('; ')
      expect(detail).toContain('SCAN forms USING INDEX')

      // Assert that verifyCorpusQueryPlans refuses this plan with a SCAN error
      expect(() => verifyCorpusQueryPlans(db)).toThrow(/contains full table\/index SCAN/)
      db.close()
    })
  })
})
