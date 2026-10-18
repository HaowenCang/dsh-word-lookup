# Release Readiness Report: dsh-word-lookup@0.2.0 (Phase 7A.9)

## 1. Release Candidate Identity & Verdict
- **Package Name**: `dsh-word-lookup`
- **Candidate Version**: `0.2.0`
- **Target DSH Runtime**: `0.2.0-rc.2`
- **Evaluation Date**: `2026-10-18`
- **Code Freeze Base Commit**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`
- **Current Evidence HEAD**: `e09538c763e65c49bdada304e464701b256561ea`
- **Testing Architecture**: Isolated Disposable Profiles, Real High Ports (50991–50994), Chromium Playwright Automation, Real Process Crash Injection.

### Authoritative Release Status:
```text
READY_FOR_V0_2_0_RELEASE = YES
READY_FOR_NPM_PUBLISH    = NO
```
*(Strict Protocol Notice: Quality acceptance and release readiness gate passed 100%. In accordance with Phase 7A.9 instructions, no npm publish was performed.)*

---

## 2. Hard Gates Evaluation

| Hard Gate | Requirement | Probe / Target | Observed Outcome | Status |
|---|---|---|---|:---:|
| **HG-1: Large SQLite Scale** | Database >= 100 MiB; Event-loop P99 <= 100 ms; Max lag <= 500 ms; Peak RSS increment < 512 MiB; Worker offloaded | RC-A (`rc-a-large-database-benchmark.mjs`) | Size: 105.19 MiB; P99: 86.36 ms; Max: 97.22 ms; Peak inc: 24.84 MiB; Worker integrity: OK | **PASS** |
| **HG-2: Crash Durability** | Real child process crashes at active intent commit boundaries (F01–F05) recover cleanly across reboot | RC-B (`rc-b-process-crash-injection.mjs`) | 5/5 scenarios recovered cleanly with atomic consistency and settings reconciliation | **PASS** |
| **HG-3: Multi-Snapshot UI** | Real native UI Playwright E2E: SnapshotPickerModal (A/B), restart persistence, inactive delete, raw file invariance | RC-C (`rc-c-multi-snapshot-ui.mjs`) | Modal rendered, explicit IDs routed, reboot persisted, delete confirmed, raw source SHA invariant | **PASS** |
| **HG-4: Async Lock Safety** | 10 concurrency, rejection, and cleanup race scenarios for shortcut recorder lock | RC-D (`rc-d-recording-lock-probe.mjs`) | 10/10 scenarios passed; held state strictly false upon exit; zero unhandled rejections | **PASS** |
| **HG-5: Store Packaging** | Strict 8-file whitelist; zero credentials; zero dynamic code; clean isolated .tgz install/uninstall | RC-E (`rc-e-store-package-install.mjs`) | Exact 8 files in `dsh-word-lookup-0.2.0.tgz`; live lookup OK; clean 404 uninstallation | **PASS** |
| **HG-6: Provenance & Regression** | Historical SHA typo resolved; zero code changes since code freeze; 100% test pass | RC-F (`rc-f-historical-provenance-audit.mjs`) | Provenance closed; 60 test suites (1121 tests) passed; store contract & credential scan PASS | **PASS** |

---

## 3. Comprehensive Q01–Q20 Acceptance Matrix

| ID | Category | Scenario / Invariant | Metrics / Criteria | Verdict |
|:---:|---|---|---|:---:|
| **Q01** | RC-A | 100 MiB+ SQLite creation & worker validation | 110,301,184 B (105.19 MiB), validation 555 ms, worker offloaded | **PASS** |
| **Q02** | RC-A | 100 MiB+ publication & atomic metadata update | 2112 ms publish, active.json committed, queries verified | **PASS** |
| **Q03** | RC-A | Event loop latency SLA under 100 MiB+ load | P50: 5.53 ms, P95: 9.34 ms, P99: 86.36 ms (SLA <= 100 ms), Max: 97.22 ms | **PASS** |
| **Q04** | RC-A | Peak memory bounded SLA (< 512 MiB total) | Baseline: 294.65 MiB, Absolute Peak: 319.49 MiB, Increment: 24.84 MiB | **PASS** |
| **Q05** | RC-A | 100 MiB+ cold startup recovery via worker | 3518 ms restart, time-to-first-lookup 8 ms, ghost leases = 0 | **PASS** |
| **Q06** | RC-B | F01: Crash Managed -> Custom post-commit pre-ack | Process exited 101; restart recovered Custom, settings reconciled | **PASS** |
| **Q07** | RC-B | F02: Crash Custom -> Managed post-commit pre-ack | Process exited 102; restart recovered Managed ECDICT, settings reconciled | **PASS** |
| **Q08** | RC-B | F03: Crash Custom -> Fixture post-unlink pre-ack | Process exited 103; restart recovered Fixture cleanly without active.json | **PASS** |
| **Q09** | RC-B | F04: Crash before commit boundary | Process exited 104; prior active snapshot preserved unconditionally | **PASS** |
| **Q10** | RC-B | F05: Crash after commit pre-host config ack | Process exited 105; recovered new active mode and reconciled to synced | **PASS** |
| **Q11** | RC-C | SnapshotPickerModal rendering & A/B listing | Modal opened, both snapshots listed with distinct rows | **PASS** |
| **Q12** | RC-C | Explicit snapshot selection & query routing | Click A -> A active (query A found); Click B -> B active (query B found) | **PASS** |
| **Q13** | RC-C | Multi-snapshot availability across DSH restart | Restarted DSH with same Home: B restored, A selectable via UI modal | **PASS** |
| **Q14** | RC-C | Inactive snapshot deletion with modal confirmation | Modal confirmed, A removed from DOM catalog, B remained active | **PASS** |
| **Q15** | RC-C | User raw SQLite source files SHA-256 invariance | Source A (`b6edf3fc...`) & B (`326155d5...`) byte-for-byte identical | **PASS** |
| **Q16** | RC-D | AsyncRecordingLock concurrency & race boundaries | 10/10 scenarios passed; guaranteed final state false; idempotent release | **PASS** |
| **Q17** | RC-E | Production tarball strict 8-file whitelist audit | Tarball SHA: `56f9f227...`; unpacked: exactly 8 whitelisted files | **PASS** |
| **Q18** | RC-E | Package security & capability contract audit | Zero credentials, zero eval, zero child_process, zero lifecycle scripts | **PASS** |
| **Q19** | RC-E | Isolated profile .tgz installation & uninstallation | Extracted .tgz into isolated DSH; live lookup OK; uninstalled cleanly (404) | **PASS** |
| **Q20** | RC-F | Git SHA provenance closure & full regression suite | Typo explained; 60 test suites (1121 tests) passed; 0 regressions | **PASS** |

---

## 4. Architectural & Safety Analysis

### 4.1 Storage & Concurrency Model
1. **Atomic Invariant**: `writeActiveMetadataAtomically` writes to a temporary file (`active.json.tmp-<pid>-<rand>`), flushes with `fsync`, and performs an atomic rename to `active.json`.
2. **Crash Tolerance**: If a crash occurs before rename, the previous active configuration persists intact (Scenario F04). If a crash occurs after rename but before UI acknowledgement, the state machine recovers the committed intent on reboot and reconciles host settings (Scenarios F01, F02, F05). If switching to Fixture, unlinking `active.json` leaves the directory clean (Scenario F03).
3. **Immutability of User Files**: User database imports copy bytes to managed storage before opening. Source databases are never mutated, locked, or deleted under any circumstance (Scenario Q15).
4. **Offloading & Responsiveness**: All SQLite PRAGMA integrity checks, schema validations, and SHA-256 computations are offloaded to dedicated companion worker threads (`lib/ecdict-integrity-worker.js`), ensuring the host event-loop P99 lag remains well below 100 ms even for 100 MiB+ databases.

---

## 5. Evidence Artifacts Inventory

All evidence artifacts are preserved in `docs/evidence/phase7a9/`:

1. `release-candidate-matrix.json`: Machine-readable Q01–Q20 acceptance matrix and observed metrics.
2. `large-database-performance.json`: Benchmark metrics for authentic 105.19 MiB database under candidate validation, publish, activation, and recovery.
3. `large-database-performance-raw.csv`: Raw 100ms interval time-series data for RSS and event-loop lag.
4. `process-crash-injection.json`: Detailed execution log, PIDs, exit codes, and recovered states for F01–F05 crash injection.
5. `multi-snapshot-real-ui-e2e.json`: Playwright DOM interaction log, snapshot UUIDs, and source file SHA-256 invariance proofs.
6. `screenshots/`: 11 authentic Chromium screenshots verifying each UI transition (initial settings, custom A, custom B, fixture switch, picker modal, restart, deletion modal, and post-delete state).
7. `recording-lock-failure-injection.json`: Concurrency analysis of the 10 AsyncRecordingLock failure scenarios.
8. `store-package-sha256.json`: Unpacked 8-file whitelist audit with byte sizes and SHA-256 hashes.
9. `isolated-install-lifecycle.json`: Execution log for installing the candidate `.tgz` into an isolated DSH profile, verifying live lookups, and cleanly uninstalling.
10. `git-provenance-audit.json` & `git-provenance-audit.md`: Git commit graph lineage, explanation of historical SHA typo, and proof of production tree invariance.
11. `full-regression-summary.md`: Full regression report documenting 100% pass rate across all 60 test suites (1121 tests).
12. `release-readiness-report.md`: This authoritative release readiness declaration.

---

## 6. Final Recommendation
The `dsh-word-lookup@0.2.0` package has successfully satisfied all Hard Gates, Soft Gates, Performance SLAs, Crash Durability guarantees, Store Packaging constraints, and Security Invariants.

The release candidate is officially certified as **READY FOR v0.2.0 RELEASE**.
