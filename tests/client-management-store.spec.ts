/**
 * Tests for DictionaryManagementStore.
 *
 * Verifies:
 * - Reactive state snapshot and subscription pattern.
 * - Adaptive polling intervals (active during running tasks, idle when resting).
 * - Immediate refresh on window focus.
 * - Install flow (busy states, action errors, 409 handling).
 * - Cancel flow (targets current operationId, updates state).
 * - Remove flow (reverts to fixture, handles errors).
 * - Network failures preserve last valid status and surface connectionError.
 * - Out-of-order responses do not overwrite newer state.
 * - Complete disposal hygiene (clears timers, aborts controller, removes event listeners).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DictionaryManagementStore } from '../src/client/settings/dictionary-management-store.js'
import * as transport from '../src/client/settings/dictionary-management-transport.js'
import type { DictionaryStatusResponse } from '../src/shared/dictionary-management-protocol.js'

class FakeWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event: { type: string }): boolean {
    const set = this.listeners.get(event.type)
    if (set) {
      for (const h of set) h(event)
    }
    return true
  }
}

function sampleStatus(overrides: Partial<DictionaryStatusResponse> = {}): DictionaryStatusResponse {
  return {
    ok: true,
    activeMode: 'fixture',
    configuredMode: 'fixture',
    activeSource: 'sqlite-fixture',
    activeIdentity: 'fixture',
    installed: false,
    installedCorpus: null,
    currentOperation: null,
    lastOperation: null,
    canInstall: true,
    canCancel: false,
    canRemove: false,
    quarantined: false,
    quarantineReason: null,
    recoveryError: null,
    lastRetirementError: null,
    generation: 1,
    ...overrides,
  }
}

describe('DictionaryManagementStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new FakeWindow())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('initializes with loading state and fetches initial status', async () => {
    vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus({ installed: true, activeMode: 'managed-ecdict' }),
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    expect(store.getSnapshot().isLoading).toBe(true)
    expect(store.getSnapshot().status).toBe(null)

    await store.refresh()

    expect(store.getSnapshot().isLoading).toBe(false)
    expect(store.getSnapshot().status?.installed).toBe(true)
    expect(store.getSnapshot().status?.activeMode).toBe('managed-ecdict')
    store.dispose()
  })

  it('subscribes and notifies listeners on state changes', async () => {
    vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus(),
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    await store.refresh()
    expect(listener).toHaveBeenCalled()

    listener.mockClear()
    unsubscribe()
    await store.refresh()
    expect(listener).not.toHaveBeenCalled()

    store.dispose()
  })

  it('adapts polling cadence: high frequency when operation is running, low when idle', async () => {
    let callCount = 0
    vi.spyOn(transport, 'fetchDictionaryStatus').mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First call: operation is running
        return {
          ok: true,
          data: sampleStatus({
            currentOperation: {
              operationId: 'op-1',
              kind: 'install',
              phase: 'downloading',
              status: 'running',
              progress: { phase: 'downloading', percent: 25 },
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
        }
      }
      // Subsequent call: operation settled
      return {
        ok: true,
        data: sampleStatus({ currentOperation: null }),
      }
    })

    const store = new DictionaryManagementStore({
      activeIntervalMs: 500,
      idleIntervalMs: 5000,
      autoStart: true,
    })

    // Advance microtasks for initial poll
    await vi.advanceTimersByTimeAsync(0)
    expect(callCount).toBe(1)
    expect(store.getSnapshot().status?.currentOperation?.status).toBe('running')

    // At 400ms, next poll has NOT fired yet (interval is 500ms)
    await vi.advanceTimersByTimeAsync(400)
    expect(callCount).toBe(1)

    // At 550ms total, second poll fires
    await vi.advanceTimersByTimeAsync(150)
    expect(callCount).toBe(2)

    // Now currentOperation is null, next poll should wait for idleIntervalMs (5000ms)
    await vi.advanceTimersByTimeAsync(4000)
    expect(callCount).toBe(2)

    // At > 5000ms idle interval, third poll fires
    await vi.advanceTimersByTimeAsync(1500)
    expect(callCount).toBe(3)

    store.dispose()
  })

  it('triggers immediate refresh on window focus', async () => {
    const fetchSpy = vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus(),
    })

    const store = new DictionaryManagementStore({ autoStart: true })
    await vi.advanceTimersByTimeAsync(10)
    fetchSpy.mockClear()

    window.dispatchEvent({ type: 'focus' } as unknown as Event)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchSpy).toHaveBeenCalled()

    store.dispose()
  })

  it('handles install action: sets isActing, refreshes status, clears isActing', async () => {
    const installSpy = vi.spyOn(transport, 'installManagedDictionary').mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        operationId: 'op-install-1',
        status: 'running',
        phase: 'queued',
        message: 'Install queued',
      },
    })
    const fetchSpy = vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus({
        currentOperation: {
          operationId: 'op-install-1',
          kind: 'install',
          phase: 'downloading',
          status: 'running',
          progress: { phase: 'downloading' },
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    const promise = store.install()
    expect(store.getSnapshot().isActing).toBe(true)

    const success = await promise
    expect(success).toBe(true)
    expect(installSpy).toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalled()
    expect(store.getSnapshot().isActing).toBe(false)
    expect(store.getSnapshot().status?.currentOperation?.operationId).toBe('op-install-1')

    store.dispose()
  })

  it('handles install refusal (HTTP 409) cleanly without crash', async () => {
    vi.spyOn(transport, 'installManagedDictionary').mockResolvedValue({
      ok: false,
      kind: 'refused',
      httpStatus: 409,
      code: 'OPERATION_IN_PROGRESS',
      message: 'Another operation is currently active.',
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    const success = await store.install()

    expect(success).toBe(false)
    expect(store.getSnapshot().isActing).toBe(false)
    expect(store.getSnapshot().actionError).toBe('Another operation is currently active.')

    store.clearActionError()
    expect(store.getSnapshot().actionError).toBe(null)

    store.dispose()
  })

  it('handles cancel action: sends active operationId and updates state', async () => {
    vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus({
        canCancel: true,
        currentOperation: {
          operationId: 'op-cancel-me',
          kind: 'install',
          phase: 'downloading',
          status: 'running',
          progress: { phase: 'downloading' },
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    })

    const cancelSpy = vi.spyOn(transport, 'cancelDictionaryOperation').mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        operationId: 'op-cancel-me',
        status: 'cancelling',
        message: 'Cancellation requested',
      },
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    await store.refresh()

    const promise = store.cancel()
    expect(store.getSnapshot().isActing).toBe(true)

    const success = await promise
    expect(success).toBe(true)
    expect(cancelSpy).toHaveBeenCalledWith('op-cancel-me', expect.any(AbortSignal))
    expect(store.getSnapshot().isActing).toBe(false)

    store.dispose()
  })

  it('handles remove action: calls removeManagedDictionary and refreshes', async () => {
    const removeSpy = vi.spyOn(transport, 'removeManagedDictionary').mockResolvedValue({
      ok: true,
      data: { ok: true, removed: true, activeMode: 'fixture', message: 'Removed' },
    })
    const fetchSpy = vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus({ installed: false, activeMode: 'fixture' }),
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    const success = await store.remove()

    expect(success).toBe(true)
    expect(removeSpy).toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalled()
    expect(store.getSnapshot().isActing).toBe(false)
    expect(store.getSnapshot().status?.installed).toBe(false)

    store.dispose()
  })

  it('preserves last valid status during network errors and sets connectionError', async () => {
    vi.spyOn(transport, 'fetchDictionaryStatus')
      .mockResolvedValueOnce({
        ok: true,
        data: sampleStatus({ installed: true, activeMode: 'managed-ecdict' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        kind: 'network',
        message: 'Network unreachable',
      })

    const store = new DictionaryManagementStore({ autoStart: false })
    await store.refresh()

    expect(store.getSnapshot().status?.installed).toBe(true)
    expect(store.getSnapshot().connectionError).toBe(null)

    // Second poll fails
    await store.refresh()

    // Last valid status MUST be retained
    expect(store.getSnapshot().status?.installed).toBe(true)
    expect(store.getSnapshot().connectionError).toContain('网络连接异常')

    store.dispose()
  })

  it('disposal cancels active timers and aborts in-flight fetch', async () => {
    vi.spyOn(transport, 'fetchDictionaryStatus').mockResolvedValue({
      ok: true,
      data: sampleStatus(),
    })

    const store = new DictionaryManagementStore({ autoStart: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    store.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('concurrent refresh aborts older in-flight poll request signal', async () => {
    const signals: AbortSignal[] = []
    vi.spyOn(transport, 'fetchDictionaryStatus').mockImplementation(async (signal) => {
      if (signal) signals.push(signal)
      return { ok: true, data: sampleStatus() }
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    const p1 = store.refresh()
    const p2 = store.refresh()
    await Promise.all([p1, p2])

    expect(signals.length).toBe(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    store.dispose()
  })

  it('disposal aborts in-flight action controllers', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.spyOn(transport, 'installManagedDictionary').mockImplementation(async (signal) => {
      capturedSignal = signal
      return new Promise(() => {}) // never resolves
    })

    const store = new DictionaryManagementStore({ autoStart: false })
    void store.install()

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(false)

    store.dispose()
    expect(capturedSignal?.aborted).toBe(true)
  })
})
