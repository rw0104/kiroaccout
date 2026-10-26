import * as fs from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  KIRO_AUTO_APPROVAL_TEMPLATE_VERSION,
  KIRO_AUTO_APPROVAL_TEMPLATE_YAML,
  type KiroAutoApprovalCapability,
  type KiroPermissionsCompatibility,
  type KiroPermissionsErrorCode,
  type KiroPermissionsExportResult,
  type KiroPermissionsRestoreInfo,
  type KiroPermissionsRestoreResult,
  type KiroPermissionsRevision,
  type KiroPermissionsState,
  type KiroPermissionsStateResult,
  type KiroPermissionsTargetInfo,
  type KiroPermissionsWriteResult,
  type KiroSettingsTarget
} from '../shared/kiroPermissions'
import {
  MAX_PERMISSIONS_BYTES,
  KiroPermissionsError,
  emptyPermissionsInspection,
  inspectKiroPermissionsDocument,
  planKiroAutoApprovalMerge,
  sha256Buffer
} from './kiroPermissions'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:[+-][0-9A-Za-z.-]+)?$/

export interface KiroPermissionsStat {
  isSymbolicLink(): boolean
  isDirectory(): boolean
  isFile(): boolean
  size: number
  nlink?: number
}

export interface KiroPermissionsFileSystem {
  lstat(path: string): Promise<KiroPermissionsStat>
  realpath(path: string): Promise<string>
  mkdir(path: string, options?: { mode?: number }): Promise<unknown>
  readFile(path: string): Promise<Buffer>
  /** Read at most maxBytes + 1, so growth after lstat cannot allocate an unbounded buffer. */
  readFileBounded(path: string, maxBytes: number): Promise<Buffer>
  writeFile(
    path: string,
    data: Buffer | string,
    options?: { flag?: string; mode?: number }
  ): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const defaultPermissionsFileSystem: KiroPermissionsFileSystem = {
  lstat: path => fs.lstat(path),
  realpath: path => fs.realpath(path),
  mkdir: (path, options) => fs.mkdir(path, options),
  readFile: path => fs.readFile(path),
  readFileBounded: async (path, maxBytes) => {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
  },
  writeFile: (path, data, options) => fs.writeFile(path, data, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: path => fs.unlink(path)
}

export interface KiroPermissionsBackupManifest {
  schemaVersion: 1
  operationId: string
  target: KiroSettingsTarget
  canonicalPath: string
  originalExisted: boolean
  beforeHash: string | null
  afterHash: string
  templateVersion: string
  addedRules: KiroAutoApprovalCapability[]
  createdAt: string
  updatedAt: string
  stage: 'prepared' | 'applied' | 'restoring' | 'restored' | 'rolled_back' | 'conflict'
}

export interface KiroPermissionsServiceDependencies {
  platform: NodeJS.Platform
  homeDir: string
  backupRoot: string
  /** Explicit child environment; omitted in isolated callers rather than reading host globals. */
  env?: NodeJS.ProcessEnv
  resolveInstance(id: string): Promise<{
    label: string
    homeDir: string
    settingsPath: string
    accountId?: string
  }>
  inspectVersion?: (target: {
    type: 'default' | 'instance'
    instanceId?: string
    homeDir: string
  }) => Promise<string | undefined>
  chooseExportPath?: () => Promise<string | null>
  fileSystem?: KiroPermissionsFileSystem
  uuid?: () => string
  now?: () => Date
  beforeCommitHook?: (context: {
    action: 'apply' | 'restore'
    target: KiroSettingsTarget
    permissionsPath: string
    tempPath?: string
  }) => Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isAbsentError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function pathOpsFor(platform: NodeJS.Platform, samplePath?: string): typeof win32 | typeof posix {
  if (platform === 'win32' || (samplePath && /^[A-Za-z]:\\/.test(samplePath))) {
    return win32
  }
  return posix
}

function normalizePathFor(
  platform: NodeJS.Platform,
  value: string
): string {
  const ops = pathOpsFor(platform, value)
  if (ops === win32) {
    if (
      typeof value !== 'string' ||
      value.length > 260 ||
      !/^[A-Za-z]:\\/.test(value) ||
      /[\x00-\x1f\x7f"<>|?*]/.test(value) ||
      value.includes('/') ||
      value.slice(2).includes(':')
    ) {
      throw new KiroPermissionsError(
        'INVALID_TARGET',
        '权限配置路径无效，已拒绝操作。'
      )
    }
    const segments = value.slice(3).split('\\')
    if (
      segments.some(
        segment => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment)
      )
    ) {
      throw new KiroPermissionsError(
        'INVALID_TARGET',
        '权限配置路径包含非法片段，已拒绝操作。'
      )
    }
    return win32.normalize(value)
  }
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    !posix.isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new KiroPermissionsError(
      'INVALID_TARGET',
      '权限配置路径无效，已拒绝操作。'
    )
  }
  const segments = value.slice(1).split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new KiroPermissionsError(
      'INVALID_TARGET',
      '权限配置路径包含非法片段，已拒绝操作。'
    )
  }
  return posix.normalize(value)
}

function equalCanonicalPath(
  platform: NodeJS.Platform,
  a: string,
  b: string
): boolean {
  const ops = pathOpsFor(platform, a)
  return ops === win32 ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInsideDirectory(
  platform: NodeJS.Platform,
  baseDir: string,
  candidatePath: string
): boolean {
  const ops = pathOpsFor(platform, baseDir)
  const rel = ops.relative(
    ops === win32 ? baseDir.toLowerCase() : baseDir,
    ops === win32 ? candidatePath.toLowerCase() : candidatePath
  )
  return (
    rel !== '' &&
    rel !== '.' &&
    rel !== '..' &&
    !rel.startsWith(`..${ops.sep}`) &&
    !ops.isAbsolute(rel)
  )
}

export function evaluateKiroPermissionsCompatibility(
  ideVersion: string | undefined
): KiroPermissionsCompatibility {
  if (!ideVersion || typeof ideVersion !== 'string') {
    return {
      status: 'unverified',
      writable: false,
      reason: '兼容性待确认：未能从所选客户端安装资源确认 Kiro IDE 版本，当前保持只读；可导出配置模板手动使用。'
    }
  }
  const match = SEMVER_REGEX.exec(ideVersion.trim())
  if (!match) {
    return {
      status: 'unverified',
      writable: false,
      reason: '兼容性待确认：所选客户端版本号格式无法识别，当前保持只读；可导出配置模板手动使用。'
    }
  }
  const major = Number(match[1])
  if (major === 1) {
    return {
      status: 'supported',
      ideVersion: ideVersion.trim(),
      writable: true
    }
  }
  if (major < 1) {
    return {
      status: 'unsupported',
      ideVersion: ideVersion.trim(),
      writable: false,
      reason: `当前客户端版本 (${ideVersion.trim()}) 早于 Kiro IDE 1.x，不支持 permissions.yaml 自动批准规则。`
    }
  }
  return {
    status: 'unverified',
    ideVersion: ideVersion.trim(),
    writable: false,
    reason: `兼容性待确认：当前仅确认 Kiro IDE 1.x 兼容（检测到 ${ideVersion.trim()}），当前保持只读；可导出配置模板手动使用。`
  }
}

function normalizeSettingsTarget(
  target: unknown,
  platform: NodeJS.Platform
): KiroSettingsTarget {
  if (
    target === undefined ||
    (isPlainObject(target) && target.type === 'default' && Object.keys(target).length === 1)
  ) {
    return { type: 'default' }
  }
  if (
    isPlainObject(target) &&
    target.type === 'instance' &&
    Object.keys(target).length === 2 &&
    typeof target.instanceId === 'string' &&
    UUID_REGEX.test(target.instanceId) &&
    platform === 'win32'
  ) {
    return { type: 'instance', instanceId: target.instanceId.toLowerCase() }
  }
  throw new KiroPermissionsError(
    'INVALID_TARGET',
    'Kiro 权限设置目标无效，请重新选择默认客户端或受管实例。'
  )
}

function validateExpectedRevision(value: unknown): KiroPermissionsRevision {
  if (
    !isPlainObject(value) ||
    typeof value.exists !== 'boolean' ||
    (value.sha256 !== null &&
      (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256))) ||
    (value.exists === false && value.sha256 !== null) ||
    (value.exists === true && value.sha256 === null)
  ) {
    throw new KiroPermissionsError(
      'REVISION_CONFLICT',
      '权限配置状态标识无效或已过期，请刷新后重试。'
    )
  }
  return {
    exists: value.exists,
    sha256: value.sha256 ? value.sha256.toLowerCase() : null
  }
}

function sameTarget(a: KiroSettingsTarget, b: KiroSettingsTarget): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'default' && b.type === 'default') return true
  return (
    a.type === 'instance' &&
    b.type === 'instance' &&
    a.instanceId.toLowerCase() === b.instanceId.toLowerCase()
  )
}

interface ResolvedPermissionsTarget {
  target: KiroSettingsTarget
  targetKey: string
  targetInfo: KiroPermissionsTargetInfo
  homeDir: string
  configBaseDir: string
  settingsSegments: readonly string[]
  settingsDir: string
  permissionsPath: string
  policyFormat: 'yaml' | 'json'
}

export class KiroPermissionsService {
  private readonly deps: KiroPermissionsServiceDependencies
  private readonly io: KiroPermissionsFileSystem
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(deps: KiroPermissionsServiceDependencies) {
    // A page revision must not silently move to another policy root while an operation is pending.
    // Read before copying: Windows process.env has case-insensitive property
    // access, whereas a spread clone is an ordinary case-sensitive object.
    const kiroHome = deps.env?.KIRO_HOME ?? (deps.platform === 'win32'
      ? Object.entries(deps.env ?? {}).find(([key]) => key.toUpperCase() === 'KIRO_HOME')?.[1]
      : undefined)
    this.deps = { ...deps, env: { KIRO_HOME: kiroHome } }
    this.io = deps.fileSystem ?? defaultPermissionsFileSystem
  }

  private withLock<T>(lockKey: string, action: () => Promise<T>): Promise<T> {
    const normalizedKey =
      pathOpsFor(this.deps.platform, lockKey) === win32 ? lockKey.toLowerCase() : lockKey
    const previous = this.locks.get(normalizedKey) ?? Promise.resolve()
    const current = previous.then(action, action)
    const tracked = current.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(normalizedKey, tracked)
    return current.finally(() => {
      if (this.locks.get(normalizedKey) === tracked) {
        this.locks.delete(normalizedKey)
      }
    })
  }

  private async verifyBaseDirectory(dirPath: string, create = false): Promise<string> {
    const canonical = normalizePathFor(this.deps.platform, dirPath)
    const ops = pathOpsFor(this.deps.platform, canonical)
    const root = ops.parse(canonical).root
    const segments = canonical
      .slice(root.length)
      .split(ops.sep)
      .filter(Boolean)

    let cursor = root
    for (let i = 0; i < segments.length; i++) {
      cursor = ops.join(cursor, segments[i])
      let stat: KiroPermissionsStat | undefined
      try {
        stat = await this.io.lstat(cursor)
      } catch (error) {
        if (!isAbsentError(error)) {
          throw new KiroPermissionsError('IO_ERROR', '无法访问权限配置目录，请检查目录权限。')
        }
        if (!create) {
          throw new KiroPermissionsError('INVALID_TARGET', '目标主目录不存在，已拒绝操作。')
        }
        try {
          await this.io.mkdir(cursor, { mode: 0o700 })
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException)?.code !== 'EEXIST') {
            throw new KiroPermissionsError('IO_ERROR', '无法创建权限配置目录。')
          }
        }
        stat = await this.io.lstat(cursor)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new KiroPermissionsError(
          'PATH_REDIRECTED',
          '检测到目录包含符号链接或非目录对象，已阻止操作。'
        )
      }
      const real = normalizePathFor(this.deps.platform, await this.io.realpath(cursor))
      if (!equalCanonicalPath(this.deps.platform, real, cursor)) {
        throw new KiroPermissionsError(
          'PATH_REDIRECTED',
          '检测到目录路径被重定向，已阻止操作。'
        )
      }
    }
    return canonical
  }

  private async verifySubdirectories(
    baseDir: string,
    segments: readonly string[],
    create: boolean
  ): Promise<{ dirPath: string; exists: boolean }> {
    const verifiedBase = await this.verifyBaseDirectory(baseDir, create)
    const ops = pathOpsFor(this.deps.platform, verifiedBase)
    let cursor = verifiedBase
    for (const segment of segments) {
      cursor = ops.join(cursor, segment)
      let stat: KiroPermissionsStat | undefined
      try {
        stat = await this.io.lstat(cursor)
      } catch (error) {
        if (!isAbsentError(error)) {
          throw new KiroPermissionsError('IO_ERROR', '无法访问权限配置子目录。')
        }
        if (!create) {
          return { dirPath: ops.join(verifiedBase, ...segments), exists: false }
        }
        try {
          await this.io.mkdir(cursor, { mode: 0o700 })
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException)?.code !== 'EEXIST') {
            throw new KiroPermissionsError('IO_ERROR', '无法创建权限配置子目录。')
          }
        }
        stat = await this.io.lstat(cursor)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new KiroPermissionsError(
          'PATH_REDIRECTED',
          '权限配置目录包含符号链接或被文件替代，已拒绝操作。'
        )
      }
      const real = normalizePathFor(this.deps.platform, await this.io.realpath(cursor))
      if (
        !equalCanonicalPath(this.deps.platform, real, cursor) ||
        !isInsideDirectory(this.deps.platform, verifiedBase, real)
      ) {
        throw new KiroPermissionsError(
          'PATH_REDIRECTED',
          '权限配置目录被重定向，已拒绝操作。'
        )
      }
    }
    return { dirPath: cursor, exists: true }
  }

  private async verifyFileInDirectory(
    verifiedParentDir: string,
    filePath: string
  ): Promise<{ exists: boolean; size: number }> {
    const canonicalFile = normalizePathFor(this.deps.platform, filePath)
    if (!isInsideDirectory(this.deps.platform, verifiedParentDir, canonicalFile)) {
      throw new KiroPermissionsError(
        'PATH_REDIRECTED',
        '文件路径不在安全目录内，已拒绝操作。'
      )
    }
    let stat: KiroPermissionsStat
    try {
      stat = await this.io.lstat(canonicalFile)
    } catch (error) {
      if (isAbsentError(error)) return { exists: false, size: 0 }
      throw new KiroPermissionsError('IO_ERROR', '无法访问权限配置文件状态。')
    }
    if (
      stat.isSymbolicLink() ||
      stat.isDirectory() ||
      !stat.isFile() ||
      (typeof stat.nlink === 'number' && stat.nlink > 1)
    ) {
      throw new KiroPermissionsError(
        'PATH_REDIRECTED',
        '权限配置文件为符号链接、目录或硬链接，已拒绝操作。'
      )
    }
    const real = normalizePathFor(this.deps.platform, await this.io.realpath(canonicalFile))
    if (
      !equalCanonicalPath(this.deps.platform, real, canonicalFile) ||
      !isInsideDirectory(this.deps.platform, verifiedParentDir, real)
    ) {
      throw new KiroPermissionsError(
        'PATH_REDIRECTED',
        '权限配置文件被重定向，已拒绝操作。'
      )
    }
    return { exists: true, size: stat.size }
  }

  private async resolveTarget(requestedTarget: unknown): Promise<ResolvedPermissionsTarget> {
    const normalizedTarget = normalizeSettingsTarget(requestedTarget, this.deps.platform)
    let homeDir: string
    let label: string
    if (normalizedTarget.type === 'default') {
      homeDir = normalizePathFor(this.deps.platform, this.deps.homeDir)
      label = '默认 Kiro'
    } else {
      let instanceInfo: {
        label: string
        homeDir: string
        settingsPath: string
        accountId?: string
      }
      try {
        instanceInfo = await this.deps.resolveInstance(normalizedTarget.instanceId)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (/重定向|链接/.test(message)) {
          throw new KiroPermissionsError(
            'PATH_REDIRECTED',
            message || '实例目录或设置路径存在重定向，已阻止操作。'
          )
        }
        throw new KiroPermissionsError(
          'INVALID_TARGET',
          '所选受管实例不存在或无法验证目录归属，请刷新实例列表后重试。'
        )
      }
      homeDir = normalizePathFor(this.deps.platform, instanceInfo.homeDir)
      label = instanceInfo.label
    }

    const verifiedHome = await this.verifyBaseDirectory(homeDir, false)
    const ops = pathOpsFor(this.deps.platform, verifiedHome)
    let configBaseDir = verifiedHome
    let settingsSegments: readonly string[] = ['.kiro', 'settings']
    const override = normalizedTarget.type === 'default' ? this.deps.env?.KIRO_HOME?.trim() : undefined
    // Match the client's MGp rules: relative/root/contains-home overrides are ignored.
    // Resolve existing ancestors only for containment checks; never create directories on a status read.
    if (override && ops.isAbsolute(override)) {
      const resolvedOverride = ops.resolve(override)
      if (!equalCanonicalPath(this.deps.platform, resolvedOverride, ops.parse(resolvedOverride).root)) {
        let ancestor = normalizePathFor(this.deps.platform, resolvedOverride)
        const missing: string[] = []
        for (;;) {
          try {
            await this.io.lstat(ancestor)
            break
          } catch (error) {
            if (!isAbsentError(error)) throw new KiroPermissionsError('IO_ERROR', '无法核实 KIRO_HOME 配置目录，已保持只读。')
            const parent = ops.dirname(ancestor)
            if (parent === ancestor) throw new KiroPermissionsError('INVALID_TARGET', '无法核实 KIRO_HOME 配置目录。')
            missing.unshift(ops.basename(ancestor))
            ancestor = parent
          }
        }
        const realAncestor = await this.io.realpath(ancestor)
        const realOverride = ops.join(realAncestor, ...missing)
        if (!equalCanonicalPath(this.deps.platform, realOverride, verifiedHome) &&
            !isInsideDirectory(this.deps.platform, realOverride, verifiedHome)) {
          configBaseDir = await this.verifyBaseDirectory(ancestor, false)
          settingsSegments = [...missing, 'settings']
        }
      }
    }
    const settingsDir = ops.join(configBaseDir, ...settingsSegments)
    const settingsSub = await this.verifySubdirectories(configBaseDir, settingsSegments, false)
    let permissionsPath = ops.join(settingsDir, 'permissions.yaml')
    let policyFormat: 'yaml' | 'json' = 'yaml'
    if (settingsSub.exists && !(await this.verifyFileInDirectory(settingsDir, permissionsPath)).exists) {
      const jsonPath = ops.join(settingsDir, 'permissions.json')
      if ((await this.verifyFileInDirectory(settingsDir, jsonPath)).exists) {
        permissionsPath = jsonPath
        policyFormat = 'json'
      }
    }
    const targetKey =
      normalizedTarget.type === 'default'
        ? 'default'
        : `instance-${normalizedTarget.instanceId.toLowerCase()}`

    return {
      target: normalizedTarget,
      targetKey,
      targetInfo: {
        type: normalizedTarget.type,
        ...(normalizedTarget.type === 'instance'
          ? { instanceId: normalizedTarget.instanceId }
          : {}),
        label,
        permissionsPath
      },
      homeDir: verifiedHome,
      configBaseDir,
      settingsSegments,
      settingsDir,
      permissionsPath,
      policyFormat
    }
  }

  private async readPermissionsRaw(
    resolved: ResolvedPermissionsTarget
  ): Promise<{ exists: boolean; bytes: Buffer | null; sha256: string | null; tooLarge?: boolean }> {
    const sub = await this.verifySubdirectories(
      resolved.configBaseDir,
      resolved.settingsSegments,
      false
    )
    if (!sub.exists) {
      return { exists: false, bytes: null, sha256: null }
    }
    const fileStatus = await this.verifyFileInDirectory(
      sub.dirPath,
      resolved.permissionsPath
    )
    if (!fileStatus.exists) {
      return { exists: false, bytes: null, sha256: null }
    }
    if (fileStatus.size > MAX_PERMISSIONS_BYTES) {
      return { exists: true, bytes: null, sha256: null, tooLarge: true }
    }
    const bytes = await this.io.readFileBounded(resolved.permissionsPath, MAX_PERMISSIONS_BYTES)
    const afterStatus = await this.verifyFileInDirectory(
      sub.dirPath,
      resolved.permissionsPath
    )
    if (!afterStatus.exists) {
      throw new KiroPermissionsError(
        'REVISION_CONFLICT',
        '读取权限配置文件期间文件状态变化，请刷新后重试。'
      )
    }
    if (bytes.byteLength > MAX_PERMISSIONS_BYTES || afterStatus.size > MAX_PERMISSIONS_BYTES) {
      return { exists: true, bytes: null, sha256: null, tooLarge: true }
    }
    const sha256 = sha256Buffer(bytes)
    return { exists: true, bytes, sha256 }
  }

  private async readLatestManifest(
    resolved: ResolvedPermissionsTarget,
    currentRevision: KiroPermissionsRevision
  ): Promise<{
    restore: KiroPermissionsRestoreInfo
    manifest?: KiroPermissionsBackupManifest
    originalBytes?: Buffer
    operationDir?: string
  }> {
    // The manager creates this directory on the first write. A status read must
    // treat an absent backup directory as no snapshot, while still validating
    // its existing parent and rejecting links, redirected paths and I/O errors.
    const backupRoot = normalizePathFor(this.deps.platform, this.deps.backupRoot)
    const backupOps = pathOpsFor(this.deps.platform, backupRoot)
    const backupSub = await this.verifySubdirectories(
      backupOps.dirname(backupRoot),
      [backupOps.basename(backupRoot), resolved.targetKey],
      false
    )

    if (!backupSub.exists) {
      return { restore: { status: 'none', canRestore: false } }
    }

    const ops = pathOpsFor(this.deps.platform, backupSub.dirPath)
    const latestPath = ops.join(backupSub.dirPath, 'latest.json')
    const latestFileCheck = await this.verifyFileInDirectory(backupSub.dirPath, latestPath)
    if (!latestFileCheck.exists) {
      return { restore: { status: 'none', canRestore: false } }
    }

    let latestOperationId: string
    try {
      const parsedLatest: unknown = JSON.parse(
        (await this.io.readFile(latestPath)).toString('utf8')
      )
      if (
        !isPlainObject(parsedLatest) ||
        typeof parsedLatest.operationId !== 'string' ||
        !UUID_REGEX.test(parsedLatest.operationId)
      ) {
        return {
          restore: {
            status: 'corrupted',
            canRestore: false,
            backupDir: backupSub.dirPath,
            message: '自动批准备份索引损坏，已拒绝自动恢复；请核对本地备份目录。'
          }
        }
      }
      latestOperationId = parsedLatest.operationId.toLowerCase()
    } catch {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          backupDir: backupSub.dirPath,
          message: '无法读取自动批准备份索引，已拒绝自动恢复；请核对本地备份目录。'
        }
      }
    }

    const opSub = await this.verifySubdirectories(
      this.deps.backupRoot,
      [resolved.targetKey, latestOperationId],
      false
    )
    if (!opSub.exists) {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: backupSub.dirPath,
          message: '自动批准备份事务目录缺失，已拒绝自动恢复。'
        }
      }
    }

    const manifestPath = ops.join(opSub.dirPath, 'manifest.json')
    const manifestCheck = await this.verifyFileInDirectory(opSub.dirPath, manifestPath)
    if (!manifestCheck.exists) {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: opSub.dirPath,
          message: '自动批准备份记录文件缺失，已拒绝自动恢复。'
        }
      }
    }

    let manifest: KiroPermissionsBackupManifest
    try {
      const rawManifest: unknown = JSON.parse(
        (await this.io.readFile(manifestPath)).toString('utf8')
      )
      if (
        !isPlainObject(rawManifest) ||
        rawManifest.schemaVersion !== 1 ||
        typeof rawManifest.operationId !== 'string' ||
        rawManifest.operationId.toLowerCase() !== latestOperationId ||
        !isPlainObject(rawManifest.target) ||
        typeof rawManifest.canonicalPath !== 'string' ||
        typeof rawManifest.originalExisted !== 'boolean' ||
        (rawManifest.beforeHash !== null &&
          (typeof rawManifest.beforeHash !== 'string' ||
            !/^[0-9a-f]{64}$/i.test(rawManifest.beforeHash))) ||
        typeof rawManifest.afterHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(rawManifest.afterHash) ||
        typeof rawManifest.templateVersion !== 'string' ||
        !Array.isArray(rawManifest.addedRules) ||
        !rawManifest.addedRules.every(r => r === 'all' || r === 'fs_write') ||
        typeof rawManifest.createdAt !== 'string' ||
        typeof rawManifest.updatedAt !== 'string' ||
        ![
          'prepared',
          'applied',
          'restoring',
          'restored',
          'rolled_back',
          'conflict'
        ].includes(String(rawManifest.stage))
      ) {
        throw new Error('invalid manifest')
      }
      manifest = rawManifest as unknown as KiroPermissionsBackupManifest
    } catch {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: opSub.dirPath,
          message: '自动批准备份记录格式无效，已拒绝自动恢复。'
        }
      }
    }

    let parsedManifestTarget: KiroSettingsTarget
    try {
      parsedManifestTarget = normalizeSettingsTarget(manifest.target, this.deps.platform)
    } catch {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: opSub.dirPath,
          message: '备份记录中的目标标识无效，已拒绝自动恢复。'
        }
      }
    }

    if (
      !sameTarget(parsedManifestTarget, resolved.target) ||
      !equalCanonicalPath(
        this.deps.platform,
        manifest.canonicalPath,
        resolved.permissionsPath
      )
    ) {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: opSub.dirPath,
          message: '备份记录与当前所选目标或权限路径不一致，已拒绝自动恢复。'
        }
      }
    }

    let originalBytes: Buffer | undefined
    if (manifest.originalExisted) {
      if (!manifest.beforeHash) {
        return {
          restore: {
            status: 'corrupted',
            canRestore: false,
            operationId: latestOperationId,
            backupDir: opSub.dirPath,
            message: '备份记录缺少原始文件校验值，已拒绝自动恢复。'
          }
        }
      }
      const originalBinPath = ops.join(opSub.dirPath, 'original.bin')
      const binCheck = await this.verifyFileInDirectory(opSub.dirPath, originalBinPath)
      if (!binCheck.exists) {
        return {
          restore: {
            status: 'corrupted',
            canRestore: false,
            operationId: latestOperationId,
            backupDir: opSub.dirPath,
            message: '原始权限配置备份文件缺失，已拒绝自动恢复。'
          }
        }
      }
      originalBytes = await this.io.readFile(originalBinPath)
      if (sha256Buffer(originalBytes) !== manifest.beforeHash.toLowerCase()) {
        return {
          restore: {
            status: 'corrupted',
            canRestore: false,
            operationId: latestOperationId,
            backupDir: opSub.dirPath,
            message: '原始权限配置备份文件校验不匹配，已拒绝自动恢复。'
          }
        }
      }
    } else if (manifest.beforeHash !== null) {
      return {
        restore: {
          status: 'corrupted',
          canRestore: false,
          operationId: latestOperationId,
          backupDir: opSub.dirPath,
          message: '备份记录状态不一致，已拒绝自动恢复。'
        }
      }
    }

    const matchesBefore =
      currentRevision.exists === manifest.originalExisted &&
      currentRevision.sha256 === (manifest.beforeHash ? manifest.beforeHash.toLowerCase() : null)
    const matchesAfter =
      currentRevision.exists === true &&
      currentRevision.sha256 === manifest.afterHash.toLowerCase()

    // Reconcile the journal only after its next stage is durable. If storage is
    // still unavailable, expose a pending state instead of inventing completion.
    if (manifest.stage === 'prepared' || manifest.stage === 'restoring') {
      const reconciledStage = matchesBefore
        ? (manifest.stage === 'prepared' ? 'rolled_back' : 'restored')
        : matchesAfter ? 'applied' : undefined
      let pendingMessage = '上次权限操作中断且当前文件内容与事务记录不一致，请核对当前文件与备份目录。'
      if (reconciledStage) {
        try {
          manifest = await this.updateManifestStage(opSub.dirPath, manifest, reconciledStage)
        } catch {
          pendingMessage = '当前文件已核对，但备份事务阶段仍无法持久化；已保持待核对状态，请检查备份目录权限后刷新。'
        }
      }
      if (!reconciledStage || manifest.stage === 'prepared' || manifest.stage === 'restoring') {
        return {
          restore: {
            status: 'pending_verification',
            canRestore: false,
            operationId: manifest.operationId,
            appliedAt: manifest.updatedAt,
            addedRules: manifest.addedRules,
            originalExisted: manifest.originalExisted,
            backupDir: opSub.dirPath,
            message: pendingMessage
          },
          manifest,
          originalBytes,
          operationDir: opSub.dirPath
        }
      }
    }

    if (manifest.stage === 'restored' || manifest.stage === 'rolled_back') {
      return { restore: { status: 'none', canRestore: false }, manifest, operationDir: opSub.dirPath }
    }

    if (manifest.stage === 'conflict') {
      return {
        restore: {
          status: 'pending_verification',
          canRestore: false,
          operationId: manifest.operationId,
          appliedAt: manifest.updatedAt,
          addedRules: manifest.addedRules,
          originalExisted: manifest.originalExisted,
          backupDir: opSub.dirPath,
          message: '上次权限文件提交结果需人工核对，已保留原备份快照。'
        },
        manifest,
        originalBytes,
        operationDir: opSub.dirPath
      }
    }

    // stage === 'applied'
    if (matchesAfter) {
      return {
        restore: {
          status: 'available',
          canRestore: true,
          operationId: manifest.operationId,
          appliedAt: manifest.updatedAt,
          addedRules: manifest.addedRules,
          originalExisted: manifest.originalExisted,
          backupDir: opSub.dirPath
        },
        manifest,
        originalBytes,
        operationDir: opSub.dirPath
      }
    }

    return {
      restore: {
        status: 'external_modified',
        canRestore: false,
        operationId: manifest.operationId,
        appliedAt: manifest.updatedAt,
        addedRules: manifest.addedRules,
        originalExisted: manifest.originalExisted,
        backupDir: opSub.dirPath,
        message: '权限配置文件在应用自动批准后已被外部修改，已拒绝自动恢复并保留当前文件；可参考备份目录手动处理。'
      },
      manifest,
      originalBytes,
      operationDir: opSub.dirPath
    }
  }

  private async updateManifestStage(
    operationDir: string,
    manifest: KiroPermissionsBackupManifest,
    stage: KiroPermissionsBackupManifest['stage']
  ): Promise<KiroPermissionsBackupManifest> {
    const ops = pathOpsFor(this.deps.platform, operationDir)
    const updated: KiroPermissionsBackupManifest = {
      ...manifest,
      stage,
      updatedAt: (this.deps.now ?? (() => new Date()))().toISOString()
    }
    const manifestPath = ops.join(operationDir, 'manifest.json')
    const tempManifestPath = ops.join(
      operationDir,
      `.manifest.tmp-${(this.deps.uuid ?? randomUUID)().toLowerCase()}`
    )
    try {
      await this.io.writeFile(tempManifestPath, JSON.stringify(updated, null, 2), {
        flag: 'wx',
        mode: 0o600
      })
      await this.io.rename(tempManifestPath, manifestPath)
    } catch {
      await this.io.unlink(tempManifestPath).catch(() => {})
      throw new KiroPermissionsError(
        'BACKUP_FAILED',
        '无法持久化权限备份事务阶段；请刷新核对当前文件与备份，尚未确认操作完成。'
      )
    }
    return updated
  }

  private async buildState(resolved: ResolvedPermissionsTarget): Promise<KiroPermissionsState> {
    let ideVersion: string | undefined
    if (this.deps.inspectVersion) {
      try {
        ideVersion = await this.deps.inspectVersion({
          type: resolved.target.type,
          ...(resolved.target.type === 'instance'
            ? { instanceId: resolved.target.instanceId }
            : {}),
          homeDir: resolved.homeDir
        })
      } catch {
        ideVersion = undefined
      }
    }
    const compatibility = evaluateKiroPermissionsCompatibility(ideVersion)
    if (resolved.policyFormat === 'json') {
      compatibility.writable = false
      compatibility.reason = '检测到当前生效的 permissions.json。为保留其中已有规则，当前入口仅检查、不自动应用或恢复；可导出 YAML 模板后自行迁移。'
    }
    const raw = await this.readPermissionsRaw(resolved)
    const revision: KiroPermissionsRevision = {
      exists: raw.exists,
      sha256: raw.sha256
    }

    const { restore } = await this.readLatestManifest(resolved, revision)

    if (raw.tooLarge) {
      const empty = emptyPermissionsInspection()
      return {
        target: resolved.targetInfo,
        compatibility,
        contentStatus: 'invalid',
        revision,
        presence: empty.presence,
        restrictions: empty.restrictions,
        restore,
        parseError: '权限配置文件超过 1 MiB 处理上限；原文件未更改。'
      }
    }

    try {
      const content = raw.bytes ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.bytes) : null
      if (resolved.policyFormat === 'json' && content !== null) {
        // The upstream JSON loader is strict, even though JSON is also valid YAML.
        try { JSON.parse(content.replace(/^\uFEFF/, '')) } catch {
          throw new KiroPermissionsError('INVALID_YAML', '现有 permissions.json 不是有效 JSON，已保持只读且未创建替代 YAML。')
        }
      }
      const inspection = inspectKiroPermissionsDocument(content)
      return {
        target: resolved.targetInfo,
        compatibility,
        contentStatus: inspection.contentStatus,
        revision,
        presence: inspection.presence,
        restrictions: inspection.restrictions,
        restore
      }
    } catch (error) {
      const empty = emptyPermissionsInspection()
      const message =
        error instanceof KiroPermissionsError
          ? error.message
          : '权限配置文件不是有效的 UTF-8 YAML 文档；原文件未更改。'
      return {
        target: resolved.targetInfo,
        compatibility,
        contentStatus: 'invalid',
        revision,
        presence: empty.presence,
        restrictions: empty.restrictions,
        restore,
        parseError: message
      }
    }
  }

  async getState(requestedTarget?: unknown): Promise<KiroPermissionsStateResult> {
    try {
      const normalizedTarget = normalizeSettingsTarget(requestedTarget, this.deps.platform)
      const lockKey =
        normalizedTarget.type === 'default'
          ? 'default'
          : `instance-${normalizedTarget.instanceId.toLowerCase()}`
      return await this.withLock(lockKey, async () => {
        const resolved = await this.resolveTarget(requestedTarget)
        const state = await this.buildState(resolved)
        return { success: true, state }
      })
    } catch (error) {
      if (error instanceof KiroPermissionsError) {
        return { success: false, code: error.code, error: error.message }
      }
      return {
        success: false,
        code: 'IO_ERROR',
        error: '无法读取所选客户端的权限配置状态，请检查配置目录或实例状态。'
      }
    }
  }

  async applyAutoApproval(
    requestedTarget: unknown,
    expectedRevisionInput: unknown
  ): Promise<KiroPermissionsWriteResult> {
    try {
      const normalizedTarget = normalizeSettingsTarget(requestedTarget, this.deps.platform)
      const lockKey =
        normalizedTarget.type === 'default'
          ? 'default'
          : `instance-${normalizedTarget.instanceId.toLowerCase()}`
      const expectedRevision = validateExpectedRevision(expectedRevisionInput)

      return await this.withLock(lockKey, async () => {
        const currentResolved = await this.resolveTarget(requestedTarget)
        if (currentResolved.policyFormat === 'json') {
          throw new KiroPermissionsError('JSON_POLICY_READ_ONLY', '当前生效的是 permissions.json，已保留原规则；请手动迁移后再应用，未创建替代 YAML。')
        }
        const resolved = currentResolved
        if (
          !equalCanonicalPath(
            this.deps.platform,
            currentResolved.permissionsPath,
            resolved.permissionsPath
          )
        ) {
          throw new KiroPermissionsError(
            'INVALID_TARGET',
            '目标实例路径已变化，请刷新后重试。'
          )
        }

        let ideVersion: string | undefined
        if (this.deps.inspectVersion) {
          try {
            ideVersion = await this.deps.inspectVersion({
              type: currentResolved.target.type,
              ...(currentResolved.target.type === 'instance'
                ? { instanceId: currentResolved.target.instanceId }
                : {}),
              homeDir: currentResolved.homeDir
            })
          } catch {
            ideVersion = undefined
          }
        }
        const compatibility = evaluateKiroPermissionsCompatibility(ideVersion)
        if (!compatibility.writable) {
          throw new KiroPermissionsError(
            'COMPATIBILITY_UNVERIFIED',
            compatibility.reason || '当前客户端版本兼容性待确认，保持只读。'
          )
        }

        const raw = await this.readPermissionsRaw(currentResolved)
        const currentRevision: KiroPermissionsRevision = {
          exists: raw.exists,
          sha256: raw.sha256
        }

        if (
          currentRevision.exists !== expectedRevision.exists ||
          currentRevision.sha256 !== expectedRevision.sha256
        ) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'REVISION_CONFLICT',
            error: '配置已变化，请刷新后重试。',
            state: latestState
          }
        }

        if (raw.tooLarge) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'FILE_TOO_LARGE',
            error: '权限配置文件超过 1 MiB 处理上限；原文件未更改。',
            state: latestState
          }
        }

        let currentText: string | null = null
        if (raw.bytes) {
          try {
            currentText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.bytes)
          } catch {
            const latestState = await this.buildState(currentResolved)
            return {
              success: false,
              code: 'INVALID_YAML',
              error: '权限配置文件包含无效的 UTF-8 编码；原文件未更改。',
              state: latestState
            }
          }
        }

        let plan
        try {
          plan = planKiroAutoApprovalMerge(currentText)
        } catch (error) {
          const latestState = await this.buildState(currentResolved)
          if (error instanceof KiroPermissionsError) {
            return {
              success: false,
              code: error.code,
              error: error.message,
              state: latestState
            }
          }
          return {
            success: false,
            code: 'INVALID_YAML',
            error: '权限配置文件无法解析；原文件未更改。',
            state: latestState
          }
        }

        // Idempotent: both rules already exist -> no file write or new backup snapshot
        if (!plan.changed) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: true,
            changed: false,
            addedRules: [],
            state: latestState
          }
        }

        // Check existing backup state: never silently overwrite an active conflicted snapshot baseline
        const latestBackup = await this.readLatestManifest(currentResolved, currentRevision)
        if (
          latestBackup.restore.status === 'external_modified' ||
          latestBackup.restore.status === 'pending_verification' ||
          latestBackup.restore.status === 'corrupted' ||
          latestBackup.restore.status === 'available'
        ) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'RESTORE_CONFLICT',
            error:
              '检测到未恢复的自动批准备份记录且当前文件已变化，为保护原始恢复基线未覆盖快照；请先核对备份目录。',
            state: latestState
          }
        }

        const operationId = (this.deps.uuid ?? randomUUID)().toLowerCase()
        if (!UUID_REGEX.test(operationId)) {
          throw new KiroPermissionsError('BACKUP_FAILED', '无法生成有效的备份事务标识。')
        }

        const targetBackupSub = await this.verifySubdirectories(
          this.deps.backupRoot,
          [currentResolved.targetKey],
          true
        )
        const opBackupSub = await this.verifySubdirectories(
          this.deps.backupRoot,
          [currentResolved.targetKey, operationId],
          true
        )
        const ops = pathOpsFor(this.deps.platform, opBackupSub.dirPath)

        // Write original bytes to backup if file existed
        if (raw.exists && raw.bytes) {
          const originalBinPath = ops.join(opBackupSub.dirPath, 'original.bin')
          await this.verifyFileInDirectory(opBackupSub.dirPath, originalBinPath)
          try {
            await this.io.writeFile(originalBinPath, raw.bytes, {
              flag: 'wx',
              mode: 0o600
            })
            const verifyBackupBytes = await this.io.readFile(originalBinPath)
            if (sha256Buffer(verifyBackupBytes) !== raw.sha256) {
              throw new Error('backup hash mismatch')
            }
          } catch {
            throw new KiroPermissionsError(
              'BACKUP_FAILED',
              '无法写入或校验原始权限配置备份；目标文件未更改。'
            )
          }
        }

        const nowIso = (this.deps.now ?? (() => new Date()))().toISOString()
        const manifest: KiroPermissionsBackupManifest = {
          schemaVersion: 1,
          operationId,
          target: currentResolved.target,
          canonicalPath: currentResolved.permissionsPath,
          originalExisted: raw.exists,
          beforeHash: raw.sha256,
          afterHash: plan.afterHash,
          templateVersion: KIRO_AUTO_APPROVAL_TEMPLATE_VERSION,
          addedRules: plan.addedRules,
          createdAt: nowIso,
          updatedAt: nowIso,
          stage: 'prepared'
        }

        const manifestPath = ops.join(opBackupSub.dirPath, 'manifest.json')
        const latestPath = ops.join(targetBackupSub.dirPath, 'latest.json')
        const tempLatestPath = ops.join(
          targetBackupSub.dirPath,
          `.latest.tmp-${operationId}`
        )
        try {
          await this.verifyFileInDirectory(opBackupSub.dirPath, manifestPath)
          await this.io.writeFile(manifestPath, JSON.stringify(manifest, null, 2), {
            flag: 'wx',
            mode: 0o600
          })
          await this.verifyFileInDirectory(targetBackupSub.dirPath, tempLatestPath)
          await this.io.writeFile(
            tempLatestPath,
            JSON.stringify({ operationId }, null, 2),
            { flag: 'wx', mode: 0o600 }
          )
          await this.io.rename(tempLatestPath, latestPath)
        } catch {
          await this.io.unlink(tempLatestPath).catch(() => {})
          throw new KiroPermissionsError(
            'BACKUP_FAILED',
            '无法保存自动批准备份事务记录；目标文件未更改。'
          )
        }

        // Ensure .kiro/settings exists and verify every directory component after creation
        const settingsSub = await this.verifySubdirectories(
          currentResolved.configBaseDir,
          currentResolved.settingsSegments,
          true
        )
        const targetOps = pathOpsFor(this.deps.platform, settingsSub.dirPath)
        const tempPath = targetOps.join(
          settingsSub.dirPath,
          `.permissions.yaml.tmp-${operationId}`
        )

        const plannedBuffer = Buffer.from(plan.content, 'utf8')
        try {
          await this.verifyFileInDirectory(settingsSub.dirPath, tempPath)
          await this.io.writeFile(tempPath, plannedBuffer, {
            flag: 'wx',
            mode: 0o600
          })
          const tempStatus = await this.verifyFileInDirectory(settingsSub.dirPath, tempPath)
          if (!tempStatus.exists) {
            throw new Error('temp file missing')
          }
          const tempReadBack = await this.io.readFile(tempPath)
          if (sha256Buffer(tempReadBack) !== plan.afterHash) {
            throw new Error('temp hash mismatch')
          }
          inspectKiroPermissionsDocument(tempReadBack.toString('utf8'))
        } catch (err) {
          await this.io.unlink(tempPath).catch(() => {})
          await this.updateManifestStage(opBackupSub.dirPath, manifest, 'rolled_back')
          if (err instanceof KiroPermissionsError) throw err
          throw new KiroPermissionsError(
            'WRITE_FAILED',
            '无法创建或校验临时权限配置文件；目标文件未更改。'
          )
        }

        if (this.deps.beforeCommitHook) {
          await this.deps.beforeCommitHook({
            action: 'apply',
            target: currentResolved.target,
            permissionsPath: currentResolved.permissionsPath,
            tempPath
          })
        }

        // Re-verify target instance ownership, path safety, and original file hash right before commit
        let preCommitResolved: ResolvedPermissionsTarget
        try {
          preCommitResolved = await this.resolveTarget(requestedTarget)
          if (
            !equalCanonicalPath(
              this.deps.platform,
              preCommitResolved.permissionsPath,
              currentResolved.permissionsPath
            )
          ) {
            throw new KiroPermissionsError(
              'INVALID_TARGET',
              '提交前目标路径已变化，已中止写入。'
            )
          }
          const preCommitRaw = await this.readPermissionsRaw(preCommitResolved)
          if (
            preCommitRaw.exists !== raw.exists ||
            preCommitRaw.sha256 !== raw.sha256
          ) {
            throw new KiroPermissionsError(
              'REVISION_CONFLICT',
              '提交前权限配置文件已被外部修改，请刷新后重试。'
            )
          }
          const tempStillSafe = await this.verifyFileInDirectory(
            settingsSub.dirPath,
            tempPath
          )
          if (!tempStillSafe.exists) {
            throw new KiroPermissionsError(
              'WRITE_FAILED',
              '临时权限配置文件状态异常，已中止写入。'
            )
          }
        } catch (preCommitErr) {
          await this.io.unlink(tempPath).catch(() => {})
          await this.updateManifestStage(opBackupSub.dirPath, manifest, 'rolled_back')
          if (preCommitErr instanceof KiroPermissionsError) {
            const latestState = await this.buildState(currentResolved).catch(() => undefined)
            return {
              success: false,
              code: preCommitErr.code,
              error: preCommitErr.message,
              ...(latestState ? { state: latestState } : {})
            }
          }
          throw preCommitErr
        }

        // Atomic same-directory replacement (never unlinking target before rename)
        try {
          await this.io.rename(tempPath, currentResolved.permissionsPath)
        } catch {
          await this.io.unlink(tempPath).catch(() => {})
          const postFailRaw = await this.readPermissionsRaw(currentResolved).catch(() => null)
          if (
            postFailRaw &&
            postFailRaw.exists === raw.exists &&
            postFailRaw.sha256 === raw.sha256
          ) {
            await this.updateManifestStage(opBackupSub.dirPath, manifest, 'rolled_back')
            const latestState = await this.buildState(currentResolved)
            return {
              success: false,
              code: 'WRITE_FAILED',
              error: '无法替换权限配置文件（可能被其他程序占用）；原文件未更改。',
              state: latestState
            }
          }
          await this.updateManifestStage(opBackupSub.dirPath, manifest, 'conflict')
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'VERIFY_FAILED',
            error: '替换权限配置文件时出现不确定结果，已保留备份快照供核对。',
            state: latestState
          }
        }

        // Read back target content and verify hash
        const committedRaw = await this.readPermissionsRaw(currentResolved).catch(() => null)
        if (
          !committedRaw ||
          !committedRaw.exists ||
          committedRaw.sha256 !== plan.afterHash
        ) {
          await this.updateManifestStage(opBackupSub.dirPath, manifest, 'conflict')
          const latestState = await this.buildState(currentResolved).catch(() => undefined)
          return {
            success: false,
            code: 'VERIFY_FAILED',
            error: '写入后回读校验未通过，已保留备份快照供核对。',
            ...(latestState ? { state: latestState } : {})
          }
        }

        try {
          await this.updateManifestStage(opBackupSub.dirPath, manifest, 'applied')
        } catch {
          const state = await this.buildState(currentResolved).catch(() => undefined)
          return {
            success: false,
            code: 'BACKUP_FAILED',
            error: '权限文件已写入，但备份事务完成记录尚未保存；请核对待处理状态，未宣告操作完成。',
            ...(state ? { state } : {})
          }
        }
        const finalState = await this.buildState(currentResolved)
        return {
          success: true,
          changed: true,
          addedRules: plan.addedRules,
          state: finalState
        }
      })
    } catch (error) {
      if (error instanceof KiroPermissionsError) {
        return { success: false, code: error.code, error: error.message }
      }
      return {
        success: false,
        code: 'IO_ERROR',
        error: '应用工具自动批准配置失败，请检查配置目录权限或实例状态。'
      }
    }
  }

  async restoreAutoApproval(
    requestedTarget: unknown,
    expectedRevisionInput: unknown
  ): Promise<KiroPermissionsRestoreResult> {
    try {
      const normalizedTarget = normalizeSettingsTarget(requestedTarget, this.deps.platform)
      const lockKey =
        normalizedTarget.type === 'default'
          ? 'default'
          : `instance-${normalizedTarget.instanceId.toLowerCase()}`
      const expectedRevision = validateExpectedRevision(expectedRevisionInput)

      return await this.withLock(lockKey, async () => {
        const currentResolved = await this.resolveTarget(requestedTarget)
        if (currentResolved.policyFormat === 'json') {
          throw new KiroPermissionsError('JSON_POLICY_READ_ONLY', '当前生效的是 permissions.json，当前入口不自动恢复该文件，原规则已保留。')
        }
        const resolved = currentResolved
        if (
          !equalCanonicalPath(
            this.deps.platform,
            currentResolved.permissionsPath,
            resolved.permissionsPath
          )
        ) {
          throw new KiroPermissionsError(
            'INVALID_TARGET',
            '目标实例路径已变化，请刷新后重试。'
          )
        }

        let ideVersion: string | undefined
        if (this.deps.inspectVersion) {
          try {
            ideVersion = await this.deps.inspectVersion({
              type: currentResolved.target.type,
              ...(currentResolved.target.type === 'instance'
                ? { instanceId: currentResolved.target.instanceId }
                : {}),
              homeDir: currentResolved.homeDir
            })
          } catch {
            ideVersion = undefined
          }
        }
        const compatibility = evaluateKiroPermissionsCompatibility(ideVersion)
        if (!compatibility.writable) {
          throw new KiroPermissionsError(
            'COMPATIBILITY_UNVERIFIED',
            compatibility.reason || '当前客户端版本兼容性待确认，保持只读。'
          )
        }

        const raw = await this.readPermissionsRaw(currentResolved)
        const currentRevision: KiroPermissionsRevision = {
          exists: raw.exists,
          sha256: raw.sha256
        }

        if (
          currentRevision.exists !== expectedRevision.exists ||
          currentRevision.sha256 !== expectedRevision.sha256
        ) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'REVISION_CONFLICT',
            error: '配置已变化，请刷新后重试。',
            state: latestState
          }
        }

        const backupInfo = await this.readLatestManifest(currentResolved, currentRevision)
        if (backupInfo.restore.status === 'none' || !backupInfo.manifest || !backupInfo.operationDir) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'NO_RESTORE_SNAPSHOT',
            error: '当前目标没有可恢复的自动批准备份记录。',
            state: latestState
          }
        }

        if (!backupInfo.restore.canRestore || backupInfo.restore.status !== 'available') {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'RESTORE_CONFLICT',
            error:
              backupInfo.restore.message ||
              '当前权限文件与备份记录冲突，已拒绝自动恢复并保留当前文件。',
            state: latestState
          }
        }

        const { manifest, originalBytes, operationDir } = backupInfo
        const settingsSub = await this.verifySubdirectories(
          currentResolved.configBaseDir,
          currentResolved.settingsSegments,
          false
        )
        if (!settingsSub.exists) {
          const latestState = await this.buildState(currentResolved)
          return {
            success: false,
            code: 'RESTORE_CONFLICT',
            error: '权限配置目录不存在，无法执行自动恢复。',
            state: latestState
          }
        }

        const targetOps = pathOpsFor(this.deps.platform, settingsSub.dirPath)
        const restoreToken = (this.deps.uuid ?? randomUUID)().toLowerCase()

        if (manifest.originalExisted) {
          if (!originalBytes || !manifest.beforeHash) {
            const latestState = await this.buildState(currentResolved)
            return {
              success: false,
              code: 'BACKUP_FAILED',
              error: '备份原始数据不完整，已拒绝自动恢复并保留当前文件。',
              state: latestState
            }
          }

          const tempRestorePath = targetOps.join(
            settingsSub.dirPath,
            `.permissions.yaml.restore-${restoreToken}`
          )
          await this.verifyFileInDirectory(settingsSub.dirPath, tempRestorePath)
          await this.io.writeFile(tempRestorePath, originalBytes, {
            flag: 'wx',
            mode: 0o600
          })
          const verifyTempBytes = await this.io.readFile(tempRestorePath)
          if (sha256Buffer(verifyTempBytes) !== manifest.beforeHash.toLowerCase()) {
            await this.io.unlink(tempRestorePath).catch(() => {})
            throw new KiroPermissionsError(
              'WRITE_FAILED',
              '恢复临时文件校验未通过；当前文件未更改。'
            )
          }

          try {
            await this.updateManifestStage(operationDir, manifest, 'restoring')
          } catch (error) {
            await this.io.unlink(tempRestorePath).catch(() => {})
            throw error
          }

          if (this.deps.beforeCommitHook) {
            await this.deps.beforeCommitHook({
              action: 'restore',
              target: currentResolved.target,
              permissionsPath: currentResolved.permissionsPath,
              tempPath: tempRestorePath
            })
          }

          // Re-verify target ownership, path safety, and afterHash before replacing
          try {
            const preRestoreResolved = await this.resolveTarget(requestedTarget)
            if (
              !equalCanonicalPath(
                this.deps.platform,
                preRestoreResolved.permissionsPath,
                currentResolved.permissionsPath
              )
            ) {
              throw new KiroPermissionsError(
                'INVALID_TARGET',
                '恢复提交前目标路径已变化，已中止恢复。'
              )
            }
            const preRestoreRaw = await this.readPermissionsRaw(preRestoreResolved)
            if (
              !preRestoreRaw.exists ||
              preRestoreRaw.sha256 !== manifest.afterHash.toLowerCase()
            ) {
              throw new KiroPermissionsError(
                'RESTORE_CONFLICT',
                '恢复提交前权限配置文件已被外部修改，已拒绝覆盖当前文件。'
              )
            }
            const tempCheck = await this.verifyFileInDirectory(
              settingsSub.dirPath,
              tempRestorePath
            )
            if (!tempCheck.exists) {
              throw new KiroPermissionsError(
                'WRITE_FAILED',
                '恢复临时文件状态异常，已中止恢复。'
              )
            }
          } catch (preRestoreErr) {
            await this.io.unlink(tempRestorePath).catch(() => {})
            await this.updateManifestStage(operationDir, manifest, 'applied')
            if (preRestoreErr instanceof KiroPermissionsError) {
              const latestState = await this.buildState(currentResolved).catch(() => undefined)
              return {
                success: false,
                code: preRestoreErr.code,
                error: preRestoreErr.message,
                ...(latestState ? { state: latestState } : {})
              }
            }
            throw preRestoreErr
          }

          try {
            await this.io.rename(tempRestorePath, currentResolved.permissionsPath)
          } catch {
            await this.io.unlink(tempRestorePath).catch(() => {})
            const postFailRaw = await this.readPermissionsRaw(currentResolved).catch(() => null)
            if (
              postFailRaw &&
              postFailRaw.exists &&
              postFailRaw.sha256 === manifest.afterHash.toLowerCase()
            ) {
              await this.updateManifestStage(operationDir, manifest, 'applied')
              const latestState = await this.buildState(currentResolved)
              return {
                success: false,
                code: 'WRITE_FAILED',
                error: '无法恢复权限配置文件（可能被其他程序占用）；当前文件未更改。',
                state: latestState
              }
            }
            await this.updateManifestStage(operationDir, manifest, 'conflict')
            const latestState = await this.buildState(currentResolved)
            return {
              success: false,
              code: 'VERIFY_FAILED',
              error: '恢复权限配置文件时出现不确定结果，已保留备份快照供核对。',
              state: latestState
            }
          }

          const afterRestoreRaw = await this.readPermissionsRaw(currentResolved).catch(
            () => null
          )
          if (
            !afterRestoreRaw ||
            !afterRestoreRaw.exists ||
            afterRestoreRaw.sha256 !== manifest.beforeHash.toLowerCase()
          ) {
            await this.updateManifestStage(operationDir, manifest, 'conflict')
            const latestState = await this.buildState(currentResolved).catch(() => undefined)
            return {
              success: false,
              code: 'VERIFY_FAILED',
              error: '恢复后文件校验不一致，已保留备份快照供核对。',
              ...(latestState ? { state: latestState } : {})
            }
          }

          try {
            await this.updateManifestStage(operationDir, manifest, 'restored')
          } catch {
            const state = await this.buildState(currentResolved).catch(() => undefined)
            return {
              success: false,
              code: 'BACKUP_FAILED',
              error: '权限文件已恢复，但备份事务完成记录尚未保存；请核对待处理状态，未宣告操作完成。',
              ...(state ? { state } : {})
            }
          }
          const finalState = await this.buildState(currentResolved)
          return {
            success: true,
            restored: true,
            state: finalState
          }
        } else {
          // Original file did not exist: remove the manager-created permissions.yaml only after verifying hash
          await this.updateManifestStage(operationDir, manifest, 'restoring')

          if (this.deps.beforeCommitHook) {
            await this.deps.beforeCommitHook({
              action: 'restore',
              target: currentResolved.target,
              permissionsPath: currentResolved.permissionsPath
            })
          }

          try {
            const preRestoreResolved = await this.resolveTarget(requestedTarget)
            if (
              !equalCanonicalPath(
                this.deps.platform,
                preRestoreResolved.permissionsPath,
                currentResolved.permissionsPath
              )
            ) {
              throw new KiroPermissionsError(
                'INVALID_TARGET',
                '恢复提交前目标路径已变化，已中止恢复。'
              )
            }
            const preRestoreRaw = await this.readPermissionsRaw(preRestoreResolved)
            if (
              !preRestoreRaw.exists ||
              preRestoreRaw.sha256 !== manifest.afterHash.toLowerCase()
            ) {
              throw new KiroPermissionsError(
                'RESTORE_CONFLICT',
                '恢复提交前权限配置文件已被外部修改，已拒绝删除当前文件。'
              )
            }
          } catch (preRestoreErr) {
            await this.updateManifestStage(operationDir, manifest, 'applied')
            if (preRestoreErr instanceof KiroPermissionsError) {
              const latestState = await this.buildState(currentResolved).catch(() => undefined)
              return {
                success: false,
                code: preRestoreErr.code,
                error: preRestoreErr.message,
                ...(latestState ? { state: latestState } : {})
              }
            }
            throw preRestoreErr
          }

          try {
            await this.io.unlink(currentResolved.permissionsPath)
          } catch {
            const postFailRaw = await this.readPermissionsRaw(currentResolved).catch(() => null)
            if (
              postFailRaw &&
              postFailRaw.exists &&
              postFailRaw.sha256 === manifest.afterHash.toLowerCase()
            ) {
              await this.updateManifestStage(operationDir, manifest, 'applied')
              const latestState = await this.buildState(currentResolved)
              return {
                success: false,
                code: 'WRITE_FAILED',
                error: '无法移除权限配置文件（可能被其他程序占用）；当前文件未更改。',
                state: latestState
              }
            }
            await this.updateManifestStage(operationDir, manifest, 'conflict')
            const latestState = await this.buildState(currentResolved)
            return {
              success: false,
              code: 'VERIFY_FAILED',
              error: '移除权限配置文件时出现不确定结果，已保留备份记录供核对。',
              state: latestState
            }
          }

          const afterUnlinkRaw = await this.readPermissionsRaw(currentResolved).catch(
            () => null
          )
          if (!afterUnlinkRaw || afterUnlinkRaw.exists) {
            await this.updateManifestStage(operationDir, manifest, 'conflict')
            const latestState = await this.buildState(currentResolved).catch(() => undefined)
            return {
              success: false,
              code: 'VERIFY_FAILED',
              error: '恢复后文件状态校验异常，请核对权限配置目录。',
              ...(latestState ? { state: latestState } : {})
            }
          }

          try {
            await this.updateManifestStage(operationDir, manifest, 'restored')
          } catch {
            const state = await this.buildState(currentResolved).catch(() => undefined)
            return {
              success: false,
              code: 'BACKUP_FAILED',
              error: '权限文件已恢复为不存在，但备份事务完成记录尚未保存；请核对待处理状态，未宣告操作完成。',
              ...(state ? { state } : {})
            }
          }
          const finalState = await this.buildState(currentResolved)
          return {
            success: true,
            restored: true,
            state: finalState
          }
        }
      })
    } catch (error) {
      if (error instanceof KiroPermissionsError) {
        return { success: false, code: error.code, error: error.message }
      }
      return {
        success: false,
        code: 'IO_ERROR',
        error: '恢复原权限配置失败，请检查配置目录权限或实例状态。'
      }
    }
  }

  async restoreBeforeAutoApproval(
    requestedTarget: KiroSettingsTarget | undefined,
    expectedRevision: KiroPermissionsRevision
  ): Promise<KiroPermissionsRestoreResult> {
    return this.restoreAutoApproval(requestedTarget, expectedRevision)
  }

  async exportTemplate(...extraArgs: unknown[]): Promise<KiroPermissionsExportResult> {
    if (extraArgs.some(arg => arg !== undefined)) {
      return {
        success: false,
        code: 'EXPORT_FAILED',
        error: '导出配置模板不接受外部路径参数。'
      }
    }
    if (!this.deps.chooseExportPath) {
      return {
        success: false,
        code: 'EXPORT_FAILED',
        error: '当前环境不支持打开系统另存为对话框。'
      }
    }
    try {
      const selectedPath = await this.deps.chooseExportPath()
      if (!selectedPath) {
        return { success: false, canceled: true }
      }
      const canonical = normalizePathFor(this.deps.platform, selectedPath)
      const ops = pathOpsFor(this.deps.platform, canonical)
      const parentDir = ops.dirname(canonical)
      const verifiedParent = await this.verifyBaseDirectory(parentDir, false)
      await this.verifyFileInDirectory(verifiedParent, canonical)

      const tempExportPath = ops.join(
        verifiedParent,
        `.permissions-export.tmp-${(this.deps.uuid ?? randomUUID)().toLowerCase()}`
      )
      await this.verifyFileInDirectory(verifiedParent, tempExportPath)
      try {
        await this.io.writeFile(tempExportPath, KIRO_AUTO_APPROVAL_TEMPLATE_YAML, {
          flag: 'wx',
          mode: 0o600
        })
        await this.io.rename(tempExportPath, canonical)
      } catch (err) {
        await this.io.unlink(tempExportPath).catch(() => {})
        throw err
      }
      return { success: true }
    } catch (error) {
      if (error instanceof KiroPermissionsError) {
        return { success: false, code: error.code, error: error.message }
      }
      return {
        success: false,
        code: 'EXPORT_FAILED',
        error: '导出配置模板失败，请检查目标目录权限。'
      }
    }
  }
}

export function kiroPermissionsFailure(error: unknown): {
  success: false
  code: KiroPermissionsErrorCode
  error: string
} {
  if (error instanceof KiroPermissionsError) {
    return { success: false, code: error.code, error: error.message }
  }
  return {
    success: false,
    code: 'IO_ERROR',
    error: '无法在当前主窗口外访问 Kiro 工具自动批准设置。'
  }
}
