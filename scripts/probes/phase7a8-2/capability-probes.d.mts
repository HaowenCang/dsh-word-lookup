/**
 * Type declarations for Phase 7A.8.2 capability probes.
 */

export interface CapabilityProbeResult {
  readonly id: string
  readonly name: string
  readonly status: 'SUPPORTED' | 'UNSUPPORTED' | 'NOT_PROVEN'
  readonly exactPackage: string
  readonly exactTypeOrInterface: string
  readonly actualCallPath: string
  readonly sourceReference: string
  readonly probeResult: string
  readonly details: Record<string, unknown>
}

export declare function runCapabilityProbes(): Promise<readonly CapabilityProbeResult[]>
