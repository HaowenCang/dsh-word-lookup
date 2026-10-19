# dsh-word-lookup v0.2.0 Release Recovery Plan & Failure Playbook

- **Package**: `dsh-word-lookup@0.2.0`
- **Document Version**: 1.1.0 (Phase 7A.10R Publication Runbook & Recovery Corrections)
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Status**: **ACTIVE CONTINGENCY SPECIFICATION — STRICT HUMAN AUTHORIZATION BOUNDARY**

---

## 1. Core Principles of Recovery (恢复核心原则)

1. **绝对禁止 Force Push (Zero Force Push Rule)**:
   在任何故障恢复场景下，绝不对远端 Git 仓库执行带有 `--force` 或 `+ref` 语义的推送。
2. **严禁移动或覆写公开 Git 标签 (Tag Immutability)**:
   一旦 Git 标签已推送到公开仓库，严禁删除并将其指向不同提交。
3. **禁止将 npm Unpublish 作为常规回滚机制**:
   由于 npm 注册表的版本不可变性政策以及下游缓存污染风险，严禁试图删除已发布的版本来重新发布同一版本号。
4. **不使用未经验证的新包进行紧急覆盖**:
   如果正式发布后发现严重缺陷，必须遵循标准缺陷修复、测试验收（Phase 7A.x）、打包与审计流程发布补丁版本（如 `0.2.1`），绝不发布未经验证的紧急热补丁。
5. **部分成功必须显式报告 `PARTIAL_RELEASE`**:
   如果发布序列中某一步成功而后序步骤中断，必须保留已成功对象，准确记录当前状态为 `PARTIAL_RELEASE`，不得尝试擅自撤销前序已公开的产物。
6. **所有变更公开状态的操作须取得显式用户授权**:
   任何可能对 npm、GitHub 或 Git 仓库产生状态变更的恢复动作，必须向用户清晰呈现当前断点、影响评估与推荐步骤，并取得用户二次明确授权后方可执行。
7. **严格受限的故障处置权限边界 (Strict Recovery Authorization Boundaries)**:
   对于以下任何发布异常场景：
   - npm tarball 哈希不一致 (Artifact Hash Mismatch)
   - npm 发布后安装失败 (Post-Release Install Failure)
   - 正式 Web Profile 冒烟测试失败 (Smoke Test Failure)
   - 已发布工件存在潜在安全问题 (Potential Security Advisory / Vulnerability)
   **严禁代理、自动化脚本或发布工具自动执行任何改变公开状态的操作**，包括但不限于：
   - `npm deprecate`
   - `npm unpublish`
   - 修改 npm dist-tag
   - 删除或替换 GitHub Release Asset
   - 移动或删除 Git Tag
   - 自行发布新的补丁版本 (如未经授权直接发布 `0.2.1`)
   **只允许执行以下六项标准阻断与报告程序**：
   1. **记录实际状态**：完整记录实际状态、错误日志与环境现场信息。
   2. **停止后续步骤**：立即停止后续所有具有公开副作用的发布步骤。
   3. **判断状态**：判断当前是否属于 `PARTIAL_RELEASE`，并明确标记具体子状态。
   4. **形成安全性与影响评估**：深度评估安全性、受影响范围与技术根因。
   5. **提出恢复建议**：向用户呈送结构化的故障恢复建议方案。
   6. **阻断等待用户明确授权**：必须保持阻断态，等待用户明确书面授权后再执行公开状态变更。
8. **npm 发布网络中断与超时防盲目重试原则**:
   若执行 `npm publish` 过程中发生网络错误、连接重置或超时，**必须先发起只读查询（`npm view dsh-word-lookup@0.2.0 version`）判断 Registry 是否已实际落包，绝对禁止盲目直接重试**！
   - 若查询显示 `0.2.0` 已在 Registry 注册，说明网络中断发生在发布完成响应阶段，必须立即切入发布后校验流程，严禁重复发布；
   - 若查询确认版本仍不存在，方可在排查网络故障后由用户授权重试发布。

---

## 2. Failure Scenarios & Standard Operating Procedures (SOP)

### 场景一：npm 发布前/中失败或网络超时 (Pre-execution Failure / Network Error / Timeout)
- **触发情境**:
  在执行 `npm publish` 之前或执行过程中，网络检查不通、`npm whoami` 报告未登录、2FA OTP 提示超时中断，或发布请求返回网络超时、连接重置。
- **核心处置原则**:
  - **严禁盲目直接重试 publish**！
  - 必须首先执行只读查询核实 Registry 是否已实际落包：
    ```powershell
    npm view dsh-word-lookup@0.2.0 version 2>$null
    ```
- **当前状态评估与处置分支**:
  - **分支 A（Registry 已落包）**:
    若查询返回 `0.2.0`，说明发布请求已被 Registry 成功接收，仅本地响应因网络超时丢失。
    **禁止重复执行 publish**，立即判定当前状态为 `NPM_PUBLISHED_ACK_LOST`，无缝切入 Step 4 执行后续校验。
  - **分支 B（Registry 未落包）**:
    若查询返回空或 404，版本 `0.2.0` 仍为空白。
    1. 保持本地构建包 `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz` 原封不动。
    2. 记录实际网络错误日志。
    3. 修复网络或登录状态，重新由操作人员交互触发发布。

---

### 场景二：npm 发布成功，但 Git Tag 创建或推送失败
- **触发情境**:
  `npm publish` 成功完成，但随后执行 `git tag -a v0.2.0` 或 `git push origin v0.2.0` 时遭遇本地 Git 锁定、网络超时或 SSH/HTTPS 权限拒绝。
- **当前状态评估**:
  - npm 注册表：**已发布 `dsh-word-lookup@0.2.0`**。
  - Git 仓库：Tag 未同步。
  - 判定状态：`PARTIAL_RELEASE (NPM_PUBLISHED_GIT_PENDING)`。
- **严禁行为**:
  - **严禁执行 `npm unpublish`**。npm 包已对外生效，撤销会导致已拉取的客户端报错并封禁该版本号。
- **恢复操作步骤**:
  1. 立即记录状态为 `PARTIAL_RELEASE`，通知用户。
  2. 检查 Git 失败原因（如凭证过期、分支保护或网络波动）。
  3. 确认本地待标记的目标提交严格为 `5c863335afdc4b71ee18f41340d852f378a2bee2`。
  4. 恢复网络/权限后，重新补推标签：
     ```powershell
     git -C "E:\Projects\DSHarness\dsh-word-lookup" tag -a v0.2.0 5c863335afdc4b71ee18f41340d852f378a2bee2 -m "Release v0.2.0"
     git -C "E:\Projects\DSHarness\dsh-word-lookup" push origin v0.2.0
     ```
  5. 标签补推成功后，继续向下执行 Step 7（创建 GitHub Release）。

---

### 场景三：Git Tag 成功，但 GitHub Release 创建失败
- **触发情境**:
  npm 已成功，Git Tag `v0.2.0` 已推送到 GitHub，但在调用 `gh release create` 上传资产时由于 GitHub API 限流或网络异常中断。
- **当前状态评估**:
  - npm 注册表：已发布。
  - Git 仓库：已打标签并推送到远端。
  - GitHub Release：未创建或处于 Draft 状态。
  - 判定状态：`PARTIAL_RELEASE (RELEASE_PENDING)`。
- **严禁行为**:
  - 严禁删除远端 Tag，严禁删除 npm 版本。
- **恢复操作步骤**:
  1. 检查 GitHub Release 列表：`gh release list -R HaowenCang/dsh-word-lookup`。
  2. 若已生成空草稿（Draft），先查看其状态：`gh release view v0.2.0`。
  3. 执行幂等重试命令，重新上传工件并绑定 Release Notes（必须携带 `--verify-tag` 确保远端标签已存在）：
     ```powershell
     gh release create v0.2.0 `
       "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" `
       "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt" `
       --repo HaowenCang/dsh-word-lookup `
       --verify-tag `
       --title "dsh-word-lookup v0.2.0" `
       --notes-file "E:\Projects\DSHarness\dsh-word-lookup\docs\evidence\phase7a10-prep\release-notes-v0.2.0.md"
     ```
  4. 若 Release 已存在但资产缺失，使用 `gh release upload v0.2.0 <files...>` 补齐资产。

---

### 场景四：发布工件哈希不一致 (Artifact Integrity Mismatch)
- **触发情境**:
  在发布后校验阶段（Step 4 / Step 8），发现 npm 注册表返回的 `dist.integrity`、`dist.shasum` 或下载的 tarball SHA-256 与本地候选包基线（`ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`）不匹配。
- **可能原因**:
  - 混淆了不同算法的数值字段（如将 40 位 SHA-1 误与 64 位 SHA-256 比对）；
  - 误从工作目录直接执行了 `npm publish`（使用了重新打包的内容而非指定 `.tgz`）；
  - 存在中间网络代理篡改。
- **严禁行为**:
  - **严禁自动执行 `npm deprecate`、`npm unpublish` 或修改 dist-tag**。
  - **严禁擅自创建或推送 Git Tag、严禁创建 GitHub Release**。
- **标准六步阻断与处置流程**:
  1. **记录实际状态**: 记录 Registry 返回的元数据 JSON，留存下载的异常 tarball 文件及其实际计算的 SHA-256、SHA-1 与 SHA-512 SRI，排查是否为跨算法数值混淆。
  2. **停止后续发布步骤**: 立即停止后续所有发布动作，不推 Git Tag，不建 GitHub Release。
  3. **判断状态**: 判定当前发布状态为 `PARTIAL_RELEASE (HASH_MISMATCH)`。
  4. **形成安全性与影响评估**: 分析差异成因（如构建偏离、网络篡改等），评估对已拉取用户的影响面与风险等级。
  5. **提出恢复建议**: 向用户呈交完整的事故分析与恢复建议（例如若确实属于包内容偏离，建议由用户评估是否授权执行 `npm deprecate`，并进入 Phase 7B 补丁修复流程）。
  6. **阻断等待用户明确授权**: 保持阻断状态，严格等待用户下达明确的书面操作授权，未经授权绝不改变公开状态。

---

### 场景五：Registry 处理与同步延迟 (Propagation / CDN Latency)
- **触发情境**:
  `npm publish` 报告成功，但立即执行 `npm view dsh-word-lookup@0.2.0` 或镜像源拉取时返回 `404 Not Found` 或仍显示旧版本。
- **当前状态评估**:
  npm 官方 CDN 全球节点同步通常需要 30 秒至 3 分钟不等。中国大陆镜像源（如 npmmirror）同步延迟通常在 5 至 15 分钟。
- **恢复操作步骤**:
  1. 严禁重复执行 `npm publish`（重复执行会报错 `EPUBLISHCONFLICT`）。
  2. 显式指定官方主注册表直接查询：
     ```powershell
     npm view dsh-word-lookup@0.2.0 --registry=https://registry.npmjs.org/ --json
     ```
  3. 设立只读轮询等待期（每次间隔 15 秒，上限 5 分钟）。
  4. 待官方源确认元数据更新后，再向下推进后续步骤。

---

### 场景六：正式安装或冒烟测试失败 (Post-Release Install or Smoke Test Fails)
- **触发情境**:
  在 Step 9 的隔离 DSH 0.2.0-rc.2 环境中，执行 `node scripts/probes/phase7a10/release-smoke.mjs --source npm` 安装失败，或安装后插件启动崩溃、查询卡死、冒烟测试失败。
- **严禁行为**:
  - **严禁自动执行 `npm deprecate` 或 `npm unpublish`**。
  - **严禁自动修改 dist-tag、删除或替换 GitHub Release Asset、移动 Git Tag，或自行发布未经完整验收的新补丁**。
- **标准六步阻断与处置流程**:
  1. **记录实际状态**: 完整保存 DSH 运行日志、报错堆栈、`dsh.profile` 状态及复现步骤至 `docs/evidence/`。
  2. **停止后续发布步骤**: 停止后续宣传与扩散步骤；若 GitHub Release 尚未创建，停止创建；若已创建，严禁擅自篡改资产。
  3. **判断状态**: 判定当前发布状态为 `PARTIAL_RELEASE (INSTALL_OR_SMOKE_FAIL)`。
  4. **形成安全性与影响评估**: 深度分析缺陷严重度（阻断性缺陷 vs 边界非致命问题）及对已拉取用户的影响。
  5. **提出恢复建议**: 向用户呈送评估报告，根据缺陷等级提出处置建议（如建议用户评估后授权在 npm 执行 deprecate，或在 GitHub Release Notes 增补 Known Limitation 说明，并规划修复路线）。
  6. **阻断等待用户明确授权**: 保持阻断状态，严格等待用户下达明确书面授权后，方可在人工确认下执行公开状态变更或启动修复流程。

---

### 场景七：已发布工件存在潜在安全问题 (Potential Security Advisory on Published Artifact)
- **触发情境**:
  在发布后或验证过程中，发现已发布工件存在潜在安全漏洞、依赖高危漏洞通告或误打包敏感凭据风险。
- **严禁行为**:
  - **严禁自动执行 `npm deprecate`、`npm unpublish`、修改 dist-tag**。
  - **严禁自动删除或替换 GitHub Release Asset、移动 Git Tag，或自行发布新补丁**。
- **标准六步阻断与处置流程**:
  1. **记录实际状态**: 记录漏洞 CVE/GHSA 编号、问题模块、影响路径及当前 npm/GitHub 上受影响的包版本。
  2. **停止后续发布步骤**: 立即停止所有后续发布与扩散流程。
  3. **判断状态**: 判定当前发布状态为 `PARTIAL_RELEASE (SECURITY_FLAGGED)` 或 `RELEASED_SECURITY_FLAGGED`。
  4. **形成安全性与影响评估**: 深度分析漏洞在 DSH 运行环境（`0.2.0-rc.2 / Web`）下的实际可利用性与受影响范围。
  5. **提出恢复建议**: 向用户提交应急处置建议（如建议用户评估后授权 deprecate、在安全通告中披露、启动安全加固流程）。
  6. **阻断等待用户明确授权**: 保持阻断状态，严格等待用户明确审查并下达书面授权指令。

---

## 3. Recovery Decision Matrix (恢复决策速查表)

| 故障阶段 | 现状识别 | 核心处置原则 | 状态标识 | 需用户授权动作 |
|---|---|---|---|---|
| **Step 1-2** | 发布前预检失败 | 查明网络/环境，重试只读预检；绝不推进 | `PREFLIGHT_FAIL` | 修复凭证/网络后确认重试 |
| **Step 3** | npm 发布网络错误/超时 | 严禁盲目重试；必须先只读查询 Registry 是否落包 | `NPM_FAIL` | 核实 Registry 状态并确认操作 |
| **Step 4-5** | npm 成功，元数据延迟 | 只读等待官方源同步 (≤5min)；严禁重复 publish | `WAIT_SYNC` | 无 (只读自动等待) |
| **Step 6** | npm 成功，Git Tag 失败 | 不得撤销 npm，严禁 force push；修复网络后确认补推 | `PARTIAL_RELEASE` | 确认补推 Tag 到 5c863335... |
| **Step 7** | Tag 成功，Release 失败 | 不得回滚 Tag，使用 `--verify-tag` 重试创建 Release | `PARTIAL_RELEASE` | 确认补建 Release 资产 |
| **Step 4/8** | 产物哈希不一致 | 严格区分算法；严禁自动 deprecate；执行标准六步阻断 | `PARTIAL_RELEASE (HASH_MISMATCH)` | 审查评估后明确授权处置方案 |
| **Step 9** | 安装/冒烟测试失败 | 保留现场日志；严禁自动 deprecate/unpublish；执行六步阻断 | `PARTIAL_RELEASE (SMOKE_FAIL)` | 审查评估后明确授权处置方案 |
| **安全通告** | 发现潜在安全问题 | 严禁自动公开变更；立即阻断并完成利用面评估 | `SECURITY_FLAGGED` | 审查评估后明确授权安全应对措施 |
