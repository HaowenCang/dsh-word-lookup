/**
 * Tests for the isolation gate.
 *
 * The gate is the only thing standing between a test run and the reader's real
 * DSH home, so its refusals are themselves a tested contract: every assertion
 * below corresponds to one way a target could reach production.
 *
 * @module dsh-word-lookup/tests/iso-guard
 */

import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertIsolatedDshEnvironment,
  buildIsolatedEnv,
  IsolationError,
  isInsideOrEqual,
  ISOLATION_BANNER,
  productionFacts,
} from '../scripts/assert-isolated-env.mjs'

/** The production home on this machine, as the gate computes it. */
const PRODUCTION_HOME = resolve(join(homedir(), '.dsh'))

/** A scratch root that satisfies the gate's location rule. */
const TEST_ROOT = resolve(join(tmpdir(), 'dsh-word-lookup-test'))

/** A production-shaped environment, used to prove the gate reads it. */
const PRODUCTION_ENV = {
  DSH_HOME: PRODUCTION_HOME,
  DSH_PROFILE: 'desktop',
  DSH_WEB_URL: 'http://127.0.0.1:19387',
}

/** A well-formed isolated target, used as the baseline each test perturbs. */
const ISOLATED = {
  home: join(TEST_ROOT, 'home'),
  profile: 'word-lookup-test',
  port: 50991,
  testRoot: TEST_ROOT,
  env: PRODUCTION_ENV,
}

/**
 * Run the gate and return the violations it reported.
 *
 * @param facts - the target to check.
 * @returns the violation lines, or an empty array when the target was accepted.
 */
function violationsFor(facts: Parameters<typeof assertIsolatedDshEnvironment>[0]): string[] {
  try {
    assertIsolatedDshEnvironment(facts)
    return []
  } catch (error) {
    if (error instanceof IsolationError) return error.violations
    throw error
  }
}

describe('assertIsolatedDshEnvironment', () => {
  it('accepts a scratch home under the test root on a non-production port', () => {
    const verified = assertIsolatedDshEnvironment(ISOLATED)

    expect(verified.home).toBe(resolve(ISOLATED.home))
    expect(verified.profile).toBe('word-lookup-test')
    expect(verified.port).toBe(50991)
    expect(verified.profileDir).toBe(resolve(join(ISOLATED.home, 'profiles', 'word-lookup-test')))
    expect(ISOLATION_BANNER).toBe('ISOLATION CHECK: PASS')
  })

  it('refuses the production DSH_HOME itself', () => {
    const violations = violationsFor({ ...ISOLATED, home: PRODUCTION_HOME })

    expect(violations.join('\n')).toContain('is the production DSH_HOME')
  })

  it('refuses a home nested inside the production DSH_HOME', () => {
    const violations = violationsFor({ ...ISOLATED, home: join(PRODUCTION_HOME, 'profiles', 'scratch') })

    expect(violations.join('\n')).toContain('resolves inside the production DSH_HOME')
  })

  it('refuses the daily and damaged profile names', () => {
    for (const profile of ['web', 'desktop', 'WEB', 'Desktop']) {
      const violations = violationsFor({ ...ISOLATED, profile })
      expect(violations.join('\n'), profile).toContain('is a production profile name')
    }
  })

  it('refuses a home outside the test root', () => {
    const violations = violationsFor({ ...ISOLATED, home: resolve(join(tmpdir(), 'somewhere-else')) })

    expect(violations.join('\n')).toContain('is outside the test root')
  })

  it('refuses a test root that itself resolves into production', () => {
    const violations = violationsFor({
      ...ISOLATED,
      home: join(PRODUCTION_HOME, 'scratch', 'home'),
      testRoot: join(PRODUCTION_HOME, 'scratch'),
    })

    expect(violations.join('\n')).toContain('the test root resolves into the production DSH_HOME')
  })

  it('refuses both ports the production instance has served on', () => {
    for (const port of [19387, 50001]) {
      const violations = violationsFor({ ...ISOLATED, port })
      expect(violations.join('\n'), String(port)).toContain(`port ${port} is a production DSH port`)
    }
  })

  it('refuses a port that is not a usable TCP port', () => {
    for (const port of [0, 80, 70000, Number.NaN]) {
      const violations = violationsFor({ ...ISOLATED, port })
      expect(violations.join('\n'), String(port)).toContain('is not a usable TCP port')
    }
  })

  it('refuses a profile directory that is not <home>/profiles/<profile>', () => {
    const violations = violationsFor({ ...ISOLATED, profileDir: join(TEST_ROOT, 'elsewhere') })

    expect(violations.join('\n')).toContain('profileDir is not <home>/profiles/<profile>')
  })

  it('refuses an empty target rather than defaulting to anything', () => {
    expect(() => assertIsolatedDshEnvironment({ env: PRODUCTION_ENV })).toThrow(IsolationError)
    expect(violationsFor({ home: ISOLATED.home, profile: '', port: 50991, testRoot: TEST_ROOT, env: PRODUCTION_ENV })).toEqual(
      expect.arrayContaining(['no test profile name was supplied']),
    )
  })
})

describe('productionFacts', () => {
  it('treats the live GUI URL as a production port', () => {
    const facts = productionFacts({ DSH_WEB_URL: 'http://127.0.0.1:45678/' })

    expect(facts.ports.has(45678)).toBe(true)
    expect(facts.ports.has(50001)).toBe(true)
  })

  it('always treats ~/.dsh and the live profile name as production', () => {
    const facts = productionFacts({})

    expect(facts.homes.map((entry) => entry.toLowerCase())).toContain(PRODUCTION_HOME.toLowerCase())
    expect(facts.profiles.has('web')).toBe(true)
    expect(facts.profiles.has('desktop')).toBe(true)
  })
})

describe('buildIsolatedEnv', () => {
  it('strips every inherited DSH_ variable and sets only the isolated three', () => {
    const verified = assertIsolatedDshEnvironment(ISOLATED)
    const env = buildIsolatedEnv(verified, {
      PATH: 'C:\\bin',
      DSH_HOME: PRODUCTION_HOME,
      DSH_PROFILE: 'desktop',
      DSH_SESSION_ID: 'session-real',
      DSH_WEB_URL: 'http://127.0.0.1:19387',
      DSH_PROFILE_DIR: join(PRODUCTION_HOME, 'profiles', 'desktop'),
    })

    expect(env.PATH).toBe('C:\\bin')
    expect(env.DSH_HOME).toBe(verified.home)
    expect(env.DSH_PROFILE).toBe('word-lookup-test')
    expect(env.DSH_PROFILE_DIR).toBe(verified.profileDir)
    expect(Object.keys(env).filter((key) => key.startsWith('DSH_'))).toEqual([
      'DSH_HOME',
      'DSH_PROFILE',
      'DSH_PROFILE_DIR',
    ])
  })
})

describe('isInsideOrEqual', () => {
  it('does not treat a sibling with a shared prefix as a descendant', () => {
    expect(isInsideOrEqual(join(TEST_ROOT, 'x'), TEST_ROOT)).toBe(true)
    expect(isInsideOrEqual(`${TEST_ROOT}x`, TEST_ROOT)).toBe(false)
  })
})
