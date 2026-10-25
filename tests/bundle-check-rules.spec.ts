import { describe, expect, it } from 'vitest'
import { checkClientBundle } from '../scripts/bundle-check-rules.mjs'

const head = ['window.__ModuleLoader__.load({', '\tid: "dsh-word-lookup",', '\tfactory: (require) => {', '\t\tvar module = { exports: {} };', '\t\tvar exports = module.exports;'].join('\n')
const tail = ['\t\treturn module.exports;', '\t}', '});'].join('\n')
const fixture = (body = '') => `${head}\nrequire("react");\n${body}\n${tail}`
const approved = (text: string) => checkClientBundle(text).every((row) => row.ok)

describe('client bundle gate rules', () => {
  it.each(['.sqlite3', 'sqlite3', 'better-sqlite3', 'import sqlite3 from "sqlite3"'])('allows UI quoted text %s', (label) => {
    expect(approved(fixture(`const label = ${JSON.stringify(label)};`))).toBe(true)
  })
  it.each(['\n', '\r\n'])('accepts the legal envelope using %j without changing input', (eol) => {
    const bytes = fixture().replaceAll('\n', eol)
    expect(approved(bytes)).toBe(true)
    expect(bytes).toContain(eol)
  })
  it.each([
    'require("sqlite3")', 'require ( "better-sqlite3" )', 'require("sqlite3/lib/sqlite3")', 'module.require("sqlite3")',
    'const ui = `value ${require("sqlite3")}`;', 'const ui = `value ${import("node:fs")}`;',
    'require("sqlite\\x33")', 'require(`better-sqlite3`)',
    'import {DatabaseSync} from "node:sqlite";', 'import "sqlite3";', 'import("sqlite3")',
    'require("fs")', 'require("node:fs")', 'export * from "better-sqlite3";',
    'export{a};', 'import{a}from"somewhere";', 'const db = new DatabaseSync();',
    'StatementSync;', 'readFileSync("secret")', 'const sql = "SELECT * FROM entries";',
    'const sql = "PRAGMA integrity_check";',
  ])('rejects executable capabilities or module syntax: %s', (body) => {
    expect(approved(fixture(body))).toBe(false)
  })
  it.each([fixture().replace(head, ''), fixture().replace(tail, ''), fixture().replace('id: "dsh-word-lookup"', 'id: "wrong"')])('rejects missing/wrong envelope', (text) => {
    expect(approved(text)).toBe(false)
  })
  it('ignores comments and UI strings while detecting spaced require', () => {
    expect(approved(fixture('// require("sqlite3")\nconst ui = "export { sqlite3 }";'))).toBe(true)
    expect(approved(fixture('require /* comment */ ("sqlite3")'))).toBe(false)
  })
})
