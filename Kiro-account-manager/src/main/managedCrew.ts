import { randomUUID } from 'node:crypto'
import type { ManagedCrewRequest, ManagedCrewResult, ManagedCrewState } from '../shared/managedCrew'
import {
  ClientAccessProjectionService, accessPrincipalFingerprint, projectableClientAccess,
  type ManagerAccessSnapshot, type ClientAccessProjectionAdapter, type ClientAccessProjectionBinding
} from './clientAccessProjection'

export interface ManagedCrewProcessState {
  running: boolean
  starting?: boolean
  ownerId?: string
  sessionId?: string
  pid?: number
  port?: number
}

/** All process details, including the one-use URL, stay in the main process. */
export interface ManagedCrewProcess extends ManagedCrewProcessState {
  running: true
  ownerId: string
  sessionId: string
  pid: number
  port: number
  urlToken: string
  exited: Promise<void>
}

export interface ManagedCrewRuntime {
  id: string
  revision: string
  version: string
  adapter: ClientAccessProjectionAdapter
  prepare(): Promise<void>
  status(): Promise<ManagedCrewProcessState>
  launch(sessionId: string): Promise<ManagedCrewProcess>
  stop(process: ManagedCrewProcessState): Promise<void>
}

export interface ManagedCrewDependencies {
  account(id: string): ManagerAccessSnapshot | undefined
  runtime(): Promise<ManagedCrewRuntime | undefined>
  readBinding(): ClientAccessProjectionBinding | undefined
  writeBinding(binding: ClientAccessProjectionBinding, expectedRevision: string | undefined): boolean
  beginOperation(accountId: string): () => void
  openWindow(url: string, onClosed: () => void): Promise<void>
  closeWindow(): void
  platformSupported?: () => boolean
  now?: () => number
  intervalMs?: number
}

const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512 &&
  !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

/** An independent projection domain. Never reads or migrates default Crew bindings. */
export class ManagedCrewService {
  private readonly deps: ManagedCrewDependencies
  private readonly now: () => number
  private readonly projection: ClientAccessProjectionService
  private currentRuntime?: ManagedCrewRuntime
  private process?: ManagedCrewProcess
  private accountId?: string
  private principal?: string
  private phase: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped'
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<ManagedCrewResult>
  private stopping?: Promise<void>
  private tickPending?: Promise<void>
  private closed = false
  private disposed = false
  private generation = 0
  private syncIssue = false
  private lastError?: string
  private readonly requests = new Map<string, { key: string; result: Promise<ManagedCrewResult> }>()

  constructor(deps: ManagedCrewDependencies) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.projection = new ClientAccessProjectionService({
      account: id => this.deps.account(id),
      adapter: id => this.currentRuntime?.id === id ? this.currentRuntime.adapter : undefined,
      readBindings: () => { const binding = this.deps.readBinding(); return binding ? [binding] : [] },
      writeBinding: (binding, expected) => this.deps.writeBinding(binding, expected), now: this.now
    })
  }

  get busy(): boolean { return this.phase !== 'stopped' || !!this.pending || !!this.stopping }

  private state(accountId: string, patch: Partial<ManagedCrewState> = {}): ManagedCrewState {
    const same = !!this.accountId && this.accountId === accountId
    return {
      status: this.phase, canStart: false, canOpen: this.phase === 'running' && same && !!this.process,
      canStop: same && (this.phase === 'running' || this.phase === 'starting'), selectedAccount: same,
      ...(this.currentRuntime ? { version: this.currentRuntime.version } : {}),
      message: this.phase === 'running'
        ? same ? '独立 Crew 已运行；请保持管理器开启以同步访问凭证。' : '独立 Crew 正在使用另一个账号，请先从该账号停止工作区。'
        : this.phase === 'starting' ? '正在启动独立 Crew…' : this.phase === 'stopping' ? '正在停止独立 Crew…' : '独立工作区不会改写官方安装或现有 Crew 登录。',
      messageEn: this.phase === 'running'
        ? same ? 'The independent Crew workspace is running. Keep the manager open to sync access.' : 'The workspace is using another account. Stop it from that account first.'
        : this.phase === 'starting' ? 'Starting the independent Crew workspace…' : this.phase === 'stopping' ? 'Stopping the independent Crew workspace…' : 'This workspace preserves the official installation and existing Crew sign-in.',
      ...patch
    }
  }

  private blocked(accountId: string, code: string, message: string, messageEn: string): ManagedCrewState {
    return this.state(accountId, { status: 'blocked', canStart: false, canOpen: false, errorCode: code, message, messageEn })
  }

  private source(accountId: string): { snapshot: ManagerAccessSnapshot; principal: string } | undefined {
    const snapshot = this.deps.account(accountId)
    const principal = accessPrincipalFingerprint(snapshot)
    if (!snapshot || !principal || snapshot.temporarilyUnavailable || snapshot.expiresAt <= this.now() + 300_000) return undefined
    try { if (!projectableClientAccess(snapshot)) return undefined } catch { return undefined }
    return { snapshot, principal }
  }

  async inspect(accountId: string): Promise<ManagedCrewState> {
    if (!validId(accountId)) throw new Error('Invalid account selection')
    if (this.closed) return this.blocked(accountId, 'closing', '管理器正在退出。', 'The manager is closing.')
    if (this.deps.platformSupported && !this.deps.platformSupported()) return this.blocked(accountId, 'platform-unsupported',
      '独立 Crew 当前支持 Windows 上的官方 Crew 0.12.0。', 'The independent workspace currently supports official Crew 0.12.0 on Windows.')
    if (this.phase === 'starting' || this.phase === 'stopping') return this.state(accountId)
    try {
      const runtime = await this.deps.runtime()
      if (!runtime) return this.blocked(accountId, 'installation-unavailable',
        '请先安装或选择受支持的官方 Crew 0.12.0。', 'Install or select a supported official Crew 0.12.0 installation.')
      if (this.phase === 'running') {
        if (this.currentRuntime?.revision !== runtime.revision) return this.blocked(accountId, 'installation-changed',
          'Crew 安装已变化，请先停止工作区再重新启动。', 'The Crew installation changed. Stop this workspace before restarting it.')
        if (this.accountId !== accountId) return this.state(accountId)
        if (accessPrincipalFingerprint(this.deps.account(accountId)) !== this.principal) return this.blocked(accountId, 'identity-changed',
          '所选账号身份已变化，请停止工作区后重新连接。', 'The selected identity changed. Stop the workspace and connect again.')
        if (this.syncIssue) return this.state(accountId, { message: '独立 Crew 正在运行，但访问同步已暂停。请检查账号状态，必要时停止后重新连接。',
          messageEn: 'The workspace is running, but access sync is paused. Check the account, or stop and reconnect.', errorCode: 'sync-paused' })
        return this.state(accountId)
      }
      const existing = await runtime.status()
      if (existing.running) {
        const binding = this.deps.readBinding()
        this.currentRuntime = runtime
        this.accountId = binding?.accountId
        return this.state(accountId, { status: 'blocked', canStop: binding?.accountId === accountId,
          errorCode: 'previous-workspace-running', message: '检测到上次的独立 Crew 工作区，请先停止它再重新启动。',
          messageEn: 'A previous independent workspace is still running. Stop it before starting another.' })
      }
      const source = this.source(accountId)
      if (!source) return this.blocked(accountId, 'credentials-not-ready',
        '账号身份或访问凭证尚未就绪，请等待原自动刷新或重新授权后重试。', 'The account identity or access token is not ready. Wait for its normal refresh or authorize again.')
      runtime.adapter.validate?.(projectableClientAccess(source.snapshot)!)
      this.lastError = undefined
      return this.state(accountId, { canStart: true, version: runtime.version })
    } catch {
      return this.blocked(accountId, this.lastError ?? 'workspace-unavailable',
        '独立 Crew 未通过兼容性或工作区校验，请检查安装位置后重试。', 'Crew compatibility or workspace validation failed. Check the installation and retry.')
    }
  }

  private request(request: ManagedCrewRequest, action: string, execute: () => Promise<ManagedCrewResult>): Promise<ManagedCrewResult> {
    if (!request || !validId(request.accountId) || !uuid(request.operationId)) return Promise.reject(new Error('Invalid workspace request'))
    const key = JSON.stringify([action, request.accountId])
    const previous = this.requests.get(request.operationId)
    if (previous) return previous.key === key ? previous.result : Promise.reject(new Error('Operation identity changed'))
    const result = execute().finally(() => { this.requests.delete(request.operationId) })
    this.requests.set(request.operationId, { key, result })
    return result
  }

  start(request: ManagedCrewRequest): Promise<ManagedCrewResult> {
    return this.request(request, 'start', async () => {
      if (this.phase === 'running' && this.accountId === request.accountId) return this.open({ ...request, operationId: randomUUID() })
      if (this.pending || this.phase !== 'stopped') return { success: false, state: this.state(request.accountId) }
      const task = this.startWorkspace(request.accountId)
      this.pending = task
      try { return await task } finally { if (this.pending === task) this.pending = undefined }
    })
  }

  private async startWorkspace(accountId: string): Promise<ManagedCrewResult> {
    let release: (() => void) | undefined
    let launched: ManagedCrewProcess | undefined
    const generation = ++this.generation
    try {
      const checked = await this.inspect(accountId)
      if (!checked.canStart || this.closed) return { success: false, state: checked }
      release = this.deps.beginOperation(accountId)
      const source = this.source(accountId)
      const runtime = await this.deps.runtime()
      if (!source || !runtime || this.closed || generation !== this.generation) throw new Error('workspace-changed')
      this.phase = 'starting'; this.accountId = accountId; this.principal = source.principal; this.currentRuntime = runtime
      await runtime.prepare()
      if ((await runtime.status()).running || this.closed || generation !== this.generation) throw new Error('workspace-already-running')
      const projected = await this.projection.execute({ accountId, runtimeId: runtime.id, authDomainId: runtime.adapter.authDomainId,
        expectedPrincipalFingerprint: source.principal })
      if (!['projected', 'unchanged'].includes(projected.status)) throw new Error('projection-failed')
      if (this.closed || generation !== this.generation) throw new Error('workspace-cancelled')
      launched = await runtime.launch(randomUUID())
      this.process = launched
      if (this.closed || generation !== this.generation || accessPrincipalFingerprint(this.deps.account(accountId)) !== source.principal) {
        throw new Error('workspace-changed')
      }
      this.phase = 'running'; this.syncIssue = false
      void launched.exited.then(() => {
        if (this.process !== launched) return
        this.process = undefined; this.phase = 'stopped'; this.clearTimer(); this.deps.closeWindow()
      })
      this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 15000)
      this.timer.unref?.()
      await this.showWindow()
      if (this.closed || generation !== this.generation || this.phase !== 'running') throw new Error('workspace-cancelled')
      return { success: true, state: this.state(accountId) }
    } catch {
      this.lastError = 'start-failed'
      this.clearTimer()
      if (launched && this.currentRuntime) {
        try { await this.currentRuntime.stop(launched) } catch {
          this.phase = 'running'; this.syncIssue = true
          return { success: false, state: this.blocked(accountId, 'stop-required',
            '启动未完成，工作区仍需停止。请点击停止工作区重试。', 'Startup did not finish and the workspace still needs to stop. Use Stop workspace to retry.') }
        }
      }
      this.process = undefined; this.phase = 'stopped'; this.deps.closeWindow()
      return { success: false, state: this.blocked(accountId, 'start-failed',
        '独立 Crew 启动未完成；原客户端与管理器登录保持不变。请检查安装或账号资料后重试。',
        'The independent workspace could not start. Existing clients and sign-in are unchanged. Check the installation and account, then retry.') }
    } finally { release?.() }
  }

  private async showWindow(): Promise<void> {
    const process = this.process
    if (this.closed || !process || this.phase !== 'running' || !this.accountId ||
        accessPrincipalFingerprint(this.deps.account(this.accountId)) !== this.principal) throw new Error('workspace-not-running')
    const generation = this.generation
    await this.deps.openWindow(`http://127.0.0.1:${process.port}/?token=${encodeURIComponent(process.urlToken)}`, () => {
      if (generation === this.generation) void this.stopWorkspace().catch(() => {})
    })
  }

  open(request: ManagedCrewRequest): Promise<ManagedCrewResult> {
    return this.request(request, 'open', async () => {
      const state = await this.inspect(request.accountId)
      if (!state.canOpen) return { success: false, state }
      try { await this.showWindow(); return { success: true, state: this.state(request.accountId) } }
      catch { return { success: false, state: this.blocked(request.accountId, 'window-failed', '无法打开工作区窗口，请重试。', 'The workspace window could not be opened. Retry.') } }
    })
  }

  stop(request: ManagedCrewRequest): Promise<ManagedCrewResult> {
    return this.request(request, 'stop', async () => {
      const stored = this.deps.readBinding()
      if ((this.accountId ?? stored?.accountId) !== request.accountId) return { success: false, state: this.state(request.accountId) }
      try { await this.stopWorkspace(); return { success: true, state: this.state(request.accountId) } }
      catch { return { success: false, state: this.blocked(request.accountId, 'stop-failed',
        '尚未确认独立工作区完全退出，请重试停止；未停止其它客户端。', 'The workspace exit is not confirmed. Retry stopping it; other clients were not stopped.') } }
    })
  }

  private clearTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  async tick(): Promise<void> {
    if (this.tickPending || this.phase !== 'running' || !this.currentRuntime || !this.accountId) return this.tickPending
    this.tickPending = (async () => {
      try {
        const runtime = await this.deps.runtime()
        if (!runtime || runtime.revision !== this.currentRuntime?.revision) { this.syncIssue = true; return }
        const results = await this.projection.tick()
        this.syncIssue = results.some(result => !['projected', 'unchanged'].includes(result.status))
      } catch { this.syncIssue = true }
    })().finally(() => { this.tickPending = undefined })
    return this.tickPending
  }

  private stopWorkspace(): Promise<void> {
    if (this.stopping) return this.stopping
    this.generation++
    this.clearTimer()
    this.stopping = (async () => {
      this.phase = 'stopping'
      // A pending launch observes the generation change and closes its own process.
      if (this.pending) await this.pending
      if (this.tickPending) await this.tickPending
      const runtime = this.currentRuntime ?? await this.deps.runtime()
      if (runtime) {
        const process = this.process ?? await runtime.status()
        if (process.running) await runtime.stop(process)
      }
      this.process = undefined
      this.phase = 'stopped'
      this.deps.closeWindow()
      const binding = this.deps.readBinding()
      if (binding?.status === 'active' && !this.deps.writeBinding({ ...binding, revision: randomUUID(), status: 'needs-attention', reason: 'user-disconnected', updatedAt: this.now() }, binding.revision)) {
        throw new Error('Workspace binding save failed')
      }
    })().catch(error => {
      this.phase = this.process ? 'running' : 'stopped'
      if (this.process && !this.closed && !this.timer) {
        this.syncIssue = true
        this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 15000)
        this.timer.unref?.()
      }
      throw error
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }

  async suspendAndStop(): Promise<void> {
    this.closed = true
    try {
      if (this.currentRuntime || this.process || this.pending || this.deps.readBinding()) await this.stopWorkspace()
    } catch (error) { this.resume(); throw error }
  }

  resume(): void {
    if (this.disposed) return
    this.closed = false
    if (this.process && this.phase === 'running' && !this.timer) {
      this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 15000)
      this.timer.unref?.()
    }
  }

  dispose(): void {
    this.closed = true; this.disposed = true
    this.clearTimer(); this.projection.close()
  }

  async close(): Promise<void> {
    await this.suspendAndStop()
    this.dispose()
  }
}
