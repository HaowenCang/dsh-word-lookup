export interface ProbeResult {
  probeId: string
  objective: string
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED'
  evidenceType: 'SOURCE_CONFIRMED' | 'RUNTIME_CONFIRMED' | 'CONTROLLED_PROBE' | 'INFERRED' | 'UNVERIFIED'
  details: Record<string, any>
  limitation: string
  timestamp: string
}

export declare function runSqliteSafetyProbes(): Promise<ProbeResult[]>
