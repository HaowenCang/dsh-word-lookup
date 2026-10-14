# Phase 7A.7 — DSH Native Dictionary Settings Page Architecture & Design

**Document Version**: 1.0.0  
**Phase**: Phase 7A.7 (DSH Native Settings Section UI, Transport & Lifecycle)  
**Status**: DESIGN APPROVED / READY FOR IMPLEMENTATION  
**Target Package**: `dsh-word-lookup@0.2.0`  
**Host Baseline Commit**: `d277b5b7965f401ebb5487e5aec10b0d403ba779`  
**Target DSH Release**: `0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`)  

---

## 1. Executive Summary & Goals

Phase 7A.7 delivers the official native Settings Section for `dsh-word-lookup` in the DeepSeek Harness (DSH) Web environment. Prior to Phase 7A.7, dictionary lifecycle management (downloading, building, verifying, activating, and removing ECDICT) was exposed solely through authenticated Host HTTP endpoints implemented in Phase 7A.6 (`/api/dsh-word-lookup/dictionary/*`). 

The primary goal of Phase 7A.7 is to provide end-users with an intuitive, accessible, responsive, and native DSH Settings page that allows them to:
1. Access a dedicated **"词典" (Dictionary)** entry in the left-hand DSH Settings navigation.
2. Inspect the current dictionary status (Active mode, Installed corpus details, Entry counts, Form counts, Source provenance, and Diagnostics).
3. Perform a 1-click installation of the full 770,611-entry ECDICT corpus with real-time streaming progress indication (downloading and SQLite database construction).
4. Cancel an in-flight operation safely when permitted by the Host state machine.
5. Safely remove the managed ECDICT corpus with confirmation and seamless fallback to the built-in fixture dictionary.
6. Toggle gesture-based automatic lookup switches (`autoDoubleClick`, `autoSelection`) with instantaneous persistence via DSH `configForms`.
7. Inspect current shortcut configuration with platform-accurate defaults without creating secondary configuration stores.

---

## 2. DSH Native Settings Extension Contract

### 2.1 Extension Point & Lifecycle Hook
In DSH rc.2, the settings navigation and content panel are assembled dynamically via the `settings.section` slot:
- **Slot Name**: `settings.section`
- **Slot Kind**: `list`
- **Slot Scope**: `root`
- **Owner Props**: `SettingsSectionOwnerProps { close: () => void }`
- **Registration Envelope**:
  ```typescript
  ctx.configForms.whileServed(['dsh-word-lookup'], () => {
    return ctx.slots.inject('settings.section', () => {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dictionary',
          order: 80,
          label: () => (isZhLocale() ? '词典' : 'Dictionary'),
        },
        DictionarySettingsSection,
      )
    })
  })
  ```
- **Lifecycle Guarantees**:
  - `whileServed` ensures the section is mounted only while the host is serving the `dsh-word-lookup` namespace.
  - When the plugin unloads or is removed from the profile, the returned disposer cleanly unregisters the section.
  - `slots.inject` guarantees registration only occurs after the `settings.section` slot definition exists.

### 2.2 Host Config Integration (`ctx.configForms`)
- Read access: `form = ctx.configForms.get('dsh-word-lookup')`
- Snapshot: `form.getSnapshot().value`
- Subscriptions: `form.subscribe(callback)`
- Mutations: `form.set('autoDoubleClick', boolean)`, `form.set('autoSelection', boolean)`
- Changes take effect across browser instances in real-time without refreshing DSH.

---

## 3. Client Architecture & Component Hierarchy

The client settings implementation is partitioned into clear, testable modules under `src/client/`:

```text
src/client/
├── dictionary-management-transport.ts   # Document-relative HTTP client for management API
├── dictionary-management-store.ts       # Reactive observable store with adaptive polling
├── dictionary-settings-components.tsx   # Reusable UI primitives (cards, rows, badges, progress bar)
├── dictionary-settings-section.tsx      # Main native Settings Section component
└── index.tsx                            # Extension entry registering settings.section
```

### 3.1 Transport Layer (`dictionary-management-transport.ts`)
- Implements strict document-relative URL requests:
  - `api/dsh-word-lookup/dictionary/status`
  - `api/dsh-word-lookup/dictionary/install`
  - `api/dsh-word-lookup/dictionary/cancel`
  - `api/dsh-word-lookup/dictionary/remove`
  - `api/dsh-word-lookup/dictionary/verify`
- Same-origin authentication: Relies on native browser cookie handling without custom credential leakage.
- Precise error classification:
  - `aborted`: Request aborted via `AbortSignal`.
  - `network`: Offline or socket disconnection.
  - `refused`: Server responses (400, 401, 404, 409, 413, 415, 500). HTTP 409 (`OPERATION_IN_PROGRESS` or `DIRECTORY_QUARANTINED`) is treated as a structured domain refusal, not a transport error.
- Sanitized diagnostic messages: Paths and stack traces are filtered to protect user privacy.

### 3.2 Adaptive Polling Store (`dictionary-management-store.ts`)
- Manages local UI state and periodic synchronization with the Host:
  - **Active polling** (800ms) during running operations (`currentOperation !== null`).
  - **Idle polling** (10,000ms) when resting.
  - **Focus-triggered polling**: Window focus triggers an immediate refresh.
  - **Action-triggered polling**: Install/cancel/remove actions immediately trigger status sync.
- Resilience: Retains last known valid status during intermittent network drops with a non-intrusive warning indicator.
- Leak prevention: Explicit `dispose()` clears all active timers and aborts pending requests. No state updates occur after unmount.

### 3.3 UI Component Specifications (`dictionary-settings-section.tsx`)

#### Section A: Current Dictionary Status (当前词典)
- **Active Mode Indicator**:
  - `managed-ecdict` -> "ECDICT 本地全量词典 (770,611 词条)"
  - `fixture` -> "内置离线基础词典 (12 词条)"
  - `custom` -> "自定义 SQLite 词典"
- **Status Badges**:
  - `已启用` (Active): Mode matches activeSource and installed state.
  - `未安装` (Not Installed): Fixture active, no managed corpus.
  - `已安装未启用` (Installed but Inactive): Managed corpus installed on disk, but active mode is fixture.
  - `正在安装 / 下载 / 构建` (Installing): Dynamic phase badge.
  - `正在取消` (Cancelling): Cancellation requested.
  - `隔离保护` (Quarantined): Storage quarantined due to unconfirmed worker termination.
  - `恢复异常` (Recovery Error): Anomaly encountered on startup.
- **Collapsible Technical Details**:
  - Entry count, morphological form count, database filename, Git commit, logical digest, and generation.

#### Section B: ECDICT Installation & Lifecycle Management
- **Pre-installation State**:
  - Explanatory copy describing offline benefits and zero external dependencies.
  - Prominent "一键安装 ECDICT" button.
  - Storage & network pre-disclosure (requires ~63 MiB download and local SQLite compilation).
- **In-flight Installation State**:
  - Accessible progress bar (`role="progressbar"`, `aria-valuenow`, `aria-label`).
  - Current phase text (Downloading CSV -> Verifying Source -> Building Database -> Validating -> Activating).
  - Quantitative progress: Bytes downloaded / Entries processed / Percentage.
  - Cancel button: Enabled when `canCancel === true`; disabled with descriptive tooltip when entering atomic activation (`canCancel === false`).
- **Post-installation State**:
  - Removal button with confirmation modal/dialog.
  - Confirmation text clearly explaining only the local managed cache/database is removed.
  - Mutex protection preventing concurrent install and remove.

#### Section C: Automatic Lookup Gestures
- **Double-click Lookup** (`autoDoubleClick`):
  - DSH switch control.
  - Defaults to `false`.
  - Bound to `form.set('autoDoubleClick', value)`.
- **Drag Selection Lookup** (`autoSelection`):
  - DSH switch control.
  - Defaults to `false`.
  - Bound to `form.set('autoSelection', value)`.

#### Section D: Shortcuts & Advanced Features (Informational)
- **Shortcut Display**:
  - Windows / macOS: Displays `Ctrl+Shift+L` / `⌘+Shift+L`.
  - Linux Web: Displays `未绑定 (Unbound)` adhering to the Phase 7A.0 capability probe.
  - Informative note indicating custom keybinding UI and conflict resolution land in Phase 7A.8.
- **Advanced Custom Dictionary Note**:
  - Explanatory note on custom SQLite dictionary loading coming in Phase 7A.8.

---

## 4. Interaction & Verification Matrix (S01 - S20)

| Scenario | Description | Expected Behavior |
| :--- | :--- | :--- |
| **S01** | Clean installation | "词典" appears in left Settings navigation at order 80. |
| **S02** | Initial state | Active mode is `fixture`, 0 automatic downloads triggered. |
| **S03** | Install initiation | Clicking install issues POST request, receives `operationId`, enters installing state. |
| **S04** | Download progress | Progress bar updates with downloaded bytes and percentage. |
| **S05** | Build progress | Progress bar updates with entry import count and validation phase. |
| **S06** | Cancellation | Clicking cancel updates status to `cancelling` until settled as `cancelled`. |
| **S07** | Commit non-cancellable | Once in atomic activation, cancel button is disabled with explanatory note. |
| **S08** | Install success | Status updates to `managed-ecdict`, displays 770,611 entries, query hits live DB. |
| **S09** | Install failure | Displays sanitized error reason and offers a retry action. |
| **S10** | Concurrent install | Rapid double-click on install generates only 1 operation (client mutex + 409 handling). |
| **S11** | Remove during install | Remove is blocked or safely refused with 409 without crashing UI. |
| **S12** | Removal confirmation | Confirming remove unlinks managed DB, reverts to `fixture`, queries hit fixture. |
| **S13** | Page navigation | Closing and reopening Settings preserves status without duplicate timers. |
| **S14** | Browser refresh | Refreshing browser during in-flight install recovers progress from Host status. |
| **S15** | DSH restart | Restarting DSH preserves installed ECDICT state and active mode. |
| **S16** | Gesture switches | `autoDoubleClick` and `autoSelection` toggles persist to `configForms` instantly. |
| **S17** | Theme & Responsive | Renders cleanly in dark/light mode and narrow mobile/desktop widths. |
| **S18** | Plugin unload | Unloading plugin removes Settings entry, cancels polling, and cleans up event listeners. |
| **S19** | Error handling | HTTP 401, 409, 500, and offline network errors display user-friendly notices. |
| **S20** | Quarantine / Recovery | Storage quarantine and recovery errors are highlighted clearly without misleading users. |

---

## 5. Security & Isolation Guarantees

1. **No Runtime Dependencies**: Client code relies exclusively on React, DSH core contracts, and zero external packages.
2. **Safe Fetch Boundaries**: All network requests use document-relative URLs without hardcoded absolute origins.
3. **No Credential Exposure**: Sensitive filesystem paths and internal credentials are not exposed to the DOM.
4. **Environment Isolation**: E2E testing runs in isolated home profiles on non-production ports.
