import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type {
  CreateKiroInstanceInput, KiroInstanceRecord, KiroInstancesSnapshot, KiroInstanceView,
  KiroInstancePaths, KiroProcessIdentity, KiroLaunchStatus
} from '../shared/kiroInstances'
import type { KiroInstanceRuntime, KiroProcessInventory, KiroProcessObservation } from './kiroInstanceRuntimeTypes'
import {
  canonicalWindowsPath, equalWindowsPath, makeInstancePaths, prepareInstanceDirectories,
  verifyInstanceDirectories, checkInstanceDirectory, instanceFileSystem, UUID, KiroInstanceError, failInstance,
  type KiroInstanceFileSystem
} from './kiroInstancePaths'
export { canonicalWindowsPath, makeInstancePaths, KiroInstanceError } from './kiroInstancePaths'

export interface KiroInstanceDependencies {
  platform: string
  baseRoot: string
  readConfig(): Promise<unknown>
  writeConfig(records: KiroInstanceRecord[]): Promise<void>
  runtime: KiroInstanceRuntime
  /** Writes only the explicitly bound account into this verified profile; never refreshes it. */
  prepareAccount?: (record: KiroInstanceRecord) => Promise<void>
  /** Imports the profile's latest credential generation after it has completely stopped. */
  syncAccount?: (record: KiroInstanceRecord) => Promise<void>
  /** Explicit recovery: preserve unverified cache, mark the original account for reauthorization. */
  markAccountReauthorizationRequired?: (record: KiroInstanceRecord) => Promise<void>
  parentEnv?: NodeJS.ProcessEnv
  fileSystem?: KiroInstanceFileSystem
  uuid?: () => string
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  pollIntervalMs?: number
  launchTimeoutMs?: number
  stopTimeoutMs?: number
}

/** Windows CommandLineToArgvW rules; a command string is only parsed, never evaluated. */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = []
  let value = '', quoted = false, started = false
  for (let index = 0; index < commandLine.length;) {
    const char = commandLine[index]
    if (!quoted && /\s/.test(char)) { if (started) { args.push(value); value = ''; started = false }; index++; continue }
    started = true
    if (char === '\\') {
      let count = 0
      while (commandLine[index] === '\\') { count++; index++ }
      if (commandLine[index] === '"') {
        value += '\\'.repeat(Math.floor(count / 2))
        if (count % 2) value += '"'
        else quoted = !quoted
        index++
      } else value += '\\'.repeat(count)
    } else if (char === '"') { quoted = !quoted; index++ }
    else { value += char; index++ }
  }
  if (quoted) failInstance('进程参数无法完整识别。')
  if (started) args.push(value)
  return args
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 1; index < args.length; index++) {
    if (args[index] === flag) values.push(args[++index] ?? '')
    else if (args[index].startsWith(flag + '=')) values.push(args[index].slice(flag.length + 1))
  }
  return values
}
function mainProcess(args: string[]): boolean { return !args.some(arg => arg === '--type' || arg.startsWith('--type=')) }
function validPid(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function validDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function validAccountId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) }
function processIdentity(row: KiroProcessObservation, userDataPath: string): KiroProcessIdentity {
  if (!validPid(row.pid) || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 ||
      typeof row.ownerSid !== 'string' || !row.ownerSid || !validDate(row.startedAt)) failInstance('进程身份信息不完整。')
  return {
    pid: row.pid, parentPid: row.parentPid, ownerSid: row.ownerSid!,
    executablePath: canonicalWindowsPath(row.executablePath), startedAt: row.startedAt!, userDataPath
  }
}
function sameIdentity(a: KiroProcessIdentity, b: KiroProcessIdentity): boolean {
  return a.pid === b.pid && a.parentPid === b.parentPid && a.ownerSid.toLowerCase() === b.ownerSid.toLowerCase() &&
    equalWindowsPath(a.executablePath, b.executablePath) && a.startedAt === b.startedAt
}

export function buildInstanceArguments(paths: KiroInstancePaths): string[] {
  return [
    '--user-data-dir', paths.userData, '--extensions-dir', paths.extensions, '--shared-data-dir', paths.sharedData,
    '--agent-plugins-dir', paths.agentPlugins, '--agents-user-data-dir', paths.agentsUserData,
    '--agents-extensions-dir', paths.agentsExtensions, '--new-window', '--disable-updates'
  ]
}
export function buildInstanceEnvironment(parent: NodeJS.ProcessEnv, paths: KiroInstancePaths, portableSupported: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (/^(?:VSCODE_|ELECTRON_RUN_AS_NODE$|NODE_|AWS_|KIRO_|AMAZON_Q_|CODEWHISPERER_)/i.test(key)) continue
    if (/^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP)$/i.test(key)) continue
    env[key] = value
  }
  Object.assign(env, {
    HOME: paths.home, USERPROFILE: paths.home, HOMEDRIVE: win32.parse(paths.home).root.slice(0, 2),
    HOMEPATH: paths.home.slice(2), APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp, TMP: paths.temp,
    AWS_CONFIG_FILE: win32.join(paths.home, '.aws', 'config'),
    AWS_SHARED_CREDENTIALS_FILE: win32.join(paths.home, '.aws', 'credentials'),
    AWS_EC2_METADATA_DISABLED: 'true'
  })
  if (portableSupported) env.VSCODE_PORTABLE = paths.portable
  return env
}

interface VerifiedState { status: 'stopped' | 'running' | 'exited' | 'unverified'; processes: KiroProcessIdentity[]; message?: string; draining?: boolean }
interface LegacyRecord { id: string; label: string; executablePath: string; createdAt: string; [key: string]: unknown }
type StoredRecord = KiroInstanceRecord | LegacyRecord

/** Never trusts a launcher PID, process name, or renderer-supplied paths to decide ownership. */
export class KiroInstanceService {
  private readonly deps: KiroInstanceDependencies
  private readonly io: KiroInstanceFileSystem
  private changes: Promise<unknown> = Promise.resolve()
  private readonly operations = new Map<string, { name: string; promise: Promise<void> }>()
  private readonly epochs = new Map<string, number>()
  private readonly transient = new Map<string, { status: KiroLaunchStatus; message?: string }>()
  constructor(deps: KiroInstanceDependencies) { this.deps = deps; this.io = deps.fileSystem ?? instanceFileSystem }
  private assertWindows(): void { if (this.deps.platform !== 'win32') failInstance('目前仅支持 Windows Kiro 客户端实例。') }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const work = this.changes.then(action, action); this.changes = work.catch(() => {}); return work
  }
  private async records(): Promise<StoredRecord[]> {
    const raw = await this.deps.readConfig()
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw) || raw.length > 50) return failInstance('实例配置损坏。')
    const ids = new Set<string>()
    const accountIds = new Set<string>()
    return raw.map(item => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(item.id) || ids.has(item.id) ||
          typeof item.label !== 'string' || !item.label.trim() || item.label.length > 60 || /[\x00-\x1f\x7f]/.test(item.label) ||
          typeof item.executablePath !== 'string' || !validDate(item.createdAt)) return failInstance('实例配置包含无效或重复标识。')
      ids.add(item.id)
      if (item.schemaVersion !== 2) return item as LegacyRecord
      if (!UUID.test(item.id)) return failInstance('实例标识无效。')
      if (item.accountId !== undefined) {
        if (!validAccountId(item.accountId) || accountIds.has(item.accountId)) return failInstance('账户绑定无效或同一账户重复绑定了多个实例。')
        accountIds.add(item.accountId)
      }
      const executable = canonicalWindowsPath(item.executablePath)
      if (win32.basename(executable).toLowerCase() !== 'kiro.exe') return failInstance('实例安装路径无效。')
      if (!item.paths || typeof item.paths !== 'object') return failInstance('实例目录配置无效。')
      const portable = equalWindowsPath(item.paths.userData ?? '', makeInstancePaths(this.deps.baseRoot, item.id, true).userData)
      const expected = makeInstancePaths(this.deps.baseRoot, item.id, portable)
      if (Object.keys(item.paths).length !== Object.keys(expected).length || Object.entries(expected).some(([key, path]) =>
          typeof item.paths[key] !== 'string' || !equalWindowsPath(item.paths[key], path))) return failInstance('实例目录与管理根目录不匹配。')
      if (item.lastProcesses !== undefined && (!Array.isArray(item.lastProcesses) || item.lastProcesses.length > 500)) return failInstance('实例进程记录无效。')
      const lastProcesses = item.lastProcesses?.map((row: KiroProcessIdentity) => {
        const identity = processIdentity(row, expected.userData)
        if (!equalWindowsPath(row.userDataPath, expected.userData)) return failInstance('实例进程记录不匹配。')
        return identity
      })
      return { schemaVersion: 2, id: item.id, label: item.label.trim(), executablePath: executable, createdAt: item.createdAt, paths: expected,
        ...(item.accountId !== undefined ? { accountId: item.accountId } : {}), ...(lastProcesses ? { lastProcesses } : {}) }
    })
  }
  private async record(id: string): Promise<KiroInstanceRecord> {
    const record = (await this.records()).find(row => row.id === id)
    if (!record) return failInstance('实例不存在。')
    if (record.schemaVersion !== 2) return failInstance('旧版 Windows 用户配置不能用于当前多开，请移除配置后重新创建。')
    return record as KiroInstanceRecord
  }
  private async remember(record: KiroInstanceRecord, processes: KiroProcessIdentity[], expectedEpoch?: number): Promise<void> {
    if (expectedEpoch !== undefined && expectedEpoch !== (this.epochs.get(record.id) ?? 0)) return
    if (JSON.stringify(record.lastProcesses) === JSON.stringify(processes)) return
    await this.mutate(async () => {
      if (expectedEpoch !== undefined && expectedEpoch !== (this.epochs.get(record.id) ?? 0)) return
      const records = await this.records()
      await this.deps.writeConfig(records.map(row => row.id === record.id ? { ...row, lastProcesses: processes } : row) as KiroInstanceRecord[])
    })
    if (expectedEpoch === undefined || expectedEpoch === (this.epochs.get(record.id) ?? 0)) record.lastProcesses = processes
  }
  private async verifyPaths(record: KiroInstanceRecord): Promise<void> {
    if (!this.deps.runtime.assertSafeDirectories) await this.deps.runtime.assertSafeDirectory?.(record.paths.root)
    await verifyInstanceDirectories(this.io, record.paths, record.id)
    if (this.deps.runtime.assertSafeDirectories) await this.deps.runtime.assertSafeDirectories([
      ...Object.values(record.paths), win32.join(record.paths.home, '.aws', 'sso', 'cache'), win32.join(record.paths.home, '.kiro')
    ])
    else await this.deps.runtime.assertSafeDirectory?.(record.paths.root)
  }
  private async inspect(record: KiroInstanceRecord, inventory?: KiroProcessInventory, expectedEpoch?: number): Promise<VerifiedState> {
    try {
      await this.verifyPaths(record)
      const observed = inventory ?? await this.deps.runtime.inspectProcesses()
      if (!observed.complete || !observed.currentSid) failInstance('系统进程清单不完整，已阻止启动、停止和重启。')
      const rows = observed.processes
      const byPid = new Map(rows.map(row => [row.pid, row]))
      if (byPid.size !== rows.length || rows.some(row => !validPid(row.pid))) failInstance('系统进程清单含重复或无效 PID。')
      // Persisted identities protect restart recovery and children remaining after a main process exits.
      for (const previous of record.lastProcesses ?? []) {
        const row = byPid.get(previous.pid)
        if (row && !sameIdentity(previous, processIdentity(row, record.paths.userData))) failInstance('先前进程 PID 已被复用，当前归属无法确认。')
      }
      const candidates: KiroProcessObservation[] = []
      for (const row of rows) {
        if (!row.commandLine) continue
        let args: string[]
        try { args = parseWindowsCommandLine(row.commandLine) }
        catch { if (row.executablePath && equalWindowsPath(row.executablePath, record.executablePath)) throw new KiroInstanceError('Kiro 进程参数无法识别。'); continue }
        const values = flagValues(args, '--user-data-dir')
        const matching = values.some(value => { try { return equalWindowsPath(canonicalWindowsPath(value), record.paths.userData) } catch { return false } })
        if (!matching || !mainProcess(args)) continue
        if (values.length !== 1 || !row.executablePath || !equalWindowsPath(canonicalWindowsPath(row.executablePath), record.executablePath) ||
            !args[0] || !equalWindowsPath(canonicalWindowsPath(args[0]), record.executablePath) || row.ownerSid?.toLowerCase() !== observed.currentSid.toLowerCase()) {
          failInstance('实例进程身份或 user-data-dir 参数不唯一，已阻止操作。')
        }
        candidates.push(row)
      }
      if (candidates.length > 1) failInstance('同一实例出现多个主进程，已阻止操作。')
      if (!candidates.length) {
        // A main process can exit between observations after creating another child. Discover
        // those descendants from the last verified parent identities before declaring it stopped.
        const previousGroup = [...record.lastProcesses ?? []]
        const known = new Set(previousGroup.map(previous => previous.pid))
        let grew = true
        while (grew) {
          grew = false
          for (const row of rows) {
            if (known.has(row.pid) || !known.has(row.parentPid)) continue
            const parent = previousGroup.find(previous => previous.pid === row.parentPid)!
            const child = processIdentity(row, record.paths.userData)
            if (child.ownerSid.toLowerCase() !== observed.currentSid.toLowerCase() ||
                !equalWindowsPath(child.executablePath, record.executablePath) || Date.parse(child.startedAt) < Date.parse(parent.startedAt)) {
              failInstance('退出中的子进程归属无法确认。')
            }
            known.add(row.pid); previousGroup.push(child); grew = true
          }
        }
        if (previousGroup.some(previous => byPid.has(previous.pid))) {
          await this.remember(record, previousGroup, expectedEpoch)
          return {
            status: 'unverified', processes: [], draining: true,
            message: '实例主进程已退出，仍有归属进程存活；请等待其退出或处理窗口。'
          }
        }
        return { status: record.lastProcesses?.length ? 'exited' : 'stopped', processes: [], ...(record.lastProcesses?.length ? { message: '实例进程已退出，原因未确认；可重新启动。' } : {}) }
      }
      const main = candidates[0]
      const group: KiroProcessIdentity[] = [processIdentity(main, record.paths.userData)]
      const included = new Set([main.pid])
      let grew = true
      while (grew) {
        grew = false
        for (const row of rows) {
          if (included.has(row.pid) || !included.has(row.parentPid)) continue
          const identity = processIdentity(row, record.paths.userData)
          const parent = group.find(item => item.pid === row.parentPid)!
          if (identity.ownerSid.toLowerCase() !== observed.currentSid.toLowerCase() || Date.parse(identity.startedAt) < Date.parse(parent.startedAt)) failInstance('子进程归属信息无法确认。')
          group.push(identity); included.add(row.pid); grew = true
        }
      }
      if ((record.lastProcesses ?? []).some(previous => byPid.has(previous.pid) && !included.has(previous.pid))) failInstance('存在不再属于当前主进程的历史子进程。')
      await this.remember(record, group, expectedEpoch)
      return { status: 'running', processes: group }
    } catch (error) {
      return { status: 'unverified', processes: [], message: error instanceof KiroInstanceError ? error.message : '无法验证实例目录或进程身份，已阻止操作。' }
    }
  }
  async snapshot(): Promise<KiroInstancesSnapshot> {
    const epochs = new Map(this.epochs)
    const records = await this.records()
    if (this.deps.platform !== 'win32') return { supported: false, message: '目前仅支持 Windows Kiro 客户端实例。', instances: [] }
    const inventory = await this.deps.runtime.inspectProcesses().catch(() => ({ complete: false, currentSid: '', processes: [] }))
    const instances: KiroInstanceView[] = []
    for (const row of records) {
      if (row.schemaVersion !== 2) {
        instances.push({ schemaVersion: 1, id: row.id, label: row.label, executablePath: row.executablePath, launchStatus: 'legacy', canStop: false, canRestart: false, message: '旧版 Windows 用户配置已停用，请移除配置后按独立目录重新创建。' })
        continue
      }
      const record = row as KiroInstanceRecord
      const pending = this.transient.get(record.id)
      if (pending) { instances.push({ ...record, launchStatus: pending.status, message: pending.message, canStop: false, canRestart: false }); continue }
      const epoch = epochs.get(record.id) ?? 0
      const state = await this.inspect(record, inventory, epoch)
      if (epoch !== (this.epochs.get(record.id) ?? 0)) {
        const current = this.transient.get(record.id)
        instances.push({ ...record, launchStatus: current?.status ?? 'unverified', message: current?.message ?? '实例状态刚刚变化，请刷新后重试。', canStop: false, canRestart: false })
        continue
      }
      instances.push({ ...record, launchStatus: state.status, message: state.message, pid: state.processes[0]?.pid,
        canStop: state.status === 'running', canRestart: state.status !== 'unverified' })
    }
    return { supported: true, instances }
  }
  async create(input: CreateKiroInstanceInput): Promise<KiroInstanceRecord> {
    this.assertWindows()
    return this.mutate(async () => {
      if (!input || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 60 || /[\x00-\x1f\x7f]/.test(input.label)) failInstance('请输入 1–60 字的实例名称。')
      const executablePath = canonicalWindowsPath(input.executablePath)
      if (win32.basename(executablePath).toLowerCase() !== 'kiro.exe') failInstance('请选择官方 Kiro.exe。')
      const records = await this.records()
      if (records.length >= 50) failInstance('最多配置 50 个实例。')
      if (input.accountId !== undefined && (!validAccountId(input.accountId) || records.some(row => row.schemaVersion === 2 && row.accountId === input.accountId))) {
        failInstance('账户绑定无效或该账户已绑定其他实例，请为不同实例选择不同账户。')
      }
      const installation = await this.deps.runtime.inspectInstallation(executablePath)
      const id = (this.deps.uuid ?? randomUUID)().toLowerCase()
      if (!UUID.test(id) || records.some(row => row.id === id)) failInstance('无法生成唯一实例标识。')
      const paths = makeInstancePaths(this.deps.baseRoot, id, installation.portableSupported)
      await this.deps.runtime.assertSafeDirectory?.(this.deps.baseRoot)
      await prepareInstanceDirectories(this.io, paths, id)
      await this.deps.runtime.assertSafeDirectory?.(paths.root)
      const user = win32.join(paths.userData, 'User')
      await checkInstanceDirectory(this.io, user, true)
      await this.io.writeMarker(win32.join(user, 'settings.json'), JSON.stringify({ 'window.title': `Kiro · ${input.label.trim()}`, 'update.mode': 'none', 'extensions.autoUpdate': false }))
      await this.deps.runtime.assertSafeDirectory?.(paths.root)
      const record: KiroInstanceRecord = { schemaVersion: 2, id, label: input.label.trim(), executablePath, createdAt: (this.deps.now ?? (() => new Date()))().toISOString(), paths,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}) }
      await this.deps.writeConfig([...records, record] as KiroInstanceRecord[])
      return record
    })
  }
  private operate(id: string, name: string, action: () => Promise<void>): Promise<void> {
    this.assertWindows()
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(id)) return Promise.reject(new KiroInstanceError('实例标识无效。'))
    const previous = this.operations.get(id)
    if (previous) return previous.name === name ? previous.promise : Promise.reject(new KiroInstanceError('该实例还有操作正在完成，请稍后重试。'))
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    const promise = Promise.resolve().then(action).finally(() => { this.operations.delete(id); this.transient.delete(id) })
    this.operations.set(id, { name, promise })
    return promise
  }
  private async waitFor(record: KiroInstanceRecord, desired: 'running' | 'stopped', timeout: number): Promise<VerifiedState> {
    const interval = Math.max(1, this.deps.pollIntervalMs ?? 400)
    for (let attempt = 0; attempt <= Math.ceil(timeout / interval); attempt++) {
      const state = await this.inspect(record)
      if (state.status === 'unverified' && !(desired === 'stopped' && state.draining)) failInstance(state.message ?? '实例身份无法确认。')
      if (desired === 'running' ? state.status === 'running' : state.status === 'stopped' || state.status === 'exited') return state
      if (attempt < Math.ceil(timeout / interval)) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(interval)
    }
    return failInstance(desired === 'running' ? '启动请求已发送，但未确认独立主进程；请检查 Kiro 窗口后重试。' : 'Kiro 尚未退出，可能正在等待保存文件；请处理窗口后重试，未强制终止进程。')
  }
  private async startRecord(record: KiroInstanceRecord): Promise<void> {
    const before = await this.inspect(record)
    if (before.status === 'unverified') failInstance(before.message!)
    if (before.status === 'running') failInstance('该实例已经运行。')
    const info = await this.deps.runtime.inspectInstallation(record.executablePath)
    const portable = equalWindowsPath(record.paths.userData, makeInstancePaths(this.deps.baseRoot, record.id, true).userData)
    if (portable !== info.portableSupported) failInstance('Kiro 安装模式已变化，请重新创建实例；原实例数据保留。')
    await this.verifyPaths(record)
    this.transient.set(record.id, { status: 'starting', message: '正在等待独立 Kiro 主进程。' })
    if (record.accountId) {
      if (!this.deps.prepareAccount || !this.deps.syncAccount) failInstance('当前环境尚未提供完整的账户绑定准备及同步功能，未启动实例。')
      // An externally closed IDE may own a newer rotation than the manager's last snapshot.
      if (before.status === 'exited') await this.deps.syncAccount!(record)
      await this.deps.prepareAccount!(record)
      await this.verifyPaths(record)
    }
    await this.remember(record, [])
    await this.deps.runtime.launch(record.executablePath, buildInstanceArguments(record.paths), buildInstanceEnvironment(this.deps.parentEnv ?? process.env, record.paths, portable), record.paths.home)
    await this.waitFor(record, 'running', this.deps.launchTimeoutMs ?? 15_000)
  }
  private async stopRecord(record: KiroInstanceRecord): Promise<void> {
    const before = await this.inspect(record)
    if (before.status === 'unverified') failInstance(before.message!)
    if (record.accountId && !this.deps.syncAccount) failInstance('当前环境尚未提供账户同步功能，未停止或解除绑定。')
    if (before.status !== 'running') {
      if (record.accountId) await this.deps.syncAccount!(record)
      return
    }
    this.transient.set(record.id, { status: 'stopping', message: '正在等待 Kiro 保存并关闭窗口。' })
    await this.deps.runtime.requestClose(before.processes)
    await this.waitFor(record, 'stopped', this.deps.stopTimeoutMs ?? 15_000)
    if (record.accountId) await this.deps.syncAccount!(record)
  }
  launch(id: string): Promise<void> { return this.operate(id, 'launch', async () => this.startRecord(await this.record(id))) }
  stop(id: string): Promise<void> { return this.operate(id, 'stop', async () => this.stopRecord(await this.record(id))) }
  restart(id: string): Promise<void> { return this.operate(id, 'restart', async () => { const record = await this.record(id); await this.stopRecord(record); await this.startRecord(record) }) }
  /** Main-process watcher entry point; shares the lifecycle lock and never launches or refreshes. */
  synchronize(id: string): Promise<void> {
    return this.operate(id, 'sync', async () => {
      const record = await this.record(id)
      await this.verifyPaths(record)
      if (!record.accountId) return
      if (!this.deps.syncAccount) failInstance('当前环境尚未提供账户同步功能，未同步实例凭证。')
      await this.deps.syncAccount!(record)
    })
  }
  remove(id: string): Promise<void> {
    return this.operate(id, 'remove', async () => {
      const raw = (await this.records()).find(row => row.id === id)
      if (!raw) failInstance('实例不存在。')
      if (raw!.schemaVersion === 2) {
        const state = await this.inspect(raw as KiroInstanceRecord)
        if (state.status === 'running' || state.status === 'unverified') failInstance('请先确认实例已停止；运行中或归属未知的配置不能移除。')
        await this.verifyPaths(raw as KiroInstanceRecord)
        if ((raw as KiroInstanceRecord).accountId) {
          if (!this.deps.syncAccount) failInstance('当前环境尚未提供账户同步功能，未解除绑定。')
          await this.deps.syncAccount!(raw as KiroInstanceRecord)
        }
      }
      await this.mutate(async () => this.deps.writeConfig((await this.records()).filter(row => row.id !== id) as KiroInstanceRecord[]))
      // All profile files remain in place; removing a row never recursively deletes data.
    })
  }
  detach(id: string): Promise<void> {
    return this.operate(id, 'detach', async () => {
      const record = await this.record(id)
      if (!record.accountId) failInstance('恢复解绑仅适用于已绑定账户的实例。')
      const state = await this.inspect(record)
      if (state.status !== 'stopped' && state.status !== 'exited') failInstance('恢复解绑前必须确认实例及所有子进程均已停止。')
      await this.verifyPaths(record)
      if (!this.deps.markAccountReauthorizationRequired) failInstance('当前环境尚未提供账户重新授权标记功能，未解除绑定。')
      // Never import an unverified token or delete cache files to escape a failed sync.
      // Mark the account first; failure must leave its persistent binding intact.
      await this.deps.markAccountReauthorizationRequired!(record)
      const after = await this.inspect(record)
      if (after.status !== 'stopped' && after.status !== 'exited') failInstance('实例状态已经变化，未解除绑定；请确认所有窗口已停止后重试。')
      await this.verifyPaths(record)
      await this.mutate(async () => {
        const records = await this.records()
        const current = records.find(row => row.id === id)
        if (current?.schemaVersion !== 2 || current.accountId !== record.accountId) failInstance('实例绑定已经变化，未解除绑定。')
        await this.deps.writeConfig(records.filter(row => row.id !== id) as KiroInstanceRecord[])
      })
    })
  }
}

export function createWindowsKiroInstanceService(options: Omit<KiroInstanceDependencies, 'platform'> & { platform?: string }): KiroInstanceService {
  return new KiroInstanceService({ ...options, platform: options.platform ?? process.platform })
}
