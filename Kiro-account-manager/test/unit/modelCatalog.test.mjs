import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { requestControlPlane } from '../../src/main/kiroControlPlane.ts'
import { extractThinkingSchema, filterAvailableModels, modelUnavailableReason, toAccountModel, ModelRequestError } from '../../src/shared/modelCatalog.ts'

const ts = createRequire(import.meta.url)('typescript')
const clean = value => JSON.parse(JSON.stringify(value))
const sourceTree = path => {
  const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
}
function execute(code, context) {
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
}
const account = { id: 'SYNTHETIC_ACCOUNT', accessToken: 'SYNTHETIC_ACCESS', provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1', profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC_PROFILE' }
const model = (modelId, extra = {}) => ({ modelId, modelName: modelId, description: 'Synthetic model', ...extra })
const reasoningSchema = { properties: { reasoning: { properties: { effort: { enum: ['low', 'medium', 'high'], default: 'medium' } } } } }
const adaptiveSchema = { properties: {
  output_config: { properties: { effort: { enum: ['low', 'high', 'max'], default: 'high' } } },
  thinking: { properties: { type: { enum: ['disabled', 'adaptive'], default: 'adaptive' }, display: { enum: ['summarized', 'omitted'] } } }
} }

function apiHarness(fetcher) {
  const tree = sourceTree('main/proxy/kiroApi.ts')
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fetchKiroModels')
  const context = vm.createContext({ requestControlPlane, fetchWithProxy: fetcher, resolveProfileArn: a => a.profileArn,
    isPlaceholderProfileArn: arn => arn === 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX', ModelRequestError, Error, Set,
    throwIfAborted: signal => { if (signal?.aborted) throw signal.reason }, console })
  execute(declaration.getText(tree).replace(/^export /, ''), context)
  return context
}

test('actual ListAvailableModels paginates the verified control-plane RPC and preserves metadata', async () => {
  const calls = []
  const raw = model('synthetic-reasoning', { modelProvider: 'Synthetic', status: 'EXPERIMENTAL', availableOrigins: ['AI_EDITOR'], additionalModelRequestFieldsSchema: reasoningSchema,
    promptCaching: { supportsPromptCaching: true, maximumCacheCheckpointsPerRequest: 4, minimumTokensPerCacheCheckpoint: 64 } })
  const api = apiHarness(async (url, init) => {
    calls.push({ url, init })
    return Response.json(calls.length === 1 ? { models: [raw], nextToken: 'SYNTHETIC_PAGE_2' } : { models: [model('synthetic-second')] })
  })
  const models = await api.fetchKiroModels(account)
  assert.equal(models.length, 2)
  assert.deepEqual(clean(models[0]), raw)
  for (const { url, init } of calls) {
    assert.equal(url, 'https://management.eu-central-1.kiro.dev/')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/x-amz-json-1.0')
    assert.equal(init.headers['x-amz-target'], 'KiroControlPlaneBearerService.ListAvailableModels')
    assert.equal(init.headers.TokenType, 'SSO_OIDC')
    assert.equal(init.redirect, 'error')
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { origin: 'AI_EDITOR', profileArn: account.profileArn })
  assert.equal(JSON.parse(calls[1].init.body).nextToken, 'SYNTHETIC_PAGE_2')
  const mapped = toAccountModel(models[0])
  assert.equal(mapped.supportsThinking, true)
  assert.equal(mapped.thinkingSchemaPath, 'reasoning')
  assert.deepEqual(mapped.thinkingEfforts, ['low', 'medium', 'high'])
  assert.equal(mapped.defaultThinkingEffort, 'medium')
  for (const field of ['modelProvider', 'status', 'availableOrigins', 'promptCaching', 'additionalModelRequestFieldsSchema']) assert.deepEqual(mapped[field], raw[field])
})

test('catalog failures, malformed models and repeated pagination never become partial success', async () => {
  for (const second of [() => new Response('SYNTHETIC_PRIVATE', { status: 403 }), () => Response.json({ models: [], nextToken: 'SYNTHETIC_CURSOR' }), () => Response.json({ models: 'invalid' })]) {
    let calls = 0
    const api = apiHarness(async () => ++calls === 1 ? Response.json({ models: [model('synthetic-first')], nextToken: 'SYNTHETIC_CURSOR' }) : second())
    await assert.rejects(api.fetchKiroModels(account), error => !error.message.includes('SYNTHETIC_PRIVATE'))
    assert.equal(calls, 2)
  }
  let requests = 0
  const api = apiHarness(async () => { requests++; return Response.json({ models: [] }) })
  const controller = new AbortController(); controller.abort(new Error('Synthetic cancellation'))
  await assert.rejects(api.fetchKiroModels(account, controller.signal), /Synthetic cancellation/)
  assert.equal(requests, 0)
  await assert.rejects(api.fetchKiroModels({ ...account, profileArn: undefined }), /profile is required/)
  await assert.rejects(api.fetchKiroModels({ ...account, profileArn: 'arn:aws:codewhisperer:us-east-1:610548660232:profile/VNECVYCYYAWN' }), /profile is required/)
  assert.equal(requests, 0)
})

test('EU Social and Builder identities without a real profile retain their Region and send no synthetic profile', async () => {
  const calls = []
  const api = apiHarness(async (url, init) => { calls.push({ url, init }); return Response.json({ models: [] }) })
  for (const identity of [
    { provider: 'Google', authMethod: 'social', profileArn: undefined },
    { provider: 'BuilderId', authMethod: 'IdC', profileArn: undefined },
    { provider: 'BuilderId', authMethod: 'IdC', profileArn: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX' }
  ]) await api.fetchKiroModels({ ...account, ...identity, region: 'eu-central-1' })
  assert.equal(calls.length, 3)
  for (const { url, init } of calls) {
    assert.equal(url, 'https://management.eu-central-1.kiro.dev/')
    assert.deepEqual(JSON.parse(init.body), { origin: 'AI_EDITOR' })
  }
})

test('only explicitly unavailable, retired, or wrong-origin records are filtered; new experimental IDs are preserved', () => {
  const models = [model('synthetic-new'), model('synthetic-experimental', { status: 'EXPERIMENTAL', availableOrigins: ['AI_EDITOR'] }),
    model('claude-sonnet-4'), model('synthetic-eol', { status: 'END_OF_LIFE' }), model('synthetic-disabled', { status: 'DISABLED' }),
    model('synthetic-cli', { availableOrigins: ['CLI'] }), model('synthetic-no-origin', { availableOrigins: [] }), model('synthetic-new')]
  assert.deepEqual(filterAvailableModels(models).map(item => item.modelId), ['synthetic-new', 'synthetic-experimental'])
  assert.equal(modelUnavailableReason(model('synthetic-new-model-v3')), undefined)
})

function serverHarness(fetcher) {
  const tree = sourceTree('main/proxy/proxyServer.ts')
  const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
  const names = ['clearModelCache', 'cleanupModelCache', 'modelCacheKey', 'loadModelCatalog', 'getThinkingConfig', 'getAvailableModels', 'handleModels', 'handleApiError']
  const members = declaration.members.filter(node => names.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n')
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node)).map(node => node.getText(tree)).join('\n')
  const context = vm.createContext({ crypto, Buffer, extractThinkingSchema, filterAvailableModels, modelUnavailableReason, toAccountModel, ModelRequestError,
    mapModelId: id => id, fetchKiroModels: fetcher, setModelContextWindow() {}, classifyError: () => 'other', console, Map, Set, Error })
  execute(`${functions}\nclass Subject { ${members} }; globalThis.Subject=Subject`, context)
  const server = new context.Subject()
  server.modelCache = new Map(); server.MODEL_CACHE_TTL = 300000
  server.modelCacheBytes = 0; server.modelCacheGeneration = 0; server.MODEL_CACHE_MAX = 100; server.MODEL_CACHE_BYTE_LIMIT = 16 * 1024 * 1024
  server.throwIfAborted = () => {}; server.throwIfResponseClosed = () => {}; server.isAbortError = () => false
  server.isResponseClosed = () => false; server.isAnthropicPath = () => false
  server.recordRequestFailed = () => {}; server.recordRequest = () => {}; server.events = {}
  server.getAvailableAccount = async () => account
  return { server, context }
}

test('actual model catalog cache is account, credential and profile scoped; successful empty results stay empty', async () => {
  const calls = []
  const { server } = serverHarness(async current => { calls.push(current.id); return current.id === account.id ? [model('synthetic-account-one', { additionalModelRequestFieldsSchema: reasoningSchema })] : [] })
  const first = await server.getAvailableModels()
  assert.deepEqual(clean(first.models.map(item => item.id)), ['synthetic-account-one'])
  assert.equal((await server.getAvailableModels()).fromCache, true)
  const other = { ...account, id: 'SYNTHETIC_SECOND' }
  server.getAvailableAccount = async () => other
  assert.deepEqual(clean((await server.getAvailableModels()).models), [])
  assert.equal((await server.getAvailableModels()).fromCache, true)
  assert.equal(await server.getThinkingConfig('synthetic-account-one', other), undefined)
  server.getAvailableAccount = async () => ({ ...account, accessToken: 'SYNTHETIC_ROTATED_ACCESS' })
  assert.equal((await server.getAvailableModels()).fromCache, false)
  assert.equal(calls.length, 3)
  server.clearModelCache()
  assert.equal(server.modelCache.size, 0)
})

test('actual /v1/models sends a failure instead of fabricating models; local model validation does not penalize the account', async () => {
  const { server } = serverHarness(async () => { throw new Error('Synthetic unavailable catalog') })
  let failure
  server.sendError = (_res, status, message) => { failure = { status, message } }
  await server.handleModels({})
  assert.equal(failure.status, 502)
  assert.match(failure.message, /unavailable catalog/)
  let accountErrors = 0
  server.accountPool = { recordError() { accountErrors++ } }
  server.handleApiError({ headersSent: false }, account, new ModelRequestError('Unsupported reasoning effort'), '/v1/messages')
  assert.equal(failure.status, 400)
  assert.equal(accountErrors, 0)
})

test('actual /v1/models advertises only the current catalog with reasoning, caching and lifecycle metadata', async () => {
  const { server } = serverHarness(async () => [model('synthetic-reasoning', { status: 'EXPERIMENTAL', modelProvider: 'Synthetic', availableOrigins: ['AI_EDITOR'],
    additionalModelRequestFieldsSchema: reasoningSchema, promptCaching: { supportsPromptCaching: true } }), model('synthetic-retired', { status: 'EOL' }), model('synthetic-cli-only', { availableOrigins: ['CLI'] })])
  let output, status
  await server.handleModels({ writeHead(value) { status = value }, end(value) { output = JSON.parse(value) } })
  assert.equal(status, 200)
  assert.deepEqual(output.data.map(item => item.id), ['synthetic-reasoning'])
  assert.equal(output.data[0].reasoning, true)
  assert.equal(output.data[0].supportsThinking, true)
  assert.equal(output.data[0].thinkingSchemaPath, 'reasoning')
  assert.equal(output.data[0].modelProvider, 'Synthetic')
  assert.equal(output.data[0].status, 'EXPERIMENTAL')
  assert.equal(output.data[0].supportsPromptCaching, true)
  assert.deepEqual(output.data[0].availableOrigins, ['AI_EDITOR'])
})

function translatorHarness() {
  const tree = sourceTree('main/proxy/translator.ts')
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node)).map(node => node.getText(tree).replace(/^export /, '')).join('\n')
  const context = vm.createContext({ ModelRequestError, uuidv4: () => 'synthetic', KIRO_CACHE_POINT: { type: 'default' },
    mapModelId: id => id,
    buildKiroPayload: (...args) => ({ additionalModelRequestFields: args[10] }),
    ToolNameRegistry: class { resolve(name) { return name } }, console })
  execute(functions, context)
  return context
}

test('actual request translators use reasoning/output_config schema consistently without invented adaptive thinking', () => {
  const translator = translatorHarness()
  const reasoning = extractThinkingSchema(reasoningSchema)
  assert.deepEqual(clean(translator.buildThinkingFields(reasoning, undefined, 'medium')), { reasoning: { effort: 'medium' } })
  assert.deepEqual(clean(translator.buildThinkingFields(extractThinkingSchema(adaptiveSchema), { type: 'adaptive', display: 'summarized' }, 'high')),
    { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
  const effortOnly = extractThinkingSchema({ properties: { output_config: adaptiveSchema.properties.output_config } })
  assert.deepEqual(clean(translator.buildThinkingFields(effortOnly, undefined, 'high')), { output_config: { effort: 'high' } })
  assert.throws(() => translator.buildThinkingFields(reasoning, undefined, 'unsupported'), /Unsupported reasoning effort/)
  assert.throws(() => translator.buildThinkingFields(reasoning, undefined, 42), /non-empty string/)
  assert.throws(() => translator.buildThinkingFields(undefined, undefined, 'high'), /capability is unavailable/)
  const responses = translator.responsesToOpenAIChat({ model: 'synthetic', input: 'Synthetic input', reasoning: { effort: 'medium' } })
  assert.equal(responses.reasoning_effort, 'medium')
  const openai = translator.openaiToKiro(responses, undefined, undefined, reasoning)
  assert.deepEqual(clean(openai.additionalModelRequestFields), { reasoning: { effort: 'medium' } })
  const claude = translator.claudeToKiro({ model: 'synthetic', messages: [{ role: 'user', content: 'Synthetic input' }], max_tokens: 100,
    output_config: { effort: 'high' } }, undefined, undefined, effortOnly)
  assert.deepEqual(clean(claude.additionalModelRequestFields), { output_config: { effort: 'high' } })
})
