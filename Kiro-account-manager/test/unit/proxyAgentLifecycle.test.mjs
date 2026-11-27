import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { TokenRefreshService } from '../../src/main/authRefresh.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const read = path => readFileSync(new URL(`../../src/main/${path}`, import.meta.url), 'utf8')
function harness({ pendingClose = false } = {}) {
  const created = [], intervals = new Set()
  let now = 100000
  class Clock extends Date { static now() { return now } }
  class Agent {
    constructor(options) { this.options = options; this.closes = 0; this.destroys = 0; created.push(this) }
    async close() { this.closes++; if (pendingClose) await new Promise(resolve => { this.finishClose = resolve }) }
    async destroy() { this.destroys++ }
  }
  const context = vm.createContext({ exports: {}, URL, Buffer, Date: Clock, console,
    setInterval(fn) { const timer = { fn, unref() {} }; intervals.add(timer); return timer },
    clearInterval(timer) { intervals.delete(timer) },
    require(name) { return name === 'undici' ? { ProxyAgent: Agent, Agent } : require(name) }
  })
  vm.runInContext(compile(read('proxy/systemProxy.ts')), context)
  return { api: context.exports, created, intervals, now: () => now, tick(ms) { now += ms; for (const timer of intervals) timer.fn() } }
}

for (const file of ['index.ts', 'proxy/kiroApi.ts']) {
  test(`${file}: 1000 real network-agent selections reuse a single connection pool`, async () => {
    const h = harness()
    const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    const entry = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getNetworkAgent')
    const context = vm.createContext({ ...h.api, process: { env: { HTTPS_PROXY: 'http://synthetic.invalid:8080' } }, useKProxyForApi: false })
    vm.runInContext(compile(entry.getText(tree)), context)
    const first = context.getNetworkAgent()
    for (let i = 0; i < 999; i++) assert.equal(context.getNetworkAgent(), first)
    assert.equal(h.created.length, 1)
    await h.api.closeSharedProxyAgents()
  })
}

test('shared proxy pools isolate credentials and CA trust, evict LRU entries, and clean up while idle', async () => {
  const h = harness(), get = h.api.getSharedProxyAgent
  assert.equal(typeof get, 'function')
  const normal = get('http://synthetic.invalid:8080')
  assert.equal(get('http://synthetic.invalid:8080'), normal)
  assert.notEqual(get('http://synthetic.invalid:8080', { targetCa: 'SYNTHETIC_CA' }), normal)
  assert.notEqual(get('http://synthetic:only-test@synthetic.invalid:8080'), normal)
  for (let i = 0; i < 40; i++) get(`http://synthetic-${i}.invalid:8080`)
  assert.equal(normal.closes, 1, 'LRU eviction must gracefully drain the old pool')
  assert.equal(h.created.filter(agent => agent.closes === 0).length, 32)
  h.tick(5 * 60 * 1000 + 1)
  assert.ok(h.created.every(agent => agent.closes === 1), 'idle pools must close without a new request')
  assert.equal(h.intervals.size, 0)
  const fresh = get('socks5://synthetic.invalid:1080')
  await h.api.closeSharedProxyAgents()
  assert.equal(fresh.destroys, 1)
  assert.equal(h.intervals.size, 0)
})

test('pending streams drain without interruption, total pools stay bounded, and shutdown releases them', async () => {
  const h = harness({ pendingClose: true })
  for (let i = 0; i < 64; i++) h.api.getSharedProxyAgent(`http://synthetic-${i}.invalid:8080`)
  assert.equal(h.created.length, 64)
  assert.equal(h.created.filter(agent => agent.closes === 1).length, 32)
  assert.ok(h.created.every(agent => agent.destroys === 0), 'eviction must not interrupt streams')
  assert.throws(() => h.api.getSharedProxyAgent('http://overflow.invalid:8080'), { code: 'ERR_PROXY_POOL_CAPACITY' })
  assert.equal(h.created.length, 64, 'capacity rejection must not construct another pool')
  assert.equal(h.api.getSharedProxyAgent('http://synthetic-63.invalid:8080'), h.created[63], 'cached routes remain usable')
  h.created[0].finishClose()
  await new Promise(resolve => setImmediate(resolve))
  h.api.getSharedProxyAgent('http://after-drain.invalid:8080')
  assert.equal(h.created.length, 65, 'finished drain makes capacity available')
  await h.api.closeSharedProxyAgents()
  assert.ok(h.created.slice(1).every(agent => agent.destroys === 1))
  for (const agent of h.created) agent.finishClose?.()
})

test('opaque logical proxy route identity survives idle and LRU replacement while configuration changes remain separate', async () => {
  const h = harness(), url = 'http://synthetic:only-test@synthetic.invalid:8080'
  const original = h.api.getSharedProxyAgent(url)
  const route = h.api.getSharedProxyRouteId(original)
  assert.match(route, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(route, /synthetic|only-test/)
  for (let i = 0; i < 40; i++) h.api.getSharedProxyAgent(`http://other-${i}.invalid:8080`)
  const replaced = h.api.getSharedProxyAgent(url)
  assert.notEqual(replaced, original)
  assert.equal(h.api.getSharedProxyRouteId(replaced), route)
  h.tick(300001)
  const afterIdle = h.api.getSharedProxyAgent(url)
  assert.notEqual(afterIdle, replaced)
  assert.equal(h.api.getSharedProxyRouteId(afterIdle), route)
  assert.notEqual(h.api.getSharedProxyRouteId(h.api.getSharedProxyAgent(url, { targetCa: 'SYNTHETIC_CA' })), route)
  assert.notEqual(h.api.getSharedProxyRouteId(h.api.getSharedProxyAgent('http://other.invalid:8080')), route)
  await h.api.closeSharedProxyAgents()
})

test('an open Social route gate survives dispatcher idle retirement and a different configured proxy remains independent', async () => {
  const h = harness()
  let url = 'http://synthetic.invalid:8080', calls = 0
  const transport = async () => { calls++; return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } } }
  const service = new TokenRefreshService({ fetch: transport, socialEndpoint: 'https://synthetic.invalid', socialUserAgent: () => 'SYNTHETIC', now: h.now,
    resolveTransport: () => {
      const agent = h.api.getSharedProxyAgent(url)
      return { routeKey: h.api.getSharedProxyRouteId(agent), fetch: transport }
    }
  })
  for (let i = 0; i < 16; i++) await service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}`, manualRetry: true })
  assert.equal(calls, 16)
  h.tick(300001)
  const deferred = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_AFTER_IDLE' })
  assert.equal(deferred.retryDeferred, true)
  assert.equal(calls, 16)
  url = 'http://different.invalid:8080'
  assert.equal((await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_OTHER_ROUTE' })).retryDeferred, undefined)
  assert.equal(calls, 17)
  await h.api.closeSharedProxyAgents()
})

test('the actual refresh transport keys and sends through the same selected account or global dispatcher', async () => {
  const h = harness(), sent = []
  const tree = ts.createSourceFile('index.ts', read('index.ts'), ts.ScriptTarget.Latest, true)
  const names = ['getAppProxyDispatcher', 'fetchThroughDispatcher', 'fetchWithAppProxy', 'resolveRefreshTransport']
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree)).join('\n')
  let global = h.api.getSharedProxyAgent('http://global.invalid:8080')
  const context = vm.createContext({ ...h.api, getNetworkAgent: () => global,
    refreshDispatcherIds: new WeakMap(), refreshDispatcherSequence: 0,
    undiciFetch: async (_url, init) => { sent.push(init.dispatcher); return { ok: true } },
    fetch: async () => { sent.push(undefined); return { ok: true } }
  })
  vm.runInContext(compile(functions), context)
  const original = global
  const first = context.resolveRefreshTransport()
  assert.equal(first.routeKey, h.api.getSharedProxyRouteId(original))
  global = h.api.getSharedProxyAgent('http://changed.invalid:8080')
  await first.fetch('https://synthetic.invalid', {})
  assert.equal(sent.at(-1), original, 'the captured route cannot silently send through a different dispatcher')
  assert.notEqual(context.resolveRefreshTransport().routeKey, first.routeKey)
  const bound = context.resolveRefreshTransport('http://bound.invalid:8080')
  await bound.fetch('https://synthetic.invalid', {})
  assert.equal(sent.at(-1), h.api.getSharedProxyAgent('http://bound.invalid:8080'))
  assert.equal(bound.routeKey, h.api.getSharedProxyRouteId(sent.at(-1)))
  global = undefined
  const direct = context.resolveRefreshTransport()
  await direct.fetch('https://synthetic.invalid', {})
  assert.equal(direct.routeKey, 'direct')
  assert.equal(sent.at(-1), undefined)
  await h.api.closeSharedProxyAgents()
})
