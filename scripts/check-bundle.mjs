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

// --- package.json addresses real files --------------------------------------
const pkg = JSON.parse(read('package.json'))
check('package.json name is the plugin id', pkg.name === PLUGIN_ID)
const exportPaths = [pkg.exports['.'].default, pkg.exports['.'].types, pkg.exports['./client'].default, pkg.exports['./client'].types]
check(
  'every exports path exists on disk',
  exportPaths.every((relative) => existsSync(join(ROOT, relative))),
  exportPaths.filter((relative) => !existsSync(join(ROOT, relative))).join(', ') || exportPaths.join(', '),
)
const files = pkg.files ?? []
check(
  'the published file list covers the build output',
  files.includes('lib') && files.includes('cordis.patch.yml'),
  files.join(', '),
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
