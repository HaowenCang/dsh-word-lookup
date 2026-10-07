import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  ALLOWED_SOURCE_NAME,
  ALLOWED_SOURCE_PATH,
  ALLOWED_SOURCE_REPOSITORY,
  MAX_MANIFEST_BYTE_SIZE,
  descriptorToActiveMetadataSource,
  loadPinnedEcdictSourceDescriptor,
  resolvePackagedManifestPath,
  validateEcdictManifest,
} from '../src/host/ecdict-source.js'

describe('ECDICT source manifest and descriptor', () => {
  it('resolves the packaged manifest path and loads the authoritative pin', () => {
    const manifestPath = resolvePackagedManifestPath()
    expect(manifestPath.endsWith(join('corpus', 'ecdict.manifest.json'))).toBe(true)

    const descriptor = loadPinnedEcdictSourceDescriptor()
    expect(descriptor.sourceName).toBe('ECDICT')
    expect(descriptor.sourceRepository).toBe('https://github.com/skywind3000/ECDICT')
    expect(descriptor.sourceCommit).toBe('bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b')
    expect(descriptor.sourcePath).toBe('ecdict.csv')
    expect(descriptor.sourceSha256).toBe('1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf')
    expect(descriptor.sourceByteSize).toBe(65933428)
    expect(descriptor.schemaVersion).toBe(1)
    expect(descriptor.canonicalDownloadUrl).toBe(
      'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv',
    )
    expect(Object.isFrozen(descriptor)).toBe(true)
  })

  it('verifies that built lib/index.js loads the packaged manifest relative to its bundle location', async () => {
    // Section 5 requirement: must verify built lib/index.js reads actual package-relative manifest
    // @ts-expect-error - testing raw built bundle without emitted .d.ts
    const builtModule: any = await import('../lib/index.js')
    expect(typeof builtModule.loadPinnedEcdictSourceDescriptor).toBe('function')

    const descriptor = builtModule.loadPinnedEcdictSourceDescriptor()
    expect(descriptor.sourceName).toBe('ECDICT')
    expect(descriptor.sourceCommit).toBe('bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b')
    expect(descriptor.sourceSha256).toBe('1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf')
    expect(descriptor.sourceByteSize).toBe(65933428)
  })

  it('converts descriptor to ActiveMetadataSource accurately', () => {
    const descriptor = loadPinnedEcdictSourceDescriptor()
    const activeSource = descriptorToActiveMetadataSource(descriptor)
    expect(activeSource).toEqual({
      name: 'ECDICT',
      commit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      schemaVersion: 1,
    })
    expect(Object.isFrozen(activeSource)).toBe(true)
  })

  it('rejects malformed manifest root types', () => {
    expect(() => validateEcdictManifest(null)).toThrow(TypeError)
    expect(() => validateEcdictManifest(undefined)).toThrow(TypeError)
    expect(() => validateEcdictManifest('manifest')).toThrow(TypeError)
    expect(() => validateEcdictManifest([])).toThrow(TypeError)
  })

  it('rejects unapproved sourceName', () => {
    const valid = {
      sourceName: 'OTHER',
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      sourceByteSize: 65933428,
      schemaVersion: 1,
    }
    expect(() => validateEcdictManifest(valid)).toThrow(/Invalid manifest sourceName/)
  })

  it('rejects unapproved sourceRepository', () => {
    const invalid = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: 'https://github.com/evil/ECDICT',
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      sourceByteSize: 65933428,
      schemaVersion: 1,
    }
    expect(() => validateEcdictManifest(invalid)).toThrow(/Invalid manifest sourceRepository/)
  })

  it('rejects unapproved sourcePath', () => {
    const invalid = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: 'other.csv',
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      sourceByteSize: 65933428,
      schemaVersion: 1,
    }
    expect(() => validateEcdictManifest(invalid)).toThrow(/Invalid manifest sourcePath/)
  })

  it('rejects invalid sourceCommit hashes', () => {
    const base = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      sourceByteSize: 65933428,
      schemaVersion: 1,
    }

    expect(() => validateEcdictManifest({ ...base, sourceCommit: '' })).toThrow(/sourceCommit/)
    expect(() => validateEcdictManifest({ ...base, sourceCommit: 'bc015ed' })).toThrow(/sourceCommit/) // too short
    expect(() => validateEcdictManifest({ ...base, sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8bzz' })).toThrow(/sourceCommit/) // invalid hex / too long
    expect(() => validateEcdictManifest({ ...base, sourceCommit: 12345 })).toThrow(/sourceCommit/)
  })

  it('rejects invalid sourceSha256 hashes', () => {
    const base = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceByteSize: 65933428,
      schemaVersion: 1,
    }

    expect(() => validateEcdictManifest({ ...base, sourceSha256: '' })).toThrow(/sourceSha256/)
    expect(() => validateEcdictManifest({ ...base, sourceSha256: '1a6947e0' })).toThrow(/sourceSha256/) // too short
    expect(() => validateEcdictManifest({ ...base, sourceSha256: 'g'.repeat(64) })).toThrow(/sourceSha256/) // invalid hex
    expect(() => validateEcdictManifest({ ...base, sourceSha256: null })).toThrow(/sourceSha256/)
  })

  it('rejects non-positive, non-safe-integer, or oversized sourceByteSize', () => {
    const base = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      schemaVersion: 1,
    }

    expect(() => validateEcdictManifest({ ...base, sourceByteSize: 0 })).toThrow(/sourceByteSize/)
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: -100 })).toThrow(/sourceByteSize/)
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: NaN })).toThrow(/sourceByteSize/)
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: Infinity })).toThrow(/sourceByteSize/)
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: '65933428' })).toThrow(/sourceByteSize/)
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: 1.5 })).toThrow(/sourceByteSize/)

    // Security ceiling test
    expect(() => validateEcdictManifest({ ...base, sourceByteSize: MAX_MANIFEST_BYTE_SIZE + 1 })).toThrow(
      /exceeds maximum security ceiling/,
    )
  })

  it('rejects unsupported schemaVersion', () => {
    const base = {
      sourceName: ALLOWED_SOURCE_NAME,
      sourceRepository: ALLOWED_SOURCE_REPOSITORY,
      sourceCommit: 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b',
      sourcePath: ALLOWED_SOURCE_PATH,
      sourceSha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf',
      sourceByteSize: 65933428,
    }

    expect(() => validateEcdictManifest({ ...base, schemaVersion: 0 })).toThrow(/schemaVersion/)
    expect(() => validateEcdictManifest({ ...base, schemaVersion: 2 })).toThrow(/schemaVersion/)
    expect(() => validateEcdictManifest({ ...base, schemaVersion: '1' })).toThrow(/schemaVersion/)
  })

  it('throws descriptive error if explicit manifest file does not exist', () => {
    const nonExistent = join(tmpdir(), `nonexistent-manifest-${randomUUID()}.json`)
    expect(() => loadPinnedEcdictSourceDescriptor({ manifestPath: nonExistent })).toThrow(
      /Failed to read ECDICT manifest/,
    )
  })

  it('throws descriptive error on malformed manifest JSON file', () => {
    const tempFile = join(tmpdir(), `malformed-manifest-${randomUUID()}.json`)
    writeFileSync(tempFile, 'not-json-content', 'utf8')
    try {
      expect(() => loadPinnedEcdictSourceDescriptor({ manifestPath: tempFile })).toThrow(
        /Malformed ECDICT manifest JSON/,
      )
    } finally {
      try {
        unlinkSync(tempFile)
      } catch {}
    }
  })
})
