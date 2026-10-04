export interface BuildCorpusOptions {
  manifestPath?: string
  sourceFile?: string
  outDb?: string
  batchSize?: number
  evidenceDir?: string
  writeEvidence?: boolean
  cleanExisting?: boolean
  testedGitSha?: string
  allowDirty?: boolean
}

export interface BuildCorpusResult {
  corpusBuild: any
  corpusQuality: any
  collisions?: any
  logicalDbSha256?: string
  dbFileSha256?: string
  dbBytes?: number
  sourceVerification?: {
    actualSourceSha256: string
    actualSourceBytes: number
  }
  importedEntries?: number
  forms?: number
  integrityCheck?: string
  outDb?: string
}

export declare function buildCorpus(options?: BuildCorpusOptions): Promise<BuildCorpusResult>
export declare function buildProductionWithDeterminism(options?: BuildCorpusOptions): Promise<any>
