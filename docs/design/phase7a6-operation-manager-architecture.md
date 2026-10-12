# Phase 7A.6 — Host 词典任务编排服务与管理 API 架构设计规范

**阶段标识**：`Phase 7A.6A — Architecture, Contract & State Machine Specification`  
**基线 Git Commit**：`817d3aba470a9bb5ec1f36c0be7c45b976b612d1`  
**核验 DSH Commit**：`639ed015397290b3745d163aafe02ffee4aa3f84`（DSH `0.2.0-rc.2`）  
**执行环境**：Windows 11 / Node.js v24.13.0  
**目标版本**：`v0.2.0` (UNRELEASED)

---

## 1. 背景与架构分层

在 Phase 7A.5 中，ECDICT 的全量流式下载器（`ecdict-downloader.ts`）与静态 Worker 隔离构建器（`ecdict-importer.ts`）已全面完成。然而，Host 启动时仅硬编码加载内置 fixture 字典，普通用户尚无入口在运行时触发 ECDICT 下载、构建、完整性验证及热切换。

Phase 7A.6 的目标是在 Host 端实现完整的**词典任务编排器（DictionaryOperationManager）**、**激活事务协调器（ActivationCoordinator）**与**管理路由服务（Management Routes）**，通过 DSH 官方标准的 `ctx.connection.fetch.register()` 暴露 5 个管理端点，供后续 Phase 7A.7 设置页面调用。

### 1.1 系统组件分工与职责分离

为保证职责单一与生命周期可控，避免将逻辑堆砌入 `src/index.ts`，整体架构划分为四个核心模块：

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Browser / Client (Phase 7A.7)                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP Fetch (Loopback / Same-Origin)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 DSH Connection Layer (ctx.connection.fetch)                 │
│  - Host / Origin / Sec-Fetch-Site 信任栅栏防御 (DNS Rebinding / CSRF)       │
│  - 会话鉴权验证 (BrowserAuth session / token)                               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Admitted Requests
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│             DictionaryManagementRoutes (management-routes.ts)               │
│  - GET  /api/dsh-word-lookup/dictionary/status                              │
│  - POST /api/dsh-word-lookup/dictionary/install                             │
│  - POST /api/dsh-word-lookup/dictionary/cancel                              │
│  - POST /api/dsh-word-lookup/dictionary/remove                              │
│  - POST /api/dsh-word-lookup/dictionary/verify                              │
│  - 输入校验 (Body size <= 64KB, Content-Type, Method, Schema, Traversal)    │
│  - 错误格式化与敏感信息脱敏 (无绝对路径泄露、无凭据泄露)                   │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
                       ▼                               ▼
┌─────────────────────────────────────┐ ┌─────────────────────────────────────┐
│      DictionaryOperationManager     │ │        ActivationCoordinator        │
│      (dictionary-operations.ts)     │ │      (dictionary-activation.ts)    │
│  - 任务状态机与生命周期             │ │  - 候选/已发布数据库严格验证        │
│  - 单一在途任务互斥锁与并发门禁     │ │  - active.json 原子写入与回滚       │
│  - 阶段进度收集与节流 (<= 10 Hz)    │ │  - DictionaryManager 内存热切换     │
│  - 级联取消与静态 Worker 退出证明   │ │  - Host Config 一致性协同 (最佳努力)│
│  - 编排下载器与导入器               │ │  - 启动恢复与降级保障              │
│  - 任务终态有界缓存                 │ │  - 受控移除与 Windows 句柄安全释放 │
└──────────────────────┬──────────────┘ └──────────────────┬──────────────────┘
                       │                                   │
                       └─────────────────┬─────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Underlying Storage & Data Plane                        │
│  - DictionaryManager (内存活动词典热切换与世代递增)                         │
│  - Lookup Handler (划词查询不受管理 API 阻塞)                               │
│  - ecdict-downloader (固定 HTTPS 下载与校验)                                │
│  - ecdict-importer (RFC 4180 流式解析与静态 Worker PRAGMA integrity_check)  │
│  - managed-storage (版本化数据库 ecdict-<id>.sqlite3 与 active.json)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 状态机模型与并发控制

### 2.1 任务阶段状态转移（FSM）

每个词典安装任务严格遵循单向有限状态机，严禁逆向或非法跳转：

```text
               ┌─────────────┐
               │   queued    │
               └──────┬──────┘
                      │
                      ▼
               ┌─────────────┐
               │checking-cache│
               └──────┬──────┘
                      ├──────────────────────────┐ (Cache valid)
                      ▼ (Cache missing/invalid)  │
               ┌─────────────┐                   │
               │ downloading │                   │
               └──────┬──────┘                   │
                      ▼                          │
               ┌──────────────┐                  │
               │verifying-source│                │
               └──────┬───────┘                  │
                      │ ◄────────────────────────┘
                      ▼
               ┌─────────────┐
               │  building   │
               └──────┬──────┘
                      ▼
               ┌───────────────────┐
               │validating-database│
               └──────┬────────────┘
                      ▼
               ┌─────────────┐
               │ activating  │
               └──────┬──────┘
                      ▼
               ┌─────────────┐
               │  completed  │ (终态)
               └─────────────┘

任意非终态阶段在收到取消信号时：
  [Any Non-Terminal] ──(abort)──► [cancelled] (终态，需 WorkerExitProof)

任意非终态阶段在发生异常时：
  [Any Non-Terminal] ──(error)──► [failed] (终态，错误保留)
```

### 2.2 状态定义与快照契约

```typescript
export type DictionaryOperationPhase =
  | 'queued'
  | 'checking-cache'
  | 'downloading'
  | 'verifying-source'
  | 'building'
  | 'validating-database'
  | 'activating'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type DictionaryOperationStatus = 'running' | 'completed' | 'cancelled' | 'failed'

export interface DictionaryOperationProgress {
  readonly phase: DictionaryOperationPhase
  readonly subphase?: string
  readonly processed?: number
  readonly total?: number
  readonly percent?: number
  readonly unit?: 'bytes' | 'entries' | 'steps'
  readonly message?: string
}

export interface DictionaryOperationSnapshot {
  readonly operationId: string
  readonly kind: 'install'
  readonly phase: DictionaryOperationPhase
  readonly status: DictionaryOperationStatus
  readonly progress: DictionaryOperationProgress
  readonly startedAt: string
  readonly updatedAt: string
  readonly finishedAt?: string
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }
}
```

### 2.3 并发与取消控制规则

1. **唯一并发任务**：Host 同一时刻最多执行 1 个 ECDICT 安装任务。新请求在已有运行任务时，返回 `409 Conflict` 与 `OPERATION_IN_PROGRESS` 及当前 `operationId`。
2. **隔离性**：正在运行的安装任务与词典移除（remove）互斥。在安装任务运行时调用 remove 返回 `409 Conflict`。
3. **Quarantine 互斥**：若上次构建发生未确认 Worker 退出并触发目录隔离（Quarantine），在检验证明恢复前禁止启动新任务，返回 `409 Conflict` 与 `DIRECTORY_QUARANTINED`。
4. **进度节流与单调性**：
   - 任务对外通知频率严格限制为 `<= 10 Hz`（最小间隔 100 ms）。
   - 下载阶段进度单位为 `bytes`，构建阶段进度单位为 `entries`，激活阶段单位为 `steps`。不同阶段绝不混合累加产生混淆的百分比。
   - 订阅者异常必须被内部捕获隔离，绝不影响底层任务。
5. **取消语义与幂等性**：
   - `cancel(operationId)` 必须匹配当前正在运行的任务 ID。若 ID 不匹配或任务已结束，返回相应状态，不破坏新任务。
   - `cancel` 是幂等的。一旦发起，任务进入取消流程，触发底层 `AbortController`。
   - 取消响应指示“已接受取消请求”，底层需等待下载流关闭或 Worker 退出确认后，任务快照才落定为 `cancelled` 终态。
6. **有界历史记录**：保留最近 1 次已结算任务快照（`lastOperation`），防止内存无限膨胀。

---

## 3. 词典激活与三态一致性事务协议

### 3.1 三态职责明确划分

系统内存在三个层面的状态，职责各不相同，严禁简单等价替代：

| 状态维度 | 载体 | 职责 | 持久化特性 |
| :--- | :--- | :--- | :--- |
| **用户偏好 (Intent)** | Host Config (`dictionaryMode`) | 表达用户期望启用的词典模式 (`fixture` \| `managed-ecdict` \| `custom`) | 由 DSH Settings 服务维护于 `cordis.patch.yml` |
| **托管实体权威记录 (Ground Truth)** | Managed Metadata (`storages/dsh-word-lookup/active.json`) | 记录已校验发布的物理托管 SQLite 数据库版本、文件名、Git commit 与 SHA-256 | 由 `writeActiveMetadataAtomically()` 保证原子落盘 |
| **实时查询内核 (Live Runtime)** | `DictionaryManager` 内存引用 | 实时承接划词查询，保证零停机无缝切换 | 进程内存状态，随进程生命周期存在 |

### 3.2 激活事务提交流程（Activation Transaction Pipeline）

当安装构建及 Worker 完整性校验成功、且已发布数据库文件通过同目录原子重命名（`link()` / `rename()`）写入 `databases/ecdict-<identity>.sqlite3` 后，按以下严格顺序提交：

```text
[Step 1: 打开并预检候选发布库]
  - 以只读模式打开 openProductionDictionary({ path: publishedPath })
  - 校验必需数据表 (meta, entries, forms, examples) 及关键索引
  - 校验 probe words 探针 (go, derive 等) 查询能力
  - 失败处理: 候选句柄立即关闭，中止激活，原有活动词典完全不受影响。

[Step 2: 权威元数据原子落盘 (Commit Point 1 - Durability)]
  - 构造符合 ActiveMetadata 规范的描述符
  - 调用 writeActiveMetadataAtomically(paths, metadata) (临时文件写入 + flush + rename)
  - 失败处理: 候选句柄关闭，已发布数据库保留但未激活，原有活动词典不受影响，报错抛出。

[Step 3: 内存引用原子热切换 (Commit Point 2 - In-Memory Runtime)]
  - 调用 dictionaryManager.activate({ mode: 'managed-ecdict', identity, dictionary: publishedDict })
  - DictionaryManager 内部首先将活动指针替换为新句柄，再关闭旧句柄 (旧句柄关闭失败记录于 lastRetirementError 但不回滚已提交的新词典)
  - 失败补偿: 若 manager.activate() 抛出异常 (如 manager 已关闭)，执行补偿回滚: 删除 active.json，关闭候选句柄。

[Step 4: Host Config 用户偏好持久化 (Commit Point 3 - Best-Effort Preference)]
  - 检测 ctx.get('settings') 服务是否存在
  - 若存在: 调用 await ctx.get('settings').update('dsh-word-lookup', { dictionaryMode: 'managed-ecdict' })
  - 降级契约: 若 settings 服务不可用 (如隔离测试或精简环境)，或 update 抛错，记录警告但绝不回滚 Step 2 与 Step 3！
    原因: 磁盘真实数据与内存查询内核已完全同步且可提供服务，后续重启恢复状态机会基于 active.json 保证闭环。
```

### 3.3 卸载/移除事务协议（Remove Protocol）

当用户显式调用 `POST /api/dsh-word-lookup/dictionary/remove` 时：

1. **互斥检查**：若有在途安装任务或处于 Quarantine 状态，拒绝执行并返回 `409 Conflict`。
2. **幂等检查**：若 `active.json` 不存在且当前活动词典已是 fixture，直接返回成功。
3. **安全切换回 Fixture**：
   - 打开 fixture 字典：`openFixtureDictionary()`。
   - 调用 `dictionaryManager.activate({ mode: 'fixture', identity: 'fixture', dictionary: fixture })`。
   - 该操作确保旧托管 SQLite 句柄在切换时被显式 `close()`，Windows 文件锁完全解除。
4. **移除元数据**：删除 `active.json`。
5. **删除版本化数据库**：删除 `databases/ecdict-<identity>.sqlite3`。对 Windows `EBUSY`/`EPERM` 进行明确捕获并报告。
6. **清理残留临时文件**：调用 `removeStaleTemporaryArtifacts(paths)`。
7. **保留源缓存**：严格保留 `cache/dsh-word-lookup/sources/ecdict.csv`，以便用户日后重新安装时无需重新下载网络数据（符合规范契约）。
8. **更新 Host Config**：若 settings 服务可用，更新 `dictionaryMode` 为 `'fixture'`。

---

## 4. 启动与重启恢复状态机

在插件加载时（`apply(ctx, config)`），启动恢复逻辑严格执行以下裁决：

```text
Host Plugin Boot (apply)
    │
    ▼
检查 active.json 是否存在?
    ├─► [NO] (Fresh Install / 已卸载)
    │     - 初始化 Fixture 词典到 DictionaryManager
    │     - 不发起任何网络请求，不执行任何构建
    │     - 状态报告: activeMode = 'fixture', installed = false
    │
    └─► [YES] (存在元数据)
          │
          ▼
        解析并校验 active.json 合法性
          ├─► [INVALID / CORRUPT] (元数据损坏)
          │     - 初始化 Fixture 词典到 DictionaryManager
          │     - 不删除或覆写损坏的 active.json (保留现场)
          │     - 记录 recoveryError = 'CORRUPT_ACTIVE_METADATA'
          │     - 状态报告: activeMode = 'fixture', installed = false, recoveryError
          │
          └─► [VALID] (元数据合法)
                │
                ▼
              检查 active.json 指向的 databases/ecdict-<id>.sqlite3 文件
                ├─► [MISSING] (文件丢失)
                │     - 初始化 Fixture 词典到 DictionaryManager
                │     - 不自动下载，不删除 active.json
                │     - 记录 recoveryError = 'MISSING_DATABASE_FILE'
                │     - 状态报告: activeMode = 'fixture', installed = false, recoveryError
                │
                └─► [EXISTS] (文件存在)
                      │
                      ▼
                    尝试以只读方式打开并校验该数据库
                      ├─► [VERIFICATION FAILED] (数据库损坏或版本不兼容)
                      │     - 句柄关闭，初始化 Fixture 词典
                      │     - 记录 recoveryError = 'CORRUPT_DATABASE_FILE'
                      │     - 状态报告: activeMode = 'fixture', installed = false, recoveryError
                      │
                      └─► [VERIFICATION PASSED] (数据库完全健全)
                            │
                            ▼
                          检查用户配置模式 readDictionaryMode(config)
                            ├─► [managed-ecdict]
                            │     - 激活该托管数据库到 DictionaryManager
                            │     - 状态报告: activeMode = 'managed-ecdict', installed = true
                            │
                            ├─► [fixture] (用户偏好选择使用 fixture)
                            │     - 关闭校验句柄，保持 Fixture 活动
                            │     - 状态报告: activeMode = 'fixture', installed = true (库已就绪但未激活)
                            │
                            └─► [custom]
                                  - 保持 Fixture 活动，状态反映 custom (Phase 7A.8)
```

---

## 5. Host Management API 契约规范

所有端点均挂载于 DSH 官方 `ctx.connection.fetch.register()`。

### 5.1 GET `/api/dsh-word-lookup/dictionary/status`
- **Method**: `GET`
- **Request Body**: 无（若收到 POST 请求返回 `405 Method Not Allowed`）。
- **Response Status**: `200 OK`
- **Response Schema**:
  ```json
  {
    "ok": true,
    "activeMode": "fixture" | "managed-ecdict" | "custom",
    "configuredMode": "fixture" | "managed-ecdict" | "custom",
    "activeSource": "sqlite-fixture" | "ecdict-local",
    "activeIdentity": "fixture" | "v1-...",
    "installed": true | false,
    "installedCorpus": {
      "name": "ECDICT",
      "commit": "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
      "sha256": "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf",
      "schemaVersion": 1,
      "databaseFile": "ecdict-v1-....sqlite3"
    } | null,
    "currentOperation": { ... } | null,
    "lastOperation": { ... } | null,
    "canInstall": true | false,
    "canCancel": true | false,
    "canRemove": true | false,
    "quarantined": false,
    "quarantineReason": null,
    "recoveryError": null,
    "lastRetirementError": null,
    "generation": 1
  }
  ```
- **安全约束**：绝不暴露 Host 物理绝对路径；无任何任务时快速返回，绝不触发下载或 I/O 阻塞。

### 5.2 POST `/api/dsh-word-lookup/dictionary/install`
- **Method**: `POST`
- **Request Headers**: `Content-Type: application/json` (可选)
- **Request Body**: `{}`（禁止传入自定义 `downloadUrl`、`sourceSha256`、`candidatePath` 等内部参数）
- **Response Status**:
  - `200 OK` 或 `202 Accepted`：任务接受并启动。
  - `409 Conflict`：当前已有任务正在运行，或处于 Quarantine 状态。
  - `400 Bad Request`：请求体超限或携带非法被禁止字段。
- **Response Schema (Success)**:
  ```json
  {
    "ok": true,
    "operationId": "install-1791650000000-a1b2c3d4",
    "status": "running",
    "phase": "queued",
    "message": "ECDICT installation accepted and started in background"
  }
  ```

### 5.3 POST `/api/dsh-word-lookup/dictionary/cancel`
- **Method**: `POST`
- **Request Body**: `{"operationId": "string"}`
- **Response Status**:
  - `200 OK`：取消请求已成功传播至底层任务。
  - `400 Bad Request`：缺少 `operationId` 或格式不合法。
  - `404 Not Found`：找不到对应的在途任务。
  - `409 Conflict`：该任务已完成或非运行状态。
- **Response Schema**:
  ```json
  {
    "ok": true,
    "operationId": "install-...",
    "status": "cancelling",
    "message": "Cancellation signal dispatched to operation"
  }
  ```

### 5.4 POST `/api/dsh-word-lookup/dictionary/remove`
- **Method**: `POST`
- **Request Body**: `{}`
- **Response Status**:
  - `200 OK`：托管词典已安全卸载，已回退至 fixture。
  - `409 Conflict`：正在执行安装或目录处于隔离状态，禁止删除。
  - `500 Internal Server Error`：删除文件发生文件系统严重故障。
- **Response Schema**:
  ```json
  {
    "ok": true,
    "removed": true,
    "activeMode": "fixture",
    "message": "Managed ECDICT database removed and active dictionary reverted to fixture"
  }
  ```

### 5.5 POST `/api/dsh-word-lookup/dictionary/verify`
- **Method**: `POST`
- **Request Body**: `{"path": "string"}`
- **Response Status**:
  - `200 OK`：校验结果（`valid: true` 或 `valid: false`）。
  - `400 Bad Request`：路径格式非法、包含空字符、或者扩展名非 SQLite。
- **Response Schema**:
  ```json
  {
    "ok": true,
    "valid": true,
    "schemaVersion": 1,
    "entryCount": 770611,
    "formCount": 57689,
    "message": "Database passed schema and query capability verification"
  }
  ```
- **安全约束**：严格只读打开；绝不修改目标文件；路径错误不泄露内部调用栈。

---

## 6. Cordis 生命周期与安全 Drain 边界

1. **单实例所有权**：每次 `apply()` 加载只实例化一个 `DictionaryOperationManager` 与 `ActivationCoordinator`。
2. **完整回滚注册**：若 5 个管理端点或 lookup 路由中有任意一个注册失败，此前已注册的端点必须全部回滚解注，句柄释放，绝不残留孤儿端点。
3. **安全卸载 Drain 契约**：
   - 卸载时（disposer 被 Cordis 调用），首先阻断新请求提交。
   - 对任何在途任务调用取消信号，并等待最多 5,000 ms 安全 drain，确保 Worker 退出和候选临时文件清理。
   - 注销所有 6 个 HTTP Fetch 路由。
   - 幂等关闭 `DictionaryManager`。
   - 重复加载/卸载严禁造成 Worker 泄漏、文件句柄泄漏或端口冲突。

---

## 7. 架构就绪判定

本规范已全面解决：
1. 任务并发与取消有限状态机；
2. Host Config 与 active.json 激活一致性与重启恢复闭环；
3. 五个管理端点的权限、安全与错误脱敏规范；
4. Cordis 异步清理与安全 drain 边界。

具备进入 7A.6B/C/D 实施的完整前置条件。
