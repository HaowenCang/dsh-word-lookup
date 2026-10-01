#!/usr/bin/env node
/**
 * Create or remove an isolated DSH home for Phase 1 verification.
 *
 * The instance is fully separated from the running product: its own `DSH_HOME`,
 * its own profile directory, its own port, its own sessions and credentials. That
 * separation is what makes it safe to start and stop a *second* DSH process while
 * the reader's own `web` profile keeps running, and it is the only way to measure
 * a real boot without restarting the host that is serving this session.
 *
 * The profile it composes is a genuine DSH Web profile — the two first-party
 * bundles plus this plugin — with the plugin installed as a **profile bundle
 * entry**, which is the property the settings path depends on. It is not a
 * reduced or mocked composition: the same `dsh` binary, the same base and web
 * bundles, the same connection fence, the same authentication.
 *
 * Usage:
 *   node scripts/iso-profile.mjs setup    --home <dir> --profile <name> --port <port> [--sessions <dir>]
 *   node scripts/iso-profile.mjs teardown --home <dir>
 *
 * Superseded by `scripts/create-test-profile.mjs` + `scripts/run-integration-test.mjs`,
 * which compose the plugin as a bundle entry and enforce the shared isolation
 * gate. This script is kept for its scratch-path guard behaviour; prefer the
 * newer entry points for any new work.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Bundles every isolated verification profile composes. */
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-word-lookup']

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

const [subcommand = 'setup', ...rest] = process.argv.slice(2)
const options = parseArgs(rest)
const home = resolve(options.home ?? join(tmpdir(), 'dsh-phase1-iso'))
const profileName = options.profile ?? 'wlphase1'
const port = Number(options.port ?? 50998)
const profileDir = join(home, 'profiles', profileName)

/**
 * Refuse to touch a path that is not obviously a scratch directory.
 *
 * `teardown` deletes recursively, so the guard is on the resolved absolute path
 * rather than on the argument as typed: a typo must not be able to name an
 * existing project or profile directory.
 *
 * @param path - the resolved directory about to be created or removed.
 */
function assertScratchPath(path) {
  const underTemp = path.startsWith(resolve(tmpdir()) + sep)
  const underPhase1 = basename(path).startsWith('dsh-phase1')
  if (!underTemp || !underPhase1) {
    console.error(`iso-profile: refusing to operate on ${path}; expected a dsh-phase1* directory under ${tmpdir()}`)
    process.exit(2)
  }
}

if (subcommand === 'setup') {
  assertScratchPath(home)
  if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  writeFileSync(
    join(profileDir, 'cordis.yml'),
    [
      '# Isolated Phase 1 verification profile: an empty entry list. The tree is',
      '# composed as patches: each bundle in package.json\'s dsh.profile.bundles,',
      '# then cordis.patch.yml.',
      '[]',
      '',
    ].join('\n'),
    'utf8',
  )

  // Only the webserver binding is overridden. The `!!js` expression is the same
  // one the product profile uses so that a CLI `--port` still wins, which keeps
  // the isolated instance off any port the machine already has in use.
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# Isolated Phase 1 verification profile: bind a port of our choosing.',
      '- id: webserver',
      '  config:',
      "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
      `    port: !!js ctx.webStartup.port ?? ${String(port)}`,
      '',
    ].join('\n'),
    'utf8',
  )

  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profileName}`,
        private: true,
        dsh: { profile: { bundles: [...BASE_BUNDLES] } },
        dependencies: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // Seeding sessions from the reader's own store is refused outright: copying a
  // real conversation into a test environment is prohibited, and a test that
  // needs a transcript must create its own fixture session instead.
  if (typeof options.sessions === 'string') {
    console.error(
      'iso-profile: --sessions is not supported.\n' +
        '  Real conversations must never be copied into a test environment. Create a\n' +
        '  synthetic fixture session inside the isolated instance instead.',
    )
    process.exit(2)
  }

  console.log(JSON.stringify({ subcommand, home, profileDir, profileName, port, sessionsCopied: 0, repoRoot: REPO_ROOT }, null, 2))
  process.exit(0)
}

if (subcommand === 'teardown') {
  assertScratchPath(home)
  const existed = existsSync(home)
  if (existed) rmSync(home, { recursive: true, force: true })
  console.log(JSON.stringify({ subcommand, home, existed, removed: existed && !existsSync(home) }, null, 2))
  process.exit(0)
}

console.error(`iso-profile: unknown subcommand "${subcommand}"`)
process.exit(2)
