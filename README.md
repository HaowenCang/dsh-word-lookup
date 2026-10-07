# dsh-word-lookup

A low-interruption English–Chinese dictionary for the DSH Web client. Select an
English word or phrase in a conversation and look it up with a keyboard shortcut;
nothing leaves your machine and no model is involved.

## Status

**Current development target: v0.2.0 — unreleased.**
The latest published release is **v0.1.0**.

The plugin is local-first and uses SQLite for dictionary lookup. The public package does not redistribute the full ECDICT corpus. In Phase 7A.4, a pinned, HTTPS-only ECDICT downloader primitive is implemented with streaming size, SHA-256, and fatal UTF-8 verification, cancellation, and safe cache publication; host startup performs no automatic download (fixture-only on startup), and user-facing installation UI orchestration remains pending.

| Area | State |
| --- | --- |
| Target client | DSH Web (`0.2.0-rc.2`) |
| DSH baseline | `0.2.0-rc.2`, Web only — the desktop client is not a tested target |
| Development version | `0.2.0` (unreleased) |
| Latest published release | `0.1.0` |
| Manual shortcut lookup | works; primary supported path (`Primary+Shift+L`) |
| Settings persistence | works, verified across full restart |
| Automatic lookup on double-click | works when `autoDoubleClick` is on (default off), verified in a real browser |
| Automatic lookup on drag-select | works when `autoSelection` is on (default off); portability outside the measured environment remains a known release limitation |
| Dictionary storage | local SQLite (`node:sqlite`), package-owned deterministic fixture in Phase 7A.1 |
| Dictionary configuration | Host Config model (`dictionaryMode`, `customDictionaryPath`, `autoDoubleClick`, `autoSelection`) |
| Dictionary card UI | headword, phonetic, POS, Chinese meaning, forms and examples |
| Pointer devices | mouse only — automatic lookup is refused for pen, touch and an unidentifiable pointer |

### Installation

#### Published Release (v0.1.0)

To install the latest published release in DSH Web:

```powershell
dsh plugin --profile web add dsh-word-lookup@0.1.0
dsh --profile web
```

#### Development Version (v0.2.0)

The v0.2.0 version is an active development branch and is not published to npm. To test or develop locally, link the local checkout to an isolated profile:

```powershell
npm run test-profile:create
npm run test:runtime
```

### Known v0.1.0 limitation

`autoSelection` remains opt-in and defaults to off. Its portability across unmeasured operating systems, display servers, DPI settings, and platform multi-click configurations is not yet established. The manual `Primary+Shift+L` path is unaffected and remains the primary supported interaction.

The two automatic switches (`autoDoubleClick`, `autoSelection`) exist in the
settings UI, default to **off**, and persist. Each one drives exactly the
gesture it names:

```text
autoSelection    a completed pointer drag selection   (not a selectionchange)
autoDoubleClick  a double click the browser recognised
```

Neither switch affects the manual `Primary+Shift+L` shortcut, which is the only
path that reaches the dictionary with both switches off.

**A double click is never answered by `autoSelection`.** The classifier's 5 px
drag threshold and the browser's own double-click recognition are different
rules, so a second press that drifts while selecting a word can satisfy both —
and the browser still reports the whole thing as `dblclick`. The plugin reads the
platform's click multiplicity off the `mousedown` that opens each press and
refuses an `auto-selection` lookup unless the press was verifiably a *single*
click, so a gesture the platform calls a double click is answered by
`autoDoubleClick` and nothing else. A press whose multiplicity was never observed
is refused too: an unmeasured press does not become automatic I/O.

**`autoSelection` is not "the selection changed."** A keyboard selection, a
programmatic one and the selection a double click produces are all deliberately
outside it, and the plugin never issues a lookup from a `selectionchange` event.
That is what keeps one double click to one lookup instead of two, and it is
asserted two ways: a syntax-tree check that the `selectionchange` handler reaches
no I/O, and a browser measurement that fifty programmatic selections issue zero
requests with `autoSelection` on.

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

The v0.2.0 architecture routes dictionary lookups through `DictionaryManager`:

```text
lookup route → DictionaryManager → active Dictionary
```

- **DictionaryManager Lifecycle & Hot Switching**:
  The route maintains a stable reference to `DictionaryManager`, which implements the `Dictionary` interface. Candidate dictionaries are opened and validated prior to atomic active reference replacement.
- **Deterministic Fixture Mode Startup & Zero Automatic Network**:
  The host runtime continues to start strictly on the built-in deterministic fixture database (`sqlite-fixture`) and makes zero external network requests on startup. Network access occurs only when an explicit future install action invokes the downloader. User-facing installation UI orchestration remains pending (Phase 7A.6/7A.7). The full ECDICT corpus is not redistributed in the repository or npm packages.
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
npm run iso:check              # verify the target is isolated and the port is free
npm run test-profile:create    # build the isolated profile
npm run test:runtime           # boot it, measure, shut it down
npm run test-profile:cleanup -- --evidence-recorded
```

Every runtime entry point asserts isolation first and exits non-zero otherwise.
See [`docs/ISOLATION-TEST-PLAN.md`](docs/ISOLATION-TEST-PLAN.md) — that document
is a standing engineering rule, not incident paperwork.

## Permissions & Security Disclosure (DSH STORE Review)

### Files
- The plugin uses local SQLite (`node:sqlite`) strictly on the host side.
- Fixture databases are read directly on the local machine in read-only mode.
- No dictionary corpus, word lookups, or user queries are ever uploaded or written outside local cache/storage.
- No files outside package-owned data are accessed.

### Network
- The browser client only calls the DSH host's same-origin `/api/dsh-word-lookup` HTTP POST route.
- No remote dictionary services.
- No third-party translation APIs.
- No LLM / model provider APIs or token consumption.
- No external lookup requests or outbound network traffic whatsoever.

### Environment & Credentials
- Zero environment variables are read by the active runtime.
- The `credentials` permission signal is `false`.
- No API keys, access tokens, account passwords, or personal credentials are read, stored, or transmitted.

### Corpus Redistribution
- Full ECDICT redistribution is **NOT included and NOT authorized** in this repository, npm packages, or GitHub Releases.
- Only the deterministic 7-entry test fixture and metadata manifests (`corpus/ecdict.manifest.json`) are distributed.

### Known Release Blocker: automatic-selection portability
- **RELEASE BLOCKER — automatic-selection portability: OPEN**.
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

- [`docs/RECOVERY_AUDIT.md`](docs/RECOVERY_AUDIT.md) — what was verified and when
- [`docs/ISOLATION-TEST-PLAN.md`](docs/ISOLATION-TEST-PLAN.md) — mandatory test isolation
- [`docs/PHASE1_EVIDENCE.md`](docs/PHASE1_EVIDENCE.md) — Phase 1 runtime results
- [`docs/PHASE2_EVIDENCE.md`](docs/PHASE2_EVIDENCE.md) — gesture classification results
- [`docs/PHASE3_EVIDENCE.md`](docs/PHASE3_EVIDENCE.md) — SQLite dictionary results
- [`docs/PHASE4_EVIDENCE.md`](docs/PHASE4_EVIDENCE.md) — trigger gate, de-duplication and request ordering

## License

MIT.
