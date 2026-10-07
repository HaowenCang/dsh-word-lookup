#!/usr/bin/env node
/**
 * Real isolated DSH process runtime home resolution probe.
 *
 * Verifies Phase 7A.3R Defect 2:
 * 1. Strictly enforces scratch environment isolation via `assertIsolatedDshEnvironment`.
 * 2. Mounts a test-only runtime probe into the isolated test profile (`word-lookup-test`).
 * 3. Boots a real DSH process under isolated `DSH_HOME` (`%TEMP%\dsh-word-lookup-test\home`).
 * 4. In the real Cordis Context of the real DSH process, verifies:
 *    - `ctx.get('profileContext')?.home` is present and matches the isolated `DSH_HOME`.
 *    - `ctx.get('dshHomePath')` is a function and `dshHomePath()` matches the isolated `DSH_HOME`.
 *    - Calling production helper `resolveDshHomeFromContext(ctx)` matches the isolated `DSH_HOME`.
 *    - Calling production helper `resolveManagedStoragePaths({ ctx })` matches the isolated `DSH_HOME`.
 *    - All path comparisons use normalized/canonical comparison safe for Windows.
 * 5. Cleans up test artifacts and restores the profile configuration immediately.
 * 6. Records machine-readable evidence without leaking absolute production paths.
 *
 * @module dsh-word-lookup/scripts/test-storage-runtime
 */

import { execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  DEFAULT_TEST_ROOT,
  isPortFree,
  ISOLATION_BANNER,
  IsolationError,
  normalisePath,
} from './assert-isolated-env.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_START_PORT = 50985
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g

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

const args = parseArgs(process.argv.slice(2))
const testRoot = resolve(args['test-root'] ?? DEFAULT_TEST_ROOT)
const home = resolve(args.home ?? join(testRoot, 'home'))
const profile = args.profile ?? 'word-lookup-test'
const basePort = Number(args.port ?? DEFAULT_START_PORT)

async function findNextFreePort(startPort) {
  let port = startPort
  while (!(await isPortFree(port))) {
    port += 1
    if (port > 65000) throw new Error('No free TCP port found')
  }
  return port
}

async function stopDshProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))])
}

async function run() {
  console.log('test-storage-runtime: starting Phase 7A.3R real isolated DSH runtime home verification...')

  // 1. Isolation Gate
  const port = await findNextFreePort(basePort)
  let verified
  try {
    verified = assertIsolatedDshEnvironment({
      home,
      profile,
      port,
      testRoot,
    })
  } catch (err) {
    if (err instanceof IsolationError) {
      console.error(err.message)
      console.error('\nrefusing to run runtime tests: target is not isolated')
      process.exit(2)
    }
    throw err
  }
  console.log(ISOLATION_BANNER)

  const profileDir = verified.profileDir
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const probeScriptFile = join(profileDir, 'storage-runtime-probe.mjs')
  const scratchDir = join(testRoot, 'storage-runtime-scratch')
  mkdirSync(scratchDir, { recursive: true })
  const probeOutputFile = join(scratchDir, 'probe-output.json')

  // Verify profile preconditions
  const profilePkgJson = join(profileDir, 'package.json')
  if (!existsSync(profilePkgJson)) {
    throw new Error(`Profile package.json missing at ${profilePkgJson}; run npm run test-profile:create first`)
  }
  if (!existsSync(patchFile)) {
    throw new Error(`Profile cordis.patch.yml missing at ${patchFile}`)
  }

  const repoHostBundle = join(REPO_ROOT, 'lib', 'index.js')
  if (!existsSync(repoHostBundle)) {
    throw new Error('Host bundle lib/index.js missing; run npm run build first')
  }
  const hostBundleUrl = pathToFileURL(repoHostBundle).href

  // Write test-only probe script into isolated profile directory
  const probeScriptContent = `// Test-only runtime home resolution probe (Phase 7A.3R)
import { writeFileSync } from 'node:fs'
import { resolveDshHomeFromContext, resolveManagedStoragePaths } from ${JSON.stringify(hostBundleUrl)}

export function apply(ctx) {
  const profileContext = ctx.get('profileContext')
  const dshHomePath = ctx.get('dshHomePath')

  const profileHome = profileContext && typeof profileContext.home === 'string' ? profileContext.home : null
  const dshHomeFnResult = typeof dshHomePath === 'function' ? dshHomePath() : null

  let resolverHome = null
  let resolverError = null
  try {
    resolverHome = resolveDshHomeFromContext(ctx)
  } catch (err) {
    resolverError = String(err)
  }

  let managedPathsHome = null
  let managedPathsError = null
  try {
    const paths = resolveManagedStoragePaths({ ctx })
    managedPathsHome = paths.home
  } catch (err) {
    managedPathsError = String(err)
  }

  const probeData = {
    realDshProcess: true,
    pid: process.pid,
    platform: process.platform,
    profile: profileContext?.name ?? null,
    profileContextPresent: profileContext !== undefined && profileContext !== null,
    profileHome,
    dshHomePathServicePresent: typeof dshHomePath === 'function',
    dshHomePathResult: typeof dshHomeFnResult === 'string' ? dshHomeFnResult : null,
    resolverHome,
    resolverError,
    managedPathsHome,
    managedPathsError,
  }

  const outPath = process.env.DSH_STORAGE_PROBE_OUT
  if (outPath) {
    try {
      writeFileSync(outPath, JSON.stringify(probeData, null, 2), 'utf8')
    } catch (e) {
      console.error('[PROBE WRITE ERROR]', e)
    }
  }
  console.log('[STORAGE_RUNTIME_PROBE_RESULT]', JSON.stringify(probeData))
}
`
  writeFileSync(probeScriptFile, probeScriptContent, 'utf8')

  // Temporarily patch cordis.patch.yml to insert probe plugin
  const originalPatchContent = readFileSync(patchFile, 'utf8')
  const patchedContent = `${originalPatchContent.trimEnd()}
# Temporary test-only runtime home resolution probe (Phase 7A.3R)
- insert:
    - id: test-storage-runtime-probe
      name: ./storage-runtime-probe.mjs
`
  writeFileSync(patchFile, patchedContent, 'utf8')

  let dshChild = null
  let probeResult = null
  let stdoutAccum = ''
  let stderrAccum = ''

  try {
    // Start real DSH process with isolated environment
    const extraEnv = {
      DSH_STORAGE_PROBE_OUT: probeOutputFile,
    }
    const env = buildIsolatedEnv(verified, process.env, extraEnv)

    dshChild = spawn('dsh', ['--profile', verified.profile, '--no-open', '--port', String(verified.port)], {
      cwd: REPO_ROOT,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await new Promise((resolveRun, rejectRun) => {
      const timeoutTimer = setTimeout(() => {
        rejectRun(new Error(`Timed out waiting for DSH runtime probe\nSTDOUT:\n${stdoutAccum}\nSTDERR:\n${stderrAccum}`))
      }, 45_000)

      const checkSettled = () => {
        if (existsSync(probeOutputFile)) {
          try {
            const parsed = JSON.parse(readFileSync(probeOutputFile, 'utf8'))
            if (parsed && parsed.realDshProcess) {
              probeResult = parsed
              clearTimeout(timeoutTimer)
              resolveRun(true)
              return
            }
          } catch {
            // file still writing
          }
        }
      }

      const consume = (chunk, isStdErr) => {
        const text = chunk.toString().replace(ANSI, '')
        if (isStdErr) stderrAccum += text
        else stdoutAccum += text

        const match = /\[STORAGE_RUNTIME_PROBE_RESULT\]\s*(\{.*\})/.exec(text)
        if (match) {
          try {
            probeResult = JSON.parse(match[1])
            clearTimeout(timeoutTimer)
            resolveRun(true)
            return
          } catch {
            // parse error
          }
        }
        checkSettled()
      }

      dshChild.stdout.on('data', (c) => consume(c, false))
      dshChild.stderr.on('data', (c) => consume(c, true))
      dshChild.on('exit', (code) => {
        checkSettled()
        if (probeResult) {
          clearTimeout(timeoutTimer)
          resolveRun(true)
        } else {
          clearTimeout(timeoutTimer)
          rejectRun(new Error(`dsh process exited early with code ${code}\nSTDOUT:\n${stdoutAccum}\nSTDERR:\n${stderrAccum}`))
        }
      })
    })
  } finally {
    // Clean up process
    if (dshChild) {
      await stopDshProcess(dshChild)
    }
    // Restore cordis.patch.yml
    try {
      writeFileSync(patchFile, originalPatchContent, 'utf8')
    } catch {
      // best-effort
    }
    // Remove probe script
    try {
      rmSync(probeScriptFile, { force: true })
    } catch {
      // best-effort
    }
    // Remove scratch
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  if (!probeResult) {
    throw new Error('Failed to obtain runtime probe result from isolated DSH process')
  }

  console.log('\n--- Real DSH Runtime Home Resolution Probed Values ---')
  console.log(`Real DSH Process:               ${probeResult.realDshProcess} (pid=${probeResult.pid})`)
  console.log(`Profile Name:                   ${probeResult.profile}`)
  console.log(`ProfileContext Present:         ${probeResult.profileContextPresent}`)
  console.log(`dshHomePath Service Present:    ${probeResult.dshHomePathServicePresent}`)
  console.log(`Resolved Profile Home:          ${probeResult.profileHome}`)
  console.log(`dshHomePath() Result:           ${probeResult.dshHomePathResult}`)
  console.log(`resolveDshHomeFromContext():    ${probeResult.resolverHome}`)
  console.log(`resolveManagedStoragePaths():   ${probeResult.managedPathsHome}`)

  const normIsolatedHome = normalisePath(verified.home)
  const normProfileHome = probeResult.profileHome ? normalisePath(probeResult.profileHome) : null
  const normDshHomeFn = probeResult.dshHomePathResult ? normalisePath(probeResult.dshHomePathResult) : null
  const normResolverHome = probeResult.resolverHome ? normalisePath(probeResult.resolverHome) : null
  const normManagedPathsHome = probeResult.managedPathsHome ? normalisePath(probeResult.managedPathsHome) : null

  const profileHomeMatchesIsolatedHome = normProfileHome === normIsolatedHome
  const resolverHomeMatchesIsolatedHome = normResolverHome === normIsolatedHome
  const dshHomePathMatchesIsolatedHome = normDshHomeFn === normIsolatedHome
  const managedPathsMatchesIsolatedHome = normManagedPathsHome === normIsolatedHome

  const checks = [
    {
      id: 'RT-HOME-REAL-PROCESS',
      desc: 'Probe executed in real isolated DSH child process',
      passed: probeResult.realDshProcess === true,
      detail: `pid=${probeResult.pid} platform=${probeResult.platform}`,
    },
    {
      id: 'RT-HOME-PROFILE-MATCH',
      desc: 'Executed under isolated test profile name',
      passed: probeResult.profile === verified.profile,
      detail: `profile=${probeResult.profile}`,
    },
    {
      id: 'RT-HOME-PROFILE-CONTEXT',
      desc: 'ctx.get("profileContext") is present with home string',
      passed: probeResult.profileContextPresent && typeof probeResult.profileHome === 'string',
      detail: `profileContextPresent=${probeResult.profileContextPresent}`,
    },
    {
      id: 'RT-HOME-SERVICE-FUNCTION',
      desc: 'ctx.get("dshHomePath") is present and is a function',
      passed: probeResult.dshHomePathServicePresent && typeof probeResult.dshHomePathResult === 'string',
      detail: `dshHomePathServicePresent=${probeResult.dshHomePathServicePresent}`,
    },
    {
      id: 'RT-HOME-PROFILE-EQ-ISOLATED',
      desc: 'profileContext.home matches isolated test DSH_HOME (normalized comparison)',
      passed: profileHomeMatchesIsolatedHome,
      detail: `normProfileHome=${normProfileHome} normIsolatedHome=${normIsolatedHome}`,
    },
    {
      id: 'RT-HOME-RESOLVER-EQ-ISOLATED',
      desc: 'resolveDshHomeFromContext(ctx) matches isolated test DSH_HOME (normalized comparison)',
      passed: resolverHomeMatchesIsolatedHome,
      detail: `normResolverHome=${normResolverHome}`,
    },
    {
      id: 'RT-HOME-SERVICE-EQ-ISOLATED',
      desc: 'dshHomePath() matches isolated test DSH_HOME (normalized comparison)',
      passed: dshHomePathMatchesIsolatedHome,
      detail: `normDshHomeFn=${normDshHomeFn}`,
    },
    {
      id: 'RT-HOME-MANAGED-PATHS-EQ-ISOLATED',
      desc: 'resolveManagedStoragePaths({ ctx }).home matches isolated test DSH_HOME (normalized comparison)',
      passed: managedPathsMatchesIsolatedHome,
      detail: `normManagedPathsHome=${normManagedPathsHome}`,
    },
  ]

  let allPassed = true
  console.log('\n--- Probe Assertions ---')
  for (const c of checks) {
    const status = c.passed ? 'PASS' : 'FAIL'
    if (!c.passed) allPassed = false
    console.log(`${status}  [${c.id}] ${c.desc}`)
    console.log(`      ${c.detail}`)
  }

  const evidence = {
    realDshProcess: probeResult.realDshProcess === true,
    profile: probeResult.profile,
    profileContextPresent: probeResult.profileContextPresent,
    dshHomePathServicePresent: probeResult.dshHomePathServicePresent,
    profileHomeMatchesIsolatedHome,
    resolverHomeMatchesIsolatedHome,
    dshHomePathMatchesIsolatedHome,
    managedPathsMatchesIsolatedHome,
  }

  if (args.json) {
    console.log('\n--- Evidence JSON ---')
    console.log(JSON.stringify(evidence, null, 2))
  }

  if (!allPassed) {
    console.error('\ntest-storage-runtime: one or more checks failed')
    process.exit(1)
  }

  console.log('\ntest-storage-runtime: ALL REAL RUNTIME HOME CHECKS PASSED.')
}

run().catch((err) => {
  console.error('test-storage-runtime fatal error:', err)
  process.exit(1)
})
