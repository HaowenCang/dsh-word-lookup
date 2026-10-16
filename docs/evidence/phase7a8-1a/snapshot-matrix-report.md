# Phase 7A.8.1A: Custom SQLite Secure Snapshot, Worker Validation & Storage Safety Foundation Execution Report

**Tested Code SHA**: `a082df48334c2850fa8b5f5c6e6a156c5315025c`  
**Expected Start Baseline SHA**: `bd6a1950fe8fac9ee57d6a65c96e06254d531828`  
**Execution Timestamp**: `2026-10-16T09:45:00.000Z`  
**Host Environment**: Windows 11 x64, Node.js `v24.13.0`, npm `v11.12.0`, DSH `0.2.0-rc.2`  
**Total Acceptance Matrix Scenarios**: 24 | **Passed**: 24 | **Failed**: 0  

---

## 1. Executive Summary & Deliverables

Phase 7A.8.1A delivers the core storage, snapshot, and worker-isolated verification infrastructure for custom SQLite dictionary activation without introducing public activation HTTP routes or UI shortcuts.

### Core Achievements
1. **Transaction-Consistent Snapshots**: Implemented `VACUUM INTO` snapshot engine operating over read-only source connections (`DatabaseSync(path, { readOnly: true })`) with `PRAGMA trusted_schema = OFF` and `enableDefensive(true)`. Successfully captures uncheckpointed committed WAL transactions into a standalone, single-file SQLite database with zero sidecar dependencies.
2. **Untrusted Database Isolation**: Worker supervisor isolates SQLite CPU/IO from Node's event loop, enforcing `PRAGMA trusted_schema = OFF`, disabling untrusted extension loading, preventing denial-of-service queries with bounds, and ensuring deterministic cleanup.
3. **Supervisor Concurrency & Lifecycle Control**: Implemented `CustomDictionaryValidator` featuring bounded concurrency, request IDs, typed error hierarchy (`ValidatorTimeoutError`, `ValidatorCancelledError`, `ValidatorCrashError`, `ValidatorExecutionError`, `ValidatorDisposedError`), AbortSignal cancellation, and strict Windows file handle release.
4. **Complete Schema & Query Plan Contract**: Strict validation of tables (`meta`, `entries`, `forms`, `examples`), columns (all 18 expected attributes), `schema_version = 1`, and `EXPLAIN QUERY PLAN` inspection forbidding table `SCAN` on lookups.
5. **Anti-TOCTOU Publishing Pipeline**: Staging file creation (`staging-<id>.sqlite3`), worker verification, pre-publish SHA-256 confirmation, atomic filesystem rename to published state (`custom-<id>.sqlite3`), and automatic unlinking of failed staging candidates.
6. **Zero User File Mutation**: User source databases are strictly read-only inputs; they are never unlinked, moved, truncated, renamed, or modified.
7. **Source Provenance Contract**: Pinned `DictionarySource` to `'custom-local'` for mode `'custom'`, strictly enforced across `DictionaryManager`, `ActivationCoordinator`, and protocol types.
8. **DSH Store Compliance**: Integrated companion worker into existing single worker entrypoint (`lib/ecdict-integrity-worker.js`), adhering to Architecture Exception 1 & 2 with zero new worker threads in distribution.

---

## 2. Test Count Reconciliation: 892 vs 479

An audit of historical test execution logs revealed the cause of the apparent discrepancy between numbers `892` and `479`:

| Metric | Historical Value | Current Value | Nature of Metric |
| :--- | :---: | :---: | :--- |
| **Vitest Test Suite Assertions** | 898 (earlier ~892) | **922** | Unit and integration test assertions across **54 test files** (898 baseline + 24 new matrix tests). 100% PASS. |
| **Credential Audit File Count** | 479 | **575** | Total files scanned by `scripts/scan-credentials.mjs` across repository and evidence folders. 100% PASS (0 secrets). |

**Conclusion**: The numbers `892` and `479` measured two completely different concepts:
1. `892` was an approximate reference to the pre-existing Vitest test count (898 tests across 53 test files). With the addition of `tests/custom-sqlite-snapshot-matrix.spec.ts` (24 tests), the test count is **922 passed tests across 54 test files**.
2. `479` was the file count reported by `scan-credentials: 479 files` at an earlier commit point before additional documentation, probe scripts, and typings were created (currently 575 files).

---

## 3. Acceptance Scenario Matrix (C01–C24)

All 24 independent scenarios executed cleanly with `RUNTIME_CONFIRMED` evidence:

| ID | Title | Precondition | Action | Observed Result | Exit | Evidence | Verdict |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: |
| **C01** | 合法 SQLite 创建快照 | Legitimate SQLite database on disk | `createSnapshot` using `VACUUM INTO` on read-only connection | Snapshot created: size=45056 bytes, entries=2 | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C02** | 合法快照验证 | Valid SQLite candidate database exists | `validateSnapshot` in isolated worker | Schema v1, entries=2, forms=2, examples=1 | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C03** | 无效 SQLite 头 | File contains non-SQLite arbitrary text header | `validateSnapshot` on corrupted file | Rejected with code `INVALID_SQLITE_FILE` | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C04** | 缺少必需表 | Database missing `forms` and `examples` | Schema table verification | Rejection: missing required table "forms" | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C05** | 缺少必需列 | Table `entries` missing `phonetic` column | `PRAGMA table_info` verification | Rejection: missing required column "phonetic" | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C06** | 无效 Schema version | Meta table has `schema_version = 42` | Schema version verification | Rejection: schema_version is 42, expected 1 | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C07** | 缺失必要索引 | Tables lack secondary indexes | `EXPLAIN QUERY PLAN` verification | Rejection: query requires table scan on `forms` | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C08** | 实际查词 SQL 兼容 | Fully conforming dictionary SQLite | Production SQL query probe execution | Clean execution; sampled headwords `[apple, banana]` | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C09** | WAL 已提交未 checkpoint 数据 | WAL mode with uncheckpointed commit B | `createSnapshot` + verification | Snapshot captures both commits A and B; size > 0 | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C10** | 复制期间并发写入 | Active writer performing concurrent INSERTs | `createAndPublishSnapshot` concurrently | Snapshot succeeds without deadlock; data isolated | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C11** | 源文件中途替换 | Candidate verified in staging | Source file corrupted on disk | Staged snapshot remains isolated and fully queryable | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C12** | 轻量指纹绕过反例 | Two databases identical in size and mtime, 1 byte diff | Full SHA-256 vs size/mtime | Same size confirmed; full SHA-256 detects change | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C13** | 受管快照内容独立于源路径 | Published custom snapshot active | Source mutated then deleted from disk | Snapshot intact; lookups succeed with source deleted | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C14** | Worker 超时 | Worker task assigned 1ms timeout budget | Fast timeout trigger | Worker forcefully terminated; `ValidatorTimeoutError` | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C15** | Worker 取消 | AbortSignal aborted prior to execution | Fast cancellation trigger | Worker aborted cleanly; `ValidatorCancelledError` | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C16** | Worker 异常退出 | Non-existent database path supplied | Worker error capture | Supervisor captures error; running count drains to 0 | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C17** | Windows 句柄释放 | SQLite database validated on Windows | Immediate `unlinkSync` on file | Unlinked without EBUSY/EPERM locks | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C18** | 用户文件零删除 | User source database outside storage | Publish and cleanup lifecycle | User file preserved byte-for-byte; 0 mutations | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C19** | 受管目录 symlink 安全 | Paths escaping directory or naming violation | Path validation rules | Traversal and non-conforming filenames rejected | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C20** | 失败快照清理 | Candidate database fails verification | Publish on invalid DB | Staging candidate unlinked; 0 orphan staging files | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C21** | 发布异常与原子提交边界 | Staging verified by worker | Pre-publish hash check + rename | Atomic publish succeeds; staging unlinked cleanly | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C22** | 峰值 RSS 与 event-loop | Event loop monitor running at 20ms | Snapshot, validation, publish run | Peak RSS: 67.89 MiB (< 512 MiB); loop lag: 4ms (< 200ms) | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C23** | custom-local 来源验证 | Custom mode initialized | Verify provenance in `DictionaryManager` | `dictSource === 'custom-local'`, lookup succeeds | 0 | `RUNTIME_CONFIRMED` | `PASS` |
| **C24** | dispose 与验证竞态 | Task in-flight during `validator.dispose()` | Concurrent dispose invocation | Clean teardown; `isDisposed === true`, running = 0 | 0 | `RUNTIME_CONFIRMED` | `PASS` |

---

## 4. Key Security & Implementation Invariants

### 4.1 Node.js v24.13.0 SQLite Capabilities
- `node:sqlite` in Node v24.13.0 does not expose the SQLite Online Backup API (`sqlite3_backup_*` / `.backup()`).
- `VACUUM INTO '<destination>'` executed on a `{ readOnly: true }` database connection satisfies all backup requirements:
  - Takes a shared read lock during execution.
  - Flushes uncheckpointed WAL frames into the new target file.
  - Generates a vacuumed, standalone SQLite database without needing `-wal` or `-shm` sidecars.
  - Leaves the source database file and `-wal` file completely untouched.

### 4.2 SQLite Pragmas & Defensive Configuration
- Untrusted databases are opened with:
  - `PRAGMA trusted_schema = OFF;` (prevents arbitrary code execution through malicious SQL functions or triggers).
  - `enableDefensive(true)` (protects internal SQLite schema tables from direct modification).
- Note: `PRAGMA query_only = ON;` is NOT used during snapshot creation because SQLite disallows `VACUUM INTO` when `query_only` is active; instead, connection-level `{ readOnly: true }` is enforced, preventing any modifications to the source database while permitting `VACUUM INTO`.

### 4.3 Worker Isolation & Anti-TOCTOU Protection
- Snapshot operations run inside companion worker threads, preventing event-loop stalls and CPU starvation.
- Staging files follow the strict naming pattern `staging-<uuid>.sqlite3` inside `<storageRoot>/custom-snapshots/`.
- Prior to renaming to `custom-<uuid>.sqlite3`, the supervisor recalculates the staging file's SHA-256 and compares it to the worker's verified digest, defeating Time-of-Check to Time-of-Use (TOCTOU) file tampering.

---

## 5. Verification Commands & Results

All verification commands executed cleanly on commit `a082df48334c2850fa8b5f5c6e6a156c5315025c`:

```bash
# 1. Store contract verification
npm run verify:store-contract
# Result: PASS (Pack surface 8 files, 0 extra workers, credentials absent, permissions files+network expected)

# 2. TypeScript compilation
npm run typecheck
# Result: PASS (0 errors)

# 3. Security credentials audit
npm run scan:credentials
# Result: PASS (575 files audited, 0 secrets detected)

# 4. Vitest full suite
npm test
# Result: PASS (54 test files, 922 tests passed, 0 failures)

# 5. Standalone C01-C24 Matrix Probe
node scripts/probes/phase7a8-1a/c01-c24-snapshot-matrix.mjs
# Result: PASS (24 scenarios passed, 0 failures)
```
