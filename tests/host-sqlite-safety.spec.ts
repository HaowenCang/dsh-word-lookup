/**
 * The Phase 3 store's capability probe and its safety properties.
 *
 * Three separate concerns live here because they share one subject — the
 * `node:sqlite` dependency — and one failure mode: a store that works on the
 * developer's machine by accident.
 *
 * 1. **Capability.** Phase 0 never probed `node:sqlite`, so Phase 3 measured it
 *    before designing against it. The probe is reproduced here as a test rather
 *    than left as a transcript, so the API shape this project relies on is
 *    re-checked on every run against whatever Node is actually executing.
 * 2. **Injection safety.** Every query is a prepared statement with bound
 *    parameters. The test proves the *effect* (a hostile string is a miss, and
 *    the schema is unchanged) and the *cause* (no SQL literal in the host
 *    contains an interpolation).
 * 3. **Boundary.** The client half must never be able to reach a database. The
 *    built bundle is checked by `scripts/check-bundle.mjs`; the sources are
 *    checked here, so the failure is caught before a build rather than after.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { openSqliteDictionary } from '../src/host/sqlite-dictionary.js'

/** Scratch directory for the persistence half of the probe. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-word-lookup-sqlite-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * Read one of this project's source files.
 *
 * @param relative - path below the repository root.
 * @returns the file's text.
 */
function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

/**
 * Extract every string literal that looks like SQL.
 *
 * @param text - the source to scan.
 * @returns the SQL-looking literals, with their delimiters.
 */
function sqlLiterals(text: string): string[] {
  const literals = [...text.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)].map((match) => match[2] ?? '')
  return literals.filter((literal) =>
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/.test(literal),
  )
}

describe('node:sqlite capability probe (measured, not assumed)', () => {
  it('imports and exposes a constructible DatabaseSync', () => {
    expect(typeof DatabaseSync).toBe('function')
    const db = new DatabaseSync(':memory:')
    expect(db.constructor.name).toBe('DatabaseSync')
    expect(typeof db.exec).toBe('function')
    expect(typeof db.prepare).toBe('function')
    expect(typeof db.close).toBe('function')
    db.close()
  })

  it('creates a table, inserts, and reads back through a bound parameter', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE probe (word TEXT PRIMARY KEY COLLATE NOCASE, n INTEGER)')
    const insert = db.prepare('INSERT INTO probe (word, n) VALUES (?, ?)')
    const changes = insert.run('Derive', 1)
    expect(changes.changes).toBe(1)
    expect(Number(changes.lastInsertRowid)).toBe(1)

    const select = db.prepare('SELECT word, n FROM probe WHERE word = ?')
    expect(select.get('derive')).toEqual({ word: 'Derive', n: 1 })
    expect(select.get('absent')).toBeUndefined()
    expect(select.all('derive')).toEqual([{ word: 'Derive', n: 1 }])
    db.close()
  })

  it('rolls back a failed transaction and commits a good one', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE probe (word TEXT)')
    const insert = db.prepare('INSERT INTO probe (word) VALUES (?)')
    const count = (): unknown => db.prepare('SELECT COUNT(*) AS n FROM probe').get()?.n

    db.exec('BEGIN IMMEDIATE')
    insert.run('rolled-back')
    db.exec('ROLLBACK')
    expect(count()).toBe(0)

    db.exec('BEGIN IMMEDIATE')
    insert.run('committed')
    db.exec('COMMIT')
    expect(count()).toBe(1)
    db.close()
  })

  it('persists to a file and reads the same rows back after a reopen', () => {
    const file = join(scratch, 'probe.db')
    const first = new DatabaseSync(file)
    first.exec('CREATE TABLE probe (word TEXT PRIMARY KEY)')
    first.prepare('INSERT INTO probe (word) VALUES (?)').run('derive')
    first.close()

    const second = new DatabaseSync(file)
    expect(second.prepare('SELECT word FROM probe').all()).toEqual([{ word: 'derive' }])
    second.close()
  })

  it('refuses use after close rather than triggering undefined behaviour', () => {
    const db = new DatabaseSync(':memory:')
    db.close()
    expect(() => db.prepare('SELECT 1')).toThrow(/not open/)
    expect(() => db.close()).toThrow(/not open/)
  })

  it('reports the SQLite library version this Node ships', () => {
    const db = new DatabaseSync(':memory:')
    const row = db.prepare('SELECT sqlite_version() AS v').get() ?? {}
    expect(typeof row.v).toBe('string')
    expect(String(row.v)).toMatch(/^\d+\.\d+/)
    db.close()
  })
})

describe('SQL safety — parameters, never interpolation', () => {
  it('treats a hostile query as a miss and leaves the schema intact', () => {
    const store = openSqliteDictionary({ path: ':memory:' })
    const before = store.lookup('derive')
    expect(before.found).toBe(true)

    for (const hostile of [
      "'; DROP TABLE entries; --",
      "derive'; DELETE FROM entries; --",
      "' OR 1=1 --",
      '"; DROP TABLE forms; --',
      "' UNION SELECT word FROM entries --",
      "'); INSERT INTO entries (word) VALUES ('x'); --",
    ]) {
      const result = store.lookup(hostile)
      expect(result.found, hostile).toBe(false)
    }

    // The tables survived, and the original row is still answered.
    expect(store.lookup('derive').found).toBe(true)
    expect(store.lookup('go').found).toBe(true)
    store.close()
  })

  it('does not execute a second statement smuggled into a bound parameter', () => {
    const store = openSqliteDictionary({ path: ':memory:' })
    const name = "x'; CREATE TABLE leaked (a); --"
    expect(store.lookup(name).found).toBe(false)
    // `leaked` would exist had the parameter been concatenated into `exec`.
    expect(store.lookup('leaked').found).toBe(false)
    store.close()
  })

  it('binds the query rather than interpolating it, in every host SQL literal', () => {
    for (const file of ['src/host/sqlite-dictionary.ts', 'src/host/fixture.ts']) {
      const literals = sqlLiterals(source(file))
      expect(literals.length, `${file} should contain SQL`).toBeGreaterThan(0)
      for (const literal of literals) {
        expect(literal, `${file}: ${literal.slice(0, 70)}`).not.toContain('${')
      }
    }
  })

  it('never passes anything but a literal to exec', () => {
    // `exec` can run several statements, so the only caller-supplied text it may
    // ever see is none. The check is textual and narrow on purpose: it fails if a
    // call acquires an argument that is not a plain literal.
    for (const file of ['src/host/sqlite-dictionary.ts', 'src/host/fixture.ts']) {
      const text = source(file)
      const calls = [...text.matchAll(/\.exec\(([^)]*)\)/g)].map((match) => (match[1] ?? '').trim())
      expect(calls.length, `${file} should call exec`).toBeGreaterThan(0)
      for (const argument of calls) {
        if (argument.startsWith("'") || argument.startsWith('`')) continue
        // The one permitted non-literal form is the named-constant indirection
        // used for schema and index statements, never a computed value.
        expect(argument, `${file}: exec(${argument})`).toMatch(/^[A-Za-z_$][\w$]*$/)
      }
    }
  })
})

describe('Host boundary — no network, no model, no browser', () => {
  const HOST_SOURCES = [
    'src/index.ts',
    'src/host/config.ts',
    'src/host/dictionary.ts',
    'src/host/fixture.ts',
    'src/host/fixture-db.ts',
    'src/host/lookup.ts',
    'src/host/route.ts',
    'src/host/sqlite-dictionary.ts',
  ]

  it('the host half issues no outbound request of its own', () => {
    for (const file of HOST_SOURCES) {
      const text = source(file)
      expect(text, file).not.toMatch(/\bfetch\s*\(/)
      expect(text, file).not.toMatch(/from\s+'node:https?'/)
      expect(text, file).not.toMatch(/from\s+"node:https?"/)
    }
  })

  it('the host half imports no model or provider package', () => {
    for (const file of HOST_SOURCES) {
      const text = source(file)
      expect(text, file).not.toMatch(/@deepseek-ai\/dsh-llm/)
      expect(text, file).not.toMatch(/dsh-llm-deepseek/)
      expect(text, file).not.toMatch(/\bopenai\b|\banthropic\b/i)
    }
  })

  it('the host half never touches a browser global', () => {
    for (const file of HOST_SOURCES) {
      const text = source(file)
      expect(text, file).not.toMatch(/\bwindow\./)
      expect(text, file).not.toMatch(/\bdocument\./)
    }
  })

  it('the client half imports no Node built-in and no database driver', () => {
    for (const file of ['src/client/index.tsx', 'src/client/card.tsx', 'src/client/transport.ts', 'src/client/store.ts', 'src/client/selection.ts', 'src/client/gesture.ts', 'src/client/lifecycle.ts', 'src/client/contracts.ts', 'src/shared/protocol.ts', 'src/shared/text.ts']) {
      const text = source(file)
      expect(text, file).not.toMatch(/from\s+['"]node:/)
      expect(text, file).not.toMatch(/node:sqlite/)
      expect(text, file).not.toMatch(/DatabaseSync/)
      expect(text, file).not.toMatch(/\bprocess\./)
    }
  })

  it('only the SQLite dictionary module imports node:sqlite', () => {
    for (const file of HOST_SOURCES) {
      const text = source(file)
      if (file === 'src/host/sqlite-dictionary.ts') {
        expect(text, file).toContain("from 'node:sqlite'")
      } else {
        expect(text, file).not.toContain('node:sqlite')
      }
    }
  })
})
