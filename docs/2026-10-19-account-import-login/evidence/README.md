# 离线复现证据

这些脚本用于重现分析基线的现有行为，不是修复实现，也不是修复后的通过证明。默认使用合成字段值；不启动 Electron、不调用账号 API、不修改协议注册或用户认证缓存。仓库根目录中的原始账户 JSON 不属于本证据目录，不应加入版本控制。

## 环境与运行

本次验证环境为 Windows + Node.js 24.16.0。脚本使用 `node:module.stripTypeScriptTypes` 去除提取函数的类型，需使用支持该 API 的 Node.js。无需执行 npm install。

从仓库根目录针对旧版运行（当前修复源码不应再满足旧缺陷断言）：

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs --ref v1.7.5
```

对用户反馈的 1.7.5 复现：

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs --ref v1.7.5
```

## 预期基线结果

| 脚本 | 每版检查数 | 关键观察 |
| --- | --- | --- |
| [json-import-repro.mjs](json-import-repro.mjs) | 20 | 数组被文件入口拒绝；伪包装造成 undefined 键；ID 冲突与计数不符 |
| [oidc-batch-repro.mjs](oidc-batch-repro.mjs) | 29 | Builder ID 别名走 Social；包装/嵌套失败；预览、类型校验、重复计数异常 |
| [online-login-repro.mjs](online-login-repro.mjs) | 13 | 2 项正常路径；11 项协议交接、会话竞争、轮询与状态反馈观察 |

两个版本分别完成 62 项检查。导入脚本输出源码提取哈希和案例结果，登录脚本输出观察结果；任一基线断言不符应返回非零退出码。源码修复后，部分缺陷断言理应不再成立，需另建针对修复结果的正式回归测试。

## 可选样例模式

```powershell
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5 --samples .local/samples
node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5 --samples .local/samples
```

`json-import-repro` 接受显式目录；`oidc-batch-repro` 的可选样例查找行为以脚本参数为准。公开报告只保留匿名样例编号、键结构、数量和分类，不记录真实账户值或原始文件名。其他环境直接运行默认合成矩阵即可；如需本地样例，先制作脱敏等价数据并放入 Git 忽略的 `.local/samples/`。

详细结论、版本信息和调用链见 [分析文档](../02-analysis.md)，拟议改动见 [修复方案](../03-remediation-plan.md)。
