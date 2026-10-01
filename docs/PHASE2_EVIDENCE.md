# Phase 2 Evidence — Selection Gesture Classification

## 1. Baseline

| Fact | Value |
| --- | --- |
| Recovery baseline commit | `619702926c34c26808dacf206fa8445baba2f968` |
| Branch | `master` |
| Worktree at baseline | clean, 61 files, first commit in the repository |
| Phase 2 started from | that commit, with no uncommitted work |

Phase 2 changed no file that the baseline had already verified correct beyond the
three it had to: the selection reader, the client runtime, and the verification
harness.

## 2. Environment

| Fact | Value |
| --- | --- |
| DSH | `0.2.0-rc.2` |
| Node | `v24.13.0` |
| npm | `11.12.0` |
| Browser (runtime run) | Chromium `153.0.8010.12` |
| vitest | `3.2.4` |
| tsdown / rolldown | `0.23.0` / `1.2.11` |

## 3. Files changed

New:

```text
src/client/gesture.ts             the pure classifier (no DOM, no I/O)
tests/client-gesture.spec.ts      31 classifier tests
README.md                         the packaging gap the recovery audit found
docs/PHASE2_EVIDENCE.md           this report
docs/evidence/phase2-verification-20261001.json
```

Modified:

```text
src/client/selection.ts           live-Range geometry
src/client/index.tsx              gesture listeners, snapshot, diagnostics
tests/client-selection.spec.ts    6 geometry tests
scripts/check-bundle.mjs          files[] validation + gesture/I/O checks
scripts/phase1-verify.mjs         probe layout fix, 12 Phase 2 runtime checks
```

Regenerated: `lib/client.js`, `lib/types/client/{index,selection,gesture}.d.ts`.

Nothing under `src/host/` or `src/shared/` changed: Phase 2 is entirely a browser
half concern.

## 4. Selection snapshot design

Two independent pieces of state, merged only when read:

```ts
interface SelectionFacts {           // advances on `selectionchange`
  present: boolean
  eligible: boolean
  text: string
  at: number
  rect: SelectionRect | null
}

interface GestureSnapshot {          // advances on pointer events
  kind: 'none' | 'drag' | 'double-click' | 'other'
  completedAt: number | null
  pointer: { startX; startY; endX; endY; distance } | null
}

type SelectionSnapshot = SelectionFacts & { gesture: GestureSnapshot }
```

The separation is deliberate. A `selectionchange` fires many times per drag and
says nothing about which gesture produced it, while a `pointermove` says nothing
about text. Keeping them apart means neither write path has to reconstruct the
other, and it is why no selection event can reach the classifier.

No DOM node, `Range` or `Selection` is stored in the snapshot. The `Range` is
read, measured and released inside `readEligibleSelection`; only plain numbers
survive. The snapshot is therefore safe to hand to React state, keep across
renders, or serialize into the diagnostics object.

## 5. Rect implementation

`readRangeRect(range)` is called on the same live range, in the same pass, that
produced the text — so one gesture's text can never be paired with another's
geometry.

```ts
export function readRangeRect(range: RangeLike): SelectionRect | null {
  if (range.collapsed) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}
```

- Collapsed selection, lost selection and a zero-area range all produce `null`.
- A zero-width but non-empty rect (a real caret box) is preserved rather than
  discarded.
- The parameter is the structural `RangeLike`, not `Range`, so the geometry rule
  is unit-tested without a DOM; a real `Range` satisfies it unchanged.
- The rect is **never** reconstructed from a previous measurement plus a scroll
  delta. Phase 0 §7.4 measured that scrolling moved `rect.y` by exactly the
  `scrollTop` change and that streaming re-renders the transcript, so a
  remembered rect is wrong in precisely the case the product cares about.

Measured in the real browser: `{"x":156.6875,"y":175,"width":37.859375,"height":19}`
for the word `derive`.

## 6. Gesture classifier

`src/client/gesture.ts` is a pure state machine. No DOM, no timers, no globals —
which is why the regressions that matter are covered without a browser.

```text
phase: idle | tracking | sealed

beginPointer(point, button)    button !== 0 -> ignored, no gesture opens
movePointer(point)             peak travel from origin, monotonic
endPointer(point, hasSelection) travel >= DRAG_THRESHOLD_PX && hasSelection
                                  ? 'drag' : 'other'
registerDoubleClick(point, hasSelection)
                               ? hasSelection ? 'double-click' : 'other'
                               then phase = 'sealed'
cancelGesture()                abandons in-flight state, keeps last verdict
```

- **`DRAG_THRESHOLD_PX = 5`** is a named, tested constant. Five CSS pixels clears
  the 1–3 px of jitter a real click carries and sits far below a deliberate text
  drag. The platform double-click interval is **not** re-derived here: the
  browser already performs that recognition and reports it as `dblclick`.
- **Distance is peak travel, not the start-to-end chord.** A drag that curves
  back towards where it began is still a drag; measuring the chord would
  reclassify it as a click. Documented at the field.
- **`pointercancel`, window `blur` and disposal** all abandon an in-flight
  gesture, so no half-built state survives any of them. Cancellation is
  idempotent, so `blur` plus `pointercancel` counts once.
- **Non-primary buttons** are ignored rather than tracked: a right-click drag
  carries no text selection, and letting it open a gesture would let it close one.

## 7. Event precedence

The rule the phase exists to enforce:

```text
dblclick classification outranks its trailing selectionchange
```

Three mechanisms enforce it, none of which relies on a timer:

1. **No selection event can reach the classifier.** The `selectionchange` listener
   refreshes `SelectionFacts` and nothing else. There is no function in
   `gesture.ts` that accepts a selection and names a gesture.
2. **A double click seals the gesture.** `registerDoubleClick` sets `phase:
   'sealed'`; `endPointer` returns a sealed state untouched. The `pointerup` that
   belongs to the double-click, and any stray release after it, cannot reopen or
   reinterpret it.
3. **Only a fresh `pointerdown` reopens classification**, so a genuine drag after
   a double click still classifies correctly.

Measured in the real browser, first boot and after restart:

```text
immediately after dblclick : kind = double-click
after the trailing event   : kind = double-click
drags counted in that window: 0
```

## 8. Unit tests

| | Before | After |
| --- | --- | --- |
| Test files | 9 | 10 |
| Tests | 83 | **120** |
| Failures | 0 | **0** |

New coverage — classifier (`tests/client-gesture.spec.ts`, 31 tests):

- below-threshold travel is not a drag; at-threshold and above is
- a long movement that selected nothing is not a drag
- peak travel, so a curve-back drag still counts
- a diagonal distance below threshold is not a drag
- a simple click is `other`, never `drag`
- a non-primary button opens no gesture
- double click with and without an eligible selection
- **the trailing selectionchange cannot turn a double click into a drag**
- a drag after a double click still classifies
- `pointercancel` clears transient state, keeps the last verdict, is idempotent,
  and prevents a later release from classifying
- counters start at zero, count once, and do not drift when folded repeatedly
- 100 drags + 100 double clicks classify as exactly 100 + 100

New coverage — geometry (`tests/client-selection.spec.ts`, +6 tests): one-line,
multi-line, collapsed, zero-area, caret-box and re-read-after-scroll.

## 9. 100 + 100 regression

Real trusted pointer input in the isolated browser. Both boots measured
identically:

```text
100 drags        -> drags classified        = 100
100 double clicks-> doubleClicks classified= 100
                    cancels                 = 0
                    lookup requests         = 0
```

Recorded as `B27` and `R27`. The classifier counters are asserted alongside the
request count on purpose: a request count of zero is worthless on its own,
because it holds equally for a plugin whose gesture listeners never ran.

## 10. Shortcut regression

After the 200-gesture storm, in the same page and with no reload:

```text
select an eligible word  ->  Ctrl+Shift+L  ->  POST /api/dsh-word-lookup  = exactly 1
```

Recorded as `B28` and `R28`. This is the check that a storm cannot leave the
runtime unable to fire, or able to fire twice.

## 11. Runtime isolated environment

```text
DSH_HOME    C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home
profile     word-lookup-test
port        50991
workdir     E:\Projects\DSHarness\dsh-word-lookup
gate        ISOLATION CHECK: PASS   (printed by the runner and by the harness)
auth        the isolated instance's own launch token
```

## 12. Runtime results

```text
phase1-verify: PASS — 77/77 checks
```

Phase 1's 64 checks still pass unchanged. The 12 new Phase 2 checks, each run on
the first boot (`B`) and again after a full restart (`R`):

| Check | Claim | Measured |
| --- | --- | --- |
| B23/R23 | a real pointer drag over conversation text is classified as a drag and issues no request | `landedInFlow=true`, `landedInInteractive=false`, selected `" serializer must derive the wire"`, `drags+1`, `kind=drag`, `requests=0` |
| B24/R24 | the snapshot carries the live range rectangle | `text="derive"`, `rect={x:156.7,y:175,w:37.9,h:19}` |
| B25/R25 | a real double click is classified as a double click and issues no request | `doubleClickGestures+1`, `kind=double-click`, `requests=0` |
| B26/R26 | the trailing selectionchange cannot turn a double click into a drag | `kindAfterTrailing=double-click`, `dragsDuringWindow=0` |
| B27/R27 | 100 drags and 100 double clicks are all classified and produce zero requests | `drags=100`, `doubleClicks=100`, `cancels=0`, `requests=0` |
| B28/R28 | after the gesture storm the shortcut still issues exactly one lookup | `requests=1`, `POST /api/dsh-word-lookup` |
| ISO05 | the run addressed the isolated environment and nothing production-owned | `home=…dsh-word-lookup-test\home profile=word-lookup-test port=50991` |

Full report: [`docs/evidence/phase2-verification-20261001.json`](evidence/phase2-verification-20261001.json).

Static verification: `npm run verify` → **PASS** — typecheck clean, 120 tests,
build exit 0, **48/48** bundle checks (was 39; the new ones assert that the client
half reaches the network from exactly one call site, that it is the lookup
transport, that every gesture listener is subscribed, and that every entry of
`package.json.files` exists on disk).

## 13. Production safety confirmation

```text
production DSH profile touched:   NO
production session data touched:  NO
production port touched:          NO
production loader touched:        NO
production routes touched:        NO
```

Checked after the run: port `50991` free, port `19387` still owned by pid `46308`
(the reader's instance, never restarted), and the `desktop` profile still carries
no `dsh-word-lookup` bundle, dependency or junction.

## 14. Deviations

1. **`pointer.distance` is peak travel, not the start-to-end chord** (§6). The
   field is named as sketched but defined as the quantity the threshold actually
   decides on, and documented at the field.
2. **A double click's second release transiently classifies as `other`** before
   `dblclick` arrives. This is unavoidable without lookahead — the platform has
   not yet reported the double click — and it is honest: the transient is never
   `drag`, and the settled verdict is always `double-click`. Counted and asserted
   in the tests rather than hidden.
3. **The probe layout was wrong and is fixed.** All three runtime probe nodes
   were `position: fixed` at the *same* coordinates, so the composer probe sat on
   top of the flow probe and swallowed every real pointer event. A drag aimed at
   conversation text was actually selecting composer text, and the Phase 1 check
   `B19` ("zero lookups") passed for the wrong reason — it was measuring an
   ineligible composer selection. The probes now sit at three distinct offsets,
   and `B23` asserts where the drag landed before believing what it classified.
   The product was correct throughout; the harness was not.
4. **Storm drags clear the selection between iterations.** Pressing inside an
   existing selection makes Chrome begin a native text drag-and-drop, which
   abandons the pointer sequence with `pointercancel`. That is correct classifier
   behaviour — measured at 99 cancellations and 1 drag before the change — but it
   would have made the storm measure the wrong thing. The `pointercancel` path
   therefore has real-browser evidence behind it, from the run that found it.
5. **More runtime checks than the sketch's R1–R5.** The sketched set is covered,
   and each claim is asserted on both boots and paired with a request-count
   assertion.
6. **`scripts/phase1-verify.mjs` keeps its Phase 1 name** while now covering
   Phase 2. Renaming it would churn the isolation and evidence references for no
   behavioural gain; the name is a misnomer and is recorded as such.

## 15. Residual risks

1. **The classifier classifies; nothing acts on it.** Both switches remain inert
   however they are set, exactly as Phase 2 requires. A later phase must add the
   trigger gate, and until it does the settings UI promises something the plugin
   does not deliver.
2. **`getBoundingClientRect()` runs on every `selectionchange`**, which fires many
   times per drag. This is a layout read on a hot path. It is correct and was
   measured working, but it is a performance question for Phase 7, not a
   correctness one.
3. **Drag-vs-double-click discrimination is unverified on a touch device.** The
   classifier takes `pointerType`-agnostic input; touch drags and double-taps are
   not covered by any measurement.
4. **The runtime suite now takes noticeably longer** because of 200 real gestures
   per boot, twice per run.
5. **No remote is configured and nothing was pushed**, as instructed.
6. **The desktop DSH client is untested.** The shortcut defaults cover
   `desktop:*` profiles, but every measurement here is the Web client.
