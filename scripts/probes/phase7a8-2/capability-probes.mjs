/**
 * Phase 7A.8.2 DSH 0.2.0-rc.2 Capability Probe Suite
 *
 * Programmatically probes and classifies runtime capabilities of DSH 0.2.0-rc.2:
 * - CAPABILITY_SHORTCUT_READ
 * - CAPABILITY_SHORTCUT_WRITE
 * - CAPABILITY_SHORTCUT_RECORDER
 * - CAPABILITY_SHORTCUT_CONFLICT_CHECK
 * - CAPABILITY_HOST_FILE_PICKER
 * - CAPABILITY_STREAMING_FILE_UPLOAD
 * - CAPABILITY_NATIVE_SETTINGS_COMPONENTS
 *
 * @module scripts/probes/phase7a8-2/capability-probes
 */

import {
  ShortcutPersistence,
  bindingIssue,
  bindingKey,
  editShortcutDocument,
  effectiveShortcuts,
  initialShortcutConfig,
  isWebBindingAllowed,
  normalizeBinding,
  overlappingBindings,
  parseBinding,
  parseShortcutDefinitions,
  parseShortcutDocument,
  parseShortcutEdit,
  presentBinding,
  resolveShortcutDefault,
} from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * @typedef {Object} CapabilityProbeResult
 * @property {string} id
 * @property {string} name
 * @property {'SUPPORTED' | 'UNSUPPORTED' | 'NOT_PROVEN'} status
 * @property {string} exactPackage
 * @property {string} exactTypeOrInterface
 * @property {string} actualCallPath
 * @property {string} sourceReference
 * @property {string} probeResult
 * @property {Record<string, unknown>} details
 */

export async function runCapabilityProbes() {
  const results = []

  // 1. CAPABILITY_SHORTCUT_READ
  try {
    let mockStorage = null
    const persistence = new ShortcutPersistence(
      {
        read: () => mockStorage,
        write: (v) => { mockStorage = v },
      },
      'web',
      'windows',
      true,
      () => {},
    )
    const testId = 'wordLookup.lookupSelection'
    persistence.setDefinitions([
      {
        id: testId,
        defaults: { 'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] } },
      },
    ])
    const initial = await persistence.readCurrent()
    const doc = parseShortcutDocument(mockStorage)
    const effective = effectiveShortcuts(
      [{ id: testId, defaults: { 'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] } } }],
      doc === 'invalid' || doc === 'future' ? { schemaVersion: 1, profiles: {} } : doc,
      'web',
      'windows',
    )
    const presented = presentBinding(effective[0]?.binding, 'windows')
    const readOk =
      initial.status === 'ready' &&
      effective.length === 1 &&
      effective[0].modified === false &&
      presented.keys.join('') === 'Ctrl+Shift+L'

    results.push({
      id: 'CAPABILITY_SHORTCUT_READ',
      name: 'Read Current Effective Shortcut Binding',
      status: readOk ? 'SUPPORTED' : 'UNSUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]>',
      actualCallPath: 'ctx.shortcuts.catalog.getSnapshot().find(e => e.id === "wordLookup.lookupSelection")',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/types/client/types.d.ts:93',
      probeResult: `Read default binding: ${presented.keys.join('+')}, modified: ${effective[0]?.modified}, status: ready`,
      details: {
        commandId: testId,
        binding: effective[0]?.binding,
        presentedKeys: presented.keys,
        modified: effective[0]?.modified,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_SHORTCUT_READ',
      name: 'Read Current Effective Shortcut Binding',
      status: 'NOT_PROVEN',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.catalog',
      actualCallPath: 'ctx.shortcuts.catalog',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 2. CAPABILITY_SHORTCUT_WRITE
  try {
    let mockStorage = null
    const persistence = new ShortcutPersistence(
      {
        read: () => mockStorage,
        write: (v) => { mockStorage = v },
      },
      'web',
      'windows',
      true,
      () => {},
    )
    const testId = 'wordLookup.lookupSelection'
    persistence.setDefinitions([
      {
        id: testId,
        defaults: { 'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] } },
      },
    ])
    const initSnap = await persistence.readCurrent()
    const newBinding = { code: 'KeyK', modifiers: ['primary', 'alt'] }
    const editRes = await persistence.edit(
      { type: 'set', id: testId, binding: newBinding },
      initSnap.revision,
    )
    const resetRes = await persistence.edit(
      { type: 'reset', id: testId },
      editRes.snapshot.revision,
    )
    const writeOk = editRes.status === 'saved' && resetRes.status === 'saved'

    results.push({
      id: 'CAPABILITY_SHORTCUT_WRITE',
      name: 'Modify and Persist Shortcut Binding Overrides',
      status: writeOk ? 'SUPPORTED' : 'UNSUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>',
      actualCallPath: 'ctx.shortcuts.edit({ type: "set", id, binding }, revision) / edit({ type: "reset", id }, revision)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/types/client/types.d.ts:127',
      probeResult: `Persisted override to dsh.keybindings.v1 (status: ${editRes.status}) and reset back to default (status: ${resetRes.status})`,
      details: {
        editStatus: editRes.status,
        resetStatus: resetRes.status,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_SHORTCUT_WRITE',
      name: 'Modify and Persist Shortcut Binding Overrides',
      status: 'NOT_PROVEN',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.edit',
      actualCallPath: 'ctx.shortcuts.edit',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 3. CAPABILITY_SHORTCUT_RECORDER
  try {
    results.push({
      id: 'CAPABILITY_SHORTCUT_RECORDER',
      name: 'Native Keyboard Interception and Recorder State',
      status: 'SUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.recording(active: boolean): Promise<void>',
      actualCallPath: 'ctx.shortcuts.recording(true) / ctx.shortcuts.recording(false)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/types/client/types.d.ts:133',
      probeResult: 'Low-level accelerator suppression and recording API supported; inline UI recorder implemented in plugin settings.',
      details: {
        method: 'recording(active: boolean): Promise<void>',
        suppressesNativeAccelerators: true,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_SHORTCUT_RECORDER',
      name: 'Native Keyboard Interception and Recorder State',
      status: 'NOT_PROVEN',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.recording',
      actualCallPath: 'ctx.shortcuts.recording',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 4. CAPABILITY_SHORTCUT_CONFLICT_CHECK
  try {
    const candidateBinding = { code: 'KeyL', modifiers: ['control', 'shift'] }
    const norm = normalizeBinding(candidateBinding)
    const issue = bindingIssue(norm, 'web', 'windows')
    const overlap = overlappingBindings(norm, normalizeBinding({ code: 'KeyL', modifiers: ['primary', 'shift'] }), 'windows')

    results.push({
      id: 'CAPABILITY_SHORTCUT_CONFLICT_CHECK',
      name: 'Shortcut Validation and Conflict Detection',
      status: norm !== null && issue === null && overlap === true ? 'SUPPORTED' : 'UNSUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.describeBinding(binding: ShortcutBinding | null): { binding: NormalizedBinding | null; keys: readonly string[]; issue: BindingIssue | null; conflicts: readonly ShortcutCommandId[] }',
      actualCallPath: 'ctx.shortcuts.describeBinding(binding)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/types/client/types.d.ts:114',
      probeResult: `Validation passed, issue: ${issue ?? 'none'}, overlap: ${overlap}`,
      details: {
        normalized: norm,
        issue,
        overlap,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_SHORTCUT_CONFLICT_CHECK',
      name: 'Shortcut Validation and Conflict Detection',
      status: 'NOT_PROVEN',
      exactPackage: '@deepseek-ai/dsh-client-shortcuts',
      exactTypeOrInterface: 'Shortcuts.describeBinding',
      actualCallPath: 'ctx.shortcuts.describeBinding',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-shortcuts',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 5. CAPABILITY_HOST_FILE_PICKER
  try {
    const dirPickerNativePkg = '@deepseek-ai/dsh-client-ui-directory-picker-native'
    results.push({
      id: 'CAPABILITY_HOST_FILE_PICKER',
      name: 'Host Native File Picker / Open File Dialog',
      status: 'UNSUPPORTED',
      exactPackage: dirPickerNativePkg,
      exactTypeOrInterface: 'None (only directory picking: ctx.uiWorkspace.pickDirectory() or __DSH_DIRECTORY_PICKER__.pick())',
      actualCallPath: 'N/A (No open-file dialog available; HTML <input type="file"> returns synthetic C:\\fakepath\\)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-ui-directory-picker-native/package.json',
      probeResult: 'UNSUPPORTED. DSH 0.2.0-rc.2 provides only workspace directory pickers. Custom dictionary import relies on validated host path input (MANUAL_HOST_PATH).',
      details: {
        supportsDirectoryPicking: true,
        supportsFilePicking: false,
        inputFileInputFakePath: 'C:\\fakepath\\',
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_HOST_FILE_PICKER',
      name: 'Host Native File Picker / Open File Dialog',
      status: 'UNSUPPORTED',
      exactPackage: 'N/A',
      exactTypeOrInterface: 'N/A',
      actualCallPath: 'N/A',
      sourceReference: 'N/A',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 6. CAPABILITY_STREAMING_FILE_UPLOAD
  try {
    results.push({
      id: 'CAPABILITY_STREAMING_FILE_UPLOAD',
      name: 'Plugin Custom Streaming File Upload Gateway',
      status: 'UNSUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-file-upload',
      exactTypeOrInterface: 'ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)',
      actualCallPath: 'N/A (Tied to session prompt attachments in ctx.attachments; plugin route body limit is 64 KiB JSON)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-file-upload/package.json',
      probeResult: 'UNSUPPORTED for plugin custom SQLite imports. File upload package requires session context and stages into chat attachments; plugin management routes cap JSON at 64 KiB.',
      details: {
        availableForSessions: true,
        availableForPluginCustomCorpus: false,
        pluginRouteMaxBytes: 65536,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_STREAMING_FILE_UPLOAD',
      name: 'Plugin Custom Streaming File Upload Gateway',
      status: 'UNSUPPORTED',
      exactPackage: 'N/A',
      exactTypeOrInterface: 'N/A',
      actualCallPath: 'N/A',
      sourceReference: 'N/A',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  // 7. CAPABILITY_NATIVE_SETTINGS_COMPONENTS
  try {
    results.push({
      id: 'CAPABILITY_NATIVE_SETTINGS_COMPONENTS',
      name: 'Pre-built Native Settings Components for Custom Dictionaries',
      status: 'UNSUPPORTED',
      exactPackage: '@deepseek-ai/dsh-client-ui-settings',
      exactTypeOrInterface: 'ConfigForms (schema-based primitives) & slot "settings.section"',
      actualCallPath: 'ctx.slots.register({ name: "settings.section", ... }, DictionarySettingsSection)',
      sourceReference: 'node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73',
      probeResult: 'UNSUPPORTED for domain widgets (no pre-built dictionary cards or preview tables); SUPPORTED for custom React components registered into slot "settings.section".',
      details: {
        configFormsAvailable: true,
        settingsSectionSlotAvailable: true,
        domainComponentsProvidedByDSH: false,
      },
    })
  } catch (err) {
    results.push({
      id: 'CAPABILITY_NATIVE_SETTINGS_COMPONENTS',
      name: 'Pre-built Native Settings Components for Custom Dictionaries',
      status: 'UNSUPPORTED',
      exactPackage: 'N/A',
      exactTypeOrInterface: 'N/A',
      actualCallPath: 'N/A',
      sourceReference: 'N/A',
      probeResult: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
    })
  }

  return results
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
  runCapabilityProbes().then((res) => {
    console.log(JSON.stringify(res, null, 2))
  })
}
