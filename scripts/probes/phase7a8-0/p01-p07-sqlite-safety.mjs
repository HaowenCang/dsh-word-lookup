/**
 * Phase 7A.8.0 Probe Suite: P01 - P07 (SQLite Verification Safety & File Ownership)
 *
 * Standalone probe script executing isolated, non-mutating checks against SQLite:
 * - P01: Baseline Git & DSH version audit
 * - P02: SQLite Schema Contract & lookup compatibility matrix
 * - P03: Read-only open, sidecars, trusted_schema pragma, and write safety
 * - P04: Invalid, corrupt, and malformed database handling
 * - P05: Custom path handling, symlinks, junctions, spaces, and Windows file locks
 * - P06: User file ownership, quarantine isolation, and deletion prevention
 * - P07: File replacement and TOCTOU protection
 *
 * @module scripts/probes/phase7a8-0/p01-p07-sqlite-safety
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import {
  ActivationCoordinator,
  DictionaryManager,
  openFixtureDictionary,
  readActiveMetadata,
  resolveManagedStoragePaths,
  writeActiveMetadataAtomically,
} from '../../../lib/index.js'

export async function runSqliteSafetyProbes() {
  const results = []
  const testRoot = join(tmpdir(), `dsh-p7a8-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(testRoot, { recursive: true })

  function record(probeId, objective, status, details, evidenceType = 'RUNTIME_CONFIRMED', limitation = 'None') {
    results.push({
      probeId,
      objective,
      status, // 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED'
      evidenceType,
      details,
      limitation,
      timestamp: new Date().toISOString(),
    })
  }

  try {
    // -------------------------------------------------------------------------
    // P01: Git & DSH Version Baseline
    // -------------------------------------------------------------------------
    try {
      const gitHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
      const gitOriginMaster = execSync('git rev-parse origin/master', { encoding: 'utf8' }).trim()
      const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
      const gitStatus = execSync('git status --porcelain=v1', { encoding: 'utf8' }).trim()
      const nodeVersion = process.version
      const dshVersion = execSync('dsh --version', { encoding: 'utf8' }).trim()

      const p01Pass =
        gitBranch === 'master' &&
        gitHead === '31d4fb989e1d710c21e879117755d0c0e3916f63' &&
        gitOriginMaster === '31d4fb989e1d710c21e879117755d0c0e3916f63' &&
        dshVersion === '0.2.0-rc.2' &&
        nodeVersion.startsWith('v24.')

      record('P01', 'Verify Git baseline and DSH 0.2.0-rc.2 environment', p01Pass ? 'PASS' : 'FAIL', {
        gitBranch,
        gitHead,
        gitOriginMaster,
        gitStatusClean: gitStatus.length === 0,
        nodeVersion,
        dshVersion,
        expectedHead: '31d4fb989e1d710c21e879117755d0c0e3916f63',
      })
    } catch (err) {
      record('P01', 'Verify Git baseline and DSH 0.2.0-rc.2 environment', 'FAIL', { error: err.message })
    }

    // Helper to create synthetic standard database
    function createStandardTestDb(dbPath, options = {}) {
      const db = new DatabaseSync(dbPath)
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta (key, value) VALUES ('schema_version', '${options.schemaVersion ?? 1}');
        INSERT INTO meta (key, value) VALUES ('corpus_name', 'TEST_CORPUS');

        CREATE TABLE entries (
          word TEXT PRIMARY KEY,
          phonetic TEXT,
          definition_en TEXT,
          translation_zh TEXT,
          pos TEXT,
          exchange TEXT,
          frequency INTEGER
        );

        CREATE TABLE forms (
          form TEXT PRIMARY KEY,
          headword TEXT,
          kind TEXT
        );

        CREATE TABLE examples (
          id INTEGER PRIMARY KEY,
          headword TEXT,
          english TEXT,
          chinese TEXT,
          source TEXT,
          source_id TEXT,
          score REAL
        );
      `)

      if (options.indexes !== false) {
        db.exec(`
          CREATE INDEX idx_forms_headword_raw ON forms (headword);
          CREATE INDEX idx_examples_headword ON examples (headword);
        `)
      }

      if (options.seed !== false) {
        db.exec(`
          INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
          VALUES ('test', '/test/', 'a trial', '测试', 'n.', null, 100);
          INSERT INTO forms (form, headword, kind) VALUES ('tests', 'test', 'p');
          INSERT INTO examples (id, headword, english, chinese, source, source_id, score)
          VALUES (1, 'test', 'this is a test', '这是一个测试', 'sample', '1', 1.0);
        `)
      }

      db.close()
    }

    // -------------------------------------------------------------------------
    // P02: SQLite Schema Contract
    // -------------------------------------------------------------------------
    try {
      const validDbPath = join(testRoot, 'p02-valid.db')
      createStandardTestDb(validDbPath)

      // 1. Missing columns in entries table
      const missingColsDbPath = join(testRoot, 'p02-missing-cols.db')
      const dbMissingCols = new DatabaseSync(missingColsDbPath)
      dbMissingCols.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta (key, value) VALUES ('schema_version', '1');
        CREATE TABLE entries (word TEXT PRIMARY KEY); -- missing translation_zh, definition_en etc!
        CREATE TABLE forms (form TEXT PRIMARY KEY);
        CREATE TABLE examples (id INTEGER PRIMARY KEY);
      `)
      dbMissingCols.close()

      // 2. View masquerading as table
      const viewDbPath = join(testRoot, 'p02-view.db')
      const dbView = new DatabaseSync(viewDbPath)
      dbView.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta (key, value) VALUES ('schema_version', '1');
        CREATE TABLE real_entries (word TEXT PRIMARY KEY, definition_en TEXT);
        CREATE VIEW entries AS SELECT * FROM real_entries;
        CREATE TABLE forms (form TEXT PRIMARY KEY);
        CREATE TABLE examples (id INTEGER PRIMARY KEY);
      `)
      dbView.close()

      // 3. Missing index DB
      const noIndexDbPath = join(testRoot, 'p02-no-index.db')
      createStandardTestDb(noIndexDbPath, { indexes: false })

      // Audit current verifyCustomDatabase behavior
      const manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      const coordinator = new ActivationCoordinator({ manager })

      const validResult = await coordinator.verifyCustomDatabase(validDbPath)
      const missingColsResult = await coordinator.verifyCustomDatabase(missingColsDbPath)
      const viewResult = await coordinator.verifyCustomDatabase(viewDbPath)

      // Test whether missingColsDb would throw if queried via product lookup SQL
      let lookupThrewOnMissingCols = false
      let lookupErrorMessage = null
      try {
        const raw = new DatabaseSync(missingColsDbPath, { readOnly: true })
        try {
          raw.prepare('SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?').get('test')
        } finally {
          raw.close()
        }
      } catch (err) {
        lookupThrewOnMissingCols = true
        lookupErrorMessage = err.message
      }

      // Check query execution plan on noIndexDb
      const rawNoIndex = new DatabaseSync(noIndexDbPath, { readOnly: true })
      const formPlan = rawNoIndex.prepare("EXPLAIN QUERY PLAN SELECT form, kind FROM forms WHERE headword = ?").all('test')
      rawNoIndex.close()
      const usesScanOnMissingIndex = JSON.stringify(formPlan).includes('SCAN')

      const p02Pass =
        validResult.valid === true &&
        missingColsResult.valid === true && // PROVES current verifier does NOT check columns (vulnerability!)
        lookupThrewOnMissingCols === true && // PROVES missing columns crash lookup!
        viewResult.valid === false && // PROVES views rejected by type = 'table'
        usesScanOnMissingIndex === true // PROVES missing index causes full table SCAN

      record('P02', 'Audit SQLite Schema contract, column checks, views, and index requirements', p02Pass ? 'PASS' : 'FAIL', {
        currentVerifierCheckedColumns: false, // Discovered gap
        missingColsValidationPassed: missingColsResult.valid,
        lookupThrewOnMissingCols,
        lookupErrorMessage,
        viewsRejectedByTableFilter: !viewResult.valid,
        viewRejectionReason: viewResult.error,
        missingIndexCausesTableScan: usesScanOnMissingIndex,
        recommendation: 'Must enforce PRAGMA table_info column verification and index verification in 7A.8.1',
      })
    } catch (err) {
      record('P02', 'Audit SQLite Schema contract', 'FAIL', { error: err.message })
    }

    // -------------------------------------------------------------------------
    // P03: Read-Only Open, Sidecars, Trusted Schema, Write Prevention
    // -------------------------------------------------------------------------
    try {
      const roDbPath = join(testRoot, 'p03-ro.db')
      createStandardTestDb(roDbPath)

      // Compute initial SHA-256 and size
      const initialBytes = readFileSync(roDbPath)
      const initialSha256 = createHash('sha256').update(initialBytes).digest('hex')
      const initialStat = statSync(roDbPath)

      // Open read-only
      const roDb = new DatabaseSync(roDbPath, { readOnly: true, open: true })

      // Check trusted_schema default
      const trustedSchemaRow = roDb.prepare('PRAGMA trusted_schema').get()
      const trustedSchemaDefault = trustedSchemaRow?.trusted_schema

      // Test write attempt
      let writeThrew = false
      let writeError = null
      try {
        roDb.exec("INSERT INTO meta (key, value) VALUES ('malicious', 'data')")
      } catch (err) {
        writeThrew = true
        writeError = err.message
      }

      // Check if PRAGMA trusted_schema = 0 works in read-only
      roDb.exec('PRAGMA trusted_schema = 0')
      const trustedSchemaAfter = roDb.prepare('PRAGMA trusted_schema').get()?.trusted_schema

      roDb.close()

      // Check sidecars (.db-wal, .db-shm, -journal)
      const dirFiles = readdirSync(testRoot)
      const sidecars = dirFiles.filter((f) => f.startsWith('p03-ro.db-') || f.startsWith('p03-ro.db.'))

      // Check file mutation
      const finalBytes = readFileSync(roDbPath)
      const finalSha256 = createHash('sha256').update(finalBytes).digest('hex')
      const finalStat = statSync(roDbPath)

      const p03Pass =
        writeThrew === true &&
        initialSha256 === finalSha256 &&
        initialStat.size === finalStat.size &&
        trustedSchemaDefault === 1 &&
        trustedSchemaAfter === 0 &&
        sidecars.length === 0

      record('P03', 'Verify read-only open, sidecar creation, write prevention, and trusted_schema', p03Pass ? 'PASS' : 'FAIL', {
        writeThrew,
        writeError,
        fileMutated: initialSha256 !== finalSha256,
        sizeChanged: initialStat.size !== finalStat.size,
        sidecarsCreated: sidecars,
        trustedSchemaDefault, // Proves node:sqlite defaults to 1 (unsafe for untrusted DB)
        trustedSchemaCanBeDisabled: trustedSchemaAfter === 0,
        recommendation: 'Must issue PRAGMA trusted_schema = 0 immediately upon opening any custom database',
      })
    } catch (err) {
      record('P03', 'Verify read-only open and sidecars', 'FAIL', { error: err.message })
    }

    // -------------------------------------------------------------------------
    // P04: Invalid / Malformed Database Handling
    // -------------------------------------------------------------------------
    try {
      const manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      const coordinator = new ActivationCoordinator({ manager })

      // 1. Text file with .db extension
      const textDbPath = join(testRoot, 'p04-fake.db')
      writeFileSync(textDbPath, 'NOT A SQLITE FILE HEADER AT ALL', 'utf8')
      const textResult = await coordinator.verifyCustomDatabase(textDbPath)

      // 2. Zero-byte file
      const emptyDbPath = join(testRoot, 'p04-empty.db')
      writeFileSync(emptyDbPath, Buffer.alloc(0))
      const emptyResult = await coordinator.verifyCustomDatabase(emptyDbPath)

      // 3. Corrupted SQLite file (valid 16-byte header, followed by random junk)
      const corruptDbPath = join(testRoot, 'p04-corrupt.db')
      const corruptBuf = Buffer.alloc(4096)
      corruptBuf.write('SQLite format 3\0', 0, 16, 'ascii')
      corruptBuf.fill(0xff, 16)
      writeFileSync(corruptDbPath, corruptBuf)
      const corruptResult = await coordinator.verifyCustomDatabase(corruptDbPath)

      // 4. Missing required table
      const missingTablePath = join(testRoot, 'p04-missing-table.db')
      const dbMissing = new DatabaseSync(missingTablePath)
      dbMissing.exec("CREATE TABLE meta (key TEXT, value TEXT);")
      dbMissing.close()
      const missingTableResult = await coordinator.verifyCustomDatabase(missingTablePath)

      const p04Pass =
        textResult.valid === false &&
        emptyResult.valid === false &&
        corruptResult.valid === false &&
        missingTableResult.valid === false &&
        missingTableResult.errorCode === 'INVALID_DATABASE_SCHEMA'

      record('P04', 'Verify handling of invalid, corrupt, empty, and schema-deficient databases', p04Pass ? 'PASS' : 'FAIL', {
        textDbRejected: !textResult.valid,
        textDbError: textResult.error,
        emptyDbRejected: !emptyResult.valid,
        emptyDbError: emptyResult.error,
        corruptDbRejected: !corruptResult.valid,
        corruptDbError: corruptResult.error,
        missingTableRejected: !missingTableResult.valid,
        missingTableError: missingTableResult.error,
      })
    } catch (err) {
      record('P04', 'Verify invalid database handling', 'FAIL', { error: err.message })
    }

    // -------------------------------------------------------------------------
    // P05: Custom Path Handling, Symlinks, Junctions, Spaces, Windows Locks
    // -------------------------------------------------------------------------
    try {
      const manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      const coordinator = new ActivationCoordinator({ manager })

      // 1. Path with spaces and Unicode
      const unicodeDir = join(testRoot, '词典 目录 with spaces')
      mkdirSync(unicodeDir, { recursive: true })
      const unicodeDbPath = join(unicodeDir, '用户词典_custom.sqlite3')
      createStandardTestDb(unicodeDbPath)
      const unicodeResult = await coordinator.verifyCustomDatabase(unicodeDbPath)

      // 2. Non-existent path
      const missingPath = join(testRoot, 'non-existent.sqlite')
      const missingResult = await coordinator.verifyCustomDatabase(missingPath)

      // 3. Directory path with .db extension instead of regular file
      const dirMasqueradingAsDb = join(testRoot, 'masquerading-dir.db')
      mkdirSync(dirMasqueradingAsDb, { recursive: true })
      const dirResult = await coordinator.verifyCustomDatabase(dirMasqueradingAsDb)

      // 4. Windows File Locking Check: open DatabaseSync and attempt to unlink
      const lockDbPath = join(testRoot, 'p05-lock.db')
      createStandardTestDb(lockDbPath)
      const lockDb = new DatabaseSync(lockDbPath, { readOnly: true })
      let deleteFailedWhileLocked = false
      let deleteLockError = null
      try {
        unlinkSync(lockDbPath)
      } catch (err) {
        deleteFailedWhileLocked = true
        deleteLockError = err.code
      }
      lockDb.close()

      // After closing, can unlink cleanly
      let deleteSucceededAfterClose = false
      try {
        unlinkSync(lockDbPath)
        deleteSucceededAfterClose = true
      } catch {
        deleteSucceededAfterClose = false
      }

      // 5. Windows Symlink / Junction test
      let symlinkWorks = false
      const realTargetDb = join(testRoot, 'p05-symlink-target.db')
      createStandardTestDb(realTargetDb)
      const symlinkPath = join(testRoot, 'p05-symlink-link.sqlite3')
      try {
        symlinkSync(realTargetDb, symlinkPath, 'file')
        const symResult = await coordinator.verifyCustomDatabase(symlinkPath)
        symlinkWorks = symResult.valid
      } catch (err) {
        // Symlink creation on Windows may require SeCreateSymbolicLinkPrivilege (Developer Mode)
        symlinkWorks = false
      }

      const p05Pass =
        unicodeResult.valid === true &&
        missingResult.valid === false &&
        missingResult.errorCode === 'FILE_NOT_FOUND' &&
        dirResult.valid === false &&
        dirResult.errorCode === 'NOT_A_FILE' &&
        deleteFailedWhileLocked === true && // Proves Windows file lock prevents deletion while open
        deleteLockError === 'EBUSY' || deleteLockError === 'EPERM' &&
        deleteSucceededAfterClose === true

      record('P05', 'Verify path handling (Unicode, spaces, nonexistent, directories, Windows file locks)', p05Pass ? 'PASS' : 'FAIL', {
        unicodeAndSpacesSupported: unicodeResult.valid,
        nonexistentHandledCleanly: !missingResult.valid && missingResult.errorCode === 'FILE_NOT_FOUND',
        directoryHandledCleanly: !dirResult.valid && dirResult.errorCode === 'NOT_A_FILE',
        windowsLockPreventsDeleteWhileOpen: deleteFailedWhileLocked,
        deleteLockErrorCode: deleteLockError,
        deleteSucceedsAfterClose: deleteSucceededAfterClose,
        symlinkSupported: symlinkWorks,
        recommendation: 'Must enforce handle closure before unlinking/retiring on Windows to avoid EBUSY',
      })
    } catch (err) {
      record('P05', 'Verify path handling', 'FAIL', { error: err.message })
    }

    // -------------------------------------------------------------------------
    // P06: User File Ownership & Quarantine Safety
    // -------------------------------------------------------------------------
    try {
      const userHome = join(testRoot, 'user-documents')
      mkdirSync(userHome, { recursive: true })
      const userDbPath = join(userHome, 'my-precious-dictionary.sqlite3')
      createStandardTestDb(userDbPath)

      // Storage paths
      const dshHome = join(testRoot, 'dsh-home')
      mkdirSync(dshHome, { recursive: true })
      const paths = resolveManagedStoragePaths({ home: dshHome })

      const manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      const coordinator = new ActivationCoordinator({ paths, manager })

      // Verify that removeManagedDatabase does NOT touch userDbPath
      const userDbExistsBefore = existsSync(userDbPath)
      await coordinator.removeManagedDatabase()
      const userDbExistsAfter = existsSync(userDbPath)

      const p06Pass =
        userDbExistsBefore === true &&
        userDbExistsAfter === true &&
        !userDbPath.startsWith(paths.storageDirectory)

      record('P06', 'Verify user file ownership and isolation from managed removal/quarantine', p06Pass ? 'PASS' : 'FAIL', {
        userDbPreserved: userDbExistsAfter,
        userDbOutsideStorage: !userDbPath.startsWith(paths.storageDirectory),
        managedDbDir: paths.databaseDirectory,
        userDbPath,
        recommendation: 'USER_OWNED_CUSTOM_DATABASE must never be deleted, renamed, or relocated by the plugin',
      })
    } catch (err) {
      record('P06', 'Verify user file ownership', 'FAIL', { error: err.message })
    }

    // -------------------------------------------------------------------------
    // P07: File Replacement / TOCTOU
    // -------------------------------------------------------------------------
    try {
      const candidatePath = join(testRoot, 'p07-candidate.db')
      createStandardTestDb(candidatePath, { schemaVersion: 1 })

      const manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      const coordinator = new ActivationCoordinator({ manager })

      // Step 1: verify candidate
      const initialVerification = await coordinator.verifyCustomDatabase(candidatePath)
      const stat1 = statSync(candidatePath)

      // Step 2: replace file with invalid content (simulate TOCTOU race before activation)
      writeFileSync(candidatePath, 'TOTALLY INVALID CONTENT SWAPPED IN', 'utf8')
      const stat2 = statSync(candidatePath)

      // Step 3: if we opened candidate now without re-verification, accessing pages fails
      let openOrQueryFailedOnReplacedFile = false
      let queryErrorOnReplacedFile = null
      try {
        const replacedDb = new DatabaseSync(candidatePath, { readOnly: true })
        try {
          replacedDb.prepare('SELECT COUNT(*) FROM entries').get()
        } finally {
          replacedDb.close()
        }
      } catch (err) {
        openOrQueryFailedOnReplacedFile = true
        queryErrorOnReplacedFile = err.message
      }

      const p07Pass =
        initialVerification.valid === true &&
        stat1.mtimeMs !== stat2.mtimeMs &&
        openOrQueryFailedOnReplacedFile === true

      record('P07', 'Inspect TOCTOU vulnerability when custom database file is replaced after verification', p07Pass ? 'PASS' : 'FAIL', {
        initialVerificationValid: initialVerification.valid,
        mtimeChangedOnSwap: stat1.mtimeMs !== stat2.mtimeMs,
        openOrQueryFailedOnReplacedFile,
        queryErrorOnReplacedFile,
        risk: 'HIGH: file can change between /verify and /activate without atomic lock',
        recommendation: 'Activation transaction MUST re-verify candidate or check fingerprint (mtime + size + header hash) at commit boundary',
      })
    } catch (err) {
      record('P07', 'Inspect TOCTOU vulnerability', 'FAIL', { error: err.message })
    }
  } finally {
    try {
      rmSync(testRoot, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }

  return results
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runSqliteSafetyProbes().then((results) => {
    console.log(JSON.stringify(results, null, 2))
  })
}
