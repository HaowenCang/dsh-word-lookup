# v0.2.2 发布前只读复核

日期：2026-10-25。审核角色：fresh-context 发布前复核；按控制器指定的 GPT-6.1-SOL / High 审核任务执行。

## 判定

- Spec：**PASS（本轮发布前准备及证据分类范围）**。
- Quality：**PASS（限定静态复核范围）**。
- 新增可行动代码/测试缺陷：**Critical 0 / Important 0 / Minor 0**。
- 生产代码阻断问题：**本轮未发现新增项**。
- 发布就绪：**NOT READY / 真实运行时验收未完成**。本报告不批准提交、推送、Tag、npm 或 GitHub 发布。

本轮只读检查源码、原仓库 `git diff HEAD`、新增生产/测试文件及现存日志/JSON，并计算候选文件哈希；没有重跑测试、构建、联网、调用 DSH、启动产品运行时或建立子 agent。唯一写入是本报告。已有通过结果均属于控制器提供的执行证据，不能表述为审核员独立复跑通过。

## 审查对象与身份

原仓库：`E:/Projects/DSHarness/dsh-word-lookup`；实读 HEAD 为 `62e18f8b6ceff318370ef59caa8d66d261f50f23`。候选：`C:/Users/20659/AppData/Local/Temp/dsh-022-preflight-af97f83f7e/repo`。

已读上级 AGENTS.md、原方案当前 header 及第13–22节、外部 progress.md。按 `baseline-files.json` 的577项逐项只读复算：无缺失；既有文件仅 README.md、package.json、package-lock.json、tests/ecdict-downloader.spec.ts 四项与复制前基线不同。生产源码、三份 JavaScript 产物、所有内部声明均保持复制前字节；`lib/types/shared/text.d.ts` 末尾换行的无关差异已恢复。新增发布说明单独读取，不把测试输出文件当生产发布内容。

三份当前产物 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| lib/index.js | 46e61f9d0b9f0e98186087276c8943f6b84a8ce2d93b369c80836e0fc9066d40 |
| lib/client.js | a4becec431e045e589d1164bc8826a9c9722d719369bf5715c4a44f592729c6b |
| lib/ecdict-integrity-worker.js | 91aa9a1e333628a04f497be00aeb996b1571069c5cdc1fd3d228babfdadd27af |

现存 native build/declarations/typecheck/bundle-final 日志退出码均0，bundle-final 为100/100；源码未在这些构建证据之后改变，本轮没有发现修复漏入产物的迹象。旧 candidate-pack.log 的 tgz 身份不作为最终候选哈希证据；元数据最后调整后的重打包与最终清单仍须由控制器记录。

## 修复间合同复核

| 覆盖项 | 本轮检查结论 |
| --- | --- |
| TEST-001 | 路径最近既有祖先解析、生产范围双向重叠拒绝、默认 Profile 拒绝、root/home 所有权、marker/token、清理前退出/端口/证据范围检查相互一致；共享依赖与当前验证隔离器未被换成生产数据目标。历史探针未全部迁移的限制保持。 |
| BUG-001 / BUG-004 | companion 为 Custom 唯一分派入口；validator 校验 requestId/action/形状/唯一终态并等待真实退出；schema parser 与 Worker、实际只读 opener 共用，内部声明和输出保留对应实现。 |
| BUG-002 / BUG-007 | 缺失/空 catalog 继续恢复扫描，损坏 catalog 拒绝覆写；恢复提交先于可见性并保留并发记录身份。删除及登记清理共用 eligibility，文件已删而 catalog 失败保留重试状态；持久 active metadata、租约、替代对象及保留 Worker 路径仍保护删除。未发现本轮引入的接口冲突。 |
| BUG-003 | Reader cleanup、transport abort、原始错误、close-before-unlink 和 production/internal seam 边界保持；本轮仅补强测试屏障及拆卸，无生产下载器改动。 |
| BUG-005 / BUG-006 / UX-001 | 自动手势关联 live Range，取消/失焦/卸载清上下文；手动快捷键合同保持。列表/顶部/picker 共用严格 isValid 激活合同，忙碌/活动状态继续组合。确认框生命周期与最新回调 ref 分离，未发现本轮接口回退。 |
| TEST-002–004 | bundle AST 能力判定与原始字节身份分离；必需观察项缺失/未知不变 PASS；卸载证明仍要求认证健康服务、inventory 缺席及支持的404。Release 的 zero-auto-download 仍为必需项 NOT_VERIFIED。 |
| RISK-001 | 调用方有限结算与物理 Worker 退出分离；不确定时保留容量、路径/owner和manager注册，拒绝新/排队任务；真实退出后显式dispose重试。操作层保留不确定错误和drain未知状态，大小写路径键和负整数exit域加固仍在。故障注入未改写成原生terminate故障复现。 |

各项已有独立审计，本轮追踪的是修复交界及实际新阻断条件，未声称重新完成所有历史全量审计。

## BUG-003 Minor 补强

`repo/tests/ecdict-downloader.spec.ts:135` 起四种 pending-cancel 场景：第155–159行用带标签 race 并明确断言 `cancel-entered`；第160–173行继续执行调用次数、未结算、999/1000ms、abort、解锁、warning、原始错误和目录结果断言。已删除原先 operation 先结束时的早退。第176–177行仅在 cancel 已进入时触发晚到拒绝，等待 operation 和一个真实 setImmediate 后恢复 timers/mock、清理临时目录；省略 cancel 的 mutation 不再由拆卸主动制造未处理拒绝。

证据分类准确：

- minor-old-mutation.log：4条测试断言通过，但4个 unhandled errors、退出1；**不是全绿**。
- minor-hardened-mutation.log：四个场景均在第159行以 `operation-settled` 对 `cancel-entered` 显式失败，退出1；属于本轮断言强度 RED。
- minor-green.log：恢复生产实现后55/55、退出0。cleanup-unconfirmed 属受控异常预期诊断。

候选该测试 SHA-256：`28c2270375f47d7931539658dfb2cf91f9a9ff9829af2e8d5d6f2a84020bde75`。本轮原有非阻断 Minor 建议已在候选中处理。

## 版本与发布证据

`package.json:3` 为0.2.2；`package-lock.json:3` 和根包记录均为0.2.2。锁文件仅两处版本变化；package.json 仅版本和兼容性状态变化，没有依赖变化。`package.json:45` 保留目标 `0.2.0-rc.2`；第48行及第53–56行把候选 rc.2 兼容性/安装/启动/卸载/回滚改为unknown，符合当前缺证据状态。

`README.md:9–11,20,85–86` 区分0.2.2未发布候选、0.2.1历史发布及目标运行时待验收。`docs/releases/v0.2.2.md:3,17,19,21` 保留未发布、已知限制、历史证据不认证新候选及carrier版本身份。没有把旧运行时PASS或合成浏览器验收写成当前候选真实运行时PASS。

integrated.log 第3行明确排除唯一 legacy P01–P07 文件；第542–545行记录70文件、1739测试通过、219.08s，最终退出0。解析 integrated-results.json：testResults 共70个文件，1739 passed、0 failed、0 pending/todo，success=true；其 numTotalTestSuites=311 是内部suite统计，不误写为311个文件。真实 npm tarball/Worker验证套件包含于本次结果。P01–P07 默认调用dsh且读取历史Git条件，维持 **NOT_EXECUTED**，不能称“仓库全部测试无遗漏通过”。

carrier-version.log/evidence 记录独立范围 `--version` 实测 `0.2.1-rc.3`、退出0；carrier公开代码读取证据记录 Electron Node v24.21.0。它们只证明当前carrier版本，**不是0.2.0-rc.2的真实CLI、Web/Desktop启动、候选安装/卸载/回滚验收**。

## 保留验收待办（不是本轮生产bug）

1. 缺少符合目标的真实0.2.0-rc.2 CLI及候选运行时验收；用户未授权为此自动npm install，不应使用rc.3替代或增加兼容豁免。
2. Release collector `scripts/probes/release-v0.2.1/release-smoke.mjs:973` 的完整窗口网络观察仍未收集；`zero-auto-download=NOT_VERIFIED` 保持必需项，所以真实结果不能是PASS，应为INCOMPLETE（其他已失败项仍可使结果FAIL）。该历史runner的EXPECTED_VERSION仍是0.2.1，不能直接当成0.2.2候选验收工具或证据。
3. 元数据最终调整后重新生成的tgz及其最终哈希、内容清单须独立记录。本次审查不认证旧tgz为最终包。
4. Desktop、完整ECDICT、跨进程catalog互斥及真实原生terminate拒绝/长期pending等既有未验证范围保持，不用本次静态PASS或1739测试结果补齐。
5. 原方案header及第16/22节的“Minor待处理”等保留历史陈述，控制器收尾时宜新增本轮记录并更新当前header；不追改历史失败记录。本报告判定基于候选当前测试及本轮证据。

以上是明确剩余验收/收尾条件，不构成新增Critical/Important/Minor缺陷，不代表已经可发布。
