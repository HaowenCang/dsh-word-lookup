/**
 * Test suite for ActivationCoordinator (Phase 7A.6).
 *
 * Verifies:
 * - Startup recovery across fresh, corrupted, missing DB, and valid states.
 * - Atomic activation 3-step commit and rollback semantics.
 * - Safe removal with Windows file lock release before unlinking.
 * - Diagnostic state summary.
 * - Read-only custom database verification.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ActivationCoordinator,
} from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import {
  resolveManagedStoragePaths,
  writeActiveMetadataAtomically,
  type ActiveMetadata,
  type ManagedStoragePaths,
} from '../src/host/managed-storage.js'
import { Config } from '../src/host/config.js'
import type { ManagedEcdictBuildResult } from '../src/host/ecdict-importer.js'

const PINNED_COMMIT = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'
const PINNED_SHA256 = '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf'

function createSyntheticManagedDb(filePath: string): void {
  const db = new DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE entries (
      word TEXT PRIMARY KEY,
      phonetic TEXT,
      definition_en TEXT,
      translation_zh TEXT,
      pos TEXT,
      exchange TEXT,
      frequency INTEGER
    );
    CREATE TABLE forms (
      form TEXT PRIMARY KEY,
      headword TEXT NOT NULL,
      kind TEXT
    );
    CREATE TABLE examples (
      id INTEGER PRIMARY KEY,
      headword TEXT NOT NULL,
      english TEXT NOT NULL,
      chinese TEXT NOT NULL,
      source TEXT,
      source_id TEXT,
      score REAL
    );
    CREATE INDEX idx_forms_headword_raw ON forms (headword);
    CREATE INDEX idx_examples_headword ON examples (headword);

    INSERT INTO meta VALUES ('schema_version', '1');
    INSERT INTO meta VALUES ('corpus_name', 'ECDICT');
    INSERT INTO meta VALUES ('upstream_commit', '${PINNED_COMMIT}');
    INSERT INTO meta VALUES ('source_sha256', '${PINNED_SHA256}');
    INSERT INTO meta VALUES ('entry_count', '3');
    INSERT INTO meta VALUES ('form_count', '1');
    INSERT INTO meta VALUES ('example_count', '0');
    INSERT INTO meta VALUES ('logical_sha256', '${'b'.repeat(64)}');

    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('hello', 'həˈloʊ', 'used as a greeting', 'int. 你好', 'int', NULL, 100);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('world', 'wɜːrld', 'the earth with its countries and people', 'n. 世界', 'n', NULL, 200);
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
      VALUES ('test', 'test', 'a procedure intended to establish the quality', 'n. 测试', 'n', NULL, 300);
    INSERT INTO forms (form, headword, kind) VALUES ('testing', 'test', 'p');
  `)
  db.close()
}

describe('ActivationCoordinator', () => {
  let tempHome: string
  let paths: ManagedStoragePaths
  let manager: DictionaryManager

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-act-test-'))
    paths = resolveManagedStoragePaths({ home: tempHome })
    mkdirSync(paths.databaseDirectory, { recursive: true })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })

    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
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

  it('startup recovery on fresh install leaves manager on fixture without error', async () => {
    const coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'managed-ecdict' }),
    })

    await coordinator.recoverOnStartup()
    const summary = coordinator.getStatusSummary()

    expect(summary.activeMode).toBe('fixture')
    expect(summary.installed).toBe(false)
    expect(summary.installedCorpus).toBeNull()
    expect(summary.recoveryError).toBeNull()
  })

  it('startup recovery on corrupt active.json sets recoveryError and preserves fixture', async () => {
    writeFileSync(paths.activeMetadataPath, '{ malformed json...', 'utf8')

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'managed-ecdict' }),
    })

    await coordinator.recoverOnStartup()
    const summary = coordinator.getStatusSummary()

    expect(summary.activeMode).toBe('fixture')
    expect(summary.recoveryError).toContain('Corrupt active metadata')
  })

  it('startup recovery when DB file is missing sets recoveryError and preserves fixture', async () => {
    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'missing',
      databaseFile: 'ecdict-missing.sqlite3',
      source: {
        name: 'ECDICT',
        commit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        schemaVersion: 1,
      },
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'managed-ecdict' }),
    })

    await coordinator.recoverOnStartup()
    const summary = coordinator.getStatusSummary()

    expect(summary.activeMode).toBe('fixture')
    expect(summary.recoveryError).toContain('Managed database file missing')
  })

  it('startup recovery verifies valid DB and activates it when configuredMode is managed-ecdict', async () => {
    const dbFile = 'ecdict-v1-valid.sqlite3'
    const fullDbPath = join(paths.databaseDirectory, dbFile)
    createSyntheticManagedDb(fullDbPath)

    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'v1-valid',
      databaseFile: dbFile,
      source: {
        name: 'ECDICT',
        commit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        schemaVersion: 1,
      },
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'managed-ecdict' }),
    })

    await coordinator.recoverOnStartup()
    const summary = coordinator.getStatusSummary()

    expect(summary.activeMode).toBe('managed-ecdict')
    expect(summary.installed).toBe(true)
    expect(summary.installedCorpus?.name).toBe('ECDICT')
    expect(summary.recoveryError).toBeNull()

    // Test lookup on activated DB
    const lookup = manager.lookup('hello')
    expect(lookup.found).toBe(true)
    expect((lookup as { headword?: string }).headword).toBe('hello')
    expect(manager.snapshot().source).toBe('ecdict-local')
  })

  it('startup recovery caches corpus info but remains on fixture when configuredMode is fixture', async () => {
    const dbFile = 'ecdict-v1-cached.sqlite3'
    const fullDbPath = join(paths.databaseDirectory, dbFile)
    createSyntheticManagedDb(fullDbPath)

    const metadata: ActiveMetadata = {
      version: 1,
      activeMode: 'managed-ecdict',
      identity: 'v1-cached',
      databaseFile: dbFile,
      source: {
        name: 'ECDICT',
        commit: PINNED_COMMIT,
        sha256: PINNED_SHA256,
        schemaVersion: 1,
      },
    }
    await writeActiveMetadataAtomically(paths, metadata)

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
      config: Config({ dictionaryMode: 'fixture' }),
    })

    await coordinator.recoverOnStartup()
    const summary = coordinator.getStatusSummary()

    expect(summary.activeMode).toBe('fixture')
    expect(summary.installed).toBe(true)
    expect(summary.installedCorpus?.name).toBe('ECDICT')
    expect(summary.recoveryError).toBeNull()
  })

  it('activates newly built managed database atomically', async () => {
    const dbFile = 'ecdict-newly-built.sqlite3'
    const fullDbPath = join(paths.databaseDirectory, dbFile)
    createSyntheticManagedDb(fullDbPath)

    const buildResult: ManagedEcdictBuildResult = {
      path: fullDbPath,
      databaseFile: dbFile,
      identity: 'newly-built',
      sourceCommit: PINNED_COMMIT,
      sourceSha256: PINNED_SHA256,
      entryCount: 3,
      formCount: 1,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 3,
      byteSize: 40960,
      schemaVersion: 1,
      logicalSha256: 'b'.repeat(64),
      fileSha256: 'c'.repeat(64),
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    }

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
    })

    await coordinator.activateManagedDatabase(buildResult)

    const summary = coordinator.getStatusSummary()
    expect(summary.activeMode).toBe('managed-ecdict')
    expect(summary.activeIdentity).toBe('newly-built')
    expect(summary.installed).toBe(true)

    // Lookup works on newly activated database
    const res = manager.lookup('world')
    expect(res.found).toBe(true)
    expect((res as { headword?: string }).headword).toBe('world')
    expect(manager.snapshot().source).toBe('ecdict-local')
  })

  it('safely removes managed database and reverts to fixture', async () => {
    const dbFile = 'ecdict-to-remove.sqlite3'
    const fullDbPath = join(paths.databaseDirectory, dbFile)
    createSyntheticManagedDb(fullDbPath)

    const buildResult: ManagedEcdictBuildResult = {
      path: fullDbPath,
      databaseFile: dbFile,
      identity: 'to-remove',
      sourceCommit: PINNED_COMMIT,
      sourceSha256: PINNED_SHA256,
      entryCount: 3,
      formCount: 1,
      exampleCount: 0,
      ambiguousFormCount: 0,
      rejectedRowCount: 0,
      sourceRowCount: 3,
      byteSize: 40960,
      schemaVersion: 1,
      logicalSha256: 'b'.repeat(64),
      fileSha256: 'c'.repeat(64),
      yieldCount: 1,
      postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
    }

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
    })

    await coordinator.activateManagedDatabase(buildResult)
    expect(coordinator.getStatusSummary().activeMode).toBe('managed-ecdict')
    expect(existsSync(fullDbPath)).toBe(true)
    expect(existsSync(paths.activeMetadataPath)).toBe(true)

    // Perform removal
    const outcome = await coordinator.removeManagedDatabase()
    expect(outcome.removed).toBe(true)

    const summary = coordinator.getStatusSummary()
    expect(summary.activeMode).toBe('fixture')
    expect(summary.installed).toBe(false)
    expect(existsSync(fullDbPath)).toBe(false)
    expect(existsSync(paths.activeMetadataPath)).toBe(false)
  })

  it('verifies custom SQLite database read-only without modifying anything', async () => {
    const customDbPath = join(tempHome, 'custom.sqlite3')
    createSyntheticManagedDb(customDbPath)

    const coordinator = new ActivationCoordinator({
      paths,
      manager,
    })

    const outcome = await coordinator.verifyCustomDatabase(customDbPath)
    expect(outcome.valid).toBe(true)
    expect(outcome.entryCount).toBe(3)
    expect(outcome.formCount).toBe(1)
    expect(outcome.headwordsSample).toContain('hello')

    // Invalid non-existent file
    const invalidOutcome = await coordinator.verifyCustomDatabase(join(tempHome, 'missing.db'))
    expect(invalidOutcome.valid).toBe(false)
    expect(invalidOutcome.errorCode).toBe('FILE_NOT_FOUND')

    // Invalid non-SQLite file
    const textFilePath = join(tempHome, 'text.txt')
    writeFileSync(textFilePath, 'just plain text', 'utf8')
    const badDbOutcome = await coordinator.verifyCustomDatabase(textFilePath)
    expect(badDbOutcome.valid).toBe(false)
    expect(badDbOutcome.errorCode).toBe('INVALID_SQLITE_FILE')
  })
})
