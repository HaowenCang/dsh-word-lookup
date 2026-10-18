/**
 * Accessible UI primitives and helper components for DSH native dictionary settings.
 *
 * Implements:
 * - Theme-aware styles adhering to DSH design tokens (--dsw-* / fallback).
 * - Full dark and light theme support with responsive wrapping.
 * - WCAG compliant ARIA attributes, keyboard accessibility (Tab, Space, Enter, Escape).
 * - Self-contained zero external runtime dependencies.
 *
 * @module dsh-word-lookup/client/settings/dictionary-settings-components
 */

import React, { type CSSProperties, type ReactNode } from 'react'
import type { CustomSnapshotSummary } from '../../shared/dictionary-management-protocol.js'

/** CSS styles injected for settings UI components. */
export const SETTINGS_THEME_STYLES = `
.dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);
  --wl-set-accent: var(--dsw-alias-brand-primary, #4176e6);
  --wl-set-accent-hover: #3463c2;
  --wl-set-success: var(--dsw-alias-state-success-primary, #22c55e);
  --wl-set-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --wl-set-error: var(--dsw-alias-state-error-primary, #ef4444);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));
}

@media (prefers-color-scheme: light) {
  .dsh-wl-settings {
    --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));
    --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));
    --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);
    --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);
    --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);
    --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));
  }
}

:root[data-theme="light"] .dsh-wl-settings,
body:not([data-ds-dark-theme]) .dsh-wl-settings,
.light .dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));
}

:root[data-theme="dark"] .dsh-wl-settings,
body[data-ds-dark-theme] .dsh-wl-settings,
.dark .dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));
}

@media (max-width: 600px) {
  .dsh-wl-setting-row {
    flex-direction: column !important;
    align-items: flex-start !important;
    gap: 8px !important;
  }
}
`

// --- Section Card Container ---

export interface SectionCardProps {
  readonly title: string
  readonly description?: string
  readonly badge?: ReactNode
  readonly action?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}

export function SectionCard({ title, description, badge, action, children, className }: SectionCardProps) {
  const cardStyle: CSSProperties = {
    background: 'var(--wl-set-bg-card, rgba(255, 255, 255, 0.04))',
    border: '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))',
    borderRadius: '12px',
    padding: '18px 20px',
    marginBottom: '20px',
    boxSizing: 'border-box',
  }

  const headerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '12px',
    marginBottom: description ? '4px' : '14px',
    flexWrap: 'wrap',
  }

  const titleGroupStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  }

  const titleStyle: CSSProperties = {
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--wl-set-text-main, #f2f2f7)',
    margin: 0,
    lineHeight: '22px',
  }

  const descStyle: CSSProperties = {
    fontSize: '12.5px',
    color: 'var(--wl-set-text-sub, #9898a6)',
    margin: '0 0 14px 0',
    lineHeight: '18px',
  }

  return (
    <section className={`dsh-wl-card-section ${className ?? ''}`} style={cardStyle} aria-labelledby={`sec-${title}`}>
      <div style={headerStyle}>
        <div style={titleGroupStyle}>
          <h3 id={`sec-${title}`} style={titleStyle}>
            {title}
          </h3>
          {badge}
        </div>
        {action && <div>{action}</div>}
      </div>
      {description && <p style={descStyle}>{description}</p>}
      <div>{children}</div>
    </section>
  )
}

// --- Setting Row ---

export interface SettingRowProps {
  readonly title: string
  readonly description?: ReactNode
  readonly control: ReactNode
  readonly isLast?: boolean
}

export function SettingRow({ title, description, control, isLast = false }: SettingRowProps) {
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '12px 0',
    borderBottom: isLast ? 'none' : '1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.06))',
  }

  const labelStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
  }

  const titleStyle: CSSProperties = {
    fontSize: '13.5px',
    fontWeight: 500,
    color: 'var(--wl-set-text-main, #f2f2f7)',
    lineHeight: '20px',
  }

  const descStyle: CSSProperties = {
    fontSize: '12px',
    color: 'var(--wl-set-text-sub, #9898a6)',
    marginTop: '2px',
    lineHeight: '17px',
  }

  return (
    <div style={rowStyle}>
      <div style={labelStyle}>
        <div style={titleStyle}>{title}</div>
        {description && <div style={descStyle}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  )
}

// --- Status Badge ---

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral'

export interface StatusBadgeProps {
  readonly variant: BadgeVariant
  readonly label: string
  readonly icon?: ReactNode
}

export function StatusBadge({ variant, label, icon }: StatusBadgeProps) {
  let color = 'var(--wl-set-text-sub, #9898a6)'
  let bg = 'rgba(128, 128, 128, 0.12)'
  let border = 'rgba(128, 128, 128, 0.25)'

  if (variant === 'success') {
    color = 'var(--wl-set-success, #22c55e)'
    bg = 'rgba(34, 197, 94, 0.12)'
    border = 'rgba(34, 197, 94, 0.3)'
  } else if (variant === 'warning') {
    color = 'var(--wl-set-warn, #f59e0b)'
    bg = 'rgba(245, 158, 11, 0.12)'
    border = 'rgba(245, 158, 11, 0.3)'
  } else if (variant === 'error') {
    color = 'var(--wl-set-error, #ef4444)'
    bg = 'rgba(239, 68, 68, 0.12)'
    border = 'rgba(239, 68, 68, 0.3)'
  } else if (variant === 'info') {
    color = 'var(--wl-set-accent, #4176e6)'
    bg = 'rgba(65, 118, 230, 0.12)'
    border = 'rgba(65, 118, 230, 0.3)'
  }

  const badgeStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '11.5px',
    fontWeight: 500,
    lineHeight: '16px',
    color,
    background: bg,
    border: `1px solid ${border}`,
    userSelect: 'none',
  }

  return (
    <span style={badgeStyle} role="status">
      {icon}
      {label}
    </span>
  )
}

// --- Accessible Switch Control ---

export interface SwitchProps {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly id?: string
}

export function Switch({ checked, disabled = false, onChange, label, id }: SwitchProps) {
  const width = 38
  const height = 22
  const thumbSize = 16

  const lastToggleTimeRef = React.useRef(0)

  const toggle = () => {
    if (disabled) return
    const now = Date.now()
    if (now - lastToggleTimeRef.current < 80) return
    lastToggleTimeRef.current = now
    onChange(!checked)
  }

  const trackStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width: `${width}px`,
    height: `${height}px`,
    borderRadius: `${height / 2}px`,
    background: checked
      ? 'var(--wl-set-accent, #4176e6)'
      : 'var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.25))',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background 0.2s ease, opacity 0.2s ease',
    outline: 'none',
    border: 'none',
    padding: 0,
    verticalAlign: 'middle',
  }

  const thumbStyle: CSSProperties = {
    position: 'absolute',
    top: '3px',
    left: checked ? `${width - thumbSize - 3}px` : '3px',
    width: `${thumbSize}px`,
    height: `${thumbSize}px`,
    borderRadius: '50%',
    background: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
    transition: 'left 0.2s ease',
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === ' ') {
      e.preventDefault()
      toggle()
    }
    // Enter key triggers native button onClick automatically. Do not handle Enter here to prevent double-toggle.
  }

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={trackStyle}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <span style={thumbStyle} aria-hidden="true" />
    </button>
  )
}

// --- Accessible Action Button ---

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export interface ActionButtonProps {
  readonly children: ReactNode
  readonly onClick: () => void
  readonly variant?: ButtonVariant
  readonly disabled?: boolean
  readonly busy?: boolean
  readonly size?: 'small' | 'medium'
  readonly ariaLabel?: string
  readonly title?: string
  readonly 'data-testid'?: string
}

export function ActionButton({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  busy = false,
  size = 'medium',
  ariaLabel,
  title,
  'data-testid': testId,
}: ActionButtonProps) {
  let bg = 'rgba(255, 255, 255, 0.08)'
  let color = 'var(--wl-set-text-main, #f2f2f7)'
  let border = '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.12))'

  if (variant === 'primary') {
    bg = 'var(--wl-set-accent, #4176e6)'
    color = '#ffffff'
    border = '1px solid transparent'
  } else if (variant === 'danger') {
    bg = 'rgba(239, 68, 68, 0.12)'
    color = 'var(--wl-set-error, #ef4444)'
    border = '1px solid rgba(239, 68, 68, 0.3)'
  } else if (variant === 'ghost') {
    bg = 'transparent'
    color = 'var(--wl-set-text-sub, #9898a6)'
    border = '1px solid transparent'
  }

  const padding = size === 'small' ? '4px 10px' : '7px 14px'
  const fontSize = size === 'small' ? '12px' : '13px'

  const buttonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    background: bg,
    color,
    border,
    borderRadius: '6px',
    padding,
    fontSize,
    fontWeight: 500,
    cursor: disabled || busy ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : busy ? 0.75 : 1,
    transition: 'background 0.15s ease, opacity 0.15s ease, filter 0.15s ease',
    outline: 'none',
    userSelect: 'none',
    lineHeight: '1.4',
  }

  return (
    <button
      type="button"
      data-testid={testId}
      style={buttonStyle}
      disabled={disabled || busy}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!disabled && !busy && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          e.stopPropagation()
          onClick?.()
        }
      }}
      aria-label={ariaLabel}
      title={title}
    >
      {busy && (
        <span
          style={{
            display: 'inline-block',
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'dsh-wl-spin 0.8s linear infinite',
          }}
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  )
}

// --- Accessible Progress Bar ---

export interface ProgressBarProps {
  readonly percent?: number
  readonly label: string
  readonly subtext?: string
}

export function ProgressBar({ percent, label, subtext }: ProgressBarProps) {
  const safePercent = percent !== undefined ? Math.min(100, Math.max(0, Math.round(percent))) : undefined

  const containerStyle: CSSProperties = {
    width: '100%',
    marginTop: '10px',
  }

  const headerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '12px',
    color: 'var(--wl-set-text-sub, #9898a6)',
    marginBottom: '6px',
  }

  const trackStyle: CSSProperties = {
    width: '100%',
    height: '6px',
    borderRadius: '3px',
    background: 'var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.2))',
    overflow: 'hidden',
    position: 'relative',
  }

  const fillStyle: CSSProperties = {
    height: '100%',
    borderRadius: '3px',
    background: 'var(--wl-set-accent, #4176e6)',
    width: safePercent !== undefined ? `${safePercent}%` : '40%',
    transition: 'width 0.3s ease',
    ...(safePercent === undefined
      ? {
          position: 'absolute',
          animation: 'dsh-wl-indeterminate 1.5s infinite ease-in-out',
        }
      : {}),
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>{label}</span>
        {safePercent !== undefined && <span>{safePercent}%</span>}
      </div>
      <div
        style={trackStyle}
        role="progressbar"
        aria-valuenow={safePercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div style={fillStyle} />
      </div>
      {subtext && (
        <div style={{ fontSize: '11.5px', color: 'var(--wl-set-text-muted, #6c6c7a)', marginTop: '4px' }}>
          {subtext}
        </div>
      )}
    </div>
  )
}

// --- Modal Confirmation Dialog ---

export interface ModalConfirmProps {
  readonly title: string
  readonly message: ReactNode
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly isDanger?: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ModalConfirm({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  isDanger = false,
  onConfirm,
  onCancel,
}: ModalConfirmProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null
    }

    const timer = setTimeout(() => {
      if (dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length > 0) {
          focusable[0]?.focus()
        } else {
          dialogRef.current.focus()
        }
      }
    }, 10)

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault()
            last?.focus()
          }
        } else {
          if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault()
            first?.focus()
          }
        }
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleGlobalKeyDown, true)
    }

    return () => {
      clearTimeout(timer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleGlobalKeyDown, true)
      }
      if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
        try {
          previousActiveElementRef.current.focus()
        } catch {
          // ignore error during unmount
        }
      }
    }
  }, [onCancel])

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99999,
    padding: '16px',
  }

  const dialogStyle: CSSProperties = {
    background: 'var(--wl-set-bg-card, #202026)',
    border: '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))',
    borderRadius: '12px',
    maxWidth: '420px',
    width: '100%',
    padding: '20px 22px',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
    boxSizing: 'border-box',
    outline: 'none',
  }

  const titleStyle: CSSProperties = {
    fontSize: '16px',
    fontWeight: 600,
    margin: '0 0 10px 0',
    color: 'var(--wl-set-text-main, #f2f2f7)',
  }

  const messageStyle: CSSProperties = {
    fontSize: '13px',
    lineHeight: '1.5',
    color: 'var(--wl-set-text-sub, #9898a6)',
    margin: '0 0 20px 0',
  }

  const footerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '10px',
  }

  return (
    <div style={backdropStyle} role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 id="confirm-dialog-title" style={titleStyle}>
          {title}
        </h4>
        <div style={messageStyle}>{message}</div>
        <div style={footerStyle}>
          <ActionButton data-testid="modal-cancel-btn" onClick={onCancel} variant="secondary">
            {cancelLabel}
          </ActionButton>
          <ActionButton data-testid="modal-confirm-btn" onClick={onConfirm} variant={isDanger ? 'danger' : 'primary'}>
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

// --- Accessible Text Input ---

export interface TextInputProps {
  readonly id?: string
  readonly label?: string
  readonly placeholder?: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly error?: string | null
  readonly helpText?: string
  readonly width?: string | number
  readonly 'data-testid'?: string
  readonly onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

export function TextInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  disabled = false,
  error,
  helpText,
  width = '100%',
  'data-testid': testId,
  onKeyDown,
}: TextInputProps) {
  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: typeof width === 'number' ? `${width}px` : width,
    boxSizing: 'border-box',
  }

  const labelStyle: CSSProperties = {
    fontSize: '12.5px',
    fontWeight: 500,
    color: 'var(--wl-set-text-main, #f2f2f7)',
  }

  const inputStyle: CSSProperties = {
    background: 'rgba(0, 0, 0, 0.2)',
    border: error
      ? '1px solid var(--wl-set-error, #ef4444)'
      : '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.12))',
    borderRadius: '6px',
    padding: '8px 12px',
    fontSize: '13px',
    color: 'var(--wl-set-text-main, #f2f2f7)',
    outline: 'none',
    boxSizing: 'border-box',
    width: '100%',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s ease',
  }

  return (
    <div style={containerStyle}>
      {label && (
        <label htmlFor={id} style={labelStyle}>
          {label}
        </label>
      )}
      <input
        id={id}
        data-testid={testId}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        style={inputStyle}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : helpText ? `${id}-help` : undefined}
      />
      {helpText && !error && (
        <span id={`${id}-help`} style={{ fontSize: '11.5px', color: 'var(--wl-set-text-muted, #6c6c7a)' }}>
          {helpText}
        </span>
      )}
      {error && (
        <span
          id={`${id}-error`}
          role="alert"
          style={{ fontSize: '12px', color: 'var(--wl-set-error, #ef4444)' }}
        >
          {error}
        </span>
      )}
    </div>
  )
}

// --- Accessible Shortcut Recorder Modal ---

/**
 * Concurrency coordinator for DSH shortcut recording lock.
 *
 * Guarantees:
 * - Single ownership per modal instance.
 * - Strict serial execution: acquire and release never race or overlap.
 * - If release is requested while acquire is pending, release waits for acquire to settle before calling recording(false).
 * - If disposed before acquire starts, acquire is safely canceled.
 * - Errors in acquire or release do not cause unhandled rejections.
 * - Idempotent cleanup: duplicate release calls are no-ops.
 * - Final state is guaranteed to be false after release.
 */
export class AsyncRecordingLock {
  private queue: Promise<void> = Promise.resolve()
  private held = false
  private released = false

  acquire(recordingFn?: (active: boolean) => Promise<void>): Promise<void> {
    if (!recordingFn) return Promise.resolve()
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await recordingFn(true)
        this.held = true
      })
      .catch(() => {})
    return this.queue
  }

  release(recordingFn?: (active: boolean) => Promise<void>): Promise<void> {
    if (this.released || !recordingFn) return this.queue
    this.released = true
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        try {
          await recordingFn(false)
        } finally {
          this.held = false
        }
      })
      .catch(() => {})
    return this.queue
  }

  isHeld(): boolean {
    return this.held
  }
}

export interface ShortcutRecorderModalProps {
  readonly currentKeys: readonly string[]
  readonly isModified: boolean
  readonly onClose: () => void
  readonly onSave: (binding: { code: string; modifiers: readonly string[] }) => Promise<boolean | { ok: boolean; error?: string }>
  readonly onReset: () => Promise<boolean | { ok: boolean; error?: string }>
  readonly describeBinding?: (binding: { code: string; modifiers: readonly string[] } | null) => {
    binding: unknown
    keys: readonly string[]
    issue: string | null
    conflicts: readonly string[]
  }
  readonly recording?: (active: boolean) => Promise<void>
}

export function ShortcutRecorderModal({
  currentKeys,
  isModified,
  onClose,
  onSave,
  onReset,
  describeBinding,
  recording,
}: ShortcutRecorderModalProps) {
  const [candidate, setCandidate] = React.useState<{ code: string; modifiers: readonly string[] } | null>(null)
  const [candidateKeys, setCandidateKeys] = React.useState<readonly string[] | null>(null)
  const [issue, setIssue] = React.useState<string | null>(null)
  const [conflictWarning, setConflictWarning] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  const recorderBoxRef = React.useRef<HTMLDivElement>(null)
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  const lockRef = React.useRef<AsyncRecordingLock | null>(null)
  if (!lockRef.current) {
    lockRef.current = new AsyncRecordingLock()
  }
  const recordingRef = React.useRef(recording)
  recordingRef.current = recording

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null
    }

    const lock = lockRef.current!
    void lock.acquire(recordingRef.current)

    const timer = setTimeout(() => {
      recorderBoxRef.current?.focus()
    }, 20)

    return () => {
      clearTimeout(timer)
      void lock.release(recordingRef.current)
      if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
        try {
          previousActiveElementRef.current.focus()
        } catch {
          // ignore
        }
      }
    }
  }, [])

  const handleRecorderKeyDown = (e: React.KeyboardEvent) => {
    if (isSaving) return

    // Plain Escape key cancels and closes modal
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
      return
    }

    // Ignore Tab navigation so user can tab to Save/Cancel/Reset buttons
    if (e.key === 'Tab') {
      return
    }

    // Modifiers only: wait for final character
    if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.key) || /^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    e.preventDefault()
    e.stopPropagation()

    const modifiers: string[] = []
    if (e.ctrlKey) modifiers.push('control')
    if (e.altKey) modifiers.push('alt')
    if (e.shiftKey) modifiers.push('shift')
    if (e.metaKey) modifiers.push('meta')

    const nextBinding = { code: e.code, modifiers }
    setCandidate(nextBinding)
    setSaveError(null)

    if (describeBinding) {
      try {
        const desc = describeBinding(nextBinding)
        setCandidateKeys(desc.keys && desc.keys.length > 0 ? desc.keys : [e.code])
        if (desc.issue) {
          setIssue(
            desc.issue === 'modifier-required' || desc.issue === 'requires-modifier'
              ? '快捷键必须包含至少一个修饰键（Ctrl、Alt 或 Shift）'
              : desc.issue === 'reserved' || desc.issue === 'reserved-key'
                ? '该按键为系统保留快捷键，不可重定义'
                : desc.issue === 'unsupported-browser'
                  ? '当前 Web 浏览器平台不支持该快捷键组合'
                  : desc.issue === 'unsupported-key'
                    ? '当前系统或浏览器不支持该按键作为快捷键'
                    : `按键不合规: ${desc.issue}`,
          )
        } else {
          setIssue(null)
        }
        if (desc.conflicts && desc.conflicts.length > 0) {
          const otherConflicts = desc.conflicts.filter((c) => c !== 'wordLookup.lookupSelection')
          if (otherConflicts.length > 0) {
            setConflictWarning(`该快捷键与现有命令冲突: ${otherConflicts.join(', ')}`)
          } else {
            setConflictWarning(null)
          }
        } else {
          setConflictWarning(null)
        }
      } catch (err) {
        setIssue(`无效组合键: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      const parts = [...modifiers.map((m) => m.toUpperCase()), e.code.replace(/^Key/, '')]
      setCandidateKeys(parts)
      if (modifiers.length === 0) {
        setIssue('快捷键必须包含至少一个修饰键（Ctrl、Alt 或 Shift）')
      } else {
        setIssue(null)
        setConflictWarning(null)
      }
    }
  }

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    // Escape closes modal safely from anywhere
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
      return
    }

    // Tab trap
    if (e.key === 'Tab') {
      if (!dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          '[data-testid="shortcut-recorder-box"], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last?.focus()
            return
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first?.focus()
            return
          }
        }
      }
    }

    // If key originates on a button, do not capture as shortcut recording
    if ((e.target as HTMLElement)?.closest('button')) {
      return
    }

    // If keydown is dispatched directly on the dialog container (e.g. synthetic test events)
    if (e.target === e.currentTarget) {
      handleRecorderKeyDown(e)
    }
  }

  const handleSave = async () => {
    if (!candidate || issue || conflictWarning || isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const res = await onSave(candidate)
      const ok = typeof res === 'boolean' ? res : res.ok
      if (ok) {
        onCloseRef.current()
      } else {
        const errMsg = typeof res === 'object' && res.error ? res.error : '保存快捷键失败，Host 未接受该配置'
        setSaveError(errMsg)
      }
    } catch (err) {
      setSaveError(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = async () => {
    if (isSaving) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const res = await onReset()
      const ok = typeof res === 'boolean' ? res : res.ok
      if (ok) {
        onCloseRef.current()
      } else {
        const errMsg = typeof res === 'object' && res.error ? res.error : '恢复默认快捷键失败'
        setSaveError(errMsg)
      }
    } catch (err) {
      setSaveError(`恢复默认失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSaving(false)
    }
  }

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99999,
    padding: '16px',
  }

  const modalStyle: CSSProperties = {
    background: 'var(--wl-set-bg-card, #202026)',
    border: '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))',
    borderRadius: '12px',
    maxWidth: '460px',
    width: '100%',
    padding: '22px 24px',
    boxShadow: '0 12px 36px rgba(0, 0, 0, 0.55)',
    boxSizing: 'border-box',
    outline: 'none',
  }

  const displayKeys = candidateKeys ?? currentKeys

  return (
    <div style={backdropStyle} role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recorder-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <h4
          id="recorder-dialog-title"
          style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 8px 0', color: 'var(--wl-set-text-main, #f2f2f7)' }}
        >
          修改划词查询快捷键
        </h4>
        <p style={{ fontSize: '12.5px', color: 'var(--wl-set-text-sub, #9898a6)', margin: '0 0 16px 0', lineHeight: '1.5' }}>
          请直接在键盘上按下您希望设置的组合键（例如 Ctrl + Alt + K 或 Command + Shift + L）。
        </p>

        {/* Keycap preview & isolated recorder focus box */}
        <div
          ref={recorderBoxRef}
          tabIndex={0}
          role="region"
          aria-label="快捷键录制区域"
          data-testid="shortcut-recorder-box"
          onKeyDown={handleRecorderKeyDown}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '64px',
            padding: '12px',
            borderRadius: '8px',
            background: 'rgba(0, 0, 0, 0.25)',
            border: issue
              ? '1px solid var(--wl-set-error, #ef4444)'
              : candidate
                ? '1px solid var(--wl-set-accent, #4176e6)'
                : '1px dashed var(--wl-set-stroke, rgba(255, 255, 255, 0.18))',
            marginBottom: '14px',
            outline: 'none',
            cursor: 'text',
          }}
        >
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            {displayKeys && displayKeys.length > 0 ? (
              displayKeys.map((k, idx) => (
                <span
                  key={idx}
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    fontFamily: 'monospace',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    background: candidate ? 'var(--wl-set-accent, #4176e6)' : 'rgba(255, 255, 255, 0.12)',
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                  }}
                >
                  {k}
                </span>
              ))
            ) : (
              <span style={{ fontSize: '13px', color: 'var(--wl-set-text-muted, #6c6c7a)' }}>
                等待按键输入...
              </span>
            )}
          </div>
        </div>

        {/* Issue message */}
        {issue && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--wl-set-error, #ef4444)', marginBottom: '12px' }}>
            {issue}
          </div>
        )}

        {/* Conflict warning */}
        {conflictWarning && !issue && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--wl-set-warn, #f59e0b)', marginBottom: '12px' }}>
            {conflictWarning}
          </div>
        )}

        {/* Save error */}
        {saveError && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--wl-set-error, #ef4444)', marginBottom: '12px' }}>
            {saveError}
          </div>
        )}

        {/* Footer actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '18px' }}>
          <div>
            {isModified && (
              <ActionButton
                data-testid="btn-reset-shortcut"
                size="small"
                variant="ghost"
                onClick={handleReset}
                busy={isSaving}
              >
                恢复默认快捷键
              </ActionButton>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <ActionButton
              data-testid="btn-cancel-shortcut"
              variant="secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              取消
            </ActionButton>
            <ActionButton
              data-testid="btn-save-shortcut"
              variant="primary"
              disabled={!candidate || Boolean(issue) || Boolean(conflictWarning) || isSaving}
              busy={isSaving}
              onClick={handleSave}
            >
              保存修改
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Accessible Custom Snapshot Picker Modal ---

export interface SnapshotPickerModalProps {
  readonly snapshots: readonly CustomSnapshotSummary[]
  readonly activeSnapshotId?: string | null
  readonly isActing?: boolean
  readonly onClose: () => void
  readonly onSelect: (snapshotId: string) => void
}

export function SnapshotPickerModal({
  snapshots,
  activeSnapshotId,
  isActing = false,
  onClose,
  onSelect,
}: SnapshotPickerModalProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose
  const onSelectRef = React.useRef(onSelect)
  onSelectRef.current = onSelect

  const [submittingId, setSubmittingId] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      previousActiveElementRef.current = document.activeElement as HTMLElement | null
    }

    const timer = setTimeout(() => {
      // Focus first selectable button or dialog container
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled])',
      )
      if (firstFocusable) {
        firstFocusable.focus()
      } else {
        dialogRef.current?.focus()
      }
    }, 20)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
        return
      }

      if (e.key === 'Tab') {
        if (!dialogRef.current) return
        const focusableElements = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
        if (focusableElements.length === 0) {
          e.preventDefault()
          return
        }

        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === firstElement || document.activeElement === dialogRef.current) {
            e.preventDefault()
            lastElement?.focus()
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault()
            firstElement?.focus()
          }
        }
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeyDown, true)
    }

    return () => {
      clearTimeout(timer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown, true)
      }
      if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === 'function') {
        try {
          previousActiveElementRef.current.focus()
        } catch {
          // ignore
        }
      } else if (typeof document !== 'undefined') {
        const topCustomBtn = document.querySelector<HTMLElement>('[data-testid="btn-mode-custom"]')
        topCustomBtn?.focus()
      }
    }
  }, [])

  const handleSelectSnapshot = (snapshotId: string) => {
    if (isActing || submittingId !== null) return
    const target = snapshots.find((s) => s.snapshotId === snapshotId)
    if (!target || target.corrupt) return
    setSubmittingId(snapshotId)
    onSelectRef.current(snapshotId)
    onCloseRef.current()
  }

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99999,
    padding: '16px',
  }

  const modalStyle: CSSProperties = {
    background: 'var(--wl-set-bg-card, #202026)',
    border: '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))',
    borderRadius: '12px',
    maxWidth: '480px',
    width: '100%',
    padding: '22px 24px',
    boxShadow: '0 12px 36px rgba(0, 0, 0, 0.55)',
    boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div style={backdropStyle} role="presentation" onClick={() => onCloseRef.current()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-picker-dialog-title"
        data-testid="snapshot-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h4
          id="snapshot-picker-dialog-title"
          style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 8px 0', color: 'var(--wl-set-text-main, #f2f2f7)' }}
        >
          选择要启用的自定义词典
        </h4>
        <p style={{ fontSize: '12.5px', color: 'var(--wl-set-text-sub, #9898a6)', margin: '0 0 16px 0', lineHeight: '1.5' }}>
          检测到多份已导入的自定义 SQLite 词典快照，请选择需要激活生效的词典：
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
          {snapshots.map((snap) => {
            const isActive = snap.snapshotId === activeSnapshotId
            const isCorrupt = snap.corrupt === true
            return (
              <div
                key={snap.snapshotId}
                data-testid={`snapshot-picker-row-${snap.snapshotId}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: isActive
                    ? '1px solid rgba(34, 197, 94, 0.4)'
                    : '1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))',
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '3px' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--wl-set-text-main, #f2f2f7)' }}>
                      {snap.identity}
                    </span>
                    {isActive && <StatusBadge variant="success" label="当前激活" />}
                    {isCorrupt && <StatusBadge variant="error" label="快照损坏" />}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--wl-set-text-muted, #6c6c7a)', fontFamily: 'monospace' }}>
                    ID: {snap.snapshotId.slice(0, 8)}... | {snap.entryCount?.toLocaleString?.() ?? snap.entryCount} 词条 | {snap.formCount?.toLocaleString?.() ?? snap.formCount} 形态
                  </div>
                </div>

                <ActionButton
                  data-testid={`snapshot-picker-select-${snap.snapshotId}`}
                  size="small"
                  variant={isActive ? 'ghost' : 'primary'}
                  disabled={isActive || isCorrupt || isActing || submittingId !== null}
                  onClick={() => handleSelectSnapshot(snap.snapshotId)}
                >
                  {isActive ? '已激活' : isCorrupt ? '快照损坏' : '启用'}
                </ActionButton>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '18px' }}>
          <ActionButton data-testid="snapshot-picker-cancel" variant="secondary" onClick={() => onCloseRef.current()}>
            取消
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

