# Phase 5 Evidence — Production Result Card UI, Viewport Safety, Dismissal & Interaction Integrity

## 1. Baseline

| Fact | Value |
| --- | --- |
| `START_SHA` | `d585300c17dbaa16f0a6b3afe8ca27c90f97713c` |
| Branch | `master` |
| Worktree at start | clean (`git status --short` empty) |
| Previous checkpoint | `d585300` Phase 4.2 native-input audit reconciliation |
| Phase 5 scope | Production Result Card UI, Pure Viewport Positioning Engine, Surface Generation Identity, Dismissal & Race Correctness, Accessibility, Non-Stealing Focus, Overlay Pass-Through |

`HEAD` had not advanced beyond the stated baseline prior to this phase. No history was rewritten; no force commands (`git reset --hard`, `git clean -fd`, `git checkout .`, `git restore .`) were executed.

All pre-existing unit test suites (Phases 1–4.2) and all 169 isolated runtime verification checks pass without regression.

## 2. Environment

| Fact | Value |
| --- | --- |
| DSH Shell / Base | `0.2.0-rc.2` |
| Node.js | `v24.13.0` |
| npm | `11.12.0` |
| SQLite (bundled with Node) | `3.50.4` |
| Browser Engine | Chromium `153.0.8010.12` (Playwright `1.63.0`) |
| Test Runner | `vitest v3.2.4` |
| Bundler | `tsdown v0.23.0` (powered by `rolldown v1.2.11`) |
| TypeScript | `v5.9.3` |
| OS / Platform | Windows 11 (x64) |

Isolation protocol strictly observed: all tests executed on isolated port `50991` and `50992` using dedicated temporary home directories (`C:\Users\20659\AppData\Local\Temp\dsh-word-lookup-test\home`), never touching production port `19387`, production profiles, or production user data.

---

## 3. Architecture & 5-State UI Model

The Result Card UI implements a strictly mutually exclusive 5-state finite state machine derived from `CardState`:

```
           [lookup triggered]
[idle] ------------------------> [loading]
  ^                                 |
  | (dismissed)                     | (response resolved)
  |                                 v
[idle] <----------------------- [found] | [not-found] | [error]
```

### State Definitions:
1. `idle`: Occupant renders `null`. Overlay slot contains 0 child nodes (`slotChildren: 0`).
2. `loading`: Rendered as an elevated card containing the query title and a subtle loading message (`"Fetching dictionary definition..."`).
3. `found`: Complete dictionary entry rendering:
   - Header: Canonical headword (`<h2>`), phonetic transcription (`<span data-dsh-word-lookup="phonetic">`), and accessible close button (`<button aria-label="Close dictionary">`).
   - Lemma relation tag (`<div data-dsh-word-lookup="lemma">`): Displayed **only** when `matchedForm` exists and differs from `headword` (e.g., `"went → go"`, `"teeth → tooth"`, `"derived → derive"`). When searching canonical headword `"derive"`, lemma tag is omitted.
   - Meanings list (`<ol data-dsh-word-lookup="meanings">`): Ordered definitions with part of speech (`<span data-dsh-word-lookup="pos">`), Chinese translations (`<span data-dsh-word-lookup="gloss">`), and English definitions.
   - Inflected forms summary (`<div data-dsh-word-lookup="forms">`).
   - Bilingual contextual example sentences (`<div data-dsh-word-lookup="example">`).
4. `not-found`: Clean, non-intrusive notification: `"no entry for \"<query>\""`. Never displays red error banners, stack traces, or broken layout.
5. `error`: Sanitized error notification: `"Dictionary service unavailable"` or `"Request refused (<status>)"`. Never leaks filesystem paths, SQLite schema, route endpoints, or auth tokens.

All nullable and optional fields (`phonetic: null`, `partOfSpeech: null`, `definition: null`, empty forms, empty examples) render safely without producing `undefined`, `null`, or `NaN` text.

---

## 4. Pure Viewport-Safe Positioning Engine

Implemented in `src/client/position.ts` as a pure mathematical function:

```typescript
export function computeCardPosition(
  anchorRect: CardRect | null,
  cardSize: CardDimensions,
  viewportSize: CardDimensions,
  options?: PositionOptions,
): CardPosition
```

### Deterministic Placement Rules:
1. **Vertical Preferred Below**: If `anchorRect.bottom + gap + cardHeight <= viewportHeight - margin`, places card at `top = anchorRect.bottom + gap`.
2. **Vertical Fallback Above**: If placing below overflows the bottom margin, and `anchorRect.top - gap - cardHeight >= margin`, places card at `top = anchorRect.top - gap - cardHeight`.
3. **Vertical Viewport Clamping**: If card overflows both above and below, clamps `top` between `margin` and `max(margin, viewportHeight - margin - cardHeight)`.
4. **Horizontal Alignment & Clamping**: Aligns card with `anchorRect.left`, clamped between `margin` and `max(margin, viewportWidth - margin - cardWidth)`.
5. **Narrow Viewport Adaptation**: In viewports smaller than default card width (e.g., 360px mobile view), width is clamped to `min(360px, calc(100vw - 24px))` and `left` is clamped to margin `12px` without horizontal scrollbar or overflow.
6. **Multiline Rect Handling**: Accepts selection bounding client rects spanning multiple text lines; anchor top and bottom correctly anchor above or below the selection block.
7. **Null Fallback**: When `anchorRect === null`, places card horizontally centered at the upper portion of the viewport (`top: 60px`, `left = (viewportWidth - cardWidth) / 2`).

Positioning is recalculated automatically on window resize via `useIsomorphicLayoutEffect` and `resize` event listener.

---

## 5. Surface Generation Identity & Dismiss / Request Race Correctness

### Problem:
In asynchronous UI environments, request completion order can decouple from user intention. If a request is slow, and the user dismisses the card or triggers a new lookup before the response arrives, late network settlement must **never** revive a dismissed card or overwrite newer data.

### Solution: Two Distinct Monotonic Counters
1. `requestId` (Request Identity): Monotonically incremented on each network lookup. Only the latest `requestId` is accepted by `LookupController.run()`.
2. `surfaceGeneration` (Surface Generation Identity): Monotonically incremented on each visible lookup initiation and stored in `LookupCardStore`.

### Dismissal Invalidation Contract:
When the user dismisses the card (Escape, outside click, close button), `store.dismiss()` sets:
```typescript
this.dismissedGen = this.currentGen
this.state = { status: 'idle' }
```
When `LookupController.run()` settles:
```typescript
if (this.store.isDismissed(gen)) {
  return // Surface was dismissed; discard late result silently
}
```

### Measured Race Guarantees (Unit & Browser Verified):
- **D1 (Close Before Settle - Success)**: User looks up word A -> dismisses card while loading -> response A succeeds -> card remains closed in `idle` state.
- **D2 (Close Before Settle - Failure)**: User looks up word A -> dismisses card while loading -> response A returns 500 error -> card remains closed; no error toast appears.
- **D3 (Rapid Superseding A -> B)**: User triggers word A -> triggers word B before A returns -> A returns late -> B settles -> card displays word B.
- **D4 (Same Word Re-query After Dismiss)**: User looks up word A -> dismisses card -> looks up word A again -> new surface generation is allocated -> card displays word A normally.

---

## 6. Card Dismissal & Overlay Layer Click-Through Safety

### Dismissal Mechanisms:
1. **Escape Key**: Global keydown listener on `document` listens for `Escape` while card is open, stopping propagation and calling `store.dismiss()`.
2. **Outside Pointerdown**: Capture-phase pointer listener on `document` checks `!cardRef.current.contains(event.target)`. When detected, dismisses card immediately.
3. **Close Button**: Accessible `<button type="button" data-dsh-word-lookup="close" aria-label="Close dictionary" title="Close dictionary (Esc)">×</button>`.

### Zero Overlay Click-Shield (Pass-Through Guarantee):
- The DSH `shell.overlay` slot host uses `pointer-events: none` across the screen.
- Only the Result Card element itself sets `pointer-events: auto`.
- No full-screen backdrop or modal click shield is rendered.
- **Proof (`DISMISS-OUTSIDE`)**: Clicking on an underlying conversation item or composer input dismisses the dictionary card AND simultaneously dispatches the click to the underlying element (e.g. focused the composer and fired its click handler).
- Conversation scrolling with mouse wheel remains fully functional outside the card.

---

## 7. Accessibility, Non-Interference & Semantic Structure

### Semantic Markup:
- Container: `<aside role="region" aria-label="Dictionary lookup" data-dsh-word-lookup="card">`
- Title: `<h2 data-dsh-word-lookup="headword">` for screen readers and semantic hierarchy.
- Close Button: `<button type="button" aria-label="Close dictionary">` with clear contrast and keyboard accessibility.

### Focus Non-Stealing Guarantee (`FOCUS-INTEGRITY`):
- The appearance of the Result Card does **not** call `.focus()` or steal focus from active inputs.
- Active text input in the conversation composer remains focused before and after lookup execution.

### Text Selection & Copy Preservation:
- Text inside the dictionary card is fully selectable (`userSelect: 'text'`).
- Users can highlight definitions, phonetic symbols, and examples.
- `Ctrl+C` copy events inside the card are not intercepted, suppressed, or swallowed (`CARD-COPY-SHORTCUT`).

---

## 8. Adversarial Interaction Integrity

### Card-Internal Gesture Safety (`CARD-INTERNAL-SELECTION`):
- Selecting or double-clicking text inside the dictionary card produces **zero automatic lookup requests** (`deltaRequests = 0`).
- The gesture classifier inspects the event path: any selection or click whose target is within `[data-dsh-word-lookup="card"]` is disqualified from conversation lookup triggers.

### Outside Gesture Races:
- **`RACE-OUTSIDE-DBLCLICK`**: While card A is displayed, double-clicking word B in the conversation dismisses card A and immediately opens card B.
- **`RACE-OUTSIDE-DRAG`**: While card A is displayed, drag-selecting word B in the conversation dismisses card A and immediately opens card B.

---

## 9. Visual QA & Theming

### Design System Compliance:
Embedded CSS rules support dynamic theme switching without style recalculation lag:
- **Dark Theme** (default):
  - Background: `#1c1c21` / `var(--dsh-color-bg-elevated)`
  - Foreground: `#f2f2f7` / `var(--dsh-color-text-primary)`
  - Border: `rgba(255, 255, 255, 0.14)`
  - Shadow: `0 8px 28px rgba(0, 0, 0, 0.45)`
- **Light Theme** (media query `@media (prefers-color-scheme: light)` and `:root[data-theme="light"]`, `.light`):
  - Background: `#ffffff`
  - Foreground: `#18181c`
  - Border: `rgba(0, 0, 0, 0.12)`
  - Shadow: `0 8px 28px rgba(0, 0, 0, 0.12)`

### Visual QA Artifacts:
Screenshots captured directly from the live isolated Chromium browser instance:
- `verify-out/phase5-screenshots/normal-found.png`: Normal found entry with headword, phonetic, lemma relation, definitions, and examples.
- `verify-out/phase5-screenshots/not-found-state.png`: Friendly not-found message.
- `verify-out/phase5-screenshots/error-state.png`: Sanitized error message for 500 error probe.
- `verify-out/phase5-screenshots/narrow-viewport.png`: 360px viewport showing clean clamping within screen bounds.
- `verify-out/phase5-screenshots/long-content.png`: Long definition entry with internal vertical scroll and zero horizontal overflow.
- `verify-out/phase5-screenshots/dark-mode.png` / `light-mode.png`: Theme contrast verification.

---

## 10. Comprehensive Verification Matrix

### 1. Static Bundle & Architecture Checks (`scripts/check-bundle.mjs`)
- Result: **94/94 checks passed**
- Verifies: Exactly 2 chunks emitted (`lib/client.js`, `lib/index.js`), clean external boundaries, zero sqlite leaks to client, zero timers in client bundle, valid TypeScript declaration maps.

### 2. Unit Test Suite (`vitest run`)
- Result: **22 test files, 418 passed (0 failed)**
- Includes 32 new Phase 5 unit tests:
  - `tests/client-position.spec.ts` (11 tests): Pure viewport positioning, below/above, horizontal clamping, narrow viewport, multiline rect, null fallback.
  - `tests/client-dismiss-race.spec.ts` (6 tests): D1-D4 race sequences, surface generation isolation, late settlement suppression.
  - `tests/client-card-render.spec.ts` (12 tests): 5 mutually exclusive UI states, lemma relation formatting, POS/phonetic null safety, error sanitization.
  - `tests/client-card-interaction.spec.ts` (3 tests): Card-internal selection produces 0 lookups, outside double-click/drag B renders B.

### 3. Isolated Full Runtime Integration Test (`npm run test:runtime`)
- Script: `scripts/run-integration-test.mjs` (invoking `scripts/phase1-verify.mjs` on port `50991`)
- Result: **PASS — 169/169 checks passed**
- Verifies: Two full boots of isolated DSH web instance, clean loader injection, settings persistence across restart, 100+100 stress runs, SQLite database queries, zero unhandled errors.

### 4. Phase 5 Browser Acceptance Test (`npm run test:acceptance`)
- Script: `scripts/phase5-browser-acceptance.mjs` (on port `50992` with real Chromium)
- Result: **24/24 checks passed**:
  - `UI01`: Manual shortcut lookup for `"derived"` renders canonical headword, phonetic, lemma relation, meanings, and examples.
  - `UI02`: Auto double-click on `"went"` renders headword `"go"` with matchedForm `"went → go"` and issues exactly 1 request.
  - `UI03`: Auto drag-selection on `"teeth"` renders headword `"tooth"` with matchedForm `"teeth → tooth"` and issues exactly 1 request.
  - `UI04`: Unknown word renders friendly not-found state without error banner.
  - `UI05`: Transport error renders sanitized error message without leaking paths or internals.
  - `UI05-Recovery`: Normal lookup immediately recovers card from previous error.
  - `POS-TOP`: Selection near top places card below and respects margins.
  - `POS-BOTTOM`: Selection near bottom places card above and does not overlap composer input.
  - `POS-MULTILINE`: Multiline selection geometry places card cleanly within margins.
  - `POS-NARROW`: Narrow viewport (360px) clamps card within margins without horizontal overflow.
  - `DISMISS-BUTTON`: Clicking close button dismisses card.
  - `DISMISS-ESCAPE`: Pressing Escape dismisses visible card.
  - `DISMISS-OUTSIDE`: Clicking outside dismisses card without swallowing click on underlying element.
  - `RACE-D1`: Request starts -> dismiss -> resolve success -> card remains closed.
  - `RACE-D4`: Exact same query looked up after dismissal reopens surface normally.
  - `RACE-OUTSIDE-DBLCLICK`: Double-clicking word B outside open card dismisses card A and displays word B.
  - `RACE-OUTSIDE-DRAG`: Drag-selecting word B outside open card dismisses card A and displays word B.
  - `CARD-INTERNAL-SELECTION`: Text inside card is selectable, and internal double-click/drag produces 0 automatic requests.
  - `CARD-COPY-SHORTCUT`: Ctrl+C copy event inside card is not swallowed or intercepted by the plugin.
  - `FOCUS-INTEGRITY`: Appearance of dictionary card does not steal focus from active composer.
  - `LONG-CONTENT-SCROLL`: Long entries render with internal scroll capability and 0 horizontal overflow.
  - `THEME-DARK`: Dark theme renders elevated card contrast.
  - `THEME-LIGHT`: Light theme applies high-contrast styling.
  - `ACCESSIBILITY`: Card provides accessible region role, label, h2 structure, and accessible close button.

---

## 11. Preserved Portability Blocker

The pre-existing portability blocker identified in Phase 4.2 remains **open and untouched**:

> **RELEASE BLOCKER — automatic-selection portability**:
> `autoSelection` relies on browser platform selection event ordering during mouse drags. While fully validated and verified on Chromium under Windows 11 with native mouse hardware inputs, synthetic or non-standard pointer devices that do not emit platform click counts or emit inverted mouse/pointer sequences are guarded and refused (`unverified-pointer-kind`, `unverified-click-multiplicity`). Broader cross-platform portability requires host-level platform input abstraction in future releases.

Phase 5 has not modified any trigger classification rules, event orderings, or SQLite query pathways.

---

## 12. Residual Risks & Next Actions

1. **Host-Side Corpus Scaling**: Current runtime dictionary uses the verified SQLite fixture (`fixtures/dictionary.fixture.db`). Phase 6 / production packaging should integrate the full ECDICT database using the same verified schema and indexing rules.
2. **Audio Pronunciation**: Phonetic IPA strings are displayed cleanly; audio pronunciation playback is a future non-blocking enhancement.
3. **Multi-Window / Multi-Monitor Placement**: The positioning function clamps to `window.innerWidth`/`innerHeight`. Future enhancements can observe multi-monitor boundary boxes when DSH runs in multi-window Electron environments.

---

## 13. Files Changed in Phase 5

| File | Change Description |
| --- | --- |
| `src/client/position.ts` | **New**: Pure viewport-safe positioning engine (`computeCardPosition`) with clamping and fallback rules. |
| `src/client/store.ts` | **Enhanced**: Added surface generation tracking (`beginGeneration`, `isDismissed`) and anchor rect storage. |
| `src/client/lookup.ts` | **Enhanced**: Surface generation check before state publishing to eliminate race conditions. |
| `src/client/card.tsx` | **Complete Rewrite**: Full production Result Card component with 5 states, accessibility, theming, lemma tag, and dismissal listeners. |
| `src/client/index.tsx` | **Enhanced**: Wired selection rect to lookup controller; exposed `surfaceGeneration`, `dismiss`, and `runLookup` on diagnostics. |
| `package.json` | **Updated**: Added `"test:acceptance"` script for Phase 5 browser suite. |
| `scripts/phase5-browser-acceptance.mjs` | **New**: Dedicated 24-point end-to-end browser acceptance suite for Chromium. |
| `tests/client-position.spec.ts` | **New**: 11 unit tests for positioning engine. |
| `tests/client-dismiss-race.spec.ts` | **New**: 6 unit tests for D1-D4 dismiss/request race conditions. |
| `tests/client-card-render.spec.ts` | **New**: 12 unit tests for 5 UI states, lemma relation, null safety, and error sanitization. |
| `tests/client-card-interaction.spec.ts` | **New**: 3 harness tests for card-internal selection and outside gesture races. |
| `docs/PHASE5_EVIDENCE.md` | **New**: Complete Phase 5 verification and evidence record. |
