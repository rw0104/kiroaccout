import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type LoginKind = 'builderid' | 'social' | 'iamsso' | 'portal'
export type PortalProvider = 'Google' | 'Github' | 'BuilderId' | 'Enterprise'
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
  provider?: PortalProvider
  authMethod?: 'social' | 'IdC'
  startUrl?: string
  clientSecretExpiresAt?: number
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
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<HttpResponse>
  authEndpoint: string
  openBrowser: (url: string, privateMode?: boolean) => void | Promise<unknown>
  notifySocial: (callback: SocialLoginCallback) => void
  now?: () => number
  schedule?: typeof setTimeout
  unschedule?: typeof clearTimeout
  /** Test-only listener injection; production uses the current official portal port list. */
  portalPorts?: readonly number[]
  requestTimeoutMs?: number
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
  provider?: PortalProvider
  expectedProvider?: PortalProvider
  privateMode?: boolean
  portalConsumed?: boolean
  portalStage?: 'portal' | 'idc-starting' | 'idc'
  startUrl?: string
  clientSecretExpiresAt?: number
  redirectUri?: string
  server?: Server
  expiryTimer?: ReturnType<typeof setTimeout>
  callback?: SocialLoginCallback
  result?: LoginResult
  exchangeStarted?: boolean
}
const SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations', 'codewhisperer:transformations', 'codewhisperer:taskassist']
const SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'
const PORTAL_ENDPOINT = 'https://app.kiro.dev/signin'
const PORTAL_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153] as const
const PORTAL_PROVIDERS: Record<string, PortalProvider> = { google: 'Google', github: 'Github', builderid: 'BuilderId', awsidc: 'Enterprise' }
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const positive = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
const body = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const validRegion = (region: unknown): region is string => typeof region === 'string' && /^(?:af|ap|ca|eu|il|me|mx|sa|us)(?:-[a-z]+){1,3}-[1-9]\d?$/.test(region)
function validIssuer(value: string | null, provider: PortalProvider): string | undefined {
  if (!value || value.length > 2048) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return
    if (provider === 'BuilderId') return url.href.replace(/\/$/, '') === 'https://view.awsapps.com/start' ? 'https://view.awsapps.com/start' : undefined
    if (provider === 'Enterprise' && /^(?:[a-z0-9-]+\.)+awsapps\.com$/.test(url.hostname) && /^\/(?:start\/?|directory\/[a-zA-Z0-9-]+\/?)$/.test(url.pathname)) return url.href
  } catch { /* Callback values are untrusted. Never use them as a credential request endpoint. */ }
  return
}

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
    if (session.kind === 'portal') session.server?.closeAllConnections()
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
    if (session.kind !== 'portal') return this.deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: session.controller.signal })
    const timeout = this.deps.requestTimeoutMs ?? 10000
    const controller = new AbortController()
    const aborted = () => controller.abort()
    session.controller.signal.addEventListener('abort', aborted, { once: true })
    if (session.controller.signal.aborted) controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort!: (reason: Error) => void
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject })
    let finish = () => {}
    const failAbort = () => { finish(); rejectAbort(new Error('authorization_request_interrupted')) }
    controller.signal.addEventListener('abort', failAbort, { once: true })
    timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30000, timeout)))
    timer.unref?.()
    finish = () => {
      if (timer) clearTimeout(timer)
      session.controller.signal.removeEventListener('abort', aborted)
      controller.signal.removeEventListener('abort', failAbort)
    }
    try {
      if (controller.signal.aborted) throw new Error('cancelled')
      const response = await Promise.race([this.deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error' }), interrupted])
      if (!response.ok) finish()
      // Keep the deadline active while reading/parsing the response, not just until headers arrive.
      return { ok: response.ok, status: response.status, json: async () => {
        try { return await Promise.race([response.json(), interrupted]) } finally { finish() }
      } }
    } catch (error) { finish(); throw error }
  }
  cancel(kind: LoginKind, sessionId: string): { success: boolean } {
    const session = this.current
    if (session?.kind === kind && session.id === sessionId) this.clear(session)
    return { success: true }
  }
  private reply(response: ServerResponse, status: number, message: string): void {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(message)
  }
  private portalFailure(session: LoginSession, message: string): void {
    if (this.active(session)) session.result = { success: false, completed: true, sessionId: session.id, error: message }
  }
  private async closeCallbackServer(session: LoginSession): Promise<void> {
    const server = session.server
    session.server = undefined
    if (!server) return
    await new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return }
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  private async listenPortal(session: LoginSession, idc: boolean): Promise<void> {
    const server = createServer((request, response) => {
      void this.handlePortalCallback(session, request, response, idc).catch(() => {
        this.portalFailure(session, '登录授权失败，请重新开始')
        this.reply(response, 400, 'Authorization failed. Return to the desktop application.')
      })
    })
    session.server = server
    const ports = idc ? [0] : this.deps.portalPorts ?? PORTAL_PORTS
    if (!ports.length || ports.some(port => !Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('invalid_callback_ports')
    await new Promise<void>((resolve, reject) => {
      let index = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.controller.signal.removeEventListener('abort', abort)
        server.removeListener('error', failed)
        if (error) reject(error); else resolve()
      }
      const abort = () => { server.close(); finish(new Error('cancelled')) }
      const failed = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && index + 1 < ports.length && this.active(session)) {
          server.listen(ports[++index], '127.0.0.1')
        } else finish(new Error('callback_listener_unavailable'))
      }
      const timer = setTimeout(() => { server.close(); finish(new Error('callback_listener_timeout')) }, 10000)
      timer.unref?.()
      session.controller.signal.addEventListener('abort', abort, { once: true })
      server.on('error', failed)
      server.once('listening', () => finish())
      if (session.controller.signal.aborted) { abort(); return }
      server.listen(ports[0], '127.0.0.1')
    })
    if (!this.active(session)) { server.close(); throw new Error('cancelled') }
    server.on('error', () => this.portalFailure(session, '本地登录回调服务失败，请重试'))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('callback_listener_unavailable')
    session.redirectUri = idc ? `http://127.0.0.1:${address.port}/oauth/callback` : `http://localhost:${address.port}`
  }
  /** Current official portal flow; all networking and browser effects remain injected. */
  async startPortal(sessionId: string, expectedProvider?: PortalProvider, privateMode?: boolean): Promise<LoginResult> {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) return { success: false, sessionId, error: '登录会话标识无效' }
    if (expectedProvider && !Object.values(PORTAL_PROVIDERS).includes(expectedProvider)) return { success: false, sessionId, error: '不支持的登录方式' }
    const session = this.begin('portal', sessionId, 'us-east-1')
    session.expectedProvider = expectedProvider
    session.privateMode = privateMode
    session.portalStage = 'portal'
    session.state = randomUUID()
    session.verifier = randomBytes(32).toString('base64url')
    try {
      await this.listenPortal(session, false)
      if (!this.active(session)) return this.stopped(sessionId)
      const url = new URL(PORTAL_ENDPOINT)
      url.search = new URLSearchParams({ state: session.state!, code_challenge: createHash('sha256').update(session.verifier!).digest('base64url'), code_challenge_method: 'S256', redirect_uri: session.redirectUri!, redirect_from: 'KiroIDE' }).toString()
      const opened = await this.deps.openBrowser(url.toString(), privateMode)
      if (!this.active(session)) return this.stopped(sessionId)
      if (opened === false) return this.failure(session, '无法打开登录浏览器，请重试')
      return { success: true, sessionId, loginUrl: url.toString(), authorizeUrl: url.toString(), state: session.state, expiresIn: 600, interval: 1 }
    } catch { return this.failure(session, '无法启动网页登录，请检查本地回调端口后重试') }
  }
  pollPortal(sessionId: string): LoginResult {
    const session = this.find('portal', sessionId)
    if (!session) return this.stopped(sessionId)
    if (session.result) {
      const result = session.result
      this.clear(session)
      return result
    }
    return { success: true, sessionId, completed: false, status: 'pending', interval: 1, provider: session.provider }
  }
  private validCallback(session: LoginSession, request: IncomingMessage, idc: boolean): URL | undefined {
    if (request.method !== 'GET' || !session.redirectUri || !request.url || request.url.length > 16384) return
    try {
      const base = new URL(session.redirectUri)
      const host = request.headers.host
      if (host !== `localhost:${base.port}` && host !== `127.0.0.1:${base.port}`) return
      const url = new URL(request.url, base)
      if (url.origin !== base.origin && url.origin !== `http://127.0.0.1:${base.port}`) return
      if (idc ? url.pathname !== '/oauth/callback' : !['/oauth/callback', '/signin/callback'].includes(url.pathname)) return
      for (const key of ['state', 'code', 'error', 'login_option', 'issuer_url', 'idc_region']) if (url.searchParams.getAll(key).length > 1) return
      return url
    } catch { return }
  }
  private portalTokenResult(session: LoginSession, value: unknown): LoginResult | undefined {
    const data = body(value)
    const accessToken = text(data.accessToken)?.trim()
    const refreshToken = text(data.refreshToken)?.trim()
    const expiresIn = positive(data.expiresIn, 0)
    if (!accessToken || !refreshToken || !expiresIn) return
    return { success: true, completed: true, sessionId: session.id, accessToken, refreshToken, expiresIn, profileArn: text(data.profileArn), provider: session.provider, authMethod: session.provider === 'Google' || session.provider === 'Github' ? 'social' : 'IdC', ...(session.clientId ? { clientId: session.clientId, clientSecret: session.clientSecret, clientSecretExpiresAt: session.clientSecretExpiresAt, region: session.region, startUrl: session.startUrl } : {}) }
  }
  private async handlePortalCallback(session: LoginSession, request: IncomingMessage, response: ServerResponse, idc: boolean): Promise<void> {
    const url = this.validCallback(session, request, idc)
    if (!url) { this.reply(response, 400, 'Invalid authorization callback'); return }
    if (!this.active(session) || url.searchParams.get('state') !== session.state) { this.reply(response, 400, 'Invalid or expired login session'); return }
    if (session.result || session.exchangeStarted || (!idc && session.portalConsumed) || idc !== (session.portalStage === 'idc')) { this.reply(response, 409, 'Authorization is already being processed'); return }
    if (url.searchParams.get('error')) {
      this.portalFailure(session, url.searchParams.get('error') === 'access_denied' ? '用户拒绝授权' : '网页授权未完成，请重试')
      this.reply(response, 400, 'Authorization did not complete. Return to the desktop application.'); return
    }
    if (idc) {
      const code = text(url.searchParams.get('code'))
      if (!code) { this.reply(response, 400, 'Missing authorization code'); return }
      session.exchangeStarted = true
      try {
        const result = await this.post(session, `https://oidc.${session.region}.amazonaws.com/token`, { clientId: session.clientId, clientSecret: session.clientSecret, grantType: 'authorization_code', redirectUri: session.redirectUri, code, codeVerifier: session.verifier })
        if (!this.active(session)) { this.reply(response, 410, 'Login session was cancelled'); return }
        if (!result.ok) throw new Error('token_exchange')
        const token = this.portalTokenResult(session, await result.json())
        if (!this.active(session)) { this.reply(response, 410, 'Login session was cancelled'); return }
        if (!token) throw new Error('incomplete_token')
        session.result = token
        this.reply(response, 200, '授权完成，请返回桌面应用。')
      } catch { this.portalFailure(session, 'Token 交换失败，请重新开始'); this.reply(response, 400, 'Authorization failed. Return to the desktop application.') }
      return
    }
    const option = url.searchParams.get('login_option') || ''
    const provider = Object.hasOwn(PORTAL_PROVIDERS, option) ? PORTAL_PROVIDERS[option] : undefined
    if (!provider || session.expectedProvider && session.expectedProvider !== provider) {
      this.reply(response, 400, 'Unexpected sign-in provider'); return
    }
    if (provider === 'Google' || provider === 'Github') {
      const code = text(url.searchParams.get('code'))
      if (!code) { this.reply(response, 400, 'Missing authorization code'); return }
      session.provider = provider
      session.portalConsumed = true
      session.exchangeStarted = true
      try {
        const result = await this.post(session, `${this.deps.authEndpoint}/oauth/token`, { code, code_verifier: session.verifier, redirect_uri: `${session.redirectUri}${url.pathname}?login_option=${url.searchParams.get('login_option')}` })
        if (!this.active(session)) { this.reply(response, 410, 'Login session was cancelled'); return }
        if (!result.ok) throw new Error('token_exchange')
        const token = this.portalTokenResult(session, await result.json())
        if (!this.active(session)) { this.reply(response, 410, 'Login session was cancelled'); return }
        if (!token) throw new Error('incomplete_token')
        session.result = token
        this.reply(response, 200, '授权完成，请返回桌面应用。')
      } catch { this.portalFailure(session, 'Token 交换失败，请重新开始'); this.reply(response, 400, 'Authorization failed. Return to the desktop application.') }
      return
    }
    const issuer = validIssuer(url.searchParams.get('issuer_url'), provider)
    const region = url.searchParams.get('idc_region')
    if (!issuer || !validRegion(region)) { this.reply(response, 400, 'Invalid organization issuer or region'); return }
    session.provider = provider
    session.portalConsumed = true
    session.portalStage = 'idc-starting'
    session.startUrl = issuer
    session.region = provider === 'BuilderId' ? 'us-east-1' : region
    response.once('finish', () => { void this.startPortalIdc(session) })
    this.reply(response, 200, '请选择浏览器中随后打开的授权页面完成登录。')
  }
  private async startPortalIdc(session: LoginSession): Promise<void> {
    try {
      await this.closeCallbackServer(session)
      if (!this.active(session)) return
      const base = `https://oidc.${session.region}.amazonaws.com`
      const registration = await this.post(session, `${base}/client/register`, { clientName: 'Kiro Account Manager', clientType: 'public', scopes: SCOPES, grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['http://127.0.0.1/oauth/callback'], issuerUrl: session.startUrl })
      if (!this.active(session)) return
      if (!registration.ok) throw new Error('client_registration')
      const client = body(await registration.json())
      if (!this.active(session)) return
      session.clientId = text(client.clientId)
      session.clientSecret = text(client.clientSecret)
      session.clientSecretExpiresAt = positive(client.clientSecretExpiresAt, 0) || undefined
      if (!session.clientId || !session.clientSecret || session.clientSecretExpiresAt !== undefined && session.clientSecretExpiresAt * 1000 <= this.now()) throw new Error('invalid_client_registration')
      session.state = randomUUID()
      session.verifier = randomBytes(32).toString('base64url')
      session.exchangeStarted = false
      session.portalStage = 'idc'
      await this.listenPortal(session, true)
      if (!this.active(session)) return
      const params = new URLSearchParams({ response_type: 'code', client_id: session.clientId, redirect_uri: session.redirectUri!, scopes: SCOPES.join(','), state: session.state, code_challenge: createHash('sha256').update(session.verifier).digest('base64url'), code_challenge_method: 'S256' })
      const opened = await this.deps.openBrowser(`${base}/authorize?${params}`, session.privateMode)
      if (!this.active(session)) return
      if (opened === false) throw new Error('browser_open_failed')
    } catch { this.portalFailure(session, '无法继续组织或 Builder ID 授权，请重新开始') }
  }
  async startBuilder(sessionId: string, region = 'us-east-1'): Promise<LoginResult> {
    if (!validRegion(region)) return { success: false, sessionId, error: '无效的 AWS 区域' }
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
    if (!validRegion(region)) return { success: false, sessionId, error: '无效的 AWS 区域' }
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
