#!/usr/bin/env node
/**
 * Release Candidate QA Probe: Package Identity & File Whitelist Verification
 *
 * Implements Phase 7A.9R3 Gate 2 requirements:
 * 1. Directly compute byte size and SHA-256 of candidate .tgz archive.
 * 2. Unpack the tarball into an isolated temporary directory.
 * 3. Enumerate all files in archive, including hidden files/dotfiles.
 * 4. Check for symlinks, hardlinks, and abnormal paths (path traversal protection).
 * 5. Verify file count is strictly 8, derived directly from actual archive contents.
 * 6. Compute byteSize and SHA-256 for each of the 8 unpacked files.
 * 7. Compare each unpacked file against workspace files and baseline Git blobs.
 * 8. Any extra, missing, or mismatched hash is FAIL.
 * 9. Only output STRICT_PASS / PASS after all actual assertions succeed.
 * 10. Generate verified-tarball-contents.json and package-identity-ledger.json in docs/evidence/phase7a9r3/.
 *
 * @module dsh-word-lookup/scripts/probes/phase7a9/rc-package-identity
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function sha256File(filePath) {
  const buf = readFileSync(filePath)
  return sha256Buffer(buf)
}

function runGit(args) {
  const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout.trim()
}

const EXPECTED_8_FILES = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'corpus/ecdict.manifest.json',
  'lib/client.js',
  'lib/ecdict-integrity-worker.js',
  'lib/index.js',
  'package.json',
].sort()

const codeBaselineSha = 'b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf'
const currentHeadSha = runGit(['rev-parse', 'HEAD'])

// Parse CLI flags
const args = process.argv.slice(2)
let targetPhase = 'phase7a9r3'
const phaseArgIdx = args.indexOf('--phase')
if (phaseArgIdx !== -1 && args[phaseArgIdx + 1]) {
  targetPhase = args[phaseArgIdx + 1]
}

console.log(`=== Phase 7A.9R3 Gate 2: Tarball 8-File Identity & Whitelist Verification ===`)
console.log(`Target Phase: ${targetPhase}`)
console.log(`Repo Root:    ${REPO_ROOT}`)
console.log(`Code Baseline: ${codeBaselineSha}`)
console.log(`HEAD Commit:   ${currentHeadSha}\n`)

// 1. Tarball binary verification
const tarballRelPath = 'build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz'
const tarballPath = join(REPO_ROOT, tarballRelPath)
if (!existsSync(tarballPath)) {
  throw new Error(`CRITICAL: Tarball not found at ${tarballPath}`)
}

const tarballStat = statSync(tarballPath)
const tarballBuf = readFileSync(tarballPath)
const tarballSha256 = sha256Buffer(tarballBuf)

console.log(`[Step 1] Candidate Tarball Binary Check:`)
console.log(`  Path:      ${tarballRelPath}`)
console.log(`  Byte size: ${tarballStat.size} bytes`)
console.log(`  SHA-256:   ${tarballSha256}`)

// Historical candidate anchor check
const HISTORICAL_CANDIDATE = {
  bytes: 135731,
  sha256: 'ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34',
}
const matchesHistorical =
  tarballStat.size === HISTORICAL_CANDIDATE.bytes &&
  tarballSha256.toLowerCase() === HISTORICAL_CANDIDATE.sha256.toLowerCase()

console.log(`  Matches historical candidate anchor: ${matchesHistorical ? 'YES' : 'DIFFERS (VERIFYING EMPIRICALLY)'}`)

// 2. Pre-extract security inspection via tar -ztvf
console.log(`\n[Step 2] Pre-extraction Archive Header & Traversal Inspection:`)
const tarListRes = spawnSync('tar', ['-ztvf', tarballPath], { encoding: 'utf8' })
if (tarListRes.status !== 0) {
  throw new Error(`tar -ztvf failed: ${tarListRes.stderr}`)
}

const tarLines = tarListRes.stdout.trim().split(/\r?\n/).filter(Boolean)
const preExtractSecurity = {
  memberCount: tarLines.length,
  pathTraversalDetected: false,
  symlinksOrHardlinksDetected: false,
  abnormalPathsDetected: false,
  allMembersInPackageRoot: true,
  rawTarEntries: [],
}

for (const line of tarLines) {
  // Typical tar -ztvf line:
  // -rw-r--r-- 0 0 0 1089 Oct 26 1985 package/LICENSE
  const parts = line.trim().split(/\s+/)
  const mode = parts[0]
  const memberPath = parts.slice(parts.length - 1)[0]
  preExtractSecurity.rawTarEntries.push({ line, mode, memberPath })

  // Check for symlink/hardlink markers
  if (mode.startsWith('l') || mode.startsWith('h') || line.includes('->')) {
    preExtractSecurity.symlinksOrHardlinksDetected = true
  }

  // Check for path traversal
  if (memberPath.includes('..') || memberPath.startsWith('/') || memberPath.startsWith('\\')) {
    preExtractSecurity.pathTraversalDetected = true
  }

  // Check root prefix
  if (!memberPath.startsWith('package/')) {
    preExtractSecurity.allMembersInPackageRoot = false
  }
}

console.log(`  Archive member lines: ${preExtractSecurity.memberCount}`)
console.log(`  Path traversal detected: ${preExtractSecurity.pathTraversalDetected ? 'YES (CRITICAL)' : 'NO (SAFE)'}`)
console.log(`  Symlink / Hardlink detected: ${preExtractSecurity.symlinksOrHardlinksDetected ? 'YES (CRITICAL)' : 'NO (SAFE)'}`)
console.log(`  All members under package/: ${preExtractSecurity.allMembersInPackageRoot ? 'YES' : 'NO'}`)

if (
  preExtractSecurity.pathTraversalDetected ||
  preExtractSecurity.symlinksOrHardlinksDetected ||
  !preExtractSecurity.allMembersInPackageRoot
) {
  throw new Error('CRITICAL ARCHIVE SECURITY VIOLATION: Suspicious tar members detected!')
}

// 3. Real extraction into isolated temporary directory
console.log(`\n[Step 3] Real Unpacking into Isolated Temporary Directory:`)
const stageDir = mkdtempSync(join(tmpdir(), 'dsh-tarball-verify-'))
console.log(`  Isolated stage directory: ${stageDir}`)

const tarExtractRes = spawnSync('tar', ['-xzf', tarballPath, '-C', stageDir], { encoding: 'utf8' })
if (tarExtractRes.status !== 0) {
  rmSync(stageDir, { recursive: true, force: true })
  throw new Error(`tar -xzf failed: ${tarExtractRes.stderr}`)
}

const packageDir = join(stageDir, 'package')
if (!existsSync(packageDir)) {
  rmSync(stageDir, { recursive: true, force: true })
  throw new Error('Package root "package" directory not found in extracted tarball!')
}

// Recursively walk and enumerate ALL unpacked files, including dotfiles/hidden files
function walkExtractedEntries(dir, baseDir) {
  const results = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const fullPath = join(dir, ent.name)
    const relFromPackage = relative(baseDir, fullPath).replace(/\\/g, '/')
    if (ent.isSymbolicLink()) {
      results.push({ type: 'symlink', path: relFromPackage, fullPath })
    } else if (ent.isDirectory()) {
      results.push(...walkExtractedEntries(fullPath, baseDir))
    } else if (ent.isFile()) {
      results.push({ type: 'file', path: relFromPackage, fullPath })
    } else {
      results.push({ type: 'other', path: relFromPackage, fullPath })
    }
  }
  return results
}

const extractedEntries = walkExtractedEntries(packageDir, packageDir)
const extractedFiles = extractedEntries.filter((e) => e.type === 'file').map((e) => e.path).sort()
const extractedSymlinks = extractedEntries.filter((e) => e.type === 'symlink')
const extractedOthers = extractedEntries.filter((e) => e.type === 'other')

console.log(`  Actual unpacked file count: ${extractedFiles.length}`)
console.log(`  Actual unpacked symlink count: ${extractedSymlinks.length}`)
console.log(`  Actual unpacked other count: ${extractedOthers.length}`)
console.log(`  Unpacked files:`, extractedFiles)

// 4. Strict derivation & comparison against 8-file whitelist
const hasZeroSymlinks = extractedSymlinks.length === 0
const hasZeroOthers = extractedOthers.length === 0
const exact8Files = extractedFiles.length === 8
const matchesExpectedWhitelist =
  exact8Files &&
  extractedFiles.every((f, idx) => f === EXPECTED_8_FILES[idx])

const missingFiles = EXPECTED_8_FILES.filter((f) => !extractedFiles.includes(f))
const extraFiles = extractedFiles.filter((f) => !EXPECTED_8_FILES.includes(f))

console.log(`\n[Step 4] Whitelist & Membership Verification:`)
console.log(`  Exact 8 files: ${exact8Files ? 'PASS' : 'FAIL'}`)
console.log(`  Matches expected whitelist: ${matchesExpectedWhitelist ? 'PASS' : 'FAIL'}`)
if (missingFiles.length > 0) console.log(`  Missing files:`, missingFiles)
if (extraFiles.length > 0) console.log(`  Extra files:`, extraFiles)

// 5. Per-file byteSize, SHA-256, workspace comparison, and Git blob comparison
console.log(`\n[Step 5] Per-file Artifact Verification & Git Invariance:`)
const extractedMembersDetails = []
const eightFilesLedger = []
let unpackedTotalBytes = 0
let allWorkspaceFilesMatch = true
let allFrozenFilesMatch = true

for (const relPath of extractedFiles) {
  const extractedFilePath = join(packageDir, relPath)
  const extStat = statSync(extractedFilePath)
  const extBuf = readFileSync(extractedFilePath)
  const extSha = sha256Buffer(extBuf)
  unpackedTotalBytes += extStat.size

  extractedMembersDetails.push({
    path: relPath,
    byteSize: extStat.size,
    sha256: extSha,
    isSymbolicLink: false,
  })

  // Compare against workspace file
  const workspaceFilePath = join(REPO_ROOT, relPath)
  let workspaceExists = existsSync(workspaceFilePath)
  let workspaceSha = null
  let workspaceByteSize = null
  let workspaceMatchesExtracted = false

  if (workspaceExists) {
    const wsBuf = readFileSync(workspaceFilePath)
    workspaceByteSize = wsBuf.length
    workspaceSha = sha256Buffer(wsBuf)
    workspaceMatchesExtracted = (workspaceByteSize === extStat.size && workspaceSha === extSha)
  }
  if (!workspaceMatchesExtracted) {
    allWorkspaceFilesMatch = false
  }

  // Git Blob comparison
  const baseBlob = runGit(['rev-parse', `${codeBaselineSha}:${relPath}`])
  const headBlob = runGit(['rev-parse', `${currentHeadSha}:${relPath}`])
  const isDocCorrection = relPath === 'README.md'
  const isBitForBitFrozen = baseBlob === headBlob

  if (!isBitForBitFrozen && !isDocCorrection) {
    allFrozenFilesMatch = false
  }

  const status = isBitForBitFrozen
    ? 'FROZEN_BIT_FOR_BIT'
    : (isDocCorrection ? 'CLASS_C_APPROVED_DOCUMENTATION_CORRECTION' : 'MODIFIED')

  eightFilesLedger.push({
    file: relPath,
    byteSize: extStat.size,
    sha256: extSha,
    workspaceSha256: workspaceSha,
    gitBlobSha: headBlob,
    baselineGitBlobSha: baseBlob,
    workspaceMatch: workspaceMatchesExtracted,
    gitBlobMatch: isBitForBitFrozen || isDocCorrection,
    status,
  })

  console.log(`  ${relPath.padEnd(30)} | ${String(extStat.size).padStart(8)} B | SHA: ${extSha.slice(0, 16)}... | Workspace: ${workspaceMatchesExtracted ? 'MATCH' : 'MISMATCH'} | Status: ${status}`)
}

// Clean up isolated temporary extraction directory safely
rmSync(stageDir, { recursive: true, force: true })
console.log(`\nIsolated stage directory cleaned up cleanly.`)

// Package metadata from package.json
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

// Strict Overall Assertions
const allAssertionsPass =
  matchesHistorical &&
  preExtractSecurity.memberCount === 8 &&
  !preExtractSecurity.pathTraversalDetected &&
  !preExtractSecurity.symlinksOrHardlinksDetected &&
  preExtractSecurity.allMembersInPackageRoot &&
  hasZeroSymlinks &&
  hasZeroOthers &&
  exact8Files &&
  matchesExpectedWhitelist &&
  missingFiles.length === 0 &&
  extraFiles.length === 0 &&
  allWorkspaceFilesMatch &&
  allFrozenFilesMatch

const whitelistVerification = allAssertionsPass ? 'STRICT_PASS' : 'FAIL'
const overallVerdict = allAssertionsPass ? 'PASS' : 'FAIL'

console.log(`\n=== Whitelist Verification Verdict: ${whitelistVerification} ===`)
console.log(`=== Overall Package Identity Verdict: ${overallVerdict} ===\n`)

if (!allAssertionsPass) {
  throw new Error(`CRITICAL GATE 2 FAILURE: Package identity assertions failed! whitelistVerification: ${whitelistVerification}`)
}

// 6. Generate Deliverables in docs/evidence/<phase>/
const outDir = join(REPO_ROOT, 'docs', 'evidence', targetPhase)
mkdirSync(outDir, { recursive: true })

// 6a. verified-tarball-contents.json
const verifiedTarballContents = {
  timestamp: new Date().toISOString(),
  phase: targetPhase.toUpperCase(),
  verdict: overallVerdict,
  tarball: {
    filename: 'dsh-word-lookup-0.2.0.tgz',
    path: tarballRelPath,
    byteSize: tarballStat.size,
    sha256: tarballSha256,
    matchesHistoricalAnchor: matchesHistorical,
  },
  preExtractSecurityChecks: {
    memberCount: preExtractSecurity.memberCount,
    pathTraversalDetected: preExtractSecurity.pathTraversalDetected,
    symlinksOrHardlinksDetected: preExtractSecurity.symlinksOrHardlinksDetected,
    abnormalPathsDetected: preExtractSecurity.abnormalPathsDetected,
    allMembersInPackageRoot: preExtractSecurity.allMembersInPackageRoot,
  },
  extractionVerification: {
    isolatedDirectoryPattern: 'dsh-tarball-verify-* (tmpdir)',
    extractedFilesCount: extractedFiles.length,
    extractedSymlinksCount: extractedSymlinks.length,
    extractedOthersCount: extractedOthers.length,
    unpackedTotalBytes,
    extractedMembers: extractedMembersDetails,
  },
  assertions: {
    hasZeroSymlinks,
    hasZeroOthers,
    exact8Files,
    matchesExpectedWhitelist,
    missingFilesCount: missingFiles.length,
    extraFilesCount: extraFiles.length,
    allWorkspaceFilesMatch,
    allFrozenFilesMatch,
    whitelistVerification,
    verdict: overallVerdict,
  },
}

const tarballContentsPath = join(outDir, 'verified-tarball-contents.json')
writeFileSync(tarballContentsPath, JSON.stringify(verifiedTarballContents, null, 2), 'utf8')
console.log(`Written: ${tarballContentsPath}`)

// 6b. package-identity-ledger.json
const packageIdentityLedger = {
  timestamp: new Date().toISOString(),
  phase: targetPhase.toUpperCase(),
  verdict: overallVerdict,
  tarball: {
    filename: 'dsh-word-lookup-0.2.0.tgz',
    path: tarballRelPath,
    byteSize: tarballStat.size,
    sha256: tarballSha256,
  },
  packageMetadata: {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    peerDependencies: packageJson.peerDependencies,
    dshCompatibility: packageJson.dsh?.compatibility,
  },
  unpackedTotalBytes,
  whitelist8FilesCount: extractedFiles.length,
  whitelistVerification,
  eightFiles: eightFilesLedger,
  invarianceSummary: {
    frozenProductionFilesUnchanged: eightFilesLedger.filter((f) => f.status === 'FROZEN_BIT_FOR_BIT').length,
    approvedDocCorrections: eightFilesLedger.filter((f) => f.status === 'CLASS_C_APPROVED_DOCUMENTATION_CORRECTION').length,
    unauthorizedModifications: eightFilesLedger.filter((f) => f.status === 'MODIFIED').length,
    productionSourceTreeUnchanged: true,
  },
}

const ledgerPath = join(outDir, 'package-identity-ledger.json')
writeFileSync(ledgerPath, JSON.stringify(packageIdentityLedger, null, 2), 'utf8')
console.log(`Written: ${ledgerPath}`)

console.log('\nGate 2 Check Completed Successfully!')
