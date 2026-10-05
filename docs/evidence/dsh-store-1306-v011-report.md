# Phase 6R.1 Evidence & Release Integrity Closure Report
## DSH STORE Issue #1306 Contract Remediation & Release Candidate Closure

### 1. Identity & Provenance
- **Repository**: `https://github.com/HaowenCang/dsh-word-lookup`
- **Default Branch**: `master`
- **Immutable Released Baseline**: `v0.1.0` at `e90175eff909f1548cb73dda20b04105b0398763` (SHA-256: `22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc`)
- **START_SHA**: `e90175eff909f1548cb73dda20b04105b0398763`
- **IMPLEMENTATION_SHA (Commit A)**: `68d896098087044343c93834d2ebe53e50e67677`
- **TESTED_CODE_SHA**: `68d896098087044343c93834d2ebe53e50e67677`
- **Candidate Package Version**: `0.1.1`

### 2. Version Consistency
- `package.json` version: `0.1.1`
- `package-lock.json` top-level version: `0.1.1`
- `package-lock.json` packages[""].version: `0.1.1`
- Consistency gate: **PASS** (verified via `node -p` and `scripts/verify-store-contract.mjs`)

### 3. Previous Phase 6R Evidence Corrections
- **package-lock version mismatch**: In the previous Phase 6R review, `package.json` had been bumped to `0.1.1` while `package-lock.json` remained at `0.1.0`. In Phase 6R.1, both `version` and `packages[""].version` have been synchronized to `0.1.1` and an automated fail-closed check was added to `verify:store-contract`.
- **Test count discrepancy**: The previous Phase 6R report claimed `npm test = 241/241 passed`. This was investigated against the repository test suites: previous `241/241` count was not reproducible and is withdrawn. Direct execution on clean code confirms the authentic baseline is **468 tests across 27 test files** (468 passed, 0 failed, 0 skipped).
- **Previous acceptance evidence binding**: In previous Phase 6R, evidence documents under `docs/evidence/` remained bound to commit `91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`. In Phase 6R.1, dedicated evidence documents were produced and bound directly to `TESTED_CODE_SHA` (`68d896098087044343c93834d2ebe53e50e67677`).
- **Store contract verifier completeness**: Fixed the forbidden corpus archive regex in `scripts/verify-store-contract.mjs` to include `.tgz` alongside `.tar`, `.gz`, `.zip`, `.7z`, etc., and added package-lock version consistency checks.
- **Lifecycle runner isolation & provenance gates**: Refactored `scripts/store-lifecycle-verify.mjs` to enforce fail-closed clean git status preflight, candidate port discovery avoiding all production ports, a secondary post-selection isolation assertion prior to any profile/disk mutation, and explicit candidate tarball binding via `--tarball`.

### 4. Issue #1306 Remediation Matrix

| Category | Check | Expected / Rule | Actual Status | Result |
| --- | --- | --- | --- | --- |
| Repository | Canonical Match | `https://github.com/HaowenCang/dsh-word-lookup` | Canonical URL matched | PASS |
| Version Consistency | Lockfile Alignment | `0.1.1` in `package.json` and `package-lock.json` | `package.json`: 0.1.1, `package-lock`: 0.1.1, `packages[""]`: 0.1.1 | PASS |
| License | License declared | SPDX `MIT` | `MIT` declared; `LICENSE` file present | PASS |
| DSH Compatibility | Declared baseline | `0.2.0-rc.2` | Declared in `dsh.compatibility` | PASS |
| DSH Compatibility | Releases matrix | `0.2.0-rc.2`: compatible; others: unknown | Strictly aligned | PASS |
| DSH Compatibility | Operations matrix | `0.2.0-rc.2`: install, start, uninstall, rollback | All 4 operations measured `passed` | PASS |
| Lifecycle scripts | Forbidden scripts | `preinstall`, `install`, `postinstall`, `prepare` | None present in `package.json` | PASS |
| Runtime dependencies | Dependency array | Zero runtime dependencies | Empty dependencies object | PASS |
| Distributable surface | Explicit `files` | Positive array selector | 7 files explicitly selected | PASS |
| Module closure | Distributable modules | Zero missing local relative imports | `missingLocalModules = 0` | PASS |
| Corpus exclusion | Forbidden files | `*.db`, `*.sqlite`, `*.csv`, `*.zip`, `*.tgz`, etc. | 0 forbidden files in tarball | PASS |

### 5. DSH STORE Static Permission Classification
- `files`: **EXPECTED** (used for host local SQLite dictionary access)
- `network`: **EXPECTED** (browser client calls same-origin host route `POST /api/dsh-word-lookup` only; zero external requests observed)
- `credentials`: **EXPECTED_STATIC_SIGNAL** (`process.env.DSH_WORD_LOOKUP_DB_PATH` read to locate local optional corpus; zero credentials/tokens read)
- `commands`: **ABSENT** (`child_process` not used)
- `protectedDsh`: **ABSENT** (no mutation of loader/fiber)
- `nativeArtifacts`: **ABSENT** (no .node, .dll, or executables)
- `dynamicCodeLoading`: **ABSENT** (no eval or dynamic Function constructor)

### 6. Distributable Tarball Facts
- **Tarball Name**: `dsh-word-lookup-0.1.1.tgz`
- **Tarball SHA-256**: `9001396d4001f4a03914e46809f4d0f6c0cf0125e15bcde3a834c26cb9a737c7`
- **Packed Size**: 46,121 bytes
- **Unpacked Size**: 146,456 bytes
- **File Count**: 7
- **Files in Tarball**:
  1. `LICENSE` (1,089 bytes)
  2. `README.md` (14,599 bytes)
  3. `cordis.patch.yml` (415 bytes)
  4. `corpus/ecdict.manifest.json` (566 bytes)
  5. `lib/client.js` (73,665 bytes)
  6. `lib/index.js` (51,654 bytes)
  7. `package.json` (4,400 bytes)

### 7. Disposable Profile Lifecycle Verification (DSH 0.2.0-rc.2)
Lifecycle operations were executed against the exact candidate tarball (`dsh-word-lookup-0.1.1.tgz`, SHA-256: `9001396d4001f4a03914e46809f4d0f6c0cf0125e15bcde3a834c26cb9a737c7`) using isolated port 50993:
- **Port Isolation**: Pre-checked free, production ports avoided, secondary isolation assertion passed before any mutation.
- **INSTALL**: PASS (candidate unpacked into isolated profile `node_modules/dsh-word-lookup`, not junction, version 0.1.1, patch present, runtime bundles present, bundle registered once)
- **START**: PASS (anonymous route returns 401 unauthenticated fence; session route returns 200; client bundle loads; word card renders `derive`)
- **UNINSTALL**: PASS (package directory removed; session route returns 404; browser client module absent; DSH boots cleanly)
- **ROLLBACK**: PASS (verified immutable `v0.1.0` tarball SHA-256: `22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc`; installed and booted cleanly; lookup works)

### 8. Full Command Matrix & Regression Results

| Command | Exit Code | Duration | Outcome / Parsed Totals | Status |
| --- | --- | --- | --- | --- |
| `npm test` | 0 | 6,117 ms | 27 test files, 468 tests passed, 0 failed, 0 skipped | PASS |
| `npm run typecheck` | 0 | 1,954 ms | TypeScript strict check: 0 errors | PASS |
| `npm run verify` | 0 | 11,171 ms | 6/6 steps passed: fixture (0.6s), typecheck (1.9s), test (6.3s), build (1.7s), bundle-static-checks (0.1s), credential-scan (0.2s) | PASS |
| `npm run verify:store-contract` | 0 | 820 ms | 25/25 checks passed, missingLocalModules = 0 | PASS |
| `npm pack --dry-run` | 0 | 696 ms | 7 files, unpacked size 146,456 bytes | PASS |
| `npm pack` | 0 | 760 ms | Created `dsh-word-lookup-0.1.1.tgz` (46,121 bytes, SHA-256: `9001396d...`) | PASS |
| `npm run test:store-lifecycle` | 0 | 21,364 ms | All 4 lifecycle operations passed (port 50993) | PASS |
| `npm run test:runtime` | 0 | 328,180 ms | 169/169 checks passed | PASS |
| `npm run test:acceptance` | 0 | 22,232 ms | 37/37 browser acceptance checks passed | PASS |
| `npm run corpus:verify-source` | 0 | 362 ms | Verified `.cache/corpus/ecdict.csv` size (65,933,428 bytes) & SHA-256 (`1a6947e0...`) | PASS |
| `npm run corpus:build` | 0 | 14,366 ms | Deterministic build: 770,611 entries, 57,689 forms, logical determinism identical | PASS |
| `npm run corpus:verify` | 0 | 2,778 ms | PRAGMA integrity_check ok, table counts verified | PASS |
| `npm run corpus:benchmark` | 0 | 554 ms | Open: 1.97 ms, steady-state median: 51.4 µs, p95: 87.0 µs | PASS |
| `npm run test:corpus-runtime` | 0 | 33,710 ms | 4 CR1 probes passed, CR2-CR5 negative gates passed | PASS |

### 9. Acceptance Evidence Binding
- **Browser Acceptance Tested SHA**: `68d896098087044343c93834d2ebe53e50e67677` (`docs/evidence/store1306-v011-browser-acceptance.json`)
- **Runtime Acceptance Tested SHA**: `68d896098087044343c93834d2ebe53e50e67677` (`docs/evidence/store1306-v011-runtime.json`)
- **Corpus Runtime Tested SHA**: `68d896098087044343c93834d2ebe53e50e67677` (`docs/evidence/store1306-v011-corpus-runtime.json`)
- **Lifecycle Tested SHA**: `68d896098087044343c93834d2ebe53e50e67677` (`docs/evidence/store1306-v011-lifecycle.json`)
- **All Tested SHAs Match TESTED_CODE_SHA**: **YES**

### 10. Isolation Invariants
- Production DSH profile touched: **NO**
- Production `DSH_HOME` touched: **NO**
- Production session data touched: **NO**
- Production port touched: **NO**
- Unknown process killed: **NO** (only test child process PID explicitly tracked and cleaned)

### 11. Release Actions
- `npm publish`: **NOT PERFORMED**
- `git tag v0.1.1`: **NOT CREATED**
- GitHub Release: **NOT CREATED**

### 12. Remaining Standing Blockers
- **RELEASE BLOCKER — automatic-selection portability**: **OPEN** (opt-in only; defaults to OFF)
- **Full ECDICT redistribution**: **NOT AUTHORIZED** (only test fixture and manifest distributed)
