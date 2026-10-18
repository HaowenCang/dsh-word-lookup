# Phase 7A.8.2R2 Acceptance Matrix & Final Native UI Report

**Phase**: Phase 7A.8.2R2 — Evidence Provenance, Shortcut Persistence & Final Native UI Acceptance  
**Tested Code SHA**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`  
**Previous Code Commit**: `c6bacf19cde2525bcd5a62e922a6ca28ac12bdb6`  
**Previous Evidence Commit**: `f923dcff8d1d9f6771d1baf86059c97b271caa92`  
**Package**: `dsh-word-lookup@0.2.0` (UNRELEASED)  
**Host Environment**: Node.js `v24.13.0`, Windows 11 Pro 64-bit, DeepSeek Harness `0.2.0-rc.2`  
**Browser Engine**: Chromium (Playwright `v1.63.0`)  
**Execution Timestamp**: `2026-10-18T03:12:00Z`  

---

## 1. Executive Summary

Phase 7A.8.2R2 remediates the five critical defects (D1–D5) identified during independent audit of the DSH Word Lookup native dictionary settings and configurable shortcuts integration, ensuring verifiable evidence provenance and robust production quality:

1. **Defect D1 (Shortcut Service Unavailable State Determination & Fallback)**:
   - *Issue*: Missing `ctx.shortcuts` or null catalog snapshots were incorrectly evaluated or masked with default keys, potentially masquerading an unavailable service as functional.
   - *Remediation*: Established a strict state taxonomy union (`SERVICE_UNAVAILABLE`, `CATALOG_NOT_READY`, `COMMAND_NOT_REGISTERED`, `READ_ONLY`, `READY`) in `DictionarySettingsSection`. Missing service displays `[data-testid="shortcut-service-unavailable"]` ("快捷键服务暂不可用"), unready catalog displays `[data-testid="shortcut-catalog-not-ready"]` ("快捷键服务未就绪"), and unregistered command displays `[data-testid="shortcut-command-not-registered"]` ("划词命令未注册"). The edit button is disabled with matching descriptive tooltips, and unbound keybindings cleanly render `"未绑定 (Unbound)"`.

2. **Defect D2 (Actual Shortcut Dispatch, Browser Reload & DSH Restart Persistence)**:
   - *Issue*: Previous tests only checked UI label text mutation without dispatching genuine keydown events, testing word lookup triggering, or verifying persistence across browser reloads and host process restarts.
   - *Remediation*: Implemented end-to-end browser acceptance using Playwright Chromium persistent context (`launchPersistentContext`) with an isolated user data directory. Verified that:
     - Selecting text in an eligible conversation flow item and pressing the custom shortcut (`Control+Alt+KeyJ`) dispatches a real lookup, increments `lookupsByOrigin().shortcut` by exactly 1, and renders the word lookup overlay card.
     - Reloading the browser page (`page.reload()`) preserves the keybinding in `localStorage['dsh.keybindings.v1']` and continues to dispatch lookups.
     - Stopping and restarting the isolated DSH host process preserves keybindings across restarts.
     - Resetting to default in Settings UI restores `Ctrl+Shift+L` and disarms the previous custom binding.

3. **Defect D3 (Async Recording Lock Race Condition & Unmount Cleanup)**:
   - *Issue*: Asynchronous `recording(true)` and `recording(false)` invocations risked race conditions and state leakage upon fast modal open/close or component unmounting during pending promises.
   - *Remediation*: Created `AsyncRecordingLock` with queue-based serialized promise chaining, single ownership tracking, idempotent `release()`, and safe catch handling. `ShortcutRecorderModal` mounts with `lock.acquire()`, unmounts with `lock.release()`, and employs `onCloseRef` to prevent stale closure races.

4. **Defect D4 (Acceptance Coverage Matrix W01–W20 & Clean Evidence Provenance)**:
   - *Issue*: Prior phases lacked a structured acceptance matrix covering all edge cases and mixed production code with evidence artifacts.
   - *Remediation*: Comprehensive 20-scenario matrix (W01–W20) implemented across unit/integration tests and real browser E2E suites. Strict two-commit protocol enforced: Commit A commits code/tests and freezes `TESTED_CODE_SHA`, followed by re-execution on the frozen SHA and Commit B containing strictly `docs/evidence/phase7a8-2r2/**`.

5. **Defect D5 (SnapshotPickerModal Focus Stability, Trap & Lifecycle)**:
   - *Issue*: Parent re-renders (e.g. from polling timer updates) reset modal focus to the dialog container, focus was not trapped between interactive boundaries, and corrupt snapshots lacked explicit visual disablement.
   - *Remediation*: Added WCAG 2.1 compliant focus trap wrapping Tab/Shift+Tab navigation between interactive elements, Escape cancellation, active element restoration upon unmount, and decoupled parent function identity churn using `useRef`. Corrupt snapshots (`corrupt: true`) render with `"快照损坏"` badge and disabled action buttons.

---

## 2. Acceptance Matrix (W01–W20) Verification Results

| Scenario ID | Category | Level | Verdict | Verification Details & Assertions |
|---|---|---|---|---|
| **W01** | Shortcut Service | Unit / Component | **PASS** | `shortcuts: undefined` renders `[data-testid="shortcut-service-unavailable"]` ("快捷键服务暂不可用"), disables edit button, and displays no fallback key masquerading. |
| **W02** | Shortcut Catalog | Unit / Component | **PASS** | Catalog returning `null` snapshot renders `[data-testid="shortcut-catalog-not-ready"]` ("快捷键服务未就绪") and disables edit button. |
| **W03** | Command Registration | Unit / Component | **PASS** | Catalog missing `wordLookup.lookupSelection` renders `[data-testid="shortcut-command-not-registered"]` ("划词命令未注册") and disables edit button. |
| **W04** | Dynamic Recovery | Unit / Integration | **PASS** | Shortcuts catalog recovering dynamically transitions UI from unready to ready, displays real keybinding (`Ctrl + Alt + J`), and enables edit button. |
| **W05** | Async Lock Safety | Unit / Integration | **PASS** | Rapid acquire and release through `AsyncRecordingLock` executes sequentially without leaking lock state (`held = false`). |
| **W06** | Unmount Race Safety | Unit / Integration | **PASS** | Unmount calling release while acquire is pending guarantees acquire completes before release, with final state strictly `held = false`. |
| **W07** | Error Resilience | Unit / Integration | **PASS** | Host shortcuts bus rejection during acquire is safely caught and permits clean idempotent release without unhandled promise rejection. |
| **W08** | Modal Key Capture | Unit / Component | **PASS** | `ShortcutRecorderModal` isolates keydown capture inside recorder box; Escape key cancels and triggers `onClose` cleanly. |
| **W09** | Shortcut Config UI | Real Browser E2E | **PASS** | Shortcut recorder modal verifies conflict detection on `Ctrl+Alt+K` (conflicts with `session.search`), records `Ctrl+Alt+J`, and updates UI display. |
| **W10** | Live Shortcut Dispatch | Real Browser E2E | **PASS** | Selecting text in eligible conversation flow and pressing `Control+Alt+KeyJ` triggers lookup, renders lookup card, and increments shortcut lookup count by 1. |
| **W11** | Browser Reload | Real Browser E2E | **PASS** | Browser page reload preserves custom binding in `localStorage['dsh.keybindings.v1']`; pressing `Control+Alt+KeyJ` dispatches lookup cleanly. |
| **W12** | DSH Process Restart | Real Browser E2E | **PASS** | Isolated DSH process reboot with persistent browser profile preserves custom keybinding; pressing `Control+Alt+KeyJ` triggers lookup. |
| **W13** | Default Shortcut Reset | Real Browser E2E | **PASS** | Resetting shortcut via "恢复默认快捷键" restores `Ctrl+Shift+L`; old custom shortcut `Ctrl+Alt+J` is ignored, and default shortcut triggers lookup. |
| **W14** | Multi-Snapshot Pick | Unit / Component | **PASS** | `SnapshotPickerModal` renders snapshot choices, explicitly selects target snapshot B, and passes exact `snapshotId`. |
| **W15** | Focus Trap & Escape | Unit / Component | **PASS** | `SnapshotPickerModal` traps Tab focus by wrapping from last element back to first, and closes cleanly upon Escape keypress. |
| **W16** | Focus Stability | Unit / Component | **PASS** | Parent component polling re-renders do not reset focus back to dialog container; active element focus is preserved. |
| **W17** | Corrupt Snapshot Gating | Unit / Component | **PASS** | Corrupt snapshot (`corrupt: true`) renders `"快照损坏"` badge and disabled action button, preventing activation. |
| **W18** | Multi-Snapshot E2E | Real Browser E2E | **PASS** | Second custom snapshot ("quantum-beta") verified, activated, and live query hits snapshot B lexicon (`teleportation` -> `source: 'custom-local'`). |
| **W19** | Source File Invariance | Real Browser E2E | **PASS** | Deleting dormant custom snapshot removes it from catalog while user's original source SQLite database remains bit-for-bit invariant (SHA-256 match). |
| **W20** | Full Lifecycle Closure | Real Browser E2E | **PASS** | Complete end-to-end multi-mode management and configurable shortcut lifecycle executed with 100% PASS across all browser scenarios. |

---

## 3. Real Browser Screenshots & Cryptographic Provenance

All screenshots were captured during live Playwright Chromium execution against the booted isolated DSH instance on `TESTED_CODE_SHA` (`b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`):

| Scenario ID | Screenshot Path | Viewport | SHA-256 Hash |
|---|---|---|---|
| **V15** | `screenshots/v15-settings-navigated.png` | 1280x800 | `16125dbc43b9aff149b56863f958f17b13c87fb7d07ad02042e15bd47eef32cd` |
| **V16** | `screenshots/v16-initial-fixture-state.png` | 1280x800 | `16125dbc43b9aff149b56863f958f17b13c87fb7d07ad02042e15bd47eef32cd` |
| **V17** | `screenshots/v17-custom-path-verified.png` | 1280x800 | `22e847951f5e2e1694863d3e678957be625a8efc23bf8e1a431fcb5b4f973769` |
| **V18** | `screenshots/v18-custom-activated.png` | 1280x800 | `6f42ea298838258502d7f23813150a3f3a43a281571ea294ff551f3d7bf6419c` |
| **V19** | `screenshots/v19-switched-to-fixture.png` | 1280x800 | `91bdcc7840443d023bd26370f0bbef4af985b2fab6fc98fa90bf52bdb863b754` |
| **V20** | `screenshots/v20-switched-to-custom.png` | 1280x800 | `384e1c6de64bac7c846315354d28b35e5f227f3fbe95c63326e2e7b781ccab6f` |
| **W09** | `screenshots/w09-shortcut-customized.png` | 1280x800 | `d1eada7c766f9b2cf7e356ab1e9d4b6974a91a01aa1f344810feeefcd422beda` |
| **W10** | `screenshots/w10-shortcut-lookup-card-opened.png` | 1280x800 | `aff1634beeee4fefeff848b52e7b6f7be13ea392e78212bfa081e232b25d6cb0` |
| **W11** | `screenshots/w11-browser-reload-shortcut-lookup.png` | 1280x800 | `aff1634beeee4fefeff848b52e7b6f7be13ea392e78212bfa081e232b25d6cb0` |
| **W12** | `screenshots/w12-dsh-restart-shortcut-lookup.png` | 1280x800 | `aff1634beeee4fefeff848b52e7b6f7be13ea392e78212bfa081e232b25d6cb0` |
| **W13** | `screenshots/w13-shortcut-reset-to-default.png` | 1280x800 | `9e159d625570395194d62e4b68a36805b2c27c239ef19b2be84b54699d53aaf1` |
| **W18** | `screenshots/w18-multi-snapshot-active.png` | 1280x800 | `befaba78994fcc5bf171e4ea81c4102bb60008d7b6aa9211f9d2c89fe25177a4` |
| **W19** | `screenshots/w19-dormant-snapshot-deleted.png` | 1280x800 | `0f679a4fe0b6e6bc67e0a88e0c17fd86129af72cd040b7e21e92a5054005c9b8` |

---

## 4. Verification & Store Contract Summary

1. **Isolation Gate**:
   - `npm run iso:check` passed cleanly, ensuring zero access to production homes (`~/.dsh`), profiles (`web`, `desktop`), or forbidden ports.
2. **Deterministic Corpus Fixture**:
   - `npm run build:fixture` generated deterministic fixture DB with SHA-256 `063fbf6b650afecc6a52f6790fb89956a9a7e07bd6985269324191e399dfd930`.
3. **Type Safety & Compiler**:
   - `npm run typecheck` passed with 0 errors across all production and test files.
4. **Unit & Scenario Regression**:
   - `npx vitest run` passed with 60/60 test files and 1121/1121 tests passing (100%).
5. **Security & Credential Scanning**:
   - `npm run scan:credentials` scanned 631 files, 0 usable secrets/tokens found.
6. **Store Contract**:
   - `npm run verify:store-contract` confirmed strictly 8 files in tarball, 0 runtime dependencies, 0 lifecycle scripts, and absent high-privilege permissions.
7. **Lifecycle Gating**:
   - `npm run test:store-lifecycle` passed all lifecycle phases (INSTALL, START, UNINSTALL, ROLLBACK).
8. **Management & Settings E2E**:
   - `npm run test:mgmt-e2e` passed Parts 1–7.
   - `npm run test:settings-e2e` passed S01–S20.
   - `npm run test:phase7a8-2-e2e` passed V15–V20, W09–W13, W18–W20.
9. **Release Gates**:
   - Release gates `PEAK_RSS_LARGE_FILE_RECOVERY` and `REAL_PROCESS_COMMIT_CRASH_INJECTION` remain recorded as `NOT_FULLY_VERIFIED` in accordance with established requirements.
