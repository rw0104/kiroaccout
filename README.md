# kiroaccout

[中文](README_CN.md) · [Repository](https://github.com/rw0104/kiroaccout)

An Electron desktop Kiro account manager, derived from [chaogei/Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager) by [chaogei](https://github.com/chaogei). Licensed under [AGPL-3.0](LICENSE).

JSON/OIDC import and local authentication-session fixes are merged. [Download the Windows x64 v1.7.6-rc.1 prerelease](https://github.com/rw0104/kiroaccout/releases/tag/v1.7.6-rc.1): installer, ZIP and SHA-256 checksums. Real desktop authentication still requires acceptance testing in an isolated environment.

- [Requirements](docs/2026-10-19-account-import-login/01-requirements.md)
- [Analysis](docs/2026-10-19-account-import-login/02-analysis.md)
- [Remediation plan](docs/2026-10-19-account-import-login/03-remediation-plan.md)
- [Project rules](AGENTS.md) and [development isolation](docs/development-rules.md)
- [Development and Windows release guide](docs/DEVELOPMENT.md)
- [Application source](Kiro-account-manager/)

Development and testing must remain isolated from the running 1.7.5 installation, production account data and shared authentication caches. Follow the isolation rules before launching a development client.
