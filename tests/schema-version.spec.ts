import { describe, expect, it } from 'vitest'
import { parseDictionarySchemaVersion } from '../src/host/schema-version.js'
import { schemaVersionCases } from './schema-version-test-helpers.js'

describe('parseDictionarySchemaVersion', () => {
  it.each(schemaVersionCases)('$label parses independently of supported versions', ({ value, parsed }) => {
    if (parsed === null) expect(() => parseDictionarySchemaVersion(value)).toThrow(/schema_version/)
    else expect(parseDictionarySchemaVersion(value)).toBe(parsed)
  })

  it.each([true, false, {}, [], 1n, Symbol('1')])('rejects non-string input %s without coercion', (value) => {
    expect(() => parseDictionarySchemaVersion(value)).toThrow(/schema_version/)
  })
})
