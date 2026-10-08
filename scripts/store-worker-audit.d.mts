export interface HostWorkerAuditResult {
  readonly approved: boolean
  readonly workerCount: number
  readonly errors: string[]
}

export interface CompanionWorkerAuditResult {
  readonly approved: boolean
  readonly errors: string[]
}

export function auditHostWorkerUsage(sourceText: string): HostWorkerAuditResult
export function auditCompanionWorker(sourceText: string): CompanionWorkerAuditResult
