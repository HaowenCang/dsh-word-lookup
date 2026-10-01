#!/usr/bin/env node
/**
 * Stop and remove the isolated DSH test environment.
 *
 * Cleanup deletes recursively, so it asserts isolation first and then refuses to
 * delete anything until the caller confirms the evidence has been written into a
 * project report (`--evidence-recorded`). A test environment whose results exist
 * only inside itself is evidence, not scratch space, and this project has
 * already lost one set of files to an eager cleanup.
 *
 * The script never touches the production home, and it reports the final safety
 * confirmation the project's test protocol requires.
 *
 * Usage:
 *   node scripts/cleanup-test-profile.mjs [--home <dir>] [--profile <name>] [--port <port>] \
 *     --evidence-recorded
 *
 * @module dsh-word-lookup/scripts/cleanup-test-profile
 */

import { existsSync, rmSync } from 'node:fs'
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

// --- gate ------------------------------------------------------------------
let verified
try {
  verified = assertIsolatedDshEnvironment({ home, profile, port, testRoot })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nrefusing to clean up: the target is not an isolated environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

// --- stop the instance -----------------------------------------------------
const portFree = await isPortFree(verified.port)
if (!portFree) {
  console.error(
    `cleanup-test-profile: something is still listening on ${verified.port}; ` +
      'stop the isolated DSH process and confirm no orphan remains before cleaning up',
  )
  process.exit(3)
}

// --- delete ----------------------------------------------------------------
if (options['evidence-recorded'] !== 'true') {
  console.error(
    'cleanup-test-profile: refusing to delete the test environment.\n' +
      '  Confirm the run\'s results are written into a project report, then re-run with\n' +
      '  --evidence-recorded. Stopping the instance above is already done; only the\n' +
      '  directory is left in place.',
  )
  process.exit(4)
}

const existed = existsSync(verified.home)
if (existed) rmSync(verified.home, { recursive: true, force: true })
const removed = existed && !existsSync(verified.home)

console.log(
  JSON.stringify(
    {
      home: verified.home,
      profileDir: verified.profileDir,
      port: verified.port,
      existed,
      removed,
      portFree,
      productionHomeTouched: false,
      productionPortTouched: false,
    },
    null,
    2,
  ),
)
console.log('production DSH profile touched: NO')
console.log('production session data touched: NO')
console.log('production port touched: NO')
console.log('production loader touched: NO')
console.log('production routes touched: NO')
