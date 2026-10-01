#!/usr/bin/env node
/**
 * Unified verification: typecheck, unit tests, build, static bundle checks.
 *
 * The steps run in this order because each one is cheap relative to the next and
 * because the bundle checks are only meaningful after a build. A failure stops the
 * run — reporting "tests pass" after a typecheck failure would misrepresent the
 * state of the tree.
 *
 * `npm run build` is executed even when the artifacts are already present: the
 * bundle checks read `lib/`, and a stale artifact is the one failure mode a
 * source-level check cannot see.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this script's own location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The npm executable for this platform. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Whether the child needs a shell.
 *
 * Node refuses to spawn a `.cmd` shim without one on Windows, and the npm
 * scripts are the point of this pipeline: it must exercise the same commands a
 * reader would run, not reimplement them.
 */
const SHELL = process.platform === 'win32'

/** One step of the pipeline. */
const STEPS = [
  { name: 'typecheck', command: NPM, args: ['run', '--silent', 'typecheck'] },
  { name: 'test', command: NPM, args: ['run', '--silent', 'test'] },
  { name: 'build', command: NPM, args: ['run', '--silent', 'build'] },
  { name: 'bundle-static-checks', command: process.execPath, args: ['scripts/check-bundle.mjs'] },
]

/** Results, in execution order. */
const summary = []

for (const step of STEPS) {
  process.stdout.write(`\n=== ${step.name} ===\n`)
  const started = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: step.command === NPM ? SHELL : false,
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const ok = result.status === 0
  summary.push({ name: step.name, ok, seconds })
  if (!ok) {
    console.error(`\nverify: "${step.name}" failed with exit code ${String(result.status)}`)
    break
  }
}

console.log('\n=== verify summary ===')
for (const step of summary) {
  console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}  (${step.seconds}s)`)
}
const failed = summary.filter((step) => !step.ok)
if (failed.length > 0 || summary.length !== STEPS.length) {
  console.log('verify: FAIL')
  process.exit(1)
}
console.log('verify: PASS')
