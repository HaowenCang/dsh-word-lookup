/**
 * Test suite for Dictionary Management HTTP Routes (Phase 7A.6).
 *
 * Verifies:
 * - 5 pure route handlers (GET status, POST install, POST cancel, POST remove, POST verify).
 * - HTTP method enforcement (405).
 * - Request payload size limits (<= 64 KiB, 413).
 * - Content-Type validation (415).
 * - Header sanitization (`cache-control: no-store`).
 * - Security gates: rejection of forbidden installation override parameters.
 * - Error sanitization: elimination of machine paths from messages.
 * - Rollback on registration failure.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createActivateCustomHandler,
  createCancelHandler,
  createInstallHandler,
  createRemoveHandler,
  createSelectModeHandler,
  createStatusHandler,
  createVerifyHandler,
  registerDictionaryManagementRoutes,
} from '../src/host/dictionary-management-route.js'
import { DictionaryOperationManager } from '../src/host/dictionary-operations.js'
import { ActivationCoordinator } from '../src/host/dictionary-activation.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
import { resolveManagedStoragePaths, type ManagedStoragePaths } from '../src/host/managed-storage.js'
import {
  MANAGEMENT_ACTIVATE_CUSTOM_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_SELECT_MODE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
} from '../src/host/route.js'
import * as downloader from '../src/host/ecdict-downloader.js'
import * as importer from '../src/host/ecdict-importer.js'

function jsonPostRequest(url: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('Dictionary Management Route Handlers', () => {
  let tempHome: string
  let paths: ManagedStoragePaths
  let manager: DictionaryManager
  let coordinator: ActivationCoordinator
  let opMan: DictionaryOperationManager

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-route-test-'))
    paths = resolveManagedStoragePaths({ home: tempHome })
    mkdirSync(paths.databaseDirectory, { recursive: true })
    mkdirSync(paths.sourceCacheDirectory, { recursive: true })

    manager = new DictionaryManager({
      mode: 'fixture',
      identity: 'fixture',
      dictionary: openFixtureDictionary(),
    })
    coordinator = new ActivationCoordinator({
      paths,
      manager,
    })
    opMan = new DictionaryOperationManager({
      paths,
      activationCoordinator: coordinator,
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

  describe('GET /api/dsh-word-lookup/dictionary/status', () => {
    it('returns 405 on non-GET request', async () => {
      const handler = createStatusHandler(opMan, coordinator)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'POST' }))
      expect(res.status).toBe(405)
      const data = await res.json()
      expect(data.error).toBe('METHOD_NOT_ALLOWED')
    })

    it('returns status payload with cache-control no-store', async () => {
      const handler = createStatusHandler(opMan, coordinator)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-type')).toContain('application/json')

      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.activeMode).toBe('fixture')
      expect(data.installed).toBe(false)
      expect(data.canInstall).toBe(true)
      expect(data.canCancel).toBe(false)
      expect(data.currentOperation).toBeNull()
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/install', () => {
    it('returns 405 on non-POST request', async () => {
      const handler = createInstallHandler(opMan)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_INSTALL_PATH, { method: 'GET' }))
      expect(res.status).toBe(405)
    })

    it('returns 415 when Content-Type is not application/json', async () => {
      const handler = createInstallHandler(opMan)
      const req = new Request('http://localhost' + MANAGEMENT_INSTALL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'test',
      })
      const res = await handler(req)
      expect(res.status).toBe(415)
      const data = await res.json()
      expect(data.error).toBe('UNSUPPORTED_MEDIA_TYPE')
    })

    it('returns 413 when body exceeds 64 KiB', async () => {
      const handler = createInstallHandler(opMan)
      const hugeObject = { padding: 'a'.repeat(70000) }
      const req = jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, hugeObject)
      const res = await handler(req)
      expect(res.status).toBe(413)
      const data = await res.json()
      expect(data.error).toBe('BODY_TOO_LARGE')
    })

    it('strictly forbids custom installation override parameters', async () => {
      const handler = createInstallHandler(opMan)
      const req = jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, {
        downloadUrl: 'https://malicious.site/ecdict.csv',
      })
      const res = await handler(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('BAD_REQUEST')
      expect(data.message).toContain('downloadUrl')
    })

    it('accepts valid install request and returns 200 with operationId', async () => {
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async () => {
        return {
          path: join(tempHome, 'source.csv'),
          sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
          sha256: 'a'.repeat(64),
          byteSize: 100,
          reused: false,
          redirectCount: 0,
        }
      })
      vi.spyOn(importer, 'buildManagedEcdictDatabase').mockImplementation(async () => {
        return {
          path: join(tempHome, 'ecdict.sqlite3'),
          databaseFile: 'ecdict.sqlite3',
          identity: 'test',
          sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
          sourceSha256: 'a'.repeat(64),
          entryCount: 1,
          formCount: 0,
          exampleCount: 0,
          ambiguousFormCount: 0,
          rejectedRowCount: 0,
          sourceRowCount: 1,
          byteSize: 40960,
          schemaVersion: 1,
          logicalSha256: 'b'.repeat(64),
          fileSha256: 'c'.repeat(64),
          yieldCount: 1,
          postPublicationCleanup: { candidateRemoved: true, sidecarsRemoved: true },
        }
      })
      vi.spyOn(coordinator, 'activateManagedDatabase').mockResolvedValue(undefined)

      const handler = createInstallHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, {}))
      expect(res.status).toBe(200)

      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.status).toBe('running')
      expect(data.phase).toBe('queued')
      expect(typeof data.operationId).toBe('string')
    })

    it('returns 409 when installation is already running', async () => {
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_p, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const handler = createInstallHandler(opMan)
      const firstRes = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, {}))
      expect(firstRes.status).toBe(200)

      // Concurrent request
      const secondRes = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, {}))
      expect(secondRes.status).toBe(409)
      const data = await secondRes.json()
      expect(data.error).toBe('OPERATION_IN_PROGRESS')

      await opMan.dispose(50)
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/cancel', () => {
    it('returns 400 when operationId is missing or empty', async () => {
      const handler = createCancelHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_CANCEL_PATH, {}))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('INVALID_OPERATION_ID')
    })

    it('returns 404 when operationId is not found', async () => {
      const handler = createCancelHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_CANCEL_PATH, { operationId: 'unknown-id' }))
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('OPERATION_NOT_FOUND')
    })

    it('successfully dispatches cancel to in-flight operation', async () => {
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_paths, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })

      const installHandler = createInstallHandler(opMan)
      const installRes = await installHandler(jsonPostRequest('http://localhost' + MANAGEMENT_INSTALL_PATH, {}))
      const { operationId } = await installRes.json()

      const cancelHandler = createCancelHandler(opMan)
      const cancelRes = await cancelHandler(jsonPostRequest('http://localhost' + MANAGEMENT_CANCEL_PATH, { operationId }))
      expect(cancelRes.status).toBe(200)
      const cancelData = await cancelRes.json()
      expect(cancelData.ok).toBe(true)
      expect(cancelData.status).toBe('cancelling')
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/remove', () => {
    it('returns 405 on non-POST', async () => {
      const handler = createRemoveHandler(opMan, coordinator)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_REMOVE_PATH, { method: 'GET' }))
      expect(res.status).toBe(405)
    })

    it('returns 409 when installation is in progress', async () => {
      vi.spyOn(downloader, 'downloadPinnedEcdict').mockImplementation(async (_p, opts) => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
      opMan.install()

      const handler = createRemoveHandler(opMan, coordinator)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_REMOVE_PATH, {}))
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toBe('OPERATION_IN_PROGRESS')

      await opMan.dispose(50)
    })

    it('successfully removes dictionary and returns 200', async () => {
      vi.spyOn(coordinator, 'removeManagedDatabase').mockResolvedValue({ removed: true, activeMode: 'fixture' })

      const handler = createRemoveHandler(opMan, coordinator)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_REMOVE_PATH, {}))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.removed).toBe(true)
      expect(data.activeMode).toBe('fixture')
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/verify', () => {
    it('returns 400 when path is missing or exceeds 1024 chars', async () => {
      const handler = createVerifyHandler(coordinator)

      const resMissing = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_VERIFY_PATH, {}))
      expect(resMissing.status).toBe(400)
      expect((await resMissing.json()).error).toBe('INVALID_PATH')

      const resTooLong = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_VERIFY_PATH, { path: 'a'.repeat(1025) }))
      expect(resTooLong.status).toBe(400)
      expect((await resTooLong.json()).error).toBe('INVALID_PATH')
    })

    it('returns 400 when verifying non-existent database file', async () => {
      const handler = createVerifyHandler(coordinator)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_VERIFY_PATH, { path: join(tempHome, 'missing.db') }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('FILE_NOT_FOUND')
    })

    it('returns 200 with schema and counts on valid custom database', async () => {
      const customDbPath = join(tempHome, 'valid-custom.sqlite3')
      const db = new DatabaseSync(customDbPath)
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
          english TEXT,
          chinese TEXT,
          source TEXT,
          source_id TEXT,
          score REAL
        );
        CREATE INDEX idx_forms_headword_raw ON forms(headword);
        CREATE INDEX idx_examples_headword ON examples(headword);
        INSERT INTO meta VALUES ('schema_version', '1');
        INSERT INTO entries VALUES ('word1', 'w', 'def', 'trans', 'n', '', 1);
        INSERT INTO forms VALUES ('word1s', 'word1', 'p');
      `)
      db.close()

      const handler = createVerifyHandler(coordinator)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_VERIFY_PATH, { path: customDbPath }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.valid).toBe(true)
      expect(data.entryCount).toBe(1)
      expect(data.formCount).toBe(1)
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/activate-custom', () => {
    it('returns 405 on non-POST', async () => {
      const handler = createActivateCustomHandler(opMan)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, { method: 'GET' }))
      expect(res.status).toBe(405)
    })

    it('returns 400 when path is missing or invalid', async () => {
      const handler = createActivateCustomHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {}))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('INVALID_PATH')
    })

    it('returns 400 when identity has invalid characters', async () => {
      const handler = createActivateCustomHandler(opMan)
      const res = await handler(
        jsonPostRequest('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
          path: '/path/to/dict.sqlite3',
          identity: 'bad identity with spaces!',
        }),
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('INVALID_ARGUMENT')
    })

    it('accepts valid request and delegates to operationManager.activateCustom', async () => {
      vi.spyOn(opMan, 'activateCustom').mockResolvedValue({
        ok: true,
        operationId: 'activate-custom-123',
        activeMode: 'custom',
        identity: 'test-custom',
        snapshotId: 'snap-12345',
        message: 'Custom dictionary activated successfully',
      })

      const handler = createActivateCustomHandler(opMan)
      const res = await handler(
        jsonPostRequest('http://localhost' + MANAGEMENT_ACTIVATE_CUSTOM_PATH, {
          path: join(tempHome, 'test.sqlite3'),
          identity: 'test-custom',
        }),
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.snapshotId).toBe('snap-12345')
    })
  })

  describe('POST /api/dsh-word-lookup/dictionary/select-mode', () => {
    it('returns 405 on non-POST', async () => {
      const handler = createSelectModeHandler(opMan)
      const res = await handler(new Request('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, { method: 'GET' }))
      expect(res.status).toBe(405)
    })

    it('returns 400 when mode is invalid', async () => {
      const handler = createSelectModeHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, { mode: 'invalid' }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('INVALID_ARGUMENT')
    })

    it('returns 400 when mode is custom but snapshotId is missing', async () => {
      const handler = createSelectModeHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, { mode: 'custom' }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('INVALID_ARGUMENT')
    })

    it('accepts valid mode switch request and delegates to operationManager.selectMode', async () => {
      vi.spyOn(opMan, 'selectMode').mockResolvedValue({
        ok: true,
        operationId: 'switch-mode-123',
        activeMode: 'fixture',
        identity: 'fixture',
        message: 'Switched to fixture',
      })

      const handler = createSelectModeHandler(opMan)
      const res = await handler(jsonPostRequest('http://localhost' + MANAGEMENT_SELECT_MODE_PATH, { mode: 'fixture' }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.activeMode).toBe('fixture')
    })
  })

  describe('registerDictionaryManagementRoutes', () => {
    it('registers all 7 routes and returns clean disposer', async () => {
      const registeredPaths: string[] = []
      const mockCtx = {
        connection: {
          fetch: {
            register: vi.fn((spec: { path: string }) => {
              registeredPaths.push(spec.path)
              return async () => {
                const idx = registeredPaths.indexOf(spec.path)
                if (idx !== -1) registeredPaths.splice(idx, 1)
              }
            }),
          },
        },
      }

      const dispose = registerDictionaryManagementRoutes(mockCtx as any, opMan, coordinator)
      expect(registeredPaths).toHaveLength(7)
      expect(registeredPaths).toContain(MANAGEMENT_STATUS_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_INSTALL_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_CANCEL_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_REMOVE_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_VERIFY_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_ACTIVATE_CUSTOM_PATH)
      expect(registeredPaths).toContain(MANAGEMENT_SELECT_MODE_PATH)

      // Unregister
      await dispose()
      expect(registeredPaths).toHaveLength(0)
    })

    it('rolls back registered routes when a registration throws', () => {
      const disposedPaths: string[] = []
      let callCount = 0

      const mockCtx = {
        connection: {
          fetch: {
            register: vi.fn((spec: { path: string }) => {
              callCount++
              if (callCount === 3) {
                throw new Error('Registration conflict on 3rd route')
              }
              return async () => {
                disposedPaths.push(spec.path)
              }
            }),
          },
        },
      }

      expect(() => {
        registerDictionaryManagementRoutes(mockCtx as any, opMan, coordinator)
      }).toThrow('Registration conflict on 3rd route')

      // Rollback must have disposed the first 2 registered routes
      expect(disposedPaths).toHaveLength(2)
    })
  })
})
