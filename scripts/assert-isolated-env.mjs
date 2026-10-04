#!/usr/bin/env node
/**
 * The isolation gate every DSH runtime test in this project must pass first.
 *
 * This module exists because a plugin test once ran against the profile the
 * reader was using and destroyed it. The rule it enforces is therefore absolute:
 *
 *   No test may create, modify, load into, or start the production DSH home,
 *   profile, port, loader tree or session store — for any reason, however small
 *   the change looks and however easily it could "be reverted afterwards".
 *
 * `assertIsolatedDshEnvironment()` refuses a target unless it proves, from the
 * resolved absolute paths, that it is a scratch environment:
 *
 * 1. the target `DSH_HOME` is not the production home,
 * 2. the target `DSH_HOME` is not *inside* the production home,
 * 3. the target `DSH_HOME` lives under the test root,
 * 4. the test root itself does not resolve into the production home,
 * 5. the profile name is neither the daily profile nor the damaged `web` profile,
 * 6. the profile directory is `<home>/profiles/<name>`, inside the test root,
 * 7. the port is a valid high port and is none the production instance has used.
 *
 * The check is pure: it reads paths and environment variables and decides. It
 * never writes anything, so it is safe to call before any mutation and cheap
 * enough to call at the top of every runner.
 *
 * Usage:
 *   node scripts/assert-isolated-env.mjs --home <dir> --profile <name> --port <port>
 *
 * Exit codes: 0 = ISOLATION CHECK: PASS, 2 = refused (violations listed).
 *
 * @module dsh-word-lookup/scripts/assert-isolated-env
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Printed exactly once, only after every assertion holds. */
export const ISOLATION_BANNER = 'ISOLATION CHECK: PASS'

/** Default scratch root; every isolated home must live underneath it. */
export const DEFAULT_TEST_ROOT = resolve(join(tmpdir(), 'dsh-word-lookup-test'))

/**
 * Ports the daily instance has served on in this environment.
 *
 * `19387` is the GUI this project was audited from; `50001` is the port the
 * Phase 0 evidence records for the earlier daily instance. Neither may ever be
 * used by a test, even when nothing is listening on it.
 */
export const PRODUCTION_PORTS = Object.freeze([19387, 50001])

/** Profiles that carry real conversation data and are therefore off limits. */
export const FORBIDDEN_PROFILES = Object.freeze(['web', 'desktop'])

/** Thrown when a target is not provably isolated. */
export class IsolationError extends Error {
  /**
   * @param violations - one human-readable line per failed assertion.
   */
  constructor(violations) {
    super(`ISOLATION CHECK: FAIL\n  - ${violations.join('\n  - ')}`)
    this.name = 'IsolationError'
    this.violations = violations
  }
}

/**
 * Resolve a path to a comparable absolute form.
 *
 * Windows path comparison is case-insensitive and junctions make two different
 * spellings name one directory, so the resolved form is realpath'd when it
 * exists and lower-cased on Windows. Without this, `C:\Users\x\.dsh` and
 * `c:\users\x\.dsh\profiles\..` would compare as different environments.
 *
 * @param path - the path to normalise.
 * @returns the comparable absolute form.
 */
export function normalisePath(path) {
  let out = resolve(path)
  try {
    if (existsSync(out)) out = realpathSync.native(out)
  } catch {
    // A path that cannot be realpath'd (missing, locked) is still compared in
    // its resolved form; the shell-level assertions below do not depend on the
    // directory existing yet.
  }
  return process.platform === 'win32' ? out.toLowerCase() : out
}

/**
 * Whether one path is the other or lives underneath it.
 *
 * String prefix matching alone would treat `…\dsh-word-lookup-testx` as living
 * under `…\dsh-word-lookup-test`, so the separator is part of the comparison.
 *
 * @param child - the candidate descendant.
 * @param parent - the candidate ancestor.
 * @returns true when `child` is `parent` or inside it.
 */
export function isInsideOrEqual(child, parent) {
  const inner = normalisePath(child)
  const outer = normalisePath(parent)
  if (inner === outer) return true
  const prefix = outer.endsWith(sep) ? outer : outer + sep
  return inner.startsWith(prefix)
}

/**
 * The facts about the production environment that tests must avoid.
 *
 * Read from the environment rather than hard-coded so that the gate follows the
 * machine it runs on: the live GUI URL supplies the port the reader is actually
 * using, and `DSH_PROFILE` names the profile currently loaded.
 *
 * @param env - environment to read; defaults to this process's.
 * @returns the forbidden home, ports and profile names.
 */
export function productionFacts(env = process.env) {
  const homes = new Set([resolve(join(homedir(), '.dsh'))])
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    homes.add(resolve(env.DSH_HOME))
  }

  const ports = new Set(PRODUCTION_PORTS)
  if (typeof env.DSH_WEB_URL === 'string' && env.DSH_WEB_URL.trim() !== '') {
    try {
      const port = Number(new URL(env.DSH_WEB_URL).port)
      if (Number.isInteger(port) && port > 0) ports.add(port)
    } catch {
      // An unparseable URL simply contributes no port.
    }
  }

  const profiles = new Set(FORBIDDEN_PROFILES.map((name) => name.toLowerCase()))
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '') {
    profiles.add(env.DSH_PROFILE.trim().toLowerCase())
  }

  return { homes: [...homes], ports, profiles }
}

/**
 * Assert that a DSH target is a scratch environment.
 *
 * @param facts - the target to check.
 * @param facts.home - resolved `DSH_HOME` the test would use.
 * @param facts.profile - profile name the test would load.
 * @param facts.port - TCP port the test would bind; omitted by install-only callers.
 * @param facts.profileDir - optional profile directory; derived when omitted.
 * @param facts.testRoot - scratch root; defaults to {@link DEFAULT_TEST_ROOT}.
 * @param facts.env - environment to read production facts from.
 * @returns the verified facts, including the derived `profileDir` and `testRoot`.
 * @throws {IsolationError} when any assertion fails.
 */
export function assertIsolatedDshEnvironment(facts) {
  const violations = []
  const env = facts.env ?? process.env
  const testRoot = resolve(facts.testRoot ?? DEFAULT_TEST_ROOT)
  const production = productionFacts(env)

  if (typeof facts.home !== 'string' || facts.home.trim() === '') {
    throw new IsolationError(['no test DSH_HOME was supplied'])
  }
  const home = resolve(facts.home)
  const profile = String(facts.profile ?? '')
  const profileDir = resolve(facts.profileDir ?? join(home, 'profiles', profile))
  const port = Number(facts.port)

  // 1 + 2. The target home is neither the production home nor inside it.
  for (const forbidden of production.homes) {
    if (normalisePath(home) === normalisePath(forbidden)) {
      violations.push(`DSH_HOME is the production DSH_HOME (${forbidden})`)
    } else if (isInsideOrEqual(home, forbidden)) {
      violations.push(`DSH_HOME resolves inside the production DSH_HOME (${home} under ${forbidden})`)
    }
  }

  // 3. The target home lives under the scratch root.
  if (!isInsideOrEqual(home, testRoot)) {
    violations.push(`DSH_HOME is outside the test root (${home} is not under ${testRoot})`)
  }

  // 4. The scratch root does not itself resolve into production.
  for (const forbidden of production.homes) {
    if (isInsideOrEqual(testRoot, forbidden)) {
      violations.push(`the test root resolves into the production DSH_HOME (${testRoot} under ${forbidden})`)
    }
  }

  // 5. The profile is neither the live profile nor a real-data profile.
  if (profile.trim() === '') {
    violations.push('no test profile name was supplied')
  } else {
    for (const forbidden of production.profiles) {
      if (profile.toLowerCase() === forbidden) {
        violations.push(`profile "${profile}" is a production profile name`)
      }
    }
  }

  // 6. The profile directory is where a profile must be, and inside the root.
  const expectedProfileDir = join(home, 'profiles', profile)
  if (normalisePath(profileDir) !== normalisePath(expectedProfileDir)) {
    violations.push(`profileDir is not <home>/profiles/<profile> (${profileDir} != ${expectedProfileDir})`)
  }
  if (!isInsideOrEqual(profileDir, testRoot)) {
    violations.push(`the profile directory is outside the test root (${profileDir})`)
  }
  for (const forbidden of production.homes) {
    if (isInsideOrEqual(profileDir, forbidden)) {
      violations.push(`the profile directory resolves into the production DSH_HOME (${profileDir})`)
    }
  }

  // 7. When the caller binds a port it must be a real high port that production
  //    has never served on. Callers that bind nothing — an install-only script —
  //    may omit it, and the check is skipped rather than passed by default.
  if (facts.port !== undefined) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      violations.push(`port ${String(facts.port)} is not a usable TCP port`)
    } else if (production.ports.has(port)) {
      violations.push(`port ${port} is a production DSH port`)
    }
  }

  if (violations.length > 0) throw new IsolationError(violations)

  return {
    home,
    profile,
    profileDir,
    port: facts.port === undefined ? undefined : port,
    testRoot,
    productionHomes: production.homes,
    productionPorts: [...production.ports],
  }
}

/**
 * Whether a TCP port is currently free.
 *
 * A test must never take a port by killing whatever holds it, so an occupied
 * port is a reason to choose another one, not to terminate a process.
 *
 * @param port - the port to probe.
 * @returns true when nothing is listening on it.
 */
export async function isPortFree(port) {
  const { createServer } = await import('node:net')
  return new Promise((resolveFree) => {
    const server = createServer()
    server.once('error', () => resolveFree(false))
    server.once('listening', () => server.close(() => resolveFree(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Build the environment for an isolated `dsh` child process.
 *
 * Production `DSH_*` variables are stripped rather than overridden: inheriting
 * `DSH_SESSION_ID`, `DSH_WEB_URL` or `DSH_PROFILE_DIR` would hand the isolated
 * instance a pointer to real state even though `DSH_HOME` was replaced.
 *
 * @param verified - the return value of {@link assertIsolatedDshEnvironment}.
 * @param base - the environment to derive from; defaults to this process's.
 * @returns a child environment carrying only isolated DSH variables.
 */
export function buildIsolatedEnv(verified, base = process.env, extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('DSH_')) continue
    if (value !== undefined) env[key] = value
  }
  env.DSH_HOME = verified.home
  env.DSH_PROFILE = verified.profile
  env.DSH_PROFILE_DIR = verified.profileDir
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v
  }
  return env
}

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

/** True when this module is the process entry point rather than an import. */
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const testRoot = resolve(options['test-root'] ?? DEFAULT_TEST_ROOT)
  try {
    const verified = assertIsolatedDshEnvironment({
      home: options.home ?? join(testRoot, 'home'),
      profile: options.profile ?? 'word-lookup-test',
      port: options.port ?? 50991,
      profileDir: options['profile-dir'],
      testRoot,
    })
    const free = verified.port === undefined ? null : await isPortFree(verified.port)
    if (free === false) {
      console.error(`ISOLATION CHECK: FAIL\n  - port ${String(verified.port)} is already in use; choose another test port`)
      process.exit(2)
    }
    console.log(JSON.stringify({ ok: true, ...verified, portFree: free }, null, 2))
    console.log(ISOLATION_BANNER)
    process.exit(0)
  } catch (error) {
    if (error instanceof IsolationError) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
