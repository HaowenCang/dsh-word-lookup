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
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import { DictionaryManagementStore } from './dictionary-management-store.js';
/** Host settings schema for automatic triggers. */
export interface DictionaryHostSettings {
    readonly autoDoubleClick?: boolean;
    readonly autoSelection?: boolean;
    readonly dictionaryMode?: 'fixture' | 'managed-ecdict' | 'custom';
}
/** Props passed to DictionarySettingsSection. */
export type DictionarySettingsSectionProps = Partial<PropsRuntime<'settings.section'>> & {
    /** Optional pre-configured management store. */
    readonly store?: DictionaryManagementStore;
    /** Optional settings form controller for live switches. */
    readonly form?: ConfigForm<DictionaryHostSettings>;
    /** Force specific platform for shortcut testing. */
    readonly testPlatform?: 'windows' | 'macos' | 'linux';
};
export declare function DictionarySettingsSection({ store: externalStore, form, testPlatform, close: _close, }: DictionarySettingsSectionProps): import("react/jsx-runtime").JSX.Element;
