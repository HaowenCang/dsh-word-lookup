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
* Known part-of-speech abbreviations commonly found at the beginning of
* dictionary translation and definition lines.
*
* Ordered with compound or multi-letter abbreviations first to ensure
* greedy and unambiguous matching before single-letter tags.
*/
const POS_TAG_PATTERN = "(?:vt|vi|adj|adv|prep|pron|conj|interj|int|num|art|aux|abbr|sing|pref|suff|link-v|cop|pl|a|ad|n|v)";
/**
* Matches bare POS tags ending with a period and a lexical boundary:
* - Followed by one or more whitespace characters, e.g. "n. 穿过", "vt. 通过", "v.& n. 穿过", "a. 好的"
* - Followed immediately by a Chinese character without whitespace per dictionary convention, e.g. "n.穿过", "vt.打倒"
* - Ending at the boundary/end of the line, e.g. "n."
*
* Rejects non-POS plain text such as "n.example" or "v.2026".
*/
const BARE_POS_REGEX = new RegExp(`^${`(?:${POS_TAG_PATTERN}\\.?(?:\\s*(?:&|\\/)\\s*))*${POS_TAG_PATTERN}\\.`}(?:\\s+|$|(?=[\\u4e00-\\u9fa5]))`, "i");
const BRACKETED_COMPOUND_POS_PATTERN = `(?:${POS_TAG_PATTERN}\\.?(?:\\s*(?:&|\\/)\\s*))*${POS_TAG_PATTERN}\\.?`;
/**
* Matches bracketed POS tags with optional period, e.g.
* - "[n.] 穿过"
* - "[n] 穿过"
* - "(vt.) 通过"
* - "(vi) 经过"
*/
const BRACKETED_POS_REGEX = new RegExp(`^(?:\\[${BRACKETED_COMPOUND_POS_PATTERN}\\]|\\(${BRACKETED_COMPOUND_POS_PATTERN}\\))\\s*`, "i");
/**
* Matches non-empty Chinese bracketed POS tags, e.g.
* - "【动】 穿过"
* - "【名】 关口"
* - "【名词】 关口"
*
* Disallows empty bracket pairs such as "【】", "〔〕", or "（）".
*/
const CJK_BRACKETED_POS_REGEX = /^(?:【(?:名|动|形|副|代|介|连|感|叹|数|量|冠|助|缩)词?】|〔(?:名|动|形|副|代|介|连|感|叹|数|量|冠|助|缩)词?〕|（(?:名|动|形|副|代|介|连|感|叹|数|量|冠|助|缩)词?）)\s*/;
/**
* Determine whether a translation or definition line begins with an explicit part-of-speech prefix.
*
* Restricted strictly to line beginnings using a closed set of known POS abbreviations.
* Avoids misidentifying ordinary English or Chinese words (e.g. "apple", "a method", "1. item").
*
* @param line - One line of dictionary translation or definition text.
* @returns True if the line starts with an explicit POS marker; false otherwise.
*/
function hasExplicitPosPrefix(line) {
	if (!line) return false;
	const trimmed = line.trim();
	return BARE_POS_REGEX.test(trimmed) || BRACKETED_POS_REGEX.test(trimmed) || CJK_BRACKETED_POS_REGEX.test(trimmed);
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
* Split dictionary definitions or translations into distinct, displayable lines.
*
* Normalizes multiple newline conventions without multiple or recursive unescaping passes:
* - Real LF (`\n`), CRLF (`\r\n`), CR (`\r`)
* - Escaped string literals `\n`, `\r\n`, `\r`
* - Controlled tab (`\t` and `\t`) substitution (normalized to single space)
* - Preserves double-escaped backslashes (`\\n` remains literal `\n`)
* - Preserves legitimate backslashes (e.g. `\lambda`, `C:\dir`)
* - Trims individual lines and collapses consecutive empty lines
*
* Data Contract & Parsing Rules:
*
* 1. ECDICT Source Data Observation:
*    ECDICT database fields have been observed to use literal two-character sequences `\n`
*    and `\r\n` to encode multiline glosses without embedding raw control characters into
*    CSV records.
*
* 2. Plugin Parsing Rules:
*    To uniformly support both standard control characters (raw LF `\n`, CRLF `\r\n`)
*    and ECDICT-style literal escapes, this plugin's parser treats unescaped `\n` and `\r\n`
*    sequences as line breaks, while preserving double-escaped `\\n` as literal `\n`.
*
* 3. Custom SQLite & Upstream Corpora Boundary:
*    This parsing behavior is an intentional design choice of this plugin, not a universal
*    guarantee provided by all upstream dictionary corpora or user-imported SQLite databases.
*    Custom SQLite dictionaries imported by users may contain unescaped backslashes before `n`
*    or `r` (e.g. LaTeX `\nu`, `\rho`, or Windows paths `C:\new`, `C:\reports`). Under this
*    plugin's parsing rules, these sequences will be treated as line delimiters unless authoring
*    pipelines or custom importers double-escape them (`\\nu`, `\\rho`, `C:\\new`).
*
* @param text - The raw translation or definition string, or null/undefined.
* @returns Array of non-empty line strings.
*/
function splitDefinitionLines(text) {
	if (text === null || text === void 0) return [];
	const lines = [];
	let currentLine = "";
	const len = text.length;
	let i = 0;
	const pushCurrentLine = () => {
		const trimmed = currentLine.trim();
		if (trimmed.length > 0) lines.push(trimmed);
		currentLine = "";
	};
	while (i < len) {
		const c = text[i];
		if (c === "\r") {
			if (i + 1 < len && text[i + 1] === "\n") i += 2;
			else i += 1;
			pushCurrentLine();
			continue;
		}
		if (c === "\n") {
			i += 1;
			pushCurrentLine();
			continue;
		}
		if (c === "	") {
			currentLine += " ";
			i += 1;
			continue;
		}
		if (c === "\\") {
			let backslashCount = 0;
			while (i < len && text[i] === "\\") {
				backslashCount += 1;
				i += 1;
			}
			const literalBackslashes = Math.floor(backslashCount / 2);
			if (literalBackslashes > 0) currentLine += "\\".repeat(literalBackslashes);
			if (backslashCount % 2 === 1) {
				if (i < len) {
					const next = text[i];
					if (next === "n") {
						i += 1;
						pushCurrentLine();
						continue;
					} else if (next === "r") {
						i += 1;
						if (i < len && text[i] === "\n") i += 1;
						else if (i + 1 < len && text[i] === "\\" && text[i + 1] === "n") i += 2;
						pushCurrentLine();
						continue;
					} else {
						currentLine += "\\" + next;
						i += 1;
						continue;
					}
				} else {
					currentLine += "\\";
					continue;
				}
			}
			continue;
		}
		currentLine += c;
		i += 1;
	}
	pushCurrentLine();
	return lines;
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
						const transLines = meaning.translation ? splitDefinitionLines(meaning.translation) : [];
						const defLines = meaning.definition ? splitDefinitionLines(meaning.definition) : [];
						const firstLineHasPos = transLines.length > 0 && hasExplicitPosPrefix(transLines[0]);
						const posBadge = Boolean(meaning.partOfSpeech && !firstLineHasPos) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								display: "inline-block",
								padding: "1px 5px",
								marginRight: "6px",
								borderRadius: "3px",
								background: "var(--wl-tag-bg, rgba(255,255,255,0.08))",
								color: "var(--wl-tag-fg, #d0d0dc)",
								fontSize: "11px",
								fontWeight: 600,
								fontStyle: "italic",
								verticalAlign: "baseline"
							},
							children: meaning.partOfSpeech
						}) : null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: {
								marginBottom: "6px",
								fontSize: "13px"
							},
							children: [transLines.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								"data-dsh-word-lookup": "translation-block",
								children: transLines.map((line, lineIndex) => {
									const glosses = splitGlosses(line);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										"data-dsh-word-lookup": "translation-line",
										style: {
											lineHeight: "1.45",
											marginTop: lineIndex === 0 ? 0 : "3px"
										},
										children: [lineIndex === 0 ? posBadge : null, glosses.map((gloss, glossIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											"data-dsh-word-lookup": "gloss",
											children: [glossIndex === 0 ? "" : "；", gloss]
										}, String(glossIndex)))]
									}, String(lineIndex));
								})
							}) : posBadge ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									lineHeight: "1.45",
									marginBottom: "2px"
								},
								children: posBadge
							}) : null, defLines.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								"data-dsh-word-lookup": "definition-block",
								style: {
									marginTop: transLines.length > 0 || posBadge ? "4px" : 0,
									color: "var(--wl-fg-muted, #9898a6)",
									fontSize: "12px",
									lineHeight: "1.4"
								},
								children: defLines.map((defLine, defIndex) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									"data-dsh-word-lookup": "definition-line",
									style: { marginTop: defIndex === 0 ? 0 : "2px" },
									children: defLine
								}, String(defIndex)))
							}) : null]
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
/** Document-relative URL of custom snapshot removal endpoint (client-facing). */
const MANAGEMENT_REMOVE_CUSTOM_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/remove-custom";
/** Document-relative URL of dictionary verification endpoint (client-facing). */
const MANAGEMENT_VERIFY_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/verify";
/** Document-relative URL of custom dictionary activation endpoint (client-facing). */
const MANAGEMENT_ACTIVATE_CUSTOM_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/activate-custom";
/** Document-relative URL of dictionary operational mode selection endpoint (client-facing). */
const MANAGEMENT_SELECT_MODE_DOCUMENT_PATH = "api/dsh-word-lookup/dictionary/select-mode";
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
/**
* Verify a custom SQLite dictionary path.
*/
async function verifyCustomDictionary(path, signal) {
	return sendManagementRequest(MANAGEMENT_VERIFY_DOCUMENT_PATH, {
		method: "POST",
		body: { path },
		signal
	});
}
/**
* Activate a custom SQLite dictionary database from host path.
*/
async function activateCustomDictionary(path, identity, signal) {
	const body = {
		path,
		...identity ? { identity } : {}
	};
	return sendManagementRequest(MANAGEMENT_ACTIVATE_CUSTOM_DOCUMENT_PATH, {
		method: "POST",
		body,
		signal
	});
}
/**
* Switch operational dictionary mode between fixture, managed-ecdict, and custom snapshot.
*/
async function selectDictionaryMode(mode, snapshotId, signal) {
	const body = {
		mode,
		...snapshotId ? { snapshotId } : {}
	};
	return sendManagementRequest(MANAGEMENT_SELECT_MODE_DOCUMENT_PATH, {
		method: "POST",
		body,
		signal
	});
}
/**
* Remove an inactive custom dictionary snapshot by snapshot UUID.
*/
async function removeCustomDictionary(snapshotId, signal) {
	return sendManagementRequest(MANAGEMENT_REMOVE_CUSTOM_DOCUMENT_PATH, {
		method: "POST",
		body: { snapshotId },
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
	#pollAbortController = null;
	#actionControllers = /* @__PURE__ */ new Set();
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
		if (this.#pollAbortController !== null) {
			this.#pollAbortController.abort();
			this.#pollAbortController = null;
		}
		const controller = new AbortController();
		this.#pollAbortController = controller;
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
		} catch {} finally {
			if (this.#pollAbortController === controller) this.#pollAbortController = null;
			if (!this.#disposed && id === this.#requestId) this.#scheduleNextPoll();
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
		this.#actionControllers.add(controller);
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
			this.#actionControllers.delete(controller);
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
		this.#actionControllers.add(controller);
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
			this.#actionControllers.delete(controller);
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
		this.#actionControllers.add(controller);
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
			this.#actionControllers.delete(controller);
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
	* Request activation of a custom SQLite dictionary.
	*/
	async activateCustom(path, identity) {
		if (this.#disposed || this.#state.isActing) return false;
		this.#state = {
			...this.#state,
			isActing: true,
			actionError: null
		};
		this.#emit();
		const controller = new AbortController();
		this.#actionControllers.add(controller);
		try {
			const result = await activateCustomDictionary(path, identity, controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "激活自定义词典请求被取消";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			this.#actionControllers.delete(controller);
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
	* Request switching active dictionary mode (fixture, managed-ecdict, custom).
	*/
	async selectMode(mode, snapshotId) {
		if (this.#disposed || this.#state.isActing) return false;
		if (mode === "custom" && (!snapshotId || typeof snapshotId !== "string" || !snapshotId.trim())) {
			this.#state = {
				...this.#state,
				actionError: "切换至自定义词典必须指定明确的快照 ID"
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
		this.#actionControllers.add(controller);
		try {
			const result = await selectDictionaryMode(mode, snapshotId, controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "切换词典模式请求未完成";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			this.#actionControllers.delete(controller);
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
	* Request removal of an inactive custom dictionary snapshot.
	*/
	async removeCustom(snapshotId) {
		if (this.#disposed || this.#state.isActing) return false;
		this.#state = {
			...this.#state,
			isActing: true,
			actionError: null
		};
		this.#emit();
		const controller = new AbortController();
		this.#actionControllers.add(controller);
		try {
			const result = await removeCustomDictionary(snapshotId, controller.signal);
			if (this.#disposed) return false;
			if (result.ok) {
				await this.refresh();
				return true;
			}
			const errMsg = result.kind === "refused" ? result.message : result.kind === "network" ? `网络异常: ${result.message}` : "删除自定义词典快照未完成";
			this.#state = {
				...this.#state,
				actionError: errMsg
			};
			this.#emit();
			return false;
		} finally {
			this.#actionControllers.delete(controller);
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
	* Verify candidate custom SQLite dictionary file.
	*/
	async verifyCustom(path) {
		const controller = new AbortController();
		this.#actionControllers.add(controller);
		try {
			return await verifyCustomDictionary(path, controller.signal);
		} finally {
			this.#actionControllers.delete(controller);
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
	/** Whether this store has been disposed. */
	get isDisposed() {
		return this.#disposed;
	}
	/** Whether a background polling timer is currently scheduled. */
	get hasScheduledTimer() {
		return this.#timer !== null;
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
		if (this.#pollAbortController !== null) {
			this.#pollAbortController.abort();
			this.#pollAbortController = null;
		}
		for (const controller of this.#actionControllers) controller.abort();
		this.#actionControllers.clear();
		if (typeof window !== "undefined") window.removeEventListener("focus", this.#onWindowFocus);
		this.#listeners.clear();
	}
};
//#endregion
//#region src/client/contracts.ts
/** The first-class manual lookup command ID registered into DSH shortcuts. */
const LOOKUP_COMMAND_ID$1 = "wordLookup.lookupSelection";
//#endregion
//#region src/client/settings/snapshot-eligibility.ts
/** Host validity is authoritative; corrupt is an optional compatibility veto. */
function isSnapshotActivatable(snapshot) {
	return snapshot.isValid === true && snapshot.corrupt !== true;
}
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
	const lastToggleTimeRef = react.default.useRef(0);
	const toggle = () => {
		if (disabled) return;
		const now = Date.now();
		if (now - lastToggleTimeRef.current < 80) return;
		lastToggleTimeRef.current = now;
		onChange(!checked);
	};
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
		if (e.key === " ") {
			e.preventDefault();
			toggle();
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
		onClick: toggle,
		onKeyDown: handleKeyDown,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: thumbStyle,
			"aria-hidden": "true"
		})
	});
}
function ActionButton({ children, onClick, variant = "secondary", disabled = false, busy = false, size = "medium", ariaLabel, title, "data-testid": testId }) {
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
		"data-testid": testId,
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
		onKeyDown: (e) => {
			if (!disabled && !busy && (e.key === "Enter" || e.key === " ")) {
				e.preventDefault();
				e.stopPropagation();
				onClick?.();
			}
		},
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
	const dialogRef = react.default.useRef(null);
	const previousActiveElementRef = react.default.useRef(null);
	const onCancelRef = react.default.useRef(onCancel);
	react.default.useEffect(() => {
		onCancelRef.current = onCancel;
	}, [onCancel]);
	react.default.useEffect(() => {
		if (typeof document !== "undefined") previousActiveElementRef.current = document.activeElement;
		const timer = setTimeout(() => {
			if (dialogRef.current) {
				const focusable = dialogRef.current.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])");
				if (focusable.length > 0) focusable[0]?.focus();
				else dialogRef.current.focus();
			}
		}, 10);
		const handleGlobalKeyDown = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onCancelRef.current();
				return;
			}
			if (e.key === "Tab" && dialogRef.current) {
				const focusable = Array.from(dialogRef.current.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"));
				if (focusable.length === 0) {
					e.preventDefault();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
						e.preventDefault();
						last?.focus();
					}
				} else if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
					e.preventDefault();
					first?.focus();
				}
			}
		};
		if (typeof window !== "undefined") window.addEventListener("keydown", handleGlobalKeyDown, true);
		return () => {
			clearTimeout(timer);
			if (typeof window !== "undefined") window.removeEventListener("keydown", handleGlobalKeyDown, true);
			if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === "function") try {
				previousActiveElementRef.current.focus();
			} catch {}
		};
	}, []);
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
			ref: dialogRef,
			tabIndex: -1,
			style: {
				background: "var(--wl-set-bg-card, #202026)",
				border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))",
				borderRadius: "12px",
				maxWidth: "420px",
				width: "100%",
				padding: "20px 22px",
				boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
				boxSizing: "border-box",
				outline: "none"
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
						"data-testid": "modal-cancel-btn",
						onClick: onCancel,
						variant: "secondary",
						children: cancelLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
						"data-testid": "modal-confirm-btn",
						onClick: onConfirm,
						variant: isDanger ? "danger" : "primary",
						children: confirmLabel
					})]
				})
			]
		})
	});
}
function TextInput({ id, label, placeholder, value, onChange, disabled = false, error, helpText, width = "100%", "data-testid": testId, onKeyDown }) {
	const containerStyle = {
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		width: typeof width === "number" ? `${width}px` : width,
		boxSizing: "border-box"
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: containerStyle,
		children: [
			label && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				htmlFor: id,
				style: {
					fontSize: "12.5px",
					fontWeight: 500,
					color: "var(--wl-set-text-main, #f2f2f7)"
				},
				children: label
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				id,
				"data-testid": testId,
				type: "text",
				value,
				placeholder,
				disabled,
				onChange: (e) => onChange(e.target.value),
				onKeyDown,
				style: {
					background: "rgba(0, 0, 0, 0.2)",
					border: error ? "1px solid var(--wl-set-error, #ef4444)" : "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.12))",
					borderRadius: "6px",
					padding: "8px 12px",
					fontSize: "13px",
					color: "var(--wl-set-text-main, #f2f2f7)",
					outline: "none",
					boxSizing: "border-box",
					width: "100%",
					fontFamily: "inherit",
					transition: "border-color 0.15s ease"
				},
				"aria-invalid": Boolean(error),
				"aria-describedby": error ? `${id}-error` : helpText ? `${id}-help` : void 0
			}),
			helpText && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				id: `${id}-help`,
				style: {
					fontSize: "11.5px",
					color: "var(--wl-set-text-muted, #6c6c7a)"
				},
				children: helpText
			}),
			error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				id: `${id}-error`,
				role: "alert",
				style: {
					fontSize: "12px",
					color: "var(--wl-set-error, #ef4444)"
				},
				children: error
			})
		]
	});
}
/**
* Concurrency coordinator for DSH shortcut recording lock.
*
* Guarantees:
* - Single ownership per modal instance.
* - Strict serial execution: acquire and release never race or overlap.
* - If release is requested while acquire is pending, release waits for acquire to settle before calling recording(false).
* - If disposed before acquire starts, acquire is safely canceled.
* - Errors in acquire or release do not cause unhandled rejections.
* - Idempotent cleanup: duplicate release calls are no-ops.
* - Final state is guaranteed to be false after release.
*/
var AsyncRecordingLock = class {
	queue = Promise.resolve();
	held = false;
	released = false;
	acquire(recordingFn) {
		if (!recordingFn) return Promise.resolve();
		this.queue = this.queue.catch(() => {}).then(async () => {
			await recordingFn(true);
			this.held = true;
		}).catch(() => {});
		return this.queue;
	}
	release(recordingFn) {
		if (this.released || !recordingFn) return this.queue;
		this.released = true;
		this.queue = this.queue.catch(() => {}).then(async () => {
			try {
				await recordingFn(false);
			} finally {
				this.held = false;
			}
		}).catch(() => {});
		return this.queue;
	}
	isHeld() {
		return this.held;
	}
};
function ShortcutRecorderModal({ currentKeys, isModified, onClose, onSave, onReset, describeBinding, recording }) {
	const [candidate, setCandidate] = react.default.useState(null);
	const [candidateKeys, setCandidateKeys] = react.default.useState(null);
	const [issue, setIssue] = react.default.useState(null);
	const [conflictWarning, setConflictWarning] = react.default.useState(null);
	const [isSaving, setIsSaving] = react.default.useState(false);
	const [saveError, setSaveError] = react.default.useState(null);
	const recorderBoxRef = react.default.useRef(null);
	const dialogRef = react.default.useRef(null);
	const previousActiveElementRef = react.default.useRef(null);
	const onCloseRef = react.default.useRef(onClose);
	onCloseRef.current = onClose;
	const lockRef = react.default.useRef(null);
	if (!lockRef.current) lockRef.current = new AsyncRecordingLock();
	const recordingRef = react.default.useRef(recording);
	recordingRef.current = recording;
	react.default.useEffect(() => {
		if (typeof document !== "undefined") previousActiveElementRef.current = document.activeElement;
		const lock = lockRef.current;
		lock.acquire(recordingRef.current);
		const timer = setTimeout(() => {
			recorderBoxRef.current?.focus();
		}, 20);
		return () => {
			clearTimeout(timer);
			lock.release(recordingRef.current);
			if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === "function") try {
				previousActiveElementRef.current.focus();
			} catch {}
		};
	}, []);
	const handleRecorderKeyDown = (e) => {
		if (isSaving) return;
		if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
			return;
		}
		if (e.key === "Tab") return;
		if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.key) || /^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const modifiers = [];
		if (e.ctrlKey) modifiers.push("control");
		if (e.altKey) modifiers.push("alt");
		if (e.shiftKey) modifiers.push("shift");
		if (e.metaKey) modifiers.push("meta");
		const nextBinding = {
			code: e.code,
			modifiers
		};
		setCandidate(nextBinding);
		setSaveError(null);
		if (describeBinding) try {
			const desc = describeBinding(nextBinding);
			setCandidateKeys(desc.keys && desc.keys.length > 0 ? desc.keys : [e.code]);
			if (desc.issue) setIssue(desc.issue === "modifier-required" || desc.issue === "requires-modifier" ? "快捷键必须包含至少一个修饰键（Ctrl、Alt 或 Shift）" : desc.issue === "reserved" || desc.issue === "reserved-key" ? "该按键为系统保留快捷键，不可重定义" : desc.issue === "unsupported-browser" ? "当前 Web 浏览器平台不支持该快捷键组合" : desc.issue === "unsupported-key" ? "当前系统或浏览器不支持该按键作为快捷键" : `按键不合规: ${desc.issue}`);
			else setIssue(null);
			if (desc.conflicts && desc.conflicts.length > 0) {
				const otherConflicts = desc.conflicts.filter((c) => c !== "wordLookup.lookupSelection");
				if (otherConflicts.length > 0) setConflictWarning(`该快捷键与现有命令冲突: ${otherConflicts.join(", ")}`);
				else setConflictWarning(null);
			} else setConflictWarning(null);
		} catch (err) {
			setIssue(`无效组合键: ${err instanceof Error ? err.message : String(err)}`);
		}
		else {
			const parts = [...modifiers.map((m) => m.toUpperCase()), e.code.replace(/^Key/, "")];
			setCandidateKeys(parts);
			if (modifiers.length === 0) setIssue("快捷键必须包含至少一个修饰键（Ctrl、Alt 或 Shift）");
			else {
				setIssue(null);
				setConflictWarning(null);
			}
		}
	};
	const handleDialogKeyDown = (e) => {
		if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
			return;
		}
		if (e.key === "Tab") {
			if (!dialogRef.current) return;
			const focusable = Array.from(dialogRef.current.querySelectorAll("[data-testid=\"shortcut-recorder-box\"], button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"));
			if (focusable.length > 0) {
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === first) {
						e.preventDefault();
						last?.focus();
						return;
					}
				} else if (document.activeElement === last) {
					e.preventDefault();
					first?.focus();
					return;
				}
			}
		}
		if (e.target?.closest("button")) return;
		if (e.target === e.currentTarget) handleRecorderKeyDown(e);
	};
	const handleSave = async () => {
		if (!candidate || issue || conflictWarning || isSaving) return;
		setIsSaving(true);
		setSaveError(null);
		try {
			const res = await onSave(candidate);
			if (typeof res === "boolean" ? res : res.ok) onCloseRef.current();
			else {
				const errMsg = typeof res === "object" && res.error ? res.error : "保存快捷键失败，Host 未接受该配置";
				setSaveError(errMsg);
			}
		} catch (err) {
			setSaveError(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setIsSaving(false);
		}
	};
	const handleReset = async () => {
		if (isSaving) return;
		setIsSaving(true);
		setSaveError(null);
		try {
			const res = await onReset();
			if (typeof res === "boolean" ? res : res.ok) onCloseRef.current();
			else {
				const errMsg = typeof res === "object" && res.error ? res.error : "恢复默认快捷键失败";
				setSaveError(errMsg);
			}
		} catch (err) {
			setSaveError(`恢复默认失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setIsSaving(false);
		}
	};
	const backdropStyle = {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0, 0, 0, 0.6)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 99999,
		padding: "16px"
	};
	const modalStyle = {
		background: "var(--wl-set-bg-card, #202026)",
		border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))",
		borderRadius: "12px",
		maxWidth: "460px",
		width: "100%",
		padding: "22px 24px",
		boxShadow: "0 12px 36px rgba(0, 0, 0, 0.55)",
		boxSizing: "border-box",
		outline: "none"
	};
	const displayKeys = candidateKeys ?? currentKeys;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: backdropStyle,
		role: "presentation",
		onClick: onClose,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			ref: dialogRef,
			tabIndex: -1,
			style: modalStyle,
			role: "dialog",
			"aria-modal": "true",
			"aria-labelledby": "recorder-dialog-title",
			onClick: (e) => e.stopPropagation(),
			onKeyDown: handleDialogKeyDown,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					id: "recorder-dialog-title",
					style: {
						fontSize: "16px",
						fontWeight: 600,
						margin: "0 0 8px 0",
						color: "var(--wl-set-text-main, #f2f2f7)"
					},
					children: "修改划词查询快捷键"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						fontSize: "12.5px",
						color: "var(--wl-set-text-sub, #9898a6)",
						margin: "0 0 16px 0",
						lineHeight: "1.5"
					},
					children: "请直接在键盘上按下您希望设置的组合键（例如 Ctrl + Alt + K 或 Command + Shift + L）。"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: recorderBoxRef,
					tabIndex: 0,
					role: "region",
					"aria-label": "快捷键录制区域",
					"data-testid": "shortcut-recorder-box",
					onKeyDown: handleRecorderKeyDown,
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						minHeight: "64px",
						padding: "12px",
						borderRadius: "8px",
						background: "rgba(0, 0, 0, 0.25)",
						border: issue ? "1px solid var(--wl-set-error, #ef4444)" : candidate ? "1px solid var(--wl-set-accent, #4176e6)" : "1px dashed var(--wl-set-stroke, rgba(255, 255, 255, 0.18))",
						marginBottom: "14px",
						outline: "none",
						cursor: "text"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							gap: "6px",
							alignItems: "center",
							flexWrap: "wrap"
						},
						children: displayKeys && displayKeys.length > 0 ? displayKeys.map((k, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "14px",
								fontWeight: 600,
								fontFamily: "monospace",
								padding: "4px 10px",
								borderRadius: "6px",
								background: candidate ? "var(--wl-set-accent, #4176e6)" : "rgba(255, 255, 255, 0.12)",
								color: "#ffffff",
								border: "1px solid rgba(255, 255, 255, 0.15)"
							},
							children: k
						}, idx)) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "13px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "等待按键输入..."
						})
					})
				}),
				issue && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "alert",
					style: {
						fontSize: "12px",
						color: "var(--wl-set-error, #ef4444)",
						marginBottom: "12px"
					},
					children: issue
				}),
				conflictWarning && !issue && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "alert",
					style: {
						fontSize: "12px",
						color: "var(--wl-set-warn, #f59e0b)",
						marginBottom: "12px"
					},
					children: conflictWarning
				}),
				saveError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "alert",
					style: {
						fontSize: "12px",
						color: "var(--wl-set-error, #ef4444)",
						marginBottom: "12px"
					},
					children: saveError
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginTop: "18px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: isModified && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
						"data-testid": "btn-reset-shortcut",
						size: "small",
						variant: "ghost",
						onClick: handleReset,
						busy: isSaving,
						children: "恢复默认快捷键"
					}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "8px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							"data-testid": "btn-cancel-shortcut",
							variant: "secondary",
							onClick: onClose,
							disabled: isSaving,
							children: "取消"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							"data-testid": "btn-save-shortcut",
							variant: "primary",
							disabled: !candidate || Boolean(issue) || Boolean(conflictWarning) || isSaving,
							busy: isSaving,
							onClick: handleSave,
							children: "保存修改"
						})]
					})]
				})
			]
		})
	});
}
function SnapshotPickerModal({ snapshots, activeSnapshotId, isActing = false, onClose, onSelect }) {
	const dialogRef = react.default.useRef(null);
	const previousActiveElementRef = react.default.useRef(null);
	const onCloseRef = react.default.useRef(onClose);
	onCloseRef.current = onClose;
	const onSelectRef = react.default.useRef(onSelect);
	onSelectRef.current = onSelect;
	const [submittingId, setSubmittingId] = react.default.useState(null);
	react.default.useEffect(() => {
		if (typeof document !== "undefined") previousActiveElementRef.current = document.activeElement;
		const timer = setTimeout(() => {
			const firstFocusable = dialogRef.current?.querySelector("button:not([disabled])");
			if (firstFocusable) firstFocusable.focus();
			else dialogRef.current?.focus();
		}, 20);
		const handleKeyDown = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (e.key === "Tab") {
				if (!dialogRef.current) return;
				const focusableElements = Array.from(dialogRef.current.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"));
				if (focusableElements.length === 0) {
					e.preventDefault();
					return;
				}
				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === firstElement || document.activeElement === dialogRef.current) {
						e.preventDefault();
						lastElement?.focus();
					}
				} else if (document.activeElement === lastElement) {
					e.preventDefault();
					firstElement?.focus();
				}
			}
		};
		if (typeof window !== "undefined") window.addEventListener("keydown", handleKeyDown, true);
		return () => {
			clearTimeout(timer);
			if (typeof window !== "undefined") window.removeEventListener("keydown", handleKeyDown, true);
			if (previousActiveElementRef.current && typeof previousActiveElementRef.current.focus === "function") try {
				previousActiveElementRef.current.focus();
			} catch {}
			else if (typeof document !== "undefined") document.querySelector("[data-testid=\"btn-mode-custom\"]")?.focus();
		};
	}, []);
	const handleSelectSnapshot = (snapshotId) => {
		if (isActing || submittingId !== null) return;
		const target = snapshots.find((s) => s.snapshotId === snapshotId);
		if (!target || !isSnapshotActivatable(target) || target.isActive || target.snapshotId === activeSnapshotId) return;
		setSubmittingId(snapshotId);
		onSelectRef.current(snapshotId);
		onCloseRef.current();
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			position: "fixed",
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			background: "rgba(0, 0, 0, 0.6)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 99999,
			padding: "16px"
		},
		role: "presentation",
		onClick: () => onCloseRef.current(),
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			ref: dialogRef,
			tabIndex: -1,
			style: {
				background: "var(--wl-set-bg-card, #202026)",
				border: "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.15))",
				borderRadius: "12px",
				maxWidth: "480px",
				width: "100%",
				padding: "22px 24px",
				boxShadow: "0 12px 36px rgba(0, 0, 0, 0.55)",
				boxSizing: "border-box",
				outline: "none"
			},
			role: "dialog",
			"aria-modal": "true",
			"aria-labelledby": "snapshot-picker-dialog-title",
			"data-testid": "snapshot-picker-modal",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					id: "snapshot-picker-dialog-title",
					style: {
						fontSize: "16px",
						fontWeight: 600,
						margin: "0 0 8px 0",
						color: "var(--wl-set-text-main, #f2f2f7)"
					},
					children: "选择要启用的自定义词典"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						fontSize: "12.5px",
						color: "var(--wl-set-text-sub, #9898a6)",
						margin: "0 0 16px 0",
						lineHeight: "1.5"
					},
					children: "检测到多份已导入的自定义 SQLite 词典快照，请选择需要激活生效的词典："
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "8px",
						maxHeight: "280px",
						overflowY: "auto"
					},
					children: snapshots.map((snap) => {
						const isActive = snap.snapshotId === activeSnapshotId || snap.isActive;
						const isCorrupt = snap.corrupt === true;
						const isActivatable = isSnapshotActivatable(snap);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": `snapshot-picker-row-${snap.snapshotId}`,
							style: {
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								padding: "10px 12px",
								borderRadius: "8px",
								background: "rgba(255, 255, 255, 0.04)",
								border: isActive ? "1px solid rgba(34, 197, 94, 0.4)" : "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: "6px",
									alignItems: "center",
									marginBottom: "3px"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontWeight: 600,
											fontSize: "13px",
											color: "var(--wl-set-text-main, #f2f2f7)"
										},
										children: snap.identity
									}),
									isActive && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										variant: "success",
										label: "当前激活"
									}),
									isCorrupt ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										variant: "error",
										label: "快照损坏"
									}) : !isActivatable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										variant: "warning",
										label: "快照不可用"
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: "11px",
									color: "var(--wl-set-text-muted, #6c6c7a)",
									fontFamily: "monospace"
								},
								children: [
									"ID: ",
									snap.snapshotId.slice(0, 8),
									"... | ",
									snap.entryCount?.toLocaleString?.() ?? snap.entryCount,
									" 词条 | ",
									snap.formCount?.toLocaleString?.() ?? snap.formCount,
									" 形态"
								]
							})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								"data-testid": `snapshot-picker-select-${snap.snapshotId}`,
								size: "small",
								variant: isActive ? "ghost" : "primary",
								disabled: isActive || !isActivatable || isActing || submittingId !== null,
								title: isCorrupt ? "快照文件已损坏，不可激活" : !isActivatable ? "快照不可用，请重新导入或校验" : void 0,
								onClick: () => handleSelectSnapshot(snap.snapshotId),
								children: isActive ? "已激活" : isCorrupt ? "快照损坏" : !isActivatable ? "快照不可用" : "启用"
							})]
						}, snap.snapshotId);
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						justifyContent: "flex-end",
						marginTop: "18px"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
						"data-testid": "snapshot-picker-cancel",
						variant: "secondary",
						onClick: () => onCloseRef.current(),
						children: "取消"
					})
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
* Implements Phase 7A.8.2:
* - Current Dictionary Status (Active mode, entry counts, forms, source, diagnostics).
* - Three-Mode Switching (Fixture, Managed ECDICT, Custom SQLite).
* - 1-Click ECDICT Installation, Real-time Streaming Progress, Safe Cancellation.
* - Managed Corpus Removal with Confirmation Dialog, preserving active Custom mode if present.
* - Custom SQLite Management: Host path validation (MANUAL_HOST_PATH), live /verify, /activate-custom.
* - Custom Snapshot List with safe removal gating (unleased, inactive only) and safe /remove-custom unlinking.
* - Automatic Lookup Switches (autoDoubleClick, autoSelection) via ConfigForms.
* - Configurable Lookup Shortcut with ctx.shortcuts live inspection, recording modal, conflict check, and reset.
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
/** Helper to format keys cleanly whether already punctuated or raw. */
function formatShortcutKeys(keys) {
	if (!keys || keys.length === 0) return "未绑定 (Unbound)";
	if (keys.includes("+")) return keys.join(" ");
	return keys.join(" + ");
}
function DictionarySettingsSection({ store: externalStore, form, shortcuts, testPlatform, close: _close }) {
	const [internalStore] = (0, react.useState)(() => externalStore ? null : new DictionaryManagementStore({ autoStart: false }));
	const store = externalStore ?? internalStore;
	(0, react.useEffect)(() => {
		if (typeof window !== "undefined") window.__DSH_WL_SETTINGS_STORE__ = store;
		return () => {
			if (typeof window !== "undefined") {
				const win = window;
				if (win.__DSH_WL_SETTINGS_STORE__ === store) delete win.__DSH_WL_SETTINGS_STORE__;
			}
			if (internalStore) internalStore.dispose();
		};
	}, [internalStore, store]);
	const storeState = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot, store.getSnapshot);
	const isMountedRef = (0, react.useRef)(true);
	(0, react.useEffect)(() => {
		return () => {
			isMountedRef.current = false;
		};
	}, []);
	const [formSnapshot, setFormSnapshot] = (0, react.useState)(() => {
		return form ? form.getSnapshot() : null;
	});
	(0, react.useEffect)(() => {
		if (!form) return;
		setFormSnapshot(form.getSnapshot());
		return form.subscribe(() => {
			if (isMountedRef.current) setFormSnapshot(form.getSnapshot());
		});
	}, [form]);
	const isFormWritable = Boolean(form && formSnapshot && formSnapshot.status === "ready" && formSnapshot.writable);
	const [pendingDoubleClick, setPendingDoubleClick] = (0, react.useState)(false);
	const [pendingSelection, setPendingSelection] = (0, react.useState)(false);
	const [configError, setConfigError] = (0, react.useState)(null);
	const doubleClickSeqRef = (0, react.useRef)(0);
	const selectionSeqRef = (0, react.useRef)(0);
	const handleToggleDoubleClick = async (next) => {
		if (!isFormWritable || !form || pendingDoubleClick) return;
		setConfigError(null);
		setPendingDoubleClick(true);
		const seq = ++doubleClickSeqRef.current;
		try {
			const ok = await form.set("autoDoubleClick", next);
			if (!isMountedRef.current || seq !== doubleClickSeqRef.current) return;
			if (!ok) setConfigError("保存双击查词设置失败：Host 拒绝了修改，已恢复原有配置");
		} catch (err) {
			if (!isMountedRef.current || seq !== doubleClickSeqRef.current) return;
			setConfigError(`保存双击查词设置异常: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (isMountedRef.current && seq === doubleClickSeqRef.current) setPendingDoubleClick(false);
		}
	};
	const handleToggleSelection = async (next) => {
		if (!isFormWritable || !form || pendingSelection) return;
		setConfigError(null);
		setPendingSelection(true);
		const seq = ++selectionSeqRef.current;
		try {
			const ok = await form.set("autoSelection", next);
			if (!isMountedRef.current || seq !== selectionSeqRef.current) return;
			if (!ok) setConfigError("保存框选查词设置失败：Host 拒绝了修改，已恢复原有配置");
		} catch (err) {
			if (!isMountedRef.current || seq !== selectionSeqRef.current) return;
			setConfigError(`保存框选查词设置异常: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (isMountedRef.current && seq === selectionSeqRef.current) setPendingSelection(false);
		}
	};
	const [showRemoveConfirm, setShowRemoveConfirm] = (0, react.useState)(false);
	const [isExpandingDetails, setIsExpandingDetails] = (0, react.useState)(false);
	const [customPath, setCustomPath] = (0, react.useState)("");
	const [customIdentity, setCustomIdentity] = (0, react.useState)("");
	const [isVerifying, setIsVerifying] = (0, react.useState)(false);
	const [verifyOutcome, setVerifyOutcome] = (0, react.useState)(null);
	const [snapshotToRemove, setSnapshotToRemove] = (0, react.useState)(null);
	const [showShortcutRecorder, setShowShortcutRecorder] = (0, react.useState)(false);
	const [showSnapshotPicker, setShowSnapshotPicker] = (0, react.useState)(false);
	const [verifiedPath, setVerifiedPath] = (0, react.useState)(null);
	const pendingVerifyPathRef = (0, react.useRef)(null);
	const { status, isLoading, isActing, actionError, connectionError } = storeState;
	const currentOp = status?.currentOperation;
	const isOperationRunning = currentOp !== null && currentOp !== void 0 && currentOp.status === "running";
	const platform = detectPlatform(testPlatform);
	const activeShortcuts = shortcuts ?? (typeof window !== "undefined" ? window.__DSH_SHORTCUTS__ : void 0);
	const catalogSnapshot = (0, react.useSyncExternalStore)((callback) => {
		if (activeShortcuts?.catalog?.subscribe) return activeShortcuts.catalog.subscribe(callback);
		return () => {};
	}, () => {
		if (activeShortcuts?.catalog?.getSnapshot) return activeShortcuts.catalog.getSnapshot();
		return null;
	}, () => {
		if (activeShortcuts?.catalog?.getSnapshot) return activeShortcuts.catalog.getSnapshot();
		return null;
	});
	const lookupShortcutEntry = catalogSnapshot?.find((e) => e.id === LOOKUP_COMMAND_ID$1);
	const shortcutServiceState = (0, react.useMemo)(() => {
		if (!activeShortcuts) return "SERVICE_UNAVAILABLE";
		if (!activeShortcuts.catalog || catalogSnapshot === null) return "CATALOG_NOT_READY";
		if (!catalogSnapshot.find((e) => e.id === "wordLookup.lookupSelection")) return "COMMAND_NOT_REGISTERED";
		if (typeof activeShortcuts.edit !== "function" || typeof activeShortcuts.recording !== "function") return "READ_ONLY";
		return "READY";
	}, [activeShortcuts, catalogSnapshot]);
	const isShortcutEditable = shortcutServiceState === "READY";
	const handleRecording = (0, react.useCallback)(async (active) => {
		if (activeShortcuts?.recording) await activeShortcuts.recording(active);
	}, [activeShortcuts]);
	const handleSaveShortcut = async (binding) => {
		if (!activeShortcuts || typeof activeShortcuts.edit !== "function") return {
			ok: false,
			error: "快捷键服务暂不可用"
		};
		const revision = (activeShortcuts.config?.getSnapshot ? activeShortcuts.config.getSnapshot() : null)?.revision ?? 1;
		const res = await activeShortcuts.edit({
			type: "set",
			id: LOOKUP_COMMAND_ID$1,
			binding
		}, revision);
		if (res.status === "saved") return { ok: true };
		return {
			ok: false,
			error: res.status === "conflict" ? `保存失败：快捷键与现有命令冲突 (${res.conflicts?.join(", ") || "未知冲突"})` : res.status === "stale" ? "保存失败：快捷键配置已被其他操作修改（版本过期），已刷新最新状态" : res.status === "not-ready" ? "保存失败：快捷键配置服务尚未就绪" : res.status === "unreadable" ? "保存失败：快捷键配置存储损坏或无法读取" : `保存失败：Host 拒绝了该快捷键 (${res.status})`
		};
	};
	const handleResetShortcut = async () => {
		if (!activeShortcuts || typeof activeShortcuts.edit !== "function") return {
			ok: false,
			error: "快捷键服务暂不可用"
		};
		const revision = (activeShortcuts.config?.getSnapshot ? activeShortcuts.config.getSnapshot() : null)?.revision ?? 1;
		const res = await activeShortcuts.edit({
			type: "reset",
			id: LOOKUP_COMMAND_ID$1
		}, revision);
		if (res.status === "saved") return { ok: true };
		return {
			ok: false,
			error: res.status === "stale" ? "恢复默认失败：快捷键配置已被其他操作修改，已刷新最新状态" : `恢复默认失败：${res.status}`
		};
	};
	const handleVerifyCustom = async () => {
		const trimmedPath = customPath.trim();
		if (!trimmedPath || isVerifying || isActing) return;
		setIsVerifying(true);
		setVerifyOutcome(null);
		setVerifiedPath(null);
		pendingVerifyPathRef.current = trimmedPath;
		try {
			const res = await store.verifyCustom(trimmedPath);
			if (pendingVerifyPathRef.current !== trimmedPath || customPath.trim() !== trimmedPath) return;
			if (res.ok) {
				setVerifiedPath(trimmedPath);
				setVerifyOutcome({
					valid: true,
					schemaVersion: res.data.schemaVersion,
					entryCount: res.data.entryCount,
					formCount: res.data.formCount,
					headwordsSample: res.data.headwordsSample,
					message: res.data.message || "SQLite 数据库架构校验通过"
				});
			} else {
				setVerifiedPath(trimmedPath);
				setVerifyOutcome({
					valid: false,
					message: res.kind === "refused" ? res.message : res.kind === "network" ? `网络/连接异常: ${res.message}` : "校验请求已取消",
					error: res.kind === "refused" ? res.code : res.kind === "network" ? "NETWORK_ERROR" : "ABORTED"
				});
			}
		} catch (err) {
			if (pendingVerifyPathRef.current === trimmedPath && customPath.trim() === trimmedPath) {
				setVerifiedPath(trimmedPath);
				setVerifyOutcome({
					valid: false,
					message: err instanceof Error ? err.message : String(err),
					error: "INTERNAL_ERROR"
				});
			}
		} finally {
			setIsVerifying(false);
		}
	};
	const handleCustomPathChange = (newVal) => {
		setCustomPath(newVal);
		pendingVerifyPathRef.current = null;
		if (verifiedPath !== null && newVal.trim() !== verifiedPath) {
			setVerifyOutcome(null);
			setVerifiedPath(null);
		}
	};
	const handleActivateCustom = async () => {
		const trimmedPath = customPath.trim();
		if (!trimmedPath || isActing || isVerifying) return;
		const trimmedIdentity = customIdentity.trim() || void 0;
		if (await store.activateCustom(trimmedPath, trimmedIdentity)) {
			setCustomPath("");
			setCustomIdentity("");
			setVerifyOutcome(null);
		}
	};
	const handleConfirmRemoveCustom = async () => {
		if (!snapshotToRemove || isActing) return;
		const id = snapshotToRemove.snapshotId;
		setSnapshotToRemove(null);
		await store.removeCustom(id);
	};
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
	} else if (status?.activeMode === "custom") {
		badgeVariant = "success";
		badgeLabel = `自定义已启用 (${status.activeIdentity ?? "custom"})`;
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
	const activeCustomSnapshot = status?.activeMode === "custom" && status.customSnapshots ? status.customSnapshots.find((s) => s.snapshotId === status.activeSnapshotId) : null;
	const customSnapshots = status?.customSnapshots ?? [];
	const validCustomSnapshots = customSnapshots.filter(isSnapshotActivatable);
	const canSwitchMode = status?.canSwitchMode !== false && !isActing && !isOperationRunning;
	const handleSelectCustomSnapshot = (snapshotId) => {
		const target = customSnapshots.find((snapshot) => snapshot.snapshotId === snapshotId);
		if (!canSwitchMode || !target || !isSnapshotActivatable(target) || target.isActive || target.snapshotId === status?.activeSnapshotId) return;
		store.selectMode("custom", snapshotId);
	};
	const handleCustomTopButtonClick = () => {
		if (!canSwitchMode || customSnapshots.length === 0 || validCustomSnapshots.length === 0) return;
		if (validCustomSnapshots.length === 1 && validCustomSnapshots[0]) {
			const single = validCustomSnapshots[0];
			if (status?.activeMode === "custom" && status?.activeSnapshotId === single.snapshotId) return;
			handleSelectCustomSnapshot(single.snapshotId);
		} else setShowSnapshotPicker(true);
	};
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "mode-switcher-container",
						style: {
							display: "flex",
							gap: "8px",
							marginBottom: "16px",
							paddingBottom: "14px",
							borderBottom: "1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.08))",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								"data-testid": "btn-mode-fixture",
								variant: status?.activeMode === "fixture" ? "primary" : "secondary",
								size: "small",
								disabled: !canSwitchMode,
								onClick: () => void store.selectMode("fixture"),
								ariaLabel: "切换至内置基础词典",
								children: "内置基础词典 (Fixture)"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								"data-testid": "btn-mode-ecdict",
								variant: status?.activeMode === "managed-ecdict" ? "primary" : "secondary",
								size: "small",
								disabled: !status?.installed || !canSwitchMode,
								onClick: () => void store.selectMode("managed-ecdict"),
								title: !status?.installed ? "需先在一键安装 ECDICT 后方可切换" : "切换至本地全量 ECDICT 词典",
								ariaLabel: "切换至本地 ECDICT 词典",
								children: "ECDICT 本地全量词典"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								"data-testid": "btn-mode-custom",
								variant: status?.activeMode === "custom" ? "primary" : "secondary",
								size: "small",
								disabled: !canSwitchMode || customSnapshots.length === 0 || validCustomSnapshots.length === 0,
								onClick: handleCustomTopButtonClick,
								title: customSnapshots.length === 0 ? "需先在下方导入自定义 SQLite 词典" : validCustomSnapshots.length === 0 ? "暂无有效可用的自定义词典快照，请重新导入或校验" : "切换至自定义 SQLite 词典",
								ariaLabel: "切换至自定义词典",
								children: "自定义 SQLite 词典"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "词典模式",
						description: "当前使用的词典引擎类别",
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "13px",
								fontWeight: 500,
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: status === null ? "加载中..." : status.quarantined ? "存储已隔离保护" : status.activeMode === "managed-ecdict" ? "ECDICT 本地全量词典" : status.activeMode === "custom" ? "自定义 SQLite 词典" : "内置离线基础词典 (Fixture)"
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
							children: status === null ? "暂无统计" : status.activeMode === "managed-ecdict" ? status.installedCorpus?.entryCount !== void 0 ? `${status.installedCorpus.entryCount.toLocaleString()} 词条` : "暂无统计" : status.activeMode === "custom" ? activeCustomSnapshot?.entryCount !== void 0 ? `${activeCustomSnapshot.entryCount.toLocaleString()} 词条` : "暂无统计" : status.activeMode === "fixture" ? status.fixtureStats?.entryCount !== void 0 ? `${status.fixtureStats.entryCount} 词条` : "暂无统计" : "暂无统计"
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
							children: status === null ? "暂无统计" : status.activeMode === "managed-ecdict" ? status.installedCorpus?.formCount !== void 0 ? `${status.installedCorpus.formCount.toLocaleString()} 记录` : "暂无统计" : status.activeMode === "custom" ? activeCustomSnapshot?.formCount !== void 0 ? `${activeCustomSnapshot.formCount.toLocaleString()} 记录` : "暂无统计" : status.activeMode === "fixture" ? status.fixtureStats?.formCount !== void 0 ? `${status.fixtureStats.formCount} 记录` : "暂无统计" : "暂无统计"
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
							children: status === null ? "暂无数据" : status.activeMode === "managed-ecdict" ? status.installedCorpus?.commit ? `ECDICT @ ${status.installedCorpus.commit.slice(0, 7)}` : "ECDICT (版本未知)" : status.activeMode === "custom" ? activeCustomSnapshot?.identity ? `自定义 (${activeCustomSnapshot.identity})` : status.activeIdentity ?? "自定义 SQLite" : status.activeMode === "fixture" ? status.fixtureStats?.version ? `内置 Fixture (${status.fixtureStats.version})` : "内置 Fixture" : status.activeIdentity ?? "自定义版本"
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
								status?.activeSnapshotId && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["活跃快照: ", status.activeSnapshotId] }),
								status?.customSnapshotStatus && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["快照引用租约: ", status.customSnapshotStatus.activeLeases] }),
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
									children: currentOp.phase === "downloading" ? "正在下载 ECDICT 词源文件..." : currentOp.phase === "verifying-source" ? "正在校验 CSV 词源完整性..." : currentOp.phase === "building" ? "正在本地编译构建 SQLite 数据库..." : currentOp.phase === "validating-database" ? "正在执行 SQLite 完整性校验..." : currentOp.phase === "activating" ? "正在原子激活并重载词典..." : "正在处理中..."
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
							background: status.activeMode === "managed-ecdict" ? "rgba(34, 197, 94, 0.08)" : "rgba(245, 158, 11, 0.08)",
							border: status.activeMode === "managed-ecdict" ? "1px solid rgba(34, 197, 94, 0.25)" : "1px solid rgba(245, 158, 11, 0.25)",
							marginBottom: "16px",
							fontSize: "13px",
							lineHeight: "1.5",
							color: "var(--wl-set-text-main, #f2f2f7)"
						},
						children: status.activeMode === "managed-ecdict" ? `ECDICT 本地全量数据库已就绪${status.installedCorpus?.entryCount !== void 0 ? `（${status.installedCorpus.entryCount.toLocaleString()} 词条${status.installedCorpus?.formCount !== void 0 ? `，${status.installedCorpus.formCount.toLocaleString()} 形态学记录` : ""}）` : ""}。当前运行状态稳定，查词请求直接命中本地只读 SQLite 数据库。` : `ECDICT 本地全量数据库已安装在磁盘，但当前活动词典模式为「${status.activeMode === "fixture" ? "内置基础词典 (Fixture)" : status.activeMode === "custom" ? "自定义 SQLite 词典" : status.activeMode}」。查词请求尚未命中 ECDICT。`
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
							children: "移除后将恢复为内置基础词典 (Fixture)；若当前使用自定义词典则继续保持。"
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
				title: "自定义 SQLite 词典管理",
				description: "支持通过本地绝对路径导入自建 SQLite 词典（.sqlite3 / .sqlite / .db）。原文件始终保持只读完整，插件在内部维护独立只读安全快照。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "manual-host-path-notice",
						style: {
							padding: "12px 14px",
							borderRadius: "8px",
							background: "rgba(65, 118, 230, 0.08)",
							border: "1px solid rgba(65, 118, 230, 0.25)",
							marginBottom: "16px",
							fontSize: "12.5px",
							lineHeight: "1.5",
							color: "var(--wl-set-text-main, #f2f2f7)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontWeight: 600,
								marginBottom: "3px"
							},
							children: "路径输入说明 (MANUAL_HOST_PATH)"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { color: "var(--wl-set-text-sub, #9898a6)" },
							children: [
								"受浏览器沙箱安全策略限制，无法直接调用本地文件选择窗口。请在资源管理器中复制 SQLite 数据库文件的完整绝对路径（如 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: { fontFamily: "monospace" },
									children: "C:\\dictionaries\\my-dict.sqlite3"
								}),
								" 或 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									style: { fontFamily: "monospace" },
									children: "/home/user/dict.db"
								}),
								"）并粘贴于下方。"
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "12px",
							marginBottom: "16px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
								id: "input-custom-dict-path",
								"data-testid": "input-custom-dict-path",
								label: "SQLite 数据库绝对路径 (MANUAL_HOST_PATH)",
								placeholder: "例如: C:\\dictionaries\\my-dict.sqlite3 或 /path/to/dict.db",
								value: customPath,
								onChange: handleCustomPathChange,
								disabled: isActing || isVerifying
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextInput, {
								id: "input-custom-dict-identity",
								"data-testid": "input-custom-dict-identity",
								label: "自定义词库标识（可选，留空则自动提取文件名）",
								placeholder: "例如: medical-terms 或 collins-en-zh (仅限字母/数字/短横线/下划线)",
								value: customIdentity,
								onChange: setCustomIdentity,
								disabled: isActing || isVerifying
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: "10px",
									alignItems: "center",
									marginTop: "4px"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									"data-testid": "btn-verify-custom",
									variant: "secondary",
									disabled: !customPath.trim() || isVerifying || isActing,
									busy: isVerifying,
									onClick: () => void handleVerifyCustom(),
									children: "校验数据库"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									"data-testid": "btn-activate-custom",
									variant: "primary",
									disabled: !customPath.trim() || isVerifying || isActing,
									busy: isActing,
									onClick: () => void handleActivateCustom(),
									children: "导入并激活"
								})]
							})
						]
					}),
					actionError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "custom-action-error-box",
						role: "alert",
						style: {
							padding: "10px 14px",
							borderRadius: "8px",
							marginBottom: "16px",
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
					verifyOutcome && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "verify-outcome-box",
						role: "alert",
						style: {
							padding: "12px 14px",
							borderRadius: "8px",
							marginBottom: "16px",
							fontSize: "12.5px",
							background: verifyOutcome.valid ? "rgba(34, 197, 94, 0.08)" : "rgba(239, 68, 68, 0.12)",
							border: verifyOutcome.valid ? "1px solid rgba(34, 197, 94, 0.25)" : "1px solid rgba(239, 68, 68, 0.3)",
							color: verifyOutcome.valid ? "var(--wl-set-text-main, #f2f2f7)" : "var(--wl-set-error, #ef4444)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontWeight: 600,
								marginBottom: "4px"
							},
							children: verifyOutcome.valid ? "数据库架构校验通过" : "数据库校验未通过"
						}), verifyOutcome.valid ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								color: "var(--wl-set-text-sub, #9898a6)",
								lineHeight: "1.6"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["架构版本: v", verifyOutcome.schemaVersion ?? 1] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									"词条条目数: ",
									verifyOutcome.entryCount?.toLocaleString() ?? 0,
									" 条"
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
									"词形形态数: ",
									verifyOutcome.formCount?.toLocaleString() ?? 0,
									" 条"
								] }),
								verifyOutcome.headwordsSample && verifyOutcome.headwordsSample.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["样词抽样: ", verifyOutcome.headwordsSample.slice(0, 5).join(", ")] })
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: verifyOutcome.message })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							marginTop: "18px",
							paddingTop: "14px",
							borderTop: "1px solid var(--wl-set-border-row, rgba(255, 255, 255, 0.08))"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							style: {
								fontSize: "14px",
								fontWeight: 600,
								margin: "0 0 10px 0",
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: "已导入的自定义词典快照"
						}), !status?.customSnapshots || status.customSnapshots.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							"data-testid": "custom-snapshots-empty",
							style: {
								fontSize: "12.5px",
								color: "var(--wl-set-text-muted, #6c6c7a)",
								padding: "8px 0"
							},
							children: "暂无已导入的自定义词典快照。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							"data-testid": "custom-snapshots-list",
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "8px"
							},
							children: status.customSnapshots.map((snap) => {
								const isCurrentActive = snap.snapshotId === status.activeSnapshotId || snap.isActive;
								const isActivatable = isSnapshotActivatable(snap);
								const leases = status.customSnapshotStatus?.snapshotId === snap.snapshotId ? status.customSnapshotStatus.activeLeases : 0;
								const isLeased = leases > 0;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									"data-testid": `custom-snapshot-row-${snap.snapshotId}`,
									style: {
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "10px 14px",
										borderRadius: "8px",
										background: "rgba(255, 255, 255, 0.03)",
										border: isCurrentActive ? "1px solid rgba(34, 197, 94, 0.35)" : "1px solid var(--wl-set-stroke, rgba(255, 255, 255, 0.08))"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											gap: "8px",
											alignItems: "center",
											marginBottom: "2px"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontWeight: 600,
													fontSize: "13px",
													color: "var(--wl-set-text-main, #f2f2f7)"
												},
												children: snap.identity
											}),
											isCurrentActive && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
												variant: "success",
												label: "当前激活"
											}),
											isLeased && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
												variant: "warning",
												label: `查询中 (${leases})`
											}),
											snap.corrupt === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
												variant: "error",
												label: "快照损坏"
											}) : !isActivatable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
												variant: "warning",
												label: "快照不可用"
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: "11.5px",
											color: "var(--wl-set-text-muted, #6c6c7a)",
											fontFamily: "monospace"
										},
										children: [
											"ID: ",
											snap.snapshotId.slice(0, 8),
											"... | ",
											snap.entryCount?.toLocaleString?.() ?? snap.entryCount,
											" 词条 | ",
											snap.formCount?.toLocaleString?.() ?? snap.formCount,
											" 形态"
										]
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											gap: "8px"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
											size: "small",
											variant: "secondary",
											disabled: isCurrentActive || !canSwitchMode || !isActivatable,
											title: snap.corrupt === true ? "快照文件已损坏，不可激活" : !isActivatable ? "快照不可用，请重新导入或校验" : void 0,
											onClick: () => handleSelectCustomSnapshot(snap.snapshotId),
											children: "启用"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
											size: "small",
											variant: "danger",
											disabled: isCurrentActive || isLeased || isActing,
											title: isCurrentActive ? "不能删除当前激活的词典快照，请先切换至其他词典" : isLeased ? "快照当前有活动查询占用，暂不可删除" : "安全删除快照（不影响原始文件）",
											onClick: () => setSnapshotToRemove(snap),
											children: "删除"
										})]
									})]
								}, snap.snapshotId);
							})
						})]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "手势与自动查词",
				description: "配置在浏览和编辑时通过鼠标手势自动触发查词。设置修改后实时生效，无需重启应用。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "双击自动查词",
						description: "在页面中双击选中英文单词后自动弹出词典卡片展示释义",
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
							id: "switch-auto-double-click",
							label: "双击自动查词",
							checked: formSnapshot?.value?.autoDoubleClick === true,
							disabled: !isFormWritable || pendingDoubleClick,
							onChange: handleToggleDoubleClick
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
						title: "拖拽框选自动查词",
						description: "使用鼠标拖拽划选一段英文文本后，在释放鼠标时自动触发查词",
						isLast: true,
						control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
							id: "switch-auto-selection",
							label: "拖拽框选自动查词",
							checked: formSnapshot?.value?.autoSelection === true,
							disabled: !isFormWritable || pendingSelection,
							onChange: handleToggleSelection
						})
					}),
					configError && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						style: {
							marginTop: "12px",
							padding: "8px 12px",
							borderRadius: "6px",
							background: "rgba(239, 68, 68, 0.12)",
							border: "1px solid rgba(239, 68, 68, 0.3)",
							color: "var(--wl-set-error, #ef4444)",
							fontSize: "12px",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: configError }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							size: "small",
							variant: "ghost",
							onClick: () => setConfigError(null),
							children: "忽略"
						})]
					}),
					form && !isFormWritable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginTop: "8px",
							fontSize: "11.5px",
							color: "var(--wl-set-text-muted, #6c6c7a)"
						},
						children: "提示：当前设置处于只读模式或不可写入，开关已禁用。"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SectionCard, {
				title: "快捷键与高级功能",
				description: "查看与自定义划词查询快捷键，配置按键偏好。设置修改将即时持久化至宿主。",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "划词查询快捷键",
					description: shortcutServiceState === "SERVICE_UNAVAILABLE" ? "快捷键服务暂不可用。" : shortcutServiceState === "CATALOG_NOT_READY" ? "快捷键目录尚未就绪。" : shortcutServiceState === "COMMAND_NOT_REGISTERED" ? "划词查询命令尚未注册至快捷键服务。" : platform === "linux" && (!lookupShortcutEntry?.keys || lookupShortcutEntry.keys.length === 0) ? "Linux Web 平台受浏览器系统快捷键限制，默认未绑定。支持通过自定义配置按键。" : "选中任意文本后按下快捷键即可发起词典查询。支持在此重新绑定自定义按键。",
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center"
						},
						children: [shortcutServiceState === "SERVICE_UNAVAILABLE" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "shortcut-service-unavailable",
							style: {
								fontSize: "13px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "快捷键服务暂不可用"
						}) : shortcutServiceState === "CATALOG_NOT_READY" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "shortcut-catalog-not-ready",
							style: {
								fontSize: "13px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "快捷键服务未就绪"
						}) : shortcutServiceState === "COMMAND_NOT_REGISTERED" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "shortcut-command-not-registered",
							style: {
								fontSize: "13px",
								color: "var(--wl-set-text-muted, #6c6c7a)"
							},
							children: "划词命令未注册"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"data-testid": "shortcut-key-display",
							style: {
								fontSize: "13px",
								fontWeight: 600,
								fontFamily: "monospace",
								padding: "3px 8px",
								borderRadius: "6px",
								background: "rgba(255, 255, 255, 0.08)",
								color: "var(--wl-set-text-main, #f2f2f7)"
							},
							children: formatShortcutKeys(lookupShortcutEntry?.keys)
						}), shortcutServiceState === "READ_ONLY" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
							variant: "neutral",
							label: "只读"
						}) : lookupShortcutEntry?.modified ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
							variant: "warning",
							label: "已自定义"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
							variant: "neutral",
							label: "默认绑定"
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							"data-testid": "btn-edit-shortcut",
							size: "small",
							variant: "secondary",
							disabled: !isShortcutEditable,
							title: shortcutServiceState === "SERVICE_UNAVAILABLE" ? "快捷键服务暂不可用" : shortcutServiceState === "CATALOG_NOT_READY" ? "快捷键服务未就绪" : shortcutServiceState === "COMMAND_NOT_REGISTERED" ? "划词命令未注册" : shortcutServiceState === "READ_ONLY" ? "快捷键处于只读状态" : "修改划词查询快捷键",
							onClick: () => {
								if (isShortcutEditable) setShowShortcutRecorder(true);
							},
							children: "修改快捷键"
						})]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: "自定义外部 SQLite 词典",
					description: "支持指定本地用户自建或专业领域的 SQLite 词库文件。请在上方“自定义 SQLite 词典管理”区域配置并挂载使用。",
					isLast: true,
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
						variant: "success",
						label: "已支持"
					})
				})]
			}),
			showRemoveConfirm && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModalConfirm, {
				title: "确认移除 ECDICT 本地词典？",
				message: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "移除操作将安全删除本地托管的 ECDICT SQLite 数据库文件并释放存储空间。若当前处于 ECDICT 模式，插件将自动回退到内置基础词典 (Fixture)；若当前处于自定义词典模式，则将继续保持自定义模式。该操作不会影响任何用户自有的自定义文件。" }),
				confirmLabel: "确认移除",
				cancelLabel: "取消",
				isDanger: true,
				onConfirm: () => {
					setShowRemoveConfirm(false);
					store.remove();
				},
				onCancel: () => setShowRemoveConfirm(false)
			}),
			snapshotToRemove && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModalConfirm, {
				title: `确认删除自定义词典快照 "${snapshotToRemove.identity}"？`,
				message: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
					"该操作将安全清理插件内部管理的快照副本（ID: ",
					snapshotToRemove.snapshotId,
					"）。您的本地原始数据库文件将保持完整，绝不会被修改或删除。"
				] }),
				confirmLabel: "确认删除",
				cancelLabel: "取消",
				isDanger: true,
				onConfirm: () => void handleConfirmRemoveCustom(),
				onCancel: () => setSnapshotToRemove(null)
			}),
			showShortcutRecorder && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ShortcutRecorderModal, {
				currentKeys: lookupShortcutEntry?.keys ?? (platform === "macos" ? [
					"⌘",
					"Shift",
					"L"
				] : [
					"Ctrl",
					"Shift",
					"L"
				]),
				isModified: Boolean(lookupShortcutEntry?.modified),
				onClose: () => setShowShortcutRecorder(false),
				onSave: handleSaveShortcut,
				onReset: handleResetShortcut,
				describeBinding: activeShortcuts?.describeBinding ? (b) => activeShortcuts.describeBinding(b) : void 0,
				recording: handleRecording
			}),
			showSnapshotPicker && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SnapshotPickerModal, {
				snapshots: customSnapshots,
				activeSnapshotId: status?.activeSnapshotId,
				isActing: !canSwitchMode,
				onClose: () => setShowSnapshotPicker(false),
				onSelect: handleSelectCustomSnapshot
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
/** Value snapshot only: never retain a live Selection or Range across events. */
function readSelectionEndpoints(doc) {
	const selection = doc.getSelection();
	return selection === null ? null : {
		anchorNode: selection.anchorNode,
		anchorOffset: selection.anchorOffset,
		focusNode: selection.focusNode,
		focusOffset: selection.focusOffset
	};
}
/** Resolve through the composed path, then inspect all DOM ancestors. */
function readAutomaticSurface(doc, event) {
	const elements = event.composedPath().filter((node) => node?.nodeType === 1);
	const target = elements[0] ?? elementFor(event.target);
	if (target === null) return null;
	for (const element of /* @__PURE__ */ new Set([target, ...elements])) if (element.closest("input, textarea, select, [contenteditable=\"\"], [contenteditable=\"true\"], [role=\"textbox\"], [contenteditable]:not([contenteditable=\"false\"]), button, a, [role=\"button\"], [role=\"link\"], [role=\"dialog\"], [aria-modal=\"true\"], [data-dsh-word-lookup=\"card\"], .dsh-wl-card, .dsh-wl-settings, .snapshot-picker-modal") !== null) return null;
	let resolved = false;
	for (const element of /* @__PURE__ */ new Set([target, ...elements])) {
		for (let ancestor = element; ancestor !== null; ancestor = ancestor.parentElement) {
			const style = doc.defaultView?.getComputedStyle(ancestor);
			const value = [style?.userSelect, style?.getPropertyValue("-webkit-user-select")].find((value) => value !== void 0 && value !== "" && value !== "auto");
			if (value === "none") return null;
			if (value !== void 0) {
				resolved = true;
				break;
			}
		}
		if (resolved) break;
	}
	const flow = target.closest(CONVERSATION_FLOW_SELECTOR);
	return flow === null ? null : {
		target,
		flow
	};
}
function readPointCaret(doc, x, y) {
	const caretDoc = doc;
	const position = caretDoc.caretPositionFromPoint?.(x, y);
	if (position !== void 0 && position !== null) return {
		node: position.offsetNode,
		offset: position.offset
	};
	const range = caretDoc.caretRangeFromPoint?.(x, y);
	return range === void 0 || range === null ? null : {
		node: range.startContainer,
		offset: range.startOffset
	};
}
/** Caret positions may map to a selected endpoint from trailing line whitespace. */
function pointTouchesRange(range, caret, x, y) {
	if (caret !== null) {
		const node = caret.node;
		const length = [
			3,
			4,
			7,
			8
		].includes(node.nodeType) ? node.nodeValue?.length ?? 0 : node.childNodes.length;
		if (node.nodeType === 10 || !Number.isInteger(caret.offset) || caret.offset < 0 || caret.offset > length) return false;
		return caret.node.getRootNode() === range.startContainer.getRootNode() && range.isPointInRange(caret.node, caret.offset);
	}
	return Array.from(range.getClientRects()).some((rect) => x >= rect.x - 2 && x <= rect.x + rect.width + 2 && y >= rect.y - 2 && y <= rect.y + rect.height + 2);
}
/** Associate this gesture's two targets/points with the newly read live Range. */
function isSelectionRelatedToGesture(doc, selection, context, event) {
	if (context === null) return false;
	const end = readAutomaticSurface(doc, event);
	const live = readSelectionEndpoints(doc);
	if (end === null || live === null) return false;
	const anchor = elementFor(live.anchorNode)?.closest(CONVERSATION_FLOW_SELECTOR);
	const focus = elementFor(live.focusNode)?.closest(CONVERSATION_FLOW_SELECTOR);
	if (!(context.surface.flow === anchor && end.flow === focus || context.surface.flow === focus && end.flow === anchor)) return false;
	const range = selection.range;
	if (!range.intersectsNode(context.surface.target) || !range.intersectsNode(end.target)) return false;
	const startCaret = context.caret ?? readPointCaret(doc, context.x, context.y);
	const endCaret = readPointCaret(doc, event.clientX, event.clientY);
	if (!pointTouchesRange(range, startCaret, context.x, context.y) || !pointTouchesRange(range, endCaret, event.clientX, event.clientY)) return false;
	const before = context.before;
	return before === null || before.anchorNode !== live.anchorNode || before.focusNode !== live.focusNode || before.anchorOffset !== live.anchorOffset || before.focusOffset !== live.focusOffset || context.surface.target.contains(live.anchorNode) && end.target.contains(live.focusNode) || context.surface.target.contains(live.focusNode) && end.target.contains(live.anchorNode);
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
					form,
					shortcuts: ctx.shortcuts
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
		let automaticContext = null;
		const captureSelection = (event) => {
			try {
				const selection = readEligibleSelection(document);
				if (selection !== null && isSelectionRelatedToGesture(document, selection, automaticContext, event)) return {
					eligible: true,
					text: selection.text,
					rect: selection.rect
				};
			} catch {}
			automaticContext = null;
			return EMPTY_SELECTION;
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
			if (event.button === 0) {
				automaticContext = null;
				try {
					const surface = readAutomaticSurface(document, event);
					automaticContext = surface === null ? null : {
						surface,
						before: readSelectionEndpoints(document),
						caret: readPointCaret(document, event.clientX, event.clientY),
						x: event.clientX,
						y: event.clientY
					};
				} catch {
					automaticContext = null;
				}
			}
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
			const selection = captureSelection(event);
			const previous = gesture.state;
			gesture = observePointerUp(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, selection.eligible);
			if (gesture.state !== previous) considerAutomatic(selection);
			if (gesture.state.clickMultiplicity !== "multi") automaticContext = null;
		};
		const onDoubleClick = (event) => {
			const selection = captureSelection(event);
			gesture = observeDoubleClick(gesture, {
				x: event.clientX,
				y: event.clientY,
				at: Date.now()
			}, selection.eligible);
			considerAutomatic(selection);
			automaticContext = null;
		};
		const onCancelGesture = () => {
			automaticContext = null;
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
			automaticContext = null;
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
			set: (field, value) => form.set(field, value),
			unload: () => {
				lookup.dispose();
				store.clear();
				disposer.disposeAll();
			},
			reload: () => {
				lookup.dispose();
				store.clear();
				disposer.disposeAll();
				if (lastClientContext) apply(lastClientContext);
			}
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
let lastClientContext = null;
/**
* Apply the plugin's browser contributions.
*
* One `ctx.effect` owns the whole runtime, so the Cordis fiber has exactly one
* thing to unwind when the plugin unloads or reloads.
*
* @param ctx - the client root context DSH hands to a browser plugin.
*/
function apply(ctx) {
	lastClientContext = ctx;
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