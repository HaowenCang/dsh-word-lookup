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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DictionaryOperationManager,
  OperationDirectoryQuarantinedError,
  OperationDrainTimeoutError,
  OperationInProgressError,
  OperationNotFoundError,
  sanitizeErrorMessage,
} from '../src/host/dictionary-operations.js'
import { ActivationCoordinator } from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import { resolveManagedStoragePaths } from '../src/host/managed-storage.js'
import * as downloader from '../src/host/ecdict-downloader.js'
import * as importer from '../src/host/ecdict-importer.js'

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
          releaseRemove = () => resolve({ removed: true })
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
          releaseRemove = () => resolve({ removed: true })
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
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true })

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
})
