/**
 * Reactive observable store for dictionary management state and background polling.
 *
 * Implements:
 * - Dynamic adaptive polling: high frequency (800ms) during active operations,
 *   low frequency (10,000ms) when idle.
 * - Window focus refresh trigger.
 * - Out-of-order request protection and stale response rejection.
 * - Graceful connection error retention without wiping last known status.
 * - Full lifecycle cleanup with AbortController on disposal.
 *
 * @module dsh-word-lookup/client/settings/dictionary-management-store
 */

import type { DictionaryStatusResponse } from '../../shared/dictionary-management-protocol.js'
import {
  activateCustomDictionary,
  cancelDictionaryOperation,
  fetchDictionaryStatus,
  installManagedDictionary,
  removeCustomDictionary,
  removeManagedDictionary,
  selectDictionaryMode,
  verifyCustomDictionary,
} from './dictionary-management-transport.js'

/**
 * State snapshot of the dictionary management store.
 */
export interface DictionaryManagementStoreState {
  /** The latest authoritative status from the host, or null before initial fetch. */
  readonly status: DictionaryStatusResponse | null
  /** Whether the initial load or a manual refresh is in flight. */
  readonly isLoading: boolean
  /** Whether an install, cancel, or remove action is in flight. */
  readonly isActing: boolean
  /** Error message resulting from a user action (install, cancel, remove), or null. */
  readonly actionError: string | null
  /** Transient connection or transport error during polling, or null. */
  readonly connectionError: string | null
  /** Timestamp of the last successful status fetch. */
  readonly lastRefreshedAt: number
}

/** Configuration options for the management store. */
export interface DictionaryManagementStoreOptions {
  /** High-frequency polling interval during active operations in ms (default 800). */
  readonly activeIntervalMs?: number
  /** Low-frequency polling interval during idle state in ms (default 10000). */
  readonly idleIntervalMs?: number
  /** Whether to start polling immediately upon construction (default true). */
  readonly autoStart?: boolean
}

const DEFAULT_ACTIVE_INTERVAL = 800
const DEFAULT_IDLE_INTERVAL = 10000

export class DictionaryManagementStore {
  #state: DictionaryManagementStoreState = {
    status: null,
    isLoading: true,
    isActing: false,
    actionError: null,
    connectionError: null,
    lastRefreshedAt: 0,
  }

  readonly #listeners = new Set<() => void>()
  readonly #activeIntervalMs: number
  readonly #idleIntervalMs: number

  #timer: ReturnType<typeof setTimeout> | null = null
  #pollAbortController: AbortController | null = null
  readonly #actionControllers = new Set<AbortController>()
  #requestId = 0
  #disposed = false

  constructor(options: DictionaryManagementStoreOptions = {}) {
    this.#activeIntervalMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL
    this.#idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL

    if (options.autoStart ?? true) {
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', this.#onWindowFocus)
      }
      void this.refresh()
    }
  }

  /**
   * Subscribe to store state changes.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Return the current immutable snapshot.
   */
  getSnapshot = (): DictionaryManagementStoreState => {
    return this.#state
  }

  #emit(): void {
    if (this.#disposed) return
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // Suppress listener exceptions
      }
    }
  }

  #onWindowFocus = (): void => {
    if (this.#disposed) return
    void this.refresh()
  }

  #scheduleNextPoll(): void {
    if (this.#disposed) return
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }

    const isOperationActive =
      this.#state.status?.currentOperation !== null &&
      this.#state.status?.currentOperation !== undefined &&
      this.#state.status.currentOperation.status === 'running'

    const interval = isOperationActive ? this.#activeIntervalMs : this.#idleIntervalMs
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#poll()
    }, interval)
  }

  async #poll(): Promise<void> {
    if (this.#disposed) return
    const id = ++this.#requestId
    if (this.#pollAbortController !== null) {
      this.#pollAbortController.abort()
      this.#pollAbortController = null
    }
    const controller = new AbortController()
    this.#pollAbortController = controller

    try {
      const result = await fetchDictionaryStatus(controller.signal)
      if (this.#disposed || id !== this.#requestId) return

      if (result.ok) {
        this.#state = {
          ...this.#state,
          status: result.data,
          isLoading: false,
          connectionError: null,
          lastRefreshedAt: Date.now(),
        }
      } else if (result.kind === 'network') {
        this.#state = {
          ...this.#state,
          connectionError: `网络连接异常: ${result.message}`,
          isLoading: false,
        }
      } else if (result.kind === 'refused') {
        this.#state = {
          ...this.#state,
          connectionError: `服务响应异常 (${result.httpStatus}): ${result.message}`,
          isLoading: false,
        }
      }
      this.#emit()
    } catch {
      // Aborted or transport error
    } finally {
      if (this.#pollAbortController === controller) {
        this.#pollAbortController = null
      }
      if (!this.#disposed && id === this.#requestId) {
        this.#scheduleNextPoll()
      }
    }
  }

  /**
   * Immediately refresh dictionary status from the host.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    await this.#poll()
  }

  /**
   * Request installation of the managed ECDICT corpus.
   */
  async install(): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await installManagedDictionary(controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        // Fast status refresh to capture new operation
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '安装请求被取消'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Request cancellation of the active operation.
   */
  async cancel(targetOperationId?: string): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    const opId = targetOperationId ?? this.#state.status?.currentOperation?.operationId
    if (!opId) {
      this.#state = { ...this.#state, actionError: '没有正在执行的操作可供取消' }
      this.#emit()
      return false
    }

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await cancelDictionaryOperation(opId, controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '取消请求未完成'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Request removal of the installed managed ECDICT corpus.
   */
  async remove(): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await removeManagedDictionary(controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '移除请求未完成'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Request activation of a custom SQLite dictionary.
   */
  async activateCustom(path: string, identity?: string): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await activateCustomDictionary(path, identity, controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '激活自定义词典请求被取消'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Request switching active dictionary mode (fixture, managed-ecdict, custom).
   */
  async selectMode(mode: 'fixture' | 'managed-ecdict' | 'custom', snapshotId?: string): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await selectDictionaryMode(mode, snapshotId, controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '切换词典模式请求未完成'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Request removal of an inactive custom dictionary snapshot.
   */
  async removeCustom(snapshotId: string): Promise<boolean> {
    if (this.#disposed || this.#state.isActing) return false

    this.#state = { ...this.#state, isActing: true, actionError: null }
    this.#emit()

    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      const result = await removeCustomDictionary(snapshotId, controller.signal)
      if (this.#disposed) return false

      if (result.ok) {
        await this.refresh()
        return true
      }

      const errMsg =
        result.kind === 'refused'
          ? result.message
          : result.kind === 'network'
            ? `网络异常: ${result.message}`
            : '删除自定义词典快照未完成'

      this.#state = { ...this.#state, actionError: errMsg }
      this.#emit()
      return false
    } finally {
      this.#actionControllers.delete(controller)
      if (!this.#disposed) {
        this.#state = { ...this.#state, isActing: false }
        this.#emit()
      }
    }
  }

  /**
   * Verify candidate custom SQLite dictionary file.
   */
  async verifyCustom(path: string) {
    const controller = new AbortController()
    this.#actionControllers.add(controller)
    try {
      return await verifyCustomDictionary(path, controller.signal)
    } finally {
      this.#actionControllers.delete(controller)
    }
  }

  /**
   * Clear any outstanding action errors.
   */
  clearActionError(): void {
    if (this.#state.actionError !== null) {
      this.#state = { ...this.#state, actionError: null }
      this.#emit()
    }
  }

  /** Whether this store has been disposed. */
  get isDisposed(): boolean {
    return this.#disposed
  }

  /** Whether a background polling timer is currently scheduled. */
  get hasScheduledTimer(): boolean {
    return this.#timer !== null
  }

  /**
   * Dispose store, stop all timers and abort outstanding requests.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }

    if (this.#pollAbortController !== null) {
      this.#pollAbortController.abort()
      this.#pollAbortController = null
    }

    for (const controller of this.#actionControllers) {
      controller.abort()
    }
    this.#actionControllers.clear()

    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.#onWindowFocus)
    }

    this.#listeners.clear()
  }
}
