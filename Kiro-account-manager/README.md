# kiroaccout application

[中文](README_CN.md) · [Project README](../README.md) · [Repository](https://github.com/rw0104/kiroaccout)

This directory contains the Electron application, derived from [chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager) by [chaogei](https://github.com/chaogei), under [AGPL-3.0](../LICENSE).

JSON/OIDC import and local login-session fixes are merged. [Windows x64 v1.7.6-rc.1](https://github.com/rw0104/kiroaccout/releases/tag/v1.7.6-rc.1) is available for isolated acceptance testing. See the [development guide](../docs/DEVELOPMENT.md), [requirements](../docs/2026-10-19-account-import-login/01-requirements.md) and [implementation record](../docs/2026-10-19-account-import-login/05-implementation-status.md).

Follow the [project rules](../AGENTS.md) and [isolation requirements](../docs/development-rules.md). Keep development and testing isolated from the running 1.7.5 installation and its account data. Real desktop authentication still requires acceptance testing.
