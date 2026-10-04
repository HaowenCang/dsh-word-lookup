# Phase 6 Evidence: Production Corpus Ingestion & Pipeline Verification

**Phase Status**: `PASS — PHASE 6 PRODUCTION CORPUS PIPELINE COMPLETE`  
**Tested Git SHA**: `9589db72fb88188613ed88dfba002f58e7874260`  
**Distribution Gate**: Full corpus redistribution authorized: **NO**  
**Production DSH Modification**: Production DSH environment modified: **NO**  
**Automatic Selection Portability**: `RELEASE BLOCKER — automatic-selection portability` remains **OPEN**

---

## 1. Executive Summary

Phase 6 delivers a clean-room, deterministic, streaming ingestion pipeline that compiles the full production-scale English-to-Chinese dictionary database (`ECDICT`) into a high-performance local SQLite database (`build/corpus/ecdict.db`).

Key achievements:
- **Zero Full Corpus Git Bloat**: Third-party database artifacts (`ecdict.csv`, `ecdict.db`) are strictly `.gitignore`'d; only ingestion code, schemas, manifests, and machine-readable evidence are tracked.
- **Reproducible & Deterministic Build**:
  - Logical Database Digest: `591e53bdd8e3d227fd92c21ce2cfe7d375fffcd90f97a9f6a64f7d26e7c78bd9`
  - Database File SHA-256: `192d82ba51e9a475186f1f5afb9e40ed4f1c012faff18e9a42cb50786d9db8fd`
  - Database Size: `86,827,008` bytes (~82.8 MB)
  - Integrity Check: `PRAGMA integrity_check = ok`
- **Streaming RFC 4180 Ingestion**: Zero full-file in-memory buffering; peak RSS ~802 MB; build throughput ~125,588 rows/sec (~6.1s total build duration).
- **Sub-Millisecond Query Latency**: Process-level read-only benchmark across 6,000 queries yielded an overall median latency of **22.9 µs** and p95 of **32.4 µs**.
- **Preserved Lookup Semantics**: Zero changes to existing client UI, zero runtime network calls, zero AI fallbacks, zero client-side SQLite.
- **Strict Provenance Gate**: Documented in `docs/CORPUS_PROVENANCE.md` and `docs/PHASE6_PACKAGING_DECISION.md`; full corpus redistribution status remains `REDISTRIBUTION REVIEW REQUIRED`.

---

## 2. Upstream Corpus Provenance & Source Integrity

| Parameter | Authoritative Value |
| --- | --- |
| **Upstream Repository** | [`https://github.com/skywind3000/ECDICT`](https://github.com/skywind3000/ECDICT) |
| **Pinned Commit SHA** | `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` |
| **Source File Path** | `ecdict.csv` |
| **Source File Size** | 65,933,428 bytes (770,612 CRLF lines) |
| **Source SHA-256** | `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf` |
| **License File Path** | `LICENSE` |
| **License SHA-256** | `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f` |
| **License Text** | MIT License (Copyright (c) 2025 Linwei) |
| **Retrieval Date** | 2026-10-04T13:24:47Z |
| **Manifest Path** | [`corpus/ecdict.manifest.json`](../corpus/ecdict.manifest.json) |
| **Redistribution Status** | `REDISTRIBUTION REVIEW REQUIRED` |

---

## 3. Data Quality & Ingestion Statistics

From [`docs/evidence/phase6-corpus-quality.json`](../docs/evidence/phase6-corpus-quality.json):

| Metric | Count | Ratio / Notes |
| --- | --- | --- |
| **Source Total CSV Rows** | 770,612 | 1 header row + 770,611 data rows |
| **Valid Imported Entries** | 770,611 | 100% of upstream rows parsed and imported |
| **Rejected Rows** | 0 | 0 malformed rows, 0 empty headwords |
| **Duplicate Headwords** | 0 | 0 duplicate entries (case-insensitive) |
| **Unique Canonical Words** | 770,611 | Clean primary key index |
| **Null Phonetics** | 552,546 | 71.70% upstream null |
| **Null Definitions** | 609,727 | 79.12% upstream null (has Chinese translation) |
| **Null Translations** | 1,872 | 0.24% upstream null (has English definition) |
| **Both Def & Trans Null** | 0 | 100% of entries carry meaning |
| **Null Dedicated POS Field** | 770,611 | 100% null in CSV; POS tags embedded in translations |
| **Rows with Exchange String** | 96,290 | 12.50% of entries |
| **Invalid UTF-8 Sequences** | 0 | 0 encoding errors detected |

---

## 4. Morphological Exchange & Collision Policy Audit

From [`docs/evidence/phase6-form-collisions.json`](../docs/evidence/phase6-form-collisions.json):

| Morphological Metric | Count |
| --- | --- |
| **Total Exchange Relationships Parsed** | 137,766 |
| **Unique Non-Self Surface Forms** | 58,152 |
| **Unambiguous Forms Imported to `forms`** | 57,689 |
| **Ambiguous Forms Excluded** | 463 |
| **Self-Referential Inflections Excluded** | 11,909 |

### Collision & Disambiguation Policy:
1. **Direction**: Every row in the product `forms` table strictly represents `observed surface form` $\rightarrow$ `canonical headword`.
2. **Exact Canonical Precedence**: In the query engine, `entries.word` is queried first. If an exact match exists, it returns immediately with `matchedForm: null`.
3. **Ambiguous Forms Policy**: When a single inflected form maps to multiple distinct canonical headwords (e.g. `analyses` pointing to both `analysis` and `analyse`, or `aches` pointing to `ACH` and `ache`), arbitrary or non-deterministic selection is prohibited. All 463 ambiguous forms are excluded from `forms` and recorded in machine-readable evidence.

---

## 5. Query Latency Benchmark

From [`docs/evidence/phase6-corpus-benchmark.json`](../docs/evidence/phase6-corpus-benchmark.json):
- **Database Open Duration**: 0.63 ms
- **First Query Latency (Cold-ish)**: 144.2 µs
- **Total Queries Executed**: 6,000 (200 iterations per word)

| Query Category | Samples | Min (µs) | Median (µs) | p95 (µs) | Max (µs) |
| --- | --- | --- | --- | --- | --- |
| **Common Word** (`go`, `wave`, `function`, `time`, `world`) | 1,000 | 21.5 | 26.0 | 39.6 | 595.0 |
| **Rare Word** (`syzygy`, `oxymoron`, `quokka`, `zygote`) | 800 | 20.0 | 22.2 | 29.5 | 151.8 |
| **Mixed-Case Word** (`Go`, `WavE`, `FunCTIon`, `WaVe FuNcTiOn`) | 1,000 | 20.2 | 24.0 | 31.7 | 184.9 |
| **Form** (`functions`, `waves`, `derives`, `apples`) | 800 | 20.3 | 22.4 | 29.3 | 155.7 |
| **Irregular Form** (`went`, `teeth`, `gone`, `feet`) | 800 | 20.3 | 23.1 | 30.3 | 209.2 |
| **Phrase** (`wave function`, `point of view`, `ice cream`) | 600 | 20.2 | 22.1 | 31.4 | 185.5 |
| **Unknown Word** (`unknownprobe123xyz`, `nonexistenttermabc`) | 400 | 18.4 | 20.2 | 27.4 | 90.0 |
| **Long Unknown Word** (64-100+ chars) | 600 | 18.2 | 20.1 | 26.4 | 320.2 |
| **OVERALL SUMMARY** | **6,000** | **18.2** | **22.9** | **32.4** | **595.0** |

---

## 6. Query Execution Plans (Index Verification)

Verified via `scripts/verify-production-db.mjs`:

| Query Path | SQL Statement | Index Used |
| --- | --- | --- |
| **Exact Entry** | `SELECT ... FROM entries WHERE word = ?` | `SEARCH entries USING INDEX sqlite_autoindex_entries_1 (word=?)` |
| **Form by Surface** | `SELECT headword FROM forms WHERE form = ?` | `SEARCH forms USING INDEX sqlite_autoindex_forms_1 (form=?)` |
| **Forms by Headword** | `SELECT form, kind FROM forms WHERE headword = ? ORDER BY form COLLATE NOCASE` | `SEARCH forms USING INDEX idx_forms_headword_raw (headword=?)` |
| **Examples by Headword** | `SELECT ... FROM examples WHERE headword = ? ORDER BY score DESC, id ASC` | `SEARCH examples USING INDEX idx_examples_headword (headword=?)` |

Zero unindexed table scans on lookup paths.

---

## 7. Required Corpus Probes

All required probes verified against production corpus (`build/corpus/ecdict.db`):

| Probe String | Found | Headword | Phonetic | Matched Form | Resolution Note |
| --- | --- | --- | --- | --- | --- |
| `go` | Yes | `go` | `gou` | `null` | Exact canonical entry |
| `went` | Yes | `went` | `went` | `null` | Exact entry in ECDICT (with WordNet defs & `go的过去式`) |
| `gone` | Yes | `gone` | `gɒn` | `null` | Exact entry in ECDICT (with WordNet defs & `go的过去分词`) |
| `tooth` | Yes | `tooth` | `tu:θ` | `null` | Exact canonical entry |
| `teeth` | Yes | `teeth` | `ti:θ` | `null` | Exact entry in ECDICT (`pl. 牙齿`) |
| `derive` | Yes | `derive` | `di'raiv` | `null` | Exact canonical entry |
| `derived` | Yes | `derived` | `null` | `null` | Exact entry in ECDICT (`a. 导出的；衍生的`) |
| `conservation` | Yes | `conservation` | `.kɒnsә'veiʃәn` | `null` | Exact canonical entry |
| `wave` | Yes | `wave` | `weiv` | `null` | Exact canonical entry |
| `function` | Yes | `function` | `'fʌŋkʃәn` | `null` | Exact canonical entry |
| `wave function` | Yes | `wave function` | `null` | `null` | Exact phrase entry in ECDICT (`[计] 波函数`) |
| `Wave Function` | Yes | `wave function` | `null` | `null` | Case-insensitive phrase lookup |
| `nonexistentprobe123` | No | - | - | - | Correctly reports `found: false` |

---

## 8. Regression Suite & Packaging Verification

| Suite | Status | Metrics | Notes |
| --- | --- | --- | --- |
| **Static Verification** (`npm run verify`) | **PASS** | 5 sub-suites | Fixture, Typecheck, Unit, Build, Bundle-checks all green |
| **Full Unit Tests** (`npm test`) | **PASS** | 25 files, 440 tests | +10 csv-parser, +4 exchange-parser, +8 corpus-production |
| **Runtime Integration** (`npm run test:runtime`) | **PASS** | 169/169 checks | Isolated DSH profile, 0 production mutation |
| **Browser Acceptance** (`npm run test:acceptance`) | **PASS** | 37/37 checks | Chromium headless, 5 UI states, accessibility, theming |
| **Corpus Source Verification** (`npm run corpus:verify-source`) | **PASS** | 1/1 check | Source SHA-256 match |
| **Corpus DB Verification** (`npm run corpus:verify`) | **PASS** | 12/12 checks | Integrity, meta, logical digest, query plans, probes |
| **Corpus Latency Benchmark** (`npm run corpus:benchmark`) | **PASS** | 6,000 queries | Median 22.9 µs, p95 32.4 µs |
| **Credential Scan** (`npm run scan:credentials`) | **PASS** | 359 files | 0 usable credentials or tokens found |

---

## 9. Distribution & Release Blocker Status

1. **Third-Party Data Redistribution**:
   ```text
   Full corpus redistribution/publication authorized: NO
   ```
   In accordance with the findings in `docs/CORPUS_PROVENANCE.md` and `docs/PHASE6_PACKAGING_DECISION.md`, the production database is generated strictly on the host via clean-room pipeline and is **NOT** committed to Git, bundled into the npm package, or published to external registries.
2. **Release Blocker**:
   ```text
   RELEASE BLOCKER — automatic-selection portability
   ```
   Remains **OPEN** and untouched in Phase 6 as specified.
3. **Production Environment Safety**:
   ```text
   Production DSH environment modified during this work: NO
   ```
