import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface SmokeObservation { id: string; status: string; [key: string]: unknown }
export interface SmokeReport { observations: SmokeObservation[]; verdict?: string; [key: string]: unknown }
export interface SmokeRunOptions {
  execute: (report: SmokeReport) => Promise<void>
  writeReport: (report: SmokeReport) => void | Promise<void>
  log?: (line: string) => void
}
export declare function evaluateSmokeVerdict(observations: unknown, requiredIds: readonly (string | { id: string; optional: boolean })[]): 'PASS' | 'FAIL' | 'INCOMPLETE'
export declare function evaluateUninstallProof(proof: unknown): 'PASS' | 'FAIL'
export declare const ROUTE_MISSING_CONTRACT: string
export declare function formattingObservations(metrics: unknown): SmokeObservation[]
export declare function scrollObservation(metrics: unknown, id?: string): SmokeObservation
export interface SmokeStartupState { spawnStatus: 'STARTED' | 'NOT_STARTED' | 'UNKNOWN'; exitConfirmed: boolean }
export interface SmokeStartedChild { child: ChildProcess; url: string; stdoutLog: () => string; stderrLog: () => string }
export interface SmokeStartupDependencies {
  env?: NodeJS.ProcessEnv
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  stopChild?: (child: ChildProcess, port?: number) => Promise<void>
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  delay?: (milliseconds: number) => Promise<void>
  onChildError?: (error: Error) => void
}
export declare function smokeLifecycleFailure(primaryError: unknown, cleanupErrors?: unknown[], startupState?: SmokeStartupState): Error
export declare function waitForSmokeStartup(child: ChildProcess, options: Pick<SmokeStartupDependencies, 'setTimer' | 'clearTimer' | 'onChildError'> & {
  label: string; timeoutMs: number; stopChild: (child: ChildProcess) => Promise<void>
}): Promise<SmokeStartedChild>
export declare function runObservedSmoke(options: SmokeRunOptions & { evidence: SmokeReport; requiredIds: readonly string[] }): Promise<{ report: SmokeReport; exitCode: number }>
