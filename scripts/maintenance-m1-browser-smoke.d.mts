import type { SmokeRunOptions, SmokeReport, SmokeStartupDependencies, SmokeStartedChild } from './smoke-verdict.mjs'
export declare const MAINTENANCE_REQUIRED_IDS: readonly string[]
export declare function runMaintenanceSmoke(options?: Partial<SmokeRunOptions>): Promise<{ report: SmokeReport; exitCode: number }>
export declare function startMaintenanceDsh(dependencies?: SmokeStartupDependencies): Promise<SmokeStartedChild>
