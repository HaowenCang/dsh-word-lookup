/**
 * The fixture database: where it lives, how it is built, and what it must
 * contain.
 *
 * The builder's determinism is checked the way the phase brief requires it to
 * be: two independent builds are compared by *logical content*, not by bytes.
 * The SQLite file's byte layout is not a stable artifact, so a byte comparison
 * would be a claim this project cannot keep — and a test that made that claim
 * would fail for a reason that has nothing to do with the fixture.
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DictionaryUnavailableError,
} from '../src/host/dictionary.js'
import {
  FIXTURE_DIRECTORY,
  FIXTURE_FILE_NAME,
  findPackageRoot,
  openFixtureDictionary,
  resolveFixtureDatabasePath,
} from '../src/host/fixture-db.js'
import {
  FIXTURE_ENTRIES,
  FIXTURE_EXAMPLES,
  FIXTURE_FORMS,
  FIXTURE_META,
  FIXTURE_TABLES,
  FIXTURE_VERSION,
  SCHEMA_VERSION,
  clearFixture,
  createFixtureSchema,
  dumpFixture,
  expectedFixtureCounts,
  seedFixture,
  validateFixture,
} from '../src/host/fixture.js'
import { openSqliteDictionary, type SqliteDictionary } from '../src/host/sqlite-dictionary.js'

/** Scratch directories created by a test, removed afterwards. */
const scratchDirectories: string[] = []
/** Dictionaries opened by a test, closed afterwards. */
const opened: SqliteDictionary[] = []

/**
 * Create one scratch directory.
 *
 * @returns its absolute path.
 */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-word-lookup-fixture-'))
  scratchDirectories.push(directory)
  return directory
}

/**
 * Build a fixture database at an explicit path.
 *
 * @param file - the target path.
 * @returns the validation report and the logical dump.
 */
function buildAt(file: string): { ok: boolean; dump: string } {
  const db = new DatabaseSync(file)
  try {
    createFixtureSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      clearFixture(db)
      seedFixture(db)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const validation = validateFixture(db)
    return { ok: validation.ok, dump: JSON.stringify(dumpFixture(db)) }
  } finally {
    db.close()
  }
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
  while (scratchDirectories.length > 0) {
    const directory = scratchDirectories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe('fixture database location', () => {
  it('is derived from the package root and is not configurable', () => {
    const root = findPackageRoot()
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(resolveFixtureDatabasePath()).toBe(join(root, FIXTURE_DIRECTORY, FIXTURE_FILE_NAME))
  })

  it('ends in the package-owned fixtures directory', () => {
    const path = resolveFixtureDatabasePath()
    expect(path.endsWith(join(FIXTURE_DIRECTORY, FIXTURE_FILE_NAME))).toBe(true)
    expect(path).not.toContain('ecdict')
    expect(path).not.toContain('tatoeba')
    expect(path).not.toContain('corpus')
  })

  it('follows the module that asks, so the built bundle resolves the same file', () => {
    // `lib/index.js` sits one level below the root, exactly like `src/host/`,
    // and it is the module the DSH process actually loads. Resolving from that
    // URL — the file need not exist for the walk — is what proves the published
    // bundle reaches the same fixture rather than a directory that only exists
    // in the source tree.
    const fromBundle = resolveFixtureDatabasePath(new URL('../lib/index.js', import.meta.url).href)
    expect(fromBundle).toBe(resolveFixtureDatabasePath())
    expect(fromBundle).toBe(join(findPackageRoot(), FIXTURE_DIRECTORY, FIXTURE_FILE_NAME))

    // A URL from a nested directory resolves identically, because the walk is
    // driven by the package manifest rather than by a fixed relative depth.
    const fromNested = resolveFixtureDatabasePath(new URL('../lib/types/host/deep/fake.js', import.meta.url).href)
    expect(fromNested).toBe(resolveFixtureDatabasePath())
  })

  it('refuses to guess when the module is outside the package', () => {
    expect(() => resolveFixtureDatabasePath('file:///C:/definitely/not/this/package/x.js')).toThrow(
      DictionaryUnavailableError,
    )
  })
})

describe('fixture database contents', () => {
  it('creates every table and index the schema declares', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    expect(buildAt(file).ok).toBe(true)

    const db = new DatabaseSync(file, { readOnly: true })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).map(
      (row) => row.name,
    )
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()).map(
      (row) => row.name,
    )
    db.close()

    for (const table of FIXTURE_TABLES) expect(tables, table).toContain(table)
    expect(indexes).toContain('idx_forms_headword')
    expect(indexes).toContain('idx_examples_headword')
  })

  it('records the schema and fixture revisions', () => {
    const store = openSqliteDictionary({ path: join(scratch(), FIXTURE_FILE_NAME) })
    opened.push(store)
    expect(store.initialization.schemaVersion).toBe(SCHEMA_VERSION)
    expect(store.initialization.fixtureVersion).toBe(FIXTURE_VERSION)
    expect(store.initialization.seeded).toBe(true)
  })

  it('holds exactly the rows the fixture definition declares', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    buildAt(file)
    const db = new DatabaseSync(file, { readOnly: true })
    const report = validateFixture(db)
    db.close()

    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.counts).toEqual(expectedFixtureCounts())
    expect(report.counts).toEqual({
      entries: FIXTURE_ENTRIES.length,
      forms: FIXTURE_FORMS.length,
      examples: FIXTURE_EXAMPLES.length,
    })
    expect(report.meta.schema_version).toBe(String(SCHEMA_VERSION))
    expect(report.meta.fixture_version).toBe(FIXTURE_VERSION)
    expect(report.meta.example_source).toBe('dsh-word-lookup-fixture')
  })

  it('declares its own counts in meta, and they agree with the tables', () => {
    expect(Number(FIXTURE_META.entries_count)).toBe(FIXTURE_ENTRIES.length)
    expect(Number(FIXTURE_META.forms_count)).toBe(FIXTURE_FORMS.length)
    expect(Number(FIXTURE_META.examples_count)).toBe(FIXTURE_EXAMPLES.length)
  })

  it('covers the six lookup shapes the phase brief names', () => {
    const words = FIXTURE_ENTRIES.map((entry) => entry.word)
    for (const word of ['derive', 'go', 'tooth', 'conservation', 'wave function']) {
      expect(words, word).toContain(word)
    }
    const forms = new Map(FIXTURE_FORMS.map((form) => [form.form, form.headword]))
    expect(forms.get('derived')).toBe('derive')
    expect(forms.get('deriving')).toBe('derive')
    expect(forms.get('went')).toBe('go')
    expect(forms.get('gone')).toBe('go')
    expect(forms.get('teeth')).toBe('tooth')
  })

  it('gives every fixture headword a phonetic, a POS and a Chinese translation', () => {
    for (const entry of FIXTURE_ENTRIES) {
      expect(entry.phonetic, entry.word).toBeTruthy()
      expect(entry.pos, entry.word).toBeTruthy()
      expect(entry.translationZh, entry.word).toBeTruthy()
    }
  })

  it('gives every headword at most two examples, none of them duplicated', () => {
    const perHeadword = new Map<string, number>()
    for (const example of FIXTURE_EXAMPLES) {
      perHeadword.set(example.headword, (perHeadword.get(example.headword) ?? 0) + 1)
    }
    for (const [headword, count] of perHeadword) {
      expect(count, headword).toBeLessThanOrEqual(2)
      expect(count, headword).toBeGreaterThanOrEqual(1)
    }
    expect(new Set(FIXTURE_EXAMPLES.map((example) => example.english)).size).toBe(FIXTURE_EXAMPLES.length)
    expect(new Set(FIXTURE_EXAMPLES.map((example) => example.id)).size).toBe(FIXTURE_EXAMPLES.length)
  })
})

describe('fixture builder determinism', () => {
  it('produces the same logical content from two independent builds', () => {
    const first = buildAt(join(scratch(), FIXTURE_FILE_NAME))
    const second = buildAt(join(scratch(), FIXTURE_FILE_NAME))
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.dump).toBe(first.dump)
  })

  it('is rerunnable over an existing file without changing its content', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    const first = buildAt(file)
    const second = buildAt(file)
    expect(second.dump).toBe(first.dump)
  })

  it('rebuilds a database whose rows were damaged, rather than serving it', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    buildAt(file)

    const damage = new DatabaseSync(file)
    damage.exec("DELETE FROM forms WHERE form = 'went'")
    expect(validateFixture(damage).ok).toBe(false)
    damage.close()

    const store = openSqliteDictionary({ path: file })
    opened.push(store)
    expect(store.initialization.seeded).toBe(true)
    expect(store.lookup('went').found).toBe(true)
  })
})

describe('fixture database lifecycle', () => {
  it('persists across a close and reopens with the same content', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)

    const writer = openSqliteDictionary({ path: file })
    expect(writer.lookup('teeth').found).toBe(true)
    writer.close()

    const reader = openSqliteDictionary({ path: file, readOnly: true })
    opened.push(reader)
    const result = reader.lookup('teeth')
    expect(result.found).toBe(true)
    if (!result.found) throw new Error('unreachable')
    expect(result.headword).toBe('tooth')
    expect(reader.initialization.existed).toBe(true)
    expect(reader.initialization.created).toBe(false)
    expect(reader.initialization.seeded).toBe(false)
  })

  it('refuses a read-only open of a file that is not there', () => {
    const missing = join(scratch(), 'absent', FIXTURE_FILE_NAME)
    expect(() => openSqliteDictionary({ path: missing, readOnly: true })).toThrow(DictionaryUnavailableError)
  })

  it('refuses a file that is not a database, and leaves no handle behind', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    writeFileSync(file, 'this is not a SQLite database', 'utf8')
    expect(() => openSqliteDictionary({ path: file, readOnly: true })).toThrow(DictionaryUnavailableError)
    // A second attempt must fail the same way rather than succeeding because the
    // first one left the file locked.
    expect(() => openSqliteDictionary({ path: file, readOnly: true })).toThrow(DictionaryUnavailableError)
  })

  it('survives repeated open/close on the same file', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    for (let index = 0; index < 10; index += 1) {
      const store = openSqliteDictionary({ path: file })
      expect(store.lookup('derive').found).toBe(true)
      store.close()
    }
    expect(existsSync(file)).toBe(true)
  })

  it('creates the fixture directory when it does not exist yet', () => {
    const file = join(scratch(), 'nested', 'deeper', FIXTURE_FILE_NAME)
    const store = openSqliteDictionary({ path: file })
    opened.push(store)
    expect(existsSync(file)).toBe(true)
    expect(store.lookup('conservation').found).toBe(true)
  })
})

describe('the package-owned fixture', () => {
  it('exists, validates, and is the file the host opens', () => {
    const store = openFixtureDictionary()
    opened.push(store)
    const path = resolveFixtureDatabasePath()
    expect(existsSync(path)).toBe(true)

    const db = new DatabaseSync(path, { readOnly: true })
    const report = validateFixture(db)
    db.close()

    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
    expect(store.lookup('derive').found).toBe(true)
    expect(store.source).toBe('sqlite-fixture')
  })
})

describe('validateFixture', () => {
  it('reports a missing table instead of throwing', () => {
    const db = new DatabaseSync(':memory:')
    const report = validateFixture(db)
    db.close()
    expect(report.ok).toBe(false)
    expect(report.problems.length).toBeGreaterThan(0)
    expect(report.problems.join(' ')).toContain('missing table')
  })

  it('reports a dangling form so a wrong-headword answer cannot be shipped', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    buildAt(file)
    const db = new DatabaseSync(file)
    db.exec("INSERT INTO forms (form, headword, kind) VALUES ('orphaned', 'nonexistent', 'plural')")
    const report = validateFixture(db)
    db.close()
    expect(report.ok).toBe(false)
    expect(report.problems.join(' ')).toContain('orphaned')
  })

  it('reports a vocabulary that shrank', () => {
    const file = join(scratch(), FIXTURE_FILE_NAME)
    buildAt(file)
    const db = new DatabaseSync(file)
    db.exec("DELETE FROM entries WHERE word = 'conservation'")
    const report = validateFixture(db)
    db.close()
    expect(report.ok).toBe(false)
    expect(report.problems.join(' ')).toContain('entries holds')
  })
})
