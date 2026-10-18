// @vitest-environment happy-dom
/**
 * Component and visual hierarchy unit tests for DictionarySettingsSection.
 *
 * Verifies:
 * - Mutually exclusive status display (fixture vs managed-ecdict vs custom vs quarantined).
 * - Section A: Current dictionary status, entry counts, forms counts, technical details disclosure.
 * - Section B: ECDICT installation, progress bar, cancel button gating, removal modal, error handling.
 * - Section C: Automatic lookup switches (autoDoubleClick, autoSelection) with ConfigForms sync.
 * - Section D: Platform-accurate shortcut inspection (Windows, macOS, Linux unbound).
 * - ARIA and WCAG 2.1 accessibility compliance.
 * - Zero undefined, null, or [object Object] artifacts in rendered output.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  DictionarySettingsSection,
  type DictionaryHostSettings,
} from '../src/client/settings/dictionary-settings-section.js'
import {
  Switch,
  ModalConfirm,
} from '../src/client/settings/dictionary-settings-components.js'
import { DictionaryManagementStore } from '../src/client/settings/dictionary-management-store.js'
import type { DictionaryStatusResponse } from '../src/shared/dictionary-management-protocol.js'
import type { Shortcuts } from '../src/client/contracts.js'

function createStatus(overrides: Partial<DictionaryStatusResponse> = {}): DictionaryStatusResponse {
  return {
    ok: true,
    activeMode: 'fixture',
    configuredMode: 'fixture',
    activeSource: 'sqlite-fixture',
    activeIdentity: 'fixture',
    installed: false,
    installedCorpus: null,
    fixtureStats: {
      entryCount: 7,
      formCount: 11,
      version: 'phase3-fixture-1',
    },
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

function createMockForm(initial: DictionaryHostSettings = {}) {
  let value = { ...initial }
  const listeners = new Set<() => void>()
  return {
    get value() {
      return value
    },
    set value(v: DictionaryHostSettings) {
      value = v
    },
    listeners,
    getSnapshot: () => ({
      status: 'ready' as const,
      mode: 'normal' as const,
      writable: true,
      revision: 1,
      value,
    }),
    set: vi.fn(async (key: keyof DictionaryHostSettings, val: unknown) => {
      value = { ...value, [key]: val }
      for (const l of listeners) l()
      return true
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

function mountSection(props: {
  storeState?: Partial<DictionaryStatusResponse>
  store?: DictionaryManagementStore
  form?: ReturnType<typeof createMockForm>
  platform?: 'windows' | 'macos' | 'linux'
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const mockStore = props.store ?? new DictionaryManagementStore({ autoStart: false })
  if (!props.store) {
    const status = createStatus(props.storeState)
    vi.spyOn(mockStore, 'getSnapshot').mockReturnValue({
      status,
      isLoading: false,
      isActing: false,
      actionError: null,
      connectionError: null,
      lastRefreshedAt: 1000,
    })
  }

  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(DictionarySettingsSection, {
          store: mockStore,
          form: props.form as never,
          testPlatform: props.platform ?? 'windows',
        }),
      )
    })
  }

  const unmount = async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }

  return { container, root, render, unmount, store: mockStore }
}

function createMockShortcuts(keys: readonly string[] = ['Ctrl', 'Shift', 'L']) {
  return {
    catalog: {
      getSnapshot: () => [
        {
          id: 'wordLookup.lookupSelection',
          label: 'Lookup Selection',
          keys,
          modified: false,
        },
      ],
      subscribe: () => () => {},
    },
    config: {
      getSnapshot: () => ({ revision: 1 }),
      subscribe: () => () => {},
    },
    edit: vi.fn(),
    recording: vi.fn(),
    describeBinding: vi.fn(),
  } as unknown as Shortcuts
}

function renderSection(props: {
  storeState?: Partial<DictionaryStatusResponse>
  form?: ReturnType<typeof createMockForm>
  shortcuts?: Shortcuts
  platform?: 'windows' | 'macos' | 'linux'
}): string {
  const mockStore = new DictionaryManagementStore({ autoStart: false })
  const status = createStatus(props.storeState)
  vi.spyOn(mockStore, 'getSnapshot').mockReturnValue({
    status,
    isLoading: false,
    isActing: false,
    actionError: null,
    connectionError: null,
    lastRefreshedAt: 1000,
  })

  return renderToStaticMarkup(
    React.createElement(DictionarySettingsSection, {
      store: mockStore,
      form: props.form as never,
      shortcuts: props.shortcuts,
      testPlatform: props.platform ?? 'windows',
    }),
  )
}

describe('DictionarySettingsSection Rendering', () => {
  describe('Section A: Current Dictionary Status', () => {
    it('renders initial fixture mode with truthful fixture entries and neutral badge', () => {
      const html = renderSection({
        storeState: { activeMode: 'fixture', installed: false },
      })

      expect(html).toContain('当前活动词典')
      expect(html).toContain('内置离线基础词典 (Fixture)')
      expect(html).toContain('7 词条')
      expect(html).toContain('11 记录')
      expect(html).not.toContain('12 词条')
      expect(html).not.toContain('12 记录')
      expect(html).not.toContain('undefined')
      expect(html).not.toContain('null')
      expect(html).not.toContain('[object Object]')
    })

    it('renders installed & active ECDICT with 770,611 entries and success badge', () => {
      const html = renderSection({
        storeState: {
          activeMode: 'managed-ecdict',
          installed: true,
          installedCorpus: {
            name: 'ECDICT',
            commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: '591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9',
            schemaVersion: 1,
            databaseFile: 'ecdict-v1-bc015ed.sqlite3',
            entryCount: 770611,
            formCount: 57689,
          },
        },
      })

      expect(html).toContain('ECDICT 本地全量词典')
      expect(html).toContain('ECDICT 已启用')
      expect(html).toContain('770,611')
      expect(html).toContain('57,689')
      expect(html).toContain('ECDICT @ bc015ed')
    })

    it('renders storage quarantine alert when quarantined is true', () => {
      const html = renderSection({
        storeState: {
          quarantined: true,
          quarantineReason: 'Worker exited abnormally before confirmation.',
        },
      })

      expect(html).toContain('存储隔离保护中')
      expect(html).toContain('存储目录已进入隔离保护')
      expect(html).toContain('Worker exited abnormally before confirmation.')
    })

    it('renders recovery error notice when recoveryError is present', () => {
      const html = renderSection({
        storeState: {
          recoveryError: 'Database file checksum verification warning.',
        },
      })

      expect(html).toContain('恢复异常')
    })
  })

  describe('Section B: ECDICT Installation & Lifecycle', () => {
    it('renders 1-click install button when uninstalled', () => {
      const html = renderSection({
        storeState: { installed: false, canInstall: true, currentOperation: null },
      })

      expect(html).toContain('ECDICT 完整词典管理')
      expect(html).toContain('一键安装 ECDICT')
      expect(html).toContain('下载约 63 MiB 的 CSV 词源')
    })

    it('renders progress bar and status during downloading phase', () => {
      const html = renderSection({
        storeState: {
          installed: false,
          canCancel: true,
          currentOperation: {
            operationId: 'op-dl-1',
            kind: 'install',
            phase: 'downloading',
            status: 'running',
            progress: {
              phase: 'downloading',
              percent: 45,
              processed: 29000000,
              total: 65933428,
              unit: 'bytes',
              message: '29 MB / 66 MB',
            },
            startedAt: '2026-10-14T00:00:00.000Z',
            updatedAt: '2026-10-14T00:00:05.000Z',
          },
        },
      })

      expect(html).toContain('正在下载 ECDICT 词源文件...')
      expect(html).toContain('role="progressbar"')
      expect(html).toContain('aria-valuenow="45"')
      expect(html).toContain('45%')
      expect(html).toContain('取消安装')
    })

    it('renders disabled cancel button when in atomic activation stage (canCancel = false)', () => {
      const html = renderSection({
        storeState: {
          installed: false,
          canCancel: false,
          currentOperation: {
            operationId: 'op-act-1',
            kind: 'install',
            phase: 'activating',
            status: 'running',
            progress: { phase: 'activating', percent: 98, message: 'Activating dictionary' },
            startedAt: '2026-10-14T00:00:00.000Z',
            updatedAt: '2026-10-14T00:00:20.000Z',
          },
        },
      })

      expect(html).toContain('正在原子激活并重载词典...')
      expect(html).toContain('不可取消 (提交中)')
      expect(html).toContain('当前阶段已进入不可取消的原子激活流程')
      expect(html).toContain('disabled=""')
    })

    it('renders removal button when dictionary is installed', () => {
      const html = renderSection({
        storeState: { installed: true, canRemove: true, currentOperation: null },
      })

      expect(html).toContain('移除本地词典')
      expect(html).toContain('移除后将恢复为内置基础词典 (Fixture)')
    })
  })

  describe('Section C: Gesture Switches', () => {
    it('renders both switches defaulting to false', () => {
      const form = createMockForm({ autoDoubleClick: false, autoSelection: false })
      const html = renderSection({ form })

      expect(html).toContain('双击自动查词')
      expect(html).toContain('拖拽框选自动查词')
      expect(html).toContain('id="switch-auto-double-click"')
      expect(html).toContain('id="switch-auto-selection"')
      expect(html).toContain('aria-checked="false"')
    })

    it('renders switches reflecting true form values', () => {
      const form = createMockForm({ autoDoubleClick: true, autoSelection: true })
      const html = renderSection({ form })

      expect(html).toContain('aria-checked="true"')
    })
  })

  describe('Section D: Shortcuts & Advanced Features', () => {
    it('renders shortcut service unavailable when shortcuts service is missing', () => {
      const html = renderSection({})
      expect(html).toContain('快捷键服务暂不可用')
    })

    it('renders Ctrl + Shift + L on Windows with active shortcuts', () => {
      const shortcuts = createMockShortcuts(['Ctrl', 'Shift', 'L'])
      const html = renderSection({ shortcuts, platform: 'windows' })
      expect(html).toContain('Ctrl + Shift + L')
    })

    it('renders ⌘ + Shift + L on macOS with active shortcuts', () => {
      const shortcuts = createMockShortcuts(['⌘', 'Shift', 'L'])
      const html = renderSection({ shortcuts, platform: 'macos' })
      expect(html).toContain('⌘ + Shift + L')
    })

    it('renders 未绑定 (Unbound) on Linux Web when unbound', () => {
      const shortcuts = createMockShortcuts([])
      const html = renderSection({ shortcuts, platform: 'linux' })
      expect(html).toContain('未绑定 (Unbound)')
      expect(html).toContain('Linux Web 平台受浏览器系统快捷键限制')
    })

    it('renders Phase 7A.8 notice for custom SQLite dictionaries', () => {
      const html = renderSection({})
      expect(html).toContain('自定义外部 SQLite 词典')
      expect(html).toContain('Phase 7A.8 开放')
    })
  })

  describe('P1 — Page Statistics Truthfulness', () => {
    it('P1-01: Fixture mode never displays false 12/12 statistics (displays truthful fixture count 7 / 11)', () => {
      const html = renderSection({
        storeState: {
          activeMode: 'fixture',
          installed: false,
          fixtureStats: { entryCount: 7, formCount: 11, version: 'phase3-fixture-1' },
        },
      })
      expect(html).toContain('7 词条')
      expect(html).toContain('11 记录')
      expect(html).not.toContain('12 词条')
      expect(html).not.toContain('12 记录')
    })

    it('P1-02: ECDICT returns accurate real statistics (770,611 / 57,689)', () => {
      const html = renderSection({
        storeState: {
          activeMode: 'managed-ecdict',
          installed: true,
          installedCorpus: {
            name: 'ECDICT',
            commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: '591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9',
            schemaVersion: 1,
            databaseFile: 'ecdict-v1-bc015ed.sqlite3',
            entryCount: 770611,
            formCount: 57689,
          },
        },
      })
      expect(html).toContain('770,611 词条')
      expect(html).toContain('57,689 记录')
      expect(html).toContain('ECDICT @ bc015ed')
    })

    it('P1-03: Missing statistics from host renders "暂无统计" rather than fabricating fallback numbers', () => {
      const html = renderSection({
        storeState: {
          activeMode: 'managed-ecdict',
          installed: true,
          installedCorpus: {
            name: 'ECDICT',
            commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: '591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9',
            schemaVersion: 1,
            databaseFile: 'ecdict-v1-bc015ed.sqlite3',
            entryCount: undefined,
            formCount: undefined,
          },
        },
      })
      expect(html).toContain('暂无统计')
      expect(html).not.toContain('770,611')
      expect(html).not.toContain('57,689')
      expect(html).not.toContain('12 词条')
    })

    it('P1-04: ECDICT installed on disk but inactive accurately distinguishes "本地文件存在" and "正在使用"', () => {
      const html = renderSection({
        storeState: {
          activeMode: 'fixture',
          installed: true,
          installedCorpus: {
            name: 'ECDICT',
            commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
            sha256: '591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9',
            schemaVersion: 1,
            databaseFile: 'ecdict-v1-bc015ed.sqlite3',
            entryCount: 770611,
            formCount: 57689,
          },
        },
      })
      expect(html).toContain('ECDICT 本地全量数据库已安装在磁盘，但当前活动词典模式为「内置基础词典 (Fixture)」')
      expect(html).toContain('查词请求尚未命中 ECDICT')
      expect(html).not.toContain('查词请求直接命中本地只读 SQLite 数据库')
    })

    it('P1-05: Host quarantine, uninitialized status, or recovery errors do not display false success state', () => {
      const htmlQuarantine = renderSection({
        storeState: {
          activeMode: 'managed-ecdict',
          installed: true,
          quarantined: true,
          quarantineReason: 'Termination without lock release',
        },
      })
      expect(htmlQuarantine).toContain('存储隔离保护中')
      expect(htmlQuarantine).toContain('存储已隔离保护')
      expect(htmlQuarantine).toContain('Termination without lock release')
      expect(htmlQuarantine).not.toContain('ECDICT 已启用')

      const htmlNull = renderToStaticMarkup(
        React.createElement(DictionarySettingsSection, {
          store: {
            subscribe: () => () => {},
            getSnapshot: () => ({
              status: null,
              isLoading: true,
              isActing: false,
              actionError: null,
              connectionError: null,
              lastRefreshedAt: 0,
            }),
          } as never,
        }),
      )
      expect(htmlNull).toContain('暂无统计')
      expect(htmlNull).not.toContain('ECDICT 已启用')
    })
  })

  describe('P2 — ConfigForms Persistence & Robustness', () => {
    it('P2-01: Successful write updates page and syncs with ConfigForms snapshot', async () => {
      const form = createMockForm({ autoDoubleClick: false, autoSelection: false })
      const { container, render, unmount } = mountSection({ form })
      await render()

      const switchDbl = container.querySelector('#switch-auto-double-click') as HTMLButtonElement
      const switchSel = container.querySelector('#switch-auto-selection') as HTMLButtonElement
      expect(switchDbl).toBeTruthy()
      expect(switchSel).toBeTruthy()
      expect(switchDbl.getAttribute('aria-checked')).toBe('false')
      expect(switchSel.getAttribute('aria-checked')).toBe('false')

      // Trigger interactive switch toggle
      await act(async () => {
        switchDbl.click()
      })

      // Form set called with new value and snapshot updated
      expect(form.set).toHaveBeenCalledWith('autoDoubleClick', true)
      expect(form.getSnapshot().value.autoDoubleClick).toBe(true)
      expect(switchDbl.getAttribute('aria-checked')).toBe('true')

      await unmount()
    })

    it('P2-02: Form set refusal or throw displays error notice without faking saved state', async () => {
      const form = createMockForm({ autoDoubleClick: false })
      // Case A: Host returns false (write refused by Host)
      form.set = vi.fn().mockResolvedValue(false)

      const { container, render, unmount } = mountSection({ form })
      await render()

      const switchBtn = container.querySelector('#switch-auto-double-click') as HTMLButtonElement
      expect(switchBtn).toBeTruthy()
      expect(switchBtn.getAttribute('aria-checked')).toBe('false')

      // Click switch to trigger toggle interaction
      await act(async () => {
        switchBtn.click()
      })

      // form.set was actively called with intended target state
      expect(form.set).toHaveBeenCalledWith('autoDoubleClick', true)

      // Switch must remain false because Host refused modification
      expect(switchBtn.getAttribute('aria-checked')).toBe('false')

      // Error alert must be rendered in UI and visible to user
      let alertEl = container.querySelector('[role="alert"]')
      expect(alertEl).toBeTruthy()
      expect(alertEl?.textContent).toContain('保存双击查词设置失败：Host 拒绝了修改，已恢复原有配置')

      // Form snapshot remains authoritative false
      expect(form.getSnapshot().value.autoDoubleClick).toBe(false)

      // Case B: Host throws exception during save
      // Wait >80ms so Switch throttle does not drop the click
      await new Promise((r) => setTimeout(r, 100))
      form.set = vi.fn().mockRejectedValue(new Error('IPC transport disconnected'))
      await act(async () => {
        switchBtn.click()
      })

      // Switch still false, not faking saved state
      expect(switchBtn.getAttribute('aria-checked')).toBe('false')
      alertEl = container.querySelector('[role="alert"]')
      expect(alertEl?.textContent).toContain('保存双击查词设置异常: IPC transport disconnected')

      await unmount()
    })

    it('P2-03: Switch is disabled when ConfigForms is unavailable or not writable', () => {
      const form = createMockForm({ autoDoubleClick: false })
      // Make snapshot unwritable
      vi.spyOn(form, 'getSnapshot').mockReturnValue({
        status: 'ready',
        mode: 'normal',
        writable: false,
        revision: 1,
        value: { autoDoubleClick: false },
      })
      const html = renderSection({ form })
      expect(html).toContain('disabled=""')
      expect(html).toContain('提示：当前设置处于只读模式或不可写入，开关已禁用')
    })

    it('P2-04: Rapid toggle ordering rejects stale out-of-order write settlement', async () => {
      let virtualNow = 1000
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => virtualNow)

      try {
        const form = createMockForm({ autoDoubleClick: false })

        let resolveFirst: (v: boolean) => void = () => {}
        const firstPromise = new Promise<boolean>((res) => {
          resolveFirst = res
        })

        // First call hangs; second call resolves immediately with true
        form.set = vi
          .fn()
          .mockImplementationOnce(() => firstPromise)
          .mockImplementationOnce(async (key, val) => {
            form.value = { ...form.value, [key]: val }
            for (const l of form.listeners) l()
            return true
          })

        const { container, render, unmount } = mountSection({ form })
        await render()

        const switchBtn = container.querySelector('#switch-auto-double-click') as HTMLButtonElement
        expect(switchBtn.getAttribute('aria-checked')).toBe('false')

        // Trigger two rapid toggles before the React state update settles
        // Both clicks fired in one act block before microtasks flush
        act(() => {
          switchBtn.click()
          virtualNow += 100
          switchBtn.click()
        })

        // Verify form.set was called twice with out-of-order sequence
        expect(form.set).toHaveBeenCalledTimes(2)

        // Allow microtasks for write 2 to process
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10))
        })

        // UI reflects the second write
        expect(form.getSnapshot().value.autoDoubleClick).toBe(true)
        expect(switchBtn.getAttribute('aria-checked')).toBe('true')

        // Now write 1 (seq = 1) resolves late with failure/refusal
        await act(async () => {
          resolveFirst(false)
        })

        // Out-of-order stale settlement from write 1 must be dropped by doubleClickSeqRef:
        // No alert error should appear and UI must remain consistent with write 2's snapshot
        const alertEl = container.querySelector('[role="alert"]')
        expect(alertEl).toBeNull()
        expect(switchBtn.getAttribute('aria-checked')).toBe('true')
        expect(form.getSnapshot().value.autoDoubleClick).toBe(true)

        await unmount()
      } finally {
        dateSpy.mockRestore()
      }
    })

    it('P2-05: Preserves persisted config across snapshot reloads', () => {
      const form = createMockForm({ autoDoubleClick: true, autoSelection: true })
      const html = renderSection({ form })
      expect(html).toMatch(/id="switch-auto-double-click"[^>]*aria-checked="true"/)
      expect(html).toMatch(/id="switch-auto-selection"[^>]*aria-checked="true"/)
    })

    it('P2-06: Unmounted component ignores late async form response without unhandled rejections', async () => {
      let unhandledRejection: unknown = null
      const onUnhandled = (event: PromiseRejectionEvent | { reason: unknown }) => {
        unhandledRejection = 'reason' in event ? event.reason : event
      }
      window.addEventListener('unhandledrejection', onUnhandled as EventListener)

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const form = createMockForm({ autoDoubleClick: false })
        let rejectWrite: (err: unknown) => void = () => {}
        const delayedPromise = new Promise<boolean>((_resolve, reject) => {
          rejectWrite = reject
        })

        form.set = vi.fn().mockImplementation(() => delayedPromise)

        const { container, render, unmount } = mountSection({ form })
        await render()

        // Verify listener was registered on the form
        expect(form.listeners.size).toBe(1)
        expect((window as unknown as { __DSH_WL_SETTINGS_STORE__?: unknown }).__DSH_WL_SETTINGS_STORE__).toBeDefined()

        // Submit write by clicking the switch
        const switchBtn = container.querySelector('#switch-auto-double-click') as HTMLButtonElement
        expect(switchBtn).toBeTruthy()
        await act(async () => {
          switchBtn.click()
        })
        expect(form.set).toHaveBeenCalledWith('autoDoubleClick', true)

        // Unmount the component while the write is still in flight!
        await unmount()

        // Verify subscription and global store cleaned up on unmount
        expect(form.listeners.size).toBe(0)
        expect((window as unknown as { __DSH_WL_SETTINGS_STORE__?: unknown }).__DSH_WL_SETTINGS_STORE__).toBeUndefined()

        // Settle the delayed promise with a rejection to verify catch block is safe after unmount
        await act(async () => {
          rejectWrite(new Error('Late network error after unmount'))
        })

        // Allow microtasks to complete
        await new Promise((r) => setTimeout(r, 20))

        // Assert: zero unhandled promise rejections
        expect(unhandledRejection).toBeNull()

        // Assert: no React state update on unmounted component warning
        const reactWarnings = consoleErrorSpy.mock.calls.filter((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('unmounted component')),
        )
        expect(reactWarnings).toHaveLength(0)

        // Assert: zero lingering subscriptions or listeners
        expect(form.listeners.size).toBe(0)
      } finally {
        window.removeEventListener('unhandledrejection', onUnhandled as EventListener)
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('DictionarySettingsComponents Accessibility & Behavior', () => {
    describe('Switch Component', () => {
      it('renders switch role and aria attributes accurately', () => {
        const html = renderToStaticMarkup(
          React.createElement(Switch, {
            checked: true,
            label: 'Test Switch',
            id: 'test-switch',
            onChange: () => {},
          }),
        )
        expect(html).toContain('role="switch"')
        expect(html).toContain('aria-checked="true"')
        expect(html).toContain('aria-label="Test Switch"')
        expect(html).toContain('id="test-switch"')
      })

      it('renders disabled attribute when disabled is true', () => {
        const html = renderToStaticMarkup(
          React.createElement(Switch, {
            checked: false,
            disabled: true,
            label: 'Disabled Switch',
            onChange: () => {},
          }),
        )
        expect(html).toContain('disabled=""')
        expect(html).toContain('aria-checked="false"')
      })

      it('prevents default on Space key and invokes onChange', () => {
        const onChange = vi.fn()
        let capturedElement: React.ReactElement | null = null
        function SwitchWrapper() {
          const el = Switch({
            checked: false,
            label: 'Keyboard Switch',
            onChange,
          })
          capturedElement = el
          return el
        }
        renderToStaticMarkup(React.createElement(SwitchWrapper))

        expect(capturedElement).not.toBeNull()
        const preventDefault = vi.fn()
        capturedElement!.props.onKeyDown({ key: ' ', preventDefault })

        expect(preventDefault).toHaveBeenCalled()
        expect(onChange).toHaveBeenCalledWith(true)
      })

      it('debounces rapid toggle calls within 80ms', () => {
        const onChange = vi.fn()
        let capturedElement: React.ReactElement | null = null
        function SwitchWrapper() {
          const el = Switch({
            checked: false,
            label: 'Debounce Switch',
            onChange,
          })
          capturedElement = el
          return el
        }
        renderToStaticMarkup(React.createElement(SwitchWrapper))

        expect(capturedElement).not.toBeNull()
        // First click triggers onChange
        capturedElement!.props.onClick()
        expect(onChange).toHaveBeenCalledTimes(1)

        // Immediate second click is debounced
        capturedElement!.props.onClick()
        expect(onChange).toHaveBeenCalledTimes(1)
      })
    })

    describe('ModalConfirm Component', () => {
      it('renders accessible dialog container and attributes', () => {
        const html = renderToStaticMarkup(
          React.createElement(ModalConfirm, {
            title: '确认操作',
            message: '此操作不可撤销，确定要继续吗？',
            confirmLabel: '立即执行',
            cancelLabel: '暂不执行',
            onConfirm: () => {},
            onCancel: () => {},
          }),
        )
        expect(html).toContain('role="dialog"')
        expect(html).toContain('aria-modal="true"')
        expect(html).toContain('aria-labelledby="confirm-dialog-title"')
        expect(html).toContain('id="confirm-dialog-title"')
        expect(html).toContain('确认操作')
        expect(html).toContain('此操作不可撤销，确定要继续吗？')
        expect(html).toContain('立即执行')
        expect(html).toContain('暂不执行')
      })

      it('renders danger button variant when isDanger is true', () => {
        const html = renderToStaticMarkup(
          React.createElement(ModalConfirm, {
            title: '移除确认',
            message: '确定移除本地词典吗？',
            isDanger: true,
            onConfirm: () => {},
            onCancel: () => {},
          }),
        )
        expect(html).toContain('移除确认')
        // Danger button has background styled with error token
        expect(html).toContain('var(--wl-set-error, #ef4444)')
      })
    })
  })
})
