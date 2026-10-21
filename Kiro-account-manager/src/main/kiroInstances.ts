import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type {
  CreateKiroInstanceInput, KiroInstanceRecord, KiroInstancesSnapshot,
  KiroWindowsUser, KiroLaunchStatus
} from '../shared/kiroInstances'

export interface WindowsUserInventory {
  currentSid: string
  currentProfilePath: string
  users: Array<KiroWindowsUser & { disabled: boolean; special: boolean; administrator: boolean }>
}

export interface KiroInstanceDependencies {
  platform: string
  readConfig(): Promise<unknown>
  writeConfig(records: KiroInstanceRecord[]): Promise<void>
  inspectUsers(): Promise<WindowsUserInventory>
  verifyExecutable(profilePath: string, executablePath: string): Promise<void>
  requestLaunch(accountName: string, executablePath: string, profilePath: string, sid: string): Promise<void>
  uuid?: () => string
  now?: () => Date
}

export class KiroInstanceError extends Error {}
const failure = (message: string): never => { throw new KiroInstanceError(message) }
const ORDINARY_USER_SID = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/i

export function isOrdinaryUserSid(sid: string): boolean {
  const match = ORDINARY_USER_SID.exec(sid)
  // Built-in Administrator/Guest/DefaultAccount/WDAG and service identities are not isolated users.
  return !!match && Number(match[1]) >= 1000
}

export function canonicalWindowsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-z]:\\/i.test(value) ||
      /[\x00-\x1f\x7f"<>|&^%?*]/.test(value) || value.includes('/') || value.slice(2).includes(':')) {
    return failure('只支持本地 Windows 盘符路径，路径不能包含控制字符、引号或命令符号。')
  }
  const segments = value.slice(3).split('\\')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment))) {
    return failure('路径必须明确指定，不能包含空片段、相对跳转或末尾空格。')
  }
  return win32.normalize(value)
}

function equalPath(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase() }
function isWithin(root: string, path: string): boolean {
  const relative = win32.relative(root.toLowerCase(), path.toLowerCase())
  return !!relative && !relative.startsWith('..') && !win32.isAbsolute(relative)
}

function safeAccountName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 ||
      !/^[\p{L}\p{N}_.-]+\\[\p{L}\p{N}_ .-]+$/u.test(value) || /[ .]$/.test(value)) {
    return failure('Windows 账户名无效；请使用系统已经创建的本机普通账户。')
  }
  return value
}

export function executableWithinProfile(profile: string, executable: string): string {
  const root = canonicalWindowsPath(profile)
  const path = canonicalWindowsPath(executable)
  if (!isWithin(root, path) || win32.basename(path).toLowerCase() !== 'kiro.exe') {
    return failure('Kiro.exe 必须位于目标 Windows 用户自己的配置目录内，不能使用当前用户或共享安装。')
  }
  return path
}

function eligibleUsers(inventory: WindowsUserInventory): KiroWindowsUser[] {
  if (!isOrdinaryUserSid(inventory.currentSid) && !/^S-1-5-21-\d+-\d+-\d+-500$/i.test(inventory.currentSid)) {
    return failure('无法确认当前 Windows 用户身份，已阻止隔离启动。')
  }
  const currentProfile = canonicalWindowsPath(inventory.currentProfilePath)
  const seen = new Set<string>()
  const users: KiroWindowsUser[] = []
  for (const user of inventory.users) {
    if (user.disabled || user.special || user.administrator || !isOrdinaryUserSid(user.sid) || user.sid.toLowerCase() === inventory.currentSid.toLowerCase()) continue
    if (seen.has(user.sid.toLowerCase())) return failure('系统返回了重复 SID，无法确认隔离用户。')
    seen.add(user.sid.toLowerCase())
    const profilePath = canonicalWindowsPath(user.profilePath)
    if (equalPath(profilePath, currentProfile) || isWithin(currentProfile, profilePath) || isWithin(profilePath, currentProfile)) continue
    users.push({ sid: user.sid, accountName: safeAccountName(user.accountName), profilePath })
  }
  // Two different SIDs pointing at one profile are not separate credential environments.
  if (users.some((user, index) => users.some((other, otherIndex) => index !== otherIndex &&
      (equalPath(user.profilePath, other.profilePath) || isWithin(user.profilePath, other.profilePath))))) {
    return failure('不同 Windows 用户指向相同配置目录，已阻止隔离启动。')
  }
  return users
}

function decodeRecords(value: unknown): KiroInstanceRecord[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 50) return failure('实例配置损坏，请检查本地配置。')
  const ids = new Set<string>()
  const sids = new Set<string>()
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return failure('实例配置无效。')
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.id) || ids.has(row.id) ||
        typeof row.sid !== 'string' || !isOrdinaryUserSid(row.sid) || sids.has(row.sid.toLowerCase()) ||
        typeof row.label !== 'string' || !row.label.trim() || row.label.length > 60 || /[\x00-\x1f\x7f]/.test(row.label) ||
        typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return failure('实例配置无效或包含重复身份。')
    ids.add(row.id); sids.add(row.sid.toLowerCase())
    const profilePath = canonicalWindowsPath(row.profilePath)
    return {
      id: row.id, label: row.label.trim(), sid: row.sid,
      accountName: safeAccountName(row.accountName), profilePath,
      executablePath: executableWithinProfile(profilePath, row.executablePath as string), createdAt: row.createdAt
    }
  })
}

/** Tracks a launch request only. A runas exit never proves that the IDE is running or stopped. */
export class KiroInstanceService {
  private readonly launches = new Map<string, { launchStatus: KiroLaunchStatus; message?: string }>()
  private changes: Promise<unknown> = Promise.resolve()
  private readonly deps: KiroInstanceDependencies
  constructor(deps: KiroInstanceDependencies) { this.deps = deps }

  private assertWindows(): void {
    if (this.deps.platform !== 'win32') failure('此版本仅支持 Windows 用户隔离的 Kiro 客户端多开。')
  }

  private async users(): Promise<KiroWindowsUser[]> {
    this.assertWindows()
    return eligibleUsers(await this.deps.inspectUsers())
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const work = this.changes.then(action, action)
    this.changes = work.catch(() => {})
    return work
  }

  async snapshot(): Promise<KiroInstancesSnapshot> {
    const records = decodeRecords(await this.deps.readConfig())
    if (this.deps.platform !== 'win32') return {
      supported: false, message: '此版本仅支持 Windows 用户隔离；不会在当前用户内模拟认证隔离。', users: [],
      instances: records.map(record => ({ ...record, launchStatus: 'idle' }))
    }
    const users = await this.users()
    return { supported: true, users, instances: records.map(record => ({ ...record, ...this.launches.get(record.id), launchStatus: this.launches.get(record.id)?.launchStatus ?? 'idle' })) }
  }

  async create(input: CreateKiroInstanceInput): Promise<KiroInstanceRecord> {
    this.assertWindows()
    return this.mutate(async () => {
      if (!input || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 60 || /[\x00-\x1f\x7f]/.test(input.label)) failure('请输入 1–60 字的实例名称。')
      if (typeof input.sid !== 'string') failure('请先选择目标 Windows 用户。')
      const user = (await this.users()).find(row => row.sid.toLowerCase() === input.sid.toLowerCase())
      if (!user) return failure('目标必须是不同于当前用户、已启用且已初始化配置目录的 Windows 普通账户。')
      const records = decodeRecords(await this.deps.readConfig())
      if (records.some(row => row.sid.toLowerCase() === user.sid.toLowerCase())) failure('同一个 Windows SID 只能创建一个隔离实例。')
      if (records.length >= 50) failure('最多配置 50 个实例。')
      const executablePath = executableWithinProfile(user.profilePath, input.executablePath)
      await this.deps.verifyExecutable(user.profilePath, executablePath)
      const record: KiroInstanceRecord = {
        ...user, id: (this.deps.uuid ?? randomUUID)(), label: input.label.trim(), executablePath,
        createdAt: (this.deps.now ?? (() => new Date()))().toISOString()
      }
      await this.deps.writeConfig([...records, record])
      return record
    })
  }

  async remove(id: string): Promise<void> {
    this.assertWindows()
    return this.mutate(async () => {
      if (this.launches.get(id)?.launchStatus === 'awaiting-credentials') failure('系统授权窗口尚未结束，请先完成或取消该窗口。')
      const records = decodeRecords(await this.deps.readConfig())
      if (!records.some(record => record.id === id)) failure('实例不存在。')
      await this.deps.writeConfig(records.filter(record => record.id !== id))
      this.launches.delete(id)
    })
  }

  async launch(id: string): Promise<void> {
    this.assertWindows()
    // Set before any await so concurrent IPC requests cannot open two credential prompts.
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) failure('实例标识无效。')
    if (this.launches.get(id)?.launchStatus === 'awaiting-credentials') failure('此实例已经有一个待完成的系统授权窗口。')
    this.launches.set(id, { launchStatus: 'awaiting-credentials', message: '请在 Windows runas 窗口输入目标用户密码；管理器不会读取或保存密码。' })
    try {
      const record = decodeRecords(await this.deps.readConfig()).find(row => row.id === id)
      if (!record) return failure('实例不存在。')
      const user = (await this.users()).find(row => row.sid.toLowerCase() === record.sid.toLowerCase())
      if (!user || !equalPath(user.profilePath, record.profilePath) || user.accountName.toLowerCase() !== record.accountName.toLowerCase()) {
        return failure('Windows 用户或配置目录已变化，请移除此配置后重新创建。')
      }
      await this.deps.verifyExecutable(user.profilePath, executableWithinProfile(user.profilePath, record.executablePath))
      await this.deps.requestLaunch(user.accountName, record.executablePath, user.profilePath, user.sid)
      this.launches.set(id, { launchStatus: 'requested', message: '系统已接受启动请求。请查看目标用户的 Kiro 窗口；此状态不代表 IDE 存活检测。' })
    } catch (error) {
      const message = error instanceof KiroInstanceError ? error.message : '无法验证或启动该实例。请检查目标用户、目录读取权限和 Windows Secondary Logon 服务；未操作现有客户端。'
      this.launches.set(id, { launchStatus: 'error', message })
      throw new KiroInstanceError(message)
    }
  }
}

// All scripts are constant. User-derived values travel only through stdin JSON, never script text.
const POWERSHELL_PREFIX = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); `
export const INSPECT_USERS_SCRIPT = POWERSHELL_PREFIX + `
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();
$profiles=@(Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath });
$adminGroup=@(Get-CimInstance Win32_Group -Filter "LocalAccount=True AND SID='S-1-5-32-544'");
if ($adminGroup.Count -ne 1) { throw 'cannot determine administrators group' };
$administratorSids=@(Get-CimAssociatedInstance -InputObject $adminGroup[0] -Association Win32_GroupUser | ForEach-Object { $_.SID });
$users=@(Get-CimInstance Win32_UserAccount -Filter 'LocalAccount=True' | ForEach-Object {
  $account=$_; $profile=@($profiles | Where-Object { $_.SID -eq $account.SID });
  if ($profile.Count -eq 1) { [pscustomobject]@{ sid=$account.SID; accountName=($account.Domain+'\\'+$account.Name); profilePath=$profile[0].LocalPath; disabled=[bool]$account.Disabled; special=[bool]$profile[0].Special; administrator=[bool]($account.SID -in $administratorSids) } }
});
[pscustomobject]@{currentSid=$identity.User.Value; currentProfilePath=[Environment]::GetFolderPath('UserProfile'); users=$users} | ConvertTo-Json -Compress -Depth 4
`

// Reused in the inspection and launch helpers. The read handle denies modification/deletion
// until runas accepts or declines, including time spent waiting for its password prompt.
const VERIFY_EXECUTABLE_BODY = `
$profile=[IO.Path]::GetFullPath([string]$payload.profilePath).TrimEnd('\\');
$exe=[IO.Path]::GetFullPath([string]$payload.executablePath);
if (-not $exe.StartsWith($profile+'\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'outside profile' };
if ([IO.Path]::GetFileName($exe) -ine 'Kiro.exe') { throw 'unexpected executable' };
$item=Get-Item -LiteralPath $exe -Force;
if ($item.PSIsContainer) { throw 'not executable file' };
while ($null -ne $item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point not allowed' };
  if ($item -is [IO.FileInfo]) { $item=$item.Directory } else { $item=$item.Parent };
};
$stream=[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
if ($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { throw 'not PE' };
$signature=Get-AuthenticodeSignature -LiteralPath $exe;
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'invalid signature' };
$publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);
if ($publisher -notin @($payload.trustedPublishers)) { throw 'unexpected publisher' };
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName -ne 'Kiro') { throw 'unexpected product' };
`

export const VERIFY_EXECUTABLE_SCRIPT = POWERSHELL_PREFIX + `
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$stream=$null;
try {
${VERIFY_EXECUTABLE_BODY}
Write-Output 'verified';
} finally { if ($null -ne $stream) { $stream.Dispose() } }
`

/** Standard Windows argv escaping; Start-Process joins its ArgumentList into one command line. */
export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}

export function runasArguments(accountName: string, executablePath: string, profilePath: string): string[] {
  const account = safeAccountName(accountName)
  const executable = executableWithinProfile(profilePath, executablePath)
  // User data and extensions are in the same target profile; authentication uses that OS user's homedir.
  // Never use /env, /savecred, manager credentials, workspaces, or renderer-supplied CLI arguments.
  const command = [quoteWindowsArgument(executable), '--new-window'].join(' ')
  return ['/profile', `/user:${account}`, command]
}

export const REQUEST_LAUNCH_SCRIPT = POWERSHELL_PREFIX + `
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$stream=$null;
try {
${VERIFY_EXECUTABLE_BODY}
$account=New-Object Security.Principal.NTAccount([string]$payload.accountName);
$sid=$account.Translate([Security.Principal.SecurityIdentifier]).Value;
if ($sid -ne [string]$payload.sid -or $sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'identity changed' };
$targetUsers=@(Get-CimInstance Win32_UserAccount -Filter 'LocalAccount=True' | Where-Object { $_.SID -eq $sid -and -not $_.Disabled });
if ($targetUsers.Count -ne 1) { throw 'target user unavailable' };
$adminGroup=@(Get-CimInstance Win32_Group -Filter "LocalAccount=True AND SID='S-1-5-32-544'");
if ($adminGroup.Count -ne 1) { throw 'cannot determine administrators group' };
$administratorSids=@(Get-CimAssociatedInstance -InputObject $adminGroup[0] -Association Win32_GroupUser | ForEach-Object { $_.SID });
if ($sid -in $administratorSids) { throw 'target user is an administrator' };
$profileRows=@(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid -and -not $_.Special });
if ($profileRows.Count -ne 1 -or [string]$profileRows[0].LocalPath -ine [string]$payload.profilePath) { throw 'profile changed' };
$runas=Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\\runas.exe';
$process=Start-Process -FilePath $runas -ArgumentList ([string]$payload.argumentLine) -WorkingDirectory $profile -WindowStyle Normal -PassThru;
# Start-Process -Wait waits for descendants too; only the runas prompt is relevant here.
$process.WaitForExit();
if ($process.ExitCode -ne 0) { throw 'runas declined' };
Write-Output 'requested';
} finally { if ($null -ne $stream) { $stream.Dispose() } }
`

export interface PowerShellOptions { interactive?: boolean }
export type PowerShellExecutor = (script: string, payload?: unknown, options?: PowerShellOptions) => Promise<string>

/** The helper has no command shell, never receives credentials, and never starts Kiro during tests. */
export const executeWindowsPowerShell: PowerShellExecutor = (script, payload, options = {}) => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new KiroInstanceError('仅支持 Windows。'))
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !/^[a-z]:\\windows$/i.test(systemRoot)) return reject(new KiroInstanceError('无法确认 Windows 系统目录。'))
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    // Do not pass portable/HOME/APPDATA overrides from this manager to a target user.
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, 'System32') }
  })
  let output = ''
  let oversized = false
  // Noninteractive inspection has a bound; password entry has no artificial timeout and remains visible.
  const timer = options.interactive ? undefined : setTimeout(() => child.kill(), 30_000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { if (output.length + chunk.length < 512_000) output += chunk; else { oversized = true; child.kill() } })
  // Never expose a raw system exception (which can contain local identities or full paths) to logs or IPC.
  child.stderr.resume()
  child.once('error', () => { if (timer) clearTimeout(timer); reject(new KiroInstanceError('Windows 系统查询无法启动。')) })
  child.once('close', code => {
    if (timer) clearTimeout(timer)
    if (code === 0 && !oversized) resolve(output.trim())
    else reject(new KiroInstanceError(options.interactive ? '系统未接受启动请求；请检查目标用户密码或在 runas 窗口取消后重试。' : '无法验证 Windows 用户、安装目录或官方数字签名；请检查读取权限及安装是否完整。'))
  })
  child.stdin.on('error', () => {})
  child.stdin.end(payload === undefined ? '' : JSON.stringify(payload))
})

function parseInventory(raw: string): WindowsUserInventory {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') return failure('Windows 身份查询无效。')
  const row = value as Record<string, unknown>
  if (typeof row.currentSid !== 'string' || typeof row.currentProfilePath !== 'string' || !Array.isArray(row.users)) return failure('Windows 身份查询不完整。')
  const users = row.users.map((rawUser: unknown) => {
    if (!rawUser || typeof rawUser !== 'object') return failure('Windows 用户查询无效。')
    const user = rawUser as Record<string, unknown>
    if (typeof user.sid !== 'string' || typeof user.accountName !== 'string' || typeof user.profilePath !== 'string' || typeof user.disabled !== 'boolean' || typeof user.special !== 'boolean' || typeof user.administrator !== 'boolean') return failure('Windows 用户查询不完整。')
    return { sid: user.sid, accountName: user.accountName, profilePath: user.profilePath, disabled: user.disabled, special: user.special, administrator: user.administrator }
  })
  return { currentSid: row.currentSid, currentProfilePath: row.currentProfilePath, users }
}

export function createWindowsKiroInstanceService(options: {
  readConfig(): Promise<unknown>
  writeConfig(records: KiroInstanceRecord[]): Promise<void>
  execute?: PowerShellExecutor
  platform?: string
  /** Populate only from a verified current official Windows distribution; empty fails closed. */
  trustedPublishers?: readonly string[]
}): KiroInstanceService {
  const execute = options.execute ?? executeWindowsPowerShell
  return new KiroInstanceService({
    platform: options.platform ?? process.platform, readConfig: options.readConfig, writeConfig: options.writeConfig,
    inspectUsers: async () => parseInventory(await execute(INSPECT_USERS_SCRIPT)),
    verifyExecutable: async (profilePath, executablePath) => {
      if (!options.trustedPublishers?.length) failure('当前官方 Windows 客户端签名尚未核实，隔离启动暂不可用。')
      if (await execute(VERIFY_EXECUTABLE_SCRIPT, { profilePath, executablePath, trustedPublishers: options.trustedPublishers }) !== 'verified') failure('安装验证未完成。')
    },
    requestLaunch: async (accountName, executablePath, profilePath, sid) => {
      const args = runasArguments(accountName, executablePath, profilePath)
      const argumentLine = args.map(quoteWindowsArgument).join(' ')
      if (await execute(REQUEST_LAUNCH_SCRIPT, { argumentLine, accountName, executablePath, profilePath, sid, trustedPublishers: options.trustedPublishers }, { interactive: true }) !== 'requested') failure('系统未确认启动请求。')
    }
  })
}
