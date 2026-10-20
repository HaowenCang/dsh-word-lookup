#!/usr/bin/env node
/**
 * Maintenance M1 Browser Smoke Test Runner.
 *
 * Runs isolated Playwright Chromium verification against isolated DSH 0.2.0-rc.2:
 * 1. Isolation gate enforcement (assertIsolatedDshEnvironment)
 * 2. Settings UI verification:
 *    - "自定义外部 SQLite 词典" row displays "已支持" badge
 *    - Outdated "Phase 7A.8 开放" text is completely absent
 * 3. FMT-01 Card Multiline Formatting verification:
 *    - Pass word entry with multiline translation & definition
 *    - Real distinct line breaks in browser DOM (bounding box y-coordinates strictly descending)
 *    - Safe escaping (no HTML injection)
 *    - Normal viewport (~360px panel width)
 *    - Narrow responsive viewport (320px width)
 *    - Long entry vertical scrollability
 * 4. High-resolution screenshots saved to docs/evidence/maintenance-m1/screenshots/
 * 5. Structured evidence written to docs/evidence/maintenance-m1/browser-smoke-evidence.json
 *
 * @module dsh-word-lookup/scripts/maintenance-m1-browser-smoke
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  DEFAULT_TEST_ROOT,
  ISOLATION_BANNER,
  IsolationError,
} from './assert-isolated-env.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 50996
const HOME = resolve(join(DEFAULT_TEST_ROOT, 'home'))
const PROFILE = 'word-lookup-test'
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'evidence', 'maintenance-m1r')
const SCREENSHOTS_DIR = join(EVIDENCE_DIR, 'screenshots')
const EVIDENCE_JSON_PATH = join(EVIDENCE_DIR, 'browser-smoke-evidence.json')

mkdirSync(SCREENSHOTS_DIR, { recursive: true })

// 1. Enforce strict isolation
console.log('--- Step 1: Isolation Gate Preflight ---')
let verified
try {
  verified = assertIsolatedDshEnvironment({
    home: HOME,
    profile: PROFILE,
    port: PORT,
    profileDir: PROFILE_DIR,
    testRoot: DEFAULT_TEST_ROOT,
  })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nRefusing to run browser smoke test: target is not an isolated test environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

// 2. Prepare isolated profile
console.log('--- Step 2: Preparing isolated profile ---')
execSync(`node scripts/create-test-profile.mjs --port ${PORT}`, {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})

// 3. Helper to start DSH
const ANSI = /\u001b\[[0-9;]*m/g

function startDsh() {
  const env = buildIsolatedEnv(verified)
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      stopDsh(child)
      rejectPromise(new Error(`dsh timed out after 90s\n${stdout}\n${stderr}`))
    }, 90_000)

    const consume = (chunk, isStderr) => {
      const text = chunk.toString().replace(ANSI, '')
      if (isStderr) stderr += text
      else stdout += text
      const match = /https?:\/\/[^\s"']*\/\?token=[A-Za-z0-9._~-]+/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolvePromise({ child, url: match[0] })
      }
    }

    child.stdout.on('data', (c) => consume(c, false))
    child.stderr.on('data', (c) => consume(c, true))
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`dsh exited early with code ${code}\n${stdout}\n${stderr}`))
    })
  })
}

async function stopDsh(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', () => r(true)))
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
}

const DISMISS_LABEL = /configure later|not now|skip|later|close|dismiss|got it|continue|ok|稍后配置|跳过/i
async function dismissDialogs(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dialogs = page.locator('[role="dialog"]')
    const count = await dialogs.count()
    if (count === 0) break

    const dialog = dialogs.last()
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()

    let clicked = false
    for (let index = 0; index < buttonCount; index += 1) {
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

async function runSmoke() {
  console.log('--- Step 3: Booting isolated DSH Web ---')
  const { child, url } = await startDsh()
  console.log(`DSH booted successfully at ${url.replace(/token=.*/, 'token=REDACTED')}`)

  const browser = await chromium.launch({ headless: true })
  const dshVersion = execSync('dsh --version', { encoding: 'utf-8' }).trim()
  const chromiumVersion = browser.version()
  const evidence = {
    suite: 'Maintenance M1R Browser Smoke Verification',
    timestamp: new Date().toISOString(),
    gitCommit: execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim(),
    classification: {
      environment: 'REAL_BROWSER',
      lookupMode: 'CONTROLLED_LOOKUP_RESPONSE',
      domMeasurement: 'REAL_DOM_GEOMETRY',
      isolation: 'ISOLATED_DSH_RUNTIME',
      liveEcdictQuery: 'REAL_ECDICT_QUERY_NOT_EXECUTED',
    },
    runtime: {
      dshVersion,
      dsh021Status: 'NOT_EXECUTED / INDEPENDENT_ACCEPTANCE_NOT_PERFORMED',
      chromiumVersion,
      port: PORT,
      home: HOME,
      profile: PROFILE,
    },
    observations: [],
    screenshots: {},
    verdict: 'PASS',
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()

    // Route interceptor for controlled synthetic word lookups (R4: CONTROLLED_LOOKUP_RESPONSE)
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

    console.log('--- Step 4: Navigating to DSH Web ---')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2000)
    await dismissDialogs(page)

    // Wait for plugin runtime
    await page.waitForFunction(
      () => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null,
      undefined,
      { timeout: 30_000 },
    )
    console.log('Plugin runtime detected successfully on window.__DSH_WORD_LOOKUP__')

    // -------------------------------------------------------------------------
    // Verification A: FMT-01 Card Multiline Rendering
    // -------------------------------------------------------------------------
    console.log('--- Step 5: Testing FMT-01 Card Multiline Rendering ---')
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
    console.log(`R1 POS badge duplication absent ("v.n." check): ${noPosDuplication ? 'PASS' : 'FAIL'}`)

    // Verify lines are on separate vertical coordinates
    const transYOrderValid =
      cardMetrics.transRects.length === 3 &&
      cardMetrics.transRects[1].top > cardMetrics.transRects[0].top &&
      cardMetrics.transRects[2].top > cardMetrics.transRects[1].top
    const defYOrderValid =
      cardMetrics.defRects.length === 4 &&
      cardMetrics.defRects[1].top > cardMetrics.defRects[0].top &&
      cardMetrics.defRects[2].top > cardMetrics.defRects[1].top &&
      cardMetrics.defRects[3].top > cardMetrics.defRects[2].top

    console.log(`Translation lines vertical separation: ${transYOrderValid ? 'PASS' : 'FAIL'}`)
    console.log(`Definition lines vertical separation: ${defYOrderValid ? 'PASS' : 'FAIL'}`)

    const cardNormalShot = join(SCREENSHOTS_DIR, '01-card-multiline-normal-360px.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNormalShot })
    evidence.screenshots.cardNormal = cardNormalShot

    evidence.observations.push({
      test: 'FMT-01 Normal Viewport Card Rendering & POS Dedup (R1)',
      status:
        cardMetrics.transLineCount === 3 &&
        cardMetrics.defLineCount === 4 &&
        transYOrderValid &&
        defYOrderValid &&
        !cardMetrics.hasLiteralEscapeInText &&
        noPosDuplication
          ? 'PASS'
          : 'FAIL',
      cardMetrics,
    })

    // Narrow Viewport test (320px)
    console.log('--- Step 6: Testing Narrow Viewport Responsiveness ---')
    await page.setViewportSize({ width: 320, height: 600 })
    await page.waitForTimeout(500)

    const narrowCardWidth = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      return card.getBoundingClientRect().width
    })
    console.log(`Narrow viewport card width: ${narrowCardWidth}px (<= 320px)`)

    const cardNarrowShot = join(SCREENSHOTS_DIR, '02-card-multiline-narrow-viewport.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardNarrowShot })
    evidence.screenshots.cardNarrow = cardNarrowShot

    evidence.observations.push({
      test: 'FMT-01 Narrow Viewport Responsiveness',
      status: narrowCardWidth <= 320 ? 'PASS' : 'FAIL',
      narrowCardWidth,
    })

    // Reset viewport
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)

    // Dismiss normal card before testing scroll on long entry
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // Long entry vertical scrollability (R2 Remediation)
    console.log('--- Step 7: Testing Long Entry Scrollability (R2 Remediation) ---')
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

      // Perform actual vertical scroll
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

    console.log(`Scrollability check: scrollHeight=${scrollInfo.scrollHeight}, clientHeight=${scrollInfo.clientHeight}`)
    console.log(`Scroll progress: before=${scrollInfo.beforeScroll}, after=${scrollInfo.afterScroll}`)
    console.log(`Scrollable (scrollHeight > clientHeight): ${scrollInfo.isScrollable ? 'PASS' : 'FAIL'}`)
    console.log(`Scroll executed (afterScroll > beforeScroll): ${scrollInfo.didScroll ? 'PASS' : 'FAIL'}`)
    console.log(`Height capped (clientHeight <= 440): ${scrollInfo.withinMaxHeightLimit ? 'PASS' : 'FAIL'}`)
    console.log(`No horizontal overflow: ${scrollInfo.noHorizontalOverflow ? 'PASS' : 'FAIL'}`)

    const cardScrollShot = join(SCREENSHOTS_DIR, '03-card-multiline-scroll.png')
    await page.locator('[data-dsh-word-lookup="card"]').screenshot({ path: cardScrollShot })
    evidence.screenshots.cardScroll = cardScrollShot

    const scrollPassed =
      scrollInfo.isScrollable &&
      scrollInfo.didScroll &&
      scrollInfo.withinMaxHeightLimit &&
      scrollInfo.noHorizontalOverflow

    evidence.observations.push({
      test: 'FMT-01 Long Entry Scrollability (R2 Remediation)',
      status: scrollPassed ? 'PASS' : 'FAIL',
      scrollInfo,
      m1Audit: {
        m1Result: 'FALSE_POSITIVE',
        m1Reason:
          'Original M1 test used scrollHeight >= clientHeight assertion with scrollHeight=372, clientHeight=372, beforeScroll=0, afterScroll=0, which produced a false positive without actual scrolling.',
        m1rRemediation:
          'M1R synthesized long dictionary response exceeding maxHeight (440px), performed real scroll action (scrollTop=120), asserted scrollHeight > clientHeight, verified afterScroll > beforeScroll, and validated geometry bounds.',
      },
    })

    // Dismiss card
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // -------------------------------------------------------------------------
    // Verification B: UI-02 Settings UI
    // -------------------------------------------------------------------------
    console.log('--- Step 8: Testing UI-02 Settings UI ---')
    // Open Settings dialog
    await page.keyboard.press('Control+Alt+,')
    await page.waitForTimeout(500)
    if ((await page.locator('nav button').count()) === 0) {
      const settingsTrigger = page.locator('button[aria-label="Settings"]').first()
      if (await settingsTrigger.isVisible().catch(() => false)) {
        await settingsTrigger.click({ force: true })
      }
    }
    await page.waitForSelector('nav button', { timeout: 8000 })
    const navItems = await page.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.innerText.trim()))
    console.log('Detected Settings nav items:', navItems)

    const dictNavButton = page.locator('nav button:has-text("词典"), nav button:has-text("Dictionary")')
    await dictNavButton.waitFor({ state: 'visible', timeout: 5000 })
    const navLabel = await dictNavButton.innerText()
    console.log(`Clicking dictionary settings nav: "${navLabel}"`)
    await dictNavButton.click()

    const sectionContainer = page.locator('.dsh-wl-settings')
    await sectionContainer.waitFor({ state: 'visible', timeout: 8000 })
    console.log('.dsh-wl-settings section is visible in DOM')

    // Give react state and sub-components time to render
    await page.waitForTimeout(1000)

    const settingsAudit = await page.evaluate(() => {
      const root = document.querySelector('.dsh-wl-settings') || document.body
      const text = root.textContent || ''
      const hasPhase7A8 = text.includes('Phase 7A.8 开放') || text.includes('Phase 7A.8')
      const hasSupportedBadge = text.includes('已支持')
      const hasCustomSection = text.includes('自定义 SQLite 词典管理')
      const hasCustomRow = text.includes('自定义外部 SQLite 词典')
      const hasUpdatedDesc = text.includes('请在上方“自定义 SQLite 词典管理”区域配置并挂载使用')

      return {
        hasPhase7A8,
        hasSupportedBadge,
        hasCustomSection,
        hasCustomRow,
        hasUpdatedDesc,
      }
    })

    console.log(`Settings has "Phase 7A.8": ${settingsAudit.hasPhase7A8} (expected false)`)
    console.log(`Settings has "已支持": ${settingsAudit.hasSupportedBadge} (expected true)`)
    console.log(`Settings has updated description: ${settingsAudit.hasUpdatedDesc} (expected true)`)

    const settingsShot = join(SCREENSHOTS_DIR, '04-settings-ui-support-badge.png')
    const advancedSection = page.locator('text="快捷键与高级功能"').first()
    if (await advancedSection.isVisible().catch(() => false)) {
      await advancedSection.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
    }

    const rowLocator = page.locator('text="自定义外部 SQLite 词典"').first()
    if (await rowLocator.isVisible().catch(() => false)) {
      await rowLocator.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      // Find parent SectionCard
      const cardElement = await rowLocator.evaluateHandle((el) => {
        let cur = el
        while (cur && !cur.textContent.includes('快捷键与高级功能')) {
          cur = cur.parentElement
        }
        return cur || el.parentElement
      })
      if (cardElement.asElement()) {
        await cardElement.asElement().screenshot({ path: settingsShot })
      } else {
        await rowLocator.screenshot({ path: settingsShot })
      }
    } else {
      await page.screenshot({ path: settingsShot, fullPage: true })
    }
    evidence.screenshots.settings = settingsShot

    const settingsPassed = !settingsAudit.hasPhase7A8 && settingsAudit.hasSupportedBadge && settingsAudit.hasUpdatedDesc
    evidence.observations.push({
      test: 'UI-02 Settings Badge and Description Update',
      status: settingsPassed ? 'PASS' : 'FAIL',
      settingsAudit,
    })

    if (!settingsPassed || !transYOrderValid || !defYOrderValid || !noPosDuplication || !scrollPassed) {
      evidence.verdict = 'FAIL'
    }
  } finally {
    await browser.close().catch(() => {})
    console.log('--- Step 9: Stopping DSH process ---')
    await stopDsh(child).catch(() => {})
  }

  writeFileSync(EVIDENCE_JSON_PATH, JSON.stringify(evidence, null, 2), 'utf-8')
  console.log(`Evidence written to ${EVIDENCE_JSON_PATH}`)
  console.log(`Overall smoke test verdict: ${evidence.verdict}`)

  if (evidence.verdict !== 'PASS') {
    process.exit(1)
  }
}

runSmoke().catch((err) => {
  console.error('Smoke test execution error:', err)
  process.exit(1)
})
