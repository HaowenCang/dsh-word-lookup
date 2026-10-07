import { existsSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureManagedStorageDirectories,
  managedDatabaseFileName,
  managedDatabasePath,
  readActiveMetadata,
  removeStaleTemporaryArtifacts,
  resolveDshHomeFromContext,
  resolveManagedStoragePaths,
  validateActiveMetadata,
  writeActiveMetadataAtomically,
  _setStorageFsHooksForTesting,
  type ActiveMetadata,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'

describe('Managed Storage & DSH Home Resolution (Phase 7A.3)', () => {
  describe('DSH Home Resolution from Host Context', () => {
    it('returns null when context is undefined or empty', () => {
      expect(resolveDshHomeFromContext(undefined)).toBeNull()
      expect(resolveDshHomeFromContext({} as never)).toBeNull()
      expect(resolveDshHomeFromContext({ get: () => undefined } as never)).toBeNull()
    })

    it('resolves home from ctx.get("profileContext")', () => {
      const mockCtx = {
        get: (name: string) => {
          if (name === 'profileContext') {
            return { home: 'C:\\Users\\test\\.dsh' }
          }
          return undefined
        },
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBe(resolve('C:\\Users\\test\\.dsh'))
    })

    it('resolves home from direct ctx.profileContext property', () => {
      const mockCtx = {
        profileContext: { home: '/home/test/.dsh' },
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBe(resolve('/home/test/.dsh'))
    })

    it('resolves home from ctx.get("dshHomePath")', () => {
      const mockCtx = {
        get: (name: string) => {
          if (name === 'dshHomePath') {
            return () => 'C:\\Users\\test\\.dsh'
          }
          return undefined
        },
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBe(resolve('C:\\Users\\test\\.dsh'))
    })

    it('resolves home from direct ctx.dshHomePath function', () => {
      const mockCtx = {
        dshHomePath: () => '/home/user/.dsh',
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBe(resolve('/home/user/.dsh'))
    })

    it('prioritizes profileContext.home over dshHomePath', () => {
      const mockCtx = {
        get: (name: string) => {
          if (name === 'profileContext') return { home: '/primary/home' }
          if (name === 'dshHomePath') return () => '/secondary/home'
          return undefined
        },
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBe(resolve('/primary/home'))
    })

    it('ignores empty or whitespace home values', () => {
      const mockCtx = {
        get: (name: string) => {
          if (name === 'profileContext') return { home: '   ' }
          if (name === 'dshHomePath') return () => ''
          return undefined
        },
      }
      expect(resolveDshHomeFromContext(mockCtx as never)).toBeNull()
    })
  })

  describe('resolveManagedStoragePaths', () => {
    it('resolves paths with explicit home option', () => {
      const paths = resolveManagedStoragePaths({ home: 'C:\\isolated\\dsh-home' })
      const expectedHome = resolve('C:\\isolated\\dsh-home')
      expect(paths.home).toBe(expectedHome)
      expect(paths.sourceCacheDirectory).toBe(join(expectedHome, 'cache', 'dsh-word-lookup', 'sources'))
      expect(paths.storageDirectory).toBe(join(expectedHome, 'storages', 'dsh-word-lookup'))
      expect(paths.databaseDirectory).toBe(join(expectedHome, 'storages', 'dsh-word-lookup', 'databases'))
      expect(paths.activeMetadataPath).toBe(join(expectedHome, 'storages', 'dsh-word-lookup', 'active.json'))
    })

    it('resolves paths with context home', () => {
      const mockCtx = {
        get: (name: string) => (name === 'profileContext' ? { home: '/isolated/home' } : undefined),
      }
      const paths = resolveManagedStoragePaths({ ctx: mockCtx as never })
      const expectedHome = resolve('/isolated/home')
      expect(paths.home).toBe(expectedHome)
      expect(paths.databaseDirectory).toBe(join(expectedHome, 'storages', 'dsh-word-lookup', 'databases'))
    })

    it('prioritizes explicit home over context home', () => {
      const mockCtx = {
        get: (name: string) => (name === 'profileContext' ? { home: '/context/home' } : undefined),
      }
      const paths = resolveManagedStoragePaths({ home: '/explicit/home', ctx: mockCtx as never })
      expect(paths.home).toBe(resolve('/explicit/home'))
    })

    it('throws fail-closed when no home can be resolved', () => {
      expect(() => resolveManagedStoragePaths()).toThrow(/Cannot resolve DSH home/)
      expect(() => resolveManagedStoragePaths({ home: '   ' })).toThrow(/Cannot resolve DSH home/)
      expect(() => resolveManagedStoragePaths({ ctx: {} as never })).toThrow(/Cannot resolve DSH home/)
    })
  })

  describe('Database artifact naming and path security', () => {
    it('formats valid versioned database filename', () => {
      expect(managedDatabaseFileName('v1')).toBe('ecdict-v1.sqlite3')
      expect(managedDatabaseFileName('ecdict-20261006')).toBe('ecdict-ecdict-20261006.sqlite3')
      expect(managedDatabaseFileName('a7013d658fb101bc')).toBe('ecdict-a7013d658fb101bc.sqlite3')
      expect(managedDatabaseFileName('release_1.0-alpha.1')).toBe('ecdict-release_1.0-alpha.1.sqlite3')
    })

    it('builds absolute database path under databaseDirectory', () => {
      const paths = resolveManagedStoragePaths({ home: 'C:\\isolated\\dsh-home' })
      const fullPath = managedDatabasePath(paths, 'v1')
      expect(fullPath).toBe(join(paths.databaseDirectory, 'ecdict-v1.sqlite3'))
    })

    it('rejects empty or whitespace identities', () => {
      expect(() => managedDatabaseFileName('')).toThrow(TypeError)
      expect(() => managedDatabaseFileName('   ')).toThrow(TypeError)
    })

    it('rejects path traversal and directory separators in identities', () => {
      expect(() => managedDatabaseFileName('..')).toThrow(/Path traversal/)
      expect(() => managedDatabaseFileName('.')).toThrow(/Path traversal/)
      expect(() => managedDatabaseFileName('../sub')).toThrow(/Invalid dictionary identity|Path traversal/)
      expect(() => managedDatabaseFileName('..\\sub')).toThrow(/Invalid dictionary identity|Path traversal/)
      expect(() => managedDatabaseFileName('sub/nested')).toThrow(/Invalid dictionary identity|Path traversal/)
      expect(() => managedDatabaseFileName('sub\\nested')).toThrow(/Invalid dictionary identity|Path traversal/)
      expect(() => managedDatabaseFileName('C:\\sub')).toThrow(/Invalid dictionary identity|Path traversal/)
    })

    it('rejects forbidden characters or overly long identities', () => {
      expect(() => managedDatabaseFileName('has spaces')).toThrow(TypeError)
      expect(() => managedDatabaseFileName('bad*char')).toThrow(TypeError)
      expect(() => managedDatabaseFileName('bad?char')).toThrow(TypeError)
      expect(() => managedDatabaseFileName('bad"quote')).toThrow(TypeError)
      expect(() => managedDatabaseFileName('a'.repeat(65))).toThrow(TypeError)
    })
  })

  describe('Active metadata schema validation', () => {
    const validMeta: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'v1-20261006',
      databaseFile: 'ecdict-v1-20261006.sqlite3',
      source: {
        name: 'ECDICT',
        commit: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        schemaVersion: 1,
      },
    }

    it('validates a compliant metadata descriptor', () => {
      const result = validateActiveMetadata(validMeta)
      expect(result).toEqual(validMeta)
    })

    it('normalizes uppercase commit and sha256 to lowercase', () => {
      const result = validateActiveMetadata({
        ...validMeta,
        source: {
          ...validMeta.source,
          commit: '1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B',
          sha256: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
        },
      })
      expect(result.source.commit).toBe('1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b')
      expect(result.source.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })

    it('rejects unsupported versions or activeMode', () => {
      expect(() => validateActiveMetadata({ ...validMeta, version: 2 })).toThrow(/Unsupported active metadata schema version/)
      expect(() => validateActiveMetadata({ ...validMeta, activeMode: 'fixture' })).toThrow(/Invalid activeMode/)
    })

    it('rejects absolute or path-traversing databaseFile', () => {
      expect(() => validateActiveMetadata({ ...validMeta, databaseFile: 'C:\\ecdict.sqlite3' })).toThrow(/relative basename/)
      expect(() => validateActiveMetadata({ ...validMeta, databaseFile: '/var/ecdict.sqlite3' })).toThrow(/relative basename/)
      expect(() => validateActiveMetadata({ ...validMeta, databaseFile: '../ecdict.sqlite3' })).toThrow(/relative basename/)
      expect(() => validateActiveMetadata({ ...validMeta, databaseFile: 'databases/ecdict-v1-20261006.sqlite3' })).toThrow(/relative basename/)
    })

    it('rejects databaseFile that does not match identity', () => {
      expect(() =>
        validateActiveMetadata({
          ...validMeta,
          identity: 'v1',
          databaseFile: 'ecdict-v2.sqlite3',
        }),
      ).toThrow(/does not match identity/)
    })

    it('rejects invalid source descriptors', () => {
      expect(() => validateActiveMetadata({ ...validMeta, source: null })).toThrow(/must be an object/)
      expect(() => validateActiveMetadata({ ...validMeta, source: { ...validMeta.source, name: '' } })).toThrow(/source.name/)
      expect(() => validateActiveMetadata({ ...validMeta, source: { ...validMeta.source, commit: 'short' } })).toThrow(/source.commit/)
      expect(() => validateActiveMetadata({ ...validMeta, source: { ...validMeta.source, sha256: 'short' } })).toThrow(/source.sha256/)
      expect(() => validateActiveMetadata({ ...validMeta, source: { ...validMeta.source, schemaVersion: 0 } })).toThrow(/source.schemaVersion/)
    })
  })

  describe('Atomic Active Metadata Persistence & Cleanup', () => {
    let testHome: string
    let paths: ManagedStoragePaths

    beforeEach(async () => {
      testHome = join(tmpdir(), `dsh-managed-storage-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      paths = resolveManagedStoragePaths({ home: testHome })
    })

    afterEach(async () => {
      _setStorageFsHooksForTesting(null)
      try {
        await rm(testHome, { recursive: true, force: true })
      } catch {
        // cleanup best-effort
      }
    })

    it('ensureManagedStorageDirectories creates required directories recursively', async () => {
      expect(existsSync(paths.sourceCacheDirectory)).toBe(false)
      expect(existsSync(paths.databaseDirectory)).toBe(false)

      await ensureManagedStorageDirectories(paths)

      expect(existsSync(paths.sourceCacheDirectory)).toBe(true)
      expect(existsSync(paths.databaseDirectory)).toBe(true)
    })

    it('readActiveMetadata returns null when active.json does not exist', async () => {
      const meta = await readActiveMetadata(paths)
      expect(meta).toBeNull()
    })

    it('writes and reads active metadata atomically', async () => {
      const metadata: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'test-2026',
        databaseFile: 'ecdict-test-2026.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'a'.repeat(40),
          sha256: 'b'.repeat(64),
          schemaVersion: 1,
        },
      }

      await writeActiveMetadataAtomically(paths, metadata)

      expect(existsSync(paths.activeMetadataPath)).toBe(true)
      const readBack = await readActiveMetadata(paths)
      expect(readBack).toEqual(metadata)

      // Ensure no temp files remained in storageDirectory
      const dirContents = await readFile(paths.activeMetadataPath, 'utf8')
      expect(JSON.parse(dirContents)).toEqual(metadata)
    })

    it('replaces active metadata atomically on subsequent write', async () => {
      const metadata1: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-1',
        databaseFile: 'ecdict-gen-1.sqlite3',
        source: {
          name: 'ECDICT',
          commit: '1'.repeat(40),
          sha256: '1'.repeat(64),
          schemaVersion: 1,
        },
      }
      const metadata2: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-2',
        databaseFile: 'ecdict-gen-2.sqlite3',
        source: {
          name: 'ECDICT',
          commit: '2'.repeat(40),
          sha256: '2'.repeat(64),
          schemaVersion: 1,
        },
      }

      await writeActiveMetadataAtomically(paths, metadata1)
      expect((await readActiveMetadata(paths))?.identity).toBe('gen-1')

      await writeActiveMetadataAtomically(paths, metadata2)
      expect((await readActiveMetadata(paths))?.identity).toBe('gen-2')
    })

    it('preserves existing active.json when temp write/flush fails (failure-injection)', async () => {
      const metadataA: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-A',
        databaseFile: 'ecdict-gen-A.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'a'.repeat(40),
          sha256: 'a'.repeat(64),
          schemaVersion: 1,
        },
      }
      const metadataB: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-B',
        databaseFile: 'ecdict-gen-B.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'b'.repeat(40),
          sha256: 'b'.repeat(64),
          schemaVersion: 1,
        },
      }

      // Step 1: Write generation A successfully
      await writeActiveMetadataAtomically(paths, metadataA)
      const initialBytes = await readFile(paths.activeMetadataPath)
      const initialMeta = await readActiveMetadata(paths)
      expect(initialMeta?.identity).toBe('gen-A')

      // Step 2: Inject temp write/flush failure
      _setStorageFsHooksForTesting({
        writeFile: async () => {
          throw new Error('EIO: simulated disk write/flush error during temp persistence')
        },
      })

      // Step 3: Attempt write of generation B -> must reject
      await expect(writeActiveMetadataAtomically(paths, metadataB)).rejects.toThrow(
        /simulated disk write\/flush error/,
      )

      // Step 4: Verify generation A is byte-for-byte unchanged and valid
      const afterBytes = await readFile(paths.activeMetadataPath)
      expect(afterBytes).toEqual(initialBytes)

      const afterMeta = await readActiveMetadata(paths)
      expect(afterMeta).toEqual(metadataA)
      expect(afterMeta?.identity).toBe('gen-A')

      // Step 5: Verify no replacement occurred and no temporary files linger
      const entries = await readdir(paths.storageDirectory)
      const tempEntries = entries.filter((e) => e.startsWith('active.json.tmp-'))
      expect(tempEntries).toHaveLength(0)
    })

    it('preserves existing active.json and cleans temp file when rename fails (failure-injection)', async () => {
      const metadataA: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-A',
        databaseFile: 'ecdict-gen-A.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'a'.repeat(40),
          sha256: 'a'.repeat(64),
          schemaVersion: 1,
        },
      }
      const metadataB: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'gen-B',
        databaseFile: 'ecdict-gen-B.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'b'.repeat(40),
          sha256: 'b'.repeat(64),
          schemaVersion: 1,
        },
      }

      // Step 1: Write generation A successfully
      await writeActiveMetadataAtomically(paths, metadataA)
      const initialBytes = await readFile(paths.activeMetadataPath)
      const initialMeta = await readActiveMetadata(paths)
      expect(initialMeta?.identity).toBe('gen-A')

      // Step 2: Inject rename failure (temp write with flush succeeds, rename throws)
      _setStorageFsHooksForTesting({
        rename: async () => {
          throw new Error('EXDEV: simulated atomic rename failure')
        },
      })

      // Step 3: Attempt write of generation B -> must reject
      await expect(writeActiveMetadataAtomically(paths, metadataB)).rejects.toThrow(
        /simulated atomic rename failure/,
      )

      // Step 4: Verify generation A bytes remain unchanged
      const afterBytes = await readFile(paths.activeMetadataPath)
      expect(afterBytes).toEqual(initialBytes)

      const afterMeta = await readActiveMetadata(paths)
      expect(afterMeta).toEqual(metadataA)
      expect(afterMeta?.identity).toBe('gen-A')

      // Step 5: Verify temp cleanup was attempted and no temporary files linger
      const entries = await readdir(paths.storageDirectory)
      const tempEntries = entries.filter((e) => e.startsWith('active.json.tmp-'))
      expect(tempEntries).toHaveLength(0)
    })

    it('verifies real Windows atomic replacement of existing active.json with flushed contents', async () => {
      // Affirm environment platform matches Windows requirement for Windows replacement acceptance
      if (process.platform === 'win32') {
        expect(process.platform).toBe('win32')
      }

      const meta1: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'win-replace-v1',
        databaseFile: 'ecdict-win-replace-v1.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'c1'.repeat(20),
          sha256: 'd1'.repeat(32),
          schemaVersion: 1,
        },
      }
      const meta2: ActiveMetadata = {
        version: 1,
        activeMode: 'managed-ecdict',
        identity: 'win-replace-v2',
        databaseFile: 'ecdict-win-replace-v2.sqlite3',
        source: {
          name: 'ECDICT',
          commit: 'c2'.repeat(20),
          sha256: 'd2'.repeat(32),
          schemaVersion: 1,
        },
      }

      // 1. Initial write creates active.json
      await writeActiveMetadataAtomically(paths, meta1)
      expect(existsSync(paths.activeMetadataPath)).toBe(true)
      expect((await readActiveMetadata(paths))?.identity).toBe('win-replace-v1')

      // 2. Real atomic replace over existing active.json
      await writeActiveMetadataAtomically(paths, meta2)
      expect(existsSync(paths.activeMetadataPath)).toBe(true)

      // 3. Read back verified new metadata
      const replaced = await readActiveMetadata(paths)
      expect(replaced?.identity).toBe('win-replace-v2')
      expect(replaced?.databaseFile).toBe('ecdict-win-replace-v2.sqlite3')

      // 4. Ensure no temporary artifacts remained in directory
      const entries = await readdir(paths.storageDirectory)
      const tempFiles = entries.filter((e) => e.startsWith('active.json.tmp-'))
      expect(tempFiles).toHaveLength(0)
    })

    it('fails closed on malformed active.json without modifying disk', async () => {
      await ensureManagedStorageDirectories(paths)
      await writeFile(paths.activeMetadataPath, '{ malformed json: not valid }', 'utf8')

      await expect(readActiveMetadata(paths)).rejects.toThrow(/Malformed active metadata JSON/)
    })

    it('fails closed on invalid schema active.json without modifying disk', async () => {
      await ensureManagedStorageDirectories(paths)
      await writeFile(paths.activeMetadataPath, JSON.stringify({ version: 99 }), 'utf8')

      await expect(readActiveMetadata(paths)).rejects.toThrow(/Unsupported active metadata schema version/)
    })

    it('removes only recognized temporary artifacts and preserves valid files', async () => {
      await ensureManagedStorageDirectories(paths)

      // Create valid persistent files
      const validActive = paths.activeMetadataPath
      await writeFile(validActive, '{"valid": true}')
      const validDb = join(paths.databaseDirectory, 'ecdict-v1.sqlite3')
      await writeFile(validDb, 'SQLITE DATA')
      const validReadme = join(paths.storageDirectory, 'README.txt')
      await writeFile(validReadme, 'do not delete')

      // Create stale temporary artifacts
      const staleTemp1 = join(paths.storageDirectory, 'active.json.tmp-abc1234')
      await writeFile(staleTemp1, 'temp data')
      const staleTemp2 = join(paths.databaseDirectory, 'ecdict-v2.sqlite3.tmp-5678')
      await writeFile(staleTemp2, 'temp db')
      const stalePart = join(paths.sourceCacheDirectory, 'ecdict.csv.part')
      await writeFile(stalePart, 'partial download')

      const result = await removeStaleTemporaryArtifacts(paths)

      expect(result.removed).toHaveLength(3)
      expect(result.removed).toContain(staleTemp1)
      expect(result.removed).toContain(staleTemp2)
      expect(result.removed).toContain(stalePart)

      // Verify valid files are preserved
      expect(existsSync(validActive)).toBe(true)
      expect(existsSync(validDb)).toBe(true)
      expect(existsSync(validReadme)).toBe(true)

      // Verify temp files are gone
      expect(existsSync(staleTemp1)).toBe(false)
      expect(existsSync(staleTemp2)).toBe(false)
      expect(existsSync(stalePart)).toBe(false)
    })
  })
})
