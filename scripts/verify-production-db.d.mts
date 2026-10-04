import type { DatabaseSync } from 'node:sqlite'

export interface VerifyProductionDbOptions {
  dbPath?: string
  manifestPath?: string
  sourceFile?: string
  metadataOnly?: boolean
  expectedEntryCount?: number | string
  expectedFormCount?: number | string
  skipProbes?: boolean
}

export interface VerifyProductionDbResult {
  status: 'PASS' | 'PARTIAL'
  verified: boolean
  sourceBindingReverified: boolean
  metadataOnly: boolean
  dbPath: string
}

export declare function verifyCorpusQueryPlans(db: DatabaseSync): void
export declare function verifyProductionDb(options?: VerifyProductionDbOptions): Promise<VerifyProductionDbResult>
