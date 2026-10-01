window.__ModuleLoader__.load({
	id: "dsh-word-lookup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/shared/protocol.ts
/**
* Wire contract shared by the two halves of `dsh-word-lookup`.
*
* This module is a leaf: it imports nothing, so both bundles may include it
* without either half reaching the other's runtime. Everything here is either a
* compile-time type or a constant that is identical in both processes.
*
* @module dsh-word-lookup/shared
*/
/**
* Document-relative URL of the lookup route, used by the browser half.
*
* `dsh-host-frontend-static` serves the application with `<base href="./">`, so a
* leading slash would address the server root rather than the application's mount
* directory; first-party callers strip the same leading slash before calling
* `fetch`.
*
* The browser bundle carries **this** literal and never the absolute path. The
* host's `/api`-prefixed form lives in `src/host/route.ts`, and a unit test
* asserts the two are the same route; stating the browser's URL as a derived
* value would have put the absolute string into the one bundle that must not
* contain it.
*/
const LOOKUP_DOCUMENT_PATH = "api/dsh-word-lookup";
/** Media type the route accepts. Any other request content type is a 400. */
const LOOKUP_MEDIA_TYPE = "application/json";
//#endregion
//#region src/shared/text.ts
/**
* Text normalization shared by both halves of `dsh-word-lookup`.
*
* A browser selection arrives with whatever punctuation the reader dragged over:
* a trailing period from the end of a sentence, a leading quotation mark, or a
* line break from a wrapped paragraph. Normalization is deliberately narrow — it
* folds compatibility characters, strips edge punctuation, folds case, and
* collapses internal whitespace, and it does not attempt stemming. Inflection
* handling belongs to the dictionary (Phase 3), not to the transport.
*
* The browser half calls the same functions only to decide whether a selection
* is worth sending; the host calls them again as the authoritative normalization
* of whatever arrives. One implementation, so the two cannot disagree about what
* "an eligible selection" is.
*
* @module dsh-word-lookup/shared/text
*/
/**
* Punctuation removed from both ends of a raw selection.
*
* Written as two alternatives rather than a single class with a `^`/`$` anchor
* pair so that one pass removes a run of characters from each end. ASCII
* punctuation is listed literally; the Unicode block covers the curly quotes,
* dashes and ellipsis a document export or an LLM transcript actually produces.
*/
const EDGE_PUNCTUATION = /^(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)|(?:[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d\u2013\u2014\u2026]+)$/g;
/** Matches any run of Unicode whitespace. */
const WHITESPACE_RUN = /\s+/gu;
/**
* Count the Unicode code points in a string.
*
* `String.prototype.length` counts UTF-16 code units, so a selection of astral
* characters (emoji, rare CJK extensions) would be measured at twice its length
* and rejected earlier than {@link MAX_QUERY_CODE_POINTS} promises.
*
* @param value - the string to measure.
* @returns the number of code points.
*/
function countCodePoints(value) {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}
/**
* Normalize one raw selection into a headword candidate.
*
* The steps and their order are the product specification's:
*
* ```text
* raw selection
*   -> NFKC                     fold compatibility characters
*   -> collapse whitespace      a line break becomes one space
*   -> strip edge punctuation   a sentence-final period is not part of the word
*   -> lowercase                the lookup is case-normalized
* ```
*
* `NFKC` runs first because it *creates* characters the later steps must then
* see: a full-width `．` folds to `.` and only then reads as edge punctuation, a
* no-break space folds to a space and only then collapses, and the ligature `ﬁ`
* folds to `fi` so a selection from a typeset document reaches the dictionary as
* the word it looks like. Folding after the strip would leave each of those
* unfixed.
*
* What NFKC deliberately does **not** do is fold `’` to `'`. Both survive, and
* because only *edge* punctuation is removed, an apostrophe or hyphen inside a
* word is part of the word: `don't` and `time-dependent` are looked up as
* themselves.
*
* @param raw - the text the reader selected.
* @returns the normalized candidate; the empty string when nothing survives.
*/
function normalizeHeadword(raw) {
	return raw.normalize("NFKC").replace(WHITESPACE_RUN, " ").trim().replace(EDGE_PUNCTUATION, "").trim().replace(WHITESPACE_RUN, " ").toLowerCase();
}
/**
* Split a Chinese translation cell into individual glosses.
*
* A dictionary cell carries several glosses separated by a full-width
* semicolon — `导出；派生；源自` — which is the convention the source
* dictionaries use and the shape the product specification renders as
* "中文义项 1 / 2 / …". Splitting is presentational and lives here rather than in
* the storage layer so both halves can render the same list.
*
* @param translation - the raw cell, or `null`.
* @returns the glosses, in order; empty when the cell is `null` or blank.
*/
function splitGlosses(translation) {
	if (translation === null) return [];
	return translation.split(/[；;]/).map((gloss) => gloss.trim()).filter((gloss) => gloss.length > 0);
}
/**
* Whether a raw selection would survive normalization as a query.
*
* Used by the browser half to decide that `resolve()` should return
* `{ status: 'pass' }` rather than send a request the host would refuse with
* `empty-query` or `query-too-long`. Returning `pass` consumes nothing, so a
* keypress with no usable selection keeps its normal meaning (T07).
*
* @param raw - the text the reader selected.
* @returns whether a lookup should be attempted.
*/
function isEligibleSelectionText(raw) {
	if (countCodePoints(raw.trim()) > 96) return false;
	return normalizeHeadword(raw).length > 0;
}
//#endregion
//#region src/client/card.tsx
/**
* The `shell.overlay` occupant.
*
* `shell.overlay` is a **list** slot at `root` scope whose layer is
* click-through: the frame itself ignores pointer events and each entry opts
* back in. The card therefore sets `pointer-events: auto` on its own root and
* nowhere else, and it never covers the composer: the panel is anchored to the
* lower right, clear of the input column.
*
* Two properties this component must keep:
*
* 1. **Idle renders nothing.** `shell.overlay` is mounted for the whole
*    application lifetime, so an occupant that rendered a container node while
*    idle would put a permanent element into every page. Returning `null` keeps
*    the layer at zero children until a lookup actually produces something.
* 2. **The style sheet is inline.** An external client plugin is served as one
*    classic script; there is no second asset a stylesheet could travel in, and
*    the shipped class names are hashed and must never be relied on.
*
* @module dsh-word-lookup/client/card
*/
/** Panel geometry and typography, in the overlay layer's own coordinates. */
const PANEL_STYLE = {
	position: "fixed",
	right: "16px",
	bottom: "96px",
	zIndex: 2147483e3,
	pointerEvents: "auto",
	maxWidth: "360px",
	padding: "10px 12px",
	border: "1px solid rgba(128,128,128,0.35)",
	borderRadius: "8px",
	background: "rgba(24,24,28,0.94)",
	color: "#e8e8ee",
	font: "12px/1.55 system-ui, -apple-system, \"Segoe UI\", sans-serif",
	boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
	whiteSpace: "normal"
};
/** Header row: query on the left, dismiss on the right. */
const HEADER_STYLE = {
	display: "flex",
	alignItems: "baseline",
	gap: "8px",
	marginBottom: "6px"
};
/** The close affordance. */
const CLOSE_STYLE = {
	marginLeft: "auto",
	border: "none",
	background: "transparent",
	color: "inherit",
	cursor: "pointer",
	font: "inherit",
	opacity: .7,
	padding: "0 2px"
};
/**
* Render the current lookup state.
*
* @param props - overlay seat props plus the injected store.
* @returns the card, or `null` while idle.
*/
function WordLookupCard(props) {
	const state = (0, react.useSyncExternalStore)(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
	if (state.status === "idle") return null;
	const close = () => {
		props.store.clear();
	};
	const statusText = state.status === "loading" ? "looking up" : state.status === "failed" ? "transport failed" : "";
	const header = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: HEADER_STYLE,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
				"data-dsh-word-lookup": "query",
				style: { fontWeight: 600 },
				children: state.query
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				"data-dsh-word-lookup": "status",
				style: { opacity: .7 },
				children: statusText
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				"data-dsh-word-lookup": "close",
				style: CLOSE_STYLE,
				onClick: close,
				"aria-label": "Close",
				children: "×"
			})
		]
	});
	let body = null;
	if (state.status === "failed") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-dsh-word-lookup": "error",
		children: state.failure.kind === "aborted" ? "superseded" : state.failure.message
	});
	else if (state.status === "ready") {
		const result = state.result;
		if (result.kind === "refused") body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			"data-dsh-word-lookup": "error",
			children: [
				result.code,
				" (",
				String(result.httpStatus),
				")"
			]
		});
		else if (result.kind === "not-found") body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			"data-dsh-word-lookup": "not-found",
			children: [
				"no entry for \"",
				result.body.query,
				"\""
			]
		});
		else {
			const found = result.body;
			body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-dsh-word-lookup": "entry",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-dsh-word-lookup": "headword",
						children: [found.headword, found.phonetic === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .7 },
							children: [" ", found.phonetic]
						})]
					}),
					found.matchedForm === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-dsh-word-lookup": "lemma",
						style: { opacity: .7 },
						children: [
							found.matchedForm,
							" → ",
							found.headword
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						style: {
							margin: "4px 0 0",
							paddingLeft: "18px"
						},
						children: found.meanings.map((meaning, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
							meaning.partOfSpeech === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("em", {
								style: { opacity: .75 },
								children: [meaning.partOfSpeech, " "]
							}),
							splitGlosses(meaning.translation).map((gloss, glossIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								"data-dsh-word-lookup": "gloss",
								children: [glossIndex === 0 ? "" : "；", gloss]
							}, String(glossIndex))),
							meaning.translation !== null && meaning.definition !== null ? " " : null,
							meaning.definition === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .85 },
								children: meaning.definition
							})
						] }, String(index)))
					}),
					found.forms.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-dsh-word-lookup": "forms",
						style: {
							marginTop: "4px",
							opacity: .7
						},
						children: found.forms.map((form) => form.form).join(" · ")
					}),
					found.examples.slice(0, 2).map((example, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-dsh-word-lookup": "example",
						style: {
							marginTop: "4px",
							opacity: .85
						},
						children: [example.en, example.zh === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}), example.zh] })]
					}, String(index)))
				]
			});
		}
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		"data-dsh-word-lookup": "card",
		"data-dsh-word-lookup-state": state.status,
		style: PANEL_STYLE,
		children: [header, body]
	});
}
/**
* The state before any gesture.
*
* Frozen because it is shared as the initial value and must never be mutated in
* place; every reducer returns a new object instead.
*/
const IDLE_GESTURE = Object.freeze({
	kind: "none",
	completedAt: null,
	pointer: null,
	phase: "idle",
	originX: 0,
	originY: 0,
	moved: 0
});
/**
* Project the full state onto the public snapshot.
*
* @param state - the classifier state.
* @returns the serializable gesture view.
*/
function gestureSnapshot(state) {
	return {
		kind: state.kind,
		completedAt: state.completedAt,
		pointer: state.pointer
	};
}
/**
* Whether a pointer travelled far enough to be a drag.
*
* @param distance - peak travel in CSS pixels.
* @returns whether the distance clears the drag threshold.
*/
function isDragDistance(distance) {
	return distance >= 5;
}
/**
* Distance between two points.
*
* @param ax - first x.
* @param ay - first y.
* @param bx - second x.
* @param by - second y.
* @returns the Euclidean distance.
*/
function distanceBetween(ax, ay, bx, by) {
	return Math.hypot(bx - ax, by - ay);
}
/**
* Open a gesture on a primary pointer press.
*
* A non-primary button is ignored rather than tracked: a right-click drag
* carries no text selection, and letting it open a gesture would let it close
* one too.
*
* The previous classification is deliberately preserved: the snapshot always
* describes the last *completed* gesture, so opening a new one does not blank
* what the reader last did.
*
* @param state - the current state.
* @param point - the press position.
* @param button - the DOM `button` value; `0` is the primary button.
* @returns the next state.
*/
function beginPointer(state, point, button = 0) {
	if (button !== 0) return state;
	return {
		...state,
		phase: "tracking",
		originX: point.x,
		originY: point.y,
		moved: 0
	};
}
/**
* Record pointer travel while a gesture is open.
*
* Returns the same object when nothing changed, so a caller may assign the
* result unconditionally without publishing spurious updates.
*
* @param state - the current state.
* @param point - the current position.
* @returns the next state.
*/
function movePointer(state, point) {
	if (state.phase !== "tracking") return state;
	const moved = Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y));
	if (moved === state.moved) return state;
	return {
		...state,
		moved
	};
}
/**
* Close a gesture on pointer release and classify it.
*
* A release with enough travel **and** an eligible selection is a `drag`. Every
* other release is `other`: a click too short to be a drag, or a long movement
* that selected nothing usable. Neither is ever reported as `drag`, which is
* what keeps a simple click out of the automatic path.
*
* A sealed state is returned untouched — that is the double-click precedence
* rule. Once `dblclick` has classified the gesture, the release that produced it
* cannot reinterpret it.
*
* @param state - the current state.
* @param point - the release position.
* @param hasEligibleSelection - whether a usable selection exists at release.
* @returns the next state.
*/
function endPointer(state, point, hasEligibleSelection) {
	if (state.phase !== "tracking") return state;
	const distance = Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y));
	return {
		kind: isDragDistance(distance) && hasEligibleSelection ? "drag" : "other",
		completedAt: point.at,
		pointer: {
			startX: state.originX,
			startY: state.originY,
			endX: point.x,
			endY: point.y,
			distance
		},
		phase: "idle",
		originX: 0,
		originY: 0,
		moved: 0
	};
}
/**
* Classify a platform-recognised double click.
*
* `dblclick` is the browser's own, high-confidence word-selection gesture, so it
* outranks anything inferred from pointer movement. The state is **sealed**
* afterwards: the `selectionchange` the browser dispatches next — and any stray
* pointer release — must not turn this back into a drag.
*
* Without an eligible selection at the moment of the double click there is
* nothing to look up, so the gesture is recorded as `other` rather than claimed
* as a usable double click.
*
* @param state - the current state.
* @param point - the double click position.
* @param hasEligibleSelection - whether a usable selection exists right now.
* @returns the next state.
*/
function registerDoubleClick(state, point, hasEligibleSelection) {
	const inFlight = state.phase === "tracking" ? Math.max(state.moved, distanceBetween(state.originX, state.originY, point.x, point.y)) : null;
	const pointer = inFlight === null ? state.pointer : {
		startX: state.originX,
		startY: state.originY,
		endX: point.x,
		endY: point.y,
		distance: inFlight
	};
	return {
		kind: hasEligibleSelection ? "double-click" : "other",
		completedAt: point.at,
		pointer,
		phase: "sealed",
		originX: 0,
		originY: 0,
		moved: 0
	};
}
/**
* Abandon an in-flight gesture.
*
* Used for `pointercancel`, window blur and disposal. A cancelled gesture leaves
* no half-built state behind — no origin, no travel, no open phase — while the
* last completed classification stays readable, because "what did the reader
* last do" is still true after an unrelated cancellation.
*
* @param state - the current state.
* @returns the next state.
*/
function cancelGesture(state) {
	if (state.phase === "idle") return state;
	return {
		...state,
		phase: "idle",
		originX: 0,
		originY: 0,
		moved: 0
	};
}
/** The observation before any event, frozen because it is the shared initial value. */
const IDLE_OBSERVATION = Object.freeze({
	state: IDLE_GESTURE,
	counters: Object.freeze({
		pointerdowns: 0,
		pointerups: 0,
		drags: 0,
		doubleClicks: 0,
		doubleClickGestures: 0,
		simpleGestures: 0,
		cancels: 0
	})
});
/**
* Count a classification that has just completed.
*
* @param counters - the counters to advance.
* @param kind - the classification that completed.
* @returns the next counters.
*/
function countClassification(counters, kind) {
	if (kind === "drag") return {
		...counters,
		drags: counters.drags + 1
	};
	if (kind === "double-click") return {
		...counters,
		doubleClickGestures: counters.doubleClickGestures + 1
	};
	return {
		...counters,
		simpleGestures: counters.simpleGestures + 1
	};
}
/**
* Fold a primary pointer press into the observation.
*
* @param observation - the current observation.
* @param point - the press position.
* @param button - the DOM `button` value.
* @returns the next observation.
*/
function observePointerDown(observation, point, button = 0) {
	const state = beginPointer(observation.state, point, button);
	if (state === observation.state) return observation;
	return {
		state,
		counters: {
			...observation.counters,
			pointerdowns: observation.counters.pointerdowns + 1
		}
	};
}
/**
* Fold pointer travel into the observation.
*
* @param observation - the current observation.
* @param point - the current position.
* @returns the next observation.
*/
function observePointerMove(observation, point) {
	const state = movePointer(observation.state, point);
	return state === observation.state ? observation : {
		state,
		counters: observation.counters
	};
}
/**
* Fold a pointer release into the observation, counting the classification.
*
* A release that classified nothing — no open gesture, or a state sealed by a
* preceding double click — still counts as an observed `pointerup`, so the
* counter cannot be mistaken for "the listener never fired".
*
* @param observation - the current observation.
* @param point - the release position.
* @param hasEligibleSelection - whether a usable selection exists at release.
* @returns the next observation.
*/
function observePointerUp(observation, point, hasEligibleSelection) {
	const counters = {
		...observation.counters,
		pointerups: observation.counters.pointerups + 1
	};
	const state = endPointer(observation.state, point, hasEligibleSelection);
	if (state === observation.state) return {
		state,
		counters
	};
	return {
		state,
		counters: countClassification(counters, state.kind)
	};
}
/**
* Fold a platform double click into the observation.
*
* @param observation - the current observation.
* @param point - the double click position.
* @param hasEligibleSelection - whether a usable selection exists right now.
* @returns the next observation.
*/
function observeDoubleClick(observation, point, hasEligibleSelection) {
	const state = registerDoubleClick(observation.state, point, hasEligibleSelection);
	return {
		state,
		counters: countClassification({
			...observation.counters,
			doubleClicks: observation.counters.doubleClicks + 1
		}, state.kind)
	};
}
/**
* Fold a cancellation into the observation.
*
* @param observation - the current observation.
* @returns the next observation.
*/
function observeCancel(observation) {
	const state = cancelGesture(observation.state);
	if (state === observation.state) return observation;
	return {
		state,
		counters: {
			...observation.counters,
			cancels: observation.counters.cancels + 1
		}
	};
}
//#endregion
//#region src/client/lifecycle.ts
/**
* A minimal disposer list.
*
* The client half makes four contributions — one slot occupant, one shortcut
* command, one settings subscription, one document listener — and every one of
* them returns its own disposer. Collecting them here gives the plugin's single
* `ctx.effect` one thing to unwind, so "how many registrations does this plugin
* make" and "how many effects does the fiber hold" stop being the same question.
*
* Disposal is idempotent, and a failure inside one child does not skip its
* siblings: a half-disposed runtime is the one outcome a reload must not produce,
* and a leftover shortcut or slot entry is exactly what a duplicate-registration
* failure on the next load would report.
*
* @module dsh-word-lookup/client/lifecycle
*/
/** Ordered, idempotent, failure-isolating disposer collection. */
var Disposer = class {
	#children = [];
	#disposed = false;
	/**
	* Adopt one disposer.
	*
	* @param dispose - the child's disposer. If the collection is already
	* disposed, the child is released immediately rather than retained.
	*/
	add(dispose) {
		if (this.#disposed) {
			dispose();
			return;
		}
		this.#children.push(dispose);
	}
	/** Release every adopted disposer, in reverse order. Safe to call twice. */
	disposeAll() {
		if (this.#disposed) return;
		this.#disposed = true;
		const children = this.#children.splice(0).reverse();
		for (const dispose of children) try {
			dispose();
		} catch (error) {
			console.error("dsh-word-lookup: a registration disposer failed", error);
		}
	}
};
//#endregion
//#region src/client/selection.ts
/**
* Browser selection reader.
*
* This module answers one question: *is there a usable selection right now, and
* where is it?* It returns the text, the live `Range`, and the range's geometry
* as read at capture time.
*
* Two boundaries are worth stating because they are easy to cross by accident:
*
* - **Nothing here issues a request.** Whether a gesture should *cause* a lookup
*   is a separate question, answered in `./gesture.js`, and Phase 2 answers it
*   without acting on it.
* - **Nothing here mutates the document.** Only `getSelection()` and ancestor
*   walks are used; no wrapper element is inserted and no `Range` is
*   constructed.
*
* The geometry is deliberately re-read from the live range on every capture
* rather than remembered: Phase 0 §7.4 measured that a scroll moves a
* selection's rect one-for-one with `scrollTop`, and that streaming re-renders
* the transcript underneath a selection. A remembered rect plus a scroll delta
* would therefore be wrong in exactly the case the product cares about.
*
* The predicate is split in two so that the decision can be unit-tested as a
* value relation. {@link isEligibleEndpoint} consumes plain facts, not DOM nodes,
* and {@link readRangeRect} accepts any {@link RangeLike}, which is why neither
* the eligibility rule nor the geometry rule needs a DOM implementation to be
* covered.
*
* @module dsh-word-lookup/client/selection
*/
/**
* Conversation flow-item anchor.
*
* Taken from the Phase 0 DOM census: every flow item carries
* `[data-chat-flow-kind]` (`user`, `turn-process`, `assistant-step`, `tool-call`,
* `context`, `model-retry`) and `[data-chat-node-key]`.
*
* `[data-dsh-part="message-body"]` is **not** used: on a freshly loaded client it
* matched 0 elements while `[data-chat-node-key]` matched 188, so a predicate
* gated on it would silently stop qualifying.
*/
const CONVERSATION_FLOW_SELECTOR = "[data-chat-flow-kind]";
/**
* Interactive text surfaces a selection is never eligible in.
*
* The DSH composer is a Lexical `contenteditable="true"` region carrying
* `role="textbox"`, so the selector has to cover the attribute both as an empty
* string and as `"true"`, as well as the plain form controls. Matching is done
* over the whole ancestor chain, because a selection endpoint is usually a text
* node several levels inside the surface.
*/
const INTERACTIVE_SURFACE_SELECTOR = "input, textarea, select, [contenteditable=\"\"], [contenteditable=\"true\"], [role=\"textbox\"]";
/**
* Read the geometry of a live range.
*
* Returns `null` for a collapsed range and for an empty rect, which is how a
* lost selection and an insertion point both present. The position is read from
* the range itself, never reconstructed from an earlier measurement.
*
* @param range - the live range to measure.
* @returns the bounding rectangle, or `null` when the range has no area.
*/
function readRangeRect(range) {
	if (range.collapsed) return null;
	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;
	return {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height
	};
}
/**
* Decide whether one endpoint may participate in a lookup.
*
* Both conditions are required: the endpoint has to be inside a conversation
* flow item (otherwise the selection is in the sidebar, a dialog, or the
* composer) **and** outside every interactive text surface.
*
* @param facts - the ancestor facts for one endpoint.
* @returns whether the endpoint is eligible.
*/
function isEligibleEndpoint(facts) {
	return facts.insideConversationFlow && !facts.insideInteractiveSurface;
}
/**
* Resolve the element a selection endpoint should be tested against.
*
* @param node - an anchor or focus node, which may be `null` or a text node.
* @returns the element to walk from, or `null` when the node has none.
*/
function elementFor(node) {
	if (node === null) return null;
	return node.nodeType === 1 ? node : node.parentElement;
}
/**
* Collect the ancestor facts of one endpoint.
*
* @param node - an anchor or focus node from the live selection.
* @returns the facts {@link isEligibleEndpoint} consumes.
*/
function describeEndpoint(node) {
	const element = elementFor(node);
	if (element === null) return {
		insideConversationFlow: false,
		insideInteractiveSurface: false
	};
	return {
		insideConversationFlow: element.closest(CONVERSATION_FLOW_SELECTOR) !== null,
		insideInteractiveSurface: element.closest(INTERACTIVE_SURFACE_SELECTOR) !== null
	};
}
/**
* Read the document's current selection and decide whether it is usable.
*
* The geometry is captured in the same pass as the text, from the same live
* range, so a caller can never pair one gesture's text with another's position.
*
* @param doc - the product document to read. Passed in rather than reached for,
* so the reader stays a pure function of its input.
* @returns the eligible selection, or `null` when there is nothing to look up.
*/
function readEligibleSelection(doc) {
	const selection = doc.getSelection();
	if (selection === null) return null;
	if (selection.rangeCount === 0 || selection.isCollapsed) return null;
	const text = selection.toString();
	if (!isEligibleSelectionText(text)) return null;
	if (!isEligibleEndpoint(describeEndpoint(selection.anchorNode))) return null;
	if (!isEligibleEndpoint(describeEndpoint(selection.focusNode))) return null;
	const range = selection.getRangeAt(0);
	return {
		text,
		range,
		rect: readRangeRect(range)
	};
}
//#endregion
//#region src/client/store.ts
/**
* Replaceable snapshot holder for the overlay occupant.
*
* Nothing here touches the DOM, React, or the network, so the ordering rules the
* card depends on can be tested directly.
*/
var LookupCardStore = class {
	#state = { status: "idle" };
	#listeners = /* @__PURE__ */ new Set();
	/**
	* @returns the current snapshot. The reference is stable until {@link set}.
	*/
	getSnapshot = () => this.#state;
	/**
	* Observe snapshot replacements.
	*
	* @param listener - invoked after each change.
	* @returns the disposer removing this listener.
	*/
	subscribe = (listener) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	/**
	* Publish a new snapshot.
	*
	* @param next - the state to publish.
	*/
	set(next) {
		this.#state = next;
		for (const listener of [...this.#listeners]) listener();
	}
	/** Return the card to its idle, zero-render state. */
	clear() {
		this.set({ status: "idle" });
	}
};
//#endregion
//#region src/client/transport.ts
/**
* Browser transport for the exact Fetch route.
*
* The URL is **document-relative** (`api/dsh-word-lookup`, no leading slash):
* `dsh-host-frontend-static` serves the application with `<base href="./">`, so a
* leading slash would leave the application's mount directory. First-party code
* strips the same slash before calling `fetch`.
*
* No `credentials` option is set: the same-origin default already sends the
* signed, authority-bound `HttpOnly` cookie the connection fence requires, and
* there is no `Authorization` header path in this DSH generation.
*
* Every outcome is returned as a value. A rejected promise is reserved for the
* two cases the caller cannot act on — an aborted request and a transport
* failure — so a controlled host refusal never has to be distinguished from a
* broken route by catching an exception.
*
* @module dsh-word-lookup/client/transport
*/
/**
* Narrow an unknown parsed body to a controlled refusal.
*
* @param value - the parsed JSON body.
* @returns the error code when the body is a well-formed refusal.
*/
function refusalCode(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.ok !== false) return void 0;
	return typeof record.error === "string" ? record.error : void 0;
}
/**
* POST one query and classify the response.
*
* @param query - the raw selected text; the host normalizes it.
* @param signal - cancels a superseded request. A newer lookup must abort the
* previous one rather than race it, which is what T15 asks for.
* @returns the classified result.
* @throws never — transport failures resolve to a value; only a programming
* error inside the classifier would propagate.
*/
async function requestLookup(query, signal) {
	const init = {
		method: "POST",
		headers: { "content-type": LOOKUP_MEDIA_TYPE },
		body: JSON.stringify({ query })
	};
	if (signal !== void 0) init.signal = signal;
	let response;
	try {
		response = await fetch(LOOKUP_DOCUMENT_PATH, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return { kind: "aborted" };
		return {
			kind: "network",
			message: error instanceof Error ? error.message : String(error)
		};
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		parsed = void 0;
	}
	if (response.ok) {
		if (typeof parsed === "object" && parsed !== null) {
			const { found } = parsed;
			if (found === true) return {
				kind: "found",
				body: parsed
			};
			if (found === false) return {
				kind: "not-found",
				body: parsed
			};
		}
	}
	return {
		kind: "refused",
		httpStatus: response.status,
		code: refusalCode(parsed) ?? "unexpected-response",
		message: `dsh-word-lookup host answered ${response.status}`
	};
}
//#endregion
//#region src/client/index.tsx
/**
* Client services this half requires before activation.
*
* `slots` is mandatory: a slot contribution made before the registry exists
* throws instead of waiting. `shortcuts` and `configForms` are equally
* load-bearing — the command registration and the settings mirror both fail
* loudly without them.
*
* `locale` is **not** declared: Phase 1 ships no localized copy, and waiting on a
* service the plugin does not read would make activation depend on a composition
* detail for no benefit. The package-level `dsh.client.inject` list keeps
* `@deepseek-ai/dsh-client-locale`, which is a module-load ordering statement
* rather than a cordis dependency.
*/
const inject = [
	"slots",
	"shortcuts",
	"configForms"
];
/** Loader entry id; equals the settings namespace and the host route's owner. */
const namespace = "dsh-word-lookup";
/** The manual command's identity in the DSH shortcut catalog. */
const LOOKUP_COMMAND_ID = "wordLookup.lookupSelection";
/** Registration id of the card inside the frame-wide overlay list. */
const CARD_ENTRY_ID = "dsh-word-lookup:card";
/**
* Ascending render order inside `shell.overlay`.
*
* Chosen to sit above the shipped toasts and notices — the card answers a
* gesture the reader just made, so it must not be covered by an unrelated
* notification — while staying well below a modal's z-index.
*/
const CARD_ORDER = 900;
/**
* Regions the manual command is available in: the page and editable surfaces.
*
* Typed by the literal array rather than by importing `ShortcutRegion`: that
* name is declared in `dsh-client-shortcuts`' protocol layer but is not
* re-exported from its public `./client` entry, and reaching for the private
* declaration file is exactly the import this project forbids.
*/
const COMMAND_REGIONS = ["page", "editable"];
/** The command owns no modal; it must not fire from inside a dialog. */
const COMMAND_MODALS = [];
/** The global slot the diagnostics object occupies. */
const DIAGNOSTICS_KEY = "__DSH_WORD_LOOKUP__";
/**
* Create the browser runtime and return its single disposer.
*
* Registration is all-or-nothing: a failure anywhere releases everything
* registered before it and rethrows, so a partially installed runtime — the
* state no test can distinguish from a working boot — cannot be produced.
*
* @param ctx - the client root context.
* @returns the disposer releasing every contribution.
*/
function createRuntime(ctx) {
	const store = new LookupCardStore();
	const disposer = new Disposer();
	try {
		let gates = {
			autoDoubleClick: false,
			autoSelection: false
		};
		/** Selection facts only; the gesture is merged in when the snapshot is read. */
		let selectionFacts = {
			present: false,
			eligible: false,
			text: "",
			at: 0,
			rect: null
		};
		let gesture = IDLE_OBSERVATION;
		let lookupCount = 0;
		let lastOutcome = null;
		let inflight = null;
		const form = ctx.configForms.get(namespace);
		/**
		* Republish the gate values from the live form snapshot.
		*
		* The host emits `settings/document-updated` when a write is accepted, the
		* event reaches the browser over the remote multiplexer, and the shared
		* mirror folds it in; the subscription below is therefore the whole of the
		* client's live-propagation work.
		*/
		const readGates = () => {
			const value = form.getSnapshot().value;
			gates = {
				autoDoubleClick: value?.autoDoubleClick === true,
				autoSelection: value?.autoSelection === true
			};
		};
		readGates();
		disposer.add(form.subscribe(readGates));
		/**
		* Issue one lookup for a selection the reader already qualified.
		*
		* A newer request aborts the previous one, so a slow answer for A cannot
		* overwrite the answer for B.
		*
		* @param query - raw selected text; the host normalizes it.
		* @param origin - which path asked, for diagnostics.
		*/
		const runLookup = async (query, origin) => {
			inflight?.abort();
			const controller = new AbortController();
			inflight = controller;
			lookupCount += 1;
			store.set({
				status: "loading",
				query
			});
			const outcome = await requestLookup(query, controller.signal);
			if (inflight !== controller) return;
			inflight = null;
			lastOutcome = outcome.kind;
			if (outcome.kind === "aborted" || outcome.kind === "network") {
				store.set({
					status: "failed",
					query,
					failure: outcome
				});
				return;
			}
			store.set({
				status: "ready",
				query,
				result: outcome
			});
		};
		let overlayDeclarationSeen = false;
		let overlayRegistrationCount = 0;
		disposer.add(ctx.slots.inject("shell.overlay", () => {
			overlayDeclarationSeen = true;
			const unregister = ctx.slots.register({
				name: "shell.overlay",
				id: CARD_ENTRY_ID,
				order: 900,
				label: "Dictionary card",
				inject: () => ({ store })
			}, WordLookupCard);
			overlayRegistrationCount += 1;
			return () => {
				overlayRegistrationCount -= 1;
				unregister();
			};
		}));
		let resolveCalls = 0;
		let passReturns = 0;
		let handledReturns = 0;
		let runCalls = 0;
		let lastShortcutOutcome = null;
		let lastShortcutContext = null;
		disposer.add(ctx.shortcuts.register({
			id: LOOKUP_COMMAND_ID,
			label: () => "Look up selection",
			aliases: [
				"word",
				"lookup",
				"dictionary"
			],
			defaults: {
				"web:windows": {
					code: "KeyL",
					modifiers: ["primary", "shift"]
				},
				"web:macos": {
					code: "KeyL",
					modifiers: ["primary", "shift"]
				},
				"desktop:windows": {
					code: "KeyL",
					modifiers: ["primary", "shift"]
				},
				"desktop:macos": {
					code: "KeyL",
					modifiers: ["primary", "shift"]
				},
				"desktop:linux": {
					code: "KeyL",
					modifiers: ["primary", "shift"]
				}
			},
			regions: COMMAND_REGIONS,
			modals: COMMAND_MODALS,
			resolve: (context) => {
				resolveCalls += 1;
				lastShortcutContext = {
					region: context.region,
					modal: context.modal,
					target: context.target === null ? null : context.target.tagName.toLowerCase()
				};
				const selection = readEligibleSelection(document);
				if (selection === null) {
					passReturns += 1;
					lastShortcutOutcome = "pass";
					return { status: "pass" };
				}
				handledReturns += 1;
				lastShortcutOutcome = "handled";
				return {
					status: "handled",
					run: () => {
						runCalls += 1;
						runLookup(selection.text, "shortcut");
					}
				};
			}
		}));
		const onSelectionChange = () => {
			const selection = readEligibleSelection(document);
			selectionFacts = {
				present: document.getSelection()?.isCollapsed === false,
				eligible: selection !== null,
				text: selection === null ? "" : selection.text.slice(0, 96),
				at: Date.now(),
				rect: selection === null ? null : selection.rect
			};
		};
		document.addEventListener("selectionchange", onSelectionChange);
		disposer.add(() => {
			document.removeEventListener("selectionchange", onSelectionChange);
		});
		const classify = () => readEligibleSelection(document) !== null;
		const onPointerDown = (event) => {
			gesture = observePointerDown(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, event.button);
		};
		const onPointerMove = (event) => {
			gesture = observePointerMove(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			});
		};
		const onPointerUp = (event) => {
			gesture = observePointerUp(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, classify());
		};
		const onDoubleClick = (event) => {
			gesture = observeDoubleClick(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, classify());
		};
		const onCancelGesture = () => {
			gesture = observeCancel(gesture);
		};
		const GESTURE_OPTIONS = { capture: true };
		document.addEventListener("pointerdown", onPointerDown, GESTURE_OPTIONS);
		document.addEventListener("pointermove", onPointerMove, GESTURE_OPTIONS);
		document.addEventListener("pointerup", onPointerUp, GESTURE_OPTIONS);
		document.addEventListener("pointercancel", onCancelGesture, GESTURE_OPTIONS);
		document.addEventListener("dblclick", onDoubleClick, GESTURE_OPTIONS);
		window.addEventListener("blur", onCancelGesture);
		disposer.add(() => {
			document.removeEventListener("pointerdown", onPointerDown, GESTURE_OPTIONS);
			document.removeEventListener("pointermove", onPointerMove, GESTURE_OPTIONS);
			document.removeEventListener("pointerup", onPointerUp, GESTURE_OPTIONS);
			document.removeEventListener("pointercancel", onCancelGesture, GESTURE_OPTIONS);
			document.removeEventListener("dblclick", onDoubleClick, GESTURE_OPTIONS);
			window.removeEventListener("blur", onCancelGesture);
			gesture = observeCancel(gesture);
		});
		const diagnostics = {
			plugin: namespace,
			namespace,
			snapshot: () => {
				const snapshot = form.getSnapshot();
				return {
					status: snapshot.status,
					mode: snapshot.mode,
					writable: snapshot.writable,
					revision: snapshot.revision,
					value: snapshot.value
				};
			},
			gates: () => gates,
			selection: () => ({
				...selectionFacts,
				gesture: gestureSnapshot(gesture.state)
			}),
			gestures: () => ({
				counters: gesture.counters,
				last: gestureSnapshot(gesture.state)
			}),
			overlay: () => ({
				entryId: CARD_ENTRY_ID,
				order: 900,
				declarationSeen: overlayDeclarationSeen,
				registrationCount: overlayRegistrationCount
			}),
			catalog: () => {
				const catalog = ctx.shortcuts.catalog.getSnapshot();
				const own = catalog.find((row) => row.id === LOOKUP_COMMAND_ID);
				return {
					size: catalog.length,
					row: own === void 0 ? null : {
						id: own.id,
						label: own.label,
						keys: own.keys,
						binding: own.binding,
						conflicts: own.conflicts,
						issue: own.issue
					}
				};
			},
			lookups: () => lookupCount,
			lastOutcome: () => lastOutcome,
			shortcut: () => ({
				resolveCalls,
				passReturns,
				handledReturns,
				runCalls,
				lastOutcome: lastShortcutOutcome,
				lastContext: lastShortcutContext
			}),
			set: (field, value) => form.set(field, value)
		};
		Reflect.set(globalThis, DIAGNOSTICS_KEY, diagnostics);
		disposer.add(() => {
			if (Reflect.get(globalThis, DIAGNOSTICS_KEY) === diagnostics) Reflect.deleteProperty(globalThis, DIAGNOSTICS_KEY);
		});
		return () => {
			inflight?.abort();
			inflight = null;
			store.clear();
			disposer.disposeAll();
		};
	} catch (error) {
		disposer.disposeAll();
		throw error;
	}
}
/**
* Apply the plugin's browser contributions.
*
* One `ctx.effect` owns the whole runtime, so the Cordis fiber has exactly one
* thing to unwind when the plugin unloads or reloads.
*
* @param ctx - the client root context DSH hands to a browser plugin.
*/
function apply(ctx) {
	ctx.effect(() => createRuntime(ctx), "dsh-word-lookup: client runtime");
}
//#endregion
exports.CARD_ENTRY_ID = CARD_ENTRY_ID;
exports.CARD_ORDER = CARD_ORDER;
exports.LOOKUP_COMMAND_ID = LOOKUP_COMMAND_ID;
exports.apply = apply;
exports.inject = inject;
exports.namespace = namespace;

		return module.exports;
	}
});