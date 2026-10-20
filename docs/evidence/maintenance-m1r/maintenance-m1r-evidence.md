# Maintenance M1R — Targeted Remediation & Acceptance Closure Report

## 1. Executive Summary & Baseline

- **Repository**: `E:\Projects\DSHarness\dsh-word-lookup`
- **GitHub Origin**: `HaowenCang/dsh-word-lookup`
- **Target Branch**: `fix/ui-dictionary-formatting-20261019`
- **Initial M1 Commit SHA**: `e092c98fb2aae7ac288d1f0e495b087406242f15`
- **Master Branch Baseline SHA**: `e92af02136102ae6312cfd1c842659fe0f47cbc0`
- **Published Product Version**: `v0.2.0` (unaltered)
- **Runtime Environment Measured**: DSH `0.2.0-rc.2` (Web Profile), Node.js `v24.13.0`, Playwright Chromium `153.0.8010.12`
- **DSH 0.2.1-rc.2 Status**: `NOT_EXECUTED / INDEPENDENT_ACCEPTANCE_NOT_PERFORMED` (no independent environment acceptance performed; zero speculative compatibility claims made)
- **Isolation Gate**: Strict isolation verified via `scripts/assert-isolated-env.mjs` (Scratch profile `word-lookup-test`, isolated port 50996, temp home; real web/desktop profiles, sessions, credentials, and databases completely untouched)

---

## 2. Review and Remediation (R1 – R5)

### R1: Part-of-Speech Badge Duplication & Conflict Remediation
- **Identified Defect**:
  In M1 browser evidence, the dictionary card for `pass` displayed `v.n. 穿过, 通过, 经过...` on the first translation line.
  The UI rendered `meaning.partOfSpeech` (`"v."`) as a badge immediately followed by the first translation line which itself began with `"n."`, causing visual duplication and contradictory POS tags.
- **Remediation**:
  1. Added `hasExplicitPosPrefix()` in `src/shared/text.ts` using a strict, anchored regular expression matching standard dictionary POS abbreviations (`vt`, `vi`, `n`, `v`, `adj`, `adv`, `prep`, `pron`, `conj`, `interj`, `int`, `num`, `art`, `abbr`, `pl`, bracketed `[n.]`, `(vt.)`, and CJK bracketed `【动】`, etc.).
  2. Updated `src/client/card.tsx` so that when translation lines already contain explicit POS prefixes (`hasTranslationPos === true`), the top-level `partOfSpeech` badge is suppressed.
  3. When translation lines lack explicit POS prefixes, or when translation is absent and only English definitions exist, the original `partOfSpeech` badge is preserved.
  4. Preserved all original multiline and multi-sense data without truncation or loss.
  5. Added comprehensive Vitest tests in `tests/client-card-render.spec.ts` covering all 6 required scenarios:
     - Scenario 1: `partOfSpeech="v."` with translation line starting with `n.` -> badge suppressed, no `v.n.` combination.
     - Scenario 2: `partOfSpeech="n."` with translation line starting with `n.` -> duplicate `n.n.` suppressed.
     - Scenario 3: `partOfSpeech="v."` with translation without POS prefix (`得到；源于`) -> badge rendered.
     - Scenario 4: `partOfSpeech=null` with multiline POS entries -> all lines preserved.
     - Scenario 5: multiline translations containing `n.`, `vt.`, and `vi.` -> all lines and senses intact.
     - Scenario 6: `partOfSpeech="v."` with `translation=null` and English definition -> badge rendered.

### R2: Correction of Scroll Test False Positive
- **Identified Defect**:
  `scripts/maintenance-m1-browser-smoke.mjs` previously used `card.scrollHeight >= card.clientHeight` to assert scrollability.
  In M1, the card had `scrollHeight = 372`, `clientHeight = 372`, `beforeScroll = 0`, `afterScroll = 0`. Because `372 >= 372`, the test reported `PASS`, which was a false positive without actual scrolling occurring.
- **Historical Attribution**:
  The M1 scroll test outcome is formally classified and recorded as `FALSE_POSITIVE`.
- **Remediation**:
  1. Updated `scripts/maintenance-m1-browser-smoke.mjs` to synthesize a controlled long dictionary entry (`query: 'long-entry'`) containing 12 translation lines and 12 definition lines.
  2. Implemented strict scroll assertions:
     - `scrollHeight > clientHeight` (strictly greater than, not `>=`)
     - Executed actual scroll: `card.scrollTop = 120`
     - Verified `afterScroll > beforeScroll` (`beforeScroll = 0`, `afterScroll = 120`)
     - Verified maximum height constraint: `clientHeight <= 440px`
     - Verified responsive container width: `scrollWidth <= clientWidth + 1` (zero horizontal overflow)
  3. Captured real scrolled page state in screenshot `03-card-multiline-scroll.png`.
  4. Verified narrow viewport responsiveness (320px viewport width -> card width 296px).

### R3: Verification of Legitimate Backslash & Newline Parsing Boundary
- **Investigation & Parsing Behavior**:
  `splitDefinitionLines()` in `src/shared/text.ts` normalizes real newlines (`\n`, `\r\n`, `\r`) and literal escape sequences (`\n`, `\r\n`, `\r`) in a single pass.
- **ECDICT Data Format Contract**:
  In ECDICT CSV records, multiline definitions and translations are stored using literal escape characters `\n` and `\r\n` to prevent embedded raw control characters within CSV fields.
  Therefore, an unescaped backslash followed immediately by `n` or `r` is syntactically treated as a newline delimiter.
- **Boundary & Remaining Ambiguity**:
  - Non-newline backslashes (e.g. `\lambda`, `\alpha`, `\beta`, `\to`, `C:\dir\file.txt`, `D:\tools\bin`) do not match `\n` or `\r` and are preserved without modification.
  - Strings where a backslash precedes `n` or `r` (such as LaTeX `\nu`, `\nabla`, `\rho` or Windows paths `C:\new`, `C:\reports`) collide with the ECDICT literal newline convention if written with a single backslash.
  - Per standard escaping contracts, double-escaping (`\\nu`, `\\rho`, `\\nabla`, `C:\\new`, `C:\\reports`) unambiguously preserves the literal backslash without splitting.
  - Added deterministic tests in `tests/shared-text.spec.ts` documenting character encodings (0x5C 0x6E vs 0x0A vs 0x0D 0x0A) and validating the exact boundary.

### R4: Evidence Classification
To ensure technical accuracy and avoid overclaiming:
- **`REAL_BROWSER`**: Playwright Chromium `153.0.8010.12` running against live browser DOM.
- **`CONTROLLED_LOOKUP_RESPONSE`**: Dictionary lookup responses injected via Playwright `page.route('**/api/dsh-word-lookup**')` to test specific formatting, long-entry scroll, and POS scenarios.
- **`REAL_DOM_GEOMETRY`**: Live layout measurements (`getBoundingClientRect()`, `scrollTop`, `scrollHeight`, `clientHeight`, `scrollWidth`, `clientWidth`).
- **`ISOLATED_DSH_RUNTIME`**: Fresh scratch environment (`DSH_HOME`, port 50996, profile `word-lookup-test`).
- **`REAL_ECDICT_QUERY_NOT_EXECUTED`**: Live SQLite query against the 800MB production corpus was not executed during this browser smoke test (controlled synthesis used for deterministic scenario coverage).

### R5: Full Test Failure Attribution (Historical Probe P01)
- **Failure Identification**:
  Running `npm test` executes all 60 test suites across the repository.
  59 suites PASS; exactly 1 suite fails: `tests/probes/phase7a8-0/p01-p07-sqlite-safety.spec.ts`.
- **Exact Failed Assertion in P01**:
  `scripts/probes/phase7a8-0/p01-p07-sqlite-safety.mjs` line 106 asserts:
  ```javascript
  const p01Pass =
    gitBranch === 'master' &&
    isAncestorOfBaseline &&
    dshVersion === '0.2.0-rc.2' &&
    nodeVersion.startsWith('v24.')
  ```
- **Attribution Analysis**:
  1. `gitBranch === 'master'`: **FAILED** (`gitBranch` is `'fix/ui-dictionary-formatting-20261019'`).
  2. `isAncestorOfBaseline`: **PASS** (`git merge-base --is-ancestor 31d4fb989e1d710c21e879117755d0c0e3916f63 HEAD` succeeded).
  3. `dshVersion === '0.2.0-rc.2'`: **PASS** (`dsh --version` returned `0.2.0-rc.2`).
  4. `nodeVersion.startsWith('v24.')`: **PASS** (`process.version` is `v24.13.0`).
- **Derivation Invariant**:
  `git merge-base master HEAD` confirms our branch was created directly from master commit `e92af02136102ae6312cfd1c842659fe0f47cbc0`.
  Historical probe P01 was authored specifically to verify that the release baseline in Phase 7A.8 was executed on `master`. Any feature or maintenance branch will fail this environment assertion by definition.
  Per instructions, this historical probe condition was not modified, git metadata was not faked, and the failure is cleanly attributed to test environment scope.

---

## 3. Test Suites & Quality Verification Summary

| Verification Category | Command | Exit Code | Suites / Tests | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **TypeScript Typecheck** | `npm run typecheck` | 0 | All TS source & test files | **PASS** |
| **Rolldown & TS Build** | `npm run build` | 0 | `lib/client.js`, `lib/index.js`, worker | **PASS** |
| **Credential Scan** | `npm run scan:credentials` | 0 | 779 files scanned | **PASS** |
| **Git Diff Check** | `git diff --check` | 0 | Clean whitespace & format | **PASS** |
| **Client & Rendering Specs** | `npx vitest run client` | 0 | 16 suites / 322 tests passed | **PASS** |
| **Shared Text Specs** | `npx vitest run tests/shared-text.spec.ts` | 0 | 1 suite / 54 tests passed | **PASS** |
| **Browser Smoke (Isolated)** | `node scripts/maintenance-m1-browser-smoke.mjs` | 0 | 4 browser checks + screenshots | **PASS** |
| **Full Regression Test Suite** | `npm test` (`vitest run`) | 1 | 60 suites / 1159 tests (1158 passed, 1 failed due to P01 historical branch probe) | **ATTRIBUTED_PASS** |

---

## 4. Browser Smoke Geometry Data (M1R vs M1)

| Dimension / Property | Maintenance M1 (Recorded) | Maintenance M1R (Remediated) | Status |
| :--- | :--- | :--- | :--- |
| **POS Badge on `pass`** | `v.n. 穿过...` (duplicated/conflicted) | `n. 穿过...` (badge suppressed, no `v.n.`) | **FIXED** |
| **Normal Card Width** | 360px | 360px | **PASS** |
| **Narrow Card Width (320px Viewport)** | 296px | 296px | **PASS** |
| **Scroll Height (`scrollHeight`)** | 372px | 1129px | **PASS** |
| **Client Height (`clientHeight`)** | 372px | 438px (within 440px max limit) | **PASS** |
| **Scroll Assertion** | `scrollHeight >= clientHeight` (False Positive) | `scrollHeight > clientHeight` (Strict) | **REMEDIATED** |
| **Scroll Position Before** | 0px | 0px | **PASS** |
| **Scroll Position After** | 0px | 120px (`afterScroll > beforeScroll`) | **VERIFIED** |
| **Horizontal Overflow** | None | `scrollWidth` = 358px <= `clientWidth` = 358px | **PASS** |
| **Settings UI Badge** | "已支持" (Green badge) | "已支持" (Green badge) | **PASS** |
| **Settings Outdated Text** | Absent | Absent | **PASS** |

---

## 5. Visual Evidence Files

The updated, verified evidence files are located in `docs/evidence/maintenance-m1r/`:
1. `screenshots/01-card-multiline-normal-360px.png`: `pass` entry showing 3 clean translation lines and 4 definition lines with no POS badge duplication.
2. `screenshots/02-card-multiline-narrow-viewport.png`: 320px narrow viewport showing clean responsive text wrap without horizontal scrollbar.
3. `screenshots/03-card-multiline-scroll.png`: Actually scrolled long entry card (`scrollTop = 120`), showing lower definitions and verified scroll progress.
4. `screenshots/04-settings-ui-support-badge.png`: Settings UI "快捷键与高级功能" section displaying the "已支持" badge and updated description.
5. `browser-smoke-evidence.json`: Full structured execution ledger.

---

## 6. Remaining Limitations & Closure Recommendation

1. **Backslash Parsing Scope**:
   As documented in R3, unescaped `\n` and `\r` sequences in dictionary data are reserved as newline separators by the ECDICT contract. Texts requiring literal backslashes before `n` or `r` must use standard double-escaping (`\\n`, `\\r`).
2. **Runtime Scope**:
   Acceptance was strictly conducted against DSH `0.2.0-rc.2`. DSH `0.2.1-rc.2` was not executed.
3. **Recommendation**:
   All targeted remediation items (R1–R5) are successfully resolved with zero production regressions.
   We recommend **`MAINTENANCE_M1_CLOSED`**.
