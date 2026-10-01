# dsh-word-lookup

A low-interruption English–Chinese dictionary for the DSH Web client. Select an
English word or phrase in a conversation and look it up with a keyboard shortcut;
nothing leaves your machine and no model is involved.

## Status

**Early development.** The dictionary is a local stub. Read this before relying
on anything below.

| Area | State |
| --- | --- |
| Target client | DSH Web (`0.2.0-rc.2`) |
| DSH baseline | `0.2.0-rc.2`, Web only — the desktop client is not a tested target |
| Package version | `0.1.0-dev.0`, private, not published |
| Manual shortcut lookup | works, verified in a real browser |
| Settings persistence | works, verified across a full restart |
| Automatic lookup on double-click | **not implemented** |
| Automatic lookup on drag-select | **not implemented** |
| Real dictionary data (ECDICT / Tatoeba) | **not implemented** — the host answers from a small built-in stub |
| Dictionary card UI | minimal; shows headword, phonetic, meanings and examples from the stub |

The two automatic switches (`autoDoubleClick`, `autoSelection`) exist in the
settings UI, default to **off**, and persist. They currently drive **nothing**:
gesture classification exists, but no gesture triggers a lookup yet. Turning them
on will not make automatic lookup happen.

## How it works

```text
browser (client half)                     host (Node half)
  selectionchange -> local snapshot only
  pointer/dblclick -> local gesture state only
  shortcut run -----> POST api/dsh-word-lookup ----> local dictionary lookup
                                                     (stub today; SQLite later)
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

## Commands

```powershell
npm install
npm run verify        # typecheck + unit tests + build + static bundle checks
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
  index.ts              host half: Config schema + the exact Fetch route
  host/                 request handling, stub dictionary, route path
  shared/               types and text normalization shared by both halves
  client/
    index.tsx           browser runtime: overlay, command, settings, listeners
    gesture.ts          pure gesture classifier (no DOM, no I/O)
    selection.ts        selection qualification and live-Range geometry
    card.tsx            the shell.overlay occupant
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

## License

MIT.
