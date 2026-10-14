window.__ModuleLoader__.load({
	id: "dsh-word-lookup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
let react_jsx_runtime = require("react/jsx-runtime");
/**
* Pure function computing card position.
*
* @param anchorRect - Selection bounding rectangle in client coordinates, or null.
* @param cardSize - Measured or estimated card size.
* @param viewportSize - Current viewport width and height.
* @param options - Optional custom margin and gap.
* @returns Viewport coordinates and placement direction.
*/
function computeCardPosition(anchorRect, cardSize, viewportSize, options) {
	const margin = options?.margin ?? 12;
	const gap = options?.gap ?? 8;
	const minX = margin;
	const maxX = Math.max(margin, viewportSize.width - margin - cardSize.width);
	const minY = margin;
	const maxY = Math.max(margin, viewportSize.height - margin - cardSize.height);
	if (anchorRect === null) {
		const fallbackX = (viewportSize.width - cardSize.width) / 2;
		const clampedFallbackX = Math.max(minX, Math.min(maxX, fallbackX));
		const fallbackY = margin + 48;
		return {
			x: Math.round(clampedFallbackX),
			y: Math.round(Math.max(minY, Math.min(maxY, fallbackY))),
			placement: "fallback"
		};
	}
	const clampedX = Math.max(minX, Math.min(maxX, anchorRect.x));
	const anchorBottom = anchorRect.y + anchorRect.height;
	const spaceBelow = viewportSize.height - margin - anchorBottom;
	const spaceAbove = anchorRect.y - margin;
	const neededHeight = cardSize.height + gap;
	const belowFits = spaceBelow >= neededHeight;
	const aboveFits = spaceAbove >= neededHeight;
	let y;
	let placement;
	if (belowFits) {
		placement = "below";
		y = anchorBottom + gap;
	} else if (aboveFits) {
		placement = "above";
		y = anchorRect.y - gap - cardSize.height;
	} else if (spaceAbove >= spaceBelow) {
		placement = "above";
		y = anchorRect.y - gap - cardSize.height;
	} else {
		placement = "below";
		y = anchorBottom + gap;
	}
	return {
		x: Math.round(clampedX),
		y: Math.round(Math.max(minY, Math.min(maxY, y))),
		placement
	};
}
//#endregion
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
* Production Result Card UI for `shell.overlay`.
*
* Implements Phase 5 Production Result Card:
* - Mutually exclusive 5-state model: idle, loading, found, not-found, error.
* - Viewport-safe positioning relative to selection anchor with fallback.
* - Dismissal: Escape, outside pointer/click (no shield), and close button.
* - Dismiss / request race correctness via surface generation.
* - Accessibility: semantic region, accessible close label, readable contrast.
* - No focus stealing on card appearance.
* - Card text selectable and copyable; 0 automatic lookups for internal selection.
* - Responsive narrow-viewport safety and scrollable long content.
* - Self-contained light and dark theme support.
*
* @module dsh-word-lookup/client/card
*/
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? react.useLayoutEffect : react.useEffect;
/**
* Classify CardState into formal UI display state.
*
* @param state - The current store snapshot.
* @returns One of the five mutually exclusive UI states.
*/
function getCardUiState(state) {
	if (state.status === "idle") return "idle";
	if (state.status === "loading") return "loading";
	if (state.status === "failed") return "error";
	if (state.result.kind === "found") return "found";
	if (state.result.kind === "not-found") return "not-found";
	return "error";
}
/** Injectable CSS rules for theming, typography, and scroll behavior. */
const THEME_STYLES = `
.dsh-wl-card {
  --wl-bg: #1c1c21;
  --wl-fg: #f2f2f7;
  --wl-fg-muted: #9898a6;
  --wl-border: rgba(255, 255, 255, 0.14);
  --wl-tag-bg: rgba(255, 255, 255, 0.08);
  --wl-tag-fg: #d0d0dc;
  --wl-example-bg: rgba(255, 255, 255, 0.04);
  --wl-close-hover: rgba(255, 255, 255, 0.12);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
@media (prefers-color-scheme: light) {
  .dsh-wl-card {
    --wl-bg: #ffffff;
    --wl-fg: #18181c;
    --wl-fg-muted: #626270;
    --wl-border: rgba(0, 0, 0, 0.12);
    --wl-tag-bg: rgba(0, 0, 0, 0.06);
    --wl-tag-fg: #454552;
    --wl-example-bg: rgba(0, 0, 0, 0.03);
    --wl-close-hover: rgba(0, 0, 0, 0.08);
    --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
  }
}
:root[data-theme="light"] .dsh-wl-card,
.light .dsh-wl-card {
  --wl-bg: #ffffff;
  --wl-fg: #18181c;
  --wl-fg-muted: #626270;
  --wl-border: rgba(0, 0, 0, 0.12);
  --wl-tag-bg: rgba(0, 0, 0, 0.06);
  --wl-tag-fg: #454552;
  --wl-example-bg: rgba(0, 0, 0, 0.03);
  --wl-close-hover: rgba(0, 0, 0, 0.08);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
}
:root[data-theme="dark"] .dsh-wl-card,
.dark .dsh-wl-card {
  --wl-bg: #1c1c21;
  --wl-fg: #f2f2f7;
  --wl-fg-muted: #9898a6;
  --wl-border: rgba(255, 255, 255, 0.14);
  --wl-tag-bg: rgba(255, 255, 255, 0.08);
  --wl-tag-fg: #d0d0dc;
  --wl-example-bg: rgba(255, 255, 255, 0.04);
  --wl-close-hover: rgba(255, 255, 255, 0.12);
  --wl-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
`;
/** Base card panel style. */
const BASE_PANEL_STYLE = {
	position: "fixed",
	zIndex: 2147483e3,
	pointerEvents: "auto",
	userSelect: "text",
	width: "min(360px, calc(100vw - 24px))",
	maxWidth: "calc(100vw - 24px)",
	maxHeight: "min(440px, calc(100vh - 32px))",
	overflowY: "auto",
	overflowX: "hidden",
	padding: "12px 14px",
	border: "1px solid var(--dsh-color-border, var(--wl-border, rgba(128,128,128,0.25)))",
	borderRadius: "10px",
	background: "var(--dsh-color-bg-elevated, var(--wl-bg, #1c1c21))",
	color: "var(--dsh-color-text-primary, var(--wl-fg, #f2f2f7))",
	font: "13px/1.55 system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
	boxShadow: "var(--wl-shadow, 0 8px 28px rgba(0,0,0,0.35))",
	boxSizing: "border-box",
	overflowWrap: "break-word",
	wordBreak: "break-word"
};
/** Header row container style. */
const HEADER_STYLE = {
	display: "flex",
	alignItems: "baseline",
	justifyContent: "space-between",
	gap: "8px",
	marginBottom: "8px"
};
/** Close button style. */
const CLOSE_STYLE = {
	flexShrink: 0,
	marginLeft: "auto",
	border: "none",
	background: "transparent",
	color: "var(--wl-fg-muted, #9898a6)",
	cursor: "pointer",
	fontSize: "18px",
	lineHeight: "1",
	padding: "2px 6px",
	borderRadius: "4px",
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	fontFamily: "inherit"
};
/**
* Render the Production Dictionary Result Card.
*
* @param props - Overlay seat props plus the injected store.
* @returns The dictionary card element, or null while idle.
*/
function WordLookupCard(props) {
	const state = (0, react.useSyncExternalStore)(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
	const cardRef = (0, react.useRef)(null);
	const [position, setPosition] = (0, react.useState)(null);
	const uiState = getCardUiState(state);
	const close = () => {
		props.store.clear();
	};
	useIsomorphicLayoutEffect(() => {
		if (state.status === "idle") {
			setPosition(null);
			return;
		}
		const updatePosition = () => {
			const el = cardRef.current;
			const width = el ? el.offsetWidth : 340;
			const height = el ? el.offsetHeight : 180;
			const anchorRect = props.store.anchorRect();
			const viewport = {
				width: typeof window !== "undefined" ? window.innerWidth : 1200,
				height: typeof window !== "undefined" ? window.innerHeight : 800
			};
			const next = computeCardPosition(anchorRect, {
				width,
				height
			}, viewport);
			setPosition(next);
		};
		updatePosition();
		if (typeof window !== "undefined") {
			window.addEventListener("resize", updatePosition);
			return () => {
				window.removeEventListener("resize", updatePosition);
			};
		}
	}, [state, props.store]);
	(0, react.useEffect)(() => {
		if (state.status === "idle") return;
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				close();
			}
		};
		const onOutsidePointerDown = (event) => {
			if (cardRef.current && !cardRef.current.contains(event.target)) close();
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onOutsidePointerDown, { capture: true });
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onOutsidePointerDown, { capture: true });
		};
	}, [state.status, props.store]);
	if (state.status === "idle") return null;
	const posStyle = position ? {
		left: `${String(position.x)}px`,
		top: `${String(position.y)}px`
	} : {
		left: "16px",
		top: "72px"
	};
	let headerTitle = null;
	let statusBadge = null;
	if (uiState === "loading") {
		headerTitle = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
			"data-dsh-word-lookup": "query",
			style: {
				fontWeight: 600,
				fontSize: "15px"
			},
			children: state.query
		});
		statusBadge = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			"data-dsh-word-lookup": "status",
			style: {
				fontSize: "12px",
				color: "var(--wl-fg-muted, #9898a6)",
				fontStyle: "italic"
			},
			children: "looking up..."
		});
	} else if (uiState === "found") {
		const found = state.result.body;
		headerTitle = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				flexWrap: "wrap"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				"data-dsh-word-lookup": "headword",
				style: {
					margin: 0,
					fontSize: "16px",
					fontWeight: 700,
					lineHeight: "1.3",
					color: "inherit"
				},
				children: found.headword
			}), found.phonetic ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				"data-dsh-word-lookup": "phonetic",
				style: {
					fontSize: "12px",
					color: "var(--wl-fg-muted, #9898a6)",
					fontFamily: "system-ui, sans-serif"
				},
				children: found.phonetic
			}) : null]
		});
	} else headerTitle = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
		"data-dsh-word-lookup": "query",
		style: {
			fontWeight: 600,
			fontSize: "15px"
		},
		children: state.query
	});
	const header = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: HEADER_STYLE,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				flex: "1 1 auto",
				minWidth: 0,
				marginRight: "8px"
			},
			children: [headerTitle, statusBadge]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			"data-dsh-word-lookup": "close",
			style: CLOSE_STYLE,
			onClick: close,
			"aria-label": "Close dictionary",
			title: "Close dictionary (Esc)",
			children: "×"
		})]
	});
	let body = null;
	if (uiState === "loading") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		"data-dsh-word-lookup": "loading-body",
		style: {
			padding: "12px 0 6px",
			fontSize: "12px",
			color: "var(--wl-fg-muted, #9898a6)"
		},
		children: "Fetching dictionary definition..."
	});
	else if (uiState === "not-found") body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		"data-dsh-word-lookup": "not-found",
		style: {
			padding: "6px 0",
			fontSize: "13px",
			color: "var(--wl-fg-muted, #9898a6)"
		},
		children: [
			"no entry for \"",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					color: "var(--wl-fg, #f2f2f7)",
					fontWeight: 500
				},
				children: state.query
			}),
			"\""
		]
	});
	else if (uiState === "error") {
		let errorMessage = "Dictionary lookup temporarily unavailable";
		if (state.status === "ready" && state.result.kind === "refused") errorMessage = `Request refused (${String(state.result.httpStatus)})`;
		else if (state.status === "failed") errorMessage = state.failure.kind === "aborted" ? "Lookup superseded" : "Dictionary service unavailable";
		body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			"data-dsh-word-lookup": "error",
			style: {
				padding: "6px 0",
				fontSize: "13px",
				color: "#e06c75"
			},
			children: errorMessage
		});
	} else if (uiState === "found") {
		const found = state.result.body;
		const showLemma = found.matchedForm !== null && found.matchedForm !== void 0 && found.matchedForm.trim().toLowerCase() !== found.headword.trim().toLowerCase();
		body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			"data-dsh-word-lookup": "entry",
			children: [
				showLemma ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					"data-dsh-word-lookup": "lemma",
					style: {
						fontSize: "12px",
						color: "var(--wl-fg-muted, #9898a6)",
						marginBottom: "6px"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: 500 },
							children: found.matchedForm
						}),
						" → ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: found.headword })
					]
				}) : null,
				Array.isArray(found.meanings) && found.meanings.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
					style: {
						margin: "6px 0 8px",
						paddingLeft: found.meanings.length > 1 ? "18px" : "0",
						listStyleType: found.meanings.length > 1 ? "decimal" : "none"
					},
					children: found.meanings.map((meaning, index) => {
						const glosses = meaning.translation ? splitGlosses(meaning.translation) : [];
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: {
								marginBottom: "6px",
								fontSize: "13px"
							},
							children: [
								meaning.partOfSpeech ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										display: "inline-block",
										padding: "1px 5px",
										marginRight: "6px",
										borderRadius: "3px",
										background: "var(--wl-tag-bg, rgba(255,255,255,0.08))",
										color: "var(--wl-tag-fg, #d0d0dc)",
										fontSize: "11px",
										fontWeight: 600,
										fontStyle: "italic"
									},
									children: meaning.partOfSpeech
								}) : null,
								glosses.map((gloss, glossIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-dsh-word-lookup": "gloss",
									children: [glossIndex === 0 ? "" : "；", gloss]
								}, String(glossIndex))),
								meaning.translation && meaning.definition ? " " : null,
								meaning.definition ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: "var(--wl-fg-muted, #9898a6)",
										fontSize: "12px"
									},
									children: meaning.definition
								}) : null
							]
						}, String(index));
					})
				}) : null,
				Array.isArray(found.forms) && found.forms.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					"data-dsh-word-lookup": "forms",
					style: {
						marginTop: "4px",
						fontSize: "11px",
						color: "var(--wl-fg-muted, #9898a6)"
					},
					children: found.forms.map((form) => form.form).join(" · ")
				}) : null,
				Array.isArray(found.examples) && found.examples.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						marginTop: "8px",
						borderTop: "1px solid var(--wl-border, rgba(128,128,128,0.2))",
						paddingTop: "6px"
					},
					children: found.examples.slice(0, 2).map((example, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-dsh-word-lookup": "example",
						style: {
							marginTop: index === 0 ? "4px" : "6px",
							padding: "4px 6px",
							borderRadius: "4px",
							background: "var(--wl-example-bg, rgba(255,255,255,0.03))",
							fontSize: "12px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { color: "var(--wl-fg, #f2f2f7)" },
							children: example.en
						}), example.zh ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								color: "var(--wl-fg-muted, #9898a6)",
								marginTop: "2px",
								fontSize: "11px"
							},
							children: example.zh
						}) : null]
					}, String(index)))
				}) : null
			]
		});
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
		ref: cardRef,
		role: "region",
		"aria-label": "Dictionary lookup",
		"data-dsh-word-lookup": "card",
		"data-dsh-word-lookup-state": state.status,
		"data-dsh-word-lookup-ui-state": uiState,
		className: "dsh-wl-card",
		style: {
			...BASE_PANEL_STYLE,
			...posStyle
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: THEME_STYLES }),
			header,
			body
		]
	});
}
//#endregion
//#region src/shared/dictionary-management-protocol.ts
/**
* Shared wire contract and data types for dictionary management operations.
*
* Leaf module: imports nothing and contains no environment-specific APIs.
* Shared between Host management routes and the future Client settings page (Phase 7A.7).
*
* @module dsh-word-lookup/shared/dictionary-management-protocol
*/
/** Document-relative URL of dictionary management status endpoint (client-facing). */
const MANAGEMENT_STATUS_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/status";
/** Document-relative URL of dictionary installation endpoint (client-facing). */
const MANAGEMENT_INSTALL_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/install";
/** Document-relative URL of dictionary cancellation endpoint (client-facing). */
const MANAGEMENT_CANCEL_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/cancel";
/** Document-relative URL of dictionary removal endpoint (client-facing). */
const MANAGEMENT_REMOVE_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/remove";
/** Content-Type accepted and returned by management endpoints. */
const MANAGEMENT_MEDIA_TYPE = "application/json";
//#endregion
//#region src/client/settings/dictionary-management-transport.ts
/**
* Browser transport client for dictionary management endpoints.
*
* All endpoints use document-relative paths (`api/dsh-word-lookup/dictionary/...`,
* no leading slash) conforming to DSH <base href="./"> architecture.
* Authentication uses standard same-origin cookie credentials.
*
* @module dsh-word-lookup/client/settings/dictionary-management-transport
*/
/**
* Validate that an unknown value conforms to DictionaryStatusResponse structure.
*/
function isValidDictionaryStatusResponse(value) {
	if (typeof value !== "object" || value === null) return false;
	const r = value;
	return r.ok === true && (r.activeMode === "fixture" || r.activeMode === "managed-ecdict" || r.activeMode === "custom") && typeof r.installed === "boolean" && typeof r.canInstall === "boolean" && typeof r.canCancel === "boolean" && typeof r.canRemove === "boolean" && typeof r.generation === "number";
}
/**
* Validate that an unknown value conforms to DictionaryErrorResponse.
*/
function parseRefusalBody(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const r = value;
	if (r.ok === false && typeof r.error === "string" && typeof r.message === "string") return {
		code: r.error,
		message: r.message
	};
}
/**
* Generic fetch wrapper for management endpoints.
*/
async function sendManagementRequest(url, options) {
	const init = {
		method: options.method,
		headers: {
			accept: MANAGEMENT_MEDIA_TYPE,
			...options.body !== void 0 ? { "content-type": MANAGEMENT_MEDIA_TYPE } : {}
		},
		...options.body !== void 0 ? { body: JSON.stringify(options.body) } : {},
		...options.signal !== void 0 ? { signal: options.signal } : {}
	};
	let response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return {
			ok: false,
			kind: "aborted"
		};
		return {
			ok: false,
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
		if (options.validator !== void 0) {
			if (options.validator(parsed)) return {
				ok: true,
				data: parsed
			};
			return {
				ok: false,
				kind: "refused",
				httpStatus: response.status,
				code: "unexpected-response",
				message: "Host returned an unexpected response structure."
			};
		}
		if (typeof parsed === "object" && parsed !== null && parsed.ok === true) return {
			ok: true,
			data: parsed
		};
	}
	const refusal = parseRefusalBody(parsed);
	return {
		ok: false,
		kind: "refused",
		httpStatus: response.status,
		code: refusal?.code ?? "unexpected-response",
		message: refusal?.message ?? `Host answered with HTTP ${response.status}`
	};
}
/**
* Fetch current dictionary status from the host.
*/
async function fetchDictionaryStatus(signal) {
	return sendManagementRequest(MANAGEMENT_STATUS_DOCUMENT_PATH, {
		method: "GET",
		signal,
		validator: isValidDictionaryStatusResponse
	});
}
/**
* Initiate an installation of the managed ECDICT corpus.
*/
async function installManagedDictionary(signal) {
	return sendManagementRequest(MANAGEMENT_INSTALL_DOCUMENT_PATH, {
		method: "POST",
		signal
	});
}
/**
* Cancel an in-flight background operation.
*/
async function cancelDictionaryOperation(operationId, signal) {
	return sendManagementRequest(MANAGEMENT_CANCEL_DOCUMENT_PATH, {
		method: "POST",
		body: { operationId },
		signal
	});
}
/**
* Remove the installed managed ECDICT corpus and revert to fixture mode.
*/
async function removeManagedDictionary(signal) {
	return sendManagementRequest(MANAGEMENT_REMOVE_DOCUMENT_PATH, {
		method: "POST",
		signal
	});
}
//#endregion
//#region src/client/settings/dictionary-management-store.ts
const DEFAULT_ACTIVE_INTERVAL = 800;
const DEFAULT_IDLE_INTERVAL = 1e4;
var DictionaryManagementStore = class {
	#state = {
		status: null,
		isLoading: true,
		isActing: false,
		actionError: null,
		connectionError: null,
		lastRefreshedAt: 0
	};
	#listeners = /* @__PURE__ */ new Set();
	#activeIntervalMs;
	#idleIntervalMs;
	#timer = null;
	#abortController = null;
	#requestId = 0;
	#disposed = false;
	constructor(options = {}) {
		this.#activeIntervalMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL;
		this.#idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL;
		if (options.autoStart ?? true) {
			if (typeof window !== "undefined") window.addEventListener("focus", this.#onWindowFocus);
			this.refresh();
		}
	}
	/**
	* Subscribe to store state changes.
	*/
	subscribe = (listener) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	/**
	* Return the current immutable snapshot.
	*/
	getSnapshot = () => {
		return this.#state;
	};
	#emit() {
		if (this.#disposed) return;
		for (const listener of this.#listeners) try {
			listener();
		} catch {}
	}
	#onWindowFocus = () => {
		if (this.#disposed) return;
		this.refresh();
	};
	#scheduleNextPoll() {
		if (this.#disposed) return;
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		const interval = this.#state.status?.currentOperation !== null && this.#state.status?.currentOperation !== void 0 && this.#state.status.currentOperation.status === "running" ? this.#activeIntervalMs : this.#idleIntervalMs;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#poll();
		}, interval);
	}
	async #poll() {
		if (this.#disposed) return;
		const id = ++this.#requestId;
		const controller = new AbortController();
		this.#abortController = controller;
		try {
			const result = await fetchDictionaryStatus(controller.signal);
			if (this.#disposed || id !== this.#requestId) return;
			if (result.ok) this.#state = {
				...this.#state,
				status: result.data,
				isLoading: false,
				connectionError: null,
				lastRefreshedAt: Date.now()
			};
			else if (result.kind === "network") this.#state = {
				...this.#state,
				connectionError: `网络连接异常: ${result.message}`,
				isLoading: false
			};
			else if (result.kind === "refused") this.#state = {
				...this.#state,
				connectionError: `服务响应异常 (${result.httpStatus}): ${result.message}`,
				isLoading: false
			};
			this.#emit();
		} finally {
			if (this.#abortController === controller) this.#abortController = null;
			this.#scheduleNextPoll();
		}
	}
	/**
	* Immediately refresh dictionary status from the host.
	*/
	async refresh() {
		if (this.#disposed) return;
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		await this.#poll();
	}
	/**
	* Request installation of the managed ECDICT corpus.
	*/
	async install() {
		if (this.#disposed || this.#state.isActing) return false;
		this.#state = {
			...this.#state,
			isActing: true,
			actionError: null
		};
		this.#emit();
		const controller = new AbortController();
		try {
			const result = await installManagedDictionary(controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "安装请求被取消";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			if (!this.#disposed) {
				this.#state = {
					...this.#state,
					isActing: false
				};
				this.#emit();
			}
		}
	}
	/**
	* Request cancellation of the active operation.
	*/
	async cancel(targetOperationId) {
		if (this.#disposed || this.#state.isActing) return false;
		const opId = targetOperationId ?? this.#state.status?.currentOperation?.operationId;
		if (!opId) {
			this.#state = {
				...this.#state,
				actionError: "没有正在执行的操作可供取消"
			};
			this.#emit();
			return false;
		}
		this.#state = {
			...this.#state,
			isActing: true,
			actionError: null
		};
		this.#emit();
		const controller = new AbortController();
		try {
			const result = await cancelDictionaryOperation(opId, controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "取消请求未完成";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			if (!this.#disposed) {
				this.#state = {
					...this.#state,
					isActing: false
				};
				this.#emit();
			}
		}
	}
	/**
	* Request removal of the installed managed ECDICT corpus.
	*/
	async remove() {
		if (this.#disposed || this.#state.isActing) return false;
		this.#state = {
			...this.#state,
			isActing: true,
			actionError: null
		};
		this.#emit();
		const controller = new AbortController();
		try {
			const result = await removeManagedDictionary(controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "移除请求未完成";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			if (!this.#disposed) {
				this.#state = {
					...this.#state,
					isActing: false
				};
				this.#emit();
			}
		}
	}
	/**
	* Clear any outstanding action errors.
	*/
	clearActionError() {
		if (this.#state.actionError !== null) {
			this.#state = {
				...this.#state,
				actionError: null
			};
			this.#emit();
		}
	}
	/**
	* Dispose store, stop all timers and abort outstanding requests.
	*/
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		if (this.#abortController !== null) {
			this.#abortController.abort();
			this.#abortController = null;
		}
		if (typeof window !== "undefined") window.removeEventListener("focus", this.#onWindowFocus);
		this.#listeners.clear();
	}
};
//#endregion
//#region src/client/settings/dictionary-settings-components.tsx
/**
* Accessible UI primitives and helper components for DSH native dictionary settings.
*
* Implements:
* - Theme-aware styles adhering to DSH design tokens (--dsw-* / fallback).
* - Full dark and light theme support with responsive wrapping.
* - WCAG compliant ARIA attributes, keyboard accessibility (Tab, Space, Enter, Escape).
* - Self-contained zero external runtime dependencies.
*
* @module dsh-word-lookup/client/settings/dictionary-settings-components
*/
/** CSS styles injected for settings UI components. */
const SETTINGS_THEME_STYLES = `
.dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);
  --wl-set-accent: var(--dsw-alias-brand-primary, #4176e6);
  --wl-set-accent-hover: #3463c2;
  --wl-set-success: var(--dsw-alias-state-success-primary, #22c55e);
  --wl-set-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --wl-set-error: var(--dsw-alias-state-error-primary, #ef4444);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));
}

@media (prefers-color-scheme: light) {
  .dsh-wl-settings {
    --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));
    --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));
    --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);
    --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);
    --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);
    --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));
  }
}

:root[data-theme="light"] .dsh-wl-settings,
body:not([data-ds-dark-theme]) .dsh-wl-settings,
.light .dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #18181c);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #5c5c66);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #8c8c99);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06));
}

:root[data-theme="dark"] .dsh-wl-settings,
body[data-ds-dark-theme] .dsh-wl-settings,
.dark .dsh-wl-settings {
  --wl-set-bg-card: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)));
  --wl-set-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08))));
  --wl-set-text-main: var(--dsw-alias-label-primary, #f2f2f7);
  --wl-set-text-sub: var(--dsw-alias-label-secondary, #9898a6);
  --wl-set-text-muted: var(--dsw-alias-label-tertiary, #6c6c7a);
  --wl-set-border-row: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06));
}

@media (max-width: 600px) {
  .dsh-wl-setting-row {
    flex-direction: column !important;
    align-items: flex-start !important;
    gap: 8px !important;
  }
}
`;
function SectionCard({ title, description, badge, action, children, className }) {
	const cardStyle = {
		background: "var(--wl-set-bg-card, rgba(255, 255, 255, 0.04))",
		border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))",
		borderRadius: "12px",
		padding: "18px 20px",
		marginBottom: "20px",
		boxSizing: "border-box"
	};
	const headerStyle = {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: "12px",
		marginBottom: description ? "4px" : "14px",
		flexWrap: "wrap"
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `dsh-wl-card-section ${className ?? ""}`,
		style: cardStyle,
		"aria-labelledby": `sec-${title}`,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: headerStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: "8px",
						flexWrap: "wrap"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						id: `sec-${title}`,
						style: {
							fontSize: "15px",
							fontWeight: 600,
							color: "var(--wl-set-text-main, #f2f2f7)",
							margin: 0,
							lineHeight: "22px"
						},
						children: title
					}), badge]
				}), action && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: action })]
			}),
			description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					fontSize: "12.5px",
					color: "var(--wl-set-text-sub, #9898a6)",
					margin: "0 0 14px 0",
					lineHeight: "18px"
				},
				children: description
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children })
		]
	});
}
function SettingRow({ title, description, control, isLast = false }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "16px",
			padding: "12px 0",
			borderBottom: isLast ? "none" : "1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.06))"
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				flex: "1 1 auto",
				minWidth: 0
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "13.5px",
					fontWeight: 500,
					color: "var(--wl-set-text-main, #f2f2f7)",
					lineHeight: "20px"
				},
				children: title
			}), description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "12px",
					color: "var(--wl-set-text-sub, #9898a6)",
					marginTop: "2px",
					lineHeight: "17px"
				},
				children: description
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: { flexShrink: 0 },
			children: control
		})]
	});
}
function StatusBadge({ variant, label, icon }) {
	let color = "var(--wl-set-text-sub, #9898a6)";
	let bg = "rgba(128, 128, 128, 0.12)";
	let border = "rgba(128, 128, 128, 0.25)";
	if (variant === "success") {
		color = "var(--wl-set-success, #22c55e)";
		bg = "rgba(34, 197, 94, 0.12)";
		border = "rgba(34, 197, 94, 0.3)";
	} else if (variant === "warning") {
		color = "var(--wl-set-warn, #f59e0b)";
		bg = "rgba(245, 158, 11, 0.12)";
		border = "rgba(245, 158, 11, 0.3)";
	} else if (variant === "error") {
		color = "var(--wl-set-error, #ef4444)";
		bg = "rgba(239, 68, 68, 0.12)";
		border = "rgba(239, 68, 68, 0.3)";
	} else if (variant === "info") {
		color = "var(--wl-set-accent, #4176e6)";
		bg = "rgba(65, 118, 230, 0.12)";
		border = "rgba(65, 118, 230, 0.3)";
	}
	const badgeStyle = {
		display: "inline-flex",
		alignItems: "center",
		gap: "4px",
		padding: "2px 8px",
		borderRadius: "12px",
		fontSize: "11.5px",
		fontWeight: 500,
		lineHeight: "16px",
		color,
		background: bg,
		border: `1px solid ${border}`,
		userSelect: "none"
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		style: badgeStyle,
		role: "status",
		children: [icon, label]
	});
}
function Switch({ checked, disabled = false, onChange, label, id }) {
	const width = 38;
	const height = 22;
	const thumbSize = 16;
	const trackStyle = {
		position: "relative",
		display: "inline-block",
		width: `${width}px`,
		height: `${height}px`,
		borderRadius: `${height / 2}px`,
		background: checked ? "var(--wl-set-accent, #4176e6)" : "var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.25))",
		cursor: disabled ? "not-allowed" : "pointer",
		opacity: disabled ? .5 : 1,
		transition: "background 0.2s ease, opacity 0.2s ease",
		outline: "none",
		border: "none",
		padding: 0,
		verticalAlign: "middle"
	};
	const thumbStyle = {
		position: "absolute",
		top: "3px",
		left: checked ? `19px` : "3px",
		width: `${thumbSize}px`,
		height: `${thumbSize}px`,
		borderRadius: "50%",
		background: "#ffffff",
		boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
		transition: "left 0.2s ease"
	};
	const handleKeyDown = (e) => {
		if (disabled) return;
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			onChange(!checked);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		id,
		type: "button",
		role: "switch",
		"aria-checked": checked,
		"aria-label": label,
		disabled,
		style: trackStyle,
		onClick: () => {
			if (!disabled) onChange(!checked);
		},
		onKeyDown: handleKeyDown,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: thumbStyle,
			"aria-hidden": "true"
		})
	});
}
function ActionButton({ children, onClick, variant = "secondary", disabled = false, busy = false, size = "medium", ariaLabel, title }) {
	let bg = "rgba(255, 255, 255, 0.08)";
	let color = "var(--wl-set-text-main, #f2f2f7)";
	let border = "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.12))";
	if (variant === "primary") {
		bg = "var(--wl-set-accent, #4176e6)";
		color = "#ffffff";
		border = "1px solid transparent";
	} else if (variant === "danger") {
		bg = "rgba(239, 68, 68, 0.12)";
		color = "var(--wl-set-error, #ef4444)";
		border = "1px solid rgba(239, 68, 68, 0.3)";
	} else if (variant === "ghost") {
		bg = "transparent";
		color = "var(--wl-set-text-sub, #9898a6)";
		border = "1px solid transparent";
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		style: {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: "6px",
			background: bg,
			color,
			border,
			borderRadius: "6px",
			padding: size === "small" ? "4px 10px" : "7px 14px",
			fontSize: size === "small" ? "12px" : "13px",
			fontWeight: 500,
			cursor: disabled || busy ? "not-allowed" : "pointer",
			opacity: disabled ? .45 : busy ? .75 : 1,
			transition: "background 0.15s ease, opacity 0.15s ease, filter 0.15s ease",
			outline: "none",
			userSelect: "none",
			lineHeight: "1.4"
		},
		disabled: disabled || busy,
		onClick,
		"aria-label": ariaLabel,
		title,
		children: [busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: {
				display: "inline-block",
				width: "12px",
				height: "12px",
				borderRadius: "50%",
				border: "2px solid currentColor",
				borderTopColor: "transparent",
				animation: "dsh-wl-spin 0.8s linear infinite"
			},
			"aria-hidden": "true"
		}), children]
	});
}
function ProgressBar({ percent, label, subtext }) {
	const safePercent = percent !== void 0 ? Math.min(100, Math.max(0, Math.round(percent))) : void 0;
	const containerStyle = {
		width: "100%",
		marginTop: "10px"
	};
	const headerStyle = {
		display: "flex",
		justifyContent: "space-between",
		fontSize: "12px",
		color: "var(--wl-set-text-sub, #9898a6)",
		marginBottom: "6px"
	};
	const trackStyle = {
		width: "100%",
		height: "6px",
		borderRadius: "3px",
		background: "var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.2))",
		overflow: "hidden",
		position: "relative"
	};
	const fillStyle = {
		height: "100%",
		borderRadius: "3px",
		background: "var(--wl-set-accent, #4176e6)",
		width: safePercent !== void 0 ? `${safePercent}%` : "40%",
		transition: "width 0.3s ease",
		...safePercent === void 0 ? {
			position: "absolute",
			animation: "dsh-wl-indeterminate 1.5s infinite ease-in-out"
		} : {}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: containerStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: headerStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), safePercent !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [safePercent, "%"] })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: trackStyle,
				role: "progressbar",
				"aria-valuenow": safePercent,
				"aria-valuemin": 0,
				"aria-valuemax": 100,
				"aria-label": label,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: fillStyle })
			}),
			subtext && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "11.5px",
					color: "var(--wl-set-text-muted, #6c6c7a)",
					marginTop: "4px"
				},
				children: subtext
			})
		]
	});
}
function ModalConfirm({ title, message, confirmLabel = "确认", cancelLabel = "取消", isDanger = false, onConfirm, onCancel }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			position: "fixed",
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			background: "rgba(0, 0, 0, 0.55)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 99999,
			padding: "16px"
		},
		role: "presentation",
		onClick: onCancel,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				background: "var(--wl-set-bg-card, #202026)",
				border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))",
				borderRadius: "12px",
				maxWidth: "420px",
				width: "100%",
				padding: "20px 22px",
				boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
				boxSizing: "border-box"
			},
			role: "dialog",
			"aria-modal": "true",
			"aria-labelledby": "confirm-dialog-title",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					id: "confirm-dialog-title",
					style: {
						fontSize: "16px",
						fontWeight: 600,
						margin: "0 0 10px 0",
						color: "var(--wl-set-text-main, #f2f2f7)"
					},
					children: title
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: "13px",
						lineHeight: "1.5",
						color: "var(--wl-set-text-sub, #9898a6)",
						margin: "0 0 20px 0"
					},
					children: message
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "flex-end",
						gap: "10px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
						onClick: onCancel,
						variant: "secondary",
						children: cancelLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
						onClick: onConfirm,
						variant: isDanger ? "danger" : "primary",
						children: confirmLabel
					})]
				})
			]
		})
	});
}
//#endregion
//#region src/client/settings/dictionary-settings-section.tsx
/**
* Native DSH Settings Section for Dictionary Management (`settings.section`).
*
* Implements Phase 7A.7:
* - Current Dictionary Status (Active mode, entry counts, forms, source, diagnostics).
* - 1-Click ECDICT Installation, Real-time Streaming Progress, Safe Cancellation.
* - Managed Corpus Removal with Confirmation Dialog and Fixture Fallback.
* - Automatic Lookup Switches (autoDoubleClick, autoSelection) via ConfigForms.
* - Platform-accurate shortcut inspection and advanced dictionary informational notices.
* - Responsive, theme-aware, WCAG-accessible (WCAG 2.1 AA).
*
* @module dsh-word-lookup/client/settings/dictionary-settings-section
*/
/** Helper to detect platform for shortcut badge. */
function detectPlatform(override) {
	if (override !== void 0) return override;
	if (typeof navigator === "undefined") return "windows";
	const p = (navigator.platform || navigator.userAgent || "").toLowerCase();
	if (p.includes("mac")) return "macos";
	if (p.includes("linux")) return "linux";
	return "windows";
}
function DictionarySettingsSection({ store: externalStore, form, testPlatform, close: _close }) {
	const [internalStore] = (0, react.useState)(() => externalStore ? null : new DictionaryManagementStore());
	const store = externalStore ?? internalStore;
	(0, react.useEffect)(() => {
		return () => {
			if (internalStore) internalStore.dispose();
		};
	}, [internalStore]);
	const storeState = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot, store.getSnapshot);
	const [formValues, setFormValues] = (0, react.useState)(() => {
		if (!form) return {
			autoDoubleClick: false,
			autoSelection: false
		};
		const snap = form.getSnapshot().value;
		return {
			autoDoubleClick: snap?.autoDoubleClick === true,
			autoSelection: snap?.autoSelection === true
		};
	});
	(0, react.useEffect)(() => {
		if (!form) return;
		const read = () => {
			const snap = form.getSnapshot().value;
			setFormValues({
				autoDoubleClick: snap?.autoDoubleClick === true,
				autoSelection: snap?.autoSelection === true
			});
		};
		read();
		return form.subscribe(read);
	}, [form]);
	const handleToggleDoubleClick = (next) => {
		setFormValues((prev) => ({
			...prev,
			autoDoubleClick: next
		}));
		if (form) form.set("autoDoubleClick", next);
	};
	const handleToggleSelection = (next) => {
		setFormValues((prev) => ({
			...prev,
			autoSelection: next
		}));
		if (form) form.set("autoSelection", next);
	};
	const [showRemoveConfirm, setShowRemoveConfirm] = (0, react.useState)(false);
	const [isExpandingDetails, setIsExpandingDetails] = (0, react.useState)(false);
	const { status, isLoading, isActing, actionError, connectionError } = storeState;
	const currentOp = status?.currentOperation;
	const isOperationRunning = currentOp !== null && currentOp !== void 0 && currentOp.status === "running";
	const platform = detectPlatform(testPlatform);
	let badgeVariant = "neutral";
	let badgeLabel = "未安装";
	if (status?.quarantined) {
		badgeVariant = "error";
		badgeLabel = "存储隔离保护中";
	} else if (status?.recoveryError) {
		badgeVariant = "warning";
		badgeLabel = "恢复异常";
	} else if (isOperationRunning) {
		badgeVariant = "info";
		if (currentOp.phase === "downloading") badgeLabel = "正在下载词源";
		else if (currentOp.phase === "verifying-source") badgeLabel = "正在校验源文件";
		else if (currentOp.phase === "building") badgeLabel = "正在构建数据库";
		else if (currentOp.phase === "validating-database") badgeLabel = "正在校验完整性";
		else if (currentOp.phase === "activating") badgeLabel = "正在激活词典";
		else badgeLabel = "正在执行操作";
	} else if (status?.installed) {
		if (status.activeMode === "managed-ecdict") {
			badgeVariant = "success";
			badgeLabel = "ECDICT 已启用";
		} else {
			badgeVariant = "warning";
			badgeLabel = "ECDICT 已安装 (未激活)";
		}
	} else {
		badgeVariant = "neutral";
		badgeLabel = "内置基础词典 (Fixture)";
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wl-settings",
		style: {
			maxWidth: "800px",
			width: "100%",
			boxSizing: "border-box"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: SETTINGS_THEME_STYLES }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { marginBottom: "22px" },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					style: {
						fontSize: "20px",
						fontWeight: 600,
						margin: "0 0 6px 0",
						color: "var(--wl-set-text-main, #f2f2f7)"
					},
					children: "词典与划词设置"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						fontSize: "13px",
						color: "var(--wl-set-text-sub, #9898a6)",
						margin: 0,
						lineHeight: "1.5"
					},
					children: "管理离线词典数据库、词源版本以及自动查词手势触发。"
				})]
			}),
			connectionError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "alert",
				style: {
					padding: "10px 14px",
					marginBottom: "16px",
					borderRadius: "8px",
					background: "rgba(245, 158, 11, 0.12)",
					border: "1px solid rgba(245, 158, 11, 0.3)",
					color: "var(--wl-set-warn, #f59e0b)",
					fontSize: "12.5px",
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: connectionError }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
					size: "small",
					variant: "secondary",
					onClick: () => void store.refresh(),
					children: "重试连接"
				})]
			}),
			status?.quarantined && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "alert",
				style: {
					padding: "12px 16px",
					marginBottom: "16px",
					borderRadius: "8px",
					background: "rgba(239, 68, 68, 0.12)",
					border: "1px solid rgba(239, 68, 68, 0.3)",
					color: "var(--wl-set-error, #ef4444)",
					fontSize: "13px",
					lineHeight: "1.5"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontWeight: 600,
						marginBottom: "4px"
					},
					children: "存储目录已进入隔离保护"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["原因: ", status.quarantineReason ?? "检测到未确认的 Worker 进程退出，系统已自动隔离存储目录以防止数据损坏。"] })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "当前活动词典",
				description: "当前在查词过程中负责提供释义的词典源与运行状态。",
				badge: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
					variant: badgeVariant,
					label: badgeLabel
				}),
				action: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
					size: "small",
					variant: "ghost",
					busy: isLoading,
					onClick: () => void store.refresh(),
					ariaLabel: "刷新词典状态",
					title: "刷新当前词典状态",
					children: "刷新状态"
				}),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "词典模式",
						description: "当前使用的词典引擎类别",
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "13px",
								fontWeight: 500,
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: status?.activeMode === "managed-ecdict" ? "ECDICT 本地全量词典" : status?.activeMode === "custom" ? "自定义 SQLite 词典" : "内置离线基础词典 (Fixture)"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "词条总数",
						description: "数据库中收录的英文词目及短语条目",
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "stat-entry-count",
							style: {
								fontSize: "13px",
								fontWeight: 600,
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: status?.activeMode === "managed-ecdict" ? (status.installedCorpus?.entryCount ?? 770611).toLocaleString() : "12 词条"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "屈折变形与词形数",
						description: "复数、过去式、进行时态等形态学归一化条目",
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "stat-form-count",
							style: {
								fontSize: "13px",
								fontWeight: 600,
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: status?.activeMode === "managed-ecdict" ? (status.installedCorpus?.formCount ?? 57689).toLocaleString() : "12 记录"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "数据源版本",
						description: "上游开源词库发布信息与来源标记",
						isLast: true,
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "12px",
								color: "var(--wl-set-text-sub, #9898a6)",
								fontFamily: "monospace"
							},
							children: status?.activeMode === "managed-ecdict" ? "ECDICT @ bc015ed" : "内置 Fixture v1.0"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: "14px",
							paddingTop: "10px",
							borderTop: "1px dashed var(--wl-set-border-row, rgba(255, 255, 255, 0.08))"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => setIsExpandingDetails(!isExpandingDetails),
							style: {
								background: "transparent",
								border: "none",
								padding: "4px 0",
								fontSize: "12px",
								color: "var(--wl-set-accent, #4176e6)",
								cursor: "pointer",
								display: "inline-flex",
								alignItems: "center",
								gap: "4px"
							},
							children: isExpandingDetails ? "收起详细技术信息 ▲" : "展开详细技术信息 ▼"
						}), isExpandingDetails && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: "10px",
								padding: "12px",
								borderRadius: "8px",
								background: "rgba(0, 0, 0, 0.15)",
								fontSize: "12px",
								lineHeight: "1.7",
								color: "var(--wl-set-text-sub, #9898a6)",
								fontFamily: "monospace"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["活跃标识: ", status?.activeIdentity ?? "fixture"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["活跃模式: ", status?.activeMode ?? "fixture"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["配置模式: ", status?.configuredMode ?? "fixture"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["数据库文件: ", status?.installedCorpus?.databaseFile ?? "内置只读"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["架构版本: ", status?.installedCorpus?.schemaVersion ?? 1] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["世代编号: ", status?.generation ?? 0] }),
								status?.settingsSyncState && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["配置同步状态: ", status.settingsSyncState] }),
								status?.recoveryError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { color: "var(--wl-set-warn, #f59e0b)" },
									children: ["启动恢复信息: ", status.recoveryError]
								})
							]
						})]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "ECDICT 完整词典管理",
				description: "ECDICT 是一部收录超过 77 万词条的开源双语离线词典，支持丰富的词频、词形变化和柯林斯星级标定。",
				children: [
					isOperationRunning && currentOp && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "16px",
							borderRadius: "8px",
							background: "rgba(65, 118, 230, 0.08)",
							border: "1px solid rgba(65, 118, 230, 0.25)",
							marginBottom: "16px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: "13.5px",
										fontWeight: 600,
										color: "var(--wl-set-text-main, #f2f2f7)"
									},
									children: currentOp.phase === "downloading" ? "正在下载 ECDICT 词源文件..." : currentOp.phase === "verifying-source" ? "正在校验 CSV 词源完整性..." : currentOp.phase === "building" ? "正在本地编译构建 SQLite 数据库..." : currentOp.phase === "validating-database" ? "正在执行 SQLite PRAGMA 完整性校验..." : currentOp.phase === "activating" ? "正在原子激活并重载词典..." : "正在处理中..."
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									size: "small",
									variant: "secondary",
									disabled: !status?.canCancel,
									busy: isActing,
									onClick: () => void store.cancel(currentOp.operationId),
									title: status?.canCancel ? "取消当前正在执行的任务" : "当前已进入原子激活阶段，不可取消",
									children: status?.canCancel ? "取消安装" : "不可取消 (提交中)"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProgressBar, {
								percent: currentOp.progress.percent,
								label: currentOp.progress.message ?? `${currentOp.phase}`,
								subtext: currentOp.progress.processed !== void 0 && currentOp.progress.total !== void 0 ? `${currentOp.progress.processed.toLocaleString()} / ${currentOp.progress.total.toLocaleString()} (${currentOp.progress.unit ?? "items"})` : void 0
							}),
							!status?.canCancel && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: "8px",
									fontSize: "12px",
									color: "var(--wl-set-warn, #f59e0b)"
								},
								children: "提示：当前阶段已进入不可取消的原子激活流程，请稍候。"
							})
						]
					}),
					status?.installed && !isOperationRunning && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "14px 16px",
							borderRadius: "8px",
							background: "rgba(34, 197, 94, 0.08)",
							border: "1px solid rgba(34, 197, 94, 0.25)",
							marginBottom: "16px",
							fontSize: "13px",
							lineHeight: "1.5",
							color: "var(--wl-set-text-main, #f2f2f7)"
						},
						children: "ECDICT 本地全量数据库已就绪（770,611 词条，57,689 形态学记录）。当前运行状态稳定，查词请求直接命中本地只读 SQLite 数据库。"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "12px",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							variant: "danger",
							disabled: !status.canRemove || isActing,
							busy: isActing,
							onClick: () => setShowRemoveConfirm(true),
							children: "移除本地词典"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "12px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "移除后将恢复为内置基础词典 (Fixture)。"
						})]
					})] }),
					!status?.installed && !isOperationRunning && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "14px 16px",
							borderRadius: "8px",
							background: "rgba(255, 255, 255, 0.04)",
							border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))",
							marginBottom: "16px",
							fontSize: "13px",
							lineHeight: "1.6",
							color: "var(--wl-set-text-sub, #9898a6)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontWeight: 600,
								color: "var(--wl-set-text-main, #f2f2f7)",
								marginBottom: "4px"
							},
							children: "一键部署说明"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "点击安装后，插件将从官方固定来源下载约 63 MiB 的 CSV 词源，并在本地通过零外部依赖的流式管道编译为 SQLite 数据库。安装成功后将自动启用，全程离线安全。" })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "12px",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							variant: "primary",
							disabled: !status?.canInstall || isActing,
							busy: isActing,
							onClick: () => void store.install(),
							children: "一键安装 ECDICT"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "12px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "耗时约 10–30 秒，取决于网络及磁盘速度。"
						})]
					})] }),
					actionError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						style: {
							marginTop: "14px",
							padding: "10px 14px",
							borderRadius: "8px",
							background: "rgba(239, 68, 68, 0.12)",
							border: "1px solid rgba(239, 68, 68, 0.3)",
							color: "var(--wl-set-error, #ef4444)",
							fontSize: "12.5px",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["操作异常: ", actionError] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							size: "small",
							variant: "ghost",
							onClick: () => store.clearActionError(),
							children: "忽略"
						})]
					}),
					status?.lastOperation?.status === "failed" && !isOperationRunning && !actionError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						style: {
							marginTop: "14px",
							padding: "10px 14px",
							borderRadius: "8px",
							background: "rgba(239, 68, 68, 0.12)",
							border: "1px solid rgba(239, 68, 68, 0.3)",
							color: "var(--wl-set-error, #ef4444)",
							fontSize: "12.5px"
						},
						children: [
							"最近一次操作失败: ",
							status.lastOperation.error?.message ?? "安装过程发生未知异常",
							status.lastOperation.error?.retryable && " (可点击安装重试)"
						]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "手势与自动查词",
				description: "配置在浏览和编辑时通过鼠标手势自动触发查词。设置修改后实时生效，无需重启应用。",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "双击自动查词",
					description: "在页面中双击选中英文单词后自动弹出词典卡片展示释义",
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
						id: "switch-auto-double-click",
						label: "双击自动查词",
						checked: formValues.autoDoubleClick,
						onChange: handleToggleDoubleClick
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "拖拽框选自动查词",
					description: "使用鼠标拖拽划选一段英文文本后，在释放鼠标时自动触发查词",
					isLast: true,
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
						id: "switch-auto-selection",
						label: "拖拽框选自动查词",
						checked: formValues.autoSelection,
						onChange: handleToggleSelection
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "快捷键与高级功能",
				description: "查看当前查词快捷键与高级自定义词库扩展计划。",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "划词查询快捷键",
					description: platform === "linux" ? "Linux Web 平台受浏览器系统快捷键限制，默认未绑定。自定义快捷键功能将在 Phase 7A.8 开放。" : "选中任意文本后按下快捷键即可发起词典查询。自定义快捷键将在 Phase 7A.8 开放。",
					control: platform === "linux" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
						variant: "neutral",
						label: "未绑定 (Unbound)"
					}) : platform === "macos" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: "13px",
							fontWeight: 600,
							fontFamily: "monospace",
							padding: "3px 8px",
							borderRadius: "6px",
							background: "rgba(255, 255, 255, 0.08)",
							color: "var(--wl-set-text-main, #f2f2f7)"
						},
						children: "⌘ + Shift + L"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: "13px",
							fontWeight: 600,
							fontFamily: "monospace",
							padding: "3px 8px",
							borderRadius: "6px",
							background: "rgba(255, 255, 255, 0.08)",
							color: "var(--wl-set-text-main, #f2f2f7)"
						},
						children: "Ctrl + Shift + L"
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "自定义外部 SQLite 词典",
					description: "允许指定本地用户自建或专业领域的 SQLite 词库文件，通过校验后无缝挂载使用。",
					isLast: true,
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
						variant: "neutral",
						label: "Phase 7A.8 开放"
					})
				})]
			}),
			showRemoveConfirm && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModalConfirm, {
				title: "确认移除 ECDICT 本地词典？",
				message: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "移除操作将安全删除本地托管的 ECDICT SQLite 数据库文件并释放存储空间。插件将自动回退到内置基础词典 (Fixture)。该操作不会影响任何用户自有的自定义文件。" }),
				confirmLabel: "确认移除",
				cancelLabel: "取消",
				isDanger: true,
				onConfirm: () => {
					setShowRemoveConfirm(false);
					store.remove();
				},
				onCancel: () => setShowRemoveConfirm(false)
			})
		]
	});
}
/**
* Narrow a DOM `MouseEvent.detail` value to a {@link ClickMultiplicity}.
*
* @param detail - the `detail` of a `mousedown`, if there was one.
* @returns `single` for a first click, `multi` for a second or later click, and
* `unknown` for anything this build has not measured.
*/
function clickMultiplicityOf(detail) {
	if (detail === 1) return "single";
	if (typeof detail === "number" && Number.isFinite(detail) && detail >= 2) return "multi";
	return "unknown";
}
/**
* Narrow a DOM `pointerType` string to a {@link PointerKind}.
*
* @param pointerType - the `PointerEvent.pointerType` value, if any.
* @returns the narrowed kind; `unknown` for anything not measured.
*/
function pointerKind(pointerType) {
	if (pointerType === "mouse" || pointerType === "pen" || pointerType === "touch") return pointerType;
	return "unknown";
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
	moved: 0,
	gestureId: 0,
	sequence: 0,
	pointerType: "unknown",
	classifiedId: 0,
	promotable: false,
	clickMultiplicity: "unknown"
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
		pointer: state.pointer,
		gestureId: state.gestureId,
		clickMultiplicity: state.clickMultiplicity
	};
}
/**
* Project the classifier state onto the classification a trigger gate consumes.
*
* `null` means "there is nothing to offer": nothing has been classified yet, or
* a press is in flight and has not produced a verdict of its own, or the gesture
* was abandoned. A state that still carries an **earlier** verdict offers it
* again under that verdict's own identity, so a gate that de-duplicates by
* identity can only ever act on it once — re-reading is safe, re-acting is not.
*
* @param state - the classifier state.
* @returns the classification, or `null` when there is none to offer.
*/
function classificationOf(state) {
	if (state.classifiedId === 0 || state.completedAt === null || state.kind === "none") return null;
	return {
		id: state.classifiedId,
		kind: state.kind,
		pointerType: state.pointerType,
		clickMultiplicity: state.clickMultiplicity,
		at: state.completedAt
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
* Opening a gesture **allocates its identity**. That is the whole reason the
* allocation lives here rather than at classification time: the two pointer
* presses of a double click are two sequences with two identities, and the
* `dblclick` that follows the second one can be attributed to it exactly.
*
* The previous classification is deliberately preserved: the snapshot always
* describes the last *completed* gesture, so opening a new one does not blank
* what the reader last did.
*
* @param state - the current state.
* @param point - the press position.
* @param button - the DOM `button` value; `0` is the primary button.
* @param pointerType - the pointer kind that produced the press.
* @returns the next state.
*/
function beginPointer(state, point, button = 0, pointerType = "unknown") {
	if (button !== 0) return state;
	const sequence = state.sequence + 1;
	return {
		...state,
		phase: "tracking",
		originX: point.x,
		originY: point.y,
		moved: 0,
		sequence,
		gestureId: sequence,
		pointerType,
		classifiedId: 0,
		promotable: false,
		clickMultiplicity: "unknown"
	};
}
/**
* Attach the platform's click multiplicity to the press that is in flight.
*
* The browser dispatches `pointerdown` and then the compatibility `mousedown`
* that carries `detail`, so the press's identity already exists when this is
* folded in. A `mousedown` that arrives with no press open (a right-button
* press, or a synthetic event) is ignored rather than recorded: it does not
* describe any sequence this classifier is tracking, and letting it overwrite
* the state would attribute one press's multiplicity to another's identity.
*
* Returns the same object when nothing changed, so a caller may assign the
* result unconditionally.
*
* @param state - the current state.
* @param detail - the `MouseEvent.detail` of the press.
* @returns the next state.
*/
function attachClickMultiplicity(state, detail) {
	if (state.phase !== "tracking") return state;
	const clickMultiplicity = clickMultiplicityOf(detail);
	if (clickMultiplicity === state.clickMultiplicity) return state;
	return {
		...state,
		clickMultiplicity
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
* The identity is carried over unchanged: a release classifies the gesture the
* press opened, and it is never given an identity of its own. It is also
* recorded as the identity this verdict was produced for, so nothing downstream
* can pair the verdict with a later press's identity.
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
		moved: 0,
		gestureId: state.gestureId,
		sequence: state.sequence,
		pointerType: state.pointerType,
		classifiedId: state.gestureId,
		promotable: true,
		clickMultiplicity: state.clickMultiplicity
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
* **Identity.** `dblclick` is reported by the platform after the second release,
* so when it promotes a sequence the state is still carrying — an open press, or
* the release that has just been folded — that sequence's identity is reused
* rather than replaced. The first press of the pair keeps the identity it was
* given when it opened, and — since a short release is `other` — never produces a
* lookup of its own.
*
* When it promotes nothing (an engine, an extension or an automation agent that
* delivers `dblclick` without pointer events) a **fresh** identity is allocated,
* so two such double clicks stay two gestures and each can produce its own
* lookup rather than the second being swallowed as a duplicate of the first.
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
	const promoted = (state.phase === "tracking" || state.promotable) && state.gestureId !== 0;
	const sequence = promoted ? state.sequence : state.sequence + 1;
	const gestureId = promoted ? state.gestureId : sequence;
	return {
		kind: hasEligibleSelection ? "double-click" : "other",
		completedAt: point.at,
		pointer,
		phase: "sealed",
		originX: 0,
		originY: 0,
		moved: 0,
		gestureId,
		sequence,
		pointerType: state.pointerType,
		classifiedId: gestureId,
		promotable: false,
		clickMultiplicity: state.clickMultiplicity
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
* What it also drops is the *offer*: an abandoned gesture has no verdict to hand
* to a trigger gate, so a stray release arriving afterwards cannot re-offer the
* previous gesture's classification.
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
		moved: 0,
		classifiedId: 0,
		promotable: false,
		clickMultiplicity: "unknown"
	};
}
/** The observation before any event, frozen because it is the shared initial value. */
const IDLE_OBSERVATION = Object.freeze({
	state: IDLE_GESTURE,
	counters: Object.freeze({
		pointerdowns: 0,
		pointerups: 0,
		mouseDowns: 0,
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
* @param pointerType - the pointer kind that produced the press.
* @returns the next observation.
*/
function observePointerDown(observation, point, button = 0, pointerType = "unknown") {
	const state = beginPointer(observation.state, point, button, pointerType);
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
* Fold the platform's click multiplicity into the observation.
*
* A non-primary press is ignored, matching {@link beginPointer}: a right-click
* opens no sequence here, so its multiplicity describes nothing this classifier
* tracks and must not be attached to a left press that happens to be in flight.
*
* @param observation - the current observation.
* @param detail - the `MouseEvent.detail` of the press.
* @param button - the DOM `button` value; `0` is the primary button.
* @returns the next observation.
*/
function observeMouseDown(observation, detail, button = 0) {
	if (button !== 0) return observation;
	const state = attachClickMultiplicity(observation.state, detail);
	if (state === observation.state) return observation;
	return {
		state,
		counters: {
			...observation.counters,
			mouseDowns: observation.counters.mouseDowns + 1
		}
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
//#region src/client/lookup.ts
/** The origins, in a fixed order, so a report can iterate over all of them. */
const LOOKUP_ORIGINS = Object.freeze([
	"shortcut",
	"auto-selection",
	"auto-double-click"
]);
/**
* Owns request identity, supersession, surface generation, and the card's published state.
*
* One instance per plugin lifecycle. {@link LookupController.dispose} makes every
* outstanding request stale, so a lookup that outlives an unload cannot republish
* into a store the next lifecycle now owns.
*/
var LookupController = class {
	#store;
	#request;
	#createAbortController;
	#counts = {
		shortcut: 0,
		"auto-selection": 0,
		"auto-double-click": 0
	};
	/** Monotonic allocator. Never decreases, never reused. */
	#issued = 0;
	/** The request allowed to publish; `0` when none is (initially, and after dispose). */
	#owner = 0;
	/** The request in flight, kept only so the next one can abort it. */
	#inflight = null;
	#lastOutcome = null;
	/**
	* @param options - the card store, the request function and the abort factory.
	*/
	constructor(options) {
		this.#store = options.store;
		this.#request = options.request;
		this.#createAbortController = options.createAbortController ?? (() => new AbortController());
	}
	/**
	* Issue one lookup for a query the caller already qualified.
	*
	* The card moves to `loading` for this query synchronously, before the request
	* is awaited, so a caller can observe the new owner immediately. When the
	* request settles it publishes **only if it is still the owner AND its generation
	* has not been dismissed**; otherwise it is dropped, success and failure alike.
	*
	* The returned promise never rejects: a transport that throws is turned into
	* the same `network` failure the transport itself reports, so an automatic
	* gesture can never surface an unhandled rejection.
	*
	* @param query - raw selected text; the host normalizes it.
	* @param origin - which path asked, for client-side accounting.
	* @param anchorRect - selection bounds captured at gesture time, or null.
	* @returns settlement after the card has been updated, or after this request
	* was recognised as stale or dismissed.
	*/
	async run(query, origin, anchorRect = null) {
		this.#issued += 1;
		const id = this.#issued;
		this.#owner = id;
		const gen = this.#store.beginGeneration(anchorRect);
		this.#counts[origin] += 1;
		this.#inflight?.abort();
		const controller = this.#createAbortController();
		this.#inflight = controller;
		this.#store.set({
			status: "loading",
			query
		});
		let outcome;
		try {
			outcome = await this.#request(query, controller.signal);
		} catch (error) {
			outcome = {
				kind: "network",
				message: error instanceof Error ? error.message : String(error)
			};
		}
		if (this.#owner !== id) return;
		if (this.#store.isDismissed(gen)) return;
		this.#inflight = null;
		this.#lastOutcome = outcome.kind;
		if (outcome.kind === "aborted" || outcome.kind === "network") {
			this.#store.set({
				status: "failed",
				query,
				failure: outcome
			});
			return;
		}
		this.#store.set({
			status: "ready",
			query,
			result: outcome
		});
	}
	/**
	* Dismiss the active surface. Aborts any request in flight and clears store.
	*/
	dismiss() {
		this.#inflight?.abort();
		this.#inflight = null;
		this.#store.clear();
	}
	/** @returns the identity of the request that owns the card; `0` when none does. */
	current() {
		return this.#owner;
	}
	/** @returns how many lookups have been issued in total. */
	issued() {
		return this.#issued;
	}
	/** @returns the active or last issued surface generation. */
	generation() {
		return this.#store.currentGeneration();
	}
	/** @returns how many lookups have been issued, by origin. */
	counts() {
		return { ...this.#counts };
	}
	/** @returns the discriminant of the outcome the card is showing, or `null`. */
	lastOutcome() {
		return this.#lastOutcome;
	}
	/**
	* Whether the card is waiting on the request that owns it.
	*
	* Read from the card's own snapshot rather than shadowed here: there is exactly
	* one loading state in this plugin, and it belongs to the owner that published
	* it.
	*
	* @returns whether the owning request is still pending.
	*/
	loading() {
		return this.#store.getSnapshot().status === "loading";
	}
	/** @returns the card state, for diagnostics and tests. */
	card() {
		return this.#store.getSnapshot();
	}
	/**
	* Abandon the request in flight and refuse every later publication.
	*
	* Called from the runtime's disposer. After it, a resolving request finds
	* itself superseded and publishes nothing.
	*/
	dispose() {
		this.#owner = 0;
		this.#inflight?.abort();
		this.#inflight = null;
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
	#anchorRect = null;
	#currentGeneration = 0;
	#dismissedGeneration = 0;
	#listeners = /* @__PURE__ */ new Set();
	/**
	* @returns the current snapshot. The reference is stable until {@link set} or {@link clear}.
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
	/**
	* Return the card to its idle, zero-render state and mark the active
	* surface generation as dismissed.
	*/
	clear() {
		this.#dismissedGeneration = Math.max(this.#dismissedGeneration, this.#currentGeneration);
		this.#state = { status: "idle" };
		for (const listener of [...this.#listeners]) listener();
	}
	/**
	* Explicitly dismiss the current surface.
	*/
	dismiss() {
		this.clear();
	}
	/**
	* Advance the active surface generation for a new lookup.
	*
	* @param anchorRect - Selection rectangle captured at trigger time.
	* @returns the newly allocated surface generation number.
	*/
	beginGeneration(anchorRect = null) {
		this.#currentGeneration += 1;
		this.#anchorRect = anchorRect;
		return this.#currentGeneration;
	}
	/**
	* Whether a given generation has been dismissed.
	*
	* @param generation - the request surface generation.
	* @returns true if this generation was dismissed.
	*/
	isDismissed(generation) {
		if (typeof generation !== "number") return false;
		return generation <= this.#dismissedGeneration;
	}
	/** @returns the latest captured anchor rectangle, or null. */
	anchorRect() {
		return this.#anchorRect;
	}
	/** @returns the highest seen surface generation. */
	currentGeneration() {
		return this.#currentGeneration;
	}
	/** @returns the highest dismissed surface generation. */
	dismissedGeneration() {
		return this.#dismissedGeneration;
	}
};
//#endregion
//#region src/client/trigger.ts
/** A capture that found nothing usable. Frozen because it is the shared literal. */
const EMPTY_SELECTION = Object.freeze({
	eligible: false,
	text: "",
	rect: null
});
/** The ledger before any gesture has been consumed. */
const EMPTY_LEDGER = Object.freeze({ consumed: Object.freeze([]) });
/**
* Whether an identity has already produced an automatic lookup.
*
* @param ledger - the consumption record.
* @param gestureId - the identity to test.
* @returns whether it was already consumed.
*/
function isConsumed(ledger, gestureId) {
	return ledger.consumed.includes(gestureId);
}
/**
* Record one identity as consumed, keeping the record bounded.
*
* @param ledger - the consumption record.
* @param gestureId - the identity to record.
* @returns the next record.
*/
function consumeGesture(ledger, gestureId) {
	return { consumed: [gestureId, ...ledger.consumed].slice(0, 32) };
}
/**
* Decide whether a completed gesture may become an automatic lookup.
*
* The order of the checks is part of the contract:
*
* 1. a classification has to exist at all;
* 2. only `drag` and `double-click` are trigger gestures — a plain click is
*    `other` and must never become one, which is what keeps a single click from
*    reaching the dictionary;
* 3. an identity already consumed stays consumed, whatever the switches say,
*    so one gesture can never buy two lookups;
* 4. the switch that owns this gesture must be on **now** — read from the value
*    passed in, never from a value captured at plugin load;
* 5. the pointer kind must be one this build has measured. Phase 4 verified
*    `mouse`; `pen`, `touch` and an unidentifiable pointer are refused rather
*    than guessed at, because an unverified gesture type must not produce
*    automatic I/O;
* 6. an `auto-selection` lookup additionally requires the platform's own click
*    counter to say the press was a **single** click. This is step 6 rather than
*    an earlier one on purpose: a `drag` classification is a movement fact, and
*    only the drag path cares whose press it was. A `double-click`
*    classification is the platform's own recognition and is answered by its own
*    switch;
* 7. the selection captured at completion must be eligible and non-empty.
*
* Step 6 is what keeps the two switches semantically independent. A double click
* whose second press drifted past the drag threshold is still classified `drag`
* by movement, and the platform still reports it as a multi-click press; without
* this check the drag path would consume the identity, and the `dblclick` that
* followed — the platform's own, unambiguous recognition of the gesture the
* reader made — would be refused as a duplicate of it. The reader asked for
* `autoDoubleClick` semantics and would have got `autoSelection`'s.
*
* The refusal is deliberately the *safe* direction in the ambiguous cases: a
* press reported as part of a multi-click sequence that never completes one
* produces no automatic lookup at all, and neither does a press whose
* multiplicity was never observed. (Phase 4.1 measured that this Chromium emits
* its `dblclick` from the press's click count, so the first shape is hard to
* produce through automation input; the rule exists for the platforms and input
* paths where it is not.) A missed automatic lookup is recoverable with the
* manual command; an unexpected one is the thing both switches exist to
* prevent.
*
* A refusal never consumes the identity unless it was already consumed. That is
* what lets `autoSelection` be switched on and the *next* drag work, and it is
* why a double click whose second release was classified as `other` is still
* free to be consumed by its own `dblclick`.
*
* @param input - the classification and the selection captured with it.
* @param gates - the switch values as they are right now.
* @param ledger - the identities consumed so far.
* @returns the decision and the ledger to carry forward.
*/
function evaluateAutomaticTrigger(input, gates, ledger) {
	const classification = input.classification;
	if (classification === null) return {
		decision: "ignored",
		reason: "no-classification",
		origin: null,
		query: "",
		gestureId: 0,
		ledger
	};
	const gestureId = classification.id;
	const origin = classification.kind === "drag" ? "auto-selection" : classification.kind === "double-click" ? "auto-double-click" : null;
	if (origin === null) return {
		decision: "ignored",
		reason: "not-a-trigger-gesture",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	if (isConsumed(ledger, gestureId)) return {
		decision: "ignored",
		reason: "duplicate-gesture",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	if (!(origin === "auto-selection" ? gates.autoSelection : gates.autoDoubleClick)) return {
		decision: "ignored",
		reason: "switch-off",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	if (classification.pointerType !== "mouse") return {
		decision: "ignored",
		reason: "unverified-pointer-kind",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	if (origin === "auto-selection" && classification.clickMultiplicity !== "single") return {
		decision: "ignored",
		reason: classification.clickMultiplicity === "multi" ? "multi-click-sequence" : "unverified-click-multiplicity",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	const selection = input.selection;
	if (!selection.eligible || selection.text.trim() === "") return {
		decision: "ignored",
		reason: "ineligible-selection",
		origin: null,
		query: "",
		gestureId,
		ledger
	};
	return {
		decision: "lookup",
		reason: "accepted",
		origin,
		query: selection.text,
		gestureId,
		ledger: consumeGesture(ledger, gestureId)
	};
}
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
/** Registration id of the dictionary settings section in DSH settings. */
const SETTINGS_SECTION_ID = "dictionary";
/**
* Ascending render order inside `settings.section`.
* Placed at 80 to appear naturally in the settings nav list.
*/
const SETTINGS_SECTION_ORDER = 80;
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
		/** The trigger gate's memory of which gesture identities it has consumed. */
		let ledger = EMPTY_LEDGER;
		/** The last automatic evaluation, accepted or refused; `null` before any. */
		let lastTrigger = null;
		/**
		* The selection captured with that evaluation.
		*
		* Recorded separately from the decision because the decision deliberately
		* reports a query only when it accepted one: "the gate refused this gesture"
		* and "the gate was handed the wrong text" produce the same request count and
		* are only distinguishable if the capture is kept.
		*/
		let lastCapture = EMPTY_SELECTION;
		const lookup = new LookupController({
			store,
			request: requestLookup
		});
		const mgmtStore = new DictionaryManagementStore();
		disposer.add(() => mgmtStore.dispose());
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
		* Issue one lookup.
		*
		* The thinnest possible wrapper: request identity, supersession and the
		* stale-result policy all live in {@link LookupController}, and this exists
		* only so the two call sites below read alike.
		*
		* @param query - raw selected text; the host normalizes it.
		* @param origin - which path asked, for client-side accounting.
		* @param rect - selection bounding box captured at trigger time, or null.
		*/
		const runLookup = (query, origin, rect = null) => {
			lookup.run(query, origin, rect);
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
		let settingsSectionDeclarationSeen = false;
		let settingsSectionRegistrationCount = 0;
		disposer.add(ctx.slots.inject("settings.section", () => {
			settingsSectionDeclarationSeen = true;
			const unregister = ctx.slots.register({
				name: "settings.section",
				id: SETTINGS_SECTION_ID,
				order: 80,
				label: () => {
					return (typeof document !== "undefined" && document.documentElement?.lang || typeof navigator !== "undefined" && (navigator.language || navigator.languages?.[0]) || "zh").toLowerCase().startsWith("en") ? "Dictionary" : "词典";
				},
				inject: () => ({
					store: mgmtStore,
					form
				})
			}, DictionarySettingsSection);
			settingsSectionRegistrationCount += 1;
			return () => {
				settingsSectionRegistrationCount -= 1;
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
						runLookup(selection.text, "shortcut", selection.rect);
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
		const captureSelection = () => {
			const selection = readEligibleSelection(document);
			if (selection === null) return EMPTY_SELECTION;
			return {
				eligible: true,
				text: selection.text,
				rect: selection.rect
			};
		};
		/**
		* Offer one completed classification to the gate and act on its decision.
		*
		* @param selection - the selection captured in the same event.
		*/
		const considerAutomatic = (selection) => {
			lastCapture = selection;
			const decision = evaluateAutomaticTrigger({
				classification: classificationOf(gesture.state),
				selection
			}, gates, ledger);
			ledger = decision.ledger;
			lastTrigger = decision;
			if (decision.decision === "lookup" && decision.origin !== null) runLookup(decision.query, decision.origin, selection.rect);
		};
		const onPointerDown = (event) => {
			gesture = observePointerDown(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, event.button, pointerKind(event.pointerType));
		};
		const onMouseDown = (event) => {
			gesture = observeMouseDown(gesture, event.detail, event.button);
		};
		const onPointerMove = (event) => {
			gesture = observePointerMove(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			});
		};
		const onPointerUp = (event) => {
			const selection = captureSelection();
			const previous = gesture.state;
			gesture = observePointerUp(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, selection.eligible);
			if (gesture.state !== previous) considerAutomatic(selection);
		};
		const onDoubleClick = (event) => {
			const selection = captureSelection();
			gesture = observeDoubleClick(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, selection.eligible);
			considerAutomatic(selection);
		};
		const onCancelGesture = () => {
			gesture = observeCancel(gesture);
		};
		const GESTURE_OPTIONS = { capture: true };
		document.addEventListener("pointerdown", onPointerDown, GESTURE_OPTIONS);
		document.addEventListener("mousedown", onMouseDown, GESTURE_OPTIONS);
		document.addEventListener("pointermove", onPointerMove, GESTURE_OPTIONS);
		document.addEventListener("pointerup", onPointerUp, GESTURE_OPTIONS);
		document.addEventListener("pointercancel", onCancelGesture, GESTURE_OPTIONS);
		document.addEventListener("dblclick", onDoubleClick, GESTURE_OPTIONS);
		window.addEventListener("blur", onCancelGesture);
		disposer.add(() => {
			document.removeEventListener("pointerdown", onPointerDown, GESTURE_OPTIONS);
			document.removeEventListener("mousedown", onMouseDown, GESTURE_OPTIONS);
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
			settingsSection: () => ({
				entryId: SETTINGS_SECTION_ID,
				order: 80,
				declarationSeen: settingsSectionDeclarationSeen,
				registrationCount: settingsSectionRegistrationCount,
				store: mgmtStore
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
			lookups: () => lookup.issued(),
			surfaceGeneration: () => lookup.generation(),
			dismiss: () => lookup.dismiss(),
			runLookup: (query, origin = "shortcut") => lookup.run(query, origin),
			lookupsByOrigin: () => lookup.counts(),
			origins: () => LOOKUP_ORIGINS,
			trigger: () => lastTrigger === null ? null : {
				decision: lastTrigger.decision,
				reason: lastTrigger.reason,
				origin: lastTrigger.origin,
				gestureId: lastTrigger.gestureId,
				query: lastTrigger.query
			},
			capture: () => ({
				eligible: lastCapture.eligible,
				text: lastCapture.text,
				rect: lastCapture.rect
			}),
			requestId: () => lookup.current(),
			loading: () => lookup.loading(),
			card: () => lookup.card(),
			lastOutcome: () => lookup.lastOutcome(),
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
			lookup.dispose();
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
exports.SETTINGS_SECTION_ID = SETTINGS_SECTION_ID;
exports.SETTINGS_SECTION_ORDER = SETTINGS_SECTION_ORDER;
exports.apply = apply;
exports.inject = inject;
exports.namespace = namespace;

		return module.exports;
	}
});