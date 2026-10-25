import type { CreatedOwnedTestRoot, OwnedRootOptions, OwnedTestRoot } from '../../isolated-run-directory.mjs'
import type { ChildProcess } from 'node:child_process'
import type { VerifiedEnvironment } from '../../assert-isolated-env.mjs'
import type { SmokeRunOptions, SmokeReport, SmokeStartupDependencies, SmokeStartedChild } from '../../smoke-verdict.mjs'
export declare function bootReleaseDsh(verified: VerifiedEnvironment, port: number, cwd: string, invocation: { cmd: string; baseArgs: string[]; isNodeScript: boolean }, timeoutMs?: number, dependencies?: SmokeStartupDependencies): Promise<SmokeStartedChild>
export declare function cleanupReleaseSmokeResources(resources: {
  context?: { close: () => Promise<void> } | null
  dshInstance?: { child: ChildProcess } | null
  downloadedTarballPath?: string | null
  testPort: number
}, dependencies?: {
  stopChild?: (child: ChildProcess, port: number) => Promise<void>
  exists?: (path: string) => boolean
  removeTarball?: (path: string, options: { force: boolean }) => void
}, primaryError?: unknown): Promise<void>
export declare const RELEASE_REQUIRED_IDS: readonly string[]
export declare function runReleaseSmoke(options?: Partial<SmokeRunOptions>): Promise<{ report: SmokeReport; exitCode: number }>
export declare function collectUninstallProof(options: {
  probe: (rpcId: string) => Promise<unknown>
  anonymousProbe: () => Promise<unknown>
  service: { origin: string; identified: boolean }
  routeContract: { contract: string }
}): Promise<unknown>
export declare function probeUninstallPage(page: {
  evaluate: (fn: (input: { rpcId: string }) => Promise<unknown>, input: { rpcId: string }) => Promise<unknown>
}, rpcId: string): Promise<unknown>
export declare function createReleaseTestRoot(options?: OwnedRootOptions): Promise<CreatedOwnedTestRoot>
export declare function cleanupReleaseTestRoot(owner: OwnedTestRoot, resources: {
  children: Array<{ exitCode: number | null; signalCode: string | null }>
  ports: number[]
  evidencePaths: string[]
}): Promise<void>
