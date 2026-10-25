import { DatabaseSync } from 'node:sqlite'
import { createFixtureSchema, seedFixture } from '../src/host/fixture.js'

// Literal expectations catch truncation, unsafe integers and SQLite value coercion.
export const schemaVersionCases = [
  { label: 'canonical', value: '1', accepted: true, parsed: 1 },
  { label: 'padded', value: ' 1 ', accepted: true, parsed: 1 },
  { label: 'decimal normalization', value: '1.0', accepted: true, parsed: 1 },
  { label: 'exponent normalization', value: '1e0', accepted: true, parsed: 1 },
  { label: 'hex normalization', value: '0x1', accepted: true, parsed: 1 },
  { label: 'trailing junk', value: '1junk', accepted: false, parsed: null },
  { label: 'fraction', value: '1.5', accepted: false, parsed: null },
  { label: 'empty', value: '', accepted: false, parsed: null },
  { label: 'whitespace only', value: ' \t ', accepted: false, parsed: null },
  { label: 'null', value: null, accepted: false, parsed: null },
  { label: 'missing', value: undefined, accepted: false, parsed: null },
  { label: 'numeric SQLite value', value: 1, accepted: false, parsed: null },
  { label: 'blob SQLite value', value: new Uint8Array([49]), accepted: false, parsed: null },
  { label: 'unsupported', value: '99', accepted: false, parsed: 99 },
  { label: 'maximum safe unsupported', value: '9007199254740991', accepted: false, parsed: 9007199254740991 },
  { label: 'unsafe integer', value: '9007199254740992', accepted: false, parsed: null },
  { label: 'zero', value: '0', accepted: false, parsed: null },
  { label: 'negative', value: '-1', accepted: false, parsed: null },
  { label: 'NaN', value: 'NaN', accepted: false, parsed: null },
  { label: 'Infinity', value: 'Infinity', accepted: false, parsed: null },
] as const

/** Small fixture, with untyped nullable meta preserving real SQLite value types. */
export function buildSchemaVersionDatabase(path: string, value: string | number | null | undefined | Uint8Array): void {
  const db = new DatabaseSync(path)
  try {
    createFixtureSchema(db)
    seedFixture(db)
    db.exec('DROP TABLE meta; CREATE TABLE meta (key TEXT PRIMARY KEY, value);')
    if (value !== undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', value)
  } finally {
    db.close()
  }
}
