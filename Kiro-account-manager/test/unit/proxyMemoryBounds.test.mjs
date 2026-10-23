import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { RequestAdmission } from '../../src/main/proxy/requestAdmission.ts'

const ts = createRequire(import.meta.url)('typescript')
const tree = file => ts.createSourceFile(file, readFileSync(new URL(`../../src/main/proxy/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const compile = (code, values = {}) => {
  const context = vm.createContext({ console: { log() {}, info() {}, debug() {}, error() {} }, crypto, createHash: crypto.createHash, Buffer, Map, Set, Error, Promise, ...values })
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return context
}

function conversationHarness() {
  const source = tree('kiroApi.ts')
  const functions = ['resolveConversationId', 'cleanupConversationCache', 'clearAllCaches']
  const variables = ['conversationCache', 'CONVERSATION_CACHE_TTL', 'CONVERSATION_CACHE_MAX']
  const code = source.statements.filter(node => (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => variables.includes(item.name.getText(source)))))
    .map(node => node.getText(source).replace(/^export /, '')).join('\n')
  let now = 100000, sequence = 0
  class Clock extends Date { static now() { return now } }
  const context = compile(code, { Date: Clock, uuidv4: () => `synthetic-${++sequence}`, fingerprintFromHistory: () => 'synthetic-history-fingerprint' })
  return { context, setTime(value) { now = value }, keys: () => Array.from(vm.runInContext('conversationCache.keys()', context)) }
}

test('actual conversation resolver enforces hard LRU bounds while preserving recently used session IDs', () => {
  const { context, keys } = conversationHarness()
  const first = context.resolveConversationId([], 'synthetic-first')
  for (let i = 0; i < 999; i++) context.resolveConversationId([], `synthetic-${i}`)
  assert.equal(context.resolveConversationId([], 'synthetic-first'), first)
  context.resolveConversationId([], 'synthetic-new')
  assert.equal(keys().length, 1000)
  assert.equal(context.resolveConversationId([], 'synthetic-first'), first)
  assert.notEqual(context.resolveConversationId([], 'synthetic-0'), 'synthetic-2', 'least recently used entry was evicted')
  for (let i = 0; i < 4000; i++) context.resolveConversationId([], `synthetic-overflow-${i}`)
  assert.equal(keys().length, 1000)
})

test('actual conversation keys hash the complete hint and expiry is checked before a cache hit', () => {
  const { context, keys, setTime } = conversationHarness()
  const prefix = 'Synthetic hint '.repeat(5000)
  const first = context.resolveConversationId([], `${prefix}A`)
  const second = context.resolveConversationId([], `${prefix}B`)
  assert.notEqual(first, second)
  assert.ok(keys().every(key => /^[a-f0-9]{64}$/.test(key)), 'raw large hint must not be a retained key')
  setTime(100000 + 2 * 60 * 60 * 1000)
  assert.notEqual(context.resolveConversationId([], `${prefix}A`), first, 'expired hit must not revive its old conversation')
  setTime(100000 + 4 * 60 * 60 * 1000)
  context.cleanupConversationCache()
  assert.equal(keys().length, 0, 'idle cleanup must remove expired entries without a new insertion')
})

function serverHarness(fetcher = async () => []) {
  const source = tree('proxyServer.ts')
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
  const names = ['clearModelCache', 'modelCacheKey', 'loadModelCatalog', 'cleanupModelCache', 'cleanupExpiredCaches', 'stop', 'handleOpenAIStream', 'pickAccountWithAffinity', 'rememberAffinity']
  const methods = declaration.members.filter(node => names.includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n')
  let now = 100000, conversationCleanups = 0, conversationsCleared = 0, estimateCalls = 0
  class Clock extends Date { static now() { return now } }
  const context = compile(`class Subject { ${methods} };globalThis.Subject=Subject`, {
    Date: Clock, fetchKiroModels: fetcher, filterAvailableModels: models => models, setModelContextWindow() {},
    cleanupConversationCache() { conversationCleanups++ }, clearAllCaches() { conversationsCleared++; return {} },
    proxyLogger: { info() {} }, setTimeout: callback => { callback(); return 1 }, clearInterval() {},
    uuidv4: () => 'synthetic-stream', ToolNameRegistry: class {},
    createOpenaiStreamChunk: (id, model, delta, finishReason, usage) => ({ id, model, delta, finishReason, usage }),
    classifyError: () => 'synthetic', ErrorType: {},
    callKiroApiStream: async (_account, _payload, onChunk, onComplete) => {
      await onChunk('Synthetic first ')
      await onChunk('Synthetic second')
      onComplete({ inputTokens: 10, outputTokens: 4, credits: 1 })
    }
  })
  const server = new context.Subject()
  server.requestAdmission = new RequestAdmission()
  server.modelCache = new Map(); server.modelCacheBytes = 0; server.modelCacheGeneration = 0
  server.MODEL_CACHE_TTL = 300000; server.MODEL_CACHE_MAX = 100; server.MODEL_CACHE_BYTE_LIMIT = 16 * 1024 * 1024
  server.throwIfAborted = () => {}; server.rateLimitBuckets = new Map(); server.sessionAffinity = new Map(); server.auditLog = []
  return { server, context, setTime(value) { now = value }, counters: () => ({ conversationCleanups, conversationsCleared, estimateCalls }) }
}
const account = id => ({ id, accessToken: 'SYNTHETIC_ACCESS', profileArn: 'synthetic-profile', region: 'eu-central-1' })

test('sticky account selection retains fixed-size full-hint hashes and preserves distinct long sessions', () => {
  const { server } = serverHarness()
  const first = account('first')
  const second = account('second')
  server.config = { sessionAffinityEnabled: true }
  server.accountPool = { getAccount: id => id === 'first' ? first : second, isSuspended: () => false }
  const prefix = 'SYNTHETIC_LONG_SESSION_'.repeat(5000)
  server.rememberAffinity(prefix + 'A', first.id)
  server.rememberAffinity(prefix + 'B', second.id)
  assert.equal(server.pickAccountWithAffinity(prefix + 'A'), first)
  assert.equal(server.pickAccountWithAffinity(prefix + 'B'), second)
  assert.ok([...server.sessionAffinity.keys()].every(key => /^[a-f0-9]{64}$/.test(key)))
  first.isAvailable = false
  assert.equal(server.pickAccountWithAffinity(prefix + 'A'), null)
  assert.equal(server.sessionAffinity.size, 1)
})

test('actual catalog cache has a UTF-8 byte budget as well as account scope and count bounds', async () => {
  let fetches = 0
  const { server } = serverHarness(async current => { fetches++; return [{ modelId: current.id, description: '合'.repeat(256 * 1024) }] })
  for (let i = 0; i < 30; i++) await server.loadModelCatalog(account(String(i)))
  assert.ok(server.modelCache.size < 30, '16MiB must evict large directories before 100 entries')
  assert.ok(server.modelCacheBytes <= 16 * 1024 * 1024)
  const hot = account('29')
  assert.equal((await server.loadModelCatalog(hot)).fromCache, true)
  assert.equal((await server.loadModelCatalog({ ...hot, accessToken: 'SYNTHETIC_ROTATED' })).fromCache, false)
  assert.ok(fetches > 30, 'credential rotation must retain account isolation')
  server.clearModelCache()
  assert.equal(server.modelCacheBytes, 0)
})

test('oversize catalog remains available without being retained and timed cleanup frees expired catalogs', async () => {
  const { server, setTime, counters } = serverHarness(async current => [{ modelId: current.id, description: current.id === 'large' ? 'x'.repeat(17 * 1024 * 1024) : 'Synthetic' }])
  assert.equal((await server.loadModelCatalog(account('large'))).models.length, 1)
  assert.equal(server.modelCache.size, 0)
  await server.loadModelCatalog(account('small'))
  assert.equal(server.modelCache.size, 1)
  setTime(400000)
  server.cleanupExpiredCaches()
  assert.equal(server.modelCache.size, 0)
  assert.equal(server.modelCacheBytes, 0)
  assert.equal(counters().conversationCleanups, 1)
})

test('catalog LRU refreshes access order and duplicate in-flight completions do not double-count bytes', async () => {
  const { server } = serverHarness(async current => [{ modelId: current.id }])
  server.MODEL_CACHE_MAX = 3
  for (const id of ['a', 'b', 'c']) await server.loadModelCatalog(account(id))
  await server.loadModelCatalog(account('a'))
  await server.loadModelCatalog(account('d'))
  assert.equal((await server.loadModelCatalog(account('a'))).fromCache, true)
  assert.equal((await server.loadModelCatalog(account('b'))).fromCache, false)

  const releases = []
  const concurrent = serverHarness(() => new Promise(resolve => releases.push(resolve))).server
  const first = concurrent.loadModelCatalog(account('same'))
  const second = concurrent.loadModelCatalog(account('same'))
  releases[0]([{ modelId: 'first' }]); await first
  releases[1]([{ modelId: 'second', description: 'Synthetic expanded metadata' }]); await second
  assert.equal(concurrent.modelCache.size, 1)
  const entry = concurrent.modelCache.values().next().value
  assert.equal(concurrent.modelCacheBytes, entry.bytes)
})

test('clearing or stopping the proxy prevents an already pending catalog from repopulating memory', async () => {
  let release
  const { server, counters } = serverHarness(() => new Promise(resolve => { release = resolve }))
  const pending = server.loadModelCatalog(account('pending'))
  server.clearModelCache()
  release([{ modelId: 'synthetic-result' }])
  assert.equal((await pending).models.length, 1, 'caller still receives its result')
  assert.equal(server.modelCache.size, 0, 'obsolete result must not be retained')
  server.server = { close(callback) { callback() } }; server.fallbackServer = null
  server.activeRequests = new Set(); server.sockets = new Set(); server.events = {}; server.config = {}; server.cleanupTimer = null
  server.modelCache.set('synthetic', { models: [], timestamp: 100000, bytes: 100 })
  server.modelCacheBytes = 100
  await server.stop(0)
  assert.equal(server.modelCache.size, 0)
  assert.equal(server.modelCacheBytes, 0)
  assert.equal(counters().conversationsCleared, 1)
})

test('actual OpenAI stream preserves every chunk and usage without a redundant full-text accumulator', async () => {
  const { server } = serverHarness()
  const writes = []
  const response = new EventEmitter()
  response.writeHead = () => {}; response.write = value => { writes.push(value); return true }; response.end = () => {}
  server.config = {}; server.waitForDrain = () => undefined; server.isAbortError = () => false; server.isResponseClosed = () => false
  server.stats = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  server.accountPool = { recordSuccess() {} }; server.events = {}; server.recordRequestSuccess = () => {}; server.recordRequest = () => {}; server.throwIfResponseClosed = () => {}
  await server.handleOpenAIStream(response, account('synthetic'), {}, 'synthetic-model', Date.now())
  const chunks = writes.filter(value => value.startsWith('data: {')).map(value => JSON.parse(value.slice(6)))
  assert.equal(chunks.map(chunk => chunk.delta?.content || '').join(''), 'Synthetic first Synthetic second')
  assert.equal(chunks.at(-1).usage.completion_tokens, 4)
  assert.equal(writes.at(-1), 'data: [DONE]\n\n')
})
