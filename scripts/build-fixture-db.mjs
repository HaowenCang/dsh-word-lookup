#!/usr/bin/env node
/**
 * Build the deterministic fixture dictionary the host reads at runtime.
 *
 * The output is a real SQLite file at a **fixed** location inside this
 * repository:
 *
 * ```text
 * fixtures/dictionary.fixture.db
 * ```
 *
 * The location is fixed on purpose. Phase 3 must not be able to touch a
 * production corpus, and the cheapest way to guarantee that is for this script
 * to have no way to be aimed at one: the default target is derived from the
 * repository root, and any `--out` is refused unless it resolves inside
 * `fixtures/` *and* its file name is still `dictionary.fixture.db`. There is no
 * flag, environment variable or argument that widens that.
 *
 * Overwrite behaviour is explicit:
 *
 * | invocation | effect on an existing file |
 * | --- | --- |
 * | `node scripts/build-fixture-db.mjs` | opened and used; repaired only if its schema or fixture revision is stale, then validated |
 * | `node scripts/build-fixture-db.mjs --force` | deleted and rebuilt from scratch |
 *
 * The build itself is one transaction, so an interrupted run leaves the previous
 * file rather than a half-seeded one. It then validates the schema and the row
 * counts, and finally proves determinism the only way that is honest: it builds
 * a second database from the same literals in a scratch directory and compares
 * the two *logical dumps*. It does **not** claim the two files are byte
 * identical — SQLite is free to lay pages out differently across builds, and a
 * byte comparison would be a claim the toolchain cannot keep.
 *
 * All SQL here is either a literal or a prepared statement with bound
 * parameters. No value from the fixture is ever interpolated into SQL text.
 *
 * Usage:
 *   node scripts/build-fixture-db.mjs [--out <path>] [--force] [--json]
 *
 * Exit codes: 0 built and validated, 1 validation failed, 2 refused by the path
 * guard or the store could not be opened.
 *
 * @module dsh-word-lookup/scripts/build-fixture-db
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FIXTURE_META,
  FIXTURE_VERSION,
  SCHEMA_VERSION,
  clearFixture,
  createFixtureSchema,
  dumpFixture,
  seedFixture,
  validateFixture,
} from '../src/host/fixture.ts'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directory that owns every generated fixture file. */
const FIXTURE_DIRECTORY = join(REPO_ROOT, 'fixtures')

/** Canonical file name; part of the guard rather than a default. */
const FIXTURE_FILE_NAME = 'dictionary.fixture.db'

/** Canonical target. */
const DEFAULT_OUT = join(FIXTURE_DIRECTORY, FIXTURE_FILE_NAME)

/** Sibling files SQLite may create next to the database. */
const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm']

/**
 * Parse `--key value` / `--flag` arguments.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[token.slice(2)] = 'true'
    } else {
      options[token.slice(2)] = value
      index += 1
    }
  }
  return options
}

/**
 * Refuse any target that is not the package-owned fixture.
 *
 * The check is on the resolved path, not on the spelling, so `fixtures/../x.db`
 * and an absolute path to another drive are both refused. Symlinks are not
 * followed beyond `resolve`, because the guard's job is to keep this script away
 * from a corpus path, not to defend against a hostile local user.
 *
 * @param candidate - the requested output path.
 * @returns the resolved path, or throws with the reason.
 */
function guardedTarget(candidate) {
  const resolved = resolve(candidate)
  const insideFixtures = resolved === FIXTURE_DIRECTORY || resolved.startsWith(FIXTURE_DIRECTORY + sep)
  if (!insideFixtures) {
    throw new Error(
      `refusing to write outside ${relative(REPO_ROOT, FIXTURE_DIRECTORY)}${sep}: ${resolved}\n` +
        'the fixture database lives in the package-owned fixtures/ directory and nowhere else',
    )
  }
  if (basename(resolved) !== FIXTURE_FILE_NAME) {
    throw new Error(
      `refusing to write "${basename(resolved)}": a fixture database must be named ${FIXTURE_FILE_NAME}\n` +
        'a differently named file could be a production corpus',
    )
  }
  return resolved
}

/**
 * Delete a file and any SQLite sidecar beside it.
 *
 * @param file - the database path.
 */
function removeWithSidecars(file) {
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    const target = file + suffix
    if (existsSync(target)) rmSync(target, { force: true })
  }
}

/**
 * Materialise the fixture into a database file.
 *
 * @param file - the target path; its directory is created if needed.
 * @returns the validation report, the logical dump and the file's SHA-256.
 */
function build(file) {
  mkdirSync(dirname(file), { recursive: true })
  removeWithSidecars(file)

  const db = new DatabaseSync(file)
  try {
    createFixtureSchema(db)

    // One transaction for the whole seed. `BEGIN IMMEDIATE` takes the write lock
    // up front, so a failure cannot leave a partially written dictionary.
    db.exec('BEGIN IMMEDIATE')
    try {
      clearFixture(db)
      seedFixture(db)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; the original error is the one to keep.
      }
      throw error
    }

    const validation = validateFixture(db)
    const dump = dumpFixture(db)
    const summary = {
      schemaVersion: SCHEMA_VERSION,
      fixtureVersion: FIXTURE_VERSION,
      meta: { ...FIXTURE_META },
    }
    db.close()
    return { validation, dump, summary, bytes: statSync(file).size, sha256: hashFile(file) }
  } catch (error) {
    try {
      db.close()
    } catch {
      // Already closed, or never opened far enough.
    }
    throw error
  }
}

/**
 * SHA-256 of a file, reported for the record only.
 *
 * It is *not* used as a determinism assertion: two builds of the same logical
 * content may differ in page layout.
 *
 * @param file - the file to hash.
 * @returns the lowercase hex digest.
 */
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Open an existing database without rebuilding it.
 *
 * @param file - the database path.
 * @returns the validation report, the dump and the file's digest.
 */
function inspect(file) {
  const db = new DatabaseSync(file)
  try {
    const validation = validateFixture(db)
    return { validation, dump: dumpFixture(db), bytes: statSync(file).size, sha256: hashFile(file) }
  } finally {
    db.close()
  }
}

const options = parseArgs(process.argv.slice(2))
const quiet = options.json === 'true' || options.quiet === 'true'
const force = options.force === 'true'
const requested = options.out ?? DEFAULT_OUT

let target
try {
  target = guardedTarget(requested)
} catch (error) {
  console.error(`build-fixture-db: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const report = {
  target: relative(REPO_ROOT, target),
  action: 'built',
  forced: force,
  existedBefore: existsSync(target),
  schemaVersion: SCHEMA_VERSION,
  fixtureVersion: FIXTURE_VERSION,
}

let first
try {
  if (report.existedBefore && !force) {
    // Not forced: use what is there, but do not silently accept a stale revision.
    const existing = inspect(target)
    if (existing.validation.ok) {
      report.action = 'validated'
      first = existing
    } else {
      report.action = 'repaired'
      report.repairReasons = existing.validation.problems
      first = build(target)
    }
  } else {
    report.action = force && report.existedBefore ? 'rebuilt' : 'built'
    first = build(target)
  }
} catch (error) {
  console.error(`build-fixture-db: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

// --- determinism, measured rather than asserted -----------------------------
// A second build from the same literals, in a scratch directory, must produce
// the same logical content. The bytes are reported but not compared.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-word-lookup-fixture-'))
let second
try {
  second = build(join(scratch, FIXTURE_FILE_NAME))
} catch (error) {
  rmSync(scratch, { recursive: true, force: true })
  console.error(`build-fixture-db: the determinism rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
rmSync(scratch, { recursive: true, force: true })

const identical = JSON.stringify(first.dump) === JSON.stringify(second.dump)
const byteIdentical = first.sha256 === second.sha256

report.counts = first.validation.counts
report.expected = first.validation.expected
report.validation = { ok: first.validation.ok, problems: first.validation.problems }
report.meta = first.validation.meta
report.bytes = first.bytes
report.sha256 = first.sha256
report.determinism = {
  logicalDumpIdentical: identical,
  byteIdentical,
  note: byteIdentical
    ? 'both builds produced identical bytes as well as identical content'
    : 'content is identical; the SQLite files differ in page layout, which is not a defect',
}

if (!quiet) {
  console.log(`build-fixture-db: ${report.action} ${report.target}`)
  console.log(`  schema_version   ${String(SCHEMA_VERSION)}`)
  console.log(`  fixture_version  ${FIXTURE_VERSION}`)
  console.log(`  entries          ${String(first.validation.counts.entries)}`)
  console.log(`  forms            ${String(first.validation.counts.forms)}`)
  console.log(`  examples         ${String(first.validation.counts.examples)}`)
  console.log(`  file             ${String(first.bytes)} bytes  sha256 ${first.sha256}`)
  console.log(`  determinism      logical dump identical: ${String(identical)} (bytes identical: ${String(byteIdentical)})`)
  for (const problem of first.validation.problems) console.log(`  problem          ${problem}`)
}

const ok = first.validation.ok && identical
if (options.json === 'true') console.log(JSON.stringify(report, null, 2))

if (!ok) {
  console.error(`build-fixture-db: FAIL — validation ok=${String(first.validation.ok)}, determinism ok=${String(identical)}`)
  process.exit(1)
}
console.log('build-fixture-db: PASS')
