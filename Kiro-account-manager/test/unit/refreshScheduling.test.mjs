// Offline reproduction: production callbacks, synthetic identities, fake time and transport.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const app = new URL('../../', import.meta.url)
const ts = createRequire(new URL('package.json', app))('typescript')
const { TokenRefreshService, refreshFailureDiagnostic } = await import(new URL('src/main/authRefresh.ts', app))
const { accountProbeFailure, userInfoFailure, preserveRefreshStatus } = await import(new URL('src/main/accountProbe.ts', app))
const { resolveAccountProxyUrl } = await import(new URL('src/main/accountProxyBinding.ts', app))
const parse = name => ts.createSourceFile(name, readFileSync(new URL(name, app), 'utf8'), ts.ScriptTarget.Latest, true)
const main = parse('src/main/index.ts'), renderer = parse('src/renderer/src/store/accounts.ts')
function find(tree, predicate) {
  let result
  const walk = node => { if (predicate(node)) result = node; ts.forEachChild(node, walk) }
  walk(tree)
  assert.ok(result)
  return result
}
const mainFunctions = ['runMainPoolTokenRefreshTick', 'mainTokenRefreshLeadMs', 'isBannedAccountErrorMain', 'startMainPoolTokenRefresh', 'stopMainPoolTokenRefresh']
  .map(name => find(main, node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(main)).join('\n')
const batch = find(main, node => ts.isVariableDeclaration(node) && node.name.getText(main) === 'backgroundBatchRefresh').initializer.getText(main)
const rendererFunctions = ['tokenRefreshLeadMs', 'isBannedAccountError'].map(name =>
  find(renderer, node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(renderer).replace(/^export /, '')).join('\n')
const rendererActions = ['startAutoTokenRefresh', 'triggerBackgroundRefresh'].map(name =>
  find(renderer, node => ts.isPropertyAssignment(node) && node.name.getText(renderer) === name).getText(renderer)).join(',\n')
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

async function scenario({ rendererOffset = 5000, responseKind = 'html403', enableMain = true, enableRenderer = true }) {
  const epoch = 1_800_000_000_000, horizon = 900_000
  let elapsed = 0, serial = 0, requests = 0, active = 0, peak = 0
  const timers = new Map(), pending = new Set(), jobs = [], errors = []
  const countsByMinute = Array.from({ length: 15 }, () => 0)
  const setTimer = (callback, delay, interval) => { const id = ++serial; timers.set(id, { at: elapsed + delay, callback, interval }); return id }
  const setTimeout = (callback, delay = 0) => setTimer(callback, delay)
  const setInterval = (callback, delay) => setTimer(callback, delay, delay)
  const clearTimer = id => timers.delete(id)
  const DateClock = class extends Date { static now() { return epoch + elapsed } }
  const accounts = Object.fromEntries(Array.from({ length: 229 }, (_, i) => [`SYNTHETIC_${i}`, {
    id: `SYNTHETIC_${i}`, email: `synthetic-${i}@example.invalid`, idp: 'Github', status: 'error', lastError: 'HTTP 403: refresh rejected',
    credentials: { authMethod: 'social', provider: 'Github', accessToken: `SYNTHETIC_ACCESS_${i}`, refreshToken: `SYNTHETIC_REFRESH_${i}`, expiresAt: epoch - 1000 }
  }]))
  const saved = { accounts, autoRefreshEnabled: true, autoRefreshConcurrency: 100, autoRefreshInterval: 5 }
  const service = new TokenRefreshService({
    now: () => epoch + elapsed, socialEndpoint: 'https://synthetic.invalid', socialUserAgent: () => 'SYNTHETIC',
    fetch: async () => {
      requests++; countsByMinute[Math.floor(elapsed / 60_000)]++; active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      if (responseKind === 'uncertain') throw new Error('SYNTHETIC_NETWORK_FAILURE')
      return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } }
    }
  })
  const track = (label, work) => {
    jobs.push({ label, atMs: elapsed })
    const task = work()
    pending.add(task)
    task.then(() => pending.delete(task), error => { pending.delete(task); errors.push(String(error)) })
    return task
  }
  let uiActions
  const context = vm.createContext({
    Date: DateClock, Set, Map, Promise, Error, setTimeout, setInterval, clearTimeout: clearTimer, clearInterval: clearTimer,
    console: { log() {}, warn: (...args) => { if (String(args[0]).includes('tick failed')) errors.push(String(args[1])) }, error() {} },
    store: { get: () => saved }, proxyServer: null,
    initStore: async () => { throw new Error('No actual store may be opened') },
    instanceAccountOwnership: { isBound: () => false, beginOperation: () => () => {} },
    poolRefreshInFlightIds: new Set(), mainPoolRefreshTimer: null, tokenRefreshTimer: null,
    TOKEN_REFRESH_MIN_LEAD_MS: 600_000,
    readMatchingKiroAuthToken: async () => null,
    refreshTokenByMethod: async (refreshToken, _clientId, _clientSecret, _region, _authMethod, proxyUrl) => service.refresh({ kind: 'social', refreshToken, proxyUrl }),
    refreshFailureDiagnostic, accountProbeFailure, userInfoFailure, preserveRefreshStatus, resolveAccountProxyUrl,
    mainWindow: { webContents: { send() {} } },
    get: () => ({ ...saved, accounts: new Map(Object.entries(accounts)), autoRefreshSyncInfo: true, autoSwitchEnabled: false, ...uiActions }),
    window: { api: { backgroundBatchRefresh: (items, concurrency, syncInfo) => track('renderer', () => context.batch(items, concurrency, syncInfo)) } }
  })
  vm.runInContext(compile(`globalThis.batch = ${batch}; ${mainFunctions}\n${rendererFunctions}\nglobalThis.uiActions={${rendererActions}};`), context)
  uiActions = context.uiActions
  context.backgroundBatchRefreshImpl = (items, concurrency, syncInfo) => track('main', () => context.batch(items, concurrency, syncInfo))
  if (enableMain) context.startMainPoolTokenRefresh()
  if (enableRenderer) setTimeout(() => uiActions.startAutoTokenRefresh(), rendererOffset)
  while (true) {
    const next = Math.min(...Array.from(timers.values(), item => item.at))
    if (!Number.isFinite(next) || next >= horizon) break
    elapsed = next
    const due = Array.from(timers.entries()).filter(([, item]) => item.at === next)
    for (const [id, item] of due) {
      if (!timers.has(id)) continue
      if (item.interval) item.at += item.interval
      else timers.delete(id)
      item.callback()
    }
    // Drain production promise chains before advancing the next timer event.
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }
  assert.deepEqual(errors, [])
  assert.equal(pending.size, 0)
  assert.equal(active, 0)
  return { window: '[0, 15 minutes)', rendererOffsetMs: rendererOffset, responseKind, enableMain, enableRenderer,
    accounts: 229, configuredConcurrency: 100, requests, peakConcurrentRequests: peak, countsByMinute,
    jobs: { main: jobs.filter(item => item.label === 'main').length, renderer: jobs.filter(item => item.label === 'renderer').length } }
}

test('actual main and renderer schedulers share admission instead of repeating 229 HTML failures every minute', async () => {
  const result = await scenario({ rendererOffset: 5000 })
  assert.deepEqual(result.jobs, { main: 15, renderer: 3 })
  assert.ok(result.requests <= 20, `sent ${result.requests} POSTs in fifteen minutes`)
  assert.ok(result.peakConcurrentRequests <= 4)
})

test('automatic cooldown never replays uncertain POSTs when both production schedulers keep firing', async () => {
  const result = await scenario({ rendererOffset: 5000, responseKind: 'uncertain' })
  assert.deepEqual(result.jobs, { main: 15, renderer: 3 })
  assert.equal(result.requests, 229)
  assert.ok(result.peakConcurrentRequests <= 4)
})
