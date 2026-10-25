/**
 * BUG-002: crash between physical publication and first catalog commit.
 * Write scope: unique os.tmpdir()/dsh-bug002-<uuid> only; no fixture, DSH,
 * network, package manager, or real profiles. All databases are small synthetic
 * SQLite files; hooks only delay/fail synthetic catalog operations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import * as snapshots from '../src/host/custom-snapshot-manager.js'
import * as storage from '../src/host/managed-storage.js'

const source = { ...snapshots, ...storage }
const bundle = await import(new URL('../lib/index.js', import.meta.url).href) as typeof source

function buildDatabase(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1'), ('corpus_name', 'BUG002_TEST');
      CREATE TABLE entries (word TEXT PRIMARY KEY, phonetic TEXT, definition_en TEXT, translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER);
      CREATE TABLE forms (form TEXT PRIMARY KEY, headword TEXT NOT NULL, kind TEXT);
      CREATE TABLE examples (id INTEGER PRIMARY KEY, headword TEXT NOT NULL, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL);
      CREATE INDEX idx_forms_headword ON forms (headword);
      CREATE INDEX idx_examples_headword ON examples (headword);
      INSERT INTO entries VALUES ('go', '/go/', 'move', '去', 'v', NULL, 1), ('derive', '', '', '', '', NULL, 1), ('wave', '', '', '', '', NULL, 1), ('orphanword', '', 'recovered definition', '恢复词', 'n', NULL, 1);
      INSERT INTO forms VALUES ('orphanwords', 'orphanword', 'p');
    `)
  } finally { db.close() }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe.each([['source', source], ['published host', bundle]] as const)('BUG-002 catalog recovery (%s)', (_target, api) => {
  let root: string
  let paths: storage.ManagedStoragePaths
  let raw: string
  let original: { sha256: string; size: number }
  let managers: snapshots.CustomSnapshotManager[]

  function digest(path: string) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
  function manager() {
    const instance = new api.CustomSnapshotManager({ paths })
    managers.push(instance)
    return instance
  }
  function orphan(id = randomUUID()) {
    const path = join(paths.customSnapshotDirectory, `custom-${id}.sqlite3`)
    copyFileSync(raw, path)
    return { id, path }
  }
  async function active(id: string) {
    await api.writeActiveMetadataAtomically(paths, {
      version: 1, activeMode: 'custom', identity: 'legacy-custom', snapshotId: id,
      databaseFile: `custom-${id}.sqlite3`, source: 'custom-local', schemaVersion: 1,
      sha256: original.sha256, byteSize: original.size,
      settingsSynced: true, settingsSyncState: 'synced',
    })
  }
  async function query(instance: snapshots.CustomSnapshotManager, id: string) {
    const dictionary = await instance.validatePublishedSnapshotForActivation(id)
    try {
      expect(dictionary.lookup('orphanword')).toMatchObject({ found: true, headword: 'orphanword' })
      expect(dictionary.lookup('orphanwords')).toMatchObject({ found: true, headword: 'orphanword' })
    } finally { dictionary.close() }
  }

  beforeEach(async () => {
    root = join(tmpdir(), `dsh-bug002-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
    paths = api.resolveManagedStoragePaths({ home: root })
    await api.ensureManagedStorageDirectories(paths)
    raw = join(root, 'source.sqlite3')
    buildDatabase(raw)
    original = { sha256: digest(raw), size: statSync(raw).size }
    managers = []
  })

  afterEach(async () => {
    api._setStorageFsHooksForTesting(null)
    api._setCustomSnapshotHooksForTesting(null)
    await Promise.all(managers.map((instance) => instance.dispose()))
    expect(digest(raw)).toBe(original.sha256)
    expect(statSync(raw).size).toBe(original.size)
    rmSync(root, { recursive: true, force: true })
  })

  it.each(['missing', 'empty'] as const)('recovers %s catalog after first publication, queries, and restarts without duplicates', async (state) => {
    const published = orphan()
    if (state === 'empty') await api.writeCustomSnapshotCatalogAtomically(paths, { version: 1, snapshots: [] })
    const fresh = manager()
    await fresh.loadCatalog()
    expect(fresh.listCustomSnapshots()).toHaveLength(1)
    expect(fresh.getSnapshot(published.id)?.sourcePath).toBe('')
    const catalog = await api.readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.map((entry) => entry.snapshotId)).toEqual([published.id])
    expect(readFileSync(paths.customSnapshotCatalogPath, 'utf8')).not.toContain(raw)
    await query(fresh, published.id)
    const restarted = manager()
    await restarted.loadCatalog()
    expect(restarted.listCustomSnapshots()).toHaveLength(1)
    expect(await restarted.reconcileUnregisteredSnapshots()).toEqual([])
    await query(restarted, published.id)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toHaveLength(1)
  })

  it('preserves corrupt catalog bytes and diagnostic even on direct reconciliation', async () => {
    const published = orphan()
    const bytes = Buffer.from('{ corrupt catalog\n\u0000')
    writeFileSync(paths.customSnapshotCatalogPath, bytes)
    const fresh = manager()
    await fresh.loadCatalog()
    expect(fresh.catalogError).toMatch(/corrupt/i)
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(readFileSync(paths.customSnapshotCatalogPath)).toEqual(bytes)
    expect(digest(published.path)).toBe(original.sha256)
  })

  it('preserves a catalog corrupted between orphan validation and registration', async () => {
    const published = orphan()
    const bytes = '{ damaged during recovery'
    const fresh = manager()
    api._setCustomSnapshotHooksForTesting({ onBeforePersistCatalog: async () => {
      writeFileSync(paths.customSnapshotCatalogPath, bytes)
    } })
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(fresh.catalogError).toMatch(/CATALOG_PERSISTENCE_FAILED.*corrupt/)
    expect(readFileSync(paths.customSnapshotCatalogPath, 'utf8')).toBe(bytes)
    expect(digest(published.path)).toBe(original.sha256)
  })

  it('migrates active metadata first, preserving its identity while recovering another orphan', async () => {
    const legacy = orphan()
    const other = orphan()
    await active(legacy.id)
    const fresh = manager()
    await fresh.loadCatalog()
    const catalog = await api.readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.map((entry) => entry.snapshotId).sort()).toEqual([legacy.id, other.id].sort())
    expect(fresh.getSnapshot(legacy.id)?.identity).toBe('legacy-custom')
    await query(fresh, legacy.id)
    await query(fresh, other.id)
  })

  it('scans after malformed active metadata without changing active bytes', async () => {
    const published = orphan()
    const bytes = '{ invalid active'
    writeFileSync(paths.activeMetadataPath, bytes)
    const fresh = manager()
    await fresh.loadCatalog()
    expect(fresh.getCustomSnapshot(published.id)?.isValid).toBe(true)
    expect(readFileSync(paths.activeMetadataPath, 'utf8')).toBe(bytes)
  })

  it('recovers multiple canonical UUID orphans while preserving malformed names, staging, corrupt files and directories', async () => {
    await api.writeCustomSnapshotCatalogAtomically(paths, { version: 1, snapshots: [] })
    const a = orphan()
    const b = orphan()
    const ignored = [
      'custom-not-a-uuid.sqlite3',
      `custom-${'a'.repeat(36)}.sqlite3`,
      `custom-${'----'.repeat(9)}.sqlite3`,
      `staging-${randomUUID()}.sqlite3`,
      'unknown.sqlite3',
    ]
    for (const name of ignored) copyFileSync(raw, join(paths.customSnapshotDirectory, name))
    const corrupt = join(paths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
    writeFileSync(corrupt, 'not sqlite')
    const empty = join(paths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
    writeFileSync(empty, '')
    const directory = join(paths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
    mkdirSync(directory)
    const fresh = manager()
    await fresh.loadCatalog()
    expect(fresh.listCustomSnapshots().map((entry) => entry.snapshotId).sort()).toEqual([a.id, b.id].sort())
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toHaveLength(2)
    for (const name of ignored) expect(digest(join(paths.customSnapshotDirectory, name))).toBe(original.sha256)
    expect(readFileSync(corrupt, 'utf8')).toBe('not sqlite')
    expect(statSync(empty).size).toBe(0)
    expect(lstatSync(directory).isDirectory()).toBe(true)
  })

  it('rejects a canonical UUID directory junction without registering or deleting its target', async () => {
    // Directory junctions need no symlink privilege on Windows. The existing
    // validator rejects them and any ancestor junction before opening SQLite.
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const id = randomUUID()
    const link = join(paths.customSnapshotDirectory, `custom-${id}.sqlite3`)
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const fresh = manager()
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(paths.customSnapshotCatalogPath)).toBe(false)
  })

  it('rejects a canonical UUID file symlink without registering or changing its source', async () => {
    const publishedPath = join(paths.customSnapshotDirectory, `custom-${randomUUID()}.sqlite3`)
    symlinkSync(raw, publishedPath, 'file')
    const fresh = manager()
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(lstatSync(publishedPath).isSymbolicLink()).toBe(true)
    expect(existsSync(paths.customSnapshotCatalogPath)).toBe(false)
  })

  it('rejects a snapshot directory junction before reading a valid target database', async () => {
    const outside = join(root, 'outside-snapshots')
    mkdirSync(outside)
    const id = randomUUID()
    const target = join(outside, `custom-${id}.sqlite3`)
    copyFileSync(raw, target)
    const link = join(root, 'linked-snapshots')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedPaths = { ...paths, customSnapshotDirectory: link, customSnapshotCatalogPath: join(link, 'index.json') }
    const fresh = new api.CustomSnapshotManager({ paths: linkedPaths })
    managers.push(fresh)
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(digest(target)).toBe(original.sha256)
    expect(existsSync(linkedPaths.customSnapshotCatalogPath)).toBe(false)
  })

  it.each(['write', 'rename'] as const)('failed catalog %s keeps published file invisible, diagnoses failure, then retries', async (failure) => {
    const published = orphan()
    const fresh = manager()
    api._setStorageFsHooksForTesting(failure === 'write' ? {
      writeFile: async (path, data, options) => {
        if (path.includes('index.json.tmp-')) throw new Error('BUG002_EACCES_WRITE')
        await writeFile(path, data, options)
      },
    } : {
      rename: async (from, to) => {
        if (to === paths.customSnapshotCatalogPath) throw new Error('BUG002_EACCES_RENAME')
        await rename(from, to)
      },
    })
    // Use loadCatalog first so this includes the missing-catalog startup path.
    await fresh.loadCatalog()
    expect(fresh.catalogError).toMatch(/CATALOG_PERSISTENCE_FAILED.*BUG002_EACCES/)
    expect(fresh.listCustomSnapshots()).toEqual([])
    expect(fresh.getSnapshot(published.id)).toBeUndefined()
    expect(await api.readCustomSnapshotCatalog(paths)).toBeNull()
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([])
    expect(digest(published.path)).toBe(original.sha256)
    expect(readdirSync(paths.customSnapshotDirectory).filter((name) => name.includes('.tmp-'))).toEqual([])
    api._setStorageFsHooksForTesting(null)
    expect(await fresh.reconcileUnregisteredSnapshots()).toEqual([published.id])
    expect(fresh.catalogError).toBeNull()
    expect(fresh.getCustomSnapshot(published.id)?.isValid).toBe(true)
    await query(fresh, published.id)
  })

  it('keeps recovery invisible until the atomic catalog rename completes', async () => {
    const published = orphan()
    const fresh = manager()
    const entered = deferred()
    const release = deferred()
    api._setStorageFsHooksForTesting({ rename: async (from, to) => {
      if (to === paths.customSnapshotCatalogPath) {
        entered.resolve()
        await release.promise
      }
      await rename(from, to)
    } })
    const pending = fresh.reconcileUnregisteredSnapshots()
    try {
      await entered.promise
      expect(fresh.listCustomSnapshots()).toEqual([])
      expect(fresh.getSnapshot(published.id)).toBeUndefined()
      expect(await api.readCustomSnapshotCatalog(paths)).toBeNull()
    } finally { release.resolve(); await pending }
    expect(fresh.getCustomSnapshot(published.id)?.isValid).toBe(true)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toHaveLength(1)
  })

  it('merges active migration with a concurrent same-manager publish instead of overwriting its catalog', async () => {
    const legacy = orphan()
    await active(legacy.id)
    const fresh = manager()
    const entered = deferred()
    const release = deferred()
    let capturedMissing = false
    api._setStorageFsHooksForTesting({ readFile: async (path, encoding) => {
      try { return await readFile(path, encoding) } catch (error) {
        if (path === paths.customSnapshotCatalogPath && !capturedMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          capturedMissing = true
          entered.resolve()
          await release.promise
        }
        throw error
      }
    } })
    const pending = fresh.loadCatalog()
    let concurrent!: snapshots.CustomSnapshotRecord
    try {
      await entered.promise
      concurrent = await fresh.createAndPublishSnapshot(raw, { identity: 'concurrent-custom' })
    } finally { release.resolve(); await pending }
    const catalog = await api.readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots).toHaveLength(2)
    expect(catalog?.snapshots.find((entry) => entry.snapshotId === concurrent.id)?.identity).toBe('concurrent-custom')
    expect(catalog?.snapshots.find((entry) => entry.snapshotId === legacy.id)?.identity).toBe('legacy-custom')
    await query(fresh, concurrent.id)
  })

  it('merges scan recovery with a concurrent same-manager publish', async () => {
    const published = orphan()
    const fresh = manager()
    const entered = deferred()
    const release = deferred()
    api._setCustomSnapshotHooksForTesting({ onBeforePersistCatalog: async (record) => {
      if (record.id === published.id) { entered.resolve(); await release.promise }
    } })
    const pending = fresh.reconcileUnregisteredSnapshots()
    let concurrent!: snapshots.CustomSnapshotRecord
    try {
      await entered.promise
      concurrent = await fresh.createAndPublishSnapshot(raw, { identity: 'concurrent-scan' })
    } finally { release.resolve(); await pending }
    const catalog = await api.readCustomSnapshotCatalog(paths)
    expect(catalog?.snapshots.map((entry) => entry.snapshotId).sort()).toEqual([published.id, concurrent.id].sort())
    expect(catalog?.snapshots.find((entry) => entry.snapshotId === concurrent.id)?.identity).toBe('concurrent-scan')
  })

  it('preserves a same-snapshot registration committed while the orphan worker was validating', async () => {
    const published = orphan()
    const fresh = manager()
    const entered = deferred()
    const release = deferred()
    let paused = false
    api._setCustomSnapshotHooksForTesting({ onBeforePersistCatalog: async (record) => {
      if (record.id === published.id && !paused) {
        paused = true
        entered.resolve()
        await release.promise
      }
    } })
    const pending = fresh.reconcileUnregisteredSnapshots()
    try {
      await entered.promise
      await fresh.adoptPublishedSnapshot(published.id, {
        identity: 'concurrent-same-snapshot', publishedPath: published.path,
        sha256: original.sha256, byteSize: original.size, schemaVersion: 1,
      })
    } finally { release.resolve(); await pending }
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots[0]?.identity).toBe('concurrent-same-snapshot')
    expect(fresh.getCustomSnapshot(published.id)?.identity).toBe('concurrent-same-snapshot')
  })

  it.each([false, true])('preserves inverse same-ID adoption queued during recovery rename (leased=%s)', async (leased) => {
    const published = orphan()
    const fresh = manager()
    const entered = deferred()
    const release = deferred()
    const adoptionAtPersist = deferred()
    let firstRename = true
    let held: ReturnType<snapshots.CustomSnapshotManager['openSnapshotDictionary']> | undefined
    api._setStorageFsHooksForTesting({ rename: async (from, to) => {
      if (to === paths.customSnapshotCatalogPath && firstRename) {
        firstRename = false
        entered.resolve()
        await release.promise
      }
      await rename(from, to)
    } })
    api._setCustomSnapshotHooksForTesting({ onBeforePersistCatalog: (record) => {
      if (record.identity === 'inverse-concurrent-adoption') adoptionAtPersist.resolve()
    } })
    const recovery = fresh.reconcileUnregisteredSnapshots()
    let adoption: Promise<snapshots.CustomSnapshotRecord> | undefined
    try {
      try {
        await entered.promise
        adoption = fresh.adoptPublishedSnapshot(published.id, {
          identity: 'inverse-concurrent-adoption', publishedPath: published.path,
          sha256: original.sha256, byteSize: original.size, schemaVersion: 1,
        })
        await adoptionAtPersist.promise
        expect(fresh.getCustomSnapshot(published.id)?.identity).toBe('inverse-concurrent-adoption')
        if (leased) held = fresh.openSnapshotDictionary(published.id)
        expect(fresh.getActiveLeases(published.id)).toBe(leased ? 1 : 0)
      } finally {
        release.resolve()
        await Promise.all([recovery, adoption])
      }
      expect((await api.readCustomSnapshotCatalog(paths))?.snapshots[0]?.identity).toBe('inverse-concurrent-adoption')
      expect(fresh.getCustomSnapshot(published.id)?.identity).toBe('inverse-concurrent-adoption')
      expect(fresh.getActiveLeases(published.id)).toBe(leased ? 1 : 0)
      if (held) expect(held.lookup('orphanword')).toMatchObject({ found: true, headword: 'orphanword' })
      await query(fresh, published.id)
      expect(fresh.getActiveLeases(published.id)).toBe(leased ? 1 : 0)
    } finally { held?.close() }
    expect(fresh.getActiveLeases(published.id)).toBe(0)
  })
})
