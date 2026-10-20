# kiroaccout

[English](README.md) · [项目仓库](https://github.com/rw0104/kiroaccout)

基于 Electron 的 Kiro 账户管理桌面应用，源自 [chaogei](https://github.com/chaogei) 的 [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)，遵循 [AGPL-3.0](LICENSE) 许可证。

JSON/OIDC 导入与登录本地会话修复已合并。[下载 Windows x64 v1.7.6-rc.1 预发布](https://github.com/rw0104/kiroaccout/releases/tag/v1.7.6-rc.1)，包含安装器、ZIP 和 SHA-256 校验清单。真实桌面认证仍需在隔离环境验收。

- [需求文档](docs/2026-10-19-account-import-login/01-requirements.md)
- [问题分析](docs/2026-10-19-account-import-login/02-analysis.md)
- [修复方案](docs/2026-10-19-account-import-login/03-remediation-plan.md)
- [项目规则](AGENTS.md)与[开发隔离规范](docs/development-rules.md)
- [开发与 Windows 发布指南](docs/DEVELOPMENT.md)
- [应用源码](Kiro-account-manager/)

开发和测试必须隔离正在运行的 1.7.5、生产账户数据及共享认证缓存。启动开发客户端前，须满足隔离规范。
