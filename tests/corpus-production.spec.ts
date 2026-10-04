import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { DictionaryUnavailableError } from '../src/host/dictionary.js'
import { openProductionDictionary, resolveProductionDatabasePath } from '../src/host/corpus-db.js'

describe('Production Corpus SQLite Dictionary', () => {
  const prodPath = resolveProductionDatabasePath()

  it('resolves production database path and opens read-only', () => {
    if (!existsSync(prodPath)) {
      console.warn('Production database not yet built; skipping live production tests')
      return
    }

    const dict = openProductionDictionary({ path: prodPath })
    expect(dict).toBeDefined()
    expect(dict.initialization.schemaVersion).toBe(1)
    dict.close()
  })

  it('performs exact and phrase queries matching expected probes', () => {
    if (!existsSync(prodPath)) return

    const dict = openProductionDictionary({ path: prodPath })
    try {
      // 1. Exact words
      const go = dict.lookup('go')
      expect(go.found).toBe(true)
      if (go.found) {
        expect(go.headword).toBe('go')
        expect(go.phonetic).toBe('gou')
        expect(go.senses.length).toBeGreaterThan(0)
      }

      const wave = dict.lookup('wave')
      expect(wave.found).toBe(true)
      if (wave.found) {
        expect(wave.headword).toBe('wave')
        expect(wave.matchedForm).toBeNull() // exact canonical precedence
      }

      // 2. Phrase
      const waveFunction = dict.lookup('wave function')
      expect(waveFunction.found).toBe(true)
      if (waveFunction.found) {
        expect(waveFunction.headword.toLowerCase()).toBe('wave function')
      }

      // 3. Case insensitivity
      const mixed = dict.lookup('CoNsErVaTiOn')
      expect(mixed.found).toBe(true)
      if (mixed.found) {
        expect(mixed.headword.toLowerCase()).toBe('conservation')
      }

      // 4. Unknown query
      const unknown = dict.lookup('nonexistentprobexyz123')
      expect(unknown.found).toBe(false)
      expect(unknown.query).toBe('nonexistentprobexyz123')
    } finally {
      dict.close()
    }
  })

  it('handles irregular and inflected forms with correct canonical mapping', () => {
    if (!existsSync(prodPath)) return

    const dict = openProductionDictionary({ path: prodPath })
    try {
      // went, teeth, derived are entries with morphological relations in ECDICT
      const went = dict.lookup('went')
      expect(went.found).toBe(true)

      const teeth = dict.lookup('teeth')
      expect(teeth.found).toBe(true)

      const tooth = dict.lookup('tooth')
      expect(tooth.found).toBe(true)
      if (tooth.found) {
        expect(tooth.forms.some((f) => f.form.toLowerCase() === 'teeth')).toBe(true)
      }
    } finally {
      dict.close()
    }
  })

  it('defends against SQL injection and hostile input strings', () => {
    if (!existsSync(prodPath)) return

    const dict = openProductionDictionary({ path: prodPath })
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

      // Verify tables still exist unharmed
      const check = dict.lookup('go')
      expect(check.found).toBe(true)
    } finally {
      dict.close()
    }
  })

  describe('Corruption handling on isolated copies', () => {
    const scratchDir = join(tmpdir(), `dsh-corpus-corruption-${Date.now()}`)
    mkdirSync(scratchDir, { recursive: true })

    it('rejects truncated / incomplete database file with controlled error', () => {
      const truncPath = join(scratchDir, 'truncated.db')
      // Write partial 100 bytes
      writeFileSync(truncPath, Buffer.alloc(100, 0x42))

      expect(() => openProductionDictionary({ path: truncPath })).toThrow(DictionaryUnavailableError)
    })

    it('rejects empty database file with controlled error', () => {
      const emptyPath = join(scratchDir, 'empty.db')
      writeFileSync(emptyPath, Buffer.alloc(0))

      expect(() => openProductionDictionary({ path: emptyPath })).toThrow(DictionaryUnavailableError)
    })

    it('rejects missing database file without downloading or falling back', () => {
      const missingPath = join(scratchDir, 'missing.db')
      expect(() => openProductionDictionary({ path: missingPath })).toThrow(DictionaryUnavailableError)
    })

    it('rejects database with invalid schema_version', () => {
      const invalidMetaPath = join(scratchDir, 'invalid-meta.db')
      const db = new DatabaseSync(invalidMetaPath)
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '999')")
      db.exec('CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, definition_en TEXT, translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER)')
      db.exec('CREATE TABLE forms (form TEXT PRIMARY KEY COLLATE NOCASE, headword TEXT NOT NULL, kind TEXT)')
      db.exec('CREATE TABLE examples (id INTEGER PRIMARY KEY, headword TEXT NOT NULL COLLATE NOCASE, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL)')
      db.close()

      expect(() => openProductionDictionary({ path: invalidMetaPath })).toThrow(DictionaryUnavailableError)
    })
  })
})
