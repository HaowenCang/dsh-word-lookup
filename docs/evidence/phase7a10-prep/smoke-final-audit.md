# Phase 7A.10 — 发布冒烟验证证据最终审计报告 (Smoke Final Audit Report)

- **软件包**: `dsh-word-lookup@0.2.0`
- **仓库地址**: `E:\Projects\DSHarness\dsh-word-lookup`
- **远端基准**: `https://github.com/HaowenCang/dsh-word-lookup`
- **审计日期**: 2026-10-19
- **审计模型**: Gemini 3.8 Flash High
- **审计判定**: **ALL SMOKE & ISOLATION CHECKS VERIFIED; READY FOR HUMAN RELEASE AUTHORIZATION**

---

## 1. 冒烟程序静态审计与安全隔离合同核验

针对冒烟脚本 `scripts/probes/phase7a10/release-smoke.mjs` 及前置安全合同门禁 `scripts/assert-isolated-env.mjs` 实施了逐项静态审计与语法验证，结果如下：

| 审计核验项 | 合同与实现机制 | 审计判定 |
|---|---|---|
| **候选包大小与哈希核验** | `EXPECTED_TARBALL_SIZE = 135731`, `EXPECTED_TARBALL_SHA256 = 'ce51e0...7f34'`；读取候选 `.tgz` 严格比对文件长度与 SHA-256，不符立即抛错中断。 | **PASS** |
| **真实安装与非源码依赖** | `local-tarball` 模式仅通过 `dsh plugin --profile <tempProfile> add <tarballPath>` 解包安装，不引用开发工作区文件。 | **PASS** |
| **模块解析与非符号链接校验** | 通过 `lstatSync` 校验 `isSymbolicLink() === false`，并使用 `realpathSync.native` 确认安装路径不位于开发仓库目录下（拒绝 symlink、junction、`link:`、`file:`）。 | **PASS** |
| **官方 npm 模式精准版本匹配** | `npm` 模式指定 `EXPECTED_PACKAGE_NAME@EXPECTED_VERSION`（`dsh-word-lookup@0.2.0`）及官方 Registry（`https://registry.npmjs.org/`）。 | **PASS** |
| **npm 未发布严格 fail-closed** | 当 Registry 返回 E404 时，严格判定为 `NOT_PUBLISHED`，记录 `NOT_EXECUTED_PRE_PUBLICATION` 并安全退出（退出码 0），**坚决禁止冒充 PASS**。 | **PASS** |
| **严格区分网络故障与版本缺失** | 区分 `E404` 与 `ENOTFOUND`、`ETIMEDOUT`、`ECONNREFUSED`、`EAI_AGAIN`，网络异常立即以退出码 2 致命失败中断，绝不误判为版本缺失。 | **PASS** |
| **真实运行时与浏览器验收** | 启动真实 DSH 0.2.0-rc.2 Web 进程，通过 Playwright 驱动真实无头 Chromium 浏览器验证 UI 组件、设置面板、字典状态及 API 词汇检索。 | **PASS** |
| **安全沙箱与临时目录隔离** | 运行于系统临时目录随机子目录（`tmpdir()/dsh-release-smoke-*`），随机 Profile 标识（`smoke-v020-*`），调用 `assertIsolatedDshEnvironment` 严格阻断生产 Profile。 | **PASS** |
| **端口独立性与生产端口防护** | 动态探测空闲高端口（`50995-60000`），禁止绑定生产端口（19387、50001 及运行中宿主端口），并在 `cordis.patch.yml` 中锁定该端口。 | **PASS** |
| **生产凭证与历史数据无污染** | 剥离所有宿主 `DSH_*` 环境变量；通过 `--from-default-profile web --dump-config` 初始化全新配置，不触碰生产 Session、Profile 与词库。 | **PASS** |
| **进程生命周期与环境清理** | Windows 环境下仅对自身子进程树执行定向终止（`taskkill /pid <childPid> /T /F`），不使用全局杀死命令；测试结束后安全清理临时文件。 | **PASS** |

---

## 2. 两次执行证据保存与覆盖问题归因修复

### 2.1 覆盖风险归因分析
在现有 `release-smoke.mjs` 中，`local-tarball` 模式完成测试后写入 `docs/evidence/phase7a10-prep/smoke-execution-report.json`，而 `npm` 预检模式在遇到未发布 E404 退出时也写入同一路径 `smoke-execution-report.json`。因此若连续执行两项操作，后执行的结果将覆盖先执行的结果。

### 2.2 独立证据持久化归档方案
为确保历史真实运行数据与 npm 预检证据均能独立溯源，本轮归档生成并保留了以下完整证据链：
1. **`smoke-local-tarball.json`**: 完整保留本地候选包冒烟测试的实际执行结果。
2. **`smoke-npm-prepublication.json`**: 完整保留发布前 npm 官方 Registry 只读预检结果与未发布提前退出记录。
3. **`smoke-execution-report.json`**: 保持与提交 `ee3a853d` 状态完全一致的本地冒烟基线报告。
4. **`smoke-final-audit.md`**: 综合审计总结文档。

---

## 3. 两次运行详细证据比对

### 3.1 本地候选包冒烟执行详情 (`local-tarball`)
- **执行命令**: `node scripts/probes/phase7a10/release-smoke.mjs --source local-tarball`
- **执行时间戳**: `2026-10-19T06:33:42.711Z`
- **执行耗时**: 26,301 ms (~26 秒)
- **退出码**: `0`
- **安装包来源**: `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz`
- **安装包大小**: 135,731 字节
- **安装包 SHA-256**: `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34`
- **隔离根目录**: `C:\Users\20659\AppData\Local\Temp\dsh-release-smoke-f9fc5ffa`
- **隔离 DSH_HOME**: `C:\Users\20659\AppData\Local\Temp\dsh-release-smoke-f9fc5ffa\home`
- **隔离 Profile 标识**: `smoke-v020-8e7519`
- **绑定高端口**: `50995`
- **实际安装路径**: `C:\Users\20659\AppData\Local\Temp\dsh-release-smoke-f9fc5ffa\home\profiles\smoke-v020-8e7519\node_modules\dsh-word-lookup`
- **符号链接检测**: `isSymlink: false` (真实解包文件，非软链接/Junction)
- **验收项 1 (插件加载)**: `window.__DSH_WORD_LOOKUP__` 诊断接口存在 -> **PASS**
- **验收项 2 (设置导航与面板)**: `nav button:has-text("词典/Dictionary")` 可见且 `.dsh-wl-settings` 渲染 -> **PASS**
- **验收项 3 (默认 Fixture 模式)**: `activeMode === 'fixture'`, `installed === false` -> **PASS**
- **验收项 4 (真实单词查询)**: POST `api/dsh-word-lookup` 查询 `derive` 成功返回 `sqlite-fixture` 释义 -> **PASS**
- **验收项 5 (手势开关默认关闭)**: 双击与划词开关 `aria-checked === 'false'` 且宿主 `gates()` 为 `false` -> **PASS**
- **验收项 6 (词库下载边界)**: ECDICT 未下载，零自动外部网络请求 -> **PASS**
- **验收项 7 (干净卸载生命周期)**: 执行 `dsh plugin remove` 后重启 DSH，路由返回非 200 (404) -> **PASS**
- **最终结论**: **PASS (7/7 acceptance items passed)**

### 3.2 npm 发布前只读预检详情 (`npm`)
- **执行命令**: `node scripts/probes/phase7a10/release-smoke.mjs --source npm`
- **执行时间戳**: `2026-10-19T07:51:11.380Z`
- **退出码**: `0`
- **查询目标**: `dsh-word-lookup@0.2.0`
- **官方 Registry**: `https://registry.npmjs.org/`
- **Registry 返回**:
  ```json
  {
    "error": {
      "code": "E404",
      "summary": "No match found for version 0.2.0",
      "detail": "The requested resource 'dsh-word-lookup@0.2.0' could not be found or you do not have permission to access it."
    }
  }
  ```
- **判定状态**: `NOT_PUBLISHED`
- **执行结论**: `NOT_EXECUTED_PRE_PUBLICATION`
- **安全说明**: 按照发布前规范，npm 正式冒烟必须在包正式发布后方可执行。发布前预检严格按 fail-closed 原则安全退出，零伪造执行。

---

## 4. 生产源码冻结与发布制品不变性审计

| 验证项 | 冻结基线要求 | 当前工作区实测值 | 审计判定 |
|---|---|---|---|
| **生产源码冻结 Commit** | `b36bf4d1b8ec5b6ab3ae3750475d656c669bcdcf` | 存在于当前 Git 提交树 | **PASS** |
| **`src/` 源码树 SHA** | `24d78dfbb54ae62882aa661d4819f6397068e303` | `24d78dfbb54ae62882aa661d4819f6397068e303` | **PASS (无修改)** |
| **`package.json` 不变性** | 冻结版本 `0.2.0` | 严格一致，零 diff | **PASS** |
| **`pnpm-lock.yaml` 不变性** | 冻结锁文件 | 严格一致，零 diff | **PASS** |
| **候选包文件路径** | `build/rc-v0.2.0/dsh-word-lookup-0.2.0.tgz` | 存在且完好 | **PASS** |
| **候选包字节大小** | `135731` 字节 | `135731` 字节 | **PASS** |
| **候选包 SHA-256** | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | `ce51e0e233d2b93b8b3d3f61548e0634debdedd0b20ac423a150037abf887f34` | **PASS (逐位匹配)** |
| **计划 v0.2.0 Tag 目标 Commit** | `5c863335afdc4b71ee18f41340d852f378a2bee2` | 保持锁定，严禁指向 HEAD | **PASS** |

---

## 5. 阶段门禁状态清单 (Phase 7A.10 Final Gate Declaration)

```text
REMOTE_COMMIT_SYNCED = PENDING_PUSH
SMOKE_SCRIPT_INDEPENDENTLY_INSPECTABLE = YES
LOCAL_TARBALL_SMOKE_EVIDENCE_PRESERVED = YES
NPM_PREPUBLICATION_EVIDENCE_PRESERVED = YES
PACKAGE_ORIGIN_VERIFIED = YES
ISOLATION_CONTRACT_VERIFIED = YES
PRODUCTION_CODE_UNCHANGED = YES
TARBALL_SHA256_UNCHANGED = YES
READY_FOR_FINAL_RELEASE_AUTHORIZATION = YES
NPM_PUBLISH_AUTHORIZED = NO
GIT_TAG_CREATION_AUTHORIZED = NO
GITHUB_RELEASE_CREATION_AUTHORIZED = NO
```

> **最终授权红线声明**:  
> 当前所有测试、验证、审计与证据归档均已在只读与完全隔离环境下执行完毕。  
> **严禁在未经用户明确书面授权的情况下执行任何 `npm publish`、Git Tag 创建/推送或 GitHub Release 发布操作。**
