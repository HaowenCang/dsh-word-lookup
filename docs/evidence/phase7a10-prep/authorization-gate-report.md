# Phase 7A.10R — Authorization Gate Report: v0.2.0 Release Preparation & Runbook Corrections

- **Project**: `dsh-word-lookup` (`E:\Projects\DSHarness\dsh-word-lookup`)
- **Repository**: `https://github.com/HaowenCang/dsh-word-lookup`
- **Release Target**: `dsh-word-lookup@0.2.0`
- **Audit Date**: 2026-10-18
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Gate Verdict**: **READY FOR PUBLICATION AUTHORIZATION (ZERO ACTIONS EXECUTED)**

---

## 1. Release Preparation Baseline Summary

All preflight checks, environment readiness audits, artifact identity verifications, release notes, publication runbooks, and failure recovery playbooks have been prepared, audited, and errata-corrected in read-only mode.

No publication actions (`npm publish`, tag creation, or GitHub Release) have been performed.

### 1.1 Provenance & Freeze Matrix
| Artifact / Anchor | Authoritative Baseline | Observed In-Tree State | Status |
|---|---|---|---|
| **生产源码冻结基线** | `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` | Present in tree (`src/` tree `24d78dfbb54ae62882aa661d4819f6397068e303`) | **PASS** |
| **测试验证提交** | `fc1c5b64c56629cf0395121b8c76a3ddfc811ddc` | Present in tree (264 suites, 1121 tests passed) | **PASS** |
| **最终验收证据提交** | `5c863335afdc4b71ee18f41340d852f378a2bee2` | Present in tree (Phase 7A.9R3 evidence anchor) | **PASS** |
| **发布准备文档提交** | `5305a934851934e39fd505057ece9a258950ed68` | Present in tree (Phase 7A.10 prep docs) | **PASS** |
| **计划 Git Tag 指向** | `5c863335afdc4b71ee18f41340d852f378a2bee2` | Anchored; strict ban on moving to latest HEAD | **PASS** |
| **生产源码树 SHA** | `24d78dfbb54ae62882aa661d4819f6397068e303` | `24d78dfbb54ae62882aa661d4819f6397068e303` bit-for-bit | **PASS** |
| **候选包文件路径** | `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz` | File exists | **PASS** |
| **候选包文件长度** | `135731 bytes` | `135731 bytes` | **PASS** |
| **候选包 SHA-256** | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | Matches bit-for-bit | **PASS** |
| **候选包成员文件数** | 严格 8 regular files | 8 files (0 symlinks, 0 hidden) | **PASS** |

---

## 2. Environment Preflight Outcomes

### 2.1 npm Ecosystem Readiness
- **Registry Endpoint**: `https://registry.npmjs.org/` (Verified official registry).
- **Authenticated Account**: `evan-williams` (Verified via `npm whoami`).
- **Authorization & Ownership**: `evan-williams` holds `read-write` permission on `dsh-word-lookup`.
- **Version Ledger**: Existing versions are `0.0.0-stage` and `0.1.0`. Version `0.2.0` is absent and completely available.
- **Two-Factor Authentication (2FA)**: Account enforces `tfa.mode: auth-and-writes`. Publication strictly prioritizes operator native interactive console 2FA OTP prompt. Zero credentials/OTP collected or displayed in prompts, reports, or logs.
- **Package Manifest & Hygiene**: Clean manifest, Node `>=22`, MIT license, no lifecycle scripts, zero secret tokens or unexpected database files.
- **Preflight Verdict**: `PASS` (with interactive 2FA OTP marked `REQUIRES_USER_ACTION`).

### 2.2 GitHub Ecosystem Readiness
- **Repository Remote**: `https://github.com/HaowenCang/dsh-word-lookup.git`.
- **Commit Anchors**: Evidence anchor `5c863335...` is locked in repo; documentation commit `5305a934...` is recorded on master.
- **Tag Target Policy**: Planned `v0.2.0` annotated tag strictly targets `5c863335afdc4b71ee18f41340d852f378a2bee2`. Ban on moving tag to HEAD without user approval.
- **Tag Namespace**: `v0.1.0` exists; `v0.2.0` is clear locally and remotely.
- **Release Namespace**: `v0.1.0` is current; `v0.2.0` is clear on GitHub.
- **CLI Authentication & Verification**: `gh` authenticated as `HaowenCang` with `repo` and `workflow` scopes; release creation enforces `--verify-tag`.
- **Preflight Verdict**: `PASS`.

---

## 3. Deliverables Inspection Ledger

The Phase 7A.10 deliverables have been updated with Phase 7A.10R runbook errata corrections and Phase 7A.10 release smoke execution readiness fixes in `docs/evidence/phase7a10-prep/` and `scripts/probes/phase7a10/`:
1. `npm-preflight.md`: Comprehensive audit of npm environment, permissions, manifest, and 2FA posture.
2. `github-preflight.md`: In-depth audit of GitHub remote state, commit lineage, CLI scopes, and release assets.
3. `release-artifact-identity.json`: Machine-readable ledger binding commits, tarball hashes, member files, and runtime baselines.
4. `release-notes-v0.2.0.md`: Complete release notes documenting 11 major features, v0.1.0 vs v0.2.0 comparison, installation instructions, and mandatory disclosures (DSH 0.2.0-rc.2 Web Profile baseline, unverified 0.2.1/Desktop, opt-in auto-selection, Scenario F03 recovery boundary, and ECDICT manifest-only redistribution).
5. `publication-runbook.md` (v1.2.0): Authoritative 10-step sequential runbook incorporating R1 registry identity rules, R2 remote Git ref resolution & `--verify-tag`, R3 ASCII SHA256SUMS encoding, R5 interactive 2FA credential security, strictly distinguishing registry 404 from network errors (Step 2), and establishing an operational, clean-room smoke test runner (`scripts/probes/phase7a10/release-smoke.mjs`) for both pre-publication local-tarball chain verification and post-publication official npm smoke acceptance (Step 9).
6. `release-recovery-plan.md` (v1.2.0): Contingency playbooks for all failure scenarios incorporating R4 strict recovery authorization boundaries (prohibiting automatic deprecate/unpublish/tag movement/patch publication and mandating 6-step reporting procedure), query-before-retry on publish network timeout, and aligning Step 9 execution commands.
7. `scripts/probes/phase7a10/release-smoke.mjs`: Standalone, clean-room isolated smoke test execution runner supporting `--source local-tarball` and `--source npm`. Enforces assertIsolatedDshEnvironment, dynamically discovers free high ports, verifies non-symlink genuine unpack, verifies real DSH Web Profile boot and word lookup, and validates clean uninstallation.
8. `smoke-execution-report.json`: Machine-readable audit evidence recording clean execution of the release smoke test suite.
9. `authorization-gate-report.md`: Current gate verification and authorization closure.

---

## 4. Phase 7A.10 Formal Gate Declaration

```text
RELEASE_SMOKE_RUNNER_EXISTS = PASS
RELEASE_SMOKE_RUNNER_EXECUTABLE = PASS
LOCAL_TARBALL_SMOKE = PASS
NPM_PACKAGE_SMOKE = NOT_EXECUTED_PRE_PUBLICATION
ISOLATED_DSH_PROFILE_VERIFIED = PASS
NO_WORKSPACE_LINK_IN_NPM_MODE = PASS
RUNBOOK_STEP9_EXECUTABLE = PASS
NPM_VERSION_PREFLIGHT_FAIL_CLOSED = PASS
PRODUCTION_CODE_FROZEN = PASS
TARBALL_SHA256_UNCHANGED = PASS
READY_FOR_HUMAN_PUBLICATION_AUTHORIZATION = YES
NPM_PUBLISH_AUTHORIZED = NO
GIT_TAG_CREATION_AUTHORIZED = NO
GITHUB_RELEASE_CREATION_AUTHORIZED = NO
```

> **CRITICAL BOUNDARY NOTICE**:  
> `READY_FOR_PUBLICATION_AUTHORIZATION = YES` indicates that all publication runbook specifications, preflight verification checks, and safety controls have been prepared and verified. **It does NOT represent an authorization to publish.**  
> `NPM_PUBLISH_AUTHORIZED`, `GIT_TAG_CREATION_AUTHORIZED`, and `GITHUB_RELEASE_CREATION_AUTHORIZED` remain strictly `NO`. No publication action may be executed without affirmative human instruction.
