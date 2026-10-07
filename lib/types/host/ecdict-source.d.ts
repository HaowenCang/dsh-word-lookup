/**
 * Pinned ECDICT corpus source manifest reader, validator, and canonical source descriptor.
 *
 * Implements strict Phase 7A.4 source-byte provenance binding:
 * - Locates packaged `corpus/ecdict.manifest.json` relative to package installation root.
 * - Parses and strictly validates manifest schema, repo identity, commit, hash, and byte bounds.
 * - Produces canonical immutable source descriptor with canonical raw GitHub download URL.
 * - Enforces absolute security ceiling on declared corpus byte size (<= 128 MiB).
 * - Bridgeable to `ActiveMetadataSource` for future Phase 7A.5/7A.6 database management.
 *
 * Invariants:
 * - Single source of truth: corpus identity is loaded exclusively from the packaged manifest.
 * - Immutable pins: no configuration, settings, query parameter, environment variable,
 *   or user payload can alter the source repository, commit, path, SHA-256, or byte size.
 * - Zero network access: this module only inspects local packaged files and constructs descriptors.
 *
 * @module dsh-word-lookup/host/ecdict-source
 */
import type { ActiveMetadataSource } from './managed-storage.js';
/** Canonical ECDICT corpus source name. */
export declare const ALLOWED_SOURCE_NAME = "ECDICT";
/** Pinned authoritative repository URL. */
export declare const ALLOWED_SOURCE_REPOSITORY = "https://github.com/skywind3000/ECDICT";
/** Pinned authoritative repository file path. */
export declare const ALLOWED_SOURCE_PATH = "ecdict.csv";
/** Strict network hostname allowlist for canonical downloads. */
export declare const ALLOWED_DOWNLOAD_HOSTNAME = "raw.githubusercontent.com";
/** Absolute security ceiling for corpus byte size (80 MiB = 83,886,080 bytes). */
export declare const MAX_MANIFEST_BYTE_SIZE: number;
/** Expected relative directory of the packaged manifest within the package. */
export declare const CORPUS_DIRECTORY = "corpus";
/** Packaged manifest file basename. */
export declare const MANIFEST_FILE_NAME = "ecdict.manifest.json";
/** Exact 40-character hexadecimal commit hash pattern. */
export declare const COMMIT_HASH_PATTERN: RegExp;
/** Exact 64-character hexadecimal SHA-256 hash pattern. */
export declare const SHA256_HASH_PATTERN: RegExp;
/**
 * Pinned, immutable ECDICT source descriptor.
 */
export interface EcdictSourceDescriptor {
    /** Pinned source name (must be 'ECDICT'). */
    readonly sourceName: 'ECDICT';
    /** Pinned source repository (must be 'https://github.com/skywind3000/ECDICT'). */
    readonly sourceRepository: string;
    /** Pinned 40-character lowercase hexadecimal Git commit hash. */
    readonly sourceCommit: string;
    /** Pinned corpus filename inside the repository (must be 'ecdict.csv'). */
    readonly sourcePath: string;
    /** Pinned 64-character lowercase hexadecimal SHA-256 digest. */
    readonly sourceSha256: string;
    /** Pinned exact byte size of the raw uncompressed corpus. */
    readonly sourceByteSize: number;
    /** Schema version of the manifest (must be 1). */
    readonly schemaVersion: number;
    /** Canonical, validated HTTPS raw GitHub download URL. */
    readonly canonicalDownloadUrl: string;
}
/**
 * Options for locating and loading the packaged ECDICT manifest.
 */
export interface LoadEcdictManifestOptions {
    /** Explicit manifest file path override (test-only). */
    readonly manifestPath?: string;
    /** Module file URL used to locate package root (defaults to this module's import.meta.url). */
    readonly fromUrl?: string;
}
/**
 * Resolve the absolute filesystem path to the packaged `corpus/ecdict.manifest.json`.
 *
 * Walks up directory hierarchy from `fromUrl` to find `package.json`, then
 * joins with `corpus/ecdict.manifest.json`.
 *
 * @param fromUrl - module URL to start search from (defaults to import.meta.url).
 * @returns absolute normalized path to manifest.
 */
export declare function resolvePackagedManifestPath(fromUrl?: string): string;
/**
 * Validate an unknown object against the authoritative ECDICT manifest contract.
 *
 * Throws TypeError with descriptive message if any field fails strict validation.
 *
 * @param raw - parsed JSON value from manifest.
 * @returns frozen, immutable {@link EcdictSourceDescriptor}.
 */
export declare function validateEcdictManifest(raw: unknown): EcdictSourceDescriptor;
/**
 * Load and validate the authoritative ECDICT source descriptor from the packaged manifest.
 *
 * Reads `corpus/ecdict.manifest.json` relative to package installation root.
 * In production, does not accept any parameters or overrides.
 *
 * @returns validated, frozen descriptor.
 */
export declare function loadPinnedEcdictSourceDescriptor(): EcdictSourceDescriptor;
/**
 * @internal Test-only loader supporting explicit manifest path or fromUrl overrides.
 * Strictly forbidden from package root exports.
 *
 * @param options - optional explicit manifest path or fromUrl.
 * @returns validated, frozen descriptor.
 */
export declare function loadPinnedEcdictSourceDescriptorForTesting(options?: LoadEcdictManifestOptions): EcdictSourceDescriptor;
/**
 * Convert a validated {@link EcdictSourceDescriptor} to an {@link ActiveMetadataSource}
 * compatible with Phase 7A.3 active metadata storage contracts.
 *
 * @param descriptor - validated ECDICT source descriptor.
 * @returns frozen active metadata source provenance object.
 */
export declare function descriptorToActiveMetadataSource(descriptor: EcdictSourceDescriptor): ActiveMetadataSource;
