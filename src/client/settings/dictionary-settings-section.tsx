/**
 * Native DSH Settings Section for Dictionary Management (`settings.section`).
 *
 * Implements Phase 7A.7:
 * - Current Dictionary Status (Active mode, entry counts, forms, source, diagnostics).
 * - 1-Click ECDICT Installation, Real-time Streaming Progress, Safe Cancellation.
 * - Managed Corpus Removal with Confirmation Dialog and Fixture Fallback.
 * - Automatic Lookup Switches (autoDoubleClick, autoSelection) via ConfigForms.
 * - Platform-accurate shortcut inspection and advanced dictionary informational notices.
 * - Responsive, theme-aware, WCAG-accessible (WCAG 2.1 AA).
 *
 * @module dsh-word-lookup/client/settings/dictionary-settings-section
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

import {
  ActionButton,
  ModalConfirm,
  ProgressBar,
  SectionCard,
  SettingRow,
  SETTINGS_THEME_STYLES,
  StatusBadge,
  Switch,
  type BadgeVariant,
} from './dictionary-settings-components.js'
import {
  DictionaryManagementStore,
  type DictionaryManagementStoreState,
} from './dictionary-management-store.js'

/** Host settings schema for automatic triggers. */
export interface DictionaryHostSettings {
  readonly autoDoubleClick?: boolean
  readonly autoSelection?: boolean
  readonly dictionaryMode?: 'fixture' | 'managed-ecdict' | 'custom'
}

/** Props passed to DictionarySettingsSection. */
export type DictionarySettingsSectionProps = Partial<PropsRuntime<'settings.section'>> & {
  /** Optional pre-configured management store. */
  readonly store?: DictionaryManagementStore
  /** Optional settings form controller for live switches. */
  readonly form?: ConfigForm<DictionaryHostSettings>
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

export function DictionarySettingsSection({
  store: externalStore,
  form,
  testPlatform,
  close: _close,
}: DictionarySettingsSectionProps) {
  // Store initialization
  const [internalStore] = useState(() => (externalStore ? null : new DictionaryManagementStore()))
  const store = externalStore ?? internalStore!

  useEffect(() => {
    return () => {
      if (internalStore) {
        internalStore.dispose()
      }
    }
  }, [internalStore])

  const storeState: DictionaryManagementStoreState = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  // ConfigForms integration for gesture switches
  const [formValues, setFormValues] = useState<{ autoDoubleClick: boolean; autoSelection: boolean }>(() => {
    if (!form) return { autoDoubleClick: false, autoSelection: false }
    const snap = form.getSnapshot().value
    return {
      autoDoubleClick: snap?.autoDoubleClick === true,
      autoSelection: snap?.autoSelection === true,
    }
  })

  useEffect(() => {
    if (!form) return
    const read = () => {
      const snap = form.getSnapshot().value
      setFormValues({
        autoDoubleClick: snap?.autoDoubleClick === true,
        autoSelection: snap?.autoSelection === true,
      })
    }
    read()
    return form.subscribe(read)
  }, [form])

  const handleToggleDoubleClick = (next: boolean) => {
    setFormValues((prev) => ({ ...prev, autoDoubleClick: next }))
    if (form) {
      void form.set('autoDoubleClick', next)
    }
  }

  const handleToggleSelection = (next: boolean) => {
    setFormValues((prev) => ({ ...prev, autoSelection: next }))
    if (form) {
      void form.set('autoSelection', next)
    }
  }

  // Remove confirmation modal state
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)
  const [isExpandingDetails, setIsExpandingDetails] = useState(false)

  const { status, isLoading, isActing, actionError, connectionError } = storeState
  const currentOp = status?.currentOperation
  const isOperationRunning = currentOp !== null && currentOp !== undefined && currentOp.status === 'running'

  // Platform detection for shortcut display
  const platform = detectPlatform(testPlatform)

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

      {/* Section A: Current Dictionary Status */}
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
              {status?.activeMode === 'managed-ecdict'
                ? 'ECDICT 本地全量词典'
                : status?.activeMode === 'custom'
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
              {status?.activeMode === 'managed-ecdict'
                ? (status.installedCorpus?.entryCount ?? 770611).toLocaleString()
                : '12 词条'}
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
              {status?.activeMode === 'managed-ecdict'
                ? (status.installedCorpus?.formCount ?? 57689).toLocaleString()
                : '12 记录'}
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
              {status?.activeMode === 'managed-ecdict' ? 'ECDICT @ bc015ed' : '内置 Fixture v1.0'}
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
                        ? '正在执行 SQLite PRAGMA 完整性校验...'
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
                background: 'rgba(34, 197, 94, 0.08)',
                border: '1px solid rgba(34, 197, 94, 0.25)',
                marginBottom: '16px',
                fontSize: '13px',
                lineHeight: '1.5',
                color: 'var(--wl-set-text-main, #f2f2f7)',
              }}
            >
              ECDICT 本地全量数据库已就绪（770,611 词条，57,689 形态学记录）。当前运行状态稳定，查词请求直接命中本地只读 SQLite 数据库。
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
                移除后将恢复为内置基础词典 (Fixture)。
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

      {/* Section C: Automatic Lookup Settings */}
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
              checked={formValues.autoDoubleClick}
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
              checked={formValues.autoSelection}
              onChange={handleToggleSelection}
            />
          }
        />
      </SectionCard>

      {/* Section D: Shortcuts & Advanced Features (Informational) */}
      <SectionCard
        title="快捷键与高级功能"
        description="查看当前查词快捷键与高级自定义词库扩展计划。"
      >
        <SettingRow
          title="划词查询快捷键"
          description={
            platform === 'linux'
              ? 'Linux Web 平台受浏览器系统快捷键限制，默认未绑定。自定义快捷键功能将在 Phase 7A.8 开放。'
              : '选中任意文本后按下快捷键即可发起词典查询。自定义快捷键将在 Phase 7A.8 开放。'
          }
          control={
            platform === 'linux' ? (
              <StatusBadge variant="neutral" label="未绑定 (Unbound)" />
            ) : platform === 'macos' ? (
              <span
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
                ⌘ + Shift + L
              </span>
            ) : (
              <span
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
                Ctrl + Shift + L
              </span>
            )
          }
        />

        <SettingRow
          title="自定义外部 SQLite 词典"
          description="允许指定本地用户自建或专业领域的 SQLite 词库文件，通过校验后无缝挂载使用。"
          isLast={true}
          control={<StatusBadge variant="neutral" label="Phase 7A.8 开放" />}
        />
      </SectionCard>

      {/* Modal: Removal Confirmation */}
      {showRemoveConfirm && (
        <ModalConfirm
          title="确认移除 ECDICT 本地词典？"
          message={
            <span>
              移除操作将安全删除本地托管的 ECDICT SQLite 数据库文件并释放存储空间。插件将自动回退到内置基础词典 (Fixture)。该操作不会影响任何用户自有的自定义文件。
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
    </div>
  )
}
