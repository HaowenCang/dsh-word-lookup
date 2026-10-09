/**
 * Quarantine Recovery Proof and Worker Exit Safety Test Suite.
 *
 * Implements Phase 7A.5R4.2 Section 4 Fault Injection Gates:
 * 1. terminate() rejects, Worker still alive: recovery refused, quarantine & candidate preserved.
 * 2. terminate() times out, Worker still alive: recovery refused, quarantine & candidate preserved.
 * 3. Candidate can be deleted, but Worker exit unconfirmed: recovery refused, candidate not deleted.
 * 4. Candidate absent, but Worker exit unconfirmed: quarantine preserved, recovery refused.
 * 5. Worker delayed exit: recovery fails before exit, succeeds after exit.
 * 6. Worker exit concurrent with recovery requests: no double cleanup, safe quarantine release.
 * 7. Same directory in quarantine rejects new import.
 * 8. Import concurrent with active recovery rejected.
 * 9. Candidate cleanup failure preserves quarantine and diagnosis.
 * 10. Foreign file / candidate replacement: identity mismatch refuses recovery, file preserved.
 * 11. Worker error and exit concurrent: error preserved, no unhandled rejection.
 * 12. Windows real Worker holding SQLite file handle: cannot bypass exit proof; cleans up on confirmed exit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  buildManagedEcdictDatabaseInternal,
  EcdictImportQuarantinedError,
  isDatabaseDirectoryQuarantined,
  isRecoveryInProgress,
  recoverQuarantinedDirectory,
  _resetQuarantinesForTesting,
} from '../src/host/ecdict-importer.js'
import {
  QuarantineRecoveryError,
  WorkerTerminationError,
  workerSupervisor,
  type WorkerLike,
} from '../src/host/ecdict-integrity-verifier.js'
import {
  resolveManagedStoragePaths,
} from '../src/host/managed-storage.js'
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

class MockWorker extends EventEmitter implements WorkerLike {
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

describe('Phase 7A.5R4.2 Section 4: Quarantine Recovery Proof & Worker Exit Safety', () => {
  let scratchHome: string
  let paths: ReturnType<typeof resolveManagedStoragePaths>
  let sourceFile: string
  let descriptor: EcdictSourceDescriptor
  const activeWorkers: Worker[] = []

  beforeEach(() => {
    _resetQuarantinesForTesting()
    scratchHome = join(tmpdir(), `dsh-proof-test-${randomUUID()}`)
    paths = resolveManagedStoragePaths({ home: scratchHome })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })
    mkdirSync(paths.databaseDirectory, { recursive: true })

    const csv = createSyntheticCsv([
      ['apple', '', 'a fruit', '苹果', 'n', '', '', '', '100', '', '', '', ''],
      ['banana', '', 'a yellow fruit', '香蕉', 'n', '', '', '', '80', '', '', '', ''],
    ])
    const synth = createSyntheticDescriptor(csv)
    descriptor = synth.descriptor
    sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
    writeFileSync(sourceFile, synth.rawBytes)
  })

  afterEach(async () => {
    for (const w of activeWorkers) {
      try {
        await w.terminate()
      } catch {
        // ignore
      }
    }
    activeWorkers.length = 0
    _resetQuarantinesForTesting()
    rmSync(scratchHome, { recursive: true, force: true })
  })

  it('1. terminate() rejects, Worker still alive: recovery refused, candidate and quarantine preserved', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS kill failed: Access Denied')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // Attempting recovery while worker is still alive MUST be refused
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    // Invariants preserved: quarantine still active, candidate not deleted
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)
  })

  it('2. terminate() times out, Worker still alive: recovery refused, candidate and quarantine preserved', async () => {
    const mockWorker = new MockWorker()
    // terminate hangs indefinitely
    mockWorker.terminateHandler = () => new Promise<number>(() => {})

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        terminationTimeoutMs: 25,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // Recovery must be refused
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)
  })

  it('3. Candidate can be deleted, but Worker exit unconfirmed: cannot unquarantine solely because deletion is possible', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS kill error')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 4,
            })
          })
          return mockWorker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // Candidate file is fully accessible and deletable by OS permissions,
    // but without worker exit proof, recovery MUST fail closed without deleting candidate
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    expect(existsSync(capturedCandPath)).toBe(true)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
  })

  it('4. Candidate absent, but Worker exit unconfirmed: quarantine must still be preserved', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS kill error')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 4,
            })
          })
          return mockWorker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // Candidate is manually deleted externally
    rmSync(capturedCandPath, { force: true })
    expect(existsSync(capturedCandPath)).toBe(false)

    // Absence of candidate file MUST NOT bypass exit proof requirement!
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
  })

  it('5. Worker delayed exit: recovery fails before exit, succeeds after exit', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('Worker termination pending')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
          queueMicrotask(() => {
            mockWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 3,
            })
          })
          return mockWorker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

    // Before exit event: recovery fails
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    // Worker later emits authentic exit event
    mockWorker.emit('exit', 0)

    // After exit event: recovery succeeds cleanly
    const recResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
    expect(recResult.recovered).toBe(true)
    expect(recResult.candidateCleaned).toBe(true)
    expect(recResult.exitProof?.proofSource).toBe('exit_event')
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(existsSync(capturedCandPath)).toBe(false)

    // Subsequent import succeeds
    const nextResult = await buildManagedEcdictDatabaseInternal(paths, {
      descriptor,
      sourcePath: sourceFile,
      verifyProbes: false,
    })
    expect(nextResult.entryCount).toBe(2)
  })

  it('6. Worker exit concurrent with multiple recovery requests: no double cleanup, safe release', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS terminate delayed')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

    // Exit confirmed
    mockWorker.emit('exit', 0)

    let candUnlinkCount = 0
    let totalUnlinkCount = 0
    const trackingUnlink = async (p: string) => {
      totalUnlinkCount++
      if (p === capturedCandPath) {
        candUnlinkCount++
      }
      const { unlink } = await import('node:fs/promises')
      await unlink(p)
    }

    // Fire 5 concurrent recovery requests
    const recoveries = await Promise.all([
      recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: trackingUnlink }),
      recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: trackingUnlink }),
      recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: trackingUnlink }),
      recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: trackingUnlink }),
      recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: trackingUnlink }),
    ])

    for (const r of recoveries) {
      expect(r.recovered).toBe(true)
    }
    // Cleanup deduplicated across concurrent callers: candidate file unlinked exactly once
    expect(candUnlinkCount).toBe(1)
    expect(totalUnlinkCount).toBe(4) // 4 suffixes ('', '-journal', '-wal', '-shm') unlinked once total
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(existsSync(capturedCandPath)).toBe(false)
  })

  it('7. Same directory in quarantine rejects new import', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('Worker terminate failed')
    }

    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

    // Calling new import on quarantined directory is rejected immediately
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      }),
    ).rejects.toThrow(EcdictImportQuarantinedError)
  })

  it('8. Import concurrent with active recovery cannot bypass quarantine', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('Worker terminate failed')
    }

    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    mockWorker.emit('exit', 0)

    // Slow unlink hook to keep recovery in flight
    let resolveSlowUnlink!: () => void
    const slowUnlinkPromise = new Promise<void>((r) => {
      resolveSlowUnlink = r
    })

    const slowUnlink = async (p: string) => {
      await slowUnlinkPromise
      const { unlink } = await import('node:fs/promises')
      await unlink(p)
    }

    const recoveryPromise = recoverQuarantinedDirectory(paths.databaseDirectory, {
      unlinkFn: slowUnlink,
    })

    expect(isRecoveryInProgress(paths.databaseDirectory)).toBe(true)

    // While recovery is running, concurrent import MUST be refused
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      }),
    ).rejects.toThrow(EcdictImportQuarantinedError)

    resolveSlowUnlink()
    const recoveryResult = await recoveryPromise
    expect(recoveryResult.recovered).toBe(true)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
  })

  it('9. Candidate cleanup failure preserves quarantine and diagnostic error', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS kill failed')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    // Worker exit confirmed
    mockWorker.emit('exit', 0)

    // Unlink fails with EACCES
    const failingUnlink = async () => {
      const err = new Error('EACCES: permission denied, unlink')
      ;(err as any).code = 'EACCES'
      throw err
    }

    let caughtErr: unknown = null
    try {
      await recoverQuarantinedDirectory(paths.databaseDirectory, { unlinkFn: failingUnlink })
    } catch (e) {
      caughtErr = e
    }

    expect(caughtErr).not.toBeNull()
    const matchesError =
      (caughtErr instanceof AggregateError &&
        caughtErr.errors.some((sub: any) => sub?.code === 'EACCES' || sub?.message?.includes('EACCES'))) ||
      (caughtErr as any)?.code === 'EACCES' ||
      (caughtErr as Error)?.message?.includes('EACCES') ||
      (caughtErr as Error)?.message?.includes('Failed to clean up candidate artifacts')
    expect(matchesError).toBe(true)

    // Directory remains quarantined for operator diagnosis!
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)
  })

  it('10. Foreign file / candidate replacement: identity mismatch refuses recovery, file preserved', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('OS kill failed')
    }

    let capturedCandPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          capturedCandPath = req.candidatePath
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
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // Replace candidate with a foreign file
    rmSync(capturedCandPath, { force: true })
    writeFileSync(capturedCandPath, 'FOREIGN_SUBSTITUTED_DATA_DO_NOT_DELETE')

    // Confirm exit
    mockWorker.emit('exit', 0)

    // Recovery must detect file identity mismatch and refuse to delete the substituted foreign file
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    // Substituted file MUST NOT be deleted
    expect(existsSync(capturedCandPath)).toBe(true)
    expect(readFileSync(capturedCandPath, 'utf8')).toBe('FOREIGN_SUBSTITUTED_DATA_DO_NOT_DELETE')
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
  })

  it('11. Worker error and exit concurrent: error preserved, no unhandled rejection', async () => {
    const mockWorker = new MockWorker()
    mockWorker.terminateHandler = async () => {
      throw new Error('Terminate rejected')
    }

    let capturedCandPath = ''
    const verifyPromise = buildManagedEcdictDatabaseInternal(paths, {
      descriptor,
      sourcePath: sourceFile,
      verifyProbes: false,
      workerAdapter: (req) => {
        capturedCandPath = req.candidatePath
        queueMicrotask(() => {
          mockWorker.emit('message', {
            requestId: req.requestId,
            success: true,
            integrityResult: 'ok',
            durationMs: 5,
          })
          // Fire error and exit simultaneously
          mockWorker.emit('error', new Error('Late fatal isolate crash'))
          mockWorker.emit('exit', 1)
        })
        return mockWorker
      },
    })

    await expect(verifyPromise).rejects.toThrow()
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(capturedCandPath.length).toBeGreaterThan(0)
  })

  it('12. Windows real Worker holding SQLite handle: cannot bypass exit proof; cleans up on confirmed exit', async () => {
    // Write an actual companion worker script that opens SQLite and holds handle until commanded to close
    const workerScriptPath = join(scratchHome, 'real-sqlite-locking-worker.mjs')
    writeFileSync(
      workerScriptPath,
      `
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';

      let db = null;
      try {
        db = new DatabaseSync(workerData.candidatePath);
        parentPort.postMessage({ status: 'HANDLE_ACQUIRED', requestId: workerData.requestId });
      } catch (err) {
        parentPort.postMessage({ status: 'ERROR', message: String(err) });
      }

      parentPort.on('message', (msg) => {
        if (msg === 'CLOSE_AND_EXIT') {
          if (db) {
            try { db.close(); } catch {}
          }
          process.exit(0);
        }
      });
      `,
    )

    let realWorker: Worker | null = null
    let workerSession: any = null
    let capturedCandPath = ''

    // Run import where injected verifier spawns the real Worker against the importer's candidate path
    try {
      await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        integrityVerifier: async (actualCandidatePath) => {
          capturedCandPath = actualCandidatePath
          realWorker = new Worker(pathToFileURL(workerScriptPath), {
            workerData: {
              candidatePath: actualCandidatePath,
              requestId: 'real-worker-req-1',
            },
          })
          activeWorkers.push(realWorker)

          const workerInstance = realWorker!
          // Await worker signal confirming handle acquisition
          await new Promise<void>((resolve, reject) => {
            const onMsg = (msg: any) => {
              if (msg.status === 'HANDLE_ACQUIRED') {
                workerInstance.removeListener('message', onMsg)
                resolve()
              } else {
                reject(new Error(`Worker error: ${JSON.stringify(msg)}`))
              }
            }
            workerInstance.on('message', onMsg)
            workerInstance.on('error', reject)
          })

          // Register real worker with workerSupervisor
          workerSession = workerSupervisor.registerWorker({
            worker: workerInstance,
            candidatePath: actualCandidatePath,
          })

          // Throw unconfirmed termination error
          throw new WorkerTerminationError(
            'Real worker termination timeout',
            'TERMINATION_UNCONFIRMED',
            {
              workerId: workerSession.workerId,
              candidatePath: actualCandidatePath,
              candidateFileIdentity: workerSession.candidateFileIdentity,
            },
          )
        },
      })
    } catch {
      // expected
    }

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    // While real worker holds SQLite handle: recovery MUST be refused
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    // Candidate file still locked & untouched
    expect(existsSync(capturedCandPath)).toBe(true)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

    // Signal real worker to close DB and exit cleanly
    realWorker!.postMessage('CLOSE_AND_EXIT')

    // Await authentic exit event recorded by supervisor
    const proof = await workerSession.waitForExit(5000)
    expect(proof).not.toBeNull()
    expect(proof.proofSource).toBe('exit_event')
    expect(proof.exitCode).toBe(0)

    // Now recovery proceeds: candidate is safely unlinked (handle released!) and quarantine removed
    const recoveryResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
    expect(recoveryResult.recovered).toBe(true)
    expect(recoveryResult.candidateCleaned).toBe(true)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(existsSync(capturedCandPath)).toBe(false)

    // Verify next real import succeeds cleanly in the same directory without deadlocks
    const cleanBuildResult = await buildManagedEcdictDatabaseInternal(paths, {
      descriptor,
      sourcePath: sourceFile,
      verifyProbes: false,
    })
    expect(cleanBuildResult.entryCount).toBe(2)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
  })
})
