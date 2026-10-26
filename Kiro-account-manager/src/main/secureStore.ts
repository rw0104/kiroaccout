import * as fs from 'node:fs'
import * as path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto'

export interface SystemSecretStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecureStoreError extends Error {}
export interface LegacyStoreFile {
  name: string
  bytes: number
  modifiedAt: number
}

export class LegacyMigrationConflictError extends SecureStoreError {
  readonly code = 'legacy-migration-conflict'
  readonly fingerprint: string
  readonly archiveName: string
  readonly files: readonly LegacyStoreFile[]

  constructor(fingerprint: string, files: readonly LegacyStoreFile[]) {
    super('旧版账户文件在迁移后发生变化，已保留两份资料；请先备份并核对旧版数据。')
    this.name = 'LegacyMigrationConflictError'
    this.fingerprint = fingerprint
    this.archiveName = `kiro-accounts.recovery-${fingerprint}.enc`
    this.files = files
  }
}

const MAIN = 'kiro-accounts.secure.json'
const BACKUP = 'kiro-accounts.secure.backup'
const KEY = 'kiro-accounts.key.enc'
const MIGRATION_ARCHIVE = 'kiro-accounts.migration.enc'
const LEGACY_FILES = ['kiro-accounts.json', 'kiro-accounts.backup.json'] as const
const RECOVERY_KIND = 'kiro-account-manager/legacy-recovery/v1'
const RECOVERY_NAME = /^kiro-accounts\.(?:recovery|repair)-[a-f0-9]{64}\.enc$|^kiro-accounts\.backup\.retained-[a-f0-9]{64}\.enc$/
const RECOVERY_STATE = '__legacyRecovery'
export const ACCOUNT_BACKUP_NAME = 'kiro-accounts.backup.enc'
export const ACCOUNT_BACKUP_STATE_NAME = 'kiro-accounts.backup.state.enc'
const PROTECTED_FILES = [MAIN, BACKUP, KEY, MIGRATION_ARCHIVE, ACCOUNT_BACKUP_NAME, ACCOUNT_BACKUP_STATE_NAME]
const AAD = Buffer.from('kiro-account-manager/store/v1')
const MAX_BYTES = 64 * 1024 * 1024
// A recovery envelope contains several base64-encoded generations, not one store.
const MAX_RECOVERY_BYTES = 512 * 1024 * 1024
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

function regularFile(filename: string, maxBytes = MAX_BYTES): boolean {
  try {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new SecureStoreError('安全存储文件无效或过大，原文件未更改。')
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

function encode(values: Record<string, unknown>, key: Buffer, maxBytes = MAX_BYTES / 2): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const content = JSON.stringify(values)
  if (Buffer.byteLength(content) > maxBytes) throw new SecureStoreError('安全存储数据过大，未保存。')
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
function readLegacy(bytes: Buffer): Record<string, unknown> {
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

export interface SecureStoreOpenOptions {
  /** Set only after the user explicitly chooses to retain the legacy data and use the secure store. */
  legacyRecoveryFingerprint?: string
}

function legacyFiles(directory: string): { contents: Record<string, string>; files: LegacyStoreFile[] } {
  const contents: Record<string, string> = {}, files: LegacyStoreFile[] = []
  for (const name of LEGACY_FILES) {
    const filename = path.join(directory, name)
    if (!regularFile(filename)) continue
    const bytes = fs.readFileSync(filename)
    contents[name] = bytes.toString('base64')
    files.push({ name, bytes: bytes.length, modifiedAt: fs.statSync(filename).mtimeMs })
  }
  return { contents, files }
}

function sameFiles(left: unknown, right: Record<string, string>): boolean {
  return object(left) && Object.keys(left).length === Object.keys(right).length &&
    Object.entries(right).every(([name, value]) => left[name] === value)
}

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function protectedFiles(directory: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of PROTECTED_FILES) {
    const filename = path.join(directory, name)
    if (regularFile(filename)) result[name] = fs.readFileSync(filename).toString('base64')
  }
  return result
}

export function managedBackupDigest(state: Buffer | undefined, secrets: SystemSecretStorage): string | undefined {
  if (!state) return undefined
  try {
    const parsed: unknown = JSON.parse(secrets.decryptString(state))
    if (object(parsed) && parsed.version === 1 && typeof parsed.digest === 'string' && /^[a-f0-9]{64}$/.test(parsed.digest)) return parsed.digest
  } catch { /* An unknown writer's backup must be retained, not trusted. */ }
  return undefined
}

function recoveryArchive(directory: string, fingerprint: string, key: Buffer): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new SecureStoreError('账户恢复状态无效，未清理旧文件。')
  const filename = path.join(directory, `kiro-accounts.recovery-${fingerprint}.enc`)
  if (!regularFile(filename, MAX_RECOVERY_BYTES)) throw new SecureStoreError('账户恢复归档缺失，未清理旧文件；请保留资料后恢复备份。')
  const saved = decode(fs.readFileSync(filename, 'utf8'), key)
  if (saved.kind !== RECOVERY_KIND || saved.fingerprint !== fingerprint || !object(saved.legacyFiles) || !object(saved.secureFiles) ||
      typeof saved.secureFiles[KEY] !== 'string' || (typeof saved.secureFiles[MAIN] !== 'string' && typeof saved.secureFiles[BACKUP] !== 'string')) {
    throw new SecureStoreError('账户恢复归档不完整，未覆盖归档或清理旧文件。')
  }
  return saved
}

export function openSecureStore(directory: string, secrets: SystemSecretStorage, platform: string = process.platform, options: SecureStoreOpenOptions = {}): SecureStore {
  if (!systemEncryptionAvailable(secrets, platform)) {
    throw new SecureStoreError('系统安全存储不可用。请解锁系统钥匙串或启用 Secret Service/KWallet 后重试；账户文件未更改。')
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, MAIN), backup = path.join(directory, BACKUP), keyPath = path.join(directory, KEY)
  const hasMain = regularFile(filename), hasBackup = regularFile(backup)
  const hasArchive = regularFile(path.join(directory, MIGRATION_ARCHIVE))
  const hasRecovery = fs.readdirSync(directory).some(name => RECOVERY_NAME.test(name))
  let key: Buffer
  if (regularFile(keyPath)) {
    try {
      const decoded = secrets.decryptString(fs.readFileSync(keyPath))
      if (!/^[a-f0-9]{64}$/.test(decoded)) throw Error()
      key = Buffer.from(decoded, 'hex')
    } catch { throw new SecureStoreError('无法解密账户密钥，请使用原系统用户并解锁安全存储。') }
  } else {
    if (hasMain || hasBackup || hasArchive || hasRecovery) throw new SecureStoreError('账户密钥文件缺失，未生成替代密钥或覆盖账户库。')
    try {
      key = randomBytes(32)
      const encryptedKey = secrets.encryptString(key.toString('hex'))
      if (secrets.decryptString(encryptedKey) !== key.toString('hex')) throw Error()
      writeEncryptedFile(keyPath, encryptedKey)
    } catch { throw new SecureStoreError('系统安全存储无法保护账户密钥，旧账户文件未更改。') }
  }

  let values: Record<string, unknown>
  if (!hasMain && !hasBackup && (hasArchive || hasRecovery)) {
    throw new SecureStoreError(hasArchive
      ? '安全主库与备份缺失，已保留迁移归档；请先恢复备份，未创建空账户库。'
      : '安全主库与备份缺失，已保留恢复归档；请先恢复备份，未创建空账户库。')
  }
  // Parse, migrate and archive exactly the same source generation. In particular,
  // do not archive a later legacy write as though it had already been imported.
  const migrationSources = legacyFiles(directory)
  let sourceFiles = protectedFiles(directory)
  let primaryRepair: string | undefined
  if (hasMain || hasBackup) {
    try {
      if (!hasMain) throw Error()
      values = decode(Buffer.from(sourceFiles[MAIN], 'base64').toString('utf8'), key)
    } catch {
      if (!hasBackup) throw new SecureStoreError('安全存储损坏且无可用备份，未覆盖文件。')
      const raw = Buffer.from(sourceFiles[BACKUP], 'base64').toString('utf8')
      values = decode(raw, key)
      // The original damaged primary remains untouched while recovery is pending.
      primaryRepair = raw
    }
  } else {
    let legacyDamaged = false
    values = {}
    if (migrationSources.contents['kiro-accounts.json']) {
      try { values = readLegacy(Buffer.from(migrationSources.contents['kiro-accounts.json'], 'base64')) } catch { legacyDamaged = true }
    }
    if (!values.accountData) {
      let foundBackup = false
      if (sourceFiles[ACCOUNT_BACKUP_NAME]) {
        foundBackup = true
        try {
          const candidate: unknown = JSON.parse(secrets.decryptString(Buffer.from(sourceFiles[ACCOUNT_BACKUP_NAME], 'base64')))
          if (isAccountBackup(candidate)) values.accountData = candidate
        } catch { /* Only a validated alternative may be used below. */ }
      }
      if (!values.accountData && migrationSources.contents['kiro-accounts.backup.json']) {
        foundBackup = true
        const candidate = readLegacy(Buffer.from(migrationSources.contents['kiro-accounts.backup.json'], 'base64'))
        if (isAccountBackup(candidate)) values.accountData = candidate
      }
      if (foundBackup && !isAccountBackup(values.accountData)) throw new SecureStoreError('旧账户备份损坏或无法解密，未迁移或覆盖文件。')
    }
    if (legacyDamaged && !isAccountBackup(values.accountData)) throw new SecureStoreError('旧账户库损坏且没有有效备份，未迁移或覆盖文件。')
    const encrypted = encode(values, key)
    writeEncryptedFile(backup, encrypted)
    writeEncryptedFile(filename, encrypted)
    decode(fs.readFileSync(filename, 'utf8'), key)
    sourceFiles = protectedFiles(directory)
  }

  // Preserve every old file in an authenticated archive, including a backup
  // that was not selected. A retry after interrupted cleanup must not replace it.
  const archive = path.join(directory, MIGRATION_ARCHIVE)
  if (!hasMain && !hasBackup && Object.keys(migrationSources.contents).length && !regularFile(archive)) {
    writeEncryptedFile(archive, encode(migrationSources.contents, key))
    decode(fs.readFileSync(archive, 'utf8'), key)
    sourceFiles[MIGRATION_ARCHIVE] = fs.readFileSync(archive).toString('base64')
  }
  const { contents: oldFiles, files } = legacyFiles(directory)
  let preserveLegacy = false
  const state = object(values[RECOVERY_STATE]) ? values[RECOVERY_STATE] : undefined
  const backupBytes = sourceFiles[ACCOUNT_BACKUP_NAME]
  const backupDigest = backupBytes === undefined ? null : digest(Buffer.from(backupBytes, 'base64'))
  const knownBackup = managedBackupDigest(sourceFiles[ACCOUNT_BACKUP_STATE_NAME] ? Buffer.from(sourceFiles[ACCOUNT_BACKUP_STATE_NAME], 'base64') : undefined, secrets)
  const backupChanged = !!state && backupDigest !== state.backupDigest && backupDigest !== knownBackup
  if (Object.keys(oldFiles).length || backupChanged) {
    let archiveBytes: string | null = null
    let conflict = hasMain || hasBackup || backupChanged
    if (regularFile(archive)) {
      archiveBytes = fs.readFileSync(archive, 'utf8')
      const saved = decode(archiveBytes, key)
      conflict = backupChanged || Object.entries(oldFiles).some(([name, value]) => saved[name] !== value)
    }
    if (conflict) {
      const sourceFingerprint = digest(JSON.stringify({ archive: archiveBytes, files: oldFiles }))
      const fingerprint = digest(JSON.stringify({ sourceFingerprint, backupDigest, generations: sourceFiles }))
      if (backupBytes !== undefined && backupDigest !== knownBackup) {
        files.push({ name: ACCOUNT_BACKUP_NAME, bytes: Buffer.from(backupBytes, 'base64').length, modifiedAt: fs.statSync(path.join(directory, ACCOUNT_BACKUP_NAME)).mtimeMs })
      }
      const error = new LegacyMigrationConflictError(fingerprint, files)
      const approved = state?.sourceFingerprint === sourceFingerprint && !backupChanged && typeof state.fingerprint === 'string'
      if (approved) {
        const saved = recoveryArchive(directory, state.fingerprint as string, key)
        if (!sameFiles(saved.legacyFiles, oldFiles)) throw new SecureStoreError('账户恢复归档与当前资料不匹配，未清理旧文件。')
      } else {
        if (options.legacyRecoveryFingerprint !== fingerprint) throw error
        const recoveryPath = path.join(directory, error.archiveName)
        if (!regularFile(recoveryPath, MAX_RECOVERY_BYTES)) {
          writeEncryptedFile(recoveryPath, encode({ kind: RECOVERY_KIND, fingerprint, legacyFiles: oldFiles, secureFiles: sourceFiles }, key, MAX_RECOVERY_BYTES / 2))
        }
        const saved = recoveryArchive(directory, fingerprint, key)
        if (!sameFiles(saved.legacyFiles, oldFiles) || !sameFiles(saved.secureFiles, sourceFiles)) {
          throw new SecureStoreError('账户恢复归档校验失败，未清理旧文件。')
        }
      }
      // Never remove conflict sources. Another version may still be writing them.
      if (!sameFiles(legacyFiles(directory).contents, oldFiles) || !sameFiles(protectedFiles(directory), sourceFiles)) {
        throw new SecureStoreError('账户资料在备份期间发生变化，未清理任何旧文件；请退出其他版本后重试。')
      }
      if (!approved) {
        const next = { ...values, [RECOVERY_STATE]: { fingerprint, sourceFingerprint, backupDigest } }
        const previous = primaryRepair ?? Buffer.from(sourceFiles[MAIN], 'base64').toString('utf8')
        decode(previous, key)
        writeEncryptedFile(backup, previous)
        writeEncryptedFile(filename, encode(next, key))
        values = next
        primaryRepair = undefined
      }
      preserveLegacy = true
    }
    else if (archiveBytes === null) {
      writeEncryptedFile(archive, encode(oldFiles, key))
      decode(fs.readFileSync(archive, 'utf8'), key)
    }
  }
  if (primaryRepair !== undefined) {
    if (!sameFiles(protectedFiles(directory), sourceFiles)) throw new SecureStoreError('安全主库在恢复期间发生变化，未覆盖文件；请退出其他版本后重试。')
    if (sourceFiles[MAIN] !== undefined) {
      const repairPath = path.join(directory, `kiro-accounts.repair-${digest(Buffer.from(sourceFiles[MAIN], 'base64'))}.enc`)
      if (!regularFile(repairPath, MAX_RECOVERY_BYTES)) {
        writeEncryptedFile(repairPath, encode({ kind: 'kiro-account-manager/primary-repair/v1', data: sourceFiles[MAIN] }, key, MAX_RECOVERY_BYTES / 2))
      }
      const saved = decode(fs.readFileSync(repairPath, 'utf8'), key)
      if (saved.kind !== 'kiro-account-manager/primary-repair/v1' || saved.data !== sourceFiles[MAIN]) throw new SecureStoreError('损坏主库的恢复归档校验失败，未覆盖原文件。')
    }
    writeEncryptedFile(filename, primaryRepair)
  }
  if (!preserveLegacy && !sameFiles(legacyFiles(directory).contents, oldFiles)) {
    throw new SecureStoreError('旧版资料在迁移期间再次变化，未清理旧文件；请退出其他版本后重试。')
  }
  for (const name of preserveLegacy ? [] : LEGACY_FILES) {
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
