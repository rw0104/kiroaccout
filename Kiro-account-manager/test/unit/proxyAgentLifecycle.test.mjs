import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

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
  return { api: context.exports, created, intervals, tick(ms) { now += ms; for (const timer of intervals) timer.fn() } }
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
