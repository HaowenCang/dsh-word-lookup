# dsh-word-lookup v0.2.0 Publication Runbook

- **Package**: `dsh-word-lookup@0.2.0`
- **Document Version**: 1.0.0
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Status**: **OPERATIONAL BLUEPRINT — STRICTLY GATED UPON USER AUTHORIZATION**

> **CRITICAL EXECUTION NOTICE**:  
> This runbook defines the authoritative, sequential publication procedure for `dsh-word-lookup@0.2.0`.  
> **NO STEP IN THIS RUNBOOK MAY BE EXECUTED AUTOMATICALLY.** Execution requires explicit, affirmative human authorization.

---

## 1. Release Architecture & Invariant Standards

### 1.1 Provenance Anchors
- **Production Source Code Freeze**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` (`src/` tree `24d78dfbb54ae62882aa661d4819f6397068e303`)
- **Tested Probe Commit**: `fc1c5b64c56629cf0395121b8c76a3ddfc811ddc`
- **Evidence Anchor & Remote HEAD**: `5c863335afdc4b71ee18f41340d852f378a2bee2`
- **Publication Tag Target**: `5c863335afdc4b71ee18f41340d852f378a2bee2`

### 1.2 Binary Tarball Invariant
Publication must NEVER rebuild or repack the distribution tarball. The publication input is strictly locked to the pre-tested archive:
- **Tarball File**: `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`
- **File Length**: `135731 bytes`
- **SHA-256**: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`
- **SHA-1**: `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3`
- **npm Integrity (SHA-512 Base64)**: `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==`

### 1.3 Hash Verification Semantics
Operators must NOT confuse hash algorithms across platforms:
1. **Binary SHA-256**: Local standalone file integrity hash (`Get-FileHash -Algorithm SHA256` or `sha256sum`). Used for candidate validation and GitHub Release asset verification.
2. **Legacy npm shasum (SHA-1)**: Registry metadata field `dist.shasum` is the hex-encoded SHA-1 of the uploaded tarball.
3. **Subresource Integrity (npm `dist.integrity`)**: Registry metadata field `dist.integrity` is the base64-encoded SHA-512 prefixed with `sha512-`.

---

## 2. Ten-Step Sequential Publication Procedure

```text
[Step 1: Human Authorization Gate]
                 │
[Step 2: Pre-Execution Invariant Verification]
                 │
[Step 3: Atomic npm Publication (Validated Tarball)]
                 │
[Step 4: npm Registry Integrity & Metadata Verification]
                 │
[Step 5: npm Distribution & Dependency Audit]
                 │
[Step 6: Git Annotated Tag Creation & Push]
                 │
[Step 7: GitHub Release Creation & Asset Upload]
                 │
[Step 8: Tripartite Identity Cross-Audit (npm, Git, GitHub)]
                 │
[Step 9: Clean-Room Isolated Smoke Test (DSH 0.2.0-rc.2 Web)]
                 │
[Step 10: Publication Evidence Finalization & Archival]
```

---

### Step 1: Human User Authorization Gate
- **Requirement**: Receive direct, affirmative instruction from the human operator authorizing the publication of `dsh-word-lookup@0.2.0`.
- **Checkpoint**: If authorization is absent, ambiguous, or conditional, **HALT IMMEDIATELY**.

### Step 2: Pre-Execution Invariant Verification
Run immediate read-only sanity checks on repository HEAD, tarball hash, and registry version availability.
```powershell
# 1. Verify Git HEAD
$currentHead = git -C "E:\Projects\DSHarness\dsh-word-lookup" rev-parse HEAD
if ($currentHead -ne "5c863335afdc4b71ee18f41340d852f378a2bee2") {
    throw "ABORT: Git HEAD $currentHead does not match authoritative evidence anchor."
}

# 2. Verify Tarball SHA-256
$tarballPath = "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz"
$hash = (Get-FileHash -Path $tarballPath -Algorithm SHA256).Hash.ToLower()
if ($hash -ne "ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34") {
    throw "ABORT: Tarball SHA-256 mismatch! Found: $hash"
}

# 3. Verify npm version availability
$existing = npm view dsh-word-lookup@0.2.0 version 2>$null
if ($existing) {
    throw "ABORT: Version 0.2.0 already exists on npm registry!"
}
```

### Step 3: Exact npm Publication Using Validated Tarball
Publish the exact candidate tarball file directly, bypassing package directory packaging:
```powershell
# If interactive 2FA OTP prompt is supported:
npm publish "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" --access public

# If passing OTP explicitly:
npm publish "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" --access public --otp=<USER_2FA_CODE>
```
*Note: Under no circumstances should `npm publish` be executed from the working directory root without the `.tgz` argument.*

### Step 4: npm Registry Integrity & Metadata Verification
Query the npm registry to verify that version `0.2.0` has been registered and verify the uploaded tarball hashes:
```powershell
# 1. Fetch publication metadata
$viewJson = npm view dsh-word-lookup@0.2.0 --json | ConvertFrom-Json

# 2. Assert dist-tags and version
if ($viewJson.version -ne "0.2.0") { throw "Registry version assertion failed!" }

# 3. Assert shasum (SHA-1)
if ($viewJson.dist.shasum -ne "9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3") {
    throw "Registry shasum mismatch! Expected 9f9a... Found $($viewJson.dist.shasum)"
}

# 4. Assert integrity (SHA-512 base64)
if ($viewJson.dist.integrity -ne "sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==") {
    throw "Registry integrity mismatch! Expected sha512-aRXt... Found $($viewJson.dist.integrity)"
}
```

### Step 5: npm Distribution & Dependency Audit
Verify package metadata as viewed by clients:
```powershell
npm view dsh-word-lookup@0.2.0 peerDependencies --json
npm view dsh-word-lookup@0.2.0 dsh --json
```
Assert that `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `dsh.compatibility.dsh: 0.2.0-rc.2` match specifications.

### Step 6: Git Annotated Tag Creation & Push
Tag the tested evidence commit:
```powershell
# 1. Create annotated tag pointing strictly to 5c863335afdc4b71ee18f41340d852f378a2bee2
git -C "E:\Projects\DSHarness\dsh-word-lookup" tag -a v0.2.0 5c863335afdc4b71ee18f41340d852f378a2bee2 -m "Release v0.2.0 (DSH 0.2.0-rc.2 Web Profile)"

# 2. Push tag to origin
git -C "E:\Projects\DSHarness\dsh-word-lookup" push origin v0.2.0
```

### Step 7: GitHub Release Creation & Asset Upload
Create the GitHub Release and upload the tarball and checksum:
```powershell
# 1. Prepare checksums file in build/rc-v0.2.0/
"ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34  dsh-word-lookup-0.2.0.tgz" | Out-File -FilePath "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt" -Encoding utf8

# 2. Create release via gh CLI
gh release create v0.2.0 `
  "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" `
  "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt" `
  --repo HaowenCang/dsh-word-lookup `
  --target 5c863335afdc4b71ee18f41340d852f378a2bee2 `
  --title "dsh-word-lookup v0.2.0" `
  --notes-file "E:\Projects\DSHarness\dsh-word-lookup\docs\evidence\phase7a10-prep\release-notes-v0.2.0.md"
```

### Step 8: Tripartite Identity Cross-Audit
Perform automated tripartite cross-audit reconciling npm, Git tag, and GitHub Release:
1. `npm view dsh-word-lookup@0.2.0 gitHead` -> `5c863335afdc4b71ee18f41340d852f378a2bee2`
2. `git rev-parse refs/tags/v0.2.0^{commit}` -> `5c863335afdc4b71ee18f41340d852f378a2bee2`
3. `gh release view v0.2.0 --json tagName,targetCommitish` -> `tagName: v0.2.0`, `targetCommitish: 5c863335afdc4b71ee18f41340d852f378a2bee2`
4. Confirm asset download SHA-256 matches `ce51e0e2...`.

### Step 9: Clean-Room Isolated Smoke Test (DSH 0.2.0-rc.2 Web)
Perform smoke installation in an isolated profile:
```powershell
# 1. Assert isolated test environment
node scripts/assert-isolated-env.mjs

# 2. Create temporary isolated profile
node scripts/create-test-profile.mjs

# 3. Install published package from npm
dsh plugin --profile test-profile add dsh-word-lookup@0.2.0

# 4. Verify startup & basic fixture query
# Execute minimal smoke verification script
node scripts/run-smoke-verification.mjs

# 5. Clean up isolated test profile
node scripts/cleanup-test-profile.mjs --evidence-recorded
```

### Step 10: Publication Evidence Finalization & Archival
Save the publication evidence records (including registry responses, release URLs, and smoke test outputs) into `docs/evidence/phase7b-published/`.
