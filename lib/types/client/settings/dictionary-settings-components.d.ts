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
import { type ReactNode } from 'react';
/** CSS styles injected for settings UI components. */
export declare const SETTINGS_THEME_STYLES = "\n.dsh-wl-settings {\n  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));\n  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));\n  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);\n  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);\n  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);\n  --wl-set-accent: var(--dsw-alias-brand-primary, #4176e6);\n  --wl-set-accent-hover: #3463c2;\n  --wl-set-success: var(--dsw-alias-state-success-primary, #22c55e);\n  --wl-set-warn: var(--dsw-alias-state-warn-primary, #f59e0b);\n  --wl-set-error: var(--dsw-alias-state-error-primary, #ef4444);\n  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));\n}\n\n@media (prefers-color-scheme: light) {\n  .dsh-wl-settings {\n    --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));\n    --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));\n    --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);\n    --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);\n    --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);\n    --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));\n  }\n}\n\n:root[data-theme=\"light\"] .dsh-wl-settings,\nbody:not([data-ds-dark-theme]) .dsh-wl-settings,\n.light .dsh-wl-settings {\n  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));\n  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));\n  --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);\n  --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);\n  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);\n  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));\n}\n\n:root[data-theme=\"dark\"] .dsh-wl-settings,\nbody[data-ds-dark-theme] .dsh-wl-settings,\n.dark .dsh-wl-settings {\n  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));\n  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));\n  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);\n  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);\n  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);\n  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));\n}\n\n@media (max-width: 600px) {\n  .dsh-wl-setting-row {\n    flex-direction: column !important;\n    align-items: flex-start !important;\n    gap: 8px !important;\n  }\n}\n";
export interface SectionCardProps {
    readonly title: string;
    readonly description?: string;
    readonly badge?: ReactNode;
    readonly action?: ReactNode;
    readonly children: ReactNode;
    readonly className?: string;
}
export declare function SectionCard({ title, description, badge, action, children, className }: SectionCardProps): import("react/jsx-runtime").JSX.Element;
export interface SettingRowProps {
    readonly title: string;
    readonly description?: ReactNode;
    readonly control: ReactNode;
    readonly isLast?: boolean;
}
export declare function SettingRow({ title, description, control, isLast }: SettingRowProps): import("react/jsx-runtime").JSX.Element;
export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';
export interface StatusBadgeProps {
    readonly variant: BadgeVariant;
    readonly label: string;
    readonly icon?: ReactNode;
}
export declare function StatusBadge({ variant, label, icon }: StatusBadgeProps): import("react/jsx-runtime").JSX.Element;
export interface SwitchProps {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly onChange: (checked: boolean) => void;
    readonly label: string;
    readonly id?: string;
}
export declare function Switch({ checked, disabled, onChange, label, id }: SwitchProps): import("react/jsx-runtime").JSX.Element;
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export interface ActionButtonProps {
    readonly children: ReactNode;
    readonly onClick: () => void;
    readonly variant?: ButtonVariant;
    readonly disabled?: boolean;
    readonly busy?: boolean;
    readonly size?: 'small' | 'medium';
    readonly ariaLabel?: string;
    readonly title?: string;
}
export declare function ActionButton({ children, onClick, variant, disabled, busy, size, ariaLabel, title, }: ActionButtonProps): import("react/jsx-runtime").JSX.Element;
export interface ProgressBarProps {
    readonly percent?: number;
    readonly label: string;
    readonly subtext?: string;
}
export declare function ProgressBar({ percent, label, subtext }: ProgressBarProps): import("react/jsx-runtime").JSX.Element;
export interface ModalConfirmProps {
    readonly title: string;
    readonly message: ReactNode;
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    readonly isDanger?: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
}
export declare function ModalConfirm({ title, message, confirmLabel, cancelLabel, isDanger, onConfirm, onCancel, }: ModalConfirmProps): import("react/jsx-runtime").JSX.Element;
