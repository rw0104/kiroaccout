import { createHash } from 'node:crypto'

export interface AuthRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  errorCode?: 'invalid-input' | 'invalid-response' | 'http' | 'timeout' | 'network' | 'busy'
}
export interface AuthRefreshInput {
  kind: 'IdC' | 'social'
  refreshToken: string
  clientId?: string
  clientSecret?: string
  /** Unix seconds, as returned by AWS client registration. */
  clientSecretExpiresAt?: number
  region?: string
  proxyUrl?: string
}
interface RefreshResponse { ok: boolean; status: number; json(): Promise<unknown> }
interface RefreshDependencies {
  fetch: (url: string, init: RequestInit, proxyUrl?: string) => Promise<RefreshResponse>
  socialEndpoint: string
  socialUserAgent: () => string
  timeoutMs?: number
  replayWindowMs?: number
  /** Upper bound for in-memory rotation aliases; never persisted or logged. */
  maxRetentionMs?: number
  now?: () => number
}
interface RefreshEntry {
  task?: Promise<AuthRefreshResult>
  completedAt?: number
  result?: AuthRefreshResult
  currentKey: string
  aliases: Set<string>
  retainUntil: number
  parent?: RefreshEntry
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const failure = (errorCode: AuthRefreshResult['errorCode'], error: string): AuthRefreshResult => ({ success: false, errorCode, error })

/** One refresh per credential across manual refresh, verification and background jobs.
 * Successful rotation is briefly replayed so a late caller cannot consume the old token twice.
 * POSTs are never automatically retried: a lost response may already have rotated the token.
 */
export class TokenRefreshService {
  // Keys are hashes of the registration and token. All generations of a rotation share an entry.
  private readonly entries = new Map<string, RefreshEntry>()
  private readonly lineages = new Set<RefreshEntry>()
  private readonly now: () => number
  private readonly deps: RefreshDependencies
  constructor(deps: RefreshDependencies) { this.deps = deps; this.now = deps.now || Date.now }

  private key(input: AuthRefreshInput, refreshToken = input.refreshToken): string {
    return createHash('sha256').update(JSON.stringify([input.kind, input.region || 'us-east-1', input.clientId, input.clientSecret, refreshToken])).digest('hex')
  }
  private root(entry: RefreshEntry): RefreshEntry {
    if (entry.parent) entry.parent = this.root(entry.parent)
    return entry.parent || entry
  }
  private copyResult(entry: RefreshEntry, result: AuthRefreshResult): AuthRefreshResult {
    const copy = { ...result }
    const current = this.root(entry)
    if (copy.success && current.completedAt !== undefined && copy.expiresIn) {
      copy.expiresIn = Math.max(0, copy.expiresIn - Math.ceil((this.now() - current.completedAt) / 1000))
      if (copy.expiresIn <= 0) return failure('invalid-response', '已缓存的凭证已过期，请使用最新刷新凭证或重新登录')
    }
    return copy
  }
  private drop(entry: RefreshEntry): void {
    for (const key of entry.aliases) if (this.entries.get(key) === entry) this.entries.delete(key)
    this.lineages.delete(entry)
  }
  private alias(entry: RefreshEntry, key: string): void {
    entry.aliases.add(key)
    this.entries.set(key, entry)
    // Keep one hour at most and 64 generations at most, rather than retaining secrets indefinitely.
    while (entry.aliases.size > 64) {
      const oldest = [...entry.aliases].find(alias => alias !== entry.currentKey)!
      entry.aliases.delete(oldest)
      if (this.entries.get(oldest) === entry) this.entries.delete(oldest)
    }
  }

  async refresh(input: AuthRefreshInput): Promise<AuthRefreshResult> {
    if (!nonempty(input.refreshToken) || !['IdC', 'social'].includes(input.kind)) return failure('invalid-input', '缺少有效刷新凭证，请重新登录')
    const region = input.region || 'us-east-1'
    if (input.kind === 'IdC' && (!nonempty(input.clientId) || !nonempty(input.clientSecret) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(region))) {
      return failure('invalid-input', 'OIDC 客户端凭证或区域无效，请重新登录')
    }
    if (input.kind === 'IdC' && input.clientSecretExpiresAt !== undefined &&
        (typeof input.clientSecretExpiresAt !== 'number' || !Number.isFinite(input.clientSecretExpiresAt) || input.clientSecretExpiresAt * 1000 <= this.now() + 900000)) {
      return failure('invalid-input', 'OIDC 客户端注册已到期或即将到期，请重新登录')
    }
    input = { ...input, region }
    const key = this.key(input)
    const replayMs = Math.max(0, this.deps.replayWindowMs ?? 15000)
    const now = this.now()
    for (const entry of this.lineages) if (!entry.task && now >= entry.retainUntil) this.drop(entry)
    const previous = this.entries.get(key)
    const existing = previous && this.root(previous)
    if (existing) {
      if (existing.task) return this.copyResult(existing, await existing.task)
      // An old consumed token must only hand off the current generation, never be posted again.
      // Even the newest token reuses the freshly issued access token during the short replay window.
      if (existing.result && (key !== existing.currentKey || existing.result.success && now - (existing.completedAt ?? 0) < replayMs)) {
        return this.copyResult(existing, existing.result)
      }
    }
    if (!existing && (this.lineages.size >= 1024 || this.entries.size >= 4096)) return failure('busy', '刷新任务较多，请稍后重试')
    const retentionMs = Math.max(1000, Math.min(3600000, this.deps.maxRetentionMs ?? 3600000))
    const entry: RefreshEntry = existing || { currentKey: key, aliases: new Set(), retainUntil: now + retentionMs }
    if (!existing) { this.lineages.add(entry); this.alias(entry, key) }
    const task = Promise.resolve().then(() => this.perform(input, region)).then(async result => {
      const current = this.root(entry)
      if (current !== entry) return current.task ? await current.task : current.result || failure('busy', '凭证轮换状态已变化，请重新获取最新凭证')
      if (result.success && result.refreshToken) {
        const nextKey = this.key(input, result.refreshToken)
        const next = this.entries.get(nextKey)
        const other = next && this.root(next)
        // A caller can already know the next token before an earlier response finishes. Join its
        // newer work instead of publishing an older rotation over it. No second POST is started here.
        if (other && other !== entry) {
          entry.parent = other
          this.lineages.delete(entry)
          for (const alias of entry.aliases) this.alias(other, alias)
          return other.task ? await other.task : other.result || failure('busy', '凭证轮换状态已变化，请重新获取最新凭证')
        }
        entry.currentKey = nextKey
        this.alias(entry, nextKey)
        entry.retainUntil = this.now() + Math.min(retentionMs, result.expiresIn! * 1000)
      } else {
        // Keep aliases after a failed newer refresh so old callers receive that failure rather than
        // a consumed older token. A caller explicitly holding currentKey may retry the failed request.
        entry.retainUntil = Math.min(entry.retainUntil, this.now() + retentionMs)
        // Failed new credentials have no consumed generations to protect. Do not let a large invalid
        // import fill the cache and block unrelated valid accounts for the entire retention period.
        if (entry.aliases.size === 1) this.drop(entry)
      }
      entry.completedAt = this.now()
      entry.result = result
      return result
    }).finally(() => { if (entry.task === task) entry.task = undefined })
    entry.task = task
    return this.copyResult(entry, await task)
  }

  private async perform(input: AuthRefreshInput, region: string): Promise<AuthRefreshResult> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<AuthRefreshResult>(resolve => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve(failure('timeout', '刷新请求超时，结果尚不确定，请稍后重试或重新登录'))
      }, this.deps.timeoutMs ?? 30000)
    })
    const request = (async (): Promise<AuthRefreshResult> => {
      try {
        const social = input.kind === 'social'
        const url = social ? `${this.deps.socialEndpoint}/refreshToken` : `https://oidc.${region}.amazonaws.com/token`
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (social) headers['User-Agent'] = this.deps.socialUserAgent()
        const payload = social ? { refreshToken: input.refreshToken } : {
          clientId: input.clientId, clientSecret: input.clientSecret, refreshToken: input.refreshToken, grantType: 'refresh_token'
        }
        const response = await this.deps.fetch(url, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error'
        }, input.proxyUrl)
        if (!response.ok) {
          // Do not return server bodies, URLs, tokens or transport exception text to the UI.
          const data = await response.json().catch(() => ({}))
          const code = record(data).error
          const reason = code === 'invalid_grant' || code === 'expired_token' ? '刷新凭证已失效，请重新登录'
            : code === 'invalid_client' || code === 'unauthorized_client' ? '客户端注册已失效，请重新登录'
              : response.status === 429 ? '请求过于频繁，请稍后重试' : '凭证刷新失败，请检查登录状态和网络'
          return failure('http', `HTTP ${response.status}: ${reason}`)
        }
        const data = record(await response.json())
        if (!nonempty(data.accessToken) || typeof data.expiresIn !== 'number' || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0 ||
            data.refreshToken !== undefined && !nonempty(data.refreshToken)) {
          return failure('invalid-response', '刷新响应缺少有效凭证或有效期，请重新登录')
        }
        return { success: true, accessToken: data.accessToken, refreshToken: data.refreshToken as string | undefined || input.refreshToken, expiresIn: data.expiresIn }
      } catch {
        return timedOut ? failure('timeout', '刷新请求超时，结果尚不确定，请稍后重试或重新登录')
          : failure('network', '刷新连接失败，结果尚不确定，请检查网络后重试')
      }
    })()
    try { return await Promise.race([request, deadline]) }
    finally { if (timer) clearTimeout(timer) }
  }
}
