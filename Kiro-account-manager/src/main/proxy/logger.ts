// 代理服务器日志模块
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { redactValue } from '../utils/redact'
import { snapshotLogEntry, LOG_HISTORY_MAX_BYTES, LOG_ENTRY_MAX_BYTES, LOG_HISTORY_MAX_COUNT, LOG_PAGE_MAX_BYTES, LOG_PAGE_MAX_COUNT, type LogEntry, type LogPage } from '../../shared/logHistory'
export type { LogEntry } from '../../shared/logHistory'

export interface LoggerConfig {
  enabled: boolean
  logDir?: string
  maxFileSize?: number // 最大文件大小 (bytes)
  maxFiles?: number // 最大文件数量
  logToConsole?: boolean
}

const DEFAULT_CONFIG: LoggerConfig = {
  enabled: false,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  logToConsole: true
}

class ProxyLogger {
  private config: LoggerConfig
  private logStream: fs.WriteStream | null = null
  private currentLogFile: string = ''
  private currentFileSize: number = 0
  private skippedFileEntries = 0

  constructor() {
    this.config = { ...DEFAULT_CONFIG }
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
    
    if (this.config.enabled && !this.config.logDir) {
      // 默认日志目录
      this.config.logDir = path.join(app.getPath('userData'), 'logs', 'proxy')
    }

    if (this.config.enabled) {
      this.close()
      this.initLogFile()
    } else {
      this.close()
    }
  }

  private initLogFile(): void {
    if (!this.config.logDir) return

    try {
      // 确保目录存在
      fs.mkdirSync(this.config.logDir, { recursive: true })

      // 创建新的日志文件
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.currentLogFile = path.join(this.config.logDir, `proxy-${timestamp}.log`)
      this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' })
      this.currentFileSize = 0

      this.info('Logger', 'Log file initialized', { file: this.currentLogFile })
    } catch (error) {
      console.error('[ProxyLogger] Failed to init log file:', error)
    }
  }

  private rotateIfNeeded(): void {
    if (!this.config.maxFileSize || this.currentFileSize < this.config.maxFileSize) {
      return
    }

    this.close()
    this.cleanOldLogs()
    this.initLogFile()
  }

  private cleanOldLogs(): void {
    if (!this.config.logDir || !this.config.maxFiles) return

    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith('proxy-') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.config.logDir!, f),
          time: fs.statSync(path.join(this.config.logDir!, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time)

      // 删除超出数量限制的旧文件
      while (files.length >= this.config.maxFiles) {
        const oldest = files.pop()
        if (oldest) {
          fs.unlinkSync(oldest.path)
        }
      }
    } catch (error) {
      console.error('[ProxyLogger] Failed to clean old logs:', error)
    }
  }

  private isWriting = false
  private write(rawEntry: LogEntry): void {
    // 统一脱敏：message + data 里的代理账密 / token / password 等，避免明文落盘或上屏
    const entry = proxyLogStore.add(rawEntry)

    if (this.config.logToConsole) {
      const prefix = `[${entry.level}][${entry.category}]`
      // 设置 flag 防止 console 拦截器重复写入 proxyLogStore
      this.isWriting = true
      try { if (entry.level === 'ERROR') {
        console.error(prefix, entry.message, entry.data || '')
      } else if (entry.level === 'WARN') {
        console.warn(prefix, entry.message, entry.data || '')
      } else {
        console.log(prefix, entry.message, entry.data || '')
      } } finally { this.isWriting = false }
    }

    if (this.config.enabled && this.logStream) {
      // Do not grow the WriteStream queue without a bound when disk is slow.
      const line = JSON.stringify(entry) + '\n'
      if (this.logStream.writableLength < 256 * 1024) {
        if (this.skippedFileEntries) {
          const notice = proxyLogStore.add({ timestamp: new Date().toISOString(), level: 'WARN', category: 'Logger',
            message: 'Slow file output skipped entries; recent bounded history remains available.',
            data: { skippedEntries: this.skippedFileEntries }, truncated: true })
          const noticeLine = JSON.stringify(notice) + '\n'
          this.logStream.write(noticeLine)
          this.currentFileSize += Buffer.byteLength(noticeLine)
          this.skippedFileEntries = 0
        }
        this.logStream.write(line)
        this.currentFileSize += Buffer.byteLength(line)
        this.rotateIfNeeded()
      } else this.skippedFileEntries++
    }

  }

  get _isWriting(): boolean { return this.isWriting }

  debug(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      category,
      message,
      data
    })
  }

  info(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category,
      message,
      data
    })
  }

  warn(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      category,
      message,
      data
    })
  }

  error(category: string, message: string, data?: unknown): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      category,
      message,
      data
    })
  }

  // 记录请求
  request(info: {
    path: string
    method: string
    model?: string
    accountId?: string
  }): void {
    this.info('Request', `${info.method} ${info.path}`, info)
  }

  // 记录响应
  response(info: {
    path: string
    status: number
    tokens?: number
    responseTime?: number
    error?: string
  }): void {
    if (info.error) {
      this.error('Response', `${info.path} -> ${info.status}`, info)
    } else {
      this.info('Response', `${info.path} -> ${info.status}`, info)
    }
  }

  // 记录 Token 刷新
  tokenRefresh(accountId: string, success: boolean, error?: string): void {
    if (success) {
      this.info('TokenRefresh', `Account ${accountId} refreshed successfully`)
    } else {
      this.error('TokenRefresh', `Account ${accountId} refresh failed`, { error })
    }
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }

  getLogDir(): string | undefined {
    return this.config.logDir
  }
}

// Both byte and count budgets apply to immutable, redacted previews.
class ProxyLogStore {
  private logs: Array<{ entry: LogEntry; bytes: number; sequence: number } | undefined> = []
  private head = 0
  private bytes = 2
  private sequence = 0
  private epoch = crypto.randomUUID()
  private listeners = new Set<(entry: LogEntry) => void>()
  private storePath = ''
  private initialized = false
  private saveTimer: NodeJS.Timeout | null = null
  private saveTask: Promise<void> | null = null
  private revision = 0
  private savedRevision = 0
  private lastSaveBytes = 0
  private skippedFileBytes = 0

  initialize(userDataPath: string): void {
    if (this.initialized) return
    this.initialized = true
    this.storePath = path.join(userDataPath, 'proxy-logs.json')
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.storePath)) return
      const size = fs.statSync(this.storePath).size
      if (size > LOG_HISTORY_MAX_BYTES) {
        this.skippedFileBytes = size
        const recentPath = `${this.storePath}.recent`
        try { fs.renameSync(this.storePath, `${this.storePath}.oversized-${crypto.randomUUID()}`) }
        catch {
          // Keep the legacy file intact even if it cannot be moved. The recent
          // bounded history uses a sidecar and is loaded on the next startup.
          this.storePath = recentPath
        }
        // A previous launch may have used the sidecar while the original could
        // not be archived. Preserve it even if archiving succeeds this time.
        if (fs.existsSync(recentPath) && fs.statSync(recentPath).size <= LOG_HISTORY_MAX_BYTES) this.loadEntries(recentPath)
        this.add({ timestamp: new Date().toISOString(), level: 'WARN', category: 'Logger',
          message: 'Previous log file exceeds the size budget; old history was skipped to protect memory.',
          data: { skippedBytes: size, limitBytes: LOG_HISTORY_MAX_BYTES }, truncated: true })
        return
      }
      this.loadEntries(this.storePath)
    } catch {
      this.add({ timestamp: new Date().toISOString(), level: 'WARN', category: 'Logger', message: 'Previous log history could not be loaded.' })
    }
  }

  private loadEntries(filename: string): void {
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, 'utf-8'))
    if (!Array.isArray(parsed)) return
    const ids = new Set<string>()
    for (const value of parsed.slice(-LOG_HISTORY_MAX_COUNT)) {
      if (!value || typeof value !== 'object' || typeof value.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(value.timestamp)) || !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(value.level)) continue
      if (typeof value.id === 'string') {
        if (ids.has(value.id)) continue
        ids.add(value.id)
      }
      this.add(value as LogEntry)
    }
  }

  private freeze(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value)) this.freeze(child)
    Object.freeze(value)
  }

  add(rawEntry: LogEntry): LogEntry {
    let entry = snapshotLogEntry(rawEntry, redactValue)
    const sequence = ++this.sequence
    entry.id = `${this.epoch}:${sequence}`
    let encoded = JSON.stringify(entry)
    if (Buffer.byteLength(encoded) > LOG_ENTRY_MAX_BYTES) {
      entry = snapshotLogEntry({ ...entry, message: entry.message.slice(0, 256),
        data: { preview: encoded.slice(0, 2048), note: 'Entry exceeded byte budget' }, truncated: true }, redactValue)
      entry.id = `${this.epoch}:${sequence}`
      encoded = JSON.stringify(entry)
    }
    this.freeze(entry)
    const bytes = Buffer.byteLength(encoded) + 1
    this.logs.push({ entry, bytes, sequence })
    this.bytes += bytes
    while (this.count() > LOG_HISTORY_MAX_COUNT || this.bytes > LOG_HISTORY_MAX_BYTES) {
      const oldest = this.logs[this.head]
      if (oldest) this.bytes -= oldest.bytes
      this.logs[this.head++] = undefined
    }
    if (this.head > 1024 && this.head * 2 > this.logs.length) {
      this.logs = this.logs.slice(this.head)
      this.head = 0
    }
    this.revision++
    for (const listener of this.listeners) { try { listener(entry) } catch { /* observer isolation */ } }
    this.scheduleSave()
    return entry
  }

  private scheduleSave(): void {
    if (!this.initialized || this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save() }, 30000)
  }

  save(): Promise<void> {
    if (!this.initialized) return Promise.resolve()
    if (this.saveTask) return this.saveTask
    if (this.savedRevision === this.revision) return Promise.resolve()
    const task = (async () => {
      do {
        const revision = this.revision
        const serialized = JSON.stringify(this.getAll())
        this.lastSaveBytes = Buffer.byteLength(serialized)
        try { await fs.promises.writeFile(this.storePath, serialized, 'utf-8') }
        catch { return } // retain dirty revision; a later scheduled/explicit save retries
        this.savedRevision = revision
      } while (this.savedRevision !== this.revision)
    })()
    this.saveTask = task
    void task.finally(() => { if (this.saveTask === task) this.saveTask = null })
    return task
  }

  async flushSaveNow(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    await this.save()
  }

  getAll(): LogEntry[] {
    return this.logs.slice(this.head).map(item => item!.entry)
  }

  getLast(count: number): LogEntry[] {
    const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
    return limit ? this.logs.slice(Math.max(this.head, this.logs.length - limit)).map(item => item!.entry) : []
  }

  getPage(cursor?: string, limit = 100): LogPage {
    const first = this.logs[this.head]?.sequence ?? this.sequence + 1
    let after = first - 1
    let reset = true
    if (typeof cursor === 'string' && cursor.length <= 128) {
      const separator = cursor.lastIndexOf(':')
      const cursorEpoch = cursor.slice(0, separator)
      const candidate = Number(cursor.slice(separator + 1))
      if (separator > 0 && cursorEpoch === this.epoch && Number.isSafeInteger(candidate) && candidate >= first - 1 && candidate <= this.sequence) {
        after = candidate
        reset = false
      }
    }
    const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(LOG_PAGE_MAX_COUNT, Math.floor(limit))) : 100
    const entries: LogEntry[] = []
    let pageBytes = 512 // reserve metadata/cursor/commas
    for (let index = this.head + Math.max(0, after - first + 1); index < this.logs.length; index++) {
      const item = this.logs[index]!
      if (entries.length >= maximum || pageBytes + item.bytes > LOG_PAGE_MAX_BYTES) break
      entries.push(item.entry)
      pageBytes += item.bytes
      after = item.sequence
    }
    return { entries, reset, epoch: this.epoch, nextCursor: `${this.epoch}:${after}`, hasMore: after < this.sequence, total: this.count() }
  }

  clear(): void {
    this.logs = []
    this.head = 0
    this.bytes = 2
    this.sequence = 0
    this.epoch = crypto.randomUUID()
    this.revision++
    void this.save()
  }

  count(): number { return this.logs.length - this.head }

  getDiagnostics(): { count: number; bytes: number; lastSaveBytes: number; skippedFileBytes: number } {
    return { count: this.count(), bytes: this.bytes, lastSaveBytes: this.lastSaveBytes, skippedFileBytes: this.skippedFileBytes }
  }

  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const proxyLogStore = new ProxyLogStore()

// 单例导出
export const proxyLogger = new ProxyLogger()

// 拦截主进程 console 输出，自动转发到 proxyLogStore
// 这样所有 console.log/warn/error 都能在日志页面显示
let consoleIntercepted = false
export function interceptConsole(): void {
  if (consoleIntercepted) return
  consoleIntercepted = true

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  const parseConsoleCategory = (args: unknown[]): { category: string; message: string } => {
    const first = String(args[0] || '')
    // 匹配 [Category] 或 [INFO][Category] 格式
    const bracketMatch = first.match(/^\[(?:DEBUG|INFO|WARN|ERROR)\]?\[?([^\]]*)\]?\s*(.*)/)
    if (bracketMatch) {
      return { category: bracketMatch[1] || 'App', message: bracketMatch[2] || '' }
    }
    const simpleMatch = first.match(/^\[([^\]]+)\]\s*(.*)/)
    if (simpleMatch) {
      return { category: simpleMatch[1], message: simpleMatch[2] || '' }
    }
    return { category: 'App', message: first }
  }

  const buildEntry = (args: unknown[], level: 'INFO' | 'WARN' | 'ERROR'): LogEntry => {
    const { category, message } = parseConsoleCategory(args)
    const rest = args.slice(1, 21)
    // data: 后续参数（对象/数组保留结构，字符串拼接）
    let data: unknown = undefined
    if (rest.length === 1) {
      data = rest[0]
    } else if (rest.length > 1) {
      data = rest
    }
    return { timestamp: new Date().toISOString(), level, category, message, data, ...(args.length > 21 ? { truncated: true } : {}) }
  }

  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'INFO'))
  }

  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'WARN'))
  }

  console.error = (...args: unknown[]) => {
    originalError.apply(console, args)
    if (proxyLogger._isWriting) return
    proxyLogStore.add(buildEntry(args, 'ERROR'))
  }
}
