/**
 * Acceptance Test Suite L01–L12 for Phase 7A.8.1AR2:
 * Snapshot Lease Atomicity, Cleanup Ownership & Evidence Closure.
 *
 * Implements deterministic verification of:
 * - L01: Cleanup claims deletion ownership -> openSnapshotDictionary is strictly rejected
 * - L02: Open acquires lease -> cleanupSnapshot is rejected with SnapshotActiveReferenceError
 * - L03: Concurrent cleanupSnapshot calls are atomic and idempotent without double unlinks
 * - L04: Database open failure rolls back reserved lease transactionally without leaking state
 * - L05: Open failure interleaves cleanly with cleanup without phantom state
 * - L06: SqliteDictionary handles duplicate close and underlying close error safely
 * - L07: Staging owner file creation failure fails closed and aborts creation
 * - L08: Active staging older than 1h is protected from deletion while manager is alive
 * - L09: Staging files with missing or malformed owner records fail closed
 * - L10: Multi-manager and PID reuse protection reclaims dead orphans without touching live staging
 * - L11: File symlink, directory junction, and parent reparse point capability testing and NOT_EXECUTED taxonomy
 * - L12: Fixture and Managed ECDICT compatibility regression verification
 */

import { describe, expect, it, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CustomSnapshotManager,
  SnapshotActiveReferenceError,
  _setCustomSnapshotHooksForTesting,
  _getHostProcessInstanceIdForTesting,
  _resetActiveManagersForTesting,
  type StagingOwnershipPayload,
} from '../src/host/custom-snapshot-manager.js'
import {
  resolveManagedStoragePaths,
  validateCustomSnapshotPath,
} from '../src/host/managed-storage.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import { openProductionDictionary } from '../src/host/corpus-db.js'

function createTempDir(prefix = 'dsh-l-test-'): string {
  const dir = join(tmpdir(), `${prefix}${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function buildValidTestDatabase(
  dbPath: string,
  options?: {
    journalMode?: 'DELETE' | 'WAL'
    versionMarker?: string
  },
): void {
  const db = new DatabaseSync(dbPath)
  const mode = options?.journalMode ?? 'DELETE'
  db.exec(`PRAGMA journal_mode = ${mode};`)

  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1');")
  db.exec("INSERT INTO meta (key, value) VALUES ('corpus_name', 'CUSTOM_TEST');")
  if (options?.versionMarker) {
    db.exec(`INSERT INTO meta (key, value) VALUES ('version_marker', '${options.versionMarker}');`)
  }

  db.exec(`
    CREATE TABLE entries (
      word TEXT PRIMARY KEY COLLATE NOCASE,
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
      form TEXT PRIMARY KEY COLLATE NOCASE,
      headword TEXT NOT NULL,
      kind TEXT
    );
  `)

  db.exec(`
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

  db.exec('CREATE INDEX idx_forms_headword_raw ON forms (headword);')
  db.exec('CREATE INDEX idx_examples_headword ON examples (headword COLLATE NOCASE);')

  db.exec("INSERT INTO entries VALUES ('apple', 'ˈæpl', 'A common fruit', '苹果', 'n.', 's:apples', 100);")
  db.exec("INSERT INTO entries VALUES ('banana', 'bəˈnænə', 'An elongated yellow fruit', '香蕉', 'n.', 's:bananas', 90);")
  db.exec("INSERT INTO forms VALUES ('apples', 'apple', 'plural');")
  db.exec("INSERT INTO forms VALUES ('bananas', 'banana', 'plural');")
  db.exec("INSERT INTO examples VALUES (1, 'apple', 'An apple a day', '一天一苹果', 'test', 'ex1', 1.0);")

  db.close()
}

function buildProductionEcdictTestDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES
      ('schema_version', '1'),
      ('corpus_name', 'ECDICT'),
      ('upstream_commit', 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'),
      ('source_sha256', '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf'),
      ('entry_count', '2'),
      ('form_count', '2'),
      ('example_count', '1'),
      ('logical_sha256', '0000000000000000000000000000000000000000000000000000000000000000');

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

    INSERT INTO entries VALUES ('apple', 'ˈæpl', 'a fruit', '苹果', 'n.', 's:apples', 100);
    INSERT INTO entries VALUES ('banana', 'bəˈnænə', 'a fruit', '香蕉', 'n.', 's:bananas', 90);
    INSERT INTO forms VALUES ('apples', 'apple', 'plural');
    INSERT INTO forms VALUES ('bananas', 'banana', 'plural');
    INSERT INTO examples VALUES (1, 'apple', 'An apple a day', '一天一苹果', 'ecdict', 'ex1', 1.0);
  `)
  db.close()
}

describe('Phase 7A.8.1AR2: Dedicated Acceptance Suite (L01–L12)', () => {
  afterEach(() => {
    _setCustomSnapshotHooksForTesting(null)
    _resetActiveManagersForTesting()
  })

  // L01: cleanup 获得所有权后禁止 open
  it('L01: strictly refuses openSnapshotDictionary once cleanup has claimed deletion ownership', async () => {
    const tmp = createTempDir('l01-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l01-snap' })
      expect(record.state).toBe('PUBLISHED_INACTIVE')
      expect(record.activeLeases).toBe(0)

      let cleanupInterleavedOpenThrew = false
      let observedStateDuringCleanup: string | null = null

      _setCustomSnapshotHooksForTesting({
        onBeforeValidateCleanup: async (snapshotId) => {
          const inProgressRecord = manager.getSnapshot(snapshotId)!
          observedStateDuringCleanup = inProgressRecord.state

          // Assert synchronous state ownership transition occurred before async boundary
          expect(observedStateDuringCleanup).toBe('CLEANUP_PENDING')
          expect(inProgressRecord.activeLeases).toBe(0)

          // Interleaved lease acquisition attempt MUST be rejected
          try {
            manager.openSnapshotDictionary(snapshotId)
          } catch (err: any) {
            cleanupInterleavedOpenThrew = true
            expect(err.message).toMatch(/CLEANUP_PENDING.*cannot be opened/i)
          }
        },
      })

      const cleanupResult = await manager.cleanupSnapshot(record.id)
      expect(cleanupResult).toBe(true)
      expect(cleanupInterleavedOpenThrew).toBe(true)
      expect(observedStateDuringCleanup).toBe('CLEANUP_PENDING')

      const finalRecord = manager.getSnapshot(record.id)!
      expect(finalRecord.state).toBe('DELETED')
      expect(finalRecord.activeLeases).toBe(0)
      expect(existsSync(record.publishedPath!)).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L02: open 获得租约后 cleanup 拒绝
  it('L02: rejects cleanupSnapshot when lease is acquired and allows cleanup only after lease release', async () => {
    const tmp = createTempDir('l02-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l02-snap' })
      const dict = manager.openSnapshotDictionary(record.id)
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(1)
      expect(manager.getSnapshot(record.id)?.state).toBe('ACTIVE')

      // Cleanup MUST be rejected while lease is held
      await expect(manager.cleanupSnapshot(record.id)).rejects.toThrow(SnapshotActiveReferenceError)

      // Query remains fully operational
      const lookupResult = dict.lookup('apple')
      expect(lookupResult.found).toBe(true)
      if (lookupResult.found) {
        expect(lookupResult.headword).toBe('apple')
      }

      // Release lease
      dict.close()
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Cleanup now succeeds
      const cleaned = await manager.cleanupSnapshot(record.id)
      expect(cleaned).toBe(true)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')
      expect(existsSync(record.publishedPath!)).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L03: 两个 cleanup 并发幂等
  it('L03: deduplicates concurrent cleanupSnapshot calls atomically without double unlinks or state regressions', async () => {
    const tmp = createTempDir('l03-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l03-snap' })

      let validateCallCount = 0
      let unlinkCallCount = 0

      _setCustomSnapshotHooksForTesting({
        onBeforeValidateCleanup: async () => {
          validateCallCount++
          // Small delay to simulate async filesystem traversal
          await new Promise((r) => setTimeout(r, 20))
        },
        onBeforeUnlinkCleanup: async () => {
          unlinkCallCount++
        },
      })

      // Concurrently dispatch two cleanups
      const [res1, res2] = await Promise.all([
        manager.cleanupSnapshot(record.id),
        manager.cleanupSnapshot(record.id),
      ])

      expect(res1).toBe(true)
      expect(res2).toBe(true)
      expect(validateCallCount).toBe(1)
      expect(unlinkCallCount).toBe(1)

      // Sequential third call is idempotent
      const res3 = await manager.cleanupSnapshot(record.id)
      expect(res3).toBe(true)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')
      expect(existsSync(record.publishedPath!)).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L04: 打开失败回滚租约
  it('L04: transactionally rolls back lease reservation on database open failure without leaking active leases or phantom ACTIVE state', async () => {
    const tmp = createTempDir('l04-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l04-snap' })
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Case A: File removed or missing at open time
      unlinkSync(record.publishedPath!)
      expect(() => manager.openSnapshotDictionary(record.id)).toThrow()

      const recAfterFailedOpenA = manager.getSnapshot(record.id)!
      expect(recAfterFailedOpenA.activeLeases).toBe(0)
      expect(recAfterFailedOpenA.state).toBe('PUBLISHED_INACTIVE')

      // Case B: Injected error in openSqliteDictionary hook
      writeFileSync(record.publishedPath!, 'not a valid sqlite file')
      _setCustomSnapshotHooksForTesting({
        openSqliteDictionary: () => {
          throw new Error('Injected SQLite open failure (e.g. disk corruption)')
        },
      })

      expect(() => manager.openSnapshotDictionary(record.id)).toThrow(/Injected SQLite open failure/)

      const recAfterFailedOpenB = manager.getSnapshot(record.id)!
      expect(recAfterFailedOpenB.activeLeases).toBe(0)
      expect(recAfterFailedOpenB.state).toBe('PUBLISHED_INACTIVE')

      // Since active leases rolled back cleanly to 0, cleanup remains possible
      const cleanupSuccess = await manager.cleanupSnapshot(record.id)
      expect(cleanupSuccess).toBe(true)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L05: 打开失败与 cleanup 交错
  it('L05: preserves consistency when open failure interleaves with cleanup', async () => {
    const tmp = createTempDir('l05-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l05-snap' })

      _setCustomSnapshotHooksForTesting({
        openSqliteDictionary: () => {
          throw new Error('Simulated SQLite engine failure')
        },
      })

      // Attempt open that fails
      expect(() => manager.openSnapshotDictionary(record.id)).toThrow(/Simulated SQLite engine failure/)

      // Lease counter must be exactly 0
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)

      // Immediate cleanup succeeds without being blocked by phantom lease
      const cleaned = await manager.cleanupSnapshot(record.id)
      expect(cleaned).toBe(true)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L06: close 异常和重复 close
  it('L06: handles duplicate close and close errors without negative lease counts or state corruption', async () => {
    const tmp = createTempDir('l06-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'l06-snap' })
      const dict = manager.openSnapshotDictionary(record.id)
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(1)

      // First close decrements lease
      dict.close()
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Second close is an idempotent no-op
      dict.close()
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Open again to test close with underlying error
      _setCustomSnapshotHooksForTesting({
        openSqliteDictionary: () => {
          return {
            source: 'custom-local',
            initialization: {} as any,
            lookup: () => ({ found: false, query: '' }),
            close: () => {
              throw new Error('Underlying SQLite handle error')
            },
          } as any
        },
      })

      const dict2 = manager.openSnapshotDictionary(record.id)
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(1)

      // dict.close() wraps in try-finally, so manager lease is still safely decremented even when underlying close throws
      expect(() => dict2.close()).toThrow(/Underlying SQLite handle error/)
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L07: owner 创建失败拒绝执行
  it('L07: fails closed when staging ownership record cannot be created and cleans up tracking', async () => {
    const tmp = createTempDir('l07-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      _setCustomSnapshotHooksForTesting({
        onBeforeWriteOwner: () => {
          throw new Error('EACCES: permission denied creating .owner file')
        },
      })

      await expect(manager.createAndPublishSnapshot(srcDb)).rejects.toThrow(
        /Failed to establish staging ownership record/,
      )

      // Verify no dangling staging files or active ownership in manager
      expect(manager.listSnapshots().length).toBe(0)
      const remainingStaging = await manager.cleanupStagingFiles()
      expect(remainingStaging).toBe(0)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L08: 活跃 staging 超过一小时不误删
  it('L08: does not delete active staging files even if elapsed time exceeds 1 hour while manager remains alive', async () => {
    const tmp = createTempDir('l08-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    // Simulate 2 hours elapsed at creation time
    const simulatedOldTime = Date.now() - 2 * 3600 * 1000
    let stagingObservedInCleanup = false
    let cleanedCount = -1

    const managerA = new CustomSnapshotManager({ paths })
    const managerB = new CustomSnapshotManager({ paths })

    _setCustomSnapshotHooksForTesting({
      now: () => simulatedOldTime,
      onAfterCreateStaging: async (stagingPath) => {
        expect(managerA.isStagingActive(stagingPath)).toBe(true)
        // Manager B attempts cleanup while Manager A is actively running with >1h old staging
        cleanedCount = await managerB.cleanupStagingFiles()
        stagingObservedInCleanup = existsSync(stagingPath)
      },
    })

    try {
      const record = await managerA.createAndPublishSnapshot(srcDb, { identity: 'l08-dict' })
      expect(record.state).toBe('PUBLISHED_INACTIVE')
      expect(cleanedCount).toBe(0)
      expect(stagingObservedInCleanup).toBe(true)
    } finally {
      await managerA.dispose()
      await managerB.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L09: owner 缺失/损坏 fail-closed
  it('L09: fails closed on missing or malformed owner records, deleting them only via explicit unverified recovery', async () => {
    const tmp = createTempDir('l09-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    mkdirSync(paths.customSnapshotDirectory, { recursive: true })

    // Staging 1: Missing owner file
    const snap1 = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    writeFileSync(snap1, 'staging without owner')

    // Staging 2: Malformed JSON owner file
    const snap2 = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    writeFileSync(snap2, 'staging with broken owner')
    writeFileSync(`${snap2}.owner`, '{ malformed json: true, ...')

    // Staging 3: Incomplete fields in owner file
    const snap3 = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    writeFileSync(snap3, 'staging with missing fields')
    writeFileSync(`${snap3}.owner`, JSON.stringify({ pid: process.pid })) // missing hostInstanceId etc.

    const manager = new CustomSnapshotManager({ paths })
    try {
      // Default cleanupStagingFiles() MUST fail-closed: do NOT touch unverified files!
      const defaultCleaned = await manager.cleanupStagingFiles()
      expect(defaultCleaned).toBe(0)
      expect(existsSync(snap1)).toBe(true)
      expect(existsSync(snap2)).toBe(true)
      expect(existsSync(snap3)).toBe(true)

      // Explicit recovery enabled: now unverified files can be safely reclaimed
      const recoveryCleaned = await manager.cleanupStagingFiles({ allowUnverifiedRecovery: true })
      expect(recoveryCleaned).toBe(3)
      expect(existsSync(snap1)).toBe(false)
      expect(existsSync(snap2)).toBe(false)
      expect(existsSync(snap3)).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L10: 多 Manager / PID 重用保护
  it('L10: detects PID reuse via hostInstanceId and safely reclaims dead owner staging files', async () => {
    const tmp = createTempDir('l10-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    mkdirSync(paths.customSnapshotDirectory, { recursive: true })

    // Staging file created by a previous process with SAME pid but DIFFERENT hostInstanceId (reused PID)
    const deadStaging = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    const deadOwner = `${deadStaging}.owner`
    writeFileSync(deadStaging, 'dead staging content')

    const deadPayload: StagingOwnershipPayload = {
      version: 1,
      managerId: 'old-manager-uuid',
      snapshotId: randomUUID(),
      pid: process.pid, // same PID!
      processStartTime: Date.now() - 5000000,
      createdAt: Date.now() - 4000000,
      hostInstanceId: 'reused-dead-host-instance-uuid', // different instance!
    }
    writeFileSync(deadOwner, JSON.stringify(deadPayload))

    const manager = new CustomSnapshotManager({ paths })
    try {
      const cleaned = await manager.cleanupStagingFiles()
      expect(cleaned).toBe(1)
      expect(existsSync(deadStaging)).toBe(false)
      expect(existsSync(deadOwner)).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // L11: symlink/junction 实际验证与 NOT_EXECUTED 分类
  it('L11: detects symlink capabilities and enforces non-bypassable rejection or explicit NOT_EXECUTED taxonomy', async () => {
    const tmp = createTempDir('l11-')
    const probeTarget = join(tmp, 'probe-target.txt')
    writeFileSync(probeTarget, 'test')
    const probeLink = join(tmp, 'probe-link.txt')

    let symlinkSupported = false
    try {
      symlinkSync(probeTarget, probeLink, 'file')
      symlinkSupported = true
      unlinkSync(probeLink)
    } catch {
      symlinkSupported = false
    }

    let junctionSupported = false
    const probeDir = join(tmp, 'probe-dir')
    mkdirSync(probeDir, { recursive: true })
    const probeJunc = join(tmp, 'probe-junc')
    try {
      symlinkSync(probeDir, probeJunc, 'junction')
      junctionSupported = true
      unlinkSync(probeJunc)
    } catch {
      junctionSupported = false
    }

    if (!symlinkSupported) {
      // Must not falsely PASS
      throw new Error('NOT_EXECUTED: Environment lacks symlink creation privileges')
    }

    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    await mkdir(paths.customSnapshotDirectory, { recursive: true })

    const outsideDir = join(tmp, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const outsideDb = join(outsideDir, 'outside.sqlite3')
    buildValidTestDatabase(outsideDb)

    // 1. File symlink
    const symlinkTarget = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    symlinkSync(outsideDb, symlinkTarget, 'file')
    await expect(
      validateCustomSnapshotPath(symlinkTarget, paths.customSnapshotDirectory),
    ).rejects.toThrow(/must not be a symbolic link/i)
    unlinkSync(symlinkTarget)

    // 2. Directory junction
    if (junctionSupported) {
      const juncHome = join(tmp, 'junc-home')
      const juncPaths = resolveManagedStoragePaths({ home: juncHome })
      mkdirSync(juncPaths.storageDirectory, { recursive: true })
      symlinkSync(outsideDir, juncPaths.customSnapshotDirectory, 'junction')

      const dummySnapshot = join(juncPaths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
      await expect(
        validateCustomSnapshotPath(dummySnapshot, juncPaths.customSnapshotDirectory),
      ).rejects.toThrow(/must not be a symbolic link or junction/i)

      unlinkSync(juncPaths.customSnapshotDirectory)

      // 3. Parent directory junction
      const parentJuncHome = join(tmp, 'parent-junc-home')
      const parentJuncPaths = resolveManagedStoragePaths({ home: parentJuncHome })
      mkdirSync(resolve(parentJuncPaths.storageDirectory, '..'), { recursive: true })
      symlinkSync(outsideDir, parentJuncPaths.storageDirectory, 'junction')

      const parentJuncSnapshot = join(parentJuncPaths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
      await expect(
        validateCustomSnapshotPath(parentJuncSnapshot, parentJuncPaths.customSnapshotDirectory),
      ).rejects.toThrow(/must not be a symbolic link or junction/i)

      unlinkSync(parentJuncPaths.storageDirectory)
    }

    rmSync(tmp, { recursive: true, force: true })
  })

  // L12: Fixture 与 Managed ECDICT 分别回归
  it('L12: independently verifies Fixture and Managed ECDICT compatibility', async () => {
    // 12A: Built-in Fixture
    const fixtureDict = openFixtureDictionary()
    const fixtureManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'built-in-fixture',
      dictionary: fixtureDict,
    })
    try {
      expect(fixtureManager.source).toBe('sqlite-fixture')
      expect(fixtureManager.snapshot().activeMode).toBe('fixture')

      const hitHead = fixtureManager.lookup('derive')
      expect(hitHead.found).toBe(true)
      if (hitHead.found) {
        expect(hitHead.headword).toBe('derive')
      }

      const hitForm = fixtureManager.lookup('derived')
      expect(hitForm.found).toBe(true)
      if (hitForm.found) {
        expect(hitForm.headword).toBe('derive')
      }

      const miss = fixtureManager.lookup('nonexistent_word_xyz')
      expect(miss.found).toBe(false)
    } finally {
      fixtureManager.close()
    }

    // 12B: Managed ECDICT
    const tmp = createTempDir('l12b-')
    const dbPath = join(tmp, 'ecdict-prod.sqlite3')
    buildProductionEcdictTestDatabase(dbPath)

    const ecdictDict = openProductionDictionary({ path: dbPath })
    const ecdictManager = new DictionaryManager({
      mode: 'managed-ecdict',
      identity: 'ecdict-v1-production',
      dictionary: ecdictDict,
    })
    try {
      expect(ecdictManager.source).toBe('ecdict-local')
      expect(ecdictManager.snapshot().activeMode).toBe('managed-ecdict')

      const hitHead = ecdictManager.lookup('apple')
      expect(hitHead.found).toBe(true)
      if (hitHead.found) {
        expect(hitHead.headword).toBe('apple')
        expect(hitHead.senses[0]?.translation).toBe('苹果')
      }

      const hitForm = ecdictManager.lookup('apples')
      expect(hitForm.found).toBe(true)
      if (hitForm.found) {
        expect(hitForm.headword).toBe('apple')
      }

      const miss = ecdictManager.lookup('nonexistent_word_xyz')
      expect(miss.found).toBe(false)
    } finally {
      ecdictManager.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
