# Phase 6 Packaging & Distribution Strategy Decision

**Document Version**: 1.0.0  
**Status**: DESIGN APPROVED (PUBLISHING DEFERRED)  
**Distribution Gate**: Full corpus redistribution authorized: **NO**

---

## 1. Context & Motivation

`dsh-word-lookup` package currently specifies `"private": true`, with published `files` restricted to:
- `lib/` (compiled host and browser bundles)
- `cordis.patch.yml`
- `README.md`

The production ECDICT database (`build/corpus/ecdict.db`) is **86,827,008 bytes (~82.8 MB)** uncompressed, or approximately **35 MB** as a gzip-compressed archive. Phase 6 requires designing the deployment and packaging architecture without premature publishing.

---

## 2. Evaluation of Packaging Architectural Options

| Dimension | Option A: DB Bundled inside npm Package | Option B: Separate Downloadable Artifact (GitHub Release) | Option C: Host Clean-Room Ingestion / First-Run Build |
| --- | --- | --- | --- |
| **Artifact Size** | ~35-40 MB `.tgz` (bloats npm package 1,000× from ~40 KB) | Core package stays tiny (~40 KB). DB artifact is standalone (~35 MB gzip) | Core package stays tiny (~40 KB). Ingestion source fetched directly by builder |
| **Offline Capability** | 100% offline immediately upon `npm i` | Offline once downloaded and placed in cache/profile directory | Offline once source CSV is present in `.cache/corpus/` |
| **npm Limits & Practicality** | Nearing npm 50MB recommended limit. Heavy CI and install latency. | Excellent. Adheres to npm best practices for JavaScript plugins. | Excellent. Zero npm bloat. |
| **Update Decoupling** | Terrible. Every 1-line client UI patch re-downloads 40 MB database. | Clean. UI/logic updates occur independently of static dictionary corpus. | Clean. Ingestion logic can be updated independently of corpus data. |
| **License & Provenance** | **BLOCKED**: Forces redistribution of 770k third-party records under npm. | **BLOCKED** until formal third-party copyright review closes. | **FAVORED**: The project distributes zero dictionary data; host builds locally. |
| **User Privacy** | High (zero network I/O after install) | High (download from user-chosen or verified release asset) | Controlled (explicit admin command `npm run corpus:fetch` or offline copy) |

---

## 3. Comparative Analysis

### Option A: Direct npm Bundling (REJECTED)
- **Technical Drawbacks**: A ~40 MB package tarball slows down DSH plugin installation, fills user disk with duplicate copies across profile installations, and violates DSH plugin lightweight principles.
- **Redistribution Barrier**: Even if upstream carries an MIT LICENSE, the compiled data incorporates historical sources with unverified provenance. Publishing the full SQLite database directly to the npm registry would create an irreversible public redistribution.
- **Verdict**: **Strictly Rejected**.

### Option B: Separate Downloadable Release Asset (RECOMMENDED FOR FUTURE RELEASE)
- **Technical Advantages**: The npm package remains ~40 KB. The host runtime checks for `build/corpus/ecdict.db` (or `DSH_WORD_LOOKUP_DB_PATH`). Users or deployment tools download the pre-built, SHA-256 verified SQLite artifact once.
- **Redistribution Dependency**: Can only be deployed after legal/redistribution review permits public hosting of compiled ECDICT artifacts.

### Option C: Host-Side Deterministic Clean-Room Ingestion (ADOPTED FOR PHASE 6)
- **Technical Advantages**: Fully implemented and validated in Phase 6. The deterministic builder (`npm run corpus:build`) compiles the pinned upstream source (`ecdict.csv`, SHA-256 `1a6947e...`) in ~6 seconds on the host machine.
- **Redistribution Compliance**: Bypasses the third-party redistribution blocker entirely because no dictionary data is ever hosted or redistributed by this repository.

---

## 4. Architectural Decision & Phased Roadmap

1. **Current Phase 6 Foundation**:
   - Package remains `"private": true`.
   - Core npm files remain restricted to `lib/`, `cordis.patch.yml`, and `README.md`.
   - Production database is generated locally via `npm run corpus:build` into `build/corpus/ecdict.db` (gitignored).
   - Standard unit and acceptance tests remain 100% offline using the deterministic fixture.
2. **Phase 7+ Release Plan**:
   - Adopt **Decoupled Architecture (Option B + C)**:
     - Core plugin ships with minimal offline fixture.
     - Production corpus is activated by placing `ecdict.db` at `<package>/build/corpus/ecdict.db` or specifying `DSH_WORD_LOOKUP_DB_PATH`.
     - Automated CLI command `npm run corpus:build` builds the database locally on demand.
   - If redistribution clearance is formally granted in the future, provide pre-compiled compressed database assets under GitHub Releases with cryptographic SHA-256 verification.

---

## 5. Decision Summary

- Bundling full SQLite DB into npm: **NO**
- Publishing full SQLite DB to npm/GitHub in Phase 6: **NO**
- Clean-room reproducible builder pipeline: **ACCEPTED & OPERATIONAL**
