# dsh-word-lookup v0.2.0 Release Recovery Plan & Failure Playbook

- **Package**: `dsh-word-lookup@0.2.0`
- **Document Version**: 1.0.0
- **Release Engineer**: Gemini 3.8 Flash High (Release Engineering & Authorization Gate)
- **Status**: **ACTIVE CONTINGENCY SPECIFICATION**

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

---

## 2. Failure Scenarios & Standard Operating Procedures (SOP)

### 场景一：npm 发布前失败 (Pre-execution Failure / Auth / Permission Check Fails)
- **触发情境**:
  在执行 `npm publish` 之前，网络检查不通、`npm whoami` 报告未登录、或 2FA OTP 提示超时中断。
- **当前状态评估**:
  - npm 注册表：未受影响，版本 `0.2.0` 仍为空白。
  - Git 仓库：未受影响，无新 Tag，无新 Release。
  - 本地工件：完整未修改。
- **恢复操作步骤**:
  1. 保持本地构建包 `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz` 原封不动。
  2. 修复本地网络环境或重新执行 `npm login`。
  3. 重新运行预检脚本确认认证通过。
  4. 无需执行任何清理或回滚。重新进入发布序列。

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
  3. 执行幂等重试命令，重新上传工件并绑定 Release Notes：
     ```powershell
     gh release create v0.2.0 `
       "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\dsh-word-lookup-0.2.0.tgz" `
       "E:\Projects\DSHarness\dsh-word-lookup\build\rc-v0.2.0\SHA256SUMS.txt" `
       --repo HaowenCang/dsh-word-lookup `
       --title "dsh-word-lookup v0.2.0" `
       --notes-file "E:\Projects\DSHarness\dsh-word-lookup\docs\evidence\phase7a10-prep\release-notes-v0.2.0.md"
     ```
  4. 若 Release 已存在但资产缺失，使用 `gh release upload v0.2.0 <files...>` 补齐资产。

---

### 场景四：发布工件哈希不一致 (Artifact Integrity Mismatch)
- **触发情境**:
  在发布后校验阶段，发现 npm 注册表返回的 `dist.integrity` 或下载的 tarball SHA-256 与本地预检基线（`ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`）不匹配。
- **可能原因**:
  - 误从工作目录直接执行了 `npm publish`（使用了重新打包的内容而非指定 `.tgz`）；
  - 存在中间网络代理篡改；
  - 本地哈希算法比对错误（混淆了 SHA-1、SHA-256 与 base64 SHA-512）。
- **恢复操作步骤**:
  1. **第一优先级**：核实计算逻辑。确认未混淆：
     - 本地 SHA-256：`ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`
     - npm shasum (SHA-1)：`9f9a66c7f354b76bd46f4cbc21d0ca667796dbb3`
     - npm integrity (SHA-512 base64)：`sha512-aRXtW5DdiAVTPFYppuFRENyQ8EIg1otondIoIw4R5P7uMjs43GQhYBfslTo0E3rCyz/FA3wdRfCZF15hEzSyEg==`
  2. 若真实验证确实存在内容差异：
     - 立即将版本标记为 `DEPRECATED`，提示用户暂停使用：
       ```powershell
       npm deprecate dsh-word-lookup@0.2.0 "Critical packaging mismatch. Do not use. Replaced by 0.2.1."
       ```
     - 暂停创建 GitHub Release。
     - 查明打包偏离原因，构建 `0.2.1` 候选包并重走完整质量门禁。

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

### 场景六：正式安装冒烟测试失败 (Post-Release Smoke Test Fails)
- **触发情境**:
  在 Step 9 的隔离 DSH 0.2.0-rc.2 环境中安装正式包后，插件启动报错或查询卡死。
- **恢复操作步骤**:
  1. 严禁篡改已发布的 npm 包或强行覆盖 Git Tag。
  2. 保留测试现场证据：保存 DSH 运行日志、报错堆栈及 `dsh.profile` 状态至 `docs/evidence/`。
  3. 评估缺陷影响面：
     - 若为严重阻断性缺陷（例如所有查询崩溃）：
       执行 `npm deprecate dsh-word-lookup@0.2.0 "Identified regression in Web Profile; please await v0.2.1"`；
       在 GitHub Release 中添加明显的“Known Issue / Warning”说明。
     - 若为特定边界非致命问题（如某些特殊字符查询）：
       在 GitHub Release Notes 中增补 Known Limitation 说明。
  4. 启动正式的 Phase 7B 修复流程，修复、验证并发布 `0.2.1`。

---

## 3. Recovery Decision Matrix (恢复决策速查表)

| 故障阶段 | 现状识别 | 核心处置原则 | 状态标识 | 需用户授权动作 |
|---|---|---|---|---|
| **Step 1-2** | 发布前失败 | 查明网络/环境，重试预检 | `PREFLIGHT_FAIL` | 修复凭证/网络 |
| **Step 3** | npm 发布中中断 (2FA/网络) | 检查 registry 是否落包；若未落包重试 publish | `NPM_FAIL` | 输入 2FA 验证码 |
| **Step 4-5** | npm 成功，元数据延迟 | 只读等待官方源同步 (≤5min) | `WAIT_SYNC` | 无 (自动等待) |
| **Step 6** | npm 成功，Git Tag 失败 | 不得撤销 npm，修复 Git 后补推对应 Tag | `PARTIAL_RELEASE` | 确认补推 Tag |
| **Step 7** | Tag 成功，Release 失败 | 不得回滚 Tag，重试 `gh release create` | `PARTIAL_RELEASE` | 确认补建 Release |
| **Step 8** | 产物哈希不一致 | 校验三类哈希语义；若真不一致执行 deprecate | `HASH_MISMATCH` | 确认 Deprecate 声明 |
| **Step 9** | 冒烟测试发现缺陷 | 不得回滚版本，评估严重度并走 v0.2.1 修复 | `DEFECT_FOUND` | 确认 Deprecate/发补丁 |
