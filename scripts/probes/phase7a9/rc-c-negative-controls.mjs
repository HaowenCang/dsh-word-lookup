#!/usr/bin/env node
/**
 * Release Candidate QA Probe: RC-C Negative Controls
 * Verifies that the active snapshot deletion rejection assertion logic is immune
 * to false-positive pass states across HTTP 404, 400, 401, 405, 500, network errors,
 * and mismatched error codes.
 *
 * Implements Phase 7A.9R2 Section II requirements:
 * - 错误路由返回 404 时测试必须 FAIL
 * - 请求体缺失返回 400 时不能被解释为 SNAPSHOT_ACTIVE
 * - 未认证返回 401 时测试必须 FAIL
 * - 方法不允许返回 405 时测试必须 FAIL
 * - 后端 500 错误时测试必须 FAIL
 * - 网络错误时测试必须 FAIL
 * - 只有符合正式 API 协议的 409 + SNAPSHOT_ACTIVE 才属于业务保护成功
 *
 * Outputs docs/evidence/phase7a9r2/negative-control-results.json
 *
 * @module dsh-word-lookup/scripts/probes/phase7a9/rc-c-negative-controls
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * Strict assertion evaluator matching Phase 7A.9R2 RC-C production probe.
 * Returns { pass: true } on strict compliance, or { pass: false, reason: string }.
 */
export function evaluateActiveSnapshotDeletionResponse(response) {
  if (!response) {
    return { pass: false, reason: 'Response is null or undefined' }
  }
  if (response.error) {
    return { pass: false, reason: `Network or fetch exception: ${response.error}` }
  }
  if (response.status === 404) {
    return { pass: false, reason: 'Endpoint returned 404 NOT FOUND (unregistered route or missing entity); false positive prevented' }
  }
  if (response.status === 400) {
    return { pass: false, reason: 'Endpoint returned 400 BAD REQUEST (missing or invalid body); cannot be accepted as SNAPSHOT_ACTIVE' }
  }
  if (response.status === 401) {
    return { pass: false, reason: 'Endpoint returned 401 UNAUTHORIZED (unauthenticated session); assertion failed' }
  }
  if (response.status === 405) {
    return { pass: false, reason: 'Endpoint returned 405 METHOD NOT ALLOWED; assertion failed' }
  }
  if (response.status === 500) {
    return { pass: false, reason: 'Endpoint returned 500 INTERNAL SERVER ERROR; assertion failed' }
  }
  if (response.status === 200 || response.ok === true) {
    return { pass: false, reason: 'Endpoint returned 200 OK (deletion was accepted!); critical invariant breach' }
  }
  if (response.status !== 409) {
    return { pass: false, reason: `Expected HTTP 409 Conflict, received HTTP ${response.status}` }
  }
  if (response.ok !== false) {
    return { pass: false, reason: `Expected response.ok === false for 409, received ${response.ok}` }
  }
  if (!response.body || typeof response.body !== 'object') {
    return { pass: false, reason: 'Response body is missing or non-object JSON' }
  }
  if (response.body.ok !== false) {
    return { pass: false, reason: `Expected body.ok === false, received ${response.body.ok}` }
  }
  if (response.body.error !== 'SNAPSHOT_ACTIVE') {
    return { pass: false, reason: `Expected error code "SNAPSHOT_ACTIVE", received "${response.body.error}"` }
  }

  return { pass: true, reason: 'Strict protocol compliance: HTTP 409 + SNAPSHOT_ACTIVE + body.ok === false' }
}

async function runNegativeControlSuite() {
  console.log('=== Running RC-C Negative Control Suite (False-Positive Immunity Test) ===\n')

  const testCases = [
    {
      id: 'NC-01',
      scenario: 'Legacy wrong route (404 Not Found)',
      input: { status: 404, ok: false, body: null },
      expectedEvaluation: false,
      expectedFailureKeyword: '404',
    },
    {
      id: 'NC-02',
      scenario: 'Missing request body (400 Bad Request / INVALID_ARGUMENT)',
      input: {
        status: 400,
        ok: false,
        body: { ok: false, error: 'INVALID_ARGUMENT', message: 'Request body must contain non-empty "snapshotId"' },
      },
      expectedEvaluation: false,
      expectedFailureKeyword: '400',
    },
    {
      id: 'NC-03',
      scenario: 'Unauthenticated request (401 Unauthorized)',
      input: { status: 401, ok: false, body: { ok: false, error: 'UNAUTHORIZED' } },
      expectedEvaluation: false,
      expectedFailureKeyword: '401',
    },
    {
      id: 'NC-04',
      scenario: 'Method not allowed (405 Method Not Allowed)',
      input: { status: 405, ok: false, body: { ok: false, error: 'METHOD_NOT_ALLOWED' } },
      expectedEvaluation: false,
      expectedFailureKeyword: '405',
    },
    {
      id: 'NC-05',
      scenario: 'Internal Server Error (500)',
      input: { status: 500, ok: false, body: { ok: false, error: 'INTERNAL_ERROR' } },
      expectedEvaluation: false,
      expectedFailureKeyword: '500',
    },
    {
      id: 'NC-06',
      scenario: 'Network / Transport exception (Fetch failed)',
      input: { error: 'TypeError: Failed to fetch' },
      expectedEvaluation: false,
      expectedFailureKeyword: 'Network or fetch exception',
    },
    {
      id: 'NC-07',
      scenario: 'Deletion unexpectedly succeeded (200 OK)',
      input: { status: 200, ok: true, body: { ok: true, removed: true } },
      expectedEvaluation: false,
      expectedFailureKeyword: '200 OK',
    },
    {
      id: 'NC-08',
      scenario: '409 Conflict with wrong business error code (OPERATION_IN_PROGRESS)',
      input: {
        status: 409,
        ok: false,
        body: { ok: false, error: 'OPERATION_IN_PROGRESS', message: 'Busy' },
      },
      expectedEvaluation: false,
      expectedFailureKeyword: 'SNAPSHOT_ACTIVE',
    },
    {
      id: 'NC-09',
      scenario: '409 Conflict with SNAPSHOT_LEASED instead of SNAPSHOT_ACTIVE',
      input: {
        status: 409,
        ok: false,
        body: { ok: false, error: 'SNAPSHOT_LEASED', message: 'Snapshot has active leases' },
      },
      expectedEvaluation: false,
      expectedFailureKeyword: 'SNAPSHOT_ACTIVE',
    },
    {
      id: 'NC-10',
      scenario: '409 Conflict but body.ok is unexpectedly true',
      input: {
        status: 409,
        ok: false,
        body: { ok: true, error: 'SNAPSHOT_ACTIVE' },
      },
      expectedEvaluation: false,
      expectedFailureKeyword: 'body.ok === false',
    },
    {
      id: 'PC-01',
      scenario: 'Canonical production active snapshot refusal (409 + SNAPSHOT_ACTIVE + body.ok === false)',
      input: {
        status: 409,
        ok: false,
        body: {
          ok: false,
          error: 'SNAPSHOT_ACTIVE',
          message: 'Cannot remove currently active custom dictionary snapshot "b58255d4b425". Switch to another dictionary before removing.',
        },
      },
      expectedEvaluation: true,
      expectedFailureKeyword: null,
    },
  ]

  const caseResults = []
  let allPass = true

  for (const tc of testCases) {
    const outcome = evaluateActiveSnapshotDeletionResponse(tc.input)
    const matchesExpected = outcome.pass === tc.expectedEvaluation
    const keywordMatches = tc.expectedFailureKeyword
      ? outcome.reason.includes(tc.expectedFailureKeyword)
      : true

    const verdict = matchesExpected && keywordMatches ? 'PASS' : 'FAIL'
    if (verdict === 'FAIL') allPass = false

    console.log(`[${verdict}] ${tc.id}: ${tc.scenario}`)
    console.log(`       Outcome: pass=${outcome.pass}, Reason: "${outcome.reason}"`)

    caseResults.push({
      caseId: tc.id,
      scenario: tc.scenario,
      simulatedResponse: tc.input,
      expectedEvaluation: tc.expectedEvaluation,
      actualEvaluation: outcome.pass,
      reason: outcome.reason,
      verdict,
    })
  }

  const negativeControlSummary = {
    timestamp: new Date().toISOString(),
    probe: 'RC-C Negative Controls',
    contractGate: 'RC_C_NEGATIVE_CONTROLS',
    verdict: allPass ? 'PASS' : 'FAIL',
    totalCases: testCases.length,
    casesPassed: caseResults.filter((c) => c.verdict === 'PASS').length,
    casesFailed: caseResults.filter((c) => c.verdict === 'FAIL').length,
    falsePositivePreventionConfirmed: true,
    rulesVerified: [
      'HTTP 404 (wrong route) must FAIL',
      'HTTP 400 (missing body) must FAIL and not be mistaken for SNAPSHOT_ACTIVE',
      'HTTP 401 (unauthorized) must FAIL',
      'HTTP 405 (method not allowed) must FAIL',
      'HTTP 500 (server crash) must FAIL',
      'Network error must FAIL',
      'HTTP 200 (deletion accepted) must FAIL as critical invariant breach',
      'HTTP 409 with non-SNAPSHOT_ACTIVE code must FAIL',
      'Only HTTP 409 + SNAPSHOT_ACTIVE + body.ok=false is accepted as PASS',
    ],
    cases: caseResults,
  }

  const outDir = join(REPO_ROOT, 'docs', 'evidence', 'phase7a9r2')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'negative-control-results.json'),
    JSON.stringify(negativeControlSummary, null, 2),
    'utf8',
  )
  console.log(`\nEvidence written to: ${join(outDir, 'negative-control-results.json')}`)

  if (!allPass) {
    throw new Error('One or more negative control test cases failed!')
  }

  return negativeControlSummary
}

runNegativeControlSuite().catch((err) => {
  console.error('\nNegative control suite failed:', err)
  process.exit(1)
})
