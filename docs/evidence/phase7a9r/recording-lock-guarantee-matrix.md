# Corrected Recording Lock Guarantee Matrix (Phase 7A.9R)

- **Source Reference**: `src/client/settings/dictionary-settings-components.tsx` (`AsyncRecordingLock`)
- **Upstream Baseline**: `@deepseek-ai/dsh-client-shortcuts` at upstream commit `639ed015397290b3745d163aafe02ffee4aa3f84`
- **Probe Reference**: `scripts/probes/phase7a9/rc-d-recording-lock-probe.mjs`
- **Evidence Classification**: `SOURCE_CODE_AUDIT` & `CONTROLLED_FAULT_INJECTION`

---

## 1. Runtime Scope: Web vs Desktop Architecture

An architectural audit of upstream DSH shortcuts implementation revealed the fundamental difference in recording handling between runtimes:

### 1.1 DSH Web Runtime (Supported Platform)
In `packages/client/shortcuts/src/client/storage.ts`:
```typescript
export function webShortcutStorage(window: Window, platform: ShortcutPlatform,
  publish: (snapshot: ShortcutConfigSnapshot) => void): DesktopShortcutsApi & { dispose(): void } {
  // ...
  return {
    get: (definitions) => { ... },
    edit: (edit, revision) => persistence.edit(edit, revision),
    subscribe: () => () => {},
    recording: async () => {}, // <--- Web runtime recording contract
    dispose: () => { ... },
  }
}
```
- In DSH Web, `recording(active)` is an asynchronous no-op (`async () => {}`).
- It never throws, never rejects, and never sets persistent host recording locks.
- **Guarantee**: Dangling host recording state is physically impossible in the supported DSH Web runtime.

### 1.2 Stateful Desktop Runtimes (Unverified / Unsupported)
- Desktop runtimes route recording through a native bridge (`window.dshDesktop.shortcuts.recording(active)`).
- If the Desktop IPC fails before releasing, the external host service can remain in recording mode.
- Upstream DSH does **NOT** implement an auto-recovery mechanism on window blur or subsequent shortcut events for this failure mode.
- Client-side `AsyncRecordingLock` guarantees local lock cleanup (`isHeld() === false`) and unhandled rejection suppression, but cannot remotely clear remote host state if the transport has broken.

---

## 2. Corrected Scenario Guarantee Matrix

| Scenario | Title | Target Scope | Local Lock (`isHeld()`) | Host Recording | Verdict | Contract Guarantee & Boundary Analysis |
|---|---|---|---|---|---|---|
| **RCD-01** | Acquire resolves normally | All | `false` (after release) | `false` | **PASS** | Acquire locks, release cleans up normally. |
| **RCD-02** | Acquire rejects before Host accepts | All | `false` | `false` | **PASS** | Exception caught in acquire queue; lock not held; safe release. |
| **RCD-03** | Acquire applies lock then rejects | All | `false` | `false` | **PASS** | Modal unmount calls release, which cleans up dangling host state. |
| **RCD-04** | Release resolves normally | All | `false` | `false` | **PASS** | Symmetrical cleanup succeeds. |
| **RCD-05** | Release rejects before Host releases | Desktop IPC | `false` | `true` | **PASS_WITH_BOUNDARY_LIMITATION** | Local lock resets to `false` via `finally`, preventing client UI deadlock; host remains locked due to transport failure. Boundary limitation documented. |
| **RCD-05W** | Native Web runtime recording | DSH Web | `false` | `false` | **PASS** | DSH Web `webShortcutStorage.recording` is a safe `async () => {}`. Zero failure risk. |
| **RCD-06** | Release applies unlock then rejects | All | `false` | `false` | **PASS** | Local lock false; host unlocked before rejection. |
| **RCD-07** | Rapid open / close | All | `false` | `false` | **PASS** | Chained promises serialize execution; acquire completes before release begins. |
| **RCD-08** | Unmount during acquire | All | `false` | `false` | **PASS** | Unmount registers release onto the serialized queue; finishes cleanly with `held = false`. |
| **RCD-09** | Repeated release | All | `false` | `false` | **PASS** | Idempotency guard (`released = true`) ensures release executes at most once. |
| **RCD-10** | Modal re-opened while cleanup pending | All | `false` (both) | `false` | **PASS** | Concurrent modals operate independent sequential queues without leaking locks. |

---

## 3. Provable Guarantees vs Acknowledged Boundaries

### Provable Guarantees
1. **Zero UI Deadlock**: Local `isHeld()` is strictly guaranteed to return `false` on release via `try-finally`, preventing modal unmount or navigation freezes.
2. **Unhandled Rejection Immunity**: All internal queue promises catch errors (`.catch(() => {})`), strictly preventing uncaught promise rejections from crashing the host or React tree.
3. **Queue Serialization**: Concurrency is serialized sequentially via promise chaining (`this.queue = this.queue.catch(...).then(...)`).
4. **Idempotence**: Duplicate `release()` calls are no-ops.
5. **DSH Web Invariance**: In the supported DSH Web client, `recording` is an asynchronous no-op, eliminating host recording divergence.

### Acknowledged Boundaries
- In hypothetical or unverified Desktop environments where `recording` is backed by a stateful native IPC, a transport disconnection during `recording(false)` leaves the remote process recording. The client plugin cannot recover this remotely because DSH exposes neither a query method (`getRecordingState()`) nor an external reset endpoint. Upstream does not auto-recover on window blur.
