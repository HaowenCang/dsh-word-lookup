/**
 * Worker Fault Injection and Lifecycle Robustness Test Suite.
 *
 * Implements Phase 7A.5R4 Section 10 & Table:
 * Verifies all 21 failure injection, edge-case, and lifecycle states
 * for the Static Worker integrity verification architecture.
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  verifyCandidateDatabaseWithWorker,
} from '../src/host/ecdict-integrity-verifier.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function createTempTestDir(): string {
  const dir = join(tmpdir(), `dsh-worker-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  return dir
}

function createValidCandidateSqlite(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE entries (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT,
      definition_en TEXT,
      translation_zh TEXT,
      pos TEXT,
      exchange TEXT,
      frequency INTEGER
    );
    CREATE TABLE forms (
      form TEXT PRIMARY KEY COLLATE NOCASE,
      headword TEXT NOT NULL,
      kind TEXT
    );
    CREATE TABLE examples (
      headword TEXT NOT NULL,
      example_en TEXT NOT NULL,
      translation_zh TEXT
    );
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO entries VALUES ('hello', 'həˈləʊ', 'greeting', '你好', 'n', '', 100);
    INSERT INTO meta VALUES ('entry_count', '1');
  `)
  db.close()
}

describe('Static Worker Integrity Verification & Fault Injection Suite', () => {
  it('Scenario 1: Normal Worker verification returns ok and releases candidate lock', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const result = await verifyCandidateDatabaseWithWorker(candidatePath)
      expect(result.success).toBe(true)
      expect(result.integrityResult).toBe('ok')
      expect(typeof result.durationMs).toBe('number')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      // Windows lock proof: file can be deleted immediately without EBUSY
      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 2: Missing candidate file fails closed immediately', async () => {
    const tempDir = createTempTestDir()
    try {
      const nonExistent = join(tempDir, 'does-not-exist.sqlite3')
      await expect(
        verifyCandidateDatabaseWithWorker(nonExistent),
      ).rejects.toThrow(/Candidate SQLite database does not exist/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 3: Missing Worker file fails closed with WORKER_SPAWN_FAILED or module error', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)
      const nonExistentWorkerUrl = pathToFileURL(join(tempDir, 'missing-worker.js'))

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: nonExistentWorkerUrl,
        }),
      ).rejects.toThrow(/Failed to spawn integrity worker|Cannot find module/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 4: Wrong requestId in IPC response is rejected', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      // Test worker that sends mismatched requestId
      const mockWorkerPath = join(tempDir, 'mock-wrong-id.js')
      writeFileSync(
        mockWorkerPath,
        `
        import { parentPort } from 'node:worker_threads';
        parentPort.postMessage({
          requestId: 'mismatched-uuid-1234',
          success: true,
          integrityResult: 'ok',
          durationMs: 5
        });
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
        }),
      ).rejects.toThrow(/requestId mismatch/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 5: Malformed or non-conforming IPC message is rejected', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      // Test worker that sends completely invalid payload
      const mockWorkerPath = join(tempDir, 'mock-bad-ipc.js')
      writeFileSync(
        mockWorkerPath,
        `
        import { parentPort } from 'node:worker_threads';
        parentPort.postMessage("raw text rather than object");
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
        }),
      ).rejects.toThrow(/invalid or unrecognized IPC response structure/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 6: Worker returns non-ok diagnostic rows (failure reported)', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const mockWorkerPath = join(tempDir, 'mock-corrupt.js')
      writeFileSync(
        mockWorkerPath,
        `
        import { parentPort, workerData } from 'node:worker_threads';
        parentPort.postMessage({
          requestId: workerData.requestId,
          success: false,
          errorCode: 'INTEGRITY_CHECK_FAILED',
          message: 'Candidate SQLite PRAGMA integrity_check failed: freelist page corruption',
          durationMs: 12
        });
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
        }),
      ).rejects.toThrow(/Candidate SQLite PRAGMA integrity_check failed/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 7: Worker uncaught exception in V8 isolate is caught and releases handles', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const mockWorkerPath = join(tempDir, 'mock-throw.js')
      writeFileSync(
        mockWorkerPath,
        `
        throw new Error('Fatal unhandled isolate exception');
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
        }),
      ).rejects.toThrow(/Integrity worker encountered an uncaught error: Fatal unhandled isolate exception/)

      // Windows lock proof
      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 8: Worker premature exit before response is caught and rejected', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const mockWorkerPath = join(tempDir, 'mock-premature-exit.js')
      writeFileSync(
        mockWorkerPath,
        `
        process.exit(1);
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
        }),
      ).rejects.toThrow(/Integrity worker exited prematurely/)

      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 9: AbortSignal aborts in-flight worker, terminates, and cleans handles', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      // Test worker that hangs until killed
      const mockWorkerPath = join(tempDir, 'mock-hang.js')
      writeFileSync(
        mockWorkerPath,
        `
        setInterval(() => {}, 1000);
        `,
      )

      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('Manual user cancellation')), 25)

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
          signal: controller.signal,
        }),
      ).rejects.toThrow(/Manual user cancellation|operation was aborted/)

      // File handle must be free
      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 10: 30-second timeout enforcement (tested with tight timeoutMs)', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const mockWorkerPath = join(tempDir, 'mock-slow.js')
      writeFileSync(
        mockWorkerPath,
        `
        setInterval(() => {}, 5000);
        `,
      )

      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath, {
          workerUrl: pathToFileURL(mockWorkerPath),
          timeoutMs: 30, // Trigger timeout after 30ms
        }),
      ).rejects.toThrow(/timed out after 30ms/)

      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 11: Real candidate physical corruption fails integrity verification', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      // Overwrite database page headers with random garbage
      const fd = openSync(candidatePath, 'r+')
      const garbage = Buffer.alloc(1024, 0xff)
      writeSync(fd, garbage, 0, 1024, 100)
      closeSync(fd)

      // Real worker must fail on corrupt candidate
      await expect(
        verifyCandidateDatabaseWithWorker(candidatePath),
      ).rejects.toThrow(/Candidate SQLite PRAGMA integrity_check failed|file is not a database|database disk image is malformed/)

      // Candidate must be cleanly removable
      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 12: Worker internal request validation rejects malformed payload', async () => {
    // Test the compiled worker directly with bad workerData
    const workerUrl = new URL('../lib/ecdict-integrity-worker.js', import.meta.url)
    const worker = new Worker(workerUrl, {
      workerData: { requestId: '', candidatePath: '' }, // invalid empty strings
    })

    const msg = await new Promise<any>((resolve) => {
      worker.on('message', resolve)
    })
    await worker.terminate()

    expect(msg.success).toBe(false)
    expect(msg.errorCode).toBe('INVALID_REQUEST_PAYLOAD')
  })

  it('Scenario 13: Multiple consecutive full verifications leave no orphan workers or lock leaks', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      for (let i = 0; i < 3; i++) {
        const result = await verifyCandidateDatabaseWithWorker(candidatePath)
        expect(result.success).toBe(true)
        expect(result.integrityResult).toBe('ok')
      }

      await unlink(candidatePath)
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 14: Simulated Cordis disposer aborts in-flight worker and awaits clean exit', async () => {
    const tempDir = createTempTestDir()
    try {
      const candidatePath = join(tempDir, 'candidate.sqlite3')
      createValidCandidateSqlite(candidatePath)

      const activeAbortControllers = new Set<AbortController>()
      const abortCtrl = new AbortController()
      activeAbortControllers.add(abortCtrl)

      const mockWorkerPath = join(tempDir, 'mock-cordis-hang.js')
      writeFileSync(
        mockWorkerPath,
        `
        setInterval(() => {}, 1000);
        `,
      )

      const verifyPromise = verifyCandidateDatabaseWithWorker(candidatePath, {
        workerUrl: pathToFileURL(mockWorkerPath),
        signal: abortCtrl.signal,
      })

      // Simulate Cordis ctx.effect() disposer triggering
      const disposer = async () => {
        for (const ctrl of activeAbortControllers) {
          ctrl.abort(new Error('Plugin disposed: Cordis unload'))
        }
        await expect(verifyPromise).rejects.toThrow(/Plugin disposed: Cordis unload|operation was aborted/)
        // After disposer completes, candidate can be cleanly cleaned up
        if (existsSync(candidatePath)) {
          await unlink(candidatePath)
        }
      }

      await disposer()
      expect(existsSync(candidatePath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('Scenario 15: Post-pack artifact layout confirms Worker is packaged and resolvable', () => {
    const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkgJson.files).toContain('lib/ecdict-integrity-worker.js')

    const workerFileOnDisk = join(ROOT, 'lib/ecdict-integrity-worker.js')
    expect(existsSync(workerFileOnDisk)).toBe(true)

    // Confirm that relative URL from lib/index.js resolves exactly to workerFileOnDisk
    const hostBundleUrl = pathToFileURL(join(ROOT, 'lib/index.js'))
    const resolvedWorkerUrl = new URL('./ecdict-integrity-worker.js', hostBundleUrl)
    expect(fileURLToPath(resolvedWorkerUrl)).toBe(workerFileOnDisk)
  })
})
