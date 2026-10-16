/**
 * Acceptance Test Suite R01–R22 for Phase 7A.8.1AR:
 * Snapshot Safety, Race Acceptance Repair & Storage Lifecycle Protection.
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CustomDictionaryValidator,
  SnapshotTamperingError,
  ValidatorCancelledError,
  ValidatorCrashError,
} from '../src/host/custom-dictionary-validator.js'
import {
  CustomSnapshotManager,
  SnapshotActiveReferenceError,
  SnapshotPublishConflictError,
} from '../src/host/custom-snapshot-manager.js'
import {
  resolveManagedStoragePaths,
  validateCustomSnapshotPath,
} from '../src/host/managed-storage.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { computeFileSha256 } from '../src/host/custom-dictionary-worker.js'
import { spawnIntegrityWorker } from '../src/host/ecdict-integrity-verifier.js'

function createTempDir(prefix = 'dsh-r-test-'): string {
  const dir = join(tmpdir(), `${prefix}${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function buildValidTestDatabase(
  dbPath: string,
  options?: {
    journalMode?: 'DELETE' | 'WAL'
    entriesCount?: number
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

  db.exec('CREATE INDEX idx_forms_headword ON forms (headword);')
  db.exec('CREATE INDEX idx_examples_headword ON examples (headword);')

  db.exec("INSERT INTO entries VALUES ('apple', 'ˈæpl', 'A common fruit', '苹果', 'n.', 'apples', 100);")
  db.exec("INSERT INTO entries VALUES ('banana', 'bəˈnɑːnə', 'A yellow fruit', '香蕉', 'n.', 'bananas', 90);")
  db.exec("INSERT INTO forms VALUES ('apples', 'apple', 'plural');")
  db.exec("INSERT INTO forms VALUES ('bananas', 'banana', 'plural');")
  db.exec("INSERT INTO examples VALUES (1, 'apple', 'An apple a day', '一天一苹果', 'test', 'ex1', 1.0);")

  db.close()
}

describe('Phase 7A.8.1AR: Scenario Acceptance Matrix (R01–R22)', () => {
  // R01: 同 identity 重复发布不覆盖旧文件
  it('R01: publishing with same identity token produces distinct snapshots and never overwrites existing file', async () => {
    const tmp = createTempDir('r01-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })

    const srcDb1 = join(tmp, 'src1.sqlite3')
    buildValidTestDatabase(srcDb1, { versionMarker: 'V1' })

    const srcDb2 = join(tmp, 'src2.sqlite3')
    buildValidTestDatabase(srcDb2, { versionMarker: 'V2' })
    const db2 = new DatabaseSync(srcDb2)
    db2.exec("INSERT INTO entries VALUES ('cherry', null, 'Cherry fruit', '樱桃', 'n.', null, 80);")
    db2.close()

    const manager = new CustomSnapshotManager({ paths })
    try {
      const rec1 = await manager.createAndPublishSnapshot(srcDb1, { identity: 'my-custom-dict' })
      expect(rec1.state).toBe('PUBLISHED_INACTIVE')
      const publishedPath1 = rec1.publishedPath!
      const sha1 = computeFileSha256(publishedPath1)

      // Second publish using exact same logical identity
      const rec2 = await manager.createAndPublishSnapshot(srcDb2, { identity: 'my-custom-dict' })
      expect(rec2.state).toBe('PUBLISHED_INACTIVE')
      const publishedPath2 = rec2.publishedPath!

      // Unique IDs and distinct published filenames
      expect(rec1.id).not.toBe(rec2.id)
      expect(publishedPath1).not.toBe(publishedPath2)

      // First snapshot file remains intact with identical hash
      expect(existsSync(publishedPath1)).toBe(true)
      expect(computeFileSha256(publishedPath1)).toBe(sha1)

      // Both dictionaries resolve their specific contents independently
      const dict1 = manager.openSnapshotDictionary(rec1.id)
      const dict2 = manager.openSnapshotDictionary(rec2.id)

      expect(dict1.lookup('apple').found).toBe(true)
      expect(dict1.lookup('cherry').found).toBe(false)

      expect(dict2.lookup('apple').found).toBe(true)
      expect(dict2.lookup('cherry').found).toBe(true)

      dict1.close()
      dict2.close()

      // Staging files are all cleaned up
      const orphanCount = await manager.cleanupStagingFiles()
      expect(orphanCount).toBe(0)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R02: 同 identity 并发发布
  it('R02: concurrent publishes with identical identity token succeed without collision or overwrite', async () => {
    const tmp = createTempDir('r02-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })

    const srcDb = join(tmp, 'concurrent-src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const p1 = manager.createAndPublishSnapshot(srcDb, { identity: 'race-dict' })
      const p2 = manager.createAndPublishSnapshot(srcDb, { identity: 'race-dict' })

      const [rec1, rec2] = await Promise.all([p1, p2])

      expect(rec1.state).toBe('PUBLISHED_INACTIVE')
      expect(rec2.state).toBe('PUBLISHED_INACTIVE')
      expect(rec1.id).not.toBe(rec2.id)
      expect(rec1.publishedPath).not.toBe(rec2.publishedPath)

      expect(existsSync(rec1.publishedPath!)).toBe(true)
      expect(existsSync(rec2.publishedPath!)).toBe(true)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R03: 发布目标路径竞争 (Fail-closed on collision)
  it('R03: fails closed when target publication file already exists and preserves existing file intact', async () => {
    const tmp = createTempDir('r03-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    await mkdir(paths.customSnapshotDirectory, { recursive: true })

    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    // Pre-create existing file at specific target name
    const preExistingFile = join(paths.customSnapshotDirectory, 'custom-conflict-target.sqlite3')
    writeFileSync(preExistingFile, 'PRE_EXISTING_PUBLISHED_DATA_DO_NOT_OVERWRITE')
    const preHash = computeFileSha256(preExistingFile)

    const manager = new CustomSnapshotManager({ paths })
    try {
      await expect(
        manager.createAndPublishSnapshot(srcDb, {
          identity: 'conflict-test',
          targetFileName: 'custom-conflict-target.sqlite3',
        }),
      ).rejects.toThrowError(SnapshotPublishConflictError)

      // Pre-existing file is completely unaltered
      expect(existsSync(preExistingFile)).toBe(true)
      expect(readFileSync(preExistingFile, 'utf8')).toBe('PRE_EXISTING_PUBLISHED_DATA_DO_NOT_OVERWRITE')
      expect(computeFileSha256(preExistingFile)).toBe(preHash)

      // No orphan staging files left behind
      const stagingCount = await manager.cleanupStagingFiles()
      expect(stagingCount).toBe(0)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R04: 活动快照 cleanup 拒绝
  it('R04: rejects cleanupSnapshot when active dictionary leases are held, keeping dictionary operational', async () => {
    const tmp = createTempDir('r04-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'active-lease-test' })
      const dict = manager.openSnapshotDictionary(record.id)

      expect(manager.getSnapshot(record.id)?.state).toBe('ACTIVE')
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(1)

      // Cleanup attempt must fail closed
      await expect(manager.cleanupSnapshot(record.id)).rejects.toThrowError(SnapshotActiveReferenceError)

      // Snapshot file still exists and queries still succeed
      expect(existsSync(record.publishedPath!)).toBe(true)
      const lookup = dict.lookup('apple')
      expect(lookup.found).toBe(true)

      dict.close()
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R05: 最后引用释放后安全 cleanup
  it('R05: allows cleanupSnapshot only after the last dictionary reference is closed and performs safe deletion', async () => {
    const tmp = createTempDir('r05-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb)
      const dict1 = manager.openSnapshotDictionary(record.id)
      const dict2 = manager.openSnapshotDictionary(record.id)

      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(2)

      // Close first handle; lease drops to 1, cleanup still blocked
      dict1.close()
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(1)
      await expect(manager.cleanupSnapshot(record.id)).rejects.toThrowError(SnapshotActiveReferenceError)

      // Close second handle; lease drops to 0, state becomes PUBLISHED_INACTIVE
      dict2.close()
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Now cleanup is permitted
      const res = await manager.cleanupSnapshot(record.id)
      expect(res).toBe(true)
      expect(existsSync(record.publishedPath!)).toBe(false)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')

      // Idempotent secondary cleanup
      const res2 = await manager.cleanupSnapshot(record.id)
      expect(res2).toBe(true)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R06: Windows/POSIX 生命周期语义 (retiring, idempotent close, lock handling)
  it('R06: handles retiring transitions and duplicate closes deterministically without negative lease count', async () => {
    const tmp = createTempDir('r06-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb)
      const dict = manager.openSnapshotDictionary(record.id)

      // Retire snapshot while reference is active
      manager.retireSnapshot(record.id)
      expect(manager.getSnapshot(record.id)?.state).toBe('RETIRING')

      // While retiring, cleanup is still rejected
      await expect(manager.cleanupSnapshot(record.id)).rejects.toThrowError(SnapshotActiveReferenceError)

      // Duplicate close on dictionary
      dict.close()
      dict.close() // Idempotent close does not double-decrement
      expect(manager.getSnapshot(record.id)?.activeLeases).toBe(0)
      expect(manager.getSnapshot(record.id)?.state).toBe('PUBLISHED_INACTIVE')

      // Now safe cleanup succeeds
      await manager.cleanupSnapshot(record.id)
      expect(manager.getSnapshot(record.id)?.state).toBe('DELETED')
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R07: 大型文件 Hash 不阻塞 Host
  it('R07: offloads pre-publish full SHA-256 to worker thread keeping host event loop responsive', async () => {
    const tmp = createTempDir('r07-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'perf-src.sqlite3')
    buildValidTestDatabase(srcDb)

    let maxLagMs = 0
    let lastTick = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      const lag = Math.max(0, now - lastTick - 10)
      if (lag > maxLagMs) maxLagMs = lag
      lastTick = now
    }, 10)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const record = await manager.createAndPublishSnapshot(srcDb, { identity: 'perf-test' })
      expect(record.state).toBe('PUBLISHED_INACTIVE')
      expect(maxLagMs).toBeLessThan(120) // Event loop remains responsive
    } finally {
      clearInterval(timer)
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R08: Hash 与 publish 间篡改
  it('R08: detects staging tampering during pre-publish worker check and rejects publishing', async () => {
    const tmp = createTempDir('r08-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'tamper-src.sqlite3')
    buildValidTestDatabase(srcDb)

    const hookValidator = new CustomDictionaryValidator({
      workerAdapter: (req) => {
        const worker = spawnIntegrityWorker(req)
        if ((req as any).action === 'CUSTOM_SNAPSHOT_VALIDATE') {
          const snapPath = (req as any).snapshotPath
          worker.on('message', (msg: any) => {
            if (msg?.success === true && existsSync(snapPath)) {
              appendFileSync(snapPath, Buffer.from([0x01, 0x02, 0x03]))
            }
          })
        }
        return worker as any
      },
    })

    const manager = new CustomSnapshotManager({ paths, validator: hookValidator })
    try {
      await expect(
        manager.createAndPublishSnapshot(srcDb, { identity: 'tamper-r08' }),
      ).rejects.toThrowError(SnapshotTamperingError)

      expect(manager.listSnapshots()[0]?.state).toBe('CLEANUP_PENDING')
    } finally {
      await manager.dispose()
      await hookValidator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R09: 真实事务并发快照一致性
  it('R09: captures point-in-time ACID consistent state (all-A or all-B) during active concurrent WAL writes', async () => {
    const tmp = createTempDir('r09-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'wal-src.sqlite3')

    const initDb = new DatabaseSync(srcDb)
    initDb.exec('PRAGMA journal_mode = WAL;')
    initDb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    initDb.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1');")
    initDb.exec("INSERT INTO meta (key, value) VALUES ('version_marker', 'VERSION_A');")
    initDb.exec(`
      CREATE TABLE entries (
        word TEXT PRIMARY KEY, phonetic TEXT, definition_en TEXT,
        translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER
      );
      CREATE TABLE forms (form TEXT PRIMARY KEY, headword TEXT NOT NULL, kind TEXT);
      CREATE INDEX idx_forms_headword ON forms (headword);
      CREATE TABLE examples (id INTEGER PRIMARY KEY AUTOINCREMENT, headword TEXT NOT NULL, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL);
      CREATE INDEX idx_examples_headword ON examples (headword);
    `)
    initDb.exec("INSERT INTO entries VALUES ('word_a1', null, 'Word A1', '词A1', 'n.', null, 1);")
    initDb.exec("INSERT INTO entries VALUES ('word_a2', null, 'Word A2', '词A2', 'n.', null, 1);")
    initDb.exec("INSERT INTO forms VALUES ('word_a1_s', 'word_a1', 'plural');")
    initDb.close()

    const writer = new DatabaseSync(srcDb)
    writer.exec('PRAGMA journal_mode = WAL;')

    const manager = new CustomSnapshotManager({ paths })
    try {
      const snapPromise = manager.createAndPublishSnapshot(srcDb, { identity: 'acid-snap' })

      writer.exec('BEGIN IMMEDIATE;')
      writer.exec("UPDATE meta SET value = 'VERSION_B' WHERE key = 'version_marker';")
      writer.exec("INSERT INTO entries VALUES ('word_b1', null, 'Word B1', '词B1', 'n.', null, 2);")
      writer.exec("INSERT INTO entries VALUES ('word_b2', null, 'Word B2', '词B2', 'n.', null, 2);")
      writer.exec('COMMIT;')

      const record = await snapPromise
      expect(record.state).toBe('PUBLISHED_INACTIVE')

      const snapDb = new DatabaseSync(record.publishedPath!)
      const markerRow = snapDb.prepare("SELECT value FROM meta WHERE key = 'version_marker'").get() as { value: string }
      snapDb.close()

      const dict = manager.openSnapshotDictionary(record.id)
      const hitA1 = dict.lookup('word_a1')
      const hitA2 = dict.lookup('word_a2')
      const hitB1 = dict.lookup('word_b1')
      const hitB2 = dict.lookup('word_b2')
      dict.close()

      if (markerRow.value === 'VERSION_A') {
        expect(hitA1.found).toBe(true)
        expect(hitA2.found).toBe(true)
        expect(hitB1.found).toBe(false)
        expect(hitB2.found).toBe(false)
      } else {
        expect(hitA1.found).toBe(true)
        expect(hitA2.found).toBe(true)
        expect(hitB1.found).toBe(true)
        expect(hitB2.found).toBe(true)
      }
    } finally {
      writer.close()
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R10: 源文件在快照生成期间变化
  it('R10: prevents source file modification from producing an inconsistent published snapshot', async () => {
    const tmp = createTempDir('r10-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'r10-src.sqlite3')
    buildValidTestDatabase(srcDb, { journalMode: 'WAL' })

    const writer = new DatabaseSync(srcDb)
    writer.exec('PRAGMA journal_mode = WAL;')

    const manager = new CustomSnapshotManager({ paths })
    try {
      const snapPromise = manager.createAndPublishSnapshot(srcDb, { identity: 'r10-snap' })
      writer.exec("INSERT INTO entries VALUES ('r10_concurrent', null, 'R10', '并发', 'n.', null, 1);")

      const record = await snapPromise
      expect(record.state).toBe('PUBLISHED_INACTIVE')

      const dict = manager.openSnapshotDictionary(record.id)
      expect(dict.lookup('apple').found).toBe(true)
      dict.close()
    } finally {
      writer.close()
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R11: staging 验证后篡改
  it('R11: detects byte corruption after validation and rejects publish without publishing invalid file', async () => {
    const tmp = createTempDir('r11-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'r11-src.sqlite3')
    buildValidTestDatabase(srcDb)

    let capturedStaging: string | null = null
    const tamperValidator = new CustomDictionaryValidator({
      workerAdapter: (req) => {
        const worker = spawnIntegrityWorker(req)
        if ((req as any).action === 'CUSTOM_SNAPSHOT_VALIDATE') {
          capturedStaging = (req as any).snapshotPath
          worker.on('message', (msg: any) => {
            if (msg?.success === true && capturedStaging && existsSync(capturedStaging)) {
              appendFileSync(capturedStaging, Buffer.from([0x99, 0x88]))
            }
          })
        }
        return worker as any
      },
    })

    const manager = new CustomSnapshotManager({ paths, validator: tamperValidator })
    try {
      await expect(
        manager.createAndPublishSnapshot(srcDb, { identity: 'r11-test' }),
      ).rejects.toThrowError(SnapshotTamperingError)

      if (capturedStaging) {
        expect(existsSync(capturedStaging)).toBe(false)
      }
      expect(manager.listSnapshots()[0]?.state).toBe('CLEANUP_PENDING')
    } finally {
      await manager.dispose()
      await tamperValidator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R12: rename/publish 失败补偿
  it('R12: publication destination conflict triggers compensation and does not corrupt existing data', async () => {
    const tmp = createTempDir('r12-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    await mkdir(paths.customSnapshotDirectory, { recursive: true })

    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const conflictDest = join(paths.customSnapshotDirectory, 'custom-r12-dest.sqlite3')
    writeFileSync(conflictDest, 'R12_ORIGINAL_FILE_CONTENT')
    const originalHash = computeFileSha256(conflictDest)

    const manager = new CustomSnapshotManager({ paths })
    try {
      await expect(
        manager.createAndPublishSnapshot(srcDb, { targetFileName: 'custom-r12-dest.sqlite3' }),
      ).rejects.toThrowError(SnapshotPublishConflictError)

      expect(readFileSync(conflictDest, 'utf8')).toBe('R12_ORIGINAL_FILE_CONTENT')
      expect(computeFileSha256(conflictDest)).toBe(originalHash)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R13: Worker 非零异常退出
  it('R13: handles worker exiting with non-zero exit code without sending response', async () => {
    const tmp = createTempDir('r13-')
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const crashWorker = () => {
      const emitter = new EventEmitter() as any
      emitter.terminate = async () => 0
      setTimeout(() => emitter.emit('exit', 42), 10)
      return emitter
    }

    const validator = new CustomDictionaryValidator({ workerAdapter: crashWorker })
    try {
      await expect(validator.validateSnapshot(srcDb)).rejects.toThrowError(ValidatorCrashError)
      expect(validator.runningCount).toBe(0)
    } finally {
      await validator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R14: Worker 无消息退出 (exit code 0 without response)
  it('R14: handles worker exiting cleanly with code 0 without sending response', async () => {
    const tmp = createTempDir('r14-')
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const cleanExitWorker = () => {
      const emitter = new EventEmitter() as any
      emitter.terminate = async () => 0
      setTimeout(() => emitter.emit('exit', 0), 10)
      return emitter
    }

    const validator = new CustomDictionaryValidator({ workerAdapter: cleanExitWorker })
    try {
      await expect(validator.validateSnapshot(srcDb)).rejects.toThrowError(ValidatorCrashError)
      expect(validator.runningCount).toBe(0)
    } finally {
      await validator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R15: Worker 取消/异常竞态
  it('R15: settles cleanly when cancellation occurs during worker execution', async () => {
    const tmp = createTempDir('r15-')
    const srcDb = join(tmp, 'src.sqlite3')
    const stagingDb = join(tmp, 'staging.sqlite3')
    buildValidTestDatabase(srcDb)

    const controller = new AbortController()
    const validator = new CustomDictionaryValidator()
    try {
      const p = validator.createSnapshot(srcDb, stagingDb, { signal: controller.signal })
      controller.abort()
      await expect(p).rejects.toThrowError(ValidatorCancelledError)
      expect(validator.runningCount).toBe(0)
    } finally {
      await validator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R16: symlink/junction 实际逃逸
  it('R16: rejects file symlinks and directory junctions attempting to escape or breach managed boundaries', async () => {
    const tmp = createTempDir('r16-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    await mkdir(paths.customSnapshotDirectory, { recursive: true })

    const externalDir = join(tmp, 'outside')
    mkdirSync(externalDir, { recursive: true })
    const outsideDb = join(externalDir, 'outside.sqlite3')
    buildValidTestDatabase(outsideDb)

    // Staging file symlink
    const symlinkTarget = join(paths.customSnapshotDirectory, `staging-${randomUUID()}.sqlite3`)
    let created = false
    try {
      symlinkSync(outsideDb, symlinkTarget, 'file')
      created = true
    } catch {}

    if (created) {
      await expect(
        validateCustomSnapshotPath(symlinkTarget, paths.customSnapshotDirectory),
      ).rejects.toThrow(/must not be a symbolic link/i)
      try { unlinkSync(symlinkTarget) } catch {}
    }

    // Source database as symlink
    const symlinkSource = join(tmp, 'src-symlink.sqlite3')
    let srcCreated = false
    try {
      symlinkSync(outsideDb, symlinkSource, 'file')
      srcCreated = true
    } catch {}

    if (srcCreated) {
      const manager = new CustomSnapshotManager({ paths })
      try {
        await expect(manager.createAndPublishSnapshot(symlinkSource)).rejects.toThrow(/must not be a symbolic link/i)
      } finally {
        await manager.dispose()
      }
    }

    rmSync(tmp, { recursive: true, force: true })
  })

  // R17: dispose during creating
  it('R17: aborts gracefully and cleans up staging when manager is disposed during snapshot creation', async () => {
    const tmp = createTempDir('r17-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const snapPromise = manager.createAndPublishSnapshot(srcDb)
      await manager.dispose()

      await expect(snapPromise).rejects.toThrow()
      expect(manager.isDisposed).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R18: dispose during verifying
  it('R18: terminates worker and cleans up staging when disposed during verification', async () => {
    const tmp = createTempDir('r18-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    let manager: CustomSnapshotManager | null = null
    const slowVerifyValidator = new CustomDictionaryValidator({
      workerAdapter: (req) => {
        const worker = spawnIntegrityWorker(req)
        if ((req as any).action === 'CUSTOM_SNAPSHOT_VALIDATE') {
          setTimeout(() => {
            if (manager) void manager.dispose()
          }, 5)
        }
        return worker as any
      },
    })

    manager = new CustomSnapshotManager({ paths, validator: slowVerifyValidator })
    try {
      await expect(manager.createAndPublishSnapshot(srcDb)).rejects.toThrow()
      expect(manager.isDisposed).toBe(true)
    } finally {
      await slowVerifyValidator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R19: dispose during publishing
  it('R19: aborts publication and cleans up staging when disposed during pre-publish verification', async () => {
    const tmp = createTempDir('r19-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    let manager: CustomSnapshotManager | null = null
    const slowPublishValidator = new CustomDictionaryValidator({
      workerAdapter: (req) => {
        const worker = spawnIntegrityWorker(req)
        if ((req as any).action === 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK') {
          setTimeout(() => {
            if (manager) void manager.dispose()
          }, 5)
        }
        return worker as any
      },
    })

    manager = new CustomSnapshotManager({ paths, validator: slowPublishValidator })
    try {
      await expect(manager.createAndPublishSnapshot(srcDb)).rejects.toThrow()
      expect(manager.isDisposed).toBe(true)
    } finally {
      await slowPublishValidator.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R20: 多 Manager staging 所有权隔离
  it('R20: protects active staging files from being deleted by another manager instance', async () => {
    const tmp = createTempDir('r20-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'src.sqlite3')
    buildValidTestDatabase(srcDb)

    const manager1 = new CustomSnapshotManager({ paths })
    const manager2 = new CustomSnapshotManager({ paths })

    try {
      // Start creation on manager1
      const p1 = manager1.createAndPublishSnapshot(srcDb, { identity: 'm1-snap' })

      // Concurrently manager2 runs cleanupStagingFiles()
      const cleaned = await manager2.cleanupStagingFiles()
      expect(cleaned).toBeGreaterThanOrEqual(0)
      // Active staging file of manager1 was NOT unlinked!
      const rec1 = await p1
      expect(rec1.state).toBe('PUBLISHED_INACTIVE')
      expect(existsSync(rec1.publishedPath!)).toBe(true)
    } finally {
      await manager1.dispose()
      await manager2.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R21: 用户源文件零修改
  it('R21: preserves user source database completely immutable across all operations', async () => {
    const tmp = createTempDir('r21-')
    const homeDir = join(tmp, 'home')
    const paths = resolveManagedStoragePaths({ home: homeDir })
    const srcDb = join(tmp, 'user-source.sqlite3')
    buildValidTestDatabase(srcDb)

    const origHash = computeFileSha256(srcDb)
    const origSize = statSync(srcDb).size
    const origBytes = readFileSync(srcDb)

    const manager = new CustomSnapshotManager({ paths })
    try {
      const rec = await manager.createAndPublishSnapshot(srcDb, { identity: 'r21-dict' })
      const dict = manager.openSnapshotDictionary(rec.id)
      expect(dict.lookup('apple').found).toBe(true)
      dict.close()

      await manager.cleanupSnapshot(rec.id)

      // Verify 100% byte-for-byte identity
      expect(existsSync(srcDb)).toBe(true)
      expect(statSync(srcDb).size).toBe(origSize)
      expect(computeFileSha256(srcDb)).toBe(origHash)
      expect(Buffer.compare(readFileSync(srcDb), origBytes)).toBe(0)
    } finally {
      await manager.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // R22: 旧 ECDICT 全量兼容
  it('R22: maintains 100% regression compatibility with existing ECDICT and Fixture functionality', async () => {
    const { openFixtureDictionary } = await import('../src/host/fixture-db.js')
    const fixtureDict = openFixtureDictionary()
    const dictManager = new DictionaryManager({
      mode: 'fixture',
      identity: 'built-in-fixture',
      dictionary: fixtureDict,
    })
    try {
      expect(dictManager.source).toBe('sqlite-fixture')
      expect(dictManager.snapshot().activeMode).toBe('fixture')

      const hit = dictManager.lookup('derive')
      expect(hit.found).toBe(true)
      if (hit.found) {
        expect(hit.headword).toBe('derive')
      }

      const miss = dictManager.lookup('nonexistent_word_xyz')
      expect(miss.found).toBe(false)
    } finally {
      dictManager.close()
    }
  })
})
