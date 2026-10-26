# kiroaccout application

Electron application source. See the [project README](../README.md), [stable download](https://github.com/rw0104/kiroaccout/releases/latest) and [all releases](https://github.com/rw0104/kiroaccout/releases).

This source targets **1.8.13 · Windows / macOS / Linux**. Release availability and assets are listed in Releases. Account binding and rotation protection have synthetic-data regression coverage; login and refresh with two real bound accounts have not been validated. Runtime checks succeeded in one Social session; see the release notes for the scope of validation.

Migration recovery: if changed legacy data blocks startup after upgrading, choose the recovery option to back up both generations and use the existing secure store. Legacy accounts and credentials are not merged automatically. Keep the entire data directory and its key for later comparison.

Use Add Account → Online Login → Sign in on Kiro website for portal login. For exports, select all or selected accounts, then Backup JSON or Credential JSON. Credentials are excluded by default; that export cannot restore login. Explicitly opt in to include credentials when needed and keep the resulting plain-text file private.

Security update: HTTPS proxy traffic verifies destination certificates, remote images are restricted to public addresses, and inference keys cannot use HTTP admin endpoints. Account data migrates to an OS-protected encrypted store on first launch. Unlock your OS keychain before starting; migrate between computers using an explicit credential export.

Kiro Settings now supports Memory and Workflows for the default IDE or a selected managed instance. Saves retain JSONC comments and unrelated settings. Account search also accepts original import names; model cards show documented context tiers when they match the current catalog rate.

Kiro instances share one installed official Kiro.exe and use separate managed profile, home, extension, shared-data and temporary directories. Choose the executable, an instance name and an existing managed account, then create and start the instance. Its credentials are written only to that instance's cache. The instance can renew an expired access token; an invalid refresh token or expired IdC registration requires reauthorization. No extra Windows users, separate installations or system passwords are required.

Creating a configuration only records the account selection. If preparation fails before a client is started, the account remains available in the manager and the configuration can be removed directly. After launch handoff, the instance owns refresh for that account; the manager blocks duplicate binding, refresh and account switching. Copying the cache preserves the original account's provider, login method and profile; verified credential changes synchronize only tokens and expiry. A read-only comparison with the default IDE cache rejects shared credentials before launch; that cache is not copied or modified. Stop the instance and synchronize its latest credentials before removing the binding. Signing into a different account inside the IDE must not overwrite the original managed account. Do not refresh the same account through an older manager or another client at the same time.

If missing or expired cache data or a changed IDE account prevents synchronization, stop the instance and explicitly confirm recovery detachment. All instance files remain, unverified credentials are not imported, and the original account requires reauthorization.

The instance page provides observed state, graceful stop and restart. Unsaved changes can prevent closure; no automatic force kill is performed. Removing a configuration preserves profile files. Old RC Windows-user configurations are inactive and must be recreated. Network, proxy, certificates, the Windows identity and DPAPI remain shared; this is not a security sandbox. A separate install directory or ZIP does not isolate the account manager itself.

[1.8.13 notes](../docs/releases/v1.8.13.md) · [AGPL-3.0](../LICENSE) · [Source attribution](../docs/NOTICE.md) · [中文](README_CN.md)
