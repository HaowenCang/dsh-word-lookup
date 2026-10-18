# Full Regression Summary Report — Phase 7A.9 (Release Candidate v0.2.0)

## 1. Test Execution Metadata
- **Date**: 2026-10-18T04:44:18Z
- **Node.js**: v24.13.0
- **Platform**: Windows 11 x64 (`win32`)
- **Git HEAD**: `e09538c763e65c49bdada304e464701b256561ea`
- **Tested Code Freeze Baseline**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`
- **Test Runner**: Vitest v3.2.4 (`npx vitest run --reporter=basic`)
- **Overall Verdict**: **100% PASS (0 FAILURES, 0 REGRESSIONS)**

---

## 2. Test Suite Breakdown (60 Test Files, 1121 Unit & Integration Tests)

| # | Test Suite | Tests | Result | Duration |
|---|---|:---:|:---:|:---:|
| 1 | `tests/iso-guard.spec.ts` | 14 | PASS | 54ms |
| 2 | `tests/host-sqlite-safety.spec.ts` | 15 | PASS | 74ms |
| 3 | `tests/managed-storage.spec.ts` | 32 | PASS | 325ms |
| 4 | `tests/worker-lifecycle-safety.spec.ts` | 12 | PASS | 397ms |
| 5 | `tests/store-worker-audit.spec.ts` | 18 | PASS | 672ms |
| 6 | `tests/corpus-builder-safety.spec.ts` | 12 | PASS | 959ms |
| 7 | `tests/ecdict-source.spec.ts` | 13 | PASS | 78ms |
| 8 | `tests/host-dictionary.spec.ts` | 34 | PASS | 58ms |
| 9 | `tests/client-card-interaction.spec.ts` | 3 | PASS | 94ms |
| 10 | `tests/client-io-boundary.spec.ts` | 12 | PASS | 76ms |
| 11 | `tests/host-lookup.spec.ts` | 24 | PASS | 22ms |
| 12 | `tests/environment-removal.spec.ts` | 6 | PASS | 32ms |
| 13 | `tests/client-management-store.spec.ts` | 16 | PASS | 17ms |
| 14 | `tests/dictionary-manager.spec.ts` | 24 | PASS | 30ms |
| 15 | `tests/ecdict-concurrency-quarantine.spec.ts` | 6 | PASS | 1718ms |
| 16 | `tests/worker-exit-provenance-safety.spec.ts` | 8 | PASS | 1784ms |
| 17 | `tests/client-card-render.spec.ts` | 12 | PASS | 20ms |
| 18 | `tests/npm-tarball-worker-verification.spec.ts` | 1 | PASS | 2130ms |
| 19 | `tests/client-management-transport.spec.ts` | 17 | PASS | 21ms |
| 20 | `tests/ecdict-downloader.spec.ts` | 40 | PASS | 1884ms |
| 21 | `tests/quarantine-recovery-proof.spec.ts` | 12 | PASS | 2033ms |
| 22 | `tests/fault-state-and-supervisor-lifecycle.spec.ts` | 13 | PASS | 2045ms |
| 23 | `tests/exchange-parser.spec.ts` | 4 | PASS | 19ms |
| 24 | `tests/dictionary-management-route.spec.ts` | 33 | PASS | 2007ms |
| 25 | `tests/probes/phase7a8-0/p08-p09-event-loop-worker.spec.ts` | 1 | PASS | 2354ms |
| 26 | `tests/client-runtime.spec.ts` | 15 | PASS | 16ms |
| 27 | `tests/client-lookup.spec.ts` | 19 | PASS | 16ms |
| 28 | `tests/client-trigger.spec.ts` | 40 | PASS | 16ms |
| 29 | `tests/shared-text.spec.ts` | 31 | PASS | 13ms |
| 30 | `tests/corpus-verify.spec.ts` | 6 | PASS | 2601ms |
| 31 | `tests/host-config.spec.ts` | 15 | PASS | 12ms |
| 32 | `tests/probes/phase7a8-0/p14-p20-shortcuts.spec.ts` | 1 | PASS | 13ms |
| 33 | `tests/client-settings-registration.spec.ts` | 2 | PASS | 13ms |
| 34 | `tests/client-gesture.spec.ts` | 40 | PASS | 11ms |
| 35 | `tests/host-route.spec.ts` | 12 | PASS | 10ms |
| 36 | `tests/client-gesture-identity.spec.ts` | 17 | PASS | 7ms |
| 37 | `tests/client-dismiss-race.spec.ts` | 6 | PASS | 7ms |
| 38 | `tests/phase421-probe-logic.spec.ts` | 14 | PASS | 6ms |
| 39 | `tests/csv-parser.spec.ts` | 13 | PASS | 4ms |
| 40 | `tests/client-position.spec.ts` | 11 | PASS | 3ms |
| 41 | `tests/client-selection.spec.ts` | 14 | PASS | 4ms |
| 42 | `tests/client-runtime-harness.spec.ts` | 51 | PASS | 3044ms |
| 43 | `tests/redact.spec.ts` | 12 | PASS | 4ms |
| 44 | `tests/client-settings-ui.spec.ts` | 32 | PASS | 319ms |
| 45 | `tests/host-fixture-db.spec.ts` | 23 | PASS | 5849ms |
| 46 | `tests/probes/phase7a8-0/p01-p07-sqlite-safety.spec.ts` | 7 | PASS | 5864ms |
| 47 | `tests/ecdict-integrity-worker.spec.ts` | 15 | PASS | 5996ms |
| 48 | `tests/cordis-lifecycle-management.spec.ts` | 14 | PASS | 6257ms |
| 49 | `tests/corpus-production.spec.ts` | 15 | PASS | 6308ms |
| 50 | `tests/ecdict-importer.spec.ts` | 32 | PASS | 6425ms |
| 51 | `tests/probes/phase7a8-0/p10-p13-activation-lifecycle.spec.ts` | 1 | PASS | 7449ms |
| 52 | `tests/phase7a8-2-native-settings.spec.ts` | 60 | PASS | 2118ms |
| 53 | `tests/phase7a8-1ar2-scenarios.spec.ts` | 12 | PASS | 7753ms |
| 54 | `tests/dictionary-operations.spec.ts` | 56 | PASS | 11186ms |
| 55 | `tests/custom-sqlite-snapshot-matrix.spec.ts` | 24 | PASS | 15038ms |
| 56 | `tests/dictionary-activation.spec.ts` | 29 | PASS | 15436ms |
| 57 | `tests/phase7a8-1ar-scenarios.spec.ts` | 23 | PASS | 16129ms |
| 58 | `tests/phase7a8-1br-activation-recovery.spec.ts` | 28 | PASS | 19125ms |
| 59 | `tests/phase7a8-1b-activation-matrix.spec.ts` | 29 | PASS | 21925ms |
| 60 | `tests/phase7a8-1br2-scenarios.spec.ts` | 20 | PASS | 24554ms |
| **Total** | **60 Test Suites** | **1121** | **PASS** | **26.18s** |

---

## 3. Store Packaging & Contract Audits

### 3.1 Store Contract Verification (`scripts/verify-store-contract.mjs`)
- Repository URL: `https://github.com/HaowenCang/dsh-word-lookup` (PASS)
- Package Lock sync: Top-level and package root versions match `0.2.0` (PASS)
- Compatibility: `dsh.compatibility.dsh: 0.2.0-rc.2` (PASS)
- Operations: `install`, `start`, `uninstall`, `rollback` declared (PASS)
- Lifecycle Scripts: ABSENT (PASS)
- Runtime Dependencies: ABSENT (PASS)
- Production Surface Whitelist: Exactly 8 files (PASS)
- Sensitive Permissions: `credentials`, `commands`, `protectedDsh`, `native`, `dynamic` are ABSENT (PASS)

### 3.2 Security & Credential Scan (`scripts/scan-credentials.mjs`)
- Files Scanned: 672 files
- Credential Candidates Found: 0 usable launch tokens (PASS)
- Known Fixtures: Synthetic 43-character test tokens in `tests/redact.spec.ts` correctly identified and skipped (PASS)

---

## 4. Phase 7A.9 Release Candidate Probes (RC-A through RC-F)

- **RC-A (Large DB Benchmark)**: Validated 105.19 MiB database, event loop p99 = 86.36 ms (SLA <= 100 ms), max lag = 97.22 ms (SLA <= 500 ms), peak RSS increment = 24.84 MiB (SLA < 512 MiB). (PASS)
- **RC-B (Crash Injection F01–F05)**: 5/5 real child process crash scenarios recovered cleanly without metadata corruption or state divergence. (PASS)
- **RC-C (Multi-Custom Snapshot Real UI)**: Full Playwright DOM automation selecting A and B, persisting across reboot, deleting inactive snapshot with modal confirmation, and verifying raw source file SHA-256 invariance. (PASS)
- **RC-D (Recording Lock Concurrency)**: 10/10 concurrency, rejection, and cleanup race scenarios passed. (PASS)
- **RC-E (Store Packaging & Lifecycle)**: Strict 8-file whitelist verified on candidate tarball `dsh-word-lookup-0.2.0.tgz`; clean installation, live lookup, and clean uninstallation in isolated DSH profile. (PASS)
- **RC-F (Provenance & Historical Closure)**: Provenance chain verified, historical typo SHA explained, and 100% production code tree invariance confirmed. (PASS)
