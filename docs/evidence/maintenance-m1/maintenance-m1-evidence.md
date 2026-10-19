# Maintenance M1 — Dictionary Formatting & Settings UI Correction

## Executive Summary

- **Task**: Maintenance M1 — Dictionary Formatting & Settings UI Correction
- **Target Branch**: `fix/ui-dictionary-formatting-20261019` (created from `master` @ `e92af02136102ae6312cfd1c842659fe0f47cbc0`)
- **Published Baseline Version**: `v0.2.0` (unaltered)
- **Runtime Environment Measured**: DSH `0.2.0-rc.2` (Web Profile), Node.js `v24.13.0`, Playwright Chromium `153.0.8010.12`
- **Candidate Target DSH 0.2.1-rc.2**: `NOT_EXECUTED / BLOCKED_ENVIRONMENT` (candidate target for independent adaptation; not claimed compatible)
- **Isolation Status**: Verified via `scripts/assert-isolated-env.mjs` (Scratch profile, port 50996; zero mutation of production homes, ports, sessions or profiles)
- **Final Verdict**: **PASS**

---

## 1. Root Cause Analysis

### FMT-01: Unrendered Escaped Line Breaks in Definitions & Translations
- **Defect Location**: `src/client/card.tsx:398-436`, `src/shared/text.ts:98-104`
- **Root Cause**:
  In ECDICT and upstream corpora, multi-part definitions and translations often encode line breaks as literal `\n`, `\r\n` or standard LF/CRLF within CSV text cells (e.g. `pass` has translation `n. ...\nvt. ...\nvi. ...` and definition `n. ...\nn. ...\nv. ...`).
  The existing UI in `src/client/card.tsx` used `splitGlosses(meaning.translation)` which only split on semicolons (`/[；;]/`), while `meaning.definition` was printed directly as a single text node inside a `<span>`.
  Neither LF/CRLF nor literal `\n` were formatted into distinct lines. Consequently, multiple parts of speech and senses were concatenated in a single run of text with literal `\n` displayed to the user.
- **Remediation**:
  1. Implemented a deterministic, pure parser `splitDefinitionLines` in `src/shared/text.ts`.
     - Single-pass parsing supporting real LF (`\n`), CRLF (`\r\n`), CR (`\r`), and literal escape sequences `\n`, `\r\n`, `\r`.
     - Controlled whitespace/tab substitution (`\t` -> space).
     - Preserves double-escaped backslashes (`\\n` remains literal `\n`).
     - Preserves legitimate backslashes (e.g. `\lambda`, `C:\dir\file.txt`).
     - Collapses consecutive empty lines and trims lines without ghost rows.
     - Pure text representation: React escapes all HTML characters, preventing XSS injection.
  2. Updated `src/client/card.tsx` to render multi-line translations and definitions as structured block lines (`data-dsh-word-lookup="translation-line"` and `data-dsh-word-lookup="definition-line"`). Semicolon glosses are properly nested within each translation line.

### UI-02: Outdated Development Phase Badge "Phase 7A.8 开放"
- **Defect Location**: `src/client/settings/dictionary-settings-section.tsx:1391`
- **Root Cause**:
  In the "快捷键与高级功能" section, the "自定义外部 SQLite 词典" row still had hardcoded `<StatusBadge variant="success" label="Phase 7A.8 开放" />`.
  The custom SQLite dictionary management feature was already fully implemented and verified in Phase 7A.8 (Section C of the settings page).
- **Remediation**:
  1. Updated the status badge label to the stable product text `"已支持"`.
  2. Updated the row description to direct users to the existing management section:
     `"支持指定本地用户自建或专业领域的 SQLite 词库文件。请在上方“自定义 SQLite 词典管理”区域配置并挂载使用。"`
  3. Updated test assertions in `tests/client-settings-ui.spec.ts`.

---

## 2. Evidence Classification & Results

| Evidence Level | Description | Outcome |
| :--- | :--- | :--- |
| **REAL** | Isolated DSH 0.2.0-rc.2 process execution, live browser DOM verification with Playwright Chromium, actual bounding-box vertical coordinate descent, responsive layout measurement, full-screen and element screenshots | **PASS** |
| **CONTROLLED_TEST** | Unit tests in Vitest covering `pass` synthesis, real/literal line breaks, CRLF, backslash preservation, HTML injection resistance, DOM structure counts | **PASS** (99/99 in modified suites, 316/316 client tests) |
| **STATIC** | TypeScript typecheck (`tsc -p tsconfig.json`), rollup/tsdown build (`tsdown && tsc -p tsconfig.build.json`), credential leak scanner (`scan-credentials.mjs`), `git diff --check` | **PASS** |
| **NOT_EXECUTED** | Full compatibility execution on candidate runtime DSH `0.2.1-rc.2` | **BLOCKED_ENVIRONMENT** (Not deployed in isolation; zero unverifiable compatibility claims made) |

---

## 3. Browser Smoke Test Metrics

- **Script**: `scripts/maintenance-m1-browser-smoke.mjs`
- **Port**: `50996` (isolated test port)
- **Profile**: `word-lookup-test` under isolated scratch root
- **FMT-01 Normal Viewport**:
  - Panel width: `360px`
  - Translation line count: `3` (each with strictly descending `top` coordinates)
  - Definition line count: `4` (each with strictly descending `top` coordinates)
  - Literal `\n` present in rendered text: `false`
- **FMT-01 Narrow Viewport (320px width)**:
  - Panel width: `296px` (fits within `320px` viewport without horizontal overflow)
- **FMT-01 Long Entry Scrollability**:
  - `overflowY: auto` active, `scrollHeight` matches content height
- **UI-02 Settings UI**:
  - "Phase 7A.8" text in settings: `false`
  - "已支持" badge present: `true`
  - Updated description directing to management section: `true`

---

## 4. Visual Evidence Artifacts

1. `docs/evidence/maintenance-m1/screenshots/01-card-multiline-normal-360px.png`: Result card rendering for `pass` with 3 distinct translation lines, 4 distinct definition lines, phonetic and POS tags in normal 360px width.
2. `docs/evidence/maintenance-m1/screenshots/02-card-multiline-narrow-viewport.png`: Result card rendering under 320px narrow viewport showing responsive wrapping.
3. `docs/evidence/maintenance-m1/screenshots/03-card-multiline-scroll.png`: Result card scrollability verification.
4. `docs/evidence/maintenance-m1/screenshots/04-settings-ui-support-badge.png`: Settings UI "快捷键与高级功能" section showing "自定义外部 SQLite 词典" with "已支持" status badge.
5. `docs/evidence/maintenance-m1/browser-smoke-evidence.json`: Full machine-readable test execution ledger.
