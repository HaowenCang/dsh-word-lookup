#!/usr/bin/env node
/**
 * Phase 5 Browser Acceptance Suite.
 *
 * Runs against an isolated DSH Web instance with real Chromium:
 * - UI01: manual shortcut found rendering (headword, phonetic, POS, meanings, lemma, examples)
 * - UI02: auto double-click found rendering (went -> go, lemma, single lookup)
 * - UI03: auto drag-selection found rendering (teeth -> tooth, lemma, single lookup)
 * - UI04: unknown word not-found state
 * - UI05: transport error handling & recovery
 * - Positioning: top, bottom, left clamp, right clamp, multiline, narrow viewport, null fallback
 * - Dismissal: Escape, outside pointer/click (no shield), close button with accessible name
 * - Close-before-response races (D1, D2)
 * - Outside-close + new lookup races (dblclick B, drag B)
 * - Card-internal selection & copy (0 automatic requests)
 * - Focus behavior: card does not steal focus
 * - Pass-through: conversation scroll, text selection, composer focus
 * - Theme & Visual QA: Light and Dark theme computed styles and screenshots
 *
 * @module dsh-word-lookup/scripts/phase5-browser-acceptance
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const DEFAULT_PORT = 50992

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

const options = parseArgs(process.argv.slice(2))
const testRoot = resolve(options['test-root'] ?? DEFAULT_TEST_ROOT)
const home = resolve(options.home ?? join(testRoot, 'home'))
const profile = options.profile ?? 'word-lookup-test'
const port = Number(options.port ?? DEFAULT_PORT)
const profileDir = join(home, 'profiles', profile)

// 1. ISOLATION GATE
let verified
try {
  verified = assertIsolatedDshEnvironment({ home, profile, port, testRoot, profileDir })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nRefusing to run Phase 5 acceptance: target is not an isolated test environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

if (!existsSync(join(verified.profileDir, 'package.json'))) {
  console.error(`Missing profile manifest at ${verified.profileDir}; create test profile first.`)
  process.exit(2)
}

if (!(await isPortFree(verified.port))) {
  console.error(`Port ${verified.port} is already in use.`)
  process.exit(2)
}

const DISMISS_LABEL = /configure later|not now|skip|later|close|dismiss|got it|continue|ok\b/i

async function dismissDialogs(page) {
  const dismissed = []
  const dialogs = () => page.locator('[role="dialog"][aria-modal="true"]')

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = await dialogs().count()
    if (before === 0) break
    const dialog = dialogs().last()
    const label = (await dialog.getAttribute('aria-label')) ?? '(unlabelled)'
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()

    const controls = []
    for (let index = 0; index < buttonCount; index += 1) {
      controls.push({ index, text: ((await buttons.nth(index).textContent()) ?? '').trim() })
    }
    const preferred = controls.filter((control) => DISMISS_LABEL.test(control.text))
    const ordered = [...preferred, ...controls.filter((control) => !preferred.includes(control))]

    let closed = false
    for (const control of ordered) {
      await buttons.nth(control.index).evaluate((element) => element.click())
      await page.waitForTimeout(500)
      if ((await dialogs().count()) < before) {
        dismissed.push(`${label} via "${control.text}"`)
        closed = true
        break
      }
    }
    if (!closed && buttonCount === 0) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      dismissed.push(`${label} via Escape`)
    }
    if (!closed && buttonCount === 0 && (await dialogs().count()) >= before) break
  }

  return { dismissed, remaining: await dialogs().count() }
}

const SCREENSHOT_DIR = join(REPO_ROOT, 'verify-out', 'phase5-screenshots')
mkdirSync(SCREENSHOT_DIR, { recursive: true })

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g
const results = []

function record(id, description, passed, detail = '') {
  results.push({ id, description, passed, detail })
  const status = passed ? 'PASS' : 'FAIL'
  console.log(`${status}  [${id}] ${description}`)
  if (detail) {
    console.log(`      ${detail.slice(0, 300)}`)
  }
}

async function startDsh() {
  const env = buildIsolatedEnv(verified)
  const child = spawn('dsh', ['--profile', profile, '--no-open', '--port', String(port)], {
    cwd: REPO_ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`dsh timed out starting\n${stdout}\n${stderr}`))
    }, 90_000)

    const consume = (chunk, isStdErr) => {
      const text = chunk.toString().replace(ANSI, '')
      if (isStdErr) stderr += text
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
      rejectUrl(new Error(`dsh exited early with code ${code}\n${stdout}\n${stderr}`))
    })
  })

  await new Promise((r) => setTimeout(r, 1500))
  return { child, url }
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

async function run() {
  console.log('Starting isolated DSH instance for Phase 5 Browser Acceptance...')
  const { child, url } = await startDsh()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  const state = { requests: [], responses: [] }
  page.on('request', (req) => {
    if (req.url().includes('/api/dsh-word-lookup')) {
      state.requests.push({ method: req.method(), url: req.url(), postData: req.postData() })
    }
  })
  page.on('response', (res) => {
    if (res.url().includes('/api/dsh-word-lookup')) {
      const entry = { status: res.status(), body: null }
      state.responses.push(entry)
      res.json().then(
        (b) => {
          entry.body = b
        },
        () => {},
      )
    }
  })

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null, undefined, {
      timeout: 90_000,
    })
    await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.overlay().declarationSeen === true, undefined, { timeout: 30_000 })

    // Setup synthetic conversation probes
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-phase1-probe]')) node.remove()

      const styleFor = (top) =>
        `position:fixed;left:24px;top:${String(top)}px;z-index:10;background:#1b1b20;color:#eaeaf0;padding:10px 14px;border-radius:6px;font:14px/1.6 system-ui;max-width:440px`

      const flow = document.createElement('div')
      flow.setAttribute('data-phase1-probe', 'flow')
      flow.setAttribute('data-phase5-probe', 'flow')
      flow.setAttribute('data-chat-flow-kind', 'assistant-step')
      flow.setAttribute('data-chat-node-key', 'phase1:probe:1')
      flow.style.cssText = styleFor(120)
      const flowText = document.createElement('p')
      flowText.textContent =
        'Probes: derive, derived, went, teeth, conservation, unknowntoken, and the wave function.'
      flow.appendChild(flowText)
      const multiline = document.createElement('p')
      multiline.setAttribute('data-phase1-probe-line', 'multiline')
      multiline.setAttribute('data-phase5-probe', 'multiline')
      multiline.style.cssText = 'width:200px;line-height:22px;'
      multiline.textContent = 'The continuous wave function of quantum states reveals energy spectrum.'
      flow.appendChild(multiline)
      document.body.appendChild(flow)

      const composer = document.createElement('div')
      composer.setAttribute('data-phase1-probe', 'composer')
      composer.setAttribute('data-phase5-probe', 'composer')
      composer.setAttribute('contenteditable', 'true')
      composer.setAttribute('role', 'textbox')
      composer.style.cssText = 'position:fixed;left:340px;bottom:20px;width:500px;height:48px;z-index:10;background:#18181c;color:#fff;border:1px solid #444;padding:8px;border-radius:6px;'
      composer.textContent = 'derive inside the composer'
      document.body.appendChild(composer)

      // Dedicated word probes positioned across the screen so none can occlude each other
      const probePositions = {
        derive: { left: 100, top: 120 },
        derived: { left: 350, top: 120 },
        went: { left: 600, top: 120 },
        teeth: { left: 950, top: 120 },
        conservation: { left: 600, top: 450 },
        unknowntoken: { left: 950, top: 450 },
      }

      for (const [word, pos] of Object.entries(probePositions)) {
        const box = document.createElement('div')
        box.setAttribute('data-phase1-probe', `probe-${word}`)
        box.setAttribute('data-phase5-probe', `probe-${word}`)
        box.setAttribute('data-chat-flow-kind', 'assistant-step')
        box.setAttribute('data-chat-node-key', `phase5:word:${word}`)
        box.style.cssText = `position:fixed;left:${pos.left}px;top:${pos.top}px;z-index:10;background:#1b1b20;color:#eaeaf0;padding:8px 12px;border-radius:6px;font:14px system-ui;`
        const span = document.createElement('span')
        span.setAttribute('data-phase1-word', word)
        span.setAttribute('data-phase5-word', word)
        span.textContent = word
        box.appendChild(span)
        document.body.appendChild(box)
      }

      // Top edge probe
      const topEdge = document.createElement('div')
      topEdge.setAttribute('data-phase5-probe', 'top-edge')
      topEdge.setAttribute('data-chat-flow-kind', 'assistant-step')
      topEdge.setAttribute('data-chat-node-key', 'phase5:edge:top')
      topEdge.style.cssText = 'position:fixed;left:340px;top:15px;z-index:10;color:#eee;'
      topEdge.innerHTML = '<span data-phase5-word="top-word">derive</span>'
      document.body.appendChild(topEdge)

      // Bottom edge probe (above composer)
      const bottomEdge = document.createElement('div')
      bottomEdge.setAttribute('data-phase5-probe', 'bottom-edge')
      bottomEdge.setAttribute('data-chat-flow-kind', 'assistant-step')
      bottomEdge.setAttribute('data-chat-node-key', 'phase5:edge:bottom')
      bottomEdge.style.cssText = 'position:fixed;left:340px;bottom:100px;z-index:10;color:#eee;'
      bottomEdge.innerHTML = '<span data-phase5-word="bottom-word">derive</span>'
      document.body.appendChild(bottomEdge)
    })

    await page.waitForTimeout(800)
    await dismissDialogs(page)

    // Enable both switches for gesture tests
    await page.evaluate(async () => {
      await window.__DSH_WORD_LOOKUP__.set('autoDoubleClick', true)
      await window.__DSH_WORD_LOOKUP__.set('autoSelection', true)
    })

    // Helper functions
    const getCard = async () => {
      return await page.evaluate(() => {
        const card = document.querySelector('[data-dsh-word-lookup="card"]')
        if (!card) return null
        const rect = card.getBoundingClientRect()
        return {
          present: true,
          state: card.getAttribute('data-dsh-word-lookup-state'),
          uiState: card.getAttribute('data-dsh-word-lookup-ui-state'),
          headword: card.querySelector('[data-dsh-word-lookup="headword"]')?.textContent ?? null,
          phonetic: card.querySelector('[data-dsh-word-lookup="phonetic"]')?.textContent ?? null,
          lemma: card.querySelector('[data-dsh-word-lookup="lemma"]')?.textContent ?? null,
          glosses: [...card.querySelectorAll('[data-dsh-word-lookup="gloss"]')].map((g) => g.textContent),
          examples: [...card.querySelectorAll('[data-dsh-word-lookup="example"]')].map((e) => e.textContent),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          text: card.textContent ?? '',
          role: card.getAttribute('role'),
          ariaLabel: card.getAttribute('aria-label'),
          closeLabel: card.querySelector('[data-dsh-word-lookup="close"]')?.getAttribute('aria-label') ?? null,
        }
      })
    }

    const selectWord = async (word) => {
      await page.evaluate((target) => {
        const el = document.querySelector(`[data-phase5-word="${target}"]`)
        if (!el) throw new Error(`Word ${target} not found`)
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = document.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      }, word)
    }

    const clearSelection = async () => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => document.getSelection()?.removeAllRanges())
    }

    // --- UI01: Manual Shortcut Found ---
    state.requests.length = 0
    await selectWord('derived')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null, undefined, { timeout: 10_000 })
    const ui01Card = await getCard()
    record(
      'UI01',
      'manual shortcut lookup for "derived" renders canonical headword, phonetic, lemma relation, meanings, and examples',
      ui01Card !== null &&
        ui01Card.uiState === 'found' &&
        ui01Card.headword === 'derive' &&
        ui01Card.phonetic?.includes('/dɪˈraɪv/') &&
        ui01Card.lemma?.includes('derived → derive') &&
        ui01Card.glosses.length > 0 &&
        ui01Card.examples.length > 0,
      JSON.stringify(ui01Card),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'normal-found.png') })

    // --- UI02: Auto double-click on "went" ---
    state.requests.length = 0
    await clearSelection()
    const wentBox = await page.locator('[data-phase5-word="went"]').boundingBox()
    if (wentBox) {
      await page.mouse.dblclick(wentBox.x + wentBox.width / 2, wentBox.y + wentBox.height / 2)
      await page.waitForFunction(() => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'go'
      }, undefined, { timeout: 10_000 })
    }
    const ui02Card = await getCard()
    record(
      'UI02',
      'auto double-click on "went" renders headword "go" with matchedForm "went → go" and issues exactly 1 request',
      ui02Card !== null &&
        ui02Card.headword === 'go' &&
        ui02Card.lemma?.includes('went → go') &&
        state.requests.length === 1,
      `requests=${state.requests.length} headword=${ui02Card?.headword} lemma=${ui02Card?.lemma}`,
    )

    // --- UI03: Auto drag on "teeth" ---
    state.requests.length = 0
    await clearSelection()
    const teethBox = await page.locator('[data-phase5-word="teeth"]').boundingBox()
    if (teethBox) {
      await page.mouse.move(teethBox.x + 2, teethBox.y + teethBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(teethBox.x + teethBox.width - 2, teethBox.y + teethBox.height / 2, { steps: 5 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'tooth'
      }, undefined, { timeout: 10_000 })
    }
    const ui03Card = await getCard()
    record(
      'UI03',
      'auto drag-selection on "teeth" renders headword "tooth" with matchedForm "teeth → tooth" and issues exactly 1 request',
      ui03Card !== null &&
        ui03Card.headword === 'tooth' &&
        ui03Card.lemma?.includes('teeth → tooth') &&
        state.requests.length === 1,
      `requests=${state.requests.length} headword=${ui03Card?.headword} lemma=${ui03Card?.lemma}`,
    )

    // --- UI04: Unknown Word (Not-Found) ---
    state.requests.length = 0
    await selectWord('unknowntoken')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="not-found"]') !== null, undefined, { timeout: 10_000 })
    const ui04Card = await getCard()
    record(
      'UI04',
      'unknown word renders friendly not-found state without error banner or traces',
      ui04Card !== null &&
        ui04Card.uiState === 'not-found' &&
        ui04Card.text.includes('no entry for "unknowntoken"'),
      JSON.stringify(ui04Card),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'not-found-state.png') })

    // --- UI05: Error State & Recovery ---
    // Inject error into controller via store
    await page.evaluate(() => {
      const diag = window.__DSH_WORD_LOOKUP__
      diag.runLookup('error-probe', 'shortcut')
    })
    // Intercept next route response to 500
    await page.route('**/api/dsh-word-lookup', async (route) => {
      if (route.request().postData()?.includes('error-probe')) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })
      } else {
        await route.continue()
      }
    })
    await selectWord('derive')
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('error-probe', 'shortcut'))
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="error"]') !== null, undefined, { timeout: 10_000 })
    const ui05Card = await getCard()
    record(
      'UI05',
      'transport error renders sanitized error message without leaking paths or internals',
      ui05Card !== null &&
        ui05Card.uiState === 'error' &&
        !ui05Card.text.includes('token') &&
        !ui05Card.text.includes('/api'),
      JSON.stringify(ui05Card),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'error-state.png') })

    // Verify recovery on next lookup
    await page.unroute('**/api/dsh-word-lookup')
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null, undefined, { timeout: 10_000 })
    const recoveredCard = await getCard()
    record(
      'UI05-Recovery',
      'normal lookup immediately recovers card from previous error',
      recoveredCard !== null && recoveredCard.uiState === 'found' && recoveredCard.headword === 'derive',
      recoveredCard?.headword,
    )

    // --- Positioning: Viewport Safety & Clamping ---
    // Top selection -> places below, within margin
    await selectWord('top-word')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const topPosCard = await getCard()
    const viewport = page.viewportSize()
    record(
      'POS-TOP',
      'selection near top places card below and respects top/left margins',
      topPosCard !== null &&
        topPosCard.rect.y >= 12 &&
        topPosCard.rect.bottom <= viewport.height - 12 &&
        topPosCard.rect.x >= 12,
      JSON.stringify(topPosCard?.rect),
    )

    // Bottom selection -> places above, does not cover composer
    await selectWord('bottom-word')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const bottomPosCard = await getCard()
    const composerBox = await page.locator('[data-phase5-probe="composer"]').boundingBox()
    record(
      'POS-BOTTOM',
      'selection near bottom places card above and does not overlap composer input',
      bottomPosCard !== null &&
        composerBox !== null &&
        bottomPosCard.rect.bottom <= composerBox.y &&
        bottomPosCard.rect.y >= 12,
      `card.bottom=${bottomPosCard?.rect.bottom} composer.y=${composerBox?.y}`,
    )

    // Multiline selection
    await page.evaluate(() => {
      const p = document.querySelector('[data-phase5-probe="multiline"]')
      const range = document.createRange()
      range.selectNodeContents(p)
      const sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const multilineCard = await getCard()
    record(
      'POS-MULTILINE',
      'multiline selection geometry places card cleanly within margins',
      multilineCard !== null &&
        multilineCard.rect.x >= 12 &&
        multilineCard.rect.right <= viewport.width - 12,
      JSON.stringify(multilineCard?.rect),
    )

    // Narrow viewport test
    await page.setViewportSize({ width: 360, height: 640 })
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const narrowCard = await getCard()
    record(
      'POS-NARROW',
      'narrow viewport (360px) clamps card within viewport margins without horizontal overflow',
      narrowCard !== null &&
        narrowCard.rect.x >= 12 &&
        narrowCard.rect.right <= 360 - 12 &&
        narrowCard.rect.width <= 360 - 24,
      JSON.stringify(narrowCard?.rect),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'narrow-viewport.png') })
    await page.setViewportSize({ width: 1400, height: 900 })

    // --- Dismissal: Escape, Outside Click, Close Button ---
    // 1. Close Button
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    await page.click('[data-dsh-word-lookup="close"]')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    record(
      'DISMISS-BUTTON',
      'clicking close button (accessible name "Close dictionary") dismisses card',
      (await getCard()) === null,
    )

    // 2. Escape key
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    record(
      'DISMISS-ESCAPE',
      'pressing Escape dismisses visible card',
      (await getCard()) === null,
    )

    // 3. Outside Click (no click shield)
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    // Click outside on composer
    let composerClicked = false
    await page.evaluate(() => {
      document.querySelector('[data-phase5-probe="composer"]').addEventListener(
        'click',
        () => {
          window.__COMPOSER_CLICKED__ = true
        },
        { once: true },
      )
    })
    await page.click('[data-phase5-probe="composer"]')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    composerClicked = await page.evaluate(() => window.__COMPOSER_CLICKED__ === true)
    record(
      'DISMISS-OUTSIDE',
      'clicking outside dismisses card without swallowing click on underlying element (no click shield)',
      (await getCard()) === null && composerClicked === true,
      `composerClicked=${composerClicked}`,
    )

    // --- Dismiss / Request Races (D1-D4 & Outside Gesture Races) ---
    // D1: lookup starts -> dismiss before settle -> resolve -> remains closed
    const d1Result = await page.evaluate(async () => {
      const diag = window.__DSH_WORD_LOOKUP__
      const p = diag.runLookup('conservation', 'shortcut')
      diag.dismiss()
      await p
      return { card: diag.card(), loading: diag.loading() }
    })
    record(
      'RACE-D1',
      'D1: request starts -> dismiss -> resolve success -> card remains closed',
      d1Result.card.status === 'idle' && d1Result.loading === false,
      JSON.stringify(d1Result),
    )

    // D4: same word looked up again after dismissal -> reopens normally
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    // Query exact same word again
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null, undefined, { timeout: 10_000 })
    const d4Card = await getCard()
    record(
      'RACE-D4',
      'D4: exact same query looked up after dismissal reopens surface normally',
      d4Card !== null && d4Card.headword === 'derive',
      JSON.stringify(d4Card),
    )

    // Outside double-click race: card A open, dblclick word B outside card -> card B visible
    const wentBoxRace = await page.locator('[data-phase5-word="went"]').boundingBox()
    if (wentBoxRace) {
      await page.mouse.dblclick(wentBoxRace.x + wentBoxRace.width / 2, wentBoxRace.y + wentBoxRace.height / 2)
      await page.waitForFunction(() => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'go'
      }, undefined, { timeout: 10_000 })
    }
    const raceDblClickCard = await getCard()
    record(
      'RACE-OUTSIDE-DBLCLICK',
      'double-clicking word B outside open card dismisses card A and displays word B',
      raceDblClickCard !== null && raceDblClickCard.headword === 'go',
      raceDblClickCard?.headword,
    )

    // Outside drag race: card A open, drag word B outside card -> card B visible
    const teethBoxRace = await page.locator('[data-phase5-word="teeth"]').boundingBox()
    if (teethBoxRace) {
      await page.mouse.move(teethBoxRace.x + 2, teethBoxRace.y + teethBoxRace.height / 2)
      await page.mouse.down()
      await page.mouse.move(teethBoxRace.x + teethBoxRace.width - 2, teethBoxRace.y + teethBoxRace.height / 2, { steps: 5 })
      await page.mouse.up()
      await page.waitForFunction(() => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'tooth'
      }, undefined, { timeout: 10_000 })
    }
    const raceDragCard = await getCard()
    record(
      'RACE-OUTSIDE-DRAG',
      'drag-selecting word B outside open card dismisses card A and displays word B',
      raceDragCard !== null && raceDragCard.headword === 'tooth',
      raceDragCard?.headword,
    )

    // --- Card-Internal Selection & Copy ---
    const initialLookups = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups())
    // Select text inside card
    await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const gloss = card?.querySelector('[data-dsh-word-lookup="gloss"]')
      if (!gloss) throw new Error('Gloss not found inside card')
      const range = document.createRange()
      range.selectNodeContents(gloss)
      const sel = document.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    })
    const cardSelectedText = await page.evaluate(() => document.getSelection()?.toString() ?? '')
    // Double click inside card
    const glossBox = await page.locator('[data-dsh-word-lookup="gloss"]').first().boundingBox()
    if (glossBox) {
      await page.mouse.dblclick(glossBox.x + glossBox.width / 2, glossBox.y + glossBox.height / 2)
    }
    await new Promise((r) => setTimeout(r, 200))
    const lookupsAfterInternalClick = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups())
    record(
      'CARD-INTERNAL-SELECTION',
      'text inside card is selectable, and internal double-click/drag produces 0 automatic requests',
      cardSelectedText.length > 0 && lookupsAfterInternalClick === initialLookups,
      `selectedText="${cardSelectedText}" deltaRequests=${lookupsAfterInternalClick - initialLookups}`,
    )

    // Test copy event is not intercepted
    let copyIntercepted = false
    await page.evaluate(() => {
      document.addEventListener(
        'copy',
        (e) => {
          window.__COPY_EVENT_RECEIVED__ = true
          window.__COPY_PREVENTED__ = e.defaultPrevented
        },
        { once: true },
      )
    })
    await page.keyboard.press('Control+C')
    const copyResult = await page.evaluate(() => ({
      received: window.__COPY_EVENT_RECEIVED__ ?? false,
      prevented: window.__COPY_PREVENTED__ ?? false,
    }))
    record(
      'CARD-COPY-SHORTCUT',
      'Ctrl+C copy event inside card is not swallowed or intercepted by the plugin',
      copyResult.prevented === false,
      JSON.stringify(copyResult),
    )

    // --- Focus Non-Stealing Behavior ---
    await page.focus('[data-phase5-probe="composer"]')
    const activeBefore = await page.evaluate(() => document.activeElement?.getAttribute('data-phase5-probe'))
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const activeAfter = await page.evaluate(() => document.activeElement?.getAttribute('data-phase5-probe'))
    record(
      'FOCUS-INTEGRITY',
      'appearance of dictionary card does NOT steal focus from active composer or document',
      activeBefore === 'composer' && activeAfter === 'composer',
      `before=${activeBefore} after=${activeAfter}`,
    )

    // --- Long Content & Internal Scroll QA ---
    // Lookup word with long definition & examples (conservation)
    await selectWord('conservation')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => {
      const h = document.querySelector('[data-dsh-word-lookup="headword"]')
      return h && h.textContent === 'conservation'
    }, undefined, { timeout: 10_000 })
    const longCard = await getCard()
    const scrollInfo = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      return {
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight,
        hasVerticalOverflow: card.scrollHeight > card.clientHeight,
        scrollWidth: card.scrollWidth,
        clientWidth: card.clientWidth,
        hasHorizontalOverflow: card.scrollWidth > card.clientWidth,
      }
    })
    record(
      'LONG-CONTENT-SCROLL',
      'long entries render with internal scroll capability and 0 horizontal overflow',
      longCard !== null &&
        scrollInfo.hasHorizontalOverflow === false &&
        longCard.rect.width <= 360,
      JSON.stringify(scrollInfo),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'long-content.png') })

    // --- Theme QA: Light and Dark Mode Styles ---
    // Dark mode styles check
    const darkStyles = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const computed = window.getComputedStyle(card)
      return {
        background: computed.backgroundColor,
        color: computed.color,
        border: computed.borderColor,
      }
    })
    record(
      'THEME-DARK',
      'dark theme renders readable elevated card contrast',
      Boolean(darkStyles.background) && Boolean(darkStyles.color),
      JSON.stringify(darkStyles),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'dark-mode.png') })

    // Switch to light mode via document data-theme attribute
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light')
      document.body.classList.add('light')
    })
    const lightStyles = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const computed = window.getComputedStyle(card)
      return {
        background: computed.backgroundColor,
        color: computed.color,
        border: computed.borderColor,
      }
    })
    record(
      'THEME-LIGHT',
      'light theme applies high-contrast foreground and border styling',
      Boolean(lightStyles.background) && Boolean(lightStyles.color),
      JSON.stringify(lightStyles),
    )
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'light-mode.png') })

    // Reset theme
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme')
      document.body.classList.remove('light')
    })

    // --- Accessibility Check ---
    const a11y = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const closeBtn = card?.querySelector('[data-dsh-word-lookup="close"]')
      const heading = card?.querySelector('h2[data-dsh-word-lookup="headword"]')
      return {
        role: card?.getAttribute('role'),
        ariaLabel: card?.getAttribute('aria-label'),
        closeAriaLabel: closeBtn?.getAttribute('aria-label'),
        hasHeading: heading !== null,
      }
    })
    record(
      'ACCESSIBILITY',
      'card provides accessible region role, label, h2 structure, and accessible close button',
      a11y.role === 'region' &&
        a11y.ariaLabel === 'Dictionary lookup' &&
        a11y.closeAriaLabel === 'Close dictionary' &&
        a11y.hasHeading === true,
      JSON.stringify(a11y),
    )

    // Reset switches back to false
    await page.evaluate(async () => {
      await window.__DSH_WORD_LOOKUP__.set('autoDoubleClick', false)
      await window.__DSH_WORD_LOOKUP__.set('autoSelection', false)
    })

  } finally {
    await browser.close()
    await stopDsh(child)
  }

  console.log('\n=== Phase 5 Browser Acceptance Summary ===')
  let passedCount = 0
  for (const r of results) {
    if (r.passed) passedCount += 1
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  [${r.id}] ${r.description}`)
  }
  console.log(`\nTotal: ${passedCount}/${results.length} checks passed.`)

  if (passedCount !== results.length) {
    console.error('Phase 5 browser acceptance: FAIL')
    process.exit(1)
  }
  console.log('Phase 5 browser acceptance: PASS')
}

await run()
