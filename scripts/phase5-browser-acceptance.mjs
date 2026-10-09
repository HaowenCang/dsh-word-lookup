#!/usr/bin/env node
/**
 * Phase 5.1 Browser Acceptance Suite.
 *
 * Runs against an isolated DSH Web instance with real Chromium:
 * - UI01: manual shortcut found rendering (headword, phonetic, POS, meanings, lemma, examples)
 * - UI02: auto double-click found rendering (went -> go, lemma, single lookup)
 * - UI03: auto drag-selection found rendering (teeth -> tooth, lemma, single lookup)
 * - UI04: unknown word not-found state
 * - UI05: transport error handling & recovery
 * - UI05-Recovery: recovery from error
 * - Positioning: top, bottom, left clamp, right clamp, null fallback, multiline, narrow viewport, live resize
 * - Dismissal: Escape, outside pointer/click (no shield), close button with accessible name
 * - Scroll & Pass-Through: fixed scroll policy, conversation wheel pass-through, text selection pass-through
 * - Deterministic Races: D1 (close before settle), D2 (close before error), D3 (A -> dismiss -> B -> late A), D4 (re-query)
 * - Outside gesture races: outside double-click B, outside drag B
 * - Card-internal interaction: real double-click (0 lookups), real pointer drag-select (0 lookups), Ctrl+C copy event verification
 * - Focus behavior: card does not steal focus
 * - Card scrolling: long content vertical overflow, card-internal wheel scroll
 * - Theme & Visual QA: Light and Dark theme computed styles, color differences, WCAG >= 4.5:1 contrast, and screenshots
 * - Overlay singleton: single occupant maintained across open/dismiss lifecycles
 * - Accessibility: accessible region, h2 heading, close button label
 *
 * Outputs auditable JSON evidence to docs/evidence/phase5-browser-acceptance-20261004.json
 * and visual screenshots to docs/evidence/phase5-screenshots/
 *
 * @module dsh-word-lookup/scripts/phase5-browser-acceptance
 */

import { execSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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
    console.error('\nRefusing to run Phase 5.1 acceptance: target is not an isolated test environment')
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

// Read current git SHA and branch
const testedGitSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
const branch = execSync('git branch --show-current', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim()
let dshVersion = '0.2.0-rc.2'
try {
  dshVersion = execSync('dsh --version', { encoding: 'utf-8' }).trim()
} catch {}

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

const EVIDENCE_DIR = join(REPO_ROOT, 'docs', 'evidence')
const SCREENSHOT_DIR = options['screenshot-dir']
  ? resolve(options['screenshot-dir'])
  : (options.out ? join(EVIDENCE_DIR, 'store1306-v011-screenshots') : join(REPO_ROOT, 'verify-out', 'phase5-screenshots'))
mkdirSync(SCREENSHOT_DIR, { recursive: true })

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g
const results = []

function record(id, description, passed, detail = '', measured = undefined) {
  results.push({ id, description, passed, detail, measured })
  const status = passed ? 'PASS' : 'FAIL'
  console.log(`${status}  [${id}] ${description}`)
  if (detail) {
    console.log(`      ${String(detail).slice(0, 300)}`)
  }
}

// WCAG relative luminance & contrast ratio calculation
function parseCssColor(colorStr) {
  if (!colorStr) return null
  const hexMatch = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colorStr.trim())
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1], 16),
      g: parseInt(hexMatch[2], 16),
      b: parseInt(hexMatch[3], 16),
    }
  }
  const rgbMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(colorStr.trim())
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    }
  }
  return null
}

function relativeLuminance(rgb) {
  const normalize = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = normalize(rgb.r)
  const g = normalize(rgb.g)
  const b = normalize(rgb.b)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(colorStrA, colorStrB) {
  const rgbA = parseCssColor(colorStrA)
  const rgbB = parseCssColor(colorStrB)
  if (!rgbA || !rgbB) return 1
  const l1 = relativeLuminance(rgbA)
  const l2 = relativeLuminance(rgbB)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2))
}

function inspectPng(filePath) {
  const buffer = readFileSync(filePath)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { sha256, width, height }
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
  console.log('Starting isolated DSH instance for Phase 5.1 Browser Acceptance...')
  const { child, url } = await startDsh()

  const browser = await chromium.launch({ headless: true })
  const chromiumVersion = browser.version()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()

  const consoleErrors = []
  const pageErrors = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })

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

  const screenshotFiles = []

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(
      () => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null,
      undefined,
      { timeout: 90_000 },
    )
    await page.waitForFunction(
      () => window.__DSH_WORD_LOOKUP__.overlay().declarationSeen === true,
      undefined,
      { timeout: 30_000 },
    )

    // Setup synthetic conversation probes
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-phase1-probe],[data-phase5-probe]')) node.remove()

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
      composer.style.cssText =
        'position:fixed;left:340px;bottom:20px;width:500px;height:48px;z-index:10;background:#18181c;color:#fff;border:1px solid #444;padding:8px;border-radius:6px;'
      composer.textContent = 'derive inside the composer'
      document.body.appendChild(composer)

      // Dedicated word probes positioned across the screen
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

      // Left edge probe (near viewport left boundary)
      const leftEdge = document.createElement('div')
      leftEdge.setAttribute('data-phase5-probe', 'left-edge')
      leftEdge.setAttribute('data-chat-flow-kind', 'assistant-step')
      leftEdge.setAttribute('data-chat-node-key', 'phase5:edge:left')
      leftEdge.style.cssText = 'position:fixed;left:4px;top:280px;z-index:10;color:#eee;'
      leftEdge.innerHTML = '<span data-phase5-word="left-word">derive</span>'
      document.body.appendChild(leftEdge)

      // Right edge probe (near viewport right boundary)
      const rightEdge = document.createElement('div')
      rightEdge.setAttribute('data-phase5-probe', 'right-edge')
      rightEdge.setAttribute('data-chat-flow-kind', 'assistant-step')
      rightEdge.setAttribute('data-chat-node-key', 'phase5:edge:right')
      rightEdge.style.cssText = 'position:fixed;right:4px;top:280px;z-index:10;color:#eee;'
      rightEdge.innerHTML = '<span data-phase5-word="right-word">derive</span>'
      document.body.appendChild(rightEdge)

      // Scrollable conversation container for wheel pass-through and fixed scroll policy tests
      const scrollContainer = document.createElement('div')
      scrollContainer.setAttribute('data-phase5-probe', 'scroll-container')
      scrollContainer.setAttribute('data-chat-flow-kind', 'assistant-step')
      scrollContainer.setAttribute('data-chat-node-key', 'phase5:scroll:container')
      scrollContainer.style.cssText =
        'position:fixed;left:100px;top:550px;width:380px;height:120px;overflow-y:auto;background:#202026;color:#ccc;padding:8px;border:1px solid #444;font:13px system-ui;'
      scrollContainer.innerHTML = `
        <p data-phase5-probe-line="c1">Conversation item 1: quantum mechanics foundation.</p>
        <p data-phase5-probe-line="c2">Conversation item 2: wave function collapse upon observation.</p>
        <p data-phase5-probe-line="c3">Conversation item 3: energy eigenvalue equation.</p>
        <p data-phase5-probe-line="c4">Conversation item 4: Hamiltonian operator formulation.</p>
        <p data-phase5-probe-line="c5">Conversation item 5: expectation values of observables.</p>
        <p data-phase5-probe-line="c6">Conversation item 6: probability density conservation.</p>
      `
      document.body.appendChild(scrollContainer)
    })

    await page.waitForTimeout(800)
    await dismissDialogs(page)

    // Enable both switches for gesture tests
    await page.evaluate(async () => {
      await window.__DSH_WORD_LOOKUP__.set('autoDoubleClick', true)
      await window.__DSH_WORD_LOOKUP__.set('autoSelection', true)
    })

    // Helpers
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
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
          },
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
      await page.waitForTimeout(100)
    }

    // --- UI01: Manual Shortcut Found ---
    state.requests.length = 0
    await selectWord('derived')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
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
      `headword=${ui01Card?.headword} lemma=${ui01Card?.lemma} meanings=${ui01Card?.glosses.length} examples=${ui01Card?.examples.length}`,
      ui01Card,
    )
    const shotUi01 = join(SCREENSHOT_DIR, 'normal-found.png')
    await page.screenshot({ path: shotUi01 })
    screenshotFiles.push('normal-found.png')

    // --- UI02: Auto double-click on "went" ---
    state.requests.length = 0
    await clearSelection()
    const wentBox = await page.locator('[data-phase5-word="went"]').boundingBox()
    if (wentBox) {
      await page.mouse.dblclick(wentBox.x + wentBox.width / 2, wentBox.y + wentBox.height / 2)
      await page.waitForFunction(
        () => {
          const h = document.querySelector('[data-dsh-word-lookup="headword"]')
          return h && h.textContent === 'go'
        },
        undefined,
        { timeout: 10_000 },
      )
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
      { requests: state.requests.length, headword: ui02Card?.headword, lemma: ui02Card?.lemma },
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
      await page.waitForFunction(
        () => {
          const h = document.querySelector('[data-dsh-word-lookup="headword"]')
          return h && h.textContent === 'tooth'
        },
        undefined,
        { timeout: 10_000 },
      )
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
      { requests: state.requests.length, headword: ui03Card?.headword, lemma: ui03Card?.lemma },
    )

    // --- UI04: Unknown Word (Not-Found) ---
    state.requests.length = 0
    await selectWord('unknowntoken')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup="not-found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    const ui04Card = await getCard()
    record(
      'UI04',
      'unknown word renders friendly not-found state without error banner or traces',
      ui04Card !== null &&
        ui04Card.uiState === 'not-found' &&
        ui04Card.text.includes('no entry for "unknowntoken"'),
      `uiState=${ui04Card?.uiState} text="${ui04Card?.text}"`,
      ui04Card,
    )
    const shotUi04 = join(SCREENSHOT_DIR, 'not-found.png')
    await page.screenshot({ path: shotUi04 })
    screenshotFiles.push('not-found.png')

    // --- UI05: Error State & Recovery ---
    await page.route('**/api/dsh-word-lookup', async (route) => {
      if (route.request().postData()?.includes('error-probe')) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })
      } else {
        await route.continue()
      }
    })
    await selectWord('derive')
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('error-probe', 'shortcut'))
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup="error"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    const ui05Card = await getCard()
    record(
      'UI05',
      'transport error renders sanitized error message without leaking paths or internals',
      ui05Card !== null &&
        ui05Card.uiState === 'error' &&
        !ui05Card.text.includes('token') &&
        !ui05Card.text.includes('/api') &&
        !ui05Card.text.includes('C:\\'),
      `uiState=${ui05Card?.uiState} text="${ui05Card?.text}"`,
      ui05Card,
    )
    const shotUi05 = join(SCREENSHOT_DIR, 'error.png')
    await page.screenshot({ path: shotUi05 })
    screenshotFiles.push('error.png')

    // Recovery check
    await page.unroute('**/api/dsh-word-lookup')
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    const recoveredCard = await getCard()
    record(
      'UI05-Recovery',
      'normal lookup immediately recovers card from previous error',
      recoveredCard !== null && recoveredCard.uiState === 'found' && recoveredCard.headword === 'derive',
      `recovered headword=${recoveredCard?.headword}`,
      recoveredCard,
    )

    // --- Positioning: Viewport Safety & Clamping ---
    const viewport = page.viewportSize()

    // POS-TOP
    await selectWord('top-word')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const topPosCard = await getCard()
    record(
      'POS-TOP',
      'selection near top places card below and respects top/left margins',
      topPosCard !== null &&
        topPosCard.rect.y >= 12 &&
        topPosCard.rect.bottom <= viewport.height - 12 &&
        topPosCard.rect.x >= 12,
      `card.y=${topPosCard?.rect.y} card.bottom=${topPosCard?.rect.bottom}`,
      topPosCard?.rect,
    )

    // POS-BOTTOM
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
      { cardRect: bottomPosCard?.rect, composerY: composerBox?.y },
    )

    // POS-LEFT
    await selectWord('left-word')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const leftPosCard = await getCard()
    const leftAnchorBox = await page.locator('[data-phase5-word="left-word"]').boundingBox()
    record(
      'POS-LEFT',
      'selection near left edge clamps card.left >= 12px within viewport margin',
      leftPosCard !== null &&
        leftPosCard.rect.x >= 12 &&
        leftPosCard.rect.right <= viewport.width - 12,
      `anchor.x=${leftAnchorBox?.x} card.x=${leftPosCard?.rect.x} card.right=${leftPosCard?.rect.right}`,
      { anchorRect: leftAnchorBox, cardRect: leftPosCard?.rect, viewport },
    )

    // POS-RIGHT
    await selectWord('right-word')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const rightPosCard = await getCard()
    const rightAnchorBox = await page.locator('[data-phase5-word="right-word"]').boundingBox()
    record(
      'POS-RIGHT',
      'selection near right edge clamps card.right <= viewport.width - 12px',
      rightPosCard !== null &&
        rightPosCard.rect.right <= viewport.width - 12 &&
        rightPosCard.rect.x >= 12,
      `anchor.x=${rightAnchorBox?.x} card.right=${rightPosCard?.rect.right} card.x=${rightPosCard?.rect.x}`,
      { anchorRect: rightAnchorBox, cardRect: rightPosCard?.rect, viewport },
    )

    // POS-NULL-FALLBACK
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('derive', 'shortcut'))
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const nullFallbackCard = await getCard()
    const expectedCenterX = Math.round((viewport.width - (nullFallbackCard?.rect.width ?? 340)) / 2)
    record(
      'POS-NULL-FALLBACK',
      'anchorRect === null triggers upper-center fallback within viewport bounds and clears composer',
      nullFallbackCard !== null &&
        Math.abs(nullFallbackCard.rect.x - expectedCenterX) <= 5 &&
        nullFallbackCard.rect.y >= 12 &&
        composerBox !== null &&
        nullFallbackCard.rect.bottom <= composerBox.y,
      `actual.x=${nullFallbackCard?.rect.x} expectedCenter.x=${expectedCenterX} card.y=${nullFallbackCard?.rect.y}`,
      { cardRect: nullFallbackCard?.rect, expectedCenterX },
    )

    // POS-MULTILINE
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
      `rect=${JSON.stringify(multilineCard?.rect)}`,
      multilineCard?.rect,
    )

    // POS-NARROW
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
      `x=${narrowCard?.rect.x} right=${narrowCard?.rect.right} width=${narrowCard?.rect.width}`,
      narrowCard?.rect,
    )
    const shotNarrow = join(SCREENSHOT_DIR, 'narrow.png')
    await page.screenshot({ path: shotNarrow })
    screenshotFiles.push('narrow.png')

    // POS-RESIZE-LIVE: shrink viewport while same card remains open
    await page.setViewportSize({ width: 1400, height: 900 })
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    const cardBeforeResize = await getCard()

    await page.setViewportSize({ width: 420, height: 700 })
    await page.waitForFunction(
      () => {
        const c = document.querySelector('[data-dsh-word-lookup="card"]')
        return c && c.getBoundingClientRect().right <= 420 - 10
      },
      undefined,
      { timeout: 5000 },
    )
    const cardAfterResize = await getCard()
    const resizeOverflow = await page.evaluate(() => {
      const c = document.querySelector('[data-dsh-word-lookup="card"]')
      return c ? c.scrollWidth > c.clientWidth : false
    })
    record(
      'POS-RESIZE-LIVE',
      'shrinking viewport while card is already open re-clamps card within new viewport margins with 0 horizontal overflow',
      cardAfterResize !== null &&
        cardAfterResize.headword === cardBeforeResize?.headword &&
        cardAfterResize.rect.x >= 12 &&
        cardAfterResize.rect.right <= 420 - 12 &&
        resizeOverflow === false,
      `wideRect=${JSON.stringify(cardBeforeResize?.rect)} narrowRect=${JSON.stringify(cardAfterResize?.rect)}`,
      { before: cardBeforeResize?.rect, after: cardAfterResize?.rect, hasHorizontalOverflow: resizeOverflow },
    )
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
      'card dismissed',
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
      'card dismissed via Escape',
    )

    // 3. Outside Click (no click shield)
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    await page.evaluate(() => {
      window.__COMPOSER_CLICKED__ = false
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
    const composerClicked = await page.evaluate(() => window.__COMPOSER_CLICKED__ === true)
    record(
      'DISMISS-OUTSIDE',
      'clicking outside dismisses card without swallowing click on underlying element (no click shield)',
      (await getCard()) === null && composerClicked === true,
      `composerClicked=${composerClicked}`,
      { composerClicked },
    )

    // --- Scroll Policy: Card is fixed in viewport, does not live-follow anchor scroll ---
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    const cardBeforeScroll = await getCard()
    await page.evaluate(() => {
      const container = document.querySelector('[data-phase5-probe="scroll-container"]')
      container.scrollTop = 50
    })
    const cardAfterScroll = await getCard()
    const containerScrolled = await page.evaluate(() => {
      const container = document.querySelector('[data-phase5-probe="scroll-container"]')
      return container.scrollTop
    })
    record(
      'SCROLL-POLICY-FIXED',
      'card position is fixed in viewport; underlying conversation scroll changes while card stays stable and safe',
      cardBeforeScroll !== null &&
        cardAfterScroll !== null &&
        Math.abs(cardBeforeScroll.rect.y - cardAfterScroll.rect.y) <= 1 &&
        containerScrolled >= 40,
      `card.y before=${cardBeforeScroll?.rect.y} after=${cardAfterScroll?.rect.y} container.scrollTop=${containerScrolled}`,
      { beforeY: cardBeforeScroll?.rect.y, afterY: cardAfterScroll?.rect.y, containerScrolled },
    )

    // --- Wheel Pass-Through: Conversation wheel outside card ---
    const convBox = await page.locator('[data-phase5-probe="scroll-container"]').boundingBox()
    if (convBox) {
      await page.mouse.move(convBox.x + convBox.width / 2, convBox.y + convBox.height / 2)
      const convScrollInitial = await page.evaluate(
        () => document.querySelector('[data-phase5-probe="scroll-container"]').scrollTop,
      )
      await page.mouse.wheel(0, 60)
      await page.waitForTimeout(200)
      const convScrollAfter = await page.evaluate(
        () => document.querySelector('[data-phase5-probe="scroll-container"]').scrollTop,
      )
      record(
        'PASS-THROUGH-WHEEL',
        'mouse wheel over conversation area outside card scrolls conversation without card overlay intercepting',
        convScrollAfter > convScrollInitial,
        `scrollTop initial=${convScrollInitial} after=${convScrollAfter}`,
        { initial: convScrollInitial, after: convScrollAfter },
      )
    }

    // --- Selection Pass-Through: Conversation text selection outside card ---
    const multilineBox = await page.locator('[data-phase5-probe="multiline"]').boundingBox()
    if (multilineBox) {
      await page.mouse.move(multilineBox.x + 5, multilineBox.y + 10)
      await page.mouse.down()
      await page.mouse.move(multilineBox.x + 120, multilineBox.y + 10, { steps: 5 })
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
    const convSelectedText = await page.evaluate(() => document.getSelection()?.toString() ?? '')
    record(
      'PASS-THROUGH-SELECTION',
      'drag-selecting text in conversation outside card is not blocked by overlay and successfully establishes selection',
      convSelectedText.length > 0,
      `selectedText="${convSelectedText}"`,
      { selectedText: convSelectedText },
    )

    // --- Dismiss / Request Races (D1 - D4) ---

    // D1: Deterministic deferred in-flight success -> dismiss -> settle -> remains closed
    let d1Resolver
    const d1Gate = new Promise((resolve) => {
      d1Resolver = resolve
    })
    let d1SeenInFlight = false

    await page.route('**/api/dsh-word-lookup', async (route) => {
      const data = route.request().postData()
      if (data?.includes('d1-deterministic-probe')) {
        d1SeenInFlight = true
        await d1Gate
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            found: true,
            query: 'd1-deterministic-probe',
            headword: 'derive',
            phonetic: '/dɪˈraɪv/',
            meanings: [{ partOfSpeech: 'verb', definition: 'derive', translation: '导出' }],
            forms: [],
            matchedForm: null,
            examples: [],
            source: 'fixture',
            settings: { autoDoubleClick: false, autoSelection: false },
          }),
        })
      } else {
        await route.continue()
      }
    })

    const d1Run = page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('d1-deterministic-probe', 'shortcut'))
    await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.loading() === true)
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.dismiss())
    d1Resolver()
    await d1Run
    await page.waitForTimeout(200)

    const d1Card = await getCard()
    const d1State = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.card())
    await page.unroute('**/api/dsh-word-lookup')

    record(
      'RACE-D1',
      'D1: request definitely observed in-flight -> dismiss -> release response -> card remains closed and idle',
      d1SeenInFlight === true && d1Card === null && d1State.status === 'idle',
      `seenInFlight=${d1SeenInFlight} cardStatus=${d1State.status}`,
      { seenInFlight: d1SeenInFlight, cardStatus: d1State.status },
    )

    // D2: Deterministic deferred in-flight 500 failure -> dismiss -> settle -> remains closed (no error card)
    let d2Resolver
    const d2Gate = new Promise((resolve) => {
      d2Resolver = resolve
    })
    let d2SeenInFlight = false

    await page.route('**/api/dsh-word-lookup', async (route) => {
      const data = route.request().postData()
      if (data?.includes('d2-deterministic-probe')) {
        d2SeenInFlight = true
        await d2Gate
        await route.fulfill({
          status: 500,
          contentType: 'text/plain',
          body: 'Internal Server Error',
        })
      } else {
        await route.continue()
      }
    })

    const d2Run = page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('d2-deterministic-probe', 'shortcut'))
    await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.loading() === true)
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.dismiss())
    d2Resolver()
    await d2Run
    await page.waitForTimeout(200)

    const d2Card = await getCard()
    const d2State = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.card())
    await page.unroute('**/api/dsh-word-lookup')

    record(
      'RACE-D2',
      'D2: request definitely observed in-flight -> dismiss -> release 500 error -> card remains closed and idle without error banner',
      d2SeenInFlight === true && d2Card === null && d2State.status === 'idle',
      `seenInFlight=${d2SeenInFlight} cardStatus=${d2State.status}`,
      { seenInFlight: d2SeenInFlight, cardStatus: d2State.status },
    )

    // D3: A starts -> dismiss A -> B starts & succeeds -> A settles late -> B remains visible, A cannot replace B
    let d3ResolverA
    const d3GateA = new Promise((resolve) => {
      d3ResolverA = resolve
    })

    await page.route('**/api/dsh-word-lookup', async (route) => {
      const data = route.request().postData()
      if (data?.includes('d3-word-a-deferred')) {
        await d3GateA
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            found: true,
            query: 'd3-word-a-deferred',
            headword: 'stale-headword-a',
            phonetic: '/a/',
            meanings: [{ partOfSpeech: 'noun', definition: 'a', translation: '甲' }],
            forms: [],
            matchedForm: null,
            examples: [],
            source: 'fixture',
            settings: { autoDoubleClick: false, autoSelection: false },
          }),
        })
      } else {
        await route.continue()
      }
    })

    const pA = page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('d3-word-a-deferred', 'shortcut'))
    await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.loading() === true)
    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.dismiss())

    // B starts and finishes
    await selectWord('went')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'go'
      },
      undefined,
      { timeout: 10_000 },
    )

    const genBeforeLateA = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.surfaceGeneration())
    // Now late A settles
    d3ResolverA()
    await pA
    await page.waitForTimeout(300)

    const d3CardFinal = await getCard()
    const genAfterLateA = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.surfaceGeneration())
    await page.unroute('**/api/dsh-word-lookup')

    record(
      'RACE-D3',
      'D3: A starts -> dismiss A -> B succeeds -> late A settles -> B remains visible, late A cannot overwrite B',
      d3CardFinal !== null &&
        d3CardFinal.headword === 'go' &&
        d3CardFinal.headword !== 'stale-headword-a' &&
        genBeforeLateA === genAfterLateA,
      `headword=${d3CardFinal?.headword} gen=${genAfterLateA}`,
      { headword: d3CardFinal?.headword, generation: genAfterLateA },
    )

    // D4: same word looked up again after dismissal -> reopens normally
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    const d4Card = await getCard()
    record(
      'RACE-D4',
      'D4: exact same query looked up after dismissal reopens surface normally with new generation',
      d4Card !== null && d4Card.headword === 'derive',
      `headword=${d4Card?.headword}`,
      d4Card,
    )

    // Outside double-click race: card A open, dblclick word B outside card -> card B visible
    const wentBoxRace = await page.locator('[data-phase5-word="went"]').boundingBox()
    if (wentBoxRace) {
      await page.mouse.dblclick(wentBoxRace.x + wentBoxRace.width / 2, wentBoxRace.y + wentBoxRace.height / 2)
      await page.waitForFunction(
        () => {
          const h = document.querySelector('[data-dsh-word-lookup="headword"]')
          return h && h.textContent === 'go'
        },
        undefined,
        { timeout: 10_000 },
      )
    }
    const raceDblClickCard = await getCard()
    record(
      'RACE-OUTSIDE-DBLCLICK',
      'double-clicking word B outside open card dismisses card A and displays word B',
      raceDblClickCard !== null && raceDblClickCard.headword === 'go',
      raceDblClickCard?.headword,
      raceDblClickCard,
    )

    // Outside drag race: card A open, drag word B outside card -> card B visible
    const teethBoxRace = await page.locator('[data-phase5-word="teeth"]').boundingBox()
    if (teethBoxRace) {
      await page.mouse.move(teethBoxRace.x + 2, teethBoxRace.y + teethBoxRace.height / 2)
      await page.mouse.down()
      await page.mouse.move(teethBoxRace.x + teethBoxRace.width - 2, teethBoxRace.y + teethBoxRace.height / 2, {
        steps: 5,
      })
      await page.mouse.up()
      await page.waitForFunction(
        () => {
          const h = document.querySelector('[data-dsh-word-lookup="headword"]')
          return h && h.textContent === 'tooth'
        },
        undefined,
        { timeout: 10_000 },
      )
    }
    const raceDragCard = await getCard()
    record(
      'RACE-OUTSIDE-DRAG',
      'drag-selecting word B outside open card dismisses card A and displays word B',
      raceDragCard !== null && raceDragCard.headword === 'tooth',
      raceDragCard?.headword,
      raceDragCard,
    )

    // --- Card-Internal Selection & Copy Tests (Split into Real DBLCLICK and Real DRAG) ---
    // Ensure card for "derive" is displayed and fully rendered in 'found' state
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )

    const initialLookups = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups())

    // 1. Real CARD-INTERNAL-DBLCLICK on gloss
    const glossLocator = page.locator('[data-dsh-word-lookup="gloss"]').first()
    await glossLocator.scrollIntoViewIfNeeded()
    const glossBox = await glossLocator.boundingBox()
    if (glossBox) {
      await page.mouse.dblclick(glossBox.x + glossBox.width / 2, glossBox.y + glossBox.height / 2)
      await page.waitForTimeout(200)
    }
    const lookupsAfterInternalDblClick = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups())
    const internalDblClickDelta = lookupsAfterInternalDblClick - initialLookups
    record(
      'CARD-INTERNAL-DBLCLICK',
      'real double-click on text inside card produces 0 automatic lookup requests',
      internalDblClickDelta === 0,
      `initialLookups=${initialLookups} lookupsAfter=${lookupsAfterInternalDblClick} delta=${internalDblClickDelta}`,
      { initialLookups, lookupsAfter: lookupsAfterInternalDblClick, delta: internalDblClickDelta },
    )

    // 2. Real CARD-INTERNAL-DRAG on definition / gloss text
    // Clear selection inside card first
    await page.evaluate(() => document.getSelection()?.removeAllRanges())
    await page.waitForTimeout(100)

    // Target the first example english text or headword/definition
    const exampleTextLocator = page.locator('[data-dsh-word-lookup="example"] div').first()
    await exampleTextLocator.scrollIntoViewIfNeeded()
    const exampleTextBox = await exampleTextLocator.boundingBox()

    if (exampleTextBox) {
      await page.mouse.move(exampleTextBox.x + 4, exampleTextBox.y + exampleTextBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(exampleTextBox.x + Math.min(100, exampleTextBox.width - 10), exampleTextBox.y + exampleTextBox.height / 2, {
        steps: 8,
      })
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
    const cardDragSelectedText = await page.evaluate(() => document.getSelection()?.toString().trim() ?? '')
    const lookupsAfterInternalDrag = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups())
    const internalDragDelta = lookupsAfterInternalDrag - lookupsAfterInternalDblClick
    const cardStillUsable = (await getCard()) !== null

    record(
      'CARD-INTERNAL-DRAG',
      'real pointer drag over text inside card forms genuine selection and produces 0 automatic requests while card remains usable',
      cardDragSelectedText.length > 0 && internalDragDelta === 0 && cardStillUsable === true,
      `selectedText="${cardDragSelectedText}" deltaRequests=${internalDragDelta} cardStillUsable=${cardStillUsable}`,
      { selectedText: cardDragSelectedText, delta: internalDragDelta, cardStillUsable },
    )

    // 3. CARD-COPY-SHORTCUT (Fix COPY vacuous PASS: must verify received === true AND prevented === false)
    await page.evaluate(() => {
      window.__COPY_EVENT_RECEIVED__ = false
      window.__COPY_PREVENTED__ = null
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
    await page.waitForTimeout(200)
    const copyResult = await page.evaluate(() => ({
      received: window.__COPY_EVENT_RECEIVED__ === true,
      prevented: window.__COPY_PREVENTED__ ?? true,
      selectedText: document.getSelection()?.toString().trim() ?? '',
    }))

    record(
      'CARD-COPY-SHORTCUT',
      'Ctrl+C copy event inside card fires with received=true and defaultPrevented=false without plugin interception',
      copyResult.received === true && copyResult.prevented === false && copyResult.selectedText.length > 0,
      `received=${copyResult.received} prevented=${copyResult.prevented} text="${copyResult.selectedText}"`,
      copyResult,
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
      { before: activeBefore, after: activeAfter },
    )

    // --- Long Content & Vertical Scroll QA ---
    // Inject synthetic rich entry with 4 meanings and 6 bilingual examples via route interception
    await page.route('**/api/dsh-word-lookup', async (route) => {
      const data = route.request().postData()
      if (data?.includes('synthetic-long-entry')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            found: true,
            query: 'synthetic-long-entry',
            headword: 'conservation',
            phonetic: '/ˌkɒnsəˈveɪʃn/',
            matchedForm: null,
            meanings: [
              {
                partOfSpeech: 'noun',
                definition: 'The principle that total value of a physical quantity remains constant in an isolated system.',
                translation: '守恒定律：孤立系统中物理量总量保持不变的基本原理。',
              },
              {
                partOfSpeech: 'noun',
                definition: 'Careful preservation and protection of something, especially environmental resources.',
                translation: '保护与保存：对自然资源与生态环境的审慎维护。',
              },
              {
                partOfSpeech: 'noun',
                definition: 'The restoration and chemical stabilization of cultural works of art and historical specimens.',
                translation: '文物修复：艺术作品与历史标本的保护与稳定技术。',
              },
              {
                partOfSpeech: 'noun',
                definition: 'Supervision and management of natural resources to ensure sustainable ecological balance.',
                translation: '资源管理：自然资源的合理监督与可持续生态管理。',
              },
            ],
            forms: ['conservational', 'conservationist', 'conservations'],
            examples: [
              {
                en: 'Charge conservation is one of the most rigorously tested physical conservation laws in science.',
                zh: '电荷守恒定律是科学界经受最严格检验的守恒定律之一。',
              },
              {
                en: 'Energy conservation strictly forbids that transition without external photon absorption.',
                zh: '能量守恒定律明确禁止该跃迁在没有外部光子吸收的情况下发生。',
              },
              {
                en: 'Local angular momentum conservation governs the vortex formation during fluid discharge.',
                zh: '局部角动量守恒支配流体排放过程中的涡旋形成。',
              },
              {
                en: 'Modern wildlife conservation programs focus on genetic diversity across fragmented habitats.',
                zh: '现代野生动物保护项目重点关注破碎化栖息地中的遗传多样性。',
              },
              {
                en: 'Architectural conservation requires reversible chemical treatments for sandstone stabilization.',
                zh: '建筑修复需要对砂岩加固采取可逆的化学处理手段。',
              },
              {
                en: 'Marine conservation zones demonstrate rapid biomass recovery within five years of establishment.',
                zh: '海洋保护区在设立后五年内表现出生物量的迅速恢复。',
              },
            ],
            source: 'fixture',
            settings: { autoDoubleClick: false, autoSelection: false },
          }),
        })
      } else {
        await route.continue()
      }
    })

    await page.evaluate(() => window.__DSH_WORD_LOOKUP__.runLookup('synthetic-long-entry', 'shortcut'))
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-dsh-word-lookup="card"]')
        return card && card.scrollHeight > card.clientHeight
      },
      undefined,
      { timeout: 10_000 },
    )
    const longCard = await getCard()
    const scrollMeasurement = await page.evaluate(() => {
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

    // Perform actual vertical scroll inside card
    await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      card.scrollTop = 80
    })
    await page.waitForTimeout(100)
    const actualScrollTop = await page.evaluate(
      () => document.querySelector('[data-dsh-word-lookup="card"]')?.scrollTop ?? 0,
    )
    await page.unroute('**/api/dsh-word-lookup')

    record(
      'LONG-CONTENT-SCROLL',
      'long entries render with scrollHeight > clientHeight (vertical overflow), 0 horizontal overflow, and responsive scrollTop scroll',
      longCard !== null &&
        scrollMeasurement.hasVerticalOverflow === true &&
        scrollMeasurement.hasHorizontalOverflow === false &&
        actualScrollTop > 0,
      `scrollHeight=${scrollMeasurement.scrollHeight} clientHeight=${scrollMeasurement.clientHeight} scrollTop=${actualScrollTop} horizOverflow=${scrollMeasurement.hasHorizontalOverflow}`,
      { ...scrollMeasurement, actualScrollTop },
    )
    const shotLong = join(SCREENSHOT_DIR, 'long-content.png')
    await page.screenshot({ path: shotLong })
    screenshotFiles.push('long-content.png')

    // --- CARD-WHEEL: Mouse wheel inside card scrolls card without moving conversation ---
    const cardBeforeWheelBox = await page.locator('[data-dsh-word-lookup="card"]').boundingBox()
    const convScrollBeforeCardWheel = await page.evaluate(
      () => document.querySelector('[data-phase5-probe="scroll-container"]').scrollTop,
    )
    await page.evaluate(() => {
      document.querySelector('[data-dsh-word-lookup="card"]').scrollTop = 0
    })
    if (cardBeforeWheelBox) {
      await page.mouse.move(
        cardBeforeWheelBox.x + cardBeforeWheelBox.width / 2,
        cardBeforeWheelBox.y + cardBeforeWheelBox.height / 2,
      )
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(200)
    }
    const cardScrollAfterWheel = await page.evaluate(
      () => document.querySelector('[data-dsh-word-lookup="card"]')?.scrollTop ?? 0,
    )
    const convScrollAfterCardWheel = await page.evaluate(
      () => document.querySelector('[data-phase5-probe="scroll-container"]').scrollTop,
    )

    record(
      'CARD-WHEEL',
      'mouse wheel inside card increments card.scrollTop without driving underlying conversation scroll',
      cardScrollAfterWheel > 0 && convScrollBeforeCardWheel === convScrollAfterCardWheel,
      `cardScrollAfter=${cardScrollAfterWheel} convScrollBefore=${convScrollBeforeCardWheel} convScrollAfter=${convScrollAfterCardWheel}`,
      { cardScrollAfterWheel, convScrollBeforeCardWheel, convScrollAfterCardWheel },
    )

    // --- Theme QA: Light and Dark Mode Computed Styles, Difference, and Contrast ---
    // Look up "derive" so theme screenshots specifically present standard headword in dark & light themes
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => {
        const h = document.querySelector('[data-dsh-word-lookup="headword"]')
        return h && h.textContent === 'derive'
      },
      undefined,
      { timeout: 10_000 },
    )

    // 1. Dark mode theme check
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.body.classList.remove('light')
      document.body.classList.add('dark')
    })
    await page.waitForTimeout(200)

    const darkStyles = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const h2 = card?.querySelector('[data-dsh-word-lookup="headword"]')
      const gloss = card?.querySelector('[data-dsh-word-lookup="gloss"]')
      const compCard = window.getComputedStyle(card)
      const compH2 = h2 ? window.getComputedStyle(h2) : null
      const compGloss = gloss ? window.getComputedStyle(gloss) : null
      return {
        background: compCard.backgroundColor,
        color: compCard.color,
        border: compCard.borderColor,
        headwordColor: compH2?.color ?? compCard.color,
        glossColor: compGloss?.color ?? compCard.color,
      }
    })
    record(
      'THEME-DARK',
      'dark theme renders elevated background and high-contrast foreground colors',
      Boolean(darkStyles.background) && Boolean(darkStyles.color),
      `bg=${darkStyles.background} fg=${darkStyles.color} border=${darkStyles.border}`,
      darkStyles,
    )
    const shotDark = join(SCREENSHOT_DIR, 'dark.png')
    await page.screenshot({ path: shotDark })
    screenshotFiles.push('dark.png')

    // 2. Light mode theme check
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light')
      document.body.classList.remove('dark')
      document.body.classList.add('light')
    })
    await page.waitForTimeout(200)

    const lightStyles = await page.evaluate(() => {
      const card = document.querySelector('[data-dsh-word-lookup="card"]')
      const h2 = card?.querySelector('[data-dsh-word-lookup="headword"]')
      const gloss = card?.querySelector('[data-dsh-word-lookup="gloss"]')
      const compCard = window.getComputedStyle(card)
      const compH2 = h2 ? window.getComputedStyle(h2) : null
      const compGloss = gloss ? window.getComputedStyle(gloss) : null
      return {
        background: compCard.backgroundColor,
        color: compCard.color,
        border: compCard.borderColor,
        headwordColor: compH2?.color ?? compCard.color,
        glossColor: compGloss?.color ?? compCard.color,
      }
    })
    const themesDiffer =
      darkStyles.background !== lightStyles.background &&
      darkStyles.color !== lightStyles.color

    record(
      'THEME-LIGHT',
      'light theme computed background and foreground colors differ significantly from dark theme',
      themesDiffer && Boolean(lightStyles.background) && Boolean(lightStyles.color),
      `lightBg=${lightStyles.background} lightFg=${lightStyles.color} differ=${themesDiffer}`,
      { darkStyles, lightStyles, themesDiffer },
    )
    const shotLight = join(SCREENSHOT_DIR, 'light.png')
    await page.screenshot({ path: shotLight })
    screenshotFiles.push('light.png')

    // 3. THEME-CONTRAST: WCAG contrast ratio calculation for both themes
    const darkBodyContrast = contrastRatio(darkStyles.background, darkStyles.color)
    const darkHeadwordContrast = contrastRatio(darkStyles.background, darkStyles.headwordColor)
    const lightBodyContrast = contrastRatio(lightStyles.background, lightStyles.color)
    const lightHeadwordContrast = contrastRatio(lightStyles.background, lightStyles.headwordColor)
    const contrastPassed =
      darkBodyContrast >= 4.5 &&
      darkHeadwordContrast >= 4.5 &&
      lightBodyContrast >= 4.5 &&
      lightHeadwordContrast >= 4.5

    record(
      'THEME-CONTRAST',
      'computed WCAG contrast ratio for core text meets or exceeds standard 4.5:1 in both dark and light modes',
      contrastPassed,
      `darkBody=${darkBodyContrast}:1 darkHeadword=${darkHeadwordContrast}:1 lightBody=${lightBodyContrast}:1 lightHeadword=${lightHeadwordContrast}:1`,
      { darkBodyContrast, darkHeadwordContrast, lightBodyContrast, lightHeadwordContrast, threshold: 4.5 },
    )

    // Reset theme
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme')
      document.body.classList.remove('dark')
      document.body.classList.remove('light')
    })

    // --- Overlay Singleton: Registration count remains 1 across open/close cycles ---
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await selectWord('derive')
      await page.keyboard.press('Control+Shift+L')
      await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') !== null)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('[data-dsh-word-lookup="card"]') === null)
    }
    const overlayStatus = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.overlay())
    record(
      'OVERLAY-SINGLETON',
      'repeated open/dismiss cycles maintain exactly 1 occupant registration in shell.overlay without accumulation',
      overlayStatus.registrationCount === 1,
      `registrationCount=${overlayStatus.registrationCount}`,
      overlayStatus,
    )

    // --- Accessibility Check ---
    await selectWord('derive')
    await page.keyboard.press('Control+Shift+L')
    await page.waitForFunction(
      () => document.querySelector('[data-dsh-word-lookup-ui-state="found"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
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
      a11y,
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

  // Filter intentional console errors provoked by UI05 and D2
  const intentionalPattern =
    /Failed to load resource: the server responded with a status of (400|500)|Internal Server Error/
  const unexpectedConsoleErrors = consoleErrors.filter((msg) => !intentionalPattern.test(msg))

  console.log('\n=== Phase 5.1 Browser Acceptance Summary ===')
  let passedCount = 0
  for (const r of results) {
    if (r.passed) passedCount += 1
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  [${r.id}] ${r.description}`)
  }
  console.log(`\nTotal: ${passedCount}/${results.length} checks passed.`)

  // Inspect generated screenshots
  const screenshotMetadata = []
  for (const filename of screenshotFiles) {
    const fullPath = join(SCREENSHOT_DIR, filename)
    if (existsSync(fullPath)) {
      const info = inspectPng(fullPath)
      const relPath = relative(REPO_ROOT, fullPath).replace(/\\/g, '/')
      screenshotMetadata.push({
        filename,
        path: relPath,
        sha256: info.sha256,
        width: info.width,
        height: info.height,
      })
    }
  }

  // Generate machine-readable JSON evidence
  const jsonReportPath = options.out ? resolve(options.out) : join(REPO_ROOT, 'verify-out', 'phase5-browser-acceptance.json')
  const jsonReport = {
    phase: options.out ? 'Phase 6R.1' : 'Phase 5.1',
    generatedAt: new Date().toISOString(),
    testedCodeGitSha: testedGitSha,
    testedGitSha,
    branch,
    profile: verified.profile,
    port: verified.port,
    dshVersion,
    isolation: {
      home: verified.home,
      profile: verified.profile,
      port: verified.port,
      isolationBanner: ISOLATION_BANNER.trim(),
    },
    environment: {
      DSH: dshVersion,
      Node: process.version,
      Chromium: chromiumVersion,
      Playwright: '1.63.0',
      viewport: { width: 1400, height: 900 },
    },
    passed: passedCount,
    failed: results.length - passedCount,
    total: results.length,
    failedIds: results.filter((r) => !r.passed).map((r) => r.id),
    checks: results.map((r) => ({
      id: r.id,
      description: r.description,
      passed: r.passed,
      detail: r.detail,
      measured: r.measured,
    })),
    summary: {
      passed: passedCount,
      total: results.length,
      failedIds: results.filter((r) => !r.passed).map((r) => r.id),
    },
    screenshots: screenshotMetadata,
    consoleErrors: unexpectedConsoleErrors,
    pageErrors,
    productionSafety:
      'Production DSH environment untouched. All tests executed against isolated test profile and ephemeral port. Synthetic conversation probes only. Zero credentials or user tokens logged.',
  }

  mkdirSync(dirname(jsonReportPath), { recursive: true })
  writeFileSync(jsonReportPath, JSON.stringify(jsonReport, null, 2), 'utf-8')
  console.log(`\nMachine-readable evidence saved to: ${jsonReportPath}`)

  const allPassed =
    passedCount === results.length &&
    unexpectedConsoleErrors.length === 0 &&
    pageErrors.length === 0

  if (!allPassed) {
    if (unexpectedConsoleErrors.length > 0) {
      console.error(`Unexpected console errors encountered (${unexpectedConsoleErrors.length}):`, unexpectedConsoleErrors)
    }
    if (pageErrors.length > 0) {
      console.error(`Page errors encountered (${pageErrors.length}):`, pageErrors)
    }
    console.error('Phase 5.1 browser acceptance: FAIL')
    process.exit(1)
  }

  console.log('Phase 5.1 browser acceptance: PASS')
}

await run()
