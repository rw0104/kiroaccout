# 开发与发布指南

本指南适用于 `rw0104/kiroaccout`。当前源码目标为 **1.7.7-rc.1**，正式版保持 **1.7.6**。候选版包含第 4、5 项与当前请求适配。经用户授权，已在已登录的官方 Kiro 客户端完成一条真实 AI 对话检查；候选版 Runtime 最小请求已返回 HTTP 200 与预期标记；门户授权和跨 Windows 用户 GUI 仍待实测，本轮暂不进行扫码授权验收。

先读[项目规则](../AGENTS.md)、[隔离执行规范](development-rules.md)及[本轮需求](requirements/2026-10-20-isolation-export-current-client.md)。**账户管理器自身没有经过验证的运行时隔离模式。不同源码、安装目录、ZIP 或单个 user-data 参数均不隔离管理器与生产资料；当前开发会话默认只执行源码检查、合成测试和构建。** Kiro 客户端按 Windows 用户分离是另一个功能，不能混为一谈。

## 1. 准备依赖和离线验证

使用 Node.js **24.16.0 或更新的 24.x**、npm 和 Git。Windows 发布需要 Windows x64 及可访问 Electron/electron-builder 下载资源的网络。仓库根保存文档，npm 命令在应用子目录执行：

```powershell
git clone https://github.com/rw0104/kiroaccout.git
Set-Location ./kiroaccout/Kiro-account-manager
node --version
npm ci
npm run test:unit
npm run build
```

已有检出先检查 `git status --short`，保留其他人的改动，不使用 reset 或目录清理替代依赖维护。`npm ci` 使用 lockfile，并运行依赖安装脚本。项目 `postinstall` 检查 Electron 包元数据和 cbor-extract/Koffi 的 Node-API 预编译库，不启动客户端；打包器独立下载 Electron。不要用 `--ignore-scripts` 或强制原生重编译绕过检查，也不要把 `electron/path.txt` 缺失直接当作打包器无法下载运行库。

| 命令 | 目的 | 输出及副作用边界 |
| --- | --- | --- |
| `npm run test:unit` | 共享解析、导出、认证、刷新、更新、实例和 Runtime 回归 | 合成凭证、内存存储和 mock；回调测试只使用本机临时 HTTP 监听 |
| `npm run typecheck` | main/preload 与 renderer 类型检查 | 不启动应用 |
| `npm run build` | 类型检查与 electron-vite 编译 | 写入 `out/`，不启动应用 |
| `npm run package:win` | 打包已编译的 Windows x64 应用 | 写入 `dist/`，显式 `--publish never`，不安装、不上传 |
| `npm run verify:package` | 静态检查 ASAR、原生库、版本和更新仓库 | 写入本地包检查报告，不执行 EXE |
| `npm run release:checksums` | 按版本和渠道选择精确附件并计算 SHA-256 | 写入 `dist/SHA256SUMS.txt`；`-- --verify` 复核清单 |
| `npm run release:stage` | 收集当前渠道应发布的附件 | 写入 `dist/release-assets/<version>/`，拒绝混入其他文件 |
| `npm run dev` / `npm start` | 启动 Electron | 先满足完整运行时隔离条件，不能在生产会话直接验证 |
| `npm run test:e2e` | 连接运行中的桌面代理 | 不属于离线测试，不能连接生产服务执行 |

截至本轮记录，**180/180 项离线回归通过**。本次类型检查、编译、打包与发布的最终结果以对应构建日志为准，不将历史结果套用至后续提交。1.7.6 的 105 项记录及更早的 85 项记录属于各自版本，详见[历史实施记录](2026-10-19-account-import-login/05-implementation-status.md)。

## 2. 定位模块和测试

下表源码路径相对应用目录 `Kiro-account-manager/`；测试由 `test:unit` 发现，不加载真实 Electron 应用。

| 入口或模块 | 职责 | 修改与回归重点 |
| --- | --- | --- |
| `src/shared/authIdentity.ts`、`accountImport.ts`、`backupRestore.ts` | 身份标准化、导入计划和备份恢复 | 多提供商、对象/数组/包装、字段冲突、稳定身份、ID 及关系映射 |
| `src/shared/accountExport.ts`、`ExportDialog.tsx` | 导出快照、格式、范围及凭证开关 | 导出数量与输出一致，保留身份/区域/注册到期时间，全部格式遵守凭证开关 |
| `src/renderer/src/store/accounts.ts`、`utils/accountImport.ts` | 串行导入和持久化 | 已消费凭证只重试保存，不再次兑换，失败计数准确 |
| `src/main/loginSessions.ts`、`src/renderer/src/lib/loginPolling.ts` | 门户、旧兼容登录和串行查询 | state/PKCE、真实提供商、超时、取消、重复及迟到回调 |
| `src/main/authRefresh.ts`、`src/main/index.ts` | 单凭证刷新协调、轮换代际及保存 | 同凭证单次在途，旧响应不能覆盖新凭证，客户端登记到期检查 |
| `src/main/proxy/kiroRuntime.ts`、`kiroApi.ts`、`proxyServer.ts` | 当前 Runtime 请求及流适配 | 实际协议、区域、CRC、截断、超时、取消、终结回调和不重放边界 |
| `src/main/kiroInstances.ts`、`ipc/kiroInstances.ts`、`src/shared/kiroInstances.ts` | Windows 身份与安装验证、实例配置和启动请求 | 只允许独立普通用户，固定脚本与参数，无密码持久化或全局缓存回退 |
| `src/renderer/src/components/kiro/KiroInstancesPanel.tsx` | 独立多开页面 | 只使用五个窄 IPC，不挂载会查询当前账户的旧 Kiro 设置页 |
| `src/main/appUpdater.ts`、`UpdateDialog.tsx` | 正式版本检查和用户确认更新 | 稳定渠道、下载校验、保存 ACK、安装失败不退出 |

针对性回归可在应用根运行；例如只检查隔离启动逻辑：

```powershell
node --disable-warning=ExperimentalWarning --import ./test/unit/register-ts-resolve.mjs --test test/unit/kiroInstances.test.ts
```

`accountExport.test.mjs`、`exportFile.test.mjs` 覆盖导出及写入错误；`portalLogin.test.ts`、`loginDialog.test.mjs` 覆盖门户及资料查询/保存重试；`authRefresh.test.ts`、`credentialGeneration.test.mjs` 覆盖轮换与保存竞争；`kiroRuntime.test.mjs`、`kiroApiRuntime.test.mjs`、`runtimeRetryBoundary.test.mjs` 覆盖流及真实调用入口。使用 Node 原生类型擦除，新增 `.ts` 测试模块避免参数属性或 enum 等需要转换的语法。

## 3. 验证 JSON 导出与导入往返

在“账户管理”或“设置 → 数据管理 → 导出”进入同一对话框。账户管理入口传入选中集合及数量，设置入口默认全量；对话框用同一校验快照生成显示数量、文件与剪贴板内容。空选择、失效 ID、缺失分组/标签或不能序列化时整批阻止输出，不静默回退成全量。

| 输出 | 内容与用途 | 凭证规则 |
| --- | --- | --- |
| 完整备份 JSON | `format=kiro-account-backup`、`schemaVersion=1`、版本、账户、分组和标签 | 默认不含凭证，只恢复元数据；包含凭证需明确选择 |
| 精简凭证 JSON | provider、authMethod、region，按模式保留必要刷新字段与客户端注册到期时间 | 含凭证模式可走 OIDC 批量导入；无凭证模式只是摘要 |
| TXT、CSV、剪贴板 | 账户列表或有限凭证字段 | 统一遵守开关；跨提供商、区域迁移优先 JSON |
| 卡密 | 兼容凭证行 | 必须明确包含凭证，不提供伪装为无凭证的卡密输出 |

无凭证模式递归移除已知 Token、密码、clientSecret、授权码、设备码及旧授权字段，移除可能含服务响应的 lastError，状态置为 `unknown`。它保留邮箱、身份及分组标签，不是匿名化。迁移登录信息时需要明确启用含凭证导出；文件为明文，凭证有效性仍由上游服务决定。

`clientSecretExpiresAt` 是 **Unix 秒**，与账户 access token 的毫秒 `expiresAt` 不同。新门户登录、完整备份及精简凭证 JSON 应保留这个区别，不能误乘或遗漏。选中范围只带所需关系，全量范围保留未使用的分组标签。

文件 IPC 在保存完成后返回成功，取消返回 false，写入失败抛固定脱敏错误供 UI 展示；三者不能混用。回归应断言失败时无成功提示、输出内容未被替换，且错误不含原始凭证。

## 4. 修改当前门户登录和刷新

所有请求变更先核对[官方 1.4.5 发行包证据](evidence/2026-10-20-current-kiro-requests.md)。网页“最新”文字、搜索缓存和旧源码不能替代固定版本、摘要与真实调用链。只读公开包分析也不能替代真实测试账户验收。

默认入口为“打开 Kiro 网页登录”：门户返回的实际提供商决定 Social 或 IdC 链路，使用每次会话的 state/PKCE 和本地 HTTP 回调。Social 的交换 redirect 包含实际回调路径及 login_option；Builder ID/组织登录继续进行已取证的 IdC 授权码交换。回调参数不可信，必须校验提供商、issuer、区域、会话归属和期限，不能把凭证 POST 到任意回调给出的主机。

旧 Builder 设备流、Social 私有协议和 IAM SSO 入口保留为显式兼容方式。设备轮询继续遵守 interval、slow_down 和单个在途请求；旧 Social 仍可能依赖系统 `kiro://`。不要为兼容测试在生产会话注册或抢占协议。

门户结果在主进程保存一次性凭证，轮询交接后查询账户资料。资料请求失败保留验证重试入口，不能再次消费授权码或刷新已拿到的 Token；保存失败只重试保存，不能重复添加。取消、关闭或新会话启动后，旧请求不得写入新会话。

刷新服务合并同凭证并发并跟踪轮换代际，在短期缓存中把迟到旧凭证映射到当前结果；缓存有数量和时间上限，不持久化。写入前检查已有凭证代际，避免迟到结果覆盖更新数据。验证 accessToken、expiresIn 和可选 refreshToken；上游没有返回新 refreshToken 时保留当前值。IdC 注册在到期前十五分钟即要求重新授权，不通过反复刷新旧 client secret 解决注册过期。

刷新 POST 不自动重试，因为网络断开时服务端可能已经轮换凭证。超时、连接、授权失效和非法响应返回受控错误，不输出原始服务 body、URL、邮箱、授权码、verifier 或凭证。

## 5. 修改 AI Runtime 请求与流

当前主请求使用区域化 Kiro Runtime 的实际 **awsJson1_0** serializer：POST 服务根路径，`Content-Type: application/x-amz-json-1.0`，`x-amz-target: KiroRuntimeService.GenerateAssistantResponse`。不能只读取 schema 的 REST HTTP trait 就替换成另一条 path，或沿用旧 AmazonQ target。

区域来自受控配置、所选 profile/账户 identity；遵循当前官方 provider 默认 profile，不能统一删除固定值，也不能猜测 Enterprise ARN。认证按真实类型设置 Bearer 及适用的 TokenType，不把未知类型猜成 Social。payload、真实 profile 与用户选择需分别校验；只提交当前模型支持的字段，不把旧 inferenceConfig 随意迁移到新结构。

AWS event stream 校验 prelude/message CRC、长度、UTF-8、JSON 和事件类型；处理分包、截断、错误事件、工具/推理事件及用量。默认首包超时三十秒，流空闲超时六十秒；取消时停止读取和回调，完成与错误最多终结一次。服务节流提示可记录为受控重试信息，但消费型请求不自动跨端点、账户或签名重放，尤其不能在已经输出文字或工具结果后重放。

官方还有 featureConfiguration 控制的 `/v1/responses` SSE 链路，本轮未启用，不能假定所有账户已切换。模型管理、订阅及其他 management 请求也未在本轮全面迁移；主流协议适配不等于所有 API 都完成最新版本验收。

## 6. 配置和验收 Kiro 客户端隔离多开

进入独立的“Kiro 隔离多开”页面。该页面不挂载旧 Kiro 设置页，不为显示实例而查询当前账户模型或写入全局配置。

1. 用户在 Windows“设置 → 账户 → 其他用户”创建普通本地用户，并登录一次初始化用户配置目录。
2. 在该用户下安装官方 Kiro，每个实例使用分别授权的账户。不要把同一份生产 refreshToken 复制给多个实例。
3. 回到管理器，选择已初始化的用户和其配置目录内的 Kiro.exe；当前管理器必须有读取安装文件和验证签名的权限。权限不足时拒绝启动，不自动改 ACL 或提权。
4. 点击“启动 Kiro”，在系统 runas 窗口输入目标用户密码；不使用 PIN，不保存密码。完成或取消该窗口前，同一实例不得再次启动。

控制器拒绝当前 SID、系统/禁用/管理员账户、重复 SID、重叠配置目录和链接跳转。目标 EXE 必须具有有效官方签名与 Kiro 产品身份；签名证据和目标文件的运行时检查是两回事。启动助手再次验证身份和文件，使用固定 `runas /profile` 参数、目标配置目录作为工作目录；不使用 `/env` 或 `/savecred`，不继承管理器的 HOME/APPDATA 覆盖。验证后的 EXE 在系统授权期间保持只读句柄，降低被替换的风险。

状态“启动请求已提交”不代表 IDE 存活检测。移除配置只改管理器配置，不结束进程、不删除 Windows 用户和文件。机器级网络、代理、证书和策略仍共享；这是用户配置与凭证环境分离，不是虚拟机沙箱，也不隔离当前账户管理器与旧版本。

本机普通账户枚举、目录读取、签名验证、Secondary Logon 服务、系统密码窗口及实际 GUI 尚需独立环境验收。离线测试通过注入身份、文件验证和启动请求适配器检查边界，不执行 runas、创建用户或启动 Kiro。

## 7. 构建与发布候选版

应用 package.json、lockfile 与发布说明版本必须一致。所有 npm 命令在应用根执行；源码改动后先编译，再打包：

```powershell
npm ci
npm run test:unit
npm run build
npm run package:win
npm run verify:package
npm run release:checksums
npm run release:checksums -- --verify
npm run release:stage
node scripts/release-version.mjs
```

`package:win` 不编译、不启动、不安装。静态包检查涵盖 ASAR 文件范围、入口、原生依赖、TLS DLL、许可证、Windows x64、版本与更新仓库；正式版另检查更新清单绑定实际安装器。不能将打包通过写成安装、真实授权或升级回退通过。

| 渠道 | 公开附件 | 发布规则 |
| --- | --- | --- |
| 本轮 `1.7.7-rc.1` | 对应 EXE、Windows ZIP、SHA256SUMS.txt | GitHub prerelease，不设 latest，不公开稳定 latest.yml/blockmap，不推送给稳定用户 |
| 正式版，如 `1.7.6` | EXE、Windows ZIP、同安装器 blockmap、latest.yml、SHA256SUMS.txt | 非 prerelease，完整校验后设 latest，允许稳定客户端检查 |

发布使用 [.github/workflows/build.yml](../.github/workflows/build.yml)，由标签或手动触发。流程在干净环境安装、测试、编译、打包、检查内容和摘要，再收集精确附件；发布任务复核下载摘要，拒绝已有标签指向其他提交，先上传完整 draft 再公开。发布后核对标签提交、渠道标记、附件名/大小/摘要和 stable latest，不能因本地存在 EXE 就宣布 GitHub 发布完成。

下载候选版后，可在附件所在目录核对：

```powershell
Get-FileHash -LiteralPath ./kiro-account-manager-1.7.7-rc.1-x64-setup.exe -Algorithm SHA256
Get-FileHash -LiteralPath ./kiro-account-manager-1.7.7-rc.1-x64-windows.zip -Algorithm SHA256
```

将值与同一 Release 的 SHA256SUMS.txt 比较。账户管理器未配置代码签名，不宣称已签名；被选择启动的官方 Kiro 必须通过其自身签名检查。安装器的应用身份、默认数据和协议仍与历史管理器相关，不因 RC、不同目录或 ZIP 获得并存隔离。

稳定更新由 `appUpdater.ts` 管理，默认启动及每六小时检查，用户确认下载、保存成功后再确认安装。候选版不会成为稳定更新目标；原上游 1.7.5 也不会自动改为本仓库更新源。需要迁移时先保留完整备份，不在生产环境验证升级。

## 8. 证据、问题与验收记录

| 证据 | 已确认的发现 | 实现或后续路径 |
| --- | --- | --- |
| [官方当前请求证据](evidence/2026-10-20-current-kiro-requests.md) | 门户、IdC PKCE、Runtime 实际 serializer 和用户级认证缓存 | loginSessions、authRefresh、kiroRuntime；真实授权与服务配置另行验收 |
| 导出与文件回归 | 旧隐私开关、格式识别、计数和写入反馈存在缺陷 | accountExport、ExportDialog、文件 IPC；完整/精简往返及失败用合成数据验证 |
| 实例回归及固定脚本语法解析 | 同用户路径不能隔离认证，SID/目录/启动状态需要验证 | kiroInstances 和独立页面；跨用户 GUI、权限及系统服务另行验收 |
| 刷新、轮换与 Runtime 调用入口回归 | 并发刷新、迟到覆盖和流消费后重放需要控制 | 共享刷新协调、保存代际检查、严格流解析和禁止盲重放 |
| 官方客户端最小对话检查（2026-10-20） | 在已登录官方 Kiro 的新会话发送固定、无需文件或工具操作的提示，收到 `KIRO_REQUEST_OK`；界面显示耗时 15 秒、模型选择为 Claude Opus 5.5，未显示工具调用 | 证明官方客户端现有登录态下的一条真实 AI 请求成功；不证明候选版 Runtime 适配、门户授权、扫码或跨用户 GUI 通过 |
| [候选 Runtime 接口检查](evidence/2026-10-20-live-interface-checks.md) | 真实请求发现并修复误删官方默认 profile 的问题；修后 HTTP 200，事件流 CRC 与预期标记通过，功能配置读取 HTTP 200 | 仅当前 Social 会话的 JSON-RPC 主链路得到真实验收，未执行刷新或缓存写回 |

上述官方客户端检查没有读取、复制或输出凭证，不记录账户邮箱、工作区、用户名或其截图。候选版新增实现仍以 180 项离线回归为验证依据，不能将官方客户端的一次成功响应计作管理器适配通过。

后续实机验收至少记录独立环境的官方客户端版本、渠道与区域、门户往返、Builder/组织二阶段回调、资料及保存失败重试、多个独立用户并行启动、取消和关闭、AI 文本/工具/推理/用量、限流和断流，以及安装升级。暂不执行的扫码或真实授权不标为通过；即使用户同意测试，也不能复用生产凭证或修改运行中的旧版。

常见失败应先定位正确边界：无可选用户检查其是否为已初始化普通本地账户；签名/目录失败检查权限和独立安装；runas 失败检查密码及 Secondary Logon 服务；JSON 缺凭证检查是否选择了默认元数据导出；Runtime 失败先看受控错误类别，不通过强行切区域或重复消费掩盖问题。

公开记录仅使用仓库相对路径及 `%APPDATA%`、`%USERPROFILE%` 等通用形式，不写本机目录、私人用户名、真实邮箱、凭证或进程 ID。历史提交未改写；当前内容清理不等于历史内容不可检索。上游来源及 AGPL 义务继续保留在 [NOTICE](NOTICE.md) 和 [LICENSE](../LICENSE) 中。
