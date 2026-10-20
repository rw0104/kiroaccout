# 项目协作规则

本文件适用于整个仓库。用户本轮明确要求：修复登录认证及过程中发现的其他 Kiro 相关问题时，先确认最新 Kiro 请求方式，再修复；修复与测试全过程隔离当前正在使用的 1.7.5。

## 1. 项目和版本基线

- 仓库根目录：`D:\kiroaccout\Kiro-account-manager`。
- Electron 应用目录：`Kiro-account-manager/`；npm 命令在此目录执行，文档和下述离线诊断命令在仓库根执行。
- 用户故障版本为 `1.7.5`，对应标签 `v1.7.5` / `56310443f73ea535836a51a7170e2e027d1df1ea`。
- 本轮拉取的 main 基线为 `8f11db50f64cc4faf3f9c0dff8eca543c01cdc15`，应用版本 `1.7.6`。修复前复核当前 HEAD，不把 main 版本当成用户正在运行的版本。
- 现有需求、分析和修复方案位于 [docs/2026-10-19-account-import-login](docs/2026-10-19-account-import-login/01-requirements.md)。发现新事实时更新对应文档，区分已验证事实、候选原因和待验收项。

## 2. 先确认最新 Kiro 请求方式，再修复

涉及登录、Token 刷新、账户查询、额度、模型、订阅、profileArn、API 端点或其他 Kiro/AWS 请求的问题，必须先取得并记录与该链路有关的最新请求证据，再决定实现。

证据优先顺序：

1. 当前官方 Kiro 客户端/CLI 或官方 SDK 的相关实现，记录版本、来源和获取时间。
2. 官方 Kiro/AWS 文档、官方协议说明或官方仓库，记录页面/提交日期和适用范围。
3. 隔离测试环境中由测试账户产生的最小、脱敏请求/响应，用于验证当前实际行为。

仓库旧实现、历史抓包、第三方适配器和已有分析文档可以提供线索，不能单独作为“最新请求方式”的证明。不要为取证升级、补丁或操作当前使用中的 1.7.5；不要为取证刷新其现有账户凭证。

每条受影响链路至少记录：provider、authMethod、授权类型、区域、端点、method、必要 header/body 字段、redirect URI/state/PKCE 或设备授权轮询规则、Token 到期与轮换行为、关键错误码，以及与 1.7.5 的差异。不得照搬旧请求的固定 ARN、User-Agent、scope 或字段，除非已核实它仍适用。

不同认证链路分别核验，不能相互套用：

- Builder ID：设备授权与 Token 轮询。
- Google/GitHub：Social 授权码及 PKCE、自定义 URI 交接。
- IAM SSO：本地 HTTP 回调及 PKCE；界面轮询主进程结果。

拿不到当前证据的部分明确标记“最新请求方式尚未验证”，继续做独立的离线解析、状态机和 mock 验证，不以猜测改写上游请求或宣称真实认证已修复。纯本地 JSON、类型校验等不涉及上游协议的修复可独立进行，不人为阻塞。

## 3. 保护当前运行的 1.7.5

本轮只读核实的生产边界：

| 资源 | 受保护位置或对象 |
| --- | --- |
| 正在使用的安装目录 | `D:\kiro-account-manager` |
| 正在使用的程序 | `D:\kiro-account-manager\kiro-account-manager.exe`，文件版本 1.7.5 |
| 生产账户与应用数据 | `%APPDATA%\kiro-account-manager` |
| Kiro IDE 共享认证缓存 | `%USERPROFILE%\.aws\sso\cache` |
| Kiro CLI 与 IDE 状态 | 用户真实的 Kiro CLI 数据库、`.kiro`、IDE 设置/全局存储及机器标识 |
| 系统共享资源 | `kiro://` 协议归属、系统代理、信任证书、机器 ID、登录启动项和全局快捷键 |

- 不停止、重启、更新、卸载、替换、打补丁或覆盖现有 1.7.5，不通过其 UI、IPC、代理端口或 Token 文件执行测试写入。
- 不读取或复制生产账户库/备份作为开发种子；JSON 样例只能做本地结构分析，测试默认使用脱敏等价数据。
- 不对正在使用的账户运行 refresh、自动续期、自动切换或真实代理请求。刷新 Token 可能使生产旧 Token 失效，即使应用数据目录不同，也不属于隔离。
- 不修改真实 AWS 缓存、CLI 数据库、IDE 账户/机器码/设置，不启用真实 IDE Token watcher 或双向同步。
- 不注册、注销或抢占生产 `kiro://`，不修改系统代理、信任证书或系统机器标识。Social 的替代 redirect URI 必须先确认上游允许；不能为隔离而任意替换。
- 构建产物仅输出到本仓库，不运行会安装/覆盖生产版本的安装器，不启用自动下载、安装或退出时更新。
- 进程 ID 会变化；按绝对可执行路径重新识别，不能硬编码 PID，更不能按名称批量结束 Kiro/Electron 进程。

## 4. 开发与实机测试的隔离门槛

**当前源码没有经过验证的运行时隔离模式。直接 `npm run dev`、`npm start` 或启动打包客户端并不安全隔离。** 不把单独源码目录、不同窗口标题、只加 `--user-data-dir`、仅修改 HOME/APPDATA 环境变量当作隔离完成。

允许执行源码分析、依赖/类型检查、构建和已核实无外部副作用的离线测试。现有 `npm run test:e2e` 会连接运行中的桌面代理，不能默认对其执行；只有显式指定经过验证的隔离服务地址和独立测试账户时才可使用。启动 Electron 调试版前必须满足 [隔离执行规范](docs/development-rules.md) 的全部运行条件：独立数据和凭证根、实例锁、日志/备份/缓存/更新路径、端口，以及针对共享协议和系统操作的明确保护。

隔离状态与临时资料统一放仓库根 `.local/isolated/`，默认空账户；该目录不入 Git。运行时保护必须在实例锁、存储初始化和启动副作用发生前生效；涉及模块初始化时要检查静态 import 的执行时序。主进程对相关 IPC 也要校验隔离边界，不能只隐藏 UI 按钮。

GUI/真实授权测试需要生产共享资源时，在独立 OS 用户或隔离虚拟机中完成；当前用户会话先用 mock 注入回调与响应。独立环境仍必须使用独立测试账户，不能共用生产 refreshToken。

## 5. 修复质量和新增问题

- 先保留最小复现，再修复，修复后用真实调用入口的回归测试验证。不要把“旧行为缺陷断言通过”当成修复通过。
- JSON 文件、OIDC 粘贴、预览和提交共用解析与身份标准化规则；禁止为绕过入口校验直接给不完整账户包装备份头并入库。
- 登录异步结果绑定 sessionId；取消、关闭和重试后旧结果不得添加账户、消费新会话或清理新会话。
- 新发现的问题单独记录触发条件、版本、证据、影响和修复范围；涉及上游请求时同样执行第 2 节。不在没有证据时顺手改写其他请求链路。
- 凭证、授权码、PKCE verifier、Cookie、邮箱、密码及包含它们的抓包不得写入日志、文档、测试报告、提交或 PR。请求证据保留字段与脱敏分类即可。
- 交付中说明改动、验证结果、真实授权是否验收，以及隔离边界是否保持；不宣称未执行的桌面测试通过。

## 6. 当前可用的离线复现

在仓库根、Node.js 24.16.0 环境运行，无需启动客户端：

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs --ref v1.7.5
```

## graphify

- **graphify** (`~/.Codex/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
- When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.
