/**
 * Deterministic stub dictionary for Phase 1.
 *
 * Its only purpose is to make the host → Fetch → client → overlay data path
 * observable end to end. It is not the v0.1.0 dictionary: there is no ECDICT
 * import, no lemma table, no exchange resolution, and no example corpus. The
 * entries below are hand-written constants, so a lookup is reproducible across
 * machines and a failing integration test cannot be confused with a data
 * problem.
 *
 * The inflection map exists so that the Phase 3 form resolution has a shape to
 * replace: 'derived', 'derives' and 'deriving' all resolve to 'derive', which is
 * the fixture behaviour the test matrix names for T10.
 *
 * @module dsh-word-lookup/host/dictionary
 */
import type { LookupExample, LookupMeaning } from '../shared/protocol.js';
/** One stub headword and everything the card can render for it. */
export interface StubEntry {
    /** Canonical headword; the key of {@link STUB_ENTRIES}. */
    readonly headword: string;
    /** IPA transcription, as plain text between slashes. */
    readonly phonetic: string;
    /** Senses in print order. */
    readonly meanings: readonly LookupMeaning[];
    /** Example sentences, most illustrative first. */
    readonly examples: readonly LookupExample[];
}
/** Every headword the stub knows, for tests and diagnostics. */
export declare const STUB_HEADWORDS: readonly string[];
/**
 * Resolve and fetch one already-normalized query.
 *
 * @param normalized - output of `normalizeHeadword`, or any lowercase key.
 * @returns the stub entry, or `undefined` when the dictionary has no such word.
 */
export declare function lookupStub(normalized: string): StubEntry | undefined;
