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

export type CsvRowCallback = (row: string[], lineIndex: number) => void

export interface CsvParserOptions {
  /** Optional custom delimiter (defaults to comma `,`). */
  readonly delimiter?: string
}

export class StreamingCsvParser {
  readonly #delimiter: string
  readonly #onRow: CsvRowCallback
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })

  #inQuote = false
  #afterQuote = false
  #currentField = ''
  #currentRow: string[] = []
  #pendingCr = false
  #rowCount = 0

  constructor(onRow: CsvRowCallback, options: CsvParserOptions = {}) {
    this.#onRow = onRow
    this.#delimiter = options.delimiter ?? ','
  }

  /**
   * Push a binary Buffer, Uint8Array or string chunk into the parser.
   * Binary chunks are decoded with { fatal: true }, throwing on invalid UTF-8.
   */
  push(chunk: Uint8Array | Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true })
    this.#parseString(text)
  }

  /**
   * Signal end of stream. Flushes any pending fields and decoders.
   * Throws if an incomplete multibyte sequence remains at EOF.
   */
  end(): void {
    const finalStr = this.#decoder.decode()
    if (finalStr.length > 0) {
      this.#parseString(finalStr)
    }

    if (this.#afterQuote) {
      this.#inQuote = false
      this.#afterQuote = false
    }

    if (this.#currentRow.length > 0 || this.#currentField.length > 0) {
      this.#currentRow.push(this.#currentField)
      this.#currentField = ''
      this.#rowCount += 1
      this.#onRow(this.#currentRow, this.#rowCount)
      this.#currentRow = []
    }
  }

  get rowCount(): number {
    return this.#rowCount
  }

  #parseString(str: string): void {
    const len = str.length
    for (let i = 0; i < len; i += 1) {
      const c = str[i]!

      if (this.#pendingCr) {
        this.#pendingCr = false
        if (c === '\n') {
          // CRLF sequence completed; newline consumed
          continue
        }
        // If not followed by \n, proceed to process c normally
      }

      if (this.#afterQuote) {
        this.#afterQuote = false
        if (c === '"') {
          // Escaped quote: `""` inside quotes represents a literal `"`
          this.#currentField += '"'
          continue
        } else {
          // Closing quote was the true end of the quoted field
          this.#inQuote = false
          if (c === this.#delimiter) {
            this.#currentRow.push(this.#currentField)
            this.#currentField = ''
            continue
          } else if (c === '\r') {
            this.#currentRow.push(this.#currentField)
            this.#currentField = ''
            this.#rowCount += 1
            this.#onRow(this.#currentRow, this.#rowCount)
            this.#currentRow = []
            this.#pendingCr = true
            continue
          } else if (c === '\n') {
            this.#currentRow.push(this.#currentField)
            this.#currentField = ''
            this.#rowCount += 1
            this.#onRow(this.#currentRow, this.#rowCount)
            this.#currentRow = []
            continue
          } else {
            // Trailing characters after quote (RFC 4180 lenient recovery)
            this.#currentField += c
            continue
          }
        }
      }

      if (c === '"') {
        if (!this.#inQuote) {
          if (this.#currentField.length === 0) {
            this.#inQuote = true
          } else {
            // Unquoted quote appearing inside an unquoted field
            this.#currentField += '"'
          }
        } else {
          // Candidate closing quote or start of `""`
          this.#afterQuote = true
        }
      } else if (this.#inQuote) {
        this.#currentField += c
      } else if (c === this.#delimiter) {
        this.#currentRow.push(this.#currentField)
        this.#currentField = ''
      } else if (c === '\r') {
        this.#currentRow.push(this.#currentField)
        this.#currentField = ''
        this.#rowCount += 1
        this.#onRow(this.#currentRow, this.#rowCount)
        this.#currentRow = []
        this.#pendingCr = true
      } else if (c === '\n') {
        this.#currentRow.push(this.#currentField)
        this.#currentField = ''
        this.#rowCount += 1
        this.#onRow(this.#currentRow, this.#rowCount)
        this.#currentRow = []
      } else {
        this.#currentField += c
      }
    }
  }
}
