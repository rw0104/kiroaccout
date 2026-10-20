# 账户 JSON 导入与网页登录故障分析

日期：2026-10-19。状态：分析完成，功能修复待实施。对应 [需求文档](01-requirements.md) 与 [修复方案](03-remediation-plan.md)。

本文保留最初的缺陷分析基线，文中 HEAD 指 `8f11db5`；后续代码和测试进展见 [接续实施记录](05-implementation-status.md)。当前源码已修复部分基线行为，历史复现应选择 v1.7.5 引用，新验收使用 `npm run test:unit`。

## 1. 核心结论

这组问题包含三个独立层次，不能统称为“JSON 不合法”：

1. **文件入口不接受现有样例结构。** 三份样例都是合法顶层数组，账户管理的文件入口只接受完整备份包装；设置页则把数组交给只接受备份的存储函数，发生运行时错误。
2. **Builder ID 样例被选择到错误认证链路。** 四条 Builder ID 记录的 provider 是展示名称 `Builder ID`，代码只识别 `BuilderId`；在未显式提供 authMethod 时推导成 `social`，最终发起 Social 刷新而不是 OIDC 刷新。这个缺陷能直接解释该样例的主要失败模式。
3. **在线登录存在会话竞争、结果丢失及轮询问题。** 已通过实际源码的离线模拟复现；用户机器上究竟触发哪条分支，还需要真实桌面授权与协议归属证据。不能把所有“不回调”归因于同一协议问题。

Google/GitHub 两份样例能够通过现有 OIDC 批量入口的基本结构和字段识别。它们在文件导入时会被拒绝，但批量入口中的偶发失败尚不能据此认定为 JSON 解析错误；仍可能发生于远端刷新、账户查询、网络或状态处理阶段，本次没有使用真实凭证联网验证。

## 2. 分析基线与边界

| 项目 | 基线 |
| --- | --- |
| 用户反馈版本 | 1.7.5，Builder ID 问题最严重，Google/GitHub 偶发 |
| 用户版本源码标签 | `v1.7.5` → `56310443f73ea535836a51a7170e2e027d1df1ea` |
| 源码位置 | 当前 Git 检出目录；公开引用使用仓库相对路径 |
| 拉取的 main | `8f11db50f64cc4faf3f9c0dff8eca543c01cdc15`，应用版本 1.7.6 |
| 应用相对路径 | `Kiro-account-manager/`，不是仓库根目录 |
| 分析环境 | Windows、Node.js 24.16.0，离线提取实际 TypeScript 函数执行 |
| 修改范围 | 新增本文档组和脱敏复现脚本；未修改产品源码 |

批量 handler、刷新路由、IPC 前置守卫，以及文件导入相关四段函数，已比较两版提取源码的 SHA-256，相关片段一致。`AddAccountDialog.tsx` 在 `v1.7.5..HEAD` 无差异。在线登录相关处理逻辑也在两版离线复跑得到相同结果。

1.7.6 的主进程、preload 和 store 整个文件确实还有其他变化，不能说两版全部相同。1.7.6 新增的 `backgroundThrottling: false` 可能影响后台轮询节奏，但并未解决本文证实的路由、会话与回调交接缺陷。

本次没有启动真实 Electron 窗口、修改 Windows 协议注册、触碰 Kiro 认证缓存、验证真实账号或执行真实持久化。网络、IPC、React 状态和存储副作用由受控 mock 替换。离线脚本证明代码行为，不证明远端凭证仍有效。

## 3. 本地样例结构

仅记录匿名样例编号、字段结构与数量，不记录原始文件名、账号邮箱、密码、Token 或其他身份值。

| 文件 | 数量与渠道 | 关键结构 | 现有文件入口 | 现有 OIDC 批量入口 |
| --- | --- | --- | --- | --- |
| 样例 A（文件名已隐去） | 3 条 Github/social | 顶层数组；有 accessToken、refreshToken、provider、authMethod；无邮箱和 OIDC client 字段 | 账户管理拒绝；设置导入失败 | 基本识别正常，走 Social；不要求 OIDC client 是合理的 |
| 样例 B（文件名已隐去） | 2 条 Google/social | 顶层数组；有邮箱、渠道、Token 及其他元数据；OIDC client 字段未构成有效三件套 | 账户管理拒绝；设置导入失败 | 基本识别正常，走 Social |
| 样例 C（文件名已隐去） | 4 条 Builder ID | 顶层数组；有邮箱、refreshToken、clientId、clientSecret；provider=`Builder ID`，无 authMethod | 账户管理拒绝；设置导入失败 | 能解析 4 条，但错误推导 social |

三份均无 BOM、无 `credentials` 嵌套。因此 BOM、包装解包和嵌套凭证问题是额外兼容性发现，不是这三份原始样例的共同原因。

## 4. 复现方法与证据索引

三个脚本默认只使用合成数据，从目标源码提取并运行原有函数；使用唯一边界定位代码，不另写一个“等价实现”来代替被测代码。运行位置是仓库根目录，Node.js 需提供 `node:module.stripTypeScriptTypes`；本次已在 Node.js 24.16.0 验证。

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs
```

对用户版本复现，无需切换当前工作区：

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs --ref v1.7.5
```

本机只读样例检查（仅输出结构/计数）：

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5 --samples .local/samples
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5 --samples .local/samples
```

| 证据 | 来源 | 结果 | 证据边界 |
| --- | --- | --- | --- |
| E-01 | [json-import-repro.mjs](evidence/json-import-repro.mjs) | HEAD 与 v1.7.5 各 20/20 基线断言成立；含正常备份控制项 | 文件选择与保存 mock；真实函数负责解析/去重/存储结构 |
| E-02 | [oidc-batch-repro.mjs](evidence/oidc-batch-repro.mjs) | 两版各 29 个矩阵案例符合当前行为；含规范输入控制项 | stub 接受不等于真实凭证可用；重点观察识别、守卫和路由 |
| E-03 | [online-login-repro.mjs](evidence/online-login-repro.mjs) | 两版各 13 项检查成立，其中 2 项正常链路、11 项缺陷观察 | 不包含真实 OS 协议注册或浏览器授权 |
| E-04 | 两个导入脚本的可选样例模式 | 9 条真实样例的结构、字段与路由分类 | 不输出真实字段值，不进行真实账号验证 |
| E-05 | `git diff v1.7.5 8f11db5 -- Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx` 及脚本的提取哈希 | 对应 handler/校验/导入函数相同 | 并非两版整个仓库相同 |
| E-06 | 本节所引源码、协议配置和生命周期代码 | 补充冷启动、关闭弹窗、窗口恢复和现有测试范围 | 静态发现，平台表现保留待验 |

这些脚本的 PASS 表示“观察到的现有行为与缺陷断言一致”，**不是功能已修复**。两版分别完成 62 项检查，不将同一测试的两次运行当成 124 个不同用例。

## 5. 已证实的问题

以下源码链接冻结到分析基线 main 提交 8f11db5；行号差异另列。根因与证据通过 F 编号和 E 编号关联。

### F-01：文件导入协议不一致

- 状态：已验证；优先级 P0；证据 E-01、E-04、E-05。
- 位置：[AccountManager.tsx:101](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AccountManager.tsx#L101)、[SettingsPage.tsx:373](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/pages/SettingsPage.tsx#L373)、[accounts.ts:1233](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/store/accounts.ts#L1233)。store 对应 v1.7.5 行号为 1218。
- 账户管理通过 `data.version && data.accounts` 判断备份，拒绝合法数组、单对象和无 version 包装。设置页直接调用 `importFromExportData`，数组中没有 `accounts`，随后 `.filter` 失败。
- 自身 [ExportDialog.tsx:58](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/ExportDialog.tsx#L58) 可导出顶层 OIDC 数组，该产物也无法从文件入口导回。
- 影响：三份原始样例共 9 条全部在文件入口失败，尚未进入凭证校验。
- 方向：统一结构识别，区分备份恢复与凭证添加，建立导出/导入往返用例。

### F-02：Builder ID 别名被错误推导为 Social

- 状态：已验证；优先级 P0；证据 E-02、E-04、E-05。
- 位置：[AddAccountDialog.tsx:734](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L734)、[main/index.ts:752](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L752)、[main/index.ts:4385](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L4385)。main 验证 IPC 在 v1.7.5 始于 4229，身份回退逻辑在 4242；刷新路由两版均为 752。
- renderer 采用精确比较 `provider === 'BuilderId' || provider === 'Enterprise'` 推导 IdC，否则为 Social。`Builder ID` 因空格无法匹配，虽有完整 client 三件套，仍被选到 Social 刷新。
- 主进程又将未知 provider 的顶层 `idp` 回退为 BuilderId，但 `credentials.provider` 仍保留 `Builder ID` 等原始别名，实际 authMethod 和刷新路由为 Social，身份字段与认证路由相互矛盾。
- 对照复现：同样的合成记录仅补 `authMethod: 'IdC'`，路由即从 social 变为 oidc，确认是渠道推导问题，非 JSON 语法问题。
- 同类扩展：`GitHub` 或小写 `google` 可走 Social，但 `idp` 仍可能回退为 BuilderId；`Social` 大小写差异还可能导致错误要求 OIDC client。原始 Google/Github 样例使用规范值，不能把这些扩展案例说成其已证实原因。
- 方向：main 与 renderer 共享 provider/authMethod/idp 标准化和冲突校验，禁止未知值默认走 Social。

### F-03：OIDC 批量输入只识别扁平字段

- 状态：已验证；优先级 P0；证据 E-02。
- 位置：[AddAccountDialog.tsx:674](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L674)、[AddAccountDialog.tsx:1791](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L1791)、[AddAccountDialog.tsx:1862](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L1862)，两版相同。
- 使用 `Array.isArray(parsed) ? parsed : [parsed]`，不解包 `accounts` / `data`，也不读取 `credentials`，不映射 snake_case。
- `{accounts:[两条]}` 被预览为 1 条，并报顶层缺少 refreshToken；两条嵌套 credentials 记录被识别为 2 条，却全部报缺少 Token；snake_case 同样失败。
- 三处重复解析目前对规范扁平数组计数一致，但都不能表达真实源记录。Markdown 围栏和某些语法错误会被预览降级为“卡密”，与提交结果不一致。
- 方向：一次解析生成结构化计划，预览与执行共享该计划，语法与结构错误分别展示。

### F-04：结构校验和结果计数不足，可能误报成功或覆盖数据

- 状态：已验证；优先级 P0（错误覆盖）/P1（错误反馈）；证据 E-01、E-02。
- 位置：[accounts.ts:1150](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/store/accounts.ts#L1150)、[accounts.ts:1225](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/store/accounts.ts#L1225)、[accounts.ts:1253](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/store/accounts.ts#L1253)、[accounts.ts:1277](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/store/accounts.ts#L1277)；对应 v1.7.5 行号均减 15。
- 仅给扁平记录外包 `version/accounts/groups/tags`，不会补齐内部 Account：两条记录均缺 id/credentials，提示成功 2 条，但 Map 的 undefined 键只剩一条。不能把这种包装当成修复。
- 两个不同账户使用相同导入 ID，提示成功 2 条，最终仅剩 1 条；与现有账户 ID 冲突时会覆盖原账户。
- 文件内只按 email 去重，同邮箱不同 provider 被丢弃；对本地记录按 `credentials.provider` 判重，缺 provider 时可能忽略有效 idp。丢弃/跳过数量未统一计数。
- 空对象可被当成成功账户；null 记录可导致整批失败；groups/tags 缺失也可触发整批错误。简化 importAccounts 入口同样缺乏必填校验和去重。
- OIDC 批量的已存在账户出现 total=1、success=0、failed=0，仍关闭对话框。对象类型和全空白字符串的 Token 可以穿过部分前置守卫到达刷新函数；stub 的接受并不代表远端会接受。
- 上述 OIDC 分支定位：[AddAccountDialog.tsx:726](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L726) 的字段判断、[750](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L750) 的重复提前返回、[848](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L848) 的关闭条件，以及 [main/index.ts:4390](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L4390) 的 IPC 守卫。
- 方向：入库前保证完整实体，生成/处理本地 ID，统一身份去重；以真实结果统计新增/失败/重复，而不是输入数或调用次数。

### F-05：登录异步结果没有会话隔离

- 状态：离线已验证；优先级 P0；证据 E-03。
- 主进程使用共享 `currentLoginState` 和共享 IAM 结果；旧请求跨 await 后继续写全局状态，没有 sessionId fencing。

| 具体路径 | v1.7.5 main 行号 | HEAD main 行号 | 可复现结果 |
| --- | --- | --- | --- |
| Builder poll | 4879、4981 | [5022](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5022)、[5124](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5124) | A 取消后启动 B，A 的迟到失败清空 B |
| Social exchange | 5381 | [5524](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5524) | A 的迟到兑换结果清空 B，B 正确回调无法继续 |
| IAM 回调和结果 | 5168、5288 | [5311](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5311)、[5431](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5431) | B 启动后消费了 A 的 Token/region，旧流程清理 B |
| Social state mismatch | 5389 | [5532](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5532) | 无效/旧 state 直接销毁本来有效的会话 |

这说明取消后重试可能“再次授权却不完成”，也可能使用错误会话结果。应绑定会话身份，并在每个异步返回点、结果消费和资源清理前检查归属。

### F-06：Builder 设备流轮询不会可靠适应慢网和 slow_down

- 状态：离线已验证；优先级 P1；证据 E-03。
- 位置：[AddAccountDialog.tsx:406](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L406)、[main/index.ts:5174](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5174)；main 对应 v1.7.5 行号 5031。
- renderer 使用 async setInterval；两次 tick 可同时发起两个尚未完成的 Token 请求。
- main 在 slow_down 时把 interval 从 5 秒调成 10 秒，但 renderer 仍每 5 秒调一次，无法遵守新的轮询频率。
- 方向：串行、受到期时间约束的调度；main 主导轮询或将间隔显式返回；取消和超时进入可见终态。

### F-07：Social 回调瞬时交接丢失，注册失败被误报成功

- 状态：离线已验证；优先级 P0/P1；证据 E-03。具体机器的协议冲突仍属待验证项。
- 位置：协议注册 [main/index.ts:2379](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L2379)，对应 v1.7.5 2234；回调路由 [main/index.ts:7192](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L7192)、[7215](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L7215)，对应 v1.7.5 7049、7072；renderer 订阅 [AddAccountDialog.tsx:149](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L149)。
- `setAsDefaultProtocolClient` 返回 false 时仍打印成功。不能把日志中的 Registered 当成操作系统确已交接成功的证据。
- URI 到达时仅通过 `webContents.send` 发送一次事件；窗口不存在或 renderer 未订阅则没有缓存、查询或确认重放，成功授权可能无法继续。
- Social 会话 [main/index.ts:5498](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5498) 没有明确 expiresAt 或超时定时器，对应 v1.7.5 5355；授权回调不来时可持续等待。
- 方向：验证注册结果；main 保存可查询的会话状态，通知与结果解耦，加入时限和幂等消费。

### F-08：IAM 浏览器页过早显示成功

- 状态：离线已验证；优先级 P1；证据 E-03。
- 位置：[main/index.ts:5334](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/main/index.ts#L5334)，对应 v1.7.5 5191。
- 浏览器已收到“成功”页面时，主进程尚未完成 Token 兑换。兑换失败后网页仍显示成功，用户看到浏览器成功、桌面端没有账户，易误认为单纯“不回调”。
- 方向：区分“收到授权回调”与“账户添加成功”，在可用的结果阶段显示准确状态，desktop 保留具体错误。

## 6. 静态补充与仍需桌面验证的项目

| 项目 | 证据与推断 | 结论强度 |
| --- | --- | --- |
| 关闭弹窗不取消 | [AccountManager.tsx:286](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AccountManager.tsx#L286) 始终挂载；[AddAccountDialog.tsx:133](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L133) 仅卸载清理；[1000](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L1000) 与 1006 关闭入口只 onClose | 代码确认缺少关闭时取消；需 UI 验证用户表现 |
| 隐藏到托盘后未显式 show | main 2326/2573 使用 hide；回调 7216 和 second-instance 7265 只有 focus/局部 restore | 代码确认缺少 show；平台表现待验 |
| `kiro` 协议归属冲突 | [electron-builder.yml:20](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/electron-builder.yml#L20) 与运行时使用共享 scheme；普通退出注销也影响归属 | 可能被其他 Kiro 安装/版本接管，未检查用户注册表，不能认定已发生 |
| 冷启动 argv | 当前路由处理 second-instance/open-url，未形成初始 argv 的统一交接 | 应补行为；但进程退出后内存 PKCE 已丢，不能只靠 code 自动恢复旧登录 |
| Google/GitHub 偶发导入失败 | 两份样例的基本批量识别通过 | 需记录脱敏阶段、HTTP 状态、错误码、provider、session 与请求耗时；不猜测具体远端原因 |

`kiro://kiro.kiroAgent/authenticate-success` 可能受到上游 redirect URI 规则约束，不能直接换 scheme/loopback 并宣称修复。IAM 注册 URI 与实际 URI 的动态端口差异也不能仅凭字符串不同认定为错误，需按服务端行为验收。

## 7. 调用链与证据关系

### P-01：文件导入失败

`样例顶层数组 → import-from-file 返回文本 → AccountManager JSON.parse → version/accounts 判断失败 → 无账户入库`。

设置入口则为：`JSON.parse → importFromExportData → data.accounts.filter 异常 → 导入失败`。关联 E-01/E-04 → F-01/F-04 → REQ-01/REQ-04。

### P-02：Builder ID 批量导入错路由

`JSON.parse 成功 → 扁平数组 4 条 → provider 为 Builder ID → renderer 推导 social → verify-account-credentials → refreshTokenByMethod 选 Social → 远端校验可能拒绝`。

直到选择错误的刷新函数为止已有动态证据；最后的真实远端响应未调用。关联 E-02/E-04 → F-02 → REQ-02。

### P-03：网页登录自动添加

| 渠道 | 实际链路 |
| --- | --- |
| Builder ID | startBuilderIdLogin → 浏览器确认设备授权 → pollBuilderIdAuth → Token → handleLoginSuccess |
| Google/GitHub | startSocialLogin → 浏览器授权 → kiro URI → main 路由 → social-auth-callback → exchangeSocialToken → handleLoginSuccess |
| IAM SSO | startIamSsoLogin → 浏览器授权 → 本地 HTTP 回调 → main 兑换 Token → pollIamSsoAuth 查询结果 → handleLoginSuccess |

统一尾部为 [AddAccountDialog.tsx:186](https://github.com/chaogei/Kiro-account-manager/blob/8f11db50f64cc4faf3f9c0dff8eca543c01cdc15/Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx#L186) 的 `verifyAccountCredentials → addAccount → resetForm → onClose`，现有设计已经是自动添加，无需新增二次确认。Builder 的“回调”实际是设备授权轮询；IAM 的 renderer poll 查询的是主进程结果，二者不能混淆。

关联 E-03/E-06 → F-05/F-06/F-07/F-08 → REQ-03/REQ-04。成功链路有离线控制项，具体 OS 交接与真实上游授权仍列为集成验收。

## 8. 实施建议与验证缺口

优先按 F-01/F-02/F-03 修复识别与路由，同时补上 F-04 的入库保护，再处理 F-05/F-07 的会话与结果交接；F-06/F-08 与生命周期问题随登录修复一并覆盖。详细模块与步骤见 [修复方案](03-remediation-plan.md)。

现有 `test:e2e` 以 API 反代为主，不覆盖本组桌面账户管理链路。本轮未运行 npm build/typecheck：没有修改产品 TypeScript，离线复现无需安装依赖。功能实施后仍需类型检查、打包及真实 Windows 浏览器授权测试，不能以本文 62 项旧行为检查代替修复验收。
