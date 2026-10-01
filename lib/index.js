import z from "@deepseek-ai/schemastery";
//#region src/host/config.ts
/**
* Host configuration of `dsh-word-lookup`.
*
* The DSH settings service reads this schema from the loader entry's runtime
* (`entry.fiber.runtime.Config`) and projects **only** the fields carrying
* `.volatile()` metadata as a browser-editable form. The entry id in
* `cordis.patch.yml` — `dsh-word-lookup` — is the namespace those writes address,
* which is why the two strings must stay equal.
*
* Both switches are `default(false)`: with neither automatic trigger enabled the
* manual `Primary+Shift+L` path is the only way a lookup can happen, which is the
* v0.1.0 default interaction.
*
* The two fields are independent top-level booleans on purpose. Nesting a
* volatile field under another volatile field is a hard parse error in the
* settings form projection, and a single switch covering both gestures could not
* express the truth table in `docs/06-test-matrix.md`.
*
* @module dsh-word-lookup/host/config
*/
/** The plugin's configuration schema, exported under the name DSH looks for. */
const Config = z.object({
	/** Automatic lookup after a completed double click. Off by default. */
	autoDoubleClick: z.boolean().default(false).volatile(),
	/** Automatic lookup after a completed drag selection. Off by default. */
	autoSelection: z.boolean().default(false).volatile()
});
/**
* Read one live volatile field.
*
* The settings service rewrites the same reference in place when a browser write
* is accepted, so a read at request time observes the newest value without any
* subscription on the host side.
*
* @param config - the parsed plugin configuration, or `undefined` before the
* first parse.
* @param field - the field to read.
* @returns the current value, or `false` when the configuration is absent.
*/
function readSwitch(config, field) {
	const value = config?.[field];
	return value === void 0 ? false : value.get() === true;
}
//#endregion
//#region src/shared/protocol.ts
/** Media type the route accepts. Any other request content type is a 400. */
const LOOKUP_MEDIA_TYPE = "application/json";
/**
* Maximum accepted request body size, in bytes.
*
* The transport buffers request bodies in memory before the handler runs, so
* the route states its own far smaller ceiling and refuses anything above it.
*/
const MAX_REQUEST_BYTES = 4096;
//#endregion
//#region src/shared/text.ts
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
* The steps are ordered: whitespace is collapsed first so that a selection
* spanning a line break becomes a single space, then edge punctuation is
* stripped so that a sentence-final period after a collapsed break is still
* removed, and finally the result is lowercased. Lowercasing last keeps the
* strip from depending on the case of the input.
*
* @param raw - the text the reader selected.
* @returns the normalized candidate; the empty string when nothing survives.
*/
function normalizeHeadword(raw) {
	return raw.replace(WHITESPACE_RUN, " ").trim().replace(EDGE_PUNCTUATION, "").trim().replace(WHITESPACE_RUN, " ").toLowerCase();
}
//#endregion
//#region src/host/dictionary.ts
/**
* Inflected surface forms the stub resolves to a headword.
*
* A flat table rather than a rule engine: Phase 1 must not grow a stemmer it
* cannot test, and Phase 3 replaces this wholesale with the ECDICT `exchange`
* column.
*/
const STUB_INFLECTIONS = {
	derived: "derive",
	derives: "derive",
	deriving: "derive",
	deriveds: "derive",
	went: "go",
	goes: "go",
	going: "go",
	gone: "go",
	looked: "look",
	looking: "look",
	looks: "look",
	selected: "select",
	selecting: "select",
	selects: "select",
	selections: "selection",
	dictionaries: "dictionary",
	words: "word"
};
/** The stub's content, keyed by canonical headword. */
const STUB_ENTRIES = {
	derive: {
		headword: "derive",
		phonetic: "/dɪˈraɪv/",
		meanings: [
			{
				partOfSpeech: "verb",
				definition: "obtain something from (a specified source)"
			},
			{
				partOfSpeech: "verb",
				definition: "base a concept on an extension or modification of another"
			},
			{
				partOfSpeech: "verb",
				definition: "originate in or be caused by"
			}
		],
		examples: [{
			en: "The result must derive from the boundary conditions alone.",
			zh: "该结果只能由边界条件导出。"
		}, {
			en: "This identity derives from Gauss’s law.",
			zh: "这一恒等式源自高斯定律。"
		}]
	},
	go: {
		headword: "go",
		phonetic: "/ɡəʊ/",
		meanings: [{
			partOfSpeech: "verb",
			definition: "move from one place to another"
		}, {
			partOfSpeech: "verb",
			definition: "come to be in a specified state"
		}],
		examples: [{
			en: "The measurement went the other way.",
			zh: "测量结果朝相反方向变化了。"
		}]
	},
	look: {
		headword: "look",
		phonetic: "/lʊk/",
		meanings: [{
			partOfSpeech: "verb",
			definition: "direct the eyes toward something in order to see it"
		}],
		examples: [{
			en: "Look at the figure before reading the proof.",
			zh: "先看图，再读证明。"
		}]
	},
	select: {
		headword: "select",
		phonetic: "/sɪˈlekt/",
		meanings: [{
			partOfSpeech: "verb",
			definition: "carefully choose as being the best or most suitable"
		}],
		examples: [{
			en: "Select the term to look up.",
			zh: "选中要查询的词。"
		}]
	},
	selection: {
		headword: "selection",
		phonetic: "/sɪˈlekʃn/",
		meanings: [{
			partOfSpeech: "noun",
			definition: "a carefully chosen group or item"
		}],
		examples: [{
			en: "The selection is passed to the host unchanged.",
			zh: "选区原样传给宿主。"
		}]
	},
	dictionary: {
		headword: "dictionary",
		phonetic: "/ˈdɪkʃənri/",
		meanings: [{
			partOfSpeech: "noun",
			definition: "a book or electronic resource listing words with meanings"
		}],
		examples: [{
			en: "The dictionary is queried locally.",
			zh: "词典在本地查询。"
		}]
	},
	word: {
		headword: "word",
		phonetic: "/wɜːd/",
		meanings: [{
			partOfSpeech: "noun",
			definition: "a single distinct meaningful element of speech or writing"
		}],
		examples: [{
			en: "One word is enough to demonstrate the path.",
			zh: "一个词就足以验证这条链路。"
		}]
	}
};
Object.keys(STUB_ENTRIES).sort();
/**
* Resolve and fetch one already-normalized query.
*
* @param normalized - output of `normalizeHeadword`, or any lowercase key.
* @returns the stub entry, or `undefined` when the dictionary has no such word.
*/
function lookupStub(normalized) {
	const direct = STUB_ENTRIES[normalized];
	if (direct !== void 0) return direct;
	const base = STUB_INFLECTIONS[normalized];
	return base === void 0 ? void 0 : STUB_ENTRIES[base];
}
//#endregion
//#region src/host/lookup.ts
/**
* Request handling for the exact Fetch route `POST /api/dsh-word-lookup`.
*
* The handler is a plain function of `(Request) => Promise<Response>` so that it
* can be exercised without a DSH process, a connection service, or a browser.
* It performs no I/O beyond reading the request body: there is no model call, no
* network call, and no filesystem access on this path, and Phase 1 must be able
* to prove that by reading the module.
*
* Refusals are controlled and machine-readable. Every malformed input produces
* a 400 with a stable `error` code from {@link LookupFailureCode} rather than an
* exception, because an unhandled throw inside a Fetch route surfaces to the
* browser as an opaque transport error and would make the failure modes
* indistinguishable from a broken route.
*
* @module dsh-word-lookup/host/lookup
*/
/** Bodies and headers are never cached: a lookup answers about a live selection. */
const NO_STORE = "no-store";
/**
* Build one controlled refusal.
*
* @param status - HTTP status; 400 for a malformed request, 405 for a method the
* route does not own.
* @param error - stable machine-readable reason.
* @param message - human-readable detail, for logs and for the browser console.
* @returns the response the route returns.
*/
function refusal(status, error, message) {
	const body = {
		ok: false,
		error,
		message
	};
	return Response.json(body, {
		status,
		headers: { "cache-control": NO_STORE }
	});
}
/**
* Build one successful response.
*
* @param body - the found or not-found payload.
* @returns a 200 with the shared no-store policy.
*/
function success(body) {
	return Response.json(body, {
		status: 200,
		headers: { "cache-control": NO_STORE }
	});
}
/**
* Read `query` out of an already-parsed body.
*
* @param raw - the parsed JSON value.
* @returns the raw query string, or a stable failure code when the body does not
* carry one.
*/
function extractQuery(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "malformed-body" };
	const value = raw.query;
	if (value === void 0) return { error: "missing-query" };
	if (typeof value !== "string") return { error: "missing-query" };
	return { query: value };
}
/**
* Create the route handler bound to one loader entry's configuration.
*
* @param config - the parsed configuration of this loader entry. Read at request
* time through {@link readSwitch}, so an accepted settings write is observable on
* the very next lookup.
* @returns the Fetch handler the route registers.
*/
function createLookupHandler(config) {
	return async function handleLookup(request) {
		if (request.method !== "POST") return refusal(405, "method-not-allowed", `dsh-word-lookup accepts POST, not ${request.method}`);
		const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
		if (contentType !== "application/json") return refusal(400, "unsupported-content-type", `expected ${LOOKUP_MEDIA_TYPE}, received "${contentType}"`);
		const declaredLength = Number(request.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > 4096) return refusal(400, "body-too-large", `body exceeds ${MAX_REQUEST_BYTES} bytes`);
		const text = await request.text();
		if (Buffer.byteLength(text, "utf8") > 4096) return refusal(400, "body-too-large", `body exceeds ${MAX_REQUEST_BYTES} bytes`);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return refusal(400, "malformed-body", "request body is not valid JSON");
		}
		const extracted = extractQuery(parsed);
		if ("error" in extracted) return refusal(400, extracted.error, "request body must be a JSON object with a string \"query\" field");
		const query = normalizeHeadword(extracted.query);
		if (query.length === 0) return refusal(400, "empty-query", "query is empty after normalization");
		if (countCodePoints(extracted.query.trim()) > 96) return refusal(400, "query-too-long", `query exceeds 96 code points`);
		const settings = {
			autoDoubleClick: readSwitch(config, "autoDoubleClick"),
			autoSelection: readSwitch(config, "autoSelection")
		};
		const entry = lookupStub(query);
		if (entry === void 0) return success({
			ok: true,
			found: false,
			query,
			source: "stub",
			settings
		});
		return success({
			ok: true,
			found: true,
			query,
			headword: entry.headword,
			phonetic: entry.phonetic,
			meanings: entry.meanings,
			examples: entry.examples,
			source: "stub",
			settings
		});
	};
}
//#endregion
//#region src/host/route.ts
/**
* The host's route path.
*
* The `/api` prefix is not added by the transport: `assertFetchRoute` rejects a
* path whose first segment is not `api`, and a route without the prefix would
* fail at plugin load rather than at request time.
*
* This module exists so the absolute string lives in the host half only. The
* browser half addresses the same route through the document-relative literal in
* `src/shared/protocol.ts`, and `tests/host-route.spec.ts` asserts that the two
* spell the same route — the browser bundle must never contain the absolute form,
* which a value derived from a shared constant would have put there.
*
* @module dsh-word-lookup/host/route
*/
/** Absolute path of the exact Fetch route owned by this plugin. */
const LOOKUP_PATH = "/api/dsh-word-lookup";
//#endregion
//#region src/index.ts
/** Package name; equals the Loader entry id and the settings namespace. */
const name = "dsh-word-lookup";
/** Host services required before this entry activates. */
const inject = ["connection"];
/**
* Register the host contributions.
*
* One effect owns the whole host surface, so unloading the loader entry removes
* the route exactly once. A second registration of the same path would throw
* `connection: exact Fetch route "…" is already registered`, which is a
* load-time signal rather than a silent duplicate.
*
* @param ctx - the host plugin context.
* @param config - the parsed {@link Config} output for this loader entry.
*/
function apply(ctx, config) {
	const handleLookup = createLookupHandler(config);
	ctx.effect(() => ctx.connection.fetch.register({
		path: LOOKUP_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: handleLookup
	}), "dsh-word-lookup: exact fetch route");
}
//#endregion
export { Config, apply, inject, name };
