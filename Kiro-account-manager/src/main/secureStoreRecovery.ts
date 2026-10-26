import {
  openSecureStore,
  LegacyMigrationConflictError,
  SecureStoreError,
  type SecureStore,
  type SystemSecretStorage
} from './secureStore'

export class SecureStoreRecoveryCancelled extends Error {}

export interface SecureStoreRecoveryUI {
  choose(conflict: LegacyMigrationConflictError): Promise<'continue' | 'open-directory' | 'cancel'>
  openDirectory(directory: string): Promise<string | void>
}

/** No watchers, account operations or logging may start until this resolves. */
export async function openSecureStoreForStartup(
  directory: string,
  secrets: SystemSecretStorage,
  ui: SecureStoreRecoveryUI,
  platform: string = process.platform
): Promise<SecureStore> {
  let fingerprint: string | undefined
  let conflicts = 0
  for (;;) {
    try {
      return openSecureStore(directory, secrets, platform, { legacyRecoveryFingerprint: fingerprint })
    } catch (error) {
      if (!(error instanceof LegacyMigrationConflictError)) throw error
      if (++conflicts > 3) throw new SecureStoreError('旧版账户资料持续变化，未清理旧文件；请退出其他版本后重新启动。')
      for (;;) {
        const choice = await ui.choose(error)
        if (choice === 'open-directory') {
          let failure: string | void
          try { failure = await ui.openDirectory(directory) } catch { failure = 'open-failed' }
          if (failure) throw new SecureStoreError('无法打开账户数据目录；账户文件未清理，请检查目录权限后重试。')
          continue
        }
        if (choice !== 'continue') throw new SecureStoreRecoveryCancelled()
        fingerprint = error.fingerprint
        break
      }
    }
  }
}
