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
      style={buttonStyle}
      disabled={disabled || busy}
      onClick={onClick}
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
          <ActionButton onClick={onCancel} variant="secondary">
            {cancelLabel}
          </ActionButton>
          <ActionButton onClick={onConfirm} variant={isDanger ? 'danger' : 'primary'}>
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
