/**
 * Test suite for DictionaryOperationManager (Phase 7A.6).
 *
 * Verifies:
 * - Singleton task orchestration and mutex concurrency gating.
 * - Monotonic FSM state transitions and progress throttling (<= 10 Hz).
 * - Observer error isolation.
 * - Safe cancellation dispatch with AbortSignal.
 * - History retention (current and last operation snapshots).
 * - Quarantine check refusal.
 * - Clean disposal and drain on plugin unload.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationDrainTimeoutError,
  OperationInProgressError,
  OperationNotCancellableError,
  OperationNotFoundError,
  sanitizeErrorMessage,
  _setOperationHooksForTesting,
} from '../src/host/dictionary-operations.js'
import { Config } from '../src/host/config.js'
import {
  ActivationCoordinator,
  _setActivationHooksForTesting,
} from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import {
  resolveManagedStoragePaths,
  readActiveMetadata,
  writeActiveMetadataAtomically,
  _setStorageFsHooksForTesting,
} from '../src/host/managed-storage.js'
import { workerSupervisor, type WorkerLike } from '../src/host/ecdict-integrity-verifier.js'
import { createCancelHandler, createStatusHandler } from '../src/host/dictionary-management-route.js'
import { MANAGEMENT_STATUS_PATH } from '../src/host/route.js'
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

describe('DictionaryOperationManager', () => {
  let tempHome: string
  let manager: DictionaryManager
  let coordinator: ActivationCoordinator

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-opman-test-'))
    const paths = resolveManagedStoragePaths({ home: tempHome })
    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    coordinator = new ActivationCoordinator({
      paths,
      manager,
    })

    return () => {
      try {
        manager.close()
      } catch {
        // ignore
      }
      try {
        rmSync(tempHome, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _setOperationHooksForTesting(null)
    _setActivationHooksForTesting(null)
    workerSupervisor.resetForTesting()
  })

  it('sanitizes error messages removing file paths', () => {
    expect(sanitizeErrorMessage('Error at C:\\Users\\User\\secret\\file.db')).toBe('Error at [local-path]')
    expect(sanitizeErrorMessage('Error at /home/user/data/ecdict.sqlite3')).toBe('Error at [local-path]')
    expect(sanitizeErrorMessage('')).toBe('Unknown error occurred')
  })

  it('initializes with null current and last operations', () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })
    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    expect(opMan.getCurrentOperation()).toBeNull()
    expect(opMan.getLastOperation()).toBeNull()
    expect(opMan.canInstall()).toBe(true)
    expect(opMan.canCancel()).toBe(false)
  })

  it('orchestrates successful install pipeline to completion', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    // Stub downloader and importer
    const downloadSpy = vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
      opts?.onProgress?.({
        phase: 'downloading',
        bytesProcessed: 50,
        totalBytes: 100,
      })
      return {
        path: join(tempHome, 'source.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      }
    })

    const buildSpy = vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async (_paths, opts) => {
      opts?.onProgress?.({
        phase: 'importing-entries',
        processed: 100,
        total: 100,
      })
      return {
        path: join(tempHome, 'ecdict.sqlite3'),
        databaseFile: 'ecdict.sqlite3',
        identity: 'test-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 100,
        formCount: 50,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 100,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      }
    })

    const activateSpy = vi.spyOn(coordinator, 'activateManagedDatabase').mockResolvedValue(undefined)

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    const snapshots: Array<string> = []
    opMan.subscribe((s) => {
      snapshots.push(`${s.phase}:${s.status}`)
    })

    const result = opMan.install()
    expect(result.status).toBe('running')
    expect(result.phase).toBe('queued')
    expect(opMan.canInstall()).toBe(false)
    expect(opMan.canCancel()).toBe(true)

    // Wait until settled
    let settled = false
    while (!settled) {
      const cur = opMan.getCurrentOperation()
      if (!cur) settled = true
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(downloadSpy).toHaveBeenCalled()
    expect(buildSpy).toHaveBeenCalled()
    expect(activateSpy).toHaveBeenCalled()

    const last = opMan.getLastOperation()
    expect(last).not.toBeNull()
    expect(last?.status).toBe('completed')
    expect(last?.phase).toBe('completed')
    expect(last?.progress.percent).toBe(100)
    expect(opMan.canInstall()).toBe(true)
    expect(opMan.canCancel()).toBe(false)
  })

  it('rejects concurrent install while an operation is in progress', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    let releaseDownload!: () => void
    vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(() => {
      return new Promise((resolve) => {
        releaseDownload = () => resolve({
          path: join(tempHome, 'source.csv'),
          sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
          sha256: 'a'.repeat(64),
          byteSize: 100,
          reused: false,
          redirectCount: 0,
        })
      })
    })

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    const first = opMan.install()
    expect(first.status).toBe('running')

    // Second install must throw OperationInProgressError
    expect(() => opMan.install()).toThrowError(OperationInProgressError)

    // Release first
    releaseDownload()
    await opMan.dispose()
  })

  it('supports cancellation of active operation', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    let abortedSignal = false
    vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          abortedSignal = true
          const err = new Error('Aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    const first = opMan.install()
    const cancelResult = opMan.cancel(first.operationId)
    expect(cancelResult.status).toBe('cancelling')

    // Wait for settlement
    let settled = false
    while (!settled) {
      if (!opMan.getCurrentOperation()) settled = true
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(abortedSignal).toBe(true)
    const last = opMan.getLastOperation()
    expect(last?.status).toBe('cancelled')
    expect(last?.phase).toBe('cancelled')

    // Idempotent cancel of finished op
    const secondCancel = opMan.cancel(first.operationId)
    expect(secondCancel.status).toBe('cancelled')
  })

  it('throws OperationNotFoundError when cancelling unknown operation', () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })
    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    expect(() => opMan.cancel('non-existent-op')).toThrowError(OperationNotFoundError)
  })

  it('isolates observer errors from breaking the operation pipeline', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
      path: join(tempHome, 'source.csv'),
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sha256: 'a'.repeat(64),
      byteSize: 100,
      reused: false,
      redirectCount: 0,
    })

    vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
      path: join(tempHome, 'ecdict.sqlite3'),
      databaseFile: 'ecdict.sqlite3',
      identity: 'test-id',
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourceSha256: 'a'.repeat(64),
      entryCount: 10,
      formCount: 5,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 10,
      byteSize: 40960,
      schemaVersion: 1,
      logicalSha256: 'b'.repeat(64),
      fileSha256: 'c'.repeat(64),
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    })

    vi.spyOn(coordinator, 'activateManagedDatabase').mockResolvedValue(undefined)

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    // Subscribed listener throws intentionally
    opMan.subscribe(() => {
      throw new Error('Exploding observer')
    })

    opMan.install()

    // Operation must still complete cleanly
    let settled = false
    while (!settled) {
      if (!opMan.getCurrentOperation()) settled = true
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(opMan.getLastOperation()?.status).toBe('completed')
  })

  it('handles pipeline errors, recording sanitized failure and retryability', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    vi.spyOn(downloader, 'downloadPinnedEcdict').mockRejectedValue(
      new Error('Fetch timeout to C:\\Users\\User\\source.csv'),
    )

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    opMan.install()

    let settled = false
    while (!settled) {
      if (!opMan.getCurrentOperation()) settled = true
      await new Promise((r) => setTimeout(r, 20))
    }

    const last = opMan.getLastOperation()
    expect(last?.status).toBe('failed')
    expect(last?.error?.message).toContain('[local-path]')
    expect(last?.error?.retryable).toBe(true)
  })

  it('refuses install when storage directory is quarantined', () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    vi.spyOn(importer, 'getQuarantineRecord').mockReturnValue({
      directory: paths.databaseDirectory,
      quarantinedAt: Date.now(),
      reason: 'Unconfirmed worker exit',
      candidatePath: join(paths.databaseDirectory, 'candidate.sqlite3'),
      error: new Error('Worker crash'),
    })

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    expect(opMan.canInstall()).toBe(false)
    expect(() => opMan.install()).toThrowError(OperationDirectoryQuarantinedError)
  })

  it('safely drains in-flight operation on dispose()', async () => {
    const paths = resolveManagedStoragePaths({ home: tempHome })

    let aborted = false
    vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true
          const err = new Error('Aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
    })

    opMan.install()
    expect(opMan.canCancel()).toBe(true)

    // Dispose should trigger abort and await settlement
    await opMan.dispose(1000)
    expect(aborted).toBe(true)
    expect(opMan.isDisposed).toBe(true)
    expect(opMan.canInstall()).toBe(false)
  })

  describe('Phase 7A.6R2 Fix B (continued): Cancellation Commit Points (B06-B07)', () => {
    it('B06: pre-commit cancellation aborts before activateManagedDatabase, unlinks candidate, active DB untouched', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let abortedSignal = false

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 'source.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            abortedSignal = true
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
          // Trigger cancellation while build is actively running
          queueMicrotask(() => {
            opMan.cancel(op.operationId)
          })
        })
      })

      const activateSpy = vi.spyOn(coordinator, 'activateManagedDatabase')

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const op = opMan.install()

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 20))
      }

      expect(abortedSignal).toBe(true)
      expect(activateSpy).not.toHaveBeenCalled()
      expect(opMan.getLastOperation()?.status).toBe('cancelled')
      expect(manager.snapshot().activeMode).toBe('fixture')
    })

    it('B07: post-commit cancellation preserves committed state and reports completed', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 'source.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'candidate.sqlite3'),
        databaseFile: 'candidate.sqlite3',
        identity: 'post-commit-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 10,
        formCount: 5,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 10,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })

      vi.spyOn(coordinator, 'activateManagedDatabase').mockImplementation(async () => {
        return undefined
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const op = opMan.install()

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 20))
      }

      const cancelOutcome = opMan.cancel(op.operationId)
      expect(cancelOutcome.status).toBe('cancelling')
      expect(opMan.getLastOperation()?.status).toBe('completed')
    })
  })

  describe('Phase 7A.6R2 Fix C: Install/Remove Promise Barrier Concurrency Serialization (C01-C06)', () => {
    it('C01: concurrent install while install in flight throws 409 OperationInProgressError', () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseDownload!: () => void
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(() => {
        return new Promise((resolve) => {
          releaseDownload = () => resolve({
            path: join(tempHome, 'source.csv'),
            sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: 'a'.repeat(64),
            byteSize: 100,
            reused: false,
            redirectCount: 0,
          })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const first = opMan.install()
      expect(first.status).toBe('running')
      expect(() => opMan.install()).toThrow(OperationInProgressError)

      releaseDownload()
      void opMan.dispose()
    })

    it('C02: concurrent remove while install in flight throws 409 OperationInProgressError', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseDownload!: () => void
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(() => {
        return new Promise((resolve) => {
          releaseDownload = () => resolve({
            path: join(tempHome, 'source.csv'),
            sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: 'a'.repeat(64),
            byteSize: 100,
            reused: false,
            redirectCount: 0,
          })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()
      expect(opMan.canRemove()).toBe(false)
      await expect(opMan.remove()).rejects.toThrow(OperationInProgressError)

      releaseDownload()
      await opMan.dispose()
    })

    it('C03: concurrent install while remove in flight throws 409 OperationInProgressError', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseRemove!: () => void
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(() => {
        return new Promise((resolve) => {
          releaseRemove = () => resolve({ removed: true, activeMode: 'fixture' })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const removePromise = opMan.remove()
      expect(opMan.canInstall()).toBe(false)
      expect(() => opMan.install()).toThrow(OperationInProgressError)

      releaseRemove()
      await removePromise
    })

    it('C04: concurrent remove while remove in flight throws 409 OperationInProgressError', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseRemove!: () => void
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(() => {
        return new Promise((resolve) => {
          releaseRemove = () => resolve({ removed: true, activeMode: 'fixture' })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const remove1 = opMan.remove()
      await expect(opMan.remove()).rejects.toThrow(OperationInProgressError)

      releaseRemove()
      await remove1
    })

    it('C05: sequential install -> remove -> install lifecycle executes cleanly', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 'source.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'candidate.sqlite3'),
        databaseFile: 'candidate.sqlite3',
        identity: 'seq-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 10,
        formCount: 5,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 10,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })
      vi.spyOn(coordinator, 'activateManagedDatabase').mockResolvedValue(undefined)
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true, activeMode: 'fixture' })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      // 1. Install
      opMan.install()
      while (opMan.isBusy()) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(opMan.getLastOperation()?.status).toBe('completed')

      // 2. Remove
      const rem = await opMan.remove()
      expect(rem.removed).toBe(true)

      // 3. Install again
      const secondInstall = opMan.install()
      expect(secondInstall.status).toBe('running')
      while (opMan.isBusy()) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(opMan.getLastOperation()?.status).toBe('completed')
    })

    it('C06: disposed manager immediately rejects install and remove', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      expect(() => opMan.install()).toThrow('DictionaryOperationManager is disposed')
      await expect(opMan.remove()).rejects.toThrow('DictionaryOperationManager is disposed')
    })
  })

  describe('Phase 7A.6R2 Fix D: Cordis Dispose Timeout Safety & Drain Closure (D01-D07)', () => {
    it('D01: clean dispose without running operation completes immediately with clean summary', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      const summary = opMan.getDrainSummary()
      expect(summary?.workflowSettled).toBe(true)
      expect(summary?.timedOut).toBe(false)
      expect(summary?.requestedCancel).toBe(false)
      expect(summary?.quarantined).toBe(false)
    })

    it('D02: in-flight operation aborted on dispose drains cleanly within timeout', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()
      expect(opMan.isBusy()).toBe(true)

      await opMan.dispose(1000)
      const summary = opMan.getDrainSummary()
      expect(summary?.workflowSettled).toBe(true)
      expect(summary?.requestedCancel).toBe(true)
      expect(summary?.timedOut).toBe(false)
      expect(summary?.statusUnknown).toBe(false)
    })

    it('D03: hanging operation triggers OperationDrainTimeoutError and fail-closed statusUnknown', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async () => {
        return new Promise(() => {
          // Never settles
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()

      await expect(opMan.dispose(50)).rejects.toThrow(OperationDrainTimeoutError)
      const summary = opMan.getDrainSummary()
      expect(summary?.timedOut).toBe(true)
      expect(summary?.statusUnknown).toBe(true)
      expect(summary?.workflowSettled).toBe(false)
    })

    it('D04: dispose is idempotent and multiple calls do not throw or re-abort', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()
      await expect(opMan.dispose()).resolves.toBeUndefined()
      await expect(opMan.dispose(100)).resolves.toBeUndefined()
    })

    it('D05: quarantine preservation - dispose does not bypass or clear quarantine', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(importer, 'getQuarantineRecord').mockReturnValue({
        directory: paths.databaseDirectory,
        quarantinedAt: Date.now(),
        reason: 'Unconfirmed worker termination',
        candidatePath: join(paths.databaseDirectory, 'candidate.sqlite3'),
        error: new Error('Worker hung'),
      })
      vi.spyOn(importer, 'isDatabaseDirectoryQuarantined').mockReturnValue(true)

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      const summary = opMan.getDrainSummary()
      expect(summary?.quarantined).toBe(true)
      expect(summary?.statusUnknown).toBe(true)
    })

    it('D06: unconfirmed worker exit during import preserves quarantine on dispose', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let isQuar = false
      vi.spyOn(importer, 'isDatabaseDirectoryQuarantined').mockImplementation(() => isQuar)
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            isQuar = true
            const err = new Error('Quarantine active')
            reject(err)
          })
        })
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()
      await opMan.dispose(500)

      const summary = opMan.getDrainSummary()
      expect(summary?.quarantined).toBe(true)
      expect(summary?.workerExited).toBe(false)
    })

    it('D07: disposed manager reports canInstall = false and canRemove = false', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      expect(opMan.canInstall()).toBe(true)

      await opMan.dispose()
      expect(opMan.canInstall()).toBe(false)
      expect(opMan.canRemove()).toBe(false)
    })
  })

  describe('Phase 7A.6R3 Fix B: Mutex Linearization & Startup Restoration (B-R3-01 to B-R3-06)', () => {
    it('B-R3-01: calling remove() synchronously claims mutex; concurrent install() is immediately rejected with 409', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseRemove!: () => void
      const removePromise = new Promise<{ removed: boolean; activeMode: 'fixture' }>((resolve) => {
        releaseRemove = () => resolve({ removed: true, activeMode: 'fixture' })
      })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(() => removePromise)

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      const removeExecution = opMan.remove()
      expect(opMan.isBusy()).toBe(true)

      expect(() => opMan.install()).toThrow(OperationInProgressError)

      releaseRemove()
      await removeExecution
      expect(opMan.isBusy()).toBe(false)
    })

    it('B-R3-02: calling remove() synchronously claims mutex; concurrent second remove() is immediately rejected with 409', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseRemove!: () => void
      const removePromise = new Promise<{ removed: boolean; activeMode: 'fixture' }>((resolve) => {
        releaseRemove = () => resolve({ removed: true, activeMode: 'fixture' })
      })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(() => removePromise)

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      const removeExecution = opMan.remove()
      expect(opMan.isBusy()).toBe(true)

      await expect(opMan.remove()).rejects.toThrow(OperationInProgressError)

      releaseRemove()
      await removeExecution
      expect(opMan.isBusy()).toBe(false)
    })

    it('B-R3-03: remove() waits for coordinator startup recovery while holding mutex ownership', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let releaseRecovery!: () => void
      const recoveryPromise = new Promise<void>((resolve) => {
        releaseRecovery = resolve
      })

      vi.spyOn(coordinator, 'isRecovering', 'get').mockReturnValue(true)
      vi.spyOn(coordinator, 'ensureReady').mockImplementation(() => recoveryPromise)
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true, activeMode: 'fixture' })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      const removeExecution = opMan.remove()
      expect(opMan.isBusy()).toBe(true)
      expect(() => opMan.install()).toThrow(OperationInProgressError)

      releaseRecovery()
      const outcome = await removeExecution
      expect(outcome.removed).toBe(true)
      expect(opMan.isBusy()).toBe(false)
    })

    it('B-R3-04: post-recovery pre-mutation race prevention via test hook confirms mutex is held throughout', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let hookReached = false
      let installRejectedAtHook = false

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true, activeMode: 'fixture' })

      _setOperationHooksForTesting({
        beforeRemoveDiskMutation: async () => {
          hookReached = true
          try {
            opMan.install()
          } catch (err) {
            if (err instanceof OperationInProgressError) {
              installRejectedAtHook = true
            }
          }
        },
      })

      const outcome = await opMan.remove()
      expect(hookReached).toBe(true)
      expect(installRejectedAtHook).toBe(true)
      expect(outcome.removed).toBe(true)
      expect(opMan.isBusy()).toBe(false)
    })

    it('B-R3-05: remove failure cleans up mutex in finally block, unblocking subsequent operations', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockRejectedValue(new Error('Disk failure'))

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await expect(opMan.remove()).rejects.toThrow('Disk failure')

      expect(opMan.isBusy()).toBe(false)

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'cand.sqlite3'),
        databaseFile: 'cand.sqlite3',
        identity: 'cand-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 1,
        formCount: 0,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 1,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })
      vi.spyOn(coordinator, 'activateManagedDatabase').mockResolvedValue(undefined)

      const inst = opMan.install()
      expect(inst.status).toBe('running')
    })

    it('B-R3-06: remove settlement promise lifecycle: isBusy is true during entire execution and false after', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let step = 0
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(async () => {
        step = 1
        await new Promise((r) => setTimeout(r, 20))
        step = 2
        return { removed: true, activeMode: 'fixture' }
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      expect(opMan.isBusy()).toBe(false)

      const removePromise = opMan.remove()
      expect(opMan.isBusy()).toBe(true)

      const res = await removePromise
      expect(step).toBe(2)
      expect(res.removed).toBe(true)
      expect(opMan.isBusy()).toBe(false)
    })
  })

  describe('Phase 7A.6R3 Fix C: Cordis Dispose & Running Remove Drain, Worker Exit Provenance (C-R3-01 to C-R3-08)', () => {
    it('C-R3-01: dispose() while remove() is running awaits remove() settlement promise and records operationKind="remove"', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      let removeFinished = false
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50))
        removeFinished = true
        return { removed: true, activeMode: 'fixture' }
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const removePromise = opMan.remove()

      await opMan.dispose(1000)
      expect(removeFinished).toBe(true)
      await removePromise

      const drainSummary = opMan.getDrainSummary()
      expect(drainSummary?.workflowSettled).toBe(true)
      expect(drainSummary?.operationKind).toBe('remove')
      expect(drainSummary?.timedOut).toBe(false)
      expect(opMan.isDisposed).toBe(true)
    })

    it('C-R3-02: dispose() aborts running remove context and drains within timeout', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      _setOperationHooksForTesting({
        beforeRemoveDiskMutation: async () => {
          await new Promise((r) => setTimeout(r, 40))
        },
      })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true, activeMode: 'fixture' })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const removePromise = opMan.remove()

      await opMan.dispose(1000)
      await removePromise.catch(() => null)

      expect(opMan.isDisposed).toBe(true)
      const summary = opMan.getDrainSummary()
      expect(summary?.workflowSettled).toBe(true)
      expect(summary?.operationKind).toBe('remove')
    })

    it('C-R3-03: dispose() timeout while remove() is hanging throws OperationDrainTimeoutError', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      vi.spyOn(coordinator, 'removeManagedDatabase').mockImplementation(() => new Promise(() => {
        // never resolves
      }))

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      void opMan.remove().catch(() => null)

      await expect(opMan.dispose(50)).rejects.toThrow(OperationDrainTimeoutError)
      const summary = opMan.getDrainSummary()
      expect(summary?.timedOut).toBe(true)
      expect(summary?.workflowSettled).toBe(false)
      expect(summary?.statusUnknown).toBe(true)
      expect(summary?.operationKind).toBe('remove')
    })

    it('C-R3-04: dispose() rejects new install() calls with disposed error', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      expect(() => opMan.install()).toThrow('DictionaryOperationManager is disposed')
    })

    it('C-R3-05: dispose() rejects new remove() calls with disposed error', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      await expect(opMan.remove()).rejects.toThrow('DictionaryOperationManager is disposed')
    })

    it('C-R3-06: authentic worker exit proof required: confirms exit using authentic supervisor proof', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      class AuthenticWorkerMock extends EventEmitter implements WorkerLike {
        async terminate(): Promise<number> {
          queueMicrotask(() => this.emit('exit', 0))
          return 0
        }
      }
      const mockWorker = new AuthenticWorkerMock()
      workerSupervisor.registerWorker({
        worker: mockWorker,
        candidatePath: join(paths.databaseDirectory, 'candidate.sqlite3'),
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      let signalBuildStarted!: () => void
      const buildStartedPromise = new Promise<void>((r) => {
        signalBuildStarted = r
      })

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

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()

      await buildStartedPromise
      await opMan.dispose(1000)

      const summary = opMan.getDrainSummary()
      expect(summary?.workflowSettled).toBe(true)
      expect(summary?.workerExited).toBe(true)
      expect(summary?.statusUnknown).toBe(false)
      expect(summary?.operationKind).toBe('install')
    })

    it('C-R3-07: unconfirmed worker exit proof during dispose leaves workerExited=false and statusUnknown=true', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      class HangingWorkerMock extends EventEmitter implements WorkerLike {
        async terminate(): Promise<number> {
          throw new Error('Worker cannot be killed')
        }
      }
      const mockWorker = new HangingWorkerMock()
      workerSupervisor.registerWorker({
        worker: mockWorker,
        candidatePath: join(paths.databaseDirectory, 'candidate.sqlite3'),
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 200))
        throw new Error('Aborted by test')
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()

      await opMan.dispose(300).catch(() => null)

      const summary = opMan.getDrainSummary()
      expect(summary?.workerExited).toBe(false)
      expect(summary?.statusUnknown).toBe(true)
      expect(summary?.operationKind).toBe('install')
    })

    it('C-R3-08: drain summary reports operationKind="none" when manager is disposed while idle', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      await opMan.dispose()

      const summary = opMan.getDrainSummary()
      expect(summary?.workflowSettled).toBe(true)
      expect(summary?.operationKind).toBe('none')
      expect(summary?.workerExited).toBe(false)
      expect(summary?.timedOut).toBe(false)
    })
  })

  describe('Phase 7A.6R3 Fix D: Cancellation Commit Boundaries & State Machine Alignment (D-R3-01 to D-R3-07)', () => {
    it('D-R3-01: pre-commit cancellation during download aborts operation cleanly before build', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const buildSpy = vi.spyOn(importer, 'buildManagedEcdictDatabase')

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const op = opMan.install()

      const cancelResult = opMan.cancel(op.operationId)
      expect(cancelResult.status).toBe('cancelling')

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(buildSpy).not.toHaveBeenCalled()
      expect(opMan.getLastOperation()?.status).toBe('cancelled')
      expect(opMan.getLastOperation()?.phase).toBe('cancelled')
    })

    it('D-R3-02: pre-commit cancellation during build phase aborts cleanly before activation', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const activateSpy = vi.spyOn(coordinator, 'activateManagedDatabase')

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const op = opMan.install()

      await new Promise((r) => setTimeout(r, 20))
      const cancelResult = opMan.cancel(op.operationId)
      expect(cancelResult.status).toBe('cancelling')

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(activateSpy).not.toHaveBeenCalled()
      expect(opMan.getLastOperation()?.status).toBe('cancelled')
    })

    it('D-R3-03: pre-commit cancellation during probe verification aborts before writeActiveMetadataAtomically', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      const dummyCand = join(paths.databaseDirectory, 'ecdict-cand-r3.sqlite3')
      createSyntheticManagedDb(dummyCand)
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: dummyCand,
        databaseFile: 'ecdict-cand-r3.sqlite3',
        identity: 'cand-r3',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 1,
        formCount: 0,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 1,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      _setActivationHooksForTesting({
        beforeCommitMetadata: async () => {
          opMan.cancel(opMan.getCurrentOperation()!.operationId)
        },
      })

      opMan.install()

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(opMan.getLastOperation()?.status).toBe('cancelled')
    })

    it('D-R3-04: post-commit boundary: cancel() throws OperationNotCancellableError once commit point is reached', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'cand.sqlite3'),
        databaseFile: 'cand.sqlite3',
        identity: 'cand-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 10,
        formCount: 5,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 10,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })

      let cancelError: unknown = null
      let opId = ''

      vi.spyOn(coordinator, 'activateManagedDatabase').mockImplementation(async (_buildResult, opts) => {
        opts?.onCommitBoundary?.()
        try {
          opMan.cancel(opId)
        } catch (err) {
          cancelError = err
        }
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      const op = opMan.install()
      opId = op.operationId

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      expect(cancelError).toBeInstanceOf(OperationNotCancellableError)
      expect((cancelError as OperationNotCancellableError).code).toBe('OPERATION_NOT_CANCELLABLE')
      expect(opMan.getLastOperation()?.status).toBe('completed')
    })

    it('D-R3-05: post-commit cancellation attempt preserves completed status with 100% progress', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(tempHome, 's.csv'),
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sha256: 'a'.repeat(64),
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'cand.sqlite3'),
        databaseFile: 'cand.sqlite3',
        identity: 'cand-id',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 50,
        formCount: 10,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 50,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })

      vi.spyOn(coordinator, 'activateManagedDatabase').mockImplementation(async (_res, opts) => {
        opts?.onCommitBoundary?.()
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      const last = opMan.getLastOperation()
      expect(last?.status).toBe('completed')
      expect(last?.progress.percent).toBe(100)
    })

    it('D-R3-06: route mapping: POST /api/dsh-word-lookup/dictionary/cancel returns HTTP 409 OPERATION_NOT_CANCELLABLE', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      vi.spyOn(opMan, 'cancel').mockImplementation(() => {
        throw new OperationNotCancellableError('test-op-123')
      })

      const cancelHandler = createCancelHandler(opMan)
      const req = new Request('http://localhost/api/dsh-word-lookup/dictionary/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'test-op-123' }),
      })

      const res = await cancelHandler(req)
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.ok).toBe(false)
      expect(data.error).toBe('OPERATION_NOT_CANCELLABLE')
      expect(data.details?.operationId).toBe('test-op-123')
    })

    it('D-R3-07: canCancel() returns true before commit point and false once nonCancellable', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50))
        return {
          path: join(tempHome, 's.csv'),
          sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
          sha256: 'a'.repeat(64),
          byteSize: 100,
          reused: false,
          redirectCount: 0,
        }
      })

      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue({
        path: join(tempHome, 'c.sqlite3'),
        databaseFile: 'c.sqlite3',
        identity: 'cid',
        sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
        sourceSha256: 'a'.repeat(64),
        entryCount: 1,
        formCount: 0,
        exampleCount: 0,
        ambiguousFormCount: 0,
        rejectedRowCount: 0,
        sourceRowCount: 1,
        byteSize: 40960,
        schemaVersion: 1,
        logicalSha256: 'b'.repeat(64),
        fileSha256: 'c'.repeat(64),
        yieldCount: 1,
        postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
      })

      let canCancelDuringCommit = true
      vi.spyOn(coordinator, 'activateManagedDatabase').mockImplementation(async (_buildResult, opts) => {
        opts?.onCommitBoundary?.()
        canCancelDuringCommit = opMan.canCancel()
      })

      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })
      opMan.install()

      // Before commit boundary
      expect(opMan.canCancel()).toBe(true)

      let settled = false
      while (!settled) {
        if (!opMan.getCurrentOperation()) settled = true
        await new Promise((r) => setTimeout(r, 10))
      }

      // During commit boundary, canCancel() must be false
      expect(canCancelDuringCommit).toBe(false)
      // Once finished, canCancel() must be false
      expect(opMan.canCancel()).toBe(false)
    })
  })

  describe('Phase 7A.6R4 Fix F1: Failure Settlement & Commit Boundary Classification (F1-01 to F1-08)', () => {
    let f1Home: string
    let f1Paths: ReturnType<typeof resolveManagedStoragePaths>
    let f1Manager: DictionaryManager
    let f1Coordinator: ActivationCoordinator

    function createF1SyntheticCandidate(identity = 'f1-test-id'): importer.ManagedEcdictBuildResult {
      const dbFile = `ecdict-${identity}.sqlite3`
      const fullDbPath = join(f1Paths.databaseDirectory, dbFile)
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
      f1Home = mkdtempSync(join(tmpdir(), 'dsh-f1-test-'))
      f1Paths = resolveManagedStoragePaths({ home: f1Home })
      mkdirSync(f1Paths.databaseDirectory, { recursive: true })
      mkdirSync(f1Paths.sourceCacheDirectory, { recursive: true })

      f1Manager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })

      f1Coordinator = new ActivationCoordinator({
        paths: f1Paths,
        manager: f1Manager,
      })

      vi.spyOn(downloader, 'downloadPinnedEcdict').mockResolvedValue({
        path: join(f1Home, 'source.csv'),
        sourceCommit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        byteSize: 100,
        reused: false,
        redirectCount: 0,
      })
    })

    afterEach(() => {
      _setStorageFsHooksForTesting(null)
      _setActivationHooksForTesting(null)
      _setOperationHooksForTesting(null)
      try {
        f1Manager.close()
      } catch {
        // ignore
      }
      try {
        rmSync(f1Home, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('F1-01: active.json 写入前取消，任务终态为 cancelled', async () => {
      const candidate = createF1SyntheticCandidate('f1-01')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(candidate)

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })

      let cancelOutcome: ReturnType<typeof opMan.cancel> | null = null
      _setActivationHooksForTesting({
        beforeCommitMetadata: async () => {
          const current = opMan.getCurrentOperation()
          if (current) {
            cancelOutcome = opMan.cancel(current.operationId)
          }
        },
      })

      const op = opMan.install()
      await opMan.whenSettled()

      expect(cancelOutcome).not.toBeNull()
      expect(cancelOutcome!.status).toBe('cancelling')

      const last = opMan.getLastOperation()
      expect(last?.status).toBe('cancelled')
      expect(last?.phase).toBe('cancelled')
      expect(last?.operationId).toBe(op.operationId)
      expect(existsSync(f1Paths.activeMetadataPath)).toBe(false)
      expect(f1Coordinator.getStatusSummary().activeMode).toBe('fixture')
    })

    it('F1-02: 已进入 onCommitBoundary，但 active.json 写入失败，任务终态必须为 failed，而非 completed', async () => {
      const candidate = createF1SyntheticCandidate('f1-02')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(candidate)

      _setStorageFsHooksForTesting({
        writeFile: async (filePath) => {
          if (filePath.includes('active.json')) {
            throw new Error('EACCES: permission denied writing active metadata')
          }
        },
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      const op = opMan.install()
      await opMan.whenSettled()

      const last = opMan.getLastOperation()
      expect(last?.operationId).toBe(op.operationId)
      expect(last?.status).toBe('failed')
      expect(last?.phase).toBe('failed')
      expect(last?.progress.percent).toBeUndefined()
      expect(last?.error?.message).toContain('Failed to commit active metadata')
      expect(f1Coordinator.getStatusSummary().installed).toBe(false)
      expect(f1Coordinator.getStatusSummary().activeMode).toBe('fixture')
    })

    it('F1-03: active.json 写入成功，但 DictionaryManager.activate 抛错，旧元数据补偿成功，任务终态为 failed', async () => {
      // 1. Establish initial active metadata with initial database
      const initialCandidate = createF1SyntheticCandidate('initial-id')
      await writeActiveMetadataAtomically(f1Paths, {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'initial-id',
        databaseFile: initialCandidate.databaseFile,
        source: {
          name: 'ECDICT',
          commit: PINNED_COMMIT,
          sha256: PINNED_SHA256,
          schemaVersion: 1,
        },
        lastActivatedAt: new Date().toISOString(),
        settingsSynced: false,
        settingsSyncState: 'pending',
        settingsSyncError: null,
      })

      const newCandidate = createF1SyntheticCandidate('f1-03')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(newCandidate)

      // Spy on manager.activate to throw during atomic switch
      vi.spyOn(f1Manager, 'activate').mockImplementation(() => {
        throw new Error('Simulated memory fault during manager.activate')
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      const op = opMan.install()
      await opMan.whenSettled()

      const last = opMan.getLastOperation()
      expect(last?.operationId).toBe(op.operationId)
      expect(last?.status).toBe('failed')
      expect(last?.phase).toBe('failed')
      expect(last?.progress.percent).toBeUndefined()
      expect(last?.error?.message).toContain('Simulated memory fault')

      // Rollback compensation verified: initial metadata restored cleanly
      const currentMeta = await readActiveMetadata(f1Paths)
      expect(currentMeta?.identity).toBe('initial-id')
      expect(f1Coordinator.getStatusSummary().lastRollbackError).toBeNull()
    })

    it('F1-04: 上述情况中旧元数据补偿也失败，抛出 ActivationRollbackError，任务终态为 failed，保留两个错误原因', async () => {
      // 1. Establish initial active metadata
      const initialCandidate = createF1SyntheticCandidate('initial-id-2')
      await writeActiveMetadataAtomically(f1Paths, {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'initial-id-2',
        databaseFile: initialCandidate.databaseFile,
        source: {
          name: 'ECDICT',
          commit: PINNED_COMMIT,
          sha256: PINNED_SHA256,
          schemaVersion: 1,
        },
        lastActivatedAt: new Date().toISOString(),
        settingsSynced: false,
        settingsSyncState: 'pending',
        settingsSyncError: null,
      })

      const newCandidate = createF1SyntheticCandidate('f1-04')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(newCandidate)

      vi.spyOn(f1Manager, 'activate').mockImplementation(() => {
        // When activate throws, also inject disk fault for rollback write
        _setStorageFsHooksForTesting({
          writeFile: async () => {
            throw new Error('EIO: secondary disk failure during rollback')
          },
        })
        throw new Error('Primary manager activation failure')
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      const op = opMan.install()
      await opMan.whenSettled()

      const last = opMan.getLastOperation()
      expect(last?.operationId).toBe(op.operationId)
      expect(last?.status).toBe('failed')
      expect(last?.phase).toBe('failed')
      expect(last?.error?.code).toBe('ACTIVATION_ROLLBACK_FAILED')
      expect(last?.error?.message).toContain('Primary manager activation failure')
      expect(last?.error?.message).toContain('secondary disk failure during rollback')

      const summary = f1Coordinator.getStatusSummary()
      expect(summary.lastRollbackError).toContain('Rollback failed')
    })

    it('F1-05: 正常提交成功，随后调用取消，不能破坏已提交状态', async () => {
      const candidate = createF1SyntheticCandidate('f1-05')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(candidate)

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      const op = opMan.install()
      await opMan.whenSettled()

      expect(opMan.getLastOperation()?.status).toBe('completed')
      expect(f1Coordinator.getStatusSummary().activeMode).toBe('managed-ecdict')
      expect(f1Coordinator.getStatusSummary().installed).toBe(true)

      // Attempt cancel after completion
      const cancelRes = opMan.cancel(op.operationId)
      expect(cancelRes.status).toBe('cancelling')
      expect(cancelRes.message).toContain('already finished with status: completed')

      // Assert committed state is fully preserved
      const last = opMan.getLastOperation()
      expect(last?.status).toBe('completed')
      expect(last?.progress.percent).toBe(100)
      expect(f1Coordinator.getStatusSummary().activeMode).toBe('managed-ecdict')
      expect(f1Coordinator.getStatusSummary().installed).toBe(true)
    })

    it('F1-06: 进入不可取消阶段但最终失败，查询 lastOperation 不得出现 progress.percent=100 的成功声明', async () => {
      const candidate = createF1SyntheticCandidate('f1-06')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(candidate)

      _setStorageFsHooksForTesting({
        writeFile: async (filePath) => {
          if (filePath.includes('active.json')) {
            throw new Error('ENOSPC: no space left on device')
          }
        },
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      opMan.install()
      await opMan.whenSettled()

      const last = opMan.getLastOperation()!
      expect(last.status).toBe('failed')
      expect(last.phase).toBe('failed')
      expect(last.progress.percent).toBeUndefined()
      expect(last.progress.percent).not.toBe(100)
      expect(last.progress.message).not.toContain('successfully installed')
      expect(last.progress.message).toContain('ENOSPC')
    })

    it('F1-07: 通过真实管理路由模拟提交后失败，状态 API 不得将 failed 报为 completed', async () => {
      const candidate = createF1SyntheticCandidate('f1-07')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(candidate)

      _setStorageFsHooksForTesting({
        writeFile: async (filePath) => {
          if (filePath.includes('active.json')) {
            throw new Error('EACCES: permission denied')
          }
        },
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      opMan.install()
      await opMan.whenSettled()

      const statusHandler = createStatusHandler(opMan, f1Coordinator)
      const res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.lastOperation).not.toBeNull()
      expect(body.lastOperation.status).toBe('failed')
      expect(body.lastOperation.status).not.toBe('completed')
      expect(body.installed).toBe(false)
      expect(body.activeMode).toBe('fixture')
    })

    it('F1-08: 失败后的模拟重启，确认实际恢复状态与 metadata 相符', async () => {
      // 1. First scenario: failure with rollback restoring previous metadata
      const initialCandidate = createF1SyntheticCandidate('f1-08-initial')
      await writeActiveMetadataAtomically(f1Paths, {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'f1-08-initial',
        databaseFile: initialCandidate.databaseFile,
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

      const failCandidate = createF1SyntheticCandidate('f1-08-fail')
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockResolvedValue(failCandidate)
      vi.spyOn(f1Manager, 'activate').mockImplementation(() => {
        throw new Error('Simulated activation error for reboot test')
      })

      const opMan = new DictionaryOperationManager({ paths: f1Paths, activationCoordinator: f1Coordinator })
      opMan.install()
      await opMan.whenSettled()

      expect(opMan.getLastOperation()?.status).toBe('failed')

      // 2. Simulate process reboot with fresh manager and fresh coordinator on same storage
      const rebootManager = new DictionaryManager({
        mode: 'fixture',
        identity: 'fixture',
        dictionary: openFixtureDictionary(),
      })
      try {
        const rebootCoordinator = new ActivationCoordinator({
          paths: f1Paths,
          manager: rebootManager,
          config: Config({ dictionaryMode: 'managed-ecdict' }),
        })

        await rebootCoordinator.recoverOnStartup()
        const rebootSummary = rebootCoordinator.getStatusSummary()

        // Restored metadata correctly recovered upon reboot
        expect(rebootSummary.activeMode).toBe('managed-ecdict')
        expect(rebootSummary.activeIdentity).toBe('f1-08-initial')
        expect(rebootSummary.installed).toBe(true)
        expect(rebootSummary.recoveryError).toBeNull()
      } finally {
        rebootManager.close()
      }
    })
  })

  describe('removeCustom and canRemoveCustom', () => {
    it('rejects invalid snapshotId with INVALID_ARGUMENT', async () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      await expect(opMan.removeCustom('not-a-uuid')).rejects.toThrow('Invalid snapshotId format')
    })

    it('canRemoveCustom returns false for non-UUID, active, or missing snapshot', () => {
      const paths = resolveManagedStoragePaths({ home: tempHome })
      const opMan = new DictionaryOperationManager({ paths, activationCoordinator: coordinator })

      expect(opMan.canRemoveCustom('')).toBe(false)
      expect(opMan.canRemoveCustom('not-a-uuid')).toBe(false)
      expect(opMan.canRemoveCustom('11111111-2222-3333-4444-555555555555')).toBe(false)
    })
  })
})
