import { isNewerVersion } from '../shared/version'

export type AppUpdateStatus = 'disabled' | 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
export type AppUpdateStage = 'check' | 'download' | 'install'
export interface AppUpdateProgress { percent: number; bytesPerSecond: number; transferred: number; total: number }
export interface AppUpdateState {
  revision: number
  status: AppUpdateStatus
  currentVersion: string
  version?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: AppUpdateProgress
  error?: string
  errorStage?: AppUpdateStage
  checkedAt?: number
  installRequiresRestart?: boolean
}
export interface UpdateActionResult { success: boolean; state: AppUpdateState; error?: string }
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  channel: string | null
  on(event: string, handler: (...args: unknown[]) => void): unknown
  removeListener(event: string, handler: (...args: unknown[]) => void): unknown
  checkForUpdates(): Promise<{ updateInfo?: unknown } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}
interface UpdaterDependencies {
  updater: UpdateEngine
  enabled: boolean
  currentVersion: string
  notify: (state: AppUpdateState) => void
  prepareInstall: () => Promise<void>
  beforeInstall: () => void
  installFailed?: () => void
  now?: () => number
  schedule?: typeof setTimeout
  unschedule?: typeof clearTimeout
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function notes(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 20000)
  if (Array.isArray(value)) return value.map(entry => record(entry).note).filter(note => typeof note === 'string').join('\n').slice(0, 20000)
  return undefined
}

/** A recoverable state machine. The Electron adapter owns persistence and application exit. */
export class AppUpdateController {
  private state: AppUpdateState
  private readonly deps: UpdaterDependencies
  private checkTask: Promise<AppUpdateState> | null = null
  private downloadTask: Promise<UpdateActionResult> | null = null
  private installTask: Promise<UpdateActionResult> | null = null
  private downloadedVersion: string | null = null
  private installationPrepared = false
  private invokingInstall = false
  private restartRequired = false
  private timer?: ReturnType<typeof setTimeout>
  private started = false
  private disposed = false
  private listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = []

  constructor(deps: UpdaterDependencies) {
    this.deps = deps
    this.state = { revision: 0, status: deps.enabled ? 'idle' : 'disabled', currentVersion: deps.currentVersion }
    deps.updater.autoDownload = false
    deps.updater.autoInstallOnAppQuit = false
    // Setting channel in electron-updater can turn downgrade on, so reset it afterwards.
    deps.updater.channel = 'latest'
    deps.updater.allowPrerelease = false
    deps.updater.allowDowngrade = false
    this.listen('checking-for-update', () => {
      if (this.state.status === 'checking') this.publish({ status: 'checking' })
    })
    this.listen('update-available', info => {
      if (this.state.status === 'checking') this.acceptInfo(info)
    })
    this.listen('update-not-available', () => {
      if (this.state.status === 'checking') this.publish({ status: 'not-available', version: undefined, checkedAt: this.now() })
    })
    this.listen('download-progress', value => {
      if (this.state.status !== 'downloading') return
      const data = record(value)
      const finite = (key: string): number => typeof data[key] === 'number' && Number.isFinite(data[key]) ? Math.max(0, data[key] as number) : 0
      this.publish({ progress: { percent: Math.min(100, finite('percent')), bytesPerSecond: finite('bytesPerSecond'), transferred: finite('transferred'), total: finite('total') } })
    })
    this.listen('update-downloaded', info => {
      if (this.state.status !== 'downloading') return
      const version = record(info).version
      if (version !== this.state.version || !this.acceptable(version)) { this.fail('download', '更新包版本不匹配，请重新检查更新'); return }
      // electron-updater emits this only after validating the downloaded package checksum.
      this.downloadedVersion = version as string
      this.publish({ status: 'downloaded', progress: undefined, error: undefined, errorStage: undefined })
    })
    this.listen('error', error => {
      const stage: AppUpdateStage = this.state.status === 'downloading' ? 'download' : this.state.status === 'installing' ? 'install' : 'check'
      // NSIS reports some launch failures asynchronously after scheduling app.quit().
      // Its internal install latch cannot be reset via a public API: require an app restart.
      if (stage === 'install' && this.installationPrepared && !this.invokingInstall) this.restartRequired = true
      if (stage === 'install') this.rollbackInstall()
      const code = error instanceof Error ? error.message : ''
      this.fail(stage, /checksum|sha512|hash mismatch/i.test(code) ? '更新包校验失败，请重新下载' : stage === 'download' ? '更新下载失败，请检查网络后重试' : stage === 'install' ? this.restartRequired ? '安装器未能启动，请重新启动应用后重试，或到发布页面手动下载安装包' : '更新安装未能启动，请重试' : '更新检查失败，请检查网络后重试')
    })
  }
  private now(): number { return (this.deps.now || Date.now)() }
  private listen(event: string, handler: (...args: unknown[]) => void): void {
    const guarded = (...args: unknown[]) => { if (!this.disposed) handler(...args) }
    this.listeners.push({ event, handler: guarded })
    this.deps.updater.on(event, guarded)
  }
  private acceptable(version: unknown): version is string {
    return typeof version === 'string' && !version.includes('-') && isNewerVersion(version, this.state.currentVersion)
  }
  private acceptInfo(value: unknown): void {
    const data = record(value)
    if (!this.acceptable(data.version)) {
      this.publish({ status: 'not-available', version: undefined, releaseDate: undefined, releaseNotes: undefined, checkedAt: this.now() })
      return
    }
    this.publish({ status: 'available', version: data.version, releaseDate: typeof data.releaseDate === 'string' ? data.releaseDate : undefined,
      releaseNotes: notes(data.releaseNotes), checkedAt: this.now(), error: undefined, errorStage: undefined })
  }
  private publish(patch: Partial<AppUpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    // State remains recoverable if a window is closing or its renderer is reloading.
    try { this.deps.notify(this.getState()) } catch { /* next snapshot query recovers it */ }
  }
  private fail(stage: AppUpdateStage, error: string): void { this.publish({ status: 'error', errorStage: stage, error, progress: undefined, installRequiresRestart: this.restartRequired }) }
  private rollbackInstall(): void {
    if (!this.installationPrepared) return
    this.installationPrepared = false
    this.deps.installFailed?.()
  }
  getState(): AppUpdateState { return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined } }
  canQuitForUpdate(): boolean { return !this.disposed && this.state.status === 'installing' && this.installationPrepared }

  start(): void {
    if (this.started || this.disposed || !this.deps.enabled) return
    this.started = true
    const schedule = this.deps.schedule || setTimeout
    const next = (delay: number): void => {
      if (this.disposed) return
      this.timer = schedule(() => { void this.check().finally(() => next(6 * 60 * 60 * 1000)) }, delay)
      this.timer.unref?.()
    }
    next(3000)
  }
  async check(): Promise<AppUpdateState> {
    if (this.disposed || !this.deps.enabled || this.restartRequired) return this.getState()
    if (this.state.status === 'downloading' || this.state.status === 'installing') return this.getState()
    if (this.downloadedVersion) { this.publish({ status: 'downloaded', error: undefined, errorStage: undefined }); return this.getState() }
    if (this.checkTask) return this.checkTask
    this.publish({ status: 'checking', error: undefined, errorStage: undefined })
    this.checkTask = Promise.resolve().then(async () => {
      try {
        const result = await this.deps.updater.checkForUpdates()
        if (this.state.status === 'checking') this.acceptInfo(result?.updateInfo)
      } catch { if (this.state.status !== 'error') this.fail('check', '更新检查失败，请检查网络后重试') }
      return this.getState()
    }).finally(() => { this.checkTask = null })
    return this.checkTask
  }
  async download(): Promise<UpdateActionResult> {
    if (this.downloadTask) return this.downloadTask
    if (this.disposed || !this.deps.enabled || !this.acceptable(this.state.version) ||
        !(this.state.status === 'available' || this.state.status === 'error' && this.state.errorStage === 'download')) {
      return { success: false, state: this.getState(), error: '请先检查并选择可用更新' }
    }
    this.publish({ status: 'downloading', error: undefined, errorStage: undefined, progress: undefined })
    this.downloadTask = Promise.resolve().then(async () => {
      try {
        await this.deps.updater.downloadUpdate()
        if (this.state.status === 'downloading') this.fail('download', '更新包尚未完成验证，请重新下载')
      } catch { if (this.state.status !== 'error') this.fail('download', '更新下载失败，请检查网络后重试') }
      return { success: this.state.status === 'downloaded', state: this.getState(), error: this.state.error }
    }).finally(() => { this.downloadTask = null })
    return this.downloadTask
  }
  async install(): Promise<UpdateActionResult> {
    if (this.installTask) return this.installTask
    if (this.restartRequired) return { success: false, state: this.getState(), error: '请重新启动应用后再尝试安装，或手动下载安装包' }
    if (this.disposed || !this.deps.enabled || !this.downloadedVersion || this.downloadedVersion !== this.state.version ||
        !(this.state.status === 'downloaded' || this.state.status === 'error' && this.state.errorStage === 'install')) {
      return { success: false, state: this.getState(), error: '更新包尚未下载并通过验证' }
    }
    this.publish({ status: 'installing', error: undefined, errorStage: undefined })
    this.installTask = Promise.resolve().then(async () => {
      try {
        await this.deps.prepareInstall()
        if (this.disposed) return { success: false, state: this.getState(), error: '应用正在退出' }
        this.installationPrepared = true
        this.deps.beforeInstall()
        this.invokingInstall = true
        try { this.deps.updater.quitAndInstall(false, true) }
        finally { this.invokingInstall = false }
        return { success: this.state.status !== 'error', state: this.getState(), error: this.state.error }
      } catch {
        this.rollbackInstall()
        this.fail('install', '更新前保存或安装准备失败，请重试；应用不会自动退出')
        return { success: false, state: this.getState(), error: this.state.error }
      }
    }).finally(() => { this.installTask = null })
    return this.installTask
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) (this.deps.unschedule || clearTimeout)(this.timer)
    for (const { event, handler } of this.listeners) this.deps.updater.removeListener(event, handler)
    this.listeners = []
  }
}
