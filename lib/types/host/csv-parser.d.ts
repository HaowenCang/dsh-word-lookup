/**
 * Streaming RFC 4180 compliant CSV parser with fatal UTF-8 decoding.
 *
 * Designed for memory-efficient streaming of large corpus files without loading
 * the entire file or whole lines into RAM. Correctly handles:
 * - Quoted fields with commas
 * - Quoted fields with newlines (multiline records)
 * - Escaped double quotes (`""` -> `"`)
 * - Chunk boundaries splitting across quotes, commas, newlines, and CRLF
 * - Multibyte UTF-8 boundaries via `TextDecoder` streaming
 * - Fatal UTF-8 verification (fails loud on malformed or truncated byte sequences)
 * - Empty fields
 *
 * @module dsh-word-lookup/host/csv-parser
 */
export type CsvRowCallback = (row: string[], lineIndex: number) => void;
export interface CsvParserOptions {
    /** Optional custom delimiter (defaults to comma `,`). */
    readonly delimiter?: string;
}
export declare class StreamingCsvParser {
    #private;
    constructor(onRow: CsvRowCallback, options?: CsvParserOptions);
    /**
     * Push a binary Buffer, Uint8Array or string chunk into the parser.
     * Binary chunks are decoded with { fatal: true }, throwing on invalid UTF-8.
     */
    push(chunk: Uint8Array | Buffer | string): void;
    /**
     * Signal end of stream. Flushes any pending fields and decoders.
     * Throws if an incomplete multibyte sequence remains at EOF.
     */
    end(): void;
    get rowCount(): number;
}
