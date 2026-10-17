# Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Persistent Snapshot Catalog Repair Evidence Report

**Document Version**: 1.0.0  
**Phase**: Phase 7A.8.1BR (Remediation & Acceptance)  
**Target Repository**: `dsh-word-lookup`  
**Target Commit A (Implementation & Tests)**: `2f304f0377ae93c3d9553a314cdde1d86f6e0678`  
**Upstream Target**: DeepSeek Harness `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`)  
**Execution Environment**: Windows 11 / Node.js `v24.13.0` / Playwright Chromium  
**Execution Date**: 2026-10-17  
**Overall Status**: **100% PASS (ALL GATES CLEARED)**

---

## 1. Executive Summary

Phase 7A.8.1BR completes the remediation of defects B11–B14 and consistency checks C1–C4 identified in Phase 7A.8.1B. It establishes a resilient, production-grade custom SQLite dictionary lifecycle subsystem within DeepSeek Harness (`dsh-word-lookup`), strictly maintaining:
1. **Inventory Isolation (B11)**: Complete decoupling of installed physical inventory (`installed-ecdict.json`) from active dictionary selection (`active.json`), enabling non-disruptive ECDICT installations while Custom mode is active.
2. **Zero Whole-File Buffering in Host Thread (B04, B12, C1)**: Candidate database verification, snapshot validation, and startup recovery digest computations strictly offloaded to the companion worker thread via streaming chunks. Host thread RSS remains bounded (< 512 MiB), and event-loop lag remains under p99 <= 100 ms.
3. **Intent Recovery Priority (B13, B14)**: Crash-consistent recovery prioritizes durable commits in `active.json` whenever settings synchronization is unconfirmed (`settingsSyncPending`). Confirmed settings synchronization honors explicit user configuration.
4. **Persistent Snapshot Catalog & Degradation Safety (B06–B10, B20, B21)**: Catalog stored at `custom-snapshots/index.json` maintains atomic updates, strict UUID-to-filename bindings (`custom-${snapshotId}.sqlite3`), corruption safe-degradation, and legacy active snapshot auto-migration.
5. **Active Lease Protection (B22)**: Snapshots in active use cannot be cleaned up or deleted until all leases are released.
6. **Path Redaction & Sanitization (B27, C2)**: Full recursive sanitization of error messages and structured details across all management routes.
7. **Clean Disposer Lifecycle (B26, C3)**: Asynchronous `dispose()` across `DictionaryOperationManager` and `ActivationCoordinator` awaiting snapshot manager and companion worker clean exit.

---

## 2. Acceptance Matrix B01–B28 Results

All 28 acceptance scenarios passed on Commit A (`2f304f0377ae93c3d9553a314cdde1d86f6e0678`).

| Scenario ID | Category | Description | Gate Type | Result |
| :--- | :--- | :--- | :---: | :---: |
| **B01** | Worker Offload | Candidate DB verification offloads to worker thread without blocking Host event loop | **HARD GATE** | **PASS** |
| **B02** | Validation | Candidate DB verification rejects non-existent database file with `FILE_NOT_FOUND` | Standard | **PASS** |
| **B03** | Validation | Candidate DB verification rejects missing required tables with `INVALID_DATABASE_SCHEMA` | Standard | **PASS** |
| **B04** | Memory Bounds | Zero whole-file buffers in Host thread during candidate verification and custom startup recovery | **HARD GATE** | **PASS** |
| **B05** | Immutability | Candidate DB verification is strictly read-only and preserves user raw database unchanged | Standard | **PASS** |
| **B06** | Catalog Lifecycle | Publish snapshot creates `custom-<uuid>.sqlite3` and atomically writes entry to `custom-snapshots/index.json` | Standard | **PASS** |
| **B07** | Security Gate | Strict UUID-to-filename binding check (`databaseFile === custom-${snapshotId}.sqlite3`) enforced | **HARD GATE** | **PASS** |
| **B08** | Catalog Persistence | Writes custom snapshot catalog atomically via temporary file and atomic replace | Standard | **PASS** |
| **B09** | Catalog Metadata | Snapshot catalog entry correctly records all schema version, digest, size, and entry counts | Standard | **PASS** |
| **B10** | Catalog Cleanup | Cleaning up an inactive snapshot atomically removes it from `custom-snapshots/index.json` | Standard | **PASS** |
| **B11** | Inventory Isolation | Installing ECDICT while Custom is active commits `installed-ecdict.json` without overwriting active Custom mode | Standard | **PASS** |
| **B12** | Route Inspection | Status handler exposes installed ECDICT inventory and `customSnapshots` while activeMode is `custom` | Standard | **PASS** |
| **B13** | Intent Recovery | Startup recovery recovers committed Custom mode when settings sync was unconfirmed/pending | **HARD GATE** | **PASS** |
| **B14** | Intent Recovery | Startup recovery recovers committed Managed ECDICT mode when settings sync was unconfirmed/pending | **HARD GATE** | **PASS** |
| **B15** | User Intent | Confirmed settings sync honors user choice of fixture mode while preserving installed ECDICT inventory | Standard | **PASS** |
| **B16** | Snapshot State | Startup recovery adopts published snapshot into `CustomSnapshotManager` tracking state cleanly | Standard | **PASS** |
| **B17** | Fault Handling | Startup recovery detects corrupt custom snapshot file via worker, records `recoveryError`, and falls back to fixture | Standard | **PASS** |
| **B18** | Fault Handling | Startup recovery detects missing custom snapshot file on disk, records `recoveryError`, and falls back to fixture | Standard | **PASS** |
| **B19** | Fault Handling | Startup recovery degrades safely when `active.json` is corrupt, falling back to fixture without throwing | Standard | **PASS** |
| **B20** | Fault Degradation | Corrupted `custom-snapshots/index.json` safely degrades without crashing snapshot manager or coordinator | **HARD GATE** | **PASS** |
| **B21** | Migration | Missing catalog automatically migrates and recreates `index.json` from active custom metadata | Standard | **PASS** |
| **B22** | Lease Safety | Snapshot with active leases cannot be deleted or cleaned up via `cleanupSnapshot` | **HARD GATE** | **PASS** |
| **B23** | Mode Switching | Switching from custom to managed-ecdict releases custom lease and switches active dictionary | Standard | **PASS** |
| **B24** | Mode Switching | Switching from managed-ecdict to custom acquires custom lease and switches active dictionary | Standard | **PASS** |
| **B25** | Hot-Swap Safety | Hot-swap between custom-A and custom-B transfers leases atomically with uninterrupted lookups | Standard | **PASS** |
| **B26** | Disposer Safety | `coordinator.dispose()` cleanly awaits `customSnapshotManager` disposal and companion worker shutdown | Standard | **PASS** |
| **B27** | Route Redaction | Route error responses sanitize internal machine paths from error messages and structured details | Standard | **PASS** |
| **B28** | Concurrency Lock | Unified concurrency mutex rejects concurrent operations with `OperationInProgressError` (409) | **HARD GATE** | **PASS** |

---

## 3. Defects Remediated & Consistency Checks

### 3.1 Defects B11–B14 Remediated
- **Defect B11 (Inventory Isolation Breakage)**: Previously, installing ECDICT while Custom mode was active switched `active.json` and `DictionaryManager` to `managed-ecdict`.
  - *Fix*: `activateManagedDatabase` checks `currentMode === 'custom'`. If active, it commits `installed-ecdict.json` and updates `#cachedInstalledCorpus` without modifying `active.json` or changing `DictionaryManager`.
- **Defect B12 (Whole-File Buffers on Host Thread during Recovery)**: Previously, custom startup recovery computed SHA-256 via `readFile(snapPath)` in the Host thread.
  - *Fix*: Snapshot verification during recovery offloads to the companion worker thread via `validatePublishedSnapshot`, streaming chunks in worker memory and keeping the Host thread zero-buffered.
- **Defect B13 (Intent Inversion for Custom Recovery)**: Incomplete settings sync previously allowed Host Config `dictionaryMode: 'fixture'` to override a durably committed Custom dictionary.
  - *Fix*: Startup recovery checks `settingsSyncPending`. When pending, durable `active.json` takes precedence and re-syncs to Host Config.
- **Defect B14 (Intent Inversion for Managed ECDICT Recovery)**: Similar to B13 for Managed ECDICT mode.
  - *Fix*: Unconfirmed settings sync for Managed ECDICT mode restores `managed-ecdict` and retries configuration sync.

### 3.2 Consistency Checks C1–C4 Remediated
- **Check C1 (`verifyCustomDatabase` Offloading)**: Rewritten to offload candidate validation directly to the companion worker via `customSnapshotManager.validateCandidateDatabase`.
- **Check C2 (Route Error Detail Sanitization)**: Implemented recursive `sanitizeDetails` and `sanitizeValue` in `dictionary-management-route.ts` to sanitize machine paths in structured details.
- **Check C3 (Async Disposer Clean Exit)**: `coordinator.dispose()` and `operationManager.dispose()` converted to `async`, awaiting `customSnapshotManager.dispose()` and companion worker thread termination.
- **Check C4 (Strict UUID-to-Filename Binding)**: `validateActiveMetadata` and `validateCustomSnapshotCatalog` strictly enforce that `databaseFile === custom-${snapshotId}.sqlite3`.

---

## 4. Test Verification Evidence

### 4.1 Matrix B01–B28 Execution (`tests/phase7a8-1br-activation-recovery.spec.ts`)
```
 RUN  v3.2.4 E:/Projects/DSHarness/dsh-word-lookup

 ✓ tests/phase7a8-1br-activation-recovery.spec.ts (28 tests) 13039ms
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B01: candidate database verification offloads to worker and returns valid schema and count without blocking Host
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B02: candidate database verification rejects non-existent database file with FILE_NOT_FOUND
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B03: candidate database verification rejects database missing required tables with INVALID_DATABASE_SCHEMA
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B04: verifies candidate database and startup recovery via worker without whole-file buffering in Host thread
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B05: candidate verification is strictly read-only and preserves user raw database unchanged
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B06: publish snapshot creates custom-<uuid>.sqlite3 and records entry in custom-snapshots/index.json
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B07: strict UUID-to-filename binding rejects mismatches between snapshotId and databaseFile
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B08: writes custom snapshot catalog atomically via temporary file and atomic replace
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B09: snapshot catalog entry correctly records all schema and count fields
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B10: cleaning up an inactive snapshot atomically removes it from custom-snapshots/index.json
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B11: installing ECDICT while Custom mode is active commits installed-ecdict.json without overwriting active Custom mode
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B12: status handler exposes installed ECDICT inventory and customSnapshots while activeMode is custom
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B13: startup recovery recovers committed Custom mode when settings sync was unconfirmed/failed
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B14: startup recovery recovers committed Managed ECDICT mode when settings sync was unconfirmed/failed
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B15: confirmed settings sync honors user choice of fixture mode while preserving installed ECDICT inventory
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B16: startup recovery adopts published snapshot into CustomSnapshotManager tracking state cleanly
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B17: startup recovery detects corrupt custom snapshot file via worker, records recoveryError, and falls back to fixture
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B18: startup recovery detects missing custom snapshot file, records recoveryError, and falls back to fixture
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B19: startup recovery degrades safely when active.json is corrupt, falling back to fixture without throwing
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B20: corrupted custom-snapshots/index.json safely degrades without crashing CustomSnapshotManager or ActivationCoordinator
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B21: missing catalog automatically migrates and recreates index.json from active custom metadata
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B22: cannot clean up snapshot while active dictionary references exist
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B23: switching from custom to managed-ecdict releases custom lease and switches active dictionary
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B24: switching from managed-ecdict to custom acquires custom lease and switches active dictionary
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B25: hot-swap between custom-A and custom-B transfers leases atomically with uninterrupted lookups
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B26: coordinator.dispose() cleanly awaits customSnapshotManager disposal and worker shutdown
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B27: route error responses sanitize internal machine paths from error message and details
   ✓ Phase 7A.8.1BR: Activation Recovery, Inventory Isolation & Catalog Repair (B01–B28) > B28: unified concurrency mutex rejects concurrent operations with OperationInProgressError

Test Files  1 passed (1)
     Tests  28 passed (28)
```

### 4.2 Comprehensive Project Test Suite
```
Test Files  58 passed (58)
     Tests  1024 passed (1024)
  Duration  82.4s
```

### 4.3 Package Bundle Invariant Check (`scripts/check-bundle.mjs`)
```
check-bundle: 101/101 checks passed
```

### 4.4 Real Isolated DSH Process E2E Verification (`scripts/test-phase7a8-1b-e2e.mjs`)
```
=== Phase 7A.8.1B Real Isolated DSH Custom Activation & 3-Mode Switching E2E ===

ISOLATION CHECK: PASS
Scratch home: C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home

Prepared isolated profile word-lookup-test with candidate plugin at C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home\profiles\word-lookup-test\node_modules\dsh-word-lookup
Created user candidate database at: C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\user-data\user-custom-dict.sqlite3 (49152 bytes, sha256: 35bf58f08840a0f6...)
Booting isolated DSH process on port 50998...
DSH booted successfully at: http://127.0.0.1:50998/?token=<redacted>

--- Part 1 (E2E-01): HostConnectionService Unauthenticated Request Fence ---
  PASS: Anonymous POST /api/dsh-word-lookup -> 401 Unauthorized
  PASS: Anonymous GET /api/dsh-word-lookup/dictionary/status -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/install -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/cancel -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/remove -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/verify -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/activate-custom -> 401 Unauthorized
  PASS: Anonymous POST /api/dsh-word-lookup/dictionary/select-mode -> 401 Unauthorized

--- Part 2: Authenticated Browser Session ---
  PASS: Client runtime mounted and authenticated session established

--- Part 3 (E2E-02): Initial Status & Capabilities ---
  PASS: GET /dictionary/status -> 200 OK (activeMode: 'fixture', canActivateCustom: true, canSwitchMode: true)
  PASS: POST /api/dsh-word-lookup -> 200 OK (source: 'sqlite-fixture', headword: 'derive')

--- Part 4 (E2E-03): Management Protocol Gating & Negative Cases ---
  PASS: Missing path POST /dictionary/activate-custom -> 400 INVALID_PATH
  PASS: Invalid identity POST /dictionary/activate-custom -> 400 INVALID_ARGUMENT
  PASS: Invalid mode POST /dictionary/select-mode -> 400 INVALID_ARGUMENT
  PASS: Missing snapshotId POST /dictionary/select-mode -> 400 INVALID_ARGUMENT
  PASS: Uninstalled ECDICT POST /dictionary/select-mode -> 400 ECDICT_NOT_INSTALLED

--- Part 5 (E2E-04 & E2E-05): Custom Activation & Source Read-Only Invariant ---
  PASS (E2E-05): POST /dictionary/activate-custom -> 200 OK (snapshotId: 5237ef28-6e84-4068-96f8-a81864ca55cd, activeMode: 'custom')
  PASS (E2E-04): User SQLite source file remains completely intact and unmodified (hash & size preserved)

--- Part 6 (E2E-06): Custom Lookups & Status Verification ---
  PASS: GET /dictionary/status reflects activeMode: 'custom' with snapshotId: 5237ef28-6e84-4068-96f8-a81864ca55cd
  PASS (E2E-06): Custom lookup POST /api/dsh-word-lookup -> 200 OK (source: 'custom-local', headword: 'phenomenon')

--- Part 7 (E2E-07): Safe Three-Mode Switching ---
  PASS (E2E-07): Switch to fixture POST /dictionary/select-mode -> 200 OK (activeMode: 'fixture')
  PASS (E2E-07): Lookup 'phenomenon' on fixture mode -> found: false (reverted cleanly)
  PASS (E2E-07): Switch back to custom POST /dictionary/select-mode -> 200 OK (activeMode: 'custom')
  PASS (E2E-07): Lookup 'phenomenon' hits again in restored custom mode (found: true)

--- Part 8 (E2E-08): Cross-Process Restart Persistence & Recovery ---
Stopping DSH process while Custom Dictionary is active...
Re-booting DSH on port 50998 to test startup recovery...
DSH rebooted successfully at: http://127.0.0.1:50998/?token=<redacted>
  PASS (E2E-08): Post-restart status directly restored activeMode: 'custom' with snapshotId: 5237ef28-6e84-4068-96f8-a81864ca55cd
  PASS (E2E-08): Post-restart lookup for 'phenomenon' -> 200 OK (found: true, source: 'custom-local')

--- Part 9 (E2E-09): Reversion to Fixture & Final Teardown ---
  PASS (E2E-09): Reverted to fixture before exit (activeMode: 'fixture')
  PASS (E2E-09): Final status verified clean (activeMode: 'fixture', activeSnapshotId: null)

Machine-readable evidence saved to: docs/evidence/phase7a8-1b-e2e-evidence.json

======================================================================
ALL PHASE 7A.8.1B REAL ISOLATED DSH E2E INVARIANTS VERIFIED (PASS)
======================================================================
```

---

## 5. Architectural & Store Boundary Invariants

1. **Production File Quota**: Exactly 8 production distribution files:
   - `lib/index.js`
   - `lib/client.js`
   - `lib/ecdict-integrity-worker.js`
   - `cordis.patch.yml`
   - `README.md`
   - `LICENSE`
   - `corpus/ecdict.manifest.json`
   - `package.json`
2. **Worker Isolation**: Exactly 1 companion worker thread (`ecdict-integrity-worker.js`). Zero dynamic worker instantiation.
3. **External Dependencies**: Zero new runtime dependencies added. Peer dependencies remain pinned to `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`.
4. **Credential Security**: Zero tokens, passwords, keys, or user source file paths leaked into logs or serialized responses.
5. **No Premature Phase Triggering**: Phase 7A.8.2 UI components, npm publishing, git tags, and release tags have not been started.
