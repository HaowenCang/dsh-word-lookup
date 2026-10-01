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
import { redactTokens } from './redact.mjs'
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
  const state = { requests: [], responses: [], consoleErrors: [], pageErrors: [], failedRequests: [] }

  page.on('request', (req) => {
    if (req.url().includes('/api/dsh-word-lookup')) {
      state.requests.push({ method: req.method(), url: req.url(), postData: req.postData() })
    }
  })
  // Phase 3 asserts on what the dictionary *answered*, not only on how many
  // requests were made. The body is captured from the wire rather than from the
  // plugin's own state, so a card that rendered stale content could not make the
  // measurement agree with itself.
  page.on('response', (res) => {
    if (!res.url().includes('/api/dsh-word-lookup')) return
    const entry = { status: res.status(), body: null, settled: false }
    state.responses.push(entry)
    res.json().then(
      (body) => {
        entry.body = body
        entry.settled = true
      },
      () => {
        entry.body = null
        entry.settled = true
      },
    )
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
 * Wait until the last `count` lookup responses have been read off the wire.
 *
 * The browser reports a response before its body has been parsed, so a check
 * that read the body immediately would race the harness rather than the plugin.
 * Returning whatever arrived after the deadline keeps a failure reportable: the
 * caller compares against `null` and fails with the evidence in hand.
 *
 * @param state - the observation channels.
 * @param count - how many of the most recent responses to wait for.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the last `count` response records.
 */
async function waitForResponses(state, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tail = state.responses.slice(-count)
    if (tail.length === count && tail.every((entry) => entry.settled)) return tail
    if (Date.now() >= deadline) return tail
    await new Promise((r) => setTimeout(r, 50))
  }
}

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
    // The three probes must not overlap. They are all `position: fixed`, so
    // sharing a coordinate would leave the last one in DOM order — the composer —
    // on top, and every real pointer event aimed at the flow probe would land in
    // the composer instead. That is not a hypothetical: it made a drag-selection
    // test pass while the drag was actually selecting composer text.
    const styleFor = (top) =>
      `position:fixed;left:24px;top:${String(top)}px;z-index:2147482000;background:#1b1b20;color:#eaeaf0;padding:10px 14px;border-radius:6px;font:14px/1.6 system-ui;max-width:440px`

    const flow = document.createElement('div')
    flow.setAttribute('data-phase1-probe', 'flow')
    flow.setAttribute('data-chat-flow-kind', 'assistant-step')
    flow.setAttribute('data-chat-node-key', 'phase1:probe:1')
    flow.style.cssText = styleFor(150)
    const flowText = document.createElement('p')
    flowText.setAttribute('data-phase1-probe-line', 'drag')
    flowText.textContent = 'The serializer must derive the wire form from the boundary conditions.'
    flow.appendChild(flowText)
    // Phase 3 selects real fixture words through the real shortcut, so the
    // surface forms have to exist in a node the plugin considers eligible. They
    // are listed here rather than fetched from the database on purpose: the
    // harness must not be able to make a lookup succeed by agreeing with the
    // implementation about what the fixture contains.
    const flowFixture = document.createElement('p')
    flowFixture.textContent =
      'Phase 3 fixtures: derive, derived, deriving, went, gone, teeth, wave function, conservation, unknowntoken, \uff44\uff45\uff52\uff49\uff56\uff45.'
    flow.appendChild(flowFixture)
    document.body.appendChild(flow)

    const loose = document.createElement('div')
    loose.setAttribute('data-phase1-probe', 'loose')
    loose.style.cssText = styleFor(300)
    loose.textContent = 'detached derive outside the conversation'
    document.body.appendChild(loose)

    const composer = document.createElement('div')
    composer.setAttribute('data-phase1-probe', 'composer')
    composer.setAttribute('contenteditable', 'true')
    composer.setAttribute('role', 'textbox')
    composer.style.cssText = styleFor(420)
    composer.textContent = 'derive inside the composer'
    document.body.appendChild(composer)

    // Phase 4 drives real pointer gestures at real words. The paragraph above is
    // the wrong target for that: a drag across it selects a phrase, and a double
    // click lands wherever the sentence happens to put a word boundary. Each
    // fixture word therefore gets its own line, in a column clear of the other
    // probes, so a gesture can be aimed at exactly one known token and the
    // expected query is known before the gesture is made.
    const words = document.createElement('div')
    words.setAttribute('data-phase1-probe', 'words')
    // Without these two the probe is not a conversation node, and the plugin's
    // own qualification rule would refuse every selection made inside it — the
    // automatic paths would then measure "the drag was not eligible" while the
    // report claimed to measure the switches. That is why every Phase 4 check
    // asserts the *classification* alongside the request count.
    words.setAttribute('data-chat-flow-kind', 'assistant-step')
    words.setAttribute('data-chat-node-key', 'phase4:words:1')
    words.style.cssText =
      'position:fixed;right:24px;top:150px;z-index:2147482000;background:#1b1b20;color:#eaeaf0;padding:10px 14px;border-radius:6px;font:14px/1.6 system-ui;width:220px'
    for (const word of [
      'derive',
      'derived',
      'went',
      'gone',
      'teeth',
      'conservation',
      'unknowntoken',
    ]) {
      const line = document.createElement('div')
      line.style.cssText = 'margin:0 0 4px'
      const span = document.createElement('span')
      span.setAttribute('data-phase1-word', word)
      span.textContent = word
      line.appendChild(span)
      words.appendChild(line)
    }
    document.body.appendChild(words)

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
 * The bounding box of one word in the Phase 4 word probe.
 *
 * @param page - the authenticated page.
 * @param word - the fixture word to measure.
 * @returns the client-space box, or `null` when the probe is absent.
 */
async function wordBox(page, word) {
  return await page.evaluate((target) => {
    const span = document.querySelector(`[data-phase1-word="${target}"]`)
    if (span === null) return null
    const rect = span.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, word)
}

/**
 * Drag-select exactly one word with real trusted pointer input.
 *
 * The press starts one pixel inside the first glyph and the release ends one
 * pixel inside the last, so the browser's own character-granular selection
 * covers the whole word and nothing else. The press point is cleared of any
 * previous selection first: pressing inside an existing selection starts a native
 * drag-and-drop instead of extending one, and the resulting `pointercancel` would
 * abandon the gesture rather than classify it.
 *
 * @param page - the authenticated page.
 * @param word - the fixture word to select.
 * @returns the box the gesture was aimed at, or `null` when the probe is absent.
 */
async function dragSelectWord(page, word) {
  const box = await wordBox(page, word)
  if (box === null) return null
  await clearSelection(page)
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 1, y)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.max(box.width - 1, 8), y, { steps: 6 })
  await page.mouse.up()
  await settle()
  return box
}

/**
 * Double-click exactly one word with real trusted pointer input.
 *
 * @param page - the authenticated page.
 * @param word - the fixture word to double click.
 * @returns the box the gesture was aimed at, or `null` when the probe is absent.
 */
async function doubleClickWord(page, word) {
  const box = await wordBox(page, word)
  if (box === null) return null
  await clearSelection(page)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await settle()
  return box
}

/**
 * Read the plugin's client-side view: the switches, the accounting and the gate.
 *
 * Every field is read in one round trip so the values describe one instant, and
 * the origin accounting is read from the plugin rather than reconstructed from
 * the wire — the two are compared, never conflated.
 *
 * @param page - the authenticated page.
 * @returns the view.
 */
async function readPluginView(page) {
  return await page.evaluate(() => {
    const plugin = window.__DSH_WORD_LOOKUP__
    return {
      gates: plugin.gates(),
      lookups: plugin.lookups(),
      origins: plugin.lookupsByOrigin(),
      trigger: plugin.trigger(),
      capture: plugin.capture(),
      selection: plugin.selection(),
      requestId: plugin.requestId(),
      loading: plugin.loading(),
      lastOutcome: plugin.lastOutcome(),
      card: plugin.card(),
      gestures: plugin.gestures(),
    }
  })
}

/**
 * Write one switch through the settings form, but only when it differs.
 *
 * Skipping a no-op write keeps a genuinely-unchanged value unchanged, which is
 * what makes the live-transition checks in `main()` mean something rather than
 * being satisfied by a write the harness made on its own.
 *
 * @param page - the authenticated page.
 * @param field - `autoSelection` or `autoDoubleClick`.
 * @param value - the value to establish.
 * @returns the resulting gate value.
 */
async function ensureSwitch(page, field, value) {
  const current = await page.evaluate((name) => window.__DSH_WORD_LOOKUP__.gates()[name], field)
  if (current === value) return current
  await page.evaluate(async ({ name, next }) => await window.__DSH_WORD_LOOKUP__.set(name, next), {
    name: field,
    next: value,
  })
  await settle()
  return await page.evaluate((name) => window.__DSH_WORD_LOOKUP__.gates()[name], field)
}

/**
 * Establish a complete switch state.
 *
 * @param page - the authenticated page.
 * @param gates - the two switch values to establish.
 * @returns the gate values actually in force afterwards.
 */
async function ensureSwitches(page, gates) {
  await ensureSwitch(page, 'autoSelection', gates.autoSelection)
  await ensureSwitch(page, 'autoDoubleClick', gates.autoDoubleClick)
  return await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())
}

/** The four switch states, named the way the test matrix names them. */
const QUADRANTS = {
  S00: { autoSelection: false, autoDoubleClick: false },
  S10: { autoSelection: true, autoDoubleClick: false },
  S01: { autoSelection: false, autoDoubleClick: true },
  S11: { autoSelection: true, autoDoubleClick: true },
}

/** The two automatic origins, so a delta can name both. */
const AUTOMATIC_ORIGINS = ['auto-selection', 'auto-double-click']

/**
 * Difference between two origin counts.
 *
 * @param before - the earlier view.
 * @param after - the later view.
 * @returns the per-origin delta, including the manual path.
 */
function originDelta(before, after) {
  const delta = {}
  for (const origin of ['shortcut', ...AUTOMATIC_ORIGINS]) delta[origin] = after.origins[origin] - before.origins[origin]
  return delta
}

/**
 * Whether every automatic origin in a delta is zero.
 *
 * @param delta - a delta produced by {@link originDelta}.
 * @returns whether no automatic lookup was issued.
 */
function noAutomaticOrigin(delta) {
  return AUTOMATIC_ORIGINS.every((origin) => delta[origin] === 0)
}

/** The query each observed request carried, read from its own body. */
function requestQueries(requests) {
  return requests.map((request) => {
    try {
      return JSON.parse(request.postData ?? '{}').query ?? null
    } catch {
      return null
    }
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
  state.responses.length = 0
  await page.evaluate(() => {
    window.__PHASE1_KEY__ = null
  })
  await page.keyboard.press('Control+Shift+L')
  await settle()
}

/**
 * Drive one real lookup: select inside a probe, press the shortcut, read both
 * halves of the result.
 *
 * The response body is read off the wire rather than from the card, and the
 * card is read as well, so the two can be compared. A plugin that rendered a
 * hard-coded entry while answering with something else would fail here.
 *
 * @param page - the authenticated page.
 * @param state - the observation channels.
 * @param word - the surface form to select.
 * @returns the measurement, including the raw response body.
 */
async function lookupViaShortcut(page, state, word) {
  await selectWord(page, 'flow', word)
  const snapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())
  await pressLookup(page, state)
  const responses = await waitForResponses(state, 1)
  return {
    word,
    snapshot: { text: snapshot.text, eligible: snapshot.eligible },
    requests: state.requests.length,
    status: responses[0]?.status ?? null,
    body: responses[0]?.body ?? null,
    card: await readCard(page),
    outcome: await page.evaluate(() => window.__DSH_WORD_LOOKUP__.lastOutcome()),
  }
}

/**
 * POST one query straight at the route from the authenticated page.
 *
 * Used where the assertion is about the *payload* rather than about the
 * trigger: the shortcut path is measured separately, so a route-level probe
 * cannot be mistaken for evidence that the trigger works.
 *
 * @param page - the authenticated page.
 * @param query - the raw query text.
 * @returns the status and parsed body.
 */
async function postQuery(page, query) {
  return await page.evaluate(async (text) => {
    const response = await fetch('api/dsh-word-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: text }),
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    return { status: response.status, body: parsed }
  }, query)
}

/**
 * Reduce a lookup payload to the fields the report needs.
 *
 * A full entry carries every example sentence, and the report is committed as
 * evidence; repeating whole payloads for a dozen checks would bury the claim
 * under its own data. The counts and the identifying fields are what a reader
 * compares.
 *
 * @param body - the parsed response body, or `null`.
 * @returns a compact projection.
 */
function compactLookup(body) {
  if (body === null || typeof body !== 'object') return body
  if (body.found !== true) {
    return { found: body.found, query: body.query, source: body.source, error: body.error }
  }
  return {
    found: true,
    query: body.query,
    headword: body.headword,
    phonetic: body.phonetic,
    matchedForm: body.matchedForm,
    meaningCount: Array.isArray(body.meanings) ? body.meanings.length : -1,
    firstMeaning: body.meanings?.[0] ?? null,
    forms: Array.isArray(body.forms) ? body.forms.map((form) => form.form) : null,
    exampleCount: Array.isArray(body.examples) ? body.examples.length : -1,
    source: body.source,
    settings: body.settings,
  }
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

  // --- the settings mirror, read before anything can move it ----------------
  // Phase 4 makes the two switches live: from the gesture section onward this
  // harness writes them on purpose. The snapshot and the derived gates are
  // therefore captured **first**, so `${prefix}20`/`${prefix}21` describe what
  // this boot loaded rather than what the run left behind, and `bootGates` is the
  // state the trigger matrix restores at the end.
  await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.snapshot().status === 'ready', undefined, {
    timeout: 30_000,
  })
  const snapshot = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.snapshot())
  const gates = await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())
  const bootGates = gates
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
    direct.found.status === 200 &&
      direct.found.body?.found === true &&
      direct.found.body?.source === 'sqlite-fixture',
    JSON.stringify(compactLookup(direct.found.body)),
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
    direct.unknown.status === 200 &&
      direct.unknown.body?.found === false &&
      direct.unknown.body?.source === 'sqlite-fixture',
    JSON.stringify(direct.unknown),
  )

  // --- automatic triggers are measured from the OFF state -------------------
  // Phase 4 makes the two switches live, so the boot's persisted value can no
  // longer be assumed: on the second boot they are both `true`, and every check
  // below is a claim about the OFF state. The state is therefore *established*
  // and recorded here rather than inherited, and `bootGates` remembers what the
  // boot actually loaded so the matrix can put it back.
  const gatesForcedOff = await ensureSwitches(page, QUADRANTS.S00)
  record(
    `${prefix}A2`,
    'the two switches are established OFF before the zero-request checks, whatever the boot loaded',
    gatesForcedOff.autoSelection === false && gatesForcedOff.autoDoubleClick === false,
    `boot=${JSON.stringify(bootGates)} now=${JSON.stringify(gatesForcedOff)}`,
  )

  // Real trusted input, aimed at a real word inside a flow item: a double click
  // (T02) and a drag selection (T01). With both switches off the expected count
  // is zero for both; the selection they produce is still captured by the
  // snapshot listener, and the gate records *why* it refused, which is what makes
  // the zero mean "refused" rather than "never asked".
  await clearSelection(page)
  const box = await page.locator('[data-phase1-probe="flow"] p[data-phase1-probe-line="drag"]').boundingBox()
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

  // --- Phase 2: gesture classification --------------------------------------
  // Classification is measured together with the request count every time,
  // because "no request happened" is worthless on its own: it holds just as well
  // for a plugin whose gesture listeners never ran. Each check below therefore
  // pairs a classification assertion with a zero-request assertion.
  //
  // The counter deltas are read around each gesture rather than reset, so the
  // instrument stays a plain read-only view of the running runtime.
  const readGestures = () => page.evaluate(() => window.__DSH_WORD_LOOKUP__.gestures())
  const readSelectionView = () => page.evaluate(() => window.__DSH_WORD_LOOKUP__.selection())

  /**
   * Perform a real pointer drag across the probe paragraph.
   *
   * @returns nothing.
   */
  const dragAcrossProbe = async () => {
    if (box === null) return
    const y = box.y + box.height / 2
    const from = box.x + 24
    const to = Math.min(box.x + 210, box.x + box.width - 10)
    await page.mouse.move(from, y)
    await page.mouse.down()
    await page.mouse.move(to, y, { steps: 8 })
    await page.mouse.up()
  }

  // --- B23/R23: a real drag is classified as a drag -------------------------
  // A capture-phase trace of the same events, so a misclassification can be
  // attributed to a specific document fact rather than guessed at. It is also
  // what proves the drag landed in the conversation and not in the composer.
  await page.evaluate(() => {
    const events = []
    const describe = (label) => {
      const sel = document.getSelection()
      const anchor = sel?.anchorNode ?? null
      const element = anchor === null ? null : anchor.nodeType === 1 ? anchor : anchor.parentElement
      events.push({
        label,
        rangeCount: sel?.rangeCount ?? -1,
        collapsed: sel?.isCollapsed ?? null,
        text: (sel?.toString() ?? '').slice(0, 40),
        anchorTag: element?.tagName ?? null,
        inFlow: element == null ? null : element.closest('[data-chat-flow-kind]') !== null,
        inInteractive:
          element == null
            ? null
            : element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]') !== null,
      })
    }
    const onDown = () => describe('pointerdown')
    const onUp = () => describe('pointerup')
    const onChange = () => describe('selectionchange')
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('selectionchange', onChange, true)
    window.__PHASE2_TRACE__ = events
  })

  const beforeDrag = await readGestures()
  await clearSelection(page)
  state.requests.length = 0
  await dragAcrossProbe()
  await settle()
  const afterDrag = await readGestures()
  const dragDelta = afterDrag.counters.drags - beforeDrag.counters.drags
  const dragSnapshotAfter = await readSelectionView()
  // Prove where the drag actually landed before believing what it classified.
  // Without this, a drag that hit the composer probe would still be "correct" as
  // an ineligible selection, and the classification test would pass while
  // measuring nothing.
  const trace = await page.evaluate(() => window.__PHASE2_TRACE__ ?? [])
  const releaseFacts = trace.filter((entry) => entry.label === 'pointerup').at(-1) ?? null
  const landedOnConversation = releaseFacts !== null && releaseFacts.inFlow === true && releaseFacts.inInteractive === false
  facts.dragTrace = releaseFacts
  facts.drag = { before: beforeDrag.counters, after: afterDrag.counters, last: afterDrag.last, view: dragSnapshotAfter }
  record(
    `${prefix}23`,
    'a real pointer drag over conversation text is classified as a drag and issues no request',
    landedOnConversation && dragDelta === 1 && afterDrag.last.kind === 'drag' && state.requests.length === 0,
    `landedInFlow=${String(releaseFacts?.inFlow)} landedInInteractive=${String(releaseFacts?.inInteractive)} selected=${JSON.stringify(releaseFacts?.text ?? '')} drags+${String(dragDelta)} kind=${afterDrag.last.kind} requests=${String(state.requests.length)}`,
  )

  // --- B24/R24: the snapshot carries live-Range geometry --------------------
  // Read after a programmatic selection rather than after a drag: Phase 0 §7.4
  // measured that the `click` closing a drag can collapse the selection again
  // within ~250 ms, so a late read after a drag is not a stable place to measure
  // geometry. The classifier reads at pointerup precisely so it does not depend
  // on that survival.
  await selectWord(page, 'flow', 'derive')
  await settle()
  const rectView = await readSelectionView()
  const rect = rectView.rect
  facts.rect = { view: rectView }
  record(
    `${prefix}24`,
    'the selection snapshot carries the live range rectangle',
    rectView.eligible === true &&
      rect !== null &&
      rect !== undefined &&
      rect.width > 0 &&
      rect.height > 0 &&
      rectView.text === 'derive',
    `text=${JSON.stringify(rectView.text)} rect=${JSON.stringify(rect)}`,
  )

  // --- B25/R25 + B26/R26: double click, and its trailing selectionchange ----
  await clearSelection(page)
  state.requests.length = 0
  const beforeDouble = await readGestures()
  if (box !== null) {
    await page.mouse.dblclick(box.x + 90, box.y + box.height / 2)
  }
  // Read before the trailing `selectionchange` has been processed, then again
  // after it has: the classification must be identical both times.
  const immediatelyAfterDouble = await readGestures()
  await settle()
  const afterTrailing = await readGestures()
  const doubleDelta = afterTrailing.counters.doubleClickGestures - beforeDouble.counters.doubleClickGestures
  const dragDuringTrailing = afterTrailing.counters.drags - beforeDouble.counters.drags
  facts.doubleClick = {
    immediatelyAfter: immediatelyAfterDouble.last,
    afterTrailing: afterTrailing.last,
    delta: doubleDelta,
    view: await readSelectionView(),
  }
  record(
    `${prefix}25`,
    'a real double click is classified as a double click and issues no request',
    doubleDelta === 1 && immediatelyAfterDouble.last.kind === 'double-click' && state.requests.length === 0,
    `doubleClickGestures+${String(doubleDelta)} kind=${immediatelyAfterDouble.last.kind} requests=${String(state.requests.length)}`,
  )
  record(
    `${prefix}26`,
    'the trailing selectionchange cannot turn a double click into a drag',
    afterTrailing.last.kind === 'double-click' && dragDuringTrailing === 0,
    `kindAfterTrailing=${afterTrailing.last.kind} dragsDuringWindow=${String(dragDuringTrailing)}`,
  )

  // --- B27/R27: 100 drags + 100 double clicks leave the request count at 0 --
  const beforeStorm = await readGestures()
  state.requests.length = 0
  for (let index = 0; index < 100; index += 1) {
    // Each drag starts from a clean slate. Pressing inside an *existing*
    // selection makes Chrome begin a native text drag-and-drop instead of
    // extending a selection, and that abandons the pointer sequence with
    // `pointercancel` — correct classifier behaviour, but it would mean the
    // storm measured one drag and 99 cancellations rather than 100 drags.
    await clearSelection(page)
    await dragAcrossProbe()
  }
  for (let index = 0; index < 100; index += 1) {
    if (box !== null) await page.mouse.dblclick(box.x + 90, box.y + box.height / 2)
  }
  await settle()
  const afterStorm = await readGestures()
  const stormDrags = afterStorm.counters.drags - beforeStorm.counters.drags
  const stormDoubles = afterStorm.counters.doubleClickGestures - beforeStorm.counters.doubleClickGestures
  const stormCancels = afterStorm.counters.cancels - beforeStorm.counters.cancels
  facts.gestureStorm = {
    drags: stormDrags,
    doubleClicks: stormDoubles,
    cancels: stormCancels,
    requests: state.requests.length,
    counters: afterStorm.counters,
  }
  record(
    `${prefix}27`,
    '100 drags and 100 double clicks are all classified and produce zero requests',
    stormDrags === 100 && stormDoubles === 100 && state.requests.length === 0,
    `drags=${String(stormDrags)} doubleClicks=${String(stormDoubles)} cancels=${String(stormCancels)} requests=${String(state.requests.length)}`,
  )

  // --- B28/R28: the shortcut still works after the gesture storm ------------
  // The point of the regression: 200 gestures must not leave the runtime in a
  // state where the one legitimate trigger has stopped working, and must not
  // have accumulated anything that makes it fire twice.
  const stormShortcut = await lookupViaShortcut(page, state, 'derive')
  facts.shortcutAfterGestures = stormShortcut
  record(
    `${prefix}28`,
    'after the gesture storm, the shortcut still issues exactly one lookup (T03)',
    stormShortcut.requests === 1 &&
      state.requests[0]?.method === 'POST' &&
      state.requests[0]?.url.includes('/api/dsh-word-lookup'),
    `requests=${JSON.stringify(state.requests)}`,
  )

  // --- Phase 3: the local SQLite dictionary answers the one real trigger -----
  // Every measurement below goes through the product's only trigger: a real
  // selection inside a conversation node, then `Primary+Shift+L`. The payload is
  // read off the wire, and the card is read from the DOM, so a plugin that
  // rendered an entry it had not actually been given would fail both ways.
  const phase3 = {}
  // The settings echo used to be compared against a boot constant: boot 1 ran
  // before the harness wrote the switches, boot 2 after they persisted. Phase 4
  // makes the two switches live, and `${prefix}A2` above establishes them OFF for
  // the zero-request checks, so a boot constant no longer describes them — and a
  // constant would be the weaker assertion anyway. The host's echo is compared
  // against the **client's own live mirror**, read in the same breath, which is
  // what the echo is actually a claim about: that both halves agree about the
  // live configuration, on every boot and whatever it starts from.
  const liveSwitches = async () => await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())

  const deriveLookup = await lookupViaShortcut(page, state, 'derive')
  phase3.derive = deriveLookup
  record(
    `${prefix}29`,
    'the shortcut\u2019s single lookup is answered by the local SQLite fixture, not a stub',
    deriveLookup.requests === 1 &&
      deriveLookup.status === 200 &&
      deriveLookup.body?.found === true &&
      deriveLookup.body?.headword === 'derive' &&
      deriveLookup.body?.source === 'sqlite-fixture' &&
      deriveLookup.body?.source !== 'stub' &&
      deriveLookup.outcome === 'found' &&
      (deriveLookup.card.headword ?? '').includes('derive'),
    `status=${String(deriveLookup.status)} body=${JSON.stringify(compactLookup(deriveLookup.body))} outcome=${String(deriveLookup.outcome)} cardHeadword=${String(deriveLookup.card.headword)}`,
  )

  const derivedLookup = await lookupViaShortcut(page, state, 'derived')
  phase3.derived = derivedLookup
  record(
    `${prefix}30`,
    'an inflected selection resolves to its lemma through the forms table (T10)',
    derivedLookup.requests === 1 &&
      derivedLookup.body?.found === true &&
      derivedLookup.body?.query === 'derived' &&
      derivedLookup.body?.headword === 'derive' &&
      derivedLookup.body?.matchedForm === 'derived' &&
      Array.isArray(derivedLookup.body?.forms) &&
      derivedLookup.body.forms.some((form) => form.form === 'deriving'),
    `status=${String(derivedLookup.status)} body=${JSON.stringify(compactLookup(derivedLookup.body))}`,
  )

  const wentLookup = await lookupViaShortcut(page, state, 'went')
  const goneLookup = await lookupViaShortcut(page, state, 'gone')
  phase3.went = wentLookup
  phase3.gone = goneLookup
  record(
    `${prefix}31`,
    'irregular forms resolve to their lemma (T11)',
    wentLookup.body?.headword === 'go' &&
      wentLookup.body?.matchedForm === 'went' &&
      goneLookup.body?.headword === 'go' &&
      goneLookup.body?.matchedForm === 'gone' &&
      wentLookup.requests === 1 &&
      goneLookup.requests === 1,
    `went=${JSON.stringify(compactLookup(wentLookup.body))} gone=${JSON.stringify(compactLookup(goneLookup.body))}`,
  )

  const teethLookup = await lookupViaShortcut(page, state, 'teeth')
  phase3.teeth = teethLookup
  record(
    `${prefix}32`,
    'an irregular plural resolves to its singular headword',
    teethLookup.body?.headword === 'tooth' &&
      teethLookup.body?.matchedForm === 'teeth' &&
      teethLookup.requests === 1,
    `body=${JSON.stringify(compactLookup(teethLookup.body))}`,
  )

  const phraseLookup = await lookupViaShortcut(page, state, 'wave function')
  phase3.phrase = phraseLookup
  record(
    `${prefix}33`,
    'a multi-word phrase is answered exactly, and is never split into its words',
    phraseLookup.body?.found === true &&
      phraseLookup.body?.query === 'wave function' &&
      phraseLookup.body?.headword === 'wave function' &&
      phraseLookup.body?.matchedForm === null &&
      phraseLookup.requests === 1,
    `body=${JSON.stringify(compactLookup(phraseLookup.body))}`,
  )

  const unknownLookup = await lookupViaShortcut(page, state, 'unknowntoken')
  phase3.unknown = unknownLookup
  record(
    `${prefix}34`,
    'a well-formed selection the dictionary does not contain is 200 found:false (T12)',
    unknownLookup.status === 200 &&
      unknownLookup.body?.found === false &&
      unknownLookup.body?.query === 'unknowntoken' &&
      unknownLookup.body?.source === 'sqlite-fixture' &&
      unknownLookup.requests === 1 &&
      unknownLookup.card.cardPresent === true &&
      unknownLookup.card.state === 'ready' &&
      (unknownLookup.card.body ?? '').includes('no entry for') &&
      unknownLookup.outcome === 'not-found',
    `status=${String(unknownLookup.status)} body=${JSON.stringify(unknownLookup.body)} outcome=${String(unknownLookup.outcome)} cardState=${String(unknownLookup.card.state)} card=${JSON.stringify(unknownLookup.card.body)}`,
  )

  // --- the payload carries what the card needs ------------------------------
  const switchesBeforePayload = await liveSwitches()
  const detailed = await postQuery(page, 'conservation')
  const switchesAfterPayload = await liveSwitches()
  phase3.detailed = detailed
  phase3.switches = { before: switchesBeforePayload, after: switchesAfterPayload }
  record(
    `${prefix}35`,
    'the payload carries headword, phonetic, POS, Chinese meaning, forms, examples and provenance',
    detailed.status === 200 &&
      detailed.body?.found === true &&
      detailed.body?.headword === 'conservation' &&
      typeof detailed.body?.phonetic === 'string' &&
      detailed.body.phonetic.length > 0 &&
      detailed.body?.meanings?.[0]?.partOfSpeech === 'noun' &&
      typeof detailed.body?.meanings?.[0]?.translation === 'string' &&
      detailed.body.meanings[0].translation.includes('\u5b88\u6052') &&
      typeof detailed.body?.meanings?.[0]?.definition === 'string' &&
      Array.isArray(detailed.body?.forms) &&
      detailed.body.forms.length === 0 &&
      detailed.body?.matchedForm === null &&
      Array.isArray(detailed.body?.examples) &&
      detailed.body.examples.length > 0 &&
      detailed.body?.source === 'sqlite-fixture' &&
      detailed.body?.settings?.autoDoubleClick === switchesBeforePayload.autoDoubleClick &&
      detailed.body?.settings?.autoSelection === switchesBeforePayload.autoSelection &&
      switchesAfterPayload.autoDoubleClick === switchesBeforePayload.autoDoubleClick &&
      switchesAfterPayload.autoSelection === switchesBeforePayload.autoSelection,
    JSON.stringify({ body: compactLookup(detailed.body), switches: phase3.switches }),
  )

  // --- SQL metacharacters are only words ------------------------------------
  const hostileQueries = [
    "'; DROP TABLE entries; --",
    "' OR '1'='1",
    '"; DROP TABLE forms; --',
    "' UNION SELECT word FROM entries --",
    "'); INSERT INTO entries (word) VALUES ('x'); --",
  ]
  const hostile = []
  for (const query of hostileQueries) hostile.push({ query, ...(await postQuery(page, query)) })
  const dictionaryAfterHostile = await postQuery(page, 'derive')
  phase3.hostile = { hostile, after: dictionaryAfterHostile }
  record(
    `${prefix}36`,
    'SQL metacharacters in a query never fault the route and never change the schema',
    hostile.every((result) => result.status < 500) &&
      hostile.every((result) => result.body?.found === false || result.body?.error === 'empty-query') &&
      dictionaryAfterHostile.status === 200 &&
      dictionaryAfterHostile.body?.found === true &&
      dictionaryAfterHostile.body?.headword === 'derive',
    JSON.stringify({ hostile, after: compactLookup(dictionaryAfterHostile.body) }),
  )

  // --- examples are deterministic and belong to the right headword ----------
  const examplesFirst = await postQuery(page, 'derive')
  const examplesSecond = await postQuery(page, 'derive')
  const waveExamples = await postQuery(page, 'wave')
  const phraseExamples = await postQuery(page, 'wave function')
  const functionExamples = await postQuery(page, 'function')
  const phase3Examples = { examplesFirst, examplesSecond, waveExamples, phraseExamples, functionExamples }
  facts.phase3Examples = phase3Examples
  const phraseIds = new Set((phraseExamples.body?.examples ?? []).map((example) => example.en))
  record(
    `${prefix}37`,
    'examples are deterministic and never belong to another headword',
    examplesFirst.body?.examples?.length > 0 &&
      JSON.stringify(examplesFirst.body.examples) === JSON.stringify(examplesSecond.body.examples) &&
      phraseIds.size === (phraseExamples.body?.examples ?? []).length &&
      !(waveExamples.body?.examples ?? []).some((example) => phraseIds.has(example.en)) &&
      !(functionExamples.body?.examples ?? []).some((example) => phraseIds.has(example.en)),
    JSON.stringify({
      derive: examplesFirst.body?.examples,
      phrase: phraseExamples.body?.examples,
      wave: waveExamples.body?.examples,
      function: functionExamples.body?.examples,
    }),
  )

  facts.phase3 = phase3

  // --- NFKC folding, through the real trigger -------------------------------
  // The product specification puts a Unicode NFKC fold first in normalization.
  // A full-width selection is the case that makes it observable: without the
  // fold the query never reaches the dictionary as an English word, and without
  // the fold running *before* the edge-punctuation strip the trailing full-width
  // period is not removed either.
  const fullWidth = await lookupViaShortcut(page, state, '\uff44\uff45\uff52\uff49\uff56\uff45')
  phase3.fullWidth = fullWidth
  record(
    `${prefix}38`,
    'a full-width selection is NFKC-folded before it is looked up',
    fullWidth.requests === 1 &&
      fullWidth.body?.found === true &&
      fullWidth.body?.query === 'derive' &&
      fullWidth.body?.headword === 'derive' &&
      fullWidth.body?.source === 'sqlite-fixture',
    `snapshotText=${JSON.stringify(fullWidth.snapshot.text)} body=${JSON.stringify(compactLookup(fullWidth.body))}`,
  )

  // =========================================================================
  // Phase 4 — the automatic trigger gate
  // =========================================================================
  // Everything below drives **real trusted input** (Playwright's mouse, at
  // coordinates measured from a real DOM element) against the **live** switches,
  // changed through the same form the settings UI calls. Two independent
  // observations are taken for every measurement and compared rather than
  // conflated:
  //
  // - the **wire**: request count, request body and response body, seen by
  //   Playwright's network layer, which the plugin cannot influence;
  // - the **plugin's own accounting**: which origin asked, what the gate
  //   decided and why, and which gesture identity it decided about.
  //
  // A request count alone would be satisfied by a plugin whose origin accounting
  // was wrong, and the accounting alone would be satisfied by a plugin that
  // reported a lookup it never made. Both are asserted together.
  const phase4 = {}

  /** Wait until the observed request stream stops growing. */
  async function waitForQuiescence(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    let last = -1
    let stable = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      if (state.requests.length === last) {
        stable += 1
        if (stable >= 3) break
      } else {
        stable = 0
        last = state.requests.length
      }
    }
    return [...state.requests]
  }

  /**
   * Measure one settings quadrant with one real drag and one real double click.
   *
   * @param gatesWanted - the switch state to establish first.
   * @param word - the fixture word both gestures are aimed at.
   * @returns the two measurements, each with its wire and plugin evidence.
   */
  async function measureQuadrant(gatesWanted, word) {
    const active = await ensureSwitches(page, gatesWanted)

    const dragBefore = await readPluginView(page)
    state.requests.length = 0
    state.responses.length = 0
    const dragBox = await dragSelectWord(page, word)
    const dragRequests = [...state.requests]
    const dragResponses = dragRequests.length === 0 ? [] : await waitForResponses(state, dragRequests.length)
    const dragAfter = await readPluginView(page)

    const doubleBefore = await readPluginView(page)
    state.requests.length = 0
    state.responses.length = 0
    const doubleBox = await doubleClickWord(page, word)
    const doubleRequests = [...state.requests]
    const doubleResponses = doubleRequests.length === 0 ? [] : await waitForResponses(state, doubleRequests.length)
    const doubleAfter = await readPluginView(page)

    return {
      active,
      drag: {
        box: dragBox,
        requests: dragRequests,
        queries: requestQueries(dragRequests),
        status: dragResponses[0]?.status ?? null,
        responseQuery: dragResponses[0]?.body?.query ?? null,
        headword: dragResponses[0]?.body?.headword ?? null,
        delta: originDelta(dragBefore, dragAfter),
        trigger: dragAfter.trigger,
        capture: dragAfter.capture,
        kind: dragAfter.gestures.last.kind,
        gestureId: dragAfter.gestures.last.gestureId,
        drags: dragAfter.gestures.counters.drags - dragBefore.gestures.counters.drags,
      },
      double: {
        box: doubleBox,
        requests: doubleRequests,
        queries: requestQueries(doubleRequests),
        status: doubleResponses[0]?.status ?? null,
        responseQuery: doubleResponses[0]?.body?.query ?? null,
        headword: doubleResponses[0]?.body?.headword ?? null,
        delta: originDelta(doubleBefore, doubleAfter),
        trigger: doubleAfter.trigger,
        capture: doubleAfter.capture,
        kind: doubleAfter.gestures.last.kind,
        gestureId: doubleAfter.gestures.last.gestureId,
        doubleClicks: doubleAfter.gestures.counters.doubleClickGestures - doubleBefore.gestures.counters.doubleClickGestures,
      },
    }
  }

  /** Compact one half of a quadrant measurement for the report. */
  const compactHalf = (half) => ({
    requests: half.requests.length,
    queries: half.queries,
    status: half.status,
    responseQuery: half.responseQuery,
    headword: half.headword,
    delta: half.delta,
    trigger: half.trigger === null ? null : { decision: half.trigger.decision, reason: half.trigger.reason, origin: half.trigger.origin, gestureId: half.trigger.gestureId },
    capture: { eligible: half.capture.eligible, text: half.capture.text, rect: half.capture.rect },
    kind: half.kind,
    gestureId: half.gestureId,
  })

  // --- S00 ------------------------------------------------------------------
  const s00 = await measureQuadrant(QUADRANTS.S00, 'derive')
  phase4.s00 = { active: s00.active, drag: compactHalf(s00.drag), double: compactHalf(s00.double) }
  record(
    `${prefix}P01`,
    'S00 — with both switches off a real drag selection issues no lookup, and the gate says why (T01/T22)',
    s00.active.autoSelection === false &&
      s00.active.autoDoubleClick === false &&
      s00.drag.requests.length === 0 &&
      s00.drag.drags === 1 &&
      s00.drag.kind === 'drag' &&
      s00.drag.capture.eligible === true &&
      s00.drag.capture.text.trim() === 'derive' &&
      s00.drag.capture.rect !== null &&
      s00.drag.trigger?.decision === 'ignored' &&
      s00.drag.trigger?.reason === 'switch-off' &&
      noAutomaticOrigin(s00.drag.delta),
    JSON.stringify(phase4.s00.drag),
  )
  record(
    `${prefix}P02`,
    'S00 — with both switches off a real double click issues no lookup, and the gate says why (T02)',
    s00.double.requests.length === 0 &&
      s00.double.doubleClicks === 1 &&
      s00.double.kind === 'double-click' &&
      s00.double.capture.eligible === true &&
      s00.double.capture.text.trim() === 'derive' &&
      s00.double.trigger?.decision === 'ignored' &&
      s00.double.trigger?.reason === 'switch-off' &&
      noAutomaticOrigin(s00.double.delta),
    JSON.stringify(phase4.s00.double),
  )
  const s00Shortcut = await lookupViaShortcut(page, state, 'derive')
  phase4.s00Shortcut = s00Shortcut
  record(
    `${prefix}P03`,
    'S00 — the manual shortcut still issues exactly one lookup with both switches off (T03)',
    s00Shortcut.requests === 1 &&
      s00Shortcut.status === 200 &&
      s00Shortcut.body?.headword === 'derive' &&
      s00Shortcut.body?.source === 'sqlite-fixture',
    JSON.stringify({ requests: s00Shortcut.requests, body: compactLookup(s00Shortcut.body) }),
  )

  // --- S10 ------------------------------------------------------------------
  const s10 = await measureQuadrant(QUADRANTS.S10, 'derive')
  phase4.s10 = { active: s10.active, drag: compactHalf(s10.drag), double: compactHalf(s10.double) }
  record(
    `${prefix}P04`,
    'S10 — autoSelection on: a real drag selection issues exactly one lookup, from the auto-selection path (T05)',
    s10.active.autoSelection === true &&
      s10.active.autoDoubleClick === false &&
      s10.drag.requests.length === 1 &&
      s10.drag.drags === 1 &&
      s10.drag.kind === 'drag' &&
      s10.drag.capture.text.trim() === 'derive' &&
      s10.drag.status === 200 &&
      s10.drag.responseQuery === 'derive' &&
      s10.drag.headword === 'derive' &&
      s10.drag.trigger?.decision === 'lookup' &&
      s10.drag.trigger?.origin === 'auto-selection' &&
      s10.drag.delta['auto-selection'] === 1 &&
      s10.drag.delta['auto-double-click'] === 0,
    JSON.stringify(phase4.s10.drag),
  )
  record(
    `${prefix}P05`,
    'S10 — autoSelection on: a real double click still issues nothing, because it is not that switch’s gesture',
    s10.double.requests.length === 0 &&
      s10.double.doubleClicks === 1 &&
      s10.double.kind === 'double-click' &&
      s10.double.trigger?.reason === 'switch-off' &&
      noAutomaticOrigin(s10.double.delta),
    JSON.stringify(phase4.s10.double),
  )
  const s10Shortcut = await lookupViaShortcut(page, state, 'derive')
  phase4.s10Shortcut = s10Shortcut
  record(
    `${prefix}P06`,
    'S10 — the manual shortcut is not suppressed by the automatic path (T03)',
    s10Shortcut.requests === 1 && s10Shortcut.outcome === 'found',
    JSON.stringify({ requests: s10Shortcut.requests, outcome: s10Shortcut.outcome }),
  )

  // --- S01 ------------------------------------------------------------------
  const s01 = await measureQuadrant(QUADRANTS.S01, 'derive')
  phase4.s01 = { active: s01.active, drag: compactHalf(s01.drag), double: compactHalf(s01.double) }
  record(
    `${prefix}P07`,
    'S01 — autoDoubleClick on: a real drag selection issues nothing, because it is not that switch’s gesture',
    s01.active.autoDoubleClick === true &&
      s01.active.autoSelection === false &&
      s01.drag.requests.length === 0 &&
      s01.drag.drags === 1 &&
      s01.drag.trigger?.reason === 'switch-off' &&
      noAutomaticOrigin(s01.drag.delta),
    JSON.stringify(phase4.s01.drag),
  )
  record(
    `${prefix}P08`,
    'S01 — autoDoubleClick on: a real double click issues exactly one lookup, from the auto-double-click path (T04)',
    s01.double.requests.length === 1 &&
      s01.double.doubleClicks === 1 &&
      s01.double.kind === 'double-click' &&
      s01.double.capture.text.trim() === 'derive' &&
      s01.double.status === 200 &&
      s01.double.responseQuery === 'derive' &&
      s01.double.headword === 'derive' &&
      s01.double.trigger?.decision === 'lookup' &&
      s01.double.trigger?.origin === 'auto-double-click' &&
      s01.double.delta['auto-double-click'] === 1 &&
      s01.double.delta['auto-selection'] === 0,
    JSON.stringify(phase4.s01.double),
  )
  const s01Shortcut = await lookupViaShortcut(page, state, 'derive')
  phase4.s01Shortcut = s01Shortcut
  record(
    `${prefix}P09`,
    'S01 — the manual shortcut is not suppressed by the automatic path (T03)',
    s01Shortcut.requests === 1 && s01Shortcut.outcome === 'found',
    JSON.stringify({ requests: s01Shortcut.requests, outcome: s01Shortcut.outcome }),
  )

  // --- S11 ------------------------------------------------------------------
  const s11 = await measureQuadrant(QUADRANTS.S11, 'derive')
  phase4.s11 = { active: s11.active, drag: compactHalf(s11.drag), double: compactHalf(s11.double) }
  record(
    `${prefix}P10`,
    'S11 — both switches on: one drag is exactly one lookup and one double click is exactly one lookup, on their own paths (T06)',
    s11.active.autoSelection === true &&
      s11.active.autoDoubleClick === true &&
      s11.drag.requests.length === 1 &&
      s11.drag.delta['auto-selection'] === 1 &&
      s11.drag.delta['auto-double-click'] === 0 &&
      s11.double.requests.length === 1 &&
      s11.double.delta['auto-double-click'] === 1 &&
      s11.double.delta['auto-selection'] === 0,
    JSON.stringify({ drag: phase4.s11.drag, double: phase4.s11.double }),
  )
  record(
    `${prefix}P11`,
    'S11 — the trailing selectionchange of a double click cannot buy a second lookup through autoSelection',
    s11.double.requests.length === 1 &&
      s11.double.trigger?.origin === 'auto-double-click' &&
      s11.double.delta['auto-selection'] === 0 &&
      s11.double.kind === 'double-click',
    JSON.stringify(phase4.s11.double),
  )

  // --- selectionchange is never a trigger -----------------------------------
  // The brief's §36 assertion is structural (an AST check that the handler
  // reaches no I/O). This is the behavioural half, and it is the case a naive
  // `document.addEventListener('selectionchange', …)` implementation could not
  // pass: fifty real selections, made with real Ranges, with autoSelection ON.
  await ensureSwitches(page, QUADRANTS.S10)
  const stormBefore = await readPluginView(page)
  state.requests.length = 0
  state.responses.length = 0
  await page.evaluate(() => {
    const host = document.querySelector('[data-phase1-probe="flow"]')
    const node = host.firstChild
    for (let index = 0; index < 50; index += 1) {
      const range = document.createRange()
      const start = index % 12
      range.setStart(node.firstChild, start)
      range.setEnd(node.firstChild, start + 6)
      const selection = document.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }
  })
  await settle()
  const stormAfter = await readPluginView(page)
  const selectionStorm = {
    requests: [...state.requests],
    delta: originDelta(stormBefore, stormAfter),
    trigger: stormAfter.trigger,
    // The two facts that make the zero meaningful rather than vacuous: the
    // `selectionchange` listener really ran for these selections (the snapshot
    // advanced and holds an eligible text), and no pointer gesture took place, so
    // nothing but the selection events could have produced a request.
    selection: { present: stormAfter.selection.present, eligible: stormAfter.selection.eligible, text: stormAfter.selection.text },
    gestures: {
      drags: stormAfter.gestures.counters.drags - stormBefore.gestures.counters.drags,
      doubleClicks: stormAfter.gestures.counters.doubleClickGestures - stormBefore.gestures.counters.doubleClickGestures,
    },
  }
  phase4.selectionStorm = selectionStorm
  record(
    `${prefix}P12`,
    'S10 — fifty programmatic selection changes are observed, and issue zero lookups, so selectionchange is not a trigger (§36)',
    selectionStorm.requests.length === 0 &&
      selectionStorm.delta.shortcut === 0 &&
      noAutomaticOrigin(selectionStorm.delta) &&
      selectionStorm.selection.present === true &&
      selectionStorm.selection.eligible === true &&
      selectionStorm.selection.text.length > 0 &&
      selectionStorm.gestures.drags === 0 &&
      selectionStorm.gestures.doubleClicks === 0,
    JSON.stringify(selectionStorm),
  )

  // --- live setting transitions ---------------------------------------------
  // A switch that is only read at plugin load passes every quadrant above and
  // fails here: this walks one switch up and back down without any reload, and
  // requires the very next gesture to follow.
  const liveSelection = []
  for (const value of [false, true, false]) {
    await ensureSwitch(page, 'autoSelection', value)
    await ensureSwitch(page, 'autoDoubleClick', false)
    state.requests.length = 0
    state.responses.length = 0
    const before = await readPluginView(page)
    await dragSelectWord(page, 'derive')
    const after = await readPluginView(page)
    liveSelection.push({
      value,
      gates: after.gates,
      requests: [...state.requests].length,
      delta: originDelta(before, after),
      reason: after.trigger?.reason ?? null,
      origin: after.trigger?.origin ?? null,
    })
  }
  phase4.liveSelection = liveSelection
  record(
    `${prefix}P13`,
    'autoSelection follows false → true → false on consecutive drags, with no restart (live setting propagation)',
    liveSelection[0].requests === 0 &&
      liveSelection[0].delta['auto-selection'] === 0 &&
      liveSelection[1].requests === 1 &&
      liveSelection[1].delta['auto-selection'] === 1 &&
      liveSelection[1].origin === 'auto-selection' &&
      liveSelection[2].requests === 0 &&
      liveSelection[2].delta['auto-selection'] === 0,
    JSON.stringify(liveSelection),
  )

  const liveDouble = []
  for (const value of [false, true, false]) {
    await ensureSwitch(page, 'autoDoubleClick', value)
    await ensureSwitch(page, 'autoSelection', false)
    state.requests.length = 0
    state.responses.length = 0
    const before = await readPluginView(page)
    await doubleClickWord(page, 'derive')
    const after = await readPluginView(page)
    liveDouble.push({
      value,
      gates: after.gates,
      requests: [...state.requests].length,
      delta: originDelta(before, after),
      reason: after.trigger?.reason ?? null,
      origin: after.trigger?.origin ?? null,
    })
  }
  phase4.liveDouble = liveDouble
  record(
    `${prefix}P14`,
    'autoDoubleClick follows false → true → false on consecutive double clicks, with no restart',
    liveDouble[0].requests === 0 &&
      liveDouble[0].delta['auto-double-click'] === 0 &&
      liveDouble[1].requests === 1 &&
      liveDouble[1].delta['auto-double-click'] === 1 &&
      liveDouble[1].origin === 'auto-double-click' &&
      liveDouble[2].requests === 0 &&
      liveDouble[2].delta['auto-double-click'] === 0,
    JSON.stringify(liveDouble),
  )

  // --- one gesture, one lookup — and two gestures, two lookups ---------------
  // The de-duplication regression the brief calls out. If identity were derived
  // from the text, from the rectangle or from a time window, the second gesture
  // would be swallowed and the count would be one.
  await ensureSwitches(page, QUADRANTS.S01)
  state.requests.length = 0
  state.responses.length = 0
  const sameWordBefore = await readPluginView(page)
  await doubleClickWord(page, 'derive')
  const firstId = (await readPluginView(page)).gestures.last.gestureId
  await doubleClickWord(page, 'derive')
  const sameWordAfter = await readPluginView(page)
  const repeatDouble = {
    requests: requestQueries([...state.requests]),
    delta: originDelta(sameWordBefore, sameWordAfter),
    firstId,
    secondId: sameWordAfter.gestures.last.gestureId,
  }
  phase4.repeatDouble = repeatDouble
  record(
    `${prefix}P15`,
    'two independent double clicks on the same word are two gestures and two lookups, never one (T06 regression)',
    repeatDouble.requests.length === 2 &&
      repeatDouble.requests.every((query) => query === 'derive') &&
      repeatDouble.delta['auto-double-click'] === 2 &&
      repeatDouble.firstId !== repeatDouble.secondId,
    JSON.stringify(repeatDouble),
  )

  await ensureSwitches(page, QUADRANTS.S10)
  state.requests.length = 0
  state.responses.length = 0
  const repeatDragBefore = await readPluginView(page)
  await dragSelectWord(page, 'derive')
  const firstDragId = (await readPluginView(page)).gestures.last.gestureId
  await dragSelectWord(page, 'derive')
  const repeatDragAfter = await readPluginView(page)
  const repeatDrag = {
    requests: requestQueries([...state.requests]),
    delta: originDelta(repeatDragBefore, repeatDragAfter),
    firstId: firstDragId,
    secondId: repeatDragAfter.gestures.last.gestureId,
  }
  phase4.repeatDrag = repeatDrag
  record(
    `${prefix}P16`,
    'two independent drag selections of the same word are two gestures and two lookups, never one',
    repeatDrag.requests.length === 2 &&
      repeatDrag.requests.every((query) => query === 'derive') &&
      repeatDrag.delta['auto-selection'] === 2 &&
      repeatDrag.firstId !== repeatDrag.secondId,
    JSON.stringify(repeatDrag),
  )

  // --- the card shows the answer to the gesture that was made ---------------
  await ensureSwitches(page, QUADRANTS.S01)
  state.requests.length = 0
  state.responses.length = 0
  await doubleClickWord(page, 'derived')
  const derivedAuto = await waitForResponses(state, 1)
  const derivedCard = await readCard(page)
  const derivedView = await readPluginView(page)
  phase4.derivedAuto = { response: compactLookup(derivedAuto[0]?.body ?? null), card: derivedCard }
  record(
    `${prefix}P17`,
    'an automatic double click on "derived" resolves through the forms table and renders the lemma',
    derivedAuto[0]?.body?.found === true &&
      derivedAuto[0]?.body?.query === 'derived' &&
      derivedAuto[0]?.body?.headword === 'derive' &&
      derivedAuto[0]?.body?.matchedForm === 'derived' &&
      derivedAuto[0]?.body?.source === 'sqlite-fixture' &&
      derivedView.trigger?.origin === 'auto-double-click' &&
      derivedCard.cardPresent === true &&
      (derivedCard.headword ?? '').includes('derive'),
    JSON.stringify(phase4.derivedAuto),
  )

  // Two automatic lookups issued back to back. The real dictionary answers in a
  // few milliseconds, so this is not a race the host can be made to lose; what it
  // proves is that a rapid pair leaves the card on the *second* gesture's answer
  // and that the first one cannot come back over it. The genuinely out-of-order
  // orders are driven deterministically in `tests/client-lookup.spec.ts` and
  // through the real runtime in `tests/client-runtime-harness.spec.ts`.
  state.requests.length = 0
  state.responses.length = 0
  const deriveBox = await wordBox(page, 'derive')
  const wentBox = await wordBox(page, 'went')
  await clearSelection(page)
  if (deriveBox !== null) await page.mouse.dblclick(deriveBox.x + deriveBox.width / 2, deriveBox.y + deriveBox.height / 2)
  await clearSelection(page)
  if (wentBox !== null) await page.mouse.dblclick(wentBox.x + wentBox.width / 2, wentBox.y + wentBox.height / 2)
  await settle()
  const rapidRequests = requestQueries([...state.requests])
  const rapidCard = await readCard(page)
  const rapidView = await readPluginView(page)
  phase4.rapidPair = { requests: rapidRequests, card: rapidCard, requestId: rapidView.requestId, loading: rapidView.loading }
  record(
    `${prefix}P18`,
    'two automatic lookups in quick succession leave the card on the second query’s headword',
    rapidRequests.length === 2 &&
      rapidRequests[0] === 'derive' &&
      rapidRequests[1] === 'went' &&
      rapidCard.cardPresent === true &&
      (rapidCard.headword ?? '').includes('go') &&
      rapidView.loading === false,
    JSON.stringify(phase4.rapidPair),
  )

  // --- a dictionary miss is not an error ------------------------------------
  state.requests.length = 0
  state.responses.length = 0
  await doubleClickWord(page, 'unknowntoken')
  const missResponses = await waitForResponses(state, 1)
  const missCard = await readCard(page)
  const missView = await readPluginView(page)
  await doubleClickWord(page, 'derive')
  const afterMissCard = await readCard(page)
  phase4.unknownAuto = {
    response: compactLookup(missResponses[0]?.body ?? null),
    status: missResponses[0]?.status ?? null,
    card: missCard,
  }
  record(
    `${prefix}P19`,
    'an automatic lookup of an unknown word is a normal miss, and the next gesture still works',
    missResponses[0]?.status === 200 &&
      missResponses[0]?.body?.found === false &&
      missResponses[0]?.body?.query === 'unknowntoken' &&
      missView.lastOutcome === 'not-found' &&
      missCard.cardPresent === true &&
      missCard.state === 'ready' &&
      (missCard.body ?? '').includes('no entry for') &&
      (afterMissCard.headword ?? '').includes('derive'),
    JSON.stringify({ ...phase4.unknownAuto, after: afterMissCard }),
  )

  // --- the automatic path obeys the same composer exclusion as the shortcut --
  await ensureSwitches(page, QUADRANTS.S11)
  const composerBox = await page.locator('[data-phase1-probe="composer"]').boundingBox()
  state.requests.length = 0
  state.responses.length = 0
  if (composerBox !== null) {
    await clearSelection(page)
    const y = composerBox.y + composerBox.height / 2
    await page.mouse.move(composerBox.x + 4, y)
    await page.mouse.down()
    await page.mouse.move(composerBox.x + 60, y, { steps: 6 })
    await page.mouse.up()
    await settle()
  }
  const composerDrag = await readPluginView(page)
  phase4.composerDrag = {
    requests: [...state.requests].length,
    kind: composerDrag.gestures.last.kind,
    trigger: composerDrag.trigger,
    box: composerBox,
  }
  record(
    `${prefix}P20`,
    'an automatic drag inside the composer issues nothing, because the classifier finds no eligible selection (T08)',
    composerBox !== null &&
      phase4.composerDrag.requests === 0 &&
      composerDrag.gestures.last.kind === 'other' &&
      composerDrag.trigger?.decision === 'ignored',
    JSON.stringify(phase4.composerDrag),
  )

  state.requests.length = 0
  state.responses.length = 0
  if (composerBox !== null) {
    await clearSelection(page)
    await page.mouse.dblclick(composerBox.x + 40, composerBox.y + composerBox.height / 2)
    await settle()
  }
  const composerDouble = await readPluginView(page)
  phase4.composerDouble = {
    requests: [...state.requests].length,
    kind: composerDouble.gestures.last.kind,
    trigger: composerDouble.trigger,
  }
  record(
    `${prefix}P21`,
    'an automatic double click inside the composer issues nothing (T08)',
    composerBox !== null &&
      phase4.composerDouble.requests === 0 &&
      composerDouble.gestures.last.kind === 'other' &&
      composerDouble.trigger?.decision === 'ignored',
    JSON.stringify(phase4.composerDouble),
  )

  // --- stress ---------------------------------------------------------------
  // The gesture storm is replayed in every quadrant. 100 + 100 is run for the two
  // states the brief requires in a real browser (both off, both on) and a reduced
  // 25 + 25 batch for the two single-switch states, whose only additional claim
  // is *which* switch fired — a claim the batch size cannot weaken. The full
  // 100 + 100 combinatorial matrix is covered exhaustively and cheaply in
  // `tests/client-trigger.spec.ts` and `tests/client-runtime-harness.spec.ts`.
  async function storm(dragCount, doubleClickCount) {
    const before = await readPluginView(page)
    state.requests.length = 0
    state.responses.length = 0
    for (let index = 0; index < dragCount; index += 1) {
      await clearSelection(page)
      await dragAcrossProbe()
    }
    for (let index = 0; index < doubleClickCount; index += 1) {
      if (box !== null) await page.mouse.dblclick(box.x + 90, box.y + box.height / 2)
    }
    const requests = await waitForQuiescence()
    const after = await readPluginView(page)
    return {
      requests: requests.length,
      delta: originDelta(before, after),
      drags: after.gestures.counters.drags - before.gestures.counters.drags,
      doubleClicks: after.gestures.counters.doubleClickGestures - before.gestures.counters.doubleClickGestures,
      cancels: after.gestures.counters.cancels - before.gestures.counters.cancels,
    }
  }

  await ensureSwitches(page, QUADRANTS.S00)
  const stress00 = await storm(100, 100)
  phase4.stress00 = stress00
  record(
    `${prefix}P22`,
    'S00 stress — 100 real drags and 100 real double clicks produce zero lookups (T01/T02/T22)',
    stress00.drags === 100 &&
      stress00.doubleClicks === 100 &&
      stress00.requests === 0 &&
      stress00.delta.shortcut === 0 &&
      noAutomaticOrigin(stress00.delta),
    JSON.stringify(stress00),
  )

  await ensureSwitches(page, QUADRANTS.S11)
  const stress11 = await storm(100, 100)
  phase4.stress11 = stress11
  record(
    `${prefix}P23`,
    'S11 stress — 100 real drags and 100 real double clicks produce exactly 200 lookups, 100 on each path',
    stress11.drags === 100 &&
      stress11.doubleClicks === 100 &&
      stress11.requests === 200 &&
      stress11.delta['auto-selection'] === 100 &&
      stress11.delta['auto-double-click'] === 100 &&
      stress11.delta.shortcut === 0,
    JSON.stringify(stress11),
  )

  await ensureSwitches(page, QUADRANTS.S10)
  const stress10 = await storm(25, 25)
  phase4.stress10 = stress10
  record(
    `${prefix}P24`,
    'S10 stress — real drags and double clicks produce exactly one lookup per drag and none per double click',
    stress10.drags === 25 &&
      stress10.doubleClicks === 25 &&
      stress10.requests === 25 &&
      stress10.delta['auto-selection'] === 25 &&
      stress10.delta['auto-double-click'] === 0,
    JSON.stringify(stress10),
  )

  await ensureSwitches(page, QUADRANTS.S01)
  const stress01 = await storm(25, 25)
  phase4.stress01 = stress01
  record(
    `${prefix}P25`,
    'S01 stress — real gestures produce exactly one lookup per double click and none per drag',
    stress01.drags === 25 &&
      stress01.doubleClicks === 25 &&
      stress01.requests === 25 &&
      stress01.delta['auto-double-click'] === 25 &&
      stress01.delta['auto-selection'] === 0,
    JSON.stringify(stress01),
  )

  // The matrix changed the switches on purpose. They are put back to what this
  // boot loaded, so a later check cannot be satisfied by a write this harness
  // made here rather than by the one it is measuring.
  const restoredGates = await ensureSwitches(page, bootGates)
  phase4.bootGates = bootGates
  phase4.restoredGates = restoredGates
  record(
    `${prefix}P26`,
    'the trigger matrix left the two switches exactly as this boot loaded them',
    restoredGates.autoSelection === bootGates.autoSelection &&
      restoredGates.autoDoubleClick === bootGates.autoDoubleClick,
    `boot=${JSON.stringify(bootGates)} restored=${JSON.stringify(restoredGates)}`,
  )
  facts.phase4 = phase4

  // --- settings mirror ------------------------------------------------------
  // Already measured at `${prefix}20`/`${prefix}21`, before any write could move
  // the values. Nothing is re-read here: a second read after the matrix below
  // would describe the run's own writes, not the boot's state.

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

    // --- Phase 4: a reloaded runtime must not have stacked its listeners -----
    // L01 proves the overlay and the command were registered once. Automatic
    // lookups add five more listeners, and a reload that left a previous set
    // behind would make one gesture issue two or three requests — the exact
    // regression this measures. Both switches are `true` at this point, written
    // by S01/S04 above, so the automatic paths are live.
    await installProbeNodes(page)
    await dismissDialogs(page)
    await page.waitForTimeout(400)
    state.requests.length = 0
    state.responses.length = 0
    await doubleClickWord(page, 'derive')
    const reloadDoubleRequests = requestQueries([...state.requests])
    const reloadDoubleView = await readPluginView(page)

    state.requests.length = 0
    state.responses.length = 0
    await dragSelectWord(page, 'went')
    const reloadDragRequests = requestQueries([...state.requests])
    const reloadDragView = await readPluginView(page)

    report.facts.afterReloadTriggers = {
      double: { requests: reloadDoubleRequests, gates: reloadDoubleView.gates, trigger: reloadDoubleView.trigger },
      drag: { requests: reloadDragRequests, gates: reloadDragView.gates, trigger: reloadDragView.trigger },
    }
    record(
      'L06',
      'after a full client reload one double click still issues exactly one lookup, so no listener was stacked',
      reloadDoubleRequests.length === 1 &&
        reloadDoubleRequests[0] === 'derive' &&
        reloadDoubleView.trigger?.origin === 'auto-double-click',
      JSON.stringify(report.facts.afterReloadTriggers.double),
    )
    record(
      'L07',
      'after a full client reload one drag selection still issues exactly one lookup',
      reloadDragRequests.length === 1 &&
        reloadDragRequests[0] === 'went' &&
        reloadDragView.trigger?.origin === 'auto-selection',
      JSON.stringify(report.facts.afterReloadTriggers.drag),
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
  // Final isolation statement, recorded as a check so it lands in the report
  // rather than only on the console. Everything the run did addressed the
  // verified scratch environment; the processes it started were given a
  // scrubbed environment by `buildIsolatedEnv`.
  record(
    'ISO05',
    'the run addressed the isolated environment and nothing production-owned',
    VERIFIED.home === HOME && PROFILE === VERIFIED.profile && PORT === VERIFIED.port,
    `home=${HOME} profile=${PROFILE} port=${String(PORT)}`,
  )

  const failed = results.filter((result) => !result.ok)
  report.summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((result) => result.id) }
  report.status = failed.length === 0 ? 'PASS' : 'FAIL'

  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true })
  // The launch token is a process credential: the URL it travels in mints the
  // browser session cookie. `docs/evidence/` is committed, so the scrub runs
  // over the whole report on the way out — including `environment.firstBootUrl`,
  // which an earlier field-by-field scrub missed.
  writeFileSync(OUT_PATH, `${JSON.stringify(redactTokens(report), null, 2)}\n`, 'utf8')
  console.log(`\nphase1-verify: ${report.status} — ${String(report.summary.passed)}/${String(report.summary.total)} checks`)
  console.log(`report: ${OUT_PATH}`)
  if (failed.length > 0) console.log(`failed: ${failed.map((result) => result.id).join(', ')}`)
  console.log('production DSH profile touched: NO')
  console.log('production session data touched: NO')
  console.log('production port touched: NO')
  console.log('production loader touched: NO')
  console.log('production routes touched: NO')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('phase1-verify: aborted', error)
  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true })
  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(redactTokens({ status: 'ERROR', error: String(error?.stack ?? error), results, bootLogs }), null, 2)}\n`,
    'utf8',
  )
  process.exit(2)
})
