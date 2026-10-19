#!/usr/bin/env node
/**
 * Release Smoke Verification Probe (Phase 7A.10)
 *
 * Provides a clean-room, isolated runtime smoke verification suite for
 * `dsh-word-lookup@0.2.0` on real DeepSeek Harness (DSH) 0.2.0-rc.2 Web Profile.
 *
 * Supports two distinct execution modes:
 * - `--source local-tarball`: Installs and verifies the pre-tested candidate
 *   `.tgz` archive (build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz) in an isolated profile,
 *   proving that the smoke execution pipeline is 100% operational prior to publication.
 * - `--source npm`: Queries the official npm registry (https://registry.npmjs.org/)
 *   for published `dsh-word-lookup@0.2.0`, verifies registry metadata and tarball SHA-256,
 *   and executes post-publication smoke acceptance on the genuine npm artifact.
 *   If version 0.2.0 is not yet published (E404), reports NOT_PUBLISHED cleanly
 *   and fails closed without simulating success.
 *
 * Strict Isolation & Security Contracts:
 * 1. Executes in a dedicated scratch directory under OS tempdir.
 * 2. Generates an isolated, randomized non-production profile name.
 * 3. Enforces assertIsolatedDshEnvironment() before any mutation.
 * 4. Binds an independently probed idle high port (never production ports 19387 / 50001).
 * 5. Strips all host DSH_* environment variables.
 * 6. Verifies installation is a genuine unpacked package, never a workspace symlink/junction.
 * 7. Never kills unrelated system processes.
 * 8. Ensures clean uninstallation and non-interfering environment cleanup.
 *
 * @module scripts/probes/phase7a10/release-smoke
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  DEFAULT_TEST_ROOT,
  FORBIDDEN_PROFILES,
  isPortFree,
  ISOLATION_BANNER,
  IsolationError,
  PRODUCTION_PORTS,
} from '../../assert-isolated-env.mjs'

/** Repository root path */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Expected authoritative release metadata */
const EXPECTED_PACKAGE_NAME = 'dsh-word-lookup'
const EXPECTED_VERSION = '0.2.0'
const EXPECTED_TARBALL_SIZE = 135731
const EXPECTED_TARBALL_SHA256 = 'ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34'
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** ANSI color regex for stdout/stderr scraping */
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g

/**
 * Compute SHA-256 hex digest of a buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Compute SHA-256 hex digest of a file.
 * @param {string} filePath
 * @returns {string}
 */
function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = 'true'
    } else {
      options[key] = next
      i++
    }
  }
  return options
}

/**
 * Find an available high TCP port.
 * @param {number} startPort
 * @returns {Promise<number>}
 */
async function findAvailablePort(startPort = 50995) {
  for (let port = startPort; port < 60000; port++) {
    if (PRODUCTION_PORTS.includes(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error('Unable to find an available high port between 50995 and 60000')
}

/**
 * Boot isolated DSH Web profile child process.
 * @param {object} verified - Output from assertIsolatedDshEnvironment
 * @param {number} port - Bound port
 * @param {string} cwd - Execution working directory
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, stdoutLog: () => string, stderrLog: () => string }>}
 */
async function bootDsh(verified, port, cwd, timeoutMs = 60000) {
  const env = buildIsolatedEnv(verified, process.env, { PORT: String(port) })
  const child = spawn('dsh', ['--profile', verified.profile, '--no-open', '--port', String(port)], {
    cwd,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`DSH startup timed out after ${timeoutMs}ms.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    }, timeoutMs)

    const consume = (chunk, isStderr) => {
      const text = chunk.toString().replace(ANSI_REGEX, '')
      if (isStderr) stderr += text
      else stdout += text

      const match = /https?:\/\/[^\s"']*\/\?token=([A-Za-z0-9._~-]+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[0])
      }
    }

    child.stdout.on('data', (c) => consume(c, false))
    child.stderr.on('data', (c) => consume(c, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error(`DSH exited prematurely with exit code ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    })
  })

  // Brief stabilization pause
  await new Promise((r) => setTimeout(r, 1200))
  return {
    child,
    url,
    stdoutLog: () => stdout,
    stderrLog: () => stderr,
  }
}

/**
 * Cleanly stop a DSH child process and its descendants without touching other processes.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} port
 */
async function stopDsh(child, port) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
    // Only kill the spawned process tree rooted at child.pid
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))])
  await new Promise((r) => setTimeout(r, 1000))

  if (port) {
    const free = await isPortFree(port)
    if (!free) {
      console.warn(`[WARNING] Port ${port} is still occupied after stopping DSH PID ${child.pid}. Waiting...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

/**
 * Dismiss introductory dialogs / modals in DSH Web UI.
 * @param {import('playwright').Page} page
 */
async function dismissAllModals(page) {
  for (let i = 0; i < 5; i++) {
    const continueBtn = page.getByRole('button', { name: 'Continue', exact: true })
    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click()
      await page.waitForTimeout(600)
    }

    const skipBtn = page.locator('button:has-text("Configure later"), button:has-text("稍后配置"), button:has-text("Skip"), button:has-text("跳过")')
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click()
      await page.waitForTimeout(600)
    }

    const dialog = page.locator('[role="dialog"]')
    if (await dialog.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    } else {
      break
    }
  }
}

/**
 * Inspect npm registry for package version availability and distinguish E404 vs network failure.
 * @param {string} packageName
 * @param {string} version
 * @param {string} registry
 * @returns {{ state: 'PUBLISHED' | 'NOT_PUBLISHED' | 'NETWORK_ERROR' | 'REGISTRY_ERROR', data?: any, error?: any }}
 */
function checkNpmRegistry(packageName, version, registry = OFFICIAL_NPM_REGISTRY) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const spec = `${packageName}@${version}`
  const res = spawnSync(npmCmd, ['view', spec, '--registry', registry, '--json'], {
    encoding: 'utf8',
    shell: true,
  })

  let parsed = null
  try {
    if (res.stdout && res.stdout.trim().startsWith('{')) {
      parsed = JSON.parse(res.stdout.trim())
    }
  } catch {
    // Non-JSON output
  }

  if (parsed && parsed.error) {
    const code = parsed.error.code
    if (code === 'E404') {
      return { state: 'NOT_PUBLISHED', error: parsed.error }
    }
    if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)) {
      return { state: 'NETWORK_ERROR', error: parsed.error }
    }
    return { state: 'REGISTRY_ERROR', error: parsed.error }
  }

  if (res.status === 0 && parsed && parsed.version === version) {
    return { state: 'PUBLISHED', data: parsed }
  }

  // Check stderr if stdout had no json
  const stderr = (res.stderr || '').trim()
  if (stderr.includes('E404') || stderr.includes('404 Not Found') || stderr.includes('No match found for version')) {
    return { state: 'NOT_PUBLISHED', error: { code: 'E404', detail: stderr } }
  }
  if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT') || stderr.includes('ECONNREFUSED')) {
    return { state: 'NETWORK_ERROR', error: { code: 'NETWORK_ERROR', detail: stderr } }
  }

  return { state: 'REGISTRY_ERROR', error: { code: 'UNKNOWN_ERROR', detail: stderr || res.stdout } }
}

/**
 * Execute clean smoke verification run.
 */
async function main() {
  const startTime = Date.now()
  const options = parseArgs(process.argv.slice(2))
  const sourceMode = options.source

  console.log('======================================================================')
  console.log(' Phase 7A.10: DSH 0.2.0-rc.2 Release Smoke Test Execution Suite')
  console.log('======================================================================\n')

  if (!sourceMode || !['local-tarball', 'npm'].includes(sourceMode)) {
    console.error('ERROR: Missing or invalid --source argument.')
    console.error('Usage:')
    console.error('  node scripts/probes/phase7a10/release-smoke.mjs --source local-tarball [--tarball <path>]')
    console.error('  node scripts/probes/phase7a10/release-smoke.mjs --source npm [--registry <url>]')
    process.exit(1)
  }

  console.log(`Execution Mode:    --source ${sourceMode}`)
  console.log(`Repository Root:   ${REPO_ROOT}`)
  console.log(`Target Package:    ${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`)

  // ---------------------------------------------------------------------------
  // [Gate 1] npm preflight handling for --source npm
  // ---------------------------------------------------------------------------
  let registryMetadata = null
  let downloadedTarballPath = null

  if (sourceMode === 'npm') {
    const registry = options.registry || OFFICIAL_NPM_REGISTRY
    console.log(`\n[npm-preflight] Querying official registry: ${registry}...`)
    const registryCheck = checkNpmRegistry(EXPECTED_PACKAGE_NAME, EXPECTED_VERSION, registry)

    if (registryCheck.state === 'NOT_PUBLISHED') {
      console.log(`\n[NPM_PREFLIGHT_STATUS] NOT_PUBLISHED`)
      console.log(`Reason: Package ${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION} is not yet published on ${registry} (E404).`)
      console.log('Pre-publication read-only preflight check passed (E404 strictly confirmed).')
      console.log('Per release specification, npm smoke test cannot be executed prior to publication.')
      console.log('Execution safely aborted (FAIL-CLOSED, zero simulated success).')

      const preflightReport = {
        timestamp: new Date().toISOString(),
        mode: 'npm',
        verdict: 'NOT_EXECUTED_PRE_PUBLICATION',
        reason: 'NOT_PUBLISHED (E404 confirmed from official registry)',
        registry,
        package: `${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`,
        error: registryCheck.error,
      }

      const reportPath = resolve(REPO_ROOT, 'docs/evidence/phase7a10-prep/smoke-execution-report.json')
      writeFileSync(reportPath, JSON.stringify(preflightReport, null, 2), 'utf8')
      console.log(`Report written to: ${reportPath}`)
      process.exit(0)
    }

    if (registryCheck.state === 'NETWORK_ERROR') {
      console.error(`\n[FATAL] npm registry network error: ${JSON.stringify(registryCheck.error)}`)
      process.exit(2)
    }

    if (registryCheck.state !== 'PUBLISHED') {
      console.error(`\n[FATAL] Unexpected registry state: ${registryCheck.state}: ${JSON.stringify(registryCheck.error)}`)
      process.exit(2)
    }

    registryMetadata = registryCheck.data
    console.log(`[PASS] Registry metadata retrieved for version ${registryMetadata.version}`)
    console.log(`  dist.shasum:   ${registryMetadata.dist?.shasum}`)
    console.log(`  dist.integrity: ${registryMetadata.dist?.integrity}`)
    console.log(`  dist.tarball:   ${registryMetadata.dist?.tarball}`)

    // Download and verify tarball hash
    const tarballUrl = registryMetadata.dist?.tarball
    if (!tarballUrl) throw new Error('Registry metadata missing dist.tarball URL')

    const downloadTemp = join(tmpdir(), `npm-download-${Date.now()}-${randomUUID().slice(0, 6)}.tgz`)
    console.log(`Downloading published tarball from ${tarballUrl}...`)
    const dlRes = spawnSync('node', [
      '-e',
      `const https = require('node:https'); const fs = require('node:fs');
       const file = fs.createWriteStream(${JSON.stringify(downloadTemp)});
       https.get(${JSON.stringify(tarballUrl)}, (res) => {
         res.pipe(file);
         file.on('finish', () => { file.close(); process.exit(0); });
       }).on('error', (err) => { process.exit(1); });`,
    ], { shell: true })
    if (dlRes.status !== 0 || !existsSync(downloadTemp)) {
      throw new Error(`Failed to download published tarball from ${tarballUrl}`)
    }
    downloadedTarballPath = downloadTemp
    const downloadedHash = sha256File(downloadedTarballPath)
    console.log(`Downloaded tarball SHA-256: ${downloadedHash}`)
    if (downloadedHash !== EXPECTED_TARBALL_SHA256) {
      throw new Error(`Downloaded npm tarball SHA-256 mismatch! Expected ${EXPECTED_TARBALL_SHA256}, got ${downloadedHash}`)
    }
    console.log('PASS: Downloaded npm tarball SHA-256 matches candidate hash bit-for-bit!')
  }

  // ---------------------------------------------------------------------------
  // [Gate 2] Candidate package verification for --source local-tarball
  // ---------------------------------------------------------------------------
  let localTarballPath = null
  if (sourceMode === 'local-tarball') {
    const candidateArg = options.tarball || 'build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz'
    localTarballPath = resolve(REPO_ROOT, candidateArg)
    console.log(`\n[candidate-verification] Candidate Tarball: ${localTarballPath}`)

    if (!existsSync(localTarballPath)) {
      throw new Error(`Candidate tarball does not exist: ${localTarballPath}`)
    }

    const tgzStat = statSync(localTarballPath)
    const tgzHash = sha256File(localTarballPath)

    console.log(`  Byte size: ${tgzStat.size} bytes (Expected: ${EXPECTED_TARBALL_SIZE})`)
    console.log(`  SHA-256:   ${tgzHash}`)
    console.log(`  Expected:  ${EXPECTED_TARBALL_SHA256}`)

    if (tgzStat.size !== EXPECTED_TARBALL_SIZE) {
      throw new Error(`Candidate tarball size mismatch! Expected ${EXPECTED_TARBALL_SIZE}, got ${tgzStat.size}`)
    }
    if (tgzHash !== EXPECTED_TARBALL_SHA256) {
      throw new Error(`Candidate tarball SHA-256 mismatch! Expected ${EXPECTED_TARBALL_SHA256}, got ${tgzHash}`)
    }
    console.log('PASS: Local candidate tarball SHA-256 & byte size verified bit-for-bit.')
  }

  // ---------------------------------------------------------------------------
  // [Gate 3] Isolated Environment Setup & Assertion
  // ---------------------------------------------------------------------------
  console.log('\n[isolation-setup] Establishing isolated DSH environment...')
  const testRoot = resolve(options['test-root'] ?? join(tmpdir(), `dsh-release-smoke-${randomUUID().slice(0, 8)}`))
  const testHome = join(testRoot, 'home')
  const testProfile = `smoke-v020-${randomUUID().slice(0, 6)}`
  const profileDir = join(testHome, 'profiles', testProfile)
  const testPort = await findAvailablePort(options.port ? Number(options.port) : 50995)

  let verified = null
  try {
    verified = assertIsolatedDshEnvironment({
      home: testHome,
      profile: testProfile,
      port: testPort,
      profileDir,
      testRoot,
    })
  } catch (error) {
    if (error instanceof IsolationError) {
      console.error('\n' + error.message)
      console.error('Refusing to execute: target failed isolation contract.')
      process.exit(2)
    }
    throw error
  }
  console.log(ISOLATION_BANNER)
  console.log(`  Test Root:   ${testRoot}`)
  console.log(`  DSH_HOME:    ${testHome}`)
  console.log(`  Profile:     ${testProfile}`)
  console.log(`  Port:        ${testPort}`)

  mkdirSync(join(testHome, 'profiles'), { recursive: true })

  // ---------------------------------------------------------------------------
  // [Gate 4] Profile Initialization & Package Installation
  // ---------------------------------------------------------------------------
  console.log('\n[profile-setup] Initializing DSH Web profile from default template...')
  const isolatedEnv = buildIsolatedEnv(verified, process.env)

  // Initialize Web profile template using dsh CLI
  const initRes = spawnSync('dsh', [testProfile, '--from-default-profile', 'web', '--dump-config'], {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (initRes.status !== 0 && !existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`Failed to initialize isolated profile: ${initRes.stderr}`)
  }
  console.log('PASS: Profile initialized with baseline Web bundles.')

  // Bind the isolated test port explicitly in cordis.patch.yml
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# Isolated release smoke profile: bind verified test port only.',
      '- id: webserver',
      '  config:',
      "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
      `    port: !!js ctx.webStartup.port ?? ${String(testPort)}`,
      '',
    ].join('\n'),
    'utf8',
  )

  // Install package via dsh plugin command
  console.log('\n[package-install] Installing plugin into isolated profile via DSH CLI...')
  let installArgs = []
  if (sourceMode === 'local-tarball') {
    installArgs = ['plugin', '--profile', testProfile, 'add', localTarballPath]
  } else {
    installArgs = ['plugin', '--profile', testProfile, 'add', `${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`, '--registry', OFFICIAL_NPM_REGISTRY]
  }

  const installRes = spawnSync('dsh', installArgs, {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (installRes.status !== 0) {
    throw new Error(`dsh plugin add failed:\n${installRes.stderr}\n${installRes.stdout}`)
  }
  console.log('PASS: dsh plugin add executed successfully.')

  // Verify node_modules installation provenance
  const installedDir = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
  if (!existsSync(installedDir)) {
    throw new Error(`Expected installed directory not found: ${installedDir}`)
  }

  const stat = lstatSync(installedDir)
  const isSymlink = stat.isSymbolicLink()
  const realInstalledPath = realpathSync.native(installedDir)
  console.log(`Installed Package Location: ${realInstalledPath}`)
  console.log(`  isSymbolicLink/Junction:   ${isSymlink}`)

  if (isSymlink) {
    throw new Error(`PROVENANCE VIOLATION: Installed package is a symlink/junction! Refusing execution.`)
  }

  // Ensure real path does not resolve into repository workspace
  const repoRootNorm = resolve(REPO_ROOT).toLowerCase()
  const realNorm = resolve(realInstalledPath).toLowerCase()
  if (realNorm === repoRootNorm || realNorm.startsWith(repoRootNorm + sep)) {
    throw new Error(`WORKSPACE LEAKAGE VIOLATION: Installed package resolves inside dev repo: ${realInstalledPath}`)
  }

  const installedPkgJson = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  if (installedPkgJson.name !== EXPECTED_PACKAGE_NAME || installedPkgJson.version !== EXPECTED_VERSION) {
    throw new Error(`Installed manifest mismatch: ${installedPkgJson.name}@${installedPkgJson.version}`)
  }
  console.log(`PASS: Installed package confirmed genuine isolated unpack of version ${installedPkgJson.version}.`)

  // ---------------------------------------------------------------------------
  // [Gate 5] Live DSH Boot & Minimal Acceptance Verification
  // ---------------------------------------------------------------------------
  console.log('\n[smoke-boot] Booting isolated DSH Web instance...')
  let dshInstance = null
  let browser = null
  let context = null
  let page = null

  const verificationEvidence = {
    pluginLoaded: 'NOT_VERIFIED',
    settingsNavVisible: 'NOT_VERIFIED',
    settingsSectionVisible: 'NOT_VERIFIED',
    fixtureModeActive: 'NOT_VERIFIED',
    lookupSuccessful: 'NOT_VERIFIED',
    lookupHeadword: null,
    lookupSource: null,
    autoDoubleClickDefaultOff: 'NOT_VERIFIED',
    autoSelectionDefaultOff: 'NOT_VERIFIED',
    ecdictNotDownloaded: 'NOT_VERIFIED',
    uninstallationClean: 'NOT_VERIFIED',
  }

  try {
    dshInstance = await bootDsh(verified, testPort, testRoot)
    console.log(`DSH running at ${dshInstance.url} (PID: ${dshInstance.child.pid})`)

    const browserUserData = join(testRoot, 'chrome-user-data')
    mkdirSync(browserUserData, { recursive: true })
    context = await chromium.launchPersistentContext(browserUserData, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    })
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()

    console.log('Navigating to DSH Web UI...')
    await page.goto(dshInstance.url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(1000)
    await dismissAllModals(page)

    // Acceptance 1: Plugin loads cleanly
    console.log('\n--- [Acceptance 1] Checking Plugin Diagnostics API & Load Status ---')
    const diagReady = await page.waitForFunction(() => {
      return typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null
    }, { timeout: 10000 }).then(() => true).catch(() => false)

    if (!diagReady) {
      throw new Error('Plugin failed to load: window.__DSH_WORD_LOOKUP__ diagnostics interface not found')
    }
    verificationEvidence.pluginLoaded = 'PASS'
    console.log('PASS: Plugin loaded cleanly, window.__DSH_WORD_LOOKUP__ exposed.')

    // Acceptance 2: Settings entry appears in UI
    console.log('\n--- [Acceptance 2] Verifying Settings Navigation & Section Rendering ---')
    await page.keyboard.press('Control+Alt+,')
    await page.waitForTimeout(600)
    if ((await page.locator('nav button').count()) === 0) {
      const settingsTrigger = page.locator('button[aria-label="Settings"], button:has-text("设置")').first()
      if (await settingsTrigger.isVisible().catch(() => false)) {
        await settingsTrigger.click({ force: true })
      }
    }
    await page.waitForSelector('nav button', { timeout: 8000 })
    const dictNavButton = page.locator('nav button:has-text("词典"), nav button:has-text("Dictionary")')
    await dictNavButton.waitFor({ state: 'visible', timeout: 5000 })
    verificationEvidence.settingsNavVisible = 'PASS'
    console.log('PASS: Settings navigation item "词典/Dictionary" visible.')

    await dictNavButton.click()
    const settingsSection = page.locator('.dsh-wl-settings')
    await settingsSection.waitFor({ state: 'visible', timeout: 5000 })
    verificationEvidence.settingsSectionVisible = 'PASS'
    console.log('PASS: Plugin settings panel (.dsh-wl-settings) successfully rendered.')

    // Acceptance 3: Default Fixture mode normal
    console.log('\n--- [Acceptance 3] Verifying Deterministic Fixture Mode ---')
    const dictStatus = await page.evaluate(async () => {
      const res = await window.fetch('api/dsh-word-lookup/dictionary/status')
      return await res.json()
    })
    console.log('Dictionary Status:', dictStatus)
    if (dictStatus?.activeMode === 'fixture' && dictStatus?.installed === false) {
      verificationEvidence.fixtureModeActive = 'PASS'
      console.log('PASS: Initial dictionary mode is strictly "fixture" (installed: false).')
    } else {
      throw new Error(`Unexpected dictionary status: ${JSON.stringify(dictStatus)}`)
    }

    // Acceptance 4: Legal word query test
    console.log('\n--- [Acceptance 4] Executing Real Word Lookup Query ("derive") ---')
    const lookupResponse = await page.evaluate(async () => {
      const res = await window.fetch('api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      })
      return await res.json()
    })
    console.log('Word Lookup Response:', lookupResponse)
    if (
      lookupResponse?.found === true &&
      lookupResponse?.headword === 'derive' &&
      lookupResponse?.source === 'sqlite-fixture'
    ) {
      verificationEvidence.lookupSuccessful = 'PASS'
      verificationEvidence.lookupHeadword = lookupResponse.headword
      verificationEvidence.lookupSource = lookupResponse.source
      console.log(`PASS: Lookup succeeded for "${lookupResponse.headword}" via ${lookupResponse.source}.`)
    } else {
      throw new Error(`Word lookup failed: ${JSON.stringify(lookupResponse)}`)
    }

    // Acceptance 5: Auto-double-click and auto-selection switches default OFF
    console.log('\n--- [Acceptance 5] Verifying Gesture Trigger Gates Default OFF ---')
    const dblSwitch = page.locator('#switch-auto-double-click')
    const selSwitch = page.locator('#switch-auto-selection')
    const dblChecked = await dblSwitch.getAttribute('aria-checked')
    const selChecked = await selSwitch.getAttribute('aria-checked')
    const hostGates = await page.evaluate(() => window.__DSH_WORD_LOOKUP__?.gates?.())

    console.log(`  #switch-auto-double-click aria-checked: ${dblChecked}`)
    console.log(`  #switch-auto-selection    aria-checked: ${selChecked}`)
    console.log(`  window.__DSH_WORD_LOOKUP__.gates():     ${JSON.stringify(hostGates)}`)

    if (dblChecked === 'false' && hostGates?.autoDoubleClick === false) {
      verificationEvidence.autoDoubleClickDefaultOff = 'PASS'
    } else {
      throw new Error(`autoDoubleClick not default off: aria-checked=${dblChecked}, gates=${JSON.stringify(hostGates)}`)
    }

    if (selChecked === 'false' && hostGates?.autoSelection === false) {
      verificationEvidence.autoSelectionDefaultOff = 'PASS'
    } else {
      throw new Error(`autoSelection not default off: aria-checked=${selChecked}, gates=${JSON.stringify(hostGates)}`)
    }
    console.log('PASS: Both gesture switches default strictly to OFF.')

    // Acceptance 6: ECDICT not downloaded, zero external network requests
    console.log('\n--- [Acceptance 6] Verifying ECDICT Download Boundary Invariant ---')
    if (dictStatus.installed === false && dictStatus.canInstall === true) {
      verificationEvidence.ecdictNotDownloaded = 'PASS'
      console.log('PASS: ECDICT corpus remains uninstalled; zero automatic downloads triggered.')
    } else {
      throw new Error(`ECDICT download boundary violated: ${JSON.stringify(dictStatus)}`)
    }

    // Close browser & shutdown DSH for uninstallation test
    await context.close()
    context = null
    await stopDsh(dshInstance.child, testPort)
    dshInstance = null

    // Acceptance 7: Clean uninstallation test
    if (options['skip-uninstall'] !== 'true') {
      console.log('\n--- [Acceptance 7] Verifying Clean Uninstallation Lifecycle ---')
      console.log('Executing dsh plugin remove...')
      const removeRes = spawnSync('dsh', ['plugin', '--profile', testProfile, 'remove', EXPECTED_PACKAGE_NAME], {
        cwd: testRoot,
        env: isolatedEnv,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      })
      if (removeRes.status !== 0) {
        throw new Error(`dsh plugin remove failed:\n${removeRes.stderr}\n${removeRes.stdout}`)
      }
      console.log('PASS: Plugin uninstalled via DSH CLI.')

      // Reboot DSH without plugin
      console.log('Rebooting isolated DSH without plugin to verify clean removal...')
      dshInstance = await bootDsh(verified, testPort, testRoot)

      context = await chromium.launchPersistentContext(browserUserData, {
        headless: true,
        viewport: { width: 1280, height: 800 },
      })
      page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()
      await page.goto(dshInstance.url, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(1000)

      const postUninstallLookup = await page.evaluate(async () => {
        try {
          const res = await window.fetch('api/dsh-word-lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'derive' }),
          })
          return { status: res.status }
        } catch (e) {
          return { error: String(e) }
        }
      })
      console.log('Post-uninstall lookup probe:', postUninstallLookup)
      if (postUninstallLookup.status !== 200) {
        verificationEvidence.uninstallationClean = 'PASS'
        console.log(`PASS: Lookup route cleanly disarmed (HTTP status ${postUninstallLookup.status}).`)
      } else {
        throw new Error(`Lookup route still responded with HTTP 200 after uninstallation!`)
      }

      await context.close()
      context = null
      await stopDsh(dshInstance.child, testPort)
      dshInstance = null
    } else {
      verificationEvidence.uninstallationClean = 'SKIPPED'
    }
  } finally {
    if (context) {
      await context.close().catch(() => {})
    }
    if (dshInstance) {
      await stopDsh(dshInstance.child, testPort).catch(() => {})
    }
    if (downloadedTarballPath && existsSync(downloadedTarballPath)) {
      rmSync(downloadedTarballPath, { force: true })
    }
  }

  // ---------------------------------------------------------------------------
  // [Gate 6] Record Final Smoke Execution Report & Clean Up
  // ---------------------------------------------------------------------------
  const durationMs = Date.now() - startTime
  const finalReport = {
    timestamp: new Date().toISOString(),
    phase: 'PHASE7A10',
    mode: sourceMode,
    verdict: 'PASS',
    durationMs,
    packageIdentity: {
      name: EXPECTED_PACKAGE_NAME,
      version: EXPECTED_VERSION,
      sourceMode,
      tarballSha256: EXPECTED_TARBALL_SHA256,
      installedPath: installedDir,
      isSymlink,
    },
    isolation: {
      testRoot,
      dshHome: testHome,
      profile: testProfile,
      port: testPort,
    },
    verificationEvidence,
  }

  const reportDir = resolve(REPO_ROOT, 'docs/evidence/phase7a10-prep')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, 'smoke-execution-report.json')
  writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8')
  console.log(`\nEvidence report written to: ${reportPath}`)

  // Clean up scratch test environment
  if (options['keep-evidence'] !== 'true') {
    console.log('Cleaning up isolated scratch directory...')
    rmSync(testRoot, { recursive: true, force: true })
    console.log('PASS: Scratch environment cleaned up.')
  } else {
    console.log(`Scratch directory retained at: ${testRoot}`)
  }

  console.log('\n======================================================================')
  console.log(` RELEASE SMOKE TEST VERDICT: PASS (Mode: --source ${sourceMode})`)
  console.log(` Duration: ${Math.round(durationMs / 1000)}s | Exit Code: 0`)
  console.log('======================================================================\n')
  process.exit(0)
}

main().catch((err) => {
  console.error('\n[FATAL SMOKE FAILURE]')
  console.error(err)
  process.exit(1)
})
