/**
 * Parse dictionary metadata without truncation or coercing non-string values.
 * Supported schema revisions are checked separately by each caller.
 */
export declare function parseDictionarySchemaVersion(value: unknown): number;
