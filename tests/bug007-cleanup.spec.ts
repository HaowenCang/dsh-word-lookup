import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as snapshots from '../src/host/custom-snapshot-manager.js'
import * as storage from '../src/host/managed-storage.js'
import { DictionaryOperationManager } from '../src/host/dictionary-operations.js'
import { ActivationCoordinator } from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import { registerDictionaryManagementRoutes } from '../src/host/dictionary-management-route.js'
import { DictionaryManagementStore } from '../src/client/settings/dictionary-management-store.js'
const source = { ...snapshots, ...storage, DictionaryOperationManager, ActivationCoordinator, DictionaryManager, openFixtureDictionary, registerDictionaryManagementRoutes }
const bundle = await import(new URL('../lib/index.js', import.meta.url).href) as typeof source
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
// A swallowed catalog write, premature DELETED state or blanket REJECTED allowance breaks these tests.
describe.each([['source', source], ['emitted Host', bundle]] as const)('BUG007 durable cleanup (%s)', (_, api) => {
  let root: string, paths: storage.ManagedStoragePaths, raw: string, hash: string, sourceSize: number
  let managers: snapshots.CustomSnapshotManager[]
  const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const manager = () => { const m = new api.CustomSnapshotManager({ paths }); managers.push(m); return m }
  async function fixture(m: snapshots.CustomSnapshotManager, id = randomUUID()) {
    const path = join(paths.customSnapshotDirectory, `custom-${id}.sqlite3`)
    copyFileSync(raw, path)
    await m.adoptPublishedSnapshot(id, { identity: 'synthetic', publishedPath: path, sha256: hash, byteSize: statSync(raw).size, schemaVersion: 1 })
    return { id, path }
  }
  beforeEach(async () => {
    root = join(tmpdir(), `bug007-${randomUUID()}`); mkdirSync(root, { recursive: true })
    paths = api.resolveManagedStoragePaths({ home: root }); await api.ensureManagedStorageDirectories(paths)
    raw = join(root, 'source.sqlite3'); copyFileSync(new URL('../fixtures/dictionary.fixture.db', import.meta.url), raw); hash = digest(raw); sourceSize = statSync(raw).size; managers = []
  })
  afterEach(async () => {
    api._setStorageFsHooksForTesting(null); api._setCustomSnapshotHooksForTesting(null)
    await Promise.all(managers.map(m => m.dispose()))
    expect(digest(raw)).toBe(hash); expect(statSync(raw).size).toBe(sourceSize)
    rmSync(root, { recursive: true, force: true })
  })
  it.each(['ENOSPC', 'EPERM'])('reports %s after unlink and retries without losing other catalog entries', async code => {
    const m = manager(), a = await fixture(m), b = await fixture(m)
    const before = (await api.readCustomSnapshotCatalog(paths))!.snapshots.find(e => e.snapshotId === b.id)
    api._setStorageFsHooksForTesting({ rename: async (from, to) => { if (to === paths.customSnapshotCatalogPath) throw Object.assign(new Error(code), { code }); await rename(from, to) } })
    await expect(m.cleanupSnapshot(a.id)).rejects.toMatchObject({ code: 'SNAPSHOT_CLEANUP_FAILED', originalCode: 'CATALOG_PERSISTENCE_FAILED' })
    expect(m.getSnapshot(a.id)).toMatchObject({ state: 'CLEANUP_PENDING', errorCode: 'CATALOG_PERSISTENCE_FAILED' })
    expect(m.getSnapshot(a.id)?.error).toMatch(/file.*(deleted|absent).*catalog.*retry/i)
    expect(existsSync(a.path)).toBe(false); expect(digest(b.path)).toBe(hash)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toHaveLength(2)
    api._setStorageFsHooksForTesting(null)
    expect(await m.cleanupSnapshot(a.id)).toBe(true); expect(await m.cleanupSnapshot(a.id)).toBe(true)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toEqual([before])
  })
  it.each(['ENOSPC', 'EPERM'])('atomic temporary catalog write %s cannot report success after unlink', async code => {
    const m = manager(), a = await fixture(m), b = await fixture(m), catalog = readFileSync(paths.customSnapshotCatalogPath)
    api._setStorageFsHooksForTesting({ writeFile: async (path, data, options) => { if (path.includes('index.json.tmp-')) throw Object.assign(new Error(code), { code }); await writeFile(path, data, options) } })
    await expect(m.cleanupSnapshot(a.id)).rejects.toMatchObject({ originalCode: 'CATALOG_PERSISTENCE_FAILED' })
    expect(existsSync(a.path)).toBe(false); expect(m.getSnapshot(a.id)?.state).toBe('CLEANUP_PENDING')
    expect(readFileSync(paths.customSnapshotCatalogPath)).toEqual(catalog); expect(digest(b.path)).toBe(hash)
    api._setStorageFsHooksForTesting(null); expect(await m.cleanupSnapshot(a.id)).toBe(true)
  })
  it('fresh manager permits explicit known missing UUID registration-only retry', async () => {
    const m = manager(), a = await fixture(m); unlinkSync(a.path)
    const fresh = manager(); await fresh.loadCatalog()
    expect(fresh.getSnapshot(a.id)).toMatchObject({ state: 'REJECTED', errorCode: 'FILE_NOT_FOUND' })
    expect(await fresh.cleanupSnapshot(a.id)).toBe(true); expect(await fresh.cleanupSnapshot(a.id)).toBe(true)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toEqual([])
  })
  it('registration-only retry derives its path from catalog UUID rather than untrusted record paths', async () => {
    const m = manager(), a = await fixture(m); unlinkSync(a.path)
    const fresh = manager(); await fresh.loadCatalog()
    Object.assign(fresh.getSnapshot(a.id)!, { sourcePath: raw, publishedPath: raw })
    expect(await fresh.cleanupSnapshot(a.id)).toBe(true); expect(digest(raw)).toBe(hash)
    expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toEqual([])
  })
  it.each(['file', 'directory', 'link', 'broken-link'])('preserves %s replacement on missing-file retry', async kind => {
    const m = manager(), a = await fixture(m); unlinkSync(a.path)
    const fresh = manager(); await fresh.loadCatalog()
    if (kind === 'file') writeFileSync(a.path, 'replacement')
    else if (kind === 'directory') mkdirSync(a.path)
    else symlinkSync(kind === 'broken-link' ? join(root, 'missing-target') : raw, a.path, 'file')
    await expect(fresh.cleanupSnapshot(a.id)).rejects.toMatchObject({ code: 'SNAPSHOT_CLEANUP_FAILED' })
    expect(lstatSync(a.path)).toBeDefined(); expect((await api.readCustomSnapshotCatalog(paths))?.snapshots).toHaveLength(1)
  })
  it('same-process retry refuses a replacement after catalog failure', async () => {
    const m = manager(), a = await fixture(m)
    api._setStorageFsHooksForTesting({ rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } })
    await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined()
    api._setStorageFsHooksForTesting(null); writeFileSync(a.path, 'replacement')
    await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(readFileSync(a.path, 'utf8')).toBe('replacement')
  })
  it('keeps CLEANUP_PENDING through catalog barrier and deduplicates concurrent callers', async () => {
    const m = manager(), a = await fixture(m), entered = deferred(), release = deferred(); let writes = 0, unlinks = 0
    api._setCustomSnapshotHooksForTesting({ onBeforeUnlinkCleanup: () => { unlinks++ } })
    api._setStorageFsHooksForTesting({ rename: async (from, to) => { if (to === paths.customSnapshotCatalogPath) { writes++; entered.resolve(); await release.promise } await rename(from, to) } })
    const first = m.cleanupSnapshot(a.id)
    expect(m.getSnapshot(a.id)?.state).toBe('CLEANUP_PENDING')
    let second: Promise<boolean> | undefined
    try { await entered.promise; second = m.cleanupSnapshot(a.id); expect(m.getSnapshot(a.id)?.state).toBe('CLEANUP_PENDING'); expect(existsSync(a.path)).toBe(false) }
    finally { release.resolve(); await Promise.all([first, second]) }
    expect(writes).toBe(1); expect(unlinks).toBe(1); expect(m.getSnapshot(a.id)?.state).toBe('DELETED')
  })
  it('fails on corrupt catalog without overwriting its bytes', async () => {
    const m = manager(), a = await fixture(m); const corrupt = '{ corrupt catalog'; writeFileSync(paths.customSnapshotCatalogPath, corrupt)
    await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined()
    expect(m.getSnapshot(a.id)?.state).toBe('CLEANUP_PENDING'); expect(readFileSync(paths.customSnapshotCatalogPath, 'utf8')).toBe(corrupt)
  })
  it('retains concurrent new entry queued behind removal persistence', async () => {
    const m = manager(), a = await fixture(m), entered = deferred(), release = deferred(); let first = true
    api._setStorageFsHooksForTesting({ rename: async (from, to) => { if (to === paths.customSnapshotCatalogPath && first) { first = false; entered.resolve(); await release.promise } await rename(from, to) } })
    const deleting = m.cleanupSnapshot(a.id); let adding: ReturnType<typeof fixture> | undefined
    try { await entered.promise; adding = fixture(m) } finally { release.resolve(); await deleting }
    const b = await adding!; expect((await api.readCustomSnapshotCatalog(paths))?.snapshots.map(e => e.snapshotId)).toEqual([b.id]); expect(digest(b.path)).toBe(hash)
  })
  it('rejects active metadata even with inactive in-memory state', async () => {
    const m = manager(), a = await fixture(m)
    await api.writeActiveMetadataAtomically(paths, { version: 1, activeMode: 'custom', snapshotId: a.id, identity: 'synthetic', databaseFile: `custom-${a.id}.sqlite3`, source: 'custom-local', schemaVersion: 1, sha256: hash, byteSize: sourceSize, settingsSynced: true, settingsSyncState: 'synced' })
    await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(digest(a.path)).toBe(hash)
  })
  it('does not open arbitrary REJECTED cleanup for a directory', async () => {
    const m = manager(), a = await fixture(m); unlinkSync(a.path); mkdirSync(a.path)
    const fresh = manager(); await fresh.loadCatalog(); expect(fresh.getSnapshot(a.id)?.errorCode).toBe('NOT_A_FILE')
    await expect(fresh.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(lstatSync(a.path).isDirectory()).toBe(true)
  })
  it('loadCatalog treats an ENOTDIR ancestor as STAT_FAILED, never known missing', async () => {
    const m = manager(), a = await fixture(m), wrongDirectory = join(root, 'not-a-directory')
    writeFileSync(wrongDirectory, 'preserved')
    const fresh = new api.CustomSnapshotManager({ paths: { ...paths, customSnapshotDirectory: wrongDirectory } }); managers.push(fresh)
    await fresh.loadCatalog()
    expect(fresh.getSnapshot(a.id)).toMatchObject({ state: 'REJECTED', errorCode: 'STAT_FAILED' })
    await expect(fresh.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(readFileSync(wrongDirectory, 'utf8')).toBe('preserved'); expect(digest(a.path)).toBe(hash)
  })
  it('synchronous cleanup hook failure leaves retryable work rather than a stale rejected promise', async () => {
    const m = manager(), a = await fixture(m)
    api._setCustomSnapshotHooksForTesting({ onBeforeValidateCleanup: () => { throw new Error('synthetic synchronous hook failure') } })
    await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(digest(a.path)).toBe(hash)
    api._setCustomSnapshotHooksForTesting(null); expect(await m.cleanupSnapshot(a.id)).toBe(true)
  })
  it.each(['ACTIVE', 'RETIRING', 'PUBLISHED_LEASED'] as const)('protects %s even with zero leases in manager and operation capability/execution', async state => {
    const m = manager(), a = await fixture(m)
    Object.assign(m.getSnapshot(a.id)!, { state, activeLeases: 0 })
    const dictionary = new api.DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: api.openFixtureDictionary() })
    const coordinator = new api.ActivationCoordinator({ paths, manager: dictionary, customSnapshotManager: m })
    const operations = new api.DictionaryOperationManager({ paths, activationCoordinator: coordinator })
    try {
      expect(operations.canRemoveCustom(a.id)).toBe(false)
      await expect(operations.removeCustom(a.id)).rejects.toBeDefined()
      await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(digest(a.path)).toBe(hash)
    } finally { await operations.dispose(); dictionary.close() }
  })
  it('protects an actual open query lease and permits removal only after close', async () => {
    const m = manager(), a = await fixture(m), dictionary = m.openSnapshotDictionary(a.id)
    try { expect(m.getActiveLeases(a.id)).toBe(1); expect(m.canCleanupSnapshot(a.id)).toBe(false); await expect(m.cleanupSnapshot(a.id)).rejects.toBeDefined(); expect(dictionary.lookup('go').found).toBe(true) }
    finally { dictionary.close() }
    expect(await m.cleanupSnapshot(a.id)).toBe(true)
  })
  it('current active ID and positive leases override otherwise inactive cleanup eligibility', async () => {
    const m = manager(), a = await fixture(m)
    expect(m.canCleanupSnapshot(a.id, a.id)).toBe(false)
    const dictionary = new api.DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: api.openFixtureDictionary() })
    const coordinator = new api.ActivationCoordinator({ paths, manager: dictionary, customSnapshotManager: m })
    const operations = new api.DictionaryOperationManager({ paths, activationCoordinator: coordinator })
    Object.defineProperty(coordinator, 'activeSnapshotId', { get: () => a.id })
    try {
      expect(operations.canRemoveCustom(a.id)).toBe(false); await expect(operations.removeCustom(a.id)).rejects.toMatchObject({ code: 'SNAPSHOT_ACTIVE' })
      Object.assign(m.getSnapshot(a.id)!, { activeLeases: 1 })
      expect(m.canCleanupSnapshot(a.id)).toBe(false); await expect(m.cleanupSnapshot(a.id)).rejects.toMatchObject({ code: 'SNAPSHOT_ACTIVE_REFERENCE' })
      expect(digest(a.path)).toBe(hash)
    } finally { Object.assign(m.getSnapshot(a.id)!, { activeLeases: 0 }); await operations.dispose(); dictionary.close() }
  })
  it('propagates catalog read denial and retries without treating it as missing', async () => {
    const m = manager(), a = await fixture(m), bytes = readFileSync(paths.customSnapshotCatalogPath)
    api._setStorageFsHooksForTesting({ readFile: async (path, encoding) => { if (path === paths.customSnapshotCatalogPath) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return readFile(path, encoding) } })
    await expect(m.cleanupSnapshot(a.id)).rejects.toMatchObject({ originalCode: 'CATALOG_PERSISTENCE_FAILED' })
    expect(m.getSnapshot(a.id)?.state).toBe('CLEANUP_PENDING'); expect(readFileSync(paths.customSnapshotCatalogPath)).toEqual(bytes)
    api._setStorageFsHooksForTesting(null); expect(await m.cleanupSnapshot(a.id)).toBe(true)
  })
  it.each(['ENOSPC', 'EPERM'])('actual operation/HTTP/transport/store reports %s failure and fresh-manager retry removes ghost row', async code => {
    const m = manager(), a = await fixture(m), other = await fixture(m)
    const dictionary = new api.DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: api.openFixtureDictionary() })
    let coordinator = new api.ActivationCoordinator({ paths, manager: dictionary, customSnapshotManager: m })
    let operations = new api.DictionaryOperationManager({ paths, activationCoordinator: coordinator })
    const store = new DictionaryManagementStore({ autoStart: false }); const responses: Array<{ status: number; body: unknown }> = []
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const bind = () => api.registerDictionaryManagementRoutes({ connection: { fetch: { register: ({ path, fetch }: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(path, fetch); return async () => { routes.delete(path) } } } } } as any, operations, coordinator)
    let unregister = bind()
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(new URL(String(input), 'http://synthetic.invalid/'), init)
      const response = await routes.get(new URL(request.url).pathname)!(request)
      responses.push({ status: response.status, body: await response.clone().json() }); return response
    })
    try {
      await store.refresh(); expect(store.getSnapshot().status?.customSnapshots).toHaveLength(2)
      api._setStorageFsHooksForTesting({ rename: async (from, to) => { if (to === paths.customSnapshotCatalogPath) throw Object.assign(new Error(code), { code }); await rename(from, to) } })
      expect(await store.removeCustom(a.id)).toBe(false)
      expect(store.getSnapshot().actionError).toMatch(/file.*(deleted|absent).*catalog.*retry/i)
      expect(responses.some(r => r.status === 500 && (r.body as { ok: boolean }).ok === false)).toBe(true)
      await store.refresh(); expect(store.getSnapshot().status?.customSnapshots?.find(s => s.snapshotId === a.id)?.status).toBe('CLEANUP_PENDING')
      expect(existsSync(a.path)).toBe(false); expect(digest(other.path)).toBe(hash)
      api._setStorageFsHooksForTesting(null)
      await unregister(); await operations.dispose()
      const fresh = manager(); await fresh.loadCatalog()
      coordinator = new api.ActivationCoordinator({ paths, manager: dictionary, customSnapshotManager: fresh }); operations = new api.DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      unregister = bind()
      expect(operations.canRemoveCustom(a.id)).toBe(true)
      await store.refresh(); expect(store.getSnapshot().status?.customSnapshots?.find(s => s.snapshotId === a.id)?.status).toBe('REJECTED')
      expect(await store.removeCustom(a.id)).toBe(true); expect(await store.removeCustom(a.id)).toBe(true)
      expect(store.getSnapshot().actionError).toBeNull(); expect(store.getSnapshot().status?.customSnapshots?.map(s => s.snapshotId)).toEqual([other.id])
      expect(JSON.stringify(responses)).not.toContain(raw)
    } finally { store.dispose(); vi.unstubAllGlobals(); await unregister(); await operations.dispose(); dictionary.close() }
  })
})
