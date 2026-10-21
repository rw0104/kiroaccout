import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request, createServer } from 'node:http'
import { LoginSessionManager } from '../../src/main/loginSessions'

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data })
const tokenData = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresIn: 3600,
  profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/SYNTHETIC' }
const registration = { clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: 4000000000 }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.ok(predicate(), 'local callback did not reach the expected mocked stage')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(overrides: Partial<ConstructorParameters<typeof LoginSessionManager>[0]> = {}) {
  const opened: Array<{ url: string; privateMode?: boolean }> = []
  const calls: Array<{ url: string; init: { body: string; signal?: AbortSignal; redirect?: RequestRedirect } }> = []
  const manager = new LoginSessionManager({
    authEndpoint: 'https://auth.example.invalid', portalPorts: [0],
    openBrowser(url, privateMode) { opened.push({ url, privateMode }) }, notifySocial() { assert.fail('portal must not depend on system protocol callbacks') },
    fetch: async (url, init) => { calls.push({ url, init }); return reply(url.endsWith('/client/register') ? registration : tokenData) },
    ...overrides
  })
  return { manager, opened, calls }
}
function portalCallback(loginUrl: string, option = 'google', extra: Record<string, string> = {}): URL {
  const login = new URL(loginUrl)
  const callback = new URL(login.searchParams.get('redirect_uri')!)
  callback.hostname = '127.0.0.1' // test stays on IPv4 while retaining actual callback base in exchange
  callback.pathname = '/oauth/callback'
  callback.search = new URLSearchParams({ state: login.searchParams.get('state')!, login_option: option,
    ...(option === 'google' || option === 'github' ? { code: 'SYNTHETIC_CODE' } : {}), ...extra }).toString()
  return callback
}

test('portal opens the official PKCE loopback flow and Social exchanges exactly the actual callback URI', async t => {
  for (const [option, provider, path] of [['google', 'Google', '/oauth/callback'], ['github', 'Github', '/signin/callback']]) {
    const h = harness()
    t.after(() => h.manager.cancel('portal', option))
    const started = await h.manager.startPortal(option, undefined, true)
    assert.equal(started.success, true)
    const login = new URL(started.loginUrl!)
    assert.equal(login.origin + login.pathname, 'https://app.kiro.dev/signin')
    assert.equal(login.searchParams.get('redirect_from'), 'KiroIDE')
    assert.equal(login.searchParams.get('code_challenge_method'), 'S256')
    assert.match(login.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+$/)
    assert.equal(h.opened[0].privateMode, true)
    const callback = portalCallback(started.loginUrl!, option)
    callback.pathname = path
    assert.equal((await fetch(callback)).status, 200)
    const result = h.manager.pollPortal(option)
    assert.equal(result.provider, provider)
    assert.equal(result.authMethod, 'social')
    assert.equal(result.accessToken, tokenData.accessToken)
    assert.equal(result.profileArn, tokenData.profileArn)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'https://auth.example.invalid/oauth/token')
    const payload = JSON.parse(h.calls[0].init.body)
    assert.equal(payload.code, 'SYNTHETIC_CODE')
    assert.equal(payload.redirect_uri, `${login.searchParams.get('redirect_uri')}${path}?login_option=${option}`)
    assert.match(payload.code_verifier, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(createHash('sha256').update(payload.code_verifier).digest('base64url'), login.searchParams.get('code_challenge'))
    assert.equal(h.calls[0].init.redirect, 'error')
    assert.equal(h.manager.pollPortal(option).status, 'cancelled')
  }
})

test('bad state, unsupported/provider-conflicting methods and ambiguous callback query never consume a portal session', async t => {
  const h = harness()
  t.after(() => h.manager.cancel('portal', 'guarded'))
  const started = await h.manager.startPortal('guarded', 'Google')
  const good = portalCallback(started.loginUrl!)
  for (const bad of [
    portalCallback(started.loginUrl!, 'google', { state: 'wrong', error: 'SYNTHETIC_SECRET' }),
    portalCallback(started.loginUrl!, 'github'), portalCallback(started.loginUrl!, '__proto__'),
    portalCallback(started.loginUrl!, 'external_idp')
  ]) {
    assert.equal((await fetch(bad)).status, 400)
    assert.equal(h.manager.pollPortal('guarded').completed, false)
  }
  const duplicate = new URL(good)
  duplicate.searchParams.append('state', started.state!)
  assert.equal((await fetch(duplicate)).status, 400)
  assert.equal(h.calls.length, 0)
  assert.equal((await fetch(good)).status, 200)
  assert.equal(h.manager.pollPortal('guarded').provider, 'Google')
})

test('portal callback validates Host, method, request target and path before handling authorization', async t => {
  const h = harness()
  t.after(() => h.manager.cancel('portal', 'malformed'))
  const started = await h.manager.startPortal('malformed')
  const callback = portalCallback(started.loginUrl!)
  const badRequests = [
    { method: 'POST', path: callback.pathname + callback.search, host: callback.host },
    { method: 'GET', path: callback.pathname + callback.search, host: 'evil.example.invalid' },
    { method: 'GET', path: '/different-path' + callback.search, host: callback.host },
    { method: 'GET', path: 'http://evil.example.invalid/oauth/callback' + callback.search, host: callback.host },
    { method: 'GET', path: 'http://[', host: callback.host }
  ]
  for (const bad of badRequests) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: callback.port, method: bad.method, path: bad.path, headers: { Host: bad.host } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject); req.end()
    })
    assert.equal(status, 400)
  }
  assert.equal(h.calls.length, 0)
  assert.equal((await fetch(callback)).status, 200)
  assert.equal(h.manager.pollPortal('malformed').completed, true)
})

test('duplicate Social callback while exchange is pending cannot exchange or publish twice', async t => {
  const delayed = deferred<ReturnType<typeof reply>>()
  let calls = 0
  const h = harness({ fetch: async () => { calls++; return delayed.promise } })
  t.after(() => h.manager.cancel('portal', 'single'))
  const started = await h.manager.startPortal('single')
  const callback = portalCallback(started.loginUrl!)
  const first = fetch(callback)
  await until(() => calls === 1)
  assert.equal((await fetch(callback)).status, 409)
  delayed.resolve(reply(tokenData))
  assert.equal((await first).status, 200)
  assert.equal(calls, 1)
  assert.equal(h.manager.pollPortal('single').completed, true)
  assert.equal(h.manager.pollPortal('single').success, false)
})

test('Builder and Enterprise use a separate bound IdC callback with exact registered PKCE fields', async t => {
  for (const [option, provider, issuer, region] of [
    ['builderid', 'BuilderId', 'https://view.awsapps.com/start', 'us-east-1'],
    ['awsidc', 'Enterprise', 'https://synthetic.awsapps.com/start', 'eu-central-1']
  ]) {
    const h = harness()
    t.after(() => h.manager.cancel('portal', option))
    const start = await h.manager.startPortal(option, undefined, true)
    const callback = portalCallback(start.loginUrl!, option, { issuer_url: issuer, idc_region: region })
    assert.equal((await fetch(callback)).status, 200)
    await until(() => h.opened.length === 2)
    const authorize = new URL(h.opened[1].url)
    assert.equal(authorize.origin, `https://oidc.${region}.amazonaws.com`)
    assert.equal(authorize.pathname, '/authorize')
    assert.equal(h.opened[1].privateMode, true)
    const client = JSON.parse(h.calls[0].init.body)
    assert.equal(client.issuerUrl, issuer)
    assert.deepEqual(client.grantTypes, ['authorization_code', 'refresh_token'])
    assert.deepEqual(client.redirectUris, ['http://127.0.0.1/oauth/callback'])
    assert.notEqual(authorize.searchParams.get('state'), start.state)
    const idcCallback = new URL(authorize.searchParams.get('redirect_uri')!)
    assert.equal(idcCallback.hostname, '127.0.0.1')
    assert.equal(idcCallback.pathname, '/oauth/callback')
    assert.ok(Number(idcCallback.port) > 0)
    idcCallback.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'SYNTHETIC_IDC_CODE' }).toString()
    assert.equal((await fetch(idcCallback)).status, 200)
    const payload = JSON.parse(h.calls[1].init.body)
    assert.equal(payload.redirectUri, authorize.searchParams.get('redirect_uri'))
    assert.equal(payload.grantType, 'authorization_code')
    assert.equal(payload.clientId, registration.clientId)
    assert.equal(createHash('sha256').update(payload.codeVerifier).digest('base64url'), authorize.searchParams.get('code_challenge'))
    const result = h.manager.pollPortal(option)
    assert.equal(result.provider, provider)
    assert.equal(result.authMethod, 'IdC')
    assert.equal(result.region, region)
    assert.equal(result.startUrl, issuer)
    assert.equal(result.clientSecretExpiresAt, registration.clientSecretExpiresAt)
  }
})

test('untrusted issuer or region never directs client credentials to an arbitrary endpoint', async t => {
  const h = harness()
  t.after(() => h.manager.cancel('portal', 'issuer'))
  const started = await h.manager.startPortal('issuer')
  for (const [issuer, region, option] of [
    ['https://evil.example.invalid/start', 'us-east-1', 'awsidc'],
    ['https://synthetic.awsapps.com.evil.invalid/start', 'us-east-1', 'awsidc'],
    ['https://synthetic.awsapps.com:444/start', 'us-east-1', 'awsidc'],
    ['https://synthetic.awsapps.com/start?redirect=evil', 'us-east-1', 'awsidc'],
    ['https://synthetic.awsapps.com/start', 'us-east-1.evil.invalid/', 'awsidc'],
    ['https://synthetic.awsapps.com/start', 'us-east-1', 'builderid']
  ]) {
    assert.equal((await fetch(portalCallback(started.loginUrl!, option, { issuer_url: issuer, idc_region: region }))).status, 400)
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.opened.length, 1)
  assert.equal(h.manager.pollPortal('issuer').completed, false)
})

test('cancelled in-flight Social exchange cannot insert a result into a newer portal session', async t => {
  const delayed = deferred<ReturnType<typeof reply>>()
  let calls = 0
  const h = harness({ fetch: async () => { calls++; return delayed.promise } })
  t.after(() => h.manager.cancel('portal', 'new'))
  const old = await h.manager.startPortal('old')
  const first = fetch(portalCallback(old.loginUrl!)).catch(() => null)
  await until(() => calls === 1)
  h.manager.cancel('portal', 'old')
  await h.manager.startPortal('new')
  delayed.resolve(reply(tokenData))
  await first
  await tick()
  assert.equal(h.manager.pollPortal('old').status, 'cancelled')
  h.manager.cancel('portal', 'old')
  assert.equal(h.manager.pollPortal('new').completed, false)
})

test('portal body deadlines and bad server responses fail closed without exposing response or error values', async t => {
  for (const mode of ['timeout', 'missing-token', 'upstream', 'invalid-json']) {
    const h = harness({ requestTimeoutMs: 20, fetch: async () => mode === 'timeout'
      ? { ok: true, status: 200, json: () => new Promise(() => {}) }
      : mode === 'missing-token' ? reply({ ...tokenData, accessToken: '' })
        : mode === 'upstream' ? reply({ error: 'SYNTHETIC_PRIVATE_SERVER_VALUE' }, 500)
          : { ok: true, status: 200, json: async () => { throw new Error('SYNTHETIC_PRIVATE_SERVER_VALUE') } } })
    t.after(() => h.manager.cancel('portal', mode))
    const started = await h.manager.startPortal(mode)
    assert.equal((await fetch(portalCallback(started.loginUrl!))).status, 400)
    const result = h.manager.pollPortal(mode)
    assert.equal(result.success, false)
    assert.equal(result.completed, true)
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_SERVER_VALUE|SYNTHETIC_ACCESS/)
    assert.equal(h.manager.pollPortal(mode).status, 'cancelled')
  }
})

test('denied or expired portal sessions cannot exchange a code', async t => {
  let now = 0
  const h = harness({ now: () => now })
  t.after(() => h.manager.cancel('portal', 'expired'))
  const denied = await h.manager.startPortal('denied')
  assert.equal((await fetch(portalCallback(denied.loginUrl!, 'google', { error: 'access_denied' }))).status, 400)
  assert.equal(h.manager.pollPortal('denied').error, '用户拒绝授权')
  const expired = await h.manager.startPortal('expired')
  now = 600001
  assert.equal(h.manager.pollPortal('expired').status, 'cancelled')
  assert.equal(h.calls.length, 0)
  assert.equal(h.manager.pollPortal('denied').status, 'cancelled')
  assert.ok(expired.success)
})

test('listener collision advances only to the configured port and browser failure closes its callback server', async t => {
  const blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => { blocker.close(); blocker.closeAllConnections() })
  const address = blocker.address()
  assert.ok(address && typeof address !== 'string')
  const h = harness({ portalPorts: [address.port, 0] })
  t.after(() => h.manager.cancel('portal', 'ports'))
  const started = await h.manager.startPortal('ports')
  assert.equal(started.success, true)
  const callback = portalCallback(started.loginUrl!)
  assert.notEqual(Number(callback.port), address.port)
  h.manager.cancel('portal', 'ports')
  const failed = harness({ openBrowser: () => false })
  const result = await failed.manager.startPortal('browser')
  assert.equal(result.success, false)
  assert.equal(failed.manager.pollPortal('browser').status, 'cancelled')
})
