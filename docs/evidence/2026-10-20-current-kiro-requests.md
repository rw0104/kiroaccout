# 当前 Kiro 登录、刷新、AI 请求与隔离取证

核查日期：2026-10-20。范围：官方公开资料、公开发行包的静态分析，以及本仓库源码对照。没有安装或执行官方客户端，没有读取生产账户或缓存，也没有发出带账户凭证的请求。

## 结论与证据等级

已取得官方 **Kiro IDE 1.4.5** Linux x64 公开包，其中内置 Agent 扩展为 **1.1.499**，Code OSS 为 **1.131.0**。Windows stable 元数据也声明当前版本为 1.4.5。以下精确协议来自该包的跨平台 JavaScript；没有把 Linux 包静态分析描述成 Windows 实机验收。

确有协议变化：当前 IDE 仅通过统一门户开始登录，Social 使用本机 HTTP 回调；Builder ID 当前 IDE 使用授权码和 PKCE；主要 AI 会话使用 Kiro Runtime 域名，并存在由服务功能配置控制的 Responses SSE 路径。不能把“算法更新”简单等同于修改版本字符串或随机请求头。

刷新 API 的核心 wire 字段仍与旧实现一致。稳定性改进应包括有效响应校验、同凭证单次并发刷新、请求超时、取消、刷新结果防覆盖，以及避免在已经输出部分文本或执行工具后盲目重放。

**仍未验证：** 独立测试账户的真实登录、上游允许第三方应用的授权策略、真实 Token 轮换、具体账户收到的功能配置，以及所有模型的实时调用结果。静态官方实现可以指导实现和离线回归，不能代替这些验收。

后续经用户授权已完成[真实 Runtime 接口检测](2026-10-20-live-interface-checks.md)：当前 Social 会话最小请求返回 HTTP 200 与预期标记，功能配置读取返回 HTTP 200；登录、刷新和跨用户验收仍未执行。下面的静态证据与该局部真实结果分别记录。

## 1. 官方来源和可复核样本

| 编号 | 来源 | 本次读取结果与用途 |
| --- | --- | --- |
| S1 | [官网下载页](https://kiro.dev/downloads/) | 页面内脚本声明官方 metadata 域名。服务端渲染的旧 Latest 为 0.12.200，但同一 HTML 的 releases 数据含 1.4.0；搜索缓存还显示 1.3.11。故不以渲染标签或搜索摘要确定最新二进制。 |
| S2 | [Windows x64 stable metadata](https://prod.download.desktop.kiro.dev/stable/metadata-win32-x64-user-stable.json) | `currentRelease=1.4.5`，`pub_date=2026-10-20`；HTTP Last-Modified 为 2026-10-20 01:32:01 GMT。 |
| S3 | [Linux x64 stable metadata](https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json) | 同为 1.4.5；HTTP Last-Modified 为 2026-10-20 01:32:04 GMT。 |
| S4 | [官方 Linux x64 1.4.5 tar.gz](https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.4.5/tar/kiro-ide-1.4.5-stable-linux-x64.tar.gz) | 下载、计算 SHA-256、按文件名提取文本；不执行 ELF、扩展或启动脚本。 |
| S5 | [IDE changelog](https://kiro.dev/changelog/ide/) | 读取时最新文章为 2026-10-19 的 1.4.0；元数据比文章更新，二者不混为同一个版本证据。 |
| S6 | [Authentication](https://kiro.dev/docs/getting-started/authentication/) | 当前四类登录入口、浏览器完成授权；CLI 远程设备流与 IDE 流程需分开。 |
| S7 | [Firewalls](https://kiro.dev/docs/privacy-and-security/firewalls/) | 页面更新 2026-10-16；确认 auth.desktop、runtime、management、区域 OIDC 域名用途。域名允许列表本身不证明 HTTP path/body。 |
| S8 | [CLI settings](https://kiro.dev/docs/cli/reference/settings/) | 页面更新 2026-10-10；`KIRO_HOME` 文档覆盖 agents、prompts、skills、steering、settings、sessions，没有明确承诺认证缓存隔离。 |
| S9 | [CLI 2.31 changelog](https://kiro.dev/changelog/cli/2-31/) | 2026-10-13；扩展 KIRO_HOME 的 V3 配置与状态范围，不能据此推断 IDE 认证缓存已改位置。 |
| S10 | [CLI commands](https://kiro.dev/docs/cli/reference/cli-commands/) | 说明本地统一门户、远程 device flow，logout 为用户级并影响各工作区。 |
| S11 | [AWS CreateToken](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_CreateToken.html) | 当前官方 camelCase JSON 授权码与刷新字段，以及可选 refreshToken、expiresIn 和错误类型。 |
| S12 | [AWS RegisterClient](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_RegisterClient.html) | 当前客户端注册字段、grantTypes、redirectUris、issuerUrl 与 clientSecretExpiresAt。 |

元数据获取时间为 2026-10-20 12:36 UTC 左右；静态分析记录于同日 12:44 UTC，后续适配时继续核对调用链。官方 metadata 可继续变更，下列摘要固定本次观察样本：

| 文件 | 字节数 / SHA-256 |
| --- | --- |
| Linux tar.gz | 277459584 / `0f594cbd9e043e5f1a3087dfbef22763d4f5804fbc00582c3b770b97f157aa4f` |
| Windows metadata JSON | `82892d4a4d767ba7a8c1f659524749f144f3b617631b8d1ec7dc4cff32a3b700` |
| Windows 1.4.5 installer | `9df4eb3d5340beacbefa7ff539d9aee337e43362b5156a6e00ad72173da82843` |
| Linux metadata JSON | `17bde6588e12a575ee4d7ab820785f0c4b048bb8ec267d9ebcb35f057b7d2997` |
| `resources/app/product.json` | `b68a01850dcca198cb17546694c9b3b0eead7a69cd66227ec0dd2ce6a9fd0e7f` |
| `resources/app/extensions/kiro.kiro-agent/dist/extension.js` | 15233421 / `cba1aade5bf26a519d70acfd9ac135fd945b6bfc71d3d4e9eb5a33f6f8b54f12` |
| `resources/app/out/cli.js` | 256698 / `0ae2e1a5325c072acecc3021e35006d1cb92f7d890ba08b9a3c1c5ddf0aa1969` |

`product.json` 标记 commit 为 `fbcbbe0c0c7081d7646c1cad6d5f31ed774c15b8`，构建时间为 `2026-10-19T23:03:44Z`。样本和摘录只放 Git 忽略的 `.local/evidence/current-kiro/`；本报告不提交第三方发行包或整段反编译代码。

后文定位是 `extension.js` 经 UTF-8 解码后的字符偏移，以零为起点；对应同一 SHA-256，版本变化后应重新定位。

另从 Windows metadata 指定的[官方 1.4.5 安装器](https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.4.5/kiro-ide-1.4.5-stable-win32-x64.exe)只读取得 Authenticode：状态 `Valid`，发布者 `Amazon.com, Inc.`，组织单元 `AWS Kiro`，签发者 `DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1`。未执行该安装器。实例启动器在运行时还会独立验证用户选择的 Kiro.exe 的有效签名、发布者与产品名，不能用安装器签名代替目标程序校验。

## 2. 当前登录方式

### 2.1 统一门户与本地回调

`PortalAuthProvider`（约 11229xxx）和 `PortalAuthServer`（112235xx）显示：

- 入口为 `GET https://app.kiro.dev/signin`。query 包括 `state`、`code_challenge`、`code_challenge_method=S256`、`redirect_uri`、`redirect_from=KiroIDE`；企业管理规则可进一步限制方法。state 为每次会话 UUID，verifier 为 32 个随机字节的 base64url，challenge 为 SHA-256 后 base64url。
- 监听实际绑定 `127.0.0.1`；向门户传的 URI 为 `http://localhost:<port>`，不带 callback path。候选端口依次为 `3128,4649,6588,8008,9091,49153,50153,51153,52153,53153`。这是当前官方实现允许使用的端口集合证据，不能自行假设任意新端口均获门户允许。
- 接受 `/oauth/callback` 和 `/signin/callback`。回调读取 `state`、`login_option`、`code`、`issuer_url`、`idc_region`；外部 IdP 另含 client/scopes/login_hint/audience。总会话上限 10 分钟。
- 官方入口支持 `google`、`github`、`builderid`、`awsidc`、`external_idp`。门户本身选择提供商。管理器如果显示预先选择的提供商，必须在收到回调后再校验真实方法，不可把另一提供商的结果写成所选身份。
- 授权拒绝 `access_denied`、缺失字段和不匹配 state 都不应被视作成功。管理器应使过期、取消或迟到的回调无法污染新会话；此为本地稳定性边界。

与仓库 1.7.6 对照：`src/main/loginSessions.ts` 的 Social 仍打开旧 `/login?idp=...`，redirect 为 `kiro://kiro.kiroAgent/authenticate-success`；这与当前官方入口不同，也会遇到系统协议被其他应用占用的问题。官方新门户提供了不抢占生产 `kiro://` 的已取证替代链路。

### 2.2 Google / GitHub 换 Token 与刷新

`PortalAuthProvider.exchangeSocialToken`（约 112325xx）与 `AuthServiceClient`（11152513）共同确定：

| 项目 | 当前官方行为 |
| --- | --- |
| 认证 host | `https://prod.us-east-1.auth.desktop.kiro.dev` |
| 交换 | `POST /oauth/token`，JSON `code`、`code_verifier`、`redirect_uri`；可选 `invitation_code` |
| 交换 redirect | 实际回调 base URI + 实际 callback path + `?login_option=google` 或 `?login_option=github`；不是门户开始时的不带 path URI，也不是旧 kiro 私有 scheme |
| 响应 | `accessToken`、`refreshToken`、`profileArn`、`expiresIn`；缓存把到期时间写为 ISO 字符串 |
| 刷新 | `POST /refreshToken`，JSON `{refreshToken}` |
| header | `Content-Type: application/json`；官方客户端的 User-Agent 包含其版本和机器 ID。该客户端标识事实不意味着第三方工具可以仅伪装版本就完成兼容。 |
| 客户端请求超时 | AuthServiceClient 配置 10 秒 |

当前仓库的 Social 刷新 host/path/body 与此一致，最新证据不支持无理由替换该刷新端点。官方 provider 保留已有 profileArn；管理器同样应在刷新没有返回新 profileArn 时保留既有值。服务端实际 refreshToken 轮换行为仍需独立账户验证，按 AWS 响应字段缺省规则不能把缺失新 refreshToken 当成空字符串覆盖。

### 2.3 Builder ID / IAM Identity Center

`IDCAuthProvider`（11193685）、`AuthSSOServer`（111887xx）、`ClientRegistrationStorage`（111927xx）表明：

- 门户 Builder 回调后，IDE 再以 `authMethod=IdC, provider=BuilderId` 执行 PKCE 授权码流。Builder 默认 start URL 仍为 `https://view.awsapps.com/start`，region 默认为 `us-east-1`；Enterprise 使用门户给出的组织 start URL 和 region。
- 这是 **当前 IDE 的授权码流**。CLI 官方仍明确支持远程设备流，不能因此声称旧设备授权接口被删除，或把旧设备流兼容性等同于已验证。
- 注册 `POST https://oidc.<region>.amazonaws.com/client/register`，字段为 `clientName`、`clientType=public`、`scopes`、`grantTypes=[authorization_code,refresh_token]`、`redirectUris=[http://127.0.0.1/oauth/callback]`、`issuerUrl`。官方 clientName 为 Kiro IDE；第三方工具应有自身标识。
- 当前默认 scopes 为五个 codewhisperer 权限：completions、analysis、conversations、transformations、taskassist。官方可配置 scopePrefix；不能给所有未来企业目录硬编码成不同的固定 scope。
- 同一个已绑定 server 使用 `127.0.0.1:0` 获取动态端口；回调路径 `/oauth/callback`。授权 `GET /authorize` query 为 `response_type=code`、`client_id`、实际 `redirect_uri`、`scopes`（逗号分隔）、`state`、`code_challenge`、`code_challenge_method=S256`。
- 交换 `POST /token`，JSON `clientId`、`clientSecret`、`grantType=authorization_code`、`redirectUri`、`code`、`codeVerifier`。刷新同一路径，JSON `clientId`、`clientSecret`、`grantType=refresh_token`、`refreshToken`。
- 客户端登记以 `SHA1(JSON.stringify({startUrl}))` 的名字缓存，并保存 `clientId`、`clientSecret`、客户端到期时间。官方在登记到期前 15 分钟即视为需要重新授权，不会靠重复刷新旧 client secret 解决注册过期。

本仓库 IAM PKCE 结构大体一致；Builder 仍走设备流。升级 Builder 至已取证 PKCE 流应复用 sessionId 和本地 HTTP 会话管理，不能靠预填 backup 数据跳过认证。

## 3. 刷新稳定性对照

当前 `AuthProvider`（约 112881xx）有如下行为，适合作为管理器本地并发和时序设计的证据：

1. 同实例 `refreshInFlight` 合并并发刷新。失败后按递增 backoff 暂缓继续请求，而不是各窗口高频重复消耗同一个 refreshToken。
2. 发送前保留旧凭证版本；写入前再次比较磁盘 refreshToken。若别的窗口已经轮换，不用旧刷新结果覆盖新凭证；旧请求失败但新凭证已有效时使用新凭证。
3. Token 在到期前处理，网络错误与授权失效分类。客户端登记过期、无凭证、拒绝授权等不能无限自动重试。
4. Token 文件使用临时文件、权限限制、原子 rename；拒绝符号链接目标。不能让断电或竞争写入留下半截 JSON。

以上是官方实现的事实归纳，不是已经对管理器修改通过的测试结论。管理器修改仍应通过自身调用入口的合成数据测试验收。

## 4. AI 请求：新 Runtime 与双协议

### 4.1 区域和认证

当前官方仍有 provider 固定 profile（`getFixedProfileArn` / `getAllProfiles`，约 13859302–13861200）：Builder ID 默认 profile 与 Google/GitHub 默认 Social profile 继续参与真实请求；Social token 自带 profile 优先。不能把所有固定 ARN 都当作无效值删除。其他提供商通过可用 profile 列表选择身份，不能凭旧第三方默认值猜测 Enterprise ARN。此规则已通过上述真实请求对照修正到候选实现。

`resolve identity`（约 3398350）与 `get endpoint`（3481340）优先使用显式区域覆盖，其次 profileArn 中的 region，再其次账户 identity.region，最后 `us-east-1`。主要 endpoint 为 `https://runtime.<region>.kiro.dev`；配置、模型等管理请求为 `https://management.<region>.kiro.dev`。不应仅用字符串 `startsWith('eu-')` 把所有欧洲组织固定重定向到另一区域。

主请求使用 Bearer access token。`TokenType` 映射（1925979、3396412）中 IdC 为 `SSO_OIDC`，外部 IdP 为 `EXTERNAL_IDP`；普通 Social 不增加该 header。机器 Token/API key 另有类型，当前账户管理器尚未实现，不应把它们猜成 Social Token。

### 4.2 GenerateAssistantResponse

当前主会话 `buildRequestCommand`（5556896）、`getKrsClient`（8952xxx）和 Runtime SDK schema（53048xx）确认：

- SDK service 为 KiroRuntimeService，apiVersion `2026-01-13`。
- 操作名 GenerateAssistantResponse。schema 的 HTTP trait 声明 `POST /generateAssistantResponse`，agentMode 带有 `x-amzn-kiro-agent-mode` trait；**但默认实际 protocol 是 awsJson1_0**（5295973），父 RPC serializer（3311187）以 `/` 为 path，按 JSON 序列化整个 input，再设置 `Content-Type: application/x-amz-json-1.0` 和 `x-amz-target: KiroRuntimeService.GenerateAssistantResponse`（5294816）。因此不能只读 schema 的 HTTP trait 就认定实际发送了该 REST path 或该 agentMode header。接入时应完整对照所选 protocol 的 serializer，不能混合 RPC 与 REST 绑定。
- buildRequestCommand 的 input 字段为 `conversationState`、`profileArn`、`additionalModelRequestFields`、`agentMode`、`systemPrompt`；systemPrompt 为字符串。HTTP trait 的 profile header 只出现在 featureConfiguration 等 schema，不能自行套用至所有请求。
- 顶层 **没有独立 inferenceConfig**。`maxTokens`、temperature 等旧 payload 参数不能在没有模型专属证据时随意挪进新字段。
- conversationState 包括 currentMessage、chatTriggerType、conversationId、history、agentContinuationId、agentTaskType、rootConversationId。userInputMessage 保持 content/modelId/origin、工具结果、图片和文档；assistantResponseMessage 可包含 toolUses、reasoningContent。
- 响应 conversationId 来自 `x-amzn-kiro-conversation-id`。响应体使用 AWS event stream，不能按普通一次性 JSON 读取。
- 当前流包含 assistantResponseEvent、reasoningContentEvent、codeReferenceEvent、toolUseEvent、toolResultEvent、metadataEvent、meteringEvent、contextUsageEvent、documentCitationEvent，并可能在流中返回 error、throttlingError、validationError、serviceUnavailableError。
- metadataEvent 包含 tokenUsage、stopReason、stopDetails；tokenUsage 包含 uncachedInputTokens、outputTokens、totalTokens、cacheReadInputTokens、cacheWriteInputTokens、contextUsagePercentage、normalizedTokenUsage。
- SDK 错误 schema 包括 HTTP 400、402、403、429、500、503；节流提示 header 为 `x-amzn-kiro-ratelimit-retry-after`（毫秒）。不能把所有 403 都当作可刷新错误，也不能通过轮换账户或重复请求掩盖无权调用。

仓库 `src/main/proxy/kiroApi.ts` 仍以 CodeWhisperer host 为第一端点，使用固定 `KIRO_VERSION=0.12.155` 和旧 AmazonQ target。旧 SDK 仍存在于当前包中，不证明旧端点是当前主链路；当前主调用点已明确使用 Runtime。仅替换 User-Agent 或 URL 不足以完成迁移，应把端点、payload、headers、流事件和错误一起适配，并保留显式兼容选项。

### 4.3 服务配置选择的 CreateResponse / SSE

本包还包含当前官方实现的另一条路径，`usesCreateResponsePath` / `create_response_api`（约 5281606、5289280、5543xxx）：

- 内置默认值为 `disabled`。只有 featureConfiguration 的 `create_response_api` 等于 `create_response` 时，主会话才切换；没有带账户取配置，不能声称所有账户已切这条路径。
- `POST https://runtime.<region>.kiro.dev/v1/responses`，JSON 响应协议为 SSE。请求 body 包括 `model`、`input`、`instructions`、`tools`、`stream=true`、`origin`、`profileArn`，另有 `metadata` 的 `kiro:*` 会话字段及 reasoning type/effort/summary。
- 请求 header：`Content-Type: application/json`、`Authorization: Bearer ...`、`x-amzn-kiro-origin`、`x-amzn-codewhisperer-optout`；存在 profile 时为 `x-amzn-kiro-profile`，按认证类型可附 TokenType；与前一协议的 header 不可混用。
- 原始实现 `create-response-raw`（5462715）分别处理连接超时、首字节超时、流解析和服务错误，SSE 转回统一内部 assistant/tool/reasoning/usage 事件后再消费。
- 新接口不等于公开 OpenAI API：路径和 SSE 外形相似，仍依赖 Kiro Token、profile、区域和功能开关。不得未经验证把任意 OpenAI 请求原样透传至该端点。

可实施顺序：先支持已取证 Runtime GAR 主协议与健壮流解析；若实现 SSE，应显式按服务配置或用户选项选择协议。未知配置不猜新协议；部分流输出后不跨端点自动重放。

## 5. Kiro IDE 多开和隔离边界

官方 1.4.5 `out/cli.js` 声明 `--user-data-dir`、`--extensions-dir`、`--new-window`（约 1934xx），以及 `--shared-data-dir`、agent 插件/数据/扩展目录参数。CLI 还识别 portable data，`VSCODE_PORTABLE` 可以优先选 portable 数据目录；因此自动启动器不能忽略继承的 portable 环境变量。

但这些参数不足以隔离认证：

- `TokenStorage`（11278189）直接将 `os.homedir()` 与 `.aws/sso/cache/kiro-auth-token.json` 组合。
- `ClientRegistrationStorage` 同样直接以 `os.homedir()/.aws/sso/cache` 为根。
- 搜索本版 TokenStorage 路径未发现 auth-cache 专用环境覆盖；`AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` 出现在其他 AWS SDK 配置路径，不能将其误当成 Kiro TokenStorage 覆盖项。
- ProfileStorage 使用扩展 context.globalStorageUri，可随 IDE user data 分开；这不能消除共享 Token 文件竞争。
- `KIRO_HOME` 只影响部分 Agent 配置根；其他 IDE 路径仍直接使用 homedir。仅修改这一个变量没有完成隔离。
- 所有实例仍属同一 OS 用户时，系统协议注册、机器级 managed-settings、系统代理/证书和可执行文件自动更新仍需单独约束。`--new-window` 表示新窗口，不保证独立凭证，也不保证独立父进程或实例锁。

因此需求 4 应提供明确的“配置分离”和“凭证隔离”状态，不把不同窗口标题/安装目录当作成功。环境 HOME/USERPROFILE 等覆盖可以作为受控实验方案，但官方源码没有认证隔离的完整承诺；在没有验证时应拒绝把生产账户写进这类实例。完整验收需独立 OS 用户/虚拟机，或经过验证的专用启动环境，且使用独立测试账户。

## 6. 本次可复现性与未执行项

采用 reverse-engineering 技能的 triage → static → synthesis 流程：确认公开 tar 格式与 SHA-256；只提取 product、Agent extension、CLI 等文本；定位认证、流 SDK schema、会话主调用点和缓存构造函数；记录版本和字符偏移。动态阶段因保护生产环境而未执行，不将其写成通过。

后续离线测试至少覆盖：门户与 IdC 两阶段 PKCE、准确 redirect、空/错误响应、错 state/错 provider、取消/过期/重复回调、刷新单次并发与迟到写入、区域匹配、event stream 分包/CRC/截断/错误事件、SSE 多行/UTF-8 分块/终止以及部分输出后的重试边界。真实服务验收另行使用独立测试账户进行。
