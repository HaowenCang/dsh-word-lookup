# DSH STORE Issue #1306 Contract Remediation Report

## 1. Identity & Provenance
- **Repository**: `https://github.com/HaowenCang/dsh-word-lookup`
- **Default Branch**: `master`
- **Immutable Baseline**: `v0.1.0` at `e90175eff909f1548cb73dda20b04105b0398763` (SHA-256: `22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc`)
- **START_SHA**: `e90175eff909f1548cb73dda20b04105b0398763`
- **TESTED_CODE_SHA**: `ded182ed1a615a2ca985495b75fe6696005f181c`
- **Candidate Package Version**: `0.1.1`

## 2. Issue #1306 Remediation Matrix

| Category | Check | Expected / Rule | Actual Status | Result |
| --- | --- | --- | --- | --- |
| Repository | Canonical Match | `https://github.com/HaowenCang/dsh-word-lookup` | Matches normalized repository URL | PASS |
| License | License declared | SPDX `MIT` | `MIT` declared; `LICENSE` file present | PASS |
| DSH Compatibility | Declared baseline | `0.2.0-rc.2` | Declared in `dsh.compatibility` | PASS |
| DSH Compatibility | Releases matrix | `0.2.0-rc.2`: compatible; others: unknown | Strictly aligned | PASS |
| DSH Compatibility | Operations matrix | `0.2.0-rc.2`: install, start, uninstall, rollback | All 4 operations measured `passed` | PASS |
| Lifecycle scripts | Forbidden scripts | `preinstall`, `install`, `postinstall`, `prepare` | None present in `package.json` | PASS |
| Runtime dependencies | Dependency array | Zero runtime dependencies | Empty dependencies object | PASS |
| Distributable surface | Explicit `files` | Positive array selector | 7 files explicitly selected | PASS |
| Module closure | Distributable modules | Zero missing local relative imports | `missingLocalModules = 0` | PASS |
| Corpus exclusion | Forbidden files | `*.db`, `*.sqlite`, `*.csv`, `*.zip`, etc. | 0 forbidden files in tarball | PASS |

## 3. Package & Distributable Tarball Facts
- **Tarball Name**: `dsh-word-lookup-0.1.1.tgz`
- **Tarball SHA-256**: `e5617f8aaae3080c19732f3a19c15472ec0c0ffe133ab9019167112fbb0b50f5`
- **Packed Size**: 46,104 bytes
- **Unpacked Size**: 146,388 bytes
- **File Count**: 7
- **Files in Tarball**:
  1. `LICENSE` (1,089 bytes)
  2. `README.md` (14,599 bytes)
  3. `cordis.patch.yml` (415 bytes)
  4. `corpus/ecdict.manifest.json` (566 bytes)
  5. `lib/client.js` (73,665 bytes)
  6. `lib/index.js` (51,654 bytes)
  7. `package.json` (4,400 bytes)

## 4. DSH STORE Static Permission Classification
- `files`: **EXPECTED** (used for host local SQLite dictionary access)
- `network`: **EXPECTED** (browser client calls same-origin host route `POST /api/dsh-word-lookup` only; no external network)
- `credentials`: **EXPECTED_STATIC_SIGNAL** (`process.env.DSH_WORD_LOOKUP_DB_PATH` read to locate local optional corpus; no credentials/tokens read)
- `commands`: **ABSENT** (`child_process` not used)
- `protectedDsh`: **ABSENT** (no mutation of loader/fiber)
- `nativeArtifacts`: **ABSENT** (no .node, .dll, or executables)
- `dynamicCodeLoading`: **ABSENT** (no eval or dynamic Function constructor)

## 5. Disposable Profile Lifecycle Verification (DSH 0.2.0-rc.2)
Lifecycle operations were executed against a real unpacked tarball (no repository junction):
1. **INSTALL**: PASS (candidate unpacked into isolated profile `node_modules/dsh-word-lookup`, bundle listed once, patch loaded)
2. **START**: PASS (anonymous route 401 fence verified; session route 200 verified; client bundle loaded; word card rendered)
3. **UNINSTALL**: PASS (package directory removed; session route returns 404; browser client module absent; DSH boots cleanly)
4. **ROLLBACK**: PASS (verified immutable `v0.1.0` tarball SHA-256: `22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc`; installed and booted cleanly; lookup works)

## 6. Regression & Acceptance Results
- `npm test`: 241/241 passed
- `npm run typecheck`: PASS (0 errors)
- `npm run verify`: PASS (fixture, typecheck, tests, bundle-static-checks, credential-scan)
- `npm run verify:store-contract`: PASS (all 22 contract assertions passed)
- `npm run test:runtime`: PASS (169/169 checks)
- `npm run test:acceptance`: PASS (37/37 browser acceptance checks)
- `npm run corpus:verify-source`: PASS
- `npm run corpus:build`: PASS (deterministic byte-for-byte verification passed)
- `npm run corpus:verify`: PASS
- `npm run corpus:benchmark`: PASS
- `npm run test:corpus-runtime`: PASS (13/13 passed)

## 7. Isolation Invariants
- Production DSH profile touched: **NO**
- Production `DSH_HOME` touched: **NO**
- Production session data touched: **NO**
- Production port touched: **NO**
- Unknown process killed: **NO**

## 8. Remaining Standing Blockers
- **RELEASE BLOCKER — automatic-selection portability**: **OPEN** (opt-in only; defaults to OFF)
- **Full ECDICT redistribution**: **NOT AUTHORIZED** (only test fixture and manifest distributed)
