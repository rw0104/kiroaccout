import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRuntimeRequest, executeRuntimeRequest } from '../../src/main/proxy/kiroRuntime.ts'

const account = (over = {}) => ({ id: 'synthetic', email: 'synthetic@example.invalid', accessToken: 'FAKE_ACCESS', authMethod: 'IdC', provider: 'Enterprise', region: 'eu-west-1', ...over })
const payload = () => ({ conversationState: { conversationId: 'synthetic-conversation', chatTriggerType: 'MANUAL', currentMessage: { userInputMessage: { content: 'Synthetic input', modelId: 'synthetic-model', origin: 'AI_EDITOR' } } }, inferenceConfig: { maxTokens: 7 }, additionalModelRequestFields: { thinking: { type: 'disabled' } } })
const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
const frame = (type, value, messageType = 'event') => {
  const entries = [[':message-type', messageType], [messageType === 'exception' ? ':exception-type' : ':event-type', type]]
  const headers = Buffer.concat(entries.map(([name, value]) => {
    const key = Buffer.from(name)
    const text = Buffer.from(value)
    const size = Buffer.alloc(2)
    size.writeUInt16BE(text.length)
    return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([7]), size, text])
  }))
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(16 + headers.length + body.length, 0)
  prelude.writeUInt32BE(headers.length, 4)
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
  const withoutCrc = Buffer.concat([prelude, headers, body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(withoutCrc))
  return Buffer.concat([withoutCrc, crc])
}
const streamOf = (chunks) => new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close() } })
const run = async (body, over = {}) => {
  const chunks = [], errors = [], completions = [], calls = []
  await executeRuntimeRequest({ account: account(), payload: payload(), fetcher: async (url, options) => { calls.push({ url, options }); return new Response(body, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } }) }, onChunk: (...args) => { chunks.push(args) }, onComplete: usage => completions.push(usage), onError: error => errors.push(error), ...over })
  return { chunks, errors, completions, calls }
}

test('actual current SDK wire uses Runtime JSON-RPC, canonical TokenType and body agentMode', () => {
  const original = payload()
  const request = buildRuntimeRequest(account(), original, { agentMode: 'spec' })
  assert.equal(request.url, 'https://runtime.eu-west-1.kiro.dev/')
  assert.equal(request.headers['content-type'], 'application/x-amz-json-1.0')
  assert.equal(request.headers['x-amz-target'], 'KiroRuntimeService.GenerateAssistantResponse')
  assert.equal(request.headers.TokenType, 'SSO_OIDC')
  assert.equal(request.payload.agentMode, 'spec')
  assert.equal(request.payload.inferenceConfig, undefined)
  assert.deepEqual(request.payload.additionalModelRequestFields, original.additionalModelRequestFields)
  assert.ok(original.inferenceConfig, 'wire adaptation does not mutate the caller')
  assert.doesNotMatch(JSON.stringify(request.headers), /KiroIDE-|AmazonQ/)
  assert.equal(buildRuntimeRequest(account({ authMethod: 'social', provider: 'Google' }), payload()).headers.TokenType, undefined)
  assert.equal(buildRuntimeRequest(account({ authMethod: 'external_idp', provider: 'ExternalIdp' }), payload()).headers.TokenType, 'EXTERNAL_IDP')
})

test('service profile and current official provider defaults are retained; arbitrary payload profiles are ignored', () => {
  const arn = 'arn:aws:codewhisperer:ap-northeast-1:123456789012:profile/synthetic'
  assert.equal(buildRuntimeRequest(account({ profileArn: arn }), payload()).url, 'https://runtime.ap-northeast-1.kiro.dev/')
  assert.equal(buildRuntimeRequest(account({ profileArn: arn }), payload(), { regionOverride: 'us-west-2' }).url, 'https://runtime.us-west-2.kiro.dev/')
  const old = payload(); old.profileArn = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
  assert.equal(buildRuntimeRequest(account({ provider: 'Enterprise' }), old).payload.profileArn, undefined)
  for (const fixed of [old.profileArn, 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK']) {
    const request = buildRuntimeRequest(account({ profileArn: fixed, region: 'ap-southeast-1' }), payload())
    assert.equal(request.payload.profileArn, fixed)
    assert.equal(request.region, 'us-east-1', 'current official provider profile keeps its own region')
  }
  const unsupported = 'arn:aws:codewhisperer:eu-central-1:610548660232:profile/VNECVYCYYAWN'
  assert.equal(buildRuntimeRequest(account({ provider: 'Enterprise', profileArn: unsupported }), old).payload.profileArn, undefined)
  assert.equal(buildRuntimeRequest(account({ provider: 'BuilderId' }), old).payload.profileArn, old.profileArn)
  assert.equal(buildRuntimeRequest(account({ provider: 'Google' }), old).payload.profileArn.endsWith('/EHGA3GRVQMUK'), true)
  assert.throws(() => buildRuntimeRequest(account({ region: 'eu-west-1.evil.invalid' }), payload()), /region/i)
  assert.throws(() => buildRuntimeRequest(account({ profileArn: 'malformed-profile' }), payload()), /profile/i)
})

test('split UTF-8 frames, reasoning, interleaved tools and current usage schema reach real callbacks once', async () => {
  const frames = Buffer.concat([
    frame('assistantResponseEvent', { content: '你好 ' }),
    frame('reasoningContentEvent', { text: 'Synthetic reasoning', signature: 'synthetic-signature' }),
    frame('toolUseEvent', { toolUseId: 'a', name: 'one', input: '{"x":', stop: false }),
    frame('toolUseEvent', { toolUseId: 'b', name: 'two', input: '{"y":2}', stop: true }),
    frame('toolUseEvent', { toolUseId: 'a', name: 'one', input: '1}', stop: true }),
    frame('metadataEvent', { tokenUsage: { uncachedInputTokens: 0, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 0, totalTokens: 7 }, stopReason: 'tool_use' }),
    frame('meteringEvent', { usage: 0.25, unit: 'credits' })
  ])
  const chunks = Array.from({ length: frames.length }, (_, index) => frames.subarray(index, index + 1))
  const result = await run(streamOf(chunks))
  assert.equal(result.errors.length, 0)
  assert.equal(result.completions.length, 1)
  assert.equal(result.calls.length, 1)
  assert.equal(result.chunks[0][0], '你好 ')
  assert.equal(result.chunks[1][2], true)
  assert.deepEqual(result.chunks.filter(chunk => chunk[1]).map(chunk => chunk[1]), [{ toolUseId: 'b', name: 'two', input: { y: 2 } }, { toolUseId: 'a', name: 'one', input: { x: 1 } }])
  assert.equal(result.completions[0].inputTokens, 7)
  assert.equal(result.completions[0].outputTokens, 0)
  assert.equal(result.completions[0].credits, 0.25)
})

test('bad CRC, truncated frames, malformed JSON and unfinished tools fail closed without completing', async () => {
  const corrupt = Buffer.from(frame('assistantResponseEvent', { content: 'Synthetic' })); corrupt[12] ^= 1
  const truncated = frame('assistantResponseEvent', { content: 'Synthetic' }).subarray(0, -1)
  const invalidJson = frame('assistantResponseEvent', '{not-json FAKE_TOKEN')
  const incompleteTool = frame('toolUseEvent', { toolUseId: 'x', name: 'one', input: '{', stop: false })
  for (const bytes of [corrupt, truncated, invalidJson, incompleteTool]) {
    const result = await run(streamOf([bytes]))
    assert.equal(result.errors.length, 1)
    assert.equal(result.completions.length, 0)
    assert.equal(result.calls.length, 1)
    assert.doesNotMatch(result.errors[0].message, /FAKE_|not-json/)
  }
})

test('HTTP 403 and 429 never replay, expose raw body or pretend every forbidden error is refreshable', async () => {
  for (const status of [403, 429]) {
    let count = 0
    const result = await run(null, { fetcher: async () => { count++; return new Response('FAKE_ACCESS synthetic@example.invalid', { status, headers: { 'x-amzn-kiro-ratelimit-retry-after': '1500' } }) } })
    assert.equal(count, 1)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].retryable, false)
    assert.equal(result.errors[0].upstreamStatus, status)
    assert.equal(result.completions.length, 0)
    assert.doesNotMatch(result.errors[0].message, /FAKE_|example\.invalid|Auth error/)
    if (status === 429) assert.equal(result.errors[0].retryAfterMs, 1500)
  }
})

test('stream exceptions after output are terminal, redacted and never replayed', async () => {
  const bytes = Buffer.concat([frame('assistantResponseEvent', { content: 'Partial' }), frame('throttlingError', { message: 'FAKE_ACCESS synthetic@example.invalid', retryAfterMilliseconds: 1000 })])
  const result = await run(streamOf([bytes]))
  assert.equal(result.chunks.length, 1)
  assert.equal(result.calls.length, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].outputStarted, true)
  assert.equal(result.errors[0].retryable, false)
  assert.equal(result.completions.length, 0)
  assert.doesNotMatch(result.errors[0].message, /FAKE_|example\.invalid/)
})

test('first byte timeout, idle timeout and cancellation stop the reader and emit only one error', async () => {
  let cancelled = 0
  const stalled = () => new ReadableStream({ cancel() { cancelled++ } })
  const first = await run(stalled(), { firstByteTimeoutMs: 15, idleTimeoutMs: 100 })
  assert.equal(first.errors[0].code, 'first_byte_timeout')
  assert.equal(first.completions.length, 0)
  const idle = await run(new ReadableStream({ start(controller) { controller.enqueue(frame('assistantResponseEvent', { content: 'Partial' })) }, cancel() { cancelled++ } }), { firstByteTimeoutMs: 100, idleTimeoutMs: 15 })
  assert.equal(idle.errors[0].code, 'idle_timeout')
  assert.equal(idle.errors[0].outputStarted, true)
  const controller = new AbortController()
  const pending = run(stalled(), { signal: controller.signal, firstByteTimeoutMs: 100 })
  controller.abort(new Error('FAKE_PRIVATE_ABORT_REASON'))
  const aborted = await pending
  assert.equal(aborted.errors.length, 1)
  assert.equal(aborted.errors[0].code, 'cancelled')
  assert.doesNotMatch(aborted.errors[0].message, /FAKE_/)
  assert.ok(cancelled >= 2)
})

test('terminal consumer exceptions never emit a second terminal callback', async () => {
  let completed = 0, errors = 0
  await run(streamOf([frame('assistantResponseEvent', { content: 'Done' })]), { onComplete() { completed++; throw new Error('FAKE_COMPLETE') }, onError() { errors++ } })
  assert.equal(completed, 1)
  assert.equal(errors, 0)
})
