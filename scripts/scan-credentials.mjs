#!/usr/bin/env node
/**
 * Scan every file this project could publish for a usable launch token.
 *
 * The launch token is the one credential this project handles. The URL it
 * travels in mints the browser session cookie for a DSH instance, `docs/evidence/`
 * is committed, and the harness's own reports are the obvious place for one to
 * end up. Redaction is applied at write time by `scripts/redact.mjs`; this scan
 * is the independent check that it worked, because a scrub that misses a field is
 * exactly the bug that already happened once.
 *
 * What it looks for is a **value**, not a field name. Every occurrence of
 * `token=` is examined and the run of token-alphabet characters after it
 * measured:
 *
 * ```text
 * token=<redacted>          placeholder  -> fine
 * token=[A-Za-z0-9._~-]+    regex source -> fine, the next character is not token-shaped
 * token=abc123              short literal -> fine, not a credential length
 * token=A1b2…{43 chars}     a credential -> reported
 * ```
 *
 * A value long enough to be a real token is a failure unless it is one of the
 * enumerated synthetic fixtures below, and the scan *also* fails if a listed
 * fixture is no longer present. That direction matters: an exception that
 * quietly stops matching is an exception that has silently widened.
 *
 * Usage:
 *   node scripts/scan-credentials.mjs [--quiet]
 *
 * Exit codes: 0 clean, 1 a credential-shaped value was found, 2 the scan could
 * not enumerate its inputs.
 *
 * @module dsh-word-lookup/scripts/scan-credentials
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

/** Repository root, derived from this script's own location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** How many token-alphabet characters make a value credential-shaped. */
const CREDENTIAL_LENGTH = 20

/** Directories always scanned in full, whether tracked or not. */
const ALWAYS_SCANNED = ['docs/evidence', 'verify-out', 'reports']

/**
 * Values that are credential-shaped and deliberately not credentials.
 *
 * Each entry is the literal text this scan reports, so the exception covers
 * exactly one string rather than a file, a pattern or a directory. Every entry
 * must still be found, or the scan fails: an exception that stopped matching
 * would otherwise become a silent hole.
 */
const SYNTHETIC = [
  {
    value: 'token=NOTAREALCREDENTIALAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'tests/redact.spec.ts — a 43-character fabricated fixture, labelled as such in the source',
  },
  {
    value: 'token=FIXTUREONLYVALUEBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    reason: 'tests/redact.spec.ts — the second fabricated fixture, used to prove every token is scrubbed',
  },
]

/** Extensions that are never text and cannot carry a token. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tgz|db|woff2?|ttf|node)$/i

/** Files too large to be evidence; a token in one would not be readable anyway. */
const MAX_BYTES = 8 * 1024 * 1024

/** One credential-shaped occurrence. */
let occurrences = 0

/**
 * List the files this repository tracks.
 *
 * @returns repository-relative paths, or throws when git is unavailable.
 */
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr ?? ''}`)
  }
  return result.stdout.split('\u0000').filter((entry) => entry.length > 0)
}

/**
 * List every file under a directory, recursively.
 *
 * @param relativeDirectory - directory below the repository root.
 * @returns repository-relative paths.
 */
function walk(relativeDirectory) {
  const absolute = join(ROOT, relativeDirectory)
  if (!existsSync(absolute)) return []
  const found = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) found.push(...walk(child))
    else if (entry.isFile()) found.push(child)
  }
  return found
}

/**
 * Find credential-shaped values in one file.
 *
 * @param relativePath - path below the repository root.
 * @returns the raw matched strings, in file order.
 */
function inspect(relativePath) {
  if (BINARY.test(relativePath)) return []
  const absolute = join(ROOT, relativePath)
  let size
  try {
    size = statSync(absolute).size
  } catch {
    return []
  }
  if (size === 0 || size > MAX_BYTES) return []

  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    return []
  }
  // A NUL byte in the first block means the file is binary whatever its name.
  if (text.includes('\u0000')) return []

  const matches = []
  for (const match of text.matchAll(/token=([A-Za-z0-9._~-]*)/g)) {
    const value = match[1] ?? ''
    if (value.length < CREDENTIAL_LENGTH) continue
    matches.push(match[0])
  }
  return matches
}

const quiet = process.argv.includes('--quiet')

let candidates
try {
  candidates = [...new Set([...trackedFiles(), ...ALWAYS_SCANNED.flatMap((directory) => walk(directory))])]
} catch (error) {
  console.error(`scan-credentials: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const found = []
const seenSynthetic = new Set()
for (const file of candidates.sort()) {
  for (const value of inspect(file)) {
    occurrences += 1
    const known = SYNTHETIC.find((entry) => entry.value === value)
    if (known !== undefined) {
      seenSynthetic.add(known.value)
      if (!quiet) console.log(`SKIP  ${file}\n      known synthetic: ${known.reason}`)
      continue
    }
    found.push({ file, value })
  }
}

// An exception that no longer matches is worse than no exception: it means the
// scan is no longer looking at what it claims to be excusing.
const stale = SYNTHETIC.filter((entry) => !seenSynthetic.has(entry.value))
for (const entry of stale) {
  console.error(`scan-credentials: exception no longer matches anything: ${entry.value}\n  ${entry.reason}`)
}

if (!quiet) {
  console.log(`\nscan-credentials: ${String(candidates.length)} files, ${String(occurrences)} credential-shaped candidate(s)`)
}
for (const hit of found) {
  console.error(`LEAK  ${hit.file}\n      ${hit.value.slice(0, 12)}… (${String(hit.value.length - 'token='.length)} characters)`)
}

if (found.length > 0 || stale.length > 0) {
  console.error(`\nscan-credentials: FAIL — ${String(found.length)} unredacted value(s), ${String(stale.length)} stale exception(s)`)
  process.exit(1)
}
console.log('scan-credentials: PASS — no usable launch token in any tracked file or evidence directory')
