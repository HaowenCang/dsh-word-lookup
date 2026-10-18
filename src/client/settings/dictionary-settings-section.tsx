/**
 * Native DSH Settings Section for Dictionary Management (`settings.section`).
 *
 * Implements Phase 7A.8.2:
 * - Current Dictionary Status (Active mode, entry counts, forms, source, diagnostics).
 * - Three-Mode Switching (Fixture, Managed ECDICT, Custom SQLite).
 * - 1-Click ECDICT Installation, Real-time Streaming Progress, Safe Cancellation.
 * - Managed Corpus Removal with Confirmation Dialog, preserving active Custom mode if present.
 * - Custom SQLite Management: Host path validation (MANUAL_HOST_PATH), live /verify, /activate-custom.
 * - Custom Snapshot List with safe removal gating (unleased, inactive only) and safe /remove-custom unlinking.
 * - Automatic Lookup Switches (autoDoubleClick, autoSelection) via ConfigForms.
 * - Configurable Lookup Shortcut with ctx.shortcuts live inspection, recording modal, conflict check, and reset.
 * - Responsive, theme-aware, WCAG-accessible (WCAG 2.1 AA).
 *
 * @module dsh-word-lookup/client/settings/dictionary-settings-section
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

import { LOOKUP_COMMAND_ID, type Shortcuts } from '../contracts.js'
import {
  ActionButton,
  ModalConfirm,
  ProgressBar,
  SectionCard,
  SettingRow,
  SETTINGS_THEME_STYLES,
  ShortcutRecorderModal,
  SnapshotPickerModal,
  StatusBadge,
  Switch,
  TextInput,
  type BadgeVariant,
} from './dictionary-settings-components.js'
import {
  DictionaryManagementStore,
  type DictionaryManagementStoreState,
} from './dictionary-management-store.js'
import type { CustomSnapshotSummary } from '../../shared/dictionary-management-protocol.js'

/** Host settings schema for automatic triggers. */
export interface DictionaryHostSettings {
  readonly autoDoubleClick?: boolean
  readonly autoSelection?: boolean
  readonly dictionaryMode?: 'fixture' | 'managed-ecdict' | 'custom'
}

/** Authoritative lifecycle state for DSH shortcut integration. */
export type ShortcutServiceState =
  | 'SERVICE_UNAVAILABLE'
  | 'CATALOG_NOT_READY'
  | 'COMMAND_NOT_REGISTERED'
  | 'READ_ONLY'
  | 'READY'

/** Props passed to DictionarySettingsSection. */
export type DictionarySettingsSectionProps = Partial<PropsRuntime<'settings.section'>> & {
  /** Optional pre-configured management store. */
  readonly store?: DictionaryManagementStore
  /** Optional settings form controller for live switches. */
  readonly form?: ConfigForm<DictionaryHostSettings>
  /** Optional shortcuts registry from DSH context. */
  readonly shortcuts?: Shortcuts
  /** Force specific platform for shortcut testing. */
  readonly testPlatform?: 'windows' | 'macos' | 'linux'
}

/** Helper to detect platform for shortcut badge. */
function detectPlatform(override?: 'windows' | 'macos' | 'linux'): 'windows' | 'macos' | 'linux' {
  if (override !== undefined) return override
  if (typeof navigator === 'undefined') return 'windows'
  const p = (navigator.platform || navigator.userAgent || '').toLowerCase()
  if (p.includes('mac')) return 'macos'
  if (p.includes('linux')) return 'linux'
  return 'windows'
}

/** Helper to format keys cleanly whether already punctuated or raw. */
function formatShortcutKeys(keys?: readonly string[]): string {
  if (!keys || keys.length === 0) return '未绑定 (Unbound)'
  if (keys.includes('+')) {
    return keys.join(' ')
  }
  return keys.join(' + ')
}

export function DictionarySettingsSection({
  store: externalStore,
  form,
  shortcuts,
  testPlatform,
  close: _close,
}: DictionarySettingsSectionProps) {
  // Store initialization
  const [internalStore] = useState(() => (externalStore ? null : new DictionaryManagementStore({ autoStart: false })))
  const store = externalStore ?? internalStore!

  useEffect(() => {
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __DSH_WL_SETTINGS_STORE__?: DictionaryManagementStore }).__DSH_WL_SETTINGS_STORE__ = store
    }
    return () => {
      if (typeof window !== 'undefined') {
        const win = window as unknown as { __DSH_WL_SETTINGS_STORE__?: DictionaryManagementStore }
        if (win.__DSH_WL_SETTINGS_STORE__ === store) {
          delete win.__DSH_WL_SETTINGS_STORE__
        }
      }
      if (internalStore) {
        internalStore.dispose()
      }
    }
  }, [internalStore, store])

  const storeState: DictionaryManagementStoreState = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  // ConfigForms integration for gesture switches
  const isMountedRef = useRef(true)
  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const [formSnapshot, setFormSnapshot] = useState<ConfigFormSnapshot<DictionaryHostSettings> | null>(() => {
    return form ? form.getSnapshot() : null
  })

  useEffect(() => {
    if (!form) return
    setFormSnapshot(form.getSnapshot())
    return form.subscribe(() => {
      if (isMountedRef.current) {
        setFormSnapshot(form.getSnapshot())
      }
    })
  }, [form])

  const isFormWritable = Boolean(form && formSnapshot && formSnapshot.status === 'ready' && formSnapshot.writable)
  const [pendingDoubleClick, setPendingDoubleClick] = useState(false)
  const [pendingSelection, setPendingSelection] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const doubleClickSeqRef = useRef(0)
  const selectionSeqRef = useRef(0)

  const handleToggleDoubleClick = async (next: boolean) => {
    if (!isFormWritable || !form || pendingDoubleClick) return
    setConfigError(null)
    setPendingDoubleClick(true)
    const seq = ++doubleClickSeqRef.current
    try {
      const ok = await form.set('autoDoubleClick', next)
      if (!isMountedRef.current || seq !== doubleClickSeqRef.current) return
      if (!ok) {
        setConfigError('保存双击查词设置失败：Host 拒绝了修改，已恢复原有配置')
      }
    } catch (err) {
      if (!isMountedRef.current || seq !== doubleClickSeqRef.current) return
      setConfigError(`保存双击查词设置异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isMountedRef.current && seq === doubleClickSeqRef.current) {
        setPendingDoubleClick(false)
      }
    }
  }

  const handleToggleSelection = async (next: boolean) => {
    if (!isFormWritable || !form || pendingSelection) return
    setConfigError(null)
    setPendingSelection(true)
    const seq = ++selectionSeqRef.current
    try {
      const ok = await form.set('autoSelection', next)
      if (!isMountedRef.current || seq !== selectionSeqRef.current) return
      if (!ok) {
        setConfigError('保存框选查词设置失败：Host 拒绝了修改，已恢复原有配置')
      }
    } catch (err) {
      if (!isMountedRef.current || seq !== selectionSeqRef.current) return
      setConfigError(`保存框选查词设置异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isMountedRef.current && seq === selectionSeqRef.current) {
        setPendingSelection(false)
      }
    }
  }

  // Modals & local state
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
  const [isExpandingDetails, setIsExpandingDetails] = useState(false)

  // Custom dictionary import form state
  const [customPath, setCustomPath] = useState('')
  const [customIdentity, setCustomIdentity] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [verifyOutcome, setVerifyOutcome] = useState<{
    valid: boolean
    schemaVersion?: number
    entryCount?: number
    formCount?: number
    headwordsSample?: readonly string[]
    message: string
    error?: string
  } | null>(null)
  const [snapshotToRemove, setSnapshotToRemove] = useState<CustomSnapshotSummary | null>(null)

  // Shortcut recorder state
  const [showShortcutRecorder, setShowShortcutRecorder] = useState(false)
  const [showSnapshotPicker, setShowSnapshotPicker] = useState(false)

  // Track the path for which the current verification outcome was generated (UI-1)
  const [verifiedPath, setVerifiedPath] = useState<string | null>(null)
  const pendingVerifyPathRef = useRef<string | null>(null)

  const { status, isLoading, isActing, actionError, connectionError } = storeState
  const currentOp = status?.currentOperation
  const isOperationRunning = currentOp !== null && currentOp !== undefined && currentOp.status === 'running'

  // Platform detection for shortcut display
  const platform = detectPlatform(testPlatform)

  // Shortcuts catalog synchronization
  const activeShortcuts =
    shortcuts ??
    (typeof window !== 'undefined'
      ? (window as unknown as { __DSH_SHORTCUTS__?: Shortcuts }).__DSH_SHORTCUTS__
      : undefined)

  const catalogSnapshot = useSyncExternalStore(
    (callback) => {
      if (activeShortcuts?.catalog?.subscribe) {
        return activeShortcuts.catalog.subscribe(callback)
      }
      return () => {}
    },
    () => {
      if (activeShortcuts?.catalog?.getSnapshot) {
        return activeShortcuts.catalog.getSnapshot()
      }
      return null
    },
    () => {
      if (activeShortcuts?.catalog?.getSnapshot) {
        return activeShortcuts.catalog.getSnapshot()
      }
      return null
    },
  )

  const lookupShortcutEntry = catalogSnapshot?.find((e) => e.id === LOOKUP_COMMAND_ID)

  // Authoritative shortcut service state determination (D1)
  const shortcutServiceState: ShortcutServiceState = useMemo(() => {
    if (!activeShortcuts) {
      return 'SERVICE_UNAVAILABLE'
    }
    if (!activeShortcuts.catalog || catalogSnapshot === null) {
      return 'CATALOG_NOT_READY'
    }
    const entry = catalogSnapshot.find((e) => e.id === LOOKUP_COMMAND_ID)
    if (!entry) {
      return 'COMMAND_NOT_REGISTERED'
    }
    if (typeof activeShortcuts.edit !== 'function' || typeof activeShortcuts.recording !== 'function') {
      return 'READ_ONLY'
    }
    return 'READY'
  }, [activeShortcuts, catalogSnapshot])

  const isShortcutEditable = shortcutServiceState === 'READY'

  // Stable callback for recording lock
  const handleRecording = useCallback(
    async (active: boolean) => {
      if (activeShortcuts?.recording) {
        await activeShortcuts.recording(active)
      }
    },
    [activeShortcuts],
  )

  // Shortcut actions
  const handleSaveShortcut = async (
    binding: { code: string; modifiers: readonly string[] },
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!activeShortcuts || typeof activeShortcuts.edit !== 'function') {
      return { ok: false, error: '快捷键服务暂不可用' }
    }
    const configSnap = activeShortcuts.config?.getSnapshot ? activeShortcuts.config.getSnapshot() : null
    const revision = (configSnap as { revision?: number } | null)?.revision ?? 1
    const res = await activeShortcuts.edit(
      { type: 'set', id: LOOKUP_COMMAND_ID as never, binding: binding as never },
      revision as never,
    )
    if (res.status === 'saved') {
      return { ok: true }
    }
    const errText =
      res.status === 'conflict'
        ? `保存失败：快捷键与现有命令冲突 (${res.conflicts?.join(', ') || '未知冲突'})`
        : res.status === 'stale'
          ? '保存失败：快捷键配置已被其他操作修改（版本过期），已刷新最新状态'
          : res.status === 'not-ready'
            ? '保存失败：快捷键配置服务尚未就绪'
            : res.status === 'unreadable'
              ? '保存失败：快捷键配置存储损坏或无法读取'
              : `保存失败：Host 拒绝了该快捷键 (${res.status})`
    return { ok: false, error: errText }
  }

  const handleResetShortcut = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!activeShortcuts || typeof activeShortcuts.edit !== 'function') {
      return { ok: false, error: '快捷键服务暂不可用' }
    }
    const configSnap = activeShortcuts.config?.getSnapshot ? activeShortcuts.config.getSnapshot() : null
    const revision = (configSnap as { revision?: number } | null)?.revision ?? 1
    const res = await activeShortcuts.edit(
      { type: 'reset', id: LOOKUP_COMMAND_ID as never },
      revision as never,
    )
    if (res.status === 'saved') {
      return { ok: true }
    }
    const errText =
      res.status === 'stale'
        ? '恢复默认失败：快捷键配置已被其他操作修改，已刷新最新状态'
        : `恢复默认失败：${res.status}`
    return { ok: false, error: errText }
  }

  // Custom dictionary verification handler
  const handleVerifyCustom = async () => {
    const trimmedPath = customPath.trim()
    if (!trimmedPath || isVerifying || isActing) return
    setIsVerifying(true)
    setVerifyOutcome(null)
    setVerifiedPath(null)
    pendingVerifyPathRef.current = trimmedPath

    try {
      const res = await store.verifyCustom(trimmedPath)
      // UI-1: Stale response protection
      if (pendingVerifyPathRef.current !== trimmedPath || customPath.trim() !== trimmedPath) {
        return
      }

      if (res.ok) {
        setVerifiedPath(trimmedPath)
        setVerifyOutcome({
          valid: true,
          schemaVersion: res.data.schemaVersion,
          entryCount: res.data.entryCount,
          formCount: res.data.formCount,
          headwordsSample: res.data.headwordsSample,
          message: res.data.message || 'SQLite 数据库架构校验通过',
        })
      } else {
        setVerifiedPath(trimmedPath)
        setVerifyOutcome({
          valid: false,
          message:
            res.kind === 'refused'
              ? res.message
              : res.kind === 'network'
                ? `网络/连接异常: ${res.message}`
                : '校验请求已取消',
          error:
            res.kind === 'refused'
              ? res.code
              : res.kind === 'network'
                ? 'NETWORK_ERROR'
                : 'ABORTED',
        })
      }
    } catch (err) {
      if (pendingVerifyPathRef.current === trimmedPath && customPath.trim() === trimmedPath) {
        setVerifiedPath(trimmedPath)
        setVerifyOutcome({
          valid: false,
          message: err instanceof Error ? err.message : String(err),
          error: 'INTERNAL_ERROR',
        })
      }
    } finally {
      setIsVerifying(false)
    }
  }

  // Handler for customPath change (UI-1: invalidate stale verification outcome)
  const handleCustomPathChange = (newVal: string) => {
    setCustomPath(newVal)
    pendingVerifyPathRef.current = null
    if (verifiedPath !== null && newVal.trim() !== verifiedPath) {
      setVerifyOutcome(null)
      setVerifiedPath(null)
    }
  }

  // Custom dictionary activation handler
  const handleActivateCustom = async () => {
    const trimmedPath = customPath.trim()
    if (!trimmedPath || isActing || isVerifying) return
    const trimmedIdentity = customIdentity.trim() || undefined
    const success = await store.activateCustom(trimmedPath, trimmedIdentity)
    if (success) {
      setCustomPath('')
      setCustomIdentity('')
      setVerifyOutcome(null)
    }
  }

  // Custom snapshot removal handler
  const handleConfirmRemoveCustom = async () => {
    if (!snapshotToRemove || isActing) return
    const id = snapshotToRemove.snapshotId
    setSnapshotToRemove(null)
    await store.removeCustom(id)
  }

  // Status badge calculation
  let badgeVariant: BadgeVariant = 'neutral'
  let badgeLabel = '未安装'

  if (status?.quarantined) {
    badgeVariant = 'error'
    badgeLabel = '存储隔离保护中'
  } else if (status?.recoveryError) {
    badgeVariant = 'warning'
    badgeLabel = '恢复异常'
  } else if (isOperationRunning) {
    badgeVariant = 'info'
    if (currentOp.phase === 'downloading') badgeLabel = '正在下载词源'
    else if (currentOp.phase === 'verifying-source') badgeLabel = '正在校验源文件'
    else if (currentOp.phase === 'building') badgeLabel = '正在构建数据库'
    else if (currentOp.phase === 'validating-database') badgeLabel = '正在校验完整性'
    else if (currentOp.phase === 'activating') badgeLabel = '正在激活词典'
    else badgeLabel = '正在执行操作'
  } else if (status?.activeMode === 'custom') {
    badgeVariant = 'success'
    badgeLabel = `自定义已启用 (${status.activeIdentity ?? 'custom'})`
  } else if (status?.installed) {
    if (status.activeMode === 'managed-ecdict') {
      badgeVariant = 'success'
      badgeLabel = 'ECDICT 已启用'
    } else {
      badgeVariant = 'warning'
      badgeLabel = 'ECDICT 已安装 (未激活)'
    }
  } else {
    badgeVariant = 'neutral'
    badgeLabel = '内置基础词典 (Fixture)'
  }

  // Lookup active custom snapshot if in custom mode
  const activeCustomSnapshot =
    status?.activeMode === 'custom' && status.customSnapshots
      ? status.customSnapshots.find((s) => s.snapshotId === status.activeSnapshotId)
      : null

  // Custom snapshot calculation & mode switch capability
  const customSnapshots = status?.customSnapshots ?? []
  const validCustomSnapshots = customSnapshots.filter(
    (s) => s.corrupt !== true && s.isValid !== false,
  )

  const canSwitchMode = status?.canSwitchMode !== false && !isActing && !isOperationRunning

  const handleCustomTopButtonClick = () => {
    if (!canSwitchMode || customSnapshots.length === 0 || validCustomSnapshots.length === 0) return

    // CASE B: Exactly 1 valid custom snapshot -> directly switch with explicit snapshotId
    if (validCustomSnapshots.length === 1 && validCustomSnapshots[0]) {
      const single = validCustomSnapshots[0]
      // CASE D: Already active with this snapshot -> do nothing
      if (status?.activeMode === 'custom' && status?.activeSnapshotId === single.snapshotId) {
        return
      }
      void store.selectMode('custom', single.snapshotId)
    } else {
      // CASE C: Multiple valid snapshots -> open SnapshotPickerModal
      setShowSnapshotPicker(true)
    }
  }


  return (
    <div className="dsh-wl-settings" style={{ maxWidth: '800px', width: '100%', boxSizing: 'border-box' }}>
      <style>{SETTINGS_THEME_STYLES}</style>

      {/* Header */}
      <div style={{ marginBottom: '22px' }}>
        <h2
          style={{
            fontSize: '20px',
            fontWeight: 600,
            margin: '0 0 6px 0',
            color: 'var(--wl-set-text-main, #f2f2f7)',
          }}
        >
          词典与划词设置
        </h2>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--wl-set-text-sub, #9898a6)',
            margin: 0,
            lineHeight: '1.5',
          }}
        >
          管理离线词典数据库、词源版本以及自动查词手势触发。
        </p>
      </div>

      {/* Connection / Transport Error Notice */}
      {connectionError && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            marginBottom: '16px',
            borderRadius: '8px',
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            color: 'var(--wl-set-warn, #f59e0b)',
            fontSize: '12.5px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{connectionError}</span>
          <ActionButton size="small" variant="secondary" onClick={() => void store.refresh()}>
            重试连接
          </ActionButton>
        </div>
      )}

      {/* Quarantine / Critical Anomaly Notice */}
      {status?.quarantined && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            marginBottom: '16px',
            borderRadius: '8px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            color: 'var(--wl-set-error, #ef4444)',
            fontSize: '13px',
            lineHeight: '1.5',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>存储目录已进入隔离保护</div>
          <div>
            原因: {status.quarantineReason ?? '检测到未确认的 Worker 进程退出，系统已自动隔离存储目录以防止数据损坏。'}
          </div>
        </div>
      )}

      {/* Section A: Current Dictionary Status & 3-Mode Switching */}
      <SectionCard
        title="当前活动词典"
        description="当前在查词过程中负责提供释义的词典源与运行状态。"
        badge={<StatusBadge variant={badgeVariant} label={badgeLabel} />}
        action={
          <ActionButton
            size="small"
            variant="ghost"
            busy={isLoading}
            onClick={() => void store.refresh()}
            ariaLabel="刷新词典状态"
            title="刷新当前词典状态"
          >
            刷新状态
          </ActionButton>
        }
      >
        {/* Three-Mode Switching Control */}
        <div
          data-testid="mode-switcher-container"
          style={{
            display: 'flex',
            gap: '8px',
            marginBottom: '16px',
            paddingBottom: '14px',
            borderBottom: '1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.08))',
            flexWrap: 'wrap',
          }}
        >
          <ActionButton
            data-testid="btn-mode-fixture"
            variant={status?.activeMode === 'fixture' ? 'primary' : 'secondary'}
            size="small"
            disabled={!canSwitchMode}
            onClick={() => void store.selectMode('fixture')}
            ariaLabel="切换至内置基础词典"
          >
            内置基础词典 (Fixture)
          </ActionButton>

          <ActionButton
            data-testid="btn-mode-ecdict"
            variant={status?.activeMode === 'managed-ecdict' ? 'primary' : 'secondary'}
            size="small"
            disabled={!status?.installed || !canSwitchMode}
            onClick={() => void store.selectMode('managed-ecdict')}
            title={!status?.installed ? '需先在一键安装 ECDICT 后方可切换' : '切换至本地全量 ECDICT 词典'}
            ariaLabel="切换至本地 ECDICT 词典"
          >
            ECDICT 本地全量词典
          </ActionButton>

          <ActionButton
            data-testid="btn-mode-custom"
            variant={status?.activeMode === 'custom' ? 'primary' : 'secondary'}
            size="small"
            disabled={!canSwitchMode || customSnapshots.length === 0 || validCustomSnapshots.length === 0}
            onClick={handleCustomTopButtonClick}
            title={
              customSnapshots.length === 0
                ? '需先在下方导入自定义 SQLite 词典'
                : validCustomSnapshots.length === 0
                  ? '暂无有效可用的自定义词典快照，请重新导入或校验'
                  : '切换至自定义 SQLite 词典'
            }
            ariaLabel="切换至自定义词典"
          >
            自定义 SQLite 词典
          </ActionButton>
        </div>

        <SettingRow
          title="词典模式"
          description="当前使用的词典引擎类别"
          control={
            <span
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--wl-set-text-main, #f2f2f7)',
              }}
            >
              {status === null
                ? '加载中...'
                : status.quarantined
                  ? '存储已隔离保护'
                  : status.activeMode === 'managed-ecdict'
                    ? 'ECDICT 本地全量词典'
                    : status.activeMode === 'custom'
                      ? '自定义 SQLite 词典'
                      : '内置离线基础词典 (Fixture)'}
            </span>
          }
        />

        <SettingRow
          title="词条总数"
          description="数据库中收录的英文词目及短语条目"
          control={
            <span
              data-testid="stat-entry-count"
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--wl-set-text-main, #f2f2f7)',
              }}
            >
              {status === null
                ? '暂无统计'
                : status.activeMode === 'managed-ecdict'
                  ? status.installedCorpus?.entryCount !== undefined
                    ? `${status.installedCorpus.entryCount.toLocaleString()} 词条`
                    : '暂无统计'
                  : status.activeMode === 'custom'
                    ? activeCustomSnapshot?.entryCount !== undefined
                      ? `${activeCustomSnapshot.entryCount.toLocaleString()} 词条`
                      : '暂无统计'
                    : status.activeMode === 'fixture'
                      ? status.fixtureStats?.entryCount !== undefined
                        ? `${status.fixtureStats.entryCount} 词条`
                        : '暂无统计'
                      : '暂无统计'}
            </span>
          }
        />

        <SettingRow
          title="屈折变形与词形数"
          description="复数、过去式、进行时态等形态学归一化条目"
          control={
            <span
              data-testid="stat-form-count"
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--wl-set-text-main, #f2f2f7)',
              }}
            >
              {status === null
                ? '暂无统计'
                : status.activeMode === 'managed-ecdict'
                  ? status.installedCorpus?.formCount !== undefined
                    ? `${status.installedCorpus.formCount.toLocaleString()} 记录`
                    : '暂无统计'
                  : status.activeMode === 'custom'
                    ? activeCustomSnapshot?.formCount !== undefined
                      ? `${activeCustomSnapshot.formCount.toLocaleString()} 记录`
                      : '暂无统计'
                    : status.activeMode === 'fixture'
                      ? status.fixtureStats?.formCount !== undefined
                        ? `${status.fixtureStats.formCount} 记录`
                        : '暂无统计'
                      : '暂无统计'}
            </span>
          }
        />

        <SettingRow
          title="数据源版本"
          description="上游开源词库发布信息与来源标记"
          isLast={true}
          control={
            <span
              style={{
                fontSize: '12px',
                color: 'var(--wl-set-text-sub, #9898a6)',
                fontFamily: 'monospace',
              }}
            >
              {status === null
                ? '暂无数据'
                : status.activeMode === 'managed-ecdict'
                  ? status.installedCorpus?.commit
                    ? `ECDICT @ ${status.installedCorpus.commit.slice(0, 7)}`
                    : 'ECDICT (版本未知)'
                  : status.activeMode === 'custom'
                    ? activeCustomSnapshot?.identity
                      ? `自定义 (${activeCustomSnapshot.identity})`
                      : (status.activeIdentity ?? '自定义 SQLite')
                    : status.activeMode === 'fixture'
                      ? status.fixtureStats?.version
                        ? `内置 Fixture (${status.fixtureStats.version})`
                        : '内置 Fixture'
                      : (status.activeIdentity ?? '自定义版本')}
            </span>
          }
        />

        {/* Technical Details Accordion */}
        <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px dashed var(--wl-set-border-row, rgba(255, 255, 255, 0.08))' }}>
          <button
            type="button"
            onClick={() => setIsExpandingDetails(!isExpandingDetails)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '4px 0',
              fontSize: '12px',
              color: 'var(--wl-set-accent, #4176e6)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            {isExpandingDetails ? '收起详细技术信息 ▲' : '展开详细技术信息 ▼'}
          </button>

          {isExpandingDetails && (
            <div
              style={{
                marginTop: '10px',
                padding: '12px',
                borderRadius: '8px',
                background: 'rgba(0, 0, 0, 0.15)',
                fontSize: '12px',
                lineHeight: '1.7',
                color: 'var(--wl-set-text-sub, #9898a6)',
                fontFamily: 'monospace',
              }}
            >
              <div>活跃标识: {status?.activeIdentity ?? 'fixture'}</div>
              <div>活跃模式: {status?.activeMode ?? 'fixture'}</div>
              <div>配置模式: {status?.configuredMode ?? 'fixture'}</div>
              {status?.activeSnapshotId && <div>活跃快照: {status.activeSnapshotId}</div>}
              {status?.customSnapshotStatus && (
                <div>快照引用租约: {status.customSnapshotStatus.activeLeases}</div>
              )}
              <div>数据库文件: {status?.installedCorpus?.databaseFile ?? '内置只读'}</div>
              <div>架构版本: {status?.installedCorpus?.schemaVersion ?? 1}</div>
              <div>世代编号: {status?.generation ?? 0}</div>
              {status?.settingsSyncState && (
                <div>配置同步状态: {status.settingsSyncState}</div>
              )}
              {status?.recoveryError && (
                <div style={{ color: 'var(--wl-set-warn, #f59e0b)' }}>启动恢复信息: {status.recoveryError}</div>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Section B: ECDICT Installation & Management */}
      <SectionCard
        title="ECDICT 完整词典管理"
        description="ECDICT 是一部收录超过 77 万词条的开源双语离线词典，支持丰富的词频、词形变化和柯林斯星级标定。"
      >
        {/* State 1: Active In-flight Operation (Downloading / Building / Activating / Cancelling) */}
        {isOperationRunning && currentOp && (
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              background: 'rgba(65, 118, 230, 0.08)',
              border: '1px solid rgba(65, 118, 230, 0.25)',
              marginBottom: '16px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--wl-set-text-main, #f2f2f7)' }}>
                {currentOp.phase === 'downloading'
                  ? '正在下载 ECDICT 词源文件...'
                  : currentOp.phase === 'verifying-source'
                    ? '正在校验 CSV 词源完整性...'
                    : currentOp.phase === 'building'
                      ? '正在本地编译构建 SQLite 数据库...'
                      : currentOp.phase === 'validating-database'
                        ? '正在执行 SQLite 完整性校验...'
                        : currentOp.phase === 'activating'
                          ? '正在原子激活并重载词典...'
                          : '正在处理中...'}
              </span>
              <ActionButton
                size="small"
                variant="secondary"
                disabled={!status?.canCancel}
                busy={isActing}
                onClick={() => void store.cancel(currentOp.operationId)}
                title={
                  status?.canCancel
                    ? '取消当前正在执行的任务'
                    : '当前已进入原子激活阶段，不可取消'
                }
              >
                {status?.canCancel ? '取消安装' : '不可取消 (提交中)'}
              </ActionButton>
            </div>

            <ProgressBar
              percent={currentOp.progress.percent}
              label={currentOp.progress.message ?? `${currentOp.phase}`}
              subtext={
                currentOp.progress.processed !== undefined && currentOp.progress.total !== undefined
                  ? `${currentOp.progress.processed.toLocaleString()} / ${currentOp.progress.total.toLocaleString()} (${currentOp.progress.unit ?? 'items'})`
                  : undefined
              }
            />

            {!status?.canCancel && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--wl-set-warn, #f59e0b)' }}>
                提示：当前阶段已进入不可取消的原子激活流程，请稍候。
              </div>
            )}
          </div>
        )}

        {/* State 2: Installed & Active / Inactive */}
        {status?.installed && !isOperationRunning && (
          <div>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: '8px',
                background:
                  status.activeMode === 'managed-ecdict'
                    ? 'rgba(34, 197, 94, 0.08)'
                    : 'rgba(245, 158, 11, 0.08)',
                border:
                  status.activeMode === 'managed-ecdict'
                    ? '1px solid rgba(34, 197, 94, 0.25)'
                    : '1px solid rgba(245, 158, 11, 0.25)',
                marginBottom: '16px',
                fontSize: '13px',
                lineHeight: '1.5',
                color: 'var(--wl-set-text-main, #f2f2f7)',
              }}
            >
              {status.activeMode === 'managed-ecdict'
                ? `ECDICT 本地全量数据库已就绪${status.installedCorpus?.entryCount !== undefined ? `（${status.installedCorpus.entryCount.toLocaleString()} 词条${status.installedCorpus?.formCount !== undefined ? `，${status.installedCorpus.formCount.toLocaleString()} 形态学记录` : ''}）` : ''}。当前运行状态稳定，查词请求直接命中本地只读 SQLite 数据库。`
                : `ECDICT 本地全量数据库已安装在磁盘，但当前活动词典模式为「${status.activeMode === 'fixture' ? '内置基础词典 (Fixture)' : status.activeMode === 'custom' ? '自定义 SQLite 词典' : status.activeMode}」。查词请求尚未命中 ECDICT。`}
            </div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <ActionButton
                variant="danger"
                disabled={!status.canRemove || isActing}
                busy={isActing}
                onClick={() => setShowRemoveConfirm(true)}
              >
                移除本地词典
              </ActionButton>
              <span style={{ fontSize: '12px', color: 'var(--wl-set-text-muted, #6c6c7a)' }}>
                移除后将恢复为内置基础词典 (Fixture)；若当前使用自定义词典则继续保持。
              </span>
            </div>
          </div>
        )}

        {/* State 3: Not Installed & Ready to Install */}
        {!status?.installed && !isOperationRunning && (
          <div>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))',
                marginBottom: '16px',
                fontSize: '13px',
                lineHeight: '1.6',
                color: 'var(--wl-set-text-sub, #9898a6)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--wl-set-text-main, #f2f2f7)', marginBottom: '4px' }}>
                一键部署说明
              </div>
              <div>
                点击安装后，插件将从官方固定来源下载约 63 MiB 的 CSV 词源，并在本地通过零外部依赖的流式管道编译为 SQLite 数据库。安装成功后将自动启用，全程离线安全。
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <ActionButton
                variant="primary"
                disabled={!status?.canInstall || isActing}
                busy={isActing}
                onClick={() => void store.install()}
              >
                一键安装 ECDICT
              </ActionButton>
              <span style={{ fontSize: '12px', color: 'var(--wl-set-text-muted, #6c6c7a)' }}>
                耗时约 10–30 秒，取决于网络及磁盘速度。
              </span>
            </div>
          </div>
        )}

        {/* Action Error / Operation Failure Notice */}
        {actionError && (
          <div
            role="alert"
            style={{
              marginTop: '14px',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--wl-set-error, #ef4444)',
              fontSize: '12.5px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>操作异常: {actionError}</span>
            <ActionButton size="small" variant="ghost" onClick={() => store.clearActionError()}>
              忽略
            </ActionButton>
          </div>
        )}

        {/* Last Operation Settled Failure Notice */}
        {status?.lastOperation?.status === 'failed' && !isOperationRunning && !actionError && (
          <div
            role="alert"
            style={{
              marginTop: '14px',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--wl-set-error, #ef4444)',
              fontSize: '12.5px',
            }}
          >
            最近一次操作失败: {status.lastOperation.error?.message ?? '安装过程发生未知异常'}
            {status.lastOperation.error?.retryable && ' (可点击安装重试)'}
          </div>
        )}
      </SectionCard>

      {/* Section C: Custom SQLite Dictionary Management */}
      <SectionCard
        title="自定义 SQLite 词典管理"
        description="支持通过本地绝对路径导入自建 SQLite 词典（.sqlite3 / .sqlite / .db）。原文件始终保持只读完整，插件在内部维护独立只读安全快照。"
      >
        {/* MANUAL_HOST_PATH Notice */}
        <div
          data-testid="manual-host-path-notice"
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'rgba(65, 118, 230, 0.08)',
            border: '1px solid rgba(65, 118, 230, 0.25)',
            marginBottom: '16px',
            fontSize: '12.5px',
            lineHeight: '1.5',
            color: 'var(--wl-set-text-main, #f2f2f7)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '3px' }}>路径输入说明 (MANUAL_HOST_PATH)</div>
          <div style={{ color: 'var(--wl-set-text-sub, #9898a6)' }}>
            受浏览器沙箱安全策略限制，无法直接调用本地文件选择窗口。请在资源管理器中复制 SQLite 数据库文件的完整绝对路径（如 <code style={{ fontFamily: 'monospace' }}>C:\dictionaries\my-dict.sqlite3</code> 或 <code style={{ fontFamily: 'monospace' }}>/home/user/dict.db</code>）并粘贴于下方。
          </div>
        </div>

        {/* Import Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
          <TextInput
            id="input-custom-dict-path"
            data-testid="input-custom-dict-path"
            label="SQLite 数据库绝对路径 (MANUAL_HOST_PATH)"
            placeholder="例如: C:\dictionaries\my-dict.sqlite3 或 /path/to/dict.db"
            value={customPath}
            onChange={handleCustomPathChange}
            disabled={isActing || isVerifying}
          />

          <TextInput
            id="input-custom-dict-identity"
            data-testid="input-custom-dict-identity"
            label="自定义词库标识（可选，留空则自动提取文件名）"
            placeholder="例如: medical-terms 或 collins-en-zh (仅限字母/数字/短横线/下划线)"
            value={customIdentity}
            onChange={setCustomIdentity}
            disabled={isActing || isVerifying}
          />

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px' }}>
            <ActionButton
              data-testid="btn-verify-custom"
              variant="secondary"
              disabled={!customPath.trim() || isVerifying || isActing}
              busy={isVerifying}
              onClick={() => void handleVerifyCustom()}
            >
              校验数据库
            </ActionButton>

            <ActionButton
              data-testid="btn-activate-custom"
              variant="primary"
              disabled={!customPath.trim() || isVerifying || isActing}
              busy={isActing}
              onClick={() => void handleActivateCustom()}
            >
              导入并激活
            </ActionButton>
          </div>
        </div>

        {/* Custom Action Error / Failure Notice (UI-4) */}
        {actionError && (
          <div
            data-testid="custom-action-error-box"
            role="alert"
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              marginBottom: '16px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--wl-set-error, #ef4444)',
              fontSize: '12.5px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>操作异常: {actionError}</span>
            <ActionButton size="small" variant="ghost" onClick={() => store.clearActionError()}>
              忽略
            </ActionButton>
          </div>
        )}

        {/* Live Verification Feedback */}
        {verifyOutcome && (
          <div
            data-testid="verify-outcome-box"
            role="alert"
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '12.5px',
              background: verifyOutcome.valid ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.12)',
              border: verifyOutcome.valid
                ? '1px solid rgba(34, 197, 94, 0.25)'
                : '1px solid rgba(239, 68, 68, 0.3)',
              color: verifyOutcome.valid ? 'var(--wl-set-text-main, #f2f2f7)' : 'var(--wl-set-error, #ef4444)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>
              {verifyOutcome.valid ? '数据库架构校验通过' : '数据库校验未通过'}
            </div>
            {verifyOutcome.valid ? (
              <div style={{ color: 'var(--wl-set-text-sub, #9898a6)', lineHeight: '1.6' }}>
                <div>架构版本: v{verifyOutcome.schemaVersion ?? 1}</div>
                <div>词条条目数: {verifyOutcome.entryCount?.toLocaleString() ?? 0} 条</div>
                <div>词形形态数: {verifyOutcome.formCount?.toLocaleString() ?? 0} 条</div>
                {verifyOutcome.headwordsSample && verifyOutcome.headwordsSample.length > 0 && (
                  <div>样词抽样: {verifyOutcome.headwordsSample.slice(0, 5).join(', ')}</div>
                )}
              </div>
            ) : (
              <div>{verifyOutcome.message}</div>
            )}
          </div>
        )}

        {/* Custom Snapshots List */}
        <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.08))' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 10px 0', color: 'var(--wl-set-text-main, #f2f2f7)' }}>
            已导入的自定义词典快照
          </h4>

          {!status?.customSnapshots || status.customSnapshots.length === 0 ? (
            <div data-testid="custom-snapshots-empty" style={{ fontSize: '12.5px', color: 'var(--wl-set-text-muted, #6c6c7a)', padding: '8px 0' }}>
              暂无已导入的自定义词典快照。
            </div>
          ) : (
            <div data-testid="custom-snapshots-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {status.customSnapshots.map((snap) => {
                const isCurrentActive = snap.snapshotId === status.activeSnapshotId || snap.isActive
                const leases =
                  status.customSnapshotStatus?.snapshotId === snap.snapshotId
                    ? status.customSnapshotStatus.activeLeases
                    : 0
                const isLeased = leases > 0

                return (
                  <div
                    key={snap.snapshotId}
                    data-testid={`custom-snapshot-row-${snap.snapshotId}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: isCurrentActive
                        ? '1px solid rgba(34, 197, 94, 0.35)'
                        : '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px' }}>
                        <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--wl-set-text-main, #f2f2f7)' }}>
                          {snap.identity}
                        </span>
                        {isCurrentActive && <StatusBadge variant="success" label="当前激活" />}
                        {isLeased && <StatusBadge variant="warning" label={`查询中 (${leases})`} />}
                        {snap.corrupt && <StatusBadge variant="error" label="快照损坏" />}
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--wl-set-text-muted, #6c6c7a)', fontFamily: 'monospace' }}>
                        ID: {snap.snapshotId.slice(0, 8)}... | {snap.entryCount?.toLocaleString?.() ?? snap.entryCount} 词条 | {snap.formCount?.toLocaleString?.() ?? snap.formCount} 形态
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <ActionButton
                        size="small"
                        variant="secondary"
                        disabled={isCurrentActive || isActing || !canSwitchMode || snap.corrupt === true}
                        title={snap.corrupt ? '快照文件已损坏，不可激活' : undefined}
                        onClick={() => void store.selectMode('custom', snap.snapshotId)}
                      >
                        启用
                      </ActionButton>

                      <ActionButton
                        size="small"
                        variant="danger"
                        disabled={isCurrentActive || isLeased || isActing}
                        title={
                          isCurrentActive
                            ? '不能删除当前激活的词典快照，请先切换至其他词典'
                            : isLeased
                              ? '快照当前有活动查询占用，暂不可删除'
                              : '安全删除快照（不影响原始文件）'
                        }
                        onClick={() => setSnapshotToRemove(snap)}
                      >
                        删除
                      </ActionButton>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </SectionCard>

      {/* Section D: Automatic Lookup Settings */}
      <SectionCard
        title="手势与自动查词"
        description="配置在浏览和编辑时通过鼠标手势自动触发查词。设置修改后实时生效，无需重启应用。"
      >
        <SettingRow
          title="双击自动查词"
          description="在页面中双击选中英文单词后自动弹出词典卡片展示释义"
          control={
            <Switch
              id="switch-auto-double-click"
              label="双击自动查词"
              checked={formSnapshot?.value?.autoDoubleClick === true}
              disabled={!isFormWritable || pendingDoubleClick}
              onChange={handleToggleDoubleClick}
            />
          }
        />

        <SettingRow
          title="拖拽框选自动查词"
          description="使用鼠标拖拽划选一段英文文本后，在释放鼠标时自动触发查词"
          isLast={true}
          control={
            <Switch
              id="switch-auto-selection"
              label="拖拽框选自动查词"
              checked={formSnapshot?.value?.autoSelection === true}
              disabled={!isFormWritable || pendingSelection}
              onChange={handleToggleSelection}
            />
          }
        />

        {configError && (
          <div
            role="alert"
            style={{
              marginTop: '12px',
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--wl-set-error, #ef4444)',
              fontSize: '12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{configError}</span>
            <ActionButton size="small" variant="ghost" onClick={() => setConfigError(null)}>
              忽略
            </ActionButton>
          </div>
        )}

        {form && !isFormWritable && (
          <div
            style={{
              marginTop: '8px',
              fontSize: '11.5px',
              color: 'var(--wl-set-text-muted, #6c6c7a)',
            }}
          >
            提示：当前设置处于只读模式或不可写入，开关已禁用。
          </div>
        )}
      </SectionCard>

      {/* Section E: Shortcuts & Advanced Features */}
      <SectionCard
        title="快捷键与高级功能"
        description="查看与自定义划词查询快捷键，配置按键偏好。设置修改将即时持久化至宿主。"
      >
        <SettingRow
          title="划词查询快捷键"
          description={
            shortcutServiceState === 'SERVICE_UNAVAILABLE'
              ? '快捷键服务暂不可用。'
              : shortcutServiceState === 'CATALOG_NOT_READY'
                ? '快捷键目录尚未就绪。'
                : shortcutServiceState === 'COMMAND_NOT_REGISTERED'
                  ? '划词查询命令尚未注册至快捷键服务。'
                  : platform === 'linux' && (!lookupShortcutEntry?.keys || lookupShortcutEntry.keys.length === 0)
                    ? 'Linux Web 平台受浏览器系统快捷键限制，默认未绑定。支持通过自定义配置按键。'
                    : '选中任意文本后按下快捷键即可发起词典查询。支持在此重新绑定自定义按键。'
          }
          control={
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {shortcutServiceState === 'SERVICE_UNAVAILABLE' ? (
                <span
                  data-testid="shortcut-service-unavailable"
                  style={{
                    fontSize: '13px',
                    color: 'var(--wl-set-text-muted, #6c6c7a)',
                  }}
                >
                  快捷键服务暂不可用
                </span>
              ) : shortcutServiceState === 'CATALOG_NOT_READY' ? (
                <span
                  data-testid="shortcut-catalog-not-ready"
                  style={{
                    fontSize: '13px',
                    color: 'var(--wl-set-text-muted, #6c6c7a)',
                  }}
                >
                  快捷键服务未就绪
                </span>
              ) : shortcutServiceState === 'COMMAND_NOT_REGISTERED' ? (
                <span
                  data-testid="shortcut-command-not-registered"
                  style={{
                    fontSize: '13px',
                    color: 'var(--wl-set-text-muted, #6c6c7a)',
                  }}
                >
                  划词命令未注册
                </span>
              ) : (
                <>
                  <span
                    data-testid="shortcut-key-display"
                    style={{
                      fontSize: '13px',
                      fontWeight: 600,
                      fontFamily: 'monospace',
                      padding: '3px 8px',
                      borderRadius: '6px',
                      background: 'rgba(255, 255, 255, 0.08)',
                      color: 'var(--wl-set-text-main, #f2f2f7)',
                    }}
                  >
                    {formatShortcutKeys(lookupShortcutEntry?.keys)}
                  </span>
                  {shortcutServiceState === 'READ_ONLY' ? (
                    <StatusBadge variant="neutral" label="只读" />
                  ) : lookupShortcutEntry?.modified ? (
                    <StatusBadge variant="warning" label="已自定义" />
                  ) : (
                    <StatusBadge variant="neutral" label="默认绑定" />
                  )}
                </>
              )}

              <ActionButton
                data-testid="btn-edit-shortcut"
                size="small"
                variant="secondary"
                disabled={!isShortcutEditable}
                title={
                  shortcutServiceState === 'SERVICE_UNAVAILABLE'
                    ? '快捷键服务暂不可用'
                    : shortcutServiceState === 'CATALOG_NOT_READY'
                      ? '快捷键服务未就绪'
                      : shortcutServiceState === 'COMMAND_NOT_REGISTERED'
                        ? '划词命令未注册'
                        : shortcutServiceState === 'READ_ONLY'
                          ? '快捷键处于只读状态'
                          : '修改划词查询快捷键'
                }
                onClick={() => {
                  if (isShortcutEditable) {
                    setShowShortcutRecorder(true)
                  }
                }}
              >
                修改快捷键
              </ActionButton>
            </div>
          }
        />

        <SettingRow
          title="自定义外部 SQLite 词典"
          description="允许指定本地用户自建或专业领域的 SQLite 词库文件，通过校验后无缝挂载使用。"
          isLast={true}
          control={<StatusBadge variant="success" label="Phase 7A.8 开放" />}
        />
      </SectionCard>

      {/* Modal: ECDICT Removal Confirmation */}
      {showRemoveConfirm && (
        <ModalConfirm
          title="确认移除 ECDICT 本地词典？"
          message={
            <span>
              移除操作将安全删除本地托管的 ECDICT SQLite 数据库文件并释放存储空间。若当前处于 ECDICT 模式，插件将自动回退到内置基础词典 (Fixture)；若当前处于自定义词典模式，则将继续保持自定义模式。该操作不会影响任何用户自有的自定义文件。
            </span>
          }
          confirmLabel="确认移除"
          cancelLabel="取消"
          isDanger={true}
          onConfirm={() => {
            setShowRemoveConfirm(false)
            void store.remove()
          }}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}

      {/* Modal: Custom Snapshot Removal Confirmation */}
      {snapshotToRemove && (
        <ModalConfirm
          title={`确认删除自定义词典快照 "${snapshotToRemove.identity}"？`}
          message={
            <span>
              该操作将安全清理插件内部管理的快照副本（ID: {snapshotToRemove.snapshotId}）。您的本地原始数据库文件将保持完整，绝不会被修改或删除。
            </span>
          }
          confirmLabel="确认删除"
          cancelLabel="取消"
          isDanger={true}
          onConfirm={() => void handleConfirmRemoveCustom()}
          onCancel={() => setSnapshotToRemove(null)}
        />
      )}

      {/* Modal: Shortcut Recorder */}
      {showShortcutRecorder && (
        <ShortcutRecorderModal
          currentKeys={
            lookupShortcutEntry?.keys ??
            (platform === 'macos' ? ['⌘', 'Shift', 'L'] : ['Ctrl', 'Shift', 'L'])
          }
          isModified={Boolean(lookupShortcutEntry?.modified)}
          onClose={() => setShowShortcutRecorder(false)}
          onSave={handleSaveShortcut}
          onReset={handleResetShortcut}
          describeBinding={
            activeShortcuts?.describeBinding
              ? (b) => activeShortcuts.describeBinding(b as never) as never
              : undefined
          }
          recording={handleRecording}
        />
      )}

      {/* Modal: Custom Snapshot Picker (C1) */}
      {showSnapshotPicker && (
        <SnapshotPickerModal
          snapshots={customSnapshots}
          activeSnapshotId={status?.activeSnapshotId}
          isActing={isActing}
          onClose={() => setShowSnapshotPicker(false)}
          onSelect={(snapshotId) => {
            void store.selectMode('custom', snapshotId)
          }}
        />
      )}
    </div>
  )
}
