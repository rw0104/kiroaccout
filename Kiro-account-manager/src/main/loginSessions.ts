import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export type LoginKind = 'builderid' | 'social' | 'iamsso'
export interface LoginResult {
  success: boolean
  sessionId: string
  completed?: boolean
  status?: 'pending' | 'slow_down' | 'busy' | 'cancelled'
  error?: string
  accessToken?: string
  refreshToken?: string
  profileArn?: string
  expiresIn?: number
  clientId?: string
  clientSecret?: string
  region?: string
  provider?: 'Google' | 'Github'
  userCode?: string
  verificationUri?: string
  interval?: number
  retryAfter?: number
  authorizeUrl?: string
  loginUrl?: string
  state?: string
}
export interface SocialLoginCallback {
  sessionId: string
  code?: string
  state?: string
  error?: string
}
interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}
interface LoginDependencies {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<HttpResponse>
  authEndpoint: string
  openBrowser: (url: string, privateMode?: boolean) => void | Promise<unknown>
  notifySocial: (callback: SocialLoginCallback) => void
  now?: () => number
  schedule?: typeof setTimeout
  unschedule?: typeof clearTimeout
}
interface LoginSession {
  id: string
  kind: LoginKind
  controller: AbortController
  expiresAt: number
  region: string
  interval: number
  nextPollAt: number
  inFlight: boolean
  clientId?: string
  clientSecret?: string
  deviceCode?: string
  verifier?: string
  state?: string
  provider?: 'Google' | 'Github'
  redirectUri?: string
  server?: Server
  expiryTimer?: ReturnType<typeof setTimeout>
  callback?: SocialLoginCallback
  result?: LoginResult
  exchangeStarted?: boolean
}
const SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations', 'codewhisperer:transformations', 'codewhisperer:taskassist']
const SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const positive = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
const body = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Session-owned async work. No Electron, disk, protocol registration or production credentials. */
export class LoginSessionManager {
  private current: LoginSession | null = null
  private readonly deps: LoginDependencies
  private readonly now: () => number

  constructor(deps: LoginDependencies) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }
  private dispose(session: LoginSession): void {
    session.controller.abort()
    if (session.expiryTimer) (this.deps.unschedule ?? clearTimeout)(session.expiryTimer)
    session.server?.close()
    session.callback = undefined
    session.result = undefined
  }
  private clear(session: LoginSession): void {
    this.dispose(session)
    if (this.current === session) this.current = null
  }
  private expire(session: LoginSession): void {
    if (this.current !== session || session.controller.signal.aborted) return
    // Invalidate before notification so a re-entrant query or delayed timer cannot notify twice.
    this.clear(session)
    if (session.kind === 'social') {
      try { this.deps.notifySocial({ sessionId: session.id, error: '登录已过期，请重新开始' }) } catch { /* A closed renderer must not interrupt expiry cleanup. */ }
    }
  }
  private armExpiry(session: LoginSession): void {
    if (session.expiryTimer) (this.deps.unschedule ?? clearTimeout)(session.expiryTimer)
    session.expiryTimer = (this.deps.schedule ?? setTimeout)(() => this.expire(session), Math.max(1, session.expiresAt - this.now()))
    session.expiryTimer.unref?.()
  }
  private begin(kind: LoginKind, id: string, region: string): LoginSession {
    if (this.current) this.clear(this.current)
    const session: LoginSession = { id, kind, region, controller: new AbortController(), expiresAt: this.now() + 600000, interval: 5, nextPollAt: 0, inFlight: false }
    this.current = session
    this.armExpiry(session)
    return session
  }
  private active(session: LoginSession): boolean {
    if (this.current !== session || session.controller.signal.aborted) return false
    if (this.now() >= session.expiresAt) { this.expire(session); return false }
    return true
  }
  private find(kind: LoginKind, id: string): LoginSession | undefined {
    const session = this.current
    return session?.id === id && session.kind === kind && this.active(session) ? session : undefined
  }
  private stopped(id: string): LoginResult {
    return { success: false, sessionId: id, status: 'cancelled', error: '登录已取消或过期，请重新开始' }
  }
  private failure(session: LoginSession, message: string): LoginResult {
    if (!this.active(session)) return this.stopped(session.id)
    this.clear(session)
    return { success: false, sessionId: session.id, error: message }
  }
  private async post(session: LoginSession, url: string, payload: Record<string, unknown>): Promise<HttpResponse> {
    return this.deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: session.controller.signal })
  }
  cancel(kind: LoginKind, sessionId: string): { success: boolean } {
    const session = this.current
    if (session?.kind === kind && session.id === sessionId) this.clear(session)
    return { success: true }
  }
  async startBuilder(sessionId: string, region = 'us-east-1'): Promise<LoginResult> {
    const session = this.begin('builderid', sessionId, region)
    const base = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    try {
      const registration = await this.post(session, `${base}/client/register`, { clientName: 'Kiro Account Manager', clientType: 'public', scopes: SCOPES, grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], issuerUrl: startUrl })
      if (!this.active(session)) return this.stopped(sessionId)
      if (!registration.ok) return this.failure(session, '注册客户端失败，请重试')
      const client = body(await registration.json())
      if (!this.active(session)) return this.stopped(sessionId)
      session.clientId = text(client.clientId)
      session.clientSecret = text(client.clientSecret)
      if (!session.clientId || !session.clientSecret) return this.failure(session, '注册响应缺少客户端凭证')
      const response = await this.post(session, `${base}/device_authorization`, { clientId: session.clientId, clientSecret: session.clientSecret, startUrl })
      if (!this.active(session)) return this.stopped(sessionId)
      if (!response.ok) return this.failure(session, '设备授权失败，请重试')
      const data = body(await response.json())
      if (!this.active(session)) return this.stopped(sessionId)
      session.deviceCode = text(data.deviceCode)
      const userCode = text(data.userCode)
      const verificationUri = text(data.verificationUriComplete) || text(data.verificationUri)
      if (!session.deviceCode || !userCode || !verificationUri) return this.failure(session, '设备授权响应不完整')
      session.interval = positive(data.interval, 5)
      const expiresIn = positive(data.expiresIn, 600)
      session.expiresAt = this.now() + expiresIn * 1000
      this.armExpiry(session)
      session.nextPollAt = this.now() + session.interval * 1000
      return { success: true, sessionId, userCode, verificationUri, expiresIn, interval: session.interval }
    } catch { return this.failure(session, '启动登录失败，请重试') }
  }
  async pollBuilder(sessionId: string): Promise<LoginResult> {
    const session = this.find('builderid', sessionId)
    if (!session) return this.stopped(sessionId)
    const wait = Math.max(0, (session.nextPollAt - this.now()) / 1000)
    if (session.inFlight || wait > 0) return { success: true, sessionId, completed: false, status: 'pending', interval: session.interval, retryAfter: Math.max(wait, session.inFlight ? session.interval : 0) }
    session.inFlight = true
    try {
      const response = await this.post(session, `https://oidc.${session.region}.amazonaws.com/token`, { clientId: session.clientId, clientSecret: session.clientSecret, grantType: 'urn:ietf:params:oauth:grant-type:device_code', deviceCode: session.deviceCode })
      if (!this.active(session)) return this.stopped(sessionId)
      const data = body(await response.json())
      if (!this.active(session)) return this.stopped(sessionId)
      if (response.ok) {
        if (!text(data.accessToken) || !text(data.refreshToken)) return this.failure(session, '授权响应缺少账户凭证')
        const result: LoginResult = { success: true, sessionId, completed: true, accessToken: text(data.accessToken), refreshToken: text(data.refreshToken), clientId: session.clientId, clientSecret: session.clientSecret, region: session.region, expiresIn: positive(data.expiresIn, 3600) }
        this.clear(session)
        return result
      }
      const error = data.error || data.__type
      if (error === 'authorization_pending' || error === 'AuthorizationPendingException' || error === 'slow_down' || error === 'SlowDownException') {
        const slow = error === 'slow_down' || error === 'SlowDownException'
        if (slow) session.interval += 5
        session.nextPollAt = this.now() + session.interval * 1000
        return { success: true, sessionId, completed: false, status: slow ? 'slow_down' : 'pending', interval: session.interval, retryAfter: session.interval }
      }
      return this.failure(session, error === 'access_denied' || error === 'AccessDeniedException' ? '用户拒绝授权' : error === 'expired_token' || error === 'ExpiredTokenException' ? '授权已过期，请重新开始' : '授权失败，请重新开始')
    } catch {
      if (!this.active(session)) return this.stopped(sessionId)
      session.interval = Math.max(5, session.interval * 2)
      session.nextPollAt = this.now() + session.interval * 1000
      return { success: true, sessionId, completed: false, status: 'pending', interval: session.interval, retryAfter: session.interval }
    } finally { session.inFlight = false }
  }
  async startSocial(sessionId: string, provider: 'Google' | 'Github', privateMode?: boolean): Promise<LoginResult> {
    if (provider !== 'Google' && provider !== 'Github') return { success: false, sessionId, error: '不支持的登录方式' }
    const session = this.begin('social', sessionId, 'us-east-1')
    session.provider = provider
    session.verifier = randomBytes(64).toString('base64url').substring(0, 128)
    session.state = randomBytes(32).toString('base64url')
    const url = new URL(`${this.deps.authEndpoint}/login`)
    url.searchParams.set('idp', provider)
    url.searchParams.set('redirect_uri', SOCIAL_REDIRECT_URI)
    url.searchParams.set('code_challenge', createHash('sha256').update(session.verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', session.state)
    try {
      await this.deps.openBrowser(url.toString(), privateMode)
      if (!this.active(session)) return this.stopped(sessionId)
      return { success: true, sessionId, loginUrl: url.toString(), state: session.state, expiresIn: 600 }
    } catch { return this.failure(session, '无法打开登录浏览器，请重试') }
  }
  acceptSocialCallback(input: { code?: string | null; state?: string | null; error?: string | null }): boolean {
    const session = this.current
    if (!session || session.kind !== 'social' || !this.active(session) || input.state !== session.state || session.exchangeStarted || session.callback) return false
    if (!input.code && !input.error) return false
    session.callback = { sessionId: session.id, state: session.state, ...(input.error ? { error: '网页登录授权失败，请重新开始' } : { code: input.code! }) }
    this.deps.notifySocial(session.callback)
    return true
  }
  getSocialCallback(sessionId: string): SocialLoginCallback | null {
    return this.find('social', sessionId)?.callback ?? null
  }
  async exchangeSocial(sessionId: string, code: string, state: string): Promise<LoginResult> {
    const session = this.find('social', sessionId)
    if (!session) return this.stopped(sessionId)
    if (session.state !== state) return { success: false, sessionId, error: '状态参数不匹配，请使用当前登录窗口' }
    if (session.exchangeStarted) return { success: true, sessionId, completed: false, status: 'busy' }
    if (session.callback?.error) return this.failure(session, session.callback.error)
    if (!session.callback || session.callback.code !== code) return { success: false, sessionId, error: '尚未收到当前登录会话的授权回调' }
    session.exchangeStarted = true
    try {
      const response = await this.post(session, `${this.deps.authEndpoint}/oauth/token`, { code, code_verifier: session.verifier, redirect_uri: SOCIAL_REDIRECT_URI })
      if (!this.active(session)) return this.stopped(sessionId)
      if (!response.ok) return this.failure(session, 'Token 交换失败，请重新开始')
      const data = body(await response.json())
      if (!this.active(session)) return this.stopped(sessionId)
      if (!text(data.accessToken) || !text(data.refreshToken)) return this.failure(session, '授权响应缺少账户凭证')
      const result: LoginResult = { success: true, completed: true, sessionId, provider: session.provider, accessToken: text(data.accessToken), refreshToken: text(data.refreshToken), profileArn: text(data.profileArn), expiresIn: positive(data.expiresIn, 3600) }
      this.clear(session)
      return result
    } catch { return this.failure(session, 'Token 交换失败，请重试') }
  }
  async startIam(sessionId: string, startUrl: string, region = 'us-east-1'): Promise<LoginResult> {
    if (!startUrl?.startsWith('https://')) return { success: false, sessionId, error: 'SSO Start URL 必须以 https:// 开头' }
    const session = this.begin('iamsso', sessionId, region)
    const base = `https://oidc.${region}.amazonaws.com`
    try {
      const response = await this.post(session, `${base}/client/register`, { clientName: 'Kiro Account Manager', clientType: 'public', scopes: SCOPES, grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['http://127.0.0.1/oauth/callback'], issuerUrl: startUrl })
      if (!this.active(session)) return this.stopped(sessionId)
      if (!response.ok) return this.failure(session, '注册客户端失败，请确认组织的访问权限')
      const data = body(await response.json())
      if (!this.active(session)) return this.stopped(sessionId)
      session.clientId = text(data.clientId)
      session.clientSecret = text(data.clientSecret)
      if (!session.clientId || !session.clientSecret) return this.failure(session, '注册响应缺少客户端凭证')
      session.verifier = randomBytes(32).toString('base64url')
      session.state = randomUUID()
      const server = createServer((request, response) => {
        void this.handleIamCallback(session, request.url || '/', response).catch(() => {
          if (!response.headersSent) response.writeHead(400)
          if (!response.writableEnded) response.end('Invalid authorization callback')
        })
      })
      session.server = server
      // Bind the real callback server once; never release and race to reclaim its port.
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { server.close(); reject(new Error('cancelled')) }
        session.controller.signal.addEventListener('abort', aborted, { once: true })
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          session.controller.signal.removeEventListener('abort', aborted)
          server.removeListener('error', reject)
          server.on('error', () => { if (this.active(session)) this.failure(session, '本地登录回调服务失败，请重试') })
          resolve()
        })
      })
      if (!this.active(session)) { server.close(); return this.stopped(sessionId) }
      const address = server.address()
      if (!address || typeof address === 'string') return this.failure(session, '无法建立本地登录回调')
      session.redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
      const params = new URLSearchParams({ response_type: 'code', client_id: session.clientId, redirect_uri: session.redirectUri, scopes: SCOPES.join(','), state: session.state, code_challenge: createHash('sha256').update(session.verifier).digest('base64url'), code_challenge_method: 'S256' })
      return { success: true, sessionId, authorizeUrl: `${base}/authorize?${params}`, expiresIn: 600 }
    } catch { return this.failure(session, '启动 IAM SSO 登录失败，请重试') }
  }
  private async handleIamCallback(session: LoginSession, requestUrl: string, response: import('node:http').ServerResponse): Promise<void> {
    let url: URL
    try { url = new URL(requestUrl, 'http://127.0.0.1') } catch {
      response.writeHead(400); response.end('Invalid authorization callback'); return
    }
    if (url.pathname !== '/oauth/callback') { response.writeHead(404); response.end('Not Found'); return }
    if (!this.active(session) || url.searchParams.get('state') !== session.state) { response.writeHead(400); response.end('Invalid or expired login session'); return }
    if (session.exchangeStarted) { response.writeHead(409); response.end('Authorization is already being processed'); return }
    session.exchangeStarted = true
    if (url.searchParams.get('error') || !url.searchParams.get('code')) {
      session.result = { success: false, completed: true, sessionId: session.id, error: '网页授权未完成，请重试' }
      response.writeHead(400); response.end('Authorization did not complete'); return
    }
    try {
      const tokenResponse = await this.post(session, `https://oidc.${session.region}.amazonaws.com/token`, { clientId: session.clientId, clientSecret: session.clientSecret, grantType: 'authorization_code', redirectUri: session.redirectUri, code: url.searchParams.get('code'), codeVerifier: session.verifier })
      if (!this.active(session)) { response.writeHead(410); response.end('Login session was cancelled'); return }
      if (!tokenResponse.ok) throw new Error('token_exchange')
      const data = body(await tokenResponse.json())
      if (!this.active(session)) { response.writeHead(410); response.end('Login session was cancelled'); return }
      if (!text(data.accessToken) || !text(data.refreshToken)) throw new Error('incomplete_token')
      session.result = { success: true, completed: true, sessionId: session.id, accessToken: text(data.accessToken), refreshToken: text(data.refreshToken), clientId: session.clientId, clientSecret: session.clientSecret, region: session.region, expiresIn: positive(data.expiresIn, 3600) }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<html><body><h1>授权完成</h1><p>请返回桌面应用。</p></body></html>')
    } catch {
      if (this.active(session)) session.result = { success: false, completed: true, sessionId: session.id, error: 'Token 交换失败，请重新开始' }
      response.writeHead(400); response.end('Authorization failed')
    }
  }
  pollIam(sessionId: string): LoginResult {
    const session = this.find('iamsso', sessionId)
    if (!session) return this.stopped(sessionId)
    if (session.result) {
      const result = session.result
      this.clear(session)
      return result
    }
    return { success: true, sessionId, completed: false, status: 'pending', interval: 3 }
  }
}
