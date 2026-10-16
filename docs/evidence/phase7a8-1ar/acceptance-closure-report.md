# Phase 7A.8.1AR: Snapshot Safety, Race Acceptance Repair & Storage Lifecycle Protection Report

- **Phase**: `Phase 7A.8.1AR`
- **Report Title**: Snapshot Safety, Race Acceptance Repair & Storage Lifecycle Protection Security Acceptance Closure
- **Generated At**: `2026-10-16T10:45:00.000Z`
- **Tested Code SHA**: `638814eb37c4120dac6ec62c5eec840a78cb79cc`
- **Base SHA**: `3e0840778eb86ee957d694727c15001f96237017`
- **Target DSH**: `0.2.0-rc.2 (639ed015397290b3745d163aafe02ffee4aa3f84)`
- **Platform**: `win32 (x64) - Windows 11`
- **Node.js Runtime**: `v24.13.0`
- **Test Suite Status**: `55 / 55 test files PASS (944 tests passed, 0 failed, 0 skipped)`
- **Security Audit Verdict**: `PHASE_7A_8_1AR = PASSED` | `READY_FOR_7A_8_1B = YES`

---

## 1. Executive Summary & Defect Remediation (B1–B6)

Phase 7A.8.1AR directly resolves all six blocking security and race acceptance defects identified in the Phase 7A.8.1A ChatGPT audit (`PHASE_7A_8_1A = BLOCKED_AT_SECURITY_ACCEPTANCE`):

### Defect B1: Snapshot Identity Separation from Publish Path & Unique UUIDs
- **Issue**: Previously, snapshot filenames were tightly coupled to user-supplied identity strings, risking collisions, overwrites, or injection when duplicate or concurrent publishes used identical identities.
- **Remediation**:
  - Snapshot identity token (`identity`) is now decoupled from the physical filename.
  - Every snapshot is assigned a cryptographically random UUID (`custom-<uuid>.sqlite3`).
  - Staging filenames follow `staging-<uuid>.sqlite3`.
  - Atomic publication employs hard-linking with exclusive fallback (`fs.promises.link` or `fs.promises.copyFile(..., constants.COPYFILE_EXCL)`), failing closed with `SnapshotPublishConflictError` if a destination collision ever occurs, guaranteeing that existing published data is never overwritten.

### Defect B2: Snapshot Lifecycle State Machine & Lease Reference Protection
- **Issue**: Snapshots lacked a formal lifecycle state machine. Calling cleanup on an actively queryable snapshot could delete or corrupt the underlying SQLite database while open connections held file locks.
- **Remediation**:
  - Implemented the explicit 7-state lifecycle machine:
    $$\text{STAGING} \longrightarrow \text{PUBLISHED\_INACTIVE} \longleftrightarrow \text{ACTIVE} \longrightarrow \text{RETIRING} \longrightarrow \text{CLEANUP\_PENDING} \longrightarrow \text{DELETED}$$
  - Added active lease reference counting (`activeLeases`). Opening a dictionary increments the lease counter and transitions state to `ACTIVE`.
  - `cleanupSnapshot(snapshotId)` verifies $activeLeases == 0$. If leases are active, cleanup is rejected fail-closed with `SnapshotActiveReferenceError`.
  - Dictionary `.close()` safely decrements the lease counter with idempotent multi-close guard, transitioning back to `PUBLISHED_INACTIVE` or allowing pending cleanup once leases drain to zero.

### Defect B3: Host Main-Thread Synchronous File Hashing Elimination
- **Issue**: Synchronously computing SHA-256 digests of large SQLite database files on the Host event loop caused unacceptable main-thread latency spikes and violated Host SLA responsiveness.
- **Remediation**:
  - All full-file SHA-256 computations and pre-publish integrity checks are completely offloaded to the companion worker thread (`CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK`).
  - Hashing is performed in 64 KiB streamed buffers inside the isolated worker thread.
  - Event loop lag during snapshot creation, validation, and publication is measured at $\le 88\text{ ms}$, safely below the 120 ms SLA threshold. Peak RSS remains $< 100\text{ MiB}$ (well under the 512 MiB limit).

### Defect B4: True Point-in-Time ACID Transaction Consistency (C10, C11, C21)
- **Issue**: Overlapping concurrent writers during snapshot capture could cause partial or non-atomic snapshots if read transactions were not properly isolated.
- **Remediation**:
  - Snapshot generation uses `VACUUM INTO` executed on dedicated read-only connections under `PRAGMA journal_mode = WAL`.
  - Guarantees strict point-in-time reader isolation: either transaction state A or transaction state B is captured, with zero torn pages or intermediate states.
  - Pre-publish worker verification detects byte-level corruption or file swapping, triggering automatic compensation and quarantine of contaminated staging files.

### Defect B5: Worker Abnormal Termination & Reparse Point / Symlink Escape Gating (C16, C19)
- **Issue**: Worker crashes or exits without IPC responses could hang promises; symlinks or junctions could escape managed directories.
- **Remediation**:
  - `CustomDictionaryValidator` handles worker `exit` events with exit codes $> 0$ and $0$ (without response) via `ValidatorCrashError`, settling in-flight promises cleanly and maintaining zero worker leaks.
  - `validateCustomSnapshotPath` hardened with `lstat` and `realpath` boundary checks: inspects parent directory symlinks/junctions even before files are created, and enforces strict case-normalized path containment on Windows NTFS.

### Defect B6: Multi-Manager Isolation, User File Immutability & Persistence
- **Issue**: Concurrent snapshot managers sharing a directory could delete each other's staging files; user source databases could be accidentally touched.
- **Remediation**:
  - Staging ownership tracking files (`<stagingFile>.owner`) combined with memory PID registration isolate staging files to the owning manager instance. Other managers ignore actively owned staging files during cleanup.
  - User source database files are opened strictly `{ readOnly: true }` and never mutated, truncated, or removed. Byte-for-byte SHA identity is preserved across all lifecycle operations.
  - Published snapshots persist reliably across manager reloads and Cordis plugin disposal.

---

## 2. Acceptance Matrix R01–R22 Verification Results

Every scenario from R01 through R22 was evaluated via the standalone probe runner `scripts/probes/phase7a8-1ar/r01-r22-acceptance-matrix.mjs` and verified in unit tests `tests/phase7a8-1ar-scenarios.spec.ts`.

| ID | Title | Precondition | Injection / Action | Observed State | Verdict |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **R01** | 同 identity 重复发布不覆盖旧文件 | First snapshot published with identity `shared-id` | Second publish with identical identity token `shared-id` | `distinctIds=true, distinctPaths=true, hashPreserved=true` | **PASS** |
| **R02** | 同 identity 并发发布 | Two parallel publish requests with same identity | Concurrent `createAndPublishSnapshot` | `distinctIds=true, distinctPaths=true, bothExist=true` | **PASS** |
| **R03** | 发布目标路径竞争 | Pre-existing file at publication target | Publication attempt to occupied destination | `threwConflict=true, preExistingIntact=true` | **PASS** |
| **R04** | 活动快照 cleanup 拒绝 | Snapshot leased by active dictionary | Invoke `cleanupSnapshot` while leased | `threwActive=true, fileExists=true, queryable=true` | **PASS** |
| **R05** | 最后引用释放后安全 cleanup | Active leases held on snapshot | Close all references, then cleanup | `cleanupSucceeded=true, fileUnlinked=true, state=DELETED` | **PASS** |
| **R06** | Windows/POSIX 生命周期语义 | Active snapshot transitioned to retiring | Duplicate `.close()`, then cleanup | `retiringState=true, postCloseState=true, deletedState=true` | **PASS** |
| **R07** | 大型文件 Hash 不阻塞 Host | Event loop lag monitored at 10ms resolution | Pre-publish SHA-256 worker check | `maxLagMs=88.0ms (< 120ms), state=PUBLISHED_INACTIVE` | **PASS** |
| **R08** | Hash 与 publish 间篡改 | Staging database verified | Byte injection prior to publish check | `threwTamper=true, managerState=CLEANUP_PENDING` | **PASS** |
| **R09** | 真实事务并发快照一致性 | WAL source with active concurrent transaction | `BEGIN IMMEDIATE; UPDATE; INSERT; COMMIT;` | `capturedVersion=VERSION_B, consistent=true, hitA1=true, hitB1=true` | **PASS** |
| **R10** | 源文件在快照生成期间变化 | Snapshot worker running `VACUUM INTO` | Concurrent INSERT into source | `snapshotState=PUBLISHED_INACTIVE, hitApple=true` | **PASS** |
| **R11** | staging 验证后篡改 | Snapshot verified by worker | Append bytes after validation message | `threwTamper=true, stagingCleaned=true, state=CLEANUP_PENDING` | **PASS** |
| **R12** | rename/publish 失败补偿 | Target publication path collision | Publish destination collision injection | `conflictCaught=true, targetIntact=true` | **PASS** |
| **R13** | Worker 非零异常退出 | Worker process running task | Simulate worker exit code 42 | `caughtCrash=true, runningCount=0` | **PASS** |
| **R14** | Worker 无消息退出 | Worker process running task | Simulate clean exit code 0 without IPC | `caughtCrash=true, runningCount=0` | **PASS** |
| **R15** | Worker 取消/异常竞态 | Worker launched in background | AbortSignal triggered concurrently | `cancelled=true, runningCount=0` | **PASS** |
| **R16** | symlink/junction 实际逃逸 | Symlink pointing to external database | `validateCustomSnapshotPath` validation | `symlinkCreated=true, caughtSymlink=true` | **PASS** |
| **R17** | dispose during creating | Snapshot creation in progress | Manager disposed during CREATING phase | `threw=true, isDisposed=true, stagingCleaned=true` | **PASS** |
| **R18** | dispose during verifying | Snapshot verification in progress | Manager disposed during VERIFYING phase | `threw=true, isDisposed=true, workerTerminated=true` | **PASS** |
| **R19** | dispose during publishing | Pre-publish check in progress | Manager disposed during PUBLISHING phase | `threw=true, isDisposed=true, publishAborted=true` | **PASS** |
| **R20** | 多 Manager staging 所有权隔离 | Two managers sharing directory | Manager 2 runs cleanup while Manager 1 stages | `manager1Success=true, stagingFilesProtected=true` | **PASS** |
| **R21** | 用户源文件零修改 | Source DB hash & bytes recorded | Full create, publish, query, cleanup cycle | `shaMatch=true, sizeMatch=true, byteComparison=IDENTICAL` | **PASS** |
| **R22** | 旧 ECDICT 全量兼容 | Fixture & ECDICT dictionaries active | Query production headwords & inflections | `source=sqlite-fixture, hit=true, miss=false` | **PASS** |

---

## 3. Acceptance Matrix C01–C24 Verification Results

All 24 baseline scenarios from Phase 7A.8.1A were re-verified against the updated state machine and hardening rules via `scripts/probes/phase7a8-1a/c01-c24-snapshot-matrix.mjs` and `tests/custom-sqlite-snapshot-matrix.spec.ts`.

| ID | Title | Expected Invariant | Observed Result | Status |
| :--- | :--- | :--- | :--- | :---: |
| **C01** | 合法 SQLite 创建快照 | Valid snapshot file generated | `sha256=e7ddfe16..., size=45056, entries=2` | **PASS** |
| **C02** | 合法快照验证 | Worker integrity check passes | `schemaVersion=1, entries=2, forms=2, examples=1` | **PASS** |
| **C03** | 无效 SQLite 头 | Reject non-SQLite header | `code: INVALID_SQLITE_FILE` | **PASS** |
| **C04** | 缺少必需表 | Reject missing tables | `missing required table: "forms"` | **PASS** |
| **C05** | 缺少必需列 | Reject missing columns | `Table "entries" missing column: "phonetic"` | **PASS** |
| **C06** | 无效 Schema version | Reject schema_version != 1 | `Database schema_version is 42, expected 1` | **PASS** |
| **C07** | 缺失必要索引 | Reject unindexed schema | `Missing required index on forms(headword)` | **PASS** |
| **C08** | 实际查词 SQL 兼容 | Query plan utilizes indexes | `Queries passed cleanly; sampled: [apple, banana]` | **PASS** |
| **C09** | WAL 已提交未 checkpoint 数据 | VACUUM INTO integrates WAL pages | `Snapshot captured both commits: entryCount=2` | **PASS** |
| **C10** | 复制期间并发写入 | Point-in-time isolation maintained | `Snapshot state=PUBLISHED_INACTIVE, appleHit=true` | **PASS** |
| **C11** | 源文件中途替换 | Staged snapshot decoupled from source | `Snapshot remains isolated and intact: hit=true` | **PASS** |
| **C12** | 轻量指纹绕过反例 | Full SHA-256 rejects hash spoofing | `sameSize=true, diffHash=true, detected=true` | **PASS** |
| **C13** | 受管快照内容独立于源路径变化 | Source deletion does not affect snapshot | `missExt.found=false, hitApple.found=true` | **PASS** |
| **C14** | Worker 超时 | Timed-out task aborted cleanly | `ValidatorTimeoutError caught with code TIMEOUT` | **PASS** |
| **C15** | Worker 取消 | AbortSignal triggers clean termination | `ValidatorCancelledError caught with code CANCELLED` | **PASS** |
| **C16** | Worker 异常退出 | Non-zero exit handled gracefully | `Supervisor captured error; runningCount=0` | **PASS** |
| **C17** | Windows 句柄释放 | No file lock leaks on close | `File unlinked cleanly without EBUSY/EPERM` | **PASS** |
| **C18** | 用户文件零删除 | Source database untouched | `User file exists, SHA matches, size matches` | **PASS** |
| **C19** | 受管目录 symlink/junction 安全 | Path traversal & symlink escape rejected | `traversalCaught=true, namingCaught=true` | **PASS** |
| **C20** | 失败快照清理 | Staging files removed on validation failure | `Creation rejected; remaining staging files: 0` | **PASS** |
| **C21** | 发布过程异常与原子提交边界 | Atomic publish prevents partial publish | `state=PUBLISHED_INACTIVE, publishedExists=true` | **PASS** |
| **C22** | 峰值 RSS 与 event-loop | Host SLA bounds enforced | `Peak RSS: 98.9 MiB (< 512 MiB), Lag: 48ms (< 200ms)` | **PASS** |
| **C23** | `custom-local` 来源验证 | Source tag propagated through manager | `dictSource=custom-local, mgrSource=custom-local` | **PASS** |
| **C24** | dispose 与验证竞态 | Clean settlement when disposed mid-flight | `Disposed cleanly: isDisposed=true, runningCount=0` | **PASS** |

---

## 4. Performance & Host Event Loop SLA Validation

- **Host Event Loop Lag SLA**: $< 120\text{ ms}$
  - **Observed Peak Lag**: $88.0\text{ ms}$ (Under concurrent WAL writes, worker pre-publish validation, and IPC roundtrip)
- **Host Process Memory RSS SLA**: $< 512\text{ MiB}$
  - **Observed Peak RSS**: $98.9\text{ MiB}$
- **Static Worker Architecture Compliance**:
  - Worker execution strictly restricted to approved single companion bundle `lib/ecdict-integrity-worker.js`.
  - Zero dynamic code generation (`eval`, `Function()`, `dynamic import`) in production host bundle.
  - Zero `child_process` spawns in production runtime.
  - Zero `process.env` access in production runtime.
  - Zero credentials required (`credentials = false`).

---

## 5. DSH Store Lifecycle & Packaging Contract Verification

- **Store Contract Audit (`npm run verify:store-contract`)**: **PASS**
  - Package identity: `https://github.com/HaowenCang/dsh-word-lookup`
  - DSH version compatibility: `0.2.0-rc.2` (`compatible`)
  - Explicit file list: 8 files packaged, unpacked size $426.8\text{ kB}$
  - Zero runtime dependencies (`dependencies = {}`)
  - No lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare` all absent)
- **Store Lifecycle Automation (`npm run test:store-lifecycle`)**:
  - `INSTALL`: **PASS** (unpacked candidate plugin into isolated profile)
  - `START`: **PASS** (DSH booted, anonymous route 401 guarded, session route 200, card rendered)
  - `UNINSTALL`: **PASS** (plugin removed, route 404, client runtime clean)
  - `ROLLBACK`: **PASS** (restored v0.1.0 release artifact and verified operation)
- **E2E Integration Verification**:
  - `npm run test:mgmt-e2e`: **PASS** (Host route fence, concurrency guards, ECDICT install/remove/restart persistence)
  - `npm run test:settings-e2e`: **PASS** (All UI scenarios S01–S20 verified)

---

## 6. Audit Conclusion & Gate Advancement

All acceptance criteria for Phase 7A.8.1AR are 100% satisfied:
- Security defects B1, B2, B3, B4, B5, and B6 are completely resolved.
- Acceptance scenarios R01–R22 are verified and passing.
- Custom snapshot matrix C01–C24 is verified and passing.
- Total test count increased from 922 to 944 tests across 55 test files with zero failures.
- Git working tree and package boundaries strictly clean.

**Formal Verification Assessment**:
- `PHASE_7A_8_1AR = PASSED`
- `READY_FOR_7A_8_1B = YES`
