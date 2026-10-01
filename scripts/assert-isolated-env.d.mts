/**
 * Types for {@link ./assert-isolated-env.mjs}.
 *
 * The isolation gate is plain ESM so that runner scripts can import it without
 * a build step; this declaration is what lets the TypeScript test suite assert
 * the gate's behaviour under `npm run typecheck`.
 */

/** Printed exactly once, only after every assertion holds. */
export declare const ISOLATION_BANNER: string

/** Default scratch root; every isolated home must live underneath it. */
export declare const DEFAULT_TEST_ROOT: string

/** Ports the daily instance has served on in this environment. */
export declare const PRODUCTION_PORTS: readonly number[]

/** Profiles that carry real conversation data and are therefore off limits. */
export declare const FORBIDDEN_PROFILES: readonly string[]

/** The production facts a test target must avoid. */
export interface ProductionFacts {
  /** Absolute production `DSH_HOME` candidates. */
  homes: string[]
  /** Ports the production instance has used. */
  ports: Set<number>
  /** Profile names that carry real data. */
  profiles: Set<string>
}

/** The target being checked. */
export interface IsolationFacts {
  /** Resolved `DSH_HOME` the test would use. */
  home?: string
  /** Profile name the test would load. */
  profile?: string
  /** TCP port the test would bind. */
  port?: number | string
  /** Optional profile directory; derived from `home` and `profile` when omitted. */
  profileDir?: string
  /** Scratch root; defaults to `DEFAULT_TEST_ROOT`. */
  testRoot?: string
  /** Environment to read production facts from. */
  env?: Record<string, string | undefined>
}

/** A target that passed every assertion. */
export interface VerifiedEnvironment {
  /** Verified isolated home. */
  home: string
  /** Verified isolated profile name. */
  profile: string
  /** Verified isolated profile directory. */
  profileDir: string
  /** Verified test port, or `undefined` when the caller binds no port. */
  port: number | undefined
  /** The scratch root the home lives under. */
  testRoot: string
  /** Production homes that were checked against. */
  productionHomes: string[]
  /** Production ports that were checked against. */
  productionPorts: number[]
}

/** Thrown when a target is not provably isolated. */
export declare class IsolationError extends Error {
  /** One human-readable line per failed assertion. */
  readonly violations: string[]
  constructor(violations: string[])
}

/** Resolve a path to a comparable absolute form. */
export declare function normalisePath(path: string): string

/** Whether one path is the other or lives underneath it. */
export declare function isInsideOrEqual(child: string, parent: string): boolean

/** The facts about the production environment that tests must avoid. */
export declare function productionFacts(env?: Record<string, string | undefined>): ProductionFacts

/** Assert that a DSH target is a scratch environment. */
export declare function assertIsolatedDshEnvironment(facts: IsolationFacts): VerifiedEnvironment

/** Whether a TCP port is currently free. */
export declare function isPortFree(port: number): Promise<boolean>

/** Build the environment for an isolated `dsh` child process. */
export declare function buildIsolatedEnv(
  verified: VerifiedEnvironment,
  base?: Record<string, string | undefined>,
): Record<string, string>
