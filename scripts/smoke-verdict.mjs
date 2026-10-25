/** Fixed required IDs may also declare optional observations as {id, optional:true}. */
export function evaluateSmokeVerdict(observations, requiredIds) {
  if (Array.isArray(observations) && observations.some((row) => row?.status === 'FAIL')) return 'FAIL'
  if (!Array.isArray(observations) || !Array.isArray(requiredIds) || requiredIds.length === 0) return 'INCOMPLETE'
  const declarations = requiredIds.map((item) => typeof item === 'string' ? { id: item, optional: false } : item)
  if (declarations.some((item) => !item || typeof item.id !== 'string' || !item.id || (item.optional !== undefined && typeof item.optional !== 'boolean'))) return 'INCOMPLETE'
  const declared = new Map(declarations.map((item) => [item.id, item]))
  if (declared.size !== declarations.length) return 'INCOMPLETE'
  const seen = new Set()
  for (const row of observations) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id) || !declared.has(row.id)) return 'INCOMPLETE'
    seen.add(row.id)
    if (row.status !== 'PASS' && !(declared.get(row.id).optional === true && row.status === 'SKIPPED')) return 'INCOMPLETE'
  }
  return declarations.every((item) => item.optional === true || seen.has(item.id)) ? 'PASS' : 'INCOMPLETE'
}

/** The locally inspected rc.2 connection handler returns exactly 404 for missing routes. */
export const ROUTE_MISSING_CONTRACT = 'dsh-client-connection@0.2.0-rc.2:404'

/** A failed request is never evidence that a plugin was successfully removed. */
export function evaluateUninstallProof(proof) {
  return proof?.route?.kind === 'response' && proof.route.status === 404 &&
    proof.base?.kind === 'response' && proof.base.status === 200 &&
    proof.base.authenticated === true && proof.base.identified === true &&
    proof.registration?.kind === 'inventory' && proof.registration.absent === true &&
    proof.routeMissingContract === ROUTE_MISSING_CONTRACT ? 'PASS' : 'FAIL'
}

/** Convert the collector's measured card fields into independent required checks. */
export function formattingObservations(metrics) {
  const ordered = (rects, count) => Array.isArray(rects) && rects.length === count && rects.every((rect, i) => Number.isFinite(rect?.top) && (i === 0 || rect.top > rects[i - 1].top))
  const row = (id, ok) => ({ id, status: ok ? 'PASS' : 'FAIL' })
  return [
    row('literal-escaping', metrics?.hasLiteralEscapeInText === false),
    row('line-count', metrics?.transLineCount === 3 && metrics?.defLineCount === 4),
    row('vertical-layout', ordered(metrics?.transRects, 3) && ordered(metrics?.defRects, 4)),
    row('pos', metrics?.hasDuplicatePos === false && typeof metrics?.firstTransLine === 'string' && metrics.firstTransLine.startsWith('n.')),
  ]
}

/** Verify measured movement and overflow directly; equality is not scrollability. */
export function scrollObservation(metrics, id = 'scroll') {
  const values = ['scrollHeight', 'clientHeight', 'scrollWidth', 'clientWidth', 'beforeScroll', 'afterScroll']
  const ok = values.every((key) => Number.isFinite(metrics?.[key])) &&
    metrics.clientHeight > 0 && metrics.clientHeight <= 440 && metrics.clientWidth > 0 &&
    metrics.scrollHeight > metrics.clientHeight && metrics.afterScroll > metrics.beforeScroll &&
    metrics.scrollWidth <= metrics.clientWidth + 1
  return { id, status: ok ? 'PASS' : 'FAIL', metrics }
}

const redactError = (error) => String(error?.message ?? error).replace(/([?&]token=)[^\s&]+/g, '$1REDACTED')

/** Preserve the collection failure and every failed cleanup operation. */
export function smokeLifecycleFailure(primaryError, cleanupErrors = [], startupState) {
  const error = cleanupErrors.length === 0 && primaryError instanceof Error ? primaryError :
    new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors],
      [primaryError && redactError(primaryError), ...cleanupErrors.map((item) => `cleanup: ${redactError(item)}`)].filter(Boolean).join('; '))
  if (cleanupErrors.length > 0) {
    error.primaryError = primaryError
    error.cleanupErrors = cleanupErrors
  }
  if (startupState) error.startupState = startupState
  return error
}

/** Await only this owned child's readiness; error/exit/timeout settle once. */
export function waitForSmokeStartup(child, { timeoutMs, label, stopChild, setTimer = setTimeout, clearTimer = clearTimeout, onChildError }) {
  let stdout = '', stderr = '', settled = false, ready = false, timer
  const hasPid = () => Number.isInteger(child.pid) && child.pid > 0
  const exited = () => Number.isInteger(child.exitCode) || (typeof child.signalCode === 'string' && child.signalCode.length > 0)
  return new Promise((resolve, reject) => {
    const clear = () => { if (timer !== undefined) { clearTimer(timer); timer = undefined } }
    const fail = async (primaryError, reason) => {
      if (settled) return
      settled = true
      clear()
      const cleanupErrors = []
      const startupState = {
        spawnStatus: hasPid() ? 'STARTED' : reason === 'error' && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(primaryError.code) ? 'NOT_STARTED' : 'UNKNOWN',
        exitConfirmed: exited(),
      }
      // Missing PID is not an owned kill target. In particular, failed spawn
      // must not be sent through taskkill or relabeled as an exited process.
      if (hasPid() && !exited()) {
        try { await stopChild(child) } catch (error) { cleanupErrors.push(error) }
      }
      startupState.exitConfirmed = exited()
      reject(smokeLifecycleFailure(primaryError, cleanupErrors, startupState))
    }
    // Attach before timers or stream consumers: spawn ENOENT/EACCES is an
    // asynchronous ChildProcess error, not an exit or a thrown spawn call.
    child.on('error', (error) => {
      if (settled) { if (ready) onChildError?.(error); return }
      void fail(error, 'error')
    })
    child.once('exit', (code) => { void fail(new Error(`${label} exited before readiness with code ${code}\n${stdout}\n${stderr}`), 'exit') })
    const consume = (chunk, isStderr) => {
      const text = chunk.toString().replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      if (isStderr) stderr += text
      else stdout += text
      const match = /https?:\/\/[^\s"']*\/\?token=[A-Za-z0-9._~-]+/.exec(stdout)
      if (!settled && match) {
        settled = true
        ready = true
        clear()
        resolve({ child, url: match[0], stdoutLog: () => stdout, stderrLog: () => stderr })
      }
    }
    child.stdout?.on('data', (chunk) => consume(chunk, false))
    child.stderr?.on('data', (chunk) => consume(chunk, true))
    timer = setTimer(() => { void fail(new Error(`${label} startup timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`), 'timeout') }, timeoutMs)
  })
}

function errorEvidence(error, depth = 0) {
  const evidence = { message: redactError(error) }
  if (error?.startupState) evidence.startupState = error.startupState
  if (typeof error?.code === 'string') evidence.code = error.code
  if (depth < 4) {
    if (error?.primaryError) evidence.primaryError = errorEvidence(error.primaryError, depth + 1)
    if (Array.isArray(error?.cleanupErrors)) evidence.cleanupErrors = error.cleanupErrors.map((item) => errorEvidence(item, depth + 1))
  }
  return evidence
}

/** Run a collector and persist its observation-derived verdict, including exceptions. */
export async function runObservedSmoke({ evidence, requiredIds, execute, writeReport, log = console.log }) {
  try {
    await execute(evidence)
  } catch (error) {
    evidence.observations.push({ id: 'execution-error', status: 'FAIL', ...errorEvidence(error) })
  }
  evidence.verdict = evaluateSmokeVerdict(evidence.observations, requiredIds)
  const exitCode = evidence.verdict === 'PASS' ? 0 : 1
  await writeReport(evidence)
  log(`Overall smoke test verdict: ${evidence.verdict} | Exit Code: ${exitCode}`)
  return { report: evidence, exitCode }
}
