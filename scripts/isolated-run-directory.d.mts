declare const ownerBrand: unique symbol
export interface OwnedTestRoot {
  readonly [ownerBrand]: never
  readonly path: string
}
export interface CreatedOwnedTestRoot extends OwnedTestRoot {
  readonly cleanupToken: string
}
export interface OwnedRootOptions {
  requestedRoot?: string
  env?: Record<string, string | undefined>
}
export declare function createOwnedTestRoot(options?: OwnedRootOptions): Promise<CreatedOwnedTestRoot>
export declare function reopenOwnedTestRoot(options: OwnedRootOptions & { requestedRoot: string; token: string }): Promise<OwnedTestRoot>
export declare function createOwnedHome(owner: OwnedTestRoot, home: string): Promise<void>
export declare function cleanupOwnedHome(owner: OwnedTestRoot, home: string): Promise<void>
export declare function cleanupOwnedTestRoot(owner: OwnedTestRoot): Promise<void>
