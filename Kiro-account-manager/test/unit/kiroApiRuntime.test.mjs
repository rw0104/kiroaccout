import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { isRetiredModelId, ModelRequestError } from '../../src/shared/modelCatalog.ts'
import { executeRuntimeRequest } from '../../src/main/proxy/kiroRuntime.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/proxy/kiroApi.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('kiroApi.ts', source, ts.ScriptTarget.Latest, true)
const functions = ['callKiroApiStream', 'callKiroApi', 'isCodeWhispererModelId', 'normalizeClaudeVersion', 'mapModelId']
const modelMap = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(tree) === 'MODEL_ID_MAP')).getText(tree)
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)).map(node => node.getText(tree).replace(/^export /, '')).join('\n')

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function frame(type, data) {
  const headers = Buffer.concat([[':message-type', 'event'], [':event-type', type]].map(([name, value]) => {
    const size = Buffer.alloc(2); size.writeUInt16BE(Buffer.byteLength(value))
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)])
  }))
  const dataBytes = Buffer.from(JSON.stringify(data))
  const start = Buffer.alloc(12)
  start.writeUInt32BE(16 + headers.length + dataBytes.length)
  start.writeUInt32BE(headers.length, 4)
  start.writeUInt32BE(crc32(start.subarray(0, 8)), 8)
  const payload = Buffer.concat([start, headers, dataBytes])
  const end = Buffer.alloc(4); end.writeUInt32BE(crc32(payload))
  return Buffer.concat([payload, end])
}
const account = { id: 'synthetic', accessToken: 'SYNTHETIC_ACCESS', provider: 'Enterprise', authMethod: 'IdC', region: 'eu-central-1', profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/synthetic' }
const payload = { conversationState: { conversationId: 'synthetic-session', chatTriggerType: 'MANUAL', currentMessage: { userInputMessage: { content: 'Synthetic input', modelId: 'synthetic-model', origin: 'AI_EDITOR' } } } }
function harness(fetcher) {
  const context = vm.createContext({ executeRuntimeRequest, fetchWithProxy: fetcher, configuredAgentMode: 'spec', logStreamEvents: false,
    countTokens: () => 1, isRetiredModelId, ModelRequestError, console })
  vm.runInContext(ts.transpileModule(modelMap + '\n' + declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context
}

test('real streaming call routes all old preferences to one account-region Runtime request', async () => {
  const calls = []
  const api = harness(async (url, init, acc) => {
    calls.push({ url, init, acc })
    return new Response(frame('assistantResponseEvent', { content: 'Synthetic reply' }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  })
  for (const preference of [undefined, 'runtime', 'codewhisperer', 'amazonq', 'amazonq-cli']) {
    let complete = 0, error = 0
    const chunks = []
    await api.callKiroApiStream(account, payload, text => chunks.push(text), () => complete++, () => error++, undefined, preference)
    assert.equal(complete, 1)
    assert.equal(error, 0)
    assert.deepEqual(chunks, ['Synthetic reply'])
  }
  assert.equal(calls.length, 5)
  for (const call of calls) {
    assert.equal(call.url, 'https://runtime.eu-central-1.kiro.dev/')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers['x-amz-target'], 'KiroRuntimeService.GenerateAssistantResponse')
    assert.equal(call.init.headers.TokenType, 'SSO_OIDC')
    assert.equal(JSON.parse(call.init.body).agentMode, 'spec')
    assert.equal(call.acc, account, 'bound account proxy remains available to the actual transport')
  }
})

test('real wrapper never replays after partial text followed by an upstream error', async () => {
  let calls = 0, completed = 0
  const chunks = [], errors = []
  const api = harness(async () => {
    calls++
    return new Response(Buffer.concat([frame('assistantResponseEvent', { content: 'Partial' }), frame('validationError', { message: 'SYNTHETIC_PRIVATE' })]))
  })
  await api.callKiroApiStream(account, payload, text => chunks.push(text), () => completed++, error => errors.push(error))
  assert.equal(calls, 1)
  assert.equal(completed, 0)
  assert.deepEqual(chunks, ['Partial'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].outputStarted, true)
  assert.equal(errors[0].retryable, false)
  assert.doesNotMatch(errors[0].message, /SYNTHETIC_PRIVATE/)
})

test('nonstream call uses actual Runtime reasoning and usage callbacks', async () => {
  const api = harness(async () => new Response(Buffer.concat([
    frame('reasoningContentEvent', { text: 'Synthetic reasoning', signature: 'synthetic-signature' }),
    frame('assistantResponseEvent', { content: 'Synthetic reply' }),
    frame('metadataEvent', { tokenUsage: { uncachedInputTokens: 3, outputTokens: 2 } })
  ])))
  const result = await api.callKiroApi(account, payload)
  assert.equal(result.content, 'Synthetic reply')
  assert.equal(result.reasoningContent.text, 'Synthetic reasoning')
  assert.equal(result.reasoningContent.signature, 'synthetic-signature')
  assert.equal(result.usage.inputTokens, 3)
  assert.equal(result.usage.outputTokens, 2)
})

test('new model identifiers never silently fall back to an unrelated Claude model', () => {
  const api = harness(async () => { throw new Error('Not called') })
  assert.equal(api.mapModelId('kimi-k3'), 'kimi-k3')
  assert.equal(api.mapModelId('future.synthetic-model-v2'), 'future.synthetic-model-v2')
  assert.equal(api.mapModelId(''), 'auto')
  assert.equal(api.mapModelId('gpt-4o'), 'gpt-4o')
  assert.equal(api.mapModelId('claude-3-sonnet'), 'claude-3-sonnet')
  for (const retired of ['claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4.0', 'claude-sonnet-4-20250514', 'CLAUDE_SONNET_4_20250514_V1_0']) assert.throws(() => api.mapModelId(retired), /retired/)
  assert.throws(() => api.mapModelId('invalid\nmodel'), /Invalid model identifier/)
})
