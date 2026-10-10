/**
 * Worker Exit Proof Provenance & Safety Invariant Test Suite.
 *
 * Verifies strict safety invariant:
 * A registered worker that has not genuinely exited cannot obtain a valid exit proof
 * through manual Supervisor method calls or fabricated attributes.
 *
 * Verification Gates:
 * 1. Worker registered, has not exited: no public Supervisor method can generate valid exit proof.
 * 2. Worker alive: constructing arbitrary exitCode or forging branded attributes cannot release quarantine.
 * 3. Authentic Worker exit event confirmed: recovery proceeds normally.
 * 4. Authentic terminate() Promise settlement: lifecycle cleanup completes normally.
 * 5. terminate() rejection or timeout: cannot forge or synthesize confirmation.
 * 6. Confirmed termination on both success and failure paths leaves 0 Supervisor sessions.
 * 7. Unconfirmed exit: cannot delete candidate or release quarantine.
 * 8. Real Node Worker integration: authentic lifecycle provenance prevents handle leakage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  buildManagedEcdictDatabaseInternal,
  isDatabaseDirectoryQuarantined,
  recoverQuarantinedDirectory,
  _resetQuarantinesForTesting,
} from '../src/host/ecdict-importer.js'
import {
  EXIT_PROOF_BRAND,
  QuarantineRecoveryError,
  WorkerTerminationError,
  workerSupervisor,
  type WorkerExitProof,
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

class TestWorkerMock extends EventEmitter implements WorkerLike {
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

describe('Worker Exit Proof Provenance & Safety Invariants', () => {
  let scratchHome: string
  let paths: ReturnType<typeof resolveManagedStoragePaths>
  let sourceFile: string
  let descriptor: EcdictSourceDescriptor
  const activeWorkers: Worker[] = []

  beforeEach(() => {
    _resetQuarantinesForTesting()
    workerSupervisor.resetForTesting()
    scratchHome = join(tmpdir(), `dsh-provenance-test-${randomUUID()}`)
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
    workerSupervisor.resetForTesting()
    _resetQuarantinesForTesting()
    try {
      rmSync(scratchHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('1. Worker registered, has not exited: no public Supervisor method can generate valid exit proof', () => {
    const worker = new TestWorkerMock()
    const candPath = join(paths.databaseDirectory, 'ecdict-candidate.db')
    const session = workerSupervisor.registerWorker({
      worker,
      candidatePath: candPath,
    })

    const workerId = session.workerId
    expect(session.status).toBe('RUNNING')
    expect(session.exitProof).toBeNull()
    expect(workerSupervisor.getExitProof(workerId)).toBeNull()

    // 1a. recordTerminationConfirmed must throw and refuse manual proof generation
    expect(() => {
      ;(workerSupervisor as any).recordTerminationConfirmed(workerId, 0)
    }).toThrow(WorkerTerminationError)
    expect(() => {
      ;(workerSupervisor as any).recordTerminationConfirmed(workerId, 0)
    }).toThrow(/Cannot record termination confirmation: manual proof generation is forbidden/)

    // 1b. recordTerminationViaTerminate must throw and refuse manual proof generation
    expect(() => {
      ;(workerSupervisor as any).recordTerminationViaTerminate(workerId, 0)
    }).toThrow(WorkerTerminationError)
    expect(() => {
      ;(workerSupervisor as any).recordTerminationViaTerminate(workerId, 0)
    }).toThrow(/Cannot record termination via terminate: manual proof generation is forbidden/)

    // 1c. _injectTerminationConfirmedForTesting must throw and be segregated from valid provenance
    expect(() => {
      ;(workerSupervisor as any)._injectTerminationConfirmedForTesting(workerId, 0)
    }).toThrow(WorkerTerminationError)
    expect(() => {
      ;(workerSupervisor as any)._injectTerminationConfirmedForTesting(workerId, 0)
    }).toThrow(/test injection is segregated from authentic supervisor provenance/)

    // Invariants preserved: session is STILL RUNNING, no proof exists
    expect(session.status).toBe('RUNNING')
    expect(session.exitProof).toBeNull()
    expect(workerSupervisor.getExitProof(workerId)).toBeNull()

    // Arbitrary forged object cannot pass isExitProofAuthentic
    const forged: WorkerExitProof = {
      workerId,
      exitCode: 0,
      confirmedAt: Date.now(),
      proofSource: 'exit_event',
      [EXIT_PROOF_BRAND]: true,
    }
    expect(workerSupervisor.isExitProofAuthentic(forged)).toBe(false)
  })

  it('2. Worker alive: constructing arbitrary exitCode or forging branded attributes cannot release quarantine', async () => {
    const worker = new TestWorkerMock()
    worker.terminateHandler = async () => {
      throw new Error('OS kill error: access denied')
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
            worker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 3,
            })
          })
          return worker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)

    const session = workerSupervisor.getSessionByCandidatePath(capturedCandPath)
    expect(session).not.toBeNull()
    const workerId = session!.workerId

    // Try forging proofs with arbitrary exit codes and copied brand symbol
    const forgedProofs = [
      { workerId, exitCode: 0, confirmedAt: Date.now(), proofSource: 'exit_event' as const, [EXIT_PROOF_BRAND]: true },
      { workerId, exitCode: 1, confirmedAt: Date.now(), proofSource: 'terminate' as const, [EXIT_PROOF_BRAND]: true },
      { workerId: 'other-worker', exitCode: 0, confirmedAt: Date.now(), proofSource: 'exit_event' as const, [EXIT_PROOF_BRAND]: true },
    ]

    for (const forged of forgedProofs) {
      expect(workerSupervisor.isExitProofAuthentic(forged)).toBe(false)
      await expect(
        recoverQuarantinedDirectory(paths.databaseDirectory, { exitProof: forged as WorkerExitProof }),
      ).rejects.toThrow(QuarantineRecoveryError)

      // Quarantine remains active, candidate file remains untouched
      expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
      expect(existsSync(capturedCandPath)).toBe(true)
    }
  })

  it('3. Authentic Worker exit event confirmed: recovery proceeds normally', async () => {
    const worker = new TestWorkerMock()
    worker.terminateHandler = async () => {
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
            worker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 3,
            })
          })
          return worker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)

    // Worker emits authentic exit event
    worker.emit('exit', 0)

    const session = workerSupervisor.getSessionByCandidatePath(capturedCandPath)
    expect(session?.status).toBe('TERMINATED_CONFIRMED')
    expect(session?.exitProof).not.toBeNull()
    expect(session?.exitProof?.proofSource).toBe('exit_event')
    expect(workerSupervisor.isExitProofAuthentic(session!.exitProof!)).toBe(true)

    // Recovery succeeds cleanly
    const recResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
    expect(recResult.recovered).toBe(true)
    expect(recResult.candidateCleaned).toBe(true)
    expect(recResult.exitProof?.proofSource).toBe('exit_event')
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(existsSync(capturedCandPath)).toBe(false)
    expect(workerSupervisor.getActiveSessionCount()).toBe(0)
  })

  it('4. Authentic terminate() Promise settlement: lifecycle cleanup completes normally', async () => {
    let capturedCandPath = ''
    let terminateInvoked = false
    const worker = new TestWorkerMock()
    worker.terminateHandler = async () => {
      terminateInvoked = true
      return 0
    }

    const buildResult = await buildManagedEcdictDatabaseInternal(paths, {
      descriptor,
      sourcePath: sourceFile,
      verifyProbes: false,
      workerAdapter: (req) => {
        capturedCandPath = req.candidatePath
        queueMicrotask(() => {
          worker.emit('message', {
            requestId: req.requestId,
            success: true,
            integrityResult: 'ok',
            durationMs: 2,
          })
        })
        return worker
      },
    })

    expect(buildResult.entryCount).toBe(2)
    expect(terminateInvoked).toBe(true)
    expect(capturedCandPath.length).toBeGreaterThan(0)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    // Session is cleanly unregistered on successful termination settlement
    expect(workerSupervisor.getActiveSessionCount()).toBe(0)
  })

  it('5. terminate() rejection or timeout: cannot forge or synthesize confirmation', async () => {
    // 5a. Rejection path
    const rejectingWorker = new TestWorkerMock()
    rejectingWorker.terminateHandler = async () => {
      throw new Error('OS kill rejected by kernel')
    }

    let cand1 = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          cand1 = req.candidatePath
          queueMicrotask(() => {
            rejectingWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 2,
            })
          })
          return rejectingWorker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    const session1 = workerSupervisor.getSessionByCandidatePath(cand1)
    expect(session1?.status).toBe('TERMINATION_UNCONFIRMED')
    expect(session1?.exitProof).toBeNull()

    // 5b. Timeout path
    _resetQuarantinesForTesting()
    workerSupervisor.resetForTesting()
    try {
      rmSync(cand1, { force: true })
    } catch {}

    const timingOutWorker = new TestWorkerMock()
    timingOutWorker.terminateHandler = () => new Promise<number>(() => {}) // hangs

    let cand2 = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        terminationTimeoutMs: 25,
        workerAdapter: (req) => {
          cand2 = req.candidatePath
          queueMicrotask(() => {
            timingOutWorker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 2,
            })
          })
          return timingOutWorker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    const session2 = workerSupervisor.getSessionByCandidatePath(cand2)
    expect(session2?.status).toBe('TERMINATION_UNCONFIRMED')
    expect(session2?.exitProof).toBeNull()
  })

  it('6. Confirmed termination on both success and failure paths leaves 0 Supervisor sessions', async () => {
    // 6a. Success path
    const successResult = await buildManagedEcdictDatabaseInternal(paths, {
      descriptor,
      sourcePath: sourceFile,
      verifyProbes: false,
    })
    expect(successResult.entryCount).toBe(2)
    expect(workerSupervisor.getActiveSessionCount()).toBe(0)

    // 6b. Verification failure with confirmed termination
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          const mw = new TestWorkerMock()
          queueMicrotask(() => {
            mw.emit('message', {
              requestId: req.requestId,
              success: false,
              errorCode: 'INTEGRITY_RESULT_NOT_OK',
              message: 'Database check failed',
              durationMs: 1,
            })
          })
          return mw
        },
      }),
    ).rejects.toThrow()

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(workerSupervisor.getActiveSessionCount()).toBe(0)
  })

  it('7. Unconfirmed exit: cannot delete candidate or release quarantine', async () => {
    const worker = new TestWorkerMock()
    worker.terminateHandler = async () => {
      throw new Error('Kernel hung task')
    }

    let candPath = ''
    await expect(
      buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        workerAdapter: (req) => {
          candPath = req.candidatePath
          queueMicrotask(() => {
            worker.emit('message', {
              requestId: req.requestId,
              success: true,
              integrityResult: 'ok',
              durationMs: 2,
            })
          })
          return worker
        },
      }),
    ).rejects.toThrow(WorkerTerminationError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(candPath)).toBe(true)

    // Attempting recovery without exit proof MUST throw and preserve candidate
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(candPath)).toBe(true)
  })

  it('8. Real Node Worker integration: authentic lifecycle provenance prevents handle leakage', async () => {
    // Real companion worker script that opens candidate SQLite database and holds file handle
    const workerScript = join(scratchHome, 'real-provenance-worker.mjs')
    writeFileSync(
      workerScript,
      `
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';

      let db = null;
      try {
        db = new DatabaseSync(workerData.candidatePath);
        parentPort.postMessage({ status: 'HANDLE_OPEN', requestId: workerData.requestId });
      } catch (err) {
        parentPort.postMessage({ status: 'ERROR', message: String(err) });
      }

      parentPort.on('message', (msg) => {
        if (msg === 'CLOSE_AND_TERMINATE') {
          if (db) {
            try { db.close(); } catch {}
          }
          process.exit(0);
        }
      });
      `,
    )

    let realWorker: Worker | null = null
    let realSession: any = null
    let capturedCandPath = ''

    try {
      await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        integrityVerifier: async (candPath) => {
          capturedCandPath = candPath
          realWorker = new Worker(pathToFileURL(workerScript), {
            workerData: {
              candidatePath: candPath,
              requestId: 'real-prov-req-1',
            },
          })
          activeWorkers.push(realWorker)

          const workerRef = realWorker
          await new Promise<void>((resolve, reject) => {
            const onMsg = (m: any) => {
              if (m.status === 'HANDLE_OPEN') {
                workerRef.removeListener('message', onMsg)
                resolve()
              } else {
                reject(new Error(JSON.stringify(m)))
              }
            }
            workerRef.on('message', onMsg)
            workerRef.on('error', reject)
          })

          realSession = workerSupervisor.registerWorker({
            worker: workerRef,
            candidatePath: candPath,
          })

          // Simulate unconfirmed worker shutdown
          throw new WorkerTerminationError('Real worker shutdown unconfirmed', 'TERMINATION_UNCONFIRMED', {
            workerId: realSession.workerId,
            candidatePath: candPath,
            candidateFileIdentity: realSession.candidateFileIdentity,
          })
        },
      })
    } catch {
      // Expected
    }

    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(true)
    expect(existsSync(capturedCandPath)).toBe(true)
    expect(realSession.status).toBe('RUNNING')

    // While real worker holds open file handle: recovery refused
    await expect(
      recoverQuarantinedDirectory(paths.databaseDirectory),
    ).rejects.toThrow(QuarantineRecoveryError)

    // Manual supervisor calls cannot bypass provenance for the real worker
    expect(() => {
      ;(workerSupervisor as any).recordTerminationConfirmed(realSession.workerId, 0)
    }).toThrow(WorkerTerminationError)
    expect(realSession.status).toBe('RUNNING')

    // Tell real worker to close DB and exit
    realWorker!.postMessage('CLOSE_AND_TERMINATE')

    // Await authentic exit event recorded by supervisor
    const proof = await realSession.waitForExit(5000)
    expect(proof).not.toBeNull()
    expect(proof.proofSource).toBe('exit_event')
    expect(proof.exitCode).toBe(0)
    expect(workerSupervisor.isExitProofAuthentic(proof)).toBe(true)

    // Now recovery proceeds cleanly: candidate file unlinked, quarantine released
    const recResult = await recoverQuarantinedDirectory(paths.databaseDirectory)
    expect(recResult.recovered).toBe(true)
    expect(recResult.candidateCleaned).toBe(true)
    expect(isDatabaseDirectoryQuarantined(paths.databaseDirectory)).toBe(false)
    expect(existsSync(capturedCandPath)).toBe(false)
    expect(workerSupervisor.getActiveSessionCount()).toBe(0)
  })
})
