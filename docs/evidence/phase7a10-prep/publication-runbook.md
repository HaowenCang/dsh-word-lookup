# dsh-word-lookup v0.2.0 Publication Runbook

- **Package**: `dsh-word-lookup@0.2.0`
- **Document Version**: 1.2.0 (Phase 7A.10 Release Smoke Test Execution Readiness Fix)
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Status**: **OPERATIONAL BLUEPRINT — STRICTLY GATED UPON USER AUTHORIZATION**

> **CRITICAL EXECUTION NOTICE**:  
> This runbook defines the authoritative, sequential publication procedure for `dsh-word-lookup@0.2.0`.  
> **NO STEP IN THIS RUNBOOK MAY BE EXECUTED AUTOMATICALLY.** Execution requires explicit, affirmative human authorization.

---

## 1. Release Architecture & Invariant Standards

### 1.1 Provenance Anchors
- **生产源码冻结基线 (Production Source Code Freeze)**: `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` (`src/` tree `24d78dfbb54ae62882aa661d4819f6397068e303`)
- **测试验证提交 (Tested Probe Commit)**: `fc1c5b64c56629cf0395121b8c76a3ddfc811ddc` (Vitest 264 suites, 1121 tests pass, exitCode 0)
- **最终验收证据提交 (Final Acceptance Evidence Commit)**: `5c863335afdc4b71ee18f41340d852f378a2bee2` (Phase 7A.9R3 final artifact and evidence authentication closure)
- **发布准备文档提交 (Publication Prep Doc Commit)**: `5305a934851934e39fd505057ece9a258950ed68` (Phase 7A.10 release prep documentation)
- **计划 Git Tag 指向 (Planned Git Tag Target)**: `5c863335afdc4b71ee18f41340d852f378a2bee2`
- **Tag 目标锁定规则**: 除非用户另行明确批准变更目标，否则**严禁将 Git Tag 自动移至最新 HEAD**。Git 发布标签必须且仅能指向已完成全套验收测试与证据闭环的锚点提交 `5c863335afdc4b71ee18f41340d852f378a2bee2`。

### 1.2 Binary Tarball Invariant
Publication must NEVER rebuild or repack the distribution tarball. The publication input is strictly locked to the pre-tested archive:
- **Tarball File**: `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`
- **File Length**: `135731 bytes`
- **SHA-256**: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`
- **SHA-1**: `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3`
- **npm Integrity (SHA-512 Base64)**: `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==`

### 1.3 Hash Verification Semantics
Operators must NOT confuse hash algorithms across platforms and must **NEVER treat different hash algorithm digests as an inconsistency**:
1. **Binary SHA-256**: Local standalone file integrity hash (`Get-FileHash -Algorithm SHA256` or `sha256sum`). Expected value: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`. Used for candidate package validation, GitHub Release asset verification, and byte-for-byte comparison of the package downloaded from the Registry.
2. **Legacy npm shasum (SHA-1)**: Registry metadata field `dist.shasum` is the hex-encoded SHA-1 digest of the uploaded tarball. Expected value: `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3`.
3. **Subresource Integrity (npm `dist.integrity`)**: Registry metadata field `dist.integrity` is the base64-encoded SHA-512 digest prefixed with `sha512-`. Expected value: `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==`.
4. **算法差异与一致性判定准则**:
   - 严禁因 SHA-256（64 位十六进制）、SHA-1（40 位十六进制）与 SHA-512 SRI（Base64 编码）三者数值字符串格式与长度不同而判定为不一致。
   - 判定一致性的唯一标准是：各个字段必须与本地预检基线中同一算法计算得出的标准值完全一致。

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
Run immediate read-only sanity checks on repository target lineage, tarball hash, and registry version availability:
```powershell
# 1. Verify Target Tag Commit & Production Source Tree Invariant
$targetCommit = "5c863335afdc4b71ee18f41340d852f378a2bee2"
$targetResolved = git -C "E:\Projects\DSHarness\dsh-word-lookup" rev-parse $targetCommit
if ($targetResolved -ne $targetCommit) {
    throw "ABORT: Target tag commit $targetCommit cannot be resolved in local repository."
}
$treeSha = git -C "E:\Projects\DSHarness\dsh-word-lookup" rev-parse "${targetCommit}:src"
if ($treeSha -ne "24d78dfbb54ae62882aa661d4819f6397068e303") {
    throw "ABORT: Production source tree SHA at target commit mismatch! Expected 24d78dfbb54ae62882aa661d4819f6397068e303, found: $treeSha"
}

# 2. Verify Working Branch & Remote Synchronization
$localHead = git -C "E:\Projects\DSHarness\dsh-word-lookup" rev-parse HEAD
$remoteHead = (git -C "E:\Projects\DSHarness\dsh-word-lookup" ls-remote origin HEAD | ForEach-Object { ($_ -split '\s+')[0] })
if ($localHead -ne $remoteHead) {
    throw "ABORT: Local HEAD $localHead is not synchronized with remote HEAD $remoteHead!"
}

# 3. Verify Candidate Tarball SHA-256
$tarballPath = "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz"
$hash = (Get-FileHash -Path $tarballPath -Algorithm SHA256).Hash.ToLower()
if ($hash -ne "ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34") {
    throw "ABORT: Tarball SHA-256 mismatch! Found: $hash"
}

# 4. Strictly verify npm version absence & distinguish E404 from network/auth errors (FAIL-CLOSED)
$npmViewRaw = npm view dsh-word-lookup@0.2.0 --registry=https://registry.npmjs.org/ --json 2>&1 | Out-String
$npmViewJson = $null
try { $npmViewJson = $npmViewRaw | ConvertFrom-Json } catch { }

if ($npmViewJson -and $npmViewJson.error) {
    $errCode = $npmViewJson.error.code
    if ($errCode -eq "E404") {
        Write-Host "npm version preflight PASS: Version 0.2.0 is confirmed absent from official registry (E404)."
    } elseif ($errCode -in @("ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN")) {
        throw "ABORT: npm preflight failed due to network connectivity error ($errCode). Cannot confirm publication availability!"
    } elseif ($errCode -in @("E401", "E403")) {
        throw "ABORT: npm preflight failed due to authentication/authorization error ($errCode)!"
    } else {
        throw "ABORT: npm preflight returned unexpected registry error: $errCode - $($npmViewJson.error.summary)"
    }
} elseif ($npmViewJson -and $npmViewJson.version -eq "0.2.0") {
    throw "ABORT: Version 0.2.0 already exists on npm registry! Cannot overwrite an existing version."
} else {
    if ($npmViewRaw -match 'E404' -or $npmViewRaw -match '404 Not Found' -or $npmViewRaw -match 'No match found') {
        Write-Host "npm version preflight PASS: Version 0.2.0 confirmed absent (E404 string match)."
    } else {
        throw "ABORT: npm preflight failed to confirm 404 response. Raw output:`n$npmViewRaw"
    }
}

# 5. Pre-Publication Smoke Execution Pipeline Check (Smoke Runner Executability Verification)
# Execute release smoke runner in local-tarball mode to prove isolated DSH Web profile smoke chain
node scripts/probes/phase7a10/release-smoke.mjs --source local-tarball
if ($LASTEXITCODE -ne 0) {
    throw "ABORT: Pre-publication smoke test execution pipeline failed!"
}
Write-Host "Pre-publication smoke execution pipeline verification PASS."
```

### Step 3: Exact npm Publication Using Validated Tarball & Native Interactive 2FA
Publish the exact candidate tarball file directly, strictly prioritizing native interactive 2FA:
```powershell
# Execute npm publish directly using candidate tarball path:
# npm will interactively prompt the operator for 2FA OTP in the terminal console.
npm publish "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" --access public
```

#### 2FA & 凭证安全规范 (Credential & 2FA Security Standard):
1. **优先采用本机交互式 2FA**: 发布流程优先使用 npm 原生控制台交互式一次性密码（OTP）输入，绝不使用 `--otp=<CODE>` 将真实 OTP 拼接到留存的命令行历史或日志脚本中。
2. **严禁在会话与报告中泄露凭据**: 严禁在 LLM 提示词、运行日志、工程报告、证据文档或对话交互中索取、收集、记录或展示任何真实的 OTP、npm 认证 Token、API 密钥或 Cookies。
3. **细粒度访问令牌 (Granular Access Token) 与 Trusted Publishing 约束**:
   - 若未来配置使用 Granular Access Token 或 Trusted Publishing 自动化流水线，必须事先确认其权限范围、包级别策略（Package-level access policy）及实际可用状态。
   - 本阶段**严禁擅自修改任何现有 npm 认证设置、2FA 策略或发布授权模式**。
4. **网络超时与重试安全边界**:
   - 若 `npm publish` 遭遇网络错误、连接重置或执行超时，**严禁盲目直接重试 publish**！
   - 必须首先执行只读查询（`npm view dsh-word-lookup@0.2.0 version`）核实 Registry 是否已实际落包：
     - 若 Registry 已存在 `0.2.0`，说明包已成功发布，仅响应包因网络波动丢失，应直接进入 Step 4 校验；
     - 若 Registry 确无该版本，方可在排查网络后重新由操作人员交互触发。
*Note: Under no circumstances should `npm publish` be executed from the working directory root without the `.tgz` argument.*

### Step 4: npm Registry Integrity & Metadata Verification
Query the npm registry to verify that version `0.2.0` has been registered, download the published tarball from the official `dist.tarball` URL, and verify all hashes:
```powershell
# 1. Fetch publication metadata from official registry
$viewJson = npm view dsh-word-lookup@0.2.0 --registry=https://registry.npmjs.org/ --json | ConvertFrom-Json

# 2. Assert dist-tags and version
if ($viewJson.version -ne "0.2.0") { throw "Registry version assertion failed! Expected 0.2.0, found $($viewJson.version)" }

# 3. Assert shasum (SHA-1)
if ($viewJson.dist.shasum -ne "9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3") {
    throw "Registry shasum mismatch! Expected 9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3, Found $($viewJson.dist.shasum)"
}

# 4. Assert integrity (SHA-512 base64 SRI)
if ($viewJson.dist.integrity -ne "sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==") {
    throw "Registry integrity mismatch! Expected sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==, Found $($viewJson.dist.integrity)"
}

# 5. Download actual published package from Registry official dist.tarball URL
$downloadUrl = $viewJson.dist.tarball
$tempDownload = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "dsh-word-lookup-0.2.0-registry.tgz")
Write-Host "Downloading published tarball from $downloadUrl to $tempDownload..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempDownload

# 6. Compute SHA-256 on downloaded bytes and compare with candidate package
$downloadHash = (Get-FileHash -Path $tempDownload -Algorithm SHA256).Hash.ToLower()
if ($downloadHash -ne "ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34") {
    Remove-Item $tempDownload -Force
    throw "Downloaded registry package SHA-256 mismatch! Expected ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34, Found $downloadHash"
}
Remove-Item $tempDownload -Force
Write-Host "Registry tarball byte-for-byte SHA-256 verification PASS."
```

### Step 5: npm Distribution & Dependency Audit
Verify package metadata as viewed by clients:
```powershell
npm view dsh-word-lookup@0.2.0 peerDependencies --json
npm view dsh-word-lookup@0.2.0 dsh --json
```
Assert that `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `dsh.compatibility.dsh: 0.2.0-rc.2` match specifications.

### Step 6: Git Annotated Tag Creation & Push
Tag the tested evidence anchor commit:
```powershell
# 1. Create annotated tag pointing strictly to 5c863335afdc4b71ee18f41340d852f378a2bee2
git -C "E:\Projects\DSHarness\dsh-word-lookup" tag -a v0.2.0 5c863335afdc4b71ee18f41340d852f378a2bee2 -m "Release v0.2.0 (DSH 0.2.0-rc.2 Web Profile)"

# 2. Push tag to origin
git -C "E:\Projects\DSHarness\dsh-word-lookup" push origin v0.2.0
```
*Note on Tag Anchor: The tag target is permanently anchored to `5c863335afdc4b71ee18f41340d852f378a2bee2`. Unless explicitly approved by the human user, the tag MUST NEVER be automatically moved to the latest HEAD commit.*

### Step 7: GitHub Release Creation & Asset Upload
Create the GitHub Release and upload the candidate tarball and cross-platform ASCII checksums file:
```powershell
# 1. Prepare checksums file in build/rc-v0.2.0/ using cross-platform ASCII encoding (no UTF-8 BOM, single line)
$checksumLine = "ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34  dsh-word-lookup-0.2.0.tgz"
$checksumPath = "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt"
[System.IO.File]::WriteAllText(
    $checksumPath,
    $checksumLine + "`n",
    [System.Text.Encoding]::ASCII
)

# Verify checksums file encoding: single line, no UTF-8 BOM, exactly matches expected content
$checksumBytes = [System.IO.File]::ReadAllBytes($checksumPath)
if ($checksumBytes.Length -ge 3 -and $checksumBytes[0] -eq 0xEF -and $checksumBytes[1] -eq 0xBB -and $checksumBytes[2] -eq 0xBF) {
    throw "ABORT: SHA256SUMS.txt contains UTF-8 BOM!"
}

# 2. Create release via gh CLI with mandatory --verify-tag
gh release create v0.2.0 `
  "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" `
  "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt" `
  --repo HaowenCang/dsh-word-lookup `
  --verify-tag `
  --title "dsh-word-lookup v0.2.0" `
  --notes-file "E:\Projects\DSHarness\dsh-word-lookup\docs\evidence\phase7a10-prep\release-notes-v0.2.0.md"
```
*Note on `--verify-tag`: The inclusion of `--verify-tag` ensures that gh CLI strictly requires tag `v0.2.0` to already exist on the remote repository; if the tag is missing, the release creation fails immediately rather than silently creating an unintended tag on the remote default branch HEAD.*

### Step 8: Independent Multi-Facet Identity Verification
Perform independent multi-facet identity audit across npm Registry, Git Tag, and GitHub Release without conflating cross-platform identity or algorithm hashes:

#### 8.1 npm Registry Package Identity Verification (npm 独立身份验证)
1. **Version Verification**: 验证 Registry 返回版本号为 `0.2.0`。
2. **SHA-1 (shasum) Verification**: 验证 `dist.shasum` 等于本地候选包 SHA-1 `9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3`。
3. **SHA-512 SRI (integrity) Verification**: 验证 `dist.integrity` 等于本地候选包 SHA-512 SRI `sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==`。
4. **Tarball Download & Byte-for-Byte SHA-256**: 从官方 `dist.tarball` URL 下载实际发布包，对下载字节计算 SHA-256，验证等于 `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`。
5. **Metadata & DSH Compatibility**: 检查 `peerDependencies` 与 `dsh.compatibility.dsh: 0.2.0-rc.2 / Web profile`。
6. **npm `gitHead` 辅助地位**: npm 注册表中的 `gitHead` 字段如存在，可作为发布来源诊断的辅助信息，**但严禁作为跨平台统一身份的强制判定条件**（例如当通过 tarball 独立发布或处于 monorepo/devkit 环境时，`gitHead` 可能为空或记录打包上下文提交，不影响包本身工件内容的完整性）。
7. **哈希算法区分准则**: 不得根据不同哈希算法字段（SHA-256、SHA-1、SHA-512 SRI）数值字符串的不同而认定不一致。

#### 8.2 Git Tag Commit Identity Verification (单独验证 Git Tag 的提交身份)
对于 `v0.2.0` 注释标签（Annotated Tag），发布后采用远端 Git 引用解析（dereferenced peel commit），验证其最终指向：
`5c863335afdc4b71ee18f41340d852f378a2bee2`
```powershell
# Query remote Git tag peeled commit
$remotePeeled = (git -C "E:\Projects\DSHarness\dsh-word-lookup" ls-remote origin 'refs/tags/v0.2.0^{}' | ForEach-Object { ($_ -split '\s+')[0] })
if ($remotePeeled -ne "5c863335afdc4b71ee18f41340d852f378a2bee2") {
    throw "Remote Git tag v0.2.0 does not resolve to 5c863335afdc4b71ee18f41340d852f378a2bee2! Found: $remotePeeled"
}
Write-Host "Remote Git Tag v0.2.0 resolved commit verified: $remotePeeled"
```
- **核心准则**: **不得依赖 GitHub Release API 的 `targetCommitish` 必须等于该 SHA**。GitHub Release API 返回的 `targetCommitish` 字段仅记录创建 Release 时记录的输入参数或默认分支标识，在关联已有 annotated tag 时与底层解引用的 commit 对象存在表现差异，必须以远端 Git 引用解析结果为准。

#### 8.3 GitHub Release Asset Identity Verification (单独验证 GitHub Release 的资产身份)
1. 验证 GitHub Release `v0.2.0` 已发布，并关联了正确的 Tag `v0.2.0`。
2. 验证 Release 资产包含 `dsh-word-lookup-0.2.0.tgz` 和 `SHA256SUMS.txt`。
3. 从 GitHub Release 资产下载 tarball，计算 SHA-256 确保严格等于 `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`。
4. 验证 Release 附带的 `SHA256SUMS.txt` 编码为 ASCII、无 BOM、单行且哈希值无误。

### Step 9: Clean-Room Isolated Smoke Test (DSH 0.2.0-rc.2 Web)
Execute official post-publication smoke acceptance on the genuine published npm package:
```powershell
# Execute official post-publication smoke verification from npm registry.
# The runner handles clean-room isolation, dynamic randomized non-production profile creation,
# free high-port selection, assertive isolation contract gates, candidate hash comparison,
# live DSH Web Profile boot, Playwright UI/API verification, and clean uninstallation:
node scripts/probes/phase7a10/release-smoke.mjs --source npm

if ($LASTEXITCODE -ne 0) {
    throw "ABORT: Post-publication npm release smoke verification failed!"
}
Write-Host "Official post-publication npm release smoke verification PASS."
```

#### 9.1 Package Source Modes in Smoke Runner:
- **`--source local-tarball`**:
  Executed in Step 2 before publication. Uses verified candidate `.tgz` (`build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`), verifies byte size (`135731 bytes`) and SHA-256 (`ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`), and verifies that the isolated DSH profile execution chain is completely functional. **This proves executability of the test runner, but does NOT represent npm release acceptance.**
- **`--source npm`**:
  Executed in Step 9 after publication. Queries official registry (`https://registry.npmjs.org/`), downloads the published tarball, verifies SHA-256 matches candidate hash bit-for-bit, installs `dsh-word-lookup@0.2.0` into the isolated profile via `dsh plugin --profile <randomProfile> add dsh-word-lookup@0.2.0 --registry=https://registry.npmjs.org/`, and executes the full smoke acceptance suite. **This is the official post-publication release smoke acceptance.**
  If executed before publication when 0.2.0 is not published, the script strictly distinguishes E404 from network anomalies, reports `NOT_PUBLISHED` and `NOT_EXECUTED_PRE_PUBLICATION` cleanly, and fails closed without simulating success.

#### 9.2 Minimum Acceptance Verification Criteria:
1. **Clean Plugin Load**: Plugin loads without errors; `window.__DSH_WORD_LOOKUP__` diagnostics interface is exposed.
2. **Settings Entry Rendering**: Settings navigation displays "词典/Dictionary"; clicking renders `.dsh-wl-settings` panel.
3. **Fixture Mode Normal**: Active mode is strictly `fixture` (uninstalled: `false`).
4. **Valid Word Lookup**: Query `derive` returns definition, phonetics, examples from `sqlite-fixture`.
5. **Trigger Switches Default OFF**: `#switch-auto-double-click` and `#switch-auto-selection` default to `aria-checked: false` and host gates are `false`.
6. **Corpus Safety**: Zero automatic ECDICT downloads; zero external network requests; zero access to user personal databases.
7. **Clean Uninstallation**: Plugin removed via `dsh plugin remove`; rebooted DSH verifies lookup route returns HTTP 404.
8. **Evidence Retention**: Comprehensive JSON evidence ledger saved to `docs/evidence/phase7a10-prep/smoke-execution-report.json`.

### Step 10: Publication Evidence Finalization & Archival
Save the publication evidence records (including registry responses, release URLs, and smoke test outputs) into `docs/evidence/phase7b-published/`.
