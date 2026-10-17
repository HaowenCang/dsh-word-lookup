# Phase 7A.8.1B: Custom Dictionary Activation API, Transaction Persistence & Safe Three-Mode Switching Architecture

**Status**: APPROVED & IMPLEMENTED (PHASE 7A.8.1B)  
**Author**: DSH Word Lookup Engineering Team  
**Upstream Target**: DeepSeek Harness `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`)  
**Repository Baseline**: `7312bf2c16f69aba7a6edafe49fd9ccb39bf4057` (`origin/master` / `master`)  
**Execution Date**: 2026-10-17  

---

## 1. Executive Summary

Phase 7A.8.1B delivers the production host-side activation and operational switching subsystem for custom user SQLite dictionaries in `dsh-word-lookup`. Building on the secure snapshot staging, worker-thread validation, and publishing engine delivered in Phase 7A.8.1A / 7A.8.1AR / 7A.8.1AR2, Phase 7A.8.1B integrates snapshot lifecycle management into the runtime `ActivationCoordinator` and `DictionaryOperationManager`.

### Key Architectural Deliverables
1. **Production Custom Activation API**: Exposes `POST /api/dsh-word-lookup/dictionary/activate-custom` accepting user candidate database paths or published snapshot IDs.
2. **Safe Three-Mode Switching API**: Exposes `POST /api/dsh-word-lookup/dictionary/select-mode` supporting seamless, uninterrupted switching between `fixture`, `managed-ecdict`, and `custom` modes (including `custom-A` to `custom-B`).
3. **Decoupled ECDICT Inventory & Active Selection**: Decoupled `installed-ecdict.json` (tracking physical presence of downloaded ECDICT) from `active.json` (tracking the current active dictionary selection).
4. **Remove-While-Custom Semantics**: Executing `removeManagedDatabase()` while `custom` mode is active cleans up the managed ECDICT database and removes `installed-ecdict.json` without disrupting the active custom dictionary or modifying `active.json`.
5. **Unified Concurrency Mutex & Cancellation Boundaries**: Unified transaction locking across `install`, `remove`, `activate-custom`, and `select-mode` operations under `DictionaryOperationManager`, enforcing that cancellation cannot be performed after entering the atomic commit boundary (`onCommitBoundary`).
6. **Snapshot Lease Protection & Uninterrupted Lookups**: Leases are acquired prior to opening database connections and released only after retirement and handle closure, ensuring hot-swaps never drop lookups or fail open queries.
7. **Trusted Startup Recovery**: Startup recovery verifies published custom snapshots directly from `custom-snapshots/custom-<id>.sqlite3` using recorded metadata digests, eliminating any runtime dependency on raw user paths.

---

## 2. Decoupled Storage Schema & Inventory Architecture

### 2.1 File System Topology
Under `~/.dsh/storages/dsh-word-lookup/`:
- `active.json`: Atomic pointer to currently active dictionary (`ActiveMetadata`).
- `installed-ecdict.json`: Atomic inventory record tracking installed ECDICT corpus.
- `databases/ecdict-<version>.sqlite3`: Managed ECDICT database file.
- `custom-snapshots/custom-<uuid>.sqlite3`: Published immutable custom snapshots.
- `custom-snapshots/staging-<uuid>.sqlite3`: Ephemeral snapshot staging files.
- `custom-snapshots/ownership.json`: State machine tracking active staging ownership.

### 2.2 ActiveMetadata Discriminated Union
```typescript
export type ActiveMetadata =
  | ManagedActiveMetadata
  | CustomActiveMetadata

export interface CustomActiveMetadata {
  readonly version: 1
  readonly activeMode: 'custom'
  readonly identity: string
  readonly snapshotId: string
  readonly databaseFile: string
  readonly source: {
    readonly name: 'custom-local'
    readonly schemaVersion: number
  } | 'custom-local'
  readonly sha256: string
  readonly byteSize: number
  readonly settingsSynced?: boolean
  readonly settingsSyncState?: 'synced' | 'pending' | 'failed'
}

export interface InstalledEcdictMetadata {
  readonly version: 1
  readonly identity: string
  readonly databaseFile: string
  readonly source: CorpusSourceManifest
  readonly installedAt: string
  readonly byteSize: number
  readonly sha256: string
}
```

---

## 3. Three-Mode Operational State Machine

```
              ┌────────────────────────────────────────────────────────┐
              │                                                        │
              ▼                                                        │
      ┌───────────────┐         selectMode('managed-ecdict')         ┌────────────────────┐
      │               ├─────────────────────────────────────────────►│                    │
      │    fixture    │                                              │   managed-ecdict   │
      │               │◄─────────────────────────────────────────────┤                    │
      └──┬────────────┘           selectMode('fixture')              └─────────┬──────────┘
         │        ▲                                                            │        ▲
         │        │                                                            │        │
activate-│        │selectMode                                                  │        │selectMode
custom   │        │('fixture')                                                 │        │('managed-ecdict')
         │        │                                                            │        │
         ▼        │                                                            ▼        │
      ┌──┴────────────┐            selectMode('custom', nextSnapshotId)        │        │
      │               │◄───────────────────────────────────────────────────────┘        │
      │    custom     │                                                                 │
      │  (Snapshot)   ├─────────────────────────────────────────────────────────────────┘
      └───────┬───────┘
              │
              │ activateCustom / selectMode (different snapshotId)
              ▼
         custom-A -> custom-B (safe lease handoff)
```

### 3.1 Mode Invariants
- `fixture`: Default fallback mode. Requires no external files or managed storage. Always available.
- `managed-ecdict`: Active only when `installed-ecdict.json` exists and managed database file integrity passes PRAGMA check.
- `custom`: Active when published snapshot exists under `custom-snapshots/`, its SHA-256 matches `active.json`, and an active lease is held.

---

## 4. Transaction Mutex & Rollback Semantics

All mutating dictionary operations run through `DictionaryOperationManager` using `#executeWithExclusiveLock`:
- **Single Flight**: Concurrent operations return `409 Conflict` (`OPERATION_IN_PROGRESS`).
- **Cancellation**: Permitted during download/staging/validation phases. Once `onCommitBoundary()` executes, `#currentOp.nonCancellable = true`. Any subsequent cancellation throws `OperationNotCancellableError`.
- **Atomic Metadata Commit**: Written atomically via temporary file and replace (`writeActiveMetadataAtomically`).
- **Rollback Compensation**: If `manager.activate()` fails after `active.json` has been written, the coordinator restores the previous metadata snapshot. If the restoration itself fails, an `ActivationRollbackError` is thrown containing both errors.

---

## 5. Matrix A01–A30 Verification Summary

| ID | Test Scenario | Outcome |
| :--- | :--- | :---: |
| **A01** | Initial uninstalled state status reflects fixture mode with custom capabilities | PASS |
| **A02** | Staged snapshot activation via snapshot ID opens leased database and updates active.json | PASS |
| **A03** | Raw path activation runs copy, validation, publish, lease, and activation end-to-end | PASS |
| **A04** | Activation preserves raw user database without modification or attribute change | PASS |
| **A05** | Activate Custom-A then switch to Custom-B transfers active lease cleanly | PASS |
| **A06** | Switch from Custom mode to Fixture mode releases custom lease | PASS |
| **A07** | Switch from Fixture mode back to Custom mode re-acquires lease | PASS |
| **A08** | Switch from Managed ECDICT mode to Custom mode preserves ECDICT files on disk | PASS |
| **A09** | Switch from Custom mode to Managed ECDICT mode restores ECDICT without re-download | PASS |
| **A10** | Remove managed ECDICT while Custom is active deletes ECDICT and leaves Custom active | PASS |
| **A11** | Remove managed ECDICT while ECDICT is active reverts to Fixture mode | PASS |
| **A12** | Activate Custom rejects invalid or corrupt user SQLite database with error | PASS |
| **A13** | Activate Custom with missing raw file path fails clean without modifying active.json | PASS |
| **A14** | Concurrent operations reject secondary requests with OperationInProgressError (409) | PASS |
| **A15** | Cancellation during snapshot creation unlinks staging files and preserves pre-state | PASS |
| **A16** | Cancellation during validation terminates worker and cleans up staging | PASS |
| **A17** | Cancellation attempt after commit boundary rejected with OperationNotCancellableError | PASS |
| **A18** | Startup recovery verifies published snapshot and activates custom dictionary | PASS |
| **A19** | Startup recovery detects corrupt snapshot file and falls back to fixture cleanly | PASS |
| **A20** | Startup recovery with missing snapshot file falls back to fixture cleanly | PASS |
| **A21** | Startup recovery with malformed active.json falls back to fixture cleanly | PASS |
| **A22** | Leased snapshot prevents unlink while dictionary handle is open | PASS |
| **A23** | Retired snapshot closes connection handle and decrements lease to 0 | PASS |
| **A24** | Continuous lookup queries during mode switch never fail or throw | PASS |
| **A25** | Activation failure during DictionaryManager.activate rolls back active.json | PASS |
| **A26** | Double fault throws ActivationRollbackError preserving both errors | PASS |
| **A27** | GET /dictionary/status returns accurate three-mode capabilities and state | PASS |
| **A28** | POST /activate-custom and /select-mode route handlers enforce validation | PASS |
| **A29** | Settings sync state correctly reflects custom mode activation | PASS |
| **A30** | Real isolated DSH process E2E verification across all 8 routes | PASS |
