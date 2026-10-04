export interface VerifySourceOptions {
  sourcePath?: string
  manifestPath?: string
  writeEvidence?: boolean
  allowDirty?: boolean
}

export declare function verifySourceArtifact(options?: VerifySourceOptions): Promise<any>
