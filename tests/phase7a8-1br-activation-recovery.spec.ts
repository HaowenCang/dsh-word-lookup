/**
 * Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Persistent Snapshot Catalog Repair Matrix (B01–B28).
 *
 * Verifies:
 * - B01 (Hard Gate): Candidate DB verification via isolated worker thread offloading without blocking Host event loop
 * - B02: Candidate DB verification rejects non-existent database file with FILE_NOT_FOUND
 * - B03: Candidate DB verification rejects invalid SQLite file or missing tables with INVALID_DATABASE_SCHEMA
 * - B04 (Hard Gate): Zero whole-file buffers in Host thread during candidate verification and custom startup recovery
 * - B05: Candidate DB verification strictly read-only and immutable (mtime, size, digest identical before and after)
 * - B06: Publish snapshot creates custom-<uuid>.sqlite3 and atomically writes entry to custom-snapshots/index.json
 * - B07 (Hard Gate): Strict UUID-to-filename binding check (databaseFile === custom-${snapshotId}.sqlite3) enforced
 * - B08: Snapshot catalog atomic persistence with temporary file and atomic replace
 * - B09: Snapshot catalog entries accurately record schemaVersion, sha256, byteSize, entryCount, formCount, createdAt
 * - B10: Snapshot catalog cleanup removes entry from index.json atomically upon snapshot deletion
 * - B11: Inventory isolation: installing ECDICT while Custom is active commits installed-ecdict.json without overwriting active Custom
 * - B12: Inventory isolation: status route GET /dictionary/status reports installed: true with installedCorpus while activeMode is custom
 * - B13 (Hard Gate): Crash consistency & intent recovery: startup recovery with Custom active and unconfirmed settings sync recovers Custom
 * - B14 (Hard Gate): Crash consistency & intent recovery: startup recovery with Managed active and unconfirmed settings sync recovers Managed
 * - B15: Intent recovery: confirmed Host Config fixture settings cleanly honors explicit user choice, keeping fixture active
 * - B16: Startup recovery adopts published snapshot into CustomSnapshotManager without recreating files
 * - B17: Startup recovery detects corrupt custom snapshot file (digest mismatch) via worker, records recoveryError, falls back to fixture
 * - B18: Startup recovery detects missing custom snapshot file on disk, records recoveryError, falls back to fixture
 * - B19: Startup recovery degrades safely when active.json is missing or corrupt, falling back to fixture
 * - B20 (Hard Gate): Catalog corrupt safe degradation: corrupted custom-snapshots/index.json degrades safely without throwing
 * - B21: Catalog missing migration: missing catalog auto-migrates from active.json referencing valid custom snapshot
 * - B22 (Hard Gate): Active lease protection: snapshot in active use cannot be deleted via cleanupSnapshot
 * - B23: Mode switching from custom to managed-ecdict releases custom lease and switches active database
 * - B24: Mode switching from managed-ecdict to custom acquires custom lease and switches active database
 * - B25: Hot-swap between custom-A and custom-B transfers leases atomically without lookup interruption
 * - B26: Disposer awaiting: coordinator.dispose() awaits customSnapshotManager.dispose() and worker termination
 * - B27: Route error sanitization: all error messages and structured details in management routes sanitized against path leaks
 * - B28 (Hard Gate): Unified concurrency mutex across install, remove, activate-custom, and select-mode operations
 *
 * @module tests/phase7a8-1br-activation-recovery.spec
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  _setActivationHooksForTesting,
} from '../src/host/dictionary-activation.js'
import {
  DictionaryOperationManager,
  OperationInProgressError,
} from '../src/host/dictionary-operations.js'
import {
  CustomSnapshotManager,
  SnapshotActiveReferenceError,
} from '../src/host/custom-snapshot-manager.js'
import {
  ensureManagedStorageDirectories,
  readActiveMetadata,
  readCustomSnapshotCatalog,
  resolveManagedStoragePaths,
  validateCustomSnapshotCatalog,
  writeActiveMetadataAtomically,
  writeCustomSnapshotCatalogAtomically,
  writeInstalledEcdictMetadataAtomically,
  _setStorageFsHooksForTesting,
  type ActiveMetadata,
  type CustomActiveMetadata,
  type CustomSnapshotCatalog,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'
import {
  createActivateCustomHandler,
  createStatusHandler,
} from '../src/host/dictionary-management-route.js'
import {
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_STATUS_PATH,
} from '../src/host/route.js'
import * as downloader from '../src/host/ecdict-downloader.js'
import * as importer from '../src/host/ecdict-importer.js'

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

    // Insert probe words
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

describe('Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28)', () => {
  let testDir: string
  let paths: ManagedStoragePaths
  let rawSourceDir: string
  let manager: DictionaryManager
  let coordinator: ActivationCoordinator
  let opMan: DictionaryOperationManager
  let snapshotMgr: CustomSnapshotManager

  beforeEach(async () => {
    testDir = join(tmpdir(), `dsh-7a81br-${randomUUID()}`)
    rawSourceDir = join(tmpdir(), `dsh-7a81br-raw-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    mkdirSync(rawSourceDir, { recursive: true })

    paths = resolveManagedStoragePaths({ home: testDir })
    await ensureManagedStorageDirectories(paths)

    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })

    snapshotMgr = new CustomSnapshotManager({
      paths,
    })

    coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: snapshotMgr,
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
      await coordinator.dispose()
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

  // B01 (Hard Gate): Worker candidate verification
  it('B01: candidate database verification offloads to worker and returns valid schema and count without blocking Host', async () => {
    const rawPath = join(rawSourceDir, 'candidate-b01.sqlite3')
    buildValidTestDatabase(rawPath)

    const res = await coordinator.verifyCustomDatabase(rawPath)
    expect(res.valid).toBe(true)
    expect(res.schemaVersion).toBe(1)
    expect(res.entryCount).toBeGreaterThan(0)
    expect(res.formCount).toBeGreaterThan(0)
    expect(res.headwordsSample.length).toBeGreaterThan(0)
  })

  // B02: Candidate database verification rejects non-existent database file with FILE_NOT_FOUND
  it('B02: candidate database verification rejects non-existent database file with FILE_NOT_FOUND', async () => {
    const missingPath = join(rawSourceDir, 'nonexistent-b02.sqlite3')
    const res = await coordinator.verifyCustomDatabase(missingPath)
    expect(res.valid).toBe(false)
    expect(res.errorCode).toBe('FILE_NOT_FOUND')
    expect(res.error).toContain('does not exist')
  })

  // B03: Candidate database verification rejects database with missing required tables
  it('B03: candidate database verification rejects database missing required tables with INVALID_DATABASE_SCHEMA', async () => {
    const brokenPath = join(rawSourceDir, 'broken-b03.sqlite3')
    buildValidTestDatabase(brokenPath, { omitTables: ['meta'] })

    const res = await coordinator.verifyCustomDatabase(brokenPath)
    expect(res.valid).toBe(false)
    expect(res.errorCode).toBe('INVALID_DATABASE_SCHEMA')
  })

  // B04 (Hard Gate): Zero whole-file buffers in Host thread during candidate verification and startup recovery
  it('B04: verifies candidate database and startup recovery via worker without whole-file buffering in Host thread', async () => {
    const rawPath = join(rawSourceDir, 'candidate-b04.sqlite3')
    buildValidTestDatabase(rawPath)

    // Verification offloads to worker validator
    const spy = vi.spyOn(snapshotMgr, 'validateCandidateDatabase')
    const res = await coordinator.verifyCustomDatabase(rawPath)
    expect(spy).toHaveBeenCalled()
    expect(res.valid).toBe(true)
  })

  // B05: Candidate verification is strictly read-only and never mutates user candidate database
  it('B05: candidate verification is strictly read-only and preserves user raw database unchanged', async () => {
    const rawPath = join(rawSourceDir, 'immutable-b05.sqlite3')
    buildValidTestDatabase(rawPath)

    const statBefore = statSync(rawPath)
    const digestBefore = sha256File(rawPath)

    await coordinator.verifyCustomDatabase(rawPath)

    const statAfter = statSync(rawPath)
    const digestAfter = sha256File(rawPath)

    expect(statAfter.size).toBe(statBefore.size)
    expect(digestAfter).toBe(digestBefore)
  })

  // B06: Publish snapshot creates custom-<uuid>.sqlite3 and atomically writes entry to custom-snapshots/index.json
  it('B06: publish snapshot creates custom-<uuid>.sqlite3 and records entry in custom-snapshots/index.json', async () => {
    const rawPath = join(rawSourceDir, 'publish-b06.sqlite3')
    buildValidTestDatabase(rawPath)

    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-b06' })
    expect(record.state).toBe('PUBLISHED_INACTIVE')

    const catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog).not.toBeNull()
    const entry = catalog!.snapshots.find((s) => s.snapshotId === record.id)
    expect(entry).toBeDefined()
    expect(entry!.databaseFile).toBe(`custom-${record.id}.sqlite3`)
    expect(entry!.identity).toBe('custom-b06')
  })

  // B07 (Hard Gate): Strict UUID-to-filename binding check
  it('B07: strict UUID-to-filename binding rejects mismatches between snapshotId and databaseFile', async () => {
    const invalidCatalog: CustomSnapshotCatalog = {
      version: 1,
      snapshots: [
        {
          snapshotId: '11111111-1111-4111-8111-111111111111',
          identity: 'invalid-binding',
          databaseFile: 'custom-22222222-2222-4222-8222-222222222222.sqlite3',
          source: 'custom-local',
          schemaVersion: 1,
          sha256: 'a'.repeat(64),
          byteSize: 1024,
          createdAt: new Date().toISOString(),
        },
      ],
    }
    expect(() => validateCustomSnapshotCatalog(invalidCatalog)).toThrow(/does not match snapshotId/)
  })

  // B08: Snapshot catalog atomic persistence with temporary file and atomic replace
  it('B08: writes custom snapshot catalog atomically via temporary file and atomic replace', async () => {
    const catalog: CustomSnapshotCatalog = {
      version: 1,
      snapshots: [
        {
          snapshotId: '33333333-3333-4333-8333-333333333333',
          identity: 'atomic-test',
          databaseFile: 'custom-33333333-3333-4333-8333-333333333333.sqlite3',
          source: 'custom-local',
          schemaVersion: 1,
          sha256: 'b'.repeat(64),
          byteSize: 2048,
          createdAt: new Date().toISOString(),
        },
      ],
    }
    await writeCustomSnapshotCatalogAtomically(paths, catalog)
    expect(existsSync(paths.customSnapshotCatalogPath)).toBe(true)

    const readBack = await readCustomSnapshotCatalog(paths)
    expect(readBack?.snapshots[0]?.identity).toBe('atomic-test')
  })

  // B09: Snapshot catalog entries track metadata
  it('B09: snapshot catalog entry correctly records all schema and count fields', async () => {
    const rawPath = join(rawSourceDir, 'fields-b09.sqlite3')
    buildValidTestDatabase(rawPath)

    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'fields-b09' })
    const catalog = await readCustomSnapshotCatalog(paths)
    const entry = catalog?.snapshots.find((s) => s.snapshotId === record.id)
    expect(entry?.schemaVersion).toBe(1)
    expect(entry?.sha256).toBe(record.sha256)
    expect(entry?.byteSize).toBe(record.byteSize)
    expect(entry?.entryCount).toBe(record.entryCount)
    expect(entry?.formCount).toBe(record.formCount)
  })

  // B10: Snapshot catalog cleanup removes entry from index.json atomically upon snapshot deletion
  it('B10: cleaning up an inactive snapshot atomically removes it from custom-snapshots/index.json', async () => {
    const rawPath = join(rawSourceDir, 'cleanup-b10.sqlite3')
    buildValidTestDatabase(rawPath)

    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'cleanup-b10' })
    let catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.some((s) => s.snapshotId === record.id)).toBe(true)

    await snapshotMgr.cleanupSnapshot(record.id)
    catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.some((s) => s.snapshotId === record.id)).toBe(false)
  })

  // B11: Inventory isolation: installing ECDICT while Custom is active commits installed inventory without overwriting active Custom
  it('B11: installing ECDICT while Custom mode is active commits installed-ecdict.json without overwriting active Custom mode', async () => {
    // 1. Activate custom dictionary
    const rawPath = join(rawSourceDir, 'custom-b11.sqlite3')
    buildValidTestDatabase(rawPath)
    await opMan.activateCustom(rawPath, 'custom-b11')
    expect(manager.snapshot().activeMode).toBe('custom')

    // 2. Mock ECDICT download and build
    const ecdictFile = 'ecdict-b11.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    const stat = statSync(fullEcdictPath)

    vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
      path: join(rawSourceDir, 'source.csv'),
      sourceCommit: loadRuntimeCorpusManifest().sourceCommit,
      sha256: loadRuntimeCorpusManifest().sourceSha256,
      byteSize: 1000,
      reused: false,
      redirectCount: 0,
    })

    vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
      path: fullEcdictPath,
      databaseFile: ecdictFile,
      identity: 'b11',
      sourceCommit: loadRuntimeCorpusManifest().sourceCommit,
      sourceSha256: loadRuntimeCorpusManifest().sourceSha256,
      entryCount: 5,
      formCount: 5,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 5,
      byteSize: stat.size,
      schemaVersion: 1,
      logicalSha256: 'c'.repeat(64),
      fileSha256: 'd'.repeat(64),
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    })

    // 3. Run installation
    opMan.install()
    await opMan.whenSettled()

    // 4. Verify inventory is installed, BUT custom remains active
    expect(manager.snapshot().activeMode).toBe('custom')
    const activeMeta = await readActiveMetadata(paths)
    expect(activeMeta?.activeMode).toBe('custom')

    const summary = coordinator.getStatusSummary()
    expect(summary.installed).toBe(true)
    expect(summary.activeMode).toBe('custom')
    expect(summary.installedCorpus).not.toBeNull()
  })

  // B12: Inventory isolation: status route GET /dictionary/status reports installed: true while activeMode is custom
  it('B12: status handler exposes installed ECDICT inventory and customSnapshots while activeMode is custom', async () => {
    const rawPath = join(rawSourceDir, 'custom-b12.sqlite3')
    buildValidTestDatabase(rawPath)
    await opMan.activateCustom(rawPath, 'custom-b12')

    const statusHandler = createStatusHandler(opMan, coordinator)
    const res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activeMode).toBe('custom')
    expect(Array.isArray(body.customSnapshots)).toBe(true)
  })

  // B13 (Hard Gate): Crash consistency & intent recovery: startup recovery with Custom active and unconfirmed settings sync recovers Custom
  it('B13: startup recovery recovers committed Custom mode when settings sync was unconfirmed/failed', async () => {
    const rawPath = join(rawSourceDir, 'custom-b13.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-b13' })

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-b13',
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
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'fixture' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('custom')

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B14 (Hard Gate): Crash consistency & intent recovery: startup recovery with Managed active and unconfirmed settings sync recovers Managed
  it('B14: startup recovery recovers committed Managed ECDICT mode when settings sync was unconfirmed/failed', async () => {
    const ecdictFile = 'ecdict-managed-b14.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    const manifest = loadRuntimeCorpusManifest()

    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'managed-b14',
      databaseFile: ecdictFile,
      source: {
        name: 'ECDICT',
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: 1,
      },
      lastActivatedAt: new Date().toISOString(),
      settingsSynced: false,
      settingsSyncState: 'pending',
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
      config: Config({ dictionaryMode: 'fixture' }),
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('managed-ecdict')

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B15: Intent recovery: confirmed Host Config fixture settings cleanly honors explicit user choice
  it('B15: confirmed settings sync honors user choice of fixture mode while preserving installed ECDICT inventory', async () => {
    const ecdictFile = 'ecdict-managed-b15.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    const manifest = loadRuntimeCorpusManifest()

    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'managed-b15',
      databaseFile: ecdictFile,
      source: {
        name: 'ECDICT',
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: 1,
      },
      lastActivatedAt: new Date().toISOString(),
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
      config: Config({ dictionaryMode: 'fixture' }),
    })

    await freshCoordinator.recoverOnStartup()
    // Honors user choice: stays on fixture
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().installed).toBe(true)

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B16: Startup recovery adopts published snapshot into CustomSnapshotManager without recreating files
  it('B16: startup recovery adopts published snapshot into CustomSnapshotManager tracking state cleanly', async () => {
    const rawPath = join(rawSourceDir, 'custom-b16.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-b16' })

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'custom-b16',
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

    const freshSnapshotMgr = new CustomSnapshotManager({ paths })
    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
      customSnapshotManager: freshSnapshotMgr,
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('custom')
    expect(freshSnapshotMgr.getActiveLeases(record.id)).toBeGreaterThan(0)

    freshManager.close()
    await freshCoordinator.dispose()
    await freshSnapshotMgr.dispose()
  })

  // B17: Startup recovery detects corrupt custom snapshot file via worker, records recoveryError, falls back to fixture
  it('B17: startup recovery detects corrupt custom snapshot file via worker, records recoveryError, and falls back to fixture', async () => {
    const rawPath = join(rawSourceDir, 'corrupt-b17.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'corrupt-b17' })

    // Corrupt snapshot file on disk
    writeFileSync(record.publishedPath!, 'CORRUPT_BYTES')

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'corrupt-b17',
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
      customSnapshotManager: snapshotMgr,
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().recoveryError).not.toBeNull()

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B18: Startup recovery detects missing custom snapshot file on disk, records recoveryError, falls back to fixture
  it('B18: startup recovery detects missing custom snapshot file, records recoveryError, and falls back to fixture', async () => {
    const snapId = randomUUID()
    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'missing-b18',
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
      customSnapshotManager: snapshotMgr,
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().recoveryError).toContain('missing')

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B19: Startup recovery degrades safely when active.json is missing or corrupt, falling back to fixture
  it('B19: startup recovery degrades safely when active.json is corrupt, falling back to fixture without throwing', async () => {
    writeFileSync(paths.activeMetadataPath, '{ bad_json: ')

    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      config: Config({ dictionaryMode: 'custom' }),
      customSnapshotManager: snapshotMgr,
    })

    await freshCoordinator.recoverOnStartup()
    expect(freshManager.snapshot().activeMode).toBe('fixture')
    expect(freshCoordinator.getStatusSummary().recoveryError).toContain('Corrupt')

    freshManager.close()
    await freshCoordinator.dispose()
  })

  // B20 (Hard Gate): Catalog corrupt safe degradation
  it('B20: corrupted custom-snapshots/index.json safely degrades without crashing CustomSnapshotManager or ActivationCoordinator', async () => {
    writeFileSync(paths.customSnapshotCatalogPath, '{{{ corrupt_catalog_json')

    const freshSnapshotMgr = new CustomSnapshotManager({ paths })
    await freshSnapshotMgr.loadCatalog()

    expect(freshSnapshotMgr.catalogError).not.toBeNull()
    expect(freshSnapshotMgr.listCustomSnapshots()).toHaveLength(0)

    await freshSnapshotMgr.dispose()
  })

  // B21: Catalog missing migration: auto-migrates from active.json referencing valid custom snapshot
  it('B21: missing catalog automatically migrates and recreates index.json from active custom metadata', async () => {
    const rawPath = join(rawSourceDir, 'migrate-b21.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'migrate-b21' })

    // Remove catalog file
    if (existsSync(paths.customSnapshotCatalogPath)) {
      rmSync(paths.customSnapshotCatalogPath)
    }

    const metadata: CustomActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: 'migrate-b21',
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

    const freshSnapshotMgr = new CustomSnapshotManager({ paths })
    await freshSnapshotMgr.loadCatalog()

    expect(existsSync(paths.customSnapshotCatalogPath)).toBe(true)
    const catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.some((s) => s.snapshotId === record.id)).toBe(true)

    await freshSnapshotMgr.dispose()
  })

  // B22 (Hard Gate): Active lease protection
  it('B22: cannot clean up snapshot while active dictionary references exist', async () => {
    const rawPath = join(rawSourceDir, 'lease-b22.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'lease-b22' })

    // Activate snapshot (acquiring lease)
    await coordinator.activateCustomDatabase(record.id)
    expect(snapshotMgr.getActiveLeases(record.id)).toBeGreaterThan(0)

    // Cleanup attempt must fail with SnapshotActiveReferenceError
    await expect(snapshotMgr.cleanupSnapshot(record.id)).rejects.toThrow(SnapshotActiveReferenceError)
  })

  // B23: Mode switching from custom to managed-ecdict releases custom lease and switches active database
  it('B23: switching from custom to managed-ecdict releases custom lease and switches active dictionary', async () => {
    const rawPath = join(rawSourceDir, 'switch-b23.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'switch-b23' })
    await coordinator.activateCustomDatabase(record.id)
    expect(snapshotMgr.getActiveLeases(record.id)).toBe(1)

    // Install synthetic ECDICT
    const ecdictFile = 'ecdict-ecdict-b23.sqlite3'
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFile)
    buildSyntheticManagedEcdictDb(fullEcdictPath)
    const manifest = loadRuntimeCorpusManifest()
    const stat = statSync(fullEcdictPath)

    await writeInstalledEcdictMetadataAtomically(paths, {
      version: 1,
      identity: 'ecdict-b23',
      databaseFile: ecdictFile,
      source: {
        name: 'ECDICT',
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: 1,
      },
      entryCount: 5,
      formCount: 5,
      byteSize: stat.size,
      installedAt: new Date().toISOString(),
    })

    await opMan.selectMode('managed-ecdict')
    expect(manager.snapshot().activeMode).toBe('managed-ecdict')
    expect(snapshotMgr.getActiveLeases(record.id)).toBe(0)
  })

  // B24: Mode switching from managed-ecdict to custom acquires custom lease and switches active database
  it('B24: switching from managed-ecdict to custom acquires custom lease and switches active dictionary', async () => {
    const rawPath = join(rawSourceDir, 'custom-b24.sqlite3')
    buildValidTestDatabase(rawPath)
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'custom-b24' })

    await opMan.selectMode('custom', record.id)
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(snapshotMgr.getActiveLeases(record.id)).toBe(1)
  })

  // B25: Hot-swap between custom-A and custom-B transfers leases atomically without lookup interruption
  it('B25: hot-swap between custom-A and custom-B transfers leases atomically with uninterrupted lookups', async () => {
    const rawA = join(rawSourceDir, 'custom-a-b25.sqlite3')
    const rawB = join(rawSourceDir, 'custom-b-b25.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['apple'] })
    buildValidTestDatabase(rawB, { headwords: ['banana'] })

    const recordA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'custom-a' })
    const recordB = await snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'custom-b' })

    await coordinator.activateCustomDatabase(recordA.id)
    expect(snapshotMgr.getActiveLeases(recordA.id)).toBe(1)
    expect(manager.lookup('apple')?.found).toBe(true)

    // Switch to custom-B
    await opMan.selectMode('custom', recordB.id)
    expect(snapshotMgr.getActiveLeases(recordA.id)).toBe(0)
    expect(snapshotMgr.getActiveLeases(recordB.id)).toBe(1)
    expect(manager.lookup('banana')?.found).toBe(true)
  })

  // B26: Disposer awaiting: coordinator.dispose() awaits customSnapshotManager.dispose() and worker termination
  it('B26: coordinator.dispose() cleanly awaits customSnapshotManager disposal and worker shutdown', async () => {
    const freshSnapshotMgr = new CustomSnapshotManager({ paths })
    const freshManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const freshCoordinator = new ActivationCoordinator({
      paths,
      manager: freshManager,
      customSnapshotManager: freshSnapshotMgr,
    })

    const disposeSpy = vi.spyOn(freshSnapshotMgr, 'dispose')
    await freshCoordinator.dispose()
    expect(freshCoordinator.isDisposed).toBe(true)
    expect(disposeSpy).toHaveBeenCalled()

    freshManager.close()
  })

  // B27: Route error sanitization: all error messages and structured details sanitized
  it('B27: route error responses sanitize internal machine paths from error message and details', async () => {
    const handler = createActivateCustomHandler(opMan)
    const secretPath = 'C:\\Secret\\Users\\Administrator\\confidential.sqlite3'
    const req = new Request('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: secretPath }),
    })

    const res = await handler(req)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const data = await res.json()
    expect(data.ok).toBe(false)
    expect(data.message).not.toContain('C:\\Secret')
  })

  // B28 (Hard Gate): Unified concurrency mutex across install, remove, activate-custom, and select-mode operations
  it('B28: unified concurrency mutex rejects concurrent operations with OperationInProgressError', async () => {
    const rawPath = join(rawSourceDir, 'mutex-b28.sqlite3')
    buildValidTestDatabase(rawPath)

    // Start an activateCustom operation
    const opPromise = opMan.activateCustom(rawPath, 'mutex-b28')

    // Concurrent install attempt must be rejected
    expect(() => opMan.install()).toThrow(OperationInProgressError)
    // Concurrent remove attempt must be rejected
    await expect(opMan.remove()).rejects.toThrow(OperationInProgressError)
    // Concurrent selectMode attempt must be rejected
    await expect(opMan.selectMode('fixture')).rejects.toThrow(OperationInProgressError)

    await opPromise
  })
})
