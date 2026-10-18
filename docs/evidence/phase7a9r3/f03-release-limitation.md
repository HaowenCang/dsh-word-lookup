# F03 Configuration Recovery Boundary Disclosure & Known Release Limitation

- **Document**: Phase 7A.9R3 Gate 3 Technical Disclosure
- **Scope**: `dsh-word-lookup@0.2.0` Release Candidate
- **Target Runtime**: `DSH 0.2.0-rc.2 / Web Profile`
- **Audit Date**: 2026-10-18
- **Classification**: Known Release Limitation (Class A Evidence Disclosure)

---

## 1. Background & Scope of Scenario F03

In the fault injection test suite (`scripts/probes/phase7a9/rc-b-process-crash-injection.mjs`), Scenario F03 evaluates system resilience under a process crash during the transition from **Custom Dictionary Mode** to **Fixture Dictionary Mode**.

### 1.1 Exact Crash Point
The crash is injected at the stage `post_unlink_pre_ack` (Exit 103):
1. The user initiates a mode transition from Custom mode to built-in Fixture mode.
2. The runtime unlinks the durable metadata file `active.json` from disk, making Fixture mode permanent on the filesystem.
3. The process is terminated immediately after `unlink(active.json)`, **before** the asynchronous RPC call `settings.update` can be dispatched to and acknowledged by the Host Settings service.

---

## 2. Post-Restart System State & Verification

Upon subsequent process restart, the system exhibits the following verifiable state:

```text
Recovery activeMode:   fixture
Host configuredMode:   custom
settingsSyncState:     pending
```

### 2.1 Empirical Verification
1. **Data Plane Integrity (PASS)**:
   - The absence of `active.json` causes `DictionaryActivationManager` to cleanly and deterministically initialize the built-in deterministic SQLite fixture database (`sqlite-fixture`).
   - All dictionary queries resolve successfully against the fixture database.
   - Lookups are 100% operational; there are zero crashes, zero uncaught exceptions, and zero degraded query responses.

2. **User Data & Snapshot Protection (PASS)**:
   - User raw SQLite source databases are never opened in write mode, moved, renamed, or unlinked.
   - Staged custom snapshots in `.dsh/storage/dsh-word-lookup/custom-snapshots/` remain 100% intact, bit-for-bit invariant, and available for reactivation.

3. **Control Plane Sync State**:
   - The Host Settings service retains the prior configuration (`configuredMode: custom`).
   - The runtime truthfully reports `settingsSyncState: 'pending'` to indicate that durable disk state has transitioned to fixture, but Host Settings synchronization was interrupted before completion.

---

## 3. Idle Observation Boundary & Prohibition on "Automatic Convergence" Claims

### 3.1 Empirical Observation
During a controlled idle observation period of 1500ms (and across repeated idle restarts without external trigger), the system state remains:

```text
activeMode:         fixture
configuredMode:     custom
settingsSyncState:  pending
```

### 3.2 Formal Disclosure of Technical Boundary
- **No Automatic Convergence**: This behavior is **NOT** "automatic convergence" or "auto-reconciliation".
- **Design Rationale**: When `active.json` does not exist, the startup recovery routine adopts fixture mode as the safe default. Because no active metadata intent file exists on disk, startup recovery deliberately avoids unilaterally overwriting Host Settings.
- **Truthful Status Reporting**: The state machine preserves `settingsSyncState: 'pending'`. This truthfully discloses that disk state and host configuration have not yet synchronized, rather than falsely declaring `'synced'`.
- **Prohibition**: Release documentation, readiness reports, and marketing notes MUST NOT claim that F03 "automatically recovers" or "automatically converges" to synced status during idle intervals.

---

## 4. Explicit Reconciliation Path

Synchronization between the active runtime mode and the Host Settings model is restored through an **explicit user action**:

1. **User Action**: The user clicks/selects the built-in "Fixture" dictionary mode in the DSH Settings UI (or issues `select-mode: 'fixture'`).
2. **Reconciliation RPC**: The settings transport dispatches a formal `settings.update({ dictionaryMode: 'fixture' })` call to the Host Settings service.
3. **Converged Final State**:
   ```text
   activeMode:         fixture
   configuredMode:     fixture
   settingsSyncState:  synced
   ```
   All components are fully reconciled and synchronized.

---

## 5. Release Gate Verdict & Safety Assessment

| Criterion | Evaluation | Verdict |
|---|---|---|
| **Data Plane Safety** | Lookups operate correctly on deterministic fixture database | **PASS** |
| **User Data Safety** | User source files and custom snapshots completely undamaged | **PASS** |
| **Status Transparency** | System truthfully reports `settingsSyncState: 'pending'` | **PASS** |
| **Reconciliation Feasibility** | Cleanly converges to `synced` upon explicit mode selection | **PASS** |
| **Code Freeze Invariance** | Zero production code modifications required or permitted | **PASS** |

### Release Assessment:
This configuration recovery boundary is **completely safe, non-destructive, and acceptable for the `v0.2.0` release**. It is formally classified as an acknowledged release limitation and disclosed in the release gate documentation.
