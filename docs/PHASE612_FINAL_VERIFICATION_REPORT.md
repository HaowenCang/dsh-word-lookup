# Phase 6.1.2 Final Evidence Closure & Documentation Accuracy Report

**Repository**: `HaowenCang/dsh-word-lookup`  
**Phase**: `Phase 6.1.2` (Final Evidence Closure & Documentation Accuracy)  
**Starting Commit SHA**: `2b435eb3825c8391cac6ff48c1d46594dc85533e`  
**Tested Code Git SHA (TESTED_CODE_SHA)**: `91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`  
**Date**: October 5, 2026  
**Final Phase Verdict**: **PASS**  

---

## 1. Executive Summary & Audit Remediation Scope

Phase 6.1.2 is a strictly bounded evidence closure and documentation remediation phase addressing the independent audit feedback from Phase 6.1.1. No product features or trigger semantics were modified. No Phase 7 scope was initiated.

| Audit Defect / Remediation Area | Phase 6.1.1 Audit Finding | Phase 6.1.2 Remediated & Verified State | Status |
|---|---|---|---|
| **A. SQL Documentation Accuracy** | Report documented non-existent columns (`definition`, `translation`, `sentence`) and omitted production columns. | Corrected to exact `SqliteDictionary` statements using `definition_en`, `translation_zh`, `english`, `chinese`, `source`, `source_id`, `score`, `exchange`, `frequency`, with exact `ORDER BY` clauses. | **CORRECTED** |
| **B. Complexity Claim Calibration** | Overclaimed "guarantee O(log N) lookup performance on all queries". | Replaced with verified indexed `SEARCH` query plans vs linear full-scan `SCAN` regression prevention. Complete operational cost acknowledged to depend on row cardinality, temporary B-tree sorting, and storage state. | **CORRECTED** |
| **C. Authoritative Regression Matrix Runner** | No single committed script proving the full regression suite was executed against one exact tested SHA. | Implemented and executed `scripts/phase612-final-verify.mjs`, which orchestrates all 10 regression commands and captures machine-readable evidence into `docs/evidence/phase612-final-verification.json`. | **IMPLEMENTED & VERIFIED** |
| **D. Tested Code Identity** | Final verification must run against a clean committed code state. | Established clean `TESTED_CODE_SHA` (`91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`), executed all checks against it, and distinguished `TESTED_CODE_SHA`, `EVIDENCE_COMMIT_SHA`, and `FINAL_HEAD`. | **VERIFIED** |
| **E. Runtime Bundle Evidence Wording** | Described profile link verification as cryptographic hashes of "loaded bytes". | Wording updated in code and documentation to `profileResolvedHostBundleSha256`, `profileResolvedClientBundleSha256`, and `profileResolvedBundlesMatchRepository: true`. | **CORRECTED** |
| **F. AI Safety Claim Calibration** | Stated shallow static scan "mathematically proves impossibility" of runtime AI fallback. | Classification calibrated: static architecture scan confirmed 0 AI SDK dependencies and 0 model endpoints; runtime AI observation accurately marked `notMeasured`; product architectural invariant remains 0 intentional AI fallback. | **CORRECTED** |
| **G. Distribution & Package Audit** | Tracked tree and npm pack needed recursive inspection for corpus binaries/archives. | Executable automated scan verifies 0 tracked corpus artifacts (.csv, .db, .sqlite, archives) and 0 packed corpus artifacts. Package size ~81.1 kB. Full corpus redistribution remains REFUSED. | **VERIFIED** |
| **H. Production Isolation** | Isolation must strictly prevent production environment modification. | Isolation check PASS (`%TEMP%\dsh-word-lookup-test\home`, `word-lookup-test` profile, high ephemeral ports 50991+). Production port 19387 and default profile untouched. | **VERIFIED** |

---

## 2. Commit Identity & Head Tracking

- **Starting Commit SHA**: `2b435eb3825c8391cac6ff48c1d46594dc85533e`
- **Code & Test Fix Commit (`TESTED_CODE_SHA`)**: `91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`
  - *Contains*: `package.json`, `scripts/phase612-final-verify.mjs`, `scripts/test-corpus-runtime.mjs`.
  - *Tree state when executed*: 100% clean (`git status --porcelain` empty).
- **Evidence & Documentation Commit (`EVIDENCE_COMMIT_SHA`)**: *(Recorded upon commit of evidence docs)*
  - *Contains*: `docs/evidence/*`, `docs/PHASE611_REMEDIATION_REPORT.md`, `docs/PHASE612_FINAL_VERIFICATION_REPORT.md`.
- **Final Repository Head (`FINAL_HEAD`)**: Equals `EVIDENCE_COMMIT_SHA`. Only evidence and documentation artifacts differ from `TESTED_CODE_SHA`.

---

## 3. Cryptographic Artifact Binding & Determinism

### 3.1 Pinned ECDICT Source Artifact
- **Path**: `.cache/corpus/ecdict.csv`
- **Source Byte Size**: `65,933,428` bytes
- **Source SHA-256 Digest**: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`
- **Manifest Declared Size & SHA**: `65,933,428` bytes, `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf` (Exact match)
- **Manifest File**: `corpus/ecdict.manifest.json` (`566` bytes, SHA-256 `03cba27d42cb43551d7b51fa12e4a07a869c5d4b65ac07f4fa3d105d9c944044`, upstream commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`)
- **Observed CSV Header (13 columns)**: `[word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, detail, audio]`
- **BOM Inspection**: First 3 bytes are `77 6f 72` (`wor`); `bomActuallyPresent: false`; `bomStrippingRequired: false`
- **Fatal UTF-8 Decode Verification**: Complete stream decode via `TextDecoder('utf-8', { fatal: true })` completed with zero errors.

### 3.2 Production SQLite Database Artifact
- **Path**: `build/corpus/ecdict.db`
- **Physical Byte Size**: `85,889,024` bytes
- **Physical File SHA-256**: `8aee00720cf7e1f19df9a515e541c4463abc816c34e95155129396361b32d37d`
- **Logical Data SHA-256**: `591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9`
- **PRAGMA integrity_check**: `ok`
- **Table Counts**:
  - `entries`: 770,611
  - `forms`: 57,689 (463 ambiguous multi-headword collisions excluded)
  - `examples`: 0
- **POS Column Invariant**: In the pinned source artifact, the dedicated `pos` column was measured empty across all 770,611 rows; lexical POS-style prefixes in translation strings do not alter ECDICT's documented schema.

### 3.3 Two-Build Physical & Logical Determinism
Two independent clean builds were executed sequentially from source:
- `run1LogicalSha256`: `591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9`
- `run2LogicalSha256`: `591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9`
- `run1FileSha256`: `8aee00720cf7e1f19df9a515e541c4463abc816c34e95155129396361b32d37d`
- `run2FileSha256`: `8aee00720cf7e1f19df9a515e541c4463abc816c34e95155129396361b32d37d`
- `logicalDeterminismIdentical`: `true`
- `fileDeterminismIdentical`: `true`

---

## 4. Query Plan Verification & Schema Accuracy

### 4.1 Production Schema Contract
The production database schema matches `SqliteDictionary` and migration specifications exactly:
- `entries`: `(word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, definition_en TEXT, translation_zh TEXT, pos TEXT, exchange TEXT, frequency INTEGER)`
- `forms`: `(form TEXT PRIMARY KEY COLLATE NOCASE, headword TEXT NOT NULL, kind TEXT)`
- `examples`: `(id INTEGER PRIMARY KEY, headword TEXT NOT NULL COLLATE NOCASE, english TEXT NOT NULL, chinese TEXT, source TEXT, source_id TEXT, score REAL)`
- Indexes:
  - `sqlite_autoindex_entries_1` on `entries(word)` (implicit primary key index)
  - `sqlite_autoindex_forms_1` on `forms(form)` (implicit primary key index)
  - `idx_forms_headword_raw` on `forms(headword)` (explicit raw binary index for exact WHERE headword = ?)
  - `idx_examples_headword` on `examples(headword COLLATE NOCASE)`

### 4.2 Query Execution Plan Contracts
The verified lookup predicates use indexed `SEARCH` plans rather than full table/index `SCAN` plans for the production corpus. This prevents the known linear full-scan regression on the validated query paths:

```sql
-- 1. Exact entry lookup
SELECT word, phonetic, definition_en, translation_zh, pos, exchange, frequency FROM entries WHERE word = ?;
-- Execution Plan: SEARCH entries USING INDEX sqlite_autoindex_entries_1 (word=?)

-- 2. Morphological form lookup
SELECT headword FROM forms WHERE form = ?;
-- Execution Plan: SEARCH forms USING INDEX sqlite_autoindex_forms_1 (form=?)

-- 3. Forms by headword (binary match)
SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE;
-- Execution Plan: SEARCH forms USING INDEX idx_forms_headword_raw (headword=?); USE TEMP B-TREE FOR ORDER BY

-- 4. Examples by headword
SELECT english, chinese, source, source_id, score FROM examples WHERE headword = ? ORDER BY score DESC, id ASC;
-- Execution Plan: SEARCH examples USING INDEX idx_examples_headword (headword=?); USE TEMP B-TREE FOR ORDER BY
```

Any query plan containing `SCAN` is rejected with `Error: Query plan for "<name>" rejected: contains full table/index SCAN: "<detail>"`.

---

## 5. Production Dictionary Benchmark (Product Code Path)

Benchmark target: `SqliteDictionary.lookup()` via `openProductionDictionary()` across 6,000 queries (200 iterations per word category):
- **Database Open & Validation Duration**: `2.01 ms` (one-time startup latency for read-only open and schema/metadata verification)
- **Overall Steady-State Query Latency**:
  - **Min**: `25.5 µs`
  - **Median**: `49.7 µs`
  - **95th Percentile (p95)**: `81.0 µs`
  - **Max**: `3,650.1 µs`

### Category Latency Breakdown (Copied from Committed Benchmark JSON)

| Category | Sample Count | Min (µs) | Median (µs) | p95 (µs) | Max (µs) |
|---|---|---|---|---|---|
| `commonWord` | 1,000 | 44.6 | 53.7 | 84.5 | 2,373.4 |
| `rareWord` | 800 | 43.2 | 49.3 | 84.2 | 3,071.0 |
| `mixedCase` | 1,000 | 43.1 | 51.8 | 78.8 | 2,787.1 |
| `form` | 800 | 43.1 | 49.0 | 83.1 | 3,650.1 |
| `irregularForm` | 800 | 42.9 | 51.0 | 92.5 | 3,316.6 |
| `phrase` | 600 | 42.7 | 49.8 | 79.4 | 168.9 |
| `unknown` | 400 | 26.0 | 29.7 | 50.8 | 122.0 |
| `longUnknown` | 600 | 25.5 | 28.8 | 51.1 | 174.4 |

---

## 6. Full Regression Matrix Execution Evidence

All 10 regression commands were orchestrated by `scripts/phase612-final-verify.mjs` against `TESTED_CODE_SHA` (`91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`). Every command exited with code 0:

| # | Command | Exit Code | Status | Duration | Measured Totals |
|---|---|---|---|---|---|
| 1 | `npm test` | 0 | **PASS** | 5.3s | 27/27 test files passed, 468/468 tests passed, 0 failed, 0 skipped |
| 2 | `npm run verify` | 0 | **PASS** | 10.6s | 6/6 pipeline steps passed (`fixture`, `typecheck`, `test`, `build`, `bundle-static-checks`, `credential-scan`) |
| 3 | `npm run corpus:verify-source` | 0 | **PASS** | 0.7s | Source verified: 65,933,428 bytes, exact SHA-256 match, BOM false, fatal UTF-8 decode PASS, 13 columns |
| 4 | `npm run corpus:build` | 0 | **PASS** | 14.9s | 770,611 entries, 57,689 forms; Run 1 & Run 2 determinism identical byte-for-byte; integrity `ok` |
| 5 | `npm run corpus:verify` | 0 | **PASS** | 2.6s | Tripartite binding verified, 0 query plan SCAN violations, 11/11 runtime probes passed |
| 6 | `npm run corpus:benchmark` | 0 | **PASS** | 0.8s | Startup open: 2.01 ms; 6,000 queries median 49.7 µs, p95 81.0 µs |
| 7 | `npm run test:runtime` | 0 | **PASS** | 326.6s | 169/169 checks passed, 0 failed (`verify-out/phase1-verification.json`) |
| 8 | `npm run test:corpus-runtime` | 0 | **PASS** | 33.1s | 13/13 checks passed, 0 failed; profile binding verified; 0 fixture fallback; 4 negative gates verified |
| 9 | `npm run test:acceptance` | 0 | **PASS** | 22.2s | 37/37 browser acceptance checks passed, 0 failed (`docs/evidence/phase5-browser-acceptance-20261004.json`) |
| 10 | `npm pack --dry-run` | 0 | **PASS** | 0.8s | Package: `dsh-word-lookup@0.1.0-dev.0`, 30 files, 81.1 kB packed, 262.6 kB unpacked; 0 corpus artifacts |

---

## 7. Evidence Classification (Measured vs Statically Inspected vs Not Measured)

To ensure scientific accuracy and prevent overclaims, all verification dimensions are strictly classified:

### 7.1 Measured Invariants
- **Browser-Visible External Network Requests**: `0` requests observed. Intercepted via Playwright `page.on('request')` during all runtime probes and user interactions (36 same-origin localhost requests observed).
- **Runtime Dictionary Source**: Strictly `ecdict-local` for all valid probes (`wave function`, `conservation`, `neutrino`, `quarks`).
- **Fixture Fallback Absence**: `fixtureFallbackObserved: false`.
- **Negative Gate Activation**: Mismatched database path, corrupted file, wrong source hash, and wrong commit SHA all cleanly refuse activation (HTTP 404, route not registered, 0 fixture fallback).
- **Physical & Logical Determinism**: Measured byte-for-byte equality across dual independent builds.
- **Latencies**: Directly measured via high-resolution timers (`process.hrtime.bigint()`).

### 7.2 Statically Inspected Invariants
- **Profile Link & Bundle Resolution**:
  - `profileResolvedHostBundleSha256`: `4e82542be45483ef414934feae8c2682edf48acc6ebbf3d731908245f1b67c7e`
  - `profileResolvedClientBundleSha256`: `0f1d730f02232f0920b14f136018a55eb86f552e7f828eeafc3543a673318c41`
  - `profileResolvedBundlesMatchRepository`: `true`
  - Verified profile `word-lookup-test` manifest declares bundle registration and junction resolves to repository root.
- **AI Safety Static Scan**:
  - Static architecture scan found no configured AI SDK dependency or known model endpoint in the audited package/bundles (`matchedAiDependencies: []`, `foundModelEndpoints: []`).
  - Product architectural requirement: 0 intentional AI fallback.
- **Bundle Hygiene**: Checked via `scripts/check-bundle.mjs` (React externalized, no dynamic imports, no `node:sqlite` in browser bundle, exact service injections).

### 7.3 Not Measured Invariants
- **Host Process-Wide Network Activity**: Marked `notMeasured` (no kernel-level or OS packet capture instrumentation was introduced).
- **AI Runtime Observation**: Marked `notMeasured` (no model endpoint proxy or LLM runtime monitor was attached).

---

## 8. Distribution, Safety & Release Blockers

### 8.1 Distribution Safety Gate
- **Tracked Git Corpus Artifacts**: `0` found across 160 tracked files (recursively scanned for `.csv`, `.db`, `.sqlite`, `.sqlite3`, `.7z`, `.zip`, `.gz`, `.tgz`).
- **Packed npm Corpus Artifacts**: `0` found across 30 packed files in `npm pack --dry-run`.
- **Full Corpus Redistribution**: **REFUSED / NO**. The full ECDICT corpus binary is generated locally and never published or committed.
- **Distribution Gate Status**: PASS.

### 8.2 Production Environment Safety
- **Isolation Check**: PASS.
- **Scratch Home**: `%TEMP%\dsh-word-lookup-test\home`
- **Profile**: `word-lookup-test`
- **Ports Used**: Ephemeral non-production ports (50991+).
- **Production Port 19387**: Untouched.
- **Production Profiles & Cookies**: Untouched.

### 8.3 Release Blocker Status
- **Blocker Title**: `RELEASE BLOCKER — automatic-selection portability`
- **Current State**: **OPEN**.
- **Description**: Automatic text selection gesture portability across platforms and display servers remains tracked and unresolved.
- **Phase 7 Readiness**: **NOT READY**. Phase 7 will not begin until Phase 6.1.2 audit is formally closed.

---

## 9. Authoritative Evidence File Index

The machine-readable source of truth for Phase 6.1.2 verification is:
- `docs/evidence/phase612-final-verification.json`

Supporting evidence files updated and verified during this run:
- `docs/evidence/phase611-corpus-build.json`
- `docs/evidence/phase611-corpus-benchmark.json`
- `docs/evidence/phase611-corpus-runtime.json`
- `docs/evidence/phase611-source-verification.json`
- `docs/evidence/phase5-browser-acceptance-20261004.json`
- `verify-out/phase1-verification.json`

---

## 10. Conclusion & Final Verdict

All defect classes identified in the Phase 6.1.1 audit have been remediated, verified, and committed. All 10 commands of the complete regression matrix executed successfully against `TESTED_CODE_SHA` (`91f19ebd0b1b6ca874e1c94fe64b17bdcaeb8e83`).

**Phase 6.1.2 Verdict: PASS**
