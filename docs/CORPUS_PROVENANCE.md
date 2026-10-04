# Corpus Provenance: ECDICT Ingestion

**Document Version**: 1.0.0  
**Phase**: Phase 6 — Production Corpus Ingestion & Verification  
**Authoritative Status**: `REDISTRIBUTION REVIEW REQUIRED`  
**Legal Conclusion**: None (Technical & Source Provenance Audit Only)

---

## 1. Upstream Source Identity & Artifact Integrity

| Property | Value |
| --- | --- |
| **Upstream Repository** | [`https://github.com/skywind3000/ECDICT`](https://github.com/skywind3000/ECDICT) |
| **Author / Maintainer** | Linwei (`skywind3000`) |
| **Pinned Commit SHA** | `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` |
| **Source File Path** | `ecdict.csv` |
| **Source File Size** | 65,933,428 bytes (CRLF, 770,612 lines) |
| **Source File SHA-256** | `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf` |
| **License File Path** | `LICENSE` |
| **License File SHA-256** | `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f` |
| **License Type** | MIT License (Copyright (c) 2025 Linwei) |
| **Retrieval Date** | 2026-10-04T13:24:47Z |
| **Manifest Path** | [`corpus/ecdict.manifest.json`](../corpus/ecdict.manifest.json) |

---

## 2. Upstream License vs. Corpus Redistribution Reality

The upstream Git repository contains a standard MIT License file. However, in accordance with Phase 6 auditing requirements, **the presence of an upstream MIT repository license does not automatically equate to unconditional redistributability of the compiled corpus**.

As documented in the upstream project's README and commit history, the compiled dictionary dataset represents an aggregation developed over many years from disparate external resources, including:
1. `EDictAZ.txt` (~20,000 words initial seed);
2. Public CET-4/6 and GRE vocabulary lists;
3. Web-crawled phonetic transcriptions;
4. The historical Linux package `cdict-1.0-1.rpm` (which also served as the primary source for early mdict releases);
5. British National Corpus (BNC top 160,000 words) frequency proofreading and coverage reconciliation;
6. NodeBox and WordNet lexical toolkits for inflection generation;
7. Community pull requests and internet volunteer submissions.

Because these historical sub-sources carry varying terms, potential public domain designations, or mixed copyright histories that have not undergone individual legal clearance:
- **Redistribution Status**: `REDISTRIBUTION REVIEW REQUIRED`
- **Distribution Gate**: The complete third-party corpus (`ecdict.csv`, `stardict.7z`, or the derived production SQLite database `ecdict.db`) is **NOT** committed to the Git repository, **NOT** bundled into the npm package, and **NOT** published in public releases.
- **Local Ingestion Model**: Clean room reproducible build script downloads the pinned source artifact directly from upstream by exact SHA-256, validates it, and generates the SQLite database locally on the host machine.

---

## 3. Upstream Data Format & Field Definitions

The source artifact `ecdict.csv` is a UTF-8 CSV file containing exactly 1 header row and 770,611 data rows (770,612 lines total with CRLF line endings). Every data row contains exactly 13 fields:

| Field Index | Field Name | Description | Upstream Data Status | Product Mapping |
| --- | --- | --- | --- | --- |
| 0 | `word` | English word / headword | Non-null in 770,611 rows (100%) | Maps to `entries.word` (PRIMARY KEY COLLATE NOCASE) |
| 1 | `phonetic` | IPA phonetic transcription | Present in 218,065 rows (28.30%), null in 552,546 rows (71.70%) | Maps to `entries.phonetic` (`TEXT NULL`) |
| 2 | `definition` | English definitions (newline-separated) | Present in 160,884 rows (20.88%), null in 609,727 rows (79.12%) | Maps to `entries.definition_en` (`TEXT NULL`) |
| 3 | `translation` | Chinese translations (newline-separated) | Present in 768,739 rows (99.76%), null in 1,872 rows (0.24%) | Maps to `entries.translation_zh` (`TEXT NULL`) |
| 4 | `pos` | Part-of-speech statistics (e.g. `n:46/v:54`) | **Null in 770,611 rows (100%)** | Maps to `entries.pos` (`TEXT NULL`) |
| 5 | `collins` | Collins star rating (1-5) | Present in 13,633 rows | Stored in frequency / metadata or ignored |
| 6 | `oxford` | Oxford 3000 core marker | Present in 3,461 rows | Stored in frequency / metadata or ignored |
| 7 | `tag` | Syllabus tags (`zk`, `gk`, `cet4`, etc.) | Present in 14,942 rows | Stored in frequency / metadata or ignored |
| 8 | `bnc` | British National Corpus frequency rank | Present in 770,611 rows (integer, 0 if unranked) | Maps to `entries.frequency` |
| 9 | `frq` | COCA contemporary frequency rank | Present in 770,611 rows (integer, 0 if unranked) | Available as auxiliary frequency |
| 10 | `exchange` | Morphological inflection relations | Present in 96,290 rows (12.50%) | Normalized and expanded into `forms` table |
| 11 | `detail` | Extended JSON info (examples) | Present in 1 row (99.999% null) | Upstream examples not available; `examples` table empty |
| 12 | `audio` | Audio pronunciation URL | **Null in 770,611 rows (100%)** | Ignored (Phase 6 strictly offline, zero network) |

---

## 4. Morphological Exchange Specifications & Mapping Direction

The `exchange` field encodes morphological relationships between words. The ingestion engine deterministically parses the following tags:

| Tag | Grammatical Relationship | Direction in Ingestion |
| --- | --- | --- |
| `p` | Past tense (did) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 'p'` |
| `d` | Past participle (done) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 'd'` |
| `i` | Present participle / gerund (doing) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 'i'` |
| `3` | Third-person singular present (does) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: '3'` |
| `r` | Comparative adjective / adverb (-er) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 'r'` |
| `t` | Superlative adjective / adverb (-est) | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 't'` |
| `s` | Plural noun | Canonical entry $\rightarrow$ Inflected form. Inverted to: `form` $\rightarrow$ `headword`, `kind: 's'` |
| `0` | Lemma (base headword) | In an inflected row, points to base lemma: `form` $\rightarrow$ `headword` |
| `1` | Inflection type of lemma | Accompanies tag `0` specifying the inflection kind |

### Collision & Disambiguation Rules:
1. **Direction**: All rows in the product `forms` table strictly represent `observed form` $\rightarrow$ `canonical entry`.
2. **Exact Canonical Precedence**: In the lookup engine, `entries.word` is checked before `forms.form`. If a query matches an exact entry in `entries`, the canonical entry unconditionally takes precedence.
3. **Self-referential Mappings Filtered**: Mappings where `form.toLowerCase() === headword.toLowerCase()` (e.g. self-referencing participle tags on already-inflected words) are excluded.
4. **Ambiguous Forms (Multi-Headword) Policy**: If an inflected form points to multiple distinct canonical headwords (e.g. `analyses` pointing to both `analysis` and `analyse`, or `aches` pointing to `ACH` and `ache`), inserting an arbitrary headword would be non-deterministic. Conservative policy: **ambiguous forms are omitted from `forms`**, and fully logged to `docs/evidence/phase6-form-collisions.json`.

---

## 5. Summary Technical Conclusion

- Upstream pinned commit: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- SHA-256 digest: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`
- Source data verified clean, uncorrupted, and deterministic.
- Redistribution authorization status: **REDISTRIBUTION REVIEW REQUIRED (NO REDISTRIBUTION)**.
