export interface BuildCorpusOptions {
  manifestPath?: string
  sourceFile?: string
  outDb?: string
  batchSize?: number
  evidenceDir?: string
  writeEvidence?: boolean
  cleanExisting?: boolean
  testedGitSha?: string
}

export interface BuildCorpusResult {
  corpusBuild: any
  corpusQuality: any
}

export declare function buildCorpus(options?: BuildCorpusOptions): Promise<BuildCorpusResult>
