# Phase 7A.11: dsh-word-lookup v0.2.0 Formal Release Execution Report

- **Package**: `dsh-word-lookup@0.2.0`
- **Release Date**: 2026-10-19
- **Release Engineer**: Gemini 3.8 Flash High (Lead Release Agent)
- **Operator Authorization**: `AUTHORIZED` (Affirmative human operator authorization verified)
- **Final Release Status**: **`RELEASED`**

---

## 1. Executive Summary

`dsh-word-lookup@0.2.0` has been successfully published to the official npm registry, tagged in Git, published to GitHub Releases, and validated via full clean-room end-to-end smoke acceptance on DSH 0.2.0-rc.2 Web Profile.

All tripartite release entities (npm Registry, Git Tag, GitHub Release Assets) match the locked candidate package hashes bit-for-bit without discrepancy. The production DSH profile and user data were completely untouched during the isolated verification.

---

## 2. Release Provenance & Invariant Verification

| Baseline Invariant | Expected Value | Observed / Audited Value | Status |
| :--- | :--- | :--- | :--- |
| **Code Freeze Commit** | `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` | `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` | PASS |
| **Source Tree SHA (`src/`)** | `24d78dfbb54ae62882aa661d4819f6397068e303` | `24d78dfbb54ae62882aa661d4819f6397068e303` | PASS |
| **Tested Probe Commit** | `fc1c5b64c56629cf0395121b8c76a3ddfc811ddc` | `fc1c5b64c56629cf0395121b8c76a3ddfc811ddc` | PASS |
| **Release Tag Target** | `5c863335afdc4b71ee18f41340d852f378a2bee2` | `5c863335afdc4b71ee18f41340d852f378a2bee2` | PASS |
| **Working Branch HEAD** | `7c2df70e1a50858c740182fab22d176be355f002` | `7c2df70e1a50858c740182fab22d176be355f002` | PASS |
| **Tarball Byte Size** | `135731 bytes` | `135731 bytes` | PASS |
| **Tarball SHA-256** | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | PASS |
| **Tarball SHA-1** | `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3` | `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3` | PASS |
| **Tarball SHA-512 SRI** | `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==` | `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==` | PASS |

---

## 3. npm Registry Publication Audit

- **Package Name**: `dsh-word-lookup`
- **Published Version**: `0.2.0`
- **npm Registry URL**: [https://www.npmjs.com/package/dsh-word-lookup](https://www.npmjs.com/package/dsh-word-lookup)
- **Tarball Distribution Endpoint**: `https://registry.npmjs.org/dsh-word-lookup/-/dsh-word-lookup-0.2.0.tgz`
- **Registry shasum (SHA-1)**: `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3` (Match: 100%)
- **Registry integrity (SHA-512 SRI)**: `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==` (Match: 100%)
- **Registry Download Byte-for-Byte Verification**:
  - Downloaded bytes: `135731 bytes`
  - Downloaded SHA-256: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` (Bit-for-bit identical with candidate package)
- **Dependency & Compatibility Manifest Audit**:
  - `peerDependencies`: `react: ^18.2.0`, `@deepseek-ai/cordis: ~4.0.4`, `@deepseek-ai/schemastery: ~3.18.4`
  - `dsh.compatibility`: `0.2.0-rc.2 / Web profile`

---

## 4. Git Release Tag Audit

- **Tag Name**: `v0.2.0`
- **Tag Type**: Annotated Tag (`tag -a v0.2.0`)
- **Tag Target Commit**: `5c863335afdc4b71ee18f41340d852f378a2bee2`
- **Remote Origin URL**: `https://github.com/HaowenCang/dsh-word-lookup.git`
- **Remote Peeled Tag Commit (`refs/tags/v0.2.0^{}`)**:
  `5c863335afdc4b71ee18f41340d852f378a2bee2` (Verified via `git ls-remote`)
- **Tag Invariant**: Strictly points to the acceptance evidence anchor commit `5c863335...`, preserved without moving to default branch HEAD.

---

## 5. GitHub Release & Asset Audit

- **Release URL**: [https://github.com/HaowenCang/dsh-word-lookup/releases/tag/v0.2.0](https://github.com/HaowenCang/dsh-word-lookup/releases/tag/v0.2.0)
- **Associated Tag**: `v0.2.0` (Verified via `gh release create --verify-tag`)
- **Release Title**: `dsh-word-lookup v0.2.0`
- **Release Assets**:
  1. `dsh-word-lookup-0.2.0.tgz`:
     - Size: `135731 bytes`
     - SHA-256: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` (Exact match)
  2. `SHA256SUMS.txt`:
     - Encoding: Pure ASCII, single line, no UTF-8 BOM
     - Content: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34  dsh-word-lookup-0.2.0.tgz`

---

## 6. Official npm Post-Publication Clean-Room Smoke Acceptance

- **Runner**: `node scripts/probes/phase7a10/release-smoke.mjs --source npm`
- **Install Source**: `https://registry.npmjs.org/` (`dsh-word-lookup@0.2.0`)
- **Isolation Verification**:
  - Isolated temporary directory: `C:\Users\20659\AppData\Local\Temp\dsh-release-smoke-b87d114a`
  - Ephemeral test profile: `smoke-v020-4570fd`
  - High test port: `50995`
  - Installed location: `.../node_modules/dsh-word-lookup` (`isSymbolicLink/Junction: false`)
- **Criteria Verification**:
  - [x] **Acceptance 1 (Load & Diagnostics)**: Plugin loaded cleanly; `window.__DSH_WORD_LOOKUP__` exposed.
  - [x] **Acceptance 2 (Settings Navigation)**: Settings nav item "词典/Dictionary" visible; `.dsh-wl-settings` rendered.
  - [x] **Acceptance 3 (Fixture Mode)**: Deterministic baseline fixture mode active (`installed: false`).
  - [x] **Acceptance 4 (Word Lookup)**: Query `"derive"` succeeded via `sqlite-fixture` with definitions, forms, phonetics, and examples.
  - [x] **Acceptance 5 (Gesture Gate Safety)**: Double-click and selection gesture switches default strictly to OFF (`aria-checked: false`, gates `false`).
  - [x] **Acceptance 6 (Corpus Boundary)**: ECDICT remains uninstalled; zero automatic downloads triggered.
  - [x] **Acceptance 7 (Clean Uninstallation)**: Plugin removed via `dsh plugin remove`; rebooted DSH verifies route HTTP 404.
- **Duration**: 102 seconds | Exit Code: 0 | Verdict: **`PASS`**
- **Production DSH Data**: Completely untouched (`PRODUCTION_PROFILE_UNTOUCHED = true`).

---

## 7. Evidence Manifest

All publication evidence artifacts are preserved in `docs/evidence/phase7a11-published/`:
- `npm-publication-evidence.json`
- `git-release-tag-evidence.json`
- `github-release-evidence.json`
- `smoke-execution-report.json`
- `release-summary.md`
