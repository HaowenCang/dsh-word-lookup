import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  buildManagedEcdictDatabaseInternal,
  REQUIRED_PROBE_WORDS,
  CANONICAL_FORM_RELATIONSHIPS,
  EcdictImportInProgressError,
  EXPECTED_CORPUS_HEADER,
  generateManagedDatabaseIdentity,
  MAX_FIELD_LENGTH,
  MAX_WORD_LENGTH,
  verifyCandidateProbes,
  type EcdictImportProgress,
} from '../src/host/ecdict-importer.js'
import {
  type EcdictSourceDescriptor,
} from '../src/host/ecdict-source.js'
import {
  managedDatabaseFileName,
  managedDatabasePath,
  resolveManagedStoragePaths,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'
import { openSqliteDictionary } from '../src/host/sqlite-dictionary.js'
import { apply } from '../src/index.js'
import * as indexExports from '../src/index.js'
import { Config } from '../src/host/config.js'

function createSyntheticCsv(rows: string[][], includeHeader = true): string {
  const allRows = includeHeader
    ? [
        [
          'word',
          'phonetic',
          'definition',
          'translation',
          'pos',
          'collins',
          'oxford',
          'tag',
          'bnc',
          'frq',
          'exchange',
          'detail',
          'audio',
        ],
        ...rows,
      ]
    : rows
  return (
    allRows
      .map((r) =>
        r
          .map((c) =>
            c.includes(',') || c.includes('"') || c.includes('\n')
              ? `"${c.replace(/"/g, '""')}"`
              : c,
          )
          .join(','),
      )
      .join('\n') + '\n'
  )
}

function createSyntheticDescriptor(csvContent: string | Buffer): {
  descriptor: EcdictSourceDescriptor
  rawBytes: Buffer
} {
  const rawBytes = typeof csvContent === 'string' ? Buffer.from(csvContent, 'utf8') : csvContent
  const hash = createHash('sha256').update(rawBytes).digest('hex')
  const descriptor: EcdictSourceDescriptor = Object.freeze({
    sourceName: 'ECDICT',
    sourceRepository: 'https://github.com/skywind3000/ECDICT',
    sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
    sourcePath: 'ecdict.csv',
    sourceSha256: hash,
    sourceByteSize: rawBytes.byteLength,
    schemaVersion: 1,
    canonicalDownloadUrl:
      'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
  })
  return { descriptor, rawBytes }
}

describe('ECDICT Runtime Streaming Importer', () => {
  let testRoot: string
  let paths: ManagedStoragePaths

  function setupTestPaths(): void {
    testRoot = join(tmpdir(), `test-ecdict-importer-${randomUUID()}`)
    mkdirSync(testRoot, { recursive: true })
    paths = resolveManagedStoragePaths({ home: testRoot })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })
    mkdirSync(paths.databaseDirectory, { recursive: true })
  }

  function cleanupTestPaths(): void {
    try {
      rmSync(testRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  it('imports valid small synthetic CSV into a fully valid managed DB', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['apple', 'æpl', 'a fruit', '苹果', '', '1', '1', 'gk', '100', '50', 's:apples', '', ''],
        ['banana', 'bənɑːnə', 'yellow fruit', '香蕉', '', '2', '1', 'gk', '200', '60', '', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const progressEvents: EcdictImportProgress[] = []
      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        onProgress: (p) => progressEvents.push({ ...p }),
      })

      // Verification of result structure
      expect(result.entryCount).toBe(2)
      expect(result.formCount).toBe(1)
      expect(result.exampleCount).toBe(0)
      expect(result.ambiguousFormCount).toBe(0)
      expect(result.rejectedRowCount).toBe(0)
      expect(result.sourceRowCount).toBe(2)
      expect(typeof result.integrityCheckDurationMs).toBe('number')
      expect(result.integrityCheckDurationMs).toBeGreaterThanOrEqual(0)
      expect(result.schemaVersion).toBe(1)
      expect(result.sourceCommit).toBe(descriptor.sourceCommit)
      expect(result.sourceSha256).toBe(descriptor.sourceSha256)
      expect(result.databaseFile).toBe(managedDatabaseFileName(result.identity))
      expect(existsSync(result.path)).toBe(true)
      expect(result.fileSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.logicalSha256).toMatch(/^[0-9a-f]{64}$/)

      // Progress lifecycle verification
      const phases = progressEvents.map((e) => e.phase)
      expect(phases).toContain('verifying-source')
      expect(phases).toContain('preflighting')
      expect(phases).toContain('importing-entries')
      expect(phases).toContain('resolving-forms')
      expect(phases).toContain('inserting-forms')
      expect(phases).toContain('indexing')
      expect(phases).toContain('validating')
      expect(phases).toContain('publishing')
      expect(phases).toContain('complete')

      // Read-only SqliteDictionary lookup validation
      const dict = openSqliteDictionary({ path: result.path, readOnly: true })
      try {
        const apple = dict.lookup('apple')
        expect(apple.found).toBe(true)
        if (apple.found) {
          expect(apple.headword).toBe('apple')
          expect(apple.phonetic).toBe('æpl')
          expect(apple.senses[0]?.definition).toBe('a fruit')
          expect(apple.senses[0]?.translation).toBe('苹果')
          expect(apple.forms).toEqual([{ form: 'apples', kind: 's' }])
        }

        const apples = dict.lookup('apples')
        expect(apples.found).toBe(true)
        if (apples.found) {
          expect(apples.headword).toBe('apple')
          expect(apples.matchedForm).toBe('apples')
        }

        const banana = dict.lookup('banana')
        expect(banana.found).toBe(true)

        const orange = dict.lookup('orange')
        expect(orange.found).toBe(false)
      } finally {
        dict.close()
      }

      // No active.json was created
      expect(existsSync(paths.activeMetadataPath)).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails closed with zero DB mutations if cached source is missing', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['test', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor } = createSyntheticDescriptor(csv)
      const missingSource = join(paths.sourceCacheDirectory, 'nonexistent.csv')

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: missingSource,
        }),
      ).rejects.toThrow(/missing or failed verification/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
      expect(existsSync(paths.activeMetadataPath)).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails closed with zero DB mutations if cached source hash/size is invalid', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('hello,world')
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, 'different content entirely')

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
        }),
      ).rejects.toThrow(/missing or failed verification/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
      expect(existsSync(paths.activeMetadataPath)).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails closed and removes temp DB if CSV header schema is invalid', async () => {
    setupTestPaths()
    try {
      const wrongHeaderCsv = 'word,phonetic,definition\nfoo,bar,baz\n'
      const { descriptor, rawBytes } = createSyntheticDescriptor(wrongHeaderCsv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow(/ECDICT CSV header mismatch/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('handles UTF-8 BOM in CSV header cleanly', async () => {
    setupTestPaths()
    try {
      const plainCsv = createSyntheticCsv([['cat', 'kæt', 'feline', '猫', '', '', '', '', '', '', '', '', '']])
      const bomCsv = '\ufeff' + plainCsv
      const { descriptor, rawBytes } = createSyntheticDescriptor(bomCsv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })

      expect(result.entryCount).toBe(1)
      const dict = openSqliteDictionary({ path: result.path, readOnly: true })
      try {
        expect(dict.lookup('cat').found).toBe(true)
      } finally {
        dict.close()
      }
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails closed on fatal UTF-8 error during stream parsing without leaving candidate', async () => {
    setupTestPaths()
    try {
      const validHeader = EXPECTED_CORPUS_HEADER.join(',') + '\n'
      // Invalid UTF-8 sequence (0xFF, 0xFE)
      const invalidUtf8Buffer = Buffer.concat([
        Buffer.from(validHeader, 'utf8'),
        Buffer.from([0xff, 0xfe, 0x61, 0x62, 0x63, 0x0a]),
      ])
      const { descriptor } = createSyntheticDescriptor(invalidUtf8Buffer)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, invalidUtf8Buffer)

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow()

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects oversized fields and empty headwords according to bounds policy', async () => {
    setupTestPaths()
    try {
      const oversizedWord = 'a'.repeat(MAX_WORD_LENGTH + 1)
      const oversizedField = 'b'.repeat(MAX_FIELD_LENGTH + 1)

      const csv = createSyntheticCsv([
        ['validword', 'phon', 'def', 'trans', '', '', '', '', '10', '', '', '', ''],
        [oversizedWord, 'phon', 'def', 'trans', '', '', '', '', '10', '', '', '', ''], // oversized headword
        ['valid2', 'phon', oversizedField, 'trans', '', '', '', '', '10', '', '', '', ''], // oversized field
        ['', 'phon', 'def', 'trans', '', '', '', '', '10', '', '', '', ''], // empty headword
        ['   ', 'phon', 'def', 'trans', '', '', '', '', '10', '', '', '', ''], // whitespace headword
      ])

      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })

      // Only validword and valid2(rejected due to field) -> only validword is accepted
      expect(result.entryCount).toBe(1)
      const dict = openSqliteDictionary({ path: result.path, readOnly: true })
      try {
        expect(dict.lookup('validword').found).toBe(true)
        expect(dict.lookup('valid2').found).toBe(false)
      } finally {
        dict.close()
      }
    } finally {
      cleanupTestPaths()
    }
  })

  it('enforces duplicate headword rejection without silent overwrite', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['Duplicate', 'd1', 'first definition', '第一', '', '', '', '', '10', '', '', '', ''],
        ['duplicate', 'd2', 'second definition', '第二', '', '', '', '', '20', '', '', '', ''],
      ])

      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })

      expect(result.entryCount).toBe(1)
      const dict = openSqliteDictionary({ path: result.path, readOnly: true })
      try {
        const lookup = dict.lookup('duplicate')
        expect(lookup.found).toBe(true)
        if (lookup.found) {
          expect(lookup.senses[0]?.definition).toBe('first definition')
          expect(lookup.senses[0]?.translation).toBe('第一')
        }
      } finally {
        dict.close()
      }
    } finally {
      cleanupTestPaths()
    }
  })

  it('aborts cleanly before candidate creation when signal is already aborted', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const ac = new AbortController()
      ac.abort(new Error('Pre-abort'))

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          signal: ac.signal,
          verifyProbes: false,
        }),
      ).rejects.toThrow(/operation was aborted/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('aborts during entry import chunk loop and cleans up candidate and sidecars', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['word1', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['word2', '', '', '', '', '', '', '', '', '', '', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const ac = new AbortController()
      let yieldCalls = 0

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          signal: ac.signal,
          verifyProbes: false,
          yieldFn: async () => {
            yieldCalls++
            if (yieldCalls === 2) {
              ac.abort(new Error('Abort mid-chunk'))
            }
          },
        }),
      ).rejects.toThrow(/operation was aborted/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('aborts during forms phase and cleans up candidate', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['run', '', '', '', '', '', '', '', '', '', 'p:ran/d:run/i:running/s:runs', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const ac = new AbortController()

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          signal: ac.signal,
          verifyProbes: false,
          onProgress: (p) => {
            if (p.phase === 'inserting-forms') {
              ac.abort()
            }
          },
        }),
      ).rejects.toThrow(/operation was aborted/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('aborts before publication and leaves no final database', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['test', '', '', '', '', '', '', '', '', '', '', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const ac = new AbortController()

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          signal: ac.signal,
          verifyProbes: false,
          onProgress: (p) => {
            if (p.phase === 'publishing') {
              ac.abort()
            }
          },
        }),
      ).rejects.toThrow(/operation was aborted/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('isolates progress callback exceptions without corrupting the build', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['isolated', '', '', '', '', '', '', '', '', '', '', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const throwingCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback boom!')
      })

      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        onProgress: throwingCallback,
      })

      expect(result.entryCount).toBe(1)
      expect(throwingCallback).toHaveBeenCalled()
      expect(existsSync(result.path)).toBe(true)
    } finally {
      cleanupTestPaths()
    }
  })

  it('rejects concurrent same-process imports on identical databaseDirectory', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([
        ['slow', '', '', '', '', '', '', '', '', '', '', '', ''],
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      let releaseSlow = () => {}
      const slowPromise = new Promise<void>((r) => {
        releaseSlow = r
      })

      const firstBuild = buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
        yieldFn: async () => {
          await slowPromise
        },
      })

      // Second build while first is running
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow(EcdictImportInProgressError)

      releaseSlow()
      const firstResult = await firstBuild
      expect(firstResult.entryCount).toBe(1)
    } finally {
      cleanupTestPaths()
    }
  })

  it('releases concurrency lock after failure or abort', async () => {
    setupTestPaths()
    try {
      const { descriptor } = createSyntheticDescriptor('header\n')
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, 'invalid')

      // First call fails
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow()

      // Fix source file
      const validCsv = createSyntheticCsv([['ok', '', '', '', '', '', '', '', '', '', '', '', '']])
      const valid = createSyntheticDescriptor(validCsv)
      writeFileSync(sourceFile, valid.rawBytes)

      // Second call succeeds immediately (guard was released in finally)
      const secondResult = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor: valid.descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })
      expect(secondResult.entryCount).toBe(1)
    } finally {
      cleanupTestPaths()
    }
  })

  it('preserves foreign temporary and final artifacts on error cleanup', async () => {
    setupTestPaths()
    try {
      // Pre-create unrelated foreign artifacts
      const foreignFinal = join(paths.databaseDirectory, 'ecdict-foreign.sqlite3')
      const foreignTemp = join(paths.databaseDirectory, 'ecdict-other.sqlite3.tmp-abc123')
      writeFileSync(foreignFinal, 'database content')
      writeFileSync(foreignTemp, 'temp content')

      const invalidCsv = 'malformed'
      const { descriptor, rawBytes } = createSyntheticDescriptor(invalidCsv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: false,
        }),
      ).rejects.toThrow()

      // Assert foreign artifacts are untouched
      expect(existsSync(foreignFinal)).toBe(true)
      expect(existsSync(foreignTemp)).toBe(true)
      expect(readFileSync(foreignFinal, 'utf8')).toBe('database content')
      expect(readFileSync(foreignTemp, 'utf8')).toBe('temp content')
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails cleanly if final target database file already exists', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const fixedNonce = 'fixednonce01'
      const identity = generateManagedDatabaseIdentity(
        descriptor.schemaVersion,
        descriptor.sourceCommit,
        descriptor.sourceSha256,
        fixedNonce,
      )
      const finalTarget = managedDatabasePath(paths, identity)
      writeFileSync(finalTarget, 'already exists')

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          generateNonce: () => fixedNonce,
          verifyProbes: false,
        }),
      ).rejects.toThrow(/already exists at destination/)

      // Existing final database is preserved
      expect(readFileSync(finalTarget, 'utf8')).toBe('already exists')
    } finally {
      cleanupTestPaths()
    }
  })

  it('enforces exclusive candidate ownership and preserves foreign pre-existing candidate on collision', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const fixedNonce = 'fixednonce02'
      const identity = generateManagedDatabaseIdentity(
        descriptor.schemaVersion,
        descriptor.sourceCommit,
        descriptor.sourceSha256,
        fixedNonce,
      )
      const finalFileName = managedDatabaseFileName(identity)
      const collidedCandidateId = 'collided-candidate-id'
      const candidateSentinelPath = join(
        paths.databaseDirectory,
        `${finalFileName}.tmp-${collidedCandidateId}`,
      )
      const sentinelBytes = 'SENTINEL_FOREIGN_CANDIDATE_BYTES_DO_NOT_TOUCH'
      writeFileSync(candidateSentinelPath, sentinelBytes)

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          generateNonce: () => fixedNonce,
          generateCandidateId: () => collidedCandidateId,
          verifyProbes: false,
        }),
      ).rejects.toThrow(/Candidate file reservation collision \(EEXIST\)/)

      // Foreign pre-existing candidate remains byte-for-byte untouched
      expect(existsSync(candidateSentinelPath)).toBe(true)
      expect(readFileSync(candidateSentinelPath, 'utf8')).toBe(sentinelBytes)

      // No final database published
      const finalTarget = managedDatabasePath(paths, identity)
      expect(existsSync(finalTarget)).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('fails safely on publication-time final collision race and preserves foreign final bytes', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const fixedNonce = 'fixednonce03'
      const identity = generateManagedDatabaseIdentity(
        descriptor.schemaVersion,
        descriptor.sourceCommit,
        descriptor.sourceSha256,
        fixedNonce,
      )
      const finalTarget = managedDatabasePath(paths, identity)
      const foreignFinalSentinel = 'FOREIGN_FINAL_DB_SENTINEL_DO_NOT_OVERWRITE'

      // Simulate a concurrent process creating finalPath right during the validating phase
      // (AFTER initial existsSync check has already passed)
      let raceInjected = false
      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          generateNonce: () => fixedNonce,
          verifyProbes: false,
          onProgress: (p: EcdictImportProgress) => {
            if (p.phase === 'validating' && !raceInjected) {
              raceInjected = true
              writeFileSync(finalTarget, foreignFinalSentinel)
            }
          },
        }),
      ).rejects.toThrow()

      expect(raceInjected).toBe(true)
      // Foreign final must remain byte-for-byte unchanged
      expect(existsSync(finalTarget)).toBe(true)
      expect(readFileSync(finalTarget, 'utf8')).toBe(foreignFinalSentinel)

      // Candidate artifacts and sidecars cleaned up (only the foreign final remains)
      const dbDirFiles = readdirSync(paths.databaseDirectory)
      expect(dbDirFiles).toEqual([managedDatabaseFileName(identity)])

      // active.json was not created
      expect(existsSync(paths.activeMetadataPath)).toBe(false)
    } finally {
      cleanupTestPaths()
    }
  })

  it('exposes ambiguousFormCount, rejectedRowCount, and timing breakdown in build result', async () => {
    setupTestPaths()
    try {
      // 1 valid row, 1 duplicate row (rejected), and forms with ambiguous mappings
      const csv = createSyntheticCsv([
        ['apple', '', '', '', '', '', '', '', '', '', 'p:apples', '', ''],
        ['apple', '', '', '', '', '', '', '', '', '', 'p:apples', '', ''], // Duplicate headword -> rejected
        ['orange', '', '', '', '', '', '', '', '', '', 'p:apples', '', ''], // 'apples' mapped to both apple and orange -> ambiguous
      ])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const result = await buildManagedEcdictDatabaseInternal(paths, {
        descriptor,
        sourcePath: sourceFile,
        verifyProbes: false,
      })

      expect(result.entryCount).toBe(2) // apple + orange
      expect(result.rejectedRowCount).toBe(1) // 1 duplicate rejected
      expect(result.sourceRowCount).toBe(3)
      expect(result.ambiguousFormCount).toBe(1) // 'apples' is ambiguous
      expect(result.formCount).toBe(0) // 0 unambiguous forms
      expect(typeof result.integrityCheckDurationMs).toBe('number')
      expect(result.integrityCheckDurationMs).toBeGreaterThanOrEqual(0)
      expect(result.phaseTimings).toBeDefined()
      expect(typeof result.phaseTimings?.integrityCheck).toBe('number')
      expect(typeof result.phaseTimings?.entryImport).toBe('number')
      expect(typeof result.phaseTimings?.publication).toBe('number')
    } finally {
      cleanupTestPaths()
    }
  })

  it('cleans up candidate if PRAGMA integrity_check fails', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      // Mock sqlite factory that returns a DB where integrity_check is hijacked or corrupt
      const customFactory = (dbPath: string): DatabaseSync => {
        const realDb = new DatabaseSync(dbPath)
        const origPrepare = realDb.prepare.bind(realDb)
        realDb.prepare = (sql: string) => {
          if (sql.includes('integrity_check')) {
            return {
              all: () => [{ integrity_check: 'corruption detected!' }],
              get: () => ({ integrity_check: 'corruption detected!' }),
            } as any
          }
          return origPrepare(sql)
        }
        return realDb
      }

      await expect(
        buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          sqliteFactory: customFactory,
          verifyProbes: false,
        }),
      ).rejects.toThrow(/PRAGMA integrity_check/)

      const dbFiles = readdirSync(paths.databaseDirectory)
      expect(dbFiles).toEqual([])
    } finally {
      cleanupTestPaths()
    }
  })

  it('validates canonical probes function correctly', () => {
    // Test probe validator with in-memory DB
    const db = new DatabaseSync(':memory:')
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
        id INTEGER PRIMARY KEY,
        headword TEXT NOT NULL COLLATE NOCASE,
        english TEXT NOT NULL,
        chinese TEXT,
        source TEXT,
        source_id TEXT,
        score REAL
      );
    `)

    // Insert required probe words
    for (const word of REQUIRED_PROBE_WORDS) {
      db.prepare('INSERT INTO entries (word) VALUES (?)').run(word)
    }

    // Insert canonical form inflections
    for (const rel of CANONICAL_FORM_RELATIONSHIPS) {
      for (const form of rel.expectedForms) {
        db.prepare('INSERT INTO forms (form, headword) VALUES (?, ?)').run(
          form,
          rel.headword,
        )
      }
    }

    // Mock dictionary with real lookups against db
    const mockDict = {
      lookup: (query: string) => {
        if (query === 'Wave Function') {
          return {
            found: true,
            headword: 'wave function',
            matchedForm: null,
            forms: [],
          }
        }
        const exact = db
          .prepare('SELECT word FROM entries WHERE word = ?')
          .get(query) as { word: string } | undefined
        if (exact) {
          const forms = db
            .prepare('SELECT form FROM forms WHERE headword = ?')
            .all(exact.word) as unknown as Array<{ form: string }>
          return {
            found: true,
            headword: exact.word,
            matchedForm: null,
            forms: forms.map((f) => ({ form: f.form, kind: null })),
          }
        }
        const form = db
          .prepare('SELECT headword FROM forms WHERE form = ?')
          .get(query) as { headword: string } | undefined
        if (form) {
          return {
            found: true,
            headword: form.headword,
            matchedForm: query,
            forms: [],
          }
        }
        return { found: false, query, forms: [] }
      },
    }

    expect(() => verifyCandidateProbes(mockDict as any)).not.toThrow()

    // Test missing probe word throws
    const incompleteDict = {
      lookup: (query: string) => {
        if (query === 'go') return { found: false, query, forms: [] }
        return mockDict.lookup(query)
      },
    }
    expect(() => verifyCandidateProbes(incompleteDict as any)).toThrow(/probe word "go"/)
  })

  it('preserves cleanup failure when both import and cleanup fail', async () => {
    setupTestPaths()
    try {
      const csv = createSyntheticCsv([['word', '', '', '', '', '', '', '', '', '', '', '', '']])
      const { descriptor, rawBytes } = createSyntheticDescriptor(csv)
      const sourceFile = join(paths.sourceCacheDirectory, 'ecdict.csv')
      writeFileSync(sourceFile, rawBytes)

      const failingUnlink = async () => {
        const err = new Error('Simulated cleanup EPERM error') as any
        err.code = 'EPERM'
        throw err
      }

      let caughtError: any = null
      try {
        await buildManagedEcdictDatabaseInternal(paths, {
          descriptor,
          sourcePath: sourceFile,
          verifyProbes: true, // Will fail on probes because synthetic CSV lacks probe words
          unlinkFn: failingUnlink,
        })
      } catch (err) {
        caughtError = err
      }
      expect(caughtError).toBeDefined()
      expect(caughtError instanceof AggregateError).toBe(true)
      expect((caughtError as AggregateError).errors.some((e: any) => e.code === 'EPERM')).toBe(true)
    } finally {
      cleanupTestPaths()
    }
  })

  it('strictly adheres to Host startup boundary (apply() remains fixture-only)', () => {
    let registeredPath = ''
    const mockCtx = {
      effect: vi.fn((fn: () => void) => fn()),
      connection: {
        fetch: {
          register: vi.fn(({ path }: { path: string }) => {
            registeredPath = path
            return vi.fn()
          }),
        },
      },
    }

    const config = Config(undefined)
    apply(mockCtx as any, config)

    expect(mockCtx.effect).toHaveBeenCalled()
    expect(mockCtx.connection.fetch.register).toHaveBeenCalled()
    expect(registeredPath).toBe('/api/dsh-word-lookup')
  })

  it('audits package root exports to ensure internal test seams are never exposed', () => {
    // Verify required public exports exist
    expect(typeof indexExports.buildManagedEcdictDatabase).toBe('function')
    expect(typeof indexExports.EcdictImportInProgressError).toBe('function')
    expect(typeof indexExports.downloadPinnedEcdict).toBe('function')
    expect(typeof indexExports.loadPinnedEcdictSourceDescriptor).toBe('function')

    // Verify test-only internals are NOT exported from package root
    const rootExportKeys = Object.keys(indexExports)
    expect(rootExportKeys).not.toContain('buildManagedEcdictDatabaseInternal')
    expect(rootExportKeys).not.toContain('buildCorpus')
    expect(rootExportKeys).not.toContain('sqliteFactory')
    expect(rootExportKeys).not.toContain('generateNonce')
    expect(rootExportKeys).not.toContain('yieldFn')
    expect(rootExportKeys).not.toContain('verifyCandidateProbes')
  })
})
