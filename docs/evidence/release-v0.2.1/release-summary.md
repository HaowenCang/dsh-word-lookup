# Release v0.2.1 Execution Summary & Acceptance Closure Report

- **Package**: `dsh-word-lookup@0.2.1`
- **Release Version**: `0.2.1`
- **Release Type**: Maintenance Patch Release
- **Target Platform**: DeepSeek Harness (DSH) `0.2.0-rc.2` (Web Profile) & Targeted `0.2.1-rc.2`
- **Release Engineer**: Gemini 3.8 Flash High
- **Release Authorization**: `AUTHORIZED FOR PUBLICATION` (Verified Project Owner Authorization)
- **Final Verdict**: **`PASS — v0.2.1 RELEASED`**

---

## 1. Executive Summary

`dsh-word-lookup@0.2.1` has been formally built, verified, frozen, published to the official npm Registry, tagged with an annotated Git tag, published to GitHub Releases with release assets, and verified via post-publication clean-room installation smoke tests from the live npm Registry.

All tripartite release entities (local frozen candidate package, npm Registry distribution tarball, and GitHub Release asset tarball) have been proven bit-for-bit identical via SHA-256 cryptographic verification.

---

## 2. Release Provenance & Invariant Standards

| Property | Authoritative Baseline / Recorded Value | Verification Status |
| :--- | :--- | :--- |
| **Initial `master` Baseline HEAD** | `366d6c8e8a8d40d6f5b421e35eec3a9f15c9c5a4` | **MATCH** |
| **Release Source Freeze Commit** | `79c4e16a323df48391dab0dd3799f22f99a6b771` | **FROZEN & PUSHED** |
| **Target Git Tag** | `v0.2.1` (Annotated Tag) | **CREATED & PUSHED** |
| **Tag Object SHA** | `96986896f7749b663e2949645e686f03429e67fc` | **VERIFIED** |
| **Tag Peeled Commit SHA** | `79c4e16a323df48391dab0dd3799f22f99a6b771` | **MATCH (`RELEASE_SOURCE_SHA`)** |
| **Historical v0.2.0 Tag** | `5c863335afdc4b71ee18f41340d852f378a2bee2` | **UNTOUCHED** |
| **Historical v0.1.0 Tag** | Preserved | **UNTOUCHED** |

---

## 3. Candidate Package Artifact Hashes & Member Manifest

Candidate Tarball: `build/rc-v0.2.1/dsh-word-lookup-0.2.1.tgz`

| Algorithm / Field | Value |
| :--- | :--- |
| **File Byte Size** | `139760` bytes |
| **SHA-256** | `597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758` |
| **Legacy npm shasum (SHA-1)** | `3a8c0a196ff7d7fd95cc79a1bea7d0ea8a3eeae4` |
| **Subresource Integrity (SHA-512 SRI)** | `sha512-oX3g8czFp8QczjCspl/RfL3fP/V4ZPLC4Vt8Oy0I7V+GQL9vgOyBVmA0W6J6anv9eKS4ObiZveRX8x7bBdxaBg==` |

### Tarball Member Verification
```text
-rw-r--r-- package/LICENSE (1089 bytes)
-rw-r--r-- package/lib/client.js (192200 bytes)
-rw-r--r-- package/lib/ecdict-integrity-worker.js (23193 bytes)
-rw-r--r-- package/lib/index.js (346640 bytes)
-rw-r--r-- package/corpus/ecdict.manifest.json (566 bytes)
-rw-r--r-- package/package.json (5488 bytes)
-rw-r--r-- package/README.md (19338 bytes)
-rw-r--r-- package/cordis.patch.yml (415 bytes)
```
- Total files: 8
- No unapproved files, user databases, credentials, or development tests included.
- Unpacked size: 588,929 bytes.

---

## 4. Pre-Publication Quality Gate Execution

| Step / Verification | Command | Exit Code | Observed Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **TypeScript Typecheck** | `npm run typecheck` (`tsc -p tsconfig.json`) | 0 | 0 errors | **PASS** |
| **Production Build** | `npm run build` (`tsdown && tsc -p tsconfig.build.json`) | 0 | Built 3 entries (client, host, worker) | **PASS** |
| **Full Unit & Regression Suite** | `npm test` (`vitest run`) | 0 | 60 test suites, 1165 tests passed | **PASS** |
| **Credential & Secret Scan** | `npm run scan:credentials` | 0 | 785 files checked, 0 usable secrets found | **PASS** |
| **Git Diff Whitespace / Format** | `git diff --check` | 0 | Clean diff check | **PASS** |

---

## 5. DSH Runtime Isolation Verifications

### 5.1 DSH 0.2.0-rc.2 Baseline Isolation Smoke (Local Tarball)
- **Runner**: `scripts/probes/release-v0.2.1/release-smoke.mjs --source local-tarball`
- **Runtime Target**: DSH `0.2.0-rc.2` (Web Profile)
- **Duration**: 33s | Exit Code: 0 | Verdict: **PASS**
- **Evidence**: `docs/evidence/release-v0.2.1/local-tarball-smoke-report.json`
- **Key Assertions**:
  1. Plugin load & `window.__DSH_WORD_LOOKUP__` diagnostics interface: **PASS**
  2. Settings navigation & `.dsh-wl-settings` section: **PASS**
  3. Settings UI "已支持" badge shown, obsolete "Phase 7A.8 开放" absent: **PASS**
  4. Deterministic Fixture mode active (`installed: false`): **PASS**
  5. Real fixture query (`derive`): **PASS**
  6. Auto double-click & selection switches default OFF: **PASS**
  7. Multiline Chinese translation & English definition distinct vertical ordering: **PASS**
  8. POS badge deduplication (`v.n.` absent on `pass`, starts with `n.`): **PASS**
  9. Narrow viewport (320px) responsive layout (`296px <= 320px`): **PASS**
  10. Long entry vertical scrollability (`scrollHeight=1129 > clientHeight=438`, `afterScroll > beforeScroll`): **PASS**
  11. Clean uninstallation via DSH CLI and route disarmed (HTTP 404): **PASS**

### 5.2 DSH 0.2.1-rc.2 Targeted Isolation Smoke (Local Tarball)
- **Runner**: `scripts/probes/release-v0.2.1/release-smoke.mjs --source local-tarball --dsh-bin <temp-runner>`
- **Runtime Target**: DSH `0.2.1-rc.2` (Web Profile)
- **Duration**: 36s | Exit Code: 0 | Verdict: **PASS**
- **Evidence**: `docs/evidence/release-v0.2.1/dsh-021rc2-targeted-smoke-report.json`
- **Scope**: Verified on isolated temporary DSH `0.2.1-rc.2` deployment without modifying host configuration or user profiles. All 10 acceptance checks passed identically.
- **Desktop Profile**: DSH Desktop profile was not executed and remains explicitly `NOT_VERIFIED`.

---

## 6. Official npm Publication Audit

- **Package**: `dsh-word-lookup`
- **Version**: `0.2.1`
- **Registry**: `https://registry.npmjs.org/`
- **Publication Timestamp**: `2026-10-20T11:57:05.085Z`
- **Tarball Distribution Endpoint**: `https://registry.npmjs.org/dsh-word-lookup/-/dsh-word-lookup-0.2.1.tgz`
- **Registry shasum (SHA-1)**: `3a8c0a196ff7d7fd95cc79a1bea7d0ea8a3eeae4` (Match: 100%)
- **Registry integrity (SHA-512 SRI)**: `sha512-oX3g8czFp8QczjCspl/RfL3fP/V4ZPLC4Vt8Oy0I7V+GQL9vgOyBVmA0W6J6anv9eKS4ObiZveRX8x7bBdxaBg==` (Match: 100%)
- **Registry Download Byte-for-Byte Check**:
  - Size: `139760` bytes
  - SHA-256: `597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758` (Match: 100%)
- **Dist-Tags**: `latest -> 0.2.1`
- **Evidence**: `docs/evidence/release-v0.2.1/npm-publication-evidence.json`

---

## 7. Git Tag & GitHub Release Audit

- **Git Annotated Tag**: `v0.2.1`
  - Tag Object: `96986896f7749b663e2949645e686f03429e67fc`
  - Peeled Target Commit: `79c4e16a323df48391dab0dd3799f22f99a6b771` (`RELEASE_SOURCE_SHA`)
  - Remote Ref: `refs/tags/v0.2.1` on `https://github.com/HaowenCang/dsh-word-lookup.git`
- **GitHub Release URL**: [https://github.com/HaowenCang/dsh-word-lookup/releases/tag/v0.2.1](https://github.com/HaowenCang/dsh-word-lookup/releases/tag/v0.2.1)
  - Release Title: `dsh-word-lookup v0.2.1`
  - Draft Status: `false`
  - Assets:
    1. `dsh-word-lookup-0.2.1.tgz` (`139760` bytes, SHA-256: `597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758`)
    2. `SHA256SUMS.txt` (`92` bytes, pure ASCII no-BOM)
- **Evidence**: `docs/evidence/release-v0.2.1/git-release-tag-evidence.json`, `docs/evidence/release-v0.2.1/github-release-evidence.json`

---

## 8. Tripartite Hash Identity Verification

```text
Local Frozen Candidate Tarball SHA-256:
597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758

npm Registry Downloaded Tarball SHA-256:
597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758

GitHub Release Downloaded Tarball SHA-256:
597e70b241c298a35c6b36988fc0356129029e51436faa7dc8ec00968d3ad758
```

Result: **`LOCAL_TARBALL_SHA256 == NPM_TARBALL_SHA256 == GITHUB_RELEASE_TARBALL_SHA256`** (100% Bit-for-bit identical).

---

## 9. Official npm Post-Publication Clean-Room Smoke Acceptance

- **Runner**: `node scripts/probes/release-v0.2.1/release-smoke.mjs --source npm`
- **Package Installed**: Genuine `dsh-word-lookup@0.2.1` unpacked from official npm Registry
- **Duration**: 38s | Exit Code: 0 | Verdict: **`PASS`**
- **Evidence**: `docs/evidence/release-v0.2.1/npm-smoke-execution-report.json`
- **Clean-room Checks Verified**:
  - [x] Unpacked directory provenance confirmed genuine (no symlinks / junctions)
  - [x] Initial dictionary mode strictly `fixture` with 0 external network requests
  - [x] Real fixture query `derive` succeeded via SQLite
  - [x] Settings panel rendered with "已支持" badge and without obsolete Phase 7A.8 text
  - [x] Double-click and selection switches default strictly OFF
  - [x] Multiline Chinese translations & English definitions render formatted separate blocks
  - [x] POS badge deduplication confirmed (`pass` has `n.` translation, `v.n.` combination absent)
  - [x] Narrow viewport 320px responsive adaptation verified (width 296px)
  - [x] Long entry vertical scrollability verified (`scrollHeight=1129 > clientHeight=438`)
  - [x] Clean uninstallation via DSH CLI and route disarmed (HTTP 404 confirmed)
  - [x] Scratch test directory cleaned up automatically

---

## 10. Non-Interference & Environment Isolation Guarantees

1. **Production DSH Profile**: `web` profile and user default profile were never touched or mutated.
2. **User Databases**: No real user dictionaries, custom snapshots, or production sessions were accessed or altered.
3. **Credentials & 2FA**: 2FA was performed natively by the operator on trusted local interface; zero OTP tokens or credentials were logged or transmitted.
4. **Ports**: All runs used dynamic high non-production ports (`50995`).
5. **No Network Leakage**: In all fixture mode tests, zero automatic downloads were initiated.

---

## 11. Known Limitations & Remaining Scope

1. **F03 Crash Recovery Sync**: Process termination during transition from custom dictionary mode to built-in fixture mode immediately following disk unlink may leave `settingsSyncState: 'pending'`. The user can click once in Settings to re-sync.
2. **Auto Drag-Selection Portability**: `autoSelection` remains default OFF due to OS-level pointer event timing variations. Keyboard shortcut (`Primary+Shift+L`) is the primary recommended method.
3. **Corpus Distribution**: ECDICT is not bundled in npm or GitHub packages and requires user-initiated download.
4. **DSH Desktop Profile**: Not executed / declared `NOT_VERIFIED`.

---

## 12. Final Verdict

**`PASS — v0.2.1 RELEASED`**
- npm package `dsh-word-lookup@0.2.1` is live and verified.
- Git tag `v0.2.1` is pushed and verified.
- GitHub Release `v0.2.1` is live and verified with matching assets.
- Post-publication smoke test is 100% passed.
