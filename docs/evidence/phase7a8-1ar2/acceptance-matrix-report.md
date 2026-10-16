# Phase 7A.8.1AR2 Lifecycle Acceptance & Audit Closure Report

**Phase**: 7A.8.1AR2 — Snapshot Lease Atomicity, Cleanup Ownership & Evidence Closure  
**Tested Code SHA**: `492a92f68e17018339ca653c0841cf5bd33dcc8f`  
**Start Baseline SHA**: `7312929dfaee90569032ddafe39d27a6342f6b51`  
**Execution Timestamp**: `2026-10-16T14:40:00Z`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 x64, DSH `0.2.0-rc.2`  
**Verification Framework**: Vitest `v3.2.4`, Isolated DSH Runner, npm CLI v11.1.0  

---

## 1. Executive Summary

Phase 7A.8.1AR2 resolves four critical audit findings (B7, B8, B9, B10) identified during the review of Phase 7A.8.1AR. All 12 dedicated acceptance scenarios (**L01–L12**) and all 23 lifecycle regression scenarios (**R01–R22**) have been executed against `PHASE_7A_8_1AR2_TESTED_CODE_SHA` (`492a92f68e17018339ca653c0841cf5bd33dcc8f`) with **100% PASS** rates.

Furthermore, full DSH Store lifecycle verification (Install, Start, Uninstall, Rollback) was successfully executed in an isolated sandbox environment, confirming zero runtime regressions and strict store contract compliance.

---

## 2. Audit Finding Closures (B7–B10)

### 2.1 Finding B7: Mutual Exclusion & Synchronous State Transition (Cleanup vs. Open)
- **Defect**: In previous iterations, `cleanupSnapshot` performed an asynchronous boundary before altering the snapshot state, allowing a concurrent `openSnapshotDictionary` call to acquire a lease and open an SQLite handle on a file that was about to be unlinked.
- **Architectural Solution**:
  1. **Synchronous Transition**: `cleanupSnapshot` immediately updates the snapshot state to `CLEANUP_PENDING` before any `await` or asynchronous I/O operation.
  2. **Open Gate Rejection**: `openSnapshotDictionary` checks the state synchronously and unconditionally throws an error if the state is `CLEANUP_PENDING`, `DELETED`, `RETIRING`, or any non-published state.
  3. **Atomic In-Flight Deduplication**: Concurrent invocations of `cleanupSnapshot` for the same snapshot share the active in-flight promise (`#inFlightCleanups`), preventing double unlinks and redundant validations.
- **Verification Scenarios**: `L01`, `L03`, `R04`, `R05`.

### 2.2 Finding B8: Transactional Lease Reservation & Fail-Safe Close Wrapper
- **Defect**: An exception thrown during `openSqliteDictionary` (e.g. disk corruption, locked handle, or invalid header) after incrementing the active lease counter left the lease incremented or the state stuck in `ACTIVE` without an open dictionary instance. Additionally, errors during dictionary closing could bypass lease decrements.
- **Architectural Solution**:
  1. **Transactional Rollback**: `openSnapshotDictionary` records prior lease count and state before reservation. If `openSqliteDictionary` throws, the catch block rolls back the lease count by decrementing it and restoring the prior state (`PUBLISHED_INACTIVE` or prior active state).
  2. **Fail-Safe Close Wrapper**: The returned `Dictionary` wrapper wraps `dict.close()` in a `try...finally` block ensuring that the snapshot manager's active lease counter is decremented exactly once, even if the underlying SQLite close operation throws.
  3. **Close Idempotency**: Subsequent calls to `dict.close()` are guarded by a local boolean flag and become safe no-ops without negative lease counts.
- **Verification Scenarios**: `L02`, `L04`, `L05`, `L06`, `R06`.

### 2.3 Finding B9: Fail-Closed Staging Ownership & Long-Running Manager Protection
- **Defect**: Staging ownership markers were prone to deletion if an operation exceeded 1 hour, even if the manager was actively building a large database. Missing or corrupted owner files were silently deleted or mishandled.
- **Architectural Solution**:
  1. **Staging Ownership Schema v1**: Every staging `.owner` file contains:
     ```json
     {
       "version": 1,
       "managerId": "<uuid>",
       "snapshotId": "<uuid>",
       "pid": 12345,
       "processStartTime": 1792160000000,
       "createdAt": 1792160100000,
       "hostInstanceId": "<uuid>"
     }
     ```
  2. **Fail-Closed Creation**: If writing the `.owner` file with exclusive flag (`wx`) fails, snapshot creation aborts immediately and staging tracking is purged.
  3. **In-Process Active Manager Protection**: An in-process registry (`ACTIVE_MANAGERS`) tracks alive managers. If a staging file belongs to a live manager in the current process, it is protected from deletion regardless of elapsed time (>1h).
  4. **Fail-Closed Unverified Recovery**: Files with missing or malformed `.owner` files are strictly protected from deletion during standard scans. They can only be reclaimed when `allowUnverifiedRecovery: true` is explicitly provided.
  5. **PID Reuse Protection**: `hostInstanceId` prevents confusing recycled operating system PIDs with active instances.
- **Verification Scenarios**: `L07`, `L08`, `L09`, `L10`, `R20`.

### 2.4 Finding B10: Reparse Point Ancestor Traversal & Capability Probing
- **Defect**: Previous tests claimed symlink/junction acceptance without probing OS capability privileges, and `validateCustomSnapshotPath` only inspected the immediate snapshot directory rather than resolving ancestor directory junctions. ECDICT and Fixture tests were bundled into a single scenario.
- **Architectural Solution**:
  1. **Ancestor Directory Traversal**: `validateCustomSnapshotPath` iteratively climbs the directory tree up to the filesystem root, validating that neither the target file, nor its parent directory, nor any ancestor directory is a symbolic link or junction, even if intermediate directories do not yet exist (`ENOENT`).
  2. **Explicit Capability Detection & Taxonomy**: Capability probes detect file symlink and junction support. If privileges are missing, the test reports `NOT_EXECUTED` (`ENVIRONMENT_UNAVAILABLE`) rather than a false `PASS`.
  3. **Acceptance Decoupling**: R22 is formally split into `R22A` (Built-in Fixture compatibility) and `R22B` (Managed ECDICT production schema compatibility).
- **Verification Scenarios**: `L11`, `L12`, `R16`, `R22A`, `R22B`.

---

## 3. Dedicated Acceptance Matrix (L01–L12)

The dedicated test suite `tests/phase7a8-1ar2-scenarios.spec.ts` and probe `scripts/probes/phase7a8-1ar2/l01-l12-acceptance-matrix.mjs` confirm the following results:

| Scenario | Objective | Status | Evidence Level | Observed State Summary |
| :--- | :--- | :---: | :---: | :--- |
| **L01** | `cleanupSnapshot` acquires ownership -> `openSnapshotDictionary` strictly refused | `PASS` | `RUNTIME_CONFIRMED` | `observedStateInCleanup=CLEANUP_PENDING, openRejected=true, finalState=DELETED, fileDeleted=true` |
| **L02** | `openSnapshotDictionary` acquires lease -> `cleanupSnapshot` rejected | `PASS` | `RUNTIME_CONFIRMED` | `cleanupRejected=true, lookupDuringActive=true, cleanupAfterRelease=true` |
| **L03** | Concurrent `cleanupSnapshot` calls are atomic and idempotent | `PASS` | `RUNTIME_CONFIRMED` | `concurrentResults=[true,true], subsequentResult=true, validateCalls=1, unlinkCalls=1` |
| **L04** | Open failure transactionally rolls back lease reservation | `PASS` | `RUNTIME_CONFIRMED` | `openThrewA=true, leasesA=0, stateA=PUBLISHED_INACTIVE, openThrewB=true, leasesB=0, stateB=PUBLISHED_INACTIVE, postCleanup=true` |
| **L05** | Open failure and cleanup interleave cleanly without corruption | `PASS` | `RUNTIME_CONFIRMED` | `openThrew=true, leases=0, cleanupResult=true, state=DELETED` |
| **L06** | Duplicate close and close engine errors handled safely | `PASS` | `RUNTIME_CONFIRMED` | `leasesAfterDuplicateClose=0, closeThrew=true, leasesAfterError=0` |
| **L07** | Staging owner file creation failure fails closed | `PASS` | `RUNTIME_CONFIRMED` | `creationRejected=true, snapshotsCount=0, remainingStaging=0` |
| **L08** | Active staging older than 1h is not deleted while manager alive | `PASS` | `RUNTIME_CONFIRMED` | `manager1Success=true, manager2CleanedFiles=0, stagingSurvives=true` |
| **L09** | Missing/malformed owner records fail closed | `PASS` | `RUNTIME_CONFIRMED` | `defaultCleaned=0, unverifiedSurvives=true, recoveredCount=3, reclaimed=true` |
| **L10** | Multi-manager / PID reuse protection reclaims dead orphans | `PASS` | `RUNTIME_CONFIRMED` | `cleaned=1, deadStagingRemoved=true` |
| **L11** | Symlink/junction capability verification and taxonomy | `PASS` | `RUNTIME_CONFIRMED` | `symlinkSupported=true, caughtFileSymlink=true, caughtDirJunction=true` |
| **L12** | Fixture and Managed ECDICT independent regression verification | `PASS` | `RUNTIME_CONFIRMED` | `fixture={source:sqlite-fixture,headword:true,form:true}, ecdict={source:ecdict-local,headword:true,translation:苹果,form:true}` |

**Dedicated Matrix Summary**: 12 Total | **12 Passed** | **0 Failed**

---

## 4. Regression Acceptance Matrix (R01–R22)

Executed via `scripts/probes/phase7a8-1ar/r01-r22-acceptance-matrix.mjs` on `PHASE_7A_8_1AR2_TESTED_CODE_SHA`:

| Scenario ID | Description | Status | Evidence Level |
| :--- | :--- | :---: | :---: |
| **R01** | Same identity repeat publish does not overwrite previous files | `PASS` | `RUNTIME_CONFIRMED` |
| **R02** | Concurrent publish operations with identical identity | `PASS` | `RUNTIME_CONFIRMED` |
| **R03** | Publish destination path collision detection | `PASS` | `RUNTIME_CONFIRMED` |
| **R04** | Active snapshot cleanup refusal while leases active | `PASS` | `RUNTIME_CONFIRMED` |
| **R05** | Safe snapshot cleanup after release of final dictionary lease | `PASS` | `RUNTIME_CONFIRMED` |
| **R06** | Windows/POSIX lifecycle semantics and duplicate close safety | `PASS` | `RUNTIME_CONFIRMED` |
| **R07** | Large file SHA-256 calculation does not block Host event-loop | `PASS` | `RUNTIME_CONFIRMED` |
| **R08** | Snapshot tampering detection between hashing and publishing | `PASS` | `RUNTIME_CONFIRMED` |
| **R09** | SQLite transaction concurrency and snapshot consistency | `PASS` | `RUNTIME_CONFIRMED` |
| **R10** | Source database mutations during snapshot creation | `PASS` | `RUNTIME_CONFIRMED` |
| **R11** | Tampering detection after staging verification | `PASS` | `RUNTIME_CONFIRMED` |
| **R12** | Publish failure compensation and rollback | `PASS` | `RUNTIME_CONFIRMED` |
| **R13** | Worker non-zero abnormal exit handling | `PASS` | `RUNTIME_CONFIRMED` |
| **R14** | Worker clean exit without response message handling | `PASS` | `RUNTIME_CONFIRMED` |
| **R15** | Worker cancellation race condition handling | `PASS` | `RUNTIME_CONFIRMED` |
| **R16** | Symlink and directory junction boundary protection | `PASS` | `RUNTIME_CONFIRMED` |
| **R17** | CustomSnapshotManager disposal during creation phase | `PASS` | `RUNTIME_CONFIRMED` |
| **R18** | CustomSnapshotManager disposal during verification phase | `PASS` | `RUNTIME_CONFIRMED` |
| **R19** | CustomSnapshotManager disposal during publishing phase | `PASS` | `RUNTIME_CONFIRMED` |
| **R20** | Multi-manager staging ownership isolation | `PASS` | `RUNTIME_CONFIRMED` |
| **R21** | User source database byte-for-byte immutability | `PASS` | `RUNTIME_CONFIRMED` |
| **R22A** | Built-in Fixture backward compatibility | `PASS` | `RUNTIME_CONFIRMED` |
| **R22B** | Managed ECDICT database query compatibility | `PASS` | `RUNTIME_CONFIRMED` |

**Regression Matrix Summary**: 23 Total | **23 Passed** | **0 Failed**

---

## 5. DSH Store-1306 Lifecycle Verification

Executed via `scripts/store-lifecycle-verify.mjs` against the clean commit SHA `492a92f68e17018339ca653c0841cf5bd33dcc8f`:

```
=== STORE-1306 Lifecycle Verification Summary ===
INSTALL:   PASS (installed to C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home\profiles\word-lookup-test\node_modules\dsh-word-lookup, junction=false, version=0.2.0)
START:     PASS (HTTP 200, session authenticated, card rendered, headword="derive")
UNINSTALL: PASS (packageDirRemoved=true, route404=true, clientAbsent=true)
ROLLBACK:  PASS (reverted to v0.1.0 tarball, headword="derive", card visible)
OVERALL:   ALL LIFECYCLE OPERATIONS PASSED
```

- **Candidate Tarball SHA-256**: `6e24c17e5cff6b113ceb72e9cdce46115b6960d32f9d0f1659750ac086820591`
- **Isolation Invariant**: Verified zero collisions with production ports (`19387`, `50001`) or home directories (`C:\Users\20659\.dsh`).

---

## 6. Architecture & Security Invariants Verification

1. **No External Credentials**: `npm run scan:credentials` verified 590 files with zero leaked credentials or environment tokens.
2. **Pack Surface Hygiene**: Pack tarball dry-run confirmed exactly 8 distributed files (`lib/index.js`, `lib/client.js`, `lib/ecdict-integrity-worker.js`, `cordis.patch.yml`, `README.md`, `LICENSE`, `corpus/ecdict.manifest.json`, `package.json`). Zero devDependencies, zero build artifacts, zero raw sqlite files.
3. **Single Worker Bundle Contract**: Maintained single companion worker (`lib/ecdict-integrity-worker.js`) without introducing auxiliary workers.
4. **Prohibitions Honored**:
   - Phase 7A.8.1B was not started.
   - Custom activation API was not modified.
   - Client shortcuts were not modified.
   - npm publish was not performed.
   - Git rebase, reset, and force-push were strictly avoided.

---

## 7. Evidence Manifest

- `docs/evidence/phase7a8-1ar2/l01-l12-evidence.json`: Machine-readable output of dedicated acceptance matrix (L01–L12).
- `docs/evidence/phase7a8-1ar2/r01-r22-evidence.json`: Machine-readable output of full regression matrix (R01–R22).
- `docs/evidence/phase7a8-1ar2/store-lifecycle-evidence.json`: Full machine-readable DSH store lifecycle execution record bound to `492a92f68e17018339ca653c0841cf5bd33dcc8f`.
- `docs/evidence/phase7a8-1ar2/acceptance-matrix-report.md`: This authoritative closure report.
