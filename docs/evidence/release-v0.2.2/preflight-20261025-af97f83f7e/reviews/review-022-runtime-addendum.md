# v0.2.2 rc.3 运行时验收只读补充复核

日期：2026-10-25。审核任务：GPT-6.1-SOL / High fresh-context 补充审查。

## 最终判定

- Spec：**PASS（用户新授权的当前安装 DSH 0.2.1-rc.3、独立 Web Profile、正常安装/关闭/卸载流程范围）**。
- Quality：**PASS（本次静态设施和留存执行证据复核范围）**。
- 新增可行动问题：**Critical 0 / Important 0 / Minor 0**。
- 在上述范围内，最终候选真实运行时验收证据闭合；没有发现错误PASS或触碰真实 desktop Profile/Session/Credentials 的新增证据。本结论不是提交、Tag、推送或发布授权。

原 `review-022-preflight.md` 保持原样。它记录的当时 rc.2 基线及缺少运行时证据状态没有被改写。用户后来明确选择当前安装版本，实测为0.2.1-rc.3，因此本补充报告更新的是后续授权后的验收判断，不把rc.3当成rc.2的替代证据。

本审核只读查看脚本、JSON、日志、归档和截图并计算SHA-256。未运行测试、构建、验收harness、DSH、产品进程或网络请求，未委派。唯一写入是本报告；所有运行结果均为已存在的控制器执行证据。

## 最终对象绑定

工作根：`C:/Users/20659/AppData/Local/Temp/dsh-022-preflight-af97f83f7e`。最终报告：`evidence/runtime022-72d18d0d/runtime-report.json`。

| 对象 | 审核实读结果 |
| --- | --- |
| 最终候选 | candidate-rc3/dsh-word-lookup-0.2.2.tgz，147121 bytes |
| 候选SHA-256 | 5311ac80bfa6140d0c843654ce2031641343a43026576bed08f0f85acace1131 |
| 实际CLI | 0.2.1-rc.3；carrier Node v24.21.0 |
| 正式验收结果 | 21/21必需观察项PASS，pageErrors/pageErrorDetails均空 |
| harness SHA-256 | 15b9af739998ccb1872e6ce5b5ab2ad581f22634a4f01cfbc582c4feb8cdb9e7 |
| observer SHA-256 | 21d78f26d5cae9082f758ee5230e9565e0d106771c4c0ea87e702223131f66a9 |
| verdict SHA-256 | 5c915409d8cd5c4932efca91dd75a8c07a4434f71ffee073f0bcb8751438848b |
| 实测connection SHA-256 | 0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684 |

上述候选及归档设施哈希由审核员只读复算，与最终报告、当前设施对应。`evidence/final-artifact-rc3.json` 的8个成员逐项与最终运行报告 installedMembers 及当前候选文件哈希一致，包括README、package.json、Host/Client/Worker。该文件另记录真实Worker响应success/integrity ok、exitCode=0和退出后删除PASS；这是已有执行证据，本审核没有再次启动Worker。

生产src/lib没有因运行时基线转换而改动。package.json仅为0.2.2补丁版本及对应rc.3目标/声明，lock仅根版本递增，没有依赖改变。rc.3 compatible/install/start/uninstall有独立实际证据；rollback、rc.2、Desktop、其他版本未获本轮验证。README与v0.2.2说明继续标为候选、未发布，未把受控格式化响应说成真实ECDICT词条。

## 隔离与正常验收流程

已读 progress.md、新元数据/README/release notes、runtime022-smoke.mjs、network-observer.cjs、network-verdict.mjs及三份selftest脚本，并核对被复用的boot/stop、collectUninstallProof/probeUninstallPage和carrier公开代码归档。

外层run-isolated记录独立HOME/USERPROFILE/TMP/TEMP，APPDATA/LOCALAPPDATA/npm配置也由隔离器重定向；内层以随机runtime022-*根和release022-rc3-* Profile独立创建owned root/home。runtime022-smoke.mjs:27–29设置独立DSH_HOME/DSH_AGENTS_HOME、离线store，删除敏感环境变量及NODE_OPTIONS；第49行覆盖documentsDirectory到本次scratch。没有使用真实desktop Profile作为测试目标。启动CLI依赖为安装carrier的公开代码，非读取真实会话凭据。测试生成的新Session/credentials接口请求属于新的隔离服务，不代表读取真实Session/Credentials。

第43行stop只针对当前持有child，先记录是否仍running，沿既有owned PID树停止并等待exit/port释放。最终两个PID58108、58364都在请求停止时仍running，终止原因明确OWNED_TEST_SHUTDOWN，exitCode=1为测试强制停止结果，不伪装自然成功退出。两个端口检查及最终cleanup均PASS，测试根保留，未执行危险递归清理。

安装的canonical路径在该次新Profile内，逐成员实读一致；真实Fixture查询为REAL_HOST_SQLITE，返回derive/sqlite-fixture。格式化/窄屏/滚动仍明确CONTROLLED_RESPONSE，通过实际安装插件的Client呈现，不能据此宣称完整语料下载、完整ECDICT查询或真实手动快捷键dispatcher验收。审核员查看最终settings及scroll截图，页面可读，无框架错误overlay；早期正常运行的narrow截图也符合对应测量。

卸载后第88–93行采用新context、新页面及新Host：匿名401/403、认证base200、同origin、自有服务、匹配rpcId且字段完整的inventory无plugin/preset、window global缺席及插件route404共同证明删除。rc.3合同明确绑定实际connection源码hash，未冒用旧rc.2合同；最终network-ready也绑定同一connection hash。已读公开connection处理代码：支持路由选择后明确404，认证/owner条件保留。

## 网络证据与错误PASS防护

本结论仅为 **instrumented plugin smoke window**。不是抓包、任意native代码、任意未来功能或所有未包装网络API的保证。

observer通过每次Host入口的--require在DSH载入前安装fetch/http/https/socket/tls/undici、Worker与异步child观察，并同步builtin ESM exports。插件生产下载入口为global fetch。浏览器context route在goto前安装；非同origin HTTP请求记录并阻断。Worker、未知目的或非白名单child使网络证据不完整；非本地尝试使判定失败。精确本机reg.exe query只允许HKCU/HKLM对应SOFTWARE下App Paths/Uninstall（含指定WOW6432Node）加/s，保留参数与SHA，不接受UNC注册表目标。没有把本机只读注册表探测假装成观测不到的普通子进程。

`network-observer.cjs:19–21` 写日志失败立即exit97；不会静默丢日志后继续运行。`network-verdict.mjs:7–10` 要求两个Host各有唯一首条ready、observer/connection哈希一致、请求停止时仍running、实际退出/端口释放、主线程记录sequence连续；未知PID也拒绝。`network-verdict-red.log`保留此前prematureDeath/missingRecord错误PASS的失败证据，green日志记录修补后15案例PASS；审核员没有执行这些selftest。carrier-sensor-control/sensor-final及独立network-control记录正向本地fetch/http/socket/undici控制与非本地尝试被阻断，控制流量没有混入正式零下载窗口。

最终正式窗口是 **11条记录**，不是前一轮的12条：PID58108有sequence1–6，PID58364有1–5。两条ready均绑定最新observer及实测connection hash；其余9条为精确本机reg.exe只读query；无Worker、未知目的、其他child、Host外部尝试或浏览器外部尝试，浏览器记录96条。实际原始jsonl与最终JSON统计一致。

旧38ad90b2 PASS归档对应较早observer/verdict；本报告没有用它替代最新设施的最终包验收。最新72d18d0d归档和最终候选才是本次结论对象。

## 断线重连失败及兼容性限制

**必须保留的限制：DSH 0.2.1-rc.3中，浏览器保持开启、跨越后端强制停止/重启的重连恢复不在本候选兼容性承诺内。正式维护流程先关闭浏览器，停止后端并卸载，重启后重新打开浏览器。**

`evidence/runtime022-6e377aeb/runtime-report.json`仍为FAIL：其余20项包括卸载及网络均PASS，最终no-browser-pageerror因 `scope 'session-maybe' rendered without an installed adapter` 失败。这个失败不能改写为通过。

独立 `reconnect-control.mjs`在新的Web Profile建立无外部插件对照：审核员实读该Profile package.json的dependencies为空；control-report记录firstAbsence={globalAbsent:true,status:404}、lastGlobalAbsent=true。对照在两次 `reconnect-without-plugin-0/1` 阶段均记录同一错误，stack源头为DSH core ScopeProvider，模块列表没有本插件；控制端口最终释放。它支持“该重连错误不要求安装本插件也会发生”的因果判断，可归为已知上游rc.3重连行为；这不证明所有可能重连错误均与插件无关，也不是对DSH生产代码的修复验证。

正式harness的变更可审查：第37–42行保留每个新context的pageerror listener及phase/stack，第87–88行先关闭旧context再停止/卸载并以新context验收卸载状态；第101行 **保留** no-browser-pageerror必需断言。没有清空旧错误数组或删除该断言来取得PASS。最终零pageerror适用于重新打开浏览器的正常维护流程，不覆盖已明确排除的持续页面重连场景。

早期欢迎/登录引导、错误desktop快捷键尝试、pnpm remove flags/store-dir不匹配及上述最终包失败均各自保留。它们没有被批量改称产品bug，也没有被最终PASS覆盖。

## 收尾边界

原审查“尚无符合所选基线的运行时证据”在后续新授权范围内已由以上新证据补齐。rc.2、Desktop、rollback、完整语料、真实原生terminate失败、断线页面重连及其他未测范围继续保留限制。release说明/最终交付应连同本报告披露重连限制，不能只摘取21/21并隐去6e377aeb失败和无插件对照。没有新增生产/验收阻断项；没有形成任何未经用户授权的提交或发布动作。
