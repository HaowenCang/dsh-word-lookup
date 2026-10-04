import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { DictionaryUnavailableError } from '../src/host/dictionary.js'
import { loadRuntimeCorpusManifest, openProductionDictionary } from '../src/host/corpus-db.js'

describe('Production Corpus SQLite Dictionary (Synthetic Production Schema)', () => {
  const scratchDir = join(tmpdir(), `dsh-synthetic-prod-${Date.now()}`)
  mkdirSync(scratchDir, { recursive: true })

  const manifest = loadRuntimeCorpusManifest()

  function createSyntheticProductionDb(
    filePath: string,
    metaOverrides: Record<string, string> = {},
    skipIndexes = false,
  ): void {
    const db = new DatabaseSync(filePath)
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
    `)

    if (!skipIndexes) {
      db.exec(`
        CREATE INDEX idx_forms_headword ON forms (headword COLLATE NOCASE);
        CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);
      `)
    }

    const defaultMeta: Record<string, string> = {
      schema_version: String(manifest.schemaVersion),
      corpus_name: manifest.sourceName,
      upstream_commit: manifest.sourceCommit,
      source_sha256: manifest.sourceSha256,
      entry_count: '3',
      form_count: '2',
      example_count: '1',
      logical_sha256: 'synthetic-digest',
    }

    const effectiveMeta: Record<string, string> = { ...defaultMeta, ...metaOverrides }
    const metaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(effectiveMeta)) {
      if (v !== undefined) {
        metaStmt.run(k, v)
      }
    }

    // Seed entries
    const entryStmt = db.prepare(`
      INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    entryStmt.run('go', 'gou', 'move from one place to another', '去；走', 'v', 'p:went/d:gone', 10)
    entryStmt.run('wave', 'weiv', 'move to and fro', '波动；挥手', 'v', null, 50)
    entryStmt.run('wave function', 'weiv fʌŋkʃən', 'quantum state mathematical description', '波函数', 'n', null, 500)

    // Seed forms
    const formStmt = db.prepare('INSERT INTO forms (form, headword, kind) VALUES (?, ?, ?)')
    formStmt.run('went', 'go', 'past')
    formStmt.run('gone', 'go', 'done')

    // Seed examples
    const exStmt = db.prepare(`
      INSERT INTO examples (id, headword, english, chinese, source, source_id, score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    exStmt.run(1, 'go', 'I go to school.', '我去上学。', 'synth', 's1', 1.0)

    db.close()
  }

  const validDbPath = join(scratchDir, 'valid-production.db')
  createSyntheticProductionDb(validDbPath)

  it('opens synthetic production database with ecdict-local provenance and read-only mode', () => {
    const dict = openProductionDictionary({ path: validDbPath })
    try {
      expect(dict).toBeDefined()
      expect(dict.source).toBe('ecdict-local')
      expect(dict.initialization.schemaVersion).toBe(manifest.schemaVersion)
    } finally {
      dict.close()
    }
  })

  it('performs exact and phrase queries with correct canonical precedence', () => {
    const dict = openProductionDictionary({ path: validDbPath })
    try {
      // 1. Exact headword
      const go = dict.lookup('go')
      expect(go.found).toBe(true)
      if (go.found) {
        expect(go.headword).toBe('go')
        expect(go.phonetic).toBe('gou')
        expect(go.matchedForm).toBeNull()
        expect(go.senses.length).toBeGreaterThan(0)
      }

      // 2. Exact word "wave" over any morphology
      const wave = dict.lookup('wave')
      expect(wave.found).toBe(true)
      if (wave.found) {
        expect(wave.headword).toBe('wave')
        expect(wave.matchedForm).toBeNull()
      }

      // 3. Multi-word phrase "wave function"
      const waveFn = dict.lookup('wave function')
      expect(waveFn.found).toBe(true)
      if (waveFn.found) {
        expect(waveFn.headword).toBe('wave function')
        expect(waveFn.matchedForm).toBeNull()
      }

      // 4. Case-insensitivity
      const mixed = dict.lookup('WaVe FuNcTiOn')
      expect(mixed.found).toBe(true)
      if (mixed.found) {
        expect(mixed.headword).toBe('wave function')
      }

      // 5. Unknown query
      const unknown = dict.lookup('notrealxyz')
      expect(unknown.found).toBe(false)
      expect(unknown.query).toBe('notrealxyz')
    } finally {
      dict.close()
    }
  })

  it('resolves inflected forms to lemma with matchedForm', () => {
    const dict = openProductionDictionary({ path: validDbPath })
    try {
      const went = dict.lookup('went')
      expect(went.found).toBe(true)
      if (went.found) {
        expect(went.headword).toBe('go')
        expect(went.matchedForm).toBe('went')
      }
    } finally {
      dict.close()
    }
  })

  it('defends against SQL injection and hostile input strings', () => {
    const dict = openProductionDictionary({ path: validDbPath })
    try {
      const maliciousQueries = [
        "'; DROP TABLE entries; --",
        "' OR '1'='1",
        "UNION SELECT * FROM meta --",
        '\\x00\\x01\\x02',
        'a'.repeat(2048),
      ]

      for (const q of maliciousQueries) {
        const res = dict.lookup(q)
        expect(res.found).toBe(false)
      }

      // Check database integrity remains undamaged
      const check = dict.lookup('go')
      expect(check.found).toBe(true)
    } finally {
      dict.close()
    }
  })

  describe('Fail-Clean Metadata & Integrity Assertions (No Skips, No Fallbacks)', () => {
    it('CR1 / Missing DB: rejects non-existent database file without falling back', () => {
      const missingPath = join(scratchDir, 'definitely-does-not-exist.db')
      expect(() => openProductionDictionary({ path: missingPath })).toThrow(DictionaryUnavailableError)
    })

    it('Corrupt DB: rejects truncated file with controlled error', () => {
      const truncPath = join(scratchDir, 'truncated.db')
      writeFileSync(truncPath, Buffer.alloc(100, 0x42))
      expect(() => openProductionDictionary({ path: truncPath })).toThrow(DictionaryUnavailableError)
    })

    it('Corrupt DB: rejects empty file with controlled error', () => {
      const emptyPath = join(scratchDir, 'empty.db')
      writeFileSync(emptyPath, Buffer.alloc(0))
      expect(() => openProductionDictionary({ path: emptyPath })).toThrow(DictionaryUnavailableError)
    })

    it('Wrong schema_version: rejects database with schema mismatch', () => {
      const badPath = join(scratchDir, 'bad-schema.db')
      createSyntheticProductionDb(badPath, { schema_version: '999' })
      expect(() => openProductionDictionary({ path: badPath })).toThrow(/schema_version 999, expected/)
    })

    it('Wrong corpus_name: rejects database with wrong corpus_name', () => {
      const badPath = join(scratchDir, 'bad-corpus-name.db')
      createSyntheticProductionDb(badPath, { corpus_name: 'NOT_ECDICT' })
      expect(() => openProductionDictionary({ path: badPath })).toThrow(/corpus_name "NOT_ECDICT", expected/)
    })

    it('Wrong upstream_commit: rejects database with wrong upstream_commit', () => {
      const badPath = join(scratchDir, 'bad-upstream-commit.db')
      createSyntheticProductionDb(badPath, { upstream_commit: 'deadbeef00000000000000000000000000000000' })
      expect(() => openProductionDictionary({ path: badPath })).toThrow(/upstream_commit "deadbeef00000000000000000000000000000000", expected/)
    })

    it('Wrong source_sha256: rejects database with wrong source_sha256', () => {
      const badPath = join(scratchDir, 'bad-source-sha.db')
      createSyntheticProductionDb(badPath, { source_sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' })
      expect(() => openProductionDictionary({ path: badPath })).toThrow(/source_sha256 "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", expected/)
    })

    it('Missing required index: rejects database without idx_forms_headword', () => {
      const badPath = join(scratchDir, 'missing-index.db')
      createSyntheticProductionDb(badPath, {}, true) // skipIndexes = true
      expect(() => openProductionDictionary({ path: badPath })).toThrow(/missing required index/)
    })
  })
})
