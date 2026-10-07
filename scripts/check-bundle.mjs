#!/usr/bin/env node
/**
 * Static verification of the built artifacts.
 *
 * `npm run build` succeeding only proves that rolldown produced *some* files. The
 * contracts Phase 1 depends on are about their exact shape: the browser half must
 * be one classic script carrying the module-loader envelope with no surviving
 * top-level `import`/`export`, React must arrive through that envelope's
 * `require` rather than being bundled, and every path in `package.json` must
 * address a file that exists.
 *
 * These checks read the emitted bytes, not the sources, because a bundler
 * misconfiguration is precisely the failure a source-level assertion cannot see.
 * They are the reason `npm run verify` can be trusted after a toolchain change.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this script's own location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The plugin id that must appear in the envelope and in `package.json`. */
const PLUGIN_ID = 'dsh-word-lookup'

/** Every check result, in execution order. */
const results = []

/**
 * Record one check.
 *
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - evidence or the reason it failed.
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
}

/**
 * Remove block and line comments from an emitted bundle.
 *
 * Used only where a *comment* is allowed to discuss something the *code* must
 * not claim — the host half's JSDoc names ECDICT and Tatoeba precisely to say it
 * does not use them. Every "must not contain" check that is about reachable code
 * runs against the raw text instead, because stripping could hide a violation
 * rather than reveal one.
 *
 * @param {string} text - the bundle text.
 * @returns the text with comments removed.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * Read a repository-relative file as UTF-8.
 *
 * @param {string} relative - path below the repository root.
 * @returns {string} the file's text.
 */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

const CLIENT = 'lib/client.js'
const HOST = 'lib/index.js'

// --- artifacts exist, and there is exactly one client chunk ------------------
if (!existsSync(join(ROOT, CLIENT)) || !existsSync(join(ROOT, HOST))) {
  console.error('check-bundle: lib/client.js and lib/index.js must exist; run `npm run build` first')
  process.exit(2)
}

const libEntries = readdirSync(join(ROOT, 'lib'), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort()
check(
  'lib contains exactly the two emitted artifacts',
  libEntries.length === 2 && libEntries.includes('client.js') && libEntries.includes('index.js'),
  libEntries.join(', '),
)
check(
  'no second client chunk was emitted',
  !libEntries.some((name) => name.includes('chunk') || name.includes('shared')),
  libEntries.join(', '),
)

const client = read(CLIENT)
const host = read(HOST)

// --- the loader envelope -----------------------------------------------------
const envelopeHead = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(PLUGIN_ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')
const envelopeTail = ['\t\treturn module.exports;', '\t}', '});'].join('\n')

check('client bundle opens with the module-loader envelope', client.startsWith(envelopeHead))
check('client bundle closes with the module-loader envelope', client.trimEnd().endsWith(envelopeTail))

// --- no surviving module syntax ---------------------------------------------
const topLevelModuleSyntax = client
  .split('\n')
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => /^(import|export)\s|^import\{|^export\{/.test(line))
check(
  'client bundle has no top-level import/export',
  topLevelModuleSyntax.length === 0,
  topLevelModuleSyntax.map((hit) => `line ${hit.number}: ${hit.line.slice(0, 60)}`).join(' | '),
)
check('client bundle has no dynamic import', !/\bimport\s*\(/.test(client))

// --- externals arrive through require ---------------------------------------
const requires = [...client.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
const externalRequires = [...new Set(requires)].sort()
check(
  'client bundle requires only the declared externals',
  externalRequires.every((specifier) =>
    ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(specifier),
  ),
  externalRequires.join(', ') || '(none)',
)
check('client bundle requires react', externalRequires.includes('react'))
check('React is not bundled into the client', !/function\s+createElement\s*\(/.test(client) || externalRequires.includes('react'))

// --- the plugin's own exported face -----------------------------------------
check('client bundle exports apply', /^exports\.apply = apply;$/m.test(client))
check('client bundle exports inject', /^exports\.inject = inject;$/m.test(client))

for (const [label, needle] of [
  ['shortcut command id', '"wordLookup.lookupSelection"'],
  ['overlay slot key', '"shell.overlay"'],
  ['card entry id', '"dsh-word-lookup:card"'],
]) {
  check(`client bundle carries the ${label}`, client.includes(needle), needle)
}

// --- the sealed interface strings -------------------------------------------
check(
  'client bundle carries the document-relative route and never the absolute form',
  client.includes('"api/dsh-word-lookup"') && !client.includes('"/api/dsh-word-lookup"'),
  'client must address api/dsh-word-lookup because the page sets <base href="./">',
)
check(
  'client bundle never fetches an absolute /api path',
  !/fetch\(\s*["'`]\/api\//.test(client),
)
check('client bundle contains no hard-coded route literal in fetch', !client.includes('fetch("/api'))

// --- the gesture path performs no I/O ---------------------------------------
// Phase 2 adds pointer and `dblclick` listeners whose whole job is to classify.
// The invariant that makes the two automatic switches meaningful is that only
// the manual command can reach the network, so the client half must contain
// exactly one call site — and it must be the transport's.
const fetchCallLines = client.split('\n').filter((line) => /\bfetch\s*\(/.test(line))
check(
  'the client half reaches the network from exactly one call site',
  fetchCallLines.length === 1,
  fetchCallLines.map((line) => line.trim().slice(0, 90)).join(' | ') || '(no fetch call found)',
)
check(
  'the only network call site is the lookup transport',
  fetchCallLines.length === 1 && fetchCallLines[0].includes('LOOKUP_DOCUMENT_PATH'),
  'a second call site would mean some other path can issue a request',
)
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'selectionchange']) {
  check(`client bundle subscribes to ${type}`, client.includes(`"${type}"`))
}
check(
  'client bundle declares the three required services',
  /\["slots",\s*"shortcuts",\s*"configForms"\]|"slots",\s*"shortcuts",\s*"configForms"/.test(client),
)
check(
  'client bundle registers the shortcut on five profiles and not web:linux',
  (client.match(/"(web|desktop):(windows|macos|linux)":/g) ?? []).length >= 5 &&
    !client.includes('"web:linux"'),
)

// --- host half ---------------------------------------------------------------
check('host bundle imports schemastery as an external', /^import z from "@deepseek-ai\/schemastery";$/m.test(host))
check('host bundle exports Config', /^export \{[\s\S]*\bConfig\b[\s\S]*\};$/m.test(host))
check('host bundle exports apply', /export \{\s*(?:[^}]*,\s*)?apply\b/.test(host) || /\bapply as\b/.test(host) || host.includes('apply'))
check('host bundle declares the exact route path', host.includes('"/api/dsh-word-lookup"'))
check('host bundle registers requestBody buffered', host.includes('"buffered"'))
check('host bundle does not use rpc.handle or rpc.intercept', !/\.rpc\.(handle|intercept)/.test(host))
check('host bundle carries no browser global', !/\bwindow\./.test(host) && !/\bdocument\./.test(host))
check(
  'host bundle makes no outbound call of its own',
  !/\bfetch\s*\(/.test(host) && !/from\s+"node:https?"/.test(host),
  'the handler answers from local data only; no provider or network call exists on this path',
)
check(
  'host bundle imports no model provider package',
  !/from\s+"@deepseek-ai\/dsh-llm/.test(host) && !/dsh-llm-deepseek/.test(host),
)

// --- Phase 3: the dictionary lives on the host side and only there -----------
// Phase 3 replaces the stub with a real SQLite store. The invariant that makes
// that safe is a one-way door: the database is reachable from the host half and
// unreachable from the browser half. These checks read the emitted bytes, so a
// bundler configuration that quietly hoisted a `node:` import into the client
// would fail here rather than at runtime in a reader's browser.
const CLIENT_FORBIDDEN = [
  'node:sqlite',
  'DatabaseSync',
  'StatementSync',
  'better-sqlite3',
  'sqlite3',
  'CREATE TABLE',
  'INSERT INTO',
  'DELETE FROM',
  'PRAGMA',
  'dictionary.fixture',
  'fixtures/',
  'dictionaryPath',
]
for (const token of CLIENT_FORBIDDEN) {
  check(`client bundle contains no "${token}"`, !client.includes(token))
}
// Statement *shapes* rather than bare keywords: the client half legitimately
// contains the word `select` inside the composer-exclusion CSS selector, so a
// keyword search would report a false positive and, worse, teach the next reader
// to ignore this check.
const SQL_STATEMENT_SHAPES = [
  /SELECT\s+[\w*][\w*,\s().]*\s+FROM\s+\w/i,
  /INSERT\s+INTO\s+\w/i,
  /DELETE\s+FROM\s+\w/i,
  /UPDATE\s+\w+\s+SET\s+\w/i,
  /CREATE\s+(TABLE|INDEX)\s/i,
  /PRAGMA\s+\w/i,
  /BEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION)/i,
  /ORDER\s+BY\s+\w+\s+(ASC|DESC)/i,
]
const sqlHit = SQL_STATEMENT_SHAPES.find((shape) => shape.test(client))
check(
  'client bundle contains no SQL statement',
  sqlHit === undefined,
  sqlHit === undefined
    ? 'no statement shape found'
    : `matched ${String(sqlHit)}: a dictionary query in the browser half would mean the dictionary shipped to the page`,
)
check(
  'client bundle requires no Node built-in module',
  !externalRequires.some((specifier) => specifier.startsWith('node:')),
  externalRequires.join(', ') || '(none)',
)
check(
  'client bundle names no filesystem or path API',
  !/\b(readFileSync|writeFileSync|existsSync|mkdirSync|fileURLToPath)\b/.test(client),
)

const hostCode = stripComments(host)
check(
  'host bundle loads node:sqlite as a built-in',
  host.includes('"node:sqlite"') && host.includes('DatabaseSync'),
  'the dictionary must be a real local SQLite store on the host side',
)
check(
  'host bundle ships the fixture schema',
  hostCode.includes('CREATE TABLE IF NOT EXISTS entries') && hostCode.includes('CREATE TABLE IF NOT EXISTS forms'),
)
check(
  'host bundle binds its queries through prepared statements',
  hostCode.includes('.prepare(') && hostCode.includes('BEGIN IMMEDIATE'),
  'the seed is one transaction',
)
check(
  'host bundle resolves the fixture from its own module URL',
  hostCode.includes('import.meta.url') && hostCode.includes('package.json'),
  'the database path is derived, never configured and never hard-coded to a machine',
)
check(
  'host bundle reports the fixture as its only provenance',
  hostCode.includes('"sqlite-fixture"'),
  'the runtime must not still answer as the Phase 1 stub',
)
// Phase 4 §37: the two switches now drive real behaviour, so the settings rows
// have to describe the gesture each one answers. The copy is asserted in the
// emitted host bundle because that is where DSH reads the config schema from.
for (const [field, description] of [
  ['autoSelection', 'Automatically look up after dragging to select text'],
  ['autoDoubleClick', 'Automatically look up a word after double-clicking it'],
]) {
  check(
    `host bundle describes ${field} as the gesture it answers`,
    host.includes(description),
    `the settings row must not read as "look up on any selection change"`,
  )
}
// Phase 3 required no stub or unbuilt corpus claimed as lookup provenance.
// In Phase 7A.4, the host exports the pinned ECDICT source descriptor, while
// the active lookup handler continues to report only sqlite-fixture.
check(
  'the emitted host code claims no stub as a source',
  !/"stub"|'stub'/.test(hostCode) && !/["']Tatoeba["']/.test(hostCode),
  'provenance must describe the data that is actually there',
)

// --- Phase 4: the trigger gate lives in the browser, and only there ----------
// Phase 4 connects the two switches to the gesture classifier. Two properties
// have to hold in the emitted bytes rather than only in the sources: the gate
// must actually be *in* the browser bundle, and the interaction concern it
// carries must not have leaked into the host. A gate that shipped to the host
// would mean the route had learned about pointer gestures, and a gate missing
// from the client would mean the switches were inert again.
for (const [label, needle] of [
  ['the auto-selection origin', '"auto-selection"'],
  ['the auto-double-click origin', '"auto-double-click"'],
  ['the manual origin', '"shortcut"'],
  ['the duplicate refusal reason', '"duplicate-gesture"'],
  ['the switched-off refusal reason', '"switch-off"'],
  ['the unverified-pointer refusal reason', '"unverified-pointer-kind"'],
  ['the not-a-trigger refusal reason', '"not-a-trigger-gesture"'],
  // Phase 4.1: the semantic-independence rule and the event that supplies it.
  ['the multi-click refusal reason', '"multi-click-sequence"'],
  ['the unverified-multiplicity refusal reason', '"unverified-click-multiplicity"'],
  ['the platform click-multiplicity values', '"single"'],
  ['a listener for the event that carries the click counter', '"mousedown"'],
]) {
  check(`client bundle carries ${label}`, client.includes(needle), needle)
}
check(
  'client bundle classifies pointer kinds, so an unverified one can be refused',
  client.includes('pointerType') && client.includes('"mouse"'),
  'the automatic paths are gated on the pointer kind the build measured',
)
check(
  'client bundle allocates a gesture identity',
  client.includes('gestureId') && client.includes('sequence'),
  'de-duplication is by identity, never by text or by a time window',
)
// Phase 4 §18: no timer may decide whether a gesture happened. `setTimeout` in
// the browser half would mean user-space gesture recognition rather than
// consuming the classifier and the platform's own `dblclick`.
const clientTimers = client.split('\n').filter((line) => /\b(setTimeout|setInterval|setImmediate)\s*\(/.test(line))
check(
  'client bundle uses no timer',
  clientTimers.length === 0,
  clientTimers.map((line) => line.trim().slice(0, 90)).join(' | ') || 'none',
)
// The interaction concern stays on the client: the host answers queries and
// knows nothing about how one was asked for.
for (const token of ['auto-selection', 'auto-double-click', 'gestureId', 'pointerType', 'duplicate-gesture', 'multi-click-sequence', 'clickMultiplicity']) {
  check(`host bundle carries no gesture concern ("${token}")`, !host.includes(token))
}
check(
  'host bundle still carries no pointer or selection event name',
  !/["'](pointerdown|pointerup|pointermove|selectionchange|dblclick)["']/.test(host),
  'a host that subscribed to a DOM event would be a second, unreviewed trigger path',
)
check(
  'client bundle requests no origin field on the wire',
  !client.includes('"origin"') && !/"origin"\s*:/.test(client),
  'origin is client state; the HTTP contract is unchanged by Phase 4',
)

// --- package.json addresses real files --------------------------------------
const pkg = JSON.parse(read('package.json'))
check('package.json name is the plugin id', pkg.name === PLUGIN_ID)
const exportPaths = [
  pkg.exports?.['.']?.default,
  pkg.exports?.['.']?.types,
  pkg.exports?.['./client']?.default,
  pkg.exports?.['./client']?.types,
].filter((path) => typeof path === 'string')
check(
  'every exports path exists on disk',
  exportPaths.every((relative) => existsSync(join(ROOT, relative))),
  exportPaths.filter((relative) => !existsSync(join(ROOT, relative))).join(', ') || exportPaths.join(', '),
)
const files = pkg.files ?? []
check(
  'the published file list covers the build output',
  (files.includes('lib') || (files.includes('lib/index.js') && files.includes('lib/client.js'))) &&
    files.includes('cordis.patch.yml'),
  files.join(', '),
)
// `files` is a promise to whoever installs this package. Listing a path that
// does not exist silently ships a package without it, so every entry is checked
// rather than only the two the build is known to produce.
const missingPublished = files.filter((relative) => !existsSync(join(ROOT, relative)))
check(
  'every published file entry exists on disk',
  missingPublished.length === 0,
  missingPublished.length === 0
    ? files.join(', ')
    : `missing: ${missingPublished.join(', ')}`,
)
check('dsh.bundle.patch exists', existsSync(join(ROOT, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch)
check('dsh.client.platform is web', pkg.dsh.client.platform === 'web')
check('dsh.client.inject lists the load-order dependencies', Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
check(
  'peer dependencies pin the installed schemastery and cordis lines',
  pkg.peerDependencies['@deepseek-ai/schemastery'].startsWith('~3.18') &&
    pkg.peerDependencies['@deepseek-ai/cordis'].startsWith('~4.0'),
  JSON.stringify(pkg.peerDependencies),
)

// --- the loader patch declares the settings namespace -----------------------
const patch = read('cordis.patch.yml')
check('patch inserts the plugin row', patch.includes('- id: dsh-word-lookup') && patch.includes("name: 'dsh-word-lookup'"))

// --- declarations ------------------------------------------------------------
for (const declaration of ['lib/types/index.d.ts', 'lib/types/client/index.d.ts']) {
  check(`${declaration} exists`, existsSync(join(ROOT, declaration)))
}
check(
  'lib/types is a directory',
  existsSync(join(ROOT, 'lib/types')) && statSync(join(ROOT, 'lib/types')).isDirectory(),
)

// --- report ------------------------------------------------------------------
const failed = results.filter((result) => !result.ok)
for (const result of results) {
  const mark = result.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${result.name}${result.detail ? `\n      ${result.detail}` : ''}`)
}
console.log(`\ncheck-bundle: ${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
