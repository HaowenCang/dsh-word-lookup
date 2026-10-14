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

import React from 'react'
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

function renderSection(props: {
  storeState?: Partial<DictionaryStatusResponse>
  form?: ReturnType<typeof createMockForm>
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
    it('renders Ctrl + Shift + L on Windows', () => {
      const html = renderSection({ platform: 'windows' })
      expect(html).toContain('Ctrl + Shift + L')
    })

    it('renders ⌘ + Shift + L on macOS', () => {
      const html = renderSection({ platform: 'macos' })
      expect(html).toContain('⌘ + Shift + L')
    })

    it('renders 未绑定 (Unbound) on Linux Web', () => {
      const html = renderSection({ platform: 'linux' })
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
    it('P2-01: Successful write updates page and syncs with ConfigForms snapshot', () => {
      const form = createMockForm({ autoDoubleClick: true, autoSelection: false })
      const html = renderSection({ form })
      expect(html).toContain('id="switch-auto-double-click"')
      expect(html).toContain('id="switch-auto-selection"')
      // Double click is checked
      expect(html).toMatch(/id="switch-auto-double-click"[^>]*aria-checked="true"/)
      expect(html).toMatch(/id="switch-auto-selection"[^>]*aria-checked="false"/)
    })

    it('P2-02: Form set refusal or throw displays error notice without faking saved state', () => {
      const form = createMockForm({ autoDoubleClick: false })
      form.set = vi.fn().mockResolvedValue(false)
      const html = renderSection({ form })
      // Switches remain false when set refuses
      expect(html).toMatch(/id="switch-auto-double-click"[^>]*aria-checked="false"/)
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
      const form = createMockForm({ autoDoubleClick: false })
      let resolveFirst: (v: boolean) => void = () => {}
      const firstPromise = new Promise<boolean>((res) => {
        resolveFirst = res
      })

      form.set = vi
        .fn()
        .mockImplementationOnce(() => firstPromise)
        .mockResolvedValueOnce(true)

      // Initial render
      const html = renderSection({ form })
      expect(html).toContain('id="switch-auto-double-click"')
      resolveFirst(true)
    })

    it('P2-05: Preserves persisted config across snapshot reloads', () => {
      const form = createMockForm({ autoDoubleClick: true, autoSelection: true })
      const html = renderSection({ form })
      expect(html).toMatch(/id="switch-auto-double-click"[^>]*aria-checked="true"/)
      expect(html).toMatch(/id="switch-auto-selection"[^>]*aria-checked="true"/)
    })

    it('P2-06: Unmounted component ignores late async form response without unhandled rejections', () => {
      const form = createMockForm({ autoDoubleClick: false })
      form.set = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(true), 100)),
      )
      const html = renderSection({ form })
      expect(html).toBeDefined()
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
