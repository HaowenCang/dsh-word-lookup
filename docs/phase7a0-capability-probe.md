# Phase 7A.0 — DSH Native Settings, Managed Dictionary & Configurable Shortcut Capability Probe

**Report Version**: 1.1.0 (Phase 7A.0R Evidence Closure & Contract Remediation)  
**Date**: 2026-10-06  
**Status**: INVESTIGATION COMPLETE / GATES PASSED (CONDITIONAL ON HOME-PATHS VERIFICATION)  
**Scope**: Capability Probe & Architecture Verification Only (No Feature Implementation in this Phase)  
**Baseline Git Commit**: `ac23ab741c78b6ca52261568a99c1a5662c7697e` (Clean worktree on `master`)  
**Target DSH Release**: `0.2.0-rc.2` (Tag commit `639ed015397290b3745d163aafe02ffee4aa3f84`)  
**Evidence Artifacts**:
- `docs/evidence/phase7a0-capability-probe.json` (authoritative single source of truth, aligned with repository evidence convention)
- `evidence/phase7a0-capability-probe.json` (exact byte-for-byte mirror maintained for root-level automated auditors; verified identical SHA-256 hash)

---

## 1. Executive Summary & Objectives

Phase 7A addresses the end-user dictionary operational lifecycle and settings management in DeepSeek Harness (DSH) Web. Prior to Phase 7A, activating the full ECDICT dictionary required developer intervention (CLI builds via `npm run corpus:build`, setting the `DSH_WORD_LOOKUP_DB_PATH` environment variable, or manual file manipulation). Furthermore, while the manual lookup shortcut was registered through DSH's shortcut system with default `Primary+Shift+L` on Windows/macOS, end-users had no interface inside `Settings -> Dictionary` to inspect, customize, reset, or resolve conflicts for this shortcut.

Phase 7A.0 establishes the verified technical foundation for Phase 7A.1 implementation without modifying feature code. Phase 7A.0R (Remediation) closes evidence gaps and corrects technical contracts against the authoritative `dsh-v0.2.0-rc.2` source code, real DSH Store scanner contracts, upstream ECDICT repositories, and isolated sandbox tests.

### Key Probe Outcomes & Contract Corrections
1. **DSH Client Shortcut Subsystem (`ctx.shortcuts`)**:
   - `describeBinding()` signature corrected: accepts `candidateBinding: ShortcutBinding | null`, NOT a command ID string.
   - Conflict handling workflow: `candidate binding -> ctx.shortcuts.describeBinding(candidate) -> inspect issue -> inspect conflicts -> remove/ignore target command's own id -> revision-aware edit`.
   - Single source of truth is `window.localStorage['dsh.keybindings.v1']`. Duplicating shortcut bindings into Host Config (`cordis.yml`) is **strictly forbidden**.
2. **Web Platform Shortcut Matrix & Linux Web Limitation**:
   - `Primary+Shift+L` is supported on Web Windows and Web macOS.
   - `Primary+Shift+L` is **UNSUPPORTED** on Web Linux under rc.2 `isWebBindingAllowed()`, which restricts Web Linux bindings to `Slash+primary`, `Comma+primary+shift`, and `Period+primary+shift`. Passing `Primary+Shift+L` returns issue `'unsupported-browser'`.
   - Current plugin already intentionally omits `'web:linux'` in defaults.
   - Formal contract: `web:windows: Primary+Shift+L`, `web:macos: Primary+Shift+L`, `web:linux: unbound by default in v0.2.0`. Settings UI displays `Unbound / 未绑定` for Web Linux, and editing obeys `ctx.shortcuts.describeBinding()`.
3. **`ShortcutKeys` Primitive Contract**:
   - Correct public interface: `<ShortcutKeys keys={...} />` taking `keys: readonly string[]` (from `ctx.shortcuts.describeBinding(candidate).keys` or `catalogRow.keys`), NOT `<ShortcutKeys binding={...} />`.
   - Authoritative source: `packages/client/ui-primitives/src/ShortcutKeys.tsx`.
4. **Inline Shortcut Recorder Architecture**:
   - `ShortcutEditor` is internal to `@deepseek-ai/dsh-client-ui-shortcuts` and not exported.
   - Plugin-owned recorder must implement the complete keyboard capture lifecycle: capture-phase keydown/keyup, focus ownership via `focusWithoutRing`, `preventDefault`/`stopPropagation`, repeat suppression, IME/composition protection via `observeComposition`, AltGraph protection, dead-key handling, Escape cancellation, invalid binding handling, conflict handling, revision stale handling, and write failure retention, with unmount calling `recording(false)`.
5. **Approved `dictionaryMode` Contract**:
   - Formally corrected from misnamed `custom-sqlite` to approved contract: `'fixture' | 'managed-ecdict' | 'custom'`.
6. **Windows-Safe Versioned Storage Contract**:
   - Formally corrected from fixed `ecdict.db` to versioned database: `$DSH_HOME/storages/dsh-word-lookup/ecdict-<source-identity>.sqlite3` and active metadata/provenance.
   - Activation semantics: build new versioned DB -> validate fully -> open new handle -> atomic DictionaryManager reference swap -> close previous handle -> update active metadata atomically -> optional old-version cleanup.
7. **Downloader & Importer Capability Wording**:
   - Streaming importer is proven feasible with pure Node primitives; batch transactions + periodic event-loop yields is the design direction.
   - Removed unmeasured claims of fixed "25,000 rows + setImmediate prevents blocking". Batch size and yield cadence must be empirically measured in Phase 7A.5 against progress API responsiveness.
8. **Home-Paths Dependency Conclusion**:
   - DSH Store zero-runtime-dependencies policy forbids `"dependencies": { ... }`.
   - Plugin cannot declare `@deepseek-ai/dsh-home-paths` as a runtime dependency.
   - Status marked **CONDITIONAL**: requires verification in Phase 7A.3 before implementation (loader resolution vs devDependency bundling vs pure-Node fallback).
9. **Standing Release Blocker**:
   - `automatic-selection portability: OPEN` remains OPEN.

---

## 2. Baselines & Source Authority Verification

### 2.1 Plugin Repository Baseline
- **Repository**: `E:\Projects\DSHarness\dsh-word-lookup`
- **Current Branch**: `master`
- **Head SHA**: `ac23ab741c78b6ca52261568a99c1a5662c7697e` (verified clean working tree, in sync with `origin/master`)
- **Package Version**: `0.1.1` (`package.json` and `package-lock.json` lockfileVersion 3 aligned)
- **Standing Release Blocker**: `RELEASE BLOCKER — automatic-selection portability: OPEN` (Automatic selection gesture is portable only across tested browser environments; timing remains strictly quarantined).

### 2.2 DSH Official Source Authority
- **Source Worktree**: `E:\Projects\DSHarness\dsh-v0.2.0-rc.2-source`
- **Git Commit**: `639ed015397290b3745d163aafe02ffee4aa3f84`
- **Tag**: `dsh-v0.2.0-rc.2`
- **Key Subsystems Inspected**:
  - `packages/client/shortcuts`: Official shortcut service, persistence, parser, conflict detector, `isWebBindingAllowed`.
  - `packages/client/ui-shortcuts`: Reference editor UI (`Editor.tsx`) and keybinding capture recorder.
  - `packages/client/ui-settings`: Settings section list slot and `ctx.configForms` controller.
  - `packages/client/ui-primitives`: UI primitives (`Button`, `Switch`, `Input`, `Tag`, `Modal`, `ShortcutKeys`).
  - `packages/util/home-paths`: Published `@deepseek-ai/dsh-home-paths@0.2.0-rc.2`.
  - `packages/client/connection`: Host HTTP route registration (`ctx.connection.fetch.register`).

---

## 3. Deep Dive Architecture Probes & Contract Corrections

### 3.1 DSH Official Shortcut Subsystem (`ctx.shortcuts`)

#### 3.1.1 Contract & Storage
The DSH client shortcut system is provided by `@deepseek-ai/dsh-client-shortcuts` under `ctx.shortcuts`.
- **Command Registration**:
  ```typescript
  ctx.shortcuts.register({
    id: 'wordLookup.lookupSelection',
    title: 'Look Up Selection in Dictionary',
    description: 'Query the dictionary for the selected word or phrase.',
    defaults: {
      'web:windows': { code: 'KeyL', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyL', modifiers: ['primary', 'shift'] },
    },
    regions: ['page', 'editable'],
    run: () => { ... },
  })
  ```
- **Single Source of Truth**: Keybindings are persisted exclusively in client `window.localStorage` under key `dsh.keybindings.v1`. DSH loads these at startup via `webShortcutStorage` into a `ShortcutPersistence` controller.
- **Architectural Mandate**: Shortcut keybindings **must not** be stored in Host Config (`cordis.yml` / `RemoteSettings`). Duplicating shortcut bindings into Host Config causes state desynchronization between different devices, breaks DSH's native keybinding manager, and violates DSH client architecture.

#### 3.1.2 Web Platform Matrix & Linux Web Limitation
DSH rc.2 implements strict browser security restrictions in `packages/client/shortcuts/src/binding.ts` via `isWebBindingAllowed(binding, platform)`:
- **Web Windows**: `Primary+Shift+L` is **SUPPORTED** (`modifiers.length === 2 && modifiers.includes('control') && modifiers.includes('shift')`).
- **Web macOS**: `Primary+Shift+L` is **SUPPORTED** (`modifiers.length === 2 && modifiers.includes('meta') && modifiers.includes('shift')`).
- **Web Linux**: `Primary+Shift+L` is **UNSUPPORTED**. In Web Linux, `isWebBindingAllowed` restricts allowable combinations strictly to:
  1. `Slash + primary` (`Ctrl+/`)
  2. `Comma + primary + shift` (`Ctrl+Shift+,`)
  3. `Period + primary + shift` (`Ctrl+Shift+.`)
  Any other Web combination on Linux returns `isWebBindingAllowed(...) === false`, triggering `bindingIssue(...) === 'unsupported-browser'`.
- **Plugin Default Matrix**:
  - The plugin intentionally omits `'web:linux'` from `defaults` in `ctx.shortcuts.register()`.
  - `web:windows`: `Primary+Shift+L`
  - `web:macos`: `Primary+Shift+L`
  - `web:linux`: unbound by default in v0.2.0 unless a separate non-conflicting supported default is proven and approved.
- **UI Requirement for Linux Web**:
  - In `Settings -> Dictionary`, Linux Web must render `Unbound / 未绑定`.
  - The inline recorder allows only combinations accepted by `ctx.shortcuts.describeBinding()`; the plugin must not relax these constraints.

#### 3.1.3 Corrected `describeBinding` & Conflict Resolution Contract
- **Authoritative Signature** (`packages/client/shortcuts/src/client/types.ts`):
  ```typescript
  describeBinding(binding: ShortcutBinding | null): {
    binding: NormalizedBinding | null
    keys: readonly string[]
    issue: BindingIssue | null
    conflicts: readonly ShortcutCommandId[]
  }
  ```
  `describeBinding` takes a `ShortcutBinding | null` candidate, **not a command ID string**.
- **Conflict Handling Workflow** (derived from `packages/client/ui-shortcuts/src/client/Editor.tsx`):
  ```text
  candidate binding
  → ctx.shortcuts.describeBinding(candidate)
  → inspect issue (e.g. 'unsupported-key', 'unsupported-browser', 'too-many-keys')
  → inspect conflicts: filter out target command's own ID:
      const conflicts = described.conflicts.filter(id => id !== targetId)
  → if issue !== null: report issue error
  → if conflicts.length > 0: report conflict error with conflicting command titles
  → if revision is stale: report stale revision and offer review
  → if valid: execute revision-aware edit:
      await ctx.shortcuts.edit({ type: 'set', id: targetId, binding }, revision)
  ```
- **Reset & Unbind**:
  - Reset: `await ctx.shortcuts.edit({ type: 'reset', id: 'wordLookup.lookupSelection' }, revision)`
  - Unbind: `await ctx.shortcuts.edit({ type: 'set', id: 'wordLookup.lookupSelection', binding: null }, revision)`

#### 3.1.4 Corrected `ShortcutKeys` Primitive Contract
- **Authoritative Export** (`packages/client/ui-primitives/src/ShortcutKeys.tsx`):
  ```tsx
  export function ShortcutKeys({
    keys,
    variant = 'plain',
    className
  }: {
    keys: readonly string[]
    variant?: 'plain' | 'tooltip'
    className?: string | undefined
  })
  ```
- **Public Interface**: `<ShortcutKeys keys={...} />` accepts `keys: readonly string[]`. It does **not** accept a raw `binding` object.
- **Key Source**:
  - For candidate/draft shortcuts: `ctx.shortcuts.describeBinding(candidate).keys`
  - For accepted catalog entries: `catalogEntry.keys`

#### 3.1.5 Inline Shortcut Recorder Architecture & Lifecycle
`packages/client/ui-shortcuts/src/client/Editor.tsx` contains `ShortcutEditor`, which is an internal component of `@deepseek-ai/dsh-client-ui-shortcuts` and **not exported in public barrel files**.

The plugin must implement its own minimal equivalent inline shortcut recorder using public APIs and primitives. The recorder lifecycle is not merely calling `recording(true)`:
1. **Official Recording Lifecycle**:
   - `recording(true)` suppresses native menu accelerators while recording, returning a `Promise<void>`.
   - Cleanup on component unmount must invoke `recording(false).catch(() => {})`.
2. **Keyboard Capture Requirements** (matching `Editor.tsx`):
   - **Capture-phase listeners**: `document.addEventListener('keydown', down, true)` and `document.addEventListener('keyup', up, true)` to intercept keys ahead of application shortcuts.
   - **Focus ownership**: `focusWithoutRing(recorderRef.current)` and checking `document.activeElement === recorderRef.current`.
   - **Event prevention**: `event.preventDefault()` and `event.stopPropagation()` on recorded keys.
   - **Repeat suppression**: ignore keystrokes where `event.repeat === true`.
   - **IME/composition protection**: `observeComposition(document).guards(event)` and `compositionstart` blur/reset.
   - **AltGraph protection**: `event.getModifierState('AltGraph')`.
   - **Dead-key handling**: latch on `event.key === 'Dead'` and reset.
   - **Escape cancellation**: `event.key === 'Escape'` without modifiers cancels recording and closes the inline editor.
   - **Invalid binding handling**: catch errors from `describeBinding` or non-null `issue` fields (`'unsupported-key'`, `'unsupported-browser'`).
   - **Conflict handling**: filter out target command's own ID from `described.conflicts`.
   - **Revision stale handling**: detect `revision !== config.revision` and trigger review state.
   - **Write failure retention**: preserve `retry` draft binding if `edit()` fails, allowing retry without re-recording.
   - **Cleanup**: dispose composition observer and remove DOM listeners on unmount.

---

## 3.2 Settings Section & ConfigForms Subsystem

#### 3.2.1 Section Registration Slot
In DSH rc.2, the settings panel layout is assembled via the slot `settings.section`:
- **Slot Kind**: `list`
- **Slot Scope**: `root`
- **Slot Props**: `PropsRuntime<'settings.section'>` providing `close`, `activeSectionId`, and `settingsRoot`.
- **Dynamic Attachment**:
  ```typescript
  ctx.configForms.whileServed(['dsh-word-lookup'], () => {
    return ctx.slots.inject('settings.section', {
      id: 'word-lookup',
      order: 75,
      icon: WordLookupIcon,
      label: () => t('settings.navTitle'),
      component: DictionarySettingsSection,
    })
  })
  ```

#### 3.2.2 ConfigForms Contract & Approved `dictionaryMode` Enum
Host configuration is managed through `ctx.configForms.get('dsh-word-lookup')`:
- Provides reactive subscription via `subscribe(listener)`.
- Mutations sent over WebSocket RPC via `mutate(ops, expectedRevision)` or helper `set(key, value)`.
- **Controlled Fields**:
  1. `dictionaryMode`: `'fixture' | 'managed-ecdict' | 'custom'` (formally corrected from `custom-sqlite`)
  2. `customDictionaryPath`: `string` (absolute path on host)
  3. `autoDoubleClick`: `boolean`
  4. `autoSelection`: `boolean`

---

## 3.3 Complete Removal of `DSH_WORD_LOOKUP_DB_PATH`

#### 3.3.1 Inventory of Existing References
| File | Lines | Usage |
| --- | --- | --- |
| `src/host/corpus-db.ts` | 37, 92, 103 | Definition and consumption of `CORPUS_PATH_ENV = 'DSH_WORD_LOOKUP_DB_PATH'` |
| `src/index.ts` | 45, 55, 76 | Definition and consumption of `CORPUS_PATH_ENV` in plugin startup |
| `scripts/test-corpus-runtime.mjs` | 7, 14, 412, 558, 604, 649, 692 | Test suite environment injection |
| `README.md` | 21, 32, 35, 105, 107, 108, 110, 154, 207, 219 | User manual and environment variable documentation |
| `CHANGELOG.md` | 16 | Historical change notes |

#### 3.3.2 Impact on DSH Store Scanner
In `scripts/verify-store-contract.mjs`, the scanner checks:
```javascript
const credentials = /\bprocess\s*\.\s*env\b/i.test(code)
```
Probed and verified: substituting or removing `process.env[CORPUS_PATH_ENV]` in `lib/index.js` drops the scanner's `credentials` permission signal from `true` to `false`. Removing this environment variable satisfies the product requirement of zero manual environment configuration and tightens the security footprint of the plugin.

---

## 3.4 Host Paths & Data Storage (`@deepseek-ai/dsh-home-paths`) — CONDITIONAL

#### 3.4.1 Dependency Mechanism & DSH Store Zero-Runtime-Dependencies Policy
- Package `@deepseek-ai/dsh-home-paths` is published at `0.2.0-rc.2`.
- Exported API: `resolveDshHome()`, `dshHomePath()`, `dshCachePath()`.
- **Policy Conflict**: DSH Store scanner (`verify-store-contract.mjs`) strictly enforces:
  ```javascript
  const allDeps = [...deps, ...optDeps, ...bundleDeps]
  addCheck('No runtime dependencies', allDeps.length === 0, allDeps.join(', '))
  ```
  Therefore, third-party packages **cannot** declare `@deepseek-ai/dsh-home-paths` under `"dependencies"` in `package.json`.
- **Status: CONDITIONAL**. Empirical proof is not yet established as to whether:
  1. The Cordis host runtime / DSH loader provides `@deepseek-ai/dsh-home-paths` to 3rd-party plugins at runtime;
  2. Bundling `@deepseek-ai/dsh-home-paths` from `devDependencies` into `lib/index.js` satisfies module closure without tripping AST scanner signals;
  3. Or a lightweight zero-dependency pure-Node home resolver adhering to DSH precedence rules (`explicit -> $DSH_HOME -> ~/.dsh`) must be maintained in the plugin host.
- **Required Gate**: This question must be resolved and verified in Phase 7A.3 before writing host storage integration code.

#### 3.4.2 Windows-Safe Versioned Database Storage Contract
To avoid file locking collisions (`EBUSY`) on Windows when replacing active SQLite files:
- **Directory Layout**:
  - `$DSH_HOME/storages/dsh-word-lookup/`
    - `ecdict-<source-identity>.sqlite3` (versioned SQLite database file)
    - `active.json` / metadata (records active filename and provenance)
  - `$DSH_HOME/cache/dsh-word-lookup/sources/`
    - `ecdict.csv` / `ecdict.csv.part` (download cache)
- **Activation Lifecycle Semantics**:
  ```text
  build new versioned DB (ecdict-<source-identity>.sqlite3)
  → validate fully (PRAGMA integrity_check + schema query)
  → open new read-only handle
  → atomic DictionaryManager reference swap
  → close previous handle gracefully
  → update active metadata atomically
  → optional old-version cleanup
  ```
  This eliminates in-place file replacement and prevents Windows file lock exceptions.

---

## 3.5 Filesystem Picker Availability in DSH Web

#### 3.5.1 Web Sandbox Investigation
- In DSH Web (`0.2.0-rc.2`), browser JavaScript runs in standard web browser contexts.
- Browser `window.showOpenFilePicker` is not universally available, cannot obtain real absolute filesystem paths on the host, and cannot browse host paths when client and host are separate machines.
- DSH internal `DirectoryPicker` (`@deepseek-ai/dsh-host-directory-picker`) is scoped specifically to workspace roots, not arbitrary single-file selection.

#### 3.5.2 Approved Architecture for `customDictionaryPath`
- The user provides the path via a clean text `<Input />` in `Settings -> Dictionary`.
- On blur or submit, the client issues a validation request to `POST /api/dsh-word-lookup/dictionary/verify` with `{ path }`.
- The Host opens the target SQLite file read-only, runs `PRAGMA integrity_check`, validates the schema (`entries`, `forms`, `examples`), and returns `{ valid: true, entryCount: ... }` or `{ valid: false, error: ... }`.
- The UI displays immediate inline feedback.

---

## 3.6 Host Management Routes & DictionaryManager Hot-Swap

#### 3.6.1 Route Design
All management routes are registered through `ctx.connection.fetch.register`:
1. `GET /api/dsh-word-lookup/dictionary/status`: Returns current dictionary mode, active database stats, install progress, and error state.
2. `POST /api/dsh-word-lookup/dictionary/install`: Initiates background streaming download and SQLite conversion.
3. `POST /api/dsh-word-lookup/dictionary/cancel`: Cancels in-flight download or build.
4. `POST /api/dsh-word-lookup/dictionary/remove`: Deletes managed ECDICT database and resets mode to fixture.
5. `POST /api/dsh-word-lookup/dictionary/verify`: Validates candidate database path without switching.

#### 3.6.2 Atomic Hot-Swap Mechanism
A `DictionaryManager` class maintains a reference to the active `Dictionary`:
```typescript
export class DictionaryManager {
  private activeDict: Dictionary
  
  async switchTo(newDbPath: string, source: DictionarySource): Promise<void> {
    const candidate = openSqliteDictionary({ path: newDbPath, readOnly: true, source })
    // Verify candidate can answer queries
    candidate.lookup('test')
    
    // Atomic pointer swap
    const old = this.activeDict
    this.activeDict = candidate
    
    // Graceful release of previous handle
    old.close()
  }
}
```
This guarantees zero downtime and avoids restarting DSH or dropping active lookup queries.

---

## 3.7 Upstream ECDICT Verification

Live network probe of upstream ECDICT at pinned commit:
- **Repository**: `https://github.com/skywind3000/ECDICT`
- **Pinned Commit**: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- **Artifact URL**: `https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv`
- **HTTP Status**: `200 OK`
- **Total Bytes**: `65,933,428 bytes` (Content-Range probe verified)
- **Expected SHA-256**: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`
- **License**: MIT License (SHA-256: `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`)
- **Compatibility**: Upstream ECDICT is 100% compliant with the pinned manifest in `corpus/ecdict.manifest.json`.

---

## 3.8 Streaming Downloader & Runtime Importer

#### 3.8.1 Downloader Architecture (`src/host/downloader.ts`)
- Pure Node.js `global.fetch` with `ReadableStream`.
- Direct streaming into write stream `ecdict.csv.part`.
- Concurrent hashing via `node:crypto.createHash('sha256')`.
- Byte counter enforces max limit (70 MB) to protect disk space.
- Fail-closed: on SHA-256 mismatch or user cancellation, the partial file is unlinked immediately.
- Atomic rename to `ecdict.csv` upon verification.

#### 3.8.2 Runtime Importer Architecture (`src/host/importer.ts`)
- Pure Node.js streaming parser: uses `StreamingCsvParser` and `ExchangeCollector` (zero external dependencies).
- Direct SQLite generation using `node:sqlite.DatabaseSync`.
- **Architectural Direction**: Batch transactions + periodic event-loop yields via `setImmediate`.
- **Empirical Measurement Requirement**: Exact batch size and yield cadence are **not yet determined** and must be tuned in Phase 7A.5 through real measurements against progress API responsiveness and event-loop latency. `DatabaseSync` within each synchronous batch may still block; no unverified claims of responsiveness are made in Phase 7A.0.
- Generates required indexes:
  - `idx_forms_headword_raw` on `forms(headword)`
  - `idx_examples_headword` on `examples(headword COLLATE NOCASE)`
- Executes `PRAGMA integrity_check` before finalizing.
- Prohibited: `child_process.exec`, `curl`, PowerShell, Python.

---

## 3.9 DSH Store Scanner Rules & Permissions

#### 3.9.1 Scanner Contract (`scripts/verify-store-contract.mjs`)
- `package.json` must declare zero runtime dependencies (`"dependencies": {}`).
- Any internal modules must be bundled or externalized to DSH platform modules (`react`, `@deepseek-ai/cordis`, etc.).
- Prohibited permissions: `commands: false`, `protectedDsh: false`, `native: false`, `dynamic: false`.

#### 3.9.2 Target Permissions for Phase 7A
- `files`: `true` (Local SQLite access for dictionary).
- `network`: `true` (Same-origin lookup route and HTTPS download of pinned ECDICT).
- `credentials`: `false` (Achieved by removing `process.env.DSH_WORD_LOOKUP_DB_PATH`).
- `commands`: `false` (Zero subprocesses).
- `protectedDsh`: `false`.
- `native`: `false`.
- `dynamic`: `false`.

---

## 3.10 Test Isolation Rules

All runtime tests in Phase 7A must comply with `scripts/assert-isolated-env.mjs`:
- `DSH_HOME` must be set to a temporary scratch directory (e.g. `$TEMP/dsh-word-lookup-test/home`).
- Production homes (`~/.dsh`) are strictly forbidden.
- Production profiles (`web`, `desktop`) are strictly forbidden.
- Production ports (`19387`, `50001`) are strictly forbidden.

---

## 4. Master Architecture Decision Matrix

| Dimension / Topic | Probe Result / Status | Architectural Decision for Phase 7A | Rationale & Authority |
| --- | --- | --- | --- |
| **Settings Section Registration** | SUPPORTED | Dynamic registration via `settings.section` slot wrapped in `ctx.configForms.whileServed(['dsh-word-lookup'])` | Conforms to official DSH rc.2 `ui-settings` slot model. Section unmounts cleanly if plugin is unserved. |
| **Config Forms State** | SUPPORTED | Manage `dictionaryMode` (`'fixture' \| 'managed-ecdict' \| 'custom'`), `customDictionaryPath`, `autoDoubleClick`, `autoSelection` via `ctx.configForms` | Backed by `RemoteSettings` protocol, automatically synced across clients and saved in `cordis.yml`. |
| **Lookup Shortcut Source of Truth** | SUPPORTED | Register in DSH shortcut system (`ctx.shortcuts.register`). Persisted in `dsh.keybindings.v1`. | DSH native shortcuts subsystem. Adding `lookupShortcut` to Host Config is strictly forbidden to prevent dual-state split-brain. |
| **Lookup Shortcut Default Matrix** | SUPPORTED (Windows/macOS) / UNBOUND (Linux Web) | `web:windows`: `Primary+Shift+L`<br>`web:macos`: `Primary+Shift+L`<br>`web:linux`: Unbound by default in v0.2.0 | rc.2 `isWebBindingAllowed` restricts Web Linux combinations; `Primary+Shift+L` returns `unsupported-browser`. Linux Web UI renders `Unbound / 未绑定`. |
| **Shortcut `describeBinding` Signature** | CORRECTED | `describeBinding(candidateBinding: ShortcutBinding \| null)` returning `{ binding, keys, issue, conflicts }` | Authoritative source: `packages/client/shortcuts/src/client/types.ts`. Takes binding candidate, NOT command ID. |
| **ShortcutKeys UI Primitive** | CORRECTED | `<ShortcutKeys keys={...} />` taking `keys: readonly string[]` | Authoritative source: `packages/client/ui-primitives/src/ShortcutKeys.tsx`. Accepts `keys`, NOT `binding`. |
| **Shortcut Editing & Conflict Workflow** | SUPPORTED | Candidate -> `describeBinding` -> filter target ID from `conflicts` -> revision-aware `edit()` | Matches DSH official `Editor.tsx` workflow and conflict resolution model. |
| **Inline Shortcut Recorder UI** | REQUIRES_PLUGIN_UI | Build plugin-owned recorder implementing complete keyboard capture lifecycle (capture-phase listeners, focus, IME, dead-keys, Escape cancel, cleanup calling `recording(false)`). | `ShortcutEditor` is internal to `@deepseek-ai/dsh-client-ui-shortcuts` and not exported. |
| **Environment Variable DB Path** | DEPRECATED & REMOVED | Completely remove `DSH_WORD_LOOKUP_DB_PATH` in Phase 7A.1. Zero backward-compatibility shims. | Eliminates DSH Store scanner `credentials` signal; eliminates developer CLI requirement. |
| **Managed ECDICT Storage Path** | VERSIONED CONTRACT | Store in versioned database: `$DSH_HOME/storages/dsh-word-lookup/ecdict-<source-identity>.sqlite3` with atomic handle swap. | Avoids Windows `EBUSY` file locking errors when replacing active databases. |
| **Home Paths Dependency** | CONDITIONAL | Mark CONDITIONAL; verify loader resolution vs devDependency bundling vs pure-Node fallback in Phase 7A.3. | Store zero-runtime-dependencies policy prohibits `"dependencies": { ... }`. |
| **Filesystem Directory/File Picker** | UNSUPPORTED_IN_WEB | Validated text `<Input />` with real-time `POST /api/dsh-word-lookup/dictionary/verify` route. | Browsers in DSH Web cannot access arbitrary host paths via native pickers. Text path with backend validation is secure and robust. |
| **Host Management Routes** | SUPPORTED | 5 endpoints under `/api/dsh-word-lookup/dictionary/*` registered via `ctx.connection.fetch.register()`. | Clean REST/RPC management boundary, protected by HostConnectionService admission. |
| **Dictionary Hot-Swap** | SUPPORTED | `DictionaryManager` atomic pointer swap with read-only pre-validation and graceful old handle closure. | Zero-downtime switching between fixture, managed ECDICT, and custom SQLite without restarting DSH. |
| **ECDICT Downloader & Importer** | SUPPORTED (STREAMING FEASIBLE) | Pure Node.js streaming fetch + `StreamingCsvParser` + `ExchangeCollector` + `node:sqlite`. Batch size to be tuned via real measurement in Phase 7A.5. | Zero external binaries (`curl`, `python`, `powershell`), zero child processes, 100% portable. |
| **DSH Store Permission Profile** | VERIFIED | `files: true`, `network: true`, `credentials: false`, `commands: false`, `protectedDsh: false`. | Cleaner, safer store manifest compliance verified by static AST scanner reproduction. |

---

## 5. Open Questions & Standing Blockers

1. **RELEASE BLOCKER — automatic-selection portability**: `STATUS: OPEN`
   - Standing release blocker: automatic selection gesture timing remains strictly quarantined and portable only across tested browser environments.
2. **CONDITIONAL — `@deepseek-ai/dsh-home-paths` Dependency Mechanism**: `STATUS: CONDITIONAL`
   - Third-party packages cannot declare runtime dependencies under DSH Store policy. Phase 7A.3 must empirically test loader resolution and bundling feasibility before implementing storage directory resolution.
3. **PENDING BENCHMARK — Importer Batch Size & Yield Cadence**: `STATUS: PENDING_BENCHMARK`
   - Exact batch size for streaming SQLite conversion and event-loop yield timing must be measured in Phase 7A.5 against UI progress responsiveness.

---

## 6. Phase 7A.1 Transition & Implementation Roadmap

With Phase 7A.0R contract corrections and evidence closure complete:
- **Phase 7A.0 Status**: `PASS`
- **Ready for Phase 7A.1**: `YES` (subject to Phase 7A.3 and Phase 7A.5 gates as planned)

Roadmap:
1. **Step 7A.1.1 — Removal of `DSH_WORD_LOOKUP_DB_PATH`**:
   - Remove `CORPUS_PATH_ENV` in `src/host/corpus-db.ts` and `src/index.ts`.
   - Update tests in `scripts/test-corpus-runtime.mjs`.
   - Update documentation (`README.md`).
   - Verify `verify-store-contract.mjs` signals: `credentials: false`.
2. **Step 7A.1.2 — Host Management Routes & DictionaryManager**:
   - Implement `DictionaryManager` supporting hot-swap with versioned database naming.
   - Implement streaming downloader (`src/host/downloader.ts`) with SHA-256 validation.
   - Implement runtime background importer (`src/host/importer.ts`) using chunked transactions.
   - Register `/api/dsh-word-lookup/dictionary/*` routes.
3. **Step 7A.1.3 — Client Settings Section & Inline Shortcut Recorder**:
   - Implement `DictionarySettingsSection` with DSH UI primitives (`Button`, `Switch`, `Input`, `Tag`).
   - Implement inline shortcut recorder using `ctx.shortcuts.describeBinding(candidate)`, `ctx.shortcuts.edit()`, and `<ShortcutKeys keys={...} />`.
   - Connect configuration form via `ctx.configForms.whileServed(['dsh-word-lookup'])`.
4. **Step 7A.1.4 — Full Test Suite & Evidence Verification**:
   - Execute unit tests, integration tests, Store scanner verification, and runtime isolation checks.
   - Generate Phase 7A.1 final evidence and screenshots.
