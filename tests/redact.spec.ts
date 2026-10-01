/**
 * Launch-token scrubbing for evidence files.
 *
 * The regression this file exists for is real: the harness redacted `bootLogs`
 * and the second boot's log, but wrote `environment.firstBootUrl` and
 * `environment.secondBootUrl` verbatim, so a run's report contained two live
 * launch tokens. `docs/evidence/` is committed, so the failure mode is a
 * credential in the repository.
 *
 * The scrub is therefore asserted structurally 鈥?on a report shaped like the one
 * that leaked 鈥?rather than field by field.
 */

import { describe, expect, it } from 'vitest'

import { REDACTED_TOKEN, redactTokenText, redactTokens } from '../scripts/redact.mjs'

/**
 * A launch URL with a token, in the shape DSH actually prints.
 *
 * The value is fabricated for this test and is deliberately not a random-looking
 * string: it is 43 characters 鈥?the length of a real launch token 鈥?drawn from
 * the same alphabet, so the scrub is exercised against a faithful shape, while a
 * reader or a scanner can see at a glance that it was never minted by anything.
 * Committing a value that merely *looks* like a credential is a false positive
 * every future credential scan has to reason about.
 */
const LAUNCH_URL = 'http://127.0.0.1:50991/?token=NOTAREALCREDENTIALAAAAAAAAAAAAAAAAAAAAAAAAA'

/** A second, different fabricated token. */
const OTHER_URL = 'http://127.0.0.1:50991/?token=FIXTUREONLYVALUEBBBBBBBBBBBBBBBBBBBBBBBBBBB'

describe('redactTokenText', () => {
  it('removes the token from a launch URL', () => {
    expect(redactTokenText(LAUNCH_URL)).toBe(`http://127.0.0.1:50991/?${REDACTED_TOKEN}`)
  })

  it('keeps everything around the token intact', () => {
    const scrubbed = redactTokenText('dsh web: http://127.0.0.1:50991/?token=abc123\n')
    expect(scrubbed).toBe('dsh web: http://127.0.0.1:50991/?token=<redacted>\n')
  })

  it('removes every token, not only the first', () => {
    const scrubbed = redactTokenText(`${LAUNCH_URL} then ${OTHER_URL}`)
    expect(scrubbed).not.toContain('NOTAREALCREDENTIAL')
    expect(scrubbed).not.toContain('FIXTUREONLYVALUE')
    expect(scrubbed.match(/token=<redacted>/g)).toHaveLength(2)
  })

  it('leaves text with no token untouched', () => {
    expect(redactTokenText('http://127.0.0.1:50991/')).toBe('http://127.0.0.1:50991/')
    expect(redactTokenText('')).toBe('')
  })

  it('scrubs a token inside an error stack', () => {
    // The harness writes the failure path too, so a stack can carry the URL.
    const stack = `Error: navigation failed\n    at open (${LAUNCH_URL})`
    expect(redactTokenText(stack)).not.toContain('NOTAREALCREDENTIAL')
  })
})

describe('redactTokens', () => {
  it('scrubs the environment block that previously leaked', () => {
    // The exact shape of the regression.
    const report = {
      environment: {
        home: 'C:\\Users\\20659\\AppData\\Local\\Temp\\dsh-word-lookup-test\\home',
        profile: 'word-lookup-test',
        port: 50991,
        firstBootUrl: LAUNCH_URL,
        secondBootUrl: OTHER_URL,
        browserVersion: '153.0.8010.12',
      },
    }
    const scrubbed = redactTokens(report)
    const serialized = JSON.stringify(scrubbed)
    expect(serialized).not.toContain('NOTAREALCREDENTIAL')
    expect(serialized).not.toContain('FIXTUREONLYVALUE')
    expect(scrubbed.environment.firstBootUrl).toBe(`http://127.0.0.1:50991/?${REDACTED_TOKEN}`)
    // Everything that is not a secret must survive: the report is evidence.
    expect(scrubbed.environment.profile).toBe('word-lookup-test')
    expect(scrubbed.environment.port).toBe(50991)
    expect(scrubbed.environment.browserVersion).toBe('153.0.8010.12')
  })

  it('scrubs boot logs, arrays and nested results', () => {
    const report = {
      bootLogs: [
        { bootIndex: 1, stdout: `dsh web: ${LAUNCH_URL}\n`, stderr: '', pid: 53676 },
        { bootIndex: 2, stdout: `dsh web: ${OTHER_URL}\n`, stderr: '' },
      ],
      facts: { secondBootLog: `dsh web: ${LAUNCH_URL}\n`, nested: { deeper: [LAUNCH_URL] } },
    }
    const serialized = JSON.stringify(redactTokens(report))
    expect(serialized).not.toMatch(/token=(?!<redacted>)/)
    expect(serialized.match(/token=<redacted>/g)).toHaveLength(4)
  })

  it('leaves non-string leaves untouched', () => {
    const value = { n: 1, t: true, f: false, nothing: null, list: [1, 2, 3] }
    expect(redactTokens(value)).toEqual(value)
  })

  it('does not mutate the input', () => {
    const report = { environment: { firstBootUrl: LAUNCH_URL } }
    redactTokens(report)
    expect(report.environment.firstBootUrl).toBe(LAUNCH_URL)
  })

  it('passes a bare string through the same scrub', () => {
    expect(redactTokens(LAUNCH_URL)).toBe(`http://127.0.0.1:50991/?${REDACTED_TOKEN}`)
  })

  it('handles a report with no token at all', () => {
    const report = { status: 'PASS', summary: { total: 77, passed: 77, failed: [] } }
    expect(redactTokens(report)).toEqual(report)
  })

  it('scrubs the whole ERROR report the harness writes when it aborts', () => {
    // `phase1-verify.mjs` has two write paths: the normal report and the
    // `status: 'ERROR'` report written from the top-level catch. The second was
    // the one an earlier field-list scrub missed, so its exact shape is asserted
    // here: the token can reach it through the message, the stack, a recorded
    // result and a boot log at once.
    const report = {
      status: 'ERROR',
      error: `Error: dsh did not print a launch URL within 90s\n    at startDsh (${LAUNCH_URL})`,
      results: [{ id: 'H01', name: 'boot', ok: false, detail: `no URL at ${OTHER_URL}` }],
      bootLogs: [{ bootIndex: 1, stdout: `dsh web: ${LAUNCH_URL}\n`, stderr: `failed: ${LAUNCH_URL}` }],
    }
    const serialized = JSON.stringify(redactTokens(report))
    expect(serialized).not.toMatch(/token=(?!<redacted>)/)
    expect(serialized).not.toContain('NOTAREALCREDENTIAL')
    expect(serialized).not.toContain('FIXTUREONLYVALUE')
    // The report must still say what went wrong.
    expect(serialized).toContain('did not print a launch URL')
  })
})
