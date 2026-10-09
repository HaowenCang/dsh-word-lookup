/**
 * Real NPM Tarball Packaging, Installation, and Static Worker Verification.
 *
 * Implements Phase 7A.5R4.1 Section 5:
 * 1. Executes `npm pack` into an isolated disposable directory.
 * 2. Unpacks/installs from the real generated `.tgz` archive.
 * 3. Verifies Host (`lib/index.js`), Client (`lib/client.js`), and Worker (`lib/ecdict-integrity-worker.js`).
 * 4. Resolves the static Worker URL from the installed Host bundle directory.
 * 5. Executes a real SQLite full `PRAGMA integrity_check` using the unpacked static companion Worker.
 * 6. Confirms worker termination and verifies SQLite OS file handle release (unlink candidate).
 * 7. Cleans up all disposable test artifacts.
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function createTempDir(): string {
  const dir = join(tmpdir(), `dsh-tarball-verify-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function createValidSqliteDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE entries (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      translation TEXT
    );
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO entries VALUES ('verify', '验证');
    INSERT INTO meta VALUES ('entry_count', '1');
  `)
  db.close()
}

describe('Phase 7A.5R4.1 Section 5: Real NPM Tarball & Worker Verification', () => {
  it('builds real tarball, unpacks artifacts, and executes full PRAGMA integrity_check with worker handle release', async () => {
    const tempDir = createTempDir()
    try {
      // 1. Execute npm pack into isolated disposable directory
      const packDest = join(tempDir, 'pack')
      mkdirSync(packDest, { recursive: true })

      execFileSync(NPM, ['pack', '--pack-destination', packDest], {
        cwd: ROOT,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })

      const tgzFiles = readdirSync(packDest).filter((f) => f.endsWith('.tgz'))
      expect(tgzFiles.length).toBe(1)
      const tgzPath = join(packDest, tgzFiles[0]!)
      expect(existsSync(tgzPath)).toBe(true)
      expect(statSync(tgzPath).size).toBeGreaterThan(10000)

      // 2. Unpack the real .tgz into extract directory
      const extractDir = join(tempDir, 'unpacked')
      mkdirSync(extractDir, { recursive: true })

      if (process.platform === 'win32') {
        execFileSync('tar.exe', ['-xzf', tgzPath, '-C', extractDir], {
          stdio: 'pipe',
        })
      } else {
        execFileSync('tar', ['-xzf', tgzPath, '-C', extractDir], {
          stdio: 'pipe',
        })
      }

      const pkgRoot = join(extractDir, 'package')
      expect(existsSync(pkgRoot)).toBe(true)

      // 3. Verify Host, Client, and Worker actual files in unpacked package
      const hostFile = join(pkgRoot, 'lib', 'index.js')
      const clientFile = join(pkgRoot, 'lib', 'client.js')
      const workerFile = join(pkgRoot, 'lib', 'ecdict-integrity-worker.js')
      const manifestFile = join(pkgRoot, 'corpus', 'ecdict.manifest.json')
      const packageJsonFile = join(pkgRoot, 'package.json')

      expect(existsSync(hostFile)).toBe(true)
      expect(existsSync(clientFile)).toBe(true)
      expect(existsSync(workerFile)).toBe(true)
      expect(existsSync(manifestFile)).toBe(true)
      expect(existsSync(packageJsonFile)).toBe(true)

      expect(statSync(hostFile).size).toBeGreaterThan(50000)
      expect(statSync(clientFile).size).toBeGreaterThan(30000)
      expect(statSync(workerFile).size).toBeGreaterThan(1000)

      // 4. Resolve static companion Worker URL from installed Host bundle directory
      const hostBundleUrl = pathToFileURL(hostFile)
      const resolvedWorkerUrl = new URL('./ecdict-integrity-worker.js', hostBundleUrl)
      expect(fileURLToPath(resolvedWorkerUrl)).toBe(workerFile)

      // 5. Execute real SQLite candidate PRAGMA integrity_check using unpacked static worker
      const candidateDbPath = join(tempDir, 'candidate.sqlite3')
      createValidSqliteDb(candidateDbPath)

      const requestId = randomUUID()
      const worker = new Worker(resolvedWorkerUrl, {
        workerData: {
          requestId,
          candidatePath: candidateDbPath,
        },
      })

      const response = await new Promise<any>((resolve, reject) => {
        worker.on('message', resolve)
        worker.on('error', reject)
        worker.on('exit', (code) => {
          if (code !== 0 && code !== 1) {
            reject(new Error(`Worker exited prematurely with code ${code}`))
          }
        })
      })

      expect(response).toBeDefined()
      expect(response.requestId).toBe(requestId)
      expect(response.success).toBe(true)
      expect(response.integrityResult).toBe('ok')
      expect(typeof response.durationMs).toBe('number')

      // Terminate worker and confirm exit
      await worker.terminate()

      // 6. Verify SQLite file handle released: delete candidate without EBUSY/lock error
      await unlink(candidateDbPath)
      expect(existsSync(candidateDbPath)).toBe(false)
    } finally {
      // 7. Clean up all disposable test files
      rmSync(tempDir, { recursive: true, force: true })
      expect(existsSync(tempDir)).toBe(false)
    }
  }, 30000)
})
