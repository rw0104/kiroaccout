import * as fs from 'node:fs'
import * as path from 'node:path'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto'

export interface SystemSecretStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecureStoreError extends Error {}
const MAIN = 'kiro-accounts.secure.json'
const BACKUP = 'kiro-accounts.secure.backup'
const KEY = 'kiro-accounts.key.enc'
const MIGRATION_ARCHIVE = 'kiro-accounts.migration.enc'
const AAD = Buffer.from('kiro-account-manager/store/v1')
const MAX_BYTES = 64 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T

export function systemEncryptionAvailable(secrets: SystemSecretStorage, platform: string): boolean {
  try {
    if (!secrets.isEncryptionAvailable()) return false
    if (platform !== 'linux') return true
    const backend = secrets.getSelectedStorageBackend?.()
    return !!backend && backend !== 'basic_text' && backend !== 'unknown'
  } catch { return false }
}

function regularFile(filename: string): boolean {
  try {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw new SecureStoreError('安全存储文件无效或过大，原文件未更改。')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Atomic replacement only ever writes ciphertext, including temporary files. */
export function writeEncryptedFile(filename: string, bytes: Buffer | string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temporary, filename)
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(filename), 'r')
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
  } catch {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch { /* No sensitive plaintext was written. */ }
    throw new SecureStoreError('安全存储写入失败，请检查磁盘空间和文件权限。')
  }
}

function encode(values: Record<string, unknown>, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const content = JSON.stringify(values)
  if (Buffer.byteLength(content) > MAX_BYTES / 2) throw new SecureStoreError('安全存储数据过大，未保存。')
  const data = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
}

function decode(raw: string, key: Buffer): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(raw)
    if (!object(doc) || doc.version !== 1 || typeof doc.iv !== 'string' || typeof doc.tag !== 'string' || typeof doc.data !== 'string') throw Error()
    const iv = Buffer.from(doc.iv, 'base64'), tag = Buffer.from(doc.tag, 'base64')
    if (iv.length !== 12 || tag.length !== 16) throw Error()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD); decipher.setAuthTag(tag)
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8'))
    if (!object(parsed)) throw Error()
    return parsed
  } catch { throw new SecureStoreError('安全存储损坏或无法解密，请保留文件并从安全备份恢复。') }
}

/** Read-only migration compatibility. This public key is never used to save new data. */
function readLegacy(filename: string): Record<string, unknown> {
  const bytes = fs.readFileSync(filename)
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    if (object(parsed)) return parsed
  } catch { /* Legacy electron-store may be encrypted. */ }
  const iv = bytes.subarray(0, 16)
  if (iv.length === 16 && bytes[16] === 58) {
    for (const salt of [iv, iv.toString()]) {
      try {
        const key = pbkdf2Sync('kiro-account-manager-secret-key', salt, 10000, 32, 'sha512')
        const decipher = createDecipheriv('aes-256-cbc', key, iv)
        const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(17)), decipher.final()]).toString('utf8'))
        if (object(parsed)) return parsed
      } catch { /* Support both historically used salt encodings. */ }
    }
  }
  throw new SecureStoreError('旧账户库损坏，未迁移或覆盖；请先恢复备份。')
}

function isAccountBackup(value: unknown): value is Record<string, unknown> {
  return object(value) && object(value.accounts)
}

export interface SecureStore {
  path: string
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

export function openSecureStore(directory: string, secrets: SystemSecretStorage, platform: string = process.platform): SecureStore {
  if (!systemEncryptionAvailable(secrets, platform)) {
    throw new SecureStoreError('系统安全存储不可用。请解锁系统钥匙串或启用 Secret Service/KWallet 后重试；账户文件未更改。')
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, MAIN), backup = path.join(directory, BACKUP), keyPath = path.join(directory, KEY)
  const hasMain = regularFile(filename), hasBackup = regularFile(backup)
  const hasArchive = regularFile(path.join(directory, MIGRATION_ARCHIVE))
  let key: Buffer
  if (regularFile(keyPath)) {
    try {
      const decoded = secrets.decryptString(fs.readFileSync(keyPath))
      if (!/^[a-f0-9]{64}$/.test(decoded)) throw Error()
      key = Buffer.from(decoded, 'hex')
    } catch { throw new SecureStoreError('无法解密账户密钥，请使用原系统用户并解锁安全存储。') }
  } else {
    if (hasMain || hasBackup || hasArchive) throw new SecureStoreError('账户密钥文件缺失，未生成替代密钥或覆盖账户库。')
    try {
      key = randomBytes(32)
      const encryptedKey = secrets.encryptString(key.toString('hex'))
      if (secrets.decryptString(encryptedKey) !== key.toString('hex')) throw Error()
      writeEncryptedFile(keyPath, encryptedKey)
    } catch { throw new SecureStoreError('系统安全存储无法保护账户密钥，旧账户文件未更改。') }
  }

  let values: Record<string, unknown>
  if (!hasMain && !hasBackup && hasArchive) throw new SecureStoreError('安全主库与备份缺失，已保留迁移归档；请先恢复备份，未创建空账户库。')
  if (hasMain || hasBackup) {
    try {
      if (!hasMain) throw Error()
      values = decode(fs.readFileSync(filename, 'utf8'), key)
    } catch {
      if (!hasBackup) throw new SecureStoreError('安全存储损坏且无可用备份，未覆盖文件。')
      const raw = fs.readFileSync(backup, 'utf8')
      values = decode(raw, key)
      writeEncryptedFile(filename, raw)
    }
  } else {
    const legacy = path.join(directory, 'kiro-accounts.json')
    let legacyDamaged = false
    values = {}
    if (regularFile(legacy)) {
      try { values = readLegacy(legacy) } catch { legacyDamaged = true }
    }
    if (!values.accountData) {
      const encryptedBackup = path.join(directory, 'kiro-accounts.backup.enc')
      const plainBackup = path.join(directory, 'kiro-accounts.backup.json')
      let foundBackup = false
      if (regularFile(encryptedBackup)) {
        foundBackup = true
        try {
          const candidate: unknown = JSON.parse(secrets.decryptString(fs.readFileSync(encryptedBackup)))
          if (isAccountBackup(candidate)) values.accountData = candidate
        } catch { /* Only a validated alternative may be used below. */ }
      }
      if (!values.accountData && regularFile(plainBackup)) {
        foundBackup = true
        const candidate = readLegacy(plainBackup)
        if (isAccountBackup(candidate)) values.accountData = candidate
      }
      if (foundBackup && !isAccountBackup(values.accountData)) throw new SecureStoreError('旧账户备份损坏或无法解密，未迁移或覆盖文件。')
    }
    if (legacyDamaged && !isAccountBackup(values.accountData)) throw new SecureStoreError('旧账户库损坏且没有有效备份，未迁移或覆盖文件。')
    const encrypted = encode(values, key)
    writeEncryptedFile(backup, encrypted)
    writeEncryptedFile(filename, encrypted)
    decode(fs.readFileSync(filename, 'utf8'), key)
  }

  // Preserve every old file in an authenticated archive, including a backup
  // that was not selected. A retry after interrupted cleanup must not replace it.
  const archive = path.join(directory, MIGRATION_ARCHIVE)
  const oldFiles: Record<string, string> = {}
  for (const name of ['kiro-accounts.json', 'kiro-accounts.backup.json']) {
    const legacy = path.join(directory, name)
    if (regularFile(legacy)) oldFiles[name] = fs.readFileSync(legacy).toString('base64')
  }
  if (Object.keys(oldFiles).length) {
    if (regularFile(archive)) {
      const saved = decode(fs.readFileSync(archive, 'utf8'), key)
      if (Object.entries(oldFiles).some(([name, value]) => saved[name] !== value)) {
        throw new SecureStoreError('旧版账户文件在迁移后发生变化，已保留两份资料；请先备份并核对旧版数据。')
      }
    }
    else {
      writeEncryptedFile(archive, encode(oldFiles, key))
      decode(fs.readFileSync(archive, 'utf8'), key)
    }
  }
  for (const name of ['kiro-accounts.json', 'kiro-accounts.backup.json']) {
    const legacy = path.join(directory, name)
    if (regularFile(legacy)) {
      try { fs.unlinkSync(legacy) } catch { throw new SecureStoreError('账户已安全迁移，但旧账户文件无法清理；请检查文件权限后重试。') }
    }
  }
  return {
    path: filename,
    get(name, fallback) { return clone(Object.hasOwn(values, name) ? values[name] : fallback) },
    set(name, value) {
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new SecureStoreError('安全存储字段无效。')
      const next = clone({ ...values, [name]: value })
      const encrypted = encode(next, key)
      // Authentication is checked before replacing a known-good generation.
      const previous = fs.readFileSync(filename, 'utf8')
      decode(previous, key)
      writeEncryptedFile(backup, previous)
      writeEncryptedFile(filename, encrypted)
      values = next
    }
  }
}
