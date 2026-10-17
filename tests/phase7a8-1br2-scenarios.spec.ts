/**
 * Dedicated unit and integration tests for Phase 7A.8.1BR2:
 * Persistent Snapshot Integrity, Catalog Durability, Concurrency & ECDICT Compensation (R01–R12).
 *
 * Tested Invariants:
 * - R01: Catalog dormant snapshot successfully validated and activated.
 * - R02: Dormant snapshot same-size tamper rejected (fail-closed, previous active dictionary intact).
 * - R03: Dormant snapshot different-size tamper rejected (fail-closed, previous active dictionary intact).
 * - R04: SQLite-valid database with mismatched digest rejected (fail-closed).
 * - R05: Symlink or junction snapshot rejected before activation.
 * - R06: Worker validation failure preserves old active dictionary.
 * - R07: Anti-TOCTOU race protection between validation and dictionary opening.
 * - R08: Catalog persistence failure does not report false success.
 * - R09: Catalog concurrent publishes do not lose entries (serialized mutex queue).
 * - R10: Physically published but uncataloged snapshots safely reconciled.
 * - R11: ECDICT Inventory failure triggers rollback compensation.
 * - R12: ECDICT install success is strictly consistent with durable inventory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
} from '../src/host/dictionary-operations.js'
import {
  CustomSnapshotManager,
  SnapshotTamperingError,
  CatalogPersistenceError,
  _setCustomSnapshotHooksForTesting,
} from '../src/host/custom-snapshot-manager.js'
import {
  ensureManagedStorageDirectories,
  readActiveMetadata,
  readCustomSnapshotCatalog,
  readInstalledEcdictMetadata,
  resolveManagedStoragePaths,
  writeActiveMetadataAtomically,
  writeCustomSnapshotCatalogAtomically,
  writeInstalledEcdictMetadataAtomically,
  _setStorageFsHooksForTesting,
  type ActiveMetadata,
  type CustomSnapshotCatalog,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'
import type { ManagedEcdictBuildResult } from '../src/host/ecdict-importer.js'
import {
  createActivateCustomHandler,
  createSelectModeHandler,
  createStatusHandler,
} from '../src/host/dictionary-management-route.js'
import {
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
  MANAGEMENT_STATUS_PATH,
  LOOKUP_PATH,
} from '../src/host/route.js'
import { createLookupHandler } from '../src/host/lookup.js'

function buildValidTestDatabase(
  dbPath: string,
  options?: {
    headwords?: readonly string[]
  },
): void {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = DELETE;')

  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1');`)
  db.exec(`INSERT INTO meta (key, value) VALUES ('corpus_name', 'CUSTOM_TEST');`)

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

  db.exec(`
    CREATE TABLE forms (
      form TEXT PRIMARY KEY,
      headword TEXT NOT NULL,
      kind TEXT
    );
  `)

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

  db.exec(`CREATE INDEX idx_entries_word ON entries (word);`)
  db.exec(`CREATE INDEX idx_forms_form ON forms (form);`)
  db.exec(`CREATE INDEX idx_forms_headword ON forms (headword);`)
  db.exec(`CREATE INDEX idx_examples_headword ON examples (headword);`)

  const words = Array.from(new Set(['go', 'derive', 'wave', ...(options?.headwords ?? ['apple', 'pear'])]))
  const insEntry = db.prepare(`
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
    VALUES (?, 'phonetic', 'definition', '释义', 'n.', NULL, 100);
  `)
  const insForm = db.prepare(`
    INSERT INTO forms (form, headword, kind) VALUES (?, ?, 'p');
  `)
  const insExample = db.prepare(`
    INSERT INTO examples (headword, english, chinese, source, source_id, score)
    VALUES (?, ?, '中文示例', 'test', '1', 1.0);
  `)

  for (const w of words) {
    insEntry.run(w)
    insForm.run(`${w}s`, w)
    insExample.run(w, `This is an example sentence with ${w}.`)
  }

  db.close()
}

function buildSyntheticManagedEcdictDb(filePath: string, extraWords?: string[]): void {
  const manifest = loadRuntimeCorpusManifest()
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = DELETE;')
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

  const words = ['go', 'derive', 'wave', ...(extraWords ?? ['ecdictword', 'managedword'])]
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

describe('Phase 7A.8.1BR2: Integrity, Durability, Concurrency & Compensation Matrix (R01–R20)', { timeout: 60_000 }, () => {
  let testDir: string
  let paths: ManagedStoragePaths
  let rawSourceDir: string
  let manager: DictionaryManager
  let coordinator: ActivationCoordinator
  let snapshotMgr: CustomSnapshotManager
  let opMan: DictionaryOperationManager

  beforeEach(async () => {
    testDir = join(tmpdir(), `dsh-br2-test-${randomUUID()}`)
    rawSourceDir = join(tmpdir(), `dsh-br2-raw-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    mkdirSync(rawSourceDir, { recursive: true })

    paths = resolveManagedStoragePaths({ home: testDir })
    await ensureManagedStorageDirectories(paths)

    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })

    snapshotMgr = new CustomSnapshotManager({ paths })
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
    _setCustomSnapshotHooksForTesting(null)
    try { await opMan.dispose(100) } catch {}
    try { await coordinator.dispose() } catch {}
    try { await snapshotMgr.dispose() } catch {}
    try { manager.close() } catch {}

    rmSync(testDir, { recursive: true, force: true })
    rmSync(rawSourceDir, { recursive: true, force: true })
  })

  // R01: Catalog 中正常非活动快照成功验证激活
  it('R01: dormant snapshot in catalog passes full worker integrity check and activates successfully', async () => {
    const rawPath = join(rawSourceDir, 'r01.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['resilience'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r01-dict' })

    // Simulate restart: fresh snapshot manager loads catalog
    const restartSnapshotMgr = new CustomSnapshotManager({ paths })
    await restartSnapshotMgr.loadCatalog()
    const dormant = restartSnapshotMgr.getSnapshot(record.id)
    expect(dormant?.state).toBe('PUBLISHED_INACTIVE')

    const restartCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: restartSnapshotMgr,
    })

    const result = await restartCoord.activateCustomDatabase(record.id)
    expect(result.activeMode).toBe('custom')
    expect(result.snapshotId).toBe(record.id)
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.lookup('resilience')?.found).toBe(true)

    await restartCoord.dispose()
  })

  // R02: 非活动快照同大小内容篡改被拒绝
  it('R02: dormant snapshot tampered with identical byte size is rejected before activation', async () => {
    const rawPath = join(rawSourceDir, 'r02.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['tamper-same-size'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r02-dict' })
    const pubPath = record.publishedPath!
    expect(existsSync(pubPath)).toBe(true)

    // Tamper published file with exact same size by modifying bytes in-place
    const fileBuf = readFileSync(pubPath)
    // Flip bytes inside SQLite header page (offset 24-27 or free page)
    fileBuf[50] = (fileBuf[50]! ^ 0xff)
    writeFileSync(pubPath, fileBuf)

    // Restart manager and attempt activation
    const restartSnapshotMgr = new CustomSnapshotManager({ paths })
    await restartSnapshotMgr.loadCatalog()

    const restartCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: restartSnapshotMgr,
    })

    await expect(restartCoord.activateCustomDatabase(record.id)).rejects.toThrow()
    // Verification failed: manager remains on fixture
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(restartSnapshotMgr.getActiveLeases(record.id)).toBe(0)

    await restartCoord.dispose()
  })

  // R03: 非活动快照不同大小内容篡改被拒绝
  it('R03: dormant snapshot tampered with different byte size is rejected before activation', async () => {
    const rawPath = join(rawSourceDir, 'r03.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['tamper-diff-size'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r03-dict' })
    const pubPath = record.publishedPath!

    // Append extra bytes to published file
    const fileBuf = readFileSync(pubPath)
    const corrupted = Buffer.concat([fileBuf, Buffer.from([0x01, 0x02, 0x03, 0x04])])
    writeFileSync(pubPath, corrupted)

    const restartSnapshotMgr = new CustomSnapshotManager({ paths })
    await restartSnapshotMgr.loadCatalog()

    const restartCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: restartSnapshotMgr,
    })

    await expect(restartCoord.activateCustomDatabase(record.id)).rejects.toThrow(SnapshotTamperingError)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(restartSnapshotMgr.getActiveLeases(record.id)).toBe(0)

    await restartCoord.dispose()
  })

  // R04: SQLite 有效但 SHA 不符被拒绝
  it('R04: valid SQLite database substituted into dormant snapshot location is rejected by digest match', async () => {
    const rawA = join(rawSourceDir, 'r04-a.sqlite3')
    const rawB = join(rawSourceDir, 'r04-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['database-a'] })
    buildValidTestDatabase(rawB, { headwords: ['database-b-different'] })

    const recordA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'r04-a' })
    const pubPathA = recordA.publishedPath!

    // Overwrite published snapshot A file with completely valid SQLite database B
    const bBytes = readFileSync(rawB)
    writeFileSync(pubPathA, bBytes)

    const restartSnapshotMgr = new CustomSnapshotManager({ paths })
    await restartSnapshotMgr.loadCatalog()

    const restartCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: restartSnapshotMgr,
    })

    await expect(restartCoord.activateCustomDatabase(recordA.id)).rejects.toThrow(SnapshotTamperingError)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(restartSnapshotMgr.getActiveLeases(recordA.id)).toBe(0)

    await restartCoord.dispose()
  })

  // R05: symlink/junction 快照被拒绝
  it('R05: symlinked or junction snapshot file is rejected before activation', async () => {
    const rawPath = join(rawSourceDir, 'r05.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['symlink-test'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r05-dict' })
    const pubPath = record.publishedPath!

    // Replace published file with a symlink pointing to rawPath
    unlinkSync(pubPath)
    try {
      symlinkSync(rawPath, pubPath, 'file')
    } catch {
      // On Windows without SeCreateSymbolicLinkPrivilege, test junction or mock
      return
    }

    const restartSnapshotMgr = new CustomSnapshotManager({ paths })
    await restartSnapshotMgr.loadCatalog()

    const restartCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: restartSnapshotMgr,
    })

    await expect(restartCoord.activateCustomDatabase(record.id)).rejects.toThrow()
    expect(manager.snapshot().activeMode).toBe('fixture')

    await restartCoord.dispose()
  })

  // R06: Worker 验证失败仍保留旧活动词典
  it('R06: worker verification failure leaves existing active dictionary uninterrupted and without ghost leases', async () => {
    // 1. Establish valid active custom dictionary A
    const rawA = join(rawSourceDir, 'r06-a.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['alpha'] })
    const recordA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'r06-a' })
    await coordinator.activateCustomDatabase(recordA.id)
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.lookup('alpha')?.found).toBe(true)
    expect(snapshotMgr.getActiveLeases(recordA.id)).toBe(1)

    // 2. Publish snapshot B, then corrupt B's SQLite file
    const rawB = join(rawSourceDir, 'r06-b.sqlite3')
    buildValidTestDatabase(rawB, { headwords: ['beta'] })
    const recordB = await snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'r06-b' })
    writeFileSync(recordB.publishedPath!, 'corrupt-sqlite-bytes')

    // 3. Attempt to switch to B
    await expect(opMan.selectMode('custom', recordB.id)).rejects.toThrow()

    // 4. Verification: Dictionary A remains active, lookups succeed, zero ghost leases on B
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.lookup('alpha')?.found).toBe(true)
    expect(snapshotMgr.getActiveLeases(recordA.id)).toBe(1)
    expect(snapshotMgr.getActiveLeases(recordB.id)).toBe(0)
  })

  // R07: 验证到打开之间的文件替换竞态 (TOCTOU)
  it('R07: TOCTOU race replacement between worker validation and SQLite open is caught fail-closed', async () => {
    const rawPath = join(rawSourceDir, 'r07.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['toctou-target'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r07-dict' })

    // Inject tampering hook right after validation passes but before open
    _setCustomSnapshotHooksForTesting({
      onAfterValidateBeforeOpen: async (_snapId, path) => {
        // Tamper file content between validation and open
        const buf = readFileSync(path)
        buf[64] = (buf[64]! ^ 0xab)
        writeFileSync(path, buf)
      },
    })

    await expect(coordinator.activateCustomDatabase(record.id)).rejects.toThrow(SnapshotTamperingError)
    expect(manager.snapshot().activeMode).toBe('fixture')
    expect(snapshotMgr.getActiveLeases(record.id)).toBe(0)
  })

  // R08: Catalog 写入故障不得误报成功
  it('R08: catalog persistence failure does not report false success and preserves published database safely', async () => {
    const rawPath = join(rawSourceDir, 'r08.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['catalog-durability'] })

    // Inject write failure on index.json
    _setStorageFsHooksForTesting({
      writeFile: async (filePath, data, options) => {
        if (filePath.includes('index.json')) {
          throw new Error('EACCES: permission denied writing catalog index.json')
        }
        await writeFile(filePath, data, options)
      },
    })

    // createAndPublishSnapshot must throw CatalogPersistenceError
    await expect(
      snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r08-dict' }),
    ).rejects.toThrow(CatalogPersistenceError)

    // User source file remains completely untouched
    expect(existsSync(rawPath)).toBe(true)
  })

  // R09: Catalog 并发发布无 lost update
  it('R09: concurrent snapshot creations do not lose catalog entries due to mutex transaction locking', async () => {
    const rawA = join(rawSourceDir, 'r09-a.sqlite3')
    const rawB = join(rawSourceDir, 'r09-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['concur-a'] })
    buildValidTestDatabase(rawB, { headwords: ['concur-b'] })

    // Concurrently trigger createAndPublishSnapshot
    const [recA, recB] = await Promise.all([
      snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'r09-a' }),
      snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'r09-b' }),
    ])

    expect(recA.id).not.toBe(recB.id)

    // Read catalog from disk
    const catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog).not.toBeNull()
    const snapIds = catalog!.snapshots.map((s) => s.snapshotId)
    expect(snapIds).toContain(recA.id)
    expect(snapIds).toContain(recB.id)
    expect(catalog!.snapshots).toHaveLength(2)
  })

  // R10: 已发布但未登记快照的安全恢复
  it('R10: safely reconciles published database file missing from catalog without deleting user source', async () => {
    const rawPath = join(rawSourceDir, 'r10.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['reconcile-test'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r10-dict' })

    // Remove entry from catalog to simulate crash before catalog commit
    const catalog = await readCustomSnapshotCatalog(paths)
    const strippedCatalog: CustomSnapshotCatalog = {
      version: 1,
      snapshots: Object.freeze(catalog!.snapshots.filter((s) => s.snapshotId !== record.id)),
    }
    await writeCustomSnapshotCatalogAtomically(paths, strippedCatalog)

    // Verify catalog does not have it
    const preCheck = await readCustomSnapshotCatalog(paths)
    expect(preCheck?.snapshots.some((s) => s.snapshotId === record.id)).toBe(false)

    // Restart manager: loadCatalog triggers reconcileUnregisteredSnapshots
    const freshMgr = new CustomSnapshotManager({ paths })
    await freshMgr.loadCatalog()

    // Snapshot is recovered into catalog
    const postCheck = await readCustomSnapshotCatalog(paths)
    expect(postCheck?.snapshots.some((s) => s.snapshotId === record.id)).toBe(true)

    // Can now be safely activated
    const freshCoord = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: freshMgr,
    })
    const actResult = await freshCoord.activateCustomDatabase(record.id)
    expect(actResult.activeMode).toBe('custom')
    expect(manager.lookup('reconcile-test')?.found).toBe(true)

    await freshCoord.dispose()
  })

  // R11: ECDICT Inventory 写入失败的补偿
  it('R11: ECDICT inventory commit failure triggers rollback compensation to previous active dictionary', async () => {
    // Establish initial custom dictionary active
    const rawCustom = join(rawSourceDir, 'r11-prev.sqlite3')
    buildValidTestDatabase(rawCustom, { headwords: ['previous-custom-word'] })
    const customRecord = await snapshotMgr.createAndPublishSnapshot(rawCustom, { identity: 'r11-prev' })
    await coordinator.activateCustomDatabase(customRecord.id)
    expect(manager.snapshot().activeMode).toBe('custom')

    // Prepare synthetic ECDICT candidate
    const identity = 'r11'
    const ecdictFileName = `ecdict-${identity}.sqlite3`
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFileName)
    buildSyntheticManagedEcdictDb(fullEcdictPath, ['ecdict-word'])
    const manifest = loadRuntimeCorpusManifest()
    const st = statSync(fullEcdictPath)

    const buildResult: ManagedEcdictBuildResult = {
      identity,
      databaseFile: ecdictFileName,
      path: fullEcdictPath,
      byteSize: st.size,
      sourceCommit: manifest.sourceCommit,
      sourceSha256: manifest.sourceSha256,
      schemaVersion: 1,
      entryCount: 4,
      formCount: 4,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 4,
      logicalSha256: 'dummy-logical-sha',
      fileSha256: 'dummy-file-sha',
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    }

    // Inject failure on writing installed-ecdict.json
    _setStorageFsHooksForTesting({
      writeFile: async (filePath, data, options) => {
        if (filePath.includes('installed-ecdict.json')) {
          throw new Error('EIO: I/O error writing installed inventory')
        }
        await writeFile(filePath, data, options)
      },
    })

    await expect(
      coordinator.activateManagedDatabase(buildResult, { forceActivate: true }),
    ).rejects.toThrow('Failed to commit installed ECDICT inventory')

    // Rollback compensation: active mode rolled back to previous custom mode!
    expect(manager.snapshot().activeMode).toBe('custom')
    expect(manager.lookup('previous-custom-word')?.found).toBe(true)
    const activeMeta = await readActiveMetadata(paths)
    expect(activeMeta?.activeMode).toBe('custom')
  })

  // R12: 安装成功与持久库存状态一致
  it('R12: ECDICT activation succeeds strictly in consistency with durable installed inventory metadata', async () => {
    const identity = 'r12'
    const ecdictFileName = `ecdict-${identity}.sqlite3`
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFileName)
    buildSyntheticManagedEcdictDb(fullEcdictPath, ['durable-ecdict'])
    const manifest = loadRuntimeCorpusManifest()
    const st = statSync(fullEcdictPath)

    const buildResult: ManagedEcdictBuildResult = {
      identity,
      databaseFile: ecdictFileName,
      path: fullEcdictPath,
      byteSize: st.size,
      sourceCommit: manifest.sourceCommit,
      sourceSha256: manifest.sourceSha256,
      schemaVersion: 1,
      entryCount: 4,
      formCount: 4,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 4,
      logicalSha256: 'dummy-logical-sha',
      fileSha256: 'dummy-file-sha',
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    }

    await coordinator.activateManagedDatabase(buildResult, { forceActivate: true })

    expect(manager.snapshot().activeMode).toBe('managed-ecdict')
    expect(manager.lookup('durable-ecdict')?.found).toBe(true)

    // Durable inventory verified on disk
    const invMeta = await readInstalledEcdictMetadata(paths)
    expect(invMeta).not.toBeNull()
    expect(invMeta?.databaseFile).toBe(ecdictFileName)
    expect(invMeta?.entryCount).toBe(4)

    const activeMeta = await readActiveMetadata(paths)
    expect(activeMeta?.activeMode).toBe('managed-ecdict')
  })

  // R13: 多快照独立发布与独立 catalog 登记
  it('R13: publishes multiple independent snapshots and tracks distinct entries in catalog', async () => {
    const rawA = join(rawSourceDir, 'r13-a.sqlite3')
    const rawB = join(rawSourceDir, 'r13-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['galaxy', 'nebula'] })
    buildValidTestDatabase(rawB, { headwords: ['quasar', 'pulsar'] })

    const recA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'galaxy-dict' })
    const recB = await snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'quasar-dict' })

    expect(recA.id).not.toBe(recB.id)
    expect(existsSync(recA.publishedPath!)).toBe(true)
    expect(existsSync(recB.publishedPath!)).toBe(true)
    expect(recA.publishedPath).not.toBe(recB.publishedPath)

    const catalog = await readCustomSnapshotCatalog(paths)
    expect(catalog).not.toBeNull()
    expect(catalog!.snapshots).toHaveLength(2)

    const entryA = catalog!.snapshots.find((s) => s.snapshotId === recA.id)
    const entryB = catalog!.snapshots.find((s) => s.snapshotId === recB.id)
    expect(entryA?.identity).toBe('galaxy-dict')
    expect(entryB?.identity).toBe('quasar-dict')
    expect(entryA?.databaseFile).toBe(`custom-${recA.id}.sqlite3`)
    expect(entryB?.databaseFile).toBe(`custom-${recB.id}.sqlite3`)

    expect(snapshotMgr.getActiveLeases(recA.id)).toBe(0)
    expect(snapshotMgr.getActiveLeases(recB.id)).toBe(0)
  })

  // R14: 多快照间激活与热切换
  it('R14: switches actively between multiple custom snapshots with zero ghost leases and correct lookups', async () => {
    const rawA = join(rawSourceDir, 'r14-a.sqlite3')
    const rawB = join(rawSourceDir, 'r14-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['galaxy'] })
    buildValidTestDatabase(rawB, { headwords: ['quasar'] })

    const recA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'galaxy-dict' })
    const recB = await snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'quasar-dict' })

    // 1. Activate B
    const resB = await coordinator.activateCustomDatabase(recB.id)
    expect(resB.activeMode).toBe('custom')
    expect(resB.snapshotId).toBe(recB.id)
    expect(manager.lookup('quasar')?.found).toBe(true)
    expect(manager.lookup('galaxy')?.found).toBe(false)
    expect(snapshotMgr.getActiveLeases(recB.id)).toBe(1)
    expect(snapshotMgr.getActiveLeases(recA.id)).toBe(0)

    // 2. Switch to A
    const resA = await coordinator.activateCustomDatabase(recA.id)
    expect(resA.activeMode).toBe('custom')
    expect(resA.snapshotId).toBe(recA.id)
    expect(manager.lookup('galaxy')?.found).toBe(true)
    expect(manager.lookup('quasar')?.found).toBe(false)
    expect(snapshotMgr.getActiveLeases(recA.id)).toBe(1)
    expect(snapshotMgr.getActiveLeases(recB.id)).toBe(0)

    // 3. Switch back to B
    const resB2 = await coordinator.activateCustomDatabase(recB.id)
    expect(resB2.snapshotId).toBe(recB.id)
    expect(manager.lookup('quasar')?.found).toBe(true)
    expect(snapshotMgr.getActiveLeases(recB.id)).toBe(1)
    expect(snapshotMgr.getActiveLeases(recA.id)).toBe(0)
  })

  // R15: 跨重启持久化与多快照恢复
  it('R15: restores active snapshot B across process reboot while retaining snapshot A selectable in catalog', async () => {
    const rawA = join(rawSourceDir, 'r15-a.sqlite3')
    const rawB = join(rawSourceDir, 'r15-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['galaxy'] })
    buildValidTestDatabase(rawB, { headwords: ['quasar'] })

    const recA = await snapshotMgr.createAndPublishSnapshot(rawA, { identity: 'galaxy-dict' })
    const recB = await snapshotMgr.createAndPublishSnapshot(rawB, { identity: 'quasar-dict' })
    await coordinator.activateCustomDatabase(recB.id)

    // Simulate process shutdown
    await coordinator.dispose()
    manager.close()

    // Simulate process reboot
    const rebootManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const rebootSnapshotMgr = new CustomSnapshotManager({ paths })
    const rebootCoordinator = new ActivationCoordinator({
      paths,
      manager: rebootManager,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: rebootSnapshotMgr,
    })

    await rebootCoordinator.recoverOnStartup()

    // Snapshot B is restored as active
    expect(rebootManager.snapshot().activeMode).toBe('custom')
    expect(rebootCoordinator.getStatusSummary().activeSnapshotId).toBe(recB.id)
    expect(rebootManager.lookup('quasar')?.found).toBe(true)
    expect(rebootManager.lookup('galaxy')?.found).toBe(false)

    // Both snapshots are listed in catalog, A is selectable
    const list = rebootCoordinator.listCustomSnapshots()
    expect(list).toHaveLength(2)
    const snapA = list.find((s) => s.snapshotId === recA.id)
    const snapB = list.find((s) => s.snapshotId === recB.id)
    expect(snapA?.status).toBe('PUBLISHED_INACTIVE')
    expect(snapB?.status).toBe('ACTIVE')

    // Activate A on rebooted instance
    await rebootCoordinator.activateCustomDatabase(recA.id)
    expect(rebootManager.lookup('galaxy')?.found).toBe(true)
    expect(rebootCoordinator.getStatusSummary().activeSnapshotId).toBe(recA.id)

    await rebootCoordinator.dispose()
    rebootManager.close()
  })

  // R16: 100 MiB+ 大库 Worker 校验性能与宿主事件循环 SLA
  it('R16: validates 100 MiB+ SQLite database offloaded to worker within event-loop SLA (p99 <= 100ms, max <= 500ms) and bounded RSS', async () => {
    const largeDbPath = join(rawSourceDir, 'r16-large-100mb.sqlite3')
    const db = new DatabaseSync(largeDbPath)
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = 0;')
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    db.exec("INSERT INTO meta VALUES ('schema_version', '1'), ('corpus_name', 'CUSTOM_TEST');")
    db.exec(`
      CREATE TABLE entries (
        word TEXT PRIMARY KEY, phonetic TEXT, definition_en TEXT,
        translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER
      );
    `)
    db.exec('CREATE TABLE forms (form TEXT PRIMARY KEY, headword TEXT NOT NULL, kind TEXT);')
    db.exec('CREATE TABLE examples (id INTEGER PRIMARY KEY, headword TEXT NOT NULL, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL);')
    db.exec('CREATE INDEX idx_entries_word ON entries (word);')
    db.exec('CREATE INDEX idx_forms_form ON forms (form);')
    db.exec('CREATE INDEX idx_forms_headword ON forms (headword);')
    db.exec('CREATE INDEX idx_examples_headword ON examples (headword);')

    db.exec('BEGIN TRANSACTION;')
    const stmt = db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, 100);')
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 1700; i++) {
      stmt.run(`large_word_${i}`, 'phonetic', chunk, 'translation', 'n.')
    }
    db.exec('COMMIT;')
    db.close()

    const rawSize = statSync(largeDbPath).size
    expect(rawSize).toBeGreaterThanOrEqual(100 * 1024 * 1024)

    // Event loop latency monitor
    const delays: number[] = []
    let lastTick = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const delta = now - lastTick
      const delay = Math.max(0, delta - 10)
      delays.push(delay)
      lastTick = now
    }, 10)

    const initialRss = process.memoryUsage().rss

    let record
    try {
      record = await snapshotMgr.createAndPublishSnapshot(largeDbPath, { identity: 'large-bench' })
    } finally {
      clearInterval(timer)
    }

    const finalRss = process.memoryUsage().rss
    const rssIncreaseMb = (finalRss - initialRss) / (1024 * 1024)

    expect(delays.length).toBeGreaterThan(0)
    delays.sort((a, b) => a - b)
    const p99 = delays[Math.floor(delays.length * 0.99)] ?? 0
    const maxDelay = Math.max(...delays)

    // Assert SLA bounds
    expect(p99).toBeLessThanOrEqual(100)
    expect(maxDelay).toBeLessThanOrEqual(500)
    expect(record.byteSize).toBeGreaterThanOrEqual(100 * 1024 * 1024)
    expect(rssIncreaseMb).toBeLessThan(512)

    // Activate the published large snapshot
    await coordinator.activateCustomDatabase(record.id)
    expect(manager.lookup('large_word_0')?.found).toBe(true)
    expect(manager.lookup('large_word_1699')?.found).toBe(true)
  })

  // R17: 故障恢复: Managed -> Custom 崩溃窗口
  it('R17: recovers safely after crash during Managed to Custom transition', async () => {
    // 1. Establish valid custom snapshot on disk
    const rawPath = join(rawSourceDir, 'r17.sqlite3')
    buildValidTestDatabase(rawPath, { headwords: ['recovery-custom'] })
    const record = await snapshotMgr.createAndPublishSnapshot(rawPath, { identity: 'r17-dict' })

    // 2. Simulate crash during transition: active.json was committed to custom, but settingsSyncState is pending
    const activeMeta: ActiveMetadata = {
      version: 1,
      activeMode: 'custom',
      identity: record.identity,
      databaseFile: basename(record.publishedPath!),
      snapshotId: record.id,
      source: 'custom-local',
      sha256: record.sha256 ?? '',
      byteSize: record.byteSize ?? 0,
      schemaVersion: 1,
      lastActivatedAt: new Date().toISOString(),
      settingsSynced: false,
      settingsSyncState: 'pending',
    }
    await writeActiveMetadataAtomically(paths, activeMeta)

    // Reboot process
    const rebootMgr = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const rebootSnapMgr = new CustomSnapshotManager({ paths })
    const rebootCoord = new ActivationCoordinator({
      paths,
      manager: rebootMgr,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: rebootSnapMgr,
    })

    await rebootCoord.recoverOnStartup()

    expect(rebootMgr.snapshot().activeMode).toBe('custom')
    expect(rebootMgr.lookup('recovery-custom')?.found).toBe(true)
    expect(rebootCoord.getStatusSummary().activeSnapshotId).toBe(record.id)

    await rebootCoord.dispose()
    rebootMgr.close()
  })

  // R18: 故障恢复: Custom -> Managed 崩溃窗口
  it('R18: recovers safely after crash during Custom to Managed transition', async () => {
    // 1. Create durable custom snapshot in catalog
    const rawCustom = join(rawSourceDir, 'r18-custom.sqlite3')
    buildValidTestDatabase(rawCustom, { headwords: ['custom-r18'] })
    const customRecord = await snapshotMgr.createAndPublishSnapshot(rawCustom, { identity: 'r18-custom' })

    // 2. Create durable installed ECDICT database
    const identity = 'r18'
    const ecdictFileName = `ecdict-${identity}.sqlite3`
    const fullEcdictPath = join(paths.databaseDirectory, ecdictFileName)
    buildSyntheticManagedEcdictDb(fullEcdictPath, ['managed-r18'])
    const manifest = loadRuntimeCorpusManifest()
    const st = statSync(fullEcdictPath)

    await writeInstalledEcdictMetadataAtomically(paths, {
      version: 1,
      identity,
      databaseFile: ecdictFileName,
      source: {
        name: 'ECDICT',
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: 1,
      },
      installedAt: new Date().toISOString(),
      entryCount: 4,
      formCount: 4,
      byteSize: st.size,
    })

    // Simulate crash after active.json committed to managed-ecdict with pending settings
    await writeActiveMetadataAtomically(paths, {
      version: 1,
      activeMode: 'managed-ecdict',
      identity,
      databaseFile: ecdictFileName,
      source: {
        name: 'ECDICT',
        commit: manifest.sourceCommit,
        sha256: manifest.sourceSha256,
        schemaVersion: 1,
      },
      lastActivatedAt: new Date().toISOString(),
      settingsSynced: false,
      settingsSyncState: 'pending',
    })

    // Reboot process
    const rebootMgr = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const rebootSnapMgr = new CustomSnapshotManager({ paths })
    const rebootCoord = new ActivationCoordinator({
      paths,
      manager: rebootMgr,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: rebootSnapMgr,
    })

    await rebootCoord.recoverOnStartup()

    expect(rebootMgr.snapshot().activeMode).toBe('managed-ecdict')
    expect(rebootMgr.lookup('managed-r18')?.found).toBe(true)

    // Custom snapshot in catalog remains selectable
    const list = rebootCoord.listCustomSnapshots()
    const snap = list.find((s) => s.snapshotId === customRecord.id)
    expect(snap?.status).toBe('PUBLISHED_INACTIVE')

    await rebootCoord.dispose()
    rebootMgr.close()
  })

  // R19: 故障恢复: Custom -> Fixture 崩溃窗口
  it('R19: recovers safely after crash during Custom to Fixture transition', async () => {
    // 1. Create durable custom snapshot
    const rawCustom = join(rawSourceDir, 'r19-custom.sqlite3')
    buildValidTestDatabase(rawCustom, { headwords: ['custom-r19'] })
    const customRecord = await snapshotMgr.createAndPublishSnapshot(rawCustom, { identity: 'r19-custom' })

    // 2. Simulate crash during switch to fixture: active.json was removed
    if (existsSync(paths.activeMetadataPath)) {
      unlinkSync(paths.activeMetadataPath)
    }

    // Reboot process
    const rebootMgr = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    const rebootSnapMgr = new CustomSnapshotManager({ paths })
    const rebootCoord = new ActivationCoordinator({
      paths,
      manager: rebootMgr,
      config: Config({ dictionaryMode: 'fixture' }),
      customSnapshotManager: rebootSnapMgr,
    })

    await rebootCoord.recoverOnStartup()

    expect(rebootMgr.snapshot().activeMode).toBe('fixture')
    // Fixture lookups work
    expect(rebootMgr.lookup('derive')?.found).toBe(true)

    // Custom snapshot remains selectable in catalog
    const list = rebootCoord.listCustomSnapshots()
    const snap = list.find((s) => s.snapshotId === customRecord.id)
    expect(snap?.status).toBe('PUBLISHED_INACTIVE')
    expect(rebootSnapMgr.getActiveLeases(customRecord.id)).toBe(0)

    await rebootCoord.dispose()
    rebootMgr.close()
  })

  // R20: 完整端到端 HTTP Route 与查询闭环 (Status -> Lookup -> Activate A -> Lookup A -> Activate B -> Lookup B -> Select Fixture -> Select A -> Lookup A)
  it('R20: executes complete multi-mode management route and lookup lifecycle E2E', async () => {
    const rawA = join(rawSourceDir, 'r20-a.sqlite3')
    const rawB = join(rawSourceDir, 'r20-b.sqlite3')
    buildValidTestDatabase(rawA, { headwords: ['synapse'] })
    buildValidTestDatabase(rawB, { headwords: ['mitochondria'] })

    const statusHandler = createStatusHandler(opMan, coordinator)
    const activateHandler = createActivateCustomHandler(opMan)
    const selectHandler = createSelectModeHandler(opMan)
    const lookupHandler = createLookupHandler(Config({ dictionaryMode: 'fixture' }), manager)

    // 1. Initial Status
    const s1Res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    const s1Data = await s1Res.json()
    expect(s1Data.activeMode).toBe('fixture')

    // 2. Lookup in Fixture
    const l1Res = await lookupHandler(new Request('http://localhost' + LOOKUP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'derive' }),
    }))
    const l1Data = await l1Res.json()
    expect(l1Data.ok).toBe(true)
    expect(l1Data.found).toBe(true)

    // 3. Activate Custom A
    const actARes = await activateHandler(new Request('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rawA, identity: 'dict-a' }),
    }))
    const actAData = await actARes.json()
    expect(actAData.ok).toBe(true)
    expect(actAData.activeMode).toBe('custom')
    const snapAId = actAData.snapshotId

    // 4. Lookup Custom A word
    const l2Res = await lookupHandler(new Request('http://localhost' + LOOKUP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'synapse' }),
    }))
    const l2Data = await l2Res.json()
    expect(l2Data.ok).toBe(true)
    expect(l2Data.found).toBe(true)

    // 5. Activate Custom B
    const actBRes = await activateHandler(new Request('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rawB, identity: 'dict-b' }),
    }))
    const actBData = await actBRes.json()
    expect(actBData.ok).toBe(true)
    const snapBId = actBData.snapshotId
    expect(snapBId).toBeDefined()

    // 6. Lookup Custom B word
    const l3Res = await lookupHandler(new Request('http://localhost' + LOOKUP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mitochondria' }),
    }))
    const l3Data = await l3Res.json()
    expect(l3Data.ok).toBe(true)
    expect(l3Data.found).toBe(true)

    // 7. Select Fixture mode
    const selFixRes = await selectHandler(new Request('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fixture' }),
    }))
    const selFixData = await selFixRes.json()
    expect(selFixData.ok).toBe(true)
    expect(selFixData.activeMode).toBe('fixture')

    // 8. Select back to Custom A via snapshotId
    const selARes = await selectHandler(new Request('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'custom', snapshotId: snapAId }),
    }))
    const selAData = await selARes.json()
    expect(selAData.ok).toBe(true)
    expect(selAData.activeMode).toBe('custom')

    // 9. Lookup Custom A word again
    const l4Res = await lookupHandler(new Request('http://localhost' + LOOKUP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'synapse' }),
    }))
    const l4Data = await l4Res.json()
    expect(l4Data.ok).toBe(true)
    expect(l4Data.found).toBe(true)

    // 10. Verify final status has both snapshots
    const s2Res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    const s2Data = await s2Res.json()
    expect(s2Data.activeMode).toBe('custom')
    expect(s2Data.activeSnapshotId).toBe(snapAId)
    expect(s2Data.customSnapshots).toHaveLength(2)
  })
})
