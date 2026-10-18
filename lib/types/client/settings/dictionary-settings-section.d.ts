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
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import { type Shortcuts } from '../contracts.js';
import { DictionaryManagementStore } from './dictionary-management-store.js';
/** Host settings schema for automatic triggers. */
export interface DictionaryHostSettings {
    readonly autoDoubleClick?: boolean;
    readonly autoSelection?: boolean;
    readonly dictionaryMode?: 'fixture' | 'managed-ecdict' | 'custom';
}
/** Authoritative lifecycle state for DSH shortcut integration. */
export type ShortcutServiceState = 'SERVICE_UNAVAILABLE' | 'CATALOG_NOT_READY' | 'COMMAND_NOT_REGISTERED' | 'READ_ONLY' | 'READY';
/** Props passed to DictionarySettingsSection. */
export type DictionarySettingsSectionProps = Partial<PropsRuntime<'settings.section'>> & {
    /** Optional pre-configured management store. */
    readonly store?: DictionaryManagementStore;
    /** Optional settings form controller for live switches. */
    readonly form?: ConfigForm<DictionaryHostSettings>;
    /** Optional shortcuts registry from DSH context. */
    readonly shortcuts?: Shortcuts;
    /** Force specific platform for shortcut testing. */
    readonly testPlatform?: 'windows' | 'macos' | 'linux';
};
export declare function DictionarySettingsSection({ store: externalStore, form, shortcuts, testPlatform, close: _close, }: DictionarySettingsSectionProps): import("react/jsx-runtime").JSX.Element;
