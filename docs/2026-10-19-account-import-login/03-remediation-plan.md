# 账户导入与在线登录修复方案

日期：2026-10-19。状态：实施设计，尚未修改产品功能。对应 [需求文档](01-requirements.md) 与 [分析文档](02-analysis.md)。

本文为原始设计；后续已实施的代码、检查结果与真实桌面验收边界见 [接续实施记录](05-implementation-status.md)。

执行前先遵循 [项目规则](../../AGENTS.md) 和 [隔离执行规范](../development-rules.md)：涉及 Kiro/AWS 请求的改动先核验当前官方请求证据；禁止停止、覆盖或使用用户正在运行的 1.7.5 做测试。现阶段仅离线验证，完成运行时隔离条件后才进入真实桌面与浏览器授权验收。

## 1. 推荐路线

先修复能够离线稳定复现的 JSON 结构识别与认证渠道归一，再修复登录会话、回调交接和轮询生命周期，最后用 Windows 1.7.5 场景与新构建包做真实授权验收。单纯放宽 `JSON.parse` 或把所有账户强制设为 Builder ID 无法解决这组问题。

| 阶段 | 工作项 | 完成条件 |
| --- | --- | --- |
| A | 统一解析和 provider/authMethod 标准化 | 脱敏样例在所有入口识别一致；Builder ID 选择正确刷新端点 |
| B | 接入文件、文本、OIDC 批量入口与存储结果 | 预览等于提交；错误和去重计数准确；备份可往返 |
| C | 主进程统一登录会话与可恢复结果交接 | 不丢有效完成结果；取消、重试、迟到结果互不污染 |
| D | 分渠道处理 Builder、Social、IAM SSO | 各自的成功、失败、超时、取消路径得到覆盖 |
| E | Windows 打包与真实浏览器授权 | 实际安装包全部 P0 验收通过 |

## 2. 建立明确的导入数据契约

### 2.1 一个解析器，多个业务入口

建议新增 `Kiro-account-manager/src/shared/accountImport.ts` 与 `Kiro-account-manager/src/shared/authIdentity.ts`，作为不依赖 React、Electron、网络的纯函数模块。同步调整两个 TypeScript 配置的 include/编译边界，确保 main 与 renderer 都能使用相同枚举和规范化规则。后续可按复杂度拆分模块，不将大段解析逻辑继续塞入 `AddAccountDialog.tsx`。

建议的数据流：

```text
文件内容 / 粘贴文本
  → 去 BOM、首尾空白、完整代码围栏
  → JSON 语法解析或现有文本格式识别
  → 白名单容器解包
  → 字段、身份、时间和类型标准化
  → 逐条校验，输出 ImportPlan
  → 预览 / 用户提交同一个 ImportPlan
  → 按备份恢复或在线凭证验证分别执行
  → 返回实际新增、失败、重复、取消/未处理结果
```

`ImportPlan` 至少包含识别的格式、源记录总数、有效记录、逐条问题、源 JSON 路径和可用的备份分组/标签。预览与提交共享该对象，避免三个位置重复 `JSON.parse`。

容器只支持文档化形态：单对象、顶层数组、`accounts` 数组/映射、`data` 数组、完整备份。嵌套 `credentials` 仅解包凭证字段，不递归遍历整个对象寻找 Token。合法 JSON 的结构不支持时直接报“不支持的账户结构”；JSON 语法失败不再降级为分隔符文本。

### 2.2 统一身份与字段处理

| 输入情况 | 拟定规则 |
| --- | --- |
| `BuilderId`、`Builder ID`、`builder_id`、`builder-id` | 映射为 `provider=BuilderId`、`authMethod=IdC` |
| Google/GitHub 大小写与约定别名 | 映射为现有 `Google` / `Github` 和 `social` |
| `Enterprise` / `IAM_SSO` | 保留渠道身份，走 IdC/SSO 必要字段校验 |
| `provider` 缺失，但 `idp` 可识别 | 读取并标准化 `idp` |
| 身份缺失但存在完整 OIDC 三件套 | 可推导 IdC；企业身份不明时提示确认，不凭空推断租户 |
| 显式 authMethod 的 `idc` / `IdC`、`social` / `Social` | 按白名单归一为 IdC / social，未知值拒绝 |
| 显式 `provider` 与 `authMethod` 冲突 | 逐条报冲突，不能悄悄选择 Social |
| 显式未知 provider | 报不支持的认证来源，不以凭证字段覆盖显式身份；仅缺省身份可按上述规则推导 |
| camelCase / snake_case | 使用文档化字段映射；拒绝非字符串凭证 |
| 顶层与 `credentials` 中同字段内容冲突 | 报字段冲突；相同值可接受，避免选择旧 Token |
| 缺少邮箱但具备可验证凭证 | 允许进入账户信息查询；查询后再确定账户身份 |
| 社交账户没有 OIDC client 字段 | 按 Social 刷新要求判断，不要求 OIDC client |
| OIDC 缺少 clientId 或 clientSecret | 解析成功但逐条校验失败，准确指出缺失字段 |
| 无效、秒/毫秒混用或字符串到期时间 | 按显式规则标准化；无法判断的时间不伪造为长期有效 |

主进程 `verify-account-credentials` 与 `refreshTokenByMethod` 必须消费同一份规范化身份，避免渲染层决定一个渠道、主进程存储另一个渠道。账户顶层 `idp` 与 `credentials.provider/authMethod` 同步生成，规范化信息同时用于当前请求和持久化。

### 2.3 区分账户备份与简化凭证

完整备份先进行 schema 校验，再恢复账户、分组和标签；不要为了兼容凭证数组而要求备份恢复必须联网。缺少可选集合时使用空数组；集合类型错误应反馈，不直接调用 `.filter` 或 `.length`。

分组策略明确为：完整备份保留其分组和标签关系；导入 ID 与本地分组/标签冲突且定义不同时生成新 ID，并重映射本批账户的引用，保留本地定义。简化凭证添加到当前选择的分组，无当前分组时不自动分组；不从不可信的外部 groupId 推定本地关联。两种入口都在预览中说明本次采用的策略。

简化凭证先离线识别和校验，再通过现有主进程验证流程查询账户；不把 Token 数组直接强转成 `AccountExportData`。令 `importFromExportData` 接收已验证的备份对象，或让其成为更窄的 `restoreAccountBackup`，不承担全部格式猜测。

### 2.4 修正去重与结果语义

在批次开始前建立现有账户索引，并在每条成功时更新该索引。默认串行提交账户；如果采用并发验证，入库阶段须原子检查并保留 in-flight 身份键，失败后释放，防止多个条目在异步保存前同时通过判重。沿用产品允许同邮箱不同身份渠道的现有规则；有稳定 `userId` 时优先用于确认身份。输入文件中的 ID 冲突应重新分配本地 ID，不覆盖已有账户。

现有 `addAccount` 返回新账户 ID；OIDC 重复分支在调用它之前提前返回，却没有累计 skipped。应将添加/导入流程改成返回结构化结果，例如 `added`、`duplicate`、`invalid`、`failed`；调用方根据实际结果计数，并等待可确认的保存结果。批次最终满足 `总数 = 新增 + 失败（含 invalid）+ 重复/跳过 + 取消后未处理`。不要用总输入数减重复数推定成功数。

OIDC 行格式的识别与 JSON 模式分开。保留已经支持的分隔符格式并记录兼容测试；过滤空行和注释后再计算预览总数，逐行保留原始行号。

## 3. 修复网页登录的自动完成链路

### 3.1 主进程拥有会话与完成结果

建议新增 `src/main/auth/loginSession.ts`，每次启动生成 `sessionId`，绑定 provider、region、state、PKCE verifier、到期时间、AbortController、轮询/回调资源与完成结果。状态流为：

```text
idle → starting → waiting → exchanging → validating → completed
                   ↘ failed / expired / cancelled
```

IPC 启动、查询、取消、结果事件都携带 `sessionId`。仅当前会话可转换状态；旧请求返回时先校验会话仍有效。终态幂等，重复回调不能再次兑换或入库。取消停止网络请求并清理对应资源，新会话不能被旧会话的 `finally` 清掉。

为解决瞬时 IPC 丢失，先写入主进程会话结果，再发送状态通知。renderer 在启动前订阅，启动完成/对话框恢复时按 `sessionId` 查询一次快照；通知用于唤醒，快照用于恢复。完成结果采用短期保留及确认机制，限定发送至当前应用窗口，超时后清理凭证。

保持当前成功行为：验证账户后自动 `addAccount`、刷新列表并关闭对话框。添加结果可观察且持久化成功之后才标记完成；不要因第二阶段失败反复兑换一次性 code。凭证兑换成功与账户数据保存分别记录内部状态，以支持受控重试。

### 3.2 Builder ID：修正设备授权轮询

Builder ID 无浏览器 URI 回调是正常机制，它依靠 `/token` 的设备授权轮询完成。将固定 `setInterval` 改为单请求串行的递归调度，下一次请求必须在前一次结束后启动；采用服务端下发间隔，并在 `slow_down` 时增加后续间隔。

将服务端 `expiresIn` 换算成当前会话的到期点；遇到授权待定继续，拒绝、过期和不可重试错误进入终态。网络异常使用有上限、受会话到期时间约束的退避。完成/取消/重试时校验 session，不依靠 React state 的异步更新防止重复处理。更适合由 main 负责轮询，renderer 订阅状态；如阶段性保留 renderer 轮询，也必须传入并校验 session 与服务端间隔。

### 3.3 Google/GitHub：加固自定义协议交接

当前 Social 授权 redirect URI 使用 `kiro://`。修复前先验证 Windows 协议归属、注册成功与否以及浏览器实际打开的进程，结合开发模式/安装包分开记录。**不能直接把 URI 改成独有 scheme 并假定 AWS 上游允许它**；如服务端 redirect URI 有白名单约束，必须保留可接受的 URI，并提供明确的注册检查和受支持的恢复方式。

检查运行时 `setAsDefaultProtocolClient` 的返回值；区分开发模式的可执行文件参数与打包参数；处理 `second-instance`、macOS `open-url`，以及 Windows/Linux 冷启动 `process.argv` 中的认证 URL。启动阶段先缓存 URL，窗口与会话准备好后统一消费。恢复窗口统一执行必要的 restore、show、focus，覆盖隐藏到托盘的情况。不要在每次普通退出时无条件注销共享 `kiro` 协议；不能以此破坏已有 IDE 的合法配置。

进程完全退出后，当前仅存于内存的 PKCE verifier 与会话状态已经丢失。补冷启动 URL 处理后，对没有有效会话的回调应明确提示登录会话失效并重新发起授权，不能假定凭 code 能恢复。跨进程重启继续登录需要另行设计有时限的安全临时状态存储，不作为本次默认实现。

使用严格的 scheme、host、path 校验，将匹配 `state` 作为会话绑定条件；处理远端 `error`、缺失参数、重复和过期回调。加入绝对到期时间、可见的超时和重试入口。日志只记录 session、provider、阶段和脱敏错误，不记录 code、verifier 或 Token。

### 3.4 IAM SSO：管理本地回调与结果查询

IAM SSO 使用 `127.0.0.1` 本地 HTTP 回调加 PKCE，renderer 轮询的是主进程结果，不是设备 Token。监听完成后才打开浏览器；用完整路径与 state 验证请求；兑换完成后保存主进程结果，浏览器只显示“授权完成，桌面端正在验证并保存”。最终“账户添加成功”必须等到账户校验及持久化确认后再显示。

处理监听端口失败、浏览器打开失败、拒绝、超时、兑换失败和取消。无效或旧回调不得关闭当前有效会话的服务。关闭回调服务和清理结果必须按 session 归属执行；新会话启动前等待旧监听释放。renderer 查询可因隐藏/暂停而延迟，结果应保留到确认或到期，而不是靠一次事件送达。

## 4. 预计涉及的文件

下表路径相对仓库根目录，新增路径是拟议设计。

| 文件 | 改动目的 |
| --- | --- |
| `Kiro-account-manager/src/shared/accountImport.ts`（新增） | 解析、解包、字段校验、ImportPlan、错误路径 |
| `Kiro-account-manager/src/shared/authIdentity.ts`（新增） | provider/authMethod/idp 统一映射及冲突校验 |
| `Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx` | 共用批量结果、正确计数、订阅与取消会话、移除重复解析 |
| `Kiro-account-manager/src/renderer/src/components/accounts/AccountManager.tsx` | 文件入口接入统一解析 |
| `Kiro-account-manager/src/renderer/src/components/pages/SettingsPage.tsx` | 数据恢复入口 schema 检查和明确错误 |
| `Kiro-account-manager/src/renderer/src/components/accounts/ExportDialog.tsx` | 标准化导出与往返测试，必要时补 schema/version 元数据 |
| `Kiro-account-manager/src/renderer/src/store/accounts.ts` | 备份结构保护、真实添加结果、批内去重及 ID 冲突处理 |
| `Kiro-account-manager/src/main/auth/loginSession.ts`（新增） | 会话状态、到期、清理、结果确认 |
| `Kiro-account-manager/src/main/index.ts` | 身份路由、登录 IPC、协议处理、启动 URL 缓存 |
| `Kiro-account-manager/src/preload/index.ts`、`index.d.ts` | 会话 API、结果类型、订阅返回类型同步 |
| `Kiro-account-manager/electron-builder.yml` | 按验证结论调整协议配置，避免盲目改 scheme |
| `Kiro-account-manager/tsconfig.node.json`、`tsconfig.web.json` | 支持共享纯函数模块 |

根因位置与版本间行号差异以分析文档的精确源码引用为准。

## 5. 测试与交付门槛

先将本次 `evidence/` 中的缺陷复现转换为针对新模块/真实入口的回归测试，再修改功能。当前复现脚本验证的是旧行为，它们不是“修复后应继续通过”的产品验收测试。

| 测试层 | 必须覆盖 |
| --- | --- |
| 纯函数 | 所有 JSON 形态、别名、嵌套字段、冲突、类型错误、BOM/围栏、源路径 |
| 导入集成 | 真实预览/提交同计划、主进程渠道路由、文件与粘贴一致、保存结果计数 |
| 存储 | 当前备份往返、旧备份兼容、批内/批外去重、ID 冲突、无效项不覆盖 |
| 登录离线 | 早到/迟到/重复回调、冷启动、slow_down、慢请求、取消后重试、超时、state 错误 |
| Windows 桌面 | 开发模式与安装包，Kiro IDE 同时安装、协议归属、各登录渠道真实授权和账户入库 |

现有 `test:e2e` 主要面向反向代理 HTTP API，不能代替本任务的账户管理与桌面授权测试。新增测试入口应无需有效账号即可运行离线回归。功能实施后在应用目录执行 `npm ci`、`npm run typecheck` 和 `npm run build`，再打包并验证 Windows 客户端。真实授权用单独的隔离测试账户与测试数据目录，不使用结构测试冒充授权成功证明。

最终交付应包含：功能 diff、脱敏回归夹具、自动测试结果、Windows 安装包验证记录，以及未通过的验收项及原因。只有离线回归和相关真实桌面 P0 用例都通过后，才将“网页登录自动完成已修复”标记为完成。
