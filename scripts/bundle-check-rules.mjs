import { builtinModules } from 'node:module'
import ts from 'typescript'

const EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const SQL_STATEMENTS = [
  /SELECT\s+[\w*][\w*,\s().]*\s+FROM\s+\w/i, /INSERT\s+INTO\s+\w/i,
  /DELETE\s+FROM\s+\w/i, /UPDATE\s+\w+\s+SET\s+\w/i, /CREATE\s+(TABLE|INDEX)\s/i,
  /PRAGMA\s+\w/i, /BEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION)/i,
  /ORDER\s+BY\s+\w+\s+(ASC|DESC)/i,
]

/** Check the browser bundle without reading artifacts or changing input bytes. */
export function checkClientBundle(client, pluginId = 'dsh-word-lookup') {
  const results = []
  const check = (name, ok, detail = '') => results.push({ name, ok, detail })
  // Only the envelope's formatting view is normalized; capability checks and
  // callers' hashes continue to use the unmodified bundle text/bytes.
  const format = client.replace(/\r\n/g, '\n')
  const head = ['window.__ModuleLoader__.load({', `\tid: ${JSON.stringify(pluginId)},`, '\tfactory: (require) => {', '\t\tvar module = { exports: {} };', '\t\tvar exports = module.exports;'].join('\n')
  const tail = ['\t\treturn module.exports;', '\t}', '});'].join('\n')
  check('client bundle opens with the module-loader envelope', format.startsWith(head))
  check('client bundle closes with the module-loader envelope', format.trimEnd().endsWith(tail))
  // Use the same installed parser as store-worker-audit. Traversing expressions
  // catches calls inside template interpolation while leaving UI strings alone.
  const source = ts.createSourceFile('client-bundle.js', client, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const specifiers = []
  let moduleSyntax = false
  let dynamicImport = false
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      moduleSyntax = true
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node)) {
      moduleSyntax = true
      if (ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text)
    }
    if (ts.isExportAssignment(node) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) || (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)) moduleSyntax = true
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const isImport = expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = (ts.isIdentifier(expression) && expression.text === 'require') || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'require')
      if (isImport) dynamicImport = true
      if (isImport || isRequire) {
        const argument = node.arguments[0]
        specifiers.push(argument && ts.isStringLiteralLike(argument) ? argument.text : '(non-literal module specifier)')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  check('client bundle parses as JavaScript', source.parseDiagnostics.length === 0)
  const unique = [...new Set(specifiers)].sort()
  check('client bundle has no top-level import/export', !moduleSyntax)
  check('client bundle has no dynamic import', !dynamicImport)
  check('client bundle requires only the declared externals', unique.every((name) => EXTERNALS.has(name)), unique.join(', ') || '(none)')
  check('client bundle requires react', unique.includes('react'))
  check('React is not bundled into the client', !/function\s+createElement\s*\(/.test(client) || unique.includes('react'))
  check('client bundle references no SQLite driver module', !unique.some((name) => /^(?:node:sqlite|sqlite3|better-sqlite3)(?:\/|$)/.test(name)), unique.join(', ') || '(none)')
  for (const token of ['DatabaseSync', 'StatementSync', 'CREATE TABLE', 'INSERT INTO', 'DELETE FROM', 'PRAGMA', 'dictionary.fixture', 'fixtures/', 'dictionaryPath']) {
    check(`client bundle contains no "${token}"`, !client.includes(token))
  }
  const sqlHit = SQL_STATEMENTS.find((pattern) => pattern.test(client))
  check('client bundle contains no SQL statement', sqlHit === undefined, sqlHit ? `matched ${sqlHit}` : 'no statement shape found')
  check('client bundle requires no Node built-in module', !unique.some((name) => name.startsWith('node:') || BUILTINS.has(name)), unique.join(', ') || '(none)')
  check('client bundle names no filesystem or path API', !/\b(readFileSync|writeFileSync|existsSync|mkdirSync|fileURLToPath)\b/.test(client))
  return results
}
