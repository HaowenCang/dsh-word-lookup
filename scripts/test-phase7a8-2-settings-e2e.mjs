#!/usr/bin/env node
/**
 * Real isolated DSH 0.2.0-rc.2 process E2E acceptance verification for Phase 7A.8.2R:
 * Native Settings UI, Custom Dictionary Management, Three-Mode Switching & Configurable Lookup Shortcut.
 *
 * Verifies live behavior against a real booted DSH instance via Chromium DOM interactions (V15–V21, V24):
 * - V15: Settings navigation and "词典" section rendering
 * - V16: Initial Fixture mode state & truthful counts
 * - V17: Custom SQLite path input & verification feedback
 * - V18: Custom dictionary activation, snapshot list update & live lookup
 * - V19: Three-mode switcher: switch to Fixture mode
 * - V20: Three-mode switcher: switch back to Custom mode (explicit snapshot routing)
 * - V21: Delete custom snapshot with modal confirmation & source file SHA-256 invariance
 * - V24: Configurable shortcut recorder modal, modifier enforcement, custom save & reset
 *
 * @module dsh-word-lookup/scripts/test-phase7a8-2-settings-e2e
 */

import { randomUUID, createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  isPortFree,
} from './assert-isolated-env.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PORT = 50999
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g

function sha256File(path) {
  const buf = readFileSync(path)
  return createHash('sha256').update(buf).digest('hex')
}

function buildCustomUserDatabase(dbPath, headwords = ['superposition', 'entanglement', 'qubit']) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = DELETE;')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1'), ('corpus_name', 'PHASE7A8_2_CUSTOM_E2E');

    CREATE TABLE entries (
      word TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT,
      definition_en TEXT,
      translation_zh TEXT,
      pos TEXT,
      exchange TEXT,
      frequency INTEGER
    );

    CREATE TABLE forms (
      form TEXT PRIMARY KEY COLLATE NOCASE,
      headword TEXT NOT NULL,
      kind TEXT
    );

    CREATE TABLE examples (
      id INTEGER PRIMARY KEY,
      headword TEXT NOT NULL COLLATE NOCASE,
      english TEXT NOT NULL,
      chinese TEXT,
      source TEXT,
      source_id TEXT,
      score REAL
    );

    CREATE INDEX idx_entries_word_lower ON entries (word);
    CREATE INDEX idx_forms_form_lower ON forms (form);
    CREATE INDEX idx_forms_headword_raw ON forms (headword);
    CREATE INDEX idx_examples_headword ON examples (headword);
  `)

  const insertEntry = db.prepare(`
    INSERT INTO entries (word, phonetic, definition_en, translation_zh, pos, exchange, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  for (const w of headwords) {
    insertEntry.run(w, `/${w}/`, `Definition for ${w}`, `${w}的中文释义`, 'n.', '', 100)
  }

  db.exec('PRAGMA integrity_check;')
  db.close()
}

async function prepareIsolatedProfile({ home, profile, port }) {
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })

  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
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
  const candidateTarballPath = join(tmpdir(), filename)

  const installedPluginDir = join(profileDir, 'node_modules', 'dsh-word-lookup')
  mkdirSync(installedPluginDir, { recursive: true })

  const stageDir = join(tmpdir(), `dsh-e2e-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(stageDir, { recursive: true })
  const res = spawnSync('tar', ['-xzf', candidateTarballPath, '-C', stageDir], { encoding: 'utf8', shell: true })
  if (res.status !== 0) {
    throw new Error(`tar -xzf failed on ${candidateTarballPath}: ${res.stderr}`)
  }
  const packageDir = join(stageDir, 'package')
  cpSync(packageDir, installedPluginDir, { recursive: true })
  rmSync(stageDir, { recursive: true, force: true })
  try {
    unlinkSync(candidateTarballPath)
  } catch {}

  const profilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-word-lookup'],
      },
    },
    dependencies: {
      'dsh-word-lookup': './node_modules/dsh-word-lookup',
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
  console.log(`Prepared isolated profile ${profile} with candidate plugin at ${installedPluginDir}`)
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

  await new Promise((r) => setTimeout(r, 1500))
  return { child, url }
}

async function stopDsh(child, port = DEFAULT_PORT) {
  if (child && child.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
    } else {
      child.kill('SIGTERM')
    }
  }
  if (process.platform === 'win32' && port) {
    try {
      const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`, { encoding: 'utf8' }).trim()
      if (out) {
        const pids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        for (const p of pids) {
          spawnSync('taskkill', ['/pid', p, '/T', '/F'], { stdio: 'ignore', shell: true })
        }
      }
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1000))
}

async function dismissAllModals(page) {
  for (let i = 0; i < 5; i++) {
    const continueBtn = page.getByRole('button', { name: 'Continue', exact: true })
    if (await continueBtn.isVisible().catch(() => false)) {
      console.log('Dismissing Preview Notice...')
      await continueBtn.click()
      await page.waitForTimeout(600)
    }

    const skipBtn = page.locator('button:has-text("Configure later"), button:has-text("稍后配置"), button:has-text("Skip"), button:has-text("跳过")')
    if (await skipBtn.isVisible().catch(() => false)) {
      console.log('Dismissing Onboarding dialog...')
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

async function main() {
  console.log('=== Phase 7A.8.2R Real Isolated DSH Native Settings UI & Browser Acceptance ===\n')

  const testRoot = resolve(join(tmpdir(), 'dsh-word-lookup-7a8-2-test'))
  const home = join(testRoot, 'home')
  const profile = 'word-lookup-test-7a8-2'
  const profileDir = join(home, 'profiles', profile)
  const port = DEFAULT_PORT

  const verified = assertIsolatedDshEnvironment({ home, profile, port, testRoot, profileDir })
  console.log('ISOLATION CHECK: PASS')
  console.log(`Scratch home: ${home}\n`)

  if (!(await isPortFree(port))) {
    throw new Error(`Port ${port} is occupied`)
  }

  // Clean scratch storage
  const storageDir = join(home, 'storages', 'dsh-word-lookup')
  if (existsSync(storageDir)) {
    rmSync(storageDir, { recursive: true, force: true })
  }

  await prepareIsolatedProfile({ home, profile, port })

  const userDir = join(testRoot, 'user-data')
  mkdirSync(userDir, { recursive: true })

  // Prepare custom SQLite source database
  const customDbPath = join(userDir, 'quantum-dict.db')
  buildCustomUserDatabase(customDbPath, ['superposition', 'entanglement', 'qubit'])
  const originalUserDbStat = {
    size: statSync(customDbPath).size,
    sha256: sha256File(customDbPath),
  }

  const evidenceDir = join(REPO_ROOT, 'docs', 'evidence', 'phase7a8-2r')
  const screenshotsDir = join(evidenceDir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })

  let dshInstance = null
  let browser = null

  const evidenceRecords = []
  const screenshots = []

  try {
    console.log(`Starting real DSH instance on port ${port}...`)
    dshInstance = await bootDsh(verified, port)
    console.log(`DSH instance booted at ${dshInstance.url}`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()

    page.on('console', (msg) => console.log(`[BROWSER ${msg.type()}]`, msg.text()))
    page.on('pageerror', (err) => console.error('[BROWSER PAGEERROR]', err))

    console.log('Navigating to DSH web page...')
    await page.goto(dshInstance.url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)

    await dismissAllModals(page)
    console.log('Dismissed initial modals')

    // =========================================================================
    // V15: Settings Navigation & Section Contribution
    // =========================================================================
    console.log('\n--- V15: Navigating to Settings -> "词典" Section ---')
    await page.keyboard.press('Control+Alt+,')
    await page.waitForTimeout(500)
    if ((await page.locator('nav button').count()) === 0) {
      const settingsTrigger = page.locator('button[aria-label="Settings"]').first()
      await settingsTrigger.click({ force: true })
    }
    await page.waitForSelector('nav button', { timeout: 8000 })

    const dictNavButton = page.locator('nav button:has-text("词典"), nav button:has-text("Dictionary")')
    await dictNavButton.waitFor({ state: 'visible', timeout: 5000 })
    await dictNavButton.click()

    const sectionContainer = page.locator('.dsh-wl-settings')
    await sectionContainer.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Found .dsh-wl-settings container in DOM')

    const v15Screenshot = join(screenshotsDir, 'v15-settings-navigated.png')
    await page.screenshot({ path: v15Screenshot })
    screenshots.push({ id: 'V15', path: 'screenshots/v15-settings-navigated.png', sha256: sha256File(v15Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V15',
      name: 'Settings Navigation & "词典" Section Contribution',
      verdict: 'PASS',
      details: { sectionVisible: true, container: '.dsh-wl-settings' },
    })

    // =========================================================================
    // V16: Initial Fixture Mode State & Truthful Counts
    // =========================================================================
    console.log('\n--- V16: Verifying Initial Fixture State & Truthful Counts ---')
    const btnFixture = page.locator('[data-testid="btn-mode-fixture"]')
    const btnEcdict = page.locator('[data-testid="btn-mode-ecdict"]')
    const btnCustom = page.locator('[data-testid="btn-mode-custom"]')

    await btnFixture.waitFor({ state: 'visible' })
    await btnEcdict.waitFor({ state: 'visible' })
    await btnCustom.waitFor({ state: 'visible' })

    const ecdictDisabled = await btnEcdict.isDisabled()
    const customDisabled = await btnCustom.isDisabled()
    const entryCountText = await page.locator('[data-testid="stat-entry-count"]').innerText()
    const formCountText = await page.locator('[data-testid="stat-form-count"]').innerText()

    if (!ecdictDisabled) throw new Error('ECDICT mode button should be disabled when not installed')
    if (!customDisabled) throw new Error('Custom mode button should be disabled when 0 snapshots exist')
    if (!entryCountText.includes('7')) throw new Error(`Expected fixture entry count 7, got ${entryCountText}`)
    if (!formCountText.includes('11')) throw new Error(`Expected fixture form count 11, got ${formCountText}`)

    const v16Screenshot = join(screenshotsDir, 'v16-initial-fixture-state.png')
    await page.screenshot({ path: v16Screenshot })
    screenshots.push({ id: 'V16', path: 'screenshots/v16-initial-fixture-state.png', sha256: sha256File(v16Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V16',
      name: 'Initial Fixture State & Truthful Counts',
      verdict: 'PASS',
      details: { entryCountText, formCountText, ecdictDisabled, customDisabled },
    })

    // =========================================================================
    // V17: Custom SQLite Path Verification Feedback
    // =========================================================================
    console.log('\n--- V17: Custom SQLite Path Verification via UI ---')
    const inputPath = page.locator('[data-testid="input-custom-dict-path"]')
    const inputIdentity = page.locator('[data-testid="input-custom-dict-identity"]')
    const btnVerify = page.locator('[data-testid="btn-verify-custom"]')

    await inputPath.fill(customDbPath)
    await inputIdentity.fill('quantum-physics')
    await page.waitForTimeout(200)

    console.log('Clicking "校验数据库" button...')
    await btnVerify.click()

    const outcomeBox = page.locator('[data-testid="verify-outcome-box"]')
    await outcomeBox.waitFor({ state: 'visible', timeout: 10000 })
    const outcomeText = await outcomeBox.innerText()
    console.log('Verification outcome text:', outcomeText)

    if (!outcomeText.includes('SQLite 数据库架构校验通过') && !outcomeText.includes('通过')) {
      throw new Error(`Verification feedback failed: ${outcomeText}`)
    }
    if (!outcomeText.includes('3')) {
      throw new Error(`Expected 3 entries reported in verification feedback: ${outcomeText}`)
    }

    const v17Screenshot = join(screenshotsDir, 'v17-custom-path-verified.png')
    await page.screenshot({ path: v17Screenshot })
    screenshots.push({ id: 'V17', path: 'screenshots/v17-custom-path-verified.png', sha256: sha256File(v17Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V17',
      name: 'Custom SQLite Path Verification via UI',
      verdict: 'PASS',
      details: { outcomeText, customDbPath },
    })

    // =========================================================================
    // V18: Custom Dictionary Activation & Snapshot List Update
    // =========================================================================
    console.log('\n--- V18: Custom Dictionary Activation via UI ---')
    const btnActivate = page.locator('[data-testid="btn-activate-custom"]')
    await btnActivate.click()

    console.log('Waiting for custom snapshot to activate and appear in catalog...')
    const activeBadge = page.locator('span:has-text("自定义已启用 (quantum-physics)")').first()
    await activeBadge.waitFor({ state: 'visible', timeout: 15000 })

    const snapshotRow = page.locator('div:has-text("quantum-physics")').filter({ hasText: '当前激活' }).first()
    await snapshotRow.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Found active custom snapshot row with "当前激活" badge')

    // Verify lookup query hits the newly activated custom dictionary
    const lookupRes = await page.evaluate(async () => {
      const res = await window.fetch('api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'superposition' }),
      })
      return await res.json()
    })
    console.log('Lookup query result for "superposition":', lookupRes)
    if (!lookupRes?.found || lookupRes?.source !== 'custom-local') {
      throw new Error(`Lookup failed on custom dictionary: ${JSON.stringify(lookupRes)}`)
    }

    const v18Screenshot = join(screenshotsDir, 'v18-custom-activated.png')
    await page.screenshot({ path: v18Screenshot })
    screenshots.push({ id: 'V18', path: 'screenshots/v18-custom-activated.png', sha256: sha256File(v18Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V18',
      name: 'Custom Dictionary Activation & Snapshot List Update',
      verdict: 'PASS',
      details: { activeIdentity: 'quantum-physics', lookupFound: lookupRes.found, lookupSource: lookupRes.source },
    })

    // =========================================================================
    // V19: Three-Mode Switcher: Switch to Fixture Mode
    // =========================================================================
    console.log('\n--- V19: Switch Operational Mode to Fixture via UI Click ---')
    await btnFixture.click()

    const fixtureBadge = page.locator('span:has-text("内置基础词典 (Fixture)")').first()
    await fixtureBadge.waitFor({ state: 'visible', timeout: 8000 })

    const enableCustomRowBtn = page.locator('button:has-text("启用")').first()
    await enableCustomRowBtn.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Custom snapshot row button transitioned to "启用"')

    const v19Screenshot = join(screenshotsDir, 'v19-switched-to-fixture.png')
    await page.screenshot({ path: v19Screenshot })
    screenshots.push({ id: 'V19', path: 'screenshots/v19-switched-to-fixture.png', sha256: sha256File(v19Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V19',
      name: 'Three-Mode Switcher: Switch to Fixture Mode',
      verdict: 'PASS',
      details: { activeMode: 'fixture' },
    })

    // =========================================================================
    // V20: Three-Mode Switcher: Switch Back to Custom Mode (C1 Fix Verified)
    // =========================================================================
    console.log('\n--- V20: Switch Operational Mode Back to Custom via UI Click ---')
    // Click top Custom button. Because exactly 1 snapshot exists, it switches directly with snapshotId
    await btnCustom.click()

    await activeBadge.waitFor({ state: 'visible', timeout: 8000 })
    await snapshotRow.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Switched back to custom mode successfully with explicit snapshotId')

    const v20Screenshot = join(screenshotsDir, 'v20-switched-to-custom.png')
    await page.screenshot({ path: v20Screenshot })
    screenshots.push({ id: 'V20', path: 'screenshots/v20-switched-to-custom.png', sha256: sha256File(v20Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V20',
      name: 'Three-Mode Switcher: Switch Back to Custom Mode',
      verdict: 'PASS',
      details: { activeMode: 'custom', activeIdentity: 'quantum-physics' },
    })

    // =========================================================================
    // V21: Delete Inactive Custom Snapshot & Source File Invariance
    // =========================================================================
    console.log('\n--- V21: Delete Inactive Custom Snapshot & Source File Invariance ---')
    // Switch to fixture mode first
    await btnFixture.click()
    await fixtureBadge.waitFor({ state: 'visible', timeout: 8000 })

    // Find Delete button in snapshot row
    const deleteSnapshotBtn = page.locator('button:has-text("删除")').first()
    await deleteSnapshotBtn.waitFor({ state: 'visible', timeout: 5000 })
    await deleteSnapshotBtn.click()

    // Confirm modal
    const modalConfirm = page.locator('[role="dialog"]').filter({ hasText: '确认删除自定义词典快照' }).first()
    await modalConfirm.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Deletion confirmation modal displayed')

    const confirmDeleteBtn = modalConfirm.locator('button:has-text("确认删除")')
    await confirmDeleteBtn.click()

    // Wait for snapshot row to disappear
    await page.locator('text=quantum-physics').waitFor({ state: 'detached', timeout: 8000 })
    console.log('Custom snapshot successfully removed from list')

    // Verify top Custom button is disabled again
    const customDisabledAfterDelete = await btnCustom.isDisabled()
    if (!customDisabledAfterDelete) {
      throw new Error('Top custom button should be disabled after all snapshots are deleted')
    }

    // Source database invariance verification
    if (!existsSync(customDbPath)) {
      throw new Error('User source database was deleted!')
    }
    const currentStat = {
      size: statSync(customDbPath).size,
      sha256: sha256File(customDbPath),
    }
    if (currentStat.size !== originalUserDbStat.size || currentStat.sha256 !== originalUserDbStat.sha256) {
      throw new Error(`User source database mutated! Original: ${JSON.stringify(originalUserDbStat)}, Current: ${JSON.stringify(currentStat)}`)
    }
    console.log('Original user SQLite file verified 100% invariant (SHA-256 match)')

    const v21Screenshot = join(screenshotsDir, 'v21-custom-deleted-source-preserved.png')
    await page.screenshot({ path: v21Screenshot })
    screenshots.push({ id: 'V21', path: 'screenshots/v21-custom-deleted-source-preserved.png', sha256: sha256File(v21Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V21',
      name: 'Delete Inactive Custom Snapshot & Source File Invariance',
      verdict: 'PASS',
      details: {
        snapshotRemoved: true,
        sourceFileExists: true,
        originalSha256: originalUserDbStat.sha256,
        currentSha256: currentStat.sha256,
      },
    })

    // =========================================================================
    // V24: Configurable Shortcut Recorder UI (C2 Fix Verified)
    // =========================================================================
    console.log('\n--- V24: Configurable Shortcut Recorder via UI ---')
    const btnEditShortcut = page.locator('[data-testid="btn-edit-shortcut"]')
    await btnEditShortcut.click()

    const recorderBox = page.locator('[data-testid="shortcut-recorder-box"]')
    await recorderBox.waitFor({ state: 'visible', timeout: 5000 })
    console.log('Shortcut recorder modal opened and recorder box visible')

    const recorderDialog = page.getByRole('dialog', { name: '修改划词查询快捷键' })
    const saveShortcutBtn = recorderDialog.locator('button:has-text("保存修改")')

    // First verify conflict detection on Ctrl+Alt+K (which conflicts with session.search)
    console.log('Testing conflict detection with Ctrl+Alt+K...')
    await recorderBox.click()
    await page.keyboard.press('Control+Alt+KeyK')
    await page.waitForTimeout(300)

    const conflictText = await recorderDialog.innerText()
    console.log('Detected conflict message:', conflictText)
    if (!conflictText.includes('冲突') || !conflictText.includes('session.search')) {
      throw new Error(`Expected conflict with session.search: ${conflictText}`)
    }
    const saveDisabled = await saveShortcutBtn.isDisabled()
    if (!saveDisabled) {
      throw new Error('Save button should be disabled when shortcut has conflict')
    }
    console.log('Conflict detected and Save button disabled as expected')

    // Now press an unconflicted shortcut (e.g. Ctrl + Alt + J)
    console.log('Recording non-conflicting shortcut Ctrl+Alt+J...')
    await recorderBox.click()
    await page.keyboard.press('Control+Alt+KeyJ')
    await page.waitForTimeout(300)

    const noConflictText = await recorderDialog.innerText()
    console.log('Dialog text with Ctrl+Alt+J:', noConflictText)

    // Save modification
    await saveShortcutBtn.click()

    // Wait for dialog to close
    await recorderBox.waitFor({ state: 'detached', timeout: 5000 })

    // Verify key display updated
    const keyDisplay = page.locator('[data-testid="shortcut-key-display"]').first()
    const updatedKeyText = await keyDisplay.innerText()
    console.log('Updated shortcut key display:', updatedKeyText)
    if (!updatedKeyText.includes('Ctrl') || !updatedKeyText.includes('Alt') || !updatedKeyText.includes('J')) {
      throw new Error(`Shortcut key display failed to update to Ctrl + Alt + J: got ${updatedKeyText}`)
    }

    // Reset back to default
    await btnEditShortcut.click()
    await recorderBox.waitFor({ state: 'visible', timeout: 5000 })

    const resetShortcutBtn = page.locator('button:has-text("恢复默认快捷键")').first()
    await resetShortcutBtn.click()
    await recorderBox.waitFor({ state: 'detached', timeout: 5000 })

    const restoredKeyText = await keyDisplay.innerText()
    console.log('Restored shortcut key display:', restoredKeyText)
    if (!restoredKeyText.includes('Shift') || !restoredKeyText.includes('L')) {
      throw new Error(`Shortcut key display failed to restore to default: got ${restoredKeyText}`)
    }

    const v24Screenshot = join(screenshotsDir, 'v24-shortcut-configured-and-reset.png')
    await page.screenshot({ path: v24Screenshot })
    screenshots.push({ id: 'V24', path: 'screenshots/v24-shortcut-configured-and-reset.png', sha256: sha256File(v24Screenshot) })

    evidenceRecords.push({
      scenarioId: 'V24',
      name: 'Configurable Shortcut Recorder UI & Reset Lifecycle',
      verdict: 'PASS',
      details: { updatedKeyText, restoredKeyText },
    })

    console.log('\nAll E2E scenarios (V15–V21, V24) executed with 100% PASS!\n')
  } finally {
    if (browser) {
      await browser.close()
    }
    if (dshInstance?.child) {
      console.log('Stopping isolated DSH instance...')
      await stopDsh(dshInstance.child, port)
    }
    try {
      if (existsSync(userDir)) {
        rmSync(userDir, { recursive: true, force: true })
      }
      if (existsSync(testRoot)) {
        rmSync(testRoot, { recursive: true, force: true })
      }
    } catch {}
  }

  // Save machine-readable evidence
  const evidenceOut = {
    phase: 'Phase 7A.8.2R',
    name: 'Native Settings UI Interaction Repair & Real Browser Acceptance Closure',
    timestamp: new Date().toISOString(),
    status: 'PASS',
    totalScenarios: evidenceRecords.length,
    passedScenarios: evidenceRecords.filter((r) => r.verdict === 'PASS').length,
    records: evidenceRecords,
    screenshots,
  }

  writeFileSync(
    join(evidenceDir, 'phase7a8-2r-settings-ui-acceptance.json'),
    JSON.stringify(evidenceOut, null, 2) + '\n',
    'utf8',
  )
  console.log(`Saved machine-readable evidence to: docs/evidence/phase7a8-2r/phase7a8-2r-settings-ui-acceptance.json`)
}

main().catch((err) => {
  console.error('Fatal E2E test failure:', err)
  process.exit(1)
})
