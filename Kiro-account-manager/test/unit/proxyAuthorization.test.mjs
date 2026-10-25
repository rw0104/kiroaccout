import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { RequestAdmission, RequestAdmissionError, requiresRequestAdmission } from '../../src/main/proxy/requestAdmission.ts'

const ts = createRequire(import.meta.url)('typescript')
const poolContext = vm.createContext({ exports: {}, console: { log() {}, warn() {} } })
vm.runInContext(ts.transpileModule(readFileSync(new URL('../../src/main/proxy/accountPool.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, poolContext)
const { AccountPool } = poolContext.exports
const source = ts.createSourceFile('server.ts', readFileSync(new URL('../../src/main/proxy/proxyServer.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
const names = ['handleRequest', 'handleAdminApi', 'validateApiKey', 'safeStringEq', 'getAllowedAccountIds',
  'isAccountAllowed', 'getScopedNextAccount', 'getAvailableAccount', 'callWithRetry', 'getAvailableModels',
  'handleModels', 'handleGeminiModels', 'handleGeminiRequest', 'handleOpenAIChat', 'handleOpenAIResponses',
  'handleClaudeMessages', 'recordApiKeyUsage', 'getAbortError', 'throwIfAborted', 'isAbortError', 'isResponseClosed',
  'throwIfResponseClosed', 'abortable', 'extractSessionHint', 'pickAccountWithAffinity', 'rememberAffinity', 'isAnthropicPath']
const members = declaration.members.filter(node => names.includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n')
const compiled = ts.transpileModule(`class Subject { ${members} }; globalThis.Subject=Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function harness(config = {}, options = {}) {
  const calls = [], catalogCalls = [], persisted = [], responseEvents = [], creditsEvents = [], tokenEvents = []
  const usage = { inputTokens: 11, outputTokens: 7, credits: 15 }
  const context = vm.createContext({ Buffer, crypto, AbortController, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, RequestAdmissionError, requiresRequestAdmission,
    proxyLogger: { debug() {}, info() {}, warn() {} }, ErrorType: { RECOVERABLE: 'recoverable' },
    BodyTooLargeError: class extends Error {}, ProxyServer: { extractSessionHint: () => undefined },
    ToolNameRegistry: class {}, openaiToKiro: request => request, claudeToKiro: request => request,
    responsesToOpenAIChat: request => ({ ...request, messages: [{ role: 'user', content: request.input }] }),
    kiroToOpenaiResponse: content => ({ content }), kiroToClaudeResponse: content => ({ content, usage: {} }),
    openAIChatToResponsesResponse: () => ({ output: [] }), uuidv4: () => 'synthetic-response',
    filterAvailableModels: models => models, toAccountModel: model => model, buildClientModel: model => model,
    promptCacheTracker: { buildClaudeProfile: () => undefined, compute: () => ({}), update() {} },
    callKiroApi: async account => {
      calls.push(account.id)
      if (options.inference) return options.inference(account, calls.length, usage)
      return { content: 'Synthetic reply', usage }
    },
    callKiroApiStream: async (account, _payload, onChunk, onComplete, onError, signal) => {
      calls.push(account.id)
      if (options.stream) return options.stream({ onChunk, onComplete, onError, signal, usage })
      await onChunk('Synthetic reply')
      onComplete(usage)
      if (options.duplicateCompletion) onComplete(usage)
    }
  })
  vm.runInContext(compiled, context)
  const server = new context.Subject()
  const key = { id: 'key-a', key: 'SYNTHETIC_KEY_A', enabled: true, creditsLimit: 100, usage: { totalRequests: 0, totalCredits: 0, totalInputTokens: 0, totalOutputTokens: 0, daily: {} } }
  server.config = { enableMultiAccount: true, apiKeys: [key], apiKeyAccountBindings: { 'key-a': ['A'] }, maxRetries: 4, retryDelayMs: 1, ...config }
  server.accountPool = new AccountPool()
  for (const account of options.accounts || [{ id: 'A', groupId: 'one' }, { id: 'B', groupId: 'two' }]) {
    server.accountPool.addAccount({ accessToken: 'SYNTHETIC_ACCESS', profileArn: 'synthetic-profile', expiresAt: Date.now() + 600000, ...account })
  }
  server.events = { onConfigChanged: value => persisted.push(value), onResponse: value => responseEvents.push(value), onCreditsUpdate: value => creditsEvents.push(value), onTokensUpdate: (...value) => tokenEvents.push(value) }
  server.activeRequests = new Set(); server.sessionAffinity = new Map(); server.requestAdmission = new RequestAdmission({ maxConcurrent: 2 })
  server.stats = { totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCredits: 0 }
  server.getClientIP = () => '127.0.0.1'; server.setCorsHeaders = () => {}; server.isClientIPAllowed = () => ({ allowed: true })
  server.checkRateLimit = () => ({ allowed: true }); server.appendAuditLog = () => {}; server.syncKProxyDeviceId = () => {}
  server.isTokenExpiringSoon = account => !!account.expired
  server.refreshToken = async account => { server.accountPool.markNeedsRefresh(account.id); return false }
  server.detectSuspendedError = message => message.includes('SUSPENDED') ? { reason: 'SUSPENDED' } : undefined
  server.triggerWebhook = () => {}; server.waitForRetry = async () => {}
  server.sanitizeErrorMessage = value => value
  server.readBody = async req => JSON.stringify(req.body)
  server.prepareOpenAIRequest = value => value; server.prepareClaudeRequest = value => value
  server.resolveOpenAIHttpImages = async value => value; server.resolveClaudeHttpImages = async value => value
  server.getThinkingConfig = async () => undefined; server.applyModelMapping = value => value
  server.loadModelCatalog = async account => { catalogCalls.push(account.id); return { models: [{ id: account.id }], fromCache: false } }
  server.recordNewRequest = () => {}; server.recordRequestSuccess = () => {}; server.recordRequestFailed = () => {}; server.recordRequest = () => {}
  server.waitForDrain = async () => {}
  server.sendError = (res, status, message) => { res.writeHead(status); res.end(JSON.stringify({ error: message })) }
  server.handleApiError = (res, _account, error) => server.sendError(res, 502, error.message)
  server.handleOpenAIStream = server.handleClaudeStream = async (res, account) => { calls.push(account.id); res.writeHead(200); res.end('stream') }
  async function request(url, body = {}, { method = 'POST', headers = { authorization: 'Bearer SYNTHETIC_KEY_A' } } = {}) {
    const req = Object.assign(new EventEmitter(), { url, method, headers, body, socket: { remoteAddress: '127.0.0.1' }, pause() {} })
    const res = Object.assign(new EventEmitter(), { status: 0, output: '', writableEnded: false, destroyed: false,
      setHeader() {}, writeHead(status) { this.status = status }, write(value) { this.output += value; return true }, end(value = '') { this.output += value; this.writableEnded = true } })
    await server.handleRequest(req, res)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
    assert.equal(server.activeRequests.size, 0)
    assert.equal(server.requestAdmission.state.active, 0)
    return res
  }
  return { server, key, calls, catalogCalls, persisted, responseEvents, creditsEvents, tokenEvents, request }
}

const inferenceRoutes = [
  ['/v1/chat/completions', { model: 'synthetic-model', messages: [{ role: 'user', content: 'Hello' }] }],
  ['/v1/responses', { model: 'synthetic-model', input: 'Hello' }],
  ['/v1/messages', { model: 'synthetic-model', messages: [{ role: 'user', content: 'Hello' }] }],
  ['/v1beta/models/synthetic-model:generateContent', { contents: [{ parts: [{ text: 'Hello' }] }] }]
]

test('real HTTP inference handlers cannot use a selected single account outside the Key scope', async () => {
  for (const [route, body] of inferenceRoutes) {
    const h = harness({ enableMultiAccount: false, selectedAccountIds: ['B'] })
    const res = await h.request(route, body)
    assert.equal(res.status, 503, route)
    assert.deepEqual(h.calls, [], route)
  }
})

test('real HTTP inference handlers use only allowed accounts and meter successful nonstream requests once', async () => {
  for (const [route, body] of inferenceRoutes) {
    const h = harness({}, { accounts: [{ id: 'B' }, { id: 'A' }] })
    const res = await h.request(route, body)
    assert.equal(res.status, 200, `${route}: ${res.output}`)
    assert.deepEqual(h.calls, ['A'], route)
    assert.equal(h.key.usage.totalRequests, 1, route)
    assert.equal(h.key.usage.totalCredits, 15, route)
    assert.equal(h.persisted.length, 1, route)
  }
})

test('model catalogs obey Key scope including refresh failure and ownership changes during refresh', async () => {
  for (const route of ['/v1/models', '/models', '/v1beta/models']) {
    const h = harness({}, { accounts: [{ id: 'B' }, { id: 'A' }] })
    assert.equal((await h.request(route, {}, { method: 'GET' })).status, 200)
    assert.deepEqual(h.catalogCalls, ['A'], route)
    const expired = harness({}, { accounts: [{ id: 'A', expired: true }, { id: 'B' }] })
    await expired.request(route, {}, { method: 'GET' })
    assert.deepEqual(expired.catalogCalls, [], route)
    const revoked = harness({}, { accounts: [{ id: 'A', expired: true }, { id: 'B' }] })
    revoked.server.refreshToken = async () => { revoked.server.config.apiKeyAccountBindings['key-a'] = ['B']; return true }
    await revoked.request(route, {}, { method: 'GET' })
    assert.ok(!revoked.catalogCalls.includes('A'), route)
  }
})

test('refresh fallback, session affinity, selected quota switch and configured groups intersect Key scope', async () => {
  const expired = harness({}, { accounts: [{ id: 'A', expired: true }, { id: 'B' }] })
  assert.equal(await expired.server.getAvailableAccount(undefined, undefined, 'key-a'), null)
  const sticky = harness({ sessionAffinityEnabled: true })
  sticky.server.rememberAffinity('synthetic-session', 'B')
  assert.equal((await sticky.server.getAvailableAccount(undefined, 'synthetic-session', 'key-a')).id, 'A')
  const exhausted = harness({ enableMultiAccount: false, selectedAccountIds: ['A'], autoSwitchOnQuotaExhausted: true }, { accounts: [{ id: 'A', quotaLimit: 1, quotaUsed: 1 }, { id: 'B' }] })
  assert.equal(await exhausted.server.getAvailableAccount(undefined, undefined, 'key-a'), null)
  for (const multiAccountGroupIds of [[], ['two']]) {
    const groups = harness({ multiAccountSelectionMode: 'groups', multiAccountGroupIds })
    assert.equal(await groups.server.getAvailableAccount(undefined, undefined, 'key-a'), null)
  }
  const legacyGroups = harness({ apiKeyAccountBindings: {}, apiKeyGroupBindings: { 'key-a': ['two'] } })
  assert.equal((await legacyGroups.server.getAvailableAccount(undefined, undefined, 'key-a')).id, 'B')
  for (const binding of [{}, { 'key-a': [] }]) {
    const unrestricted = harness({ apiKeyAccountBindings: binding }, { accounts: [{ id: 'B' }] })
    assert.equal((await unrestricted.server.getAvailableAccount(undefined, undefined, 'key-a')).id, 'B')
  }
})

test('all actual retry callers retain Key scope for auth, quota, suspension and server failures', async () => {
  for (const [route, body] of inferenceRoutes.slice(0, 3)) {
    for (const message of ['401 Auth', '429 quota', '503 unavailable', '403 SUSPENDED']) {
      const h = harness({}, { inference: async () => { throw new Error(message) } })
      const res = await h.request(route, body)
      assert.equal(res.status, 502, `${route}: ${message}: ${res.output}`)
      assert.ok(h.calls.length > 0 && h.calls.every(id => id === 'A'), `${route}: ${message}: ${h.calls}`)
    }
  }
})

test('allowed fallback candidates still work and refresh every expiring candidate before inference', async () => {
  for (const message of ['401 Auth', '429 quota', '503 unavailable', '403 SUSPENDED']) {
    const h = harness({ apiKeyAccountBindings: { 'key-a': ['A', 'C', 'D'] } }, {
      accounts: [{ id: 'A' }, { id: 'B' }, { id: 'C', expired: true }, { id: 'D', expired: true }],
      inference: async (account, _count, usage) => {
        if (account.id === 'A') throw new Error(message)
        return { content: 'Synthetic retry success', usage }
      }
    })
    const refreshed = []
    h.server.refreshToken = async account => {
      refreshed.push(account.id)
      if (account.id !== 'D') { h.server.accountPool.markNeedsRefresh(account.id); return false }
      h.server.accountPool.updateAccount(account.id, { expired: false })
      return true
    }
    const res = await h.request(inferenceRoutes[0][0], inferenceRoutes[0][1])
    assert.equal(res.status, 200, `${message}: ${res.output}`)
    assert.ok(h.calls.every(id => ['A', 'D'].includes(id)), h.calls.join(','))
    assert.equal(h.calls.at(-1), 'D')
    assert.ok(refreshed.includes('C') && refreshed.includes('D'))
    assert.equal(h.key.usage.totalRequests, 1)
  }
})

test('stream entrypoints and Responses stream retry preserve account scope', async () => {
  for (const [route, body] of inferenceRoutes.slice(0, 3)) {
    const h = harness({}, { accounts: [{ id: 'B' }, { id: 'A' }] })
    assert.equal((await h.request(route, { ...body, stream: true })).status, 200)
    assert.deepEqual(h.calls, ['A'])
  }
  const h = harness({}, { inference: async () => { throw new Error('401 Auth') } })
  await h.request('/v1/responses', { ...inferenceRoutes[1][1], stream: true })
  assert.deepEqual(h.calls, ['A'])
})

test('Key removal during refresh cannot change the request into an unrestricted request', async () => {
  const h = harness({}, { accounts: [{ id: 'A', expired: true }, { id: 'B' }] })
  h.server.refreshToken = async () => { h.server.config.apiKeys = []; h.server.config.apiKeyAccountBindings = {}; return true }
  assert.equal(await h.server.getAvailableAccount(undefined, undefined, 'key-a'), null)
})

test('retry rechecks the latest group membership after asynchronous backoff', async () => {
  const h = harness({ multiAccountSelectionMode: 'groups', multiAccountGroupIds: ['one'] }, {
    inference: async () => { throw new Error('503 unavailable') }
  })
  h.server.waitForRetry = async () => h.server.accountPool.updateAccount('A', { groupId: 'two' })
  await h.request(inferenceRoutes[0][0], inferenceRoutes[0][1])
  assert.deepEqual(h.calls, ['A'])
})

test('Gemini stream success persists tokens, credits and one request, then its quota blocks the next call', async () => {
  const h = harness({}, { accounts: [{ id: 'B' }, { id: 'A' }], duplicateCompletion: true })
  h.key.creditsLimit = 10
  const route = '/v1beta/models/synthetic-model:streamGenerateContent'
  assert.equal((await h.request(route, { contents: [{ parts: [{ text: 'Hi' }] }] })).status, 200)
  assert.deepEqual(h.calls, ['A'])
  assert.deepEqual([h.key.usage.totalRequests, h.key.usage.totalCredits, h.key.usage.totalInputTokens, h.key.usage.totalOutputTokens], [1, 15, 11, 7])
  assert.equal(h.persisted.length, 1)
  assert.equal(h.responseEvents.length, 1)
  assert.equal(h.creditsEvents.length, 1)
  assert.equal(h.tokenEvents.length, 1)
  assert.equal((await h.request(route)).status, 429)
  assert.deepEqual(h.calls, ['A'])
})

test('Gemini cancelled or failed streams do not commit a successful Key usage record', async () => {
  for (const stream of [async ({ onError }) => onError(new Error('Synthetic failure')), async ({ onComplete, signal, usage }) => {
    // Abort the actual request controller before upstream completion.
    const controller = [...current.server.activeRequests][0]
    controller.abort(new Error('Synthetic cancellation'))
    assert.equal(signal.aborted, true)
    onComplete(usage)
  }]) {
    var current = harness({}, { stream })
    await current.request('/v1beta/models/synthetic-model:streamGenerateContent')
    assert.equal(current.key.usage.totalRequests, 0)
    assert.equal(current.persisted.length, 0)
  }
})

test('all HTTP admin paths reject ordinary, legacy and absent keys without reading a body or mutating state', async () => {
  for (const config of [{}, { apiKeys: [], apiKey: 'SYNTHETIC_KEY_A' }, { apiKeys: [] }]) {
    for (const path of ['/admin/accounts', '/admin/config', '/admin/stats', '/admin/logs', '/admin/audit', '/admin/cache/clear', '/admin/unknown']) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const h = harness(config)
        h.server.readBody = () => { throw new Error('HTTP admin must not read its body') }
        const res = await h.request(path, { rateLimitPerKeyPerMinute: 0 }, { method })
        assert.equal(res.status, 403, `${path} ${method}: ${res.output}`)
        assert.equal(h.persisted.length, 0)
      }
    }
  }
})

test('large forbidden pools stop after a bounded scoped scan and cancellation prevents any selection', async () => {
  const h = harness({}, { accounts: Array.from({ length: 1000 }, (_, i) => ({ id: `forbidden-${i}` })) })
  let selections = 0
  const original = h.server.accountPool.getNextAccount.bind(h.server.accountPool)
  h.server.accountPool.getNextAccount = (...args) => { selections++; return original(...args) }
  assert.equal(await h.server.getAvailableAccount(undefined, undefined, 'key-a'), null)
  assert.ok(selections <= 2)
  const controller = new AbortController(); controller.abort(new Error('Synthetic cancellation'))
  await assert.rejects(h.server.getAvailableAccount(controller.signal, undefined, 'key-a'))
  assert.ok(selections <= 2)
})
