# Phase 7A.8.1BR2 Acceptance Matrix & Closure Report

**Phase**: Phase 7A.8.1BR2 — Custom Snapshot Content Integrity, Catalog Durability, Multi-Snapshot Lifecycle & Crash-Window Recovery  
**Tested Code SHA**: `fc4d0c5`  
**Baseline SHA**: `941dbab260d2385fd3582b5efeda2b9a2d1c05e6`  
**Execution Timestamp**: `2026-10-17T13:18:00Z`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 Pro 64-bit, DeepSeek Harness `0.2.0-rc.2`  
**Verification Framework**: Vitest `v3.2.4`, Playwright Chromium `v1.57.0`, Isolated DSH Runner, npm CLI `11.1.0`  

---

## 1. Executive Summary

Phase 7A.8.1BR2 resolves findings **B15–B18** discovered during independent GitHub audit of Phase 7A.8.1BR. All 20 targeted acceptance scenarios (**R01–R20**) have been implemented and executed with **100% PASS** rates across unit, integration, performance benchmark, crash-window recovery, and real isolated DSH process E2E suites.

The repository's complete verification suite passed unconditionally with zero regressions:
- **`build:fixture`**: PASS (deterministic SQLite fixture generation).
- **`typecheck`**: PASS (clean TypeScript strict-mode compilation).
- **`test`**: PASS (59 test files, 1044 tests passing).
- **`build`**: PASS (clean bundling of host, companion worker, and client artifacts).
- **`verify:store-contract`**: PASS (strict 8-file package closure, 0 runtime dependencies, zero credentials/commands/dynamic-code permissions).
- **`test:phase7a8-1br2`**: PASS (R01–R20 scenario probe matrix, 20/20 passed).
- **`scripts/test-phase7a8-1br2-e2e.mjs`**: PASS (real isolated DSH 0.2.0-rc.2 process lifecycle and anti-TOCTOU E2E).

---

## 2. Core Architectural Resolutions (B15–B18)

### 2.1 B15: Dormant Custom Snapshot Content Integrity & Anti-TOCTOU Protection
- **Vulnerability**: Dormant custom snapshots referenced in `index.json` were opened directly via `DatabaseSync` without re-verifying file digest, integrity, or symlink status, allowing silent execution of tampered databases or TOCTOU race replacements.
- **Resolution**:
  - Implemented `validatePublishedSnapshotForActivation(snapshotId, options)` in `CustomSnapshotManager`.
  - Enforces strict filename pattern match (`custom-<uuid>.sqlite3`), regular file status (`!lstat.isSymbolicLink()`), and catalog `byteSize` match prior to worker offloading.
  - Offloads full streaming SHA-256 computation (64 KB chunks) and SQLite `PRAGMA integrity_check` + table schema validation to companion Worker thread (`ecdict-integrity-worker.ts`), preserving Host event-loop responsiveness.
  - Anti-TOCTOU Invariant: Records filesystem identity (`dev`, `ino`, `size`, `mtimeNs`) before opening SQLite connection and re-verifies them after opening. Any change throws `SnapshotTamperingError` fail-closed.
  - Verified across **R01–R07**, **R20**, and **E2E-BR2-05**.

### 2.2 B16: Catalog & Installed ECDICT Durability Failure Semantics
- **Vulnerability**: Catalog mutations (`index.json`) and installed inventory writes (`installed-ecdict.json`) lacked serialization against concurrent writes and lacked rollback compensation upon I/O or durability failures.
- **Resolution**:
  - Introduced `#catalogLock` async mutex queue in `CustomSnapshotManager` serializing all `index.json` read-modify-write transactions, eliminating lost updates during concurrent operations.
  - Introduced fail-closed `CatalogPersistenceError` with code `CATALOG_PERSISTENCE_FAILED`. On catalog write failure during snapshot creation, record is marked `REJECTED` and error is re-thrown without claiming false success.
  - In `ActivationCoordinator.activateManagedDatabase()`, made `writeInstalledEcdictMetadataAtomically()` durable and mandatory. If inventory commit fails, automated rollback compensation executes immediately: active metadata is restored, candidate database is unlinked, and prior dictionary connection is preserved or safely reverted to fixture.
  - Verified across **R08–R12**.

### 2.3 B17: Isolated Multi-Custom Snapshot Lifecycle Across Restart
- **Vulnerability**: Prior tests focused on single custom snapshot lifecycles, leaving multi-snapshot catalog indexing, lease handoffs, and cross-reboot dormant snapshot preservation unverified in real isolated processes.
- **Resolution**:
  - Validated independent catalog tracking of distinct custom snapshots (Snapshot A and Snapshot B) with unique UUIDs.
  - Validated zero ghost leases during alternating active switches (`A -> B -> A -> B`), ensuring leases decrement to 0 immediately upon retirement.
  - Validated cross-process restart persistence: active snapshot B is restored directly on reboot while dormant snapshot A remains indexed as `PUBLISHED_INACTIVE` in catalog and selectable without re-import.
  - Verified across **R13–R15** and **E2E-BR2-01–04**.

### 2.4 B18: Performance Benchmark (100 MiB+) & Real Crash-Window Recoveries
- **Vulnerability**: Large custom SQLite databases (>100 MiB) could block the Node.js event loop or cause RSS memory bloat; crash-window recovery across transition boundaries needed formal verification.
- **Resolution**:
  - **100 MiB+ Benchmark**: Benchmarked with a 107.22 MiB SQLite database containing 1,700 oversized rows. Event loop latency p99 remained at **14.1 ms** (threshold <= 100 ms) and max lag at **14.2 ms** (threshold <= 500 ms). Host RSS memory footprint delta was bounded at **-1.0 MiB** (threshold < 512 MiB) due to zero full-file buffering in the Host process.
  - **Crash-Window Recovery**:
    - *Managed -> Custom*: Crash after `active.json` committed to custom with pending settings sync: `recoverOnStartup` recovers custom mode, restores lookups, and reconciles state safely (**R17**).
    - *Custom -> Managed*: Crash after `active.json` committed to managed-ecdict with pending settings sync: `recoverOnStartup` recovers managed-ecdict mode while dormant custom snapshot remains selectable (**R18**).
    - *Custom -> Fixture*: Crash after `active.json` unlinked: `recoverOnStartup` falls back cleanly to fixture mode while custom snapshots retain catalog integrity (**R19**).
  - Verified across **R16–R19**.

---

## 3. Comprehensive Acceptance Matrix (R01–R20)

| Scenario ID | Category | Description | Actual Observed State | Verdict |
| :---: | :--- | :--- | :--- | :---: |
| **R01** | Content Integrity | Dormant snapshot in catalog passes full worker integrity check and activates successfully | `activeMode=custom`, `snapshotId` confirmed, `lookup(resilience)=true` | **PASS** |
| **R02** | Content Integrity | Dormant snapshot tampered with identical byte size is rejected before activation | `caughtError=SnapshotTamperingError` (digest mismatch), `activeMode=fixture`, `leases=0` | **PASS** |
| **R03** | Content Integrity | Dormant snapshot tampered with different byte size is rejected before activation | `caughtError=SnapshotTamperingError` (byte size mismatch), `activeMode=fixture` | **PASS** |
| **R04** | Content Integrity | Valid SQLite database substituted into dormant snapshot location is rejected by digest match | `caughtError=SnapshotTamperingError` (digest mismatch), `activeMode=fixture` | **PASS** |
| **R05** | Content Integrity | Symlinked or junction snapshot file is rejected before activation | `isSymbolicLink()` catches link, rejected fail-closed, `activeMode=fixture` | **PASS** |
| **R06** | Lease Protection | Worker verification failure preserves existing active dictionary without ghost leases | `caughtError=SnapshotTamperingError`, `lookup(alpha)=true`, `leaseA=1`, `leaseB=0` | **PASS** |
| **R07** | Anti-TOCTOU | TOCTOU race replacement between worker validation and SQLite open is caught fail-closed | `caughtError=SnapshotTamperingError` (pre-open mismatch), `activeMode=fixture`, `leases=0` | **PASS** |
| **R08** | Catalog Durability | Catalog persistence failure does not report false success and preserves published database safely | `caughtError=CatalogPersistenceError`, raw source file intact and unmodified | **PASS** |
| **R09** | Concurrency Mutex | Concurrent snapshot creations do not lose catalog entries due to mutex transaction locking | `catalogEntries=2`, both snapshot IDs indexed, zero lost updates | **PASS** |
| **R10** | Catalog Durability | Safely reconciles published database file missing from catalog without deleting user source | `reconciledInCatalog=true`, user source file exists and intact | **PASS** |
| **R11** | Compensation | ECDICT inventory commit failure triggers rollback compensation to previous active dictionary | `caughtError=Failed to commit installed inventory`, `activeMode=custom`, rollback restored | **PASS** |
| **R12** | Durability | ECDICT activation succeeds strictly in consistency with durable installed inventory metadata | `activeMode=managed-ecdict`, `invDatabaseFile` recorded, `activeMeta` consistent | **PASS** |
| **R13** | Multi-Snapshot | Publishes multiple independent snapshots and tracks distinct entries in catalog | `catalogCount=2`, distinct snapshot UUIDs, initial `leases=0` | **PASS** |
| **R14** | Multi-Snapshot | Switches actively between multiple custom snapshots with zero ghost leases and correct lookups | Alternating switches `B -> A -> B` pass, queries hit active snapshot, leases strictly 1:0 | **PASS** |
| **R15** | Multi-Snapshot | Restores active snapshot B across process reboot while retaining snapshot A selectable in catalog | `activeMode=custom`, `activeSnapshotId=B`, `statusA=PUBLISHED_INACTIVE`, `statusB=ACTIVE` | **PASS** |
| **R16** | Performance SLA | Validates 100 MiB+ SQLite database offloaded to worker within event-loop SLA and bounded RSS | `size=107.22MB`, `p99Lag=14.1ms` (<=100ms), `maxLag=14.2ms` (<=500ms), `rssDelta=-1.0MB` | **PASS** |
| **R17** | Crash Recovery | Recovers safely after crash during Managed to Custom transition window | `recoveredActiveMode=custom`, `lookup(recovery-custom)=true`, metadata reconciled | **PASS** |
| **R18** | Crash Recovery | Recovers safely after crash during Custom to Managed transition window | `recoveredActiveMode=managed-ecdict`, `lookup(managed)=true`, custom snapshot dormant | **PASS** |
| **R19** | Crash Recovery | Recovers safely after crash during Custom to Fixture transition window | `recoveredActiveMode=fixture`, `lookup(derive)=true`, custom snapshot dormant, `leases=0` | **PASS** |
| **R20** | Full Route E2E | Executes complete multi-mode management route and lookup lifecycle E2E | All 8 routes exercised: Status -> Lookup -> Activate A/B -> Select Fixture/A/B -> Status | **PASS** |

---

## 4. Real Isolated DSH 0.2.0-rc.2 Process E2E Verification

The dedicated runner `scripts/test-phase7a8-1br2-e2e.mjs` executed an automated Chromium browser session against a live DSH process booted on isolated port `50998` with a scratch profile:
1. **Multi-Custom Staging & Activation (`E2E-BR2-01`, `02`)**:
   - Staged and published Custom Candidate A (`supernova`).
   - Staged and published Custom Candidate B (`blackhole`).
   - Verified live lookups hit expected dictionary entries for each active candidate.
2. **Cross-Process Reboot Persistence (`E2E-BR2-03`)**:
   - DSH server process killed and rebooted while Snapshot B was active.
   - Upon restart, `activeMode: 'custom'` and `activeSnapshotId: snapBId` were restored immediately without touching user source files.
3. **Multi-Custom Mode Switching (`E2E-BR2-04`)**:
   - Switched from B to dormant A via `POST /select-mode { mode: 'custom', snapshotId: snapAId }`. Lookups on `supernova` succeeded.
   - Switched back from A to B. Lookups on `blackhole` succeeded.
4. **Live Anti-TOCTOU & Tamper Rejection (`E2E-BR2-05`, `06`)**:
   - Tampered dormant published file A on disk.
   - Invoked `POST /select-mode` to activate A.
   - Request was rejected fail-closed with status `500`.
   - Existing active dictionary B remained completely intact and uninterrupted; lookup on `blackhole` answered without fault. Zero ghost leases occurred.
5. **Clean Reversion to Fixture (`E2E-BR2-07`)**:
   - Switched to fixture mode; lookups for `derive` succeeded. Teardown cleaned temporary artifacts safely.

---

## 5. Store Packaging & Distribution Contract

Verification via `npm run verify:store-contract` confirmed that all changes strictly comply with DSH store guidelines:
- **Distribution Closure**: Exactly 8 required files (`lib/index.js`, `lib/client.js`, `lib/ecdict-integrity-worker.js`, `cordis.patch.yml`, `README.md`, `LICENSE`, `corpus/ecdict.manifest.json`, `package.json`).
- **Dependencies**: Exactly 0 runtime dependencies (`dependencies: {}`).
- **Permissions**: `files` (expected SQLite access) and `network` (same-origin host routes). Zero credentials, commands, dynamic code loading, or unauthorized permissions.
- **Worker Concurrency**: Companion worker threads strictly constrained to `ecdict-integrity-worker.ts` with static path resolution.

---

## 6. Audit Sign-Off

All requirements for Phase 7A.8.1BR2 have been fulfilled in full. Findings B15–B18 are completely resolved with verified fail-closed security invariants, transactional catalog durability, bounded event-loop SLAs, and zero regressions across the entire test baseline.

- **Phase Status**: COMPLETED & VERIFIED
- **Overall Verdict**: PASS
