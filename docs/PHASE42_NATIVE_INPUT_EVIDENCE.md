# Phase 4.2 Native Input Measurement Evidence — Windows / Chromium Real Input Stack

> **Phase 4.2.2 Native Input Acceptance Measurement (2026-10-04).**
> Following Phase 4.2 (CDP-based multiplicity measurement) and the Phase 4.2.1 probe audit, three measurement instrument defects in `scripts/phase421-native-input-probe.mjs` were identified and repaired.
> With monotonic single-origin timing, strict click-sequence cooldowns (fresh `detail === 1`), numeric `offsetPx` preservation, and verified negative/positive validity controls, this experiment measured the reachability of the first-press drag / double-click overlap through the **real Windows mouse input queue** (`SendInput` without caller-supplied `clickCount`).

---

## 1. Instrument Repair Summary (Phase 4.2.2)

### DEFECT A — offsetPx Lost
- **Problem:** In previous runs, `runRow()` returned objects lacking `offsetPx: spec.offsetPx`, causing spatial validity assertions (`spatialRows.find(row => row.offsetPx === 0)`) to evaluate to `null` even if the spatial sweep ran.
- **Repair:**
  - `runRow()` and `runRowResilient()` now explicitly project `offsetPx: typeof spec.offsetPx === 'number' ? spec.offsetPx : (spec.offsetPx ?? null)`.
  - Added a fail-loud assertion `assertSpatialRowsIntegrity(spatialRows)` in `scripts/phase421-instrument-logic.mjs` requiring every control-space row to have a numeric `offsetPx`.

### DEFECT B — Incompatible Clock Origins
- **Problem:** `firstReleaseMs` was recorded from `performance.now() - window.__PHASE421__.started` (trace-relative), but the inter-press wait loop mixed `page.evaluate(() => performance.now())` and Node's `Date.now()`, causing origin misalignment (e.g. 410 ms requested measuring as 10 ms).
- **Repair:**
  - Implemented single-clock monotonic timing via `calculateGapWait(firstReleaseMs, requestedGapMs, currentTraceMs)`.
  - Node calculates target trace time and waits using high-resolution monotonic spin aligned to trace origin.
  - Added `gapErrorMs = measuredGapMs - requestedGapMs` and strict tolerance verification (`toleranceMs = 30`). Any timed row exceeding tolerance fails the validity gate (`BLOCKED — TIMING CONTROL INVALID`).

### DEFECT C — Row-to-Row Click-Count Contamination
- **Problem:** Multi-click sequences across rows were bleeding into each other (e.g., T-BELOW ending at detail 2 and T-ABOVE starting at detail 3).
- **Repair:**
  - Implemented dynamic inter-row cooldown: `calculateRowCooldownMs(GetDoubleClickTime(), 100) = 500 + 100 = 600 ms` enforced between mouse actions.
  - Added strict freshness validation `validateRowFreshness(row)` asserting `first mousedown.detail === 1`.
  - If a row starts with `detail !== 1`, it is retried with cooldown up to 3 times before failing loud (`BLOCKED — CLICK SEQUENCE DID NOT RESET`).

### Pure Regression Test Suite
- Pure algorithms isolated in `scripts/phase421-instrument-logic.mjs` with typing in `scripts/phase421-instrument-logic.d.mts`.
- 14 automated unit tests added in `tests/phase421-probe-logic.spec.ts` covering:
  - `offsetPx` preservation & fail-loud integrity;
  - Monotonic gap scheduling & rejection of out-of-tolerance gaps (e.g. 410 ms -> 10 ms rejected);
  - Row freshness rejection of detail >= 2;
  - Validity gates for timeout positive (1 -> 2, dblclick=true), timeout negative (1 -> 1, dblclick=false), spatial positive (1 -> 2), and spatial far (1 -> 1).

---

## 2. Platform & System Metrics Snapshot

| Metric | Source | Value |
| --- | --- | --- |
| OS | `Win32 GetOperatingSystemInfo` | Microsoft Windows 11 Pro for Workstations Insider Preview (Build 26220, 64-bit) |
| Display | Physical Virtual Screen | 2560 x 1600 @ 150% DPI scale (`devicePixelRatio = 1.5`, DPI = 144) |
| `GetDoubleClickTime()` | Win32 API | 500 ms |
| `SM_CXDOUBLECLK` / `SM_CYDOUBLECLK` | `GetSystemMetrics` | 4 px / 4 px |
| `SM_CXDRAG` / `SM_CYDRAG` | `GetSystemMetrics` | 4 px / 4 px |
| DoubleClickWidth / Height (DPI) | `GetSystemMetricsForDpi` | 4 px / 4 px |
| DoubleClickWidth / Height | Registry `HKCU:\Control Panel\Mouse` | 4 / 4 |
| DoubleClickSpeed | Registry `HKCU:\Control Panel\Mouse` | 500 |
| Chromium | Page Browser Version | Chrome / 153.0.8010.12 |
| DSH Web Core | Runtime | 0.2.0-rc.2 |

---

## 3. Validity Controls (Gate Evaluation)

All validity controls passed with strong click multiplicity and timing assertions:

### Timeout Positive Control (`T-BELOW`)
- Requested gap: 410 ms
- Measured gap: 415.1 ms (gap error: +5.1 ms, tolerance <= 30 ms)
- Multiplicity: `first mousedown.detail = 1`, `second mousedown.detail = 2`
- Double click emitted: `true`
- Status: **VALID PASS**

### Timeout Negative Control (`T-ABOVE`)
- Requested gap: 700 ms
- Measured gap: 706.6 ms (gap error: +6.6 ms, tolerance <= 30 ms)
- Multiplicity: `first mousedown.detail = 1`, `second mousedown.detail = 1`
- Double click emitted: `false`
- Status: **VALID PASS**

### Spatial Positive Control (`S-000`, Offset 0 CSS px)
- Offset: 0 CSS px (same point)
- Gap: 90 ms requested, 98.1 ms measured (error: +8.1 ms)
- Multiplicity: `first mousedown.detail = 1`, `second mousedown.detail = 2`
- Double click emitted: `true`
- Status: **VALID PASS**

### Spatial Far Negative Control (`S-060`, Offset 60 CSS px)
- Offset: 60 CSS px apart
- Gap: 90 ms requested, 94.5 ms measured (error: +4.5 ms)
- Multiplicity: `first mousedown.detail = 1`, `second mousedown.detail = 1`
- Double click emitted: `false`
- Status: **VALID PASS**

### Empirical Spatial Boundary Sweep
Spatial offset sweep at 90 ms gap:
- Offset 0 CSS px (0 physical px): `dblclick = true` (`1 -> 2`)
- Offset 1 CSS px (1.5 physical px): `dblclick = true` (`1 -> 2`)
- Offset 2 CSS px (3.0 physical px): `dblclick = false` (`1 -> 1`)
- Offset 3 CSS px (4.5 physical px): `dblclick = false` (`1 -> 1`)
- Offset 4, 6, 8, 12, 20, 40, 60 CSS px: `dblclick = false` (`1 -> 1`)

**Empirical Boundary:** Double-click recognized up to 1 CSS px (1.5 physical px), dropped at 2 CSS px (3.0 physical px). This aligns closely with `SM_CXDOUBLECLK = 4` physical pixels.

**Validity Gate Result:** `probeValid = true`.

---

## 4. Native Measurement Results: Group A & Group B

### Group A (First down at X0, drift to X1, second down at X0)
Drift during first press; second press returns to the first press down coordinate X0:

| Row ID | Requested Travel | Observed Travel | First Kind | Selection at Release | First MD Detail | Second MD Detail | Emitted DblClick | Gap Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-00 | 0 px | 0.67 px | other | `""` | `[1]` | `[2]` | **true** | +2.0 ms |
| A-01 | 1 px | 0.67 px | other | `""` | `[1]` | `[2]` | **true** | +6.6 ms |
| A-02 | 2 px | 2.11 px | other | `""` | `[1]` | `[1]` | false | +7.1 ms |
| A-03 | 3 px | 2.67 px | other | `""` | `[1]` | `[1]` | false | +3.1 ms |
| A-04 | 4 px | 4.06 px | other | `"d"` | `[1]` | `[1]` | false | +10.1 ms |
| A-05 | 5 px | 4.67 px | other | `"d"` | `[1]` | `[1]` | false | +7.5 ms |
| A-06 | 6 px | 6.04 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +8.4 ms |
| A-08 | 8 px | 8.03 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +2.1 ms |
| A-10 | 10 px | 10.02 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +6.6 ms |
| A-12 | 12 px | 12.02 px | **drag** | `"de"` | `[1]` | `[1]` | **false** | +4.3 ms |

### Group B (First down at X0, drift to X1, second down at X1)
Drift during first press; second press stays at the release coordinate X1:

| Row ID | Requested Travel | Observed Travel | First Kind | Selection at Release | First MD Detail | Second MD Detail | Emitted DblClick | Gap Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B-00 | 0 px | 0.00 px | other | `""` | `[1]` | `[2]` | **true** | +3.0 ms |
| B-01 | 1 px | 0.67 px | other | `""` | `[1]` | `[2]` | **true** | +10.9 ms |
| B-02 | 2 px | 2.11 px | other | `""` | `[1]` | `[1]` | false | +7.0 ms |
| B-03 | 3 px | 2.67 px | other | `""` | `[1]` | `[1]` | false | +3.0 ms |
| B-04 | 4 px | 4.06 px | other | `"d"` | `[1]` | `[1]` | false | +2.5 ms |
| B-05 | 5 px | 4.67 px | other | `"d"` | `[1]` | `[1]` | false | +4.6 ms |
| B-06 | 6 px | 6.04 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +11.5 ms |
| B-08 | 8 px | 8.03 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +3.1 ms |
| B-10 | 10 px | 10.02 px | **drag** | `"d"` | `[1]` | `[1]` | **false** | +1.9 ms |
| B-12 | 12 px | 12.02 px | **drag** | `"de"` | `[1]` | `[1]` | **false** | +2.4 ms |

### Confirmation Battery
Repeated trials at 5 px, 8 px, and 12 px:
- `C-A-05-1`, `C-A-05-2`: observed travel 4.67 px, kind `other`, dblclick = `false`
- `C-B-05-1`, `C-B-05-2`: observed travel 4.67 px, kind `other`, dblclick = `false`
- `C-A-08-1`, `C-A-08-2`: observed travel 8.03 px, kind `drag`, dblclick = `false`
- `C-B-08-1`, `C-B-08-2`: observed travel 8.03 px, kind `drag`, dblclick = `false`
- `C-A-12-1`, `C-A-12-2`: observed travel 12.02 px, kind `drag`, dblclick = `false`
- `C-B-12-1`, `C-B-12-2`: observed travel 12.02 px, kind `drag`, dblclick = `false`

---

## 5. Overlap Summary & Finding

- **Drag-classified rows (observed travel >= 5 px, eligible selection):** 16 rows
- **Rows where a subsequent platform double click occurred:** 0 rows (0 / 16)
- **All rows started with fresh click sequence:** `mousedown.detail === 1` verified on 100% of rows.
- **Timing accuracy:** Gap errors ranged between +1.9 ms and +11.5 ms (well within the <= 30 ms tolerance).

### Finding (CASE A)
```text
PASS — PHASE 4.2 NATIVE OVERLAP NOT OBSERVED / READY FOR INDEPENDENT REVIEW
```

**Verdict summary:**
Through the real Windows input stack, no first press that the product classified as a drag was followed by a platform-recognised double click in this verified Windows/Chromium environment.
Both Group A and Group B drop double click recognition once movement exceeds 1 CSS px (empirical boundary), well below the product's 5 CSS px drag classification threshold.

---

## 6. Artifacts & Evidence Files

- JSON Evidence: `docs/evidence/phase42-native-input-20261004.json`
- Verification Log / Screen: `verify-out/phase421-probe-page.png`
- Instrument Repair Commit: `6fded22`
