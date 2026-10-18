# Phase 7A.9R — Audit Remediation & Evidence Closure Report

## 1. Executive Summary
- **Execution Phase**: Phase 7A.9R (Release Candidate Audit Remediation & Final Evidence Closure)
- **Target Repository**: `E:\Projects\DSHarness\dsh-word-lookup`
- **GitHub Target**: `https://github.com/HaowenCang/dsh-word-lookup`
- **Target Environment**: Windows 11 x64, Node.js v24.13.0, DSH v0.2.0-rc.2 (`639ed015397290b3745d163aafe02ffee4aa3f84`)
- **Git Branch**: `master`
- **Package Status**: `dsh-word-lookup@0.2.0 (UNRELEASED)`
- **Mandate Constraints Enforced**:
  - `npm publish`: **NOT AUTHORIZED / NOT EXECUTED**
  - Git Tags / GitHub Releases: **NOT CREATED**
  - Production DSH Home / Profiles: **UNTOUCHED (Strict Isolation Enforced)**
  - Git History Rewriting: **ZERO FORCE PUSH / ZERO HISTORY REWRITING**

---

## 2. Root Cause and Remediation Analysis for Audit Findings

### Finding 1: RC-D `RCD-05` reports PASS even though simulated Host recording remains true
- **Original Defect**: `RCD-05` tested a simulated Host failure where `recording(false)` rejects before release. The test reported unconditional `PASS` while `host.isRecording` remained `true` and local lock was `false`. Furthermore, comments claimed DSH auto-disarms recording on window blur or shortcut dispatch without upstream support.
- **Source Mechanism**: An audit of upstream DSH shortcuts (`packages/client/shortcuts/src/client/storage.ts`) established that DSH Web implements recording as `async () => {}` through `webShortcutStorage`. Dangling host recording can only theoretically occur in stateful native Desktop adapters. Client-side `AsyncRecordingLock` guarantees local cleanup (`isHeld() === false`) and suppresses unhandled rejections to prevent UI lockup, but cannot remotely clear remote host state if the transport rejects.
- **Remediation**:
  1. Reclassified `RCD-05` verdict to `PASS_WITH_BOUNDARY_LIMITATION`.
  2. Added `RCD-05W` to directly verify DSH Web runtime native recording contract (`webShortcutStorage.recording: async () => {}`).
  3. Removed unsupported claims regarding window blur auto-disarm.
  4. Documented precise boundary in `docs/evidence/phase7a9r/recording-lock-guarantee-matrix.md`.
- **Verification**: `scripts/probes/phase7a9/rc-d-recording-lock-probe.mjs` executed cleanly. Local lock `held = false` verified; boundary explicitly noted.

### Finding 2: RC-F was executed against `e09538c...`, not final RC commit
- **Original Defect**: RC-F referenced `e09538c...` as HEAD because it was drafted prior to committing RC probe and evidence commits.
- **Source Mechanism**: Circular SHA reference problem: an evidence file cannot record its own future commit SHA.
- **Remediation**: Updated RC-F probe to dynamically resolve the current HEAD SHA from the Git repository using `git rev-parse HEAD` and establish a clear staged provenance structure separating:
  - Source baseline: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`
  - Tested implementation commit: `7dbfb43d7eeb608e6ea45ccc579c63c588b854ad`
  - Current HEAD / Evidence commit: evaluated dynamically.
- **Verification**: `rc-f-historical-provenance-audit.mjs` successfully executed against current HEAD.

### Finding 3: RC-F `git ls-tree --name-only` compared filenames, not file contents
- **Original Defect**: The previous script compared `git ls-tree --name-only`, which only proves directory structure and filenames, not byte-for-byte content equality.
- **Source Mechanism**: Inadequate git invocation.
- **Remediation**:
  1. Implemented tree object SHA comparison for `src/` (`git rev-parse <commit>:src`).
  2. Implemented per-file Git blob SHA comparison (`git rev-parse <commit>:<file>`) across all production files.
  3. Classified changes into Class A (Evidence), Class B (RC Probes), Class C (Approved Documentation Correction: `README.md`), and Forbidden (0 files).
- **Verification**: All 7 production code/config files proved 100% bit-for-bit identical to `CODE_FREEZE_SHA`.

### Finding 4: Release-readiness and provenance reports contained stale Git identities
- **Original Defect**: Prior reports had copy-pasted author names, dates, or emails from older commits.
- **Source Mechanism**: Manual transcription in markdown templates.
- **Remediation**: Rewrote `rc-f-historical-provenance-audit.mjs` to dynamically extract author, date, and commit subject directly from the Git object database using `git log -1 --format=%H%x00%s%x00%an <%ae>%x00%ad%x00%P`.
- **Verification**: All commit lineage entries in `git-provenance-audit.json` and `.md` match authentic Git commit objects.

### Finding 5: Historical commit dates were hard-coded incorrectly
- **Original Defect**: Historical reports contained manually typed dates (e.g., April 2026 timestamps).
- **Source Mechanism**: Synthetic date transcription.
- **Remediation**: Replaced all hardcoded dates with live git object queries.
- **Verification**: Dynamic extraction confirmed in `git-provenance-audit.json`.

### Finding 6: RC-E's actual `.tgz` binary was not independently rehashed in final audit
- **Original Defect**: Previous evidence recorded a hash that was not recomputed after packaging changes.
- **Source Mechanism**: Missing end-to-end binary verification step.
- **Remediation**:
  1. Packaged release candidate tarball with `npm pack --pack-destination build/rc-v0.2.0/`.
  2. Recomputed SHA-256 directly from binary stream via both `Get-FileHash` and Node.js `crypto.createHash('sha256')`.
  3. Final Tarball SHA-256: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` (135,731 bytes).
  4. Extracted archive in temporary directory and verified strict 8-file whitelist.
- **Verification**: Saved in `docs/evidence/phase7a9r/final-tarball-sha256.json` and `final-package-file-ledger.json`.

### Finding 7: RC-E did not itself verify complete Store rollback lifecycle
- **Original Defect**: RC-E verified install, start, and uninstall, but omitted rollback to verified v0.1.0 release.
- **Source Mechanism**: Rollback test was only present in `store-lifecycle-verify.mjs`.
- **Remediation**:
  1. Enhanced `rc-e-store-package-install.mjs` Step 6 to unpack verified v0.1.0 release tarball (`22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc`), reconfigure profile, boot DSH, and execute live lookup.
  2. Enhanced `store-lifecycle-verify.mjs` to support `--allow-dirty` for pre-commit verification against candidate tarball.
  3. Successfully executed both runners.
- **Verification**: Complete 4-step Store lifecycle (Install, Start, Uninstall, Rollback) passed with authentic DSH process reboots.

### Finding 8: README contained obsolete information about ECDICT installation UI
- **Original Defect**: README claimed user-facing installation UI was still pending.
- **Source Mechanism**: Unupdated text from Phase 7A.4.
- **Remediation**: Updated `README.md` to accurately describe built-in fixture, one-click managed ECDICT installation, custom SQLite snapshots, active snapshot protection, and multi-snapshot switching. Preserved `v0.2.0 = UNRELEASED` and `REDISTRIBUTION REVIEW REQUIRED`.
- **Verification**: Formally classified as `CLASS_C_APPROVED_DOCUMENTATION_CORRECTION`.

### Finding 9: RC-A startup measurement had incomplete evidence of sampler initialization coverage
- **Original Defect**: Saved recovery CSV had 61 samples spanning ~1.916s, leaving the first ~1.5s of process startup unexplained.
- **Source Mechanism**: External Node.js engine and core bundle bootstrap occurs prior to Cordis plugin apply.
- **Remediation**:
  1. Added explicit architectural analysis of process startup timeline vs in-process sampling.
  2. Confirmed `process.memoryUsage().rss` captures process-wide RSS including Worker threads.
  3. Replicated recovery benchmark across 3 independent cold-start runs.
  4. Preserved SLA contracts; documented database structural scope limitations.
- **Verification**: Saved in `docs/evidence/phase7a9r/performance-replication-report.md` and `large-database-performance.json`.

### Finding 10: RC-C active-snapshot deletion protection claimed without dedicated rejection attempt
- **Original Defect**: RC-C verified inactive snapshot deletion but lacked a dedicated rejection attempt on active snapshot B.
- **Source Mechanism**: Probe skipped active snapshot deletion attempt to avoid test errors.
- **Remediation**: Added Step 9.5 to `rc-c-multi-snapshot-ui.mjs`:
  1. Asserted UI delete button is disabled on active snapshot B.
  2. Executed guarded management API deletion attempt via HTTP POST to `/api/dsh-word-lookup/remove-custom?snapshotId=<activeB>`, verifying refusal (`ok: false`).
  3. Verified Custom B remains active and queryable immediately after rejection.
  4. Captured screenshot: `rcc-S09_active_delete_guard-active-snapshot-delete-disabled.png`.
- **Verification**: Step 9.5 executed and passed in authentic browser session.

---

## 3. Residual Limitations & Disclosures

1. **`autoSelection` Portability**: Remains opt-in and defaults to OFF. Drag-selection timing across non-measured windowing environments/DPI remains experimental. First-class supported lookup path remains manual keyboard shortcut (`Primary+Shift+L`).
2. **Synthetic Benchmark DB Scope**: The 105 MiB benchmark database proves memory buffers and SQLite page handling for large databases, but contains 1,750 entries rather than 770,611 realistic ECDICT entries.
3. **Desktop IPC Recording Failure Boundary**: In unverified stateful Desktop environments, if the host IPC transport breaks, the external process may remain recording. Client local lock resets cleanly to prevent UI hang, but remote clearing is not possible without host endpoints. This cannot occur in DSH Web.
