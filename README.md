# dsh-word-lookup

A low-interruption English–Chinese dictionary for the DSH Web client. Select an
English word or phrase in a conversation and look it up with a keyboard shortcut;
nothing leaves your machine and no model is involved.

## Status

**Early development.** The dictionary is a real local SQLite database, but it
holds a small deterministic fixture rather than a production corpus. Read this
before relying on anything below.

| Area | State |
| --- | --- |
| Target client | DSH Web (`0.2.0-rc.2`) |
| DSH baseline | `0.2.0-rc.2`, Web only — the desktop client is not a tested target |
| Package version | `0.1.0-dev.0`, private, not published |
| Manual shortcut lookup | works, verified in a real browser |
| Settings persistence | works, verified across a full restart |
| Automatic lookup on double-click | **not implemented** |
| Automatic lookup on drag-select | **not implemented** |
| Dictionary storage | local SQLite (`node:sqlite`), package-owned fixture database |
| Dictionary data (ECDICT / Tatoeba) | **not imported** — the store holds a hand-written fixture covering six lookup shapes |
| Dictionary card UI | minimal; shows headword, phonetic, POS, Chinese meaning, forms and examples |

The two automatic switches (`autoDoubleClick`, `autoSelection`) exist in the
settings UI, default to **off**, and persist. They currently drive **nothing**:
gesture classification exists, but no gesture triggers a lookup. Turning them on
will not make automatic lookup happen. The manual `Primary+Shift+L` shortcut is
the only path that reaches the dictionary.

## How it works

```text
browser (client half)                     host (Node half)
  selectionchange -> local snapshot only
  pointer/dblclick -> local gesture state only
  shortcut run -----> POST api/dsh-word-lookup ----> SQLite dictionary lookup
                                                     (deterministic fixture)
                    <--------- structured result
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

### The dictionary

`src/host/fixture.ts` holds the fixture as literals; `scripts/build-fixture-db.mjs`
materialises it into `fixtures/dictionary.fixture.db`; `src/host/sqlite-dictionary.ts`
answers from it through prepared statements with bound parameters. The host opens
the database once per plugin lifecycle and closes it on unload, so repeated
load/unload cycles cannot accumulate handles.

The database path is **not a setting**. It is derived from the package's own
location, so there is no `dictionaryPath` a reader could aim at an arbitrary file.

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

## Repository layout

```text
src/
  index.ts              host half: Config schema, dictionary lifecycle, the route
  host/                 request handling, the SQLite dictionary, fixture data, route path
  shared/               types and text normalization shared by both halves
  client/
    index.tsx           browser runtime: overlay, command, settings, listeners
    gesture.ts          pure gesture classifier (no DOM, no I/O)
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

## License

MIT.
