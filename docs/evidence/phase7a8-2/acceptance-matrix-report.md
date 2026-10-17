# Phase 7A.8.2 Acceptance Matrix & Native Settings Closure Report

**Phase**: Phase 7A.8.2 — Native Settings UI, Custom Dictionary Management, Three-Mode Switching & Configurable Lookup Shortcut  
**Tested Code SHA**: `HEAD`  
**Baseline SHA**: `25a33634c549e83e3d852dce5fa6c0774b8d5798`  
**Execution Timestamp**: `2026-10-17T08:25:00-07:00`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 Pro 64-bit, DeepSeek Harness `0.2.0-rc.2`  
**Verification Framework**: Vitest `v3.2.4`, Playwright Chromium `v1.57.0`, Isolated DSH Runner, npm CLI `11.1.0`  

---

## 1. Executive Summary

Phase 7A.8.2 integrates Host dictionary management into the DeepSeek Harness native settings page (`settings.section` slot and `dsh-word-lookup` config form) without requiring manual REST API invocations or developer console commands. It provides:
1. Truthful active dictionary status presentation reflecting the currently active corpus, mode, and precise entry/form counts.
2. Robust three-mode switching between `fixture`, `managed-ecdict` (ECDICT full local corpus), and `custom` (custom SQLite dictionary snapshots).
3. Custom SQLite dictionary management with clear browser sandbox file-picker explanations (`MANUAL_HOST_PATH`), backend verification via Worker thread, atomic activation via `VACUUM INTO`, published snapshot catalog listing, and safe snapshot deletion via `POST /api/dsh-word-lookup/dictionary/remove-custom` with zero mutation to user source files.
4. Configurable lookup shortcut integration using DSH's native `ctx.shortcuts` catalog and recorder system, supporting custom keybinding assignment, modifier requirement validation, conflict detection against existing commands, and instant reset to defaults.

All 32 targeted acceptance scenarios (**U01–U32**) and the 7 capability probes have been implemented and verified with **100% PASS** rates across unit, integration, and real isolated DSH process E2E suites.

---

## 2. DSH Capability Probes Summary

Programmatic verification of the 7 DSH client and host capabilities (`scripts/probes/phase7a8-2/capability-probes.mjs`) yielded authoritative results:

| Capability ID | Description | Status | Evidence / Implementation Strategy |
|---|---|---|---|
| `CAPABILITY_SHORTCUT_READ` | Read Current Effective Shortcut Binding | **SUPPORTED** | `ctx.shortcuts.catalog` observable snapshot exposes current keys, aria label, modified state, and binding. |
| `CAPABILITY_SHORTCUT_WRITE` | Modify and Persist Shortcut Binding Overrides | **SUPPORTED** | `ctx.shortcuts.edit({ type: 'set' \| 'reset', id, binding }, revision)` updates `dsh.keybindings.v1` in `localStorage`. |
| `CAPABILITY_SHORTCUT_RECORDER` | Native Keyboard Interception & Recording Lock | **SUPPORTED** | `ctx.shortcuts.recording(true/false)` engages low-level accelerator suppression while recording new key combinations. |
| `CAPABILITY_SHORTCUT_CONFLICT_CHECK` | Shortcut Validation and Conflict Detection | **SUPPORTED** | `ctx.shortcuts.describeBinding(binding)` normalizes combinations, enforces modifiers, and identifies conflicting command IDs. |
| `CAPABILITY_HOST_FILE_PICKER` | Host Native Open File Dialog | **UNSUPPORTED** | Browser file inputs return synthetic `C:\fakepath\`. Settings UI explicitly provides `MANUAL_HOST_PATH` text input with copy-as-path guidance. |
| `CAPABILITY_STREAMING_FILE_UPLOAD` | Plugin Streaming File Upload Gateway | **UNSUPPORTED** | `ctx.fileUpload` is scoped to chat session attachments; plugin HTTP endpoints cap JSON at 64 KiB. Host path is passed to Host backend, which performs atomic snapshot staging via SQLite `VACUUM INTO`. |
| `CAPABILITY_NATIVE_SETTINGS_COMPONENTS` | Pre-built Dictionary UI Domain Components | **UNSUPPORTED** | DSH provides generic schema forms and slot `settings.section`. All domain-specific cards, tables, and recorder modals are implemented directly within the plugin's native section component. |

---

## 3. Acceptance Matrix Scenarios (U01–U32)

### 3.1 Three-Mode Switching, Stats Truthfulness & Coexistence (U01–U09)

- **U01**: Status display reflects activeMode `fixture` with fixture stats (7 entries, 11 forms). (**PASS**)
- **U02**: Status display reflects activeMode `managed-ecdict` with truthful ECDICT corpus stats (770,611 entries, 57,689 forms). (**PASS**)
- **U03**: Status display reflects activeMode `custom` with custom snapshot stats and identity. (**PASS**)
- **U04**: Three-mode switcher renders all three mode choices (`fixture`, `managed-ecdict`, `custom`). (**PASS**)
- **U05**: Mode switch to `fixture` dispatches `select-mode` and updates store. (**PASS**)
- **U06**: Mode switch to `managed-ecdict` is disabled when ECDICT is not installed. (**PASS**)
- **U07**: Mode switch to `managed-ecdict` is enabled when ECDICT is installed and dispatches switch. (**PASS**)
- **U08**: Mode switch to `custom` switches active snapshot to the custom dictionary. (**PASS**)
- **U09**: Removing ECDICT while custom mode is active retains custom mode and does not force fixture mode. (**PASS**)

### 3.2 Custom SQLite Management UX, Verification & Lifecycle (U10–U23)

- **U10**: Custom dictionary path input accepts host filesystem path with `MANUAL_HOST_PATH` guidance. (**PASS**)
- **U11**: Path verification calls `/verify` and displays entryCount, formCount, and headwords sample. (**PASS**)
- **U12**: Path verification displays error message when path is non-existent, invalid, or corrupt SQLite. (**PASS**)
- **U13**: Custom dictionary activation calls `/activate-custom` with validated parameters. (**PASS**)
- **U14**: Successful activation clears input path, identity, and verification outcome. (**PASS**)
- **U15**: Custom dictionary activation preserves user original source database untouched. (**PASS**)
- **U16**: Custom dictionary snapshots list displays all published snapshots with metadata and status. (**PASS**)
- **U17**: Custom snapshot row shows "当前激活" badge for the active snapshot. (**PASS**)
- **U18**: Switching active custom snapshot via row "启用" button calls `select-mode`. (**PASS**)
- **U19**: Deletion of active custom snapshot is disabled in UI with status protection badge. (**PASS**)
- **U20**: Deletion of leased custom snapshot is disabled in UI with active lease count. (**PASS**)
- **U21**: Deletion of unleased inactive custom snapshot opens confirmation modal with safety notice. (**PASS**)
- **U22**: Confirming removal executes `/remove-custom` and unlinks snapshot from disk and catalog. (**PASS**)
- **U23**: Custom snapshot deletion never touches original source database file. (**PASS**)

### 3.3 Configurable Lookup Shortcut UX & ctx.shortcuts Integration (U24–U32)

- **U24**: Shortcut section reads current binding from `ctx.shortcuts` catalog. (**PASS**)
- **U25**: Shortcut section presents default `Ctrl + Shift + L` on Windows/Linux and `⌘ + Shift + L` on macOS. (**PASS**)
- **U26**: Opening shortcut recorder modal engages `ctx.shortcuts.recording(true)` to suppress accelerators. (**PASS**)
- **U27**: Shortcut recorder captures keys and calls `describeBinding` for normalization. (**PASS**)
- **U28**: Shortcut recorder rejects invalid combinations missing a modifier key. (**PASS**)
- **U29**: Shortcut recorder detects and warns on binding conflicts with other DSH commands. (**PASS**)
- **U30**: Saving new shortcut calls `ctx.shortcuts.edit({ type: 'set', ... })` and updates catalog. (**PASS**)
- **U31**: Resetting shortcut calls `ctx.shortcuts.edit({ type: 'reset', ... })` and restores default. (**PASS**)
- **U32**: Closing recorder releases recording mode via `ctx.shortcuts.recording(false)`. (**PASS**)

---

## 4. Real Isolated DSH 0.2.0-rc.2 E2E Verification

The isolated end-to-end test suite (`scripts/test-phase7a8-2-settings-e2e.mjs`) verified live behavior against a clean booted DSH 0.2.0-rc.2 server with real Chromium:

1. **E2E-01-INITIAL_STATUS**: Booted into default fixture mode (7 entries, 11 forms). (**PASS**)
2. **E2E-02-VERIFY_CUSTOM_DB**: Verified a custom SQLite database via `POST /api/dsh-word-lookup/dictionary/verify`. (**PASS**)
3. **E2E-03-ACTIVATE_CUSTOM_DB**: Staged and activated custom snapshot `54a588e7-4da4-4f09-ba1e-7eea6f7d22cd` via `POST /api/dsh-word-lookup/dictionary/activate-custom`. (**PASS**)
4. **E2E-04-CUSTOM_LOOKUP_QUERY**: Executed live lookup query for word `superposition`, returning status 200 with source `custom-local`. (**PASS**)
5. **E2E-05-SWITCH_TO_FIXTURE**: Successfully switched mode back to `fixture` via `POST /api/dsh-word-lookup/dictionary/select-mode`. (**PASS**)
6. **E2E-06-SWITCH_TO_CUSTOM**: Successfully switched mode back to custom snapshot via `POST /api/dsh-word-lookup/dictionary/select-mode`. (**PASS**)
7. **E2E-07-ACTIVE_SNAPSHOT_REMOVAL_REJECTED**: Attempting to delete the active custom snapshot returned HTTP 409 `SNAPSHOT_ACTIVE`. (**PASS**)
8. **E2E-08-INACTIVE_SNAPSHOT_REMOVED**: Switched to fixture mode and deleted the now-dormant custom snapshot via `POST /api/dsh-word-lookup/dictionary/remove-custom`, unlinking the snapshot file and updating `index.json`. (**PASS**)
9. **E2E-09-USER_SOURCE_FILE_PRESERVED**: User source database remained bit-for-bit identical throughout all operations. (**PASS**)
10. **E2E-10-SHORTCUT_CONTEXT_CONFIRMED**: DSH client shortcut system and browser event listeners confirmed ready. (**PASS**)

---

## 5. Store Packaging and Verification Surface

Running `npm run verify:store-contract` confirms strict compliance with DSH 0.2.0-rc.2 Store distribution contracts:

```
Package: dsh-word-lookup-0.2.0.tgz (8 files, unpacked: 558757 bytes)
Files:
  LICENSE
  README.md
  cordis.patch.yml
  corpus/ecdict.manifest.json
  lib/client.js
  lib/ecdict-integrity-worker.js
  lib/index.js
  package.json

Permission Signals:
  files:       EXPECTED (SQLite/local file access)
  network:     EXPECTED (same-origin /api/dsh-word-lookup)
  credentials: ABSENT (zero process.env / secrets)
  commands:    ABSENT
  protected:   ABSENT
  native:      ABSENT
  dynamic:     ABSENT
```

- Total Vitest test suites: **60 passed (60)**
- Total Vitest tests: **1092 passed (1092)**
- TypeScript strict-mode compilation: **PASS (0 errors)**

---

## 6. Closure Verdict

**PASS**: Phase 7A.8.2 native settings UX, custom dictionary management, three-mode switching, custom snapshot safe removal, and configurable lookup shortcut integration meet all architectural, security, and functional criteria with zero regressions.
