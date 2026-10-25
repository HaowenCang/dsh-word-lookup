# dsh-word-lookup

A low-interruption English–Chinese dictionary for the DSH Web client. Select an
English word or phrase in a conversation and look it up with a keyboard shortcut;
nothing leaves your machine and no model is involved.

## Status

**Version: v0.2.2 — maintenance fixes and reliability hardening.**
See [`docs/releases/v0.2.2.md`](docs/releases/v0.2.2.md) for changes and validation limits. Check [GitHub Releases](https://github.com/HaowenCang/dsh-word-lookup/releases) and [npm](https://www.npmjs.com/package/dsh-word-lookup) for publication status.

The previous v0.2.1 release addressed dictionary card text formatting, multiline translation/definition rendering, part-of-speech badge deduplication and lexical boundary refinement, and settings UI label updates. See [`docs/releases/v0.2.1.md`](docs/releases/v0.2.1.md) for detailed release notes.

The plugin is local-first and uses SQLite (`node:sqlite`) for dictionary lookup. The public npm package does not bundle or redistribute the full ECDICT database corpus (manifest status: `REDISTRIBUTION REVIEW REQUIRED`). On startup, the plugin immediately provides a deterministic, zero-dependency built-in fixture dictionary with zero external network requests. Full lexicon coverage is available via one-click user-orchestrated Managed ECDICT installation from the pinned public corpus source with streaming SHA-256 and UTF-8 verification, or via user-provided custom SQLite dictionary imports staged into immutable managed snapshots.

| Area | State |
| --- | --- |
| Target client | DSH Web (`0.2.1-rc.3`) |
| DSH baseline | `0.2.1-rc.3` — verified with a newly created isolated Web profile |
| DSH 0.2.1-rc.2 status | `NOT_VERIFIED` — targeted verification candidate (see release notes) |
| Desktop / other targets | Desktop adapters and earlier DSH versions are unverified / unsupported |
| Package version | `0.2.2` |
| Distribution | GitHub release assets; npm upload is completed separately by the maintainer |
| Manual shortcut lookup | works; primary supported path (`Primary+Shift+L` by default, fully customizable) |
| Settings persistence | works, verified across full restart and reboot |
| Automatic lookup on double-click | works when `autoDoubleClick` is on (default off), verified in a real browser |
| Automatic lookup on drag-select | works when `autoSelection` is on (default off); portability outside the measured environment remains a known release limitation |
| Dictionary storage | local SQLite (`node:sqlite`) — package-owned deterministic fixture, one-click managed ECDICT, or immutable custom SQLite snapshots |
| Dictionary configuration | Host Config model (`dictionaryMode`, `customDictionaryPath`, `autoDoubleClick`, `autoSelection`, `activeSnapshotId`) |
| Multi-snapshot management | works; settings UI supports importing, switching, and deleting custom snapshots |
| Snapshot protection | active snapshot is strictly protected against deletion until deactivated |
| User source safety | custom SQLite import creates an isolated managed snapshot; user source files are never modified, moved, or deleted |
| Dictionary card UI | headword, phonetic, POS, multiline Chinese meaning, English definition, forms and examples |
| Pointer devices | mouse only — automatic lookup is refused for pen, touch and an unidentifiable pointer |

### Installation

#### Release v0.2.2

After v0.2.2 is available on npm, install it in DSH Web:

```powershell
dsh plugin --profile web add dsh-word-lookup@0.2.2
dsh --profile web
```

#### Development & Local Verification

To run runtime verification tests or develop locally against an isolated profile:

```powershell
$runRoot = Join-Path $env:TEMP ("dsh-word-lookup-test-" + [guid]::NewGuid())
npm run iso:check -- --test-root $runRoot
npm run test-profile:create -- --test-root $runRoot
# Save the independently printed CLEANUP_TOKEN outside $runRoot.
$cleanupToken = '<token from create output>'
npm run test:runtime -- --test-root $runRoot
# After every owned process/worker has exited and evidence is saved outside $runRoot:
npm run test-profile:cleanup -- --test-root $runRoot --cleanup-token $cleanupToken --evidence-recorded --processes-exited
```

### Historical Versions

#### Release v0.2.0

Release v0.2.0 introduced one-click Managed ECDICT on-demand download, custom SQLite immutable snapshot imports, and host configuration management:

```powershell
dsh plugin --profile web add dsh-word-lookup@0.2.0
dsh --profile web
```

#### Release v0.1.0

The initial release of `dsh-word-lookup` provided basic SQLite fixture lookup and shortcut invocation:

```powershell
dsh plugin --profile web add dsh-word-lookup@0.1.0
dsh --profile web
```

## Compatibility Scope

- **Candidate Verified Target**: DSH `0.2.1-rc.3`, the exact version returned by the installed CLI, with a newly created isolated Web profile. Candidate installation, startup, fixture queries, settings, rendering, and uninstallation were verified; this does not declare compatibility for the Desktop profile.
- **Historical Target**: DSH `0.2.0-rc.2` was verified for v0.2.1. It has not been rerun for v0.2.2 and remains `unknown` in this candidate. Rollback and other runtime versions also remain unverified.
- **Candidate Target (DSH 0.2.1-rc.2)**: `NOT_VERIFIED`. In the absence of end-to-end empirical testing, DSH `0.2.1-rc.2` is not declared compatible and the v0.2.2 candidate does not claim compatibility for it. It is recorded as a candidate target for future independent compatibility validation.
- **Unsupported Environments**: DSH Desktop profiles, native desktop electron wrappers, and DSH versions prior to `0.2.0-rc.2` are unverified and unsupported.

## Known Limitations & Disclosures

### Windows SQLite path length

Keep the complete managed database and temporary candidate paths below 260 characters in the measured Windows runtimes. Synthetic checks on Node 24.13.0 and the DSH carrier Node 24.21.0 opened 259-character paths but rejected paths of 260 characters or more, even when the filesystem could reserve the file. A shorter DSH home and test root avoid this platform boundary.


### 1. Automatic Selection Portability (`autoSelection`)

`autoSelection` (automatic lookup on mouse drag-selection) remains strictly opt-in and defaults to **OFF**. Automatic lookup on drag-selection has been measured and verified on Windows/Chromium at standard DPI settings. Portability across unmeasured operating systems, display servers (e.g., Wayland/X11), high-DPI scaling, and platform multi-click timing differences is not established and is classified as a known release limitation.

The manual keyboard shortcut (`Primary+Shift+L`) is unaffected, has zero gesture timing dependencies, and remains the primary, recommended interaction.

The two automatic switches (`autoDoubleClick`, `autoSelection`) exist in the settings UI, default to **OFF**, and persist across restarts. Each switch controls strictly the gesture it names:

```text
autoSelection    a completed pointer drag selection (not a selectionchange)
autoDoubleClick  a double click the browser recognized
```

- **A double click is never answered by `autoSelection`**: The classifier's 5 px drag threshold and the browser's double-click recognition are distinct rules. The plugin reads platform click multiplicity on `mousedown` and refuses an `auto-selection` lookup unless the press was verifiably a *single* click. An unmeasured press does not produce automatic I/O.
- **`autoSelection` is not "the selection changed"**: Keyboard selection, programmatic selection, and selections resulting from double-clicks are deliberately excluded. The plugin never triggers a lookup from a DOM `selectionchange` event.

### 2. Scenario F03 Process Crash Recovery Boundary

In fault-injection testing under Scenario F03 (a process crash occurring during transition from custom dictionary mode to built-in fixture mode, immediately after the durable metadata file `active.json` is unlinked on disk but before the host settings synchronization RPC is acknowledged):
- **Data Plane Resiliency**: Upon restart, the data plane safely falls back to the built-in deterministic fixture dictionary (`activeMode: fixture`). Vocabulary lookup functionality is 100% operational.
- **Data Integrity**: User source database files and managed snapshots remain 100% intact without data loss or corruption.
- **Truthful Status Reporting**: Because the host configuration synchronization RPC was interrupted by the crash, host configuration may still display the prior mode. The runtime truthfully reports `settingsSyncState: 'pending'` to disclose that disk state and host configuration have not yet synchronized.
- **Recovery Requirement**: This pending state is stable and will not cause runtime errors, but **it will not automatically converge during idle periods**. The user must explicitly click and select the dictionary mode ("内置词典 / Fixture") once in the settings UI to complete host settings synchronization and transition `settingsSyncState` to `'synced'`.

### 3. ECDICT Corpus Redistribution & Network Boundary

- **Package Redistribution**: The full ECDICT database corpus is **NOT** bundled or redistributed in this repository, npm packages, or GitHub Releases (manifest status: `REDISTRIBUTION REVIEW REQUIRED`). Only the deterministic 7-entry test fixture and metadata manifest (`corpus/ecdict.manifest.json`) are included in the package.
- **Zero Network for Lookups**: Dictionary word lookups run strictly against local SQLite and never make outbound network requests, never contact third-party translation services, and never send queries to AI models or LLM token endpoints.
- **Explicit Network on Installation**: Outbound network requests occur **only** when the user explicitly triggers the "Install ECDICT" action in the settings UI. The host then streams the corpus directly from the pinned public repository source with streaming SHA-256 integrity and UTF-8 validation before building the local SQLite database in a background worker.

## How it works

```text
browser (client half)                          host (Node half)
  selectionchange -> local snapshot only
  pointer/dblclick -> local gesture state only
                       + monotonic gesture identity
  gesture completes --> trigger gate --> maybe a lookup
  shortcut run -------> POST api/dsh-word-lookup ----> DictionaryManager
                                                         -> active Dictionary (fixture on startup)
                      <--------- structured result
  latest request wins <--------- card state
  shell.overlay <---- renders the card
```

- **No AI.** The lookup path never calls a model provider, a translation API or
  anything that consumes tokens. There is no network call other than the local
  route back to the host process.
- **No transcript mutation.** The plugin only reads `Selection` and `Range`. It
  never inserts elements into conversation text and never wraps a selection.
- **Interface only through DSH surfaces.** The overlay is a `shell.overlay`
  occupant, the command is registered with DSH's shortcut service, and the
  settings use DSH's own configuration form so the switches persist with the
  profile.

### Dictionary Storage & Lifecycle

The plugin architecture routes dictionary lookups through `DictionaryManager`:

```text
lookup route → DictionaryManager → active Dictionary
```

- **DictionaryManager Lifecycle & Hot Switching**:
  The route maintains a stable reference to `DictionaryManager`, which implements the `Dictionary` interface. Candidate dictionaries are opened and validated prior to atomic active reference replacement.
- **Deterministic Fixture Mode Startup & Zero Automatic Network**:
  The host runtime starts strictly on the built-in deterministic fixture database (`sqlite-fixture`) and makes zero external network requests on startup. Network access occurs only when a user explicitly initiates the Managed ECDICT download through the settings UI. The full ECDICT corpus is not bundled in the npm package (`redistributionStatus: REDISTRIBUTION REVIEW REQUIRED`).
- **One-Click Managed ECDICT Installation**:
  Users can trigger the managed ECDICT dictionary installation from Settings. The host streams the corpus from the pinned public source with strict hash/size/encoding verification and compiles the SQLite database in an isolated worker thread.
- **Custom SQLite Import & Immutable Managed Snapshots**:
  Users can import their own SQLite dictionaries matching the schema. The plugin creates an isolated, verified snapshot via `VACUUM INTO`, preserving user source databases untouched. Multi-snapshot switching is supported, with active snapshot deletion strictly prevented.
- **Zero Legacy Environment Variables**:
  Legacy environment variable database activation has been completely removed. Host startup and dictionary resolution no longer inspect any process environment variables.
- **Fail-Closed Guarantee**:
  If a dictionary cannot be opened or initialized, the plugin fails closed with a controlled error rather than falling back to remote APIs or token-consuming AI models.

### When a lookup happens

Three paths, and only three:

| path | trigger | can it be disabled |
| --- | --- | --- |
| `shortcut` | `Primary+Shift+L` on a qualifying selection | no — it is the first-class path |
| `auto-selection` | a completed pointer **drag** that selected qualifying text | yes, `autoSelection` |
| `auto-double-click` | the browser's own `dblclick` on qualifying text | yes, `autoDoubleClick` |

Every automatic lookup passes through one gate (`src/client/trigger.ts`) which
decides, in order: is this a real drag or double click; has this gesture identity
already been used; is the switch that owns it on *right now*; is the pointer a
kind this build measured; for a drag, was the press the platform's own *single*
click; and was the selection captured when the gesture completed eligible. A
refusal never consumes the gesture, so turning a switch on makes the very next
gesture work and nothing else.

Identity is a monotonic number allocated when a pointer press opens a gesture —
never the text, never the rectangle, never a time window. Two deliberate
double-clicks on the same word are therefore two lookups, and one gesture can
never buy two. Identity alone was not enough to keep the two switches apart: a
drifting double click spent its identity on the drag path before the browser's
`dblclick` arrived, which is why the platform's click multiplicity is carried
with the classification and checked by the gate.

Requests are numbered too, so the newest lookup owns the card: a slow answer for
A cannot roll the card back from B, and a superseded failure cannot bury a newer
hit.

### The dictionary

`src/host/fixture.ts` holds the fixture as literals; `scripts/build-fixture-db.mjs`
materialises it into `fixtures/dictionary.fixture.db`; `src/host/sqlite-dictionary.ts`
answers from it through prepared statements with bound parameters. The host opens
the database once per plugin lifecycle and closes it on unload, so repeated
load/unload cycles cannot accumulate handles.

The fixture database path is package-derived. There is no manual environment variable configuration.

```powershell
npm run build:fixture   # rebuild fixtures/dictionary.fixture.db and validate it
```

`npm run verify` runs that step first, so the runtime always reads a freshly
validated file. The database is generated rather than committed: every row is a
literal in `src/host/fixture.ts`, and the host rebuilds it on first open if it is
absent or stale.

Lookup precedence is fixed: an exact entry (including an exact multi-word phrase)
first, then the `forms` table for an inflection, then that headword's examples.
There is no stemming, no spelling correction, no lemma guessing, and never a
silent split of a phrase into separate word queries.

## Commands

```powershell
npm install
npm run verify        # fixture + typecheck + unit tests + build + static bundle checks
```

Individual steps:

```powershell
npm run typecheck
npm test
npm run build
```

## Testing against a real DSH instance

**Never test against the DSH you are using.** A test once ran against a live
profile and destroyed it. Runtime tests must run in a fully isolated
environment, and the only supported entry point is:

```powershell
$runRoot = Join-Path $env:TEMP ("dsh-word-lookup-test-" + [guid]::NewGuid())
npm run iso:check -- --test-root $runRoot
npm run test-profile:create -- --test-root $runRoot
$cleanupToken = '<token from create output>'  # keep outside $runRoot
npm run test:runtime -- --test-root $runRoot
# Confirm all owned processes/workers exited and save the evidence before cleanup.
npm run test-profile:cleanup -- --test-root $runRoot --cleanup-token $cleanupToken --evidence-recorded --processes-exited
```

Every runtime entry point asserts isolation first and exits non-zero otherwise.
See [`docs/ISOLATION-TEST-PLAN.md`](docs/ISOLATION-TEST-PLAN.md) — that document
is a standing engineering rule, not incident paperwork.

## Permissions & Security Disclosure (DSH STORE Review)

### Files
- The plugin uses local SQLite (`node:sqlite`) strictly on the host side.
- Fixture databases are read directly on the local machine in read-only mode.
- No dictionary corpus, word lookups, or user queries are ever uploaded or written outside local cache/storage.
- No files outside package-owned data and user-designated import files are accessed.

### Network
- The browser client only calls the DSH host's same-origin `/api/dsh-word-lookup` HTTP POST route.
- Zero remote dictionary services or third-party translation APIs.
- Zero LLM / model provider APIs or token consumption.
- Zero external network requests during dictionary lookup operations.
- Outbound network requests occur exclusively during user-initiated Managed ECDICT download from the pinned public corpus repository.

### Environment & Credentials
- Zero environment variables are read by the active runtime.
- The `credentials` permission signal is `false`.
- No API keys, access tokens, account passwords, or personal credentials are read, stored, or transmitted.

### Corpus Redistribution
- Full ECDICT redistribution is **NOT included and NOT authorized** in this repository, npm packages, or GitHub Releases.
- Only the deterministic 7-entry test fixture and metadata manifests (`corpus/ecdict.manifest.json`) are distributed.

### Known Release Limitation: automatic-selection portability
- Automatic lookup on drag-selection is verified only in measured Windows/Chromium/DPI environments. Cross-platform timing, multi-click behaviors, and display server differences mean `autoSelection` remains an experimental opt-in feature.
- `autoSelection` defaults to **OFF**.
- `autoDoubleClick` defaults to **OFF**.
- The primary and recommended method remains the manual keyboard shortcut (`Primary+Shift+L`).

## Repository layout

```text
src/
  index.ts              host half: Config schema, dictionary lifecycle, the route
  host/                 request handling, the SQLite dictionary, fixture data, route path, config model
  shared/               types and text normalization shared by both halves
  client/
    index.tsx           browser runtime: overlay, command, settings, listeners
    gesture.ts          pure gesture classifier + identity (no DOM, no I/O)
    trigger.ts          pure trigger gate: switches, eligibility, de-duplication
    lookup.ts           request identity, supersession, the card's published state
    selection.ts        selection qualification and live-Range geometry
    card.tsx            the shell.overlay occupant
fixtures/               generated fixture database (gitignored; see `npm run build:fixture`)
lib/                    build output; committed because the loader reads it directly
scripts/                build, verification and isolated-test tooling
docs/                   evidence and engineering rules
tests/                  unit tests (vitest)
```

## Documentation

- [`docs/releases/v0.2.1.md`](docs/releases/v0.2.1.md) — formal v0.2.1 release notes
- [`docs/evidence/phase7a11-published/release-summary.md`](docs/evidence/phase7a11-published/release-summary.md) — Phase 7A.11 formal publication report
- [`docs/evidence/phase7a10-prep/release-notes-v0.2.0.md`](docs/evidence/phase7a10-prep/release-notes-v0.2.0.md) — formal v0.2.0 release notes
- [`docs/RECOVERY_AUDIT.md`](docs/RECOVERY_AUDIT.md) — what was verified and when
- [`docs/ISOLATION-TEST-PLAN.md`](docs/ISOLATION-TEST-PLAN.md) — mandatory test isolation
- [`docs/PHASE1_EVIDENCE.md`](docs/PHASE1_EVIDENCE.md) — Phase 1 runtime results
- [`docs/PHASE2_EVIDENCE.md`](docs/PHASE2_EVIDENCE.md) — gesture classification results
- [`docs/PHASE3_EVIDENCE.md`](docs/PHASE3_EVIDENCE.md) — SQLite dictionary results
- [`docs/PHASE4_EVIDENCE.md`](docs/PHASE4_EVIDENCE.md) — trigger gate, de-duplication and request ordering

## License

MIT.
