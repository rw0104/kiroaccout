// 安全备份：用 Electron safeStorage（OS 级加密：Windows DPAPI / macOS Keychain / Linux libsecret）
// 加密容灾备份文件，避免账号 token、代理账密以明文 JSON 落在磁盘上。
//
// 策略：
//   - 写：safeStorage 可用 → 写加密文件 *.backup.enc，并清理旧明文 *.backup.json
//          不可用时拒绝写入，不降级为明文或 Linux basic_text
//   - 读：优先解密 *.backup.enc；失败/不存在再读旧明文 *.backup.json（平滑迁移）

import { safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { SecureStoreError, systemEncryptionAvailable, writeEncryptedFile } from './secureStore'

const ENC_NAME = 'kiro-accounts.backup.enc'
const LEGACY_JSON_NAME = 'kiro-accounts.backup.json'

function encPath(dir: string): string {
  return path.join(dir, ENC_NAME)
}
function legacyPath(dir: string): string {
  return path.join(dir, LEGACY_JSON_NAME)
}

/** safeStorage 是否真正可用（部分 Linux 环境无密钥环时返回 false） */
export function isSecureBackupAvailable(): boolean {
  try {
    return systemEncryptionAvailable(safeStorage, process.platform)
  } catch {
    return false
  }
}

/** All new backups require a secure OS backend. */
export async function writeSecureBackup(dir: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data)
  if (isSecureBackupAvailable()) {
    const enc = safeStorage.encryptString(json)
    writeEncryptedFile(encPath(dir), enc)
    // 清理旧的明文备份，避免明文长期残留
    try { await fs.unlink(legacyPath(dir)) } catch { /* 不存在则忽略 */ }
    return
  }
  throw new SecureStoreError('系统安全存储不可用，未写入明文备份。')
}

/** 读备份：优先解密 .enc，失败再读旧明文 .json。返回 null 表示无可用备份 */
export async function readSecureBackup(dir: string): Promise<unknown | null> {
  if (!isSecureBackupAvailable()) throw new SecureStoreError('系统安全存储不可用，未读取凭证备份。')
  // 1) 加密备份
  if (isSecureBackupAvailable()) {
    try {
      const buf = await fs.readFile(encPath(dir))
      const json = safeStorage.decryptString(buf)
      return JSON.parse(json)
    } catch {
      /* .enc 不存在或解密失败 → 尝试明文 */
    }
  }
  // 2) 旧明文备份（平滑迁移）
  try {
    const content = await fs.readFile(legacyPath(dir), 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}
