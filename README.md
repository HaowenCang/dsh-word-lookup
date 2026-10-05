# dsh-word-lookup

A low-interruption English–Chinese dictionary for the DSH Web client. Select an
English word or phrase in a conversation and look it up with a keyboard shortcut;
nothing leaves your machine and no model is involved.

## Status

**v0.1.1 Release Candidate.** The plugin is local-first and uses SQLite for dictionary lookup. The public package does not redistribute the full ECDICT corpus; production-corpus activation is an explicit local opt-in.

| Area | State |
| --- | --- |
| Target client | DSH Web (`0.2.0-rc.2`) |
| DSH baseline | `0.2.0-rc.2`, Web only — the desktop client is not a tested target |
| Package version | `0.1.1` |
| Manual shortcut lookup | works; primary supported path |
| Settings persistence | works, verified across a full restart |
| Automatic lookup on double-click | works when `autoDoubleClick` is on (default off), verified in a real browser |
| Automatic lookup on drag-select | works when `autoSelection` is on (default off); portability outside the measured environment remains a known release limitation |
| Dictionary storage | local SQLite (`node:sqlite`), package-owned deterministic fixture by default |
| Dictionary data (ECDICT) | local ECDICT corpus supported via explicit `DSH_WORD_LOOKUP_DB_PATH` opt-in; full corpus is not bundled |
| Dictionary card UI | headword, phonetic, POS, Chinese meaning, forms and examples |
| Pointer devices | mouse only — automatic lookup is refused for pen, touch and an unidentifiable pointer |

### Install

```powershell
dsh plugin --profile web add dsh-word-lookup@0.1.1
dsh --profile web
```

The package intentionally does **not** include the full ECDICT corpus. Without `DSH_WORD_LOOKUP_DB_PATH`, the deterministic fixture dictionary is used. To use an already-built and provenance-compatible production database, set the environment variable before starting DSH:

```powershell
$env:DSH_WORD_LOOKUP_DB_PATH = "E:\\path\\to\\ecdict.db"
dsh --profile web
```

If explicit production activation fails schema, metadata, hash, or integrity validation, the plugin fails closed and does not fall back to the fixture.

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
  shortcut run -------> POST api/dsh-word-lookup ----> SQLite dictionary lookup
                                                       (fixture by default;
                                                        ECDICT when explicitly activated)
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

### Dictionary Storage & Runtime Activation Semantics

The plugin operates with fail-closed dictionary loading semantics:

- **Default Fixture Mode (Unset `DSH_WORD_LOOKUP_DB_PATH`)**:
  When `DSH_WORD_LOOKUP_DB_PATH` is not set, the plugin initializes its package-owned deterministic fixture database (`dsh-word-lookup-fixture`). This is the default public-package behavior and is intentionally distinct from production-corpus activation.
- **Explicit Production Corpus Opt-In (`DSH_WORD_LOOKUP_DB_PATH`)**:
  Setting `DSH_WORD_LOOKUP_DB_PATH=<path-to-db>` explicitly requests production dictionary activation. The host loads the specified SQLite database in read-only mode and strictly verifies the production schema, indexes (`idx_forms_headword_raw`, `idx_examples_headword`), primary keys, and metadata (`corpus_name === 'ECDICT'`, `upstream_commit`, `source_sha256`, `schema_version`) against the pinned `corpus/ecdict.manifest.json`.
- **Fail-Closed Guarantee (No Silent Fallback)**:
  If production activation is requested via `DSH_WORD_LOOKUP_DB_PATH` and the database is missing, corrupted, or fails metadata/schema verification:
  - The plugin refuses activation with a controlled `DictionaryUnavailableError`.
  - The lookup route is NOT registered (answering HTTP 404).
  - No silent fallback to fixture database occurs.
  - No fallback to AI/remote dictionary occurs.

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

The fixture database path is package-derived and is not user-configurable. Production-corpus activation is intentionally separate: an operator may provide a read-only compatible database path through the process environment variable `DSH_WORD_LOOKUP_DB_PATH`. There is no writable UI `dictionaryPath` setting.

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
- Fixture and local dictionary databases are read directly on the local machine.
- Production ECDICT databases are opened via local filesystem paths (`DSH_WORD_LOOKUP_DB_PATH`).
- No dictionary corpus, word lookups, or user queries are ever uploaded or written outside local cache/storage.
- No files outside the plugin fixture and specified local database paths are accessed.

### Network
- The browser client only calls the DSH host's same-origin `/api/dsh-word-lookup` HTTP POST route.
- No remote dictionary services.
- No third-party translation APIs.
- No LLM / model provider APIs or token consumption.
- No external lookup requests or outbound network traffic whatsoever.

### Environment & Credentials
- `process.env.DSH_WORD_LOOKUP_DB_PATH` is read solely to determine the local filesystem path to an optional pre-built production dictionary database.
- The static security scanner flags `process.env` as a credentials signal; however, no API keys, access tokens, account passwords, or personal credentials are ever read, stored, or transmitted.

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
  host/                 request handling, the SQLite dictionary, fixture data, route path
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
