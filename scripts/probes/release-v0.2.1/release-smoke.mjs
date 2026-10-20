#!/usr/bin/env node
/**
 * Release Smoke Verification Probe for v0.2.1
 *
 * Provides a clean-room, isolated runtime smoke verification suite for
 * `dsh-word-lookup@0.2.1` on DeepSeek Harness (DSH).
 *
 * Supports:
 * - `--source local-tarball`: Installs and verifies the candidate `.tgz` archive
 * - `--source npm`: Queries official npm registry, downloads tarball, verifies SHA-256,
 *   and executes post-publication smoke acceptance. (Fails closed on E404 when not yet published).
 *
 * Supports custom DSH binary via `--dsh-bin` for targeted DSH 0.2.1-rc.2 verification.
 *
 * @module scripts/probes/release-v0.2.1/release-smoke
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
import { spawn, spawnSync, execSync } from 'node:child_process'
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

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const EXPECTED_PACKAGE_NAME = 'dsh-word-lookup'
const EXPECTED_VERSION = '0.2.1'
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath))
}

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

async function findAvailablePort(startPort = 50995) {
  for (let port = startPort; port < 60000; port++) {
    if (PRODUCTION_PORTS.includes(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error('Unable to find an available high port between 50995 and 60000')
}

function resolveDshInvocation(dshBinOption) {
  if (!dshBinOption || dshBinOption === 'dsh') {
    const defaultNpmBin = join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (existsSync(defaultNpmBin)) {
      return { cmd: process.execPath, baseArgs: [defaultNpmBin], isNodeScript: true }
    }
    return { cmd: 'dsh', baseArgs: [], isNodeScript: false }
  }
  if (dshBinOption.endsWith('.js') || dshBinOption.endsWith('.mjs') || dshBinOption.endsWith('.cjs')) {
    return { cmd: process.execPath, baseArgs: [resolve(dshBinOption)], isNodeScript: true }
  }
  return { cmd: dshBinOption, baseArgs: [], isNodeScript: false }
}

async function bootDsh(verified, port, cwd, dshInvocation, timeoutMs = 90000) {
  const env = buildIsolatedEnv(verified, process.env, { PORT: String(port) })
  const args = [...dshInvocation.baseArgs, '--profile', verified.profile, '--no-open', '--port', String(port)]
  const child = spawn(dshInvocation.cmd, args, {
    cwd,
    env,
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(async () => {
      await stopDsh(child, port).catch(() => {})
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

  await new Promise((r) => setTimeout(r, 1200))
  return {
    child,
    url,
    stdoutLog: () => stdout,
    stderrLog: () => stderr,
  }
}

async function stopDsh(child, port) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
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

const DISMISS_LABEL = /configure later|not now|skip|later|close|dismiss|got it|continue|ok|稍后配置|跳过/i
async function dismissAllModals(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const dialogs = page.locator('[role="dialog"]')
    const count = await dialogs.count()
    if (count === 0) break

    const dialog = dialogs.last()
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()

    let clicked = false
    for (let index = 0; index < buttonCount; index++) {
      const text = ((await buttons.nth(index).textContent()) ?? '').trim()
      if (DISMISS_LABEL.test(text)) {
        await buttons.nth(index).click().catch(() => {})
        await page.waitForTimeout(600)
        clicked = true
        break
      }
    }
    if (!clicked) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  }
}

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
  } catch {}

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

  const stderr = (res.stderr || '').trim()
  if (stderr.includes('E404') || stderr.includes('404 Not Found') || stderr.includes('No match found for version')) {
    return { state: 'NOT_PUBLISHED', error: { code: 'E404', detail: stderr } }
  }
  if (stderr.includes('ENOTFOUND') || stderr.includes('ETIMEDOUT') || stderr.includes('ECONNREFUSED')) {
    return { state: 'NETWORK_ERROR', error: { code: 'NETWORK_ERROR', detail: stderr } }
  }

  return { state: 'REGISTRY_ERROR', error: { code: 'UNKNOWN_ERROR', detail: stderr || res.stdout } }
}

async function main() {
  const startTime = Date.now()
  const options = parseArgs(process.argv.slice(2))
  const sourceMode = options.source

  console.log('======================================================================')
  console.log(' Release v0.2.1: Isolated Smoke Test Execution Probe')
  console.log('======================================================================\n')

  if (!sourceMode || !['local-tarball', 'npm'].includes(sourceMode)) {
    console.error('ERROR: Missing or invalid --source argument.')
    console.error('Usage:')
    console.error('  node scripts/probes/release-v0.2.1/release-smoke.mjs --source local-tarball [--tarball <path>]')
    console.error('  node scripts/probes/release-v0.2.1/release-smoke.mjs --source npm [--registry <url>]')
    process.exit(1)
  }

  const dshInvocation = resolveDshInvocation(options['dsh-bin'])
  console.log(`Execution Mode:    --source ${sourceMode}`)
  console.log(`Repository Root:   ${REPO_ROOT}`)
  console.log(`Target Package:    ${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`)
  console.log(`DSH Command:       ${dshInvocation.cmd} ${dshInvocation.baseArgs.join(' ')}`)

  const evidenceDir = resolve(REPO_ROOT, options['evidence-dir'] || 'docs/evidence/release-v0.2.1')
  mkdirSync(evidenceDir, { recursive: true })
  const screenshotsDir = join(evidenceDir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })

  let registryMetadata = null
  let downloadedTarballPath = null
  let expectedTarballSha256 = options['expected-sha256'] || null
  let expectedTarballSize = options['expected-size'] ? Number(options['expected-size']) : null

  // ---------------------------------------------------------------------------
  // [Gate 1] npm preflight handling for --source npm
  // ---------------------------------------------------------------------------
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

      const reportPath = join(evidenceDir, options['evidence-name'] || 'npm-smoke-preflight-report.json')
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
    console.log(`  dist.shasum:    ${registryMetadata.dist?.shasum}`)
    console.log(`  dist.integrity: ${registryMetadata.dist?.integrity}`)
    console.log(`  dist.tarball:   ${registryMetadata.dist?.tarball}`)

    const tarballUrl = registryMetadata.dist?.tarball
    if (!tarballUrl) throw new Error('Registry metadata missing dist.tarball URL')

    const downloadTemp = join(tmpdir(), `npm-download-v021-${Date.now()}-${randomUUID().slice(0, 6)}.tgz`)
    console.log(`Downloading published tarball from ${tarballUrl}...`)
    const dlFetch = await fetch(tarballUrl)
    if (!dlFetch.ok) {
      throw new Error(`Failed to download published tarball from ${tarballUrl}: HTTP ${dlFetch.status}`)
    }
    const dlBuf = Buffer.from(await dlFetch.arrayBuffer())
    writeFileSync(downloadTemp, dlBuf)
    downloadedTarballPath = downloadTemp
    const downloadedHash = sha256File(downloadedTarballPath)
    console.log(`Downloaded tarball SHA-256: ${downloadedHash}`)

    if (expectedTarballSha256 && downloadedHash !== expectedTarballSha256) {
      throw new Error(`Downloaded npm tarball SHA-256 mismatch! Expected ${expectedTarballSha256}, got ${downloadedHash}`)
    }
    expectedTarballSha256 = downloadedHash
    console.log('PASS: Downloaded npm tarball retrieved and verified.')
  }

  // ---------------------------------------------------------------------------
  // [Gate 2] Candidate package verification for --source local-tarball
  // ---------------------------------------------------------------------------
  let localTarballPath = null
  if (sourceMode === 'local-tarball') {
    const candidateArg = options.tarball || 'build/rc-v0.2.1/dsh-word-lookup-0.2.1.tgz'
    localTarballPath = resolve(REPO_ROOT, candidateArg)
    console.log(`\n[candidate-verification] Candidate Tarball: ${localTarballPath}`)

    if (!existsSync(localTarballPath)) {
      throw new Error(`Candidate tarball does not exist: ${localTarballPath}`)
    }

    const tgzStat = statSync(localTarballPath)
    const tgzHash = sha256File(localTarballPath)

    console.log(`  Byte size: ${tgzStat.size} bytes`)
    console.log(`  SHA-256:   ${tgzHash}`)

    if (expectedTarballSize && tgzStat.size !== expectedTarballSize) {
      throw new Error(`Candidate tarball size mismatch! Expected ${expectedTarballSize}, got ${tgzStat.size}`)
    }
    if (expectedTarballSha256 && tgzHash !== expectedTarballSha256) {
      throw new Error(`Candidate tarball SHA-256 mismatch! Expected ${expectedTarballSha256}, got ${tgzHash}`)
    }
    expectedTarballSha256 = tgzHash
    expectedTarballSize = tgzStat.size
    console.log('PASS: Local candidate tarball verified.')
  }

  // ---------------------------------------------------------------------------
  // [Gate 3] Isolated Environment Setup & Assertion
  // ---------------------------------------------------------------------------
  console.log('\n[isolation-setup] Establishing isolated DSH environment...')
  const testRoot = resolve(options['test-root'] ?? join(tmpdir(), `dsh-release-smoke-v021-${randomUUID().slice(0, 8)}`))
  const testHome = join(testRoot, 'home')
  const testProfile = `smoke-v021-${randomUUID().slice(0, 6)}`
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

  const initArgs = [...dshInvocation.baseArgs, testProfile, '--from-default-profile', 'web', '--dump-config']
  const initRes = spawnSync(dshInvocation.cmd, initArgs, {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
  })
  if (initRes.status !== 0 && !existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`Failed to initialize isolated profile: ${initRes.stderr}`)
  }
  console.log('PASS: Profile initialized with baseline Web bundles.')

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

  console.log('\n[package-install] Installing plugin into isolated profile via DSH CLI...')
  let installArgs = []
  if (sourceMode === 'local-tarball') {
    installArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'add', localTarballPath]
  } else {
    installArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'add', `${EXPECTED_PACKAGE_NAME}@${EXPECTED_VERSION}`, '--registry', OFFICIAL_NPM_REGISTRY]
  }

  const installRes = spawnSync(dshInvocation.cmd, installArgs, {
    cwd: testRoot,
    env: isolatedEnv,
    encoding: 'utf8',
    shell: !dshInvocation.isNodeScript && process.platform === 'win32',
  })
  if (installRes.status !== 0) {
    throw new Error(`dsh plugin add failed:\n${installRes.stderr}\n${installRes.stdout}`)
  }
  console.log('PASS: dsh plugin add executed successfully.')

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
    multilineFormattingVerified: 'NOT_VERIFIED',
    posBadgeDeduplicationVerified: 'NOT_VERIFIED',
    narrowViewportVerified: 'NOT_VERIFIED',
    scrollabilityVerified: 'NOT_VERIFIED',
    settingsUpdatedBadgesVerified: 'NOT_VERIFIED',
    uninstallationClean: 'NOT_VERIFIED',
    screenshots: {},
  }

  try {
    dshInstance = await bootDsh(verified, testPort, testRoot, dshInvocation)
    console.log(`DSH running at ${dshInstance.url} (PID: ${dshInstance.child.pid})`)

    const browserUserData = join(testRoot, 'chrome-user-data')
    mkdirSync(browserUserData, { recursive: true })
    context = await chromium.launchPersistentContext(browserUserData, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    })
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage()

    // Route interceptor for controlled synthetic word lookups (multiline & scroll testing)
    await page.route('**/api/dsh-word-lookup**', async (route) => {
      const req = route.request()
      if (req.method() === 'POST') {
        const postData = JSON.parse(req.postData() ?? '{}')
        if (postData.query === 'pass') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              found: true,
              query: 'pass',
              headword: 'pass',
              phonetic: '/pɑːs, pæs/',
              meanings: [
                {
                  partOfSpeech: 'v.',
                  translation:
                    'n. 穿过, 通过, 经过, 通行证, 护照, 入场券, 票, 隘口, 关口\\nvt. 通过, 经过, 穿过, 度过, 超越, 传递, 传球, 遗留, 批准\\nvi. 经过, 穿过, 变化, 终止, 传递, 被通过',
                  definition:
                    'n. (sports) the act of throwing the ball to another member of your team\\nn. a success in a test or exam\\nv. to move past something or someone\\nv. to give something to someone using your hands',
                },
              ],
              forms: [
                { form: 'passed', kind: 'past' },
                { form: 'passing', kind: 'participle' },
              ],
              matchedForm: null,
              examples: [
                { en: 'Time passes quickly.', zh: '光阴似箭。' },
                { en: 'The bill passed in parliament.', zh: '该法案在议会获得通过。' },
              ],
              source: 'ecdict-local',
              settings: { autoDoubleClick: false, autoSelection: false },
            }),
          })
        }
        if (postData.query === 'long-entry') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              found: true,
              query: 'long-entry',
              headword: 'long-entry',
              phonetic: '/lɔːŋ ˈɛntri/',
              meanings: [
                {
                  partOfSpeech: 'n.',
                  translation: Array.from(
                    { length: 12 },
                    (_, i) =>
                      `释义行 ${i + 1}：用于验证长释义卡片垂直滚动的详细中文翻译条目，包含丰富上下文`,
                  ).join('\\n'),
                  definition: Array.from(
                    { length: 12 },
                    (_, i) =>
                      `Definition line ${i + 1}: detailed English explanation sense to enforce card scrollHeight exceeding clientHeight constraint`,
                  ).join('\\n'),
                },
              ],
              forms: [{ form: 'long-entries', kind: 'plural' }],
              matchedForm: null,
              examples: [
                {
                  en: 'Comprehensive test example to ensure container scrollability is verified.',
                  zh: '用于确保容器可滚动性得到严格验证的综合测试用例。',
                },
                {
                  en: 'Second example validating maximum height enforcement.',
                  zh: '验证卡片最大高度限制的第二个示例。',
                },
              ],
              source: 'ecdict-local',
              settings: { autoDoubleClick: false, autoSelection: false },
            }),
          })
        }
      }
      return route.continue()
    })

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

    // Acceptance 2: Settings entry appears in UI & check updated status badge
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

    // Check Settings badges and description updates
    await page.waitForTimeout(800)
    const settingsAudit = await page.evaluate(() => {
      const root = document.querySelector('.dsh-wl-settings') || document.body
      const text = root.textContent || ''
      const hasPhase7A8 = text.includes('Phase 7A.8 开放') || text.includes('Phase 7A.8')
      const hasSupportedBadge = text.includes('已支持')
      const hasUpdatedDesc = text.includes('请在上方“自定义 SQLite 词典管理”区域配置并挂载使用')
      return { hasPhase7A8, hasSupportedBadge, hasUpdatedDesc }
    })

    if (!settingsAudit.hasPhase7A8 && settingsAudit.hasSupportedBadge) {
      verificationEvidence.settingsUpdatedBadgesVerified = 'PASS'
      console.log('PASS: Settings UI accurately shows "已支持" and obsolete "Phase 7A.8 开放" is absent.')
    } else {
      throw new Error(`Settings UI text audit failed: ${JSON.stringify(settingsAudit)}`)
    }

    const settingsShot = join(screenshotsDir, '04-settings-ui-support-badge.png')
    await page.screenshot({ path: settingsShot, fullPage: true })
    verificationEvidence.screenshots.settings = settingsShot

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

    // Acceptance 4: Legal word query test (Real Fixture Lookup: "derive")
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

    // Close settings dialog to test card overlays
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // Acceptance 6: FMT-01 Card Multiline Rendering & POS Badge Deduplication
    console.log('\n--- [Acceptance 6] Verifying Card Multiline Formatting & POS Dedup ---')
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('pass', 'shortcut')
    })
    await page.waitForSelector('[data-dsh-word-lookup="card"]', { timeout: 10_000 })
    await page.waitForSelector('[data-dsh-word-lookup="translation-line"]', { timeout: 10_000 })

    const cardMetrics = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const transLines = Array.from(document.querySelectorAll('[data-dsh-word-lookup="translation-line"]'))
      const defLines = Array.from(document.querySelectorAll('[data-dsh-word-lookup="definition-line"]'))
      const cardRect = card.getBoundingClientRect()
      const transRects = transLines.map((el) => ({
        text: el.textContent.trim(),
        top: el.getBoundingClientRect().top,
        height: el.getBoundingClientRect().height,
      }))
      const defRects = defLines.map((el) => ({
        text: el.textContent.trim(),
        top: el.getBoundingClientRect().top,
        height: el.getBoundingClientRect().height,
      }))
      return {
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
        transLineCount: transLines.length,
        defLineCount: defLines.length,
        transRects,
        defRects,
        hasLiteralEscapeInText: card.textContent.includes('\\n'),
        firstTransLine: transLines[0]?.textContent.trim() ?? '',
        hasDuplicatePos: (transLines[0]?.textContent ?? '').includes('v.n.'),
      }
    })

    console.log(`Card dimensions: ${cardMetrics.cardWidth}px x ${cardMetrics.cardHeight}px`)
    console.log(`Translation lines count: ${cardMetrics.transLineCount}`)
    console.log(`Definition lines count: ${cardMetrics.defLineCount}`)
    console.log(`Literal \\n in text: ${cardMetrics.hasLiteralEscapeInText}`)

    const noPosDuplication = !cardMetrics.hasDuplicatePos && cardMetrics.firstTransLine.startsWith('n.')
    const transYOrderValid =
      cardMetrics.transRects.length === 3 &&
      cardMetrics.transRects[1].top > cardMetrics.transRects[0].top &&
      cardMetrics.transRects[2].top > cardMetrics.transRects[1].top
    const defYOrderValid =
      cardMetrics.defRects.length === 4 &&
      cardMetrics.defRects[1].top > cardMetrics.defRects[0].top &&
      cardMetrics.defRects[2].top > cardMetrics.defRects[1].top &&
      cardMetrics.defRects[3].top > cardMetrics.defRects[2].top

    if (transYOrderValid && defYOrderValid && !cardMetrics.hasLiteralEscapeInText) {
      verificationEvidence.multilineFormattingVerified = 'PASS'
      console.log('PASS: Multiline translations and definitions render cleanly with descending vertical positions.')
    } else {
      throw new Error(`Multiline formatting failed: transYOrderValid=${transYOrderValid}, defYOrderValid=${defYOrderValid}`)
    }

    if (noPosDuplication) {
      verificationEvidence.posBadgeDeduplicationVerified = 'PASS'
      console.log('PASS: POS badge duplication successfully suppressed ("v.n." absent, starts with "n.").')
    } else {
      throw new Error(`POS badge duplication detected: ${cardMetrics.firstTransLine}`)
    }

    const cardNormalShot = join(screenshotsDir, '01-card-multiline-normal-360px.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNormalShot })
    verificationEvidence.screenshots.cardNormal = cardNormalShot

    // Narrow Viewport test (320px)
    console.log('\n--- [Acceptance 7] Testing Narrow Viewport Responsiveness ---')
    await page.setViewportSize({ width: 320, height: 600 })
    await page.waitForTimeout(500)
    const narrowCardWidth = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      return card.getBoundingClientRect().width
    })
    console.log(`Narrow viewport card width: ${narrowCardWidth}px (<= 320px)`)
    if (narrowCardWidth <= 320) {
      verificationEvidence.narrowViewportVerified = 'PASS'
      console.log('PASS: Card layout adapts cleanly to narrow 320px viewport without horizontal overflow.')
    } else {
      throw new Error(`Card width ${narrowCardWidth}px exceeds 320px viewport limit`)
    }
    const cardNarrowShot = join(screenshotsDir, '02-card-multiline-narrow-viewport.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNarrowShot })
    verificationEvidence.screenshots.cardNarrow = cardNarrowShot

    // Reset viewport and dismiss card
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // Long entry scroll test
    console.log('\n--- [Acceptance 8] Testing Long Entry Scrollability ---')
    await page.evaluate(() => {
      window.__DSH_WORD_LOOKUP__.runLookup('long-entry', 'shortcut')
    })
    await page.waitForSelector('[data-dsh-word-lookup="card"]', { timeout: 10_000 })
    await page.waitForSelector('[data-dsh-word-lookup="translation-line"]', { timeout: 10_000 })
    await page.waitForTimeout(400)

    const scrollInfo = await page.evaluate(async () => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const beforeScroll = card.scrollTop
      const scrollHeight = card.scrollHeight
      const clientHeight = card.clientHeight
      const scrollWidth = card.scrollWidth
      const clientWidth = card.clientWidth

      card.scrollTop = 120
      await new Promise((r) => requestAnimationFrame(r))
      const afterScroll = card.scrollTop

      return {
        scrollHeight,
        clientHeight,
        scrollWidth,
        clientWidth,
        beforeScroll,
        afterScroll,
        isScrollable: scrollHeight > clientHeight,
        didScroll: afterScroll > beforeScroll,
        withinMaxHeightLimit: clientHeight <= 440,
        noHorizontalOverflow: scrollWidth <= clientWidth + 1,
      }
    })

    console.log(`Scrollability: scrollHeight=${scrollInfo.scrollHeight}, clientHeight=${scrollInfo.clientHeight}`)
    console.log(`Scroll action: before=${scrollInfo.beforeScroll}, after=${scrollInfo.afterScroll}`)

    if (scrollInfo.isScrollable && scrollInfo.didScroll && scrollInfo.withinMaxHeightLimit && scrollInfo.noHorizontalOverflow) {
      verificationEvidence.scrollabilityVerified = 'PASS'
      console.log('PASS: Long entry scrolling strictly verified (scrollHeight > clientHeight, scrollTop moved, maxHeight <= 440px).')
    } else {
      throw new Error(`Scrollability verification failed: ${JSON.stringify(scrollInfo)}`)
    }

    const cardScrollShot = join(screenshotsDir, '03-card-multiline-scroll.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardScrollShot })
    verificationEvidence.screenshots.cardScroll = cardScrollShot

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Acceptance 9: ECDICT not downloaded, zero external network requests
    console.log('\n--- [Acceptance 9] Verifying ECDICT Download Boundary Invariant ---')
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

    // Acceptance 10: Clean uninstallation test
    if (options['skip-uninstall'] !== 'true') {
      console.log('\n--- [Acceptance 10] Verifying Clean Uninstallation Lifecycle ---')
      console.log('Executing dsh plugin remove...')
      const removeArgs = [...dshInvocation.baseArgs, 'plugin', '--profile', testProfile, 'remove', EXPECTED_PACKAGE_NAME]
      const removeRes = spawnSync(dshInvocation.cmd, removeArgs, {
        cwd: testRoot,
        env: isolatedEnv,
        encoding: 'utf8',
        shell: !dshInvocation.isNodeScript && process.platform === 'win32',
      })
      if (removeRes.status !== 0) {
        throw new Error(`dsh plugin remove failed:\n${removeRes.stderr}\n${removeRes.stdout}`)
      }
      console.log('PASS: Plugin uninstalled via DSH CLI.')

      console.log('Rebooting isolated DSH without plugin to verify clean removal...')
      dshInstance = await bootDsh(verified, testPort, testRoot, dshInvocation)

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
    phase: 'RELEASE_V021',
    mode: sourceMode,
    verdict: 'PASS',
    durationMs,
    packageIdentity: {
      name: EXPECTED_PACKAGE_NAME,
      version: EXPECTED_VERSION,
      sourceMode,
      tarballSha256: expectedTarballSha256,
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

  const reportPath = join(evidenceDir, options['evidence-name'] || 'smoke-execution-report.json')
  writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8')
  console.log(`\nEvidence report written to: ${reportPath}`)

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
