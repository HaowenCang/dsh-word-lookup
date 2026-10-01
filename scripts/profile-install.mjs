#!/usr/bin/env node
/**
 * Install or remove this package as a **profile bundle entry**.
 *
 * A bundle entry is the only installation shape DSH's settings service serves:
 * `SettingsForms.describe()` walks `configEditor.configuration()`, which contains
 * the entries owned by the profile's root Include. An entry created at runtime
 * through `loader.create` — the super-injector path — is not among them, so the
 * two switches would be reported `unavailable` and every write refused. Phase 0
 * measured exactly that difference, and Phase 1 must therefore install this way.
 *
 * Installing is three coordinated edits, all of them reversible:
 *
 * 1. `dependencies.dsh-word-lookup = "link:<plugin dir>"` in the profile's
 *    `package.json`, so the profile states where the package comes from;
 * 2. a `node_modules/dsh-word-lookup` junction, so Node and the Loader can
 *    resolve it at boot;
 * 3. an entry in `dsh.profile.bundles`, so the composition applies the package's
 *    own `cordis.patch.yml` (`dsh.bundle.patch`) at boot.
 *
 * The profile's own `cordis.patch.yml` is deliberately **not** edited: the
 * package's bundle patch is what inserts the loader row, and writing the row in
 * two places would insert the entry twice.
 *
 * Usage:
 *   node scripts/profile-install.mjs install   [--home <DSH_HOME>] [--profile web] [--plugin <dir>]
 *   node scripts/profile-install.mjs uninstall [--home <DSH_HOME>] [--profile web]
 *   node scripts/profile-install.mjs status    [--home <DSH_HOME>] [--profile web]
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertIsolatedDshEnvironment,
  DEFAULT_TEST_ROOT,
  IsolationError,
} from './assert-isolated-env.mjs'

/** Package name; equals the Loader entry id and the settings namespace. */
const PACKAGE_NAME = 'dsh-word-lookup'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Parse `--key value` arguments.
 *
 * @param argv - arguments after the subcommand.
 * @returns the parsed options.
 */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[key] = 'true'
    } else {
      options[key] = value
      index += 1
    }
  }
  return options
}

const [subcommand = 'status', ...rest] = process.argv.slice(2)
const options = parseArgs(rest)

const dshHome = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileName = options.profile ?? process.env.DSH_PROFILE ?? 'web'
const profileDir = resolve(dshHome, 'profiles', profileName)
const pluginDir = resolve(options.plugin ?? REPO_ROOT)
const packageJsonPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

/**
 * Refuse to mutate a profile that is not a scratch test environment.
 *
 * This guard exists because this script used to default to
 * `DSH_HOME ?? ~/.dsh` and `DSH_PROFILE ?? 'web'` with nothing stopping it: run
 * from an ordinary shell in this project and it edited the profile the reader
 * was using. That is how a live profile was destroyed once already.
 *
 * `install` and `uninstall` therefore require an explicit, provably isolated
 * target. `status` only reads and is allowed anywhere, but says plainly when it
 * is looking at production.
 */
function gateProfileMutation() {
  if (subcommand !== 'install' && subcommand !== 'uninstall') return
  try {
    assertIsolatedDshEnvironment({
      home: dshHome,
      profile: profileName,
      profileDir,
      testRoot: options['test-root'] ?? DEFAULT_TEST_ROOT,
    })
  } catch (error) {
    if (error instanceof IsolationError) {
      console.error(error.message)
      console.error(
        `\nprofile-install: refusing to ${subcommand} into ${profileDir}.\n` +
          '  Plugin installation is a profile mutation and may only target the isolated test\n' +
          '  profile. Create it with `npm run test-profile:create`, or pass\n' +
          '  `--home <test root> --profile word-lookup-test`.',
      )
      process.exit(2)
    }
    throw error
  }
}

gateProfileMutation()

/**
 * Read the profile's `package.json`.
 *
 * @returns the parsed document.
 */
function readProfilePackage() {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'))
}

/**
 * Write the profile's `package.json`, keeping the original formatting style.
 *
 * @param document - the document to write.
 */
function writeProfilePackage(document) {
  writeFileSync(packageJsonPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/**
 * Back up a profile file outside the profile directory.
 *
 * @param path - the file to copy.
 * @param tag - suffix identifying this run.
 * @returns the backup path.
 */
function backup(path, tag) {
  const target = join(tmpdir(), `${profileName}-${PACKAGE_NAME}-${tag}.bak`)
  copyFileSync(path, target)
  return target
}

/**
 * Report whether the junction exists and where it points.
 *
 * @returns the link facts.
 */
function linkState() {
  if (!existsSync(linkPath)) return { present: false }
  const stats = lstatSync(linkPath)
  if (!stats.isSymbolicLink()) return { present: true, kind: 'directory', target: null }
  let target = null
  try {
    target = readlinkSync(linkPath)
  } catch {
    target = null
  }
  return { present: true, kind: 'junction', target }
}

const report = { subcommand, dshHome, profileName, profileDir, pluginDir, packageJsonPath, linkPath }

if (subcommand === 'status') {
  const document = readProfilePackage()
  report.bundles = document.dsh?.profile?.bundles ?? []
  report.bundleListed = report.bundles.includes(PACKAGE_NAME)
  report.dependency = document.dependencies?.[PACKAGE_NAME] ?? null
  report.link = linkState()
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (subcommand === 'install') {
  if (!existsSync(packageJsonPath)) {
    console.error(`profile-install: no profile at ${profileDir}`)
    process.exit(2)
  }
  if (!existsSync(join(pluginDir, 'lib', 'client.js')) || !existsSync(join(pluginDir, 'lib', 'index.js'))) {
    console.error(`profile-install: ${pluginDir} has no build output; run \`npm run build\` first`)
    process.exit(2)
  }

  const document = readProfilePackage()
  const before = JSON.stringify(document)
  document.dependencies ??= {}
  document.dsh ??= {}
  document.dsh.profile ??= {}
  document.dsh.profile.bundles ??= []

  const changes = []
  const linkSpec = `link:${pluginDir.replace(/\\/g, '/')}`
  if (document.dependencies[PACKAGE_NAME] !== linkSpec) {
    document.dependencies[PACKAGE_NAME] = linkSpec
    changes.push(`dependencies.${PACKAGE_NAME} = ${linkSpec}`)
  }
  if (!document.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    document.dsh.profile.bundles.push(PACKAGE_NAME)
    changes.push(`dsh.profile.bundles += ${PACKAGE_NAME}`)
  }

  if (changes.length > 0) {
    report.backup = backup(packageJsonPath, 'package.json')
    writeProfilePackage(document)
  } else {
    report.backup = null
  }
  report.changed = changes
  report.unchanged = JSON.stringify(document) === before

  mkdirSync(dirname(linkPath), { recursive: true })
  const state = linkState()
  if (state.present && state.kind === 'junction') {
    report.linkAction = 'kept'
  } else if (state.present) {
    console.error(`profile-install: ${linkPath} exists and is not a junction; refusing to replace it`)
    process.exit(3)
  } else {
    symlinkSync(pluginDir, linkPath, 'junction')
    report.linkAction = 'created'
  }

  report.after = {
    bundles: document.dsh.profile.bundles,
    dependency: document.dependencies[PACKAGE_NAME],
    link: linkState(),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (subcommand === 'uninstall') {
  if (!existsSync(packageJsonPath)) {
    console.error(`profile-install: no profile at ${profileDir}`)
    process.exit(2)
  }
  const document = readProfilePackage()
  const changes = []
  if (document.dependencies?.[PACKAGE_NAME] !== undefined) {
    delete document.dependencies[PACKAGE_NAME]
    changes.push(`dependencies.${PACKAGE_NAME} removed`)
  }
  const bundles = document.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    document.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    changes.push(`dsh.profile.bundles -= ${PACKAGE_NAME}`)
  }
  if (changes.length > 0) {
    report.backup = backup(packageJsonPath, 'package.json')
    writeProfilePackage(document)
  }
  report.changed = changes

  const state = linkState()
  if (state.present && state.kind === 'junction') {
    // Guard: remove the link only, never a directory with contents behind it.
    // `rmdirSync` on a junction removes the reparse point, not the target.
    rmSync(linkPath, { recursive: false, force: true })
    report.linkAction = 'removed'
  } else if (state.present) {
    report.linkAction = 'kept (not a junction)'
  } else {
    report.linkAction = 'absent'
  }

  report.after = {
    bundles: document.dsh?.profile?.bundles ?? [],
    dependency: document.dependencies?.[PACKAGE_NAME] ?? null,
    link: linkState(),
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

console.error(`profile-install: unknown subcommand "${subcommand}"`)
process.exit(2)
