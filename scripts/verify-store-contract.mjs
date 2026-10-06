#!/usr/bin/env node
/**
 * Fail-closed verification of DSH STORE contracts and packaging compliance.
 *
 * Implements the checks required by DSH STORE Issue #1306 and reproduces
 * the Store's static scanner logic:
 *   - Canonical repository URL
 *   - License alignment
 *   - DSH compatibility declaration (strict latest-three compatibility gating)
 *   - Explicit files surface
 *   - Distributable module closure (missingLocalModules == 0)
 *   - No lifecycle scripts (preinstall, install, postinstall, prepare)
 *   - No runtime dependencies
 *   - Full corpus exclusion (*.db, *.sqlite, *.csv, etc.)
 *   - Permission classification (files, network as expected; credentials, commands,
 *     protectedDsh, native, dynamic absent)
 *
 * Usage:
 *   node scripts/verify-store-contract.mjs [--json]
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CANONICAL_REPO = 'https://github.com/HaowenCang/dsh-word-lookup'
const REQUIRED_DSH_VERSION = '0.2.0-rc.2'
const FORBIDDEN_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']
const FORBIDDEN_CORPUS_EXTENSIONS = /\.(?:db|sqlite|sqlite3|csv|zip|7z|gz|tgz|tar)$/i

// --- Store scanner regexes --------------------------------------------------
const moduleImport = (names) => new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["'](?:node:)?(?:${names})["']`,
  'i',
)
const FILE_MODULE = moduleImport('fs|fs/promises')
const NETWORK_MODULE = moduleImport('http|https|net|tls|dgram|axios|got|undici')
const COMMAND_MODULE = moduleImport('child_process')
const COMMAND_CALL = /(?:^|[^\w$.'"`])(?:exec|execFile|spawn|fork)\s*\(/im
const NATIVE_ARTIFACT = /\.(?:node|wasm|dll|dylib|so|exe|bin)$/i

function blankNonCode(source, start, end, output) {
  for (let index = start; index < end; index++) {
    if (source[index] !== '\n' && source[index] !== '\r') output[index] = ' '
  }
}

function javascriptCode(source, { keepStrings = false } = {}) {
  const output = source.split('')
  const templates = []
  const parens = []
  let mode = 'code'
  let canStartRegex = true
  let previousWord = ''

  for (let index = 0; index < source.length;) {
    const char = source[index]
    const next = source[index + 1]

    if (mode === 'template') {
      if (char === '\\') {
        blankNonCode(source, index, Math.min(source.length, index + 2), output)
        index += 2
      } else if (char === '`') {
        if (!keepStrings) output[index] = ' '
        templates.pop()
        mode = 'code'
        canStartRegex = false
        previousWord = ''
        index++
      } else if (char === '$' && next === '{') {
        output[index] = output[index + 1] = ' '
        templates.at(-1).expressionDepth = 0
        mode = 'code'
        canStartRegex = true
        previousWord = ''
        index += 2
      } else {
        if (!keepStrings) blankNonCode(source, index, index + 1, output)
        index++
      }
      continue
    }

    if (char === '/' && next === '/') {
      let end = index + 2
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++
      blankNonCode(source, index, end, output)
      index = end
      continue
    }
    if (char === '/' && next === '*') {
      let end = index + 2
      while (end < source.length && !(source[end] === '*' && source[end + 1] === '/')) end++
      end = Math.min(source.length, end + 2)
      blankNonCode(source, index, end, output)
      index = end
      continue
    }
    if (char === "'" || char === '"') {
      let end = index + 1
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue }
        if (source[end] === char) { end++; break }
        end++
      }
      end = Math.min(source.length, end)
      if (!keepStrings) blankNonCode(source, index, end, output)
      index = end
      canStartRegex = false
      previousWord = ''
      continue
    }
    if (char === '`') {
      if (!keepStrings) output[index] = ' '
      templates.push({ expressionDepth: null })
      mode = 'template'
      index++
      continue
    }
    if (char === '/' && canStartRegex && next !== '=' && next !== '/' && next !== '*') {
      let end = index + 1
      let inCharacterClass = false
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue }
        if (source[end] === '[') inCharacterClass = true
        else if (source[end] === ']') inCharacterClass = false
        else if (source[end] === '/' && !inCharacterClass) { end++; break }
        else if (source[end] === '\n' || source[end] === '\r') break
        end++
      }
      while (/[A-Za-z]/.test(source[end] ?? '')) end++
      blankNonCode(source, index, end, output)
      index = end
      canStartRegex = false
      previousWord = ''
      continue
    }

    if (/\s/.test(char)) { index++; continue }
    const template = templates.at(-1)
    if (char === '{' && template?.expressionDepth !== null && template?.expressionDepth !== undefined) {
      template.expressionDepth++
      canStartRegex = true
      previousWord = ''
      index++
      continue
    }
    if (char === '}' && template?.expressionDepth !== null && template?.expressionDepth !== undefined) {
      if (template.expressionDepth === 0) {
        output[index] = ' '
        template.expressionDepth = null
        mode = 'template'
        index++
        continue
      }
      template.expressionDepth--
      canStartRegex = false
      previousWord = ''
      index++
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1
      while (/[\w$]/.test(source[end] ?? '')) end++
      const word = source.slice(index, end)
      canStartRegex = ['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'].includes(word)
      previousWord = word
      index = end
      continue
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1
      while (/[$\w.]/.test(source[end] ?? '')) end++
      canStartRegex = false
      previousWord = ''
      index = end
      continue
    }
    if (char === '(') {
      parens.push(['catch', 'for', 'if', 'switch', 'while', 'with'].includes(previousWord))
      canStartRegex = true
    } else if (char === ')') {
      canStartRegex = parens.pop() ?? false
    } else if (char === ']' || char === '.') {
      canStartRegex = false
    } else if (char === '}') {
      canStartRegex = true
    } else {
      canStartRegex = !/[)\]}]/.test(char)
    }
    previousWord = ''
    index++
  }
  return output.join('')
}

function hasCodeMatch(pattern, source, code) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let match
  while ((match = matcher.exec(source)) !== null) {
    if (code[match.index] !== ' ') return true
    if (match[0].length === 0) matcher.lastIndex++
  }
  return false
}

function checkPermissionSignals(source) {
  const text = String(source ?? '')
  const code = javascriptCode(text)
  const literals = javascriptCode(text, { keepStrings: true })

  const files = hasCodeMatch(FILE_MODULE, text, code)
    || /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i.test(code)
    || /\bprocess\s*\.\s*env\s*\.\s*DSH_HOME\b/i.test(code)

  const network = hasCodeMatch(NETWORK_MODULE, text, code)
    || /\b(?:fetch|WebSocket|EventSource)\s*\(/i.test(code)
    || /\b(?:axios|got|undici)\s*(?:\.|\()/i.test(code)

  const commands = hasCodeMatch(COMMAND_MODULE, text, code)
    || COMMAND_CALL.test(code)
    || /shell\s*:\s*true|Bun\.spawn|new\s+Deno\.Command/i.test(code)

  const credentials = /process\s*\.\s*env/i.test(code)
    || /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i.test(code)
    || /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i.test(code)

  const directMutation = /\b(?:__ModuleLoader__|loader|fiber|Loader|Fiber)\s*(?:\?\.|\.)\s*(?:unload|insert|remove|patch|enable|disable|write|mutate|replace)\s*(?:\?\.)?\s*\(/i.test(code)
  const computedMutation = /\b(?:__ModuleLoader__|loader|fiber|Loader|Fiber)\s*\[\s*['"](?:unload|insert|remove|patch|enable|disable|write|mutate|replace)['"]\s*\]\s*\(/i
  const protectedDsh = directMutation || hasCodeMatch(computedMutation, literals, code)

  return { files, network, commands, credentials, protectedDsh }
}

function checkLocalModuleEvidence(source) {
  const text = String(source ?? '')
  const code = javascriptCode(text)
  const pattern = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"\r\n]+)['"]/g
  const references = []
  let match
  while ((match = pattern.exec(text))) {
    if (code[match.index] !== ' ') references.push(match[1])
  }
  const dynamic = /\b(?:eval|Function)\s*\(/.test(code)
  return { references: [...new Set(references)], dynamic }
}

export function runStoreContractCheck() {
  const pkgPath = join(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const checks = []

  function addCheck(name, passed, detail = '') {
    checks.push({ name, passed, detail })
  }

  // 1. Repository
  const repoRaw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? ''
  const canonicalRepo = repoRaw.replace(/^git\+/, '').replace(/\.git$/, '')
  addCheck('Repository identity matches canonical GitHub URL', canonicalRepo === CANONICAL_REPO, `Got: ${canonicalRepo}, Expected: ${CANONICAL_REPO}`)

  // 1b. Release metadata & Lockfile consistency
  const lockPath = join(ROOT, 'package-lock.json')
  const lockExists = existsSync(lockPath)
  addCheck('package-lock.json exists in repository root', lockExists)
  if (lockExists) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      const lockVersionMatches = lock.version === pkg.version
      addCheck(
        'Package-lock top-level version matches package.json',
        lockVersionMatches,
        `package.json: ${pkg.version}, package-lock.json: ${lock.version}`,
      )
      const lockRootVersionMatches = lock.packages?.['']?.version === pkg.version
      addCheck(
        'Package-lock packages[""] version matches package.json',
        lockRootVersionMatches,
        `package.json: ${pkg.version}, packages[""].version: ${lock.packages?.['']?.version}`,
      )
    } catch (err) {
      addCheck('package-lock.json is valid JSON', false, String(err))
    }
  }

  // 2. License
  const licenseDeclared = pkg.license === 'MIT'
  const licenseFileExists = existsSync(join(ROOT, 'LICENSE'))
  addCheck('License declared as MIT in package.json', licenseDeclared, `license: ${pkg.license}`)
  addCheck('LICENSE file exists in repository root', licenseFileExists)

  // 3. DSH compatibility
  const compat = pkg.dsh?.compatibility
  addCheck('dsh.compatibility declared', !!compat && typeof compat === 'object')
  addCheck(`dsh.compatibility.dsh is ${REQUIRED_DSH_VERSION}`, compat?.dsh === REQUIRED_DSH_VERSION, `Got: ${compat?.dsh}`)

  const releases = compat?.dshReleases ?? {}
  addCheck(`${REQUIRED_DSH_VERSION} is compatible`, releases[REQUIRED_DSH_VERSION] === 'compatible', `${REQUIRED_DSH_VERSION}: ${releases[REQUIRED_DSH_VERSION]}`)

  const otherReleases = Object.entries(releases).filter(([k]) => k !== REQUIRED_DSH_VERSION)
  const otherAreUnknown = otherReleases.every(([, v]) => v === 'unknown' || v === 'incompatible')
  addCheck('Unverified DSH releases are not marked compatible', otherAreUnknown, JSON.stringify(releases))

  const operations = compat?.dshOperations?.[REQUIRED_DSH_VERSION]
  const validOps = operations && ['install', 'start', 'uninstall', 'rollback'].every((op) =>
    ['passed', 'unknown', 'failed'].includes(operations[op]),
  )
  addCheck('dshOperations for 0.2.0-rc.2 declares install, start, uninstall, rollback', !!validOps, JSON.stringify(operations))

  // 4. Lifecycle scripts
  const scripts = pkg.scripts ?? {}
  const foundLifecycle = FORBIDDEN_SCRIPTS.filter((s) => typeof scripts[s] === 'string')
  addCheck('No lifecycle scripts in package.json (preinstall, install, postinstall, prepare)', foundLifecycle.length === 0, foundLifecycle.join(', '))

  // 5. Runtime dependencies
  const deps = Object.keys(pkg.dependencies ?? {})
  const optDeps = Object.keys(pkg.optionalDependencies ?? {})
  const bundleDeps = Object.keys(pkg.bundledDependencies ?? {})
  const allDeps = [...deps, ...optDeps, ...bundleDeps]
  addCheck('No runtime dependencies', allDeps.length === 0, allDeps.join(', '))

  // 6. Explicit files
  const explicitFiles = Array.isArray(pkg.files) && pkg.files.length > 0
  addCheck('Explicit package.json files array declared', explicitFiles, JSON.stringify(pkg.files))

  // 7. Inspect pack surface via npm pack dry-run
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packRes = spawnSync(npmCmd, ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: true })
  let packMeta = null
  try {
    packMeta = JSON.parse(packRes.stdout)?.[0]
  } catch {
    packMeta = null
  }
  addCheck('npm pack dry-run executed successfully', !!packMeta && packRes.status === 0)

  const packedFiles = (packMeta?.files ?? []).map((f) => f.path)
  const packedFileSet = new Set(packedFiles)

  // Verify runtime targets
  const requiredTargets = [
    pkg.main,
    pkg.exports?.['.']?.default,
    pkg.exports?.['./client']?.default,
    pkg.dsh?.bundle?.patch,
  ].filter(Boolean).map((t) => t.replace(/^\.\//, ''))

  const targetsPresent = requiredTargets.every((t) => packedFileSet.has(t))
  addCheck('All manifest runtime entrypoints are included in tarball', targetsPresent, requiredTargets.filter((t) => !packedFileSet.has(t)).join(', '))

  // Verify corpus exclusion
  const forbiddenArtifacts = packedFiles.filter((p) => FORBIDDEN_CORPUS_EXTENSIONS.test(p))
  addCheck('Tarball excludes corpus data artifacts (*.db, *.sqlite, *.csv, *.zip, etc.)', forbiddenArtifacts.length === 0, forbiddenArtifacts.join(', '))

  // 8. Module closure & Local relative imports scan
  let missingLocalModules = []
  let cumulativeSignals = {
    files: false,
    network: false,
    commands: false,
    credentials: false,
    protectedDsh: false,
    native: false,
    dynamic: false,
  }

  for (const filePath of packedFiles) {
    if (NATIVE_ARTIFACT.test(filePath)) {
      cumulativeSignals.native = true
    }
    if (!/\.(?:[cm]?[jt]sx?|[cm]?ts)$/i.test(filePath)) continue

    const fullPath = join(ROOT, filePath)
    if (!existsSync(fullPath)) continue
    const content = readFileSync(fullPath, 'utf8')

    // Module evidence
    const { references, dynamic } = checkLocalModuleEvidence(content)
    if (dynamic) cumulativeSignals.dynamic = true

    for (const ref of references) {
      if (ref.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(filePath), ref))
        const candidates = [target, target + '.js', target + '.mjs', target + '.cjs', target + '.json', posix.join(target, 'index.js')]
        const resolved = candidates.some((c) => packedFileSet.has(c))
        if (!resolved) {
          missingLocalModules.push(`${filePath} -> ${ref}`)
        }
      }
    }

    // Permission signals
    const signals = checkPermissionSignals(content)
    if (signals.files) cumulativeSignals.files = true
    if (signals.network) cumulativeSignals.network = true
    if (signals.commands) cumulativeSignals.commands = true
    if (signals.credentials) cumulativeSignals.credentials = true
    if (signals.protectedDsh) cumulativeSignals.protectedDsh = true
  }

  addCheck('Distributable module closure (missingLocalModules == 0)', missingLocalModules.length === 0, missingLocalModules.join('; '))

  // 9. Permissions gating
  addCheck('Permission credentials is ABSENT', !cumulativeSignals.credentials)
  addCheck('Permission commands is ABSENT', !cumulativeSignals.commands)
  addCheck('Permission protectedDsh is ABSENT', !cumulativeSignals.protectedDsh)
  addCheck('Native artifacts are ABSENT', !cumulativeSignals.native)
  addCheck('Dynamic code loading/eval is ABSENT', !cumulativeSignals.dynamic)

  // Expected signals
  addCheck('Permission files signal is PRESENT (expected SQLite capability)', cumulativeSignals.files)
  addCheck('Permission network signal is PRESENT (expected same-origin host route)', cumulativeSignals.network)

  const allPassed = checks.every((c) => c.passed)

  return {
    allPassed,
    checks,
    packMeta: {
      filename: packMeta?.filename,
      size: packMeta?.size,
      unpackedSize: packMeta?.unpackedSize,
      fileCount: packedFiles.length,
      files: packedFiles,
    },
    signals: cumulativeSignals,
    missingLocalModules,
  }
}

// CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const jsonMode = process.argv.includes('--json')
  const result = runStoreContractCheck()

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('=== DSH STORE Contract & Packaging Verification ===\n')
    for (const check of result.checks) {
      const mark = check.passed ? 'PASS' : 'FAIL'
      console.log(`[${mark}] ${check.name}${check.detail ? ` (${check.detail})` : ''}`)
    }
    console.log('\n--- Pack Surface ---')
    console.log(`Package: ${result.packMeta.filename} (${result.packMeta.fileCount} files, unpacked: ${result.packMeta.unpackedSize} bytes)`)
    console.log(`Files:\n  ${result.packMeta.files.join('\n  ')}`)
    console.log('\n--- Permission Signals ---')
    console.log(`files:       ${result.signals.files ? 'EXPECTED (SQLite/local file access)' : 'FALSE'}`)
    console.log(`network:     ${result.signals.network ? 'EXPECTED (same-origin /api/dsh-word-lookup)' : 'FALSE'}`)
    console.log(`credentials: ${result.signals.credentials ? 'PRESENT (FAIL)' : 'ABSENT (zero process.env / secrets)'}`)
    console.log(`commands:    ${result.signals.commands ? 'PRESENT (FAIL)' : 'ABSENT'}`)
    console.log(`protected:   ${result.signals.protectedDsh ? 'PRESENT (FAIL)' : 'ABSENT'}`)
    console.log(`native:      ${result.signals.native ? 'PRESENT (FAIL)' : 'ABSENT'}`)
    console.log(`dynamic:     ${result.signals.dynamic ? 'PRESENT (FAIL)' : 'ABSENT'}`)
    console.log(`\nResult: ${result.allPassed ? 'PASS' : 'FAIL'}`)
  }

  process.exit(result.allPassed ? 0 : 1)
}
