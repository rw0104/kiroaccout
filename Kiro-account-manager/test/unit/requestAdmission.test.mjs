import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { RequestAdmission, RequestAdmissionError, requiresRequestAdmission } from '../../src/main/proxy/requestAdmission.ts'

const ts = createRequire(import.meta.url)('typescript')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('pure admission is FIFO, cancellation removes waiters, and releasing a permit twice is harmless', async () => {
  const admission = new RequestAdmission({ maxConcurrent: 1 })
  const first = await admission.acquire()
  const cancelled = new AbortController()
  const second = admission.acquire(cancelled.signal).catch(error => error.code)
  let thirdEntered = false
  const third = admission.acquire().then(release => { thirdEntered = true; return release })
  cancelled.abort()
  assert.equal(await second, 'cancelled')
  assert.deepEqual(admission.state, { active: 1, pending: 1, maxConcurrent: 1, maxPending: 4 })
  assert.equal(thirdEntered, false)
  first(); first()
  const release = await third
  assert.equal(admission.state.active, 1)
  release()
  assert.equal(admission.state.active, 0)
})

test('pending capacity, timeout, close and reopen are bounded without revoking active work', async () => {
  const admission = new RequestAdmission({ maxConcurrent: 1, waitMs: 5 })
  const first = await admission.acquire()
  const pending = Array.from({ length: 4 }, () => admission.acquire().catch(error => error.code))
  await assert.rejects(admission.acquire(), error => error.code === 'queue_full')
  assert.deepEqual(await Promise.all(pending), Array(4).fill('wait_timeout'))
  assert.equal(admission.state.pending, 0)
  const wait = admission.acquire().catch(error => error.code)
  admission.close()
  assert.equal(await wait, 'stopped')
  first()
  assert.equal(admission.state.active, 0)
  admission.open()
  const release = await admission.acquire(); release()
  admission.configure(1000)
  assert.equal(admission.state.maxPending, 128)
})

/** Simulates a paused IncomingMessage: remote data is produced only once read. */
class Incoming extends EventEmitter {
  constructor(id, path = '/v1/chat/completions') {
    super(); this.id = id; this.url = path; this.method = 'POST'; this.headers = {}; this.paused = false; this.closed = false; this.remote = []; this.ended = false
  }
  on(event, listener) {
    super.on(event, listener)
    if (event === 'data' && !this.paused) queueMicrotask(() => this.flush())
    return this
  }
  pause() { this.paused = true; return this }
  resume() { this.paused = false; this.flush(); return this }
  offer(value, end = false) { this.remote.push(value); this.ended = end; this.flush() }
  flush() {
    if (this.paused || this.closed || !this.listenerCount('data')) return
    while (this.remote.length && !this.paused) this.emit('data', Buffer.from(this.remote.shift()))
    if (this.ended && !this.remote.length && !this.paused) { this.ended = false; this.emit('end') }
  }
  destroy() { this.closed = true }
}
class Outgoing extends EventEmitter {
  constructor() { super(); this.headers = {}; this.writableEnded = false; this.destroyed = false; this.status = undefined; this.output = '' }
  setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) }
  writeHead(status) { this.status = status }
  write(value) { this.output += value; return true }
  end(value = '') { this.output += value; this.writableEnded = true; this.emit('finish') }
}

function harness(waitMs = 30000) {
  const text = readFileSync(new URL('../../src/main/proxy/proxyServer.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('server.ts', text, ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
  const methods = ['handleRequest', 'handleAdminApi', 'readBody', 'getAbortError', 'isAbortError', 'stop', 'updateConfig', 'sendError', 'isAnthropicPath', 'getAnthropicErrorType', 'sanitizeErrorMessage']
  const members = declaration.members.filter(node => methods.includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n')
  const context = vm.createContext({ Buffer, AbortController, RequestAdmission, RequestAdmissionError, requiresRequestAdmission,
    console: { log() {}, error() {} }, proxyLogger: { info() {}, warn() {} }, setTimeout, clearTimeout, clearInterval,
    clearAllCaches() {}, BodyTooLargeError: class extends Error { constructor(received, limit) { super('Body too large'); this.received = received; this.limit = limit } } })
  vm.runInContext(ts.transpileModule(`class Subject { ${members} };globalThis.Subject=Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  const server = new context.Subject()
  server.config = { maxConcurrent: 1, logRequests: false }; server.activeRequests = new Set(); server.events = {}; server.isStopping = false
  server.requestAdmission = new RequestAdmission({ maxConcurrent: 1, waitMs })
  server.getClientIP = () => '127.0.0.1'; server.setCorsHeaders = () => {}; server.isClientIPAllowed = () => ({ allowed: true })
  server.validateApiKey = () => ({ valid: true }); server.checkRateLimit = () => ({ allowed: true }); server.appendAuditLog = () => {}
  server.notifyAllAccountsExhausted = () => { throw new Error('Admission pressure must not claim account exhaustion') }
  const entered = [], bodies = []
  server.handleOpenAIChat = async (req, res, signal) => {
    entered.push(req.id)
    const body = await server.readBody(req, signal)
    JSON.parse(body)
    bodies.push(body)
    res.writeHead(200); res.end(`Synthetic response ${req.id}`)
  }
  server.handleClaudeMessages = server.handleOpenAIChat
  server.handleModels = async res => { res.writeHead(200); res.end('models') }
  server.handleHealth = res => { res.writeHead(200); res.end('healthy') }
  server.clearModelCache = () => {}; server.server = { close(callback) { setImmediate(callback) } }; server.fallbackServer = null
  server.isRunning = () => true
  server.sockets = new Set(); server.cleanupTimer = null
  const request = (id, path) => { const req = new Incoming(id, path), res = new Outgoing(); return { req, res, pending: server.handleRequest(req, res) } }
  return { server, request, entered, bodies }
}

test('real handleRequest reads only one body, preserves paused payloads, and admits waiting callers FIFO', async () => {
  const { request, server, entered, bodies } = harness()
  const calls = [request('first'), request('second'), request('third')]
  calls.forEach(({ req }, index) => req.offer(JSON.stringify({ synthetic: index }), index > 0))
  await tick()
  assert.deepEqual(entered, ['first'])
  assert.equal(calls.reduce((sum, item) => sum + item.req.listenerCount('data'), 0), 1)
  assert.equal(server.requestAdmission.state.pending, 2)
  calls[0].req.offer('', true)
  await Promise.all(calls.map(item => item.pending))
  assert.deepEqual(entered, ['first', 'second', 'third'])
  assert.deepEqual(bodies.map(body => JSON.parse(body).synthetic), [0, 1, 2])
  assert.ok(calls.every(item => item.res.status === 200))
  assert.equal(server.requestAdmission.state.active, 0)
})

test('queue cancellation, parser errors and stop release actual handler permits without upstream work', async () => {
  const { request, server, entered } = harness()
  const first = request('first'), abandoned = request('abandoned'), third = request('third')
  await tick()
  abandoned.res.emit('close'); await abandoned.pending
  assert.equal(server.requestAdmission.state.pending, 1)
  first.req.offer('invalid json', true); await first.pending
  await tick()
  assert.deepEqual(entered, ['first', 'third'])
  assert.equal(first.res.status, 500)
  const waiting = request('waiting')
  await tick()
  await server.stop(0)
  await Promise.all([third.pending, waiting.pending])
  assert.equal(server.requestAdmission.state.active, 0)
  assert.equal(server.requestAdmission.state.pending, 0)
  assert.equal(server.activeRequests.size, 0)
  assert.equal(waiting.req.listenerCount('data'), 0)
})

test('queue pressure preserves health/models access and rejects HTTP admin without waiting', { timeout: 3000 }, async () => {
  const { request, server, entered } = harness(20)
  const first = request('first')
  const pending = Array.from({ length: 4 }, (_, i) => request(`queued-${i}`))
  const rejected = request('rejected', '/v1/messages')
  const health = request('health', '/health'), models = request('models', '/v1/models'), admin = request('admin', '/admin/stats')
  health.req.method = models.req.method = admin.req.method = 'GET'
  await tick()
  assert.equal(rejected.res.status, 503)
  await Promise.all([rejected.pending, health.pending, models.pending, admin.pending])
  assert.equal(rejected.res.headers['retry-after'], '1')
  assert.equal(JSON.parse(rejected.res.output).type, 'error')
  assert.equal(rejected.req.listenerCount('data'), 0)
  assert.ok([health, models].every(item => item.res.status === 200))
  assert.equal(admin.res.status, 403)
  await Promise.all(pending.map(item => item.pending))
  assert.ok(pending.every(item => item.res.status === 503 && item.res.headers['retry-after'] === '1'))
  assert.deepEqual(entered, ['first'])
  first.res.emit('close'); await first.pending
  assert.equal(server.requestAdmission.state.active, 0)
})

test('live maxConcurrent increases wake FIFO immediately and decreases preserve already active work', async () => {
  const { request, server, entered } = harness()
  const first = request('first'), second = request('second'), third = request('third')
  await tick()
  assert.deepEqual(entered, ['first'])
  server.updateConfig({ maxConcurrent: 2 })
  await tick()
  assert.deepEqual(entered, ['first', 'second'])
  server.updateConfig({ maxConcurrent: 1 })
  first.req.offer('{}', true); await first.pending
  await tick()
  assert.deepEqual(entered, ['first', 'second'])
  assert.equal(server.requestAdmission.state.active, 1)
  second.req.offer('{}', true); await second.pending
  await tick()
  assert.deepEqual(entered, ['first', 'second', 'third'])
  third.req.offer('{}', true); await third.pending
  assert.equal(server.requestAdmission.state.active, 0)
})

test('abort between permit grant and handler entry returns the slot and body-size rejection also releases it', async () => {
  const { request, server, entered } = harness()
  const early = request('early')
  early.res.emit('close')
  await early.pending
  assert.deepEqual(entered, [])
  assert.equal(server.requestAdmission.state.active, 0)
  const large = request('large')
  large.req.headers['content-length'] = String(11 * 1024 * 1024)
  await large.pending
  assert.equal(large.res.status, 413)
  assert.equal(server.requestAdmission.state.active, 0)
  const valid = request('valid')
  valid.req.offer('{}', true)
  await valid.pending
  assert.equal(valid.res.status, 200)
  assert.equal(server.requestAdmission.state.active, 0)
})

test('admission routing limits AI POST work and keeps discovery and administration independent', () => {
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1beta/models/synthetic:generateContent', '/v1/messages/count_tokens']) assert.equal(requiresRequestAdmission('POST', path), true)
  for (const path of ['/health', '/v1/models', '/admin/stats']) assert.equal(requiresRequestAdmission('POST', path), false)
  assert.equal(requiresRequestAdmission('GET', '/v1/chat/completions'), false)
})
