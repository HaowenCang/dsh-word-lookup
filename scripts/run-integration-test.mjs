#!/usr/bin/env node
/**
 * Run the Phase 1 runtime verification against the isolated test profile.
 *
 * This is the only supported entry point for a real DSH runtime test in this
 * project. Its first executable statement is the isolation assertion: if the
 * target is not provably a scratch environment, the run stops before a single
 * process is started or a single file is written.
 *
 * The work itself is delegated to `phase1-verify.mjs`, which boots the isolated
 * instance twice (to prove settings persistence across a restart), drives a
 * real Chromium over the launch-token URL, and records every measurement to
 * `verify-out/phase1-verification.json`.
 *
 * Usage:
 *   node scripts/run-integration-test.mjs [--home <dir>] [--profile <name>] [--port <port>]
 *
 * @module dsh-word-lookup/scripts/run-integration-test
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertIsolatedDshEnvironment,
  DEFAULT_TEST_ROOT,
  isPortFree,
  ISOLATION_BANNER,
  IsolationError,
} from './assert-isolated-env.mjs'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

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

const options = parseArgs(process.argv.slice(2))
const testRoot = resolve(options['test-root'] ?? DEFAULT_TEST_ROOT)
const home = resolve(options.home ?? join(testRoot, 'home'))
const profile = options.profile ?? 'word-lookup-test'
const port = Number(options.port ?? DEFAULT_PORT)
const out = options.out === undefined ? undefined : resolve(options.out)
const workdir = resolve(options.workdir ?? REPO_ROOT)

// --- gate ------------------------------------------------------------------
let verified
try {
  verified = assertIsolatedDshEnvironment({ home, profile, port, testRoot })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nrefusing to start a DSH runtime test: the target is not an isolated environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

// --- preconditions ---------------------------------------------------------
const profileManifest = join(verified.profileDir, 'package.json')
if (!existsSync(profileManifest)) {
  console.error(`run-integration-test: no isolated profile at ${verified.profileDir}`)
  console.error('run `npm run test-profile:create` first')
  process.exit(2)
}

// An occupied port is a reason to pick another one, never to end a process:
// the holder may be the reader's own instance.
if (!(await isPortFree(verified.port))) {
  console.error(`run-integration-test: port ${verified.port} is already in use; pass --port <other>`)
  process.exit(2)
}

// --- run -------------------------------------------------------------------
const args = [
  'scripts/phase1-verify.mjs',
  '--home',
  verified.home,
  '--profile',
  verified.profile,
  '--port',
  String(verified.port),
  '--workdir',
  workdir,
]
if (out !== undefined) args.push('--out', out)

const result = spawnSync(process.execPath, args, {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
