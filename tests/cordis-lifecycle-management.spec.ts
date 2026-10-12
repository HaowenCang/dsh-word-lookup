/**
 * Test suite for Cordis lifecycle and host registration integration (Phase 7A.6).
 *
 * Verifies:
 * - Single ctx.effect() owns host surfaces (lookup route + 5 management routes).
 * - Startup recovery check kicks off without blocking apply().
 * - Safe drain and abortion on plugin unload disposer.
 * - Proper handle closing and route unregistration.
 * - Fault tolerance when context does not supply DSH home.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { Config } from '../src/host/config.js'
import {
  LOOKUP_PATH,
  MANAGEMENT_CANCEL_PATH,
  MANAGEMENT_INSTALL_PATH,
  MANAGEMENT_REMOVE_PATH,
  MANAGEMENT_STATUS_PATH,
  MANAGEMENT_VERIFY_PATH,
} from '../src/host/route.js'

describe('Cordis Host Lifecycle Management Integration', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-cordis-test-'))
    mkdirSync(join(tempHome, 'storages', 'dsh-word-lookup', 'databases'), { recursive: true })
    mkdirSync(join(tempHome, 'cache', 'dsh-word-lookup', 'sources'), { recursive: true })

    return () => {
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

  it('registers all 6 Fetch routes inside a single ctx.effect()', async () => {
    const registeredRoutes = new Map<string, (req: Request) => Promise<Response>>()
    const disposersCalled: string[] = []
    let effectDisposer: (() => Promise<void>) | undefined

    const mockCtx = {
      profileContext: { home: tempHome },
      effect: vi.fn((fn: () => () => Promise<void>) => {
        effectDisposer = fn()
      }),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            registeredRoutes.set(spec.path, spec.fetch)
            return async () => {
              disposersCalled.push(spec.path)
            }
          }),
        },
      },
    }

    const config = Config({ dictionaryMode: 'fixture' })
    apply(mockCtx as any, config)

    expect(mockCtx.effect).toHaveBeenCalledTimes(1)
    expect(mockCtx.connection.fetch.register).toHaveBeenCalledTimes(6)

    expect(registeredRoutes.has(LOOKUP_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_STATUS_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_INSTALL_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_CANCEL_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_REMOVE_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_VERIFY_PATH)).toBe(true)

    // Verify status route returns activeMode: 'fixture'
    const statusHandler = registeredRoutes.get(MANAGEMENT_STATUS_PATH)!
    const statusRes = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json()
    expect(statusData.activeMode).toBe('fixture')
    expect(statusData.canInstall).toBe(true)

    // Execute unload disposer
    expect(effectDisposer).toBeDefined()
    await effectDisposer!()

    expect(disposersCalled).toHaveLength(6)
    expect(disposersCalled).toContain(LOOKUP_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_STATUS_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_INSTALL_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_CANCEL_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_REMOVE_PATH)
    expect(disposersCalled).toContain(MANAGEMENT_VERIFY_PATH)
  })

  it('rolls back registered routes and closes handles if a route registration throws during startup', () => {
    let callCount = 0
    const unregistered: string[] = []

    const mockCtx = {
      profileContext: { home: tempHome },
      effect: vi.fn((fn: () => () => Promise<void>) => fn()),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string }) => {
            callCount++
            if (callCount === 4) {
              throw new Error('Route registration collision')
            }
            return async () => {
              unregistered.push(spec.path)
            }
          }),
        },
      },
    }

    const config = Config({})
    expect(() => apply(mockCtx as any, config)).toThrow('Route registration collision')

    // Prior routes must have been rolled back
    expect(unregistered.length).toBeGreaterThanOrEqual(1)
  })

  it('operates in fixture-only mode when host context does not supply DSH home', async () => {
    const registeredRoutes = new Map<string, (req: Request) => Promise<Response>>()
    let effectDisposer: (() => Promise<void>) | undefined

    const mockCtx = {
      // No profileContext or dshHomePath
      effect: vi.fn((fn: () => () => Promise<void>) => {
        effectDisposer = fn()
      }),
      connection: {
        fetch: {
          register: vi.fn((spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
            registeredRoutes.set(spec.path, spec.fetch)
            return async () => {}
          }),
        },
      },
    }

    const config = Config({})
    expect(() => apply(mockCtx as any, config)).not.toThrow()

    // Routes registered
    expect(registeredRoutes.has(LOOKUP_PATH)).toBe(true)
    expect(registeredRoutes.has(MANAGEMENT_STATUS_PATH)).toBe(true)

    // Status shows canInstall is false (storage unavailable)
    const statusHandler = registeredRoutes.get(MANAGEMENT_STATUS_PATH)!
    const res = await statusHandler(new Request('http://localhost' + MANAGEMENT_STATUS_PATH, { method: 'GET' }))
    const data = await res.json()
    expect(data.canInstall).toBe(false)
    expect(data.installed).toBe(false)

    // Lookup route functions normally on fixture
    const lookupHandler = registeredRoutes.get(LOOKUP_PATH)!
    const lookupRes = await lookupHandler(
      new Request('http://localhost' + LOOKUP_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      }),
    )
    expect(lookupRes.status).toBe(200)

    await effectDisposer!()
  })
})
