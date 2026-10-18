# Phase 7A.8.2R2 Formal Acceptance & Closure Sign-off Report

**Phase**: Phase 7A.8.2R2 — Evidence Provenance, Shortcut Persistence & Final Native UI Acceptance  
**Status**: **PASS**  
**Package**: `dsh-word-lookup@0.2.0` (UNRELEASED)  
**Baseline START_SHA**: `f923dcff8d1d9f6771d1baf86059c97b271caa92`  
**TESTED_CODE_SHA**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 Pro 64-bit, DSH `0.2.0-rc.2`  
**Date**: `2026-10-18T04:01:00Z`

---

## 1. Remediation of the Five Identified Defects

### D1: Shortcut Service Unavailable State Determination & Fallback
- **Defect**: When `activeShortcuts` or catalog snapshots were undefined/null, the UI previously fell back to displaying hardcoded default keys (`Ctrl+Shift+L`) and enabled the edit button, masquerading an unavailable service as operational.
- **Resolution**: Implemented a strict 5-state discriminator (`SERVICE_UNAVAILABLE`, `CATALOG_NOT_READY`, `COMMAND_NOT_REGISTERED`, `READ_ONLY`, `READY`) in `DictionarySettingsSection`. When unavailable, displays `"快捷键服务暂不可用"` and disables the edit button with descriptive tooltip. Does not display fake bindings. Auto-recovers when service catalog becomes ready. Retains command ID `wordLookup.lookupSelection` without introducing secondary global listeners.

### D2: Actual Shortcut Lookup, Live Dispatch & Persistence Across Reloads and Restarts
- **Defect**: Previous tests only inspected UI text label updates without dispatching genuine keyboard events or verifying that lookups occurred via `origin: 'shortcut'`.
- **Resolution**: Automated real browser keyboard dispatch via Playwright Chromium persistent context. Verified that selecting eligible text and pressing `Control+Alt+KeyJ` fires a genuine lookup request, renders the lookup card, and increments the shortcut lookup counter by 1. Verified persistence across browser page reload (`page.reload()`) and across isolated DSH host process termination and reboot. Verified shortcut reset restores default `Ctrl+Shift+L` and disarms custom combination.

### D3: Async Recording Lock Race Condition & Unmount Cleanup
- **Defect**: Asynchronous `recording(true)` and `recording(false)` invocations were vulnerable to race conditions when the modal was opened and closed rapidly, or unmounted before acquire settled.
- **Resolution**: Designed `AsyncRecordingLock` featuring queue-based serialized promise chaining, single ownership, idempotent release, and unhandled rejection safety. Unmounting during a pending acquire guarantees acquire resolves before release executes, leaving final state strictly `held = false`.

### D4: Real UI Acceptance Coverage & Clean Evidence Provenance
- **Defect**: Prior phase lacked a structured 20-scenario matrix and mixed code edits with evidence commits.
- **Resolution**: Enforced strict two-commit protocol. Commit A (`b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`) contains all production fixes and tests, freezing `TESTED_CODE_SHA`. Full re-verification executed on frozen SHA. Commit B contains strictly `docs/evidence/phase7a8-2r2/**` artifacts verified via `git diff-tree`.

### D5: SnapshotPickerModal Focus Stability, Trap & Lifecycle
- **Defect**: Parent polling timer updates recreated callbacks, resetting modal focus back to dialog container; corrupt snapshots were not disabled.
- **Resolution**: Added WCAG 2.1 focus trap (Tab/Shift+Tab wrapping between interactive elements, Escape to dismiss, focus restore to triggering button). Decoupled parent function identity churn using `useRef`. Corrupt snapshots (`corrupt: true`) render with `"快照损坏"` badge and disabled action button.

---

## 2. Release Gates Status

In accordance with strict project guidelines, the following two items remain tracked:
- `PEAK_RSS_LARGE_FILE_RECOVERY` = **NOT_FULLY_VERIFIED**
- `REAL_PROCESS_COMMIT_CRASH_INJECTION` = **NOT_FULLY_VERIFIED**

These gates are deferred to Release Candidate QA and will be addressed during formal RC qualification.

---

## 3. Project Release Readiness

- **READY_FOR_RELEASE_CANDIDATE_QA**: **YES**
- **READY_FOR_NPM_PUBLISH**: **NO** (Strictly forbidden in this phase)
