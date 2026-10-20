# 当前认证协议取证与修复边界

取证日期：2026-10-19（America/Los_Angeles，按用户客户端日期）。本次只读取官方公开资料及仓库源码，没有启动桌面客户端、执行真实授权、访问账户缓存、刷新 Token 或注册系统协议。

## 1. 结论

当前官方资料足以支持修复设备授权轮询规则、PKCE 本地交接、会话隔离、取消及迟到结果处理。**不能据此声称已经实测 Kiro 最新真实认证，或任意迁移 Social 接口。** 精确的 Kiro 专属授权参数、scope、允许的 redirect URI 和 Token 轮换行为中，未获得当前官方实现或隔离实测证据的部分明确保留为待核实。

本轮仓库读取基线为 `ce00adcadff5a7db98a373b66dc9df2e7c8a9d19`；用户故障基线仍是账户管理器 `v1.7.5`。下文 Kiro CLI 的版本与账户管理器版本无关。

## 2. 证据来源与时效

| 编号 | 官方来源 | 版本、页面时间或固定提交 | 可证明的范围 |
| --- | --- | --- | --- |
| K1 | [Kiro Authentication](https://kiro.dev/docs/getting-started/authentication/) | 页面更新 2026-10-17；2026-10-19 读取（旧 `/docs/cli/authentication/` 搜索缓存为 10-09，以当前页面为准） | 当前支持的提供商、浏览器完成登录、远程设备授权 |
| K2 | [Kiro CLI commands](https://kiro.dev/docs/cli/reference/cli-commands/) | 2026-10-19 读取，页面未提供独立发布日期 | 当前本地 CLI 使用统一登录门户；远程或强制 device flow 轮询完成 |
| K3 | [Kiro firewall documentation](https://kiro.dev/docs/privacy-and-security/firewalls/) | 页面更新 2026-10-16；2026-10-19 读取 | IDE 认证域名与区域 OIDC 域名的用途 |
| K4 | [Kiro CLI changelog](https://kiro.dev/changelog/cli/) | 读取时最新条目 2.31.1，发布于 2026-10-14 | 当前公开版本参照；不代表已经运行或分析该二进制 |
| K5 | [AWS 官方 Q CLI 仓库](https://github.com/aws/amazon-q-developer-cli#readme) | 2026-10-19 读取 | README 明确后继 Kiro CLI 为闭源，Q CLI 源码不能冒充当前 Kiro 实现 |
| A1 | [RegisterClient](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_RegisterClient.html) | AWS `latest` 文档，2026-10-19 读取 | 注册请求、grant、redirect 限制、客户端有效期 |
| A2 | [StartDeviceAuthorization](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_StartDeviceAuthorization.html) | AWS `latest` 文档，2026-10-19 读取 | 设备授权请求和返回的间隔、有效期 |
| A3 | [CreateToken](https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_CreateToken.html) | AWS `latest` 文档，2026-10-19 读取 | AWS JSON 字段、授权码/设备码/刷新授权、响应和错误 |
| A4 | [AWS IAM Identity Center endpoints](https://docs.aws.amazon.com/general/latest/gr/sso.html) | AWS `latest` 文档，2026-10-19 读取 | 区域端点；不可将任意 region 当作合法区域 |
| A5 | [AWS SDK JS SSO OIDC model](https://github.com/aws/aws-sdk-js-v3/blob/35085844c581d910f51deea1b2de48f6b4ffa704/clients/client-sso-oidc/src/models/models_0.ts) 与 [HTTP auth scheme](https://github.com/aws/aws-sdk-js-v3/blob/35085844c581d910f51deea1b2de48f6b4ffa704/clients/client-sso-oidc/src/auth/httpAuthSchemeProvider.ts) | `@aws-sdk/client-sso-oidc` 3.1153.0；路径最新提交 `35085844…`，2026-10-19T18:20:42Z；GitHub API 与固定 raw 文件核对 | 当前公开 SDK 字段和三个操作的 noAuth 选择，不证明 Kiro scope 或应用授权策略 |
| A6 | [AWS CLI callback implementation](https://github.com/aws/aws-cli/blob/322485ac8328e3c5c76f1dfec422421e27e6b913/awscli/customizations/sso/utils.py) | 文件最新提交 `322485ac…`，2026-10-16T14:01:21Z；2026-10-19 读取 | 当前公开 AWS CLI 对 loopback 动态端口及 redirect URI 的处理 |
| R1 | [RFC 8628 §3.2–3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.5) | IETF，2019-08，2026-10-19 复核 | 设备授权轮询间隔、slow_down、终止和连接超时规则 |
| R2 | [RFC 8252 §7.3、§8.3–8.4](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3) | IETF，2017-10，2026-10-19 复核 | 原生应用 loopback、动态端口、协议冲突、redirect 匹配边界 |
| R3 | [RFC 7636 §4](https://www.rfc-editor.org/rfc/rfc7636.html#section-4) | IETF，2015-09，2026-10-19 复核 | verifier、S256 challenge 与授权码交换的绑定 |

## 3. 分链路核验

### 3.1 Builder ID：设备授权

- 本仓库约定 `provider=BuilderId`、`authMethod=IdC`；这是账户管理器内部数据约定，不能仅凭名称把它改成 Social。
- AWS 官方当前协议：区域 OIDC HTTPS 端点；依次 `POST /client/register`、`POST /device_authorization`、`POST /token`，JSON body，`Content-Type: application/json`。注册至少包含 `clientName`、`clientType=public`；设备授权使用注册返回的 `clientId`、`clientSecret` 和 `startUrl`。[A1][A2][A4]
- 设备 Token 请求使用 `clientId`、`clientSecret`、`grantType=urn:ietf:params:oauth:grant-type:device_code`、`deviceCode`。这是 AWS camelCase 协议；不能套用 RFC 示例的表单编码和 snake_case。[A3][A5]
- 设备授权返回的 `expiresIn` 及 `interval` 为秒，决定会话过期及最小轮询间隔。设备流通过 Token 轮询自动完成，协议本身不要求浏览器回调桌面；因此用户所述“不回调”在 Builder ID 场景必须先检查轮询和会话交接。[A2][R1]
- 默认间隔为 5 秒；`authorization_pending` 继续等待，`slow_down` 将间隔增加 5 秒并用于全部后续请求；连接超时降低频率。`access_denied`、`expired_token` 和其他终止错误停止该轮询。[R1]

**尚未核实：** 当前 Kiro Builder ID 的专属 `startUrl`、scope 列表、是否仍允许该第三方工具使用原有客户端注册组合，以及真实服务是否接受现有请求。当前 Kiro 官方只公开支持 Builder ID 与 device flow 的产品行为，未公开这套内部请求契约。[K1][K2] 本轮保留现有业务参数，修复排程与状态机；真实可用性待独立测试账户验收。

### 3.2 IAM Identity Center：授权码与 PKCE、loopback

- `provider=Enterprise`（仓库内部约定）、`authMethod=IdC`；区域来自组织的目录配置，Start URL 必须与该组织匹配。Kiro 官方要求用户提供 Start URL 与 Region。[K1]
- 当前 RegisterClient 支持 `authorization_code`、`refresh_token`；`redirectUris` 限制授权完成后的目的地，`issuerUrl` 指定目录 issuer，`scopes` 限制权限。客户端秘密使用 `clientSecretExpiresAt` 判断有效期，不能假设永久有效。[A1]
- 当前 CreateToken 的授权码交换使用 JSON `clientId`、`clientSecret`、`grantType=authorization_code`、`code`、`codeVerifier`、`redirectUri`。Token 成功响应使用 `accessToken`、可选 `refreshToken`、`expiresIn`、`tokenType`；刷新授权使用 `grantType=refresh_token` 和 `refreshToken`。响应不保证每次返回新 refresh token，实际轮换策略尚未实测。[A3]
- PKCE verifier 必须属于当前会话；S256 为 verifier 的 SHA-256 再 base64url。回调的 `state` 应与当前会话精确匹配，不能让不匹配的旧回调销毁新会话。[R3；后半为项目实现要求]
- 当前 AWS CLI 源码先将同一个 HTTPServer 绑定到 `127.0.0.1:0`，从已绑定的 server 获取端口；用于注册的 URI 不带端口，用于授权的 URI 带实际端口，路径都是 `/oauth/callback`。它不会先找空端口、关闭、再重新绑定。[A6] 该行为与 RFC loopback 端口例外相符。[R2]

**尚未核实：** Kiro 专属 scope、entitled application 策略，以及本仓库 `/authorize` 中 `scopes`/分隔方式是否与当前 Kiro 真实实现一致。AWS Token API 的 `scope` 单数与注册 API 的 `scopes` 复数不能据此推断浏览器 authorize 参数。此处不凭 OAuth 通用经验猜改上游参数。

### 3.3 Google/GitHub：Social 授权码及 PKCE、系统 URI

- 本仓库约定 `provider=Google` 或 `Github`、`authMethod=social`。Kiro 官方仍支持两种提供商并通过浏览器完成登录；当前本地 CLI 文档描述的是统一门户，与本仓库直接提供 `idp` 的旧流程不同，不能据此认为旧接口必然失效或仍然受支持。[K1][K2]
- 官方防火墙文档确认 IDE 使用 `prod.us-east-1.auth.desktop.kiro.dev` 完成 Token 交换、刷新及注销；它只确认域名用途，未公开具体 `/login`、`/oauth/token`、请求字段或 redirect allowlist。[K3]
- 仓库现有请求是 `/login`（query：`idp`、`redirect_uri`、`code_challenge`、`code_challenge_method=S256`、`state`）和 `POST /oauth/token`（JSON：`code`、`code_verifier`、`redirect_uri`）；redirect 为 `kiro://kiro.kiroAgent/authenticate-success`。**这些仅是当前仓库事实，最新请求方式尚未验证。** 不把其 scope、User-Agent、固定 ARN 或返回字段当成最新官方保证。
- 系统私有 URI 可被多个应用声明，目的进程由操作系统协议归属决定。[R2] 在生产 1.7.5 使用该 URI 时，另一个源码目录或自定义 userData 并不能解决协议冲突；禁止为测试抢占 `kiro://`。不能把 redirect 改成任意 `http://127.0.0.1` 或自定义 scheme，除非另有上游允许的证据。

**尚未核实：** Social 端点精确契约、允许的 redirect URI、返回 Token 的最新字段与过期/轮换规则。当前闭源 Kiro CLI 未作为二进制取得和分析；历史 Q CLI 源码和第三方适配器不能替代此证据。[K5]

## 4. 与 1.7.5 故障的关系和实施建议

这里区分“请求协议改变”和“本地异步交接改变”。以下措施不需要改写未验证的上游契约，可以用 mock 端点、fake clock 和合成回调离线验收：

1. 每次启动分配 sessionId，绑定 provider、region、state、verifier、到期时间与取消信号；异步调用只使用捕获的会话，写回前检查该会话仍有效。
2. 启动尚未完成也可被取消；旧 start、poll、exchange、callback 的迟到结果不能覆盖或清理新会话。不同渠道的 cancel 也不能取消另一个渠道。
3. Builder ID 串行轮询：主进程限制同一会话单次 in-flight 请求并执行 nextPollAt；向渲染进程返回实际间隔和剩余等待时间。渲染层用 await 后安排下一次请求，实际遵守 slow_down；到期、关闭和取消清理定时器。
4. Social 回调在主进程先按有效会话和 state 校验，保留一次性可交接结果；监听器尚未就绪时仍能恢复。重复回调不重复换 Token 或添加账户。不匹配的回调被忽略，不销毁当前有效会话。
5. IAM 将同一个 server 绑定到动态 loopback 端口，监听就绪后再展示授权 URL；关闭、超时、启动失败释放该会话 server。Token 交换结果与 sessionId 绑定，旧 server callback 不得写入新全局 result。
6. IPC/日志返回固定的脱敏错误类别和受控消息；不输出 userCode、授权码、verifier、完整凭证、上游原始响应或包含这些内容的 URL。网页登录的真正完成以 Token 交换成功为准。

这些修复保留 1.7.5 的业务请求地址及参数；设备轮询时间调整有当前 AWS 文档和 RFC 的直接依据。它们不能证明生产协议归属已经解决，也不能取代完整运行时隔离和真实授权验收。

## 5. 后续实机验收的最小证据

在独立 OS 用户或虚拟机与独立测试账户中，逐渠道记录官方客户端版本、请求 method/path、字段名、区域、允许的 redirect 形式、响应字段、错误类别及 Token 轮换现象；全部值脱敏。对照同一环境的新构建验证浏览器授权、自动入库、取消重试及迟到回调。不要使用生产 1.7.5 的账户或 refreshToken，也不要为取得这些证据启动当前用户下未经验证隔离的 Electron。
