import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
function subject(file, className, methods, values) {
  const tree = ts.createSourceFile(file, readFileSync(new URL(`../../src/main/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const code = declaration.members.filter(node => methods.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n')
  const context = { console: { log() {}, error() {} }, setTimeout, clearInterval,
    setInterval: () => ({ unref() {} }), clearAllCaches() {}, proxyLogger: { info() {}, warn() {} }, ...values }
  vm.runInNewContext(ts.transpileModule(`class Subject { ${code} }; globalThis.Subject = Subject`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  return new context.Subject()
}
function startHarness() {
  let resolveCert, rejectCert, created = 0, listening = 0, opened = 0
  const cert = new Promise((resolve, reject) => { resolveCert = resolve; rejectCert = reject })
  class Server extends EventEmitter {
    listen(_port, _host, ready) { listening++; ready() }
    close(done) { done?.() }
  }
  const server = subject('proxy/proxyServer.ts', 'ProxyServer', ['start', 'startServer', 'stop'], {
    https: { createServer(options) { assert.equal(options.cert, 'synthetic cert'); created++; return new Server() } }
  })
  Object.assign(server, {
    config: { host: '127.0.0.1', port: 0, tls: { enabled: true } }, startGeneration: 0, starting: null,
    isBindingExternal: () => false, getTlsOptions: () => cert,
    requestAdmission: { open() { opened++ }, close() {} }, events: {}, stats: {}, sockets: new Set(), activeRequests: new Map(),
    clearModelCache() {}, server: null, fallbackServer: null
  })
  return { server, resolveCert, rejectCert, counts: () => ({ created, listening, opened }) }
}

test('concurrent proxy starts share async certificate generation and bind one server', async () => {
  const h = startHarness()
  const first = h.server.start(), second = h.server.start()
  assert.equal(first, second)
  assert.deepEqual(h.counts(), { created: 0, listening: 0, opened: 0 })
  h.resolveCert({ cert: 'synthetic cert', key: 'synthetic key' })
  await Promise.all([first, second])
  assert.deepEqual(h.counts(), { created: 1, listening: 1, opened: 1 })
  await h.server.stop(0)
})

test('stop during certificate generation prevents the late start from opening a listener', async () => {
  const h = startHarness()
  const pending = h.server.start()
  await h.server.stop(0)
  h.resolveCert({ cert: 'synthetic cert', key: 'synthetic key' })
  await assert.rejects(pending, /start canceled/)
  assert.deepEqual(h.counts(), { created: 0, listening: 0, opened: 0 })
})

test('async certificate generation failure rejects startup before request admission opens', async () => {
  const h = startHarness()
  const pending = h.server.start()
  h.rejectCert(new Error('synthetic certificate error'))
  await assert.rejects(pending, /TLS configuration error: synthetic certificate error/)
  assert.deepEqual(h.counts(), { created: 0, listening: 0, opened: 0 })
})

test('restart while an old certificate operation is pending starts only the replacement generation', async () => {
  const h = startHarness()
  const old = h.server.start()
  const rejected = assert.rejects(old, /start canceled/)
  await h.server.stop(0)
  const replacement = h.server.start()
  assert.notEqual(replacement, old)
  h.resolveCert({ cert: 'synthetic cert', key: 'synthetic key' })
  await Promise.all([rejected, replacement])
  assert.deepEqual(h.counts(), { created: 1, listening: 1, opened: 1 })
  await h.server.stop(0)
})

test('actual certificate UI methods await generation and handle asynchronous failure', async () => {
  let fail = false, calls = 0
  const result = { cert: 'synthetic cert', key: 'synthetic key', fingerprint: 'synthetic fingerprint' }
  const server = subject('proxy/proxyServer.ts', 'ProxyServer', ['getSelfSignedCertInfo', 'regenerateSelfSignedCert'], {
    require: name => name === 'electron' ? { app: { getPath: () => 'synthetic-directory' } } : {
      ensureProxySelfSignedCert: async () => { calls++; if (fail) throw new Error('synthetic generation failure'); return result }
    }
  })
  server.config = { host: '127.0.0.1' }; server.appendAuditLog = () => {}
  assert.equal(await server.getSelfSignedCertInfo(), result)
  assert.equal(await server.regenerateSelfSignedCert(), result)
  fail = true
  assert.equal(await server.getSelfSignedCertInfo(), null)
  assert.equal(await server.regenerateSelfSignedCert(), null)
  assert.equal(calls, 4)
})

test('an abandoned MITM connection cannot resume after async leaf generation', async () => {
  let resolveCert, upgraded = 0, writes = 0
  const pendingCert = new Promise(resolve => { resolveCert = resolve })
  const proxy = subject('kproxy/mitmProxy.ts', 'MitmProxy', ['handleMitmConnect'], {
    tls: { TLSSocket: class { constructor() { upgraded++ } } }
  })
  proxy.certManager = { generateCertForHost: () => pendingCert }
  proxy.server = {}
  const socket = { destroyed: false, once() {}, write() { writes++ }, end() {} }
  const pending = proxy.handleMitmConnect('synthetic.invalid', 443, socket, Buffer.alloc(0))
  socket.destroyed = true
  resolveCert({ cert: 'synthetic cert', key: 'synthetic key' })
  await pending
  assert.equal(upgraded, 0)
  assert.equal(writes, 0)
})
