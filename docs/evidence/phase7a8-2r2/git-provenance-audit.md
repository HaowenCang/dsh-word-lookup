# Git Evidence Provenance & Cryptographic Audit Report

**Phase**: Phase 7A.8.2R2 — Evidence Provenance, Shortcut Persistence & Final Native UI Acceptance  
**Repository**: `https://github.com/HaowenCang/dsh-word-lookup`  
**Execution Timestamp**: `2026-10-18T03:59:00Z`  
**Auditor**: Independent Acceptance Engine (Gemini 3.8 Flash High)

---

## 1. Baseline & Lineage Commit Ledger

| Role | Commit SHA | Message / Summary |
|---|---|---|
| **START_SHA** | `f923dcff8d1d9f6771d1baf86059c97b271caa92` | Baseline prior evidence commit |
| **PREVIOUS_CODE_COMMIT** | `c6bacf19cde2525bcd5a62e922a6ca28ac12bdb6` | Prior code commit from Phase 7A.8.2R |
| **PREVIOUS_EVIDENCE_COMMIT** | `f923dcff8d1d9f6771d1baf86059c97b271caa92` | Prior evidence commit from Phase 7A.8.2R |
| **TESTED_CODE_SHA (Commit A)** | `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` | `fix(client): close shortcut persistence and settings E2E gaps` |
| **EVIDENCE_COMMIT (Commit B)** | `1148da9a9dd6588401b56c996bfdda2a855e1cd8` | `test(evidence): close phase 7a8.2r2 acceptance provenance` |

---

## 2. Commit A Inspection (`b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`)

Inspection via `git show --stat b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf`:

```text
 lib/client.js                                      | 218 ++++++---
 .../settings/dictionary-settings-components.d.ts   |  20 +
 .../settings/dictionary-settings-section.d.ts      |   2 +
 scripts/phase7a7-settings-e2e.mjs                  |   2 +-
 scripts/test-phase7a8-2-settings-e2e.mjs           | 513 ++++++++++++++++----
 .../settings/dictionary-settings-components.tsx    | 187 ++++++--
 .../settings/dictionary-settings-section.tsx       | 147 ++++--
 tests/client-settings-ui.spec.ts                   |  46 +-
 tests/phase7a8-2-native-settings.spec.ts           | 531 ++++++++++++++++++++-
 9 files changed, 1425 insertions(+), 241 deletions(-)
```

**Verification Invariants**:
- Zero `docs/evidence/**` files included in Commit A.
- All production logic for D1, D3, D5 contained in `src/client/**` and compiled into `lib/client.js`.
- All automated unit/mock test suites for W01–W08 and W14–W17 contained in `tests/**`.
- Full E2E browser runner for W09–W13 and W18–W20 contained in `scripts/test-phase7a8-2-settings-e2e.mjs`.

---

## 3. Commit B Inspection & Evidence-Only Boundary

Verification via `git diff-tree --no-commit-id --name-only -r 1148da9a9dd6588401b56c996bfdda2a855e1cd8`:

All paths strictly match `docs/evidence/phase7a8-2r2/**`.
- Zero changes to `src/**`
- Zero changes to `tests/**`
- Zero changes to `scripts/**`
- Zero changes to `lib/**`
- Zero changes to `package.json`

---

## 4. Anti-Tampering & History Integrity

In accordance with strict release engineering rules:
- No `git rebase` performed.
- No `git reset --hard` performed.
- No `git commit --amend` performed.
- No `--force` push executed.
- Linear fast-forward commit lineage maintained on `origin/master`.
