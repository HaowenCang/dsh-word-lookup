/**
 * Verifies complete removal of legacy environment variable mechanisms:
 * - DSH_WORD_LOOKUP_DB_PATH
 * - CORPUS_PATH_ENV
 * - process.env
 *
 * Verifies that host runtime uses fixture only in Phase 7A.1, and that
 * any process environment variables are strictly ignored with zero side-effects.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config } from '../src/host/config.js'
import { resolveProductionDatabasePath } from '../src/host/corpus-db.js'
import { apply } from '../src/index.js'
import * as indexExports from '../src/index.js'
import * as corpusDbExports from '../src/host/corpus-db.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(REPO_ROOT, 'src')

function getAllSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(full))
    } else if (/\.(?:[cm]?[jt]sx?|[cm]?ts)$/i.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

describe('Legacy environment variable removal — Static analysis', () => {
  const sourceFiles = getAllSourceFiles(SRC_DIR)

  it('scans all src files and confirms zero process.env occurrences', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8')
      expect(content, `File ${file} must not contain process.env`).not.toMatch(/\bprocess\s*\.\s*env\b/)
    }
  })

  it('scans all src files and confirms zero DSH_WORD_LOOKUP_DB_PATH occurrences', () => {
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8')
      expect(content, `File ${file} must not contain DSH_WORD_LOOKUP_DB_PATH`).not.toContain('DSH_WORD_LOOKUP_DB_PATH')
    }
  })

  it('scans all src files and confirms zero CORPUS_PATH_ENV occurrences', () => {
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8')
      expect(content, `File ${file} must not contain CORPUS_PATH_ENV`).not.toContain('CORPUS_PATH_ENV')
    }
  })

  it('confirms CORPUS_PATH_ENV is not exported by src/index.ts or src/host/corpus-db.ts', () => {
    expect('CORPUS_PATH_ENV' in indexExports).toBe(false)
    expect('CORPUS_PATH_ENV' in corpusDbExports).toBe(false)
  })
})

describe('Legacy environment variable removal — Runtime isolation', () => {
  const LEGACY_VAR = 'DSH_WORD_LOOKUP_DB_PATH'

  afterEach(() => {
    delete process.env[LEGACY_VAR]
  })

  it('resolveProductionDatabasePath ignores legacy environment variable', () => {
    process.env[LEGACY_VAR] = '/nonexistent/host/override.db'
    const defaultResolved = resolveProductionDatabasePath()
    expect(defaultResolved).not.toContain('/nonexistent/host/override.db')
    expect(defaultResolved).toContain(join('build', 'corpus', 'ecdict.db'))
  })

  it('Host startup (apply) always activates fixture and ignores DSH_WORD_LOOKUP_DB_PATH', async () => {
    // In Phase 6.1, setting DSH_WORD_LOOKUP_DB_PATH to a nonexistent path caused apply() to fail
    // with DictionaryUnavailableError. In Phase 7A.1, the environment variable is ignored,
    // and the host safely boots with the fixture dictionary.
    process.env[LEGACY_VAR] = 'C:\\nonexistent\\corrupted\\ecdict.db'

    let registeredPath = ''
    let registeredHandler: ((req: Request) => Promise<Response>) | null = null

    const mockCtx = {
      effect: (fn: () => () => Promise<void>) => {
        return fn()
      },
      connection: {
        fetch: {
          register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            registeredPath = spec.path
            registeredHandler = spec.fetch
            return async () => {}
          },
        },
      },
    }

    const config = Config({})
    let cleanup: (() => Promise<void>) | undefined

    expect(() => {
      cleanup = (apply as any)(mockCtx, config)
    }).not.toThrow()

    expect(registeredPath).toBe('/api/dsh-word-lookup')
    expect(typeof registeredHandler).toBe('function')

    if (registeredHandler) {
      const req = new Request('http://127.0.0.1:50001/api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      })
      const res = await (registeredHandler as (req: Request) => Promise<Response>)(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.found).toBe(true)
      expect(data.source).toBe('sqlite-fixture')
    }

    if (cleanup) {
      await cleanup()
    }
  })
})
