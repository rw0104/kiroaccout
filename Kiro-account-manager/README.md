# kiroaccout application

Electron application source. See the [project README](../README.md), [development guide](../docs/DEVELOPMENT.md), [stable download](https://github.com/rw0104/kiroaccout/releases/latest) and [all releases](https://github.com/rw0104/kiroaccout/releases).

Stable remains **1.7.6**. This source targets **1.7.7-rc.1**, a candidate with portal sign-in, JSON export controls and Windows-user-based Kiro client instances. A live minimal Runtime call through the new adapter returned HTTP 200 and the expected response. Portal authentication and cross-user GUI operation still require validation. This RC is not distributed through stable automatic updates.

Use Add Account → Online Login → Sign in on Kiro website for portal login. For exports, select all or selected accounts, then Backup JSON or Credential JSON. Credentials are excluded by default; that export cannot restore login. Explicitly opt in to include credentials when needed and keep the resulting plain-text file private.

Kiro instances require separate initialized standard Windows local users and their own signed official Kiro installations. The system `runas` window collects the target user's password; the manager never stores it. Network, machine-wide proxy and certificates remain shared. A separate install directory or ZIP does not isolate the account manager itself.

[RC notes](../docs/releases/v1.7.7-rc.1.md) · [Requirements](../docs/requirements/2026-10-20-isolation-export-current-client.md) · [AGPL-3.0](../LICENSE) · [Source attribution](../docs/NOTICE.md) · [中文](README_CN.md)
