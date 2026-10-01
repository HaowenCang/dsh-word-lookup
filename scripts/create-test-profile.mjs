#!/usr/bin/env node
/**
 * Create the isolated DSH profile this project's runtime tests run against.
 *
 * The profile is a genuine DSH Web composition — the two first-party bundles
 * plus this plugin — with the plugin installed as a **profile bundle entry**.
 * That shape matters: `SettingsForms.describe()` walks the profile root's
 * configuration, so a plugin injected at runtime through `loader.create` is not
 * a configurable entry and its switches read `unavailable`. Phase 0 measured
 * that difference and this script reproduces the shape that works.
 *
 * Three coordinated files and one link, all inside the test root:
 *
 * | Path                                   | Purpose                              |
 * | -------------------------------------- | ------------------------------------ |
 * | `profiles/<p>/cordis.yml`              | empty entry list; the tree is patches |
 * | `profiles/<p>/cordis.patch.yml`        | bind the test port only              |
 * | `profiles/<p>/package.json`            | bundles + `link:` dependency         |
 * | `profiles/<p>/node_modules/<package>`  | junction so the Loader resolves it   |
 *
 * Sibling profile files are copied to `<home>/.profile-backup/<stamp>/` before
 * anything is written, so a crashed test can be rebuilt without guessing.
 *
 * Every mutation happens after `assertIsolatedDshEnvironment()` has accepted the
 * target. If it does not, this script exits non-zero without touching a thing.
 *
 * Usage:
 *   node scripts/create-test-profile.mjs [--home <dir>] [--profile <name>] [--port <port>]
 *
 * @module dsh-word-lookup/scripts/create-test-profile
 */

import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  assertIsolatedDshEnvironment,
  DEFAULT_TEST_ROOT,
  ISOLATION_BANNER,
  IsolationError,
} from './assert-isolated-env.mjs'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Package name; equals the Loader entry id and the settings namespace. */
const PACKAGE_NAME = 'dsh-word-lookup'

/** Bundles every isolated verification profile composes. */
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE_NAME]

/** Profile files copied aside before a re-create overwrites them. */
const BACKED_UP_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml']

/** Default test port, chosen away from every production port. */
const DEFAULT_PORT = 50991

/**
 * Parse `--key value` / `--flag` arguments.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[token.slice(2)] = 'true'
    } else {
      options[token.slice(2)] = value
      index += 1
    }
  }
  return options
}

/**
 * Read the installed DSH version, never failing the run over it.
 *
 * @returns the version string, or `'unknown'`.
 */
function dshVersion() {
  const result = spawnSync('dsh', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const match = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(text)
  return match === null ? 'unknown' : match[0]
}

const options = parseArgs(process.argv.slice(2))
const testRoot = resolve(options['test-root'] ?? DEFAULT_TEST_ROOT)
const home = resolve(options.home ?? join(testRoot, 'home'))
const profile = options.profile ?? 'word-lookup-test'
const port = Number(options.port ?? DEFAULT_PORT)
const pluginDir = resolve(options.plugin ?? REPO_ROOT)

// --- gate ------------------------------------------------------------------
// Nothing below this line may run unless the target is provably scratch.
let verified
try {
  verified = assertIsolatedDshEnvironment({ home, profile, port, testRoot })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nrefusing to create a profile: the target is not an isolated test environment')
    process.exit(2)
  }
  throw error
}

// --- preconditions ---------------------------------------------------------
const clientBundle = join(pluginDir, 'lib', 'client.js')
const hostBundle = join(pluginDir, 'lib', 'index.js')
if (!existsSync(clientBundle) || !existsSync(hostBundle)) {
  console.error(`create-test-profile: ${pluginDir} has no build output; run \`npm run verify\` first`)
  process.exit(2)
}

const profileDir = verified.profileDir
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const backupDir = join(home, '.profile-backup', new Date().toISOString().replace(/[:.]/g, '-'))

/** Files copied aside before this run overwrites the profile. */
const backedUp = []
for (const name of BACKED_UP_FILES) {
  const source = join(profileDir, name)
  if (!existsSync(source)) continue
  mkdirSync(backupDir, { recursive: true })
  const target = join(backupDir, name)
  cpSync(source, target)
  backedUp.push(target)
}

// --- profile ---------------------------------------------------------------
mkdirSync(profileDir, { recursive: true })

writeFileSync(
  join(profileDir, 'cordis.yml'),
  [
    '# Isolated test profile: an empty entry list. The tree is composed as patches:',
    "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.",
    '[]',
    '',
  ].join('\n'),
  'utf8',
)

// Only the webserver binding is overridden. The `!!js` expression mirrors the
// product profile so a CLI `--port` still wins, which is what keeps the
// isolated instance off any port the machine already has in use.
writeFileSync(
  join(profileDir, 'cordis.patch.yml'),
  [
    '# Isolated test profile: bind the test port only.',
    '- id: webserver',
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    `    port: !!js ctx.webStartup.port ?? ${String(port)}`,
    '',
  ].join('\n'),
  'utf8',
)

const linkSpec = `link:${pluginDir.replace(/\\/g, '/')}`
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: `dsh-profile-${profile}`,
      private: true,
      dsh: { profile: { bundles: [...BASE_BUNDLES] } },
      dependencies: { [PACKAGE_NAME]: linkSpec },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

mkdirSync(dirname(linkPath), { recursive: true })
let linkAction = 'kept'
if (!existsSync(linkPath)) {
  symlinkSync(pluginDir, linkPath, 'junction')
  linkAction = 'created'
}

// --- record ----------------------------------------------------------------
const record = {
  dshVersion: dshVersion(),
  nodeVersion: process.version,
  dshHome: verified.home,
  dshProfile: verified.profile,
  profileDir: verified.profileDir,
  port: verified.port,
  testRoot: verified.testRoot,
  pluginSourcePath: pluginDir,
  pluginInstalledPath: linkPath,
  linkAction,
  backedUp,
  profilePackageJson: JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')),
  profilePatch: readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'),
}

console.log(JSON.stringify(record, null, 2))
console.log(ISOLATION_BANNER)
