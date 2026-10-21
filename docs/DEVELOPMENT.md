# 开发与发布指南

本指南适用于 `rw0104/kiroaccout`。当前源码目标为 **1.8.0 · Windows x64**，发布状态以 Releases 为准。本版将多开改为同一 Windows 用户、共用一份官方 Kiro.exe、选择管理器已有账户启动独立配置实例，补充状态、正常停止、重启和恢复识别。真实双空白实例、账户绑定回归与包内容结果分别记录；不预先宣称双真实账户登录及刷新已验收。

先读[项目规则](../AGENTS.md)、[隔离执行规范](development-rules.md)及[1.8.0 多开需求](requirements/2026-10-20-single-client-instances-1-8.md)。**账户管理器自身没有经过验证的运行时隔离模式。不同源码、安装目录、ZIP 或单个 user-data 参数均不隔离管理器与生产资料。** Kiro 客户端的受管实例是另一个功能；只在核实完整启动环境、目录和进程边界后，对空白受管实例执行已授权的实机验收，不运行开发管理器去访问生产资料。

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

1.7.7-rc.1 的历史记录为 **180/180 项离线回归通过**，不能将该数量当作本次 1.8.0 的结果。1.8.0 的当前回归、类型检查、编译、包内容和发布结果以对应构建日志及实机验收记录为准。1.7.6 的 105 项及更早的 85 项同样属于各自版本，详见[历史实施记录](2026-10-19-account-import-login/05-implementation-status.md)。

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
| `src/main/kiroInstances.ts`、`kiroInstancePaths.ts`、`kiroInstanceWindows.ts`、`ipc/kiroInstances.ts` | 同用户多配置目录、可信安装、进程归属及生命周期 | 空账户初始化、固定参数和环境、标记与 reparse 检查、正常关闭、恢复识别及不误操作生产进程 |
| `src/main/kiroInstanceAccounts.ts`、`kiroInstanceOwnership.ts` | 所选账户的专用缓存、刷新凭证同步与持久绑定归属 | 只写绑定实例、身份校验、保留较新轮换、拒绝重复消费凭证、旧渲染快照不能覆盖新凭证 |
| `src/shared/kiroInstances.ts`、`src/renderer/src/components/kiro/KiroInstancesPanel.tsx` | 窄 API 与独立多开页面 | 状态约三秒刷新，启动/停止/重启与失败明确反馈，不挂载旧 Kiro 设置页 |
| `src/main/appUpdater.ts`、`UpdateDialog.tsx` | 正式版本检查和用户确认更新 | 稳定渠道、下载校验、保存 ACK、安装失败不退出 |

针对性回归可在应用根运行；例如只检查隔离启动逻辑：

```powershell
node --disable-warning=ExperimentalWarning --import ./test/unit/register-ts-resolve.mjs --test test/unit/kiroInstances.test.ts
```

`kiroInstances.test.ts` 与 `kiroInstanceWindows.test.ts` 分别覆盖控制器和 Windows 适配器；`kiroInstanceAccounts.test.ts`、`kiroInstanceOwnership.test.ts` 覆盖选定账户的缓存写入、轮换验证、持久归属及保存合并。不能以合成凭证回归代替双真实账户登录、刷新验收。`accountExport.test.mjs`、`exportFile.test.mjs` 覆盖导出及写入错误；`portalLogin.test.ts`、`loginDialog.test.mjs` 覆盖门户及资料查询/保存重试；`authRefresh.test.ts`、`credentialGeneration.test.mjs` 覆盖轮换与保存竞争；`kiroRuntime.test.mjs`、`kiroApiRuntime.test.mjs`、`runtimeRetryBoundary.test.mjs` 覆盖流及真实调用入口。Node 原生类型擦除不支持参数属性或 enum 等需要转换的语法。

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

Google/GitHub 快捷入口也走门户 PKCE，并在主进程和界面核对期望提供商与实际结果，不再调用 renderer 的旧 Social 私有协议交接。旧 Builder 设备流与 IAM SSO loopback 入口保留为显式兼容方式。设备轮询继续遵守 interval、slow_down 和单个在途请求。管理器启动、退出及安装不再声明或注销官方 `kiro://`；不要为兼容测试抢占该协议。

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

1. 选择一份现有官方 Kiro.exe，为实例取名，选择管理器内已有账户并创建。多个实例选择同一程序、各自选择不同账户，无需多个安装或 Windows 用户。
2. 新实例生成独立根，默认位于 `%APPDATA%\kiro-account-manager\kiro-instances-v2\<UUID>`。初始化凭证只来自所选管理账户，启动前只读比较默认 IDE 缓存，发现相同 access/refresh token 即拒绝，不复制或改写默认缓存、设置或扩展；正常使用无需再次登录。
3. 过期 access token 与刷新凭证可交给官方实例自行续期，管理器不为启动提前刷新。IdC 账户还需有效客户端登记及真实到期时间，不能虚构期限；刷新凭证或登记失效需重新授权。高级空白实例供独立启动或另行授权；它不代替已有账户绑定流程的验收。
4. 页面观察状态，可正常停止或重启指定实例。遇保存提示先在对应窗口处理；等待超时不会自动强杀，也不会在旧进程仍存时重新启动。移除绑定前先停止并同步最新凭证；移除只删除配置，保留实例文件。

绑定持久记录 accountId，实例停止后仍保留刷新归属，直到安全移除。管理器按账户 ID 及凭证识别归属，拒绝对绑定账户手动/后台刷新、切号或重复绑定，并保留管理器中已同步的较新凭证，防止旧渲染快照覆盖。实例轮换回写须证明仍是同一账户；IDE 中改登其他账户不能覆盖原账户。旧管理器和外部客户端不受该锁约束，不要让它们并行刷新同一账户。

默认创建需明确选择账户，高级空白实例位于单独选项。缓存缺失、过期或账户变化导致正常同步失败时，页面提供“恢复解绑”及二次确认：`detach(id)` 只处理已确认停止的绑定实例，要求 `markAccountReauthorizationRequired(record)` 先持久标记原账户需重新授权，再复核进程和路径后移除配置。它不调用凭证准备/同步，不删除任何文件；标记失败或进程仍存时保留绑定。主进程每三十秒通过 `synchronize(id)` 同步，复用生命周期操作锁，不能直接并行调用账户同步模块；此入口不暴露给 renderer。正常启动需要准备与同步两个依赖，正常停止/移除缺同步依赖时拒绝操作。

无 JWT subject 可比对的刷新轮换须补充身份凭据：采用最新客户端 ControlPlane 的只读 `GetUsageLimits`，只提交该实例 access token，核对返回 userId 与原绑定账户一致，不发送 refresh token 或执行刷新。验证失败、token 在验证期间变化或返回不同身份时不回写；已过期且无法验证的缓存可走上述显式恢复解绑。当前请求依据见[1.4.13 多开证据](evidence/2026-10-20-kiro-instance-lifecycle.md#6-绑定账户的只读身份核验补充)。

目录覆盖包含 user data、home、extensions、shared data、Agent plugins、agents user data、agents extensions、AppData/LocalAppData 和 temp。主进程固定生成参数，并移除继承的 KIRO_API_KEY、AWS 凭证、VS Code/Electron 路径覆盖等；父进程环境不变。创建和后续操作均校验 UUID、标记、目录祖先及 reparse point，防止链接指向其他数据。共享 EXE 的受管实例禁用自动更新，避免一个实例修改其他实例使用的程序。

安装检查验证 PE、产品名、有效官方数字签名与发行类型。官方 Windows User 安装会删除强制设置的 VSCODE_PORTABLE，不能靠它伪造 Portable。只有检查为支持 Portable 的分发才配置专用 Portable 根，并与 user-data 路径一致；User 安装使用独立目录参数。非 Portable 官方 GUI 可能重复写入 kiro://，因此启动前先检查现有处理命令是否指向同一个 EXE，不匹配即拒绝，不自动改归属。外部 kiro:// 仍路由默认配置；门户使用各实例拥有的本地 HTTP 回调。

运行状态不能只看 spawn PID 或 code.lock。控制器核对 Windows SID、规范 EXE、唯一且精确的 user-data 参数、PID 和创建时间，识别主进程与其后代，并在管理器重启后重建归属。查询不完整、重复主进程、PID 复用或孤立子进程无法确认时进入 `unverified`，阻止停止、重启和重复启动。原因不明的消失显示退出，不谎报崩溃；恢复采用用户明确发起的重新启动。

停止由固定 Windows helper 持有并核验同一进程句柄，再发送正常窗口关闭请求，不按名称批量终止，不以单个 PID 强杀。运行中或归属未知时拒绝移除；绑定账户还须安全同步凭证。旧 RC 的 Windows 用户配置只显示停用状态，允许移除配置后重建，不自动执行或删除原用户资料。

同一 Windows 身份、DPAPI、系统网络、代理、证书和机器级策略仍共享，这不是安全沙箱。官方 Kiro 1.4.5 的两个空白实例已完成同 SID/EXE 并行、停止/重启 A 保持 B 完整进程身份、重建控制器恢复识别及最终正常停止的实机检查，详见[本轮实机记录](requirements/2026-10-20-single-client-instances-1-8.md#本轮实机记录)。1.4.13 的启动与存储依据仍为[静态证据](evidence/2026-10-20-kiro-instance-lifecycle.md)。该结果不等于双真实账户刷新或回调已验收；未执行的双账户登录、刷新和扫码不得写成通过。

## 7. 构建与发布正式 1.8.0

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
| 正式 `1.8.0` | EXE、Windows ZIP、同安装器 blockmap、latest.yml、SHA256SUMS.txt | 非 prerelease，完整校验后设 latest，允许稳定客户端检查 |
| 历史 `1.7.7-rc.1` | 对应 EXE、Windows ZIP、SHA256SUMS.txt | GitHub prerelease，不设 latest，不公开稳定 latest.yml/blockmap |

发布使用 [.github/workflows/build.yml](../.github/workflows/build.yml)，由标签或手动触发。流程在干净环境安装、测试、编译、打包、检查内容和摘要，再收集精确附件；发布任务复核下载摘要，拒绝已有标签指向其他提交，先上传完整 draft 再公开。发布后核对标签提交、渠道标记、附件名/大小/摘要和 stable latest，不能因本地存在 EXE 就宣布 GitHub 发布完成。

下载后，可在附件所在目录核对：

```powershell
Get-FileHash -LiteralPath ./kiro-account-manager-1.8.0-x64-setup.exe -Algorithm SHA256
Get-FileHash -LiteralPath ./kiro-account-manager-1.8.0-x64-windows.zip -Algorithm SHA256
```

将值与同一 Release 的 SHA256SUMS.txt 比较。账户管理器未配置代码签名，不宣称已签名；被选择启动的官方 Kiro 必须通过其自身签名检查。1.8.0 安装器不再声明 kiro 协议，但管理器应用身份及默认数据仍与历史版本共用，不因不同目录或 ZIP 获得并存隔离。

稳定更新由 `appUpdater.ts` 管理，默认启动及每六小时检查，用户确认下载、保存成功后再确认安装。1.8.0 仅在完整公开发布后进入稳定更新；原上游 1.7.5 不会自动改为本仓库更新源。迁移前先保留完整备份，开发期间不运行安装器覆盖现有版本。

## 8. 证据、问题与验收记录

| 证据 | 已确认的发现 | 实现或后续路径 |
| --- | --- | --- |
| [官方当前请求证据](evidence/2026-10-20-current-kiro-requests.md) | 门户、IdC PKCE、Runtime 实际 serializer 和用户级认证缓存 | loginSessions、authRefresh、kiroRuntime；真实授权与服务配置另行验收 |
| 导出与文件回归 | 旧隐私开关、格式识别、计数和写入反馈存在缺陷 | accountExport、ExportDialog、文件 IPC；完整/精简往返及失败用合成数据验证 |
| [当前多开证据](evidence/2026-10-20-kiro-instance-lifecycle.md)、实例回归及 Windows helper 检查 | 完整 home/配置覆盖、独立锁和复合进程身份是同用户多开的必要条件 | kiroInstances、kiroInstancePaths、kiroInstanceWindows 和独立页面；真实双实例、账户刷新和回调分别验收 |
| 刷新、轮换与 Runtime 调用入口回归 | 并发刷新、迟到覆盖和流消费后重放需要控制 | 共享刷新协调、保存代际检查、严格流解析和禁止盲重放 |
| 官方客户端最小对话检查（2026-10-20） | 在已登录官方 Kiro 的新会话发送固定、无需文件或工具操作的提示，收到 `KIRO_REQUEST_OK`；界面显示耗时 15 秒、模型选择为 Claude Opus 5.5，未显示工具调用 | 证明官方客户端现有登录态下的一条真实 AI 请求成功；不证明候选版 Runtime 适配、门户授权、扫码或跨用户 GUI 通过 |
| [候选 Runtime 接口检查](evidence/2026-10-20-live-interface-checks.md) | 真实请求发现并修复误删官方默认 profile 的问题；修后 HTTP 200，事件流 CRC 与预期标记通过，功能配置读取 HTTP 200 | 仅当前 Social 会话的 JSON-RPC 主链路得到真实验收，未执行刷新或缓存写回 |

官方客户端 UI 检查和新 Runtime 接口探针是两条记录；前者不读取、复制或输出凭证，后者经用户授权仅在内存使用当前 access token，未刷新或写回。公开记录不包含凭证、邮箱、工作区、用户名或其截图。旧版 180 项离线回归与局部真实接口结果不能替代 1.8.0 的多开验收。

实机验收应分别记录：同一官方 EXE 的两个空配置并行启动、目录与设置分离、真实进程恢复识别、停止 A 不影响 B/默认 IDE、关闭等待、退出恢复；再独立记录两个已有账户的选择与直接启动、渠道/区域、缓存归属及真实轮换。门户往返、Builder/组织二阶段回调、资料和保存重试，以及 AI 文本/工具/推理/用量按各自链路验收；安装升级另列。暂不执行的扫码或双账户登录不标为通过。测试使用独立授权的账户，不复制生产账户库作为开发种子。

常见失败应先定位正确边界：签名或目录失败检查官方安装完整性、权限和链接跳转；协议归属不符不能静默接管；状态无法确认检查完整进程元数据和实例参数，不通过忽略身份校验绕过；关闭超时先处理 Kiro 保存窗口。JSON 缺凭证检查是否选择了默认元数据导出；Runtime 失败先看受控错误类别，不通过强行切区域或重复消费掩盖问题。

公开记录仅使用仓库相对路径及 `%APPDATA%`、`%USERPROFILE%` 等通用形式，不写本机目录、私人用户名、真实邮箱、凭证或进程 ID。历史提交未改写；当前内容清理不等于历史内容不可检索。上游来源及 AGPL 义务继续保留在 [NOTICE](NOTICE.md) 和 [LICENSE](../LICENSE) 中。
