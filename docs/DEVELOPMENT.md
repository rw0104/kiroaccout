# 开发与发布指南

本文面向接续维护 `rw0104/kiroaccout` 的开发者，覆盖依赖安装、离线回归、导入和登录模块、Windows 安装包构建及 GitHub 发布。仓库保留上游历史，许可证为 [AGPL-3.0](../LICENSE)。

**先读 [项目规则](../AGENTS.md) 和 [隔离执行规范](development-rules.md)。当前没有经过验证的运行时隔离模式；在用户正在运行 1.7.5 的 Windows 会话中，默认只做源码分析、离线测试、类型检查和构建。不要直接执行 `npm run dev`、`npm start`、`npm run test:e2e` 或运行打包客户端。**

## 1. 安装依赖并完成离线验证

使用 Node.js **24.16.0 或更新的 24.x**、npm、Git；Windows 发布还需要 Windows x64 环境和可访问 Electron/electron-builder 构建资源的网络。测试依赖 Node 原生 TypeScript 类型擦除与模块解析钩子，不沿用上游旧 README 的 Node 18 要求。

仓库有一层同名应用目录，根目录不直接执行 npm 命令：

```text
kiroaccout/                         仓库根
├── AGENTS.md                       协作与生产隔离规则
├── README.md / README_CN.md        项目入口
├── docs/                           开发、请求证据、实施记录
│   ├── DEVELOPMENT.md              本文
│   └── 2026-10-19-account-import-login/
├── .github/workflows/              CI / Release 工作流
└── Kiro-account-manager/           Electron 应用根
    ├── package.json / package-lock.json
    ├── electron-builder.yml
    ├── src/main/                   主进程、认证与文件/网络 IPC
    ├── src/preload/                渲染进程允许调用的接口
    ├── src/renderer/src/           React 界面、Zustand store
    ├── src/shared/                 共享纯函数与导入数据模型
    ├── test/unit/                  离线回归
    ├── out/                        electron-vite 编译结果
    └── dist/                       electron-builder 打包结果
```

在新的检出目录执行：

```powershell
git clone https://github.com/rw0104/kiroaccout.git
Set-Location ./kiroaccout/Kiro-account-manager
node --version
npm --version
npm ci
npm run test:unit
npm run typecheck
npm run build
```

已有检出应先检查 `git status --short`，保留其他人的未提交改动；不要为了更新依赖而 reset 或清理目录。`npm ci` 严格使用 lockfile，并保留依赖自身的安装脚本；项目的 `postinstall` 检查 Electron 包元数据，并加载 cbor-extract/Koffi 的 Node-API 预编译依赖，不启动桌面客户端。打包器独立下载 Electron 运行库，运行库和生成产物在打包后检查，不以开发环境的 `electron/path.txt` 为门槛。不要用 `--ignore-scripts` 跳过依赖安装，也不要强制 `electron-builder install-app-deps` 重编译这些自带 Node-API 的模块。网络不可用时依赖安装不算离线操作。单元测试通过注入响应执行，不请求真实 Kiro 服务。

| 命令 | 用途 | 输出或副作用边界 |
| --- | --- | --- |
| `npm run test:unit` | 解析、恢复、持久化、界面处理函数、认证状态机回归 | 合成凭证和 mock；IAM 测试仅使用本地动态 loopback 端口 |
| `npm run typecheck` | main/preload 与 renderer 的 TypeScript 检查 | 不启动应用 |
| `npm run build` | 类型检查及 electron-vite 编译 | `out/`，不创建安装包、不启动应用 |
| `npm run package:win` | Windows x64 NSIS 安装包和 ZIP | 只打包已有 `out/`，先执行 `build`；输出 `dist/`，显式 `--publish never`，不上传、不安装 |
| `npm run verify:package` | 静态核验打包内容、版本、更新仓库、原生库和 x64 架构 | 仅检查文件，生成 `dist/package-verification.json`，不执行应用 |
| `npm run release:checksums` | 为当前版本的精确发布附件生成 SHA256，正式版包含更新元数据 | 写入 `dist/SHA256SUMS.txt`；附加 `-- --verify` 可复核已有清单 |
| `npm run release:stage` | 汇集当前版本与渠道所需附件 | 写入 `dist/release-assets/<version>/`，拒绝混入其他文件 |
| `npm run dev` / `npm start` | 启动 Electron | 当前会话默认禁止，必须先满足完整隔离条件 |
| `npm run test:e2e` | 连接桌面代理的端到端测试 | 不属于离线回归，默认禁止连接运行中的生产代理 |

[前一阶段实施记录](2026-10-19-account-import-login/05-implementation-status.md) 保留了当时 **85/85 项离线检查、类型检查和源码构建通过** 的结果。2026-10-20 的 `1.7.6` 发布验证为 **105/105 项离线回归通过**，新增覆盖版本比较、更新状态、保存确认、异步安装器启动失败及更新清单校验。类型检查和源码构建也已通过；Windows 安装包结果及校验值以对应 Release 的构建日志和附件为准。

## 2. 定位导入问题

导入的数据流是：文本预处理 → 白名单容器解包 → 身份和字段标准化 → `ImportPlan` → 预览/计数 → 凭证验证或备份恢复 → 保存确认。

| 模块（相对应用根） | 职责 | 修改时的约束 |
| --- | --- | --- |
| `src/shared/authIdentity.ts` | provider/authMethod 别名及身份冲突校验 | Builder ID 必须归一为 `BuilderId` / `IdC`；未知显式渠道不能回退 Social |
| `src/shared/accountImport.ts` | 文本、JSON、字段标准化、逐条问题及计划计数 | main 和 renderer 共用纯函数；预览与提交共用同一计划 |
| `src/shared/backupRestore.ts` | 完整备份恢复、账户/分组/标签 ID 与引用映射 | 保护本地 ID 与定义，避免不同备份的同名 ID 覆盖 |
| `src/renderer/src/utils/accountImport.ts` | 凭证验证、去重、取消、持久化及结果计数 | 通过依赖注入验证；确认保存后才能计为新增成功 |
| `src/renderer/src/store/accounts.ts` | 跨入口串行导入、已消费凭证关联、保存调度 | 保存失败只重试保存，不重新兑换同一个 refreshToken |
| `src/renderer/src/components/accounts/AddAccountDialog.tsx` | OIDC 批量预览与在线登录界面 | 关闭、取消、重试使旧操作失效；保存错误保留重试入口 |
| `src/main/index.ts` 和 `src/preload/` | 主进程 IPC 与隔离后的能力暴露 | 类型与实现同步，敏感输入不进入日志 |

解析器支持单账户对象、数组、`accounts` 数组/映射、`data` 数组、带元数据的完整备份，以及已有凭证行语法；预处理兼容 BOM、首尾空白和完整 Markdown 代码围栏。它不接受任意层级的递归猜测，也不会将语法正确但缺少账户字段的 JSON 当成有效凭证。

必须保留两种入库语义：

- **简化凭证**：先校验身份、完整性、重复项，再经主进程验证后入库。Builder ID 缺少 `refreshToken` / `clientId` / `clientSecret` 三件套时逐条报错；Google/GitHub 走 Social 身份。
- **完整备份**：恢复账户及分组/标签元数据，保护 ID 和引用关系；无 Token 的完整备份账户可保留并标记 `unknown`。不能给任意不完整对象补备份头来绕过凭证校验。

下面的合成输入可以用于解析回归，不能用于真实授权：

```json
[
  {
    "provider": "Builder ID",
    "credentials": {
      "refreshToken": "SYNTHETIC_REFRESH",
      "clientId": "SYNTHETIC_CLIENT",
      "clientSecret": "SYNTHETIC_SECRET",
      "region": "us-east-1"
    }
  }
]
```

最终结果分别统计 `added`、`duplicate`、`invalid`、`failed` 和 `cancelled`，总和应等于计划总数。不要以“发起验证”或“写入内存”代替“已经保存成功”。

## 3. 修改认证会话

认证主逻辑在 `src/main/loginSessions.ts` 的 `LoginSessionManager`，由 `src/main/index.ts` 接入 IPC；前端串行排程在 `src/renderer/src/lib/loginPolling.ts`，界面位于 `AddAccountDialog.tsx`。

每次启动都携带独立 `sessionId`，会话绑定 provider、region、state、PKCE verifier、取消信号、期限及本地回调服务。异步调用完成后先检查归属，再交接 Token 和入库。旧 start/poll/exchange/callback 不得销毁新会话，取消不得跨渠道作用。

| 渠道 | 本地完成路径 | 必须覆盖的回归 |
| --- | --- | --- |
| Builder ID | 设备授权后串行轮询 Token，不依赖浏览器回调桌面 | 最小 `interval`、单个在途请求、`slow_down` 后增加 5 秒、过期及取消 |
| Google/GitHub | PKCE + 系统 `kiro://` 回调；主进程缓存一次性回调供界面恢复 | 监听前收到回调、错误 state、重复回调、迟到交换、退出后 verifier 丢失 |
| IAM SSO | 同一个 HTTP server 先绑定 `127.0.0.1:0`，就绪后生成授权地址，界面查询结果 | 动态端口、畸形请求、state、超时释放、旧回调不进入新会话 |

本轮只修复有官方依据的设备轮询规则及可离线证明的本地会话交接，没有凭旧实现迁移尚未核实的 Kiro 专属端点、scope、redirect allowlist 或 Token 轮换策略。

涉及上游请求时先更新 [当前认证请求证据](2026-10-19-account-import-login/04-current-auth-evidence.md)，记录官方来源、获取日期、版本、method/path、字段结构及适用链路。取证应使用独立环境与测试账户，禁止刷新生产账户来验证请求。没有依据的部分写明“最新请求方式尚未验证”，独立推进本地解析及 mock 回归。

## 4. 添加可复现的回归

先使用合成数据建立会失败的最小测试，再修改真实调用入口。测试放在 `test/unit/*.test.ts` 或 `*.test.mjs`，由现有 `test:unit` 脚本发现。TypeScript 测试使用 Node 原生类型擦除，`register-ts-resolve.mjs` 仅为本地扩展名解析提供钩子，不加载 Electron。

| 现有测试 | 可复用的方式 |
| --- | --- |
| `accountImport.test.ts` | 直接调用共享纯函数，断言容器、渠道、逐条错误和计数 |
| `backupRestore.test.mjs` | 使用内存账户/分组/标签，断言 ID 碰撞和引用映射 |
| `credentialImport.test.mjs` | 注入 `verify`、`add`、`persist`、`existing`、`now`，断言真实执行时序 |
| `importPersistence.test.mjs` | 驱动实际 store 保存逻辑，复现在途快照、失败及重试 |
| `loginSessions.test.ts` | 注入 `fetch`、`openBrowser`、`notifySocial`、`now`、计时器；用 deferred Promise 控制迟到结果 |
| `loginDialog.test.mjs` | 在 VM 中执行真实对话框处理函数，mock hooks、IPC 和 store，不启动窗口 |
| `version.test.ts` | 覆盖预发布标记与稳定版的排序，避免将 RC 错当作稳定更新 |
| `appUpdater.test.ts` | mock 更新引擎，检查稳定渠道、单次下载、保存确认、失败与重试、状态快照顺序 |
| `updaterInstallAdapter.test.mjs` | 使用依赖实际退出逻辑，离线复现异步 NSIS 启动失败，验证阻止退出及恢复入口 |
| `updateManifest.test.mjs` | 绑定更新清单的版本、文件名、大小与摘要，并区分 RC 和正式版附件 |

登录 mock 的最小示例（放到应用根的 `test/unit/` 下）：

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import { LoginSessionManager } from '../../src/main/loginSessions'

test('注册失败返回固定错误，不回显响应内容', async () => {
  const manager = new LoginSessionManager({
    authEndpoint: 'https://example.invalid',
    openBrowser() {},
    notifySocial() {},
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'SYNTHETIC_PRIVATE_VALUE' })
    })
  })
  const result = await manager.startBuilder('synthetic-session')
  assert.equal(result.success, false)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_VALUE/)
})
```

不要将用户目录里的真实 JSON、邮箱、密码、Cookie、授权码、refreshToken 或抓包复制进测试、截图、日志、PR。`.local/` 中的交接快照和隔离资料同样不提交。上游响应错误只断言受控分类，不拼接原始 body 到 UI 错误。

历史 `evidence/*.mjs` 的断言针对旧版缺陷；对当前修复源码运行它们并不能代替回归验收。需要比较时，在仓库根使用规则中给出的 `--ref v1.7.5` 或 `--source-ref v1.7.5`，新行为使用 `npm run test:unit`。

## 5. 保护正在运行的 1.7.5

用户现有的生产安装目录、`%APPDATA%\kiro-account-manager`、真实 `.aws/sso/cache`、CLI/IDE 数据及系统 `kiro://` 协议都属于保护边界。不同源码目录、窗口标题或单个 `--user-data-dir` 不能阻止共享缓存和协议写入。

当前允许的方式是“独立源码 + 不启动 Electron + 注入 mock”。运行桌面测试前必须满足 [完整隔离门槛](development-rules.md#2-启动-electron-前的必要条件)：在初始化/实例锁前隔离数据、凭证、日志、备份、缓存、更新及端口；禁用生产 watcher/同步、自动刷新、协议注册、系统代理/证书/机器标识写入；主进程 IPC 同样校验边界。

需要真实浏览器或系统协议交接时，使用独立 OS 用户或虚拟机与独立测试账户。Social redirect 必须是上游允许的形式，不能随意改 scheme 或 loopback 来绕过协议冲突。独立目录也不能复用生产 refreshToken，因为刷新可能使原 Token 失效。

**安装包只构建和分发，不在当前用户环境运行安装器或 `win-unpacked` 程序。** NSIS 中 `runAfterFinish: false` 只限制安装结束时启动，不构成安装和运行隔离。ZIP 解压后的程序仍会触及同样的账户数据、认证缓存和系统资源；ZIP 也不是隔离模式。

## 6. 构建 Windows 版本并发布

当前交付目标为 Windows x64 正式版本 `1.7.6`。正式版按稳定更新渠道分发；RC 是预发布渠道，两者的公开附件和 latest 标记不同。发布类别不能代替实际验收记录，不能把未执行的真实账号授权或隔离多开测试写成通过。

1. 先检查代码、文档和版本。应用 `package.json` 与 `package-lock.json` 中的版本必须同步；仓库根 `docs/releases/v${version}.md` 必须有对应发布说明。
2. 在 Windows x64 应用根执行：

```powershell
npm ci
npm run test:unit
npm run build
npm run package:win
npm run verify:package
npm run release:checksums
npm run release:checksums -- --verify
npm run release:stage
```

`build` 包含 TypeScript 检查。`package:win` 不重新编译源码；修改源码后必须先运行 `build`，再由 electron-builder 生成 NSIS 安装器与 ZIP，并显式使用 `--publish never`。打包可能下载 Electron、NSIS 和辅助工具，不启动生成的应用或安装器。

`verify:package` 检查 ASAR 文件范围、必需入口与原生依赖、版本、TLS DLL、随包许可证、更新仓库和 Windows x64 架构。`release:checksums` 根据当前版本生成精确发布附件的摘要，拒绝缺失或旧版本产物。静态检查与摘要通过不等于安装、启动或真实授权验收通过。

| 发布类别 | 公开附件 | GitHub 标记与更新渠道 |
| --- | --- | --- |
| 正式版，例如 `1.7.6` | `kiro-account-manager-1.7.6-x64-setup.exe`、`kiro-account-manager-1.7.6-x64-windows.zip`、安装器同名 `.blockmap`、`latest.yml`、`SHA256SUMS.txt` | 非 prerelease；设为 latest；允许本仓库稳定客户端发现更新 |
| RC，例如 `1.7.6-rc.1` | 对应版本的 EXE、ZIP、`SHA256SUMS.txt` | prerelease；不设 latest；不上传 `latest.yml` 或稳定更新元数据 |

ZIP 仅提供解压分发，不是隔离模式。仅构建 Windows x64 不能宣称生成或验收了其他平台。不要把 `win-unpacked/`、本地验证报告或调试文件上传为 Release 附件。

3. 运行 `node scripts/release-version.mjs`，检查包与 lockfile 的版本、版本格式和发布说明；由 tag 触发时还检查 tag 与 `v${version}` 一致。已有 tag 不得悄悄指向另一提交。
4. 使用 [.github/workflows/build.yml](../.github/workflows/build.yml)。工作流支持推送 `v*` 标签或在欲发布的提交上手动运行，依次执行依赖安装、离线回归、类型检查、构建、打包、包内容检查和摘要生成。
5. 发布任务下载构建附件并复核摘要后，在 `rw0104/kiroaccout` 先创建 draft、上传完整附件，再按版本类别公开。发布后核对 tag、目标提交、附件名、大小和摘要；缺附件或构建失败不能作为成功交付。

`latest.yml` 中的安装器文件名、URL、大小与 SHA-512 必须与实际 EXE 匹配，blockmap 必须来自同一份安装器。新增正式版本的 EXE、blockmap 和元数据需要一起发布；只上传 EXE 不足以提供软件内自动更新。`SHA256SUMS.txt` 用于用户下载核对，不能代替更新器所需的元数据。

更新逻辑由 `src/main/appUpdater.ts` 管理，`src/main/index.ts` 负责更新引擎和 IPC 适配，`src/renderer/src/lib/updateClient.ts` 按 revision 接收快照，`UpdateDialog.tsx` 提供用户确认。默认启动及每六小时检查，下载和安装均需用户操作。安装前以随机 requestId 和渲染进程身份确认保存成功；异步安装器启动失败时阻止排定的退出，并要求重启应用后重试或手动安装，避免依赖内部安装闩锁导致界面假重试。

下载后在下载目录使用 PowerShell 检查：

```powershell
Get-FileHash -LiteralPath ./kiro-account-manager-1.7.6-x64-setup.exe -Algorithm SHA256
Get-FileHash -LiteralPath ./kiro-account-manager-1.7.6-x64-windows.zip -Algorithm SHA256
```

将摘要与该 Release 的清单比较。没有配置签名证书的包不能宣称已签名；构建、校验、安装启动和真实授权是分别记录的检查。

旧上游 1.7.5 仍可能查询它原来的更新仓库，不会因为本仓库发布了版本而自动切换来源。首次迁移前先备份；开发和验收不得在现有生产账户或安装上执行更新。后续通过本仓库客户端提示下载，并由用户确认重启安装。

## 7. 常见问题

| 现象 | 排查步骤 |
| --- | --- |
| npm 提示没有 package.json | 进入仓库内的 `Kiro-account-manager/`，不要在仓库根执行 npm |
| 测试无法解析 `.ts` 或不支持 Node 参数 | 检查 Node 24.16+，在应用根执行 `npm ci` 和仓库脚本，不改成旧版 Node 强行运行 |
| JSON 合法却不能导入 | 检查受支持的容器、provider/authMethod 与三件套；逐条问题是字段/身份校验结果，不能仅以 JSON.parse 成功判断可导入 |
| Builder ID 网页显示完成，桌面仍等待 | Builder ID 使用设备轮询；先以 fake clock 检查间隔、slow_down、sessionId 和过期，再在独立测试环境核验服务响应 |
| Google/GitHub 回到错误程序或没有唤起窗口 | 检查隔离系统内的 `kiro://` 归属与浏览器外部协议许可，不在生产会话抢占协议；回调缓存不能解决操作系统路由错误 |
| 保存失败后再次导入报重复 | 查看内存账户和保存结果，走保存重试；不要重新兑换同一份可能已轮换的 Token |
| electron-builder 下载失败 | 确认网络和下载阶段，保留脱敏日志；不通过启动生产客户端或借用生产配置排查 |
| 只有 `out/` 没有安装器 | `npm run build` 只编译；随后使用 `npm run package:win`，再执行 `verify:package` 检查 `dist/` |
| 安装包版本正确却没有最新改动 | `package:win` 不编译；确认打包前已从当前提交运行 `npm run build` |

## 8. 提交与验收

在新分支工作，先确认 `git status` 与远端，不撤销其他人的改动。每个修复记录触发条件、最小复现、修改模块、相应回归及请求证据边界；`npm run test:unit`、类型检查、构建通过后再提交。PR 正文应说明生产 1.7.5 未被测试写入，明确区分离线验证和真实桌面授权结果。

后续真实验收至少覆盖：三种认证链路及各渠道；对象/数组/包装 JSON 与 OIDC 粘贴；重复、无效、取消、保存失败；连续重试、迟到回调、关闭窗口；安装器协议归属与实际自动入库。结果更新到 [实施记录](2026-10-19-account-import-login/05-implementation-status.md)，证据只保留字段结构和脱敏分类。

| 证据 | 结论 | 对应路径 |
| --- | --- | --- |
| [需求与分析](2026-10-19-account-import-login/02-analysis.md) 及共享解析回归 | 旧入口结构和身份判断可导致导入失败 | `src/shared/`、导入 utils/store 与测试 |
| [当前官方请求证据](2026-10-19-account-import-login/04-current-auth-evidence.md) 及会话测试 | 可修复设备轮询及本地交接；未证明所有真实服务契约 | `src/main/loginSessions.ts`、界面与轮询模块 |
| [85 项验证记录](2026-10-19-account-import-login/05-implementation-status.md) | 已完成离线修复与源码构建，真实授权待验收 | `test/unit/`、独立环境后续验收 |

更多历史上下文见 [需求](2026-10-19-account-import-login/01-requirements.md)、[修复方案](2026-10-19-account-import-login/03-remediation-plan.md) 和 [隔离规范](development-rules.md)。
