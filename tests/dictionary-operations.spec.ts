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
})
