# kiroaccout

Kiro 账户管理桌面应用，用于管理账户、分组和标签，导入、导出 JSON，并查看账户状态。

[正式版下载](https://github.com/rw0104/kiroaccout/releases/latest) · [全部版本](https://github.com/rw0104/kiroaccout/releases) · [源码与问题反馈](https://github.com/rw0104/kiroaccout) · [开发文档](docs/DEVELOPMENT.md)

当前正式版为 **1.7.6**；本分支新增功能对应 **1.7.7-rc.1 候选版**。候选版 Runtime 最小请求已实测通过；新增门户授权和跨 Windows 用户多开尚待实机验收，不会推送给稳定版用户。安装到不同目录或使用 ZIP，均不会隔离账户管理器自身的数据；升级前先备份，不要同时运行新旧管理器。

[项目首页](README.md)

## 使用候选版新增功能

- 网页登录：打开“添加账户 → 在线登录 → 打开 Kiro 网页登录”，在网页选择 Builder ID、Google、GitHub 或组织账户；授权后通过本地回调继续添加。旧登录入口作为兼容方式保留。
- 导入 JSON：在“账户管理”导入文件，或在“添加账户 → OIDC 凭证 → 批量”粘贴凭证。
- 导出 JSON：在“账户管理”或“设置 → 数据管理 → 导出”选择全部/选中账户、完整备份 JSON 或精简凭证 JSON。**默认不含登录凭证，只能恢复账户资料；要迁移登录信息，必须明确勾选“包含登录凭证”。** 含凭证文件为明文，请妥善保管。
- Kiro 客户端多开：打开独立的“Kiro 隔离多开”页面，为不同的普通 Windows 本地用户添加各自安装的官方 Kiro。目标用户须预先创建、登录一次以初始化配置目录，并使用独立授权的账户。启动时在系统 `runas` 窗口输入该用户密码，管理器不保存密码。
- 检查正式更新：打开“关于 → 检查更新”，按提示下载并确认安装。

Kiro 客户端多开采用 Windows 用户身份分离，目录和数字签名无法验证时会拒绝启动。系统网络、机器级代理和证书仍共用；这不是虚拟机，也不代表管理器本身已隔离。

[候选版说明](docs/releases/v1.7.7-rc.1.md) · [本轮需求](docs/requirements/2026-10-20-isolation-export-current-client.md) · [当前客户端请求证据](docs/evidence/2026-10-20-current-kiro-requests.md)

本项目遵循 [AGPL-3.0](LICENSE)，开源来源和适用声明见 [NOTICE](docs/NOTICE.md)。
