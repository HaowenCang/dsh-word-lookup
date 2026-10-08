/**
 * Scanner negative regression tests for Store Worker audit rules.
 *
 * Implements Phase 7A.5R4 Section 8:
 * Asserts that each forbidden pattern or mutation is strictly caught
 * and rejected by the AST scanner and Store contract verifier.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  auditHostWorkerUsage,
  auditCompanionWorker,
} from '../scripts/store-worker-audit.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const validHostBundle = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
const validWorkerBundle = readFileSync(join(ROOT, 'lib/ecdict-integrity-worker.js'), 'utf8')
const EXACT_WORKER_TARGET = 'new URL("./ecdict-integrity-worker.js", import.meta.url)'

describe('Store Worker Audit Rules & Scanner Negative Regression Matrix', () => {
  it('passes on valid production host and worker bundles', () => {
    const hostAudit = auditHostWorkerUsage(validHostBundle)
    expect(hostAudit.approved).toBe(true)
    expect(hostAudit.workerCount).toBe(1)
    expect(hostAudit.errors).toHaveLength(0)

    const workerAudit = auditCompanionWorker(validWorkerBundle)
    expect(workerAudit.approved).toBe(true)
    expect(workerAudit.errors).toHaveLength(0)
  })

  it('rejects mutation: Worker filename replaced with other file', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      'new URL("./malicious-worker.js", import.meta.url)',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('is not the approved companion worker'))).toBe(true)
  })

  it('rejects mutation: Worker path constructed with string concatenation', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      'new URL("./" + "ecdict-integrity-worker.js", import.meta.url)',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('dynamic string concatenation'))).toBe(true)
  })

  it('rejects mutation: Worker options specify eval: true', () => {
    const mutated = validHostBundle.replace(
      'execArgv: []',
      'execArgv: [], eval: true',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('eval: true'))).toBe(true)
  })

  it('rejects mutation: Worker target uses data: URL', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      '"data:text/javascript,console.log(1)"',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('data: URL'))).toBe(true)
  })

  it('rejects mutation: Worker target uses blob: URL', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      '"blob:http://localhost/uuid"',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('blob: URL'))).toBe(true)
  })

  it('rejects mutation: Worker target is raw string instead of new URL', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      '"./ecdict-integrity-worker.js"',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('raw string instead of static new URL'))).toBe(true)
  })

  it('rejects mutation: Worker target URL base is not import.meta.url', () => {
    const mutated = validHostBundle.replace(
      EXACT_WORKER_TARGET,
      'new URL("./ecdict-integrity-worker.js", "https://evil.com/")',
    )
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('base must be import.meta.url'))).toBe(true)
  })

  it('rejects mutation: Host bundle introduces eval() call', () => {
    const mutated = validHostBundle + '\neval("1 + 1");\n'
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('eval()'))).toBe(true)
  })

  it('rejects mutation: Host bundle introduces new Function() constructor', () => {
    const mutated = validHostBundle + '\nconst fn = new Function("return 42;");\n'
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('Function constructor'))).toBe(true)
  })

  it('rejects mutation: Host bundle introduces dynamic import()', () => {
    const mutated = validHostBundle + '\nconst mod = import("./something.js");\n'
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('dynamic import()'))).toBe(true)
  })

  it('rejects mutation: Host bundle introduces child_process', () => {
    const mutated = validHostBundle + '\nimport "node:child_process";\n'
    const audit = auditHostWorkerUsage(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('child_process'))).toBe(true)
  })

  it('rejects mutation: Worker bundle introduces eval()', () => {
    const mutated = validWorkerBundle + '\neval("console.log(1)");\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('eval()'))).toBe(true)
  })

  it('rejects mutation: Worker bundle introduces Function() constructor', () => {
    const mutated = validWorkerBundle + '\nconst f = Function("return 1");\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('Function constructor'))).toBe(true)
  })

  it('rejects mutation: Worker bundle introduces dynamic import()', () => {
    const mutated = validWorkerBundle + '\nimport("./plugin.js");\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('dynamic import()'))).toBe(true)
  })

  it('rejects mutation: Worker bundle attempts nested Worker instantiation', () => {
    const mutated = validWorkerBundle + '\nnew Worker("./nested.js");\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('nested Worker'))).toBe(true)
  })

  it('rejects mutation: Worker bundle references child_process', () => {
    const mutated = validWorkerBundle + '\nconst cp = require("child_process");\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('child_process'))).toBe(true)
  })

  it('rejects mutation: Worker bundle references process.env credentials', () => {
    const mutated = validWorkerBundle + '\nconst secret = process.env.SECRET_KEY;\n'
    const audit = auditCompanionWorker(mutated)
    expect(audit.approved).toBe(false)
    expect(audit.errors.some((e: string) => e.includes('process.env credentials'))).toBe(true)
  })
})
