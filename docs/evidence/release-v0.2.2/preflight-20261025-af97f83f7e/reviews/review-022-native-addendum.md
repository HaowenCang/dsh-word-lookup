# v0.2.2 原生快捷键只读补充复核

日期：2026-10-25。审核任务：GPT-6.1-SOL / High。保留 review-022-preflight.md 与 review-022-runtime-addendum.md 原样。

## 判定

Spec / Quality：**PASS（本轮新增原生快捷键链路及最新包身份绑定范围）**。

新增可行动问题：**Critical 0 / Important 0 / Minor 0**。

本审核只读检查当前harness相对72d18d0d归档的新增内容、实际Client合同、失败及最终JSON、网络日志与截图，并计算哈希。未运行测试、构建、产品/DSH进程、浏览器自动化或网络请求，未委派；只写本报告。下述运行结果是控制器已留存的证据，不是审核员重跑。

## 新增原生链路

当前 `runtime022-smoke.mjs:17` 将 `native-default-shortcut` 加入必需项。第66–73行的实际次序是：

1. 建立受控文本span `derive`，明确标记 `data-chat-flow-kind=assistant-step` 与 `data-chat-node-key=audit-controlled-flow`，聚焦并用真实DOM Range/Selection选中。
2. 在按键前安装真实POST响应等待器，匹配 `/api/dsh-word-lookup` 和query=derive。
3. 使用 `page.keyboard.press('Control+Shift+L')`，等待HTTP响应，要求200、found=true、headword=derive、source=sqlite-fixture，并要求Client lookups准确增加1。
4. 保存实际卡片截图后dismiss，移除span及selection，再继续原有验收。

此项没有通过公开runLookup调试入口触发，也没有使用受控HTTP响应。格式化用途的page.route在第80行才安装，晚于本项；早先直接Fixture HTTP查询已被await完成，不能满足稍后设置的快捷键响应等待器。后续 `runLookup('pass'/'long-entry',...)` 仍仅属于既有受控格式化项。

`src/client/index.tsx:490` 起实际注册DSH shortcut命令，Windows Web默认绑定KeyL+primary+shift；第520行读取eligible selection，第532行命令run发起shortcut lookup。`src/client/selection.ts:35–45` 的会话flow选择器与第118–124、166–177行资格检查要求端点在会话流内且不在交互输入面。受控span满足既有生产合同，未放宽产品准入。

最终 `evidence/runtime022-5e06c194/runtime-report.json` 的原生观察记录 issuedBefore=0、issuedAfter=1、真实Fixture derive内容及source=sqlite-fixture；classification为REAL_KEYBOARD_REAL_HOST_SQLITE。审核员查看07-native-shortcut.png，确有选中的derive及对应真实Fixture卡片，包含释义、词形和例句，无错误overlay。这里的会话DOM文字是受控构造，不是模型生成消息；没有调用模型，也不证明全语料或所有OS/浏览器快捷键都已验收。

## 最新身份与结果

工作根：`C:/Users/20659/AppData/Local/Temp/dsh-022-preflight-af97f83f7e`。

| 对象 | 只读复核结果 |
| --- | --- |
| 当前正式报告 | evidence/runtime022-5e06c194/runtime-report.json |
| 当前验收 | 22/22必需项PASS；pageErrors=0；原有21项均继续在同一轮运行 |
| 候选 | candidate-rc3/dsh-word-lookup-0.2.2.tgz；147121 bytes |
| 候选SHA-256 | 5311ac80bfa6140d0c843654ce2031641343a43026576bed08f0f85acace1131 |
| harness SHA-256 | 432a424899c97cafe400186ada2bddf7e1da933d732496d5e0ca5a625d952281 |
| observer SHA-256 | 21d78f26d5cae9082f758ee5230e9565e0d106771c4c0ea87e702223131f66a9 |
| verdict SHA-256 | 5c915409d8cd5c4932efca91dd75a8c07a4434f71ffee073f0bcb8751438848b |

候选实际文件哈希与大小、当前harness/observer/verdict和本次归档均只读复算一致。最终8个installedMembers逐项与上一份已核对的72d18d0d包成员哈希相同，生产源码/产物及包成员没有因添加探针改变。

最新网络为12条，两个Host PID48124和25492各自sequence1–6，无外部/未知目的；浏览器外部尝试0。两个Host在要求停止时仍running，最终owned进程退出、端口释放、测试根保留，cleanup PASS。此项沿用上份报告已经限定的instrumented plugin smoke window范围，不升级为所有native代码网络保证。

## 保留失败及限制

`evidence/runtime022-325bd19b/runtime-report.json`保留FAIL，具体为等待快捷键HTTP响应超时10000ms，pageErrors为空。其归档harness的span没有任何conversation flow marker；生产selection合同本来就拒绝会话流外文本，因此这次失败来自测试夹具不满足产品资格条件，不能据此判为产品回归。修正只在外部harness补上受控DOM标记，没有修改生产selection或命令代码。原FAIL没有被覆盖。

72d18d0d的21PASS仍是历史记录；6e377aeb的断线重连FAIL及control-f62a6c52无插件对照仍保持原样。最新22PASS没有验证浏览器保持开启跨后端强制重启的恢复；该上游rc.3限制、Desktop/其他版本/rollback/完整ECDICT等范围继续遵从上份报告。没有新增提交、Tag、推送或发布授权。
