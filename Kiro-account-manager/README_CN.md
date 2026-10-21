# kiroaccout 应用源码

本目录为 Electron 应用源码。使用说明见[项目首页](../README.md)，开发与构建见[开发文档](../docs/DEVELOPMENT.md)，安装包见 [Releases](https://github.com/rw0104/kiroaccout/releases)。

正式版保持 **1.7.6**；当前源码对应 **1.7.7-rc.1 候选版**，增加统一网页登录、JSON 导出控制和基于 Windows 独立用户的 Kiro 客户端多开。候选版 Runtime 最小调用已返回 HTTP 200 与预期响应；新增门户授权和跨用户 GUI 尚待实测，RC 不进入稳定版自动更新。

在“添加账户 → 在线登录 → 打开 Kiro 网页登录”进行门户登录。在“账户管理”或“设置 → 数据管理 → 导出”选择全部/选中、完整备份 JSON 或精简凭证 JSON。默认不含凭证，不能恢复登录；需要迁移登录信息时明确勾选包含凭证，并妥善保存明文文件。

“Kiro 隔离多开”需要不同的普通 Windows 本地用户，各自初始化配置目录、安装官方签名 Kiro 并独立授权。系统 `runas` 窗口收取目标用户密码，管理器不保存密码。机器级网络、代理和证书仍共享；不同安装目录和 ZIP 不能隔离账户管理器自身。

[候选版说明](../docs/releases/v1.7.7-rc.1.md) · [本轮需求](../docs/requirements/2026-10-20-isolation-export-current-client.md) · [AGPL-3.0](../LICENSE) · [开源来源说明](../docs/NOTICE.md) · [English](README.md)
