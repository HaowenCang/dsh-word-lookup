export interface CorpusManifest {
  sourceName: string
  sourceRepository: string
  sourceCommit: string
  sourcePath: string
  sourceSha256: string
  sourceByteSize: number
  licensePath: string
  licenseSha256: string
  retrievedAt: string
  parserVersion: string
  schemaVersion: number
  redistributionStatus?: string
}

export interface SourceVerificationResult {
  actualByteSize: number
  actualSha256: string
}

export declare const DEFAULT_MANIFEST_PATH: string
export declare const DEFAULT_SOURCE_PATH: string
export declare const EXPECTED_CORPUS_HEADER: readonly string[]

export declare function loadCorpusManifest(manifestPath?: string): CorpusManifest
export declare function hashFile(filePath: string): Promise<SourceVerificationResult>
export declare function verifyCorpusSource(sourcePath?: string, manifest?: CorpusManifest | null): Promise<SourceVerificationResult>
export declare function validateCorpusHeader(row: string[]): string[]
export declare function preflightCorpusHeader(sourcePath: string): Promise<string[]>
