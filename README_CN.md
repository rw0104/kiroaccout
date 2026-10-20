# kiroaccout

[English](README.md) · [项目仓库](https://github.com/rw0104/kiroaccout)

基于 Electron 的 Kiro 账户管理桌面应用，源自 [chaogei](https://github.com/chaogei) 的 [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)，遵循 [AGPL-3.0](LICENSE) 许可证。

当前正在修复账户 JSON 导入、OIDC 批量粘贴及在线登录回调。真实桌面认证仍需验收，本仓库尚未发布本次修复版本。

- [需求文档](docs/2026-10-19-account-import-login/01-requirements.md)
- [问题分析](docs/2026-10-19-account-import-login/02-analysis.md)
- [修复方案](docs/2026-10-19-account-import-login/03-remediation-plan.md)
- [项目规则](AGENTS.md)与[开发隔离规范](docs/development-rules.md)
- [开发与 Windows 发布指南](docs/DEVELOPMENT.md)
- [应用源码](Kiro-account-manager/)

开发和测试必须隔离正在运行的 1.7.5、生产账户数据及共享认证缓存。启动开发客户端前，须满足隔离规范。
