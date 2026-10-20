/**
 * Offline evidence for the original online-login implementation.
 * Run with Node >= 22.13:
 *   node docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs
 *   node docs/2026-10-19-account-import-login/evidence/online-login-repro.mjs --ref v1.7.5
 *
 * Extracts and executes the actual handler/polling bodies from the checkout.
 * IPC, network, browser, protocol registry, window and HTTP server are mocks.
 * Does not launch Electron, bind ports, access credentials, or contact services.
 * Assertions below intentionally demonstrate existing defects, not fixes.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import * as cryptoMock from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const refIndex = process.argv.indexOf('--ref')
const sourceRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined
if (refIndex >= 0) assert.ok(sourceRef, '--ref requires an existing Git ref')
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
async function sourceFile(path) {
  return sourceRef
    ? execFileSync('git', ['show', `${sourceRef}:${path}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')
}
const mainSource = await sourceFile('Kiro-account-manager/src/main/index.ts')
const rendererSource = await sourceFile('Kiro-account-manager/src/renderer/src/components/accounts/AddAccountDialog.tsx')

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `Source markers unavailable: ${startMarker}`)
  return source.slice(start, end)
}

const loginBody = stripTypeScriptTypes(
  section(mainSource, '  // 存储当前登录状态', '  // IPC: 设置代理')
    .replaceAll("await import('crypto')", 'cryptoMock')
    .replaceAll("await import('http')", 'httpMock'),
  { mode: 'strip' }
)
const protocolBody = stripTypeScriptTypes(
  section(mainSource, '  // 更新协议处理函数以支持 Social Auth 回调', '  createWindow()'),
  { mode: 'strip' }
)
const registrationBody = stripTypeScriptTypes(
  section(mainSource, '// 注册自定义协议\n', '// 处理协议 URL (用于 OAuth 回调)'),
  { mode: 'strip' }
)
const builderPollBody = stripTypeScriptTypes(
  section(rendererSource, '  // 开始轮询 Builder ID 授权', '  // 取消登录'),
  { mode: 'strip' }
)
const quietConsole = { log() {}, error() {}, warn() {} }

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) }
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function makeHarness() {
  const handlers = new Map()
  const calls = []
  const browserOpens = []
  const servers = []
  let fetchHook
  let clientCounter = 0
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler) }
  const fetchMock = async (url, options) => {
    const request = { url, body: JSON.parse(options.body) }
    calls.push(request)
    if (fetchHook) {
      const result = fetchHook(request)
      if (result !== undefined) return result
    }
    if (url.endsWith('/client/register')) return response({ clientId: `synthetic-client-${++clientCounter}`, clientSecret: 'synthetic-secret' })
    if (url.endsWith('/device_authorization')) return response({ deviceCode: 'synthetic-device', userCode: 'SYNTHETIC', verificationUri: 'https://invalid.example/authorize', interval: 5, expiresIn: 600 })
    if (request.body.grantType === 'urn:ietf:params:oauth:grant-type:device_code') return response({ error: 'authorization_pending' }, 400)
    return response({ accessToken: `synthetic-access-${request.body.code}`, refreshToken: `synthetic-refresh-${request.body.code}`, expiresIn: 3600 })
  }
  const httpMock = {
    createServer(callback) {
      const server = {
        callback,
        closed: false,
        port: 41000 + servers.length,
        listen(port, host, ready) { this.port = port || this.port; ready?.(); return this },
        address() { return { port: this.port } },
        close(done) { this.closed = true; done?.() }
      }
      servers.push(server)
      return server
    }
  }
  const factory = new Function(
    'ipcMain', 'fetchWithAppProxy', 'cryptoMock', 'httpMock', 'console', 'shell', 'openBrowserInPrivateMode', 'URL', 'URLSearchParams',
    `const KIRO_AUTH_ENDPOINT = 'https://invalid.example';\n${loginBody}\nreturn { state: () => currentLoginState, iamResult: () => iamSsoResult };`
  )
  const state = factory(ipcMain, fetchMock, cryptoMock, httpMock, quietConsole, { openExternal: url => browserOpens.push(url) }, url => browserOpens.push(url), URL, URLSearchParams)
  return {
    ...state,
    calls,
    browserOpens,
    servers,
    setFetchHook(hook) { fetchHook = hook },
    invoke(name, ...args) { assert.ok(handlers.has(name), `Missing IPC handler ${name}`); return handlers.get(name)(null, ...args) },
    async callback(server, authorizeUrl, code) {
      const stateValue = new URL(authorizeUrl).searchParams.get('state')
      const url = `/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateValue)}`
      const result = { status: undefined, html: undefined }
      const res = { writeHead(status) { result.status = status }, end(html) { result.html = html } }
      await server.callback({ url }, res)
      return result
    }
  }
}

function makeProtocolRouter(initialWindow) {
  const factory = new Function('initialWindow', 'console', `
    let mainWindow = initialWindow;
    const PROTOCOL_PREFIX = 'kiro';
    let handleProtocolUrl = () => {};
    ${protocolBody}
    return { route: url => handleProtocolUrl(url), setWindow: window => { mainWindow = window } };
  `)
  return factory(initialWindow, quietConsole)
}

function makeRendererPoller(harness) {
  let scheduled
  const factory = new Function('window', 'setInterval', 'clearInterval', 'console', `
    const region = 'us-east-1';
    const pollIntervalRef = { current: null };
    const setError = () => {};
    const setIsLoggingIn = () => {};
    const setBuilderIdLoginData = () => {};
    const handleLoginSuccess = async () => {};
    ${builderPollBody}
    return startPolling;
  `)
  const start = factory(
    { api: { pollBuilderIdAuth: region => harness.invoke('poll-builder-id-auth', region) } },
    (fn, ms) => { scheduled = { fn, ms }; return scheduled },
    () => {},
    quietConsole
  )
  start(5)
  return { tick: () => scheduled.fn(), interval: () => scheduled.ms }
}

const observations = []
async function check(name, test) {
  const detail = await test()
  observations.push({ name, ...detail })
}

await check('positive-social-google-and-github-main-handler-flow', async () => {
  for (const provider of ['Google', 'Github']) {
    const h = makeHarness()
    const started = await h.invoke('start-social-login', provider, false)
    const result = await h.invoke('exchange-social-token', `synthetic-${provider}`, started.state)
    assert.equal(result.success, true)
    assert.equal(result.provider, provider)
  }
  return { result: 'Mocked social token exchange works when callback is delivered.' }
})

await check('positive-iam-authorization-code-loopback-and-poll-flow', async () => {
  const h = makeHarness()
  const started = await h.invoke('start-iam-sso-login', 'https://invalid.example/start', 'us-east-1')
  assert.equal(started.success, true)
  const server = h.servers.findLast(server => server.callback)
  await h.callback(server, started.authorizeUrl, 'synthetic-iam')
  const result = await h.invoke('poll-iam-sso-auth')
  assert.equal(result.success, true)
  assert.equal(result.completed, true)
  assert.equal(result.accessToken, 'synthetic-access-synthetic-iam')
  assert.equal(server.closed, true)
  return { result: 'Main exchanges authorization code; renderer IPC poll reads completed result.' }
})

await check('protocol-registration-failure-is-reported-as-registered', async () => {
  const logs = []
  const operations = []
  const app = {
    setAsDefaultProtocolClient: scheme => { operations.push(`register:${scheme}`); return false },
    removeAsDefaultProtocolClient: scheme => { operations.push(`unregister:${scheme}`); return false }
  }
  const run = new Function('app', 'process', 'join', 'console', `const PROTOCOL_PREFIX = 'kiro'; ${registrationBody}; registerProtocol();`)
  run(app, { defaultApp: false }, value => value, { log: value => logs.push(value) })
  assert.deepEqual(operations, ['unregister:kiro', 'register:kiro'])
  assert.ok(logs.some(line => line.includes('Registered kiro://')))
  return { result: 'False protocol-registration return is ignored; success is logged.', operations }
})

await check('protocol-callback-before-window-is-lost', async () => {
  const delivered = []
  const router = makeProtocolRouter(null)
  router.route('kiro://kiro.kiroAgent/authenticate-success?code=synthetic-code&state=synthetic-state')
  router.setWindow({ webContents: { send: (...args) => delivered.push(args) }, focus() {} })
  assert.equal(delivered.length, 0)
  return { result: 'No callback is replayed when the window becomes available.' }
})

await check('protocol-callback-without-renderer-subscriber-is-lost', async () => {
  const subscribers = []
  const delivered = []
  const router = makeProtocolRouter({ webContents: { send: (...args) => subscribers.forEach(fn => fn(...args)) }, focus() {} })
  router.route('kiro://kiro.kiroAgent/authenticate-success?code=synthetic-code&state=synthetic-state')
  subscribers.push((...args) => delivered.push(args))
  assert.equal(delivered.length, 0)
  return { result: 'IPC send is instantaneous and has no acknowledgment or pending-result retrieval.' }
})

await check('social-invalid-state-cancels-valid-session', async () => {
  const h = makeHarness()
  const started = await h.invoke('start-social-login', 'Google', false)
  const invalid = await h.invoke('exchange-social-token', 'synthetic-unrelated-code', 'synthetic-wrong-state')
  assert.equal(invalid.success, false)
  assert.equal(h.state(), null)
  const valid = await h.invoke('exchange-social-token', 'synthetic-valid-code', started.state)
  assert.equal(valid.success, false)
  return { result: 'A stale/mismatching callback destroys the active session before its real callback.' }
})

await check('social-session-has-no-expiration', async () => {
  const h = makeHarness()
  await h.invoke('start-social-login', 'Github', false)
  assert.equal(h.state().expiresAt, undefined)
  return { result: 'Social session has neither expiresAt nor a timeout timer in extracted handlers.' }
})

await check('cancelled-social-exchange-clears-next-social-session', async () => {
  const h = makeHarness()
  const startedA = await h.invoke('start-social-login', 'Google', false)
  const pending = deferred()
  h.setFetchHook(request => request.body.code === 'synthetic-social-a' ? pending.promise : undefined)
  const exchangeA = h.invoke('exchange-social-token', 'synthetic-social-a', startedA.state)
  await h.invoke('cancel-social-login')
  const startedB = await h.invoke('start-social-login', 'Github', false)
  assert.equal(h.state().oauthState, startedB.state)
  pending.resolve(response({ accessToken: 'synthetic-old-social-a', refreshToken: 'synthetic-old-refresh-a', expiresIn: 3600 }))
  await exchangeA
  assert.equal(h.state(), null)
  const resultB = await h.invoke('exchange-social-token', 'synthetic-social-b', startedB.state)
  assert.equal(resultB.success, false)
  return { result: 'Late exchange A clears B; B then cannot exchange its genuine callback.' }
})

await check('builder-slow-down-does-not-change-renderer-cadence', async () => {
  const h = makeHarness()
  await h.invoke('start-builder-id-login', 'us-east-1')
  h.setFetchHook(request => request.url.endsWith('/token') ? response({ error: 'slow_down' }, 400) : undefined)
  const poller = makeRendererPoller(h)
  await poller.tick()
  assert.equal(h.state().interval, 10)
  assert.equal(poller.interval(), 5000)
  return { result: 'Main interval becomes 10 s while renderer keeps scheduling every 5 s.', mainIntervalSeconds: h.state().interval, rendererIntervalMs: poller.interval() }
})

await check('builder-renderer-allows-overlapping-token-polls', async () => {
  const h = makeHarness()
  await h.invoke('start-builder-id-login', 'us-east-1')
  const pending = deferred()
  let inFlight = 0
  h.setFetchHook(request => {
    if (!request.url.endsWith('/token')) return undefined
    inFlight++
    return pending.promise
  })
  const poller = makeRendererPoller(h)
  const first = poller.tick()
  const second = poller.tick()
  assert.equal(inFlight, 2)
  pending.resolve(response({ error: 'authorization_pending' }, 400))
  await Promise.all([first, second])
  return { result: 'Two renderer interval ticks start two token requests before the first resolves.', concurrentRequests: inFlight }
})

await check('cancelled-builder-poll-clears-next-builder-session', async () => {
  const h = makeHarness()
  await h.invoke('start-builder-id-login', 'us-east-1')
  const pending = deferred()
  h.setFetchHook(request => request.body.grantType === 'urn:ietf:params:oauth:grant-type:device_code' ? pending.promise : undefined)
  const pollA = h.invoke('poll-builder-id-auth', 'us-east-1')
  await h.invoke('cancel-builder-id-login')
  await h.invoke('start-builder-id-login', 'eu-west-1')
  assert.equal(h.state().type, 'builderid')
  pending.resolve(response({ error: 'expired_token' }, 400))
  await pollA
  assert.equal(h.state(), null)
  const pollB = await h.invoke('poll-builder-id-auth', 'eu-west-1')
  assert.equal(pollB.success, false)
  return { result: 'Late failure from cancelled poll A clears B before B can complete.' }
})

await check('cancelled-iam-response-is-consumed-by-next-iam-session', async () => {
  const h = makeHarness()
  const first = await h.invoke('start-iam-sso-login', 'https://invalid.example/start-a', 'us-east-1')
  const serverA = h.servers.findLast(server => server.callback)
  const pending = deferred()
  h.setFetchHook(request => request.body.code === 'synthetic-session-a' ? pending.promise : undefined)
  const oldCallback = h.callback(serverA, first.authorizeUrl, 'synthetic-session-a')
  await h.invoke('cancel-iam-sso-login')
  await h.invoke('start-iam-sso-login', 'https://invalid.example/start-b', 'eu-west-1')
  assert.equal(h.state().region, 'eu-west-1')
  pending.resolve(response({ accessToken: 'synthetic-old-session-a-access', refreshToken: 'synthetic-old-session-a-refresh', expiresIn: 3600 }))
  await oldCallback
  const resultForB = await h.invoke('poll-iam-sso-auth')
  assert.equal(resultForB.accessToken, 'synthetic-old-session-a-access')
  assert.equal(resultForB.region, 'us-east-1')
  assert.equal(h.state(), null)
  return { result: 'Session B consumes session A tokens and is cleared by the old completion.', returnedRegionForSessionB: resultForB.region }
})

await check('iam-page-reports-success-before-token-exchange-finishes', async () => {
  const h = makeHarness()
  const started = await h.invoke('start-iam-sso-login', 'https://invalid.example/start', 'us-east-1')
  const server = h.servers.findLast(server => server.callback)
  h.setFetchHook(request => request.body.grantType === 'authorization_code' ? response({ error: 'synthetic-token-exchange-error' }, 400) : undefined)
  const page = await h.callback(server, started.authorizeUrl, 'synthetic-failing-code')
  const result = await h.invoke('poll-iam-sso-auth')
  assert.ok(page.html.includes('授权成功'))
  assert.equal(result.success, false)
  return { result: 'Browser receives success HTML although token exchange then fails.' }
})

console.log(JSON.stringify({
  sourceRef: sourceRef || 'working-tree',
  scope: 'Extracted original source with mocks; no real login or operating-system protocol integration.',
  assertionsPassed: observations.length,
  observations,
  stillNeedsDesktopValidation: [
    'Actual Windows/macOS/Linux protocol registration ownership and browser external-protocol consent.',
    'Packaged Electron cold start / hidden or minimized window behavior.',
    'Real provider authentication and network responses through configured proxies.'
  ]
}, null, 2))
