# Kiro 单程序、多配置实例的当前客户端证据

核查日期：2026-10-20（America/Los_Angeles）；Windows 样本下载及静态核查在 2026-10-21 02:30–02:45 UTC 完成。本报告仅分析公开发行包与官方文档，没有执行安装器、启动样本、读取现有账户缓存或发出账户请求。

目标是同一个 Windows 用户使用同一份官方 Kiro 程序启动多个专用配置实例。文件分离、进程管理和账户登录是不同验收项；环境变量覆盖不是 Windows 用户身份切换，也不是安全沙箱。

## 1. 样本与可复核来源

| 证据 | 官方来源或固定样本 | 本次结果 |
| --- | --- | --- |
| E-01 | [Windows x64 user stable 元数据](https://prod.download.desktop.kiro.dev/stable/metadata-win32-x64-user-stable.json) | `currentRelease=1.4.13`，发行日期字段 `2026-10-21`，URL 指向下述 Windows 安装器。 |
| E-02 | [Windows 1.4.13 官方安装器](https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.4.13/kiro-ide-1.4.13-stable-win32-x64.exe) | 219249816 字节，SHA-256 为 `720729c672701d590d6abdb8ffeee00d44d8c495ff43c449b2a22a2083604c61`。Authenticode 为 `Valid`，发布者 Amazon.com, Inc.、组织单元 AWS Kiro。 |
| E-03 | 安装器内 `resources/app/product.json` | Kiro `1.4.13`；commit `cff967c745e7c31a70be5d4d1d406cd063f641b2`；构建时间 `2026-10-21T00:04:08Z`；`target=user`。内置 Kiro Agent `1.1.530`。 |
| E-04 | [Linux x64 stable 元数据](https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json) | 查询时仍为 `1.4.5`。不能把已有 Linux 1.4.5 静态分析当作 Windows 1.4.13 的新证据。 |
| E-05 | [官网下载页](https://kiro.dev/downloads/) | Windows 下载入口指向 user stable 元数据。本次没有取得经过官方入口证实的 Windows Kiro ZIP 发行包。 |
| E-06 | [Node.js os.homedir](https://nodejs.org/api/os.html#oshomedir)、[libuv Windows 实现](https://github.com/libuv/libuv/blob/v1.x/src/win/util.c) | Windows 优先读取进程环境中的 `USERPROFILE`，缺失时才读取实际登录用户的配置目录。 |
| E-07 | [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | Windows 使用 DPAPI；相同登录用户下的其他进程不因此被隔绝。 |
| E-08 | [VS Code Portable mode](https://code.visualstudio.com/docs/setup/portable)、[命令行说明](https://code.visualstudio.com/docs/configure/command-line) | 上游明确区分独立 user data 与 Portable。Windows User/System 安装版本不支持 Portable；该上游说明不能代替 Kiro ZIP 的发行证据。 |

使用 Inno 解包工具读取安装器数据，不运行安装器或提取出的 Kiro 程序。下载及解包结果仅保存在 Git 忽略的 `.local/evidence/kiro-instance-lifecycle/`。公共报告不提交第三方发行包及完整打包代码。

固定文本摘要如下；后续偏移均指 UTF-8 解码后的零起点字符位置，不能跨版本复用。

| 包内相对路径 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `resources/app/product.json` | 12655 | `d54b82785d0d00089b9a2bee1bbf16db70c14737602d0383f715fdbb23e417d4` |
| `resources/app/out/cli.js` | 256671 | `d0ffa851037877d0353ab7719dea46968941b81abf09b867f7bd466a72251501` |
| `resources/app/out/main.js` | 1478419 | `3228e7092c70ace69e4999ae9b2f97804a8b4bcc31a638ed1ac85ffb6f0bad0c` |
| `resources/app/extensions/kiro.kiro-agent/dist/extension.js` | 15376074 | `fcc87eecc3ec6c71e92086f9bf9d66665303442b1f50a501781a26bc92fbb221` |
| `resources/app/out/vs/workbench/workbench.desktop.main.js` | 19053851 | `b9bd30dd0a2fc2b991544cdad8ac9d0b8708d051882cff2216d81a82bbf57154` |

Windows 元数据本次原始 JSON 的 SHA-256 为 `463973bd25435a91c7f84d425fabd81132f7d672a7441436f6c35555cc92d322`。元数据会继续变化，版本与摘要固定本次观察，不能表示以后仍为最新。

## 2. 启动参数、目录优先级与实例锁

E-03 的 `cli.js` 参数声明确认下列准确名称。参数被解析不等于所有参数均由普通 IDE 窗口消费；实现必须验证实际生成文件。

| 参数 | 证据位置 | 含义与实施注意 |
| --- | ---: | --- |
| `--user-data-dir` | 193863 | IDE 用户设置、状态和窗口数据。 |
| `--extensions-dir` | 194080 | 用户扩展目录；内置 Agent 仍由同一安装提供。 |
| `--shared-data-dir` | 194273 | 应用间共享目录，默认独立于 user data，必须单独指定。 |
| `--agent-plugins-dir` | 194375 | Agent 插件目录。 |
| `--agents-user-data-dir` | 194411 附近 | 名称为复数 `agents`；不存在 `--agent-data-dir`。 |
| `--agents-extensions-dir` | 194450 附近 | 名称为复数 `agents`；不存在 `--agent-extensions-dir`。 |
| `--new-window` | 191483、普通根选项内另有声明 | 新窗口请求；仅此参数不保证独立父进程、设置或凭证。 |
| `--disable-updates` | 197974 | `main.js` 980196 的更新初始化检查会停用更新服务，适合共享一个可执行程序的受管实例。 |

`main.js` 25862 的 user data 选择顺序是：有效 `VSCODE_PORTABLE` 下的 `user-data`，然后 `VSCODE_APPDATA`，然后 `--user-data-dir`，最后系统默认目录。`extensionsPath`（391457 附近）和 Agent 插件路径（443014 附近）也有环境覆盖。启动器必须清除无关的继承覆盖，不能只拼接几个参数。

`main.js` 396152 的主 IPC 使用 user data 路径计算标识。实际命名算法（248107）以该路径 SHA-256 的前 8 个十六进制字符加版本和通道名构造 Windows 命名管道；`code.lock` 位于该 user data 下。普通启动在取得实例管道后才写主进程 PID 到 `code.lock`（约 1431177），正常退出时删除。

因此两个不同的、规范化后互不重叠的 user data 有独立主进程的机制。`code.lock` 只是恢复定位线索，文件存在或其中存在一个 PID 均不能单独证明实例正在运行。必须同时匹配当前进程的可执行路径、完整实例参数、PID 和创建时间，避免误认其他进程或 PID 重用。

## 3. 账户缓存和 secret storage

E-03 的当前 Agent 有两条直接使用 `os.homedir()` 的账户目录：

| 调用点 | `extension.js` 偏移 | 实际路径来源 |
| --- | ---: | --- |
| `TokenStorage` | 11418163 | home + `.aws/sso/cache/kiro-auth-token.json`；构造时监听此文件。 |
| `ClientRegistrationStorage` | 11332840 | home + `.aws/sso/cache/<登记散列>.json`。 |
| `ProfileStorage` | 11420762 | 扩展 context 的 `globalStorageUri/profile.json`，随 IDE user data 分开。 |
| Agent 配置根 | 10409319 | `KIRO_HOME` 或 home 的默认配置根；没有覆盖上面两条认证缓存构造。 |

E-06 支持对子进程设置独立、非空的 `USERPROFILE`，使这两条明确的 home 调用落到专用目录；`HOME` 也应随实例保持一致。只设置 `KIRO_HOME`、`AWS_CONFIG_FILE` 或 `AWS_SHARED_CREDENTIALS_FILE` 不会重定向上述 Kiro TokenStorage。`main.js` 395454 也直接导入 Node 的 homedir 作为 IDE home，而不是在此处直接调用 Windows KnownFolder。

`KIRO_API_KEY` 的环境读取位于 `extension.js` 11414820；若照抄管理器环境，新空配置仍可能取得继承的账户身份。启动器应移除继承的 API key、AWS 凭证和其他认证覆盖。不得复制现有用户的 Token 文件作为默认初始化。

当前 Kiro 主 Token 不是通过所观察到的 VS Code secret storage 读取，而是上述 home 文件。其他扩展仍可能使用 secret storage：

- `main.js` 730095 通过 Electron `safeStorage` 加密字符串。
- Workbench 的 `secret://` 服务位于 3875451 附近。一般秘密写 application scope（`-1`）；Windows 内置 GitHub authentication 的 `github.auth` 被明确列入共享 scope（`-2`，3876020–3876534）。
- Application storage 的数据库位于对应全局存储目录的 `state.vscdb`（`main.js` 436092）。Application shared storage 使用 `appSharedDataHome/sharedStorage`（446223）。因此仅 user data 分离，遗漏 shared data，仍不完整。
- 这里没有发现 Kiro TokenStorage 使用同名 Windows Credential Manager/keytar 条目的调用证据；不能把“未发现”扩大为所有第三方扩展和原生组件都不会访问系统凭据。

E-07 意味着同 SID 的 DPAPI 密钥仍共享。目录分离可避免正常操作互相覆盖，但不形成同一用户进程之间的恶意访问隔离；也不能借目录分离保证服务端同一 refreshToken 的并发轮换不会互相影响。

## 4. Windows 协议注册与 Portable 限制

这是同用户、多配置启动必须处理的共享边界。

`main.js` 1281846 的普通 GUI startup 调用 `setupProtocolUrlHandlers`，1283096 创建 `ElectronURLListener`。其构造函数在 1013520 附近，对 Windows 且非 portable 的情况直接调用 `setAsDefaultProtocolClient`，参数为产品 `kiro`、当前 EXE 和 `--open-url --`。这条 Windows 分支没有预先检查是否已经是默认处理程序。`--new-window`、`--reuse-window` 不绕过该调用；诊断命令不能当作启动新 GUI 的替代。

不能简单添加 `VSCODE_PORTABLE` 解决：本 Windows 包 `product.json` 有 `target=user`。`configurePortable`（1439225 附近）要求产品没有 target 字段且 portable 目录存在，否则删除这个变量；删除发生在主 user data 选择之前。E-08 的官方上游说明与此一致。

可实施保护应检查目标分发类型和现有协议归属：

1. 支持 portable 的已验证分发可使用存在且归属当前实例的 portable 根，并使其 `user-data` 与启动计划一致；不能修改官方 product 来伪造该分发。
2. User 安装版必须在启动前检查 `kiro://` 已指向同一 EXE 和相同官方命令形态，避免新的实例把协议从其他程序抢走。若不一致，应先向用户说明并处理迁移，不能静默覆盖。
3. 即使实际处理命令相同，官方程序仍可能重写相同注册表值；这是共享系统副作用，不能宣称没有执行协议注册。外部 `kiro://` 链接仍走默认配置实例，不能宣称按受管实例分派。
4. 当前门户采用实例自己的 HTTP 回调，但 TCP 监听端口仍在同一 Windows 网络命名空间。只有成功绑定的实例拥有端口，冲突必须继续选择其已支持端口或清楚失败；不能因目录分开就宣称回调完全隔离。

上述策略描述实现所需保护，并不是本静态核查已经执行的 GUI 验收。系统代理、证书、机器标识、注册表和服务端账户关系继续共享；不得为多开修改这些资源。

## 5. Evidence → Finding → Path

| 证据 | 发现 | 实施和验收路径 |
| --- | --- | --- |
| E-03 参数与主管道算法 | 独立 user data 可生成独立主进程标识；单独 new-window 不够。 | 一个可执行程序、两个专用根，核实不同主 PID、创建时间、完整参数、管道对应 lock。 |
| E-03 TokenStorage + E-06 | 认证根有明确的进程 home 来源。 | 子进程专用 USERPROFILE/HOME，空账户初始化；在专用根观察缓存路径，不读取生产缓存。 |
| E-03 application/shared storage + E-07 | user data、shared data、扩展秘密均需分开；同 SID 不提供安全沙箱。 | 两实例写入不同合成设置和状态，互相不可见；保留 DPAPI、协议和网络共享边界说明。 |
| E-03 target/portable/协议注册 + E-08 | User 安装版不支持靠环境变量强制 Portable。 | 不补丁官方客户端；启动前验证同 EXE 既有协议归属，不符合即阻止启动或由用户显式迁移。 |
| E-03 lock 写入和清理 | launcher 退出或一个残留 lock 均不足以判断 IDE 是否结束。 | 生命周期管理只操作本实例的进程身份；停止后再次核实，崩溃及管理器重启后由匹配的进程恢复状态。 |

实机结果必须另行记录：两个空配置同时启动、设置相互隔离、extension host home 对应、停止一个不影响另一个、管理器重启后恢复识别、异常退出后的状态，以及官方程序版本和系统共享边界。若没有两个独立授权的账户登录/刷新实测，不得把这些文件和进程测试写成双账户完整验收。

本报告覆盖多开启动、本地存储及下述绑定身份核验所需证据，没有重新验证 1.4.13 的全部登录、刷新和 AI wire 协议。

## 6. 绑定账户的只读身份核验补充

以下结论仍来自 E-03 的 Windows 1.4.13 / Agent 1.1.530 静态文本；`extension.js` 的 SHA-256 已再次核对为 `fcc87eecc3ec6c71e92086f9bf9d66665303442b1f50a501781a26bc92fbb221`。没有读取生产账户、执行提取代码或发出真实身份请求。这里确认客户端如何构造请求，不等于真实账户的在线验收已经通过。

### 6.1 当前可用链路与实际 wire

Agent 新 ControlPlane 的 `GetUsageLimits` 响应包含 `userInfo.userId`。身份核验可只提交当前实例的 access token 与已知 profile，不需要 refresh token、OIDC client secret 或重新授权。`userId` 必须由经过 TLS 的认证响应提供，并与绑定管理器账户的已知用户 ID 散列精确匹配；同 provider、相同 profile ARN 或响应中的邮箱均不能证明属于同一账户。

| 项目 | 当前官方构造 |
| --- | --- |
| operation | `GetUsageLimits`，目标服务 `KiroControlPlaneBearerService`。 |
| endpoint | `https://management.<region>.kiro.dev/`；新客户端优先使用显式 region override，否则从 profile ARN 解析区域、再取身份区域，最后默认为 `us-east-1`。绑定核验使用该账户的已知 profile 区域。 |
| method/path | **POST `/`**。不能把 schema 中的 `GET /Get-Usage-Limits` trait 当作当前新客户端的实际 wire。 |
| 必要认证 header | `Authorization: Bearer <accessToken>`；IdC 追加 `TokenType: SSO_OIDC`；Social 不根据 provider 自行制造 TokenType。 |
| 协议 header | `Content-Type: application/x-amz-json-1.0`；`x-amz-target: KiroControlPlaneBearerService.GetUsageLimits`。 |
| body | 新 Agent 调用点实际传入 `{origin, profileArn?}`；IDE 的 origin 映射为 `AI_EDITOR`。请求模型还声明 `resourceType`、`isEmailRequired`，本次最小核验不索取邮箱、不追加这些可选字段。 |
| response | JSON 的 `userInfo.userId`；`userInfo` 缺失、ID 为空或不是字符串时不能确认身份，返回受控失败。 |
| 副作用边界 | 只读使用量/身份查询；不发送 refresh token，不进行 refresh、重试、旧端点回退或认证 Cookie 拼接。查询失败不覆盖管理器凭证。 |

实际 method/header/body 来自完整序列化调用链，而非只看服务模型中的 HTTP trait。固定偏移和短片段如下；偏移口径与第 1 节一致。

| `extension.js` 零起点字符偏移 | 可复核片段/作用 |
| ---: | --- |
| 2960795 | `e.protocol.serializeRequest(...)`；schema-aware middleware 调用客户端选择的协议。 |
| 3007106 | `m3...serializeRequest` 最终令 `h.method="POST"`，初始 path 为 `/`，请求结构体交给 payload serializer。 |
| 3519254 | `zpi` 构造 `https://${e}.${r}.kiro.dev`；其后的 `M3` 选择 `management`。区域来源中的 `PSe` 位于 3436750 附近，优先解析 profile ARN。 |
| 3558850 | `lyu` 继承 `m3`，设置 JSON 1.0 content type 和 `x-amz-target`，而不是执行 REST 的 query/path 序列化。 |
| 3560538 | `uyu` 的 shape 为 `aws.protocols#awsJson1_0`。 |
| 3574078 | `protocol:e?.protocol??uyu`；默认 service target 为 `KiroControlPlaneBearerService`。 |
| 3570662 | `mSu` 请求模型的四个字段为 `profileArn`、`origin`、`resourceType`、`isEmailRequired`。 |
| 3570757、3572565 | `gSu` 响应含 `userInfo`；`qSu` 的字段为 `userId`、`email`。字段字符串映射分别见 3569242、3569252、3567357。 |
| 3573319 | `Bpi` 上虽然保留 `GET /Get-Usage-Limits` trait，但当前所选 AWS JSON 1.0 协议不会将其作为 REST 路由使用。 |
| 3529823 | bearer signer 直接写 `Authorization=Bearer token`。 |
| 1572042、3092331 | `IdC` 映射 `SSO_OIDC`，`Hb` 将其加入 `TokenType` header；Social 没有该映射。 |
| 5267712 | `fce("kiro-ide", ...)` 返回 `AI_EDITOR`。 |
| 10098500 附近 | `yGp` 经 `M3` 取得 management endpoint，以 `{token:u.accessToken}` 构造 `FK`，再调用 `GetUsageLimits`，输入只有 `origin` 和可选 profile；不会把 refresh token 传给该 client。 |
| 10661911 | `handleGetUsage` 以 `fce(clientInfo.name, ...)` 的 origin 调用上述新 Agent 链路。 |

注意，官方 host 的 `Xh`/`getToken` 在取得身份时可能触发其自身认证管理；管理器的身份核验不能照搬这一层。核验模块只使用调用者已经提供的实例 access token，绝不读取默认缓存、调用 getToken 或代替实例刷新。

### 6.2 与仓库旧查询函数的边界

同一个官方包还保留另一套 `CodeWhispererRuntimeClient.GetUsageLimitsCommand`：模型中的旧路径为 `/getUsageLimits`（12214971），IDE 面板命令位于 13998592，返回同样含 `userInfo.userId`，面板在 13998826 取该 ID。存在两套 SDK/协议不能推出它们的 URL、header 和 body 可以互换。

本次官方提取物中 `GetUserInfo`、`getUserInfo`、`GetUserUsageAndLimits` 字符串均没有命中。这个有限观察不能证明服务器已经删除旧接口，但它不能为仓库的旧 CBOR 门户调用提供当前客户端证据。

源码核查时，`src/main/index.ts` 的 `getUserInfo` 仍走 `kiroApiRequest('GetUserInfo', ...)`；`getUsageAndLimits` 则按全局设置走 CBOR 门户或旧 REST 路径，并带旧端点自动回退、响应/错误日志。因此它们不能原封用于多开绑定身份核验。核验需使用独立的、无 refresh/回退/载荷日志的 transport，并从受控认证响应中仅返回 `{userId}`。

实现选择固定 8 秒总超时，覆盖建立响应和读取响应体，禁止重定向、自动重试和端点回退；响应大小设上限。上述超时和大小上限是管理器的稳定性防护，不是本次从官方代码复制的服务要求。离线测试使用注入 fetch、合成 Token/响应及虚拟计时，不发出真实账户请求。

### 6.3 单会话只读请求结果

在用户已授权的真实接口检测范围内，于 `2026-10-21T03:53:42Z`（本地会话日期 2026-10-20）运行本版 `verifyKiroInstanceIdentity`。仅在内存中使用现有会话 accessToken，向上述新 ControlPlane 发送 **1 次** `GetUsageLimits`，返回 **HTTP 200**，成功解析非空 `userInfo.userId`；没有发送 refreshToken、刷新凭证、重试或写入认证缓存，也没有输出实际用户 ID。

这验证了该单会话的请求与身份响应，不能扩大成双真实账户启动、账户轮换、所有 provider/区域或安装升级均已验收。第 6.1–6.2 节的静态核查本身没有使用真实账户；本小节为独立的在线补充。
