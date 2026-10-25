# v0.2.2 发布前验证报告

**结论：PRE_PUBLICATION_VALIDATION_PASS_WITH_RECORDED_LIMITS。** 已完成本轮授权的发布前验证；候选包未发布，源码尚未提交或打Tag。

## 版本与范围

- 源码基线HEAD：`62e18f8b6ceff318370ef59caa8d66d261f50f23`；既有修复以未提交工作区状态保留。
- 版本：`0.2.2`，只递增根包及锁文件根版本；依赖树没有更新。
- 用户选择当前安装DSH为正式验收基线；CLI实测`0.2.1-rc.3`，carrier Node`v24.21.0`。新建隔离Web Profile，正式desktop Profile未参与。
- 修复方案11项确认缺陷及UX-001已完成；RISK-001防御性加固已完成，原生触发仍未复现。BUG-003剩余Minor断言本轮关闭。性能假设没有冒充已修缺陷。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 整合回归 | 70文件、1739测试通过，0失败/跳过，219.08秒 |
| 旧P01–P07整套 | NOT_EXECUTED；默认CLI及历史Git/版本前提 |
| Fixture确定性 / native构建 / 声明 / noEmit | PASS；源码三份JS与既有修复产物字节一致 |
| bundle门禁 | 100/100 PASS |
| 候选包 | 8个允许成员逐字节一致；真实Worker integrity_check及退出后删除PASS |
| 真实隔离Web | 22/22 PASS；真实Fixture与受控格式化响应明确分开 |
| 网络观察 | 两Host窗口12条记录，非本地尝试0；carrier正例及15判定案例通过 |
| 独立只读复核 | GPT-6.1-SOL / High，三份Spec/Quality限定范围PASS，Critical/Important/Minor均0 |
| 凭据扫描 | 复制前扫描551文件+补扫471份源文本PASS；应用后再扫描并单独记录 |

## 最终候选身份

- 文件：`build/rc-v0.2.2/dsh-word-lookup-0.2.2.tgz`（应用后保存，Git忽略）。
- 大小：**147121 bytes**。
- SHA-256：`5311ac80bfa6140d0c843654ce2031641343a43026576bed08f0f85acace1131`。
- SRI：`sha512-IShZ22GgzI4KGEuP3jb+qwB053DqAMn7Xsj+Xb+Aq0JBQtjBxqTkwh9aB3wQaj2fhvqF2fkZnC4kfgcc+yeWKA==`。
- README与package.json仍标识候选/未发布；如后续修改任何包成员，应重新打包并更新身份及相应验证。

## 真实运行时与数据保护

- Profile：`release022-rc3-5e06c194`；DSH_HOME：`C:\Users\20659\AppData\Local\Temp\dsh-022-preflight-af97f83f7e\runtime022-5e06c194\home`。HOME、USERPROFILE、APPDATA、TMP、agents、Documents和pnpm store均使用本次临时根。
- 通过DSH CLI离线安装和卸载，安装下载0包。实际pnpm虚拟存储位于独立Profile内，不能错误要求合法pnpm软链接本身消失；校验最终真实路径仍在隔离Profile且8成员匹配。
- 真实查词derive来源sqlite-fixture；排版/长条目采用明确受控响应，不能算完整ECDICT查询。320px视口卡片left12/right308/width296；滚动height977/client438，scrollTop0→120。主代理已查看设置、窄卡片和滚动截图。
- 卸载验证：健康服务认证200、匿名401/403、真实inventory及preset无插件、global缺失、实际rc.3源码指纹绑定的缺路由404。传输异常或非200不能算成功。
- 观测器于Host加载前安装，记录并阻断非本地Node网络API尝试；浏览器在导航前记录/阻断非本地HTTP(S)。唯一允许的辅助子进程是严格限定的本地注册表只读查询。未知目标、非透明子进程、Worker、丢失日志序号、缺少真实退出均不能通过。该证据不是抓包，也不覆盖任意native代码网络能力。
- 两个测试Host退出码1均是明确OWNED_TEST_SHUTDOWN；父进程确认停止前仍运行、停止后真实退出及端口释放。正式Profile没有读取或修改；不通过读取正式Session/Credentials来证明隔离。

## 历史失败及新发现的上游限制

- 早期欢迎/登录引导阻挡设置入口、pnpm remove不接受offline/ignore-scripts及store位置不一致均按FAIL保留，随后修正验收设施；没有伪装成插件生产Bug。
- `runtime022-6e377aeb`对同一最终包因页面跨Host强制重启出现`scope 'session-maybe' rendered without an installed adapter`而FAIL，其他功能/卸载/网络检查PASS。该FAIL未覆盖。
- `control-f62a6c52`从空依赖Web模板启动，插件global缺席且请求404，在两次reconnect-without-plugin阶段复现同一DSH ScopeProvider错误。它实证不依赖本插件；未对上游根因作完整审计。
- 正常安装/卸载验收按先关浏览器、再停Host/卸载，重启后开新context执行；`runtime022-5e06c194`全部22项PASS、pageerror为0。没有删pageerror断言。**浏览器保持存活跨后端重启的恢复不在本轮兼容性承诺内。**

## 仍未验证

- 正式Desktop、旧rc.2及其他DSH版本、回滚、完整ECDICT及性能、真实磁盘耗尽和跨进程TOCTOU。
- 原生Worker terminate拒绝/长期pending仍未复现；F03和已有操作系统/转义语义限制继续保留。
- 完整语料、Fixture、合成UI及真实运行时范围分开；不新增未测性能或兼容性声明。

## 证据索引

- [最终运行时](runtime/runtime022-5e06c194/runtime-report.json)、[最终产物](checks/final-artifact-rc3.json)、[无插件重连对照](runtime/control-f62a6c52/control-report.json)。
- [整合回归摘要](regression-summary.json)、[完整日志](logs/integrated.log)、[Minor RED](logs/minor-hardened-mutation.log)、[Minor GREEN](logs/minor-green.log)。
- [初次只读复核](reviews/review-022-preflight.md)、[运行时补充复核](reviews/review-022-runtime-addendum.md)。前者的当时NOT READY未被改写，后续用户授权及新证据由补充报告记录。
- [归档哈希索引](archive-index.json)记录原始与归档哈希及脱敏差异；原始证据仍在仓库外。重现脚本为当时源码归档，路径属于该次独立副本，不能直接在正式Profile运行。

## 后续发布动作

当前属于候选验证完成，下一步为项目所有者确认源码冻结/提交、Tag及发布。没有执行Git提交、推送、npm/GitHub发布；公开latest仍为0.2.1。应用记录与最终只读检查会追加在本目录。

## 默认快捷键补充验证

最终运行还包含真实Control+Shift+L：受控构造符合data-chat-flow-kind合同的会话文字derive，Playwright发出真实键盘事件，经DSH已注册命令/选区捕获/真实HTTP/SQLite返回sqlite-fixture，client issued0→1。此项没有用runLookup或路由mock触发；文字DOM是受控fixture，不代表发送过模型消息。旧325bd19b因夹具不在会话流内而超时的FAIL保留；修正夹具后最终22项全部通过。原72d18d0d的21项报告原样保留。

原生快捷键已由同一6.1-SOL/High审核员完成补充只读核对，Critical/Important/Minor均0，见[原生链路复核](reviews/review-022-native-addendum.md)。最终源副本追加凭据扫描751文件PASS，原始551文件扫描仍作为历史记录保留。应用后完整扫描见final-checks.json。
