/**
 * Test suite for Cordis lifecycle and host registration integration (Phase 7A.6).
 *
 * Verifies:
 * - Single ctx.effect() owns host surfaces (lookup route + 5 management routes).
 * - Startup recovery check kicks off without blocking apply().
 * - Safe drain and abortion on plugin unload disposer.
 * - Proper handle closing and route unregistration.
 * - Fault tolerance when context does not supply DSH home.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply } from '../src/index.js'
import { Config } from '../src/host/config.js'
import {
  LOOKUP_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
} from '../src/host/route.js'
import {
  DictionaryOperationManager,
  OperationDrainTimeoutError,
  _setOperationHooksForTesting,
} from '../src/host/dictionary-operations.js'
import {
  ActivationCoordinator,
  _setActivationHooksForTesting,
} from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import {
  resolveManagedStoragePaths,
  writeActiveMetadataAtomically,
} from '../src/host/managed-storage.js'
import { workerSupervisor, type WorkerLike } from '../src/host/ecdict-integrity-verifier.js'
import {
  _resetQuarantinesForTesting,
} from '../src/host/ecdict-importer.js'
import * as downloader from '../src/host/ecdict-downloader.js'
import * as importer from '../src/host/ecdict-importer.js'

const PINNED_COMMIT = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'
const PINNED_SHA256 = '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf'

function createSyntheticManagedDb(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
      headword TEXT NOT NULL,
      kind TEXT
    );
    CREATE TABLE examples (
      id INTEGER PRIMARY KEY,
      headword TEXT NOT NULL,
      english TEXT NOT NULL,
      chinese TEXT NOT NULL,
      source TEXT,
      source_id TEXT,
      score REAL
    );
    CREATE INDEX idx_forms_headword_raw ON forms (headword);
    CREATE INDEX idx_examples_headword ON examples (headword);

    INSERT INTO meta VALUES ('schema_version', '1');
    INSERT INTO meta VALUES ('corpus_name', 'ECDICT');
    INSERT INTO meta VALUES ('upstream_commit', '${PINNED_COMMIT}');
    INSERT INTO meta VALUES ('source_sha256', '${PINNED_SHA256}');
    INSERT INTO meta VALUES ('entry_count', '3');
    INSERT INTO meta VALUES ('form_count', '1');
    INSERT INTO meta VALUES ('example_count', '0');
    INSERT INTO meta VALUES ('logical_sha256', '${'b'.repeat(64)}');

    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('hello', 'həˈloʊ', 'used as a greeting', 'int. 你好', 'int', NULL, 100);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('world', 'wɜːrld', 'the earth with its countries and people', 'n. 世界', 'n', NULL, 200);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('test', 'test', 'a procedure intended to establish the quality', 'n. 测试', 'n', NULL, 300);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('go', 'ɡoʊ', 'to move or travel', 'v. 去', 'v', NULL, 10);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('derive', 'dɪˈraɪv', 'obtain something from', 'v. 源于', 'v', NULL, 20);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('wave', 'weɪv', 'move one hand to and fro', 'n. 波浪', 'n', NULL, 30);
    INSERT INTO forms (form, headword, kind) VALUES ('testing', 'test', 'p');
  `)
  db.close()
}

describe('Cordis Host Lifecycle Management Integration', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-cordis-test-'))
    mkdirSync(join(tempHome, 'storages', 'dsh-word-lookup', 'databases'), { recursive: true })
    mkdirSync(join(tempHome, 'cache', 'dsh-word-lookup', 'sources'), { recursive: true })

    return () => {
      try {
        rmSync(tempHome, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers all 6 Fetch routes inside a single ctx.effect()', async () => {
    const registeredRoutes = new Map<string, (req: Request) => Promise<Response>>()
    const disposersCalled: string[] = []
    let effectDisposer: (() => Promise<void>) | undefined

    const mockCtx = {
      profileContext: { home: tempHome },
      effect: vi.fn((fn: () => () => Promise<void>) => {
        effectDisposer = fn()
      }),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            registeredRoutes.set(spec.path, spec.fetch)
            return async () => {
              disposersCalled.push(spec.path)
            }
          }),
        },
      },
    }

    const config = Config({ dictionaryMode: 'fixture' })
    apply(mockCtx as any, config)

    expect(mockCtx.effect).toHaveBeenCalledTimes(1)
    expect(mockCtx.connection.fetch.register).toHaveBeenCalledTimes(8)

    expect(registeredRoutes.has(LOOKUP_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_STATUS_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_INSTALL_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_CANCEL_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_REMOVE_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_VERIFY_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_ACTIVATE_CUSTOM_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_SELECT_MODE_PATH)).toBe(true)

    // Verify status route returns activeMode: 'fixture'
    const statusHandler = registeredRoutes.get(MANAGEMENT_STATUS_PATH)!
    const statusRes = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json()
    expect(statusData.activeMode).toBe('fixture')
    expect(statusData.canInstall).toBe(true)

    // Execute unload disposer
    expect(effectDisposer).toBeDefined()
    await effectDisposer!()

    expect(disposersCalled).toHaveLength(8)
    expect(disposersCalled).toContain(LOOKUP_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_STATUS_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_INSTALL_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_CANCEL_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_REMOVE_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_VERIFY_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_ACTIVATE_CUSTOM_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_SELECT_MODE_PATH)
  })

  it('rolls back registered routes and closes handles if a route registration throws during startup', () => {
    let callCount = 0
    const unregistered: string[] = []

    const mockCtx = {
      profileContext: { home: tempHome },
      effect: vi.fn((fn: () => () => Promise<void>) => fn()),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string }) => {
            callCount++
            if (callCount === 4) {
              throw new Error('Route registration collision')
            }
            return async () => {
              unregistered.push(spec.path)
            }
          }),
        },
      },
    }

    const config = Config({})
    expect(() => apply(mockCtx as any, config)).toThrow('Route registration collision')

    // Prior routes must have been rolled back
    expect(unregistered.length).toBeGreaterThanOrEqual(1)
  })

  it('operates in fixture-only mode when host context does not supply DSH home', async () => {
    const registeredRoutes = new Map<string, (req: Request) => Promise<Response>>()
    let effectDisposer: (() => Promise<void>) | undefined

    const mockCtx = {
      // No profileContext or dshHomePath
      effect: vi.fn((fn: () => () => Promise<void>) => {
        effectDisposer = fn()
      }),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            registeredRoutes.set(spec.path, spec.fetch)
            return async () => {}
          }),
        },
      },
    }

    const config = Config({})
    expect(() => apply(mockCtx as any, config)).not.toThrow()

    // Routes registered
    expect(registeredRoutes.has(LOOKUP_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_STATUS_PATH)).toBe(true)

    // Status shows canInstall is false (storage unavailable)
    const statusHandler = registeredRoutes.get(MANAGEMENT_STATUS_PATH)!
    const res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    const data = await res.json()
    expect(data.canInstall).toBe(false)
    expect(data.installed).toBe(false)

    // Lookup route functions normally on fixture
    const lookupHandler = registeredRoutes.get(LOOKUP_PATH)!
    const lookupRes = await lookupHandler(
      new Request('http://localhost' + LOOKUP_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      }),
    )
    expect(lookupRes.status).toBe(200)

    await effectDisposer!()
  })

  it('D08: plugin unload disposer coordinates operation drain and throws AggregateError on multi-resource failure', async () => {
    let effectDisposer: (() => Promise<void>) | undefined

    const mockCtx = {
      profileContext: { home: tempHome },
      effect: vi.fn((fn: () => () => Promise<void>) => {
        effectDisposer = fn()
      }),
      connection: {
        fetch: {
          register: vi.fn(() => {
            return async () => {
              throw new Error('Disposer route unregister failed')
            }
          }),
        },
      },
    }

    const config = Config({})
    apply(mockCtx as any, config)

    expect(effectDisposer).toBeDefined()
    await expect(effectDisposer!()).rejects.toThrow(AggregateError)
  })

  describe('Phase 7A.6R4 Fix F2: Cordis Dispose Timeout & Safe Manager Closure (F2-01 to F2-10)', () => {
    let f2Home: string
    let f2Paths: ReturnType<typeof resolveManagedStoragePaths>

    function createMockCordisHarness(home: string, options?: { drainTimeoutMs?: number }) {
      const registeredRoutes = new Map<string, (req: Request) => Promise<Response>>()
      const disposersCalled: string[] = []
      let effectDisposer: (() => Promise<void>) | undefined
      const testInstances: {
        manager?: DictionaryManager
        coordinator?: ActivationCoordinator
        operationManager?: DictionaryOperationManager
      } = {}

      const mockCtx = {
        profileContext: { home },
        drainTimeoutMs: options?.drainTimeoutMs,
        _testInstances: testInstances,
        effect: vi.fn((fn: () => () => Promise<void>) => {
          effectDisposer = fn()
        }),
        connection: {
          fetch: {
            register: vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
              registeredRoutes.set(spec.path, spec.fetch)
              return async () => {
                disposersCalled.push(spec.path)
              }
            }),
          },
        },
      }

      return {
        mockCtx,
        registeredRoutes,
        disposersCalled,
        getDisposer: () => effectDisposer!,
        getInstances: () => testInstances,
      }
    }

    function createF2SyntheticCandidate(identity = 'f2-test-id'): importer.ManagedEcdictBuildResult {
      const dbFile = `ecdict-${identity}.sqlite3`
      const fullDbPath = join(f2Paths.databaseDirectory, dbFile)
      createSyntheticManagedDb(fullDbPath)
      return {
        path: fullDbPath,
        databaseFile: dbFile,
        identity,
        sourceCommit: PINNED_COMMIT,
        sourceSha256: PINNED_SHA256,
        entryCount: 6,
        formCount: 1,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 6,
        byteSize: statSync(fullDbPath).size,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      }
    }

    beforeEach(() => {
      f2Home = mkdtempSync(join(tmpdir(), 'dsh-f2-cordis-test-'))
      f2Paths = resolveManagedStoragePaths({ home: f2Home })
      mkdirSync(f2Paths.databaseDirectory, { recursive: true })
      mkdirSync(f2Paths.sourceCacheDirectory, { recursive: true })
    })

    afterEach(() => {
      _setOperationHooksForTesting(null)
      _setActivationHooksForTesting(null)
      _resetQuarantinesForTesting()
      try {
        rmSync(f2Home, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('F2-01: 空闲状态卸载，所有资源正常关闭', async () => {
      const harness = createMockCordisHarness(f2Home)
      apply(harness.mockCtx as any, Config({}))

      const instances = harness.getInstances()
      expect(instances.manager).toBeDefined()
      expect(instances.manager!.snapshot().lifecycle).toBe('ready')

      const statusHandler = harness.registeredRoutes.get(MANAGEMENT_STATUS_PATH)!
      const statusRes = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
      expect(statusRes.status).toBe(200)

      await harness.getDisposer()()

      expect(instances.manager!.snapshot().lifecycle).toBe('closed')
      expect(harness.disposersCalled).toHaveLength(8)
      expect(instances.operationManager!.isDisposed).toBe(true)
    })

    it('F2-02: install 在途，取消后安全结算，随后关闭 Manager', async () => {
      let cancelObserved = false
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            cancelObserved = true
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const harness = createMockCordisHarness(f2Home, { drainTimeoutMs: 1000 })
      apply(harness.mockCtx as any, Config({}))

      const installHandler = harness.registeredRoutes.get(MANAGEMENT_INSTALL_PATH)!
      const installRes = await installHandler(new Request('http://localhost' + MANAGEMENT_INSTALL_PATH, { method: 'POST' }))
      expect(installRes.status).toBe(200)

      const instances = harness.getInstances()
      expect(instances.operationManager!.isBusy()).toBe(true)

      await harness.getDisposer()()

      expect(cancelObserved).toBe(true)
      expect(instances.manager!.snapshot().lifecycle).toBe('closed')
      expect(instances.operationManager!.getLastOperation()?.status).toBe('cancelled')
      expect(instances.operationManager!.getDrainSummary()?.workflowSettled).toBe(true)
    })

    it('F2-03: install 在途，五秒等价测试时限届满但 Promise 未结算，不得提前关闭其依赖资源', async () => {
      // Mock downloader hanging indefinitely, ignoring abort signal
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(() => {
        return new Promise(() => {}) // never resolves
      })

      const harness = createMockCordisHarness(f2Home, { drainTimeoutMs: 50 })
      apply(harness.mockCtx as any, Config({}))

      const installHandler = harness.registeredRoutes.get(MANAGEMENT_INSTALL_PATH)!
      const installRes = await installHandler(new Request('http://localhost' + MANAGEMENT_INSTALL_PATH, { method: 'POST' }))
      expect(installRes.status).toBe(200)

      const instances = harness.getInstances()
      expect(instances.operationManager!.isBusy()).toBe(true)

      let thrownError: unknown = null
      try {
        await harness.getDisposer()()
      } catch (err) {
        thrownError = err
      }

      expect(thrownError).toBeInstanceOf(AggregateError)
      const agg = thrownError as AggregateError
      const drainError = agg.errors.find((e) => e instanceof OperationDrainTimeoutError)
      expect(drainError).toBeDefined()

      // CRITICAL SAFETY INVARIANT: Manager must NOT be closed while in-flight task is still active!
      expect(instances.manager!.snapshot().lifecycle).toBe('ready')
      expect(instances.operationManager!.isBusy()).toBe(true)
    })

    it('F2-04: remove 在途，正常结算，Manager 只能在结算后关闭', async () => {
      const candidate = createF2SyntheticCandidate('f2-04')
      await writeActiveMetadataAtomically(f2Paths, {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'f2-04',
        databaseFile: candidate.databaseFile,
        source: {
          name: 'ECDICT',
          commit: PINNED_COMMIT,
          sha256: PINNED_SHA256,
          schemaVersion: 1,
        },
        lastActivatedAt: new Date().toISOString(),
        settingsSynced: true,
        settingsSyncState: 'synced',
        settingsSyncError: null,
      })

      const harness = createMockCordisHarness(f2Home, { drainTimeoutMs: 1000 })
      apply(harness.mockCtx as any, Config({ dictionaryMode: 'managed-ecdict' }))

      const instances = harness.getInstances()
      await instances.coordinator!.ensureReady()
      expect(instances.coordinator!.getStatusSummary().installed).toBe(true)

      let managerLifecycleDuringRemove: string | undefined
      const origRemove = instances.coordinator!.removeManagedDatabase.bind(instances.coordinator!)
      vi.spyOn(instances.coordinator!, 'removeManagedDatabase').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 40))
        managerLifecycleDuringRemove = instances.manager?.snapshot().lifecycle
        return origRemove()
      })

      const removeHandler = harness.registeredRoutes.get(MANAGEMENT_REMOVE_PATH)!
      const removePromise = removeHandler(new Request('http://localhost' + MANAGEMENT_REMOVE_PATH, { method: 'POST' }))

      // Await remove settlement and disposer
      const [removeRes] = await Promise.all([
        removePromise,
        harness.getDisposer()(),
      ])

      expect(removeRes.status).toBe(200)
      expect(managerLifecycleDuringRemove).toBe('ready')
      expect(instances.manager!.snapshot().lifecycle).toBe('closed')
      expect(existsSync(candidate.path)).toBe(false)
    })

    it('F2-05: remove 永久阻塞，卸载超时后不得假定安全清理完成', async () => {
      const candidate = createF2SyntheticCandidate('f2-05')
      await writeActiveMetadataAtomically(f2Paths, {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'f2-05',
        databaseFile: candidate.databaseFile,
        source: {
          name: 'ECDICT',
          commit: PINNED_COMMIT,
          sha256: PINNED_SHA256,
          schemaVersion: 1,
        },
        lastActivatedAt: new Date().toISOString(),
        settingsSynced: true,
        settingsSyncState: 'synced',
        settingsSyncError: null,
      })

      const harness = createMockCordisHarness(f2Home, { drainTimeoutMs: 50 })
      apply(harness.mockCtx as any, Config({ dictionaryMode: 'managed-ecdict' }))

      const instances = harness.getInstances()
      await instances.coordinator!.ensureReady()

      vi.spyOn(instances.coordinator!, 'removeManagedDatabase').mockImplementation(() => {
        return new Promise(() => {}) // never settles
      })

      const removeHandler = harness.registeredRoutes.get(MANAGEMENT_REMOVE_PATH)!
      void removeHandler(new Request('http://localhost' + MANAGEMENT_REMOVE_PATH, { method: 'POST' }))

      let thrownError: unknown = null
      try {
        await harness.getDisposer()()
      } catch (err) {
        thrownError = err
      }

      expect(thrownError).toBeInstanceOf(AggregateError)
      const drainError = (thrownError as AggregateError).errors.find((e) => e instanceof OperationDrainTimeoutError)
      expect(drainError).toBeDefined()

      // Manager must NOT be closed because remove is still running
      expect(instances.manager!.snapshot().lifecycle).toBe('ready')
      const drainSummary = instances.operationManager!.getDrainSummary()
      expect(drainSummary?.timedOut).toBe(true)
      expect(drainSummary?.workflowSettled).toBe(false)
      expect(drainSummary?.operationKind).toBe('remove')
    })

    it('F2-06: Worker 退出无法确认，保留 quarantine 及 Candidate', async () => {
      const candidate = createF2SyntheticCandidate('f2-06')
      const paths = f2Paths

      class UnconfirmedWorkerMock extends EventEmitter implements WorkerLike {
        async terminate(): Promise<number> {
          throw new Error('Worker termination failed: process locked')
        }
      }
      const mockWorker = new UnconfirmedWorkerMock()
      workerSupervisor.registerWorker({
        worker: mockWorker,
        candidatePath: candidate.path,
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(f2Home, 'source.csv'),
        sourceCommit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      let signalBuildStarted!: () => void
      const buildStartedPromise = new Promise<void>((r) => { signalBuildStarted = r })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async () => {
        signalBuildStarted()
        await new Promise((r) => setTimeout(r, 200))
        throw new Error('Aborted by test')
      })

      const opMan = new DictionaryOperationManager({
        paths,
        activationCoordinator: new ActivationCoordinator({
          paths,
          manager: new DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: openFixtureDictionary() }),
        }),
      })

      opMan.install()
      await buildStartedPromise

      await opMan.dispose(300).catch(() => null)

      const summary = opMan.getDrainSummary()
      expect(summary).not.toBeNull()
      expect(summary!.workerExited).toBe(false)
      expect(summary!.statusUnknown).toBe(true)

      // Candidate file is preserved
      expect(existsSync(candidate.path)).toBe(true)
    })

    it('F2-07: Worker exit proof 真实成功，允许进入相应安全清理阶段', async () => {
      const candidate = createF2SyntheticCandidate('f2-07')
      const paths = f2Paths

      class AuthenticWorkerMock extends EventEmitter implements WorkerLike {
        async terminate(): Promise<number> {
          queueMicrotask(() => this.emit('exit', 0))
          return 0
        }
      }
      const mockWorker = new AuthenticWorkerMock()
      workerSupervisor.registerWorker({
        worker: mockWorker,
        candidatePath: candidate.path,
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(f2Home, 'source.csv'),
        sourceCommit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      let signalBuildStarted!: () => void
      const buildStartedPromise = new Promise<void>((r) => { signalBuildStarted = r })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async (_paths, opts) => {
        signalBuildStarted()
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', async () => {
            try {
              await mockWorker.terminate()
            } finally {
              reject(new Error('Aborted by test'))
            }
          })
        })
      })

      const opMan = new DictionaryOperationManager({
        paths,
        activationCoordinator: new ActivationCoordinator({
          paths,
          manager: new DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: openFixtureDictionary() }),
        }),
      })

      opMan.install()
      await buildStartedPromise

      await opMan.dispose(1000)

      const summary = opMan.getDrainSummary()
      expect(summary).not.toBeNull()
      expect(summary!.workerExited).toBe(true)
      expect(summary!.statusUnknown).toBe(false)
      expect(summary!.workflowSettled).toBe(true)
    })

    it('F2-08: dispose 超时后重复调用，不能把未解决的状态改写为成功', async () => {
      const opMan = new DictionaryOperationManager({
        paths: f2Paths,
        activationCoordinator: new ActivationCoordinator({
          paths: f2Paths,
          manager: new DictionaryManager({ mode: 'fixture', identity: 'fixture', dictionary: openFixtureDictionary() }),
        }),
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(() => {
        return new Promise(() => {}) // never settles
      })

      opMan.install()

      // First call times out
      await expect(opMan.dispose(50)).rejects.toThrow(OperationDrainTimeoutError)
      expect(opMan.getDrainSummary()?.timedOut).toBe(true)

      // Second call must NOT return void claiming success while task is still running!
      await expect(opMan.dispose(50)).rejects.toThrow(OperationDrainTimeoutError)
      expect(opMan.getDrainSummary()?.workflowSettled).toBe(false)
    })

    it('F2-09: 路由注销抛错，其他独立可安全清理项目仍执行，最终错误得到聚合报告', async () => {
      let callIndex = 0
      const harness = createMockCordisHarness(f2Home)

      // Overwrite connection fetch register to inject one throwing route disposer
      harness.mockCtx.connection.fetch.register = vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        harness.registeredRoutes.set(spec.path, spec.fetch)
        const idx = callIndex++
        return async () => {
          if (idx === 2) {
            throw new Error('Simulated network fault unregistering route 2')
          }
          harness.disposersCalled.push(spec.path)
        }
      })

      apply(harness.mockCtx as any, Config({}))

      const instances = harness.getInstances()
      let thrownError: unknown = null
      try {
        await harness.getDisposer()()
      } catch (err) {
        thrownError = err
      }

      expect(thrownError).toBeInstanceOf(AggregateError)
      const agg = thrownError as AggregateError
      const allErrors = agg.errors.flatMap((e) => (e instanceof AggregateError ? e.errors : [e]))
      expect(allErrors.some((e) => (e as Error).message.includes('Simulated network fault'))).toBe(true)

      // Manager and other resources must still be closed cleanly
      expect(instances.manager!.snapshot().lifecycle).toBe('closed')
      expect(instances.operationManager!.isDisposed).toBe(true)
      expect(harness.disposersCalled.length).toBeGreaterThanOrEqual(5)
    })

    it('F2-10: 超时后旧后台 Promise 最终结算，验证其不能重新进入已失效的 Host 状态，且资源最终归属明确', async () => {
      let releaseHangingBuild!: () => void
      const hangingBarrier = new Promise<void>((r) => {
        releaseHangingBuild = r
      })

      const candidate = createF2SyntheticCandidate('f2-10')
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(f2Home, 'source.csv'),
        sourceCommit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async () => {
        await hangingBarrier
        return candidate
      })

      const harness = createMockCordisHarness(f2Home, { drainTimeoutMs: 50 })
      apply(harness.mockCtx as any, Config({}))

      const installHandler = harness.registeredRoutes.get(MANAGEMENT_INSTALL_PATH)!
      await installHandler(new Request('http://localhost' + MANAGEMENT_INSTALL_PATH, { method: 'POST' }))

      const instances = harness.getInstances()
      expect(instances.operationManager!.isBusy()).toBe(true)

      // Unload plugin: times out draining
      await expect(harness.getDisposer()()).rejects.toThrow(AggregateError)

      // Invariant at timeout: coordinator is disposed, manager is kept open for in-flight task
      expect(instances.coordinator!.isDisposed).toBe(true)
      expect(instances.manager!.snapshot().lifecycle).toBe('ready')

      // Now release the hanging background task
      releaseHangingBuild()

      // Wait for operation manager to observe full settlement
      await instances.operationManager!.whenSettled()

      // Deferred manager closure must have executed!
      expect(instances.manager!.snapshot().lifecycle).toBe('closed')
      // Candidate cannot be active in coordinator
      expect(instances.coordinator!.getStatusSummary().activeMode).toBe('fixture')
      // Last operation was failed or cancelled
      expect(instances.operationManager!.getLastOperation()?.status).not.toBe('completed')
    })
  })
})
