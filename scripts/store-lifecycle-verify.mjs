#!/usr/bin/env node
/**
 * DSH STORE-1306 Lifecycle Verification Runner.
 *
 * Verifies the 4 lifecycle operations against a real isolated DSH instance
 * using the EXACT candidate tarball (not a repository link/junction):
 *   1. INSTALL: unpack candidate tarball, register bundle, verify non-repo path
 *   2. START: boot isolated DSH, verify host route, verify browser bundle & card
 *   3. UNINSTALL: remove package & bundle, boot DSH, verify route 404 & no client module
 *   4. ROLLBACK: unpack verified v0.1.0 release artifact (SHA-256 verified), boot DSH, verify v0.1.0 works
 *
 * Usage:
 *   node scripts/store-lifecycle-verify.mjs [--port <port>] [--tarball <path>] [--json]
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  DEFAULT_TEST_ROOT,
  isPortFree,
  ISOLATION_BANNER,
  IsolationError,
} from './assert-isolated-env.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = 'dsh-word-lookup'
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const V010_VERIFIED_SHA256 = '22d3cdffd9f73790adebb707cf36a258453a4813db981d19d9d5cffb249458cc'
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

function sha256File(filePath) {
  const buffer = readFileSync(filePath)
  return createHash('sha256').update(buffer).digest('hex')
}

async function findAvailablePort(startPort) {
  for (let p = startPort; p < startPort + 50; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`No free port found starting from ${startPort}`)
}

async function unpackTarball(tarballPath, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const stageDir = join(tmpdir(), `dsh-tarball-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(stageDir, { recursive: true })

  // Use tar command to extract
  const res = spawnSync('tar', ['-xzf', tarballPath, '-C', stageDir], { encoding: 'utf8', shell: true })
  if (res.status !== 0) {
    throw new Error(`tar -xzf failed on ${tarballPath}: ${res.stderr}`)
  }

  const packageDir = join(stageDir, 'package')
  if (!existsSync(packageDir)) {
    throw new Error(`Unpacked tarball does not contain 'package/' folder`)
  }

  // Copy contents of package/ to targetDir
  cpSync(packageDir, targetDir, { recursive: true })
  rmSync(stageDir, { recursive: true, force: true })
}

async function bootDsh(verified, port) {
  const env = buildIsolatedEnv(verified, process.env, { PORT: String(port) })
  const child = spawn('dsh', ['--profile', verified.profile, '--no-open', '--port', String(port)], {
    cwd: REPO_ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`dsh timed out starting\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`))
    }, 60_000)

    const consume = (chunk, isStderr) => {
      const text = chunk.toString().replace(ANSI, '')
      if (isStderr) stderr += text
      else stdout += text

      const match = /https?:\/\/[^\s"']*\/\?token=[A-Za-z0-9._~-]+/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[0])
      }
    }

    child.stdout.on('data', (c) => consume(c, false))
    child.stderr.on('data', (c) => consume(c, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error(`dsh exited early with code ${code}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`))
    })
  })

  // Short settle delay
  await new Promise((r) => setTimeout(r, 1500))
  return { child, url }
}

async function stopDsh(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))])
  await new Promise((r) => setTimeout(r, 1000))
}

async function safeRm(targetPath) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (existsSync(targetPath)) {
        rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
      return
    } catch (err) {
      if (attempt === 9) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

async function testLookupRouteInsideBrowser(page, query = 'derive') {
  return await page.evaluate(async (q) => {
    try {
      const res = await fetch('api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      let body = null
      try { body = await res.json() } catch {}
      return { status: res.status, body }
    } catch (err) {
      return { status: null, error: String(err) }
    }
  }, query)
}

async function testAnonymousRouteFence(port) {
  const url = `http://127.0.0.1:${port}/api/dsh-word-lookup`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'derive' }),
    })
    return res.status
  } catch (err) {
    return null
  }
}

export async function runStoreLifecycleVerification(opts = {}) {
  const testRoot = resolve(opts.testRoot ?? DEFAULT_TEST_ROOT)
  const home = resolve(opts.home ?? join(testRoot, 'home'))
  const profile = opts.profile ?? 'word-lookup-test'
  const profileDir = join(home, 'profiles', profile)

  // 1. ISOLATION GATE
  let verified
  try {
    verified = assertIsolatedDshEnvironment({ home, profile, testRoot, profileDir })
  } catch (error) {
    if (error instanceof IsolationError) {
      console.error(error.message)
      throw error
    }
    throw error
  }

  const port = await findAvailablePort(opts.port ? Number(opts.port) : 50993)
  verified.port = port

  const results = {
    isolation: {
      passed: true,
      banner: ISOLATION_BANNER,
      home: verified.home,
      profile: verified.profile,
      profileDir: verified.profileDir,
      port,
    },
    operations: {
      install: { passed: false, details: {} },
      start: { passed: false, details: {} },
      uninstall: { passed: false, details: {} },
      rollback: { passed: false, details: {} },
    },
    candidateTarball: null,
  }

  // 2. Candidate tarball resolution or build
  let candidateTarballPath = opts.tarball
  if (!candidateTarballPath) {
    // Pack candidate
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const packOut = spawnSync(npmCmd, ['pack', '--pack-destination', tmpdir()], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
    })
    if (packOut.status !== 0) {
      throw new Error(`npm pack failed: ${packOut.stderr}`)
    }
    const filename = packOut.stdout.trim().split(/\r?\n/).at(-1).trim()
    candidateTarballPath = join(tmpdir(), filename)
  }

  const candidateSha256 = sha256File(candidateTarballPath)
  results.candidateTarball = {
    path: candidateTarballPath,
    sha256: candidateSha256,
  }

  const installedPluginDir = join(profileDir, 'node_modules', PACKAGE_NAME)

  // =========================================================================
  // OPERATION 1: INSTALL
  // =========================================================================
  console.log('\n--- 1. Testing INSTALL from unpacked candidate tarball ---')
  // Prepare clean profile skeleton
  await safeRm(profileDir)
  mkdirSync(profileDir, { recursive: true })

  writeFileSync(
    join(profileDir, 'cordis.yml'),
    '[]\n',
    'utf8',
  )
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: webserver',
      '  config:',
      "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
      `    port: !!js ctx.webStartup.port ?? ${String(port)}`,
      '',
    ].join('\n'),
    'utf8',
  )

  // Unpack candidate tarball to profile's node_modules
  await unpackTarball(candidateTarballPath, installedPluginDir)

  // Setup profile package.json
  const profilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...BASE_BUNDLES, PACKAGE_NAME],
      },
    },
    dependencies: {
      [PACKAGE_NAME]: './node_modules/dsh-word-lookup',
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')

  // Verify install facts
  const installLinkStat = lstatSync(installedPluginDir)
  const isJunction = installLinkStat.isSymbolicLink()
  const installedPkgJson = JSON.parse(readFileSync(join(installedPluginDir, 'package.json'), 'utf8'))
  const candidateVersion = installedPkgJson.version
  const patchExists = existsSync(join(installedPluginDir, 'cordis.patch.yml'))
  const clientExists = existsSync(join(installedPluginDir, 'lib', 'client.js'))
  const indexExists = existsSync(join(installedPluginDir, 'lib', 'index.js'))

  const installPassed = !isJunction &&
    installedPluginDir !== REPO_ROOT &&
    candidateVersion === '0.1.1' &&
    patchExists &&
    clientExists &&
    indexExists &&
    profilePkg.dsh.profile.bundles.filter((b) => b === PACKAGE_NAME).length === 1

  results.operations.install = {
    passed: installPassed,
    details: {
      tarball: candidateTarballPath,
      sha256: candidateSha256,
      installedPath: installedPluginDir,
      isSymbolicLinkOrJunction: isJunction,
      notRepoRoot: installedPluginDir !== REPO_ROOT,
      version: candidateVersion,
      bundleListedOnce: true,
      cordisPatchPresent: patchExists,
    },
  }
  console.log(`INSTALL: ${installPassed ? 'PASS' : 'FAIL'} (installed to ${installedPluginDir}, junction=${isJunction}, version=${candidateVersion})`)

  if (!installPassed) {
    throw new Error(`INSTALL operation failed: ${JSON.stringify(results.operations.install.details)}`)
  }

  // =========================================================================
  // OPERATION 2: START
  // =========================================================================
  console.log('\n--- 2. Testing START with installed candidate plugin ---')
  let dshProcess = null
  let browser = null
  let startPassed = false

  try {
    const booted = await bootDsh(verified, port)
    dshProcess = booted.child
    const appUrl = booted.url
    console.log(`DSH booted at ${appUrl}`)

    // 1. Verify unauthenticated route fence
    const anonStatus = await testAnonymousRouteFence(port)
    console.log(`Anonymous route POST /api/dsh-word-lookup status: ${anonStatus} (expected 401)`)

    // 2. Launch browser with authenticated launch URL
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Wait for client plugin runtime diagnostics
    await page.waitForFunction(() => {
      return typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null
    }, undefined, { timeout: 45_000 })

    // Wait for overlay contribution
    await page.waitForFunction(() => {
      return window.__DSH_WORD_LOOKUP__?.overlay?.()?.declarationSeen === true
    }, undefined, { timeout: 30_000 })

    // 3. Test host lookup route through authenticated browser session
    const routeRes = await testLookupRouteInsideBrowser(page, 'derive')
    console.log(`Session route POST /api/dsh-word-lookup: status=${routeRes.status}, headword=${routeRes.body?.headword}`)
    const routeOk = routeRes.status === 200 && routeRes.body?.ok === true && routeRes.body?.headword === 'derive'

    // 4. Trigger lookup via client store and verify card rendering in shell.overlay
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('derive')
    })

    const cardVisible = await page.waitForSelector('[data-dsh-word-lookup-ui-state="found"]', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    let renderedHeadword = null
    if (cardVisible) {
      renderedHeadword = await page.evaluate(() => {
        return document.querySelector('[data-dsh-word-lookup="headword"]')?.textContent?.trim()
      })
    }
    console.log(`Card rendered: visible=${cardVisible}, headword="${renderedHeadword}"`)

    startPassed = anonStatus === 401 && routeOk && cardVisible && renderedHeadword === 'derive'
    results.operations.start = {
      passed: startPassed,
      details: {
        unauthenticatedFenceStatus: anonStatus,
        hostRouteStatus: routeRes.status,
        fixtureLookupResult: routeRes.body?.headword,
        clientBundleLoaded: true,
        cardRendered: cardVisible,
        renderedHeadword,
      },
    }
    console.log(`START: ${startPassed ? 'PASS' : 'FAIL'}`)
  } finally {
    if (browser) await browser.close()
    if (dshProcess) await stopDsh(dshProcess)
  }

  if (!startPassed) {
    throw new Error(`START operation failed: ${JSON.stringify(results.operations.start.details)}`)
  }

  // =========================================================================
  // OPERATION 3: UNINSTALL
  // =========================================================================
  console.log('\n--- 3. Testing UNINSTALL ---')
  // Remove package files
  await safeRm(installedPluginDir)

  // Update profile package.json
  const uninstalledProfilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...BASE_BUNDLES],
      },
    },
    dependencies: {},
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(uninstalledProfilePkg, null, 2) + '\n', 'utf8')

  let uninstallPassed = false
  dshProcess = null
  browser = null

  try {
    const booted = await bootDsh(verified, port)
    dshProcess = booted.child
    const appUrl = booted.url

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Verify host route is absent (404)
    const routeRes = await testLookupRouteInsideBrowser(page, 'hello')
    console.log(`Route POST /api/dsh-word-lookup after uninstall status: ${routeRes.status} (expected 404)`)
    const routeAbsent = routeRes.status === 404

    // Verify client module is absent
    const clientModuleAbsent = await page.evaluate(() => {
      return typeof window.__DSH_WORD_LOOKUP__ === 'undefined'
    })

    uninstallPassed = routeAbsent && clientModuleAbsent && !existsSync(installedPluginDir)
    results.operations.uninstall = {
      passed: uninstallPassed,
      details: {
        packageDirectoryRemoved: !existsSync(installedPluginDir),
        routeAbsent404: routeAbsent,
        clientModuleAbsent,
      },
    }
    console.log(`UNINSTALL: ${uninstallPassed ? 'PASS' : 'FAIL'} (packageDirRemoved=${!existsSync(installedPluginDir)}, route404=${routeAbsent}, clientAbsent=${clientModuleAbsent})`)
  } finally {
    if (browser) await browser.close()
    if (dshProcess) await stopDsh(dshProcess)
  }

  if (!uninstallPassed) {
    throw new Error(`UNINSTALL operation failed: ${JSON.stringify(results.operations.uninstall.details)}`)
  }

  // =========================================================================
  // OPERATION 4: ROLLBACK to verified v0.1.0 release artifact
  // =========================================================================
  console.log('\n--- 4. Testing ROLLBACK to verified v0.1.0 release artifact ---')
  const v010TarballPath = join(tmpdir(), 'dsh-word-lookup-0.1.0.tgz')
  if (!existsSync(v010TarballPath)) {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    spawnSync(npmCmd, ['pack', 'dsh-word-lookup@0.1.0', '--pack-destination', tmpdir()], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
    })
  }

  if (!existsSync(v010TarballPath)) {
    throw new Error(`Could not obtain dsh-word-lookup@0.1.0 tarball at ${v010TarballPath}`)
  }

  const v010Sha = sha256File(v010TarballPath)
  console.log(`v0.1.0 tarball SHA-256: ${v010Sha}`)
  if (v010Sha !== V010_VERIFIED_SHA256) {
    throw new Error(`v0.1.0 SHA-256 mismatch! Got ${v010Sha}, expected ${V010_VERIFIED_SHA256}`)
  }

  // Unpack v0.1.0 into profile node_modules
  await unpackTarball(v010TarballPath, installedPluginDir)

  // Configure profile package.json for v0.1.0
  const rollbackProfilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: {
      profile: {
        bundles: [...BASE_BUNDLES, PACKAGE_NAME],
      },
    },
    dependencies: {
      [PACKAGE_NAME]: './node_modules/dsh-word-lookup',
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(rollbackProfilePkg, null, 2) + '\n', 'utf8')

  let rollbackPassed = false
  dshProcess = null
  browser = null

  try {
    const booted = await bootDsh(verified, port)
    dshProcess = booted.child
    const appUrl = booted.url

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    await page.waitForFunction(() => {
      return typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null
    }, undefined, { timeout: 45_000 })

    // Verify v0.1.0 host route works
    const routeRes = await testLookupRouteInsideBrowser(page, 'derive')
    console.log(`v0.1.0 route POST /api/dsh-word-lookup status: ${routeRes.status}, headword=${routeRes.body?.headword}`)
    const routeOk = routeRes.status === 200 && routeRes.body?.ok === true && routeRes.body?.headword === 'derive'

    // Verify v0.1.0 client works
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('derive')
    })

    const cardVisible = await page.waitForSelector('[data-dsh-word-lookup-ui-state="found"]', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    let renderedHeadword = null
    if (cardVisible) {
      renderedHeadword = await page.evaluate(() => {
        return document.querySelector('[data-dsh-word-lookup="headword"]')?.textContent?.trim()
      })
    }
    console.log(`v0.1.0 card visible: ${cardVisible}, headword: "${renderedHeadword}"`)

    rollbackPassed = routeOk && cardVisible && renderedHeadword === 'derive'
    results.operations.rollback = {
      passed: rollbackPassed,
      details: {
        targetTarball: 'dsh-word-lookup-0.1.0.tgz',
        verifiedSha256: v010Sha,
        sha256Match: v010Sha === V010_VERIFIED_SHA256,
        hostRouteOk: routeOk,
        clientLoaded: true,
        cardVisible,
        renderedHeadword,
      },
    }
    console.log(`ROLLBACK: ${rollbackPassed ? 'PASS' : 'FAIL'}`)
  } finally {
    if (browser) await browser.close()
    if (dshProcess) await stopDsh(dshProcess)
  }

  if (!rollbackPassed) {
    throw new Error(`ROLLBACK operation failed: ${JSON.stringify(results.operations.rollback.details)}`)
  }

  // Cleanup profile directory after all tests succeed
  await safeRm(profileDir)

  results.allPassed = results.operations.install.passed &&
    results.operations.start.passed &&
    results.operations.uninstall.passed &&
    results.operations.rollback.passed

  return results
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2))
  const jsonMode = options.json === 'true'

  runStoreLifecycleVerification(options).then((res) => {
    if (jsonMode) {
      console.log(JSON.stringify(res, null, 2))
    } else {
      console.log('\n=== STORE-1306 Lifecycle Verification Summary ===')
      console.log(`INSTALL:   ${res.operations.install.passed ? 'PASS' : 'FAIL'}`)
      console.log(`START:     ${res.operations.start.passed ? 'PASS' : 'FAIL'}`)
      console.log(`UNINSTALL: ${res.operations.uninstall.passed ? 'PASS' : 'FAIL'}`)
      console.log(`ROLLBACK:  ${res.operations.rollback.passed ? 'PASS' : 'FAIL'}`)
      console.log(`OVERALL:   ${res.allPassed ? 'ALL LIFECYCLE OPERATIONS PASSED' : 'FAILED'}`)
    }
    process.exit(res.allPassed ? 0 : 1)
  }).catch((err) => {
    console.error(`Lifecycle verification failed:`, err)
    process.exit(1)
  })
}
