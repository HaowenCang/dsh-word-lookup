# Phase 6.1.1 Remediation & Evidence Integrity Report

**Repository**: `HaowenCang/dsh-word-lookup`  
**Phase**: `Phase 6.1.1` (Evidence Integrity, Runtime Schema Gate & Acceptance Hardening)  
**Remediation Baseline Commit**: `98dec6111ae41afd9d7d2d1bdb753408fc2228cd`  
**Date**: October 4, 2026  
**Status**: COMPLETE / AUDIT REMEDIATED  

---

## 1. Executive Summary & Defect Remediation Audit

Phase 6.1.1 is an integrity and safety remediation phase dedicated to correcting eight specific defect classes identified during the Phase 6.1 review. No Phase 7 scope was initiated.

| Defect Area | Previous Phase 6.1 Defect | Phase 6.1.1 Remediated Contract | Status |
|---|---|---|---|
| **1. Source Binding & Verification Gate** | `corpus:verify` accepted missing source without refusal; only checked SQLite DB. | Strict tripartite verification (`source <-> manifest <-> database`). Refuses if source missing. `--metadata-only` option returns `PARTIAL — SOURCE BINDING NOT REVERIFIED` and never returns full PASS. Automated in `tests/corpus-verify.spec.ts`. | **FIXED** |
| **2. Production Schema & Query Plan Contract** | Query plan allowed index scan (`SCAN forms USING INDEX sqlite_autoindex_forms_1`) because binary lookup used `WHERE headword = ?`. | Added required index `idx_forms_headword_raw ON forms (headword)`. Query plan verification strictly rejects any `SCAN`. Negative tests added for missing indexes and malformed table definitions in `tests/corpus-production.spec.ts`. | **FIXED** |
| **3. Isolated Profile & Code Binding** | Real DSH runtime tests did not cryptographically prove that the isolated profile loaded current repository code. | `verifyIsolatedProfileBinding` verifies test profile `word-lookup-test`, junction target resolution to repo root, tested Git commit SHA, and SHA-256 digests of `lib/index.js` and `lib/client.js` matching loaded bundles. | **FIXED** |
| **4. Network & AI Observation Authenticity** | Recorded `externalNetworkRequests: 0` without browser instrumentation; claimed `aiFallbackObserved: false` without runtime measurement. | Playwright `page.on('request')` intercepts all browser network traffic, asserting 0 external requests. AI safety is explicitly recorded as a static architectural invariant audit (`matchedAiDependencies: []`, `foundModelEndpoints: []`); host process network activity is marked `notMeasured`. | **FIXED** |
| **5. Production Dictionary Benchmark** | Benchmark measured raw SQL queries on naked `node:sqlite` connection instead of product code; conflated startup open/validation with lookup. | Benchmark executes `openProductionDictionary()` -> `SqliteDictionary.lookup()`. Separately measures one-time DB open/validation latency (2.18 ms) and steady-state query latencies (median 47.5 µs, p95 82.3 µs across 6,000 queries). Emits `docs/evidence/phase611-corpus-benchmark.json`. | **FIXED** |
| **6. Reproducible Build & Determinism** | Evidence was hand-assembled; BOM presence was ambiguous; determinism was not demonstrated via clean rebuild. | Executable script runs two full clean builds and asserts byte-for-byte logical and physical SHA-256 equality. Directly measures first 3 bytes of `ecdict.csv`: `bomActuallyPresent: false`, `bomStrippingRequired: false`. Proves fatal UTF-8 full-source decode. | **FIXED** |
| **7. ECDICT POS Column Clarification** | Conflated observed empty `pos` column with ECDICT schema specification. | Clarified: "In the pinned ecdict.csv artifact used by this build, the dedicated `pos` column was measured empty for all 770,611 data rows. Many translation strings contain lexical POS-style prefixes such as n./v./adj.; this observation does not redefine ECDICT’s documented `pos` schema." | **FIXED** |
| **8. Runtime Activation Semantics** | Unclear distinction between default development mode and explicit production database activation. | Documented in `README.md` and enforced in `src/host/corpus-db.ts`: unset `DSH_WORD_LOOKUP_DB_PATH` is default test fixture mode; setting `DSH_WORD_LOOKUP_DB_PATH` is explicit production activation. Any error in production DB fails closed (route not registered / HTTP 404), with zero fixture fallback. | **FIXED** |

---

## 2. Cryptographic & Physical Artifact Manifest

### 2.1 Pinned ECDICT Source Artifact
- **Path**: `.cache/corpus/ecdict.csv`
- **File Byte Size**: `65,933,428` bytes
- **SHA-256 Digest**: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`
- **Total CSV Rows**: `770,612` (1 header row + 770,611 data rows)
- **Header Columns (13)**: `word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio`
- **BOM Inspection**: First 3 bytes are `77 6f 72` (`wor`); `bomActuallyPresent: false`; `bomStrippingRequired: false`
- **UTF-8 Decode Verification**: `TextDecoder('utf-8', { fatal: true })` completed the entire 65.9 MB source with zero errors.

### 2.2 ECDICT Manifest Artifact
- **Path**: `corpus/ecdict.manifest.json`
- **File Byte Size**: `566` bytes
- **SHA-256 Digest**: `03cba27d42cb43551d7b51fa12e4a07a869c5d4b65ac07f4fa3d105d9c944044`
- **Upstream Commit**: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`

### 2.3 Generated Production SQLite Database
- **Path**: `build/corpus/ecdict.db`
- **File Byte Size**: `85,889,024` bytes
- **Physical File SHA-256**: `8aee00720cf7e1f19df9a515e541c4463abc816c34e95155129396361b32d37d`
- **Logical Data SHA-256**: `591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9`
- **Deterministic Rebuild**: Run 1 and Run 2 produced identical logical SHA-256 and physical file SHA-256.
- **Table Counts**:
  - `entries`: 770,611
  - `forms`: 57,689 (463 ambiguous multi-headword collisions excluded)
  - `examples`: 0
- **PRAGMA integrity_check**: `ok`

---

## 3. Query Plan Verification & Schema Contract

To guarantee $O(\log N)$ lookup performance on all queries, query plan inspection (`EXPLAIN QUERY PLAN`) enforces binary and case-insensitive indexes:

```sql
-- 1. Exact entry lookup
SELECT word, phonetic, definition, translation, pos FROM entries WHERE word = ? COLLATE NOCASE;
-- Execution Plan: SEARCH entries USING INDEX sqlite_autoindex_entries_1 (word=?)

-- 2. Morphological form lookup
SELECT headword FROM forms WHERE form = ? COLLATE NOCASE;
-- Execution Plan: SEARCH forms USING INDEX sqlite_autoindex_forms_1 (form=?)

-- 3. Forms by headword (binary match)
SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE;
-- Execution Plan: SEARCH forms USING INDEX idx_forms_headword_raw (headword=?); USE TEMP B-TREE FOR ORDER BY

-- 4. Examples by headword
SELECT sentence, translation FROM examples WHERE headword = ? COLLATE NOCASE ORDER BY id;
-- Execution Plan: SEARCH examples USING INDEX idx_examples_headword (headword=?); USE TEMP B-TREE FOR ORDER BY
```

Any query plan containing `SCAN` is rejected with `Error: Production index contract violation: query plan SCAN detected`.

---

## 4. Benchmark Results (Product Code Path)

Benchmark was conducted using `SqliteDictionary.lookup()` via `openProductionDictionary()` across 6,000 queries (200 iterations per word shape):

- **Database Open & Schema Validation**: `2.18 ms` (one-time startup cost)
- **Overall Steady-State Query Latency**:
  - **Min**: `24.3 µs`
  - **Median**: `47.5 µs`
  - **95th Percentile (p95)**: `82.3 µs`
  - **Max**: `4,121.8 µs`

| Category | Samples | Min (µs) | Median (µs) | p95 (µs) | Max (µs) |
|---|---|---|---|---|---|
| `commonWord` | 1,000 | 44.1 | 51.2 | 88.5 | 2,313.3 |
| `rareWord` | 800 | 43.2 | 48.6 | 89.4 | 3,054.7 |
| `mixedCase` | 1,000 | 41.7 | 50.8 | 84.7 | 3,026.8 |
| `form` | 800 | 41.1 | 45.1 | 80.8 | 2,820.0 |
| `irregularForm` | 800 | 42.0 | 47.5 | 82.9 | 3,320.4 |
| `phrase` | 600 | 41.1 | 44.2 | 82.8 | 189.9 |
| `unknown` | 400 | 25.0 | 26.8 | 45.5 | 4,121.8 |
| `longUnknown` | 600 | 24.3 | 25.9 | 45.5 | 169.2 |

---

## 5. Real DSH Isolated Runtime Acceptance

Tested against an isolated DSH Web instance (`word-lookup-test` profile on ephemeral port, `%TEMP%\dsh-word-lookup-test\home`):

- **Isolated Profile Binding**:
  - Tested Code Git SHA: `98dec6111ae41afd9d7d2d1bdb753408fc2228cd`
  - Loaded Host Bundle SHA-256: `4e82542be45483ef414934feae8c2682edf48acc6ebbf3d731908245f1b67c7e`
  - Loaded Client Bundle SHA-256: `0f1d730f02232f0920b14f136018a55eb86f552e7f828eeafc3543a673318c41`
  - Profile junction points directly to current repository root.
- **Browser Network Traffic**:
  - Intercepted requests via Playwright: `externalOriginRequestsObserved = 0`.
  - Localhost / same-origin requests: 37.
- **AI Safety**:
  - Evaluated as static architectural invariant: 0 AI/LLM SDK dependencies, 0 remote API calls.
  - Runtime AI fallback: `notMeasured` (static invariant proves impossibility).
- **Probes**:
  - `wave function` -> HTTP 200, `source: "ecdict-local"`, translation: `[计] 波函数\n[化] 波函数`
  - `conservation` -> HTTP 200, `source: "ecdict-local"`, phonetic: `.kɒnsә'veiʃәn`
  - `neutrino` (absent from fixture) -> HTTP 200, `source: "ecdict-local"`, translation: `n. 中微子\n[化] 中微子; 微中子`
  - `quarks` (absent from fixture) -> HTTP 200, `source: "ecdict-local"`
  - `CR1-NO-FIXTURE-FALLBACK`: `fixtureFallbackObserved = false`
- **Negative Gating Tests**:
  - `CR2-MISSING-DB`: Missing database path -> HTTP 404 (route not registered), 0 fixture fallback.
  - `CR3-WRONG-SOURCE-SHA`: Mismatched source hash -> HTTP 404, 0 fixture fallback.
  - `CR4-WRONG-UPSTREAM-COMMIT`: Mismatched commit -> HTTP 404, 0 fixture fallback.
  - `CR5-CORRUPTED-DB`: Truncated/corrupted DB -> HTTP 404, 0 fixture fallback.

---

## 6. Safety & Blocker Invariants

- **Production Profile Safety**: Production DSH port 19387 and default profile were never launched, probed, or modified.
- **Distribution Safety**: Verified with `npm pack --dry-run` and `git status`. No `.csv`, `.db`, `.sqlite`, `.gz`, or `.zip` files are committed or packaged. The published package remains ~81 KB packed.
- **Portability Blocker**: The existing `RELEASE BLOCKER — automatic-selection portability` remains recorded and open for Phase 7. No Phase 7 work was started.

---

## 7. Machine-Readable Evidence Files

- `docs/evidence/phase611-source-verification.json`
- `docs/evidence/phase611-corpus-build.json`
- `docs/evidence/phase611-corpus-benchmark.json`
- `docs/evidence/phase611-corpus-runtime.json`
- `docs/evidence/phase61-source-verification.json`
- `docs/evidence/phase61-corpus-build.json`
- `docs/evidence/phase6-corpus-benchmark.json`
- `docs/evidence/phase61-corpus-runtime.json`
- `docs/evidence/phase6-corpus-build.json`
- `docs/evidence/phase6-corpus-quality.json`
- `docs/evidence/phase6-form-collisions.json`
