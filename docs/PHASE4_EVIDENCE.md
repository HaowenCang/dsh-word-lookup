# Phase 4 Evidence — Automatic Trigger Gate, De-duplication and Request Concurrency

> **Phase 4.1 remediation, 2026-10-02 (`START_SHA` `39ab443`).** An independent
> audit found that this phase's two automatic switches were **not** semantically
> independent: a double click whose second press drifted past the classifier's
> 5 px drag threshold was answered by `autoSelection` at `pointerup`, and the
> platform's own `dblclick` — arriving after it — was then refused as a duplicate
> of the identity the drag had spent. §4's "deliberate choice", §20.7, §21.6 and
> the old `B/R P27`/`P28` are the record of that decision; they are **superseded**
> by §24, which is the current contract and carries the platform measurement the
> fix is based on. Nothing below was deleted or rewritten: the audit trail of
> what Phase 4 believed, and of the check that made the belief look measured, is
> kept exactly as it was written.

> **Phase 4.2 audit, 2026-10-02 (`START_SHA` `58384d7`).** An independent audit
> confirmed that §24's fix is real and effective for the press it targets, and
> asked the symmetric question §24 did not answer: can a **first** press that
> drifts far enough to be classified as a drag still become the first half of a
> platform-recognised double click? §25 is the answer. It is a measurement, not a
> repair: the overlap **is** observable in Chromium, the defect is reproduced on
> the wire in S10 and S11, no synchronous signal exists at the first `pointerup`,
> and the platform's multi-click window — the only possible commit boundary for a
> deferral — is not obtainable by the plugin. **No production file was changed.**
> §25.11 lists the three ways to close it and what each costs.

## 1. Baseline

| Fact | Value |
| --- | --- |
| `START_SHA` | `b0d0186a9b5b951909899fcfad39f8f17acf2854` |
| Branch | `master` |
| Worktree at start | clean (`git status --short` empty) |
| Previous checkpoint | `d4c34dc` Phase 3 implementation, `b0d0186` Phase 3 evidence |
| Phase 4 scope | Connect the verified gesture classifier to the two live switches, with identity-based de-duplication and latest-wins request ordering |

`HEAD` had **not** advanced beyond the stated baseline, so `START_SHA` is the
commit the phase actually started from. Nothing was reset, cleaned, restored or
rewritten: `git reset --hard`, `git clean -fd`, `git checkout .` and
`git restore .` were not run.

Phase 1, Phase 2 and Phase 3 were **not** redone. Every pre-existing unit test and
every pre-existing runtime check still passes; the only pre-existing check that
had to change is named and justified in §20.

## 2. Environment

| Fact | Value |
| --- | --- |
| DSH | `0.2.0-rc.2` |
| Node | `v24.13.0` |
| npm | `11.12.0` |
| SQLite (bundled with Node) | `3.50.4` |
| Browser (runtime run) | Chromium `153.0.8010.12` |
| vitest | `3.2.4` |
| tsdown / rolldown | `0.23.0` / `1.2.11` |
| TypeScript | `5.9.3` |

`node:sqlite` is still experimental in Node 24.13.0 and its
`ExperimentalWarning` is still left visible rather than suppressed. Phase 4 did
not change the SQLite dependency strategy, the schema, the fixture, the
normalization rule, the form precedence, the SQL statements or the dictionary
lifecycle.

Throughout this document, `B/R <ID>` names a runtime check that runs on **both**
boots of the isolated instance — `B29` is the first boot's instance of the check
and `R29` the post-restart one.

## 3. Trigger architecture

```text
pointerdown --+
pointermove   +--> gesture.ts          pure classifier + monotonic gesture identity
pointerup   --+        |               (no DOM, no timer, no I/O)
dblclick    --+        |
                       |  classificationOf(state) -> { id, kind, pointerType, at }
                       v
              captureSelection()       live Selection/Range -> plain data,
              (inside the event)       dropped at the end of the same handler
                       |
                       v
              trigger.ts               evaluateAutomaticTrigger(input, gates, ledger)
                       |               pure: switches, eligibility, pointer kind,
                       |               identity de-duplication
                       v
              LookupIntent { origin, query }
                       |
                       v
              lookup.ts                LookupController: request identity,
                       |               supersession, stale-result policy
                       v
              store.ts -> card.tsx     the shell.overlay occupant
```

Three modules, each with one job and each testable without the others:

| module | what it is | what it is not |
| --- | --- | --- |
| `src/client/gesture.ts` | what the reader did, and which gesture it was | it does not know a dictionary exists |
| `src/client/trigger.ts` | whether that may become a lookup | it does not touch the DOM or the network |
| `src/client/lookup.ts` | which answer the card is allowed to show | it does not know how the request was triggered |

The condition logic is **not** scattered through DOM listeners. The two
classification handlers each do exactly three things: capture the selection,
fold the event into the classifier, and offer the resulting classification to the
gate. The `selectionchange` handler does one thing: refresh a local snapshot.

### The I/O boundary, as a reachability property

`selectionchange` reaching the network would make `autoSelection` mean "the
selection changed" — a different product, which would also fire a second lookup
for the trailing change of every double click. It is asserted two independent
ways:

1. **Statically** (`tests/client-io-boundary.spec.ts`): the sources are parsed
   with the TypeScript compiler and the `selectionchange` handler's **call graph**
   is walked. No reachable identifier may be `fetch`, `requestLookup`,
   `runLookup`, `transport`, `lookup`, `captureSelection`, `considerAutomatic`,
   `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `setTimeout`,
   `setInterval`, `setImmediate` or `requestAnimationFrame`. It is a reachability
   check rather than a text search, so reformatting, a comment that discusses
   `fetch`, or a renamed local cannot defeat it or produce a false positive. The
   same suite asserts there is exactly **one** `fetch` call site in the whole
   browser half, and it is `transport.ts`.
2. **Behaviourally** (`B/R P12`): with `autoSelection` **on**, fifty real
   selections made with real `Range` objects issue **0** requests — while the
   snapshot is asserted to have advanced and to hold eligible text, and the
   gesture counters are asserted not to have moved, so the zero cannot be
   explained by a listener that is simply dead.

## 4. Gesture identity

De-duplication is by **identity**, never by text, rectangle or a time window.
`same text within 300 ms` would swallow a reader deliberately double-clicking the
same word twice; rectangle equality would re-identify a gesture the moment the
transcript reflowed or the page scrolled.

```ts
interface GestureState {
  sequence: number      // monotonic allocator, never reset, never reused
  gestureId: number     // identity of the open (or just-closed) sequence
  classifiedId: number  // identity the carried verdict was PRODUCED for; 0 = none
  promotable: boolean   // a `dblclick` arriving now continues the release just folded
  pointerType: PointerKind
  // ...
}

beginPointer()          // allocates: sequence += 1; gestureId = sequence;
                        // classifiedId = 0, promotable = false
endPointer()            // carries the press's identity, and records it as
                        // classifiedId; promotable = true
registerDoubleClick()   // reuses the sequence it promotes, else allocates a fresh one
```

Three of those fields exist because each one closes a defect an adversarial
review found by executing the real modules, and each is asserted by a test that
fails without it:

- **`classifiedId`, not `gestureId`.** `beginPointer` allocates a new identity
  while `kind`/`completedAt` still describe the *previous* gesture. Reading the
  identity off the state would therefore pair a fresh identity with an old
  verdict, and a stray release — a window that lost focus mid-drag, a
  right-button release, a synthetic event — would offer that verdict as a new
  gesture. Concretely: a drag the switched-off gate refused is *not* consumed, so
  turning the switch on and then delivering a release that closes nothing would
  have bought a lookup for text the reader never dragged over for it, and burned
  the identity the real release afterwards needed. `classificationOf` now returns
  `null` whenever `classifiedId` is `0`, and the runtime additionally offers a
  classification only when the fold actually changed the state.
- **`promotable`.** Without it, `dblclick` reused whatever identity the state
  carried, so two `dblclick` events delivered with no pointer events at all (an
  engine, an extension or an automation agent that synthesises them) shared one
  identity and the second was swallowed as a duplicate — two gestures, one
  lookup. It is now reused only when the `dblclick` genuinely continues a
  sequence: an open press, or the release that was just folded.
- **`cancelGesture` clears the offer.** An abandoned gesture has no verdict to
  hand a gate, so nothing after it can re-offer the previous one.

### A double click that also travels

`dblclick` is the platform's recognition and the plugin consumes it, but the
classifier's drag threshold (5 CSS px) and the platform's double-click area are
**different rules**. A second press that drifts past 5 px while selecting a word
can be both a drag and the second half of a double click.

The rule this build implements is: **a press-release pair that travels far enough
over an eligible selection is a drag**, and the `dblclick` that follows promotes
that same identity and is refused as a duplicate. One platform gesture, one
lookup, on the drag's path.

That is a deliberate choice, not an accident, and it is measured rather than
asserted (`B/R P27`, `B/R P28`): with `autoSelection` alone the drifting double
click is at most one lookup, and with both switches on it is exactly one — never
one per switch. What it means for the contract is stated plainly in §20.5: a
double click *that is also a drag* is attributed to `auto-selection`. A
zero-movement double click — what a reader produces and what both the browser
harness and the real-browser matrix issue — is attributed to `auto-double-click`.

Rebuilding the classifier to consult the platform's click count would remove the
ambiguity, and was rejected: the brief forbids rewriting the verified Phase 2
classifier to serve the automatic paths, and `MouseEvent.detail` on pointer events
is a platform behaviour this project has not measured.

> **Corrected in Phase 4.1 (§24).** This paragraph is wrong on both counts, and it
> is kept because it is what Phase 4 decided.
>
> - The rule it states — a drifting double click attributed to `auto-selection` —
>   is not the product's rule. The product says a gesture the platform recognises
>   as a double click is governed by `autoDoubleClick` alone.
> - `MouseEvent.detail` **has** now been measured, in this runtime: `mousedown`
>   carries `1` then `2` across a double click, and §24.4's movement sweep shows
>   the platform still reports `dblclick` at every drift from 0 to 12 px, from the
>   classifier's threshold (5 px) onwards.
>
> What Phase 4 was right about is that the classifier must not be rebuilt: the
> movement rule is unchanged. What changed is that the verdict now carries the
> platform's click multiplicity, and the **gate** refuses to spend an
> `auto-selection` lookup on a press the platform reported as a multi-click.

The event order this is built on is the one Phase 0 §7.3 measured in real
Chromium, and Phase 4 did not re-derive it:

```text
pointerdown#1  pointerup#1  pointerdown#2  pointerup#2  dblclick  selectionchange(trailing)
     id N-1        other         id N        other/drag  double-click   <no classification>
```

`pointerup#2` is `other` when the second press did not travel, which is what the
real-browser matrix and the harness both produce, and `drag` when it did — see
above. Either way the trailing `selectionchange` is structurally unable to produce
a classification: no reducer in `gesture.ts` is reachable from a selection event,
which the Phase 2 suite already asserts and which Phase 4 did not weaken.

Identity is a per-page-load monotonic counter. That is sufficient because the
consumption ledger is per-page-load too: a reload produces a new runtime, a new
ledger and a new identity space, and the only thing identity has to survive is
the interval between a `pointerdown` and the classification it produces.

## 5. De-duplication

`TriggerLedger` is a bounded ring of the last `LEDGER_CAPACITY` = 32 consumed
identities, not a single `lastConsumedId`: a ring tolerates events arriving in an
order the runtime did not anticipate, where one scalar would silently accept a
repeat.

The order of the gate's checks is part of the contract, and one property in it
matters more than the rest: **a refusal never consumes the identity**. That is
what lets `autoSelection` be switched on and the *next* drag work, and it is why
a double click whose second release was classified `other` is still free to be
consumed by its own `dblclick`.

| situation | result |
| --- | --- |
| one drag, with many `selectionchange`, `pointerup`, `mouseup`, `click`, re-render | exactly 1 `auto-selection` lookup |
| one double click: first click, second click, `dblclick`, trailing `selectionchange` | exactly 1 `auto-double-click` lookup |
| both switches on, one double click | `auto-double-click` 1, `auto-selection` 0, total 1 |
| both switches on, one drag | `auto-selection` 1, `auto-double-click` 0, total 1 |
| double click word A, then double click word A again | 2 gestures (2 identities), 2 lookups |
| drag word A, then drag word A again | 2 gestures (2 identities), 2 lookups |
| the same identity offered twice | first lookup, second `duplicate-gesture` |
| the same text under a new identity | lookup |

Measured in real Chromium (`B/R P15`, `B/R P16`): two double clicks on `derive`
issued **back to back** — one `gestures().last.gestureId` read between them —
produced identities `329` and `331` with **2** requests; two drags produced `332`
and `333` with **2** requests. The gap between the two gestures is measured and
asserted to be **under 300 ms**, so this rules out a text-and-time de-duplicator
as well as a text-only one; a harness that waited between the two gestures would
not have.

One consequence is stated rather than hidden: the plugin cannot tell a
synthesised repeat of a `dblclick` from a reader double-clicking twice, because
it has no timer and the platform emits one `dblclick` per gesture. Two `dblclick`
events are therefore two gestures with two identities. Duplicate absorption is
proven on the identity path that really exists — a release that classified as
`drag` and a `dblclick` promoting that same sequence — in
`tests/client-runtime-harness.spec.ts` and by `B/R P27`/`P28` in the browser.

### The manual shortcut is a different domain

Gesture de-duplication never suppresses the manual command. `Primary+Shift+L` is
an explicit user action and can be repeated freely; `B/R P03`, `B/R P06` and
`B/R P09` each assert that the shortcut still issues exactly one lookup in the
OFF, S10 and S01 states, and the runtime harness asserts that a shortcut
immediately after an automatic lookup for the *same word* still issues a second
request.

## 6. Settings semantic matrix

Each cell is a real browser, real mouse, real trusted input, with the switch
changed through the same `configForm.set` the settings UI calls. `requests` is
read off the wire by Playwright; `origin` is read from the plugin's own
client-side accounting; the two are asserted together, so a plugin that reported
an origin it did not use would fail.

| state | `autoSelection` | `autoDoubleClick` | drag | double click | shortcut |
| --- | --- | --- | --- | --- | --- |
| S00 | false | false | **0** (`switch-off`) | **0** (`switch-off`) | **1** |
| S10 | true | false | **1** (`auto-selection`) | **0** (`switch-off`) | **1** |
| S01 | false | true | **0** (`switch-off`) | **1** (`auto-double-click`) | **1** |
| S11 | true | true | **1** (`auto-selection`) | **1** (`auto-double-click`) | **1** |

Every zero is asserted alongside the *classification* and the *captured text*, so
"0 requests" cannot be satisfied by a gesture that was never recognised:

```json
{"requests":0,"delta":{"shortcut":0,"auto-selection":0,"auto-double-click":0},
 "trigger":{"decision":"ignored","reason":"switch-off","origin":null,"gestureId":307},
 "capture":{"eligible":true,"text":"derive","rect":{"x":1142,"y":161,"width":37.859375,"height":19}},
 "kind":"drag","gestureId":307}
```

And in S11, one drag plus one double click together produce exactly **2**
requests — `auto-selection` 1, `auto-double-click` 1, never 3 or 4:

```json
{"drag":{"requests":1,"delta":{"shortcut":0,"auto-selection":1,"auto-double-click":0},
         "trigger":{"decision":"lookup","origin":"auto-selection","gestureId":316},"kind":"drag"},
 "double":{"requests":1,"delta":{"shortcut":0,"auto-selection":0,"auto-double-click":1},
           "trigger":{"decision":"lookup","origin":"auto-double-click","gestureId":318},"kind":"double-click"}}
```

**A double click never additionally triggers `autoSelection` through the
selection it causes** (`B/R P11`): in S11 the double click's origin delta is
exactly `{auto-selection: 0, auto-double-click: 1}`.

## 7. Live settings transitions

No restart, no reload, no stale closure. One switch is walked
`false -> true -> false` in the real browser and the *next* gesture is required
to follow each time.

`autoSelection` (`B/R P13`, abridged):

```json
[{"value":false,"gates":{"autoDoubleClick":false,"autoSelection":false},"requests":0,"reason":"switch-off"},
 {"value":true, "gates":{"autoDoubleClick":false,"autoSelection":true}, "requests":1,"reason":"accepted","origin":"auto-selection"},
 {"value":false,"gates":{"autoDoubleClick":false,"autoSelection":false},"requests":0,"reason":"switch-off"}]
```

`autoDoubleClick` (`B/R P14`, abridged):

```json
[{"value":false,"requests":0,"reason":"switch-off"},
 {"value":true, "requests":1,"reason":"accepted","origin":"auto-double-click"},
 {"value":false,"requests":0,"reason":"switch-off"}]
```

The gate reads the switch value that the settings subscription last published, at
the moment of the gesture — it is never captured at plugin load. The runtime
harness asserts the same property without a host, and additionally asserts that
the runtime observed exactly one write.

## 8. Request concurrency

```text
A issued (id 10) --> pending
B issued (id 11) --> pending, and A is aborted
B settles       --> owner === 11  -> publish B
A settles       --> owner === 11 !== 10 -> drop A whole
```

`LookupController` allocates a monotonic request id per lookup and keeps `owner`.
Only the owner may publish. Aborting is still done — it stops work that no longer
matters — but it is **not** the safety net: an abort cannot promise that every
stage of the transport has stopped, so a request that resolves after being
aborted must still be recognised as stale by its identity and dropped.

Loading is request-scoped for free and is deliberately not tracked separately:
the card's loading state is only ever published by the owner, so an older request
finishing cannot clear a newer request's loading. `LookupController.loading()` is
*derived* from the card's own snapshot rather than shadowed, so the two cannot
disagree.

| case | driven by | result |
| --- | --- | --- |
| C1 out-of-order success | `tests/client-lookup.spec.ts`, `client-runtime-harness.spec.ts` | B is shown; A's later success is dropped |
| C2 stale error | same | B's success survives A's later network failure and A's later rejection |
| C3 current error | same | B's failure is shown after A's success |
| C4 loading ownership | same | A finishing leaves the card `loading` with **B's** query; B finishing clears it |

Each case asserts the card **after every settlement**, not only at the end: a
test that only checked the final state would pass against an implementation that
rolled back to A and then forward to B again.

In the real browser (`B/R P18`) two automatic lookups issued back to back leave
the card on the second query's headword (`go`, from `went`) with
`loading: false`. The real dictionary answers in a few milliseconds, so that
measurement proves the *normal* rapid path, not the race; the race itself is
driven deterministically by the deferred-transport tests above and through the
real runtime wiring in `tests/client-runtime-harness.spec.ts`.

## 9. Stale-response tests

| case | assertion |
| --- | --- |
| stale success | `store.getSnapshot()` still reports B after A's `found` body resolves |
| stale **error** | still B after A resolves `{kind:'network'}` |
| stale **rejection** | still B after A's promise rejects |
| current failure | B's `network` failure is displayed with B's query |
| current refusal | a controlled 400 is displayed as a `ready` state carrying the refusal |
| loading | `loading()` stays `true` with B's query after A settles |
| recovery | the lookup after a failure is issued and displayed normally |
| unknown word | `found:false` is a `ready` not-found state, not an error |

## 10. Stress tests

### Browser (real Chromium, real DSH, real mouse)

| state | drags | double clicks | requests | origins | cancels |
| --- | ---: | ---: | ---: | --- | ---: |
| S00 | 100 | 100 | **0** | 0 / 0 | 0 |
| S11 | 100 | 100 | **200** | `auto-selection` 100, `auto-double-click` 100 | 0 |
| S10 | 25 | 25 | **25** | `auto-selection` 25, `auto-double-click` 0 | 0 |
| S01 | 25 | 25 | **25** | `auto-selection` 0, `auto-double-click` 25 | 0 |

Every row also asserts the **gesture counters advanced by exactly the number of
gestures performed**, so a request count of zero cannot be explained by a
classification that never happened. `cancels` is recorded alongside them, not
asserted: a drag that began inside an existing selection would legitimately
produce one, and pinning it to zero would be asserting a property of the harness
rather than of the plugin. Each row ran on **both** boots.

The brief asks for 100 + 100 "in all four quadrants if the cost is reasonable"
and permits the full combinatorial matrix to live in the unit/integration
harness. That is what was done: 100 + 100 is a real browser measurement for
**both OFF** and **both ON**, the two states the brief requires in a browser, and
a 25 + 25 batch covers the two single-switch states whose only additional claim
is *which* switch fired — a claim the batch size cannot weaken. The exhaustive
100 + 100 matrix over **all four** states runs in
`tests/client-runtime-harness.spec.ts`, against the real listeners, classifier,
gate, controller and store with a fake DOM, and in
`tests/client-trigger.spec.ts` against the gate alone.

### Harness (real runtime wiring, fake DOM)

| state | drags | double clicks | requests |
| --- | ---: | ---: | ---: |
| S00 | 100 | 100 | 0 |
| S10 | 100 | 100 | 100, all `auto-selection` |
| S01 | 100 | 100 | 100, all `auto-double-click` |
| S11 | 100 | 100 | 200, 100 + 100 |

## 11. Shortcut regression

| check | measurement |
| --- | --- |
| `Primary+Shift+L` with both switches OFF | exactly 1 request, `found`, `sqlite-fixture` |
| `Primary+Shift+L` with `autoSelection` only | exactly 1 request, `found` |
| `Primary+Shift+L` with `autoDoubleClick` only | exactly 1 request, `found` |
| `Primary+Shift+L` after the 200-gesture S00 storm | exactly 1 request, `found` |
| `Primary+Shift+L` immediately after an automatic lookup of the *same word* | a second, separate request |
| a composer selection + shortcut | `pass`, 0 requests (unchanged Phase 1 contract) |
| no selection + shortcut | `pass`, 0 requests, key not consumed (unchanged) |

The two automatic switches never gate the manual command: it has its own
`resolve`/`run` path and the gesture ledger is never consulted from it.

## 12. SQLite regression

Phase 3's runtime checks (`B/R 29`–`B/R 38`) all still pass on both boots,
through the same real shortcut: exact entry, `forms` morphology, irregular forms
and plurals, the exact multi-word phrase (never split), unknown words as
`200 found:false`, full payload shape, SQL-metacharacter safety, deterministic
examples and the NFKC fold.

Phase 4 additionally drives the dictionary through the **automatic** path:

| check | measurement |
| --- | --- |
| `B/R P04` | automatic drag on `derive` -> `query: "derive"`, `headword: "derive"`, `source: "sqlite-fixture"` |
| `B/R P08` | automatic double click on `derive` -> the same |
| `B/R P17` | automatic double click on `derived` -> `headword: "derive"`, `matchedForm: "derived"`, card renders `derived -> derive` |
| `B/R P18` | automatic `derive` then `went` -> final card headword `go` |
| `B/R P19` | automatic `unknowntoken` -> `200 found:false`, card `no entry for "unknowntoken"`, next gesture still works |

Nothing in the SQLite layer, the schema, the fixture, the normalization rule, the
form precedence, the SQL statements or the lifecycle changed. Phase 3 remains a
stable dependency layer; no ECDICT, Tatoeba, corpus path, release database, FTS
or fuzzy matching was introduced.

## 13. Pointer scope

Phase 4 claims **mouse only**. `beginPointer` records the `pointerType` that
opened the gesture, and the gate refuses every automatic lookup whose
`pointerType` is not `mouse`:

```ts
if (classification.pointerType !== 'mouse') return ignored('unverified-pointer-kind', ...)
```

`pen`, `touch` and an unidentifiable pointer (a platform that omits the field, or
a synthetic event) are therefore refused rather than guessed at, and a refusal
does not consume the identity. The manual shortcut is unaffected by the pointer
kind — it is an explicit keyboard action. Touch double-tap is **not** claimed: it
was never measured, so it produces no automatic I/O.

## 14. No timer-based product semantics

No timer decides `drag` versus `double-click` — or anything else. Asserted twice:

- `tests/client-io-boundary.spec.ts` parses `gesture.ts`, `trigger.ts`,
  `lookup.ts` and `index.tsx` and requires **zero** calls to `setTimeout`,
  `setInterval` or `setImmediate`; it also requires that `gesture.ts` and
  `trigger.ts` never reference `Date.now` (they receive the clock's value as an
  argument);
- `scripts/check-bundle.mjs` requires the emitted `lib/client.js` to contain no
  timer call at all.

The `setTimeout` occurrences in `scripts/phase1-verify.mjs` are harness settling
delays, not product logic: they wait for network activity to become observable,
and the assertions they precede are about request counts, never about a
classification.

## 15. Repeated listener protection

| layer | evidence |
| --- | --- |
| unit (the real proof) | `tests/client-runtime-harness.spec.ts` asserts one listener per event type after `apply`, **zero** after dispose, the command registration removed, and exactly one lookup per gesture after an unload/reload cycle |
| unit | a transport that resolves *after* disposal publishes nothing, so a lookup outliving an unload cannot republish into the next lifecycle's store |
| runtime | `B/R L01` asserts the overlay and command are registered exactly once after a full client reload |
| runtime | `L06`/`L07` assert that after a full client reload the automatic path still issues **exactly one** request per gesture, with the expected origin |

`L06`/`L07` are **not** offered as evidence about listener disposal, and the check
titles say so: `page.reload()` destroys the document, so no listener could survive
it and the checks would pass with `removeEventListener` deleted. They prove the
automatic path is wired and still one-to-one in a freshly loaded page; disposal
itself is proven by the unit harness, which is the only place it can be.

## 16. Error handling

| requirement | evidence |
| --- | --- |
| no unhandled rejection | `LookupController.run` never rejects: `await this.#request(...)` is wrapped, and a thrown error becomes the same `network` failure the transport reports. Unit-tested with a synchronously throwing transport and a non-`Error` rejection |
| no permanent loading | the failing request owns the card, publishes `failed`, and `loading()` is `false` |
| future lookups keep working | the harness asserts a gesture after a transport failure produces a `ready` card |
| no duplicate error card | the card is a single store-backed occupant; `B/R 13` asserts exactly one card node |
| the gesture listener survives | the failure path never throws out of the listener |
| a dictionary miss is not an error | `B/R P19` and `B/R 34`: `200 found:false`, a `not-found` card state, and the next gesture still resolves |
| the browser console stays clean | `L02`/`L03` assert no unexpected console error and no unhandled page exception, on both boots |

## 17. Tests

> Phase 4.1 (§24.8) moved these totals to **17 files / 372 tests** and bundle
> checks to **94/94**, without weakening any assertion below. The two exceptions
> are named in §24.10: the harness's `dblclick`-as-duplicate case was removed
> because it asserted the defect as the allowed behaviour, and the harness
> drivers now emit the `mousedown` a real mouse always emits.

`npm run verify` -> **PASS**

| step | result |
| --- | --- |
| fixture | built and validated |
| typecheck | clean |
| test | **17 files, 351 tests, 0 failures** |
| build | exit 0 |
| bundle-static-checks | **88/88** |
| credential-scan | PASS |

New by Phase 4:

| file | tests | content |
| --- | ---: | --- |
| `tests/client-trigger.spec.ts` | 33 | the four-state matrix as a truth table, identity de-duplication, duplicate-identity injection, same-text/new-identity, refusals not consuming, pointer kinds, ledger bounding, 100 + 100 over the gate |
| `tests/client-lookup.spec.ts` | 19 | C1–C4, stale success/error/rejection, current failure, loading ownership, error recovery, dispose, per-origin accounting |
| `tests/client-runtime-harness.spec.ts` | 46 | the real `apply()` against a fake DOM and a fake DSH context: matrix, live transitions, de-duplication on the real duplicate path, a verdict never offered for an unreleased press, a refused gesture not re-firing under a new identity, composer exclusion, pointer kinds, lifecycle, deferred-transport ordering, error recovery, 100 + 100 in all four states |
| `tests/client-gesture-identity.spec.ts` | 17 | which sequence a verdict belongs to, no offer for an unreleased or abandoned press, promotion of a double click, two press-less double clicks staying two gestures, identities never reused |
| `tests/client-io-boundary.spec.ts` | 12 | AST reachability: `selectionchange` reaches no I/O; one `fetch` call site and it is the transport; no timers; the pure modules reference no DOM/network global |

Totals moved from **12 files / 224 tests** (Phase 3) to **17 files / 351 tests**,
with **no pre-existing assertion weakened**. The 224 pre-existing tests still
pass unchanged. `tests/client-gesture.spec.ts` (Phase 2's suite) gained no
assertions and lost none — the identity fields are additive, and the new
identity semantics live in their own file so that the Phase 2 contract stays
readable as the contract it was.

`scripts/check-bundle.mjs` grew from **69** to **88** checks. New assertions:

```text
client bundle carries the auto-selection / auto-double-click / shortcut origins
client bundle carries the duplicate-gesture / switch-off / unverified-pointer-kind /
                not-a-trigger-gesture refusal reasons
client bundle classifies pointer kinds, so an unverified one can be refused
client bundle allocates a gesture identity (gestureId + sequence)
client bundle uses no timer
host bundle carries no gesture concern (auto-selection, auto-double-click,
                gestureId, pointerType, duplicate-gesture)
host bundle still carries no pointer or selection event name
client bundle requests no origin field on the wire
host bundle describes autoSelection / autoDoubleClick as the gesture each answers
```

The last one closes Phase 3's residual risk 6: both switches are now described in
the settings schema as the gesture they actually answer
(`Automatically look up after dragging to select text`,
`Automatically look up a word after double-clicking it`), so neither row reads as
"look up whenever the selection changes".

## 18. Isolated runtime

> Phase 4.1 (§24.9) re-ran the same entry point against the same isolated
> environment and reports **169/169**; the text below is Phase 4's own run.

```text
$ npm run test:runtime
ISOLATION CHECK: PASS          (runner gate)
ISOLATION CHECK: PASS          (harness gate)
...
phase1-verify: PASS — 159/159 checks
```

| | value |
| --- | --- |
| `DSH_HOME` | `C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home` |
| profile | `word-lookup-test` |
| port | `50991` |
| DSH / Node | `0.2.0-rc.2` / `v24.13.0` |
| browser | Chromium `153.0.8010.12`, headless |
| authentication | the isolated instance's own launch token |
| boots | 2 (full restart in between, to prove settings persistence) |
| result | **159/159**, `summary.failed = []` |

159 = Phase 1's 64 + Phase 2's 13 + Phase 3's 20 + **Phase 4's 62**
(`B/R A2`, `B/R P01`–`B/R P29` = 30 per boot x 2 boots = 60, plus `L06` and
`L07`). Every pre-existing check still passes.

The Phase 4 checks run on **both** boots, so a trigger gate that only worked on a
cold start — or only with the switches at their composed defaults — would fail.

### Production safety

| fact | value |
| --- | --- |
| production `DSH_HOME` | `C:\Users\20659\.dsh` — last modified `04:26:17`, **before** this phase began, and read-only inspection only |
| live profile | `desktop` |
| live port `19387` | held by pid `46308` before and after; never restarted, never killed |
| plugin in the production profile | absent from `package.json`, `cordis.patch.yml` and `cordis.yml` |
| production session data | never read, never copied |
| production loader / routes / cookies | never touched |
| test port `50991` after the run | no listener |
| isolated instance processes | both stopped by the harness (`H02` asserts the first exits cleanly); no orphan `dsh` remains |

The isolated scratch environment (`%TEMP%\dsh-word-lookup-test`) is **retained**
rather than removed, exactly as Phases 1–3 left it: `docs/evidence/` already holds
the redacted report, and the next phase's documented sequence is
`npm run iso:check` → `npm run test-profile:create` → `npm run test:runtime`. No
test process and no test port is left occupied. The final state of the isolated
profile's patch is the composed default restored by `S07`:

```yaml
- id: dsh-word-lookup
  name: dsh-word-lookup
  config:
    autoDoubleClick: false
    autoSelection: false
```

No unrelated process was killed, no port was taken from another holder, and no
unrelated DSH instance was touched.

## 19. Real browser trigger matrix

| check | what it measured |
| --- | --- |
| `B/R A2` | the switches are *established* OFF before the zero-request checks, and the boot's own values are recorded (boot 1 `false/false`, boot 2 `true/true`) |
| `B/R P01` | S00: real drag -> 0 requests, `kind: drag`, capture `derive` eligible, reason `switch-off` |
| `B/R P02` | S00: real double click -> 0 requests, `kind: double-click`, capture eligible, reason `switch-off` |
| `B/R P03` | S00: shortcut -> exactly 1, answered by SQLite |
| `B/R P04` | S10: real drag -> exactly 1, origin `auto-selection`, wire query `derive`, headword `derive` |
| `B/R P05` | S10: real double click -> 0, reason `switch-off` |
| `B/R P06` | S10: shortcut -> exactly 1 |
| `B/R P07` | S01: real drag -> 0, reason `switch-off` |
| `B/R P08` | S01: real double click -> exactly 1, origin `auto-double-click` |
| `B/R P09` | S01: shortcut -> exactly 1 |
| `B/R P10` | S11: drag 1 + double click 1, on their own paths |
| `B/R P11` | S11: the double click's trailing selectionchange buys no `auto-selection` lookup |
| `B/R P12` | 50 programmatic selection changes are observed and issue 0 requests |
| `B/R P13`/`P14` | live `false -> true -> false` for each switch, no restart |
| `B/R P15`/`P16` | two gestures on the same word -> 2 identities, 2 requests |
| `B/R P17` | automatic `derived` -> `derive` through the forms table, rendered on the card |
| `B/R P18` | two rapid automatic lookups leave the card on the second query's headword |
| `B/R P19` | automatic unknown word -> normal miss, next gesture works |
| `B/R P20`/`P21` | automatic drag and double click inside the composer -> 0 |
| `B/R P22`–`P25` | the browser stress matrix (§10) |
| `B/R P27` | a double click whose second release drifts past the drag threshold is still at most one lookup |
| `B/R P28` | the same drifting double click with both switches on is exactly one lookup, never one per switch |
| `B/R P29` | a synthetic `pointerType: 'touch'` gesture with both switches on produces no automatic lookup |
| `B/R P26` | the matrix restored the switches to what the boot loaded |
| `L06`/`L07` | after a full client reload, one gesture is still exactly one request |

> Phase 4.1 (§24.6) replaced `P27`/`P28` and added `P41A`, `P41B`, `P41C`,
> `P30` and `P31`. The old rows above are kept with their original wording
> because that wording is part of the finding: `P27` claimed a drifting double
> click was "at most one lookup" while the check never observed a `dblclick` at
> all (`B/R P41B` measures exactly that). The Phase 4.1 rows are:
>
> | check | what it measures |
> | --- | --- |
> | `B/R P41A` | the current Chromium's click multiplicity on a double click: `mousedown`/`click`/`dblclick` carry detail `1,2` / `1,2` / `2` |
> | `B/R P41B` | the sealed `P27`/`P28` sequence produces **no** `dblclick` (`mousedown detail [1,1]`, `doubleClickGestures +0`, release classified `drag`) |
> | `B/R P41C` | the movement sweep: `dblclick` is still emitted at 0–12 px, and the classifier's `drag` verdict starts exactly at 5 px |
> | `B/R P27` (rewritten) | S10: drifting double click → 0 requests, `doubleClickGestures +1`, `auto-selection 0` |
> | `B/R P30` | S01: drifting double click → exactly 1, origin `auto-double-click` |
> | `B/R P28` (rewritten) | S11: drifting double click → exactly 1, origin `auto-double-click`, `auto-selection 0` |
> | `B/R P31` | S11: a drag-shaped sequence with no observed multiplicity → 0 requests, reason `unverified-click-multiplicity`, then the next real drag fires once |


## 20. Deviations

1. **One pre-existing runtime check changed its comparison.** `B/R 35` ("the
   payload carries headword, phonetic, POS, Chinese meaning, forms, examples and
   provenance") asserted that the settings echo in the payload matched a **boot
   constant** — `false/false` on boot 1, `true/true` on boot 2. Phase 4 makes the
   switches live and `B/R A2` establishes them OFF for the zero-request checks, so
   a boot constant no longer describes them. The check now compares the host's
   echo against the **client's own live mirror**, read around the same request,
   and additionally asserts that mirror did not move across it. That is strictly
   stronger than the constant: it is satisfied only when both halves agree about
   the live configuration, on every boot and from whatever state the boot started
   in. No other pre-existing assertion was weakened, and no Phase 1/2/3 check was
   removed.
2. **The Phase 1 probe gained a second conversation node.** Phase 4 needs to aim
   real pointer gestures at a known single word, so the harness installs a
   separate right-hand column of fixture words, each carrying
   `data-chat-flow-kind` and `data-chat-node-key`. The existing probe is
   unchanged. `B/R 22` still reports zero plugin nodes outside the overlay.
3. **`scripts/phase1-verify.mjs` keeps its Phase 1 name.** It now covers Phases
   1–4 and the name is a misnomer, exactly as Phase 3's deviation 7 recorded. The
   brief permits renaming it to `scripts/runtime-verify.mjs` but only when the
   change is simple and every entry point is synchronised; it is kept because the
   rename would churn the isolation plan, the runner, the evidence documents and
   three committed historical reports for no behavioural gain, and because
   Phase 3 already decided the same way and recorded it.
4. **The origin never crosses the wire.** `LookupOrigin` is client state and test
   evidence only. The HTTP contract, the media type, the body limit and every
   refusal code are unchanged from Phase 1, and `check-bundle` asserts the client
   bundle carries no `origin` field on the wire. The host and the SQLite layer
   learned nothing about gestures: `check-bundle` asserts the host bundle carries
   no `auto-selection`, `auto-double-click`, `gestureId`, `pointerType`,
   `duplicate-gesture` or DOM event name.
5. **`LookupOrigin` has three values now, and `lookups()` still reports a total.**
   `lookupsByOrigin()` was added alongside it rather than replacing it, so the
   Phase 1–3 checks that read `lookups()` are unchanged.
6. **`capture()` was added to the verification surface.** The gate deliberately
   reports a query only when it accepted one, so a separate record of the
   captured selection is what makes "the gate refused the right gesture" and "the
   gate was handed the wrong text" distinguishable — both produce zero requests.
   It was added after a real defect: the first version of the Phase 4 browser
   probe installed its word column without `data-chat-flow-kind`, so every
   gesture in it was correctly refused as ineligible, and the failure was only
   diagnosable once the capture was visible.
7. **A double click that is also a drag is attributed to `auto-selection`.**
   §4 states the rule and `B/R P27`/`P28` measure it. A zero-movement double
   click — every one issued by the browser harness and by the real-browser
   matrix, and the only kind the settings matrix in §6 is about — is attributed
   to `auto-double-click`. The ambiguity is a property of the platform: the
   classifier's 5 CSS px drag threshold and the platform's double-click area are
   different rules, and the brief forbids rebuilding the verified Phase 2
   classifier to consult a click count this project has not measured.
   **Superseded by §24**: the ambiguity is real, the click count is now measured,
   and the attribution is `auto-double-click` in every switch state — the
   classifier's movement verdict is still `drag`, but the gate refuses to spend
   an `auto-selection` lookup on a multi-click press.
8. **Two `dblclick` events are two gestures.** The plugin has no timer and the
   platform emits one `dblclick` per gesture, so it cannot distinguish a
   synthesised repeat from a reader double-clicking twice. Duplicate absorption is
   therefore proven on the identity path that really exists — a `drag` release and
   the `dblclick` promoting it — not by injecting a second `dblclick`.
9. **Eight of Phase 4's checks were rebuilt after an adversarial review that
   executed the real modules.** Three defects were found and fixed in the
   classifier's identity/verdict pairing and are recorded in §4; five checks were
   found weak, vacuous or tautological and were replaced:
   `B/R P12` now asserts the selection snapshot advanced and the gesture counters
   did not move; `B/R P15`/`P16` now issue their two gestures **under 300 ms
   apart** with the gap measured and asserted; `B/R P11` now asserts the eligible
   selection the double click left behind; `P27`–`P29` were added; `L06`/`L07`
   were retitled to claim only what a page reload can prove; and a tautological
   array comparison in the harness was replaced with the identities it was
   supposed to record. The reviewer's own verdict on the rest — the gate, the
   ledger, the request controller and the I/O boundary — was that they are sound
   as written.

## 21. Residual risks

1. **The dictionary is still a fixture of 7 headwords, not a corpus.** Phase 4
   says nothing about coverage. Importing ECDICT / Tatoeba remains a later phase.
2. **The generated database is still not published.** `fixtures/` is gitignored
   and absent from `package.json.files`, so a read-only package install would
   fail to materialise it. This is a release-phase decision and was deliberately
   **not** solved here; no database path was moved into a production user
   location and the release architecture was not modified.
3. **`node:sqlite` is still experimental in Node 24.13.0** and still prints
   `ExperimentalWarning`. It is left visible rather than suppressed, and
   `tests/host-sqlite-safety.spec.ts` re-measures the API on every run.
4. **The length ceiling is still measured on the raw selection**, not on the
   folded text (NFKC can expand). Phase 1 behaviour, unchanged.
5. **Touch and pen are unverified and therefore refused.** Phase 4 claims mouse
   only. The refusal is proven in the shipped bundle by `B/R P29`, which drives a
   **synthetic** `PointerEvent` with `pointerType: 'touch'` — honestly weaker than
   a real touch screen, because the event is constructed rather than produced by a
   device, so it shows the gate is wired and not that a real touch device behaves
   identically. A touch double-tap will not look anything up until a phase
   measures it on hardware.
6. **A double click whose second press drifts past 5 px is attributed to
   `auto-selection`** (§4, §20.7). It is still exactly one lookup — never two —
   but the settings matrix's "double click -> `auto-double-click`" holds for a
   double click that is not also a drag, which is what both harnesses and a
   reader's own double click produce. **Resolved by §24**: it is attributed to
   `auto-double-click`, in every switch state, and `§24.11` lists what the fix
   costs instead.
7. **The browser "rapid pair" measurement is not a race.** The real dictionary
   answers in milliseconds, so `B/R P18` proves the normal rapid path. The
   out-of-order orderings are proven with a deferred transport instead, in
   `tests/client-lookup.spec.ts` and through the real runtime wiring in
   `tests/client-runtime-harness.spec.ts`. A future phase that adds a slow
   dictionary or a network dependency should re-measure the race in a browser.
8. **The gesture identity is per page load.** It is a monotonic counter, not a
   UUID, and it is not persisted. That is sound because the consumption ledger is
   per page load too, but a future phase that persists gesture state across
   reloads must revisit it.
9. **`getBoundingClientRect()` still runs on every `selectionchange`**, carried
   over from Phase 2. Correct and measured working; still a Phase 7 performance
   question.
10. **The desktop client remains untested.** Every measurement here is the Web
    client.
11. **The stress storms aim at the sentence probe, not the word column.** Each
    storm's drags and double clicks land on the Phase 2 paragraph, so the queries
    are whatever words the sentence puts under the cursor. That is irrelevant to
    the claim the storms make — a request count paired with a gesture count — but
    the evidence must not be read as naming fixture words.
12. **No remote is configured and nothing was pushed.** No force push, no history
    rewrite, and the sealed Phase 1 / Phase 2 / Phase 3 commits were not amended.
    **Superseded by §23.1**: `origin` now exists
    (`https://github.com/HaowenCang/dsh-word-lookup.git`) and `master` was
    pushed to it without force or history rewriting.

## 22. Phase 5 readiness

```text
PASS — Phase 4 COMPLETE / Phase 5 READY
```

What Phase 5 inherits:

- **two switches that now keep their promise**: each one controls exactly the
  gesture it names, takes effect on the next gesture with no restart, and is
  described in the settings schema in those terms;
- **a proven one-to-one guarantee**: one semantic gesture produces at most one
  automatic lookup, and two gestures produce two — proven by identity, not by
  text or time, in unit tests, in a harness over the real runtime, and in a real
  Chromium with real mouse input;
- **a structural I/O boundary**: `selectionchange` cannot reach the network, the
  browser half has exactly one `fetch` call site, and the host knows nothing
  about gestures;
- **a card that always shows the newest answer**: request identity, supersession,
  the stale-result policy and request-scoped loading are in one small module with
  a stated contract;
- **a measured baseline for the next phase**: 100 drags + 100 double clicks -> 0
  requests with both switches off and exactly 200 with both on, on both boots,
  with the shortcut unchanged at exactly 1 everywhere.

What Phase 4 did **not** build, and a later phase must not assume: ECDICT or
Tatoeba import, release corpus packaging, vocabulary history, a word book,
pronunciation audio, fuzzy matching, a network dictionary, an AI fallback, a
desktop support claim, a touch double-tap claim, a card redesign, a
`selectionchange` performance optimisation, or a replacement for `node:sqlite`.

## 23. Git

| | value |
| --- | --- |
| `START_SHA` | `b0d0186a9b5b951909899fcfad39f8f17acf2854` |
| Phase 4 implementation | `9db08b5` — `feat: add automatic lookup trigger gates` |
| Review remediation | `fix: bind each gesture verdict to the identity that produced it` — the classifier fixes in §4 and the rebuilt checks in §20.9 |
| Evidence document | `docs: record phase 4 evidence`, then `docs: name the phase 4 commits in the evidence`, then the remediation's own evidence update |
| `HEAD` | `git log -1 --format=%H` at the tip of `master` prints the final commit; a document cannot name its own SHA |
| Worktree after commit | clean — `git status --porcelain` reports 0 entries |
| `git diff --check` | no whitespace errors |
| Build reproducibility | `lib/client.js` rebuilt byte-identically (`sha256 834A1F61…4134`) to the artifact the 159/159 run served |

The implementation is one commit, not several. The gate, the request controller,
the classifier's identity fields, the settings copy, the 127 new tests, the 19 new
bundle assertions, the runtime harness extension and the README are one coherent
change: splitting them would produce intermediate commits that neither build nor
pass, because the gate cannot be exercised without the runtime wiring that calls
it. The phase deliberately did **not** rename `scripts/phase1-verify.mjs` (§20.3),
which would have been the only genuinely separable change. The review remediation
is a second commit because it is a correction to a sealed artifact, and it says
so.

Git discipline observed:

```text
no force push                        no remote was created
no push to an unknown remote         (no remote is configured at all)
Phase 1 / 2 / 3 commits              not amended, not rebased, not rewritten
history                              not rewritten
git reset --hard                     not run
git clean -fd                        not run
git checkout . / git restore .       not run
```

The only deletions performed were of files this phase generated itself and could
prove worthless: none. Phase 4 deleted no file.

### 23.1 Remote and the Phase 4.1 push

| | value |
| --- | --- |
| remote | `origin` = `https://github.com/HaowenCang/dsh-word-lookup.git` |
| branch | `master` |
| Phase 4 tip at audit | `39ab4436aafbe0272d7ac2f866c5546da9e10126` |
| push | `git push origin master`, fast-forward, no `--force`, no `--force-with-lease` |
| verification | `local HEAD == origin/master`, `ahead/behind = 0/0` (§24.12) |

## 24. Phase 4.1 — semantic independence remediation

Status of this section: **the current contract**. Where §4, §17, §18, §19, §20.7,
§21.6 or §23 disagree with it, this section is what the build does and the older
text is kept as the record of what Phase 4 decided at the time.

```text
REVIEW FAIL — PHASE 4.1 REQUIRED / PHASE 5 NOT READY     (the audited state, 39ab443)
PASS — PHASE 4.1 COMPLETE / PHASE 5 READY                (after this remediation)
```

### 24.1 The defect

The product rule the two automatic switches have to satisfy is narrow and
absolute:

```text
autoSelection    controls a real drag-selection automatic lookup
autoDoubleClick  controls automatic lookup for a double click

a selection produced as part of a double click must NOT trigger autoSelection
```

The audited build violated it whenever the second press of a double click moved
at all. `endPointer()` decided the verdict from movement alone:

```ts
const dragged = isDragDistance(distance) && hasEligibleSelection
```

and the runtime offered that verdict to the gate from `onPointerUp` — which the
browser dispatches **before** it dispatches `dblclick`. So:

```text
second press drifts >= 5 px  ->  pointerup classifies `drag`
                             ->  autoSelection gate accepts and consumes identity N
                             ->  dblclick arrives, promotes identity N
                             ->  refused as `duplicate-gesture`
```

One platform gesture, one lookup, on the wrong switch's path. With
`autoSelection` on and `autoDoubleClick` off the reader's double click produced a
lookup they had disabled; with both on it produced an `auto-selection` lookup
instead of an `auto-double-click` one.

### 24.2 Why the sealed Phase 4 checks could not see it

`B/R P27`/`P28` drove `driftDouble()`, which issued two **plain** press/release
pairs:

```js
await page.mouse.down(); await page.mouse.up()          // clickCount defaults to 1
await page.mouse.down(); await page.mouse.move(cx + 8, cy); await page.mouse.up()
```

Playwright sends `clickCount: 1` on both presses unless told otherwise, so
Chromium never treated the pair as a double click: the sealed Phase 4 report
records `doubleClicks = 0`, `drags = 1`, and the accepted lookup's query as `"i"`
— the character the drag happened to select. The checks asserted

```js
drift.gapRequests <= 1 && drift.drags + drift.doubleClicks >= 1 && ...
```

so the drag alone satisfied them, and `P28`'s `auto-selection + auto-double-click === 1`
was satisfied by the `auto-selection` half. The positions were measured; the
*gesture* was assumed.

```text
Old P27/P28 did not actually observe a dblclick event.
```

That is a measured fact, not a reconstruction: `B/R P41B` replays the same two
plain presses — including the literal `driftDouble()` shape with its 8 px second
press — and records `mousedown detail [1,1]`, `click detail [1,1]`, **no
`dblclick` event at all**, `doubleClickGestures +0`, and a release classified
`drag`. Phase 4 §20.7 then documented the resulting behaviour (a drifting double
click attributed to `auto-selection`) as a deliberate choice. It was a defect:
the choice was made by the classifier's 5 px constant, not by the product.

### 24.3 The event probe, before any production change

`scripts/phase1-verify.mjs` installs a capture-phase trace of `pointerdown`,
`mousedown`, `pointermove`, `mousemove`, `pointerup`, `mouseup`, `click`,
`dblclick` and `selectionchange`, recording `type`, `detail`, `pointerType`,
`button`, `buttons`, `clientX`/`clientY`, the selection text and whether it was
collapsed, an order index and a `performance.now()` timestamp — for every event,
on both boots, with the two switches forced OFF so the probe itself issues
nothing. Chromium `153.0.8010.12`, DSH `0.2.0-rc.2`.

A normal double click (`page.mouse.dblclick`), `B/R P41A` — **PASS**:

```text
selectionchange  pointermove  mousemove
pointerdown  mousedown/1  pointerup  mouseup/1  click/1
pointerdown  mousedown/2  pointerup  mouseup/2  click/2  dblclick/2
selectionchange

mousedown detail   [1, 2]
click detail       [1, 2]
dblclick detail    [2]
doubleClickGestures +1
```

Phase 0's `mousedown(detail=2) / click(detail=2) / dblclick(detail=2)` is
therefore re-verified in the runtime this work ran in, rather than inherited.

Two more shapes were measured because the fix depends on them:

| probe | input | result | what it decides |
| --- | --- | --- | --- |
| two plain pairs | `mouse.down()/up()` twice, `clickCount` defaulted to 1 | `mousedown [1,1]`, `click [1,1]`, **no dblclick** | the sealed `P27`/`P28` shape could not observe a double click |
| raw CDP pairs | `Input.dispatchMouseEvent` pressed/released twice with **no** `clickCount` | `mousedown detail [0,0]`, **no `click` events**, **no dblclick** | Chromium's own click-count detector is not reachable from automation input; the client supplies the count |
| multi-click press, single release | `mousePressed(clickCount: 2)` … `mouseReleased(clickCount: 1)`, 8 px drift | **dblclick still emitted**, `detail 2` | Chromium takes the count from the *press*; a "flagged multi-click whose dblclick never arrives" cannot be produced through automation input, so that shape is covered by the harness, not claimed here |

The last row is why the runtime check below does not try to assert the
§9 fallback directly, and why the honest caveat in 24.11 exists: what was
measured is Chromium's *renderer* behaviour given a click count, not the
platform's native spatial tolerance for recognising a double click, which CDP
input bypasses.

### 24.4 The movement sweep

`B/R P41C` — **PASS**. Second press at the word's centre, released with the
multiplicity a real second press carries, after travelling N CSS px. The plugin's
classification is read from its own diagnostics in the same run.

| drift | browser `dblclick`? | `mousedown.detail` | `click.detail` | plugin kind | `drags` | `doubleClickGestures` | selection |
| ---: | --- | --- | --- | --- | ---: | ---: | --- |
| 0 | yes | `[1,2]` | `[1,2]` | `double-click` | 0 | 1 | `derive` |
| 1 | yes | `[1,2]` | `[1,2]` | `double-click` | 0 | 1 | `derive` |
| 2 | yes | `[1,2]` | `[1,2]` | `double-click` | 0 | 1 | `derive` |
| 3 | yes | `[1,2]` | `[1,2]` | `double-click` | 0 | 1 | `derive` |
| 4 | yes | `[1,2]` | `[1,2]` | `double-click` | 0 | 1 | `derive` |
| **5** | yes | `[1,2]` | `[1,2]` | `double-click` | **1** | 1 | `derive` |
| 6 | yes | `[1,2]` | `[1,2]` | `double-click` | 1 | 1 | `derive` |
| 8 | yes | `[1,2]` | `[1,2]` | `double-click` | 1 | 1 | `derive` |
| 10 | yes | `[1,2]` | `[1,2]` | `double-click` | 1 | 1 | `derive` |
| 12 | yes | `[1,2]` | `[1,2]` | `double-click` | 1 | 1 | `derive` |

The overlap is real and starts exactly at the classifier's constant: at 5 px the
platform still reports one double click **and** the plugin has a `drag` verdict
for the same sequence. `NO NATURAL OVERLAP OBSERVED` is therefore **not** the
case here (`overlapObserved: true`, mode `platform`), and the drift checks below
use the platform's own `dblclick` rather than a controlled substitute.

### 24.5 The fix

Minimal, and confined to the gesture→gate integration. The classifier's
**movement rule is untouched** — a press-release pair that travels far enough
over an eligible selection is still classified `drag` — and no timer, no text
comparison and no time window was introduced.

| file | change |
| --- | --- |
| `src/client/gesture.ts` | new `ClickMultiplicity` (`'unknown' | 'single' | 'multi'`), `clickMultiplicityOf(detail)`, one state field, one reducer `attachClickMultiplicity`, one fold `observeMouseDown`, and one counter `mouseDowns`. `beginPointer` clears it per press; `cancelGesture` clears it; `endPointer`/`registerDoubleClick` carry it; `classificationOf`/`gestureSnapshot` project it. |
| `src/client/trigger.ts` | the gate refuses an `auto-selection` lookup unless the press was verifiably a **single** click: `multi-click-sequence` (the platform said second click) or `unverified-click-multiplicity` (nothing ever said). The double-click path is **not** subject to it — `dblclick` is the platform's own recognition and is answered by its own switch. The check sits after the switch and pointer-kind checks, so every pre-existing refusal keeps its own reason. |
| `src/client/index.tsx` | one capture-phase `mousedown` listener (registered and disposed with the others) folds `event.detail` into the open press. Nothing else about the runtime changed: `selectionchange` still reaches no I/O, the gate is still consulted only from the two classification handlers, and the two `runLookup` call sites are unchanged. |
| `scripts/check-bundle.mjs` | the emitted client is asserted to carry both new reasons and a `mousedown` listener; the host bundle is asserted not to carry either (`88 → 94` checks). |

Why the gate rather than the classifier: "this press belongs to a multi-click
sequence" is *trigger policy*, and it is the drag path alone that must not act on
it. Keeping it in the gate also preserves the touch/pen refusal, which must keep
reporting `unverified-pointer-kind` and is checked before the multiplicity — a
classifier-level suppression would have made a synthetic touch drag `other` and
hidden the pointer-kind gate behind `not-a-trigger-gesture`.

The refusal direction is the safe one, and it is deliberate: a press the platform
flags as a multi-click whose `dblclick` never arrives produces **no** automatic
lookup, and neither does a press whose multiplicity was never observed. A missed
automatic lookup is recoverable with `Primary+Shift+L`; an unexpected one is what
both switches exist to prevent.

### 24.6 Acceptance matrix — real browser, real mouse, both boots

`autoSelection=true / autoDoubleClick=false`, a **platform double click** whose
second press drifts 8 px (Case A, `B/R P27`) — **PASS**, and FAIL before the fix:

| measurement | before (`39ab443`) | after |
| --- | --- | --- |
| requests | 1 | **0** |
| `auto-selection` delta | 1 | **0** |
| `auto-double-click` delta | 0 | **0** |
| `doubleClickGestures` delta | 1 | **1** |
| runner-up gate reason | drag `accepted`, then `duplicate-gesture` | `switch-off` |
| classifier's press multiplicity | not recorded | `multi` |

`autoSelection=false / autoDoubleClick=true` (Case B, `B/R P30`) — **PASS**:
requests **1**, `auto-double-click` **+1**, `auto-selection` **0**,
`doubleClickGestures` **+1**.

Both on (Case C, `B/R P28`) — **PASS**, and FAIL before the fix:

| measurement | before (`39ab443`) | after |
| --- | --- | --- |
| requests | 1 | **1** |
| `auto-selection` delta | **1** | **0** |
| `auto-double-click` delta | **0** | **1** |
| `doubleClickGestures` delta | 1 | 1 |
| origin of the accepted lookup | `auto-selection` | **`auto-double-click`** |

A real independent drag (Case D) is unaffected: `B/R P04` (S10) and `B/R P10`
(S11) still issue exactly one `auto-selection` lookup each, and `B/R P16` still
produces two lookups for two drags of the same word **under 100 ms apart**
(95–97 ms across runs, on two identities, with the check asserting the gap is
below 300 ms). `B/R P01`/`P07` (a drag with its own switch off) still issue none.

Case A's second half — `autoSelection` on, a *zero-movement* double click — is
`B/R P05`, strengthened to assert the deltas rather than only the absence of
requests: `doubleClickGestures +1`, `auto-selection 0`, `auto-double-click 0`.

Two further runtime checks cover the rules that have no `dblclick` to observe:

- `B/R P31` — a drag-shaped sequence delivered **without** the `mousedown` that
  carries the multiplicity (synthetic `PointerEvent`s, the shape an automation
  agent or extension produces) issues **0** requests, is classified `drag`, is
  refused as `unverified-click-multiplicity`, and the very next real drag in the
  same switch state issues exactly 1 `auto-selection` lookup with
  `mouseDowns +1`. The counter is asserted on both sides so the zero cannot be
  explained by a listener that never ran.
- the harness case in 24.7 covers the multi-click press whose `dblclick` never
  arrives, which 24.3 measured as unreachable through automation input.

### 24.7 Harness evidence (real runtime wiring, fake DOM)

`tests/client-runtime-harness.spec.ts` replays the overlap through the real
`apply()`, the real listeners, classifier, gate, controller and store:

```text
pointerdown  mousedown(detail 2)  selection  move > DRAG_THRESHOLD  pointerup  dblclick
```

| state | requests | `auto-selection` | `auto-double-click` | double-click gestures |
| --- | ---: | ---: | ---: | ---: |
| S10 | **0** | 0 | 0 | 1 |
| S01 | **1** | 0 | 1 | 1 |
| S11 | **1** | 0 | **1** | 1 |

plus:

- the multi-click press whose `dblclick` never arrives: **0** requests, reason
  `multi-click-sequence`, the identity **not** consumed, so the `dblclick` that
  follows is still answered once as `auto-double-click`, and the next real drag
  still fires;
- a drag with no observed multiplicity: refused as
  `unverified-click-multiplicity`, then the next real drag fires;
- a multi-click drag with both switches on: refused, nothing consumed.

The Phase 4 assertion that a `drag` release followed by a `dblclick` is absorbed
as `duplicate-gesture` was **removed**, as the brief requires: it asserted the
defect as the allowed behaviour. Duplicate absorption is still covered where it
is still reachable — at the gate, by `tests/client-trigger.spec.ts`.

New pure coverage in `tests/client-gesture.spec.ts` pins the narrowing
(`1 → single`, `≥2 → multi`, anything unmeasured → `unknown`), the per-press
lifetime, the non-primary refusal, the cancel clearing, the counter, and the fact
that a drifting multi-click press is *still* classified `drag` — the classifier's
movement rule was not weakened to make this work.

### 24.8 Totals

| | Phase 4 | Phase 4.1 |
| --- | --- | --- |
| unit/integration (`npm run test`) | 17 files / **351** tests | 17 files / **372** tests (+21, none weakened) |
| bundle static checks | **88/88** | **94/94** |
| isolated runtime (`npm run test:runtime`) | **159/159** | **169/169** |
| browser | Chromium 153.0.8010.12 | Chromium 153.0.8010.12 (same run-time environment) |

The runtime run before the fix — the reproduction — was **161/169** with these
failures on **both** boots: `B/R P41B` (a wrong expectation of mine about the
plain-pair shape, corrected against the measurement, not the other way round),
`B/R P27`, `B/R P28` and `B/R P31`. `B/R P30` passed before and after, which is
the expected asymmetry: with `autoSelection` off the drag could not win.

169 = Phase 1's 64 + Phase 2's 13 + Phase 3's 20 + Phase 4's 62 + **Phase 4.1's
10** (`B/R P41A`, `P41B`, `P41C`, `P30`, `P31` = 5 per boot × 2 boots). The four
browser stress storms were raised to **100 drags + 100 double clicks in all four
quadrants** on both boots, each asserting `drags = 100`, `doubleClicks = 100` and
the exact per-origin counts, so "true double click" is proven by
`doubleClickGestures` rather than assumed.

```text
S00  100 true drags + 100 true double clicks ->   0 requests
S10  100 true drags + 100 true double clicks -> 100, all auto-selection
S01  100 true drags + 100 true double clicks -> 100, all auto-double-click
S11  100 true drags + 100 true double clicks -> 200, 100 + 100
```

Every Phase 4 regression the brief lists is re-measured and still passes:
`selectionchange` → 0 I/O (`B/R P12`, plus the AST reachability check), normal
drag → `auto-selection`, normal double click → `auto-double-click`, same text +
new gesture → new lookup (`B/R P15`/`P16`), same identity → at most one lookup,
the manual shortcut independent and still exactly one everywhere, latest-request-
wins, stale success and stale failure ignored, loading ownership, composer
exclusion (`B/R P20`/`P21`), mouse-only automatic support (`B/R P29` — still
refused as `unverified-pointer-kind`), settings live update (`B/R P13`/`P14`),
and one lookup per gesture after a client reload (`L06`/`L07`).

### 24.9 Isolation

```text
$ npm run test:runtime
ISOLATION CHECK: PASS          (runner gate)
ISOLATION CHECK: PASS          (harness gate)
phase1-verify: PASS — 169/169 checks
```

| | value |
| --- | --- |
| `DSH_HOME` | `C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home` |
| profile | `word-lookup-test` |
| port | `50991` (free again after the run; only `TIME_WAIT` entries remain) |
| browser | Chromium `153.0.8010.12`, headless |
| authentication | the isolated instance's own launch token |
| boots | 2, `H02` stopping cleanly and `H03` restarting from the same profile |
| result | **169/169**, `summary.failed = []` |
| wall clock | `15:23:05Z` → `15:28:30Z` (the acceptance run on the committed bundle) |
| report | `docs/evidence/phase41-verification-20261002.json` |

The pre-fix run used the same entry point and the same environment and printed
`ISOLATION CHECK: PASS` twice as well; its report is kept as
`docs/evidence/phase41-verification-prefix-20261002.json`.

### 24.10 Test totals and what changed in them

| file | before | after | what was added |
| --- | ---: | ---: | --- |
| `tests/client-gesture.spec.ts` | 31 | 40 | the multiplicity narrowing, per-press lifetime, non-primary and cancel cases, the counter, and the "movement rule unchanged" case |
| `tests/client-trigger.spec.ts` | 33 | 40 | the multi-click refusal on both paths, the switch/pointer-kind ordering, the four-state matrix for a multi-click drag |
| `tests/client-runtime-harness.spec.ts` | 46 | 51 | the overlap matrix (S10/S01/S11), refused-not-consumed, the un-delivered `dblclick`, the unverified multiplicity; the duplicate-absorption case it replaces was removed |
| `tests/client-gesture-identity.spec.ts` | 17 | 17 | the projected classification now spells out `clickMultiplicity` |

No pre-existing assertion was weakened. The two that changed *shape* are named
here: the harness's `dblclick`-as-duplicate case was removed (it asserted the
defect), and the harness drivers now emit the `mousedown` that a real mouse
always emits — a stricter replay of the Phase 0 §7.3 order, without which the
drivers would have been testing a sequence no device produces.

### 24.11 Residual risks

1. **A multi-click press whose `dblclick` never arrives is suppressed.** The
   rule is deliberate (24.5), but it is a *behavioural* consequence: if a reader
   clicks a word and then, within the platform's double-click time and area,
   starts a drag from the same spot, the second gesture is suppressed. The
   spatial window is the platform's own (a few pixels), the manual shortcut is
   unaffected, and the safe direction was chosen on purpose — but it is a real
   cost and it is not measured here, because that window is not reachable through
   automation input.
2. **A press whose `mousedown` is never observed cannot produce an
   `auto-selection` lookup.** Real mouse input always delivers it, and `B/R P31`
   proves the counter moves for real drags; but an environment where another
   capture-phase listener stops the compatibility event before this plugin sees
   it would disable the automatic drag path (it would still be diagnosable: the
   gate reports `unverified-click-multiplicity` and `mouseDowns` stays put). The
   plugin registers on `document` capture, as it did in Phase 2; moving that one
   listener to `window` capture is the mitigation if a host ever needs it.
3. **The platform's native double-click tolerance was not measured.** CDP input
   supplies the click count, so 24.4 measures what Chromium's renderer does with
   a multiplicity the platform would have computed, not the browser's own
   recognition distance. The fix does not depend on that distance: it consumes
   the multiplicity the platform actually reports, whatever the platform's rule
   for computing it is.
4. **The multiplicity is read from the compatibility event, not from a pointer
   event.** `PointerEvent` has no click count, so `mousedown` is the only source.
   It is a DOM-standard field (`UIEvent.detail`), re-measured here rather than
   assumed, and the fallback when it is absent is refusal rather than guessing.
5. Residual risks 1–12 of §21 remain as written, except **§21.6** (the drifting
   double click attributed to `auto-selection`) which this section resolves, and
   **§21.12** (no remote) which §23.1 replaces.

### 24.12 Git

| | value |
| --- | --- |
| `START_SHA` | `39ab4436aafbe0272d7ac2f866c5546da9e10126` |
| Phase 4.1 | `fix: keep double-click and drag auto lookup independent` |
| history | `9db08b5` and `39ab443` **not** amended, not rebased, not rewritten |
| force push | not run (`--force` and `--force-with-lease` never used) |
| remote | `origin` = `https://github.com/HaowenCang/dsh-word-lookup.git`, `master` fast-forwarded |
| `git diff --check` | no whitespace errors |
| worktree after commit | clean (`git status --porcelain` reports 0 entries) |
| build reproducibility | `lib/client.js` `sha256 D232C191…82CB` — the artifact the 169/169 acceptance run served, rebuilt byte-identically from the committed sources by `npm run verify` |

The commit is one change, not several: the classifier records a platform fact,
the gate refuses on it, the runtime observes the event that carries it, and the
checks that were wrong are replaced. Splitting it would produce intermediate
commits whose tests assert the defect.

The production instance (`127.0.0.1:19387`, pid `51344`) was left running and
untouched throughout; it wrote its own usage and session state while it served
this conversation, as it always does. No action of this work addressed it: every
runtime test ran against the isolated scratch home above, the production profile
still contains no `dsh-word-lookup` row (`package.json`, `cordis.yml`,
`cordis.patch.yml`), the production port was never bound or connected to, and no
production session, cookie, loader or route was read, copied or modified.

```text
Production DSH environment modified during this work: NO
```

## 25. Phase 4.2 — first-press drift audit

Status of this section: **the record of a measurement, not a fix**. Where §24
describes what the build does, this section reports an open boundary and why it
was left open.

```text
FIRST-PRESS OVERLAP OBSERVED
BLOCKED — PRODUCT TRADE-OFF REQUIRED / PHASE 5 NOT READY
```

### 25.1 What was hypothesised

Phase 4.1 closed the **second**-press half of the double-click / drag overlap: an
`auto-selection` lookup is refused unless the press's `mousedown.detail` is
verifiably `1`. That works because a second press carries `detail === 2` and the
gate can see it *before* it spends anything.

The first press of any double click, however, always arrives as
`mousedown.detail === 1` — the platform cannot know a second click is coming
either. So the symmetric case has no such guard:

```text
press #1   detail 1   drift >= 5 px   eligible selection   ->  classifier says `drag`
                                                           ->  gate says `single`, accepts
                                                           ->  autoSelection issues a lookup
press #2   detail 2   ...             dblclick            ->  autoDoubleClick issues a second
```

Two lookups for one platform gesture, one per switch — the coupling §24 removed.

### 25.2 How it was measured, and what automation cannot measure

`scripts/phase42-probe.mjs` is the probe. It boots the isolated instance, installs
a capture-phase trace of `pointerdown`, `mousedown`, `pointermove`, `mousemove`,
`pointerup`, `mouseup`, `click`, `dblclick` and `selectionchange` (recording order,
`detail`, `pointerType`, `button`, `buttons`, `clientX`/`clientY`, the selection
text, whether it was collapsed, and a `performance.now()` timestamp for each), and
sweeps the **first** press over `0, 1, 2, 3, 4, 5, 6, 8, 10, 12` px while the
second press stays at the origin. The gap between the two presses is measured
(~87–102 ms), not assumed. Evidence: `docs/evidence/phase42-probe-20261002.json`.

The probe is explicit about the limit §8 of the brief requires. CDP input has to
be **told** the click count, so the sweep is run in four multiplicity modes, and
each row records which one produced it:

| mode | who supplies the count | why it exists |
| --- | --- | --- |
| `supplied-2` | the automation client sets `clickCount: 2` on the second press | reproduces the multiplicity a real second press carries; this is the input the product consumes |
| `plain-1` | both presses are plain clicks | the shape Playwright sends by default, and the shape the sealed Phase 4 check used |
| `raw-cdp` | nobody — raw `Input.dispatchMouseEvent` with no `clickCount` | control: is any built-in click-count detector reachable from automation input? |
| `supplied-2-late` | `clickCount: 2`, but with a ≈1300 ms gap | control: does the renderer check **time** as well as space? |

Nothing below calls a supplied count a native recognition. What is measured is the
renderer's behaviour *given* a multiplicity — the same class of measurement Phase
4.1's `P41A`/`P41C` already rest on.

### 25.3 The first-press movement sweep

Both switches **off**, so the probe itself issues no I/O. `md` is
`mousedown.detail`, read from the trace.

| first drift | first `md` | selection at first `pointerup` | plugin kind | multiplicity | second `md` | `dblclick` | gap |
| ---: | --- | --- | --- | --- | --- | --- | ---: |
| 0 | `1` | `""` | `other` | `single` | `2` | **yes** | 90.0 ms |
| 1 | `1` | `""` | `other` | `single` | `2` | **yes** | 88.7 ms |
| 2 | `1` | `""` | `other` | `single` | `2` | **yes** | 102.1 ms |
| 3 | `1` | `""` | `other` | `single` | `2` | **yes** | 92.5 ms |
| 4 | `1` | `i` | `other` | `single` | `2` | **yes** | 96.9 ms |
| **5** | `1` | `i` | **`drag`** | `single` | `2` | **yes** | 97.5 ms |
| **6** | `1` | `i` | **`drag`** | `single` | `2` | **yes** | 89.2 ms |
| **8** | `1` | `i` | **`drag`** | `single` | `2` | **yes** | 94.0 ms |
| **10** | `1` | `iv` | **`drag`** | `single` | `2` | **yes** | 87.1 ms |
| **12** | `1` | `iv` | **`drag`** | `single` | `2` | **yes** | 89.1 ms |

The classifier's `drag` verdict starts exactly at its 5 px constant, and from that
row onwards **every** element of the hypothesised overlap is present at once:
`distance >= 5`, an eligible selection at the first `pointerup`, a `drag`
classification, a `single` multiplicity the gate accepts, and a `dblclick` the
platform reports for the pair. The two runs of the probe in this session agree row
for row.

Verbatim, the drift-8 pair (from the probe's own trace):

```text
press #1   pointermove/0  mousemove/0  pointerdown/0  mousedown/1
           pointermove/0  mousemove/0  selectionchange
           pointermove/0  mousemove/0  selectionchange
           pointerup/0    mouseup/1    click/1                 selection "i"

           ... 94.0 ms with no event at all ...

press #2   pointermove/0  mousemove/0  pointerdown/0  mousedown/2
           pointerup/0    mouseup/2    click/2    dblclick/2
```

### 25.4 The controls

| mode | result across all ten distances | what it establishes |
| --- | --- | --- |
| `plain-1` | second `md` `1`; **no `dblclick`** at any drift; final kind `other` | re-confirms Phase 4.1 §24.3: the sealed `P27`/`P28` shape could never have observed a double click |
| `raw-cdp` | second `md` `0`; no `click`, **no `dblclick`** at any drift | **no click-count detector is reachable from automation input**; the count is the automation client's, not the platform's |
| `supplied-2-late` | **`dblclick` still emitted at every drift**, with a ≈1300 ms gap | the renderer checks **neither space nor time**: its `dblclick` is a pure function of the multiplicity it was handed |

The third control is the one that matters for honesty, and it cuts both ways. It
proves that the sweep's `dblclick` is not evidence about the browser's or the
operating system's own recognition — but it equally proves the renderer applies
**no spatial validation of the pair**, so nothing inside the page prevents a first
press that drifted ≥ 5 px from being the first half of the double click the
platform reports.

### 25.5 Verdict

```text
FIRST-PRESS OVERLAP OBSERVED
```

`overlapObserved: true`, computed by the probe from its own rows: the five
distances `5, 6, 8, 10, 12` satisfy the brief's §9 test exactly
(`distance >= 5` ∧ eligible selection at the first `pointerup` ∧ plugin classifies
`drag` ∧ `dblclick` emitted). No row that formed a genuine drag failed to produce
one (`dragRowsWithoutDoubleClick: []`), which is the boundary the brief's CASE A
would have required.

### 25.6 The defect, reproduced on the wire before any change

`auto-selection` decisions are read from the plugin's own accounting; `requests`
from Playwright's network layer. The two are asserted together, as everywhere else
in this document. Overlap gesture: first press drifts 8 px, second press at the
origin.

| state | `autoSelection` | `autoDoubleClick` | requests | `auto-selection` | `auto-double-click` | first `pointerup` already issued | required by §11 | verdict |
| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| **S10** | true | false | **1** | **1** | 0 | 1 (`auto-selection`, `"i"`) | 0 | **VIOLATED** |
| **S01** | false | true | 1 | 0 | 1 | 0 | exactly 1, `auto-double-click` | holds |
| **S11** | true | true | **2** | **1** | **1** | 1 (`auto-selection`, `"i"`) | exactly 1, `auto-double-click` | **VIOLATED** |

So the defect is confirmed in the two states the brief names, and the asymmetry
matches Phase 4.1's: with `autoSelection` off the drag cannot win, so S01 was
already correct.

The wire count is what makes it a defect rather than a display artefact: the
reader made one platform gesture and two POSTs left the page, one for a one- or
two-character drag selection (`i`/`iv`) and one for the word the platform's own
double click selected (`derive`). The card ends on the right answer, which is why
the extra request is invisible unless the wire is counted — and why Phase 4's
"one semantic gesture, at most one automatic lookup" is the property under test.

### 25.7 Is there a synchronous signal at the first `pointerup`? No.

This is the fact the whole repair decision turns on, and it is measured rather
than argued. At the moment the first press classifies — the only moment at which
`autoSelection` can act, and the moment `credential`-free evidence shows the
lookup leaving — the plugin's entire observable stream is:

```text
pointerdown  mousedown/1  pointermove…  selectionchange…  pointerup  mouseup/1  click/1
```

Every field in it describes a lone drag. `mousedown.detail` is `1` and will be
`1` whether or not a second press follows, because the platform has not decided
yet either; `click.detail` is `1` for the same reason; there is no "a second press
is pending" flag, no `dblclick` (it is dispatched only after the second release),
and no counter that resets. The second press's `mousedown/2` arrives ~90 ms later —
measured, not estimated — long after the request is gone.

```text
Strict semantic ownership requires deferring the auto-selection commitment.
```

There is no synchronous alternative, so the brief's §13 mechanism is the only
shape that can satisfy §11, and the brief's §14 condition on it is met.

### 25.8 Why production code was not changed

Deferring the commitment needs a **commit boundary**, and the probe says what it
cannot be. It cannot be an event: after a lone drag there is no further event at
all until the reader does something else, so a pending intent would never
commit and a drag would never look itself up. It therefore has to be a timer
bounded by the platform's own multi-click window — and that window is **not
obtainable by the plugin**:

- the renderer implements no part of it — `raw-cdp` finds no detector at all, and
  `supplied-2-late` shows the renderer ignores both space (12 px) and time
  (1300 ms) when it is handed a count;
- no web API exposes it, and the plugin's client half has no other channel to it;
- the only value reachable at all is the host operating system's own, which is a
  different fact about a possibly different machine, and would need a new
  host→client configuration channel to reach the browser at all.

The platform parameters on the machine this work ran on are, for scale,
`GetDoubleClickTime() = 500 ms` and `DoubleClickSpeed = 500`,
`DoubleClickWidth = 4`, `DoubleClickHeight = 4` in `HKCU\Control Panel\Mouse`. A
bound of that order would add **up to half a second of latency to every automatic
drag selection** — the product's primary automatic path — to suppress one extra
request in an ambiguous case. That is a product decision, not an audit fix, and
the brief's §14 is explicit that the honest response is to report the trade-off
rather than hard-code an unverified constant. **No constant was chosen and no
production file was touched.**

The probe's ownership rows are the evidence for that conclusion, and they are also
the acceptance test any future fix must flip:

```text
S10  requests 1  (auto-selection 1, auto-double-click 0)   product invariant VIOLATED
S01  requests 1  (auto-selection 0, auto-double-click 1)   product invariant HOLDS
S11  requests 2  (auto-selection 1, auto-double-click 1)   product invariant VIOLATED
```

The options, with their measured costs, are stated in §25.11.

### 25.9 The native half of the question is still unmeasured

This section must not be read as a claim about the operating system. The sweep
supplies the click count; §8 of the brief forbids describing that as the
browser's or the OS's own recognition tolerance, and the `raw-cdp` and
`supplied-2-late` controls show why the distinction is real rather than
ceremonial.

What is left unmeasured is narrow and nameable: the platform's double-click
rectangle is anchored at "the location of a first click", and this work could not
establish — without network access to the Chromium or Windows sources, and
without real OS-level input injection into a desktop session — whether that anchor
is the first press's **button-down** position or its **release** position:

- anchored at **button-down**, the drift is irrelevant, the pair is still inside
  the 4 px rectangle, the platform reports a multi-click, and the overlap is
  reachable in production;
- anchored at **release**, a first press that drifted ≥ 5 px ends more than 4 px
  from where it began, the pair falls outside the rectangle, no `dblclick` is
  produced, and the overlap is **not** reachable in production — which would make
  this phase's CASE A the truthful one.

Automation input bypasses that decision entirely, so it cannot be settled from
inside the page. Deciding it needs real OS-level input against a real Chromium
window, which this phase deliberately did not manufacture. This is the same blind
spot §24.11 residual risk 3 recorded; Phase 4.2 has narrowed it to one question
with two answers, and has shown that the *renderer* does not supply the answer.

### 25.10 Isolation

```text
$ node scripts/phase42-probe.mjs
ISOLATION CHECK: PASS
```

| | value |
| --- | --- |
| `DSH_HOME` | `C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home` |
| profile | `word-lookup-test` |
| port | `50991` (free again after the run) |
| browser | Chromium `153.0.8010.12`, headless |
| authentication | the isolated instance's own launch token |
| boots | 1 per probe run; 2 runs |
| sweeps | 5 × 10 rows, plus 3 ownership gestures |

The probe's first executable statement is the same isolation assertion the other
runtime entry points use; it refuses to start against anything that is not
provably scratch. The production instance on `127.0.0.1:19387` was never bound or
connected to, and no production home, profile, session, cookie, loader or route
was read, copied or modified. No desktop input was injected.

### 25.11 Residual risks and the decision this phase leaves open

1. **The overlap is open.** S10 issues a lookup for a gesture the platform
   subsequently recognises as a double click, and S11 issues two for it. Phase 4's
   one-gesture-one-lookup property therefore does **not** hold for this shape.
2. **The native reachability is unmeasured** (§25.9). Until it is settled, nobody
   can say whether the overlap costs anything in production, and the two candidate
   answers point at opposite decisions.
3. **The three available resolutions**, each with what it costs:

   | option | what it does | cost |
   | --- | --- | --- |
   | **A. accept and document** | leave the trigger as it is; record the overlap | one extra request and a transient card update in an ambiguous case; the one-gesture property stays untrue for this shape |
   | **B. defer auto-selection** | pending intent at `pointerup`; cancel on `mousedown.detail >= 2` or the promoting `dblclick`; commit on a platform-derived bound | up to the platform's multi-click interval (≈500 ms here) added to **every** automatic drag; needs a host→client channel for a value the renderer cannot see |
   | **C. settle §25.9 first** | drive the same sweep with real OS-level input in an isolated desktop session | decides whether B is needed at all; if the anchor is the release position, the overlap is production-unreachable and the phase closes with no fix |

   Option C is the cheapest and is the recommended next step: it converts an
   unmeasurable assumption into a measurement, and it can retire options A and B
   entirely.
4. **No assertion was added to the sealed runtime harness.** An assertion on the
   required ownership would fail today, and an assertion that recorded the current
   ownership as expected would be exactly the kind of check §24.10 removed for the
   mirrored case — a test that asserts the defect. The probe is the permanent
   artefact instead: it re-measures all five sweeps on every run and recomputes
   `overlapObserved` from the rows, so a Chromium or Playwright change that alters
   any of them is visible immediately rather than silently absorbed.
5. §21 and §24.11 residual risks remain as written; this section supersedes
   nothing in them, and adds one more.
6. **Portability release blocker recorded (Phase 4.2 closeout).** See `docs/PHASE42_NATIVE_INPUT_EVIDENCE.md` §8 (`RELEASE BLOCKER — automatic-selection portability`). Native measurement demonstrated CASE A for the tested Windows 11 / Chromium / 4 px double-click configuration, but system-wide double-click rectangle configurability, different DPI metrics, and non-Windows platforms leave cross-platform automatic-selection portability as an open release blocker.

### 25.12 Verification

`npm run verify` and `npm run test:runtime` were re-run after this work and are
**unchanged**: the production sources, the tests and the sealed bundle are
byte-identical to `58384d7`, because nothing outside `scripts/phase42-probe.mjs`,
the evidence file and this document was written.

| | value |
| --- | --- |
| `npm run verify` | PASS — 17 files / 372 tests, bundle checks 94/94, credential scan PASS |
| `npm run test:runtime` | PASS — **169/169** checks, `ISOLATION CHECK: PASS` twice |
| `git diff --check` | no whitespace errors |
| production sources touched | **none** — `git status --short` lists only `docs/PHASE4_EVIDENCE.md`, `docs/evidence/phase42-probe-20261002.json` and `scripts/phase42-probe.mjs` |

One failed attempt is recorded rather than smoothed over, because the failure was
real and the fix matters. The first acceptance run after the probe reported
**168/169**: `B20` ("the settings namespace is served to the browser and both
defaults are false") failed on boot 1 with `{autoDoubleClick: true,
autoSelection: true}`. The cause was the probe, not the product. The probe's last
sweep leaves `S11` in force, and `ConfigForm.set` **persists** — so the probe had
written `true/true` into the isolated profile's patch, and the next boot correctly
loaded it. Phase 4's own note in §18 that the retained profile ends on
`false/false` is exactly the invariant that was broken, and `S07` in the
acceptance harness restores it for the same reason the probe now does:
`scripts/phase42-probe.mjs` ends by putting both switches back through the same
settings write and records the result as `restoredSwitches`. The re-run above is
the probe's third execution, from the committed script, with the acceptance run
immediately after it, and both are green.

This is worth stating plainly because it is a small instance of the thing this
whole phase is about: a measurement that changes the state it measures is not a
measurement. It was caught by the existing gate rather than by inspection, which
is the gate working.

### 25.13 Git

| | value |
| --- | --- |
| `START_SHA` | `58384d737d913dc4a839131b9b23484725dbbb02` |
| `58384d7` amended / rebased | no |
| force push | not run |
| push | **not run** — the brief gates `git push origin master` on PASS, and this phase is BLOCKED |
| worktree | see the commit created for this phase below |

```text
Production DSH environment modified during this work: NO
```
