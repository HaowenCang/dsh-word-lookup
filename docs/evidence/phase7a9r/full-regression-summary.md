# Full Regression Suite Summary (Phase 7A.9R)

- **Execution Date**: 2026-10-18T06:33:50Z
- **Environment**: Windows 11 x64, Node.js v24.13.0, DSH v0.2.0-rc.2
- **Evidence Classification**: `LOCALLY_EXECUTED_TEST`
- **Overall Verdict**: **PASS (100% Passing, 0 Failures)**

---

## 1. Test Suite Results Overview

| Component / Layer | Test Runner / Tool | Target | Result | Notes |
|---|---|---|---|---|
| **TypeScript Static Check** | `tsc -p tsconfig.json` | Whole project | **PASS (0 errors)** | Zero type violations |
| **Production Build** | `tsdown` & `tsc -p tsconfig.build.json` | Host, Client, Worker | **PASS (3 bundles)** | Reproduces bit-for-bit byte outputs |
| **Unit & Integration Suite** | Vitest v3.2.4 | 60 test files | **PASS (1121/1121)** | 0 failures, 30.51s duration |
| **DSH Store Packaging Contract** | `scripts/verify-store-contract.mjs` | Tarball & manifest | **PASS (28/28 checks)** | Strictly 8 files, zero disallowed permissions |
| **Credential & Secret Scan** | `scripts/scan-credentials.mjs` | Tracked files & evidence | **PASS (0 leaked tokens)** | Zero tokens or secrets found |
| **Isolation Preflight Guard** | `scripts/assert-isolated-env.mjs` | Ports & homes | **PASS** | Complete safety isolation from User Home |
| **Store Lifecycle Verifier** | `scripts/store-lifecycle-verify.mjs` | Candidate `.tgz` | **PASS (4/4 ops)** | Install, Start, Uninstall, Rollback passed |

---

## 2. Release Candidate Acceptance Probes (RC-A through RC-F)

| Probe | Script | Execution Type | Verdict | Key Remediated Findings / Guarantees |
|---|---|---|---|---|
| **RC-A** | `scripts/probes/phase7a9/rc-a-large-database-benchmark.mjs` | Real Isolated DSH | **PASS** | 3 cold restart runs replicated; external boot vs in-process sampler documented; peak RSS 312.66 MiB (< 512 MiB); P99 lag 79.97 ms (<= 100 ms). |
| **RC-B** | `scripts/probes/phase7a9/rc-b-process-crash-injection.mjs` | Real Child Kill & Recover | **PASS** | 5 crash injection boundaries (F01–F05) verified with process kills at commit hooks. |
| **RC-C** | `scripts/probes/phase7a9/rc-c-multi-snapshot-ui.mjs` | Playwright Browser E2E | **PASS** | Multi-snapshot switching, reboot persistence, inactive A deletion, and dedicated Step 9.5 active B deletion rejection verified. |
| **RC-D** | `scripts/probes/phase7a9/rc-d-recording-lock-probe.mjs` | Concurrency & Fault Injection | **PASS** | RCD-05 reclassified as PASS_WITH_BOUNDARY_LIMITATION; RCD-05W added for DSH Web native contract (`async () => {}`); zero deadlock. |
| **RC-E** | `scripts/probes/phase7a9/rc-e-store-package-install.mjs` | Real Isolated DSH & NPM Pack | **PASS** | Tarball rehashed (`ce51e0e2...`); exact 8 files; clean install, start, uninstall, and rollback to v0.1.0 verified. |
| **RC-F** | `scripts/probes/phase7a9/rc-f-historical-provenance-audit.mjs` | Git Object Audit | **PASS** | Dynamic commit inspection; Class A/B/C change classification; blob equality verified for 7 frozen production files; README approved Class C. |

---

## 3. Regression Baseline Comparison

- **Phase 7A.8.2 Baseline**: 60 test files, 1121 tests, 0 failures.
- **Phase 7A.9 Baseline**: 60 test files, 1121 tests, 0 failures.
- **Phase 7A.9R Observed**: 60 test files, 1121 tests, 0 failures.
- **Result**: Zero regressions introduced across all 1121 existing automated tests.
