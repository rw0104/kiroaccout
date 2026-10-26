// 安全备份：用 Electron safeStorage（OS 级加密：Windows DPAPI / macOS Keychain / Linux libsecret）
// 加密容灾备份文件，避免账号 token、代理账密以明文 JSON 落在磁盘上。
//
// 策略：
//   - 写：safeStorage 可用 → 写加密文件 *.backup.enc
//          不可用时拒绝写入，不降级为明文或 Linux basic_text
//   - 读：优先解密 *.backup.enc；失败/不存在再读旧明文 *.backup.json（平滑迁移）

import { safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { SecureStoreError, systemEncryptionAvailable, writeEncryptedFile, managedBackupDigest, ACCOUNT_BACKUP_NAME, ACCOUNT_BACKUP_STATE_NAME } from './secureStore'

const ENC_NAME = ACCOUNT_BACKUP_NAME
const LEGACY_JSON_NAME = 'kiro-accounts.backup.json'

function encPath(dir: string): string {
  return path.join(dir, ENC_NAME)
}
function legacyPath(dir: string): string {
  return path.join(dir, LEGACY_JSON_NAME)
}

function optionalFile(filename: string): Buffer | undefined {
  try {
    const stat = fsSync.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new SecureStoreError('账户备份文件无效或过大，未覆盖文件。')
    return fsSync.readFileSync(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

function retainedMatches(retained: Buffer, original: Buffer): boolean {
  if (retained.equals(original)) return true
  try {
    const doc = JSON.parse(safeStorage.decryptString(retained))
    return doc?.kind === 'kiro-account-manager/retained-backup/v1' && doc.data === original.toString('base64')
  } catch { return false }
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
    const marker = safeStorage.encryptString(JSON.stringify({ version: 1, digest: digest(enc) }))
    const previous = optionalFile(encPath(dir))
    const statePath = path.join(dir, ACCOUNT_BACKUP_STATE_NAME)
    if (previous && digest(previous) !== managedBackupDigest(optionalFile(statePath), safeStorage)) {
      const retainedPath = path.join(dir, `kiro-accounts.backup.retained-${digest(previous)}.enc`)
      const existing = optionalFile(retainedPath)
      if (!existing) {
        let retained = previous
        try { safeStorage.decryptString(previous) } catch {
          // A damaged .enc may contain arbitrary bytes. Wrap them before writing.
          retained = safeStorage.encryptString(JSON.stringify({ kind: 'kiro-account-manager/retained-backup/v1', data: previous.toString('base64') }))
        }
        writeEncryptedFile(retainedPath, retained)
      }
      if (!retainedMatches(optionalFile(retainedPath)!, previous)) throw new SecureStoreError('旧账户备份保全校验失败，未覆盖现有备份。')
    }
    const current = optionalFile(encPath(dir))
    if ((previous === undefined) !== (current === undefined) || (previous && !previous.equals(current!))) {
      throw new SecureStoreError('账户备份在保存期间发生变化，未覆盖文件；请退出其他版本后重试。')
    }
    writeEncryptedFile(encPath(dir), enc)
    writeEncryptedFile(statePath, marker)
    // Only secureStore's verified migration may clean legacy files. A later
    // plaintext backup can contain unresolved changes from another version.
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
