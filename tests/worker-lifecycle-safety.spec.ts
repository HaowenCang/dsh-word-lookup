/**
 * Isolated unit tests for Worker Lifecycle Safety & Race Conditions.
 *
 * Implements Phase 7A.5R4.1 Defect A and Candidate Path Boundary validations:
 * - valid message -> late error -> termination
 * - valid message -> premature abnormal exit
 * - error and exit competing
 * - abort and success message competing
 * - timeout and worker error competing
 * - worker.terminate() rejects
 * - worker.terminate() remains pending
 * - duplicate IPC messages
 * - candidate path boundary and containment checks
 */

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  isTerminationUnconfirmed,
  verifyCandidateDatabaseWithWorker,
  WorkerTerminationError,
  type IntegrityRequest,
  type WorkerLike,
} from '../src/host/ecdict-integrity-verifier.js'
import {
  validateCandidateDatabasePath,
  CANDIDATE_DATABASE_FILENAME_PATTERN,
} from '../src/host/managed-storage.js'

function createTempDir(): string {
  const dir = join(tmpdir(), `dsh-worker-lifecycle-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function createDummyCandidateDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE dummy (id INTEGER PRIMARY KEY);')
  db.close()
}

class MockWorkerAdapter extends EventEmitter implements WorkerLike {
  public terminateCallCount = 0
  public terminateHandler?: () => Promise<number>

  async terminate(): Promise<number> {
    this.terminateCallCount++
    if (this.terminateHandler) {
      return this.terminateHandler()
    }
    return 1
  }
}

describe('Phase 7A.5R4.1 Defect A: Worker Event Races & Termination Timing', () => {
  it('Scenario A1: valid message -> late error -> termination rejects without crashing process', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 12,
            })
            // Emit late error during termination phase
            mockWorker.emit('error', new Error('Late worker isolate teardown error'))
          })
          return mockWorker
        },
      })

      await expect(verifyPromise).rejects.toThrow(/Late worker isolate teardown error/)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A2: valid message -> premature abnormal exit rejects fail-closed', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 8,
            })
            // Premature abnormal exit before clean termination completes
            mockWorker.emit('exit', 2)
          })
          return mockWorker
        },
      })

      await expect(verifyPromise).rejects.toThrow(/WORKER_PREMATURE_EXIT|exit code 2/)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A3: error and exit competing resolves once with error and terminates cleanly', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        workerAdapter: () => {
          queueMicrotask(() => {
            mockWorker.emit('error', new Error('Primary isolate crash'))
            mockWorker.emit('exit', 1)
          })
          return mockWorker
        },
      })

      await expect(verifyPromise).rejects.toThrow(/Primary isolate crash/)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A4: abort and success message competing yields single settlement', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const abortCtrl = new AbortController()
      const mockWorker = new MockWorkerAdapter()

      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        signal: abortCtrl.signal,
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            abortCtrl.abort(new Error('User cancellation race'))
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 15,
            })
          })
          return mockWorker
        },
      })

      // Must settle exactly once: either aborted or resolved, without unhandled rejection
      try {
        const res = await verifyPromise
        expect(res.success).toBe(true)
      } catch (err: any) {
        expect(err.message).toMatch(/User cancellation race|aborted/)
      }
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A5: timeout and worker error competing settles once fail-closed', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        timeoutMs: 15,
        workerAdapter: () => {
          setTimeout(() => {
            mockWorker.emit('error', new Error('Error right at timeout boundary'))
          }, 15)
          return mockWorker
        },
      })

      await expect(verifyPromise).rejects.toThrow(/timed out|Error right at timeout boundary/)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A6: worker.terminate() rejects marks TERMINATION_UNCONFIRMED', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      mockWorker.terminateHandler = async () => {
        throw new Error('Simulated host OS kill failure')
      }

      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 20,
            })
          })
          return mockWorker
        },
      })

      let caughtErr: unknown = null
      try {
        await verifyPromise
      } catch (err) {
        caughtErr = err
      }

      expect(caughtErr).toBeInstanceOf(WorkerTerminationError)
      expect(isTerminationUnconfirmed(caughtErr)).toBe(true)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A7: worker.terminate() remains pending times out with TERMINATION_UNCONFIRMED', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      // Hang indefinitely during terminate()
      mockWorker.terminateHandler = () => new Promise<number>(() => {})

      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        terminationTimeoutMs: 30, // 30ms timeout bound
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 5,
            })
          })
          return mockWorker
        },
      })

      let caughtErr: unknown = null
      try {
        await verifyPromise
      } catch (err) {
        caughtErr = err
      }

      expect(caughtErr).toBeInstanceOf(WorkerTerminationError)
      expect((caughtErr as Error).message).toMatch(/termination timed out after 30ms/)
      expect(isTerminationUnconfirmed(caughtErr)).toBe(true)
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario A8: duplicate IPC messages ignored without double settlement', async () => {
    const tempDir = createTempDir()
    try {
      const dbPath = join(tempDir, 'candidate.sqlite3')
      createDummyCandidateDb(dbPath)

      const mockWorker = new MockWorkerAdapter()
      const verifyPromise = verifyCandidateDatabaseWithWorker(dbPath, {
        workerAdapter: (req: IntegrityRequest) => {
          queueMicrotask(() => {
            // First valid message
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 14,
            })
            // Second duplicate message
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: false,
              errorCode: 'DUPLICATE_FAILED',
              message: 'Should be ignored',
            })
          })
          return mockWorker
        },
      })

      const res = await verifyPromise
      expect(res.success).toBe(true)
      expect(res.integrityResult).toBe('ok')
      expect(mockWorker.terminateCallCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('Candidate Database Path Boundary Validations', () => {
  it('valid candidate database path matching pattern passes validation', async () => {
    const tempDir = createTempDir()
    try {
      const validName = 'ecdict-s1-abcdef123456-1a6947e04785-001122334455.sqlite3.tmp-cand12345'
      expect(CANDIDATE_DATABASE_FILENAME_PATTERN.test(validName)).toBe(true)

      const validPath = join(tempDir, validName)
      createDummyCandidateDb(validPath)

      const validated = await validateCandidateDatabasePath(validPath, tempDir)
      expect(validated).toBe(validPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('candidate file not matching candidate naming contract is rejected', async () => {
    const tempDir = createTempDir()
    try {
      const invalidPath = join(tempDir, 'arbitrary-file.sqlite3')
      createDummyCandidateDb(invalidPath)

      await expect(
        validateCandidateDatabasePath(invalidPath, tempDir),
      ).rejects.toThrow(/violates candidate naming contract/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('candidate escaping database directory via .. is rejected', async () => {
    const tempDir = createTempDir()
    try {
      const subDir = join(tempDir, 'sub')
      mkdirSync(subDir, { recursive: true })

      const validName = 'ecdict-s1-abcdef123456-1a6947e04785-001122334455.sqlite3.tmp-cand12345'
      const escapedPath = join(subDir, '..', validName)

      await expect(
        validateCandidateDatabasePath(escapedPath, subDir),
      ).rejects.toThrow(/escapes managed database directory/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('symbolic link candidate file is rejected fail-closed', async () => {
    const tempDir = createTempDir()
    try {
      const realTarget = join(tempDir, 'real-target.sqlite3')
      createDummyCandidateDb(realTarget)

      const linkName = 'ecdict-s1-abcdef123456-1a6947e04785-001122334455.sqlite3.tmp-symlink'
      const symlinkPath = join(tempDir, linkName)

      try {
        symlinkSync(realTarget, symlinkPath)
      } catch {
        // If symlink creation fails due to Windows privileges without Developer Mode, skip this sub-check
        return
      }

      await expect(
        validateCandidateDatabasePath(symlinkPath, tempDir),
      ).rejects.toThrow(/must not be a symbolic link/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
