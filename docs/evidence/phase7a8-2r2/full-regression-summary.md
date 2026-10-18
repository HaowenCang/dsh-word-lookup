# Phase 7A.8.2R2 Full Regression Summary

**Execution Timestamp**: `2026-10-18T04:00:00Z`  
**Host Environment**: Node.js `v24.13.0`, Windows 11 x64, DSH `0.2.0-rc.2`  
**Tested Code SHA**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`  
**Target Package**: `dsh-word-lookup@0.2.0` (UNRELEASED)

---

## 1. Regression Command Matrix & Results

| # | Command / Script | Target Scope | Result | Details |
|---|---|---|---|---|
| 1 | `npm run iso:check` | Environment isolation | **PASS** | Refuses production `~/.dsh`, checks scratch port `50991` free |
| 2 | `npm run build:fixture` | Deterministic SQLite fixture | **PASS** | 7 entries, 11 forms, file SHA `063fbf6b650afe...` |
| 3 | `npm run typecheck` | TypeScript compiler (`tsc -p tsconfig.json`) | **PASS** | 0 type errors across production, tests, and scripts |
| 4 | `npm test` | Vitest full test suite | **PASS** | 60/60 test files passed, 1121/1121 tests passed (100%) |
| 5 | `npm run build` | tsdown + tsc production build | **PASS** | 3 bundles (`lib/index.js`, `lib/client.js`, `lib/ecdict-integrity-worker.js`) |
| 6 | `npm run scan:credentials` | Secret & token scanner | **PASS** | 646 files scanned, 0 usable secrets/tokens found |
| 7 | `npm run verify:store-contract` | DSH Store manifest & security contract | **PASS** | 8 files in tarball, 0 runtime dependencies, 0 eval/child_process |
| 8 | `npm run test:store-lifecycle` | Store lifecycle operations | **PASS** | INSTALL, START, UNINSTALL, ROLLBACK all verified |
| 9 | `npm run test:mgmt-e2e` | Management routes & lifecycle E2E | **PASS** | Parts 1–7 passed against real isolated DSH process |
| 10 | `npm run test:settings-e2e` | Native settings UI scenarios S01–S20 | **PASS** | All 20 scenarios passed against real browser instance |
| 11 | `npm run test:phase7a8-1ar` | Custom SQLite probes R01–R22 | **PASS** | 23/23 tests passed |
| 12 | `npm run test:phase7a8-1ar2` | Staging & lease safety L01–L12 | **PASS** | 12/12 tests passed |
| 13 | `npm run test:phase7a8-1b-e2e` | Custom activation & 3-mode E2E | **PASS** | E2E-01 through E2E-09 passed |
| 14 | `npm run test:phase7a8-1br2` | Concurrency & anti-tampering R01–R20 | **PASS** | 20/20 tests passed |
| 15 | `npm run test:phase7a8-1br2-e2e` | Multi-custom & anti-TOCTOU E2E | **PASS** | Steps 1–7 passed |
| 16 | `npm run test:phase7a8-2-e2e` | Native settings UI & browser acceptance | **PASS** | V15–V20, W09–W13, W18–W20 (14 scenarios passed) |
| 17 | `npm pack --dry-run` | Packaging closure inspection | **PASS** | Exactly 8 files, 135.3 kB packed, 575.7 kB unpacked |

---

## 2. Invariants & Contract Verification

1. **Zero-I/O Selection Contract**: Selection change event listeners perform no disk or network I/O; lookups trigger only on explicit user gesture or command.
2. **ECDICT Coexistence**: Custom snapshot activation and ECDICT installation coexist safely without mutual corruption.
3. **Worker Lifecycle**: Static worker thread terminates cleanly; handles and file locks are reliably released.
4. **Source Database Immutability**: User's original SQLite database file remains bit-for-bit invariant across all verification, staging, publication, and deletion lifecycles.
5. **Tarball 8-File Closure**: Exactly 8 files in tarball, no unnecessary build or test artifacts shipped.
