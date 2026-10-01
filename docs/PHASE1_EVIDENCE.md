# Phase 1 Runtime Evidence

This file is the durable summary of the runtime verification. The machine-readable
report is checked in beside it at `docs/evidence/phase1-verification.json` (the
`verify-out/` copy is working state and is gitignored).

## 1. What was verified

Phase 1's foundation: the host config schema, the exact Fetch route, the settings
namespace and its persistence across a restart, the `shell.overlay` occupant, the
manual `Primary+Shift+L` command, the selection qualification predicate, and the
guarantee that with both automatic switches off no gesture produces a request.

## 2. Runs

| | Original run | Post-incident re-run |
| --- | --- | --- |
| date | 2026-09-30T13:03:22Z | 2026-10-01T08:07:32Z |
| result | PASS — 64/64 | PASS — 64/64 |
| `DSH_HOME` | `%TEMP%\dsh-phase1-iso` | `%TEMP%\dsh-word-lookup-test\home` |
| profile | `wlphase1` | `word-lookup-test` |
| port | 50998 | 50991 |
| isolation gate | not present at the time | `ISOLATION CHECK: PASS` |
| DSH | 0.2.0-rc.2 | 0.2.0-rc.2 |
| Node | v24.13.0 | v24.13.0 |
| browser | Chromium 153.0.8010.12 | Chromium 153.0.8010.12 |

Both runs measured the **same artifacts**: `lib/client.js` SHA-256
`D6A219A554103A8ED9E442FDACE8E36C5F748E140C0731A1B592283EA2E84303` and
`lib/index.js` SHA-256 `294723B6222A0571D54C3D0E927074DE10A246F07A763EB6DFE4C658B207458A`.
The post-incident run rebuilt from source and reproduced those hashes byte for
byte, so the original measurements still describe the current tree.

## 3. Safety-critical measurements

| Check | Claim | Observed |
| --- | --- | --- |
| B20 | both settings default to `false` | `{"autoDoubleClick":false,"autoSelection":false}` |
| B19 | with both off, double click + drag produce zero lookups | `requests=0` |
| B07 | no eligible selection → shortcut resolves `pass` and consumes nothing | `resolveCalls:1, passReturns:1, runCalls:0, defaultPrevented:false` |
| B08 | a selection outside a conversation flow item does not qualify | `eligible:false, requests=0` |
| B09 | a selection inside the composer does not qualify (T08) | `eligible:false, requests=0` |
| B10 | qualifying selection + shortcut → exactly one request (T03) | `requests.length=1`, `POST /api/dsh-word-lookup` |
| B04/B13 | the overlay occupant registers exactly once | `registrationCount:1` |
| B22 | the plugin added no node outside the overlay layer | `pluginNodesOutsideOverlay:0` |
| S01 | a settings write changes the client snapshot without a restart | `revision:1` |
| S03 | the accepted write is persisted to the profile patch on disk | entry `dsh-word-lookup` present in the patch |
| S04 | the two switches are independent | writing one left the other unchanged |
| S05/S06 | both switches survive a full restart | `{"autoDoubleClick":true,"autoSelection":true}` after boot 2 |
| F05 | the route stays behind the connection fence without a session | `status=401` |
| L01–L05 | reload and restart produce no duplicate registration or console error | `unexpected=[] pageErrors=[]` |

## 4. Check inventory

The report records 64 checks in five groups:

- **H01–H03** — the isolated process starts, stops cleanly, and boots a second time.
- **B01–B22** — first boot: boot manifest, overlay, command catalog, selection
  qualification, request shape, settings defaults.
- **BA0–BA1 / RA0–RA1** — command behaviour while a modal dialog is open.
- **S01–S07** — settings write, live propagation, persistence, restart, independence.
- **F05** — unauthenticated access to the route.
- **L01–L05** — reload, restart, console cleanliness, host boot log.
- **R01–R22** — the same first-boot battery re-run against the restarted instance.

`summary: { total: 64, passed: 64, failed: [] }`.

## 5. Environment isolation actually observed

```text
home            C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home
profile         word-lookup-test
profileDir      …\dsh-word-lookup-test\home\profiles\word-lookup-test
port            50991
workdir         E:\Projects\DSHarness\dsh-word-lookup
firstBootUrl    http://127.0.0.1:50991/?token=<redacted>
secondBootUrl   http://127.0.0.1:50991/?token=<redacted>
```

The browser authenticated with the isolated instance's **own launch token**. No
session cookie was read from or shared with any other browser session.

The profile patch recorded after the write, proving the settings landed in the
isolated profile and nowhere else:

```yaml
- id: dsh-word-lookup
  name: dsh-word-lookup
  config:
    autoDoubleClick: false
    autoSelection: true
```

## 6. Post-run safety confirmation

```text
port 50991                        FREE (isolated process stopped)
port 19387                        still owned by the reader's instance, untouched
production profile bundles        unchanged; dsh-word-lookup absent
production profile dependency     unchanged; dsh-word-lookup absent
production profile junction       absent
production DSH profile touched:   NO
production session data touched:  NO
production port touched:          NO
production loader touched:        NO
production routes touched:        NO
```

## 7. Scope boundary

Phase 1 does **not** implement the two automatic triggers, and the run does not
claim it does. `runLookup` accepts a single origin, `'shortcut'`; nothing but the
command can reach it. `autoDoubleClick` and `autoSelection` are read, mirrored and
persisted, but no gesture consults them yet — that is Phase 2 work. B19's zero
request count is therefore a statement about Phase 1's scope, not a finished
guarantee for the shipped product.
