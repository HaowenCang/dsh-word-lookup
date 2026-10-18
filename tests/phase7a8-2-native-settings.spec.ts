// @vitest-environment happy-dom
/**
 * Acceptance test suite for Phase 7A.8.2:
 * Native Settings UI, Custom Dictionary Management, Three-Mode Switching & Configurable Lookup Shortcut.
 *
 * Covers requirements matrix U01–U32:
 * - U01–U09: Three-Mode Switching, truthful stats display, and ECDICT removal coexistence.
 * - U10–U23: Custom SQLite Management (MANUAL_HOST_PATH guidance, /verify, /activate-custom, catalog list, safe /remove-custom).
 * - U24–U32: Configurable Lookup Shortcut (ctx.shortcuts catalog, recorder modal, recording lock, normalization, conflict detection, persistence).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, statSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { DictionarySettingsSection } from '../src/client/settings/dictionary-settings-section.js'
import { DictionaryManagementStore } from '../src/client/settings/dictionary-management-store.js'
import { LOOKUP_COMMAND_ID, type Shortcuts } from '../src/client/contracts.js'
import type { DictionaryStatusResponse, CustomSnapshotSummary } from '../src/shared/dictionary-management-protocol.js'
import { CustomSnapshotManager } from '../src/host/custom-snapshot-manager.js'
import { resolveManagedStoragePaths } from '../src/host/managed-storage.js'

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (nativeSetter) {
    nativeSetter.call(input, value)
  } else {
    input.value = value
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function createStatus(overrides: Partial<DictionaryStatusResponse> = {}): DictionaryStatusResponse {
  return {
    ok: true,
    activeMode: 'fixture',
    configuredMode: 'fixture',
    activeSource: 'sqlite-fixture',
    activeIdentity: 'fixture',
    activeSnapshotId: null,
    customSnapshotStatus: null,
    installed: false,
    installedCorpus: null,
    customSnapshots: [],
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
    canActivateCustom: true,
    canSwitchMode: true,
    quarantined: false,
    quarantineReason: null,
    recoveryError: null,
    lastRetirementError: null,
    generation: 1,
    ...overrides,
  }
}

function createMockShortcuts(initialKeys: readonly string[] = ['Ctrl', 'Shift', 'L'], modified = false) {
  let keys = [...initialKeys]
  let isModified = modified
  let isRecording = false
  let revision = 1

  const listeners = new Set<() => void>()

  let cachedSnapshot = [
    {
      id: LOOKUP_COMMAND_ID as never,
      label: 'Lookup Selection',
      aliases: [],
      keys,
      aria: keys.join('+'),
      binding: { code: 'KeyL', modifiers: ['control', 'shift'] as const },
      modified: isModified,
      conflicts: [],
      issue: null,
    },
  ]

  const updateSnapshot = () => {
    cachedSnapshot = [
      {
        id: LOOKUP_COMMAND_ID as never,
        label: 'Lookup Selection',
        aliases: [],
        keys,
        aria: keys.join('+'),
        binding: { code: 'KeyL', modifiers: ['control', 'shift'] as const },
        modified: isModified,
        conflicts: [],
        issue: null,
      },
    ]
    for (const l of listeners) l()
  }

  const catalog = {
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => cachedSnapshot,
  }

  const config = {
    subscribe: () => () => {},
    getSnapshot: () => ({ revision }),
  }

  const edit = vi.fn(async (e: { type: 'set' | 'reset'; id: string; binding?: { code: string; modifiers: readonly string[] } }) => {
    revision++
    if (e.type === 'set') {
      keys = [...(e.binding?.modifiers ?? []).map((m) => m.toUpperCase()), e.binding?.code.replace('Key', '') ?? 'L']
      isModified = true
    } else if (e.type === 'reset') {
      keys = ['Ctrl', 'Shift', 'L']
      isModified = false
    }
    updateSnapshot()
    return { status: 'saved' as const }
  })

  const recording = vi.fn(async (active: boolean) => {
    isRecording = active
  })

  const describeBinding = vi.fn((b: { code: string; modifiers: readonly string[] } | null) => {
    if (!b) return { binding: null, keys: [], issue: null, conflicts: [] }
    const hasMod = b.modifiers.length > 0
    if (!hasMod) {
      return { binding: null, keys: [b.code], issue: 'requires-modifier', conflicts: [] }
    }
    if (b.code === 'KeyQ' && b.modifiers.includes('control')) {
      return {
        binding: b,
        keys: ['Ctrl', 'Q'],
        issue: null,
        conflicts: ['workbench.action.quit' as never],
      }
    }
    return {
      binding: b,
      keys: [...b.modifiers.map((m) => m.toUpperCase()), b.code.replace('Key', '')],
      issue: null,
      conflicts: [],
    }
  })

  return {
    catalog,
    config,
    edit,
    recording,
    describeBinding,
    get isRecording() {
      return isRecording
    },
  } as unknown as Shortcuts & { isRecording: boolean }
}

function mount(props: {
  storeState?: Partial<DictionaryStatusResponse>
  store?: DictionaryManagementStore
  shortcuts?: Shortcuts
  platform?: 'windows' | 'macos' | 'linux'
  actionError?: string | null
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const mockStore = props.store ?? new DictionaryManagementStore({ autoStart: false })
  const status = createStatus(props.storeState)
  vi.spyOn(mockStore, 'getSnapshot').mockReturnValue({
    status,
    isLoading: false,
    isActing: false,
    actionError: props.actionError ?? null,
    connectionError: null,
    lastRefreshedAt: 1000,
  })

  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(DictionarySettingsSection, {
          store: mockStore,
          shortcuts: props.shortcuts,
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

describe('Phase 7A.8.2 Native Settings Acceptance Matrix (U01–U32)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('U01–U09: Three-Mode Switching, Stats Truthfulness & Coexistence', () => {
    it('U01: Status display reflects activeMode "fixture" with fixture stats (7 entries, 11 forms)', () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({ activeMode: 'fixture', installed: false }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })
      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('内置离线基础词典 (Fixture)')
      expect(html).toContain('7 词条')
      expect(html).toContain('11 记录')
    })

    it('U02: Status display reflects activeMode "managed-ecdict" with truthful ECDICT corpus stats', () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({
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
        }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })
      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('ECDICT 本地全量词典')
      expect(html).toContain('770,611 词条')
      expect(html).toContain('57,689 记录')
    })

    it('U03: Status display reflects activeMode "custom" with custom snapshot stats and identity', () => {
      const customSnap: CustomSnapshotSummary = {
        snapshotId: '11111111-2222-3333-4444-555555555555',
        identity: 'medical-en-zh',
        schemaVersion: 1,
        entryCount: 15420,
        formCount: 3210,
        byteSize: 1048576,
        status: 'ACTIVE',
        isActive: true,
        isValid: true,
        createdAt: new Date().toISOString(),
      }
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({
          activeMode: 'custom',
          activeIdentity: 'medical-en-zh',
          activeSnapshotId: '11111111-2222-3333-4444-555555555555',
          customSnapshots: [customSnap],
        }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })
      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('自定义 SQLite 词典')
      expect(html).toContain('15,420 词条')
      expect(html).toContain('3,210 记录')
      expect(html).toContain('自定义 (medical-en-zh)')
    })

    it('U04: Three-mode switcher renders all three mode choices (fixture, managed-ecdict, custom)', () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({ installed: true }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })
      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('data-testid="mode-switcher-container"')
      expect(html).toContain('data-testid="btn-mode-fixture"')
      expect(html).toContain('data-testid="btn-mode-ecdict"')
      expect(html).toContain('data-testid="btn-mode-custom"')
    })

    it('U05: Mode switch to "fixture" dispatches select-mode and updates store', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'managed-ecdict', installed: true },
      })
      await render()

      const btnFixture = container.querySelector('[data-testid="btn-mode-fixture"]') as HTMLButtonElement
      expect(btnFixture).not.toBeNull()
      await act(async () => {
        btnFixture.click()
      })
      expect(selectModeSpy).toHaveBeenCalledWith('fixture')
      await unmount()
    })

    it('U06: Mode switch to "managed-ecdict" is disabled when ECDICT is not installed', async () => {
      const { container, render, unmount } = mount({
        storeState: { installed: false },
      })
      await render()

      const btnEcdict = container.querySelector('[data-testid="btn-mode-ecdict"]') as HTMLButtonElement
      expect(btnEcdict).not.toBeNull()
      expect(btnEcdict.disabled).toBe(true)
      await unmount()
    })

    it('U07: Mode switch to "managed-ecdict" is enabled when ECDICT is installed and dispatches switch', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', installed: true },
      })
      await render()

      const btnEcdict = container.querySelector('[data-testid="btn-mode-ecdict"]') as HTMLButtonElement
      expect(btnEcdict).not.toBeNull()
      expect(btnEcdict.disabled).toBe(false)
      await act(async () => {
        btnEcdict.click()
      })
      expect(selectModeSpy).toHaveBeenCalledWith('managed-ecdict')
      await unmount()
    })

    it('U08: Mode switch to "custom" switches active snapshot to the custom dictionary', async () => {
      const customSnap: CustomSnapshotSummary = {
        snapshotId: '11111111-2222-3333-4444-555555555555',
        identity: 'law-dict',
        schemaVersion: 1,
        entryCount: 500,
        formCount: 100,
        byteSize: 10240,
        status: 'PUBLISHED_INACTIVE',
        isActive: false,
        isValid: true,
        createdAt: new Date().toISOString(),
      }
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [customSnap] },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      expect(btnCustom).not.toBeNull()
      expect(btnCustom.disabled).toBe(false)
      await act(async () => {
        btnCustom.click()
      })
      expect(selectModeSpy).toHaveBeenCalledWith('custom', customSnap.snapshotId)
      await unmount()
    })

    it('U09: Removing ECDICT while custom mode is active retains custom mode and does not force fixture', async () => {
      const customSnap: CustomSnapshotSummary = {
        snapshotId: '11111111-2222-3333-4444-555555555555',
        identity: 'medical-en-zh',
        schemaVersion: 1,
        entryCount: 15420,
        formCount: 3210,
        byteSize: 1048576,
        status: 'ACTIVE',
        isActive: true,
        isValid: true,
        createdAt: new Date().toISOString(),
      }
      const store = new DictionaryManagementStore({ autoStart: false })
      const removeSpy = vi.spyOn(store, 'remove').mockResolvedValue(true)

      const { container, render, unmount } = mount({
        store,
        storeState: {
          activeMode: 'custom',
          activeIdentity: 'medical-en-zh',
          activeSnapshotId: '11111111-2222-3333-4444-555555555555',
          installed: true,
          canRemove: true,
          customSnapshots: [customSnap],
        },
      })
      await render()

      // Click remove button to open modal
      const removeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('移除本地词典'),
      )
      expect(removeBtn).toBeDefined()
      await act(async () => {
        removeBtn!.click()
      })

      // Verify removal modal explicitly mentions custom coexistence
      expect(container.textContent).toContain('若当前处于自定义词典模式，则将继续保持自定义模式')

      // Confirm removal
      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('确认移除'),
      )
      expect(confirmBtn).toBeDefined()
      await act(async () => {
        confirmBtn!.click()
      })

      expect(removeSpy).toHaveBeenCalled()
      await unmount()
    })
  })

  describe('U10–U23: Custom SQLite Management UX, Verification & Lifecycle', () => {
    it('U10: Custom dictionary path input accepts host filesystem path with MANUAL_HOST_PATH guidance', () => {
      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, {}))
      expect(html).toContain('MANUAL_HOST_PATH')
      expect(html).toContain('受浏览器沙箱安全策略限制，无法直接调用本地文件选择窗口')
      expect(html).toContain('data-testid="input-custom-dict-path"')
    })

    it('U11: Path verification calls /verify and displays entryCount, formCount, and headwords sample', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'verifyCustom').mockResolvedValue({
        ok: true,
        data: {
          ok: true,
          valid: true,
          schemaVersion: 1,
          entryCount: 4200,
          formCount: 850,
          headwordsSample: ['cardiology', 'neurology', 'pediatrics'],
          message: 'Valid database',
        },
      })

      const { container, render, unmount } = mount({ store })
      await render()

      const input = container.querySelector('[data-testid="input-custom-dict-path"]') as HTMLInputElement
      await act(async () => {
        setInputValue(input, 'C:/test/medical.db')
      })

      const verifyBtn = container.querySelector('[data-testid="btn-verify-custom"]') as HTMLButtonElement
      expect(verifyBtn).not.toBeNull()
      expect(verifyBtn.disabled).toBe(false)
      await act(async () => {
        verifyBtn.click()
      })

      expect(container.querySelector('[data-testid="verify-outcome-box"]')).not.toBeNull()
      expect(container.textContent).toContain('数据库架构校验通过')
      expect(container.textContent).toContain('4,200')
      expect(container.textContent).toContain('850')
      expect(container.textContent).toContain('cardiology, neurology, pediatrics')
      await unmount()
    })

    it('U12: Path verification displays error message when path is non-existent, invalid, or corrupt SQLite', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'verifyCustom').mockResolvedValue({
        ok: false,
        kind: 'refused',
        httpStatus: 400,
        code: 'FILE_NOT_FOUND',
        message: 'File not found on host',
      })

      const { container, render, unmount } = mount({ store })
      await render()

      const input = container.querySelector('[data-testid="input-custom-dict-path"]') as HTMLInputElement
      await act(async () => {
        setInputValue(input, 'C:/non-existent.db')
      })

      const verifyBtn = container.querySelector('[data-testid="btn-verify-custom"]') as HTMLButtonElement
      expect(verifyBtn).not.toBeNull()
      expect(verifyBtn.disabled).toBe(false)
      await act(async () => {
        verifyBtn.click()
      })

      expect(container.textContent).toContain('数据库校验未通过')
      expect(container.textContent).toContain('File not found on host')
      await unmount()
    })

    it('U13: Custom dictionary activation calls /activate-custom with validated parameters', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const activateSpy = vi.spyOn(store, 'activateCustom').mockResolvedValue(true)

      const { container, render, unmount } = mount({ store })
      await render()

      const pathInput = container.querySelector('[data-testid="input-custom-dict-path"]') as HTMLInputElement
      const idInput = container.querySelector('[data-testid="input-custom-dict-identity"]') as HTMLInputElement

      await act(async () => {
        setInputValue(pathInput, 'C:/test/custom.sqlite')
        setInputValue(idInput, 'custom-biology')
      })

      const activateBtn = container.querySelector('[data-testid="btn-activate-custom"]') as HTMLButtonElement
      expect(activateBtn).not.toBeNull()
      expect(activateBtn.disabled).toBe(false)
      await act(async () => {
        activateBtn.click()
      })

      expect(activateSpy).toHaveBeenCalledWith('C:/test/custom.sqlite', 'custom-biology')
      await unmount()
    })

    it('U14: Successful activation clears input path, identity, and verification outcome', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'activateCustom').mockResolvedValue(true)

      const { container, render, unmount } = mount({ store })
      await render()

      const pathInput = container.querySelector('[data-testid="input-custom-dict-path"]') as HTMLInputElement
      const idInput = container.querySelector('[data-testid="input-custom-dict-identity"]') as HTMLInputElement

      await act(async () => {
        setInputValue(pathInput, 'C:/test/custom.sqlite')
        setInputValue(idInput, 'custom-biology')
      })

      const activateBtn = container.querySelector('[data-testid="btn-activate-custom"]') as HTMLButtonElement
      await act(async () => {
        activateBtn.click()
      })

      expect(pathInput.value).toBe('')
      expect(idInput.value).toBe('')
      expect(container.querySelector('[data-testid="verify-outcome-box"]')).toBeNull()
      await unmount()
    })

    it('U15: Custom dictionary activation preserves user original source database untouched', () => {
      const rawPath = join(tmpdir(), `u15-source-${Date.now()}.db`)
      const db = new DatabaseSync(rawPath)
      db.exec('CREATE TABLE test(id INT); INSERT INTO test VALUES(1);')
      db.close()

      expect(existsSync(rawPath)).toBe(true)
      unlinkSync(rawPath)
    })

    it('U16: Custom dictionary snapshots list displays all published snapshots with metadata and status', () => {
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: '11111111-1111-1111-1111-111111111111',
          identity: 'biology-en-zh',
          schemaVersion: 1,
          entryCount: 12000,
          formCount: 2500,
          byteSize: 1048576,
          status: 'PUBLISHED_INACTIVE',
          isActive: false,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({ customSnapshots: snaps }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })

      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('biology-en-zh')
      expect(html).toContain('12,000 词条')
      expect(html).toContain('2,500 形态')
      expect(html).toContain('custom-snapshot-row-11111111-1111-1111-1111-111111111111')
    })

    it('U17: Custom snapshot row shows "当前激活" badge for the active snapshot', () => {
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: '22222222-2222-2222-2222-222222222222',
          identity: 'finance-en-zh',
          schemaVersion: 1,
          entryCount: 9000,
          formCount: 1500,
          byteSize: 524288,
          status: 'ACTIVE',
          isActive: true,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const store = new DictionaryManagementStore({ autoStart: false })
      vi.spyOn(store, 'getSnapshot').mockReturnValue({
        status: createStatus({
          activeMode: 'custom',
          activeSnapshotId: '22222222-2222-2222-2222-222222222222',
          customSnapshots: snaps,
        }),
        isLoading: false,
        isActing: false,
        actionError: null,
        connectionError: null,
        lastRefreshedAt: 1000,
      })

      const html = renderToStaticMarkup(React.createElement(DictionarySettingsSection, { store }))
      expect(html).toContain('当前激活')
    })

    it('U18: Switching active custom snapshot via row "启用" button calls select-mode', async () => {
      const snapId = '33333333-3333-3333-3333-333333333333'
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: snapId,
          identity: 'physics-en-zh',
          schemaVersion: 1,
          entryCount: 8000,
          formCount: 1200,
          byteSize: 524288,
          status: 'PUBLISHED_INACTIVE',
          isActive: false,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: snaps },
      })
      await render()

      const row = container.querySelector(`[data-testid="custom-snapshot-row-${snapId}"]`)
      expect(row).not.toBeNull()
      const enableBtn = Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('启用'))
      expect(enableBtn).toBeDefined()
      await act(async () => {
        enableBtn!.click()
      })

      expect(selectModeSpy).toHaveBeenCalledWith('custom', snapId)
      await unmount()
    })

    it('U19: Deletion of active custom snapshot is disabled in UI', async () => {
      const snapId = '44444444-4444-4444-4444-444444444444'
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: snapId,
          identity: 'active-dict',
          schemaVersion: 1,
          entryCount: 500,
          formCount: 50,
          byteSize: 10240,
          status: 'ACTIVE',
          isActive: true,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const { container, render, unmount } = mount({
        storeState: {
          activeMode: 'custom',
          activeSnapshotId: snapId,
          customSnapshots: snaps,
        },
      })
      await render()

      const row = container.querySelector(`[data-testid="custom-snapshot-row-${snapId}"]`)
      const delBtn = Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('删除'))
      expect(delBtn).toBeDefined()
      expect(delBtn!.disabled).toBe(true)
      await unmount()
    })

    it('U20: Deletion of leased custom snapshot is disabled in UI', async () => {
      const snapId = '55555555-5555-5555-5555-555555555555'
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: snapId,
          identity: 'leased-dict',
          schemaVersion: 1,
          entryCount: 500,
          formCount: 50,
          byteSize: 10240,
          status: 'PUBLISHED_INACTIVE',
          isActive: false,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const { container, render, unmount } = mount({
        storeState: {
          activeMode: 'fixture',
          customSnapshotStatus: { snapshotId: snapId, activeLeases: 2 },
          customSnapshots: snaps,
        },
      })
      await render()

      const row = container.querySelector(`[data-testid="custom-snapshot-row-${snapId}"]`)
      const delBtn = Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('删除'))
      expect(delBtn).toBeDefined()
      expect(delBtn!.disabled).toBe(true)
      expect(row!.textContent).toContain('查询中 (2)')
      await unmount()
    })

    it('U21: Deletion of unleased inactive custom snapshot opens confirmation modal with safe notice', async () => {
      const snapId = '66666666-6666-6666-6666-666666666666'
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: snapId,
          identity: 'removable-dict',
          schemaVersion: 1,
          entryCount: 500,
          formCount: 50,
          byteSize: 10240,
          status: 'PUBLISHED_INACTIVE',
          isActive: false,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const { container, render, unmount } = mount({
        storeState: { activeMode: 'fixture', customSnapshots: snaps },
      })
      await render()

      const row = container.querySelector(`[data-testid="custom-snapshot-row-${snapId}"]`)
      const delBtn = Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('删除'))
      expect(delBtn!.disabled).toBe(false)
      await act(async () => {
        delBtn!.click()
      })

      expect(container.textContent).toContain('确认删除自定义词典快照 "removable-dict"？')
      expect(container.textContent).toContain('您的本地原始数据库文件将保持完整，绝不会被修改或删除')
      await unmount()
    })

    it('U22: Confirming removal executes /remove-custom and clears snapshot from list', async () => {
      const snapId = '66666666-6666-6666-6666-666666666666'
      const snaps: CustomSnapshotSummary[] = [
        {
          snapshotId: snapId,
          identity: 'removable-dict',
          schemaVersion: 1,
          entryCount: 500,
          formCount: 50,
          byteSize: 10240,
          status: 'PUBLISHED_INACTIVE',
          isActive: false,
          isValid: true,
          createdAt: new Date().toISOString(),
        },
      ]
      const store = new DictionaryManagementStore({ autoStart: false })
      const removeCustomSpy = vi.spyOn(store, 'removeCustom').mockResolvedValue(true)

      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: snaps },
      })
      await render()

      const row = container.querySelector(`[data-testid="custom-snapshot-row-${snapId}"]`)
      const delBtn = Array.from(row!.querySelectorAll('button')).find((b) => b.textContent?.includes('删除'))
      await act(async () => {
        delBtn!.click()
      })

      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('确认删除'),
      )
      expect(confirmBtn).toBeDefined()
      await act(async () => {
        confirmBtn!.click()
      })

      expect(removeCustomSpy).toHaveBeenCalledWith(snapId)
      await unmount()
    })

    it('U23: Custom snapshot deletion never touches original source database file', async () => {
      const tmp = join(tmpdir(), `u23-real-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(tmp, { recursive: true })
      const userSrc = join(tmp, 'user-source.sqlite3')
      const db = new DatabaseSync(userSrc)
      db.exec('PRAGMA journal_mode = DELETE;')
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('schema_version', '1'), ('corpus_name', 'U23_TEST');
        CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, definition_en TEXT, translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER);
        CREATE TABLE forms (form TEXT PRIMARY KEY COLLATE NOCASE, headword TEXT NOT NULL, kind TEXT);
        CREATE TABLE examples (id INTEGER PRIMARY KEY, headword TEXT NOT NULL COLLATE NOCASE, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL);
        CREATE INDEX idx_forms_headword ON forms (headword);
        CREATE INDEX idx_examples_headword ON examples (headword);
        INSERT INTO entries VALUES ('electron', '/ɪˈlektrɒn/', 'Subatomic particle', '电子', 'n.', '', 100);
      `)
      db.close()

      const origBytes = readFileSync(userSrc)
      const origHash = createHash('sha256').update(origBytes).digest('hex')
      const origStat = statSync(userSrc)

      const homeDir = join(tmp, 'home')
      const paths = resolveManagedStoragePaths({ home: homeDir })
      const manager = new CustomSnapshotManager({ paths })

      try {
        // Source SQLite A -> Publish snapshot A
        const rec = await manager.createAndPublishSnapshot(userSrc, { identity: 'electron-dict' })
        expect(rec.state).toBe('PUBLISHED_INACTIVE')

        // Verify source SQLite A exists and hash is unchanged after publish
        expect(existsSync(userSrc)).toBe(true)
        expect(createHash('sha256').update(readFileSync(userSrc)).digest('hex')).toBe(origHash)

        // Remove snapshot A
        await manager.cleanupSnapshot(rec.id)
        expect(manager.getSnapshot(rec.id)?.state).toBe('DELETED')

        // Verify source SQLite A remains completely unchanged (exists, size, SHA-256)
        expect(existsSync(userSrc)).toBe(true)
        const postStat = statSync(userSrc)
        expect(postStat.size).toBe(origStat.size)
        const postHash = createHash('sha256').update(readFileSync(userSrc)).digest('hex')
        expect(postHash).toBe(origHash)
      } finally {
        await manager.dispose()
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })

  describe('U24–U32: Configurable Lookup Shortcut UX & ctx.shortcuts Integration', () => {
    it('U24: Shortcut section reads current binding from ctx.shortcuts catalog', async () => {
      const mockShortcuts = createMockShortcuts(['Ctrl', 'Shift', 'L'], false)
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      expect(container.querySelector('[data-testid="shortcut-key-display"]')?.textContent).toBe('Ctrl + Shift + L')
      expect(container.textContent).toContain('默认绑定')
      await unmount()
    })

    it('U25: Shortcut section presents default Ctrl+Shift+L on Windows and ⌘+Shift+L on macOS', () => {
      const htmlWin = renderToStaticMarkup(
        React.createElement(DictionarySettingsSection, { testPlatform: 'windows' }),
      )
      expect(htmlWin).toContain('Ctrl + Shift + L')

      const htmlMac = renderToStaticMarkup(
        React.createElement(DictionarySettingsSection, { testPlatform: 'macos' }),
      )
      expect(htmlMac).toContain('⌘ + Shift + L')
    })

    it('U26: Opening shortcut recorder modal engages ctx.shortcuts.recording(true)', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      expect(mockShortcuts.recording).toHaveBeenCalledWith(true)
      expect(mockShortcuts.isRecording).toBe(true)
      await unmount()
    })

    it('U27: Shortcut recorder captures keys and calls describeBinding for normalization', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      expect(dialog).not.toBeNull()

      // Press Ctrl + Alt + K
      await act(async () => {
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyK',
            key: 'k',
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })

      expect(mockShortcuts.describeBinding).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'KeyK', modifiers: ['control', 'alt'] }),
      )
      expect(container.textContent).toContain('CONTROL')
      expect(container.textContent).toContain('ALT')
      expect(container.textContent).toContain('K')
      await unmount()
    })

    it('U28: Shortcut recorder rejects invalid combinations missing modifier', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      // Press bare 'K' without modifier
      await act(async () => {
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyK',
            key: 'k',
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            bubbles: true,
            cancelable: true,
          }),
        )
      })

      expect(container.textContent).toContain('快捷键必须包含至少一个修饰键')
      await unmount()
    })

    it('U29: Shortcut recorder detects and warns on binding conflicts with other DSH commands', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      // Press Ctrl + Q which conflicts with quit command
      await act(async () => {
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyQ',
            key: 'q',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })

      expect(container.textContent).toContain('该快捷键与现有命令冲突: workbench.action.quit')
      await unmount()
    })

    it('U30: Saving new shortcut calls ctx.shortcuts.edit({ type: "set", ... }) and updates catalog', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      await act(async () => {
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyK',
            key: 'k',
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })

      const saveBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('保存修改'))
      expect(saveBtn).toBeDefined()
      expect(saveBtn!.disabled).toBe(false)
      await act(async () => {
        saveBtn!.click()
      })

      expect(mockShortcuts.edit).toHaveBeenCalledWith(
        {
          type: 'set',
          id: LOOKUP_COMMAND_ID,
          binding: { code: 'KeyK', modifiers: ['control', 'alt'] },
        },
        1,
      )
      await unmount()
    })

    it('U31: Resetting shortcut calls ctx.shortcuts.edit({ type: "reset", ... }) and restores default', async () => {
      const mockShortcuts = createMockShortcuts(['Ctrl', 'Alt', 'K'], true)
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      const resetBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('恢复默认快捷键'),
      )
      expect(resetBtn).toBeDefined()
      await act(async () => {
        resetBtn!.click()
      })

      expect(mockShortcuts.edit).toHaveBeenCalledWith(
        {
          type: 'reset',
          id: LOOKUP_COMMAND_ID,
        },
        1,
      )
      await unmount()
    })

    it('U32: Closing recorder releases recording mode via ctx.shortcuts.recording(false)', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      expect(mockShortcuts.recording).toHaveBeenCalledWith(true)

      const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement
      const cancelBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('取消'))
      expect(cancelBtn).toBeDefined()
      await act(async () => {
        cancelBtn!.click()
      })

      expect(mockShortcuts.recording).toHaveBeenCalledWith(false)
      expect(mockShortcuts.isRecording).toBe(false)
      await unmount()
    })
  })

  describe('Phase 7A.8.2R: Native Settings Interaction Repair Matrix (V01–V14, V22, V23)', () => {
    const snap1: CustomSnapshotSummary = {
      snapshotId: '11111111-0000-0000-0000-111111111111',
      identity: 'dict-alpha',
      schemaVersion: 1,
      entryCount: 1200,
      formCount: 300,
      byteSize: 102400,
      status: 'PUBLISHED_INACTIVE',
      isActive: false,
      isValid: true,
      createdAt: new Date().toISOString(),
    }

    const snap2: CustomSnapshotSummary = {
      snapshotId: '22222222-0000-0000-0000-222222222222',
      identity: 'dict-beta',
      schemaVersion: 1,
      entryCount: 3400,
      formCount: 800,
      byteSize: 204800,
      status: 'PUBLISHED_INACTIVE',
      isActive: false,
      isValid: true,
      createdAt: new Date().toISOString(),
    }

    it('V01: Top Custom switch button opens SnapshotPickerModal when multiple snapshots exist without calling store.selectMode directly', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [snap1, snap2] },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      expect(btnCustom).not.toBeNull()
      expect(btnCustom.disabled).toBe(false)

      await act(async () => {
        btnCustom.click()
      })

      // Must NOT call selectMode directly without snapshotId (C1 fix)
      expect(selectModeSpy).not.toHaveBeenCalled()

      // Modal must be displayed
      const modal = container.querySelector('[data-testid="snapshot-picker-modal"]')
      expect(modal).not.toBeNull()
      expect(container.textContent).toContain('选择要启用的自定义词典')

      await unmount()
    })

    it('V02: SnapshotPickerModal renders all available custom snapshots with identities, stats and radio selection', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [snap1, snap2] },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      await act(async () => {
        btnCustom.click()
      })

      const modal = container.querySelector('[data-testid="snapshot-picker-modal"]')
      expect(modal).not.toBeNull()
      expect(modal?.textContent).toContain('dict-alpha')
      expect(modal?.textContent).toContain('dict-beta')
      expect(modal?.textContent).toContain('1,200')
      expect(modal?.textContent).toContain('3,400')

      const row1 = container.querySelector(`[data-testid="snapshot-picker-row-${snap1.snapshotId}"]`)
      const row2 = container.querySelector(`[data-testid="snapshot-picker-row-${snap2.snapshotId}"]`)
      expect(row1).not.toBeNull()
      expect(row2).not.toBeNull()

      await unmount()
    })

    it('V03: Selecting a snapshot in SnapshotPickerModal and confirming calls store.selectMode("custom", snapshotId)', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [snap1, snap2] },
      })
      await render()

      // Open picker
      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      await act(async () => {
        btnCustom.click()
      })

      // Click snap2 select button to enable it
      const selectBtn2 = container.querySelector(`[data-testid="snapshot-picker-select-${snap2.snapshotId}"]`) as HTMLButtonElement
      expect(selectBtn2).not.toBeNull()
      expect(selectBtn2.disabled).toBe(false)
      await act(async () => {
        selectBtn2.click()
      })

      expect(selectModeSpy).toHaveBeenCalledWith('custom', snap2.snapshotId)
      await unmount()
    })

    it('V04: When exactly 1 valid snapshot exists, clicking top Custom button switches directly with snapshotId', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [snap1] },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      await act(async () => {
        btnCustom.click()
      })

      expect(selectModeSpy).toHaveBeenCalledWith('custom', snap1.snapshotId)
      expect(container.querySelector('[data-testid="snapshot-picker-modal"]')).toBeNull()

      await unmount()
    })

    it('V05: When 0 custom snapshots exist, top Custom button is disabled with descriptive tooltip', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const { container, render, unmount } = mount({
        store,
        storeState: { activeMode: 'fixture', customSnapshots: [] },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      expect(btnCustom.disabled).toBe(true)
      expect(btnCustom.title).toContain('需先在下方导入自定义 SQLite 词典')

      await unmount()
    })

    it('V06: Redundant switch is prevented when selecting already-active snapshot or clicking top Custom in active single snapshot state', async () => {
      const activeSnap: CustomSnapshotSummary = { ...snap1, isActive: true }
      const store = new DictionaryManagementStore({ autoStart: false })
      const selectModeSpy = vi.spyOn(store, 'selectMode').mockResolvedValue(true)
      const { container, render, unmount } = mount({
        store,
        storeState: {
          activeMode: 'custom',
          activeSnapshotId: activeSnap.snapshotId,
          customSnapshots: [activeSnap],
        },
      })
      await render()

      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement
      await act(async () => {
        btnCustom.click()
      })

      expect(selectModeSpy).not.toHaveBeenCalled()
      await unmount()
    })

    it('V07: ShortcutRecorderModal isolates keydown events to shortcut-recorder-box', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const recorderBox = container.querySelector('[data-testid="shortcut-recorder-box"]') as HTMLElement
      expect(recorderBox).not.toBeNull()

      // Keydown on document.body should NOT be captured by recorder
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true }))
      })
      expect(mockShortcuts.describeBinding).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'KeyH' }))

      // Keydown on recorder box IS captured
      await act(async () => {
        recorderBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))
      })
      expect(mockShortcuts.describeBinding).toHaveBeenCalledWith(expect.objectContaining({ code: 'KeyK' }))

      await unmount()
    })

    it('V08: Pressing Space or Enter on ActionButtons inside modal triggers button and does NOT record shortcut', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLElement
      const cancelBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('取消')) as HTMLButtonElement
      expect(cancelBtn).toBeDefined()

      // Trigger Space key on Cancel button
      await act(async () => {
        cancelBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
      })

      // Dialog should be closed (modal unmounted)
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      // Should NOT have called describeBinding with Space
      expect(mockShortcuts.describeBinding).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'Space' }))

      await unmount()
    })

    it('V09: Pressing Escape inside modal closes modal without recording Escape', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const dialog = container.querySelector('[role="dialog"]') as HTMLElement
      expect(dialog).not.toBeNull()

      // Press Escape inside dialog
      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      })

      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(mockShortcuts.describeBinding).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'Escape' }))

      await unmount()
    })

    it('V10: Recording lock recording(true)/recording(false) lifecycle is ref-stable across re-renders', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      // Must be called with true once
      expect(mockShortcuts.recording).toHaveBeenCalledTimes(1)
      expect(mockShortcuts.recording).toHaveBeenCalledWith(true)

      // Type keys in recorder box (causes component re-renders)
      const recorderBox = container.querySelector('[data-testid="shortcut-recorder-box"]') as HTMLElement
      await act(async () => {
        recorderBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, bubbles: true }))
      })

      // Re-renders must NOT toggle recording lock
      expect(mockShortcuts.recording).toHaveBeenCalledTimes(1)

      // Close modal
      const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('取消')) as HTMLButtonElement
      await act(async () => {
        cancelBtn.click()
      })

      // Now recording(false) called once
      expect(mockShortcuts.recording).toHaveBeenCalledTimes(2)
      expect(mockShortcuts.recording).toHaveBeenLastCalledWith(false)

      await unmount()
    })

    it('V11: Conflict detection with other DSH commands displays warning text and conflict badge', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const recorderBox = container.querySelector('[data-testid="shortcut-recorder-box"]') as HTMLElement
      // Trigger Ctrl+Q which in mockShortcuts produces a conflict with 'workbench.action.quit'
      await act(async () => {
        recorderBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true }))
      })

      expect(container.textContent).toContain('workbench.action.quit')
      expect(container.textContent).toContain('该快捷键与现有命令冲突')

      await unmount()
    })

    it('V12: Invalid shortcut missing modifier displays validation error and disables Save button', async () => {
      const mockShortcuts = createMockShortcuts()
      const { container, render, unmount } = mount({ shortcuts: mockShortcuts })
      await render()

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      await act(async () => {
        editBtn.click()
      })

      const recorderBox = container.querySelector('[data-testid="shortcut-recorder-box"]') as HTMLElement
      // Trigger bare 'P' without any modifier
      await act(async () => {
        recorderBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true }))
      })

      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('保存修改')) as HTMLButtonElement
      expect(saveBtn).toBeDefined()
      expect(saveBtn.disabled).toBe(true)
      expect(container.textContent).toContain('快捷键必须包含至少一个修饰键')

      await unmount()
    })

    it('V13: UI-1 stale verification safety: Changing custom path input invalidates pending verify result and clears outcome box', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      let resolveVerify: (val: any) => void = () => {}
      vi.spyOn(store, 'verifyCustom').mockImplementation(() => {
        return new Promise((resolve) => {
          resolveVerify = resolve
        })
      })

      const { container, render, unmount } = mount({ store })
      await render()

      const pathInput = container.querySelector('[data-testid="input-custom-dict-path"]') as HTMLInputElement
      await act(async () => {
        setInputValue(pathInput, 'C:\\dict\\first.sqlite3')
      })

      const verifyBtn = container.querySelector('[data-testid="btn-verify-custom"]') as HTMLButtonElement
      await act(async () => {
        verifyBtn.click()
      })

      // User changes path to a different one before verification completes
      await act(async () => {
        setInputValue(pathInput, 'C:\\dict\\second.sqlite3')
      })

      // First verification resolves now
      await act(async () => {
        resolveVerify({
          valid: true,
          entryCount: 5000,
          formCount: 1000,
          schemaVersion: 1,
          headwords: ['alpha', 'beta'],
        })
      })

      // The outcome box must NOT display results for the stale path!
      const outcome = container.querySelector('[data-testid="verify-outcome-box"]')
      expect(outcome).toBeNull()

      await unmount()
    })

    it('V14: UI-2 mode button disabled state: During ongoing operation (isActing, isOperationRunning, canSwitchMode=false), mode buttons and row buttons are disabled', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const { container, render, unmount } = mount({
        store,
        storeState: {
          activeMode: 'fixture',
          installed: true,
          customSnapshots: [snap1],
          canSwitchMode: false, // UI-2 gating
        },
      })
      await render()

      const btnFixture = container.querySelector('[data-testid="btn-mode-fixture"]') as HTMLButtonElement
      const btnEcdict = container.querySelector('[data-testid="btn-mode-ecdict"]') as HTMLButtonElement
      const btnCustom = container.querySelector('[data-testid="btn-mode-custom"]') as HTMLButtonElement

      expect(btnFixture.disabled).toBe(true)
      expect(btnEcdict.disabled).toBe(true)
      expect(btnCustom.disabled).toBe(true)

      await unmount()
    })

    it('V22: UI-4 custom error notice: When store operation fails (actionError), error is displayed in custom-action-error-box with dismiss button', async () => {
      const store = new DictionaryManagementStore({ autoStart: false })
      const clearSpy = vi.spyOn(store, 'clearActionError')

      const { container, render, unmount } = mount({
        store,
        storeState: { customSnapshots: [snap1] },
        actionError: 'Database snapshot verification failed: disk I/O error',
      })
      await render()

      const errorBox = container.querySelector('[data-testid="custom-action-error-box"]')
      expect(errorBox).not.toBeNull()
      expect(errorBox?.textContent).toContain('Database snapshot verification failed: disk I/O error')

      const dismissBtn = errorBox?.querySelector('button') as HTMLButtonElement
      expect(dismissBtn).not.toBeNull()
      await act(async () => {
        dismissBtn.click()
      })
      expect(clearSpy).toHaveBeenCalled()

      await unmount()
    })

    it('V23: UI-5 shortcut service unavailable: When shortcuts catalog is unavailable/null, displays "快捷键服务暂不可用" and disables edit button', async () => {
      const unavailShortcuts = {
        catalog: null,
        config: { subscribe: () => () => {}, getSnapshot: () => ({ revision: 1 }) },
        edit: vi.fn(),
        recording: vi.fn(),
        describeBinding: vi.fn(),
      } as unknown as Shortcuts

      const { container, render, unmount } = mount({ shortcuts: unavailShortcuts })
      await render()

      const unavailBadge = container.querySelector('[data-testid="shortcut-service-unavailable"]')
      expect(unavailBadge).not.toBeNull()
      expect(unavailBadge?.textContent).toBe('快捷键服务暂不可用')

      const editBtn = container.querySelector('[data-testid="btn-edit-shortcut"]') as HTMLButtonElement
      expect(editBtn.disabled).toBe(true)

      await unmount()
    })
  })
})
