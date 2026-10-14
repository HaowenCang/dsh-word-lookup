/**
 * Tests for settings.section lifecycle and registration in the client entrypoint.
 *
 * Verifies:
 * - Registration of settings.section with id 'dictionary' and order 80.
 * - Dynamic localized label ('词典' in zh / 'Dictionary' in en).
 * - diagnostics.settingsSection() surface observability.
 * - Clean disposal upon plugin unload with zero lingering registrations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apply,
  SETTINGS_SECTION_ID,
  SETTINGS_SECTION_ORDER,
  type WordLookupDiagnostics,
} from '../src/client/index.js'
import type { ClientContext } from '../src/client/contracts.js'

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }
}

class FakeDocument extends FakeTarget {
  getSelection() {
    return {
      rangeCount: 0,
      isCollapsed: true,
      toString: () => '',
      getRangeAt: () => ({ collapsed: true, getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) }),
    }
  }
}

describe('Client settings.section registration lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('document', new FakeDocument())
    vi.stubGlobal('window', new FakeTarget())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers settings.section and exposes diagnostics surface', () => {
    let sectionRegistration: { options: unknown; component: unknown } | null = null

    const injectedCallbacks = new Map<string, () => () => void>()

    const mockCtx = {
      effect: (fn: () => unknown) => {
        const disposer = fn()
        return () => {
          if (typeof disposer === 'function') (disposer as () => void)()
        }
      },
      slots: {
        inject: (name: string, callback: () => () => void) => {
          injectedCallbacks.set(name, callback)
          const unreg = callback()
          return () => unreg()
        },
        register: (options: { name: string; id: string; order: number; label: () => string }, component: unknown) => {
          if (options.name === 'settings.section') {
            sectionRegistration = { options, component }
          }
          return () => {}
        },
      },
      shortcuts: {
        register: () => () => {},
        catalog: { getSnapshot: () => [] },
      },
      configForms: {
        get: () => ({
          getSnapshot: () => ({ status: 'ready', mode: 'normal', writable: true, value: {} }),
          subscribe: () => () => {},
          set: async () => true,
        }),
      },
    }

    apply(mockCtx as unknown as ClientContext)

    const diag = Reflect.get(globalThis, '__DSH_WORD_LOOKUP__') as WordLookupDiagnostics
    expect(diag).toBeDefined()
    expect(diag.settingsSection).toBeDefined()

    const sectionState = diag.settingsSection()
    expect(sectionState.entryId).toBe(SETTINGS_SECTION_ID)
    expect(sectionState.order).toBe(SETTINGS_SECTION_ORDER)
    expect(sectionState.declarationSeen).toBe(true)
    expect(sectionState.registrationCount).toBe(1)
    expect(sectionState.store).toBeDefined()

    expect(sectionRegistration).not.toBeNull()
    const opts = (sectionRegistration as unknown as { options: { id: string; order: number; label: () => string } }).options
    expect(opts.id).toBe('dictionary')
    expect(opts.order).toBe(80)
    expect(['词典', 'Dictionary']).toContain(opts.label())
  })

  it('unregisters cleanly upon unload leaving 0 residue', () => {
    let unregisterCalled = false
    let effectDisposer: (() => void) | undefined

    const mockCtx = {
      effect: (fn: () => unknown) => {
        effectDisposer = fn() as () => void
        return () => effectDisposer?.()
      },
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          const unreg = callback()
          return () => unreg()
        },
        register: (options: { name: string }) => {
          return () => {
            if (options.name === 'settings.section') {
              unregisterCalled = true
            }
          }
        },
      },
      shortcuts: {
        register: () => () => {},
        catalog: { getSnapshot: () => [] },
      },
      configForms: {
        get: () => ({
          getSnapshot: () => ({ status: 'ready', mode: 'normal', writable: true, value: {} }),
          subscribe: () => () => {},
          set: async () => true,
        }),
      },
    }

    apply(mockCtx as unknown as ClientContext)
    expect(unregisterCalled).toBe(false)

    // Unload the client runtime
    effectDisposer?.()
    expect(unregisterCalled).toBe(true)
    expect(Reflect.get(globalThis, '__DSH_WORD_LOOKUP__')).toBeUndefined()
  })
})
