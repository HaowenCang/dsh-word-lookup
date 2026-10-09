/**
 * Test suite for:
 * 1. Fault state classification (integrity verification outcome vs worker termination outcome)
 * 2. WorkerSupervisor session lifecycle and listener recycling
 * 3. WorkerExitProof authenticity and tamper resistance
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  buildManagedEcdictDatabaseInternal,
  isDatabaseDirectoryQuarantined,
  recoverQuarantinedDirectory,
  _resetQuarantinesForTesting,
} from '../src/host/ecdict-importer.js'
import {
  IntegrityVerificationError,
  isTerminationUnconfirmed,
  QuarantineRecoveryError,
  verifyCandidateDatabaseWithWorker,
  workerSupervisor,
  WorkerTerminationError,
  type WorkerExitProof,
  type WorkerLike,
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

class TestMockWorker extends EventEmitter implements WorkerLike {
  public terminateCalled = false
  public terminateHandler?: () => Promise<number>

  async terminate(): Promise<number> {
    this.terminateCalled = true
    if (this.terminateHandler) {
      return this.terminateHandler()
    }
    return 0
  }
}

describe('Fault State Classification & WorkerSupervisor Lifecycle', () => {
  let scratchHome: string
  let paths: ReturnType<typeof resolveManagedStoragePaths>
  let sourceFile: string
  let descriptor: EcdictSourceDescriptor

  beforeEach(() => {
    _resetQuarantinesForTesting()
    workerSupervisor.resetForTesting()
    scratchHome = join(tmpdir(), `dsh-defect-test-${randomUUID()}`)
    paths = resolveManagedStoragePaths({ home: scratchHome })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })
    mkdirSync(paths.databaseDirectory, { recursive: true })

    const csv = createSyntheticCsv([
      ['apple', '', 'a fruit', '苹果', 'n', '', '', '', '100', '', '', '', ''],
      ['banana', '', 'a fruit', '香蕉', 'n', '', '', '', '80', '', '', '', ''],
    ])
    const synth = createSyntheticDescriptor(csv)
    descriptor = synth.descriptor
    sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
    writeFileSync(sourceFile, synth.rawBytes)
  })

  afterEach(() => {
    workerSupervisor.resetForTesting()
    _resetQuarantinesForTesting()
    try {
      rmSync(scratchHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('1. Fault State Classification & Candidate Cleanup', () => {
    it('Real Worker integration test with corrupt SQLite: integrity fails, worker exits, candidate cleaned, NO quarantine', async () => {
      // Create a corrupt SQLite database file in a valid candidate path matching CANDIDATE_DATABASE_FILENAME_PATTERN
      const corruptDbPath = join(paths.databaseDirectory, 'ecdict-v1.sqlite3.tmp-corrupt123')
      const db = new DatabaseSync(corruptDbPath)
      db.exec('CREATE TABLE entries (word TEXT PRIMARY KEY, definition TEXT);')
      db.exec("INSERT INTO entries VALUES ('hello', 'world');")
      db.close()

      // Deliberately corrupt the SQLite database bytes (overwrite internal page content)
      const bytes = readFileSync(corruptDbPath)
      const corruptBytes = Buffer.from(bytes)
      // Corrupt page header / freelist / cell pointers beyond the 100-byte SQLite header
      for (let i = 108; i < 200; i++) {
        corruptBytes[i] = 0xff
      }
      writeFileSync(corruptDbPath, corruptBytes)

      // Run verification with real worker
      let caughtErr: unknown = null
      try {
        await verifyCandidateDatabaseWithWorker(corruptDbPath, {
          expectedDirectory: paths.databaseDirectory,
        })
      } catch (err) {
        caughtErr = err
      }

      expect(caughtErr).toBeInstanceOf(IntegrityVerificationError)
      const verErr = caughtErr as IntegrityVerificationError
      // Must preserve genuine failure reason and diagnostic code
      expect(['INTEGRITY_RESULT_NOT_OK', 'INTEGRITY_CHECK_FAILED', 'WORKER_EXECUTION_ERROR', 'SQLITE_ERROR']).toContain(verErr.errorCode)
      // Worker termination is confirmed
      expect(verErr.terminationStatus).toBe('TERMINATED_CONFIRMED')
      expect(isTerminationUnconfirmed(verErr)).toBe(false)

      // Supervisor session must have been cleaned up and unregistered
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)

      // Now run full importer flow with a corrupted candidate injected via mock/verifier
      let observedCandidatePath = ''
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          workerAdapter: (req) => {
            observedCandidatePath = req.candidatePath
            // Corrupt the candidate on disk
            try {
              const fileData = readFileSync(req.candidatePath)
              const corr = Buffer.from(fileData)
              for (let i = 108; i < 200; i++) corr[i] = 0xfe
              writeFileSync(req.candidatePath, corr)
            } catch {
              // ignore
            }
            const mw = new TestMockWorker()
            queueMicrotask(() => {
              // Worker reports integrity failure
              mw.emit('message', {
                requestId: req.requestId,
                success: false,
                errorCode: 'INTEGRITY_RESULT_NOT_OK',
                message: 'PRAGMA integrity_check failed: corrupted database page',
                durationMs: 15,
              })
            })
            return mw
          },
        }),
      ).rejects.toThrow(/PRAGMA integrity_check failed/)

      // Strict post-failure assertions:
      // 1. Candidate cleanup is ALLOWED and must be executed
      expect(existsSync(observedCandidatePath)).toBe(false)
      // 2. Quarantine is NOT engaged
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      // 3. Supervisor session is unregistered
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)

      // 4. Subsequent import into the same directory must succeed without quarantine obstruction
      const cleanResult = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })
      expect(cleanResult.entryCount).toBe(2)
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    })

    it('Invalid IPC response: classified as FAILED integrity + CONFIRMED exit, candidate cleaned, no quarantine', async () => {
      let capturedPath = ''
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          workerAdapter: (req) => {
            capturedPath = req.candidatePath
            const mw = new TestMockWorker()
            queueMicrotask(() => {
              // Invalid IPC: non-matching object structure
              mw.emit('message', { garbage: 12345 })
            })
            return mw
          },
        }),
      ).rejects.toThrow(/INVALID_IPC_RESPONSE|invalid or unrecognized IPC response/)

      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      expect(existsSync(capturedPath)).toBe(false)
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)
    })

    it('Premature abnormal exit: classified as FAILED integrity + CONFIRMED exit, candidate cleaned, no quarantine', async () => {
      let capturedPath = ''
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          workerAdapter: (req) => {
            capturedPath = req.candidatePath
            const mw = new TestMockWorker()
            queueMicrotask(() => {
              // Worker exits prematurely with non-zero code before response
              mw.emit('exit', 2)
            })
            return mw
          },
        }),
      ).rejects.toThrow(/WORKER_PREMATURE_EXIT|exited prematurely/)

      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      expect(existsSync(capturedPath)).toBe(false)
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)
    })

    it('Abort: classified as FAILED integrity + CONFIRMED exit, candidate cleaned, no quarantine', async () => {
      const abortCtrl = new AbortController()
      let capturedPath = ''

      const importPromise = buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        signal: abortCtrl.signal,
        workerAdapter: (req) => {
          capturedPath = req.candidatePath
          const mw = new TestMockWorker()
          queueMicrotask(() => {
            abortCtrl.abort()
          })
          return mw
        },
      })

      await expect(importPromise).rejects.toThrow()
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      expect(existsSync(capturedPath)).toBe(false)
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)
    })

    it('Termination rejection: classified as UNCONFIRMED exit, quarantine ENGAGED, candidate PRESERVED, session KEPT', async () => {
      let capturedPath = ''
      const mw = new TestMockWorker()
      mw.terminateHandler = async () => {
        throw new Error('Host terminate rejected: OS deadlock')
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          workerAdapter: (req) => {
            capturedPath = req.candidatePath
            queueMicrotask(() => {
              mw.emit('message', {
                requestId: req.requestId,
                success: false,
                errorCode: 'INTEGRITY_RESULT_NOT_OK',
                message: 'DB failed',
                durationMs: 5,
              })
            })
            return mw
          },
        }),
      ).rejects.toThrow()

      // Strict unconfirmed requirements:
      // 1. Directory is quarantined
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
      // 2. Candidate file is preserved (not deleted)
      expect(existsSync(capturedPath)).toBe(true)
      // 3. Supervisor session is intentionally retained for quarantine protection
      expect(workerSupervisor.getActiveSessionCount()).toBe(1)
    })
  })

  describe('2. Supervisor Session Recycling & Resource Leak Prevention', () => {
    it('Multi-round imports: sessions cleanly unregistered after each round (0 leak)', async () => {
      for (let round = 1; round <= 3; round++) {
        const res = await buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        })
        expect(res.entryCount).toBe(2)
        expect(workerSupervisor.getActiveSessionCount()).toBe(0)
        expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      }
    })

    it('Consecutive verification failures with confirmed exit: 0 session leak', async () => {
      for (let round = 1; round <= 3; round++) {
        await expect(
          buildManagedEcdictDatabaseInternal(paths, {
            descriptor,
            sourcePath: sourceFile,
            verifyProbes: false,
            workerAdapter: (req) => {
              const mw = new TestMockWorker()
              queueMicrotask(() => {
                mw.emit('message', {
                  requestId: req.requestId,
                  success: false,
                  errorCode: 'INTEGRITY_RESULT_NOT_OK',
                  message: `Failure round ${round}`,
                  durationMs: 2,
                })
              })
              return mw
            },
          }),
        ).rejects.toThrow()

        expect(workerSupervisor.getActiveSessionCount()).toBe(0)
        expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
      }
    })

    it('Consecutive quarantine recoveries: session unregistered only after recovery completes', async () => {
      for (let round = 1; round <= 2; round++) {
        const mw = new TestMockWorker()
        mw.terminateHandler = async () => {
          throw new Error('OS kill error')
        }

        await expect(
          buildManagedEcdictDatabaseInternal(paths, {
            descriptor,
            sourcePath: sourceFile,
            verifyProbes: false,
            workerAdapter: (req) => {
              queueMicrotask(() => {
                mw.emit('message', {
                  requestId: req.requestId,
                  success: true,
                  integrityResult: 'ok',
                  durationMs: 2,
                })
              })
              return mw
            },
          }),
        ).rejects.toThrow(WorkerTerminationError)

        expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
        // Session must be preserved while quarantined
        expect(workerSupervisor.getActiveSessionCount()).toBe(1)

        // Worker emits authentic exit event
        mw.emit('exit', 0)

        // Recovery proceeds
        const recResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
        expect(recResult.recovered).toBe(true)
        expect(recResult.candidateCleaned).toBe(true)
        expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)

        // Session must be unregistered after recovery
        expect(workerSupervisor.getActiveSessionCount()).toBe(0)
      }
    })

    it('Idempotent unregister and cleanup: duplicate calls do not throw or corrupt state', () => {
      const mw = new TestMockWorker()
      const session = workerSupervisor.registerWorker({
        worker: mw,
        candidatePath: join(paths.databaseDirectory, 'candidate.db'),
      })
      const workerId = session.workerId
      expect(workerSupervisor.getActiveSessionCount()).toBe(1)

      // Multiple cleanup calls
      session.cleanupListeners?.()
      session.cleanupListeners?.()

      // Multiple unregister calls
      workerSupervisor.unregisterWorker(workerId)
      workerSupervisor.unregisterWorker(workerId)
      expect(workerSupervisor.getActiveSessionCount()).toBe(0)
    })

    it('Late error safety: emitting error after listener cleanup does not crash process', () => {
      const mw = new TestMockWorker()
      const session = workerSupervisor.registerWorker({
        worker: mw,
        candidatePath: join(paths.databaseDirectory, 'candidate.db'),
      })

      // Clean up listeners
      session.cleanupListeners?.()

      // Emitting error should be absorbed safely by the late error handler
      expect(() => {
        mw.emit('error', new Error('Late detached error'))
      }).not.toThrow()
    })
  })

  describe('3. WorkerExitProof Authenticity & Tamper Resistance', () => {
    it('Refuses arbitrarily constructed exitProof in recoverQuarantinedDirectory', async () => {
      const mw = new TestMockWorker()
      mw.terminateHandler = async () => {
        throw new Error('OS kill error')
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
          workerAdapter: (req) => {
            queueMicrotask(() => {
              mw.emit('message', {
                requestId: req.requestId,
                success: true,
                integrityResult: 'ok',
                durationMs: 2,
              })
            })
            return mw
          },
        }),
      ).rejects.toThrow(WorkerTerminationError)

      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

      // Try passing a forged plain object exitProof
      const forgedProof: WorkerExitProof = {
        workerId: 'random-forged-worker-id',
        exitCode: 0,
        confirmedAt: Date.now(),
        proofSource: 'exit_event',
      }

      await expect(
        recoverQuarantinedDirectory(paths.databaseDirectory, { exitProof: forgedProof }),
      ).rejects.toThrow(QuarantineRecoveryError)

      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    })

    it('recordTerminationConfirmed refuses untracked workerId', () => {
      expect(() => {
        workerSupervisor.recordTerminationConfirmed('untracked-worker-id', 0)
      }).toThrow(/Cannot record termination confirmation/)
    })

    it('Public WorkerSupervisorSession.status is readonly (cannot be overwritten from outside)', () => {
      const mw = new TestMockWorker()
      const session = workerSupervisor.registerWorker({
        worker: mw,
        candidatePath: join(paths.databaseDirectory, 'candidate.db'),
      })

      expect(session.status).toBe('RUNNING')
      // Try setting status (TypeScript prevents this; runtime should have no setter)
      try {
        ;(session as any).status = 'TERMINATED_CONFIRMED'
      } catch {
        // Expected if defined as getter-only
      }
      expect(session.status).toBe('RUNNING')
    })
  })
})
