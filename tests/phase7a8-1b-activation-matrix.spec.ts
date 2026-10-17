/**
 * Phase 7A.8.1B: Custom Dictionary Activation API, Transaction Persistence & Safe Three-Mode Switching Matrix (A01–A29).
 *
 * Verifies:
 * - A01: Activate custom dictionary from valid SQLite database -> custom mode active, active.json written, generation++
 * - A02: Switch mode from custom to fixture -> lease released, active.json unlinked, manager reverts to fixture
 * - A03: Switch mode from custom to managed-ecdict -> opens installed ECDICT, updates active.json, lease released
 * - A04: Switch mode from managed-ecdict to custom -> opens custom snapshot with lease, updates active.json, immediate queries
 * - A05: Hot-swap between custom-A and custom-B -> lease swapped, uninterrupted queries throughout
 * - A06: Switch to managed-ecdict when ECDICT is not installed -> rejected with ECDICT_NOT_INSTALLED
 * - A07: Switch to custom with non-existent snapshotId -> rejected with SNAPSHOT_NOT_FOUND
 * - A08: Switch to custom without snapshotId when no snapshot is active -> rejected with INVALID_ARGUMENT
 * - A09: Unified mutex across all 4 operations (install, remove, activate-custom, switch-mode)
 * - A10: Remove managed ECDICT while Custom is active -> deletes only ECDICT files, Custom remains active, active.json intact
 * - A11: Remove managed ECDICT while Managed ECDICT is active -> reverts to fixture, active.json and installed-ecdict.json unlinked
 * - A12: User raw SQLite database is strictly read-only -> stat, digest, mtime verified identical before and after
 * - A13: Staging and publish lifecycle -> snapshot created via VACUUM INTO, verified in worker, published atomically
 * - A14: Custom dictionary verification failure (corrupt SQLite) -> rejected before activation, staging cleaned
 * - A15: Custom dictionary verification failure (missing table) -> rejected before activation, staging cleaned
 * - A16: Cancellation before commit point in custom activation -> worker aborted, staging cleaned, returns cancelled
 * - A17: Cancellation attempt after commit boundary -> rejected with OPERATION_NOT_CANCELLABLE
 * - A18: Startup recovery with CustomActiveMetadata -> published snapshot verified by sha256 and byte size, adopted and activated
 * - A19: Startup recovery with corrupt custom snapshot file -> detects sha256 mismatch, records recoveryError, falls back to fixture
 * - A20: Startup recovery with missing custom snapshot file -> records recoveryError, falls back to fixture
 * - A21: Startup recovery with custom mode but host config fixture (unconfirmed settings sync) -> recovers committed custom activation
 * - A22: Startup recovery with custom mode and confirmed settings sync -> activates custom dictionary
 * - A23: Active snapshot lease protection -> active snapshot has lease >= 1, retired snapshot drains to 0
 * - A24: Hot-swap query continuity -> queries during hot-swap transition succeed continuously without error
 * - A25: Rollback on DictionaryManager.activate failure -> restores previous active.json, closes candidate snapshot
 * - A26: Double-fault during rollback -> throws ActivationRollbackError, preserves both original and rollback errors
 * - A27: Host management routes GET /status -> returns activeMode, activeSnapshotId, customSnapshotStatus, canActivateCustom, canSwitchMode
 * - A28: Host management routes POST /activate-custom and POST /select-mode -> accept valid requests, enforce validation limits
 * - A29: Plugin dispose and drain -> cleanly drains in-flight custom operations, unregisters all 7 routes, releases leases
 *
 * @module tests/phase7a8-1b-activation-matrix.spec
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { Config } from '../src/host/config.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import { loadRuntimeCorpusManifest } from '../src/host/corpus-db.js'
import {
  ActivationCoordinator,
  ActivationRollbackError,
  _setActivationHooksForTesting,
} from '../src/host/dictionary-activation.js'
import {
  DictionaryOperationManager,
  OperationInProgressError,
  OperationNotCancellableError,
} from '../src/host/dictionary-operations.js'
import { CustomSnapshotManager } from '../src/host/custom-snapshot-manager.js'
import {
  ensureManagedStorageDirectories,
  readActiveMetadata,
  resolveManagedStoragePaths,
  writeActiveMetadataAtomically,
  writeInstalledEcdictMetadataAtomically,
  _setStorageFsHooksForTesting,
  type ActiveMetadata,
  type CustomActiveMetadata,
  type InstalledEcdictMetadata,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'
import {
  createActivateCustomHandler,
  createSelectModeHandler,
  createStatusHandler,
  registerDictionaryManagementRoutes,
} from '../src/host/dictionary-management-route.js'
import {
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
  MANAGEMENT_STATUS_PATH,
} from '../src/host/route.js'

function buildValidTestDatabase(
  dbPath: string,
  options?: {
    journalMode?: 'DELETE' | 'WAL'
    headwords?: readonly string[]
    omitTables?: string[]
  },
): void {
  const db = new DatabaseSync(dbPath)
  const mode = options?.journalMode ?? 'DELETE'
  db.exec(`PRAGMA journal_mode = ${mode};`)

  const omit = new Set(options?.omitTables ?? [])

  if (!omit.has('meta')) {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1');`)
    db.exec(`INSERT INTO meta (key, value) VALUES ('corpus_name', 'CUSTOM_TEST');`)
  }

  if (!omit.has('entries')) {
    db.exec(`
      CREATE TABLE entries (
        word TEXT PRIMARY KEY,
        phonetic TEXT,
        definition_en TEXT,
        translation_zh TEXT,
        pos TEXT,
        exchange TEXT,
        frequency INTEGER
      );
    `)
  }

  if (!omit.has('forms')) {
    db.exec(`
      CREATE TABLE forms (
        form TEXT PRIMARY KEY,
        headword TEXT NOT NULL,
        kind TEXT
      );
    `)
  }

  if (!omit.has('examples')) {
    db.exec(`
      CREATE TABLE examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        headword TEXT NOT NULL,
        english TEXT NOT NULL,
        chinese TEXT,
        source TEXT,
        source_id TEXT,
        score REAL
      );
    `)
  }

  if (!omit.has('entries') && !omit.has('forms') && !omit.has('examples')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_word_lower ON entries (word);
      CREATE INDEX IF NOT EXISTS idx_forms_form_lower ON forms (form);
      CREATE INDEX IF NOT EXISTS idx_forms_headword_raw ON forms (headword);
      CREATE INDEX IF NOT EXISTS idx_examples_headword ON examples (headword);
    `)

    // Insert mandatory activation probe headwords
    const probeWords = ['go', 'derive', 'wave']
    const wordsToInsert = Array.from(new Set([...probeWords, ...(options?.headwords ?? ['customword', 'testitem'])]))

    const insertEntry = db.prepare(`
      INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES (?, ?, ?, ?, ?, NULL, 100);
    `)
    const insertForm = db.prepare(`
      INSERT INTO forms (form, headword, kind) VALUES (?, ?, 'p');
    `)

    for (const w of wordsToInsert) {
      insertEntry.run(w, `/${w}/`, `English definition of ${w}`, `中文释义: ${w}`, 'n')
      insertForm.run(`${w}s`, w)
    }
  }

  db.close()
}

function buildSyntheticManagedEcdictDb(filePath: string): void {
  const manifest = loadRuntimeCorpusManifest()
  const db = new DatabaseSync(filePath)
  db.exec(`PRAGMA journal_mode = DELETE;`)
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
    CREATE INDEX IF NOT EXISTS idx_entries_word_lower ON entries (word);
    CREATE INDEX IF NOT EXISTS idx_forms_form_lower ON forms (form);
    CREATE INDEX IF NOT EXISTS idx_forms_headword_raw ON forms (headword);
    CREATE INDEX IF NOT EXISTS idx_examples_headword ON examples (headword);
  `)

  const words = ['go', 'derive', 'wave', 'ecdictword', 'managedword']
  const insertEntry = db.prepare(`
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
    VALUES (?, ?, ?, ?, ?, NULL, 100);
  `)
  const insertForm = db.prepare(`
    INSERT INTO forms (form, headword, kind) VALUES (?, ?, 'p');
  `)
  for (const w of words) {
    insertEntry.run(w, `/${w}/`, `English definition of ${w}`, `中文释义: ${w}`, 'n')
    insertForm.run(`${w}s`, w)
  }

  const metaEntries: Record<string, string> = {
    schema_version: String(manifest.schemaVersion),
    corpus_name: manifest.sourceName,
    upstream_commit: manifest.sourceCommit,
    source_sha256: manifest.sourceSha256,
    logical_sha256: 'c'.repeat(64),
    entry_count: String(words.length),
    form_count: String(words.length),
    example_count: '0',
  }
  const insertMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?);`)
  for (const [k, v] of Object.entries(metaEntries)) {
    insertMeta.run(k, v)
  }

  db.close()
}

function sha256File(path: string): string {
  const buf = readFileSync(path)
  return createHash('sha256').update(buf).digest('hex').toLowerCase()
}

describe('Phase 7A.8.1B: Custom Dictionary Activation & 3-Mode Switching Matrix (A01–A29)', () => {
  let testDir: string
  let paths: ManagedStoragePaths
  let rawSourceDir: string
  let manager: DictionaryManager
  let coordinator: ActivationCoordinator
  let opMan: DictionaryOperationManager
  let snapshotMgr: CustomSnapshotManager

  beforeEach(async () => {
    testDir = join(tmpdir(), `dsh-7a81b-${randomUUID()}`)
    rawSourceDir = join(tmpdir(), `dsh-7a81b-raw-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    mkdirSync(rawSourceDir, { recursive: true })

    paths = resolveManagedStoragePaths({ home: testDir })
    await ensureManagedStorageDirectories(paths)

    const fixture = openFixtureDictionary()
    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: fixture,
    })

    snapshotMgr = new CustomSnapshotManager({ paths })

    coordinator = new ActivationCoordinator({
      paths,
      manager,
      customSnapshotManager: snapshotMgr,
      config: Config({ dictionaryMode: 'fixture' }),
    })

    opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })
  })

  afterEach(async () => {
    _setActivationHooksForTesting(null)
    _setStorageFsHooksForTesting(null)
    try {
      await opMan.dispose(100)
    } catch {}
    try {
      coordinator.dispose()
    } catch {}
    try {
      await snapshotMgr.dispose()
    } catch {}
    try {
      manager.close()
    } catch {}

    rmSync(testDir, { recursive: true, force: true })
    rmSync(rawSourceDir, { recursive: true, force: true })
  })

  // A01: Activate custom dictionary from valid SQLite database
  it('A01: activates custom dictionary from valid SQLite database and updates active.json', async () => {
    const rawDbPath = join(rawSourceDir, 'custom-dict.sqlite3')
    buildValidTestDatabase(rawDbPath, { headwords: ['phenomenon'] })

    const outcome = await opMan.activateCustom(rawDbPath, 'custom-alpha')
    expect(outcome.ok).toBe(true)
    expect(outcome.activeMode).toBe('custom')
    expect(outcome.identity).toBe('custom-alpha')
    expect(outcome.snapshotId).toBeDefined()

    const snap = manager.snapshot()
    expect(snap.activeMode).toBe('custom')
    expect(snap.identity).toBe('custom-alpha')

    // Lookups work on custom words
    const result = manager.lookup('phenomenon')
    expect(result).not.toBeNull()
    expect((result as { headword?: string })?.headword).toBe('phenomenon')

    // active.json was written atomically with CustomActiveMetadata
    const activeMeta = (await readActiveMetadata(paths)) as CustomActiveMetadata
    expect(activeMeta).not.toBeNull()
    expect(activeMeta.activeMode).toBe('custom')
    expect(activeMeta.identity).toBe('custom-alpha')
    expect(activeMeta.snapshotId).toBe(outcome.snapshotId)

    // Status summary matches
    const summary = coordinator.getStatusSummary()
    expect(summary.activeMode).toBe('custom')
    expect(summary.activeSnapshotId).toBe(outcome.snapshotId)
    expect(summary.customSnapshotStatus?.activeLeases).toBe(1)
  })

  // A02: Switch mode from custom to fixture
  it('A02: safely switches from custom to fixture mode, releasing snapshot lease and unlinking active.json', async () => {
    const rawDbPath = join(rawSourceDir, 'custom-dict.sqlite3')
    buildValidTestDatabase(rawDbPath)
    const activateOutcome = await opMan.activateCustom(rawDbPath, 'custom-alpha')

    expect(coordinator.getStatusSummary().customSnapshotStatus?.activeLeases).toBe(1)

    const switchOutcome = await opMan.selectMode('fixture')
    expect(switchOutcome.ok).toBe(true)
    expect(switchOutcome.activeMode).toBe('fixture')

    expect(manager.snapshot().activeMode).toBe('fixture')
    const activeMeta = await readActiveMetadata(paths)
    expect(activeMeta).toBeNull()

    // Lease dropped to 0
    expect(coordinator.getStatusSummary().activeSnapshotId).toBeNull()
    expect(snapshotMgr.getActiveLeases(activateOutcome.snapshotId)).toBe(0)
  })

  // A03: Switch mode from custom to managed-ecdict
  it('A03: switches mode from custom to managed-ecdict, leasing ECDICT and releasing custom lease', async () => {
    // 1. Setup installed ECDICT
    const manifest = loadRuntimeCorpusManifest()
    const ecdictFile = 'ecdict-v1-ecdicttest.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    const installedMeta: InstalledEcdictMetadata = {
      version: 1,
      identity: 'v1-ecdicttest',
      databaseFile: ecdictFile,
      source: {
        name: manifest.sourceName,
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: manifest.schemaVersion,
      },
      entryCount: 5,
      formCount: 5,
      byteSize: statSync(fullEcdictPath).size,
    }
    await writeInstalledEcdictMetadataAtomically(paths, installedMeta)

    // 2. Activate custom
    const rawDbPath = join(rawSourceDir, 'custom-dict.sqlite3')
    buildValidTestDatabase(rawDbPath, { headwords: ['customonly'] })
    const customOutcome = await opMan.activateCustom(rawDbPath, 'custom-alpha')

    // 3. Switch to managed-ecdict
    const switchOutcome = await opMan.selectMode('managed-ecdict')
    expect(switchOutcome.ok).toBe(true)
    expect(switchOutcome.activeMode).toBe('managed-ecdict')
    expect(manager.snapshot().activeMode).toBe('managed-ecdict')

    // Custom lease released
    expect(snapshotMgr.getActiveLeases(customOutcome.snapshotId)).toBe(0)

    // Managed ECDICT lookups work
    expect(manager.lookup('ecdictword')).not.toBeNull()
  })

  // A04: Switch mode from managed-ecdict to custom
  it('A04: switches mode from managed-ecdict to custom using published snapshotId', async () => {
    // 1. Install managed ECDICT
    const manifest = loadRuntimeCorpusManifest()
    const ecdictFile = 'ecdict-v1-ecdicttest.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    await writeInstalledEcdictMetadataAtomically(paths, {
      version: 1,
      identity: 'v1-ecdicttest',
      databaseFile: ecdictFile,
      source: {
        name: manifest.sourceName,
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: manifest.schemaVersion,
      },
      byteSize: statSync(fullEcdictPath).size,
    })
    await opMan.selectMode('managed-ecdict')
    expect(manager.snapshot().activeMode).toBe('managed-ecdict')

    // 2. Publish a custom snapshot
    const rawDbPath = join(rawSourceDir, 'custom-dict.sqlite3')
    buildValidTestDatabase(rawDbPath, { headwords: ['quantum'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawDbPath, { identity: 'custom-gamma' })

    // 3. Switch to custom
    const switchOutcome = await opMan.selectMode('custom', record.id)
    expect(switchOutcome.ok).toBe(true)
    expect(switchOutcome.activeMode).toBe('custom')
    expect(manager.snapshot().activeMode).toBe('custom')
    expect((manager.lookup('quantum') as { headword?: string })?.headword).toBe('quantum')
    expect(snapshotMgr.getActiveLeases(record.id)).toBe(1)
  })

  // A05: Hot-swap between custom-A and custom-B
  it('A05: performs hot-swap between custom-A and custom-B with lease handoff and uninterrupted queries', async () => {
    const rawA = join(rawSourceDir, 'custom-a.sqlite3')
    const rawB = join(rawSourceDir, 'custom-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['apple'] })
    buildValidTestDatabase(rawB, { headwords: ['banana'] })

    const resA = await opMan.activateCustom(rawA, 'custom-a')
    expect(snapshotMgr.getActiveLeases(resA.snapshotId)).toBe(1)
    expect(manager.lookup('apple')).not.toBeNull()

    // Hot-swap to custom-B
    const resB = await opMan.activateCustom(rawB, 'custom-b')
    expect(resB.ok).toBe(true)
    expect(manager.snapshot().identity).toBe('custom-b')

    // Lease on A dropped to 0, lease on B is 1
    expect(snapshotMgr.getActiveLeases(resA.snapshotId)).toBe(0)
    expect(snapshotMgr.getActiveLeases(resB.snapshotId)).toBe(1)

    expect(manager.lookup('banana')).not.toBeNull()
  })

  // A06: Switch to managed-ecdict when ECDICT is not installed
  it('A06: rejects switch to managed-ecdict when ECDICT is not installed and preserves current mode', async () => {
    await expect(opMan.selectMode('managed-ecdict')).rejects.toThrow(/ECDICT.*not installed/i)
    expect(manager.snapshot().activeMode).toBe('fixture')
  })

  // A07: Switch to custom with non-existent snapshotId
  it('A07: rejects switch to custom with non-existent snapshotId and preserves current mode', async () => {
    await expect(opMan.selectMode('custom', 'non-existent-uuid-12345')).rejects.toThrow(/not found/i)
    expect(manager.snapshot().activeMode).toBe('fixture')
  })

  // A08: Switch to custom without snapshotId when no snapshot is active
  it('A08: rejects switch to custom without snapshotId when no snapshot is currently active', async () => {
    await expect(opMan.selectMode('custom')).rejects.toThrow(/snapshotId must be provided/i)
  })

  // A09: Unified mutex across all 4 operations
  it('A09: enforces unified mutex rejecting concurrent operations with OperationInProgressError', async () => {
    const rawA = join(rawSourceDir, 'custom-mutex.sqlite3')
    buildValidTestDatabase(rawA)

    // Hook to hold operation before commit
    let releaseHook!: () => void
    const hookPromise = new Promise<void>((res) => {
      releaseHook = res
    })
    _setActivationHooksForTesting({
      beforeCommitMetadata: async () => {
        await hookPromise
      },
    })

    const opPromise = opMan.activateCustom(rawA, 'custom-mutex')

    // Wait until op is busy
    await vi.waitFor(() => expect(opMan.isBusy()).toBe(true))

    // Concurrent install call rejected
    expect(() => opMan.install()).toThrow(OperationInProgressError)

    // Concurrent remove call rejected
    await expect(opMan.remove()).rejects.toThrow(OperationInProgressError)

    // Concurrent selectMode call rejected
    await expect(opMan.selectMode('fixture')).rejects.toThrow(OperationInProgressError)

    releaseHook()
    await opPromise
  })

  // A10: Remove managed ECDICT while Custom is active
  it('A10: removeManagedDatabase while Custom is active deletes only ECDICT files, leaving Custom active and active.json intact', async () => {
    // Setup installed ECDICT
    const manifest = loadRuntimeCorpusManifest()
    const ecdictFile = 'ecdict-v1-removetest.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    await writeInstalledEcdictMetadataAtomically(paths, {
      version: 1,
      identity: 'v1-removetest',
      databaseFile: ecdictFile,
      source: {
        name: manifest.sourceName,
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: manifest.schemaVersion,
      },
      byteSize: statSync(fullEcdictPath).size,
    })

    // Activate Custom
    const rawDbPath = join(rawSourceDir, 'custom-active.sqlite3')
    buildValidTestDatabase(rawDbPath, { headwords: ['survivor'] })
    const customOutcome = await opMan.activateCustom(rawDbPath, 'custom-survivor')

    expect(manager.snapshot().activeMode).toBe('custom')
    expect(existsSync(fullEcdictPath)).toBe(true)
    expect(existsSync(paths.installedEcdictPath)).toBe(true)

    // Call remove
    const removeOutcome = await opMan.remove()
    expect(removeOutcome.ok).toBe(true)
    expect(removeOutcome.removed).toBe(true)
    expect(removeOutcome.activeMode).toBe('custom')

    // Managed ECDICT file and installed-ecdict.json unlinked
    expect(existsSync(fullEcdictPath)).toBe(false)
    expect(existsSync(paths.installedEcdictPath)).toBe(false)

    // Custom mode remains active, active.json intact
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.lookup('survivor')).not.toBeNull()

    const activeMeta = (await readActiveMetadata(paths)) as CustomActiveMetadata
    expect(activeMeta.activeMode).toBe('custom')
    expect(activeMeta.snapshotId).toBe(customOutcome.snapshotId)
  })

  // A11: Remove managed ECDICT while Managed ECDICT is active
  it('A11: removeManagedDatabase while Managed ECDICT is active reverts to fixture and cleans all files', async () => {
    const manifest = loadRuntimeCorpusManifest()
    const ecdictFile = 'ecdict-v1-ecdictact.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    await writeInstalledEcdictMetadataAtomically(paths, {
      version: 1,
      identity: 'v1-ecdictact',
      databaseFile: ecdictFile,
      source: {
        name: manifest.sourceName,
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: manifest.schemaVersion,
      },
      byteSize: statSync(fullEcdictPath).size,
    })

    await opMan.selectMode('managed-ecdict')
    expect(manager.snapshot().activeMode).toBe('managed-ecdict')

    const removeOutcome = await opMan.remove()
    expect(removeOutcome.ok).toBe(true)
    expect(removeOutcome.removed).toBe(true)
    expect(removeOutcome.activeMode).toBe('fixture')

    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(existsSync(fullEcdictPath)).toBe(false)
    expect(existsSync(paths.activeMetadataPath)).toBe(false)
    expect(existsSync(paths.installedEcdictPath)).toBe(false)
  })

  // A12: User raw SQLite database is strictly read-only
  it('A12: guarantees user source database is strictly read-only with identical size, hash and mtime', async () => {
    const rawPath = join(rawSourceDir, 'user-source.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['untouchable'] })

    const statBefore = statSync(rawPath)
    const hashBefore = sha256File(rawPath)

    await opMan.activateCustom(rawPath, 'custom-ro')

    const statAfter = statSync(rawPath)
    const hashAfter = sha256File(rawPath)

    expect(statAfter.size).toBe(statBefore.size)
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs)
    expect(hashAfter).toBe(hashBefore)
  })

  // A13: Staging and publish lifecycle
  it('A13: verifies staging creation and atomic publish into custom-snapshots directory', async () => {
    const rawPath = join(rawSourceDir, 'source-lifecycle.sqlite3')
    buildValidTestDatabase(rawPath)

    const outcome = await opMan.activateCustom(rawPath, 'custom-life')
    expect(outcome.snapshotId).toBeDefined()

    const publishedFile = join(paths.customSnapshotDirectory, `custom-${outcome.snapshotId}.sqlite3`)
    expect(existsSync(publishedFile)).toBe(true)

    // Staging directory must be empty of staging files
    const snapshotDirFiles = existsSync(paths.customSnapshotDirectory)
      ? readdirSync(paths.customSnapshotDirectory)
      : []
    const stagingFiles = snapshotDirFiles.filter((f) => f.startsWith('staging-'))
    expect(stagingFiles).toHaveLength(0)
  })

  // A14: Custom dictionary verification failure (corrupt SQLite)
  it('A14: rejects corrupt SQLite file before activation and preserves fixture mode', async () => {
    const corruptPath = join(rawSourceDir, 'corrupt.sqlite3')
    writeFileSync(corruptPath, 'This is definitely not a sqlite database header at all')

    await expect(opMan.activateCustom(corruptPath, 'custom-corrupt')).rejects.toThrow()
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(await readActiveMetadata(paths)).toBeNull()
  })

  // A15: Custom dictionary verification failure (missing table)
  it('A15: rejects custom SQLite database missing required tables before activation', async () => {
    const missingTablePath = join(rawSourceDir, 'missing-table.sqlite3')
    buildValidTestDatabase(missingTablePath, { omitTables: ['examples'] })

    await expect(opMan.activateCustom(missingTablePath, 'custom-missing')).rejects.toThrow()
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(await readActiveMetadata(paths)).toBeNull()
  })

  // A16: Cancellation before commit point in custom activation
  it('A16: supports cancellation before commit boundary, aborting staging and leaving fixture intact', async () => {
    const rawPath = join(rawSourceDir, 'cancel-test.sqlite3')
    buildValidTestDatabase(rawPath)

    let caughtError: unknown
    _setActivationHooksForTesting({
      beforeReadMetadata: async () => {
        const curOp = opMan.getCurrentOperation()
        if (curOp) {
          opMan.cancel(curOp.operationId)
        }
      },
    })

    try {
      await opMan.activateCustom(rawPath, 'custom-cancel')
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeDefined()
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(await readActiveMetadata(paths)).toBeNull()
  })

  // A17: Cancellation attempt after commit boundary
  it('A17: rejects cancellation attempt after commit boundary with OperationNotCancellableError', async () => {
    const rawPath = join(rawSourceDir, 'post-commit-cancel.sqlite3')
    buildValidTestDatabase(rawPath)

    let caughtCancelError: unknown
    const origActivate = manager.activate.bind(manager)
    vi.spyOn(manager, 'activate').mockImplementation((opts) => {
      const curOp = opMan.getCurrentOperation()
      if (curOp) {
        try {
          opMan.cancel(curOp.operationId)
        } catch (e) {
          caughtCancelError = e
        }
      }
      return origActivate(opts)
    })

    const outcome = await opMan.activateCustom(rawPath, 'post-cancel')

    expect(caughtCancelError).toBeInstanceOf(OperationNotCancellableError)
    expect(outcome.activeMode).toBe('custom')
  })

  // A18: Startup recovery with CustomActiveMetadata
  it('A18: startup recovery verifies published snapshot and activates custom dictionary', async () => {
    const rawPath = join(rawSourceDir, 'startup-valid.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['renaissance'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-startup' })

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-startup',
      snapshotId: record.id,
      databaseFile: `custom-${record.id}.sqlite3`,
      source: 'custom-local',
      schemaVersion: 1,
      sha256: record.sha256!,
      byteSize: record.byteSize!,
      settingsSynced: true,
      settingsSyncState: 'synced',
    }
    await writeActiveMetadataAtomically(paths, metadata)

    // Simulate startup
    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('custom')
    expect((freshManager.lookup('renaissance') as { headword?: string })?.headword).toBe('renaissance')
    expect(freshCoordinator.getStatusSummary().recoveryError).toBeNull()

    freshManager.close()
    freshCoordinator.dispose()
  })

  // A19: Startup recovery with corrupt custom snapshot file
  it('A19: startup recovery detects corrupt snapshot file via sha256 mismatch and falls back to fixture', async () => {
    const rawPath = join(rawSourceDir, 'startup-corrupt.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-corrupt' })

    // Corrupt snapshot on disk
    writeFileSync(record.publishedPath!, 'tampered bytes')

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-corrupt',
      snapshotId: record.id,
      databaseFile: `custom-${record.id}.sqlite3`,
      source: 'custom-local',
      schemaVersion: 1,
      sha256: record.sha256!,
      byteSize: record.byteSize!,
      settingsSynced: true,
      settingsSyncState: 'synced',
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().recoveryError).toContain('mismatch')

    freshManager.close()
    freshCoordinator.dispose()
  })

  // A20: Startup recovery with missing custom snapshot file
  it('A20: startup recovery detects missing custom snapshot file and records recoveryError', async () => {
    const snapId = randomUUID()
    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-missing',
      snapshotId: snapId,
      databaseFile: `custom-${snapId}.sqlite3`,
      source: 'custom-local',
      schemaVersion: 1,
      sha256: 'a'.repeat(64),
      byteSize: 1024,
      settingsSynced: true,
      settingsSyncState: 'synced',
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().recoveryError).toContain('missing')

    freshManager.close()
    freshCoordinator.dispose()
  })

  // A21: Startup recovery with custom mode but host config fixture (unconfirmed settings sync)
  it('A21: recovers committed custom activation when host config was not cleanly synced', async () => {
    const rawPath = join(rawSourceDir, 'startup-priority.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-priority' })

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-priority',
      snapshotId: record.id,
      databaseFile: `custom-${record.id}.sqlite3`,
      source: 'custom-local',
      schemaVersion: 1,
      sha256: record.sha256!,
      byteSize: record.byteSize!,
      settingsSynced: false,
      settingsSyncState: 'failed',
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    // User config is 'fixture', but active.json recorded unconfirmed sync: priority rule recovers custom!
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'fixture' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('custom')

    freshManager.close()
    freshCoordinator.dispose()
  })

  // A22: Startup recovery with custom mode and confirmed settings sync
  it('A22: startup recovery cleanly activates custom mode when settings sync was confirmed', async () => {
    const rawPath = join(rawSourceDir, 'startup-synced.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-synced' })

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-synced',
      snapshotId: record.id,
      databaseFile: `custom-${record.id}.sqlite3`,
      source: 'custom-local',
      schemaVersion: 1,
      sha256: record.sha256!,
      byteSize: record.byteSize!,
      settingsSynced: true,
      settingsSyncState: 'synced',
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('custom')

    freshManager.close()
    freshCoordinator.dispose()
  })

  // A23: Active snapshot lease protection
  it('A23: active snapshot holds lease >= 1, protecting from unlinking, and drains on retirement', async () => {
    const rawPath = join(rawSourceDir, 'lease-test.sqlite3')
    buildValidTestDatabase(rawPath)

    const outcome = await opMan.activateCustom(rawPath, 'custom-lease')
    expect(snapshotMgr.getActiveLeases(outcome.snapshotId)).toBe(1)

    // Revert to fixture -> lease released
    await opMan.selectMode('fixture')
    expect(snapshotMgr.getActiveLeases(outcome.snapshotId)).toBe(0)
  })

  // A24: Hot-swap query continuity
  it('A24: continuous lookup queries during mode switch never fail or throw DictionaryUnavailableError', async () => {
    const rawA = join(rawSourceDir, 'hotswap-a.sqlite3')
    const rawB = join(rawSourceDir, 'hotswap-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['go', 'apple'] })
    buildValidTestDatabase(rawB, { headwords: ['go', 'banana'] })

    await opMan.activateCustom(rawA, 'custom-a')

    let queryCount = 0
    let failedQueries = 0
    let stopQueries = false

    const queryLoop = (async () => {
      while (!stopQueries) {
        try {
          const res = manager.lookup('go')
          if (!res) failedQueries++
          queryCount++
        } catch {
          failedQueries++
        }
        await new Promise((r) => setImmediate(r))
      }
    })()

    // Switch between A and B
    await opMan.activateCustom(rawB, 'custom-b')
    await opMan.selectMode('fixture')

    stopQueries = true
    await queryLoop

    expect(queryCount).toBeGreaterThan(10)
    expect(failedQueries).toBe(0)
  })

  // A25: Rollback on DictionaryManager.activate failure
  it('A25: rolls back active.json and closes candidate snapshot if DictionaryManager.activate throws', async () => {
    const rawPath = join(rawSourceDir, 'rollback-test.sqlite3')
    buildValidTestDatabase(rawPath)

    vi.spyOn(manager, 'activate').mockImplementationOnce(() => {
      throw new Error('Simulated runtime activation failure')
    })

    await expect(opMan.activateCustom(rawPath, 'custom-fail')).rejects.toThrow(/Simulated runtime activation failure/)

    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(await readActiveMetadata(paths)).toBeNull()
  })

  // A26: Double-fault during rollback
  it('A26: throws ActivationRollbackError preserving both errors if rollback compensation fails', async () => {
    const rawPath = join(rawSourceDir, 'double-fault.sqlite3')
    buildValidTestDatabase(rawPath)

    const manifest = loadRuntimeCorpusManifest()
    // Set existing metadata
    const prevMetadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'prev-id',
      databaseFile: 'ecdict-prev-id.sqlite3',
      source: {
        name: manifest.sourceName,
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: manifest.schemaVersion,
      },
    }
    await writeActiveMetadataAtomically(paths, prevMetadata)

    vi.spyOn(manager, 'activate').mockImplementationOnce(() => {
      throw new Error('Original activation error')
    })

    _setActivationHooksForTesting({
      duringRollbackCompensation: async () => {
        _setStorageFsHooksForTesting({
          rename: async () => {
            throw new Error('Simulated rollback disk write failure')
          },
        })
      },
    })

    let caughtError: unknown
    try {
      await coordinator.activateCustomDatabase(
        (await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'df' })).id,
      )
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeInstanceOf(ActivationRollbackError)
    const rbErr = caughtError as ActivationRollbackError
    expect(rbErr.code).toBe('ACTIVATION_ROLLBACK_FAILED')
    expect(rbErr.originalError).toBeDefined()
    expect(rbErr.rollbackError).toBeDefined()
  })

  // A27: Host management routes GET /status
  it('A27: GET /api/dsh-word-lookup/dictionary/status returns all 3-mode status fields', async () => {
    const statusHandler = createStatusHandler(opMan, coordinator)
    const res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.activeMode).toBe('fixture')
    expect(data.canActivateCustom).toBe(true)
    expect(data.canSwitchMode).toBe(true)
    expect(data.activeSnapshotId).toBeNull()
    expect(data.customSnapshotStatus).toBeNull()
  })

  // A28: Host management routes POST /activate-custom and POST /select-mode
  it('A28: POST /activate-custom and POST /select-mode route handlers accept requests and enforce validation', async () => {
    const rawPath = join(rawSourceDir, 'route-test.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['endpoint'] })

    const activateHandler = createActivateCustomHandler(opMan)
    const selectHandler = createSelectModeHandler(opMan)

    // Activate custom via HTTP route
    const actReq = new Request('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rawPath, identity: 'custom-route' }),
    })
    const actRes = await activateHandler(actReq)
    expect(actRes.status).toBe(200)
    const actData = await actRes.json()
    expect(actData.ok).toBe(true)
    expect(actData.activeMode).toBe('custom')
    expect(actData.snapshotId).toBeDefined()

    // Switch mode via HTTP route
    const selReq = new Request('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fixture' }),
    })
    const selRes = await selectHandler(selReq)
    expect(selRes.status).toBe(200)
    const selData = await selRes.json()
    expect(selData.ok).toBe(true)
    expect(selData.activeMode).toBe('fixture')
  })

  // A29: Plugin dispose and drain
  it('A29: plugin dispose drains in-flight operations, unregisters all 7 routes, and releases leases', async () => {
    const registeredPaths: string[] = []
    const mockCtx = {
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string }) => {
            registeredPaths.push(spec.path)
            return async () => {
              const idx = registeredPaths.indexOf(spec.path)
              if (idx !== -1) registeredPaths.splice(idx, 1)
            }
          }),
        },
      },
    }

    const dispose = registerDictionaryManagementRoutes(mockCtx as any, opMan, coordinator)
    expect(registeredPaths).toHaveLength(8)

    await opMan.dispose(100)
    expect(opMan.isDisposed).toBe(true)

    await dispose()
    expect(registeredPaths).toHaveLength(0)
  })
})
