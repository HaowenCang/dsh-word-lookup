/**
 * Types for {@link ./redact.mjs}.
 *
 * The scrubber is plain ESM so the verification harness can import it without a
 * build step; this declaration is what lets the TypeScript test suite assert its
 * behaviour under `npm run typecheck`.
 */

/** What a removed token is replaced with. */
export declare const REDACTED_TOKEN: string

/**
 * Replace every launch token in a string.
 *
 * @param text - the text to scrub.
 * @returns the text with every `token=…` value replaced.
 */
export declare function redactTokenText(text: string): string

/**
 * Recursively replace every launch token in a JSON-shaped value.
 *
 * @param value - any JSON-shaped value: a report object, an array, or a string.
 * @returns the same shape with every token scrubbed.
 */
export declare function redactTokens<T>(value: T): T
