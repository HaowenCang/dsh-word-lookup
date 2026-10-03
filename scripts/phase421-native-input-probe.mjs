#!/usr/bin/env node
/**
 * Phase 4.2.1 — is the first-press overlap reachable through the **real Windows
 * mouse input stack**?
 *
 * The question this script exists to answer
 * -----------------------------------------
 * Phase 4.2 established, by measurement, that a first press which the product
 * classifies as a `drag` — at least {@link DRAG_THRESHOLD_PX} of travel and an
 * eligible selection at release — can still be the first half of a `dblclick`
 * the renderer reports, and that in `S11` that produces **two** lookups for one
 * semantic gesture: one `auto-selection` at the first release, one
 * `auto-double-click` at the double click.
 *
 * But Phase 4.2 generated its input through CDP, and CDP input has to be *told*
 * the click multiplicity (`clickCount`). Its own control arm proved the honesty
 * problem: with no `clickCount` supplied, raw `Input.dispatchMouseEvent` reaches
 * **no** click-count detector at all (`mousedown.detail === 0`, no `click`, no
 * `dblclick`). Deciding the multiplicity on the renderer's behalf is therefore
 * not the same thing as Windows deciding that a second press is a double click,
 * and the reachability of the overlap through a real mouse was left open.
 *
 * So this script supplies **no multiplicity**. Every mouse event in the measured
 * sequences comes from `SendInput`, through the operating system's own input
 * queue, into a visible and foreground browser window — the same path a reader's
 * hand takes. Playwright is used only to read the DOM, install the trace, start
 * the isolated browser and read the results back.
 *
 * The two questions the sweep answers
 * -----------------------------------
 * ```text
 * Group A: first down at X0, first release at X1, second press at X0
 * Group B: first down at X0, first release at X1, second press at X1
 * ```
 *
 * Together they say what the platform's spatial anchor for a double click
 * actually is. If the anchor is the first **down**, only Group A can recognise a
 * double click after a drift; if it is the first **release**, Group B can too —
 * and Group B is the realistic shape of a jittery double click, because a hand
 * does not travel back to where it started between two quick presses.
 *
 * Validity gate
 * -------------
 * No result from the sweeps is allowed to be called *Windows-native evidence*
 * until two negative controls have passed in the same run:
 *
 * - a **timeout** control — two clicks at the same point separated by more than
 *   `GetDoubleClickTime()` must **not** produce a `dblclick`, while the same pair
 *   just under it must;
 * - a **spatial** control — two clicks separated by tens of pixels must **not**
 *   produce a `dblclick`.
 *
 * If either fails, the run reports `BLOCKED — NATIVE INPUT PROBE INVALID`: a
 * detector that fires outside its own documented bounds is not the detector this
 * experiment claims to be measuring.
 *
 * Isolation
 * ---------
 * The first executable statement is the isolation assertion. Nothing here reads
 * or touches the production DSH home, profile, session, cookie, loader or port.
 * The probe operates the real OS cursor, so it records the cursor position
 * before it starts and restores it on every exit path, including failure.
 *
 * Usage:
 *   node scripts/phase421-native-input-probe.mjs [--home <dir>] [--profile <name>] [--port <port>]
 *
 * Exit codes: 0 = probe completed (read `verdict`), 2 = refused / invalid setup.
 *
 * @module dsh-word-lookup/scripts/phase421-native-input-probe
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
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

/** The SendInput helper this script drives. */
const HELPER_PATH = join(REPO_ROOT, 'scripts', 'windows-native-mouse-probe.ps1')

/**
 * The classifier's drag threshold, mirrored from `src/client/gesture.ts`.
 *
 * Plain JavaScript cannot import the TypeScript constant; `tests/client-gesture.spec.ts`
 * pins the product value and this probe reports the *observed* travel rather
 * than trusting the mirror.
 */
const DRAG_THRESHOLD_PX = 5

/** The first press's travel, in CSS px, for the movement sweep. */
const FIRST_PRESS_SWEEP = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8, 10, 12])

/** The two switch states the sweeps are run in. */
const SWEEP_GATES = Object.freeze({ autoSelection: false, autoDoubleClick: false })

/** The switch states the ownership matrix is run in, once an overlap is seen. */
const OWNERSHIP_STATES = Object.freeze({
  S10: { autoSelection: true, autoDoubleClick: false },
  S01: { autoSelection: false, autoDoubleClick: true },
  S11: { autoSelection: true, autoDoubleClick: true },
})

/** How close a commanded cursor position must land, in CSS px, to be trusted. */
const CALIBRATION_TOLERANCE_PX = 1.0

/** Event types the capture-phase trace records. */
const TRACE_EVENT_TYPES = Object.freeze([
  'pointerdown',
  'mousedown',
  'pointermove',
  'mousemove',
  'pointerup',
  'mouseup',
  'click',
  'dblclick',
  'selectionchange',
])

// ---------------------------------------------------------------------------
// Options and gates.
// ---------------------------------------------------------------------------

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
const OUT_PATH = resolve(options.out ?? join(REPO_ROOT, 'docs', 'evidence', 'phase42-native-input-20261003.json'))
const SCREENSHOT_DIR = resolve(options['screenshot-dir'] ?? join(REPO_ROOT, 'verify-out'))
const USER_DATA_DIR = resolve(options['user-data-dir'] ?? join(REPO_ROOT, 'verify-out', 'phase421-chromium-profile'))

/**
 * Stop after the window, calibration and interference checks.
 *
 * The environment side of this probe — a real window that can be foregrounded,
 * a transform that converges, a desktop that holds still — is what decides
 * whether the gesture sweeps mean anything, and it is worth being able to prove
 * on its own before spending a run on the measurements.
 */
const PREFLIGHT_ONLY = options.preflight === 'true'

// --- the isolation gate, before anything is started or written ---------------
let VERIFIED
try {
  VERIFIED = assertIsolatedDshEnvironment({ home: HOME, profile: PROFILE, port: PORT, testRoot: TEST_ROOT })
} catch (error) {
  if (error instanceof IsolationError) {
    console.error(error.message)
    console.error('\nphase421: refusing to start; the target is not an isolated environment')
    process.exit(2)
  }
  throw error
}
console.log(ISOLATION_BANNER)

if (process.platform !== 'win32') {
  console.error('phase421: this probe drives SendInput and a real desktop; it only runs on Windows')
  process.exit(2)
}

if (!(await isPortFree(VERIFIED.port))) {
  console.error(`phase421: port ${String(VERIFIED.port)} is already in use; pass --port <other>`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

/** Wait for a number of milliseconds. */
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

/** Wait for pending network activity to settle. */
const settle = () => sleep(450)

/** Round to two decimals, for evidence that reads cleanly. */
const round2 = (value) => Math.round(value * 100) / 100

/** A row that could not be measured because the cursor would not hold still. */
class ContaminatedRowError extends Error {
  /**
   * @param message - why the row was abandoned.
   */
  constructor(message) {
    super(message)
    this.name = 'ContaminatedRowError'
  }
}

// ---------------------------------------------------------------------------
// The SendInput helper: a long-lived PowerShell slave over JSON lines.
// ---------------------------------------------------------------------------

/**
 * A JSON-lines client for `scripts/windows-native-mouse-probe.ps1`.
 *
 * One long-lived process rather than one per action, because the whole point of
 * the experiment is the *spacing* of two presses: a fresh PowerShell start-up
 * between them would put hundreds of milliseconds of interpreter boot inside the
 * double-click interval and destroy the measurement.
 */
class NativeMouse {
  #child
  #reader
  #pending = new Map()
  #nextId = 1
  #stderr = ''
  #exit = null

  /**
   * @param child - the spawned helper process.
   * @param reader - the readline interface over its stdout.
   */
  constructor(child, reader) {
    this.#child = child
    this.#reader = reader
  }

  /** Start the helper and wait for its `ready` line. */
  static async start() {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH],
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const reader = createInterface({ input: child.stdout })
    const client = new NativeMouse(child, reader)

    child.stderr.on('data', (chunk) => {
      client.#stderr += chunk.toString()
    })
    child.on('exit', (code) => {
      client.#exit = code
      for (const waiter of client.#pending.values()) waiter.reject(new Error(`helper exited with code ${String(code)}`))
      client.#pending.clear()
    })

    const ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('the SendInput helper did not become ready in 30s')), 30_000)
      client.#onMessage = (message) => {
        if (message.op !== 'ready') return false
        clearTimeout(timer)
        resolveReady(message)
        return true
      }
    })

    reader.on('line', (line) => client.#handleLine(line))

    const handshake = await ready
    return { client, handshake }
  }

  /** The helper's readiness message. */
  #onMessage = null

  /**
   * Dispatch one decoded line: the handshake first, then the pending waiter.
   *
   * @param line - one raw stdout line.
   */
  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (this.#onMessage !== null && this.#onMessage(message)) {
      this.#onMessage = null
      return
    }
    const waiter = this.#pending.get(message.id)
    if (waiter === undefined) return
    this.#pending.delete(message.id)
    waiter.resolve(message)
  }

  /**
   * Send one command and await its result.
   *
   * @param op - the operation name.
   * @param extra - additional fields.
   * @returns the decoded result.
   */
  send(op, extra = {}) {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectSend(new Error(`the SendInput helper did not answer '${op}' in 20s`))
      }, 20_000)
      this.#pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolveSend(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectSend(error)
        },
      })
      this.#child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`)
    })
  }

  /** Read the system metrics, once. */
  metrics() {
    return this.send('metrics')
  }

  /** Read the current cursor position. */
  cursor() {
    return this.send('cursor')
  }

  /**
   * Move the cursor to a physical screen position and wait for it to arrive.
   *
   * @param x - physical screen x.
   * @param y - physical screen y.
   * @returns the helper's answer, including whether the move settled.
   */
  move(x, y) {
    return this.send('move', { x: Math.round(x), y: Math.round(y) })
  }

  /**
   * Press a mouse button.
   *
   * @param button - `left`, `right` or `middle`.
   * @returns the helper's answer.
   */
  down(button = 'left') {
    return this.send('down', { button })
  }

  /**
   * Release a mouse button.
   *
   * @param button - `left`, `right` or `middle`.
   * @returns the helper's answer.
   */
  up(button = 'left') {
    return this.send('up', { button })
  }

  /** Find a top-level window by a title marker. */
  findWindow(title) {
    return this.send('findWindow', { title })
  }

  /** Read one window's geometry. */
  windowInfo(hwnd) {
    return this.send('windowInfo', { hwnd })
  }

  /** Bring a window to the foreground and report whether it got there. */
  foreground(hwnd) {
    return this.send('foreground', { hwnd })
  }

  /** Put the cursor back where it was before the probe started. */
  restore() {
    return this.send('restore')
  }

  /** Stop the helper; its own `finally` restores the cursor. */
  async close() {
    try {
      await this.send('quit')
    } catch {
      // A helper that already died needs no goodbye.
    }
    this.#reader.close()
    this.#child.stdin.end()
    await new Promise((resolveExit) => {
      if (this.#exit !== null) {
        resolveExit()
        return
      }
      const timer = setTimeout(() => {
        this.#child.kill()
        resolveExit()
      }, 4000)
      this.#child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
    return { stderr: this.#stderr, exitCode: this.#exit }
  }
}

// ---------------------------------------------------------------------------
// The isolated DSH instance and the visible browser window.
// ---------------------------------------------------------------------------

/**
 * Start the isolated DSH Web process and wait for its authenticated launch URL.
 *
 * @returns the child process, its launch URL and its captured output.
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

  await sleep(1500)
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
  return (await Promise.race([exited, new Promise((resolveWait) => setTimeout(() => resolveWait(false), 15_000))])) === true
}

/** Read the installed DSH version, for the evidence header. */
async function readDshVersion() {
  return new Promise((resolveVersion) => {
    const child = spawn('dsh', ['--version'], { shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('exit', () => resolveVersion(out.trim()))
    child.on('error', () => resolveVersion('unknown'))
  })
}

// ---------------------------------------------------------------------------
// Page instrumentation. Everything here reads; nothing generates input.
// ---------------------------------------------------------------------------

/**
 * Install the word column the gestures are aimed at.
 *
 * The `data-chat-*` attributes are what the plugin's own qualification rule
 * reads; without them every selection would be refused as ineligible and the
 * probe would measure "the drag was not eligible" while claiming to measure the
 * platform.
 *
 * @param page - the authenticated page.
 * @param words - the words to render, top to bottom.
 */
async function installProbeNodes(page, words) {
  await page.evaluate((list) => {
    for (const node of document.querySelectorAll('[data-phase421-probe]')) node.remove()
    const host = document.createElement('div')
    host.setAttribute('data-phase421-probe', 'words')
    host.setAttribute('data-chat-flow-kind', 'assistant-step')
    host.setAttribute('data-chat-node-key', 'phase421:words:1')
    host.style.cssText =
      'position:fixed;right:36px;top:180px;z-index:2147482000;background:#1b1b20;color:#eaeaf0;' +
      'padding:12px 16px;border-radius:6px;font:16px/1.8 system-ui;width:260px'
    for (const word of list) {
      const line = document.createElement('div')
      line.style.cssText = 'margin:0 0 6px'
      const span = document.createElement('span')
      span.setAttribute('data-phase421-word', word)
      span.textContent = word
      line.appendChild(span)
      host.appendChild(line)
    }
    document.body.appendChild(host)
  }, words)
}

/**
 * Install the capture-phase trace and the coordinate-probe channels.
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
    window.__PHASE421__ = { events, listener: null, types, started, mousemoveCount: 0, lastMove: null }

    const listener = (event) => {
      const selection = document.getSelection()
      const record = {
        n: events.length,
        type: event.type,
        ms: Math.round((performance.now() - started) * 100) / 100,
        detail: typeof event.detail === 'number' ? event.detail : null,
        pointerType: typeof event.pointerType === 'string' ? event.pointerType : null,
        button: typeof event.button === 'number' ? event.button : null,
        buttons: typeof event.buttons === 'number' ? event.buttons : null,
        x: typeof event.clientX === 'number' ? Math.round(event.clientX * 100) / 100 : null,
        y: typeof event.clientY === 'number' ? Math.round(event.clientY * 100) / 100 : null,
        text: (selection?.toString() ?? '').slice(0, 48),
        collapsed: selection?.isCollapsed ?? null,
      }
      events.push(record)
      if (event.type === 'mousemove') {
        window.__PHASE421__.mousemoveCount += 1
        window.__PHASE421__.lastMove = { x: record.x, y: record.y, ms: record.ms }
      }
    }

    window.__PHASE421__.listener = listener
    for (const type of types) document.addEventListener(type, listener, true)
  }, TRACE_EVENT_TYPES)
}

/**
 * Keep the window title pinned to a per-run marker.
 *
 * The marker is how the helper finds *this* run's browser window among every
 * top-level window on the desktop, and it is what guarantees the probe can only
 * ever foreground the isolated Chromium. The client rewrites `document.title` as
 * the conversation changes, so the marker is re-asserted rather than set once.
 *
 * @param page - the authenticated page.
 * @param marker - the unique marker string.
 */
async function pinWindowTitle(page, marker) {
  await page.evaluate((value) => {
    const apply = () => {
      if (document.title !== value) document.title = value
    }
    apply()
    if (window.__PHASE421__.titleTimer !== undefined) clearInterval(window.__PHASE421__.titleTimer)
    window.__PHASE421__.titleTimer = setInterval(apply, 250)
  }, marker)
}

/**
 * How many events the trace has recorded so far.
 *
 * @param page - the authenticated page.
 * @returns the trace length.
 */
async function traceLength(page) {
  return await page.evaluate(() => window.__PHASE421__.events.length)
}

/**
 * Read the trace from an index.
 *
 * @param page - the authenticated page.
 * @param from - the index to read from.
 * @returns the raw event records.
 */
async function traceSince(page, from) {
  return await page.evaluate((index) => window.__PHASE421__.events.slice(index), from)
}

/**
 * Project a raw trace onto the facts the report records.
 *
 * @param events - the raw records.
 * @returns the summary.
 */
function summariseTrace(events) {
  const of = (type) => events.filter((event) => event.type === type)
  const release = of('pointerup').at(-1) ?? null
  return {
    order: events.map((event) => `${event.type}${event.detail === null ? '' : `/${String(event.detail)}`}`),
    mouseDowns: of('mousedown').map((event) => ({ detail: event.detail, button: event.button, x: event.x, y: event.y })),
    pointerDowns: of('pointerdown').map((event) => ({ x: event.x, y: event.y, pointerType: event.pointerType })),
    clicks: of('click').map((event) => event.detail),
    doubleClicks: of('dblclick').map((event) => event.detail),
    emittedClick: of('click').length > 0,
    emittedDoubleClick: of('dblclick').length > 0,
    selectionAtRelease: release?.text ?? null,
    collapsedAtRelease: release?.collapsed ?? null,
    selectionAtEnd: events.at(-1)?.text ?? null,
    events,
  }
}

/**
 * The peak travel the renderer actually delivered for the first press.
 *
 * This — not the requested SendInput distance — is the quantity the classifier
 * compares against its threshold, so it is the quantity the report records.
 *
 * @param trace - the first press's trace.
 * @returns the observed travel in CSS px, or `null` when it cannot be measured.
 */
function observedTravel(trace) {
  const down = trace.pointerDowns[0] ?? null
  if (down === null) return null
  let peak = 0
  for (const event of trace.events) {
    if (event.type !== 'pointermove' && event.type !== 'mousemove') continue
    if (event.x === null || event.y === null) continue
    peak = Math.max(peak, Math.hypot(event.x - down.x, event.y - down.y))
  }
  const release = trace.events.filter((event) => event.type === 'pointerup').at(-1) ?? null
  if (release !== null && release.x !== null && release.y !== null) {
    peak = Math.max(peak, Math.hypot(release.x - down.x, release.y - down.y))
  }
  return round2(peak)
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
    const span = document.querySelector(`[data-phase421-word="${target}"]`)
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
 * Dismiss the client's first-run onboarding dialog, if it is up.
 *
 * A fresh isolated browser profile opens the client on "Add an API key to get
 * started" behind a full-page mask. That mask is the topmost hit-test target
 * everywhere on the page, so a genuine `SendInput` press aimed at the probe word
 * lands on the mask: no text is selected, the product classifies every row as
 * `other`, and the sweep would report a confident "the overlap is not reachable"
 * that is really "the click never reached the text". With CDP input — which
 * Phase 4.2 used — the same trap is invisible, because dispatching to the
 * renderer is not the same thing as a click arriving.
 *
 * This is setup, not measurement: it is a DOM activation of the client's own
 * button, and it supplies no multiplicity to any measured gesture. The
 * hit-test gate below is what actually guarantees the protector worked.
 *
 * @param page - the authenticated page.
 * @returns what it found and what it activated.
 */
async function dismissOnboarding(page) {
  return await page.evaluate(() => {
    const label = (element) => (element.textContent ?? '').trim()
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
    const pattern = /configure later|save and continue|skip|later|稍后|以后|跳过/i
    const hit = buttons.find((button) => pattern.test(label(button)))
    const report = {
      buttonCount: buttons.length,
      clicked: hit === undefined ? null : { label: label(hit), className: String(hit.className) },
    }
    if (hit !== undefined) hit.click()
    return report
  })
}

/**
 * Ask the renderer what a real click at one CSS point would actually hit.
 *
 * @param page - the authenticated page.
 * @param point - the CSS client point to test.
 * @param word - the probe word whose span must be the hit target.
 * @returns the hit-test facts.
 */
async function hitTest(page, point, word) {
  return await page.evaluate(
    ({ target, name }) => {
      const describe = (node) => (node === null ? null : `${node.tagName.toLowerCase()}${node.id === '' ? '' : `#${node.id}`}.${String(node.className).slice(0, 60)}`)
      const element = document.elementFromPoint(target.x, target.y)
      const span = document.querySelector(`[data-phase421-word="${name}"]`)
      return {
        element: describe(element),
        probeWordPresent: span !== null,
        probeWordBox: span === null ? null : span.getBoundingClientRect().toJSON(),
        isProbeWord: span !== null && element !== null && (element === span || span.contains(element)),
        looksLikeModalMask: element !== null && /_mask_/i.test(String(element.className)),
        activeElement: document.activeElement === null ? null : document.activeElement.tagName,
      }
    },
    { target: point, name: word },
  )
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

// ---------------------------------------------------------------------------
// Coordinate calibration.
//
// Nothing here guesses a toolbar height. The transform from a CSS client point
// to a physical screen point is *measured*: the cursor is parked, the page
// reports where the resulting real `mousemove` landed, and the offset and scale
// are solved from those pairs. That is what keeps a 150 % display from silently
// turning "5 px of travel" into 7.5 px, or the reverse.
// ---------------------------------------------------------------------------

/**
 * One measured (screen, client) pair.
 *
 * @typedef {{ screen: { x: number, y: number }, client: { x: number, y: number } }} CalibrationPair
 */

/**
 * Solve the affine screen↔client transform from measured pairs.
 *
 * @param pairs - at least two pairs with distinct client coordinates.
 * @returns the solved transform, or `null` when it is under-determined.
 */
function solveTransform(pairs) {
  if (pairs.length < 2) return null
  const [a, b] = pairs
  const dcx = b.client.x - a.client.x
  const dcy = b.client.y - a.client.y
  if (Math.abs(dcx) < 1 || Math.abs(dcy) < 1) return null
  const scaleX = (b.screen.x - a.screen.x) / dcx
  const scaleY = (b.screen.y - a.screen.y) / dcy
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null
  // Average the two independent offsets so a single noisy pair cannot dominate.
  const originX = (a.screen.x - scaleX * a.client.x + (b.screen.x - scaleX * b.client.x)) / 2
  const originY = (a.screen.y - scaleY * a.client.y + (b.screen.y - scaleY * b.client.y)) / 2
  return { scaleX, scaleY, originX, originY }
}

/**
 * Move the cursor and read back where the renderer says it arrived.
 *
 * @param page - the authenticated page.
 * @param mouse - the SendInput helper.
 * @param screen - the physical screen point to move to.
 * @returns the achieved screen point and the observed CSS client point.
 */
async function samplePoint(page, mouse, screen) {
  const before = await page.evaluate(() => window.__PHASE421__.mousemoveCount)
  const move = await mouse.move(screen.x, screen.y)
  await sleep(35)
  const after = await page.evaluate(() => ({
    count: window.__PHASE421__.mousemoveCount,
    last: window.__PHASE421__.lastMove,
  }))
  return {
    requested: screen,
    achieved: move.cursor,
    settled: move.settled === true,
    fresh: after.count > before,
    client: after.count > before ? { x: after.last.x, y: after.last.y } : null,
  }
}

/**
 * Calibrate the screen↔client transform against the live page.
 *
 * @param page - the authenticated page.
 * @param mouse - the SendInput helper.
 * @param windowRect - the browser window's Win32 geometry.
 * @param pageFacts - the page's own geometry.
 * @returns the calibration record.
 */
async function calibrate(page, mouse, windowRect, pageFacts) {
  const dpr = pageFacts.devicePixelRatio
  const client = windowRect.clientRectOnScreen
  const horizontalChrome = client.width - pageFacts.innerWidth * dpr
  const verticalChrome = client.height - pageFacts.innerHeight * dpr

  // A first guess good enough to land inside the viewport on the first try in
  // the common case; everything after this is solved, not assumed.
  let transform = {
    scaleX: dpr,
    scaleY: dpr,
    originX: client.left + horizontalChrome / 2,
    originY: client.top + verticalChrome - horizontalChrome / 2,
  }

  const targets = [
    { x: Math.round(pageFacts.innerWidth * 0.25), y: Math.round(pageFacts.innerHeight * 0.3) },
    { x: Math.round(pageFacts.innerWidth * 0.7), y: Math.round(pageFacts.innerHeight * 0.7) },
  ]

  const attempts = []
  let pairs = []
  let maxResidual = Number.POSITIVE_INFINITY

  for (let round = 0; round < 6 && maxResidual > CALIBRATION_TOLERANCE_PX; round += 1) {
    const measured = []
    for (const target of targets) {
      let screen = {
        x: transform.originX + transform.scaleX * target.x,
        y: transform.originY + transform.scaleY * target.y,
      }
      let sample = await samplePoint(page, mouse, screen)
      // A guess that started above the viewport produces no event at all; walk
      // downwards until the page answers, then recalibrate from there.
      for (let nudge = 0; sample.fresh === false && nudge < 16; nudge += 1) {
        screen = { x: screen.x, y: screen.y + 48 }
        sample = await samplePoint(page, mouse, screen)
      }
      attempts.push({ round, target, ...sample })
      if (sample.fresh && sample.client !== null) {
        measured.push({ screen: sample.achieved, client: sample.client })
      }
    }
    if (measured.length < 2) break
    pairs = measured
    const solved = solveTransform(measured)
    if (solved === null) break
    transform = solved
    maxResidual = 0
    for (const pair of pairs) {
      const predicted = {
        x: transform.originX + transform.scaleX * pair.client.x,
        y: transform.originY + transform.scaleY * pair.client.y,
      }
      maxResidual = Math.max(maxResidual, Math.abs(predicted.x - pair.screen.x), Math.abs(predicted.y - pair.screen.y))
    }
  }

  return {
    devicePixelRatio: dpr,
    windowClientRectOnScreen: client,
    horizontalChromePx: round2(horizontalChrome),
    verticalChromePx: round2(verticalChrome),
    transform: {
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      originX: round2(transform.originX),
      originY: round2(transform.originY),
    },
    tolerancePx: CALIBRATION_TOLERANCE_PX,
    maxResidualPx: round2(maxResidual),
    ok: maxResidual <= CALIBRATION_TOLERANCE_PX,
    pairs: pairs.map((pair) => ({ screen: pair.screen, client: { x: round2(pair.client.x), y: round2(pair.client.y) } })),
    attempts,
  }
}

// ---------------------------------------------------------------------------
// The gesture runner.
// ---------------------------------------------------------------------------

/**
 * Run one measured pair of presses through the OS input stack.
 *
 * The sequence is deliberately split at the first release: the state the product
 * reached *before* the second press is read while the second press cannot yet
 * have influenced it. That split is the whole measurement — if the first release
 * already produced I/O, the report has to show it as its own fact.
 *
 * @param context - the run's shared state.
 * @param spec - the row specification.
 * @returns the row's measurements.
 */
async function runRow(context, spec) {
  const { page, mouse, requests, calibration, interference, anchor } = context
  const toScreen = (point) => ({
    x: calibration.transform.originX + calibration.transform.scaleX * point.x,
    y: calibration.transform.originY + calibration.transform.scaleY * point.y,
  })

  /**
   * Park the cursor on a client point, retrying while the desktop is busy.
   *
   * @param point - the CSS client point to reach.
   * @returns the helper's answers.
   */
  const parkAt = async (point) => {
    const screen = toScreen(point)
    const attempts = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const move = await mouse.move(screen.x, screen.y)
      attempts.push({ attempt, settled: move.settled === true, cursor: move.cursor })
      if (move.settled === true) return { screen, attempts }
      await sleep(30)
    }
    interference.push({ row: spec.id, kind: 'move-not-settled', point, attempts })
    throw new ContaminatedRowError(`the cursor would not settle on ${JSON.stringify(point)}`)
  }

  await ensureSwitches(page, spec.gates)
  await clearSelection(page)

  const before = await readPluginView(page)
  const traceFrom = await traceLength(page)
  const requestFrom = requests.length

  const x0 = { x: anchor.x, y: anchor.y }
  const x1 = { x: anchor.x + spec.distancePx, y: anchor.y }

  // Group A presses back at the coordinate the first press *went down* on.
  // Group B presses at the coordinate the first press *came up* on — which is
  // where a hand actually is when it presses again, because it does not travel
  // back to where it started between two quick presses. The offset variant is
  // the spatial control: a second press deliberately placed away from the first.
  const secondPoint =
    spec.secondAt === 'release'
      ? x1
      : spec.secondAt === 'offset'
        ? { x: anchor.x + spec.offsetPx, y: anchor.y }
        : x0

  // --- first press: drifts, releases, and is classified on its own ----------
  await parkAt(x0)
  await mouse.down('left')
  if (spec.distancePx > 0) {
    const steps = spec.distancePx >= 8 ? 3 : 2
    for (let step = 1; step <= steps; step += 1) {
      await parkAt({ x: x0.x + (spec.distancePx * step) / steps, y: x0.y })
    }
  }
  await mouse.up('left')

  const firstTrace = summariseTrace(await traceSince(page, traceFrom))
  const firstRequests = requests.slice(requestFrom)
  const afterFirst = await readPluginView(page)

  // --- the second press ------------------------------------------------------
  await parkAt(secondPoint)

  const firstReleaseMs = firstTrace.events.filter((event) => event.type === 'pointerup').at(-1)?.ms ?? null
  const traceSecondFrom = await traceLength(page)

  // Interference is checked twice around the press that matters: once while the
  // gap is still being waited out — so a gross drift never enters the timed path
  // — and once from the position the helper reports at the press itself, which
  // is the only reading that covers the double-click interval.
  const expectedSecond = toScreen(secondPoint)
  const preSecond = await mouse.cursor()
  const preDrift = Math.hypot(preSecond.cursor.x - expectedSecond.x, preSecond.cursor.y - expectedSecond.y)
  if (preDrift > CALIBRATION_TOLERANCE_PX) {
    interference.push({ row: spec.id, kind: 'cursor-drift-before-gap', driftPx: round2(preDrift), expected: expectedSecond, actual: preSecond.cursor })
    await clearSelection(page)
    throw new ContaminatedRowError(`the cursor drifted ${String(round2(preDrift))} px before the gap`)
  }

  if (spec.gapMs !== null && firstReleaseMs !== null) {
    const clock = await page.evaluate(() => performance.now())
    const targetNode = Date.now() + (firstReleaseMs + spec.gapMs - clock)
    const remaining = targetNode - Date.now()
    if (remaining > 6) await sleep(remaining - 4)
    while (Date.now() < targetNode) {
      // Deliberately a spin: the double-click interval is the measurement.
    }
  }

  const secondDown = await mouse.down('left')
  const atPressDrift = Math.hypot(secondDown.cursor.x - expectedSecond.x, secondDown.cursor.y - expectedSecond.y)
  await sleep(spec.holdMs)
  await mouse.up('left')
  await settle()

  if (atPressDrift > CALIBRATION_TOLERANCE_PX) {
    interference.push({ row: spec.id, kind: 'cursor-drift-at-second-press', driftPx: round2(atPressDrift), expected: expectedSecond, actual: secondDown.cursor })
    await clearSelection(page)
    throw new ContaminatedRowError(`the cursor drifted ${String(round2(atPressDrift))} px at the second press`)
  }

  const secondTrace = summariseTrace(await traceSince(page, traceSecondFrom))
  const secondRequests = requests.slice(requestFrom + firstRequests.length)
  const afterSecond = await readPluginView(page)

  const secondDownMs = secondTrace.events.filter((event) => event.type === 'pointerdown')[0]?.ms ?? null

  return {
    id: spec.id,
    kind: spec.kind,
    group: spec.group,
    gateState: spec.gateState ?? null,
    gates: afterSecond.gates,
    requestedTravelPx: spec.distancePx,
    secondPressAt: spec.secondAt,
    requestedGapMs: spec.gapMs,
    measuredGapMs: firstReleaseMs === null || secondDownMs === null ? null : round2(secondDownMs - firstReleaseMs),
    anchor: { x: round2(x0.x), y: round2(x0.y) },
    first: {
      observedTravelPx: observedTravel(firstTrace),
      classifierTravelPx: afterFirst.gestures.last.pointer?.distance ?? null,
      mouseDownDetail: firstTrace.mouseDowns.map((entry) => entry.detail),
      pointerType: firstTrace.pointerDowns[0]?.pointerType ?? null,
      selectionAtRelease: firstTrace.selectionAtRelease,
      collapsedAtRelease: firstTrace.collapsedAtRelease,
      kind: afterFirst.gestures.last.kind,
      clickMultiplicity: afterFirst.gestures.last.clickMultiplicity,
      gestureId: afterFirst.gestures.last.gestureId,
      drags: afterFirst.gestures.counters.drags - before.gestures.counters.drags,
      requests: firstRequests.length,
      queries: firstRequests.map(readQuery),
      lookupDelta: originDelta(before, afterFirst),
      trigger:
        afterFirst.trigger === null
          ? null
          : {
              decision: afterFirst.trigger.decision,
              reason: afterFirst.trigger.reason,
              origin: afterFirst.trigger.origin,
              gestureId: afterFirst.trigger.gestureId,
              query: afterFirst.trigger.query,
            },
      capture: { eligible: afterFirst.capture.eligible, text: afterFirst.capture.text },
      order: firstTrace.order,
      events: firstTrace.events,
    },
    second: {
      mouseDownDetail: secondTrace.mouseDowns.map((entry) => entry.detail),
      clicks: secondTrace.clicks,
      doubleClicks: secondTrace.doubleClicks,
      emittedClick: secondTrace.emittedClick,
      emittedDoubleClick: secondTrace.emittedDoubleClick,
      order: secondTrace.order,
      events: secondTrace.events,
    },
    final: {
      kind: afterSecond.gestures.last.kind,
      clickMultiplicity: afterSecond.gestures.last.clickMultiplicity,
      gestureId: afterSecond.gestures.last.gestureId,
      drags: afterSecond.gestures.counters.drags - before.gestures.counters.drags,
      doubleClickGestures: afterSecond.gestures.counters.doubleClickGestures - before.gestures.counters.doubleClickGestures,
      requests: firstRequests.length + secondRequests.length,
      queries: secondRequests.map(readQuery),
      lookupDelta: originDelta(before, afterSecond),
      trigger:
        afterSecond.trigger === null
          ? null
          : {
              decision: afterSecond.trigger.decision,
              reason: afterSecond.trigger.reason,
              origin: afterSecond.trigger.origin,
              gestureId: afterSecond.trigger.gestureId,
              query: afterSecond.trigger.query,
            },
    },
  }
}

/**
 * The query carried by one wire request.
 *
 * @param request - a captured request record.
 * @returns the query, or `null` when the body cannot be read.
 */
function readQuery(request) {
  try {
    return JSON.parse(request.postData ?? '{}').query ?? null
  } catch {
    return null
  }
}

/**
 * Run one row, retrying while the desktop is being driven by something else.
 *
 * @param context - the run's shared state.
 * @param spec - the row specification.
 * @returns the measurement, or a `contaminated` marker.
 */
async function runRowResilient(context, spec) {
  const failures = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runRow(context, spec)
    } catch (error) {
      if (!(error instanceof ContaminatedRowError)) throw error
      failures.push(String(error.message))
      await context.mouse.up('left').catch(() => {})
      await sleep(120)
    }
  }
  return { id: spec.id, kind: spec.kind, group: spec.group, contaminated: true, failures }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

console.log(`phase421: booting the isolated instance on port ${String(VERIFIED.port)}`)
const dshVersion = await readDshVersion()
const { child, url, log } = await startDsh()

const { client: mouse, handshake } = await NativeMouse.start()
const metricsAnswer = await mouse.metrics()
const systemMetrics = metricsAnswer.metrics
const interference = []

if (systemMetrics.doubleClickWidth === null || systemMetrics.doubleClickHeight === null) {
  console.error('phase421: the system double-click metrics could not be read; refusing to run')
  process.exit(2)
}

console.log(
  `phase421: Windows ${systemMetrics.os.caption} build ${systemMetrics.os.build} — ` +
    `GetDoubleClickTime=${String(systemMetrics.doubleClickTimeMs)} ms, ` +
    `SM_CXDOUBLECLK=${String(systemMetrics.doubleClickWidth)}, SM_CYDOUBLECLK=${String(systemMetrics.doubleClickHeight)}, ` +
    `SM_CXDRAG=${String(systemMetrics.dragWidth)}, SM_CYDRAG=${String(systemMetrics.dragHeight)}, ` +
    `screen ${String(systemMetrics.screenWidth)}x${String(systemMetrics.screenHeight)} @ ${String(systemMetrics.dpi.scalePercent)}%`,
)

const MARKER = `DSH-WL-PHASE421-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
rmSync(USER_DATA_DIR, { recursive: true, force: true })

const browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: null,
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--window-position=120,120',
    '--window-size=1280,900',
  ],
})

const pages = browserContext.pages()
const page = pages[0] ?? (await browserContext.newPage())
const state = { requests: [], consoleErrors: [], pageErrors: [] }

page.on('request', (request) => {
  if (request.url().includes('/api/dsh-word-lookup')) {
    state.requests.push({ method: request.method(), url: request.url(), postData: request.postData() })
  }
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

await installProbeNodes(page, ['derive', 'derivation'])
await startPlatformTrace(page)
await pinWindowTitle(page, MARKER)
await sleep(400)

// --- clear the first-run dialog, then prove the word is actually hittable ---
const onboarding = await dismissOnboarding(page)
await sleep(700)
await pinWindowTitle(page, MARKER)
console.log(
  `phase421: first-run dialog — ${onboarding.clicked === null ? 'no dismiss control found' : `activated "${onboarding.clicked.label}"`} ` +
    `of ${String(onboarding.buttonCount)} button(s)`,
)

// --- the window must be real, visible and foreground -----------------------
const found = await mouse.findWindow(MARKER)
if (found.windows.length === 0) {
  console.error(`phase421: no visible top-level window carries the marker ${MARKER}; refusing to inject input`)
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}
const target = found.windows[0]
const foreground = await mouse.foreground(target.hwnd)
if (foreground.result.holds !== true) {
  console.error(
    `phase421: could not bring the isolated window ${String(target.hwnd)} to the foreground ` +
      `(attempts: ${foreground.result.attempts.join(', ')}); SendInput would be delivered elsewhere`,
  )
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}
console.log(`phase421: isolated window ${String(target.hwnd)} (${target.className}) is foreground`)

const pageFacts = await page.evaluate(() => ({
  devicePixelRatio: window.devicePixelRatio,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  screenX: window.screenX,
  screenY: window.screenY,
  title: document.title,
}))
console.log(
  `phase421: page ${String(pageFacts.innerWidth)}x${String(pageFacts.innerHeight)} CSS, devicePixelRatio=${String(pageFacts.devicePixelRatio)}`,
)

// --- calibration ------------------------------------------------------------
const calibration = await calibrate(page, mouse, foreground.result.window, pageFacts)
console.log(
  `phase421: calibration scale=(${String(round2(calibration.transform.scaleX))}, ${String(round2(calibration.transform.scaleY))}) ` +
    `origin=(${String(calibration.transform.originX)}, ${String(calibration.transform.originY)}) ` +
    `maxResidual=${String(calibration.maxResidualPx)} CSS px — ${calibration.ok ? 'OK' : 'FAILED'}`,
)
if (!calibration.ok) {
  console.error('phase421: the coordinate transform did not converge; refusing to measure gestures')
  await mouse.restore()
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}

// --- idle interference check ------------------------------------------------
//
// The probe operates the real cursor, so anything else operating the real cursor
// is competing with the measurement. A desktop that will not hold still cannot
// produce a valid negative: "no double click was recognised" and "the cursor was
// somewhere else when the second press landed" are very different findings and
// this check is what keeps them apart. It refuses to spend a run on a sweep that
// could only be thrown away.
const idleSamples = []
for (let index = 0; index < 10; index += 1) {
  idleSamples.push((await mouse.cursor()).cursor)
  await sleep(150)
}
const idleDistinct = new Set(idleSamples.map((point) => `${String(point.x)},${String(point.y)}`)).size
let idleTravelPx = 0
for (let index = 1; index < idleSamples.length; index += 1) {
  idleTravelPx += Math.hypot(idleSamples[index].x - idleSamples[index - 1].x, idleSamples[index].y - idleSamples[index - 1].y)
}
idleTravelPx = Math.round(idleTravelPx)
const externalInputObserved = idleDistinct > 2
console.log(
  `phase421: idle cursor ${String(idleDistinct)}/10 distinct positions, ${String(idleTravelPx)} px of travel in 1.5 s — ` +
    `external input ${externalInputObserved ? 'OBSERVED' : 'not observed'}`,
)
if (externalInputObserved && options['allow-interference'] !== 'true' && !PREFLIGHT_ONLY) {
  console.error(
    'phase421: the desktop cursor is being driven by something other than this probe.\n' +
      '  A native-input measurement cannot be trusted while that is true: a press may land\n' +
      '  nowhere near where it was aimed, and "no double click" would then mean nothing.\n' +
      '  Stop the other cursor automation (or leave the mouse alone) and re-run.\n' +
      '  Pass --allow-interference to measure anyway; every affected row is then retried and\n' +
      '  reported as contaminated rather than silently counted.',
  )
  await mouse.restore()
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}

// --- the anchor the sweeps are aimed at -------------------------------------
const box = await wordBox(page, 'derivation')
if (box === null) {
  console.error('phase421: the word probe is absent; refusing to report a sweep')
  await mouse.restore()
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}
const anchor = { x: Math.round(box.x) + 2, y: Math.round(box.y + box.height / 2) }
console.log(`phase421: anchor client point ${JSON.stringify(anchor)} (word box ${JSON.stringify(box)})`)

// The gate that makes every sweep row meaningful. A press that lands on a mask
// selects nothing, and "nothing was selected" is indistinguishable downstream
// from "the platform refused the double click" — so the probe refuses to run
// rather than produce a negative it cannot support.
const anchorHit = await hitTest(page, anchor, 'derivation')
console.log(`phase421: hit test at the anchor -> ${JSON.stringify(anchorHit)}`)
if (anchorHit.isProbeWord !== true && !PREFLIGHT_ONLY) {
  console.error(
    `phase421: a real click at ${JSON.stringify(anchor)} would hit ${String(anchorHit.element)}, not the probe word.\n` +
      '  Every measurement taken now would classify as "nothing was selected" and read as a\n' +
      '  false negative, so the probe is refusing to start.',
  )
  await mouse.restore()
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(2)
}

// A picture of the page the input was aimed at, for an auditor who wants to see
// what the coordinates referred to. `page.screenshot` reads pixels; it injects
// nothing.
const screenshots = []
try {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const shot = join(SCREENSHOT_DIR, 'phase421-probe-page.png')
  await page.screenshot({ path: shot })
  screenshots.push(shot)
} catch (error) {
  screenshots.push(`screenshot failed: ${String(error.message)}`)
}

if (PREFLIGHT_ONLY) {
  console.log('')
  console.log('phase421: PREFLIGHT ONLY — no gesture was measured')
  console.log(`phase421: window ${String(target.hwnd)} foreground=${String(foreground.result.holds)}`)
  console.log(`phase421: windowRect ${JSON.stringify(foreground.result.window.windowRect)}`)
  console.log(`phase421: clientRectOnScreen ${JSON.stringify(foreground.result.window.clientRectOnScreen)}`)
  console.log(`phase421: calibration maxResidual ${String(calibration.maxResidualPx)} CSS px (tolerance ${String(CALIBRATION_TOLERANCE_PX)})`)
  console.log(`phase421: calibration attempts (first 10):`)
  for (const attempt of calibration.attempts.slice(0, 10)) {
    console.log(
      `    round ${String(attempt.round)} target ${JSON.stringify(attempt.target)} requested ${JSON.stringify(attempt.requested)} ` +
        `achieved ${JSON.stringify(attempt.achieved)} settled=${String(attempt.settled)} fresh=${String(attempt.fresh)} client=${JSON.stringify(attempt.client)}`,
    )
  }
  const under = await page.evaluate((point) => {
    const element = document.elementFromPoint(point.x, point.y)
    return {
      mousemoveCount: window.__PHASE421__.mousemoveCount,
      lastMove: window.__PHASE421__.lastMove,
      elementAtExpected:
        element === null ? null : `${element.tagName.toLowerCase()}#${element.id}.${String(element.className)}`.slice(0, 120),
      activeElement: document.activeElement?.tagName ?? null,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
    }
  }, calibration.attempts.at(-1)?.target ?? { x: 100, y: 100 })
  console.log(`phase421: page state ${JSON.stringify(under)}`)
  console.log(`phase421: idle distinct positions ${String(idleDistinct)}/10 — external input ${externalInputObserved ? 'OBSERVED' : 'not observed'}`)
  console.log(`phase421: idle samples ${JSON.stringify(idleSamples)}`)
  console.log(`phase421: anchor hit test ${JSON.stringify(anchorHit)}`)
  console.log(`phase421: screenshot ${screenshots[0] ?? 'none'}`)
  await mouse.restore()
  await mouse.close()
  await browserContext.close()
  await stopDsh(child)
  process.exit(calibration.ok && anchorHit.isProbeWord === true ? 0 : 2)
}

const context = {
  page,
  mouse,
  requests: state.requests,
  calibration,
  interference,
  anchor,
}

/** Run a list of row specs in order, logging as it goes. */
async function runRows(specs) {
  const rows = []
  for (const spec of specs) {
    const row = await runRowResilient(context, spec)
    rows.push(row)
    if (row.contaminated === true) {
      console.log(`  ${spec.id} CONTAMINATED — ${row.failures.join('; ')}`)
      continue
    }
    console.log(
      `  ${spec.id} travel ${String(row.requestedTravelPx).padStart(2)} px (observed ${String(row.first.observedTravelPx)}) ` +
        `${row.group ?? ''} -> first(md ${JSON.stringify(row.first.mouseDownDetail)} kind ${row.first.kind} ` +
        `sel ${JSON.stringify(row.first.selectionAtRelease)}) | second(md ${JSON.stringify(row.second.mouseDownDetail)} ` +
        `${row.second.emittedDoubleClick ? 'DBLCLICK' : 'no-dblclick'}) | gap ${String(row.measuredGapMs)} ms`,
    )
  }
  return rows
}

// --- controls ---------------------------------------------------------------
//
// Run first, and run at zero travel: they measure the detector itself, so they
// must not be entangled with the drag path whose reachability is the question.
const doubleClickTime = systemMetrics.doubleClickTimeMs
const SPATIAL_FAR_PX = 60

/** Offsets for the spatial rule, in CSS px, from the first click's own point. */
const SPATIAL_SWEEP = Object.freeze([0, 1, 2, 3, 4, 6, 8, 12, 20, 40, 60])

console.log('phase421: negative controls')
const timeoutRows = await runRows([
  { id: 'T-090', kind: 'control-time', group: 'time', distancePx: 0, secondAt: 'down', gapMs: 90, holdMs: 25, gates: SWEEP_GATES },
  { id: 'T-250', kind: 'control-time', group: 'time', distancePx: 0, secondAt: 'down', gapMs: 250, holdMs: 25, gates: SWEEP_GATES },
  { id: 'T-BELOW', kind: 'control-time', group: 'time', distancePx: 0, secondAt: 'down', gapMs: Math.max(60, doubleClickTime - 90), holdMs: 25, gates: SWEEP_GATES },
  { id: 'T-ABOVE', kind: 'control-time', group: 'time', distancePx: 0, secondAt: 'down', gapMs: doubleClickTime + 200, holdMs: 25, gates: SWEEP_GATES },
])

const spatialRows = await runRows(
  SPATIAL_SWEEP.map((offsetPx) => ({
    id: `S-${String(offsetPx).padStart(3, '0')}`,
    kind: 'control-space',
    group: 'space',
    distancePx: 0,
    secondAt: 'offset',
    offsetPx,
    gapMs: 90,
    holdMs: 25,
    gates: SWEEP_GATES,
  })),
)

const timeoutBelow = timeoutRows.find((row) => row.id === 'T-BELOW') ?? null
const timeoutAbove = timeoutRows.find((row) => row.id === 'T-ABOVE') ?? null
const spatialNear = spatialRows.find((row) => row.offsetPx === 0) ?? null
const spatialFar = spatialRows.find((row) => row.offsetPx === SPATIAL_FAR_PX) ?? null

const timeoutControl = {
  doubleClickTimeMs: doubleClickTime,
  belowTimeout: { id: 'T-BELOW', gapMs: timeoutBelow?.requestedGapMs ?? null, measuredGapMs: timeoutBelow?.measuredGapMs ?? null, doubleClick: timeoutBelow?.second?.emittedDoubleClick ?? null },
  aboveTimeout: { id: 'T-ABOVE', gapMs: timeoutAbove?.requestedGapMs ?? null, measuredGapMs: timeoutAbove?.measuredGapMs ?? null, doubleClick: timeoutAbove?.second?.emittedDoubleClick ?? null },
  pass: timeoutBelow?.second?.emittedDoubleClick === true && timeoutAbove?.second?.emittedDoubleClick === false,
}
const spatialControl = {
  samePoint: { id: 'S-000', offsetPx: 0, doubleClick: spatialNear?.second?.emittedDoubleClick ?? null },
  farPoint: { id: `S-${String(SPATIAL_FAR_PX).padStart(3, '0')}`, offsetPx: SPATIAL_FAR_PX, doubleClick: spatialFar?.second?.emittedDoubleClick ?? null },
  pass: spatialNear?.second?.emittedDoubleClick === true && spatialFar?.second?.emittedDoubleClick === false,
}
const probeValid = timeoutControl.pass && spatialControl.pass

console.log(`phase421: timeout control ${timeoutControl.pass ? 'PASS' : 'FAIL'} — below=${String(timeoutControl.belowTimeout.doubleClick)} above=${String(timeoutControl.aboveTimeout.doubleClick)}`)
console.log(`phase421: spatial control ${spatialControl.pass ? 'PASS' : 'FAIL'} — same=${String(spatialControl.samePoint.doubleClick)} far=${String(spatialControl.farPoint.doubleClick)}`)

// --- the movement sweeps ----------------------------------------------------
let groupA = []
let groupB = []
let confirmation = []
let overlapOwnership = null

if (probeValid) {
  console.log('phase421: Group A — second press at the FIRST-DOWN coordinate')
  groupA = await runRows(
    FIRST_PRESS_SWEEP.map((distance) => ({
      id: `A-${String(distance).padStart(2, '0')}`,
      kind: 'sweep',
      group: 'A',
      distancePx: distance,
      secondAt: 'down',
      gapMs: 90,
      holdMs: 25,
      gates: SWEEP_GATES,
    })),
  )

  console.log('phase421: Group B — second press at the FIRST-RELEASE coordinate')
  groupB = await runRows(
    FIRST_PRESS_SWEEP.map((distance) => ({
      id: `B-${String(distance).padStart(2, '0')}`,
      kind: 'sweep',
      group: 'B',
      distancePx: distance,
      secondAt: 'release',
      gapMs: 90,
      holdMs: 25,
      gates: SWEEP_GATES,
    })),
  )
}

/**
 * Whether one row is the hypothesised overlap: a first press the product itself
 * classified as a drag, with an eligible selection, that still became half of a
 * platform-recognised double click.
 *
 * @param row - the measurement.
 * @returns whether every part of the hypothesis holds.
 */
const isOverlapRow = (row) =>
  row.contaminated !== true &&
  row.requestedTravelPx >= DRAG_THRESHOLD_PX &&
  (row.first.observedTravelPx ?? 0) >= DRAG_THRESHOLD_PX &&
  row.first.kind === 'drag' &&
  row.first.capture.eligible === true &&
  row.first.mouseDownDetail.length >= 1 &&
  row.first.mouseDownDetail[0] === 1 &&
  row.second.emittedDoubleClick === true

let overlapRows = [...groupA, ...groupB].filter(isOverlapRow)

// A negative answer is only worth as much as the effort made to falsify it, so
// the distances nearest the threshold are re-run before "not observed" is
// recorded.
if (probeValid && overlapRows.length === 0) {
  console.log('phase421: no overlap in the first pass — running the confirmation battery')
  const battery = []
  for (const distance of [5, 8, 12]) {
    for (const secondAt of ['down', 'release']) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        battery.push({
          id: `C-${secondAt === 'down' ? 'A' : 'B'}-${String(distance).padStart(2, '0')}-${String(repeat + 1)}`,
          kind: 'confirmation',
          group: secondAt === 'down' ? 'A' : 'B',
          distancePx: distance,
          secondAt,
          gapMs: 90,
          holdMs: 25,
          gates: SWEEP_GATES,
        })
      }
    }
  }
  confirmation = await runRows(battery)
  overlapRows = confirmation.filter(isOverlapRow)
}

const nativeOverlapObserved = probeValid && overlapRows.length > 0

// --- the ownership matrix, only once the overlap is real --------------------
if (nativeOverlapObserved) {
  // The matrix is run in the shape that actually overlapped, so that a Group B
  // result is not re-tested as a Group A one and quietly reported as "no
  // overlap" a second time.
  const sample = overlapRows[0]
  const sampleSecondAt = sample.group === 'B' ? 'release' : 'down'
  const sampleDistance = sample.requestedTravelPx
  console.log(
    `phase421: overlap observed — measuring what the product does with it ` +
      `(Group ${String(sample.group)}, ${String(sampleDistance)} px)`,
  )
  const ownershipRows = []
  for (const [stateId, gates] of Object.entries(OWNERSHIP_STATES)) {
    const row = await runRowResilient(context, {
      id: `OWN-${stateId}`,
      kind: 'ownership',
      group: 'ownership',
      gateState: stateId,
      distancePx: sampleDistance,
      secondAt: sampleSecondAt,
      gapMs: 90,
      holdMs: 25,
      gates,
    })
    ownershipRows.push(row)
    console.log(
      `  ${stateId} gates ${String(row.gates?.autoSelection)}/${String(row.gates?.autoDoubleClick)} -> ` +
        `requests ${String(row.final?.requests)} ${JSON.stringify(row.final?.lookupDelta)} ` +
        `dblclick=${String(row.second?.emittedDoubleClick)}`,
    )
  }
  overlapOwnership = {
    mirroredGroup: sample.group,
    mirroredDistancePx: sampleDistance,
    secondPressAt: sampleSecondAt,
    states: ownershipRows.map((row) => ({
      state: row.id.replace('OWN-', ''),
      gates: row.gates,
      first: {
        kind: row.first.kind,
        observedTravelPx: row.first.observedTravelPx,
        selectionAtRelease: row.first.selectionAtRelease,
        requests: row.first.requests,
        queries: row.first.queries,
        lookupDelta: row.first.lookupDelta,
        trigger: row.first.trigger,
        capture: row.first.capture,
      },
      second: {
        mouseDownDetail: row.second.mouseDownDetail,
        emittedDoubleClick: row.second.emittedDoubleClick,
        order: row.second.order,
      },
      final: {
        kind: row.final.kind,
        requests: row.final.requests,
        queries: row.final.queries,
        lookupDelta: row.final.lookupDelta,
        trigger: row.final.trigger,
      },
      measuredGapMs: row.measuredGapMs,
    })),
  }
}

// --- restore the isolated profile's switches --------------------------------
//
// These writes persist to the profile's patch, and `B20` asserts the *boot*
// defaults are off. A probe that walked away having persisted `true/true` would
// make the next run's first boot fail a check about a different subject.
const restoredSwitches = await ensureSwitches(page, SWEEP_GATES)
console.log(`phase421: isolated profile switches restored to ${JSON.stringify(restoredSwitches)}`)

const helperShutdown = await mouse.close()

// Read once for the evidence header. `BrowserContext.browser()` is null for a
// persistent context, so the version is asked for over CDP — reading, not input.
let browserVersion = 'unknown'
try {
  const cdp = await browserContext.newCDPSession(page)
  const version = await cdp.send('Browser.getVersion')
  browserVersion = version.product
  await cdp.detach()
} catch {
  browserVersion = await page.evaluate(() => navigator.userAgent)
}
await browserContext.close()
const stopped = await stopDsh(child)

// --- report -----------------------------------------------------------------
const provenanceChannel = externalInputObserved ? 'external cursor movement was observed on the desktop during this run' : 'none observed'

const verdict = !probeValid
  ? {
      status: 'BLOCKED — NATIVE INPUT PROBE INVALID',
      case: 'INVALID',
      nativeOverlap: null,
      summary:
        'the negative controls failed, so nothing measured here can be called Windows-native double-click evidence',
    }
  : nativeOverlapObserved
    ? {
        status: 'BLOCKED — NATIVE OVERLAP CONFIRMED / PRODUCT TRADE-OFF REQUIRED',
        case: 'B',
        nativeOverlap: 'OBSERVED',
        summary:
          'a first press the product classified as a drag, with an eligible selection, still became the first half of a double click Windows recognised',
      }
    : {
        status: 'PASS — PHASE 4.2 NATIVE OVERLAP NOT OBSERVED / READY FOR INDEPENDENT REVIEW',
        case: 'A',
        nativeOverlap: 'NOT OBSERVED',
        summary:
          'through the real Windows input stack no first press that the product classified as a drag was followed by a platform-recognised double click',
      }

const report = {
  phase: '4.2.1',
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
  environment: {
    node: process.version,
    dshVersion,
    windows: systemMetrics.os,
    chromium: browserVersion,
    playwright: '1.63.0',
  },
  nativeInput: {
    helper: 'scripts/windows-native-mouse-probe.ps1',
    helperPid: handshake.pid,
    sizeOfInput: handshake.sizeOfInput,
    dpiAwarenessRequestGranted: handshake.awarenessRequestGranted,
    originalCursor: handshake.originalCursor,
    systemMetrics,
    sendInput: {
      mechanism: 'SendInput',
      moveFlags: 'MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK|MOVE_NOCOALESCE',
      clickCountSupplied: false,
    },
  },
  window: {
    marker: MARKER,
    hwnd: target.hwnd,
    pid: target.pid,
    className: target.className,
    windowRect: foreground.result.window.windowRect,
    clientRectOnScreen: foreground.result.window.clientRectOnScreen,
    foregroundAttempts: foreground.result.attempts,
    holdsForeground: foreground.result.holds,
  },
  page: pageFacts,
  word: 'derivation',
  wordBox: box,
  anchor,
  setup: {
    firstRunDialog: onboarding,
    anchorHitTest: anchorHit,
  },
  dragThresholdPx: DRAG_THRESHOLD_PX,
  firstPressSweep: [...FIRST_PRESS_SWEEP],
  calibration,
  interference: {
    idleSamples,
    idleDistinctPositions: idleDistinct,
    idleTravelPx,
    externalInputObserved,
    events: interference,
    summary: provenanceChannel,
  },
  controls: {
    timeout: timeoutControl,
    spatial: spatialControl,
    probeValid,
    timeoutRows,
    spatialRows,
  },
  timeSweep: timeoutRows,
  spatialSweep: spatialRows,
  groupA,
  groupB,
  confirmation,
  overlapOwnership,
  verdict: {
    ...verdict,
    overlapRows: overlapRows.map((row) => ({ id: row.id, group: row.group, travelPx: row.requestedTravelPx, observedTravelPx: row.first.observedTravelPx })),
    dragClassifiedRows: [...groupA, ...groupB, ...confirmation]
      .filter((row) => row.contaminated !== true && row.first.kind === 'drag' && (row.first.observedTravelPx ?? 0) >= DRAG_THRESHOLD_PX)
      .map((row) => ({ id: row.id, group: row.group, travelPx: row.requestedTravelPx, doubleClick: row.second.emittedDoubleClick })),
  },
  consoleErrors: state.consoleErrors,
  pageErrors: state.pageErrors,
  restoredSwitches,
  boot: { pid: log.pid, startedAt: log.startedAt, stderr: redactTokens(log.stderr).slice(-4000) },
  helper: { exitCode: helperShutdown.exitCode, stderr: helperShutdown.stderr.slice(-2000) },
  dshStopped: stopped,
  screenshots,
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${redactTokens(JSON.stringify(report, null, 2))}\n`, 'utf8')

console.log('')
console.log(`phase421: ${verdict.status}`)
console.log(`phase421: native first-press overlap — ${String(verdict.nativeOverlap)}`)
console.log(`phase421: drag-classified rows: ${String(report.verdict.dragClassifiedRows.length)}, of which double-clicked: ${String(report.verdict.overlapRows.length)}`)
if (overlapOwnership !== null) {
  for (const entry of overlapOwnership.states) {
    console.log(
      `phase421: ${entry.state} overlap ownership -> ${String(entry.final.requests)} request(s) ` +
        `(auto-selection ${String(entry.final.lookupDelta['auto-selection'])}, auto-double-click ${String(entry.final.lookupDelta['auto-double-click'])})`,
    )
  }
}
console.log(`phase421: evidence written to ${OUT_PATH}`)
console.log(`phase421: isolated instance stopped (${String(stopped)})`)

process.exit(0)
