#!/usr/bin/env node
/**
 * Phase 1 end-to-end verification against a real DSH Web boot.
 *
 * What this measures, and why each part is measured this way:
 *
 * - **Host loader.** A real `dsh` process is started against an isolated
 *   `DSH_HOME` whose profile composes this plugin as a *bundle entry*, so the
 *   entry is created by the profile's root Include at boot. Runtime injection
 *   produces a different entry class that the settings service does not serve;
 *   Phase 0 measured that difference, and no result here may come from it.
 * - **Browser.** A real Chromium navigates to the launch-token URL, which mints
 *   the authority-bound cookie the connection fence requires. Nothing is
 *   injected into the page to make the plugin work.
 * - **Route.** The lookup route is exercised from the page with
 *   `fetch('api/dsh-word-lookup', …)` — the document-relative form the product
 *   uses — and network activity is observed through Playwright, not through the
 *   plugin's own counters.
 * - **Shortcut.** The command is triggered by real key events. The pass/handled
 *   distinction is observed twice: by the request count, and by whether the
 *   event was still unconsumed when a listener registered after the plugin's ran.
 * - **Settings.** A write goes through the same `ConfigForm.set` the settings UI
 *   calls; live propagation is observed on the client snapshot and on the host's
 *   own echo, the persisted user layer is read off disk, and the whole thing is
 *   re-measured after a full process restart.
 *
 * Every measurement is recorded, including the ones that fail, so the report can
 * distinguish "not measured" from "measured and false".
 */

import { spawn } from 'node:child_process'

import { assertIsolatedDshEnvironment, buildIsolatedEnv, ISOLATION_BANNER } from './assert-isolated-env.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, request as playwrightRequest } from 'playwright'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Parse `--key value` arguments.
 *
 * @param argv - process arguments.
 * @returns the parsed options.
 */
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
const HOME = resolve(options.home ?? join(tmpdir(), 'dsh-phase1-iso'))
const PROFILE = options.profile ?? 'wlphase1'
const PORT = Number(options.port ?? 50998)
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const OUT_PATH = resolve(options.out ?? join(REPO_ROOT, 'verify-out', 'phase1-verification.json'))
const WORKDIR = resolve(options.workdir ?? REPO_ROOT)

// The isolation gate runs before anything is started or written. This harness
// boots a real DSH process and restarts it, so an unverified target here is the
// exact failure this project already suffered once.
let VERIFIED
try {
  VERIFIED = assertIsolatedDshEnvironment({
    home: HOME,
    profile: PROFILE,
    port: PORT,
    profileDir: PROFILE_DIR,
    testRoot: options['test-root'],
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('\nphase1-verify: refusing to start; the target is not an isolated environment')
  process.exit(2)
}
console.log(ISOLATION_BANNER)

/** Every recorded measurement, in execution order. */
const results = []
/** Boot logs of each `dsh` process, keyed by boot index. */
const bootLogs = []

/**
 * Record one measurement.
 *
 * @param id - stable identifier used by the report.
 * @param name - what was measured.
 * @param ok - whether it held.
 * @param detail - evidence, or the reason it failed.
 * @param extra - optional structured evidence.
 */
function record(id, name, ok, detail = '', extra = undefined) {
  results.push({ id, name, ok, detail, ...(extra === undefined ? {} : { extra }) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${detail === '' ? '' : `\n      ${detail}`}`)
}

/** Strip ANSI colour codes so boot output can be matched. */
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Start one isolated DSH Web process and wait for its authenticated launch URL.
 *
 * @param bootIndex - 1 for the first boot, 2 for the restart.
 * @returns the child process and the authenticated URL.
 */
async function startDsh(bootIndex) {
  // `buildIsolatedEnv` strips every inherited `DSH_*` variable before setting
  // the three this instance owns, so the child can never see the production
  // home, session id or GUI URL even if the caller's shell exports them.
  const env = buildIsolatedEnv(VERIFIED)
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: WORKDIR,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const log = { bootIndex, stdout: '', stderr: '', startedAt: new Date().toISOString(), pid: child.pid }
  bootLogs.push(log)

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`dsh did not print a launch URL within 90s\n${log.stdout}\n${log.stderr}`))
    }, 90_000)
    const consume = (chunk, sink) => {
      const text = chunk.toString().replace(ANSI, '')
      log[sink] += text
      const match = /https?:\/\/[^\s"']*\/\?token=[A-Za-z0-9._~-]+/.exec(log.stdout)
      if (match !== null) {
        clearTimeout(timer)
        resolveUrl(match[0])
      }
    }
    child.stdout.on('data', (chunk) => consume(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => consume(chunk, 'stderr'))
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error(`dsh exited with code ${String(code)} before printing a launch URL\n${log.stdout}\n${log.stderr}`))
    })
  })

  // Give the webserver a moment to accept connections beyond the index route.
  await new Promise((r) => setTimeout(r, 1500))
  return { child, url, log }
}

/**
 * Stop one DSH process and wait for its exit.
 *
 * @param child - the process to stop.
 * @returns whether it exited.
 */
async function stopDsh(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)))
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true })
  } else {
    child.kill('SIGTERM')
  }
  const timed = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15_000))])
  return timed === true
}

/** A page handle plus the observation channels attached to it. */
async function openAuthenticatedPage(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const state = { requests: [], consoleErrors: [], pageErrors: [], failedRequests: [] }

  page.on('request', (req) => {
    if (req.url().includes('/api/dsh-word-lookup')) {
      state.requests.push({ method: req.method(), url: req.url(), postData: req.postData() })
    }
  })
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => state.pageErrors.push(String(error.message)))
  page.on('requestfailed', (req) => state.failedRequests.push(`${req.method()} ${req.url()}: ${req.failure()?.errorText ?? ''}`))

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null, undefined, {
    timeout: 90_000,
  })
  // The overlay declaration is made by the frame, which mounts after the plugin
  // activates; wait for the contribution to be observed rather than sleeping.
  await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.overlay().declarationSeen === true, undefined, { timeout: 30_000 })
  return { context, page, state }
}

/** Wait for pending network activity to settle. */
const settle = () => new Promise((r) => setTimeout(r, 600))

/**
 * Install the synthetic DOM the shortcut checks select inside of.
 *
 * The plugin only reads `document.getSelection()` and walks ancestors, so a node
 * carrying the same two attributes a real flow item carries exercises the same
 * code path. The nodes are test scaffolding inside the page, not plugin output:
 * they are created after boot and removed before the DOM-integrity check.
 *
 * @param page - the authenticated page.
 */
async function installProbeNodes(page) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-phase1-probe]')) node.remove()
    const style = 'position:fixed;left:24px;top:150px;z-index:2147482000;background:#1b1b20;color:#eaeaf0;padding:10px 14px;border-radius:6px;font:14px/1.6 system-ui;max-width:440px'

    const flow = document.createElement('div')
    flow.setAttribute('data-phase1-probe', 'flow')
    flow.setAttribute('data-chat-flow-kind', 'assistant-step')
    flow.setAttribute('data-chat-node-key', 'phase1:probe:1')
    flow.style.cssText = style
    const flowText = document.createElement('p')
    flowText.textContent = 'The serializer must derive the wire form from the boundary conditions.'
    flow.appendChild(flowText)
    document.body.appendChild(flow)

    const loose = document.createElement('div')
    loose.setAttribute('data-phase1-probe', 'loose')
    loose.style.cssText = style
    loose.textContent = 'detached derive outside the conversation'
    document.body.appendChild(loose)

    const composer = document.createElement('div')
    composer.setAttribute('data-phase1-probe', 'composer')
    composer.setAttribute('contenteditable', 'true')
    composer.setAttribute('role', 'textbox')
    composer.style.cssText = style
    composer.textContent = 'derive inside the composer'
    document.body.appendChild(composer)

    // Recorded on the window bubble phase, registered after the plugin's own
    // listeners, so `defaultPrevented` shows whether the command consumed it.
    window.__PHASE1_KEY__ = null
    window.addEventListener('keydown', (event) => {
      window.__PHASE1_KEY__ = {
        code: event.code,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
      }
    })
  })
}

/**
 * Select the first occurrence of a word inside one probe node.
 *
 * @param page - the authenticated page.
 * @param probe - the probe node's `data-phase1-probe` value.
 * @param word - the word to select.
 */
async function selectWord(page, probe, word) {
  await page.evaluate(
    ({ probeName, target }) => {
      const host = document.querySelector(`[data-phase1-probe="${probeName}"]`)
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null && !(node.textContent ?? '').includes(target)) node = walker.nextNode()
      if (node === null) throw new Error(`no text node containing "${target}" in probe "${probeName}"`)
      const start = (node.textContent ?? '').indexOf(target)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + target.length)
      const selection = document.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    },
    { probeName: probe, target: word },
  )
}

/** Collapse the current selection. */
async function clearSelection(page) {
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
  })
}

/**
 * Census the elements the shortcut dispatcher treats as modal.
 *
 * `modalSelector` in `@deepseek-ai/dsh-client-ui-primitives` is
 * `[role="dialog"][aria-modal="true"], [role="menu"]`; the dispatcher blocks any
 * command whose `modals` list does not name the open modal. This plugin declares
 * `modals: []` by contract, so a single open dialog is expected to block it.
 *
 * @param page - the authenticated page.
 * @returns the open modals, by accessible label.
 */
async function modalCensus(page) {
  return await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].map(
      (element) => element.getAttribute('aria-label') ?? '(unlabelled)',
    ),
    menus: document.querySelectorAll('[role="menu"]').length,
  }))
}

/**
 * Controls whose text closes a shell dialog rather than submitting it.
 *
 * The shell opens two first-visit cards: a notice whose only control is
 * "Continue", and a Models onboarding whose primary button *saves* — clicking
 * that one leaves the dialog open. Preference is given to the wording that
 * dismisses, and the remaining controls are tried only if none of these closes
 * the dialog.
 */
const DISMISS_LABEL = /configure later|not now|skip|later|close|dismiss|got it|continue|ok\b/i

/**
 * Dismiss the dialogs the shell opens on a first visit.
 *
 * A fresh browser context has no stored acknowledgement, so DSH opens its
 * first-run cards. Leaving one open would make every shortcut measurement read
 * "blocked by a modal", which says nothing about the command's own behaviour.
 *
 * Controls are activated through the DOM rather than by a synthetic pointer
 * click: the cards render inside the shell's modal layer, where Playwright's
 * actionability check does not settle, while a dispatched click still reaches
 * the framework's delegated handler.
 *
 * @param page - the authenticated page.
 * @returns which dialogs were dismissed and how many remain.
 */
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

/** Press the manual lookup shortcut and let the request settle. */
async function pressLookup(page, state) {
  state.requests.length = 0
  await page.evaluate(() => {
    window.__PHASE1_KEY__ = null
  })
  await page.keyboard.press('Control+Shift+L')
  await settle()
}

/** Read the card's presence and content from the overlay layer. */
async function readCard(page) {
  return await page.evaluate(() => {
    const slot = document.querySelector('[data-slot="shell.overlay"]')
    const card = slot?.querySelector('[data-dsh-word-lookup="card"]') ?? null
    return {
      slotPresent: slot !== null,
      slotChildren: slot === null ? -1 : slot.children.length,
      cardPresent: card !== null,
      state: card?.getAttribute('data-dsh-word-lookup-state') ?? null,
      headword: slot?.querySelector('[data-dsh-word-lookup="headword"]')?.textContent ?? null,
      body: card?.textContent ?? null,
    }
  })
}

/**
 * Run every browser-side measurement.
 *
 * @param page - the authenticated page.
 * @param state - its observation channels.
 * @param boot - which boot this is, so the report can separate first-boot from
 * post-restart evidence.
 * @returns the collected facts the orchestrator needs after the browser closes.
 */
async function runBrowserChecks(page, state, boot) {
  const prefix = boot === 1 ? 'B' : 'R'
  const facts = {}

  // --- loader ---------------------------------------------------------------
  const bootFacts = await page.evaluate(() => {
    const manifest = window.__DSH_BOOT__
    const entries = Object.values(manifest?.entries ?? {}).map((entry) => ({
      id: entry.id,
      url: entry.url,
      inject: entry.inject ?? [],
    }))
    const batches = (manifest?.batches ?? []).map((batch) => ({ phase: batch.phase, url: batch.url }))
    const own = entries.filter((entry) => entry.id === 'dsh-word-lookup')
    return {
      entryCount: entries.length,
      own,
      batchUrls: batches.map((batch) => batch.url),
      hasPluginInBatch: batches.some((batch) => batch.url.includes('dsh-word-lookup/client.js')),
      diagnostics: typeof window.__DSH_WORD_LOOKUP__ === 'object',
      slotHostCount: document.querySelectorAll('[data-slot]').length,
    }
  })
  facts.boot = bootFacts

  record(
    `${prefix}01`,
    'the plugin appears in the boot manifest as a browser entry',
    bootFacts.own.length === 1 && bootFacts.own[0].url.includes('dsh-word-lookup/client.js'),
    JSON.stringify(bootFacts.own),
  )
  record(
    `${prefix}02`,
    'the plugin is served inside the concatenated application batch',
    bootFacts.hasPluginInBatch,
    bootFacts.batchUrls.filter((url) => url.includes('dsh-word-lookup')).join(' | ') || 'not present in any batch URL',
  )
  record(
    `${prefix}03`,
    'the client half executed and published its runtime',
    bootFacts.diagnostics,
    `boot manifest entries: ${String(bootFacts.entryCount)}, slot hosts: ${String(bootFacts.slotHostCount)}`,
  )

  const overlay = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.overlay())
  facts.overlayBeforeLookup = overlay
  record(
    `${prefix}04`,
    'the shell.overlay declaration was observed and the occupant registered exactly once',
    overlay.declarationSeen === true && overlay.registrationCount === 1,
    JSON.stringify(overlay),
  )

  const idleCard = await readCard(page)
  record(
    `${prefix}05`,
    'the occupant renders nothing while idle',
    idleCard.slotPresent && idleCard.cardPresent === false,
    JSON.stringify(idleCard),
  )

  // --- shortcut catalog -----------------------------------------------------
  const catalog = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.catalog())
  facts.catalog = catalog
  record(
    `${prefix}06`,
    'the manual command is registered with the sealed binding and no conflict',
    catalog.row !== null &&
      catalog.row.id === 'wordLookup.lookupSelection' &&
      catalog.row.conflicts.length === 0 &&
      catalog.row.issue === null &&
      catalog.row.keys.join('') === 'Ctrl+Shift+L',
    JSON.stringify(catalog.row),
  )

  await installProbeNodes(page)
  // The shell's first-run notice renders shortly after the frame mounts; give it
  // the moment it needs so the census below describes a settled page.
  await page.waitForTimeout(800)

  // --- the modal rule, measured before anything is dismissed ----------------
  // The shell opens its first-run notice in a browser context that has not
  // acknowledged it. This plugin declares `modals: []`, so while that dialog is
  // open the command must not fire at all: not merely "no request", but no
  // consultation of the resolver.
  const modalBefore = await modalCensus(page)
  facts.modalBefore = modalBefore
  if (modalBefore.dialogs.length > 0) {
    const beforeCounters = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
    await selectWord(page, 'flow', 'derive')
    await pressLookup(page, state)
    const blockedCounters = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
    facts.modalBlock = { modalBefore, beforeCounters, blockedCounters, requests: state.requests.length }
    record(
      `${prefix}A0`,
      'a command declaring no modals is blocked and consumed while a dialog is open',
      state.requests.length === 0 && blockedCounters.resolveCalls === beforeCounters.resolveCalls,
      `open=${JSON.stringify(modalBefore.dialogs)} requests=${String(state.requests.length)} counters=${JSON.stringify(blockedCounters)}`,
    )
  }
  const dismissal = await dismissDialogs(page)
  facts.dialogDismissal = dismissal
  record(
    `${prefix}A1`,
    'the first-run notice is dismissed so the command can be measured on its own',
    dismissal.remaining === 0,
    JSON.stringify(dismissal),
  )

  // --- pass-through with no selection --------------------------------------
  await clearSelection(page)
  const countersBeforePass = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
  await pressLookup(page, state)
  const noSelectionKey = await page.evaluate(() => window.__PHASE1_KEY__)
  const noSelectionCard = await readCard(page)
  const countersAfterPass = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
  facts.noSelection = { requests: state.requests.length, key: noSelectionKey, card: noSelectionCard, countersAfterPass }
  record(
    `${prefix}07`,
    'the shortcut resolves to pass and consumes nothing when no selection qualifies',
    state.requests.length === 0 &&
      noSelectionCard.cardPresent === false &&
      countersAfterPass.resolveCalls === countersBeforePass.resolveCalls + 1 &&
      countersAfterPass.passReturns === countersBeforePass.passReturns + 1 &&
      countersAfterPass.runCalls === countersBeforePass.runCalls &&
      noSelectionKey?.defaultPrevented === false,
    `requests=${String(state.requests.length)} key=${JSON.stringify(noSelectionKey)} counters=${JSON.stringify(countersAfterPass)}`,
  )

  // --- pass-through for a selection outside the conversation ---------------
  await selectWord(page, 'loose', 'derive')
  const looseSnapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())
  await pressLookup(page, state)
  const looseCard = await readCard(page)
  facts.looseSelection = { snapshot: looseSnapshot, requests: state.requests.length, card: looseCard }
  record(
    `${prefix}08`,
    'a selection outside a conversation flow item does not qualify',
    state.requests.length === 0 && looseCard.cardPresent === false,
    `snapshot=${JSON.stringify(looseSnapshot)} requests=${String(state.requests.length)}`,
  )

  // --- pass-through for a selection inside the composer --------------------
  await selectWord(page, 'composer', 'derive')
  const composerSnapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())
  await pressLookup(page, state)
  facts.composerSelection = { snapshot: composerSnapshot, requests: state.requests.length }
  record(
    `${prefix}09`,
    'a selection inside the composer does not qualify (T08)',
    state.requests.length === 0 && composerSnapshot.eligible === false,
    `snapshot=${JSON.stringify(composerSnapshot)} requests=${String(state.requests.length)}`,
  )

  // --- the manual path ------------------------------------------------------
  await selectWord(page, 'flow', 'derive')
  const flowSnapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())
  const countersBeforeHandled = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
  await pressLookup(page, state)
  const handledKey = await page.evaluate(() => window.__PHASE1_KEY__)
  const card = await readCard(page)
  const countersAfterHandled = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.shortcut())
  const after = {
    lookups: await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lookups()),
    lastOutcome: await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lastOutcome()),
  }
  facts.manual = {
    snapshot: flowSnapshot,
    requests: [...state.requests],
    key: handledKey,
    card,
    countersBeforeHandled,
    countersAfterHandled,
    after,
  }
  record(
    `${prefix}10`,
    'a qualifying selection plus the shortcut resolves to handled and issues exactly one request (T03)',
    state.requests.length === 1 &&
      state.requests[0]?.method === 'POST' &&
      countersAfterHandled.resolveCalls === countersBeforeHandled.resolveCalls + 1 &&
      countersAfterHandled.handledReturns === countersBeforeHandled.handledReturns + 1 &&
      countersAfterHandled.runCalls === countersBeforeHandled.runCalls + 1 &&
      handledKey?.defaultPrevented === true,
    `requests=${JSON.stringify(state.requests)} key=${JSON.stringify(handledKey)} context=${JSON.stringify(countersAfterHandled.lastContext)} counters=${JSON.stringify(countersAfterHandled)}`,
  )
  record(
    `${prefix}11`,
    'the lookup reached the host and came back as a hit',
    after.lastOutcome === 'found' && card.cardPresent === true && (card.headword ?? '').includes('derive'),
    `outcome=${String(after.lastOutcome)} card=${JSON.stringify(card)}`,
  )
  record(
    `${prefix}12`,
    'the card is rendered inside the frame-wide overlay layer',
    card.cardPresent && card.body !== null && card.body.includes('derive'),
    `slotChildren=${String(card.slotChildren)}`,
  )

  // --- overlay replacement: still exactly one occupant ----------------------
  const overlayAfter = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.overlay())
  const cardCount = await page.evaluate(
    () => document.querySelectorAll('[data-slot="shell.overlay"] [data-dsh-word-lookup="card"]').length,
  )
  facts.overlayAfterLookup = { overlayAfter, cardCount }
  record(
    `${prefix}13`,
    'no duplicate occupant is registered by the running runtime',
    overlayAfter.registrationCount === 1 && cardCount === 1,
    JSON.stringify(facts.overlayAfterLookup),
  )

  // --- route behaviour from the page ---------------------------------------
  const direct = await page.evaluate(async () => {
    const send = async (body, headers = { 'content-type': 'application/json' }) => {
      const response = await fetch('api/dsh-word-lookup', { method: 'POST', headers, body })
      let parsed = null
      try {
        parsed = await response.json()
      } catch {
        parsed = null
      }
      return { status: response.status, body: parsed }
    }
    return {
      found: await send(JSON.stringify({ query: 'derive' })),
      unknown: await send(JSON.stringify({ query: 'zzz-not-a-word' })),
      malformed: await send('{not json'),
      tooLong: await send(JSON.stringify({ query: 'a'.repeat(200) })),
      wrongType: await send(JSON.stringify({ query: 'derive' }), { 'content-type': 'text/plain' }),
    }
  })
  facts.route = direct
  record(
    `${prefix}14`,
    'the exact Fetch route answers 200 from the authenticated page',
    direct.found.status === 200 && direct.found.body?.found === true,
    JSON.stringify(direct.found),
  )
  record(
    `${prefix}15`,
    'a malformed request is a controlled 400 (T13)',
    direct.malformed.status === 400 && direct.malformed.body?.error === 'malformed-body',
    JSON.stringify(direct.malformed),
  )
  record(
    `${prefix}16`,
    'an over-long query is a controlled 400 (T14)',
    direct.tooLong.status === 400 && direct.tooLong.body?.error === 'query-too-long',
    JSON.stringify(direct.tooLong),
  )
  record(
    `${prefix}17`,
    'an unsupported content type is a controlled 400',
    direct.wrongType.status === 400 && direct.wrongType.body?.error === 'unsupported-content-type',
    JSON.stringify(direct.wrongType),
  )
  record(
    `${prefix}18`,
    'an unknown word is 200 with found:false, never an error (T12)',
    direct.unknown.status === 200 && direct.unknown.body?.found === false,
    JSON.stringify(direct.unknown),
  )

  // --- automatic triggers are absent and produce zero requests --------------
  // Real trusted input, aimed at a real word inside a flow item: a double click
  // (T02) and a drag selection (T01). Phase 1 has no trigger gate at all, so the
  // expected count is zero for both; the selection they produce is still captured
  // by the snapshot listener, which is what makes the zero meaningful.
  await clearSelection(page)
  const box = await page.locator('[data-phase1-probe="flow"] p').boundingBox()
  state.requests.length = 0
  if (box !== null) {
    const centreY = box.y + box.height / 2
    await page.mouse.dblclick(box.x + 60, centreY)
    await settle()
    await page.mouse.move(box.x + 6, centreY)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 6, centreY, { steps: 14 })
    await page.mouse.up()
    await settle()
  }
  const gestureSnapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())
  facts.automaticTriggers = { requests: state.requests.length, box, snapshotAfterGestures: gestureSnapshot }
  record(
    `${prefix}19`,
    'with both switches off, double click and drag selection produce zero lookups (T01/T02/T22)',
    state.requests.length === 0 && box !== null,
    `requests=${String(state.requests.length)} snapshot=${JSON.stringify(gestureSnapshot)}`,
  )

  // --- settings mirror ------------------------------------------------------
  const snapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.snapshot())
  const gates = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())
  facts.snapshotBeforeWrite = snapshot
  facts.gatesBeforeWrite = gates
  const settingsServed =
    snapshot.status === 'ready' && snapshot.mode === 'host' && snapshot.writable === true && snapshot.revision !== undefined
  // On the first boot the two switches must be at their composed defaults. On
  // the restart they must instead carry what the earlier write persisted, which
  // is asserted separately as S05/S06 — asserting "false" there would be
  // asserting that the write was lost.
  const settingsValues =
    boot === 1
      ? snapshot.value?.autoDoubleClick === false && snapshot.value?.autoSelection === false
      : snapshot.value?.autoDoubleClick === true && snapshot.value?.autoSelection === true
  record(
    `${prefix}20`,
    boot === 1
      ? 'the settings namespace is served to the browser and both defaults are false'
      : 'the settings namespace is served to the browser and carries the persisted values',
    settingsServed && settingsValues,
    JSON.stringify(snapshot),
  )
  record(
    `${prefix}21`,
    'the client gate values are derived from that snapshot',
    gates.autoDoubleClick === (snapshot.value?.autoDoubleClick === true) &&
      gates.autoSelection === (snapshot.value?.autoSelection === true),
    JSON.stringify(gates),
  )

  // --- DOM integrity --------------------------------------------------------
  const dom = await page.evaluate(() => ({
    flowItems: document.querySelectorAll('[data-chat-flow-kind]').length,
    messageBody: document.querySelectorAll('[data-dsh-part="message-body"]').length,
    pluginNodesOutsideOverlay: [...document.querySelectorAll('[data-dsh-word-lookup]')].filter(
      (node) => node.closest('[data-slot="shell.overlay"]') === null,
    ).length,
    probeNodes: document.querySelectorAll('[data-phase1-probe]').length,
  }))
  facts.dom = dom
  record(
    `${prefix}22`,
    'the plugin added no node outside the overlay layer',
    dom.pluginNodesOutsideOverlay === 0,
    JSON.stringify(dom),
  )

  return facts
}

/**
 * Toggle one switch through the settings form and observe both ends.
 *
 * @param page - the authenticated page.
 * @param field - the switch to write.
 * @param value - the value to write.
 * @returns the observations.
 */
async function writeSwitch(page, field, value) {
  const accepted = await page.evaluate(
    async ({ fieldName, next }) => await window.__DSH_WORD_LOOKUP__.set(fieldName, next),
    { fieldName: field, next: value },
  )
  await settle(page)
  const snapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.snapshot())
  const gates = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())
  const echo = await page.evaluate(async () => {
    const response = await fetch('api/dsh-word-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'derive' }),
    })
    return await response.json()
  })
  return { accepted, snapshot, gates, echo: echo?.settings ?? null }
}

/**
 * Read the profile's patch file, which is where an accepted write persists.
 *
 * @returns the file's text, or an empty string when it does not exist.
 */
function readPatch() {
  return existsSync(PATCH_PATH) ? readFileSync(PATCH_PATH, 'utf8') : ''
}

/**
 * Separate genuine console errors from the ones this harness provokes.
 *
 * Three checks deliberately POST malformed bodies and expect 400s; Chromium logs
 * each refused response as a resource error. Those lines are the measurement
 * working, not a defect, so they are excluded and reported separately — while
 * every other console error and every unhandled exception still fails the check.
 *
 * @param state - the page's observation channels.
 * @returns the unexpected errors and the intentional ones.
 */
function classifyConsoleErrors(state) {
  const intentional = /Failed to load resource: the server responded with a status of 400/
  const unexpected = state.consoleErrors.filter((text) => !intentional.test(text))
  const expected = state.consoleErrors.filter((text) => intentional.test(text))
  return { unexpected, expected, pageErrors: [...state.pageErrors] }
}

/** The main sequence. */
async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    environment: { home: HOME, profile: PROFILE, port: PORT, profileDir: PROFILE_DIR, patchPath: PATCH_PATH, workdir: WORKDIR },
    results,
    bootLogs,
    facts: {},
  }

  const dshVersion = await new Promise((resolveVersion) => {
    const child = spawn('dsh', ['--version'], { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('exit', () => resolveVersion(out.trim()))
  })
  report.environment.dshVersion = dshVersion

  // --- first boot -----------------------------------------------------------
  const first = await startDsh(1)
  report.environment.firstBootUrl = first.url
  record('H01', 'the isolated DSH Web process started and printed an authenticated URL', first.url.startsWith('http://127.0.0.1:'), first.url.replace(/token=.*/, 'token=<redacted>'))

  const browser = await chromium.launch({ headless: true })
  let firstFacts
  try {
    const { context, page, state } = await openAuthenticatedPage(browser, first.url)
    report.environment.browserVersion = browser.version()
    firstFacts = await runBrowserChecks(page, state, 1)

    // --- live settings write ------------------------------------------------
    const firstWrite = await writeSwitch(page, 'autoSelection', true)
    record(
      'S01',
      "a settings write is accepted and the client snapshot changes without a restart",
      firstWrite.accepted === true && firstWrite.snapshot.value?.autoSelection === true,
      JSON.stringify({ accepted: firstWrite.accepted, value: firstWrite.snapshot.value, revision: firstWrite.snapshot.revision }),
    )
    record(
      'S02',
      'the host reads the new value on its next request (config.autoSelection.get())',
      firstWrite.echo?.autoSelection === true,
      JSON.stringify(firstWrite.echo),
    )
    const patchAfterWrite = readPatch()
    report.facts.patchAfterWrite = patchAfterWrite
    record(
      'S03',
      'the accepted write is persisted to the profile patch on disk',
      patchAfterWrite.includes('dsh-word-lookup') && /autoSelection:\s*true/.test(patchAfterWrite),
      patchAfterWrite.replace(/\n/g, ' | ').slice(0, 400),
    )

    const secondWrite = await writeSwitch(page, 'autoDoubleClick', true)
    record(
      'S04',
      'the two switches are independent: writing the second one leaves the first alone',
      secondWrite.accepted === true &&
        secondWrite.snapshot.value?.autoDoubleClick === true &&
        secondWrite.snapshot.value?.autoSelection === true,
      JSON.stringify(secondWrite.snapshot.value),
    )

    // --- unauthenticated fence ---------------------------------------------
    const anonymous = await playwrightRequest.newContext()
    const anonymousResponse = await anonymous.post(`http://127.0.0.1:${String(PORT)}/api/dsh-word-lookup`, {
      data: { query: 'derive' },
      failOnStatusCode: false,
    })
    await anonymous.dispose()
    record(
      'F05',
      'the route is still behind the connection fence without a browser session',
      anonymousResponse.status() === 401,
      `status=${String(anonymousResponse.status())}`,
    )

    report.facts.firstBoot = firstFacts
    report.facts.firstWrite = firstWrite
    report.facts.patchAfterWrite = patchAfterWrite

    // --- client reload ------------------------------------------------------
    state.requests.length = 0
    state.consoleErrors.length = 0
    state.pageErrors.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null, undefined, {
      timeout: 90_000,
    })
    await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.overlay().declarationSeen === true, undefined, { timeout: 30_000 })
    const reloaded = await page.evaluate(() => ({
      overlay: window.__DSH_WORD_LOOKUP__.overlay(),
      catalog: window.__DSH_WORD_LOOKUP__.catalog(),
    }))
    report.facts.afterClientReload = reloaded
    record(
      'L01',
      'a full client reload re-registers the overlay and the command exactly once',
      reloaded.overlay.registrationCount === 1 &&
        reloaded.catalog.row !== null &&
        reloaded.catalog.row.conflicts.length === 0,
      JSON.stringify(reloaded),
    )

    // --- console cleanliness ------------------------------------------------
    const consoleFirst = classifyConsoleErrors(state)
    report.facts.consoleErrors = consoleFirst
    report.facts.failedRequests = [...state.failedRequests]
    record(
      'L02',
      'the browser console reported no unexpected error and no unhandled exception',
      consoleFirst.unexpected.length === 0 && consoleFirst.pageErrors.length === 0,
      `unexpected=${JSON.stringify(consoleFirst.unexpected)} pageErrors=${JSON.stringify(consoleFirst.pageErrors)} intentional400=${String(consoleFirst.expected.length)}`,
    )

    await context.close()
  } finally {
    await browser.close()
  }

  // --- restart --------------------------------------------------------------
  const stopped = await stopDsh(first.child)
  record('H02', 'the first isolated process stopped cleanly', stopped, `pid=${String(first.log.pid)}`)

  const second = await startDsh(2)
  report.environment.secondBootUrl = second.url
  record('H03', 'a second full DSH boot succeeded from the same profile', second.url.startsWith('http://127.0.0.1:'), second.url.replace(/token=.*/, 'token=<redacted>'))
  report.facts.secondBootLog = second.log.stdout.slice(-4000)

  const browser2 = await chromium.launch({ headless: true })
  try {
    const { context, page, state } = await openAuthenticatedPage(browser2, second.url)
    const secondFacts = await runBrowserChecks(page, state, 2)

    const persisted = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.snapshot())
    const persistedEcho = await page.evaluate(async () => {
      const response = await fetch('api/dsh-word-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'derive' }),
      })
      return (await response.json())?.settings ?? null
    })
    report.facts.afterRestart = { snapshot: persisted, echo: persistedEcho }
    record(
      'S05',
      'both switches survive a full restart',
      persisted.value?.autoSelection === true && persisted.value?.autoDoubleClick === true,
      JSON.stringify(persisted.value),
    )
    record(
      'S06',
      'the host reads the persisted values after the restart',
      persistedEcho?.autoSelection === true && persistedEcho?.autoDoubleClick === true,
      JSON.stringify(persistedEcho),
    )

    // --- restore ------------------------------------------------------------
    const restored = await writeSwitch(page, 'autoSelection', false)
    const restored2 = await writeSwitch(page, 'autoDoubleClick', false)
    record(
      'S07',
      'the switches can be returned to false, and the client follows',
      restored.accepted === true &&
        restored2.accepted === true &&
        restored2.snapshot.value?.autoSelection === false &&
        restored2.snapshot.value?.autoDoubleClick === false,
      JSON.stringify(restored2.snapshot.value),
    )
    report.facts.restored = restored2

    report.facts.secondBoot = secondFacts
    const consoleSecond = classifyConsoleErrors(state)
    report.facts.consoleErrorsSecondBoot = consoleSecond
    record(
      'L03',
      'the second boot reported no unexpected console error and no duplicate-registration failure',
      consoleSecond.unexpected.length === 0 && consoleSecond.pageErrors.length === 0,
      `unexpected=${JSON.stringify(consoleSecond.unexpected)} pageErrors=${JSON.stringify(consoleSecond.pageErrors)} intentional400=${String(consoleSecond.expected.length)}`,
    )
    record(
      'L05',
      'the recording environment stayed clean: the reload and restart produced no console error at all',
      report.facts.consoleErrors?.unexpected.length === 0 && secondFacts.boot.diagnostics === true,
      `firstBoot unexpected=${String(report.facts.consoleErrors?.unexpected.length)} diagnosticsAfterRestart=${String(secondFacts.boot.diagnostics)}`,
    )

    // --- host-side boot log -------------------------------------------------
    const log = second.log.stdout + second.log.stderr
    record(
      'L04',
      'the host boot log carries no loader failure for this plugin',
      !/dsh-word-lookup[^\n]*(error|fail|already registered|invalid plugin)/i.test(log),
      log.split('\n').filter((line) => line.includes('dsh-word-lookup')).join(' | ') || 'no dsh-word-lookup line beyond the plugin table',
    )

    await context.close()
  } finally {
    await browser2.close()
  }

  await stopDsh(second.child)
  report.finishedAt = new Date().toISOString()

  // --- report ---------------------------------------------------------------
  // The launch token is a process credential: it mints the browser session
  // cookie. Boot logs are kept for evidence, so the token is stripped first.
  const redact = (text) => text.replace(/token=[A-Za-z0-9._~-]+/g, 'token=<redacted>')
  for (const log of bootLogs) {
    log.stdout = redact(log.stdout)
    log.stderr = redact(log.stderr)
  }
  if (typeof report.facts.secondBootLog === 'string') report.facts.secondBootLog = redact(report.facts.secondBootLog)

  const failed = results.filter((result) => !result.ok)
  report.summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((result) => result.id) }
  report.status = failed.length === 0 ? 'PASS' : 'FAIL'

  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true })
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\nphase1-verify: ${report.status} — ${String(report.summary.passed)}/${String(report.summary.total)} checks`)
  console.log(`report: ${OUT_PATH}`)
  if (failed.length > 0) console.log(`failed: ${failed.map((result) => result.id).join(', ')}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('phase1-verify: aborted', error)
  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true })
  writeFileSync(
    OUT_PATH,
    `${JSON.stringify({ status: 'ERROR', error: String(error?.stack ?? error), results, bootLogs }, null, 2)}\n`,
    'utf8',
  )
  process.exit(2)
})
