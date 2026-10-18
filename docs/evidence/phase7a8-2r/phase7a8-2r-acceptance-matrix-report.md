# Phase 7A.8.2R Acceptance Matrix & Native Settings UI Repair Report

**Phase**: Phase 7A.8.2R — Native Settings UI Interaction Repair & Real Browser Acceptance Closure  
**Tested Code SHA**: `HEAD`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 Pro 64-bit, DeepSeek Harness `0.2.0-rc.2`  
**Browser Engine**: Chromium `141.0.7391.0` (Playwright `v1.57.0`)  
**Package**: `dsh-word-lookup@0.2.0` (UNRELEASED)  
**Execution Timestamp**: `2026-10-18T01:46:24Z`  

---

## 1. Executive Summary

Phase 7A.8.2R resolves independent audit findings C1–C4 and UI-1 through UI-5 in the native dictionary settings UI and establishes complete end-to-end acceptance through genuine Chromium DOM interactions within an isolated DeepSeek Harness instance:

1. **Defect C1 (Custom Mode Switch Validation & Snapshot Routing)**:
   - `store.selectMode('custom')` without `snapshotId` formerly caused HTTP 400 (`snapshotId is required when mode is "custom"`).
   - Resolved by requiring explicit `snapshotId` when switching to custom mode, adding accessible `SnapshotPickerModal` when multiple valid custom snapshots exist, and directly routing with the single snapshot ID when exactly 1 valid snapshot is available.
2. **Defect C2 (Shortcut Recorder Keyboard Interaction & Lock Stability)**:
   - Space/Enter activation on buttons was previously swallowed or misinterpreted by dialog-level keydown listeners, and unstable recording callback identity caused lock cycling.
   - Resolved by scoping recording key capture to an isolated focusable recorder box (`[data-testid="shortcut-recorder-box"]`), excluding buttons from shortcut interception, guaranteeing stable `recording(true)` on modal open and `recording(false)` on modal close, and handling Escape/Tab without capturing them as keybindings.
3. **Defect C3 (Snapshot Lifecycle Gating & Integrity Worker Check)**:
   - Unleased, inactive deletion gating strictly verified. Deleting an active custom snapshot is rejected (409 SNAPSHOT_ACTIVE), while inactive deletion succeeds cleanly.
4. **Defect C4 (Source File Bit-for-Bit Invariance)**:
   - Confirmed both in Vitest unit test U23 and in real browser Playwright E2E scenario V21 that removing custom snapshots from the catalog never modifies or removes the original user SQLite database. SHA-256 remains 100% invariant before and after snapshot removal.
5. **Defects UI-1 to UI-5**:
   - **UI-1 (Stale Verification Safety)**: Changing the custom path input clears previous verification outcomes and ignores late-arriving responses for older paths.
   - **UI-2 (Mode Button Disabled States)**: Mode buttons and row buttons are disabled during active operations or when `canSwitchMode` is false.
   - **UI-3 (Accessibility & Keyboard Operability)**: `ActionButton` components support both `Enter` and `Space` keyboard triggering; dialogs trap focus and restore previous focus on unmount.
   - **UI-4 (Action Error Notice)**: Operation failures display structured error details in `[data-testid="custom-action-error-box"]` with a dismiss button.
   - **UI-5 (Shortcut Service Unavailable Fallback)**: When `ctx.shortcuts.catalog` is unavailable or null, the UI gracefully displays `快捷键服务暂不可用` and disables modification.

All 48 matrix tests in `tests/phase7a8-2-native-settings.spec.ts` pass, all 60 test files across the repository pass, and all 8 real browser UI E2E scenarios (**V15–V21, V24**) executed with 100% PASS rates.

---

## 2. Real Browser E2E Acceptance Scenarios (V15–V21, V24)

All scenarios were executed against an isolated booted DSH instance (port 50999) using Playwright Chromium with real DOM interactions (clicks, keyboard input, and focus management):

| Scenario ID | Name | Category | Verdict | Description & Evidence |
|---|---|---|---|---|
| **V15** | Settings Navigation & Contribution | REAL BROWSER | **PASS** | Triggered settings navigation, selected "词典" item in nav, verified `.dsh-wl-settings` rendered with title "词典与划词设置". |
| **V16** | Initial Fixture State & Truthful Counts | REAL BROWSER | **PASS** | Verified initial Fixture mode active, ECDICT and Custom buttons disabled, entry count = 7, form count = 11. |
| **V17** | Custom SQLite Path Verification | REAL BROWSER | **PASS** | Filled host file path and identity in input fields, clicked "校验数据库", verified feedback box showed valid v1 SQLite with 3 entries. |
| **V18** | Custom Dictionary Activation | REAL BROWSER | **PASS** | Clicked "导入并激活", verified status badge updated to `自定义已启用 (quantum-physics)` and active snapshot row displayed. Verified lookup query for `superposition` resolved via `custom-local`. |
| **V19** | Switch to Fixture Mode | REAL BROWSER | **PASS** | Clicked top "内置基础词典 (Fixture)" button, verified status badge transitioned to Fixture and snapshot row button changed to "启用". |
| **V20** | Switch Back to Custom Mode | REAL BROWSER | **PASS** | Clicked top "自定义 SQLite 词典" button; routed directly to the single valid snapshot `quantum-physics` with explicit `snapshotId`. Status badge updated to Custom. |
| **V21** | Delete Custom Snapshot & Source Invariance | REAL BROWSER | **PASS** | Switched to Fixture mode, clicked snapshot Delete button, confirmed in modal. Verified snapshot removed from catalog and top Custom button disabled. Confirmed original user SQLite file exists and SHA-256 (`c98d4eb2b33721b426cc23c3d14ba9a32bdc3b2e811991592b238120ed2fc480`) is 100% invariant. |
| **V24** | Configurable Shortcut Recorder UI | REAL BROWSER | **PASS** | Opened recorder modal, verified conflict detection with `session.search` on `Ctrl+Alt+K` disabled Save button. Recorded non-conflicting `Ctrl+Alt+J`, saved, verified UI display update. Reopened and clicked "恢复默认快捷键", verified default `Ctrl+Shift+L` restored. |

---

## 3. Real Browser Screenshot Evidence & Digest Matrix

All screenshots were captured during the live isolated DSH execution:

| Scenario | Screenshot Filename | Viewport | SHA-256 Digest |
|---|---|---|---|
| **V15** | `screenshots/v15-settings-navigated.png` | 1280x800 | `16125dbc43b9aff149b56863f958f17b13c87fb7d07ad02042e15bd47eef32cd` |
| **V16** | `screenshots/v16-initial-fixture-state.png` | 1280x800 | `16125dbc43b9aff149b56863f958f17b13c87fb7d07ad02042e15bd47eef32cd` |
| **V17** | `screenshots/v17-custom-path-verified.png` | 1280x800 | `dd1fd7de8b45ba73c02d9ae350f6b651e7c93009862960d492664be720cde451` |
| **V18** | `screenshots/v18-custom-activated.png` | 1280x800 | `1b56372c9c1c6ca6661a33e100c500a01b29a63656e392feac51a40152c83d0f` |
| **V19** | `screenshots/v19-switched-to-fixture.png` | 1280x800 | `6ac306c3204ab26fd9a3caf6abf2642d7049839f6ba28ba32f1217b43a63b32c` |
| **V20** | `screenshots/v20-switched-to-custom.png` | 1280x800 | `0d7394efc6ca97942aa5b571e9e5745e25b3a4e53ccf4b2ec4803eb0a5ddc7e6` |
| **V21** | `screenshots/v21-custom-deleted-source-preserved.png` | 1280x800 | `40d7aeefbcc0682f2115ace759b2424cab4ecfd72fea792c8a40cf4885240638` |
| **V24** | `screenshots/v24-shortcut-configured-and-reset.png` | 1280x800 | `2efffc0b57f858613189c774a6e4bae5ce00447a04cb6815a5601dcde01d5a52` |

---

## 4. Packaging Contract & Store Compliance

Verification via `npm run verify:store-contract` confirmed strict adherence to DSH Store contracts:
- Exactly 8 production files in tarball pack surface:
  - `LICENSE`
  - `README.md`
  - `cordis.patch.yml`
  - `corpus/ecdict.manifest.json`
  - `lib/client.js`
  - `lib/ecdict-integrity-worker.js`
  - `lib/index.js`
  - `package.json`
- Zero runtime dependencies (`dependencies` is empty `{}`).
- Zero lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare` absent).
- Full corpus data exclusion (`.db`, `.sqlite`, `.csv` strictly excluded from tarball).
- Permissions audited: `files` and `network` present as expected; `credentials`, `commands`, `protectedDsh`, `native`, and `dynamic` absent.
