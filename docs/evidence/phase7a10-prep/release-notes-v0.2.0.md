# dsh-word-lookup v0.2.0 Release Notes

**Release Version**: `0.2.0`  
**Target Platform**: DeepSeek Harness (DSH) `0.2.0-rc.2` (Web Profile)  
**Release Date**: 2026-10-18  
**Package**: `dsh-word-lookup@0.2.0`  
**License**: MIT  

---

## 1. Overview (概述)

`dsh-word-lookup` 是专为 DeepSeek Harness (DSH) Web 客户端设计的低打扰离线英中词典插件。用户可在 DSH 对话与文本中选中英文单词或词组，通过快捷键即时呼出词典释义卡片。

版本 `v0.2.0` 是一次重大架构与功能升级。相较于 `v0.1.0` 仅支持静态测试词库，`v0.2.0` 正式引入了全新的本地词库存储架构，支持用户自主托管安装完整 ECDICT 词库、导入自定义 SQLite 词库、多快照管理与热切换，并在 DSH 设置中心中提供了完备的原生配置面板与崩溃恢复保障。

---

## 2. New Features in v0.2.0 (新增功能特性)

1. **离线英中词典查询 (Offline English-Chinese Lookup)**
   - 核心查询全流程本地执行，使用 `node:sqlite` 原生引擎。
   - 查询零网络调用，不消耗任何大模型 Token，不经过第三方翻译 API，绝对保护用户隐私。

2. **内置零网络 Fixture 词典 (Zero-Network Built-in Fixture)**
   - 插件内置确定性测试词库，启动时零依赖、零外部网络请求，开箱即用。
   - 保证插件在无网络环境或初次安装时即可正常启动并响应基础查询。

3. **自定义查询快捷键 (Customizable Keyboard Shortcut)**
   - 默认快捷键为 `Primary+Shift+L`（Windows/Linux 上为 `Ctrl+Shift+L`，macOS 上为 `Cmd+Shift+L`）。
   - 完全接入 DSH 客户端快捷键系统，用户可在系统设置中自由绑定或重设快捷键。

4. **安全分类的双击与划词自动查询 (Opt-in Double-Click & Selection Lookup)**
   - 新增由手势分类器驱动的双击 (`autoDoubleClick`) 与鼠标划词 (`autoSelection`) 自动查询支持。
   - 严格分离双击与拖拽手势，保证单次手势仅触发一次查询，彻底杜绝重复请求。
   - **默认保持关闭**，用户可根据自身使用习惯在设置中显式开启。

5. **DSH 原生设置界面集成 (Native DSH Settings UI)**
   - 深度集成 DSH Client UI Settings 面板，提供统一的配置入口。
   - 支持词库模式切换（内置测试词库 / ECDICT 托管词库 / 用户自定义词库）。
   - 支持实时状态监控、词库快照列表展示与操作。

6. **用户主动触发的 ECDICT 托管安装 (Managed ECDICT Installation)**
   - 用户可在设置界面一键启动完整 ECDICT 词库下载与本地编译。
   - 采用流式下载与解压，配合独立的 Worker 线程后台编译 SQLite 数据库，避免阻塞主进程与 UI 响应。

7. **严格的词库来源完整性验证 (Corpus Provenance & Hash Verification)**
   - ECDICT 下载过程受到固化来源提交（Commit）、流式 SHA-256 校验和以及字节长度的严格双向验证。
   - 编译过程采用严格的 UTF-8 解码与校验，确保词库无损坏、无注入。

8. **自定义 SQLite 词库导入 (Custom SQLite Dictionary Import)**
   - 支持用户导入符合 Schema 的自定义 SQLite 词库文件。
   - 采用原生的 `VACUUM INTO` 机制将输入数据库安全复制为受管理的独立快照。
   - 绝对不修改、不重命名、不移动用户原始词库文件，确保用户数据源安全。

9. **多快照管理与热切换 (Multi-Snapshot Management & Hot Switching)**
   - 支持多个自定义快照共存，用户可在设置面板中自由切换当前生效的词库快照。
   - 切换词库即时生效，无需重启 DSH 宿主环境。

10. **活动快照防删除保护 (Active Snapshot Deletion Protection)**
    - 运行态严格保护当前处于活动状态的词库快照，防止用户误操作删除正在使用的词库。
    - 仅在切换至其他快照或内置词库后方允许删除历史快照。

11. **数据持久化与崩溃恢复保障 (Persistence & Crash Resilience)**
    - 所有快照元数据、持久化状态与用户配置通过原子写入保持一致。
    - 包含崩溃后状态自愈能力，防止因进程异常退出导致配置文件损坏。

---

## 3. Comparison: v0.1.0 vs v0.2.0 (版本对比)

| 功能维度 | v0.1.0 | v0.2.0 |
|---|---|---|
| **词库存储架构** | 静态单文件 / 环境变量引导 | `DictionaryManager` 动态多模式架构 |
| **启动网络依赖** | 零网络 | 零网络 (严格保持) |
| **完整 ECDICT 支持** | 无 (仅测试 Fixture) | 支持用户主动一键托管下载安装 |
| **自定义词库导入** | 不支持 | 支持自定义 SQLite 导入与快照管理 |
| **设置面板** | 仅快捷键与简单开关 | 完整原生词库管理与状态面板 |
| **数据安全性** | 无快照概念 | `VACUUM INTO` 隔离，原始文件零篡改保护 |
| **活动快照保护** | 不适用 | 严格禁止删除活动快照 |
| **崩溃恢复保障** | 基础恢复 | 覆盖断电、异常退出、未提交状态的自愈机制 |
| **配置同步状态** | 隐式 | 具备显式同步报告与真实状态透传 |

---

## 4. Mandatory Disclosures & Known Limitations (技术规范声明与已知限制)

根据发布质量门禁规范，正式发布版本明确声明以下技术边界与已知限制：

### 4.1 运行环境兼容性声明
- **正式验证基线**：本项目所有端到端测试、质量验收与运行时测量仅在 **DSH `0.2.0-rc.2` Web Profile** 环境下完成。
- **未验证环境**：DSH `0.2.1` 系列以及所有 Desktop（桌面端）原生运行时尚未完成回归验证。**本项目不声称兼容任何未经验证的 DSH 版本或桌面端环境**。

### 4.2 自动划词手势可移植性限制
- `autoSelection`（鼠标划词自动查词）功能在不同操作系统平台、不同显示服务（如 X11/Wayland）、高 DPI 缩放以及复杂多击时序下可能存在手势判定差异。
- 为保证绝对的输入稳定性与防误触，该功能**在发布版本中默认保持关闭（Default: OFF）**。推荐用户优先使用键盘快捷键（`Primary+Shift+L`）进行精准查询。

### 4.3 F03 边界特定崩溃恢复限制
- 在故障注入测试场景 F03 中（即用户从自定义词库切换回内置词库时，在磁盘元数据删除后、宿主配置确认 RPC 到达前发生进程崩溃）：
  - 系统重启后，数据平面将安全回落至内置确定性测试词库，词典查词功能 100% 正常；
  - 用户的原始数据库文件与自定义快照 100% 完好；
  - 宿主配置因中断仍显示上一次的配置，系统会诚实地将 `settingsSyncState` 标记为 `'pending'`；
  - **已知限制**：该状态在空闲状态下**不会自动收敛**。用户只需在设置面板中**显式点击选择一次“内置词典 (Fixture)”**，即可立即恢复为 `'synced'` 同步状态。

### 4.4 语料库分发与版权合规性声明
- 本 npm 发布包**不包含完整 ECDICT 语料库**，仅包含词库元数据清单（`corpus/ecdict.manifest.json`）与内置测试固件。
- 用户托管安装的 ECDICT 语料库由用户在客户端主动发起，直接从公开固化的官方仓库流式下载，不属于发布包内再分发。

---

## 5. Installation & Upgrade Instructions (安装与升级说明)

### 5.1 全新安装 (Clean Install)

在 DSH `0.2.0-rc.2` Web Profile 环境中，通过命令行安装：

```powershell
# 1. 向 web profile 添加插件
dsh plugin --profile web add dsh-word-lookup@0.2.0

# 2. 启动 web profile
dsh --profile web
```

启动后进入 Web GUI，打开插件设置面板即可看到 `dsh-word-lookup` 配置项。

### 5.2 从 v0.1.0 升级 (Upgrade from v0.1.0)

从旧版本升级时，请先卸载旧版本或直接指定新版本安装：

```powershell
dsh plugin --profile web add dsh-word-lookup@0.2.0
```

升级后原有的自定义快捷键将无缝保留，词典模式默认初始化为内置测试词库。用户可进入设置面板按需下载 ECDICT 完整词库或导入自定义词库。
