#!/usr/bin/env node
/**
 * Phase 4.2 — the first-press drift probe.
 *
 * Phase 4.1 closed the *second*-press half of the double-click / drag overlap:
 * a second press the platform reports as a multi-click can no longer spend an
 * `auto-selection` lookup, because the gate refuses a press whose
 * `mousedown.detail` is not `1`. The symmetric question was left open, and this
 * script exists to answer it **by measurement, before any production change**:
 *
 * ```text
 * can a FIRST press that drifts far enough to be classified as a drag
 * still become the first half of a platform-recognised dblclick?
 * ```
 *
 * The concern is concrete. The first press of any double click always arrives as
 * `mousedown.detail === 1` -- the platform cannot know a second click is coming
 * either -- so the Phase 4.1 gate cannot refuse it. If the drift is at least the
 * classifier's 5 CSS px threshold and it leaves an eligible selection, the
 * classifier calls it `drag`, the gate accepts it as a verified `single` click,
 * and `autoSelection` issues a lookup at `pointerup`. If a `dblclick` then
 * arrives for the pair, `autoDoubleClick` issues a second one: one semantic
 * gesture, two lookups, one per switch -- the very coupling Phase 4.1 removed.
 *
 * What this script does **not** claim
 * ----------------------------------
 * Phase 4.1 established, and this probe re-establishes as a control, that raw
 * CDP input without a `clickCount` reaches **no** click-count detector at all:
 * the renderer emits no `click` and no `dblclick` for such a pair. The
 * automation client therefore has to supply the count, and supplying it is not
 * the same thing as the browser or the operating system recognising a double
 * click. Every row below records **which** multiplicity was supplied and by
 * whom, and the report never calls a supplied count a native recognition. What
 * is measured is the renderer's behaviour *given* a multiplicity -- which is
 * exactly the input the product consumes, and exactly what Phase 4.1's fix is
 * built on.
 *
 * Isolation
 * ---------
 * The first executable statement is the isolation assertion, and it refuses to
 * start anything unless the target is provably a scratch environment: isolated
 * `DSH_HOME`, profile `word-lookup-test`, isolated port. Nothing here reads the
 * production home, session, cookie, loader, route or port.
 *
 * Usage:
 *   node scripts/phase42-probe.mjs [--home <dir>] [--profile <name>] [--port <port>]
 *
 * @module dsh-word-lookup/scripts/phase42-probe
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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
import { redactTokens } from './redact.mjs'

/** Repository root, derived from this script's own location. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Parse `--key value` / `--flag` arguments.
 *
 * @param argv - arguments after the script name.
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
const TEST_ROOT = resolve(options['test-root'] ?? DEFAULT_TEST_ROOT)
const HOME = resolve(options.home ?? join(TEST_ROOT, 'home'))
const PROFILE = options.profile ?? 'word-lookup-test'
const PORT = Number(options.port ?? 50991)
const WORKDIR = resolve(options.workdir ?? REPO_ROOT)
const OUT_PATH = resolve(options.out ?? join(REPO_ROOT, 'verify-out', 'phase42-probe.json'))

// --- the isolation gate, before anything is started or written ---------------
let VERIFIED
try {
  VERIFIED = assertIsolatedDshEnvironment({ home: HOME, profile: PROFILE, port: PORT, testRoot: TEST_ROOT })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nphase42-probe: refusing to start; the target is not an isolated environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

if (!(await isPortFree(VERIFIED.port))) {
  console.error(`phase42-probe: port ${String(VERIFIED.port)} is already in use; pass --port <other>`)
  process.exit(2)
}

/**
 * The classifier's drag threshold, mirrored from `src/client/gesture.ts`.
 *
 * This script is plain JavaScript and cannot import the TypeScript constant.
 * The two are kept honest from the other side: `tests/client-gesture.spec.ts`
 * pins the product constant, and this probe asserts the *overlap the threshold
 * creates* rather than trusting the number.
 */
const DRAG_THRESHOLD_PX = 5

/** The first press's travel, in CSS px, for the movement sweep. */
const FIRST_PRESS_SWEEP = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8, 10, 12])

/** The two switch states the sweep is run in. */
const GATE_STATES = Object.freeze({
  S00: { autoSelection: false, autoDoubleClick: false },
  S11: { autoSelection: true, autoDoubleClick: true },
})

/** Wait for pending network activity to settle. */
const settle = () => new Promise((r) => setTimeout(r, 600))

/** A short pause, used where the gap between two presses must stay small. */
const shortPause = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start the isolated DSH Web process and wait for its authenticated launch URL.
 *
 * @returns the child process and the launch URL.
 */
async function startDsh() {
  const env = buildIsolatedEnv(VERIFIED)
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: WORKDIR,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const log = { stdout: '', stderr: '', startedAt: new Date().toISOString(), pid: child.pid }
  const ansi = /\u001b\[[0-9;]*m/g

  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`dsh did not print a launch URL within 90s\n${log.stdout}\n${log.stderr}`))
    }, 90_000)
    const consume = (chunk, sink) => {
      const text = chunk.toString().replace(ansi, '')
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

  await shortPause(1500)
  return { child, url, log }
}

/**
 * Stop the isolated DSH process and wait for its exit.
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
  return (await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15_000))])) === true
}

/** The event types the capture-phase trace records, in the brief's own list. */
const PROBE_EVENT_TYPES = [
  'pointerdown',
  'mousedown',
  'pointermove',
  'mousemove',
  'pointerup',
  'mouseup',
  'click',
  'dblclick',
  'selectionchange',
]

/**
 * Install the word column the gestures are aimed at.
 *
 * The two `data-chat-*` attributes are what the plugin's own qualification rule
 * reads; without them every selection here would be refused as ineligible and
 * the probe would measure "the drag was not eligible" while claiming to measure
 * the switches.
 *
 * @param page - the authenticated page.
 */
async function installProbeNodes(page) {
  await page.evaluate((words) => {
    for (const node of document.querySelectorAll('[data-phase1-probe]')) node.remove()
    const host = document.createElement('div')
    host.setAttribute('data-phase1-probe', 'words')
    host.setAttribute('data-chat-flow-kind', 'assistant-step')
    host.setAttribute('data-chat-node-key', 'phase42:words:1')
    host.style.cssText =
      'position:fixed;right:24px;top:150px;z-index:2147482000;background:#1b1b20;color:#eaeaf0;padding:10px 14px;border-radius:6px;font:14px/1.6 system-ui;width:220px'
    for (const word of words) {
      const line = document.createElement('div')
      line.style.cssText = 'margin:0 0 4px'
      const span = document.createElement('span')
      span.setAttribute('data-phase1-word', word)
      span.textContent = word
      line.appendChild(span)
      host.appendChild(line)
    }
    document.body.appendChild(host)
  }, ['derive'])
}

/**
 * Install the capture-phase trace of every event the platform emits.
 *
 * Registered with `capture: true` on `document`, so it sees each event before
 * the plugin's own listeners and cannot be influenced by them.
 *
 * @param page - the authenticated page.
 */
async function startPlatformTrace(page) {
  await page.evaluate((types) => {
    const events = []
    const started = performance.now()
    const listener = (event) => {
      const selection = document.getSelection()
      events.push({
        n: events.length,
        type: event.type,
        ms: Math.round((performance.now() - started) * 10) / 10,
        detail: typeof event.detail === 'number' ? event.detail : null,
        pointerType: typeof event.pointerType === 'string' ? event.pointerType : null,
        button: typeof event.button === 'number' ? event.button : null,
        buttons: typeof event.buttons === 'number' ? event.buttons : null,
        x: typeof event.clientX === 'number' ? Math.round(event.clientX * 100) / 100 : null,
        y: typeof event.clientY === 'number' ? Math.round(event.clientY * 100) / 100 : null,
        text: (selection?.toString() ?? '').slice(0, 32),
        collapsed: selection?.isCollapsed ?? null,
      })
    }
    window.__PHASE42__ = { events, listener, types, started }
    for (const type of types) document.addEventListener(type, listener, true)
  }, PROBE_EVENT_TYPES)
}

/**
 * How many events the trace has recorded so far.
 *
 * @param page - the authenticated page.
 * @returns the trace length.
 */
async function traceLength(page) {
  return await page.evaluate(() => window.__PHASE42__.events.length)
}

/**
 * Read the trace from an index.
 *
 * @param page - the authenticated page.
 * @param from - the index to read from.
 * @returns the raw event records.
 */
async function traceSince(page, from) {
  return await page.evaluate((index) => window.__PHASE42__.events.slice(index), from)
}

/**
 * Project a raw trace onto the facts the report records.
 *
 * @param events - the raw records.
 * @returns the summary.
 */
function summariseTrace(events) {
  const lastOf = (type) => events.filter((event) => event.type === type).at(-1) ?? null
  const release = lastOf('pointerup')
  return {
    order: events.map((event) => `${event.type}${event.detail === null ? '' : `/${String(event.detail)}`}`),
    mouseDowns: events.filter((event) => event.type === 'mousedown').map((event) => ({ detail: event.detail, button: event.button })),
    clicks: events.filter((event) => event.type === 'click').map((event) => event.detail),
    doubleClicks: events.filter((event) => event.type === 'dblclick').map((event) => event.detail),
    emittedDoubleClick: events.some((event) => event.type === 'dblclick'),
    emittedClick: events.some((event) => event.type === 'click'),
    pointerType: release?.pointerType ?? null,
    selectionAtRelease: release?.text ?? null,
    collapsedAtRelease: release?.collapsed ?? null,
    events,
  }
}

/**
 * The client-space box of one probe word.
 *
 * @param page - the authenticated page.
 * @param word - the word to measure.
 * @returns the box, or `null` when the probe is absent.
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
 * Collapse the current selection.
 *
 * @param page - the authenticated page.
 */
async function clearSelection(page) {
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
  })
}

/**
 * Read the plugin's own client-side view.
 *
 * @param page - the authenticated page.
 * @returns the view.
 */
async function readPluginView(page) {
  return await page.evaluate(() => {
    const plugin = window.__DSH_WORD_LOOKUP__
    return {
      gates: plugin.gates(),
      origins: plugin.lookupsByOrigin(),
      trigger: plugin.trigger(),
      capture: plugin.capture(),
      selection: plugin.selection(),
      gestures: plugin.gestures(),
    }
  })
}

/**
 * Difference between two origin counts.
 *
 * @param before - the earlier view.
 * @param after - the later view.
 * @returns the per-origin delta, including the manual path.
 */
function originDelta(before, after) {
  const delta = {}
  for (const origin of ['shortcut', 'auto-selection', 'auto-double-click']) {
    delta[origin] = after.origins[origin] - before.origins[origin]
  }
  return delta
}

/**
 * Establish a complete switch state through the plugin's own settings write.
 *
 * @param page - the authenticated page.
 * @param gates - the two switch values to establish.
 * @returns the gate values actually in force afterwards.
 */
async function ensureSwitches(page, gates) {
  for (const field of ['autoSelection', 'autoDoubleClick']) {
    const current = await page.evaluate((name) => window.__DSH_WORD_LOOKUP__.gates()[name], field)
    if (current === gates[field]) continue
    await page.evaluate(async ({ name, next }) => await window.__DSH_WORD_LOOKUP__.set(name, next), { name: field, next: gates[field] })
    await settle()
  }
  return await page.evaluate(() => window.__DSH_WORD_LOOKUP__.gates())
}

/**
 * The multiplicity modes the sweep is run in.
 *
 * Each mode says, in its own words, **who** supplied the click count. The
 * distinction is the whole honesty requirement of this probe: only the platform
 * can decide that a second press is a multi-click, and CDP input has to be told.
 */
const MULTIPLICITY_MODES = Object.freeze([
  {
    id: 'supplied-2',
    label: 'the automation client supplies clickCount 2 on the second press — the multiplicity a real second press carries',
    secondCount: 2,
    rawCdp: false,
    gapMs: null,
  },
  {
    id: 'plain-1',
    label: 'both presses are plain clicks (clickCount 1), the shape Playwright sends by default',
    secondCount: 1,
    rawCdp: false,
    gapMs: null,
  },
  {
    id: 'raw-cdp',
    label: 'no clickCount is supplied at all (raw Input.dispatchMouseEvent) — can any built-in detector be reached?',
    secondCount: null,
    rawCdp: true,
    gapMs: null,
  },
  {
    id: 'supplied-2-late',
    label: 'clickCount 2 again, but with a 1200 ms gap between the presses — does the renderer check time either?',
    secondCount: 2,
    rawCdp: false,
    gapMs: 1200,
  },
])

/**
 * One sweep row: a first press that drifts `distance` px, then a second press
 * back at the origin.
 *
 * The two halves are measured **separately**: the state after the first release
 * is read before the second press is delivered, because the question this probe
 * asks is precisely whether the first release already produced I/O that the
 * platform's later recognition would have forbidden.
 *
 * @param page - the authenticated page.
 * @param state - the observation channels.
 * @param cdp - a CDP session, used only by the raw mode.
 * @param point - the word's centre.
 * @param distance - the first press's travel in CSS px.
 * @param mode - one of {@link MULTIPLICITY_MODES}.
 * @returns the measurement.
 */
async function probeRow(page, state, cdp, point, distance, mode) {
  const before = await readPluginView(page)
  state.requests.length = 0
  state.responses.length = 0
  await clearSelection(page)

  const fromFirst = await traceLength(page)

  // --- first press: drifts, releases, and is classified on its own ----------
  await page.mouse.move(point.x, point.y)
  await page.mouse.down({ clickCount: 1 })
  if (distance > 0) await page.mouse.move(point.x + distance, point.y, { steps: 2 })
  await page.mouse.up({ clickCount: 1 })

  // Deliberately short: a reader's second press follows the first within the
  // platform's own double-click interval, so the probe must not insert a gap
  // that a real double click would not have. The measured gap is recorded below.
  await shortPause(80)

  const firstRequests = [...state.requests]
  const afterFirst = await readPluginView(page)
  const firstTrace = summariseTrace(await traceSince(page, fromFirst))

  // --- second press: stationary, at the origin -----------------------------
  if (mode.gapMs !== null) await shortPause(mode.gapMs)
  const fromSecond = await traceLength(page)
  const under = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element === null ? null : `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80)
  }, { x: point.x, y: point.y })

  await page.mouse.move(point.x, point.y)
  if (mode.rawCdp) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0 })
  } else {
    await page.mouse.down({ clickCount: mode.secondCount })
    await page.mouse.up({ clickCount: mode.secondCount })
  }
  await settle()

  // Only what the *second* press added: the wire log is a single growing array,
  // so the split index is what keeps the two halves from being conflated.
  const secondRequests = state.requests.slice(firstRequests.length)
  const afterSecond = await readPluginView(page)
  const secondTrace = summariseTrace(await traceSince(page, fromSecond))

  // The gap a real double click would have had, read off the platform's own
  // timestamps rather than from the harness's intentions.
  const firstReleaseAt = firstTrace.events.filter((event) => event.type === 'pointerup').at(-1)?.ms ?? null
  const secondPressAt = secondTrace.events.filter((event) => event.type === 'pointerdown')[0]?.ms ?? null
  const gapMs = firstReleaseAt === null || secondPressAt === null ? null : Math.round((secondPressAt - firstReleaseAt) * 10) / 10

  return {
    distance,
    mode: mode.id,
    // --- what the FIRST press did, on its own ------------------------------
    first: {
      mouseDownDetail: firstTrace.mouseDowns.map((entry) => entry.detail),
      selectionAtRelease: firstTrace.selectionAtRelease,
      collapsedAtRelease: firstTrace.collapsedAtRelease,
      kind: afterFirst.gestures.last.kind,
      clickMultiplicity: afterFirst.gestures.last.clickMultiplicity,
      gestureId: afterFirst.gestures.last.gestureId,
      drags: afterFirst.gestures.counters.drags - before.gestures.counters.drags,
      requests: firstRequests.length,
      queries: firstRequests.map((request) => {
        try {
          return JSON.parse(request.postData ?? '{}').query ?? null
        } catch {
          return null
        }
      }),
      lookupDelta: originDelta(before, afterFirst),
      trigger:
        afterFirst.trigger === null
          ? null
          : {
              decision: afterFirst.trigger.decision,
              reason: afterFirst.trigger.reason,
              origin: afterFirst.trigger.origin,
              gestureId: afterFirst.trigger.gestureId,
            },
      capture: { eligible: afterFirst.capture.eligible, text: afterFirst.capture.text },
      order: firstTrace.order,
      events: firstTrace.events,
    },
    // --- what the SECOND press added ---------------------------------------
    second: {
      mouseDownDetail: secondTrace.mouseDowns.map((entry) => entry.detail),
      clicks: secondTrace.clicks,
      doubleClicks: secondTrace.doubleClicks,
      emittedClick: secondTrace.emittedClick,
      emittedDoubleClick: secondTrace.emittedDoubleClick,
      order: secondTrace.order,
      events: secondTrace.events,
      elementUnderPoint: under,
    },
    // --- the pair, as the product saw it -----------------------------------
    final: {
      kind: afterSecond.gestures.last.kind,
      clickMultiplicity: afterSecond.gestures.last.clickMultiplicity,
      gestureId: afterSecond.gestures.last.gestureId,
      drags: afterSecond.gestures.counters.drags - before.gestures.counters.drags,
      doubleClickGestures: afterSecond.gestures.counters.doubleClickGestures - before.gestures.counters.doubleClickGestures,
      requests: firstRequests.length + secondRequests.length,
      queries: secondRequests.map((request) => {
        try {
          return JSON.parse(request.postData ?? '{}').query ?? null
        } catch {
          return null
        }
      }),
      lookupDelta: originDelta(before, afterSecond),
      trigger:
        afterSecond.trigger === null
          ? null
          : {
              decision: afterSecond.trigger.decision,
              reason: afterSecond.trigger.reason,
              origin: afterSecond.trigger.origin,
              gestureId: afterSecond.trigger.gestureId,
            },
    },
    gapMs,
  }
}

// --- run -------------------------------------------------------------------

console.log(`phase42-probe: booting the isolated instance on port ${String(VERIFIED.port)}`)
const { child, url, log } = await startDsh()

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
const state = { requests: [], responses: [], consoleErrors: [], pageErrors: [] }

page.on('request', (req) => {
  if (req.url().includes('/api/dsh-word-lookup')) {
    state.requests.push({ method: req.method(), url: req.url(), postData: req.postData() })
  }
})
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
      entry.settled = true
    },
  )
})
page.on('console', (message) => {
  if (message.type() === 'error') state.consoleErrors.push(message.text())
})
page.on('pageerror', (error) => state.pageErrors.push(String(error.message)))

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => typeof window.__DSH_WORD_LOOKUP__ === 'object' && window.__DSH_WORD_LOOKUP__ !== null, undefined, {
  timeout: 90_000,
})
await page.waitForFunction(() => window.__DSH_WORD_LOOKUP__.overlay().declarationSeen === true, undefined, { timeout: 30_000 })

await installProbeNodes(page)
await startPlatformTrace(page)

const box = await wordBox(page, 'derive')
if (box === null) {
  console.error('phase42-probe: the word probe is absent; refusing to report a sweep')
  process.exit(2)
}
const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

const cdp = await context.newCDPSession(page)
const sweeps = []

for (const [stateId, gates] of Object.entries(GATE_STATES)) {
  const active = await ensureSwitches(page, gates)
  const modes = stateId === 'S00' ? MULTIPLICITY_MODES : MULTIPLICITY_MODES.filter((mode) => mode.id === 'supplied-2')
  for (const mode of modes) {
    const rows = []
    for (const distance of FIRST_PRESS_SWEEP) {
      const row = await probeRow(page, state, cdp, point, distance, mode)
      rows.push(row)
      const marker = row.second.emittedDoubleClick ? 'dblclick' : 'no-dblclick'
      console.log(
        `  ${stateId} ${mode.id.padEnd(16)} drift ${String(distance).padStart(2)} px -> ` +
          `first(md ${JSON.stringify(row.first.mouseDownDetail)} kind ${row.first.kind} req ${String(row.first.requests)} ` +
          `sel ${JSON.stringify(row.first.selectionAtRelease)}) | ` +
          `second(md ${JSON.stringify(row.second.mouseDownDetail)} ${marker} gap ${String(row.gapMs)} ms) | ` +
          `final(${row.final.kind} req ${String(row.final.requests)} ${JSON.stringify(row.final.lookupDelta)})`,
      )
    }
    sweeps.push({ state: stateId, gates: active, mode: mode.id, modeLabel: mode.label, rows })
  }
}

// --- §10: who owns the overlap gesture, in each switch state ---------------
//
// The reachability sweep above runs with both switches off, so it cannot show
// what the product *does* with the overlap. These three measurements can, and
// they are what the product invariant is checked against: a gesture the platform
// recognises as a double click must be answered by `autoDoubleClick` alone.
const OVERLAP_DISTANCE = 8

const overlapOwnership = []
for (const [stateId, gates] of Object.entries({
  S10: { autoSelection: true, autoDoubleClick: false },
  S01: { autoSelection: false, autoDoubleClick: true },
  S11: { autoSelection: true, autoDoubleClick: true },
})) {
  const active = await ensureSwitches(page, gates)
  const mode = MULTIPLICITY_MODES.find((entry) => entry.id === 'supplied-2')
  const row = await probeRow(page, state, cdp, point, OVERLAP_DISTANCE, mode)
  overlapOwnership.push({ state: stateId, gates: active, row })
  console.log(
    `  ${stateId} overlap ownership -> first(${row.first.kind} req ${String(row.first.requests)} ` +
      `${JSON.stringify(row.first.lookupDelta)}) second(${row.second.emittedDoubleClick ? 'dblclick' : 'no-dblclick'} ` +
      `md ${JSON.stringify(row.second.mouseDownDetail)}) final(req ${String(row.final.requests)} ` +
      `${JSON.stringify(row.final.lookupDelta)})`,
  )
}

// Leave the isolated profile exactly as the acceptance harness expects to find
// it. The composed default is both switches off, and `S07` in
// `scripts/phase1-verify.mjs` restores it for the same reason: these writes are
// persisted to the profile's patch, and `B20` asserts the *boot* defaults are
// off. A probe that walked away having persisted `true/true` would make the next
// run's first boot fail a check about this phase's subject.
const restoredSwitches = await ensureSwitches(page, GATE_STATES.S00)
console.log(`phase42-probe: isolated profile switches restored to ${JSON.stringify(restoredSwitches)}`)

await cdp.detach()

// --- what the sweep means --------------------------------------------------

/** A row counts as the hypothesised overlap only if every part of it is true. */
const isOverlapRow = (row) =>
  row.distance >= DRAG_THRESHOLD_PX &&
  row.first.kind === 'drag' &&
  row.first.capture.eligible === true &&
  row.first.mouseDownDetail.length === 1 &&
  row.first.mouseDownDetail[0] === 1

const supplied = sweeps.find((sweep) => sweep.state === 'S00' && sweep.mode === 'supplied-2') ?? null
const overlapRows = (supplied?.rows ?? []).filter((row) => isOverlapRow(row) && row.second.emittedDoubleClick === true)
const overlapObserved = overlapRows.length > 0

// Every row in which the first press was itself a classified drag with an
// eligible selection, whatever the platform did afterwards.
const dragRows = (supplied?.rows ?? []).filter((row) => isOverlapRow(row))
const dragRowsWithoutDoubleClick = dragRows.filter((row) => row.second.emittedDoubleClick === false)

const nativeRows = sweeps.find((sweep) => sweep.state === 'S00' && sweep.mode === 'raw-cdp')?.rows ?? []
const nativeDetectorReachable = nativeRows.some((row) => row.second.emittedDoubleClick || row.second.mouseDownDetail.some((detail) => detail !== 0 && detail !== null))

const report = {
  phase: '4.2',
  generatedAt: new Date().toISOString(),
  startSha: options['start-sha'] ?? null,
  isolation: {
    banner: ISOLATION_BANNER,
    home: VERIFIED.home,
    profile: VERIFIED.profile,
    port: VERIFIED.port,
    testRoot: VERIFIED.testRoot,
    productionHomes: VERIFIED.productionHomes,
    productionPorts: VERIFIED.productionPorts,
  },
  browser: { version: browser.version(), headless: true },
  node: process.version,
  dragThresholdPx: DRAG_THRESHOLD_PX,
  firstPressSweep: [...FIRST_PRESS_SWEEP],
  word: 'derive',
  point,
  sweeps,
  overlapOwnership: overlapOwnership.map((entry) => ({
    state: entry.state,
    gates: entry.gates,
    distance: OVERLAP_DISTANCE,
    first: {
      kind: entry.row.first.kind,
      clickMultiplicity: entry.row.first.clickMultiplicity,
      selectionAtRelease: entry.row.first.selectionAtRelease,
      requests: entry.row.first.requests,
      queries: entry.row.first.queries,
      lookupDelta: entry.row.first.lookupDelta,
      trigger: entry.row.first.trigger,
    },
    second: {
      mouseDownDetail: entry.row.second.mouseDownDetail,
      emittedDoubleClick: entry.row.second.emittedDoubleClick,
      order: entry.row.second.order,
    },
    final: {
      kind: entry.row.final.kind,
      requests: entry.row.final.requests,
      queries: entry.row.final.queries,
      lookupDelta: entry.row.final.lookupDelta,
      trigger: entry.row.final.trigger,
    },
    gapMs: entry.row.gapMs,
  })),
  verdict: {
    overlapObserved,
    overlapRows: overlapRows.map((row) => ({ distance: row.distance, mode: row.mode })),
    dragRowsAtOrAboveThreshold: dragRows.map((row) => row.distance),
    dragRowsWithoutDoubleClick: dragRowsWithoutDoubleClick.map((row) => row.distance),
    nativeDetectorReachableFromAutomation: nativeDetectorReachable,
    summary: overlapObserved
      ? 'FIRST-PRESS OVERLAP OBSERVED — a first press that the product classified as a drag still became the first half of a double click the platform reported'
      : 'FIRST-PRESS OVERLAP NOT OBSERVED — no first press that the product classified as a drag was followed by a dblclick in this sweep',
  },
  consoleErrors: state.consoleErrors,
  pageErrors: state.pageErrors,
  restoredSwitches,
  boot: { pid: log.pid, startedAt: log.startedAt, stderr: redactTokens(log.stderr).slice(-4000) },
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${redactTokens(JSON.stringify(report, null, 2))}\n`, 'utf8')

console.log('')
console.log(`phase42-probe: ${report.verdict.summary}`)
console.log(`phase42-probe: drag-classified first presses at/above ${String(DRAG_THRESHOLD_PX)} px: ${JSON.stringify(report.verdict.dragRowsAtOrAboveThreshold)}`)
console.log(`phase42-probe: of those, followed by a dblclick: ${JSON.stringify(report.verdict.overlapRows)}`)
console.log(`phase42-probe: native detector reachable from automation input: ${String(nativeDetectorReachable)}`)
for (const entry of report.overlapOwnership) {
  const total = entry.final.requests
  const selection = entry.final.lookupDelta['auto-selection']
  const double = entry.final.lookupDelta['auto-double-click']
  const invariant = entry.gates.autoDoubleClick
    ? total === 1 && selection === 0 && double === 1
    : total === 0
  console.log(
    `phase42-probe: ${entry.state} overlap ownership -> requests ${String(total)} ` +
      `(auto-selection ${String(selection)}, auto-double-click ${String(double)}) — ` +
      `product invariant ${invariant ? 'HOLDS' : 'VIOLATED'}`,
  )
}
console.log(`phase42-probe: evidence written to ${OUT_PATH}`)

await context.close()
await browser.close()
const stopped = await stopDsh(child)
console.log(`phase42-probe: isolated instance stopped (${String(stopped)})`)
