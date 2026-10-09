/**
 * Concurrency Isolation and Quarantine Tests for ECDICT Importer.
 *
 * Implements Phase 7A.5R4.1 Defect B:
 * - terminate success -> cleanup -> guard released
 * - terminate rejection -> no unsafe cleanup
 * - termination unconfirmed -> concurrent import rejected
 * - verified termination -> safe recovery
 * - error aggregation preserved
 * - foreign files untouched
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildManagedEcdictDatabaseInternal,
  EcdictImportInProgressError,
  EcdictImportQuarantinedError,
  isDatabaseDirectoryQuarantined,
  recoverQuarantinedDirectory,
  _resetQuarantinesForTesting,
} from '../src/host/ecdict-importer.js'
import {
  captureCandidateFileIdentity,
  isTerminationUnconfirmed,
  WorkerTerminationError,
  workerSupervisor,
} from '../src/host/ecdict-integrity-verifier.js'
import { resolveManagedStoragePaths } from '../src/host/managed-storage.js'
import type { EcdictSourceDescriptor } from '../src/host/ecdict-source.js'

function createSyntheticCsv(rows: string[][]): string {
  const header = 'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\r\n'
  const body = rows.map((r) => r.join(',')).join('\r\n')
  return header + body + '\r\n'
}

function createSyntheticDescriptor(csvContent: string): { descriptor: EcdictSourceDescriptor; rawBytes: Buffer } {
  const rawBytes = Buffer.from(csvContent, 'utf8')
  const { createHash } = require('node:crypto')
  const sha256 = createHash('sha256').update(rawBytes).digest('hex').toLowerCase()
  return {
    descriptor: {
      sourceName: 'ECDICT',
      sourceRepository: 'https://github.com/skywind3000/ECDICT',
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: 'ecdict.csv',
      sourceByteSize: rawBytes.byteLength,
      sourceSha256: sha256,
      schemaVersion: 1,
      canonicalDownloadUrl:
        'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
    },
    rawBytes,
  }
}

describe('Phase 7A.5R4.1 Defect B: Termination Unconfirmed Concurrency Isolation & Quarantine', () => {
  let scratchHome: string
  let paths: ReturnType<typeof resolveManagedStoragePaths>

  beforeEach(() => {
    _resetQuarantinesForTesting()
    scratchHome = join(tmpdir(), `dsh-quarantine-test-${randomUUID()}`)
    paths = resolveManagedStoragePaths({ home: scratchHome })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })
    mkdirSync(paths.databaseDirectory, { recursive: true })
  })

  it('terminate success -> cleanup -> guard released', async () => {
    try {
      const csv = createSyntheticCsv([['hello', '', 'greeting', '你好', 'n', '', '', '', '100', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      // First run: normal import with successful integrity check and worker termination
      const result1 = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })

      expect(result1.entryCount).toBe(1)
      expect(result1.postPublicationCleanup.candidateRemoved).toBe(true)
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)

      // Guard is cleanly released: another import in same directory succeeds immediately
      const result2 = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })
      expect(result2.entryCount).toBe(1)
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('terminate rejection -> no unsafe cleanup', async () => {
    try {
      const csv = createSyntheticCsv([['apple', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      // Injected verifier fails with unconfirmed termination error
      const failingVerifier = async (_candidatePath: string) => {
        throw new WorkerTerminationError('Worker terminate syscall rejected by OS', 'TERMINATION_UNCONFIRMED')
      }

      let capturedError: unknown = null

      try {
        await buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          integrityVerifier: failingVerifier,
        })
      } catch (err: any) {
        capturedError = err
      }

      expect(capturedError).toBeInstanceOf(WorkerTerminationError)
      expect(isTerminationUnconfirmed(capturedError)).toBe(true)

      // Verify directory is quarantined
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

      // Unsafe cleanup was PREVENTED: candidate temporary file was NOT deleted
      const dirEntries = require('node:fs').readdirSync(paths.databaseDirectory)
      const candidateFiles = dirEntries.filter((f: string) => f.includes('.tmp-'))
      expect(candidateFiles.length).toBe(1)
      expect(existsSync(join(paths.databaseDirectory, candidateFiles[0]))).toBe(true)
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('termination unconfirmed -> concurrent import rejected with EcdictImportQuarantinedError', async () => {
    try {
      const csv = createSyntheticCsv([['book', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const failingVerifier = async () => {
        throw new WorkerTerminationError('Worker termination unconfirmed', 'TERMINATION_UNCONFIRMED')
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          integrityVerifier: failingVerifier,
        }),
      ).rejects.toThrow(WorkerTerminationError)

      // Subsequent concurrent import attempt in the quarantined directory MUST be rejected
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow(EcdictImportQuarantinedError)

      // Confirm EcdictImportQuarantinedError is an instance of EcdictImportInProgressError
      try {
        await buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        })
      } catch (err) {
        expect(err).toBeInstanceOf(EcdictImportInProgressError)
        expect(err).toBeInstanceOf(EcdictImportQuarantinedError)
      }
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('verified termination -> safe recovery releases quarantine without silent deadlock', async () => {
    try {
      const csv = createSyntheticCsv([['cat', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      let trackedWorkerId: string | undefined
      const failingVerifier = async (candPath: string) => {
        const mockWorker = new EventEmitter() as any
        mockWorker.terminate = async () => 1
        const session = workerSupervisor.registerWorker({
          worker: mockWorker,
          candidatePath: candPath,
        })
        trackedWorkerId = session.workerId
        throw new WorkerTerminationError('Stuck worker thread', 'TERMINATION_UNCONFIRMED', {
          workerId: session.workerId,
          candidatePath: candPath,
          candidateFileIdentity: captureCandidateFileIdentity(candPath),
        })
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          integrityVerifier: failingVerifier,
        }),
      ).rejects.toThrow(WorkerTerminationError)

      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

      // Verified termination: exit proof confirmed before safe recovery
      workerSupervisor.recordTerminationConfirmed(trackedWorkerId!, 0, 'exit_event')
      const recoveryResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
      expect(recoveryResult.recovered).toBe(true)
      expect(recoveryResult.candidateCleaned).toBe(true)
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)

      // Next import proceeds cleanly without any deadlock
      const cleanResult = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })
      expect(cleanResult.entryCount).toBe(1)
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('error aggregation preserved when both integrity check and termination fail', async () => {
    try {
      const csv = createSyntheticCsv([['dog', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const primaryCheckErr = new Error('Database disk image is malformed')
      const terminationErr = new WorkerTerminationError('Worker termination failed', 'TERMINATION_UNCONFIRMED')

      const failingVerifier = async () => {
        throw new AggregateError([primaryCheckErr, terminationErr], 'Dual failure during integrity validation')
      }

      let thrownErr: unknown = null
      try {
        await buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          integrityVerifier: failingVerifier,
        })
      } catch (err) {
        thrownErr = err
      }

      expect(thrownErr).toBeInstanceOf(AggregateError)
      expect(isTerminationUnconfirmed(thrownErr)).toBe(true)
      const agg = thrownErr as AggregateError
      expect(agg.errors.some((e: any) => e.message === 'Database disk image is malformed')).toBe(true)
      expect(agg.errors.some((e: any) => e instanceof WorkerTerminationError)).toBe(true)
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })

  it('foreign files in database directory are untouched during quarantine and recovery', async () => {
    try {
      const csv = createSyntheticCsv([['fish', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      // Create foreign sentinel files in database directory
      const foreignDb = join(paths.databaseDirectory, 'pre-existing-user.sqlite3')
      const foreignDoc = join(paths.databaseDirectory, 'important-notes.txt')
      writeFileSync(foreignDb, 'USER_DATABASE_CONTENT')
      writeFileSync(foreignDoc, 'USER_DOCUMENTATION_CONTENT')

      let trackedWorkerId: string | undefined
      const failingVerifier = async (candPath: string) => {
        const mockWorker = new EventEmitter() as any
        mockWorker.terminate = async () => 1
        const session = workerSupervisor.registerWorker({
          worker: mockWorker,
          candidatePath: candPath,
        })
        trackedWorkerId = session.workerId
        throw new WorkerTerminationError('Unconfirmed worker shutdown', 'TERMINATION_UNCONFIRMED', {
          workerId: session.workerId,
          candidatePath: candPath,
          candidateFileIdentity: captureCandidateFileIdentity(candPath),
        })
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          integrityVerifier: failingVerifier,
        }),
      ).rejects.toThrow(WorkerTerminationError)

      // Foreign files must be untouched during failed run
      expect(readFileSync(foreignDb, 'utf8')).toBe('USER_DATABASE_CONTENT')
      expect(readFileSync(foreignDoc, 'utf8')).toBe('USER_DOCUMENTATION_CONTENT')

      // Exit confirmed before recovery
      workerSupervisor.recordTerminationConfirmed(trackedWorkerId!, 0, 'exit_event')
      await recoverQuarantinedDirectory(paths.databaseDirectory)

      // Foreign files must be untouched during recovery
      expect(readFileSync(foreignDb, 'utf8')).toBe('USER_DATABASE_CONTENT')
      expect(readFileSync(foreignDoc, 'utf8')).toBe('USER_DOCUMENTATION_CONTENT')
    } finally {
      rmSync(scratchHome, { recursive: true, force: true })
    }
  })
})
