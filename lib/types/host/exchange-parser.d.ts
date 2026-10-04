/**
 * Deterministic parser for ECDICT morphological `exchange` strings.
 *
 * Implements bidirectional morphological extraction:
 * - Forward variants: `p` (past), `d` (past participle), `i` (present participle),
 *   `3` (3rd singular), `r` (comparative), `t` (superlative), `s` (plural).
 * - Lemma references: `0:<lemma>/1:<kind>`.
 *
 * Mappings are normalized to `form` -> `headword` (observed surface form to canonical lemma).
 * Self-referential mappings are excluded.
 * Ambiguous forms (pointing to multiple headwords) are recorded for collision auditing
 * and excluded from the final forms table to guarantee deterministic single-headword resolution.
 *
 * @module dsh-word-lookup/host/exchange-parser
 */
export interface FormCandidate {
    readonly form: string;
    readonly headword: string;
    readonly kind: string | null;
}
export interface AmbiguousFormRecord {
    readonly form: string;
    readonly candidates: Array<{
        readonly headword: string;
        readonly kinds: string[];
    }>;
}
export interface ExchangeParseResult {
    /** Unambiguous forms suitable for insertion into forms table. */
    readonly forms: FormCandidate[];
    /** Ambiguous forms that collide across multiple headwords. */
    readonly ambiguous: AmbiguousFormRecord[];
    /** Statistics for auditing. */
    readonly stats: {
        readonly totalParsedForms: number;
        readonly uniqueForms: number;
        readonly unambiguousForms: number;
        readonly ambiguousForms: number;
        readonly selfReferentialExcluded: number;
    };
}
export declare class ExchangeCollector {
    #private;
    /**
     * Process one dictionary entry's exchange string.
     *
     * @param canonical - The entry headword.
     * @param exchange - The raw exchange string from CSV.
     */
    addEntry(canonical: string, exchange: string | null | undefined): void;
    /**
     * Resolve all collected mappings into unambiguous forms and ambiguous collisions.
     */
    resolve(): ExchangeParseResult;
}
