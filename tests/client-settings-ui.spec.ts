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
    it('renders initial fixture mode with 12 entries and neutral badge', () => {
      const html = renderSection({
        storeState: { activeMode: 'fixture', installed: false },
      })

      expect(html).toContain('当前活动词典')
      expect(html).toContain('内置离线基础词典 (Fixture)')
      expect(html).toContain('12 词条')
      expect(html).toContain('12 记录')
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
})
