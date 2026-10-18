# README and Release Documentation Review Record (Phase 7A.9R)

- **Target File**: `README.md`
- **Scope**: Workstream R4 — Documentation Remediation
- **Evidence Classification**: `SOURCE_CODE_AUDIT`
- **Package Status**: `v0.2.0 = UNRELEASED`

---

## 1. Remediation Background

The independent release audit identified that `README.md` contained obsolete statements stating that user-facing ECDICT installation orchestration was still pending (from Phase 7A.4 development). In fact, through Phases 7A.5, 7A.6, and 7A.7, one-click managed ECDICT installation, custom SQLite snapshots, and native settings integration were completed and verified.

## 2. Review Checklist & Audit Guarantees

| Requirement Item | Documentation Status | Audit Finding |
|---|---|---|
| **Release Status** | `v0.2.0 = UNRELEASED` | Maintained explicitly. No false claim of npm availability. |
| **Published Version** | `v0.1.0` | Maintained as latest published release. |
| **Corpus Redistribution** | `REDISTRIBUTION REVIEW REQUIRED` | Strict distinction preserved: full ECDICT is NOT bundled or redistributed in npm or Git. Manifest status maintained. |
| **Built-in Fixture** | Deterministic, zero-network | Documented: startup immediately operates on fixture; makes zero network requests. |
| **Managed ECDICT** | One-click user-orchestrated | Documented: user initiates download from Settings; streaming size/SHA-256/UTF-8 verification; companion worker compilation. |
| **Custom SQLite Import** | Immutable snapshots | Documented: `VACUUM INTO` creates isolated snapshot; user raw source files are never modified or moved. |
| **Multi-Snapshot & Switching** | Supported | Documented: UI allows switching between multiple snapshots. |
| **Active Snapshot Protection** | Protected from deletion | Documented: deletion of active snapshot is disabled/rejected until deactivated. |
| **Supported Runtime** | DSH Web (`0.2.0-rc.2`) | Explicitly stated: Web only. Desktop adapters and other versions are unverified / unsupported. |
| **Shortcut Configuration** | Customizable | Documented: default `Primary+Shift+L`, customizable via settings. |
| **Automatic Triggers** | Opt-in, default off | Maintained: `autoDoubleClick` and `autoSelection` default to off. |
| **Installation Guide** | Published vs Dev | Maintained: published install via `dsh plugin add dsh-word-lookup@0.1.0`; dev via isolated test profile. |

## 3. Package Invariance Classification

`README.md` is one of the 8 packaged files in `dsh-word-lookup`. Because its documentation was updated to eliminate obsolete statements, it is formally recorded as:
- **Change Class**: `CLASS_C_APPROVED_DOCUMENTATION_CORRECTION`
- **Source Code Changed**: `NO` (Production TypeScript and JavaScript bundles remain 100% frozen bit-for-bit against `CODE_FREEZE_SHA`).
- **Tarball Rehashed**: Yes, final tarball SHA-256 recomputed and recorded.
