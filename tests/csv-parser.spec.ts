import { describe, expect, it } from 'vitest'
import { StreamingCsvParser } from '../src/host/csv-parser.js'

describe('StreamingCsvParser', () => {
  it('parses simple records without quotes', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('a,b,c\n1,2,3\n')
    parser.end()

    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('handles CRLF line endings', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('header1,header2\r\nval1,val2\r\nval3,val4\r\n')
    parser.end()

    expect(rows).toEqual([
      ['header1', 'header2'],
      ['val1', 'val2'],
      ['val3', 'val4'],
    ])
  })

  it('preserves commas inside quoted fields', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('word,"n. a, b, and c",42\n')
    parser.end()

    expect(rows).toEqual([['word', 'n. a, b, and c', '42']])
  })

  it('preserves actual newlines inside quoted fields (multiline RFC 4180)', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('entry1,"line 1\nline 2\r\nline 3",pos\nentry2,simple,pos2\n')
    parser.end()

    expect(rows).toEqual([
      ['entry1', 'line 1\nline 2\r\nline 3', 'pos'],
      ['entry2', 'simple', 'pos2'],
    ])
  })

  it('unescapes double quotes correctly', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('word,"quoted ""quote"" here",1\n')
    parser.end()

    expect(rows).toEqual([['word', 'quoted "quote" here', '1']])
  })

  it('handles chunk boundaries across quotes and escaped quotes', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    // Chunk splits inside `""` and across boundaries
    parser.push('word,"start ')
    parser.push('of ')
    parser.push('quoted ""')
    parser.push('value"" ')
    parser.push('end",trailing\n')
    parser.end()

    expect(rows).toEqual([['word', 'start of quoted "value" end', 'trailing']])
  })

  it('handles CRLF split across chunk boundary', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('row1,col1\r')
    parser.push('\nrow2,col2')
    parser.end()

    expect(rows).toEqual([
      ['row1', 'col1'],
      ['row2', 'col2'],
    ])
  })

  it('handles UTF-8 multibyte boundary across chunks', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    // Chinese character: 汉 (E6 B1 89)
    const buf = Buffer.from('word,"释义: 汉语",tag\n', 'utf8')
    const splitIndex = buf.indexOf(Buffer.from('汉', 'utf8')) + 1 // split inside the 3-byte character

    parser.push(buf.subarray(0, splitIndex))
    parser.push(buf.subarray(splitIndex))
    parser.end()

    expect(rows).toEqual([['word', '释义: 汉语', 'tag']])
  })

  it('handles empty fields correctly', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('a,,c\n,,\n')
    parser.end()

    expect(rows).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ])
  })

  it('flushes last row without trailing newline', () => {
    const rows: string[][] = []
    const parser = new StreamingCsvParser((row) => rows.push(row))

    parser.push('word,phonetic')
    parser.end()

    expect(rows).toEqual([['word', 'phonetic']])
  })

  describe('Fatal UTF-8 verification', () => {
    it('fails loud on invalid UTF-8 continuation byte', () => {
      const rows: string[][] = []
      const parser = new StreamingCsvParser((row) => rows.push(row))

      // 0xFF is never valid UTF-8
      const invalidBuf = Buffer.from([0x77, 0x6f, 0x72, 0x64, 0x2c, 0xff, 0x2c, 0x31, 0x0a])
      expect(() => {
        parser.push(invalidBuf)
      }).toThrow(TypeError)
    })

    it('fails loud on truncated multibyte sequence at EOF', () => {
      const rows: string[][] = []
      const parser = new StreamingCsvParser((row) => rows.push(row))

      // Start of 3-byte CJK character '中' (E4 B8 AD) without the final byte
      const truncatedBuf = Buffer.from([0x77, 0x6f, 0x72, 0x64, 0x2c, 0xe4, 0xb8])
      parser.push(truncatedBuf)

      expect(() => {
        parser.end()
      }).toThrow(TypeError)
    })

    it('fails loud on invalid UTF-8 inside quoted field', () => {
      const rows: string[][] = []
      const parser = new StreamingCsvParser((row) => rows.push(row))

      // "hello <invalid byte> world" inside quotes
      const invalidQuotedBuf = Buffer.from([
        0x22, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xfe, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x22, 0x0a,
      ])
      expect(() => {
        parser.push(invalidQuotedBuf)
      }).toThrow(TypeError)
    })
  })
})
