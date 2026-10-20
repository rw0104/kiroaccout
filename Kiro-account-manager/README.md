# kiroaccout application

[中文](README_CN.md) · [Project README](../README.md) · [Repository](https://github.com/rw0104/kiroaccout)

This directory contains the Electron application, derived from [chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager) by [chaogei](https://github.com/chaogei), under [AGPL-3.0](../LICENSE).

JSON import, OIDC batch input and online login fixes are in development. See the [requirements](../docs/2026-10-19-account-import-login/01-requirements.md), [analysis](../docs/2026-10-19-account-import-login/02-analysis.md) and [remediation plan](../docs/2026-10-19-account-import-login/03-remediation-plan.md).

Follow the [project rules](../AGENTS.md) and [isolation requirements](../docs/development-rules.md). Keep development and testing isolated from the running 1.7.5 installation and its account data. Real desktop authentication still requires acceptance testing.
