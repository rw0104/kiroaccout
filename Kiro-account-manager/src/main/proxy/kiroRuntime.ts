// Current Kiro IDE 1.4.5 / Agent 1.1.499 wire evidence:
// docs/evidence/2026-10-20-current-kiro-requests.md, Runtime's actual awsJson1_0 serializer.
// No Electron/store/system side effects; the HTTP seam is injectable for offline tests.
import type { KiroPayload, KiroToolUse, KiroUsage, ProxyAccount } from './types'

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/
const PROFILE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):(?:codewhisperer|kiro|q):([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:profile\/[A-Za-z0-9_-]+$/
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_HEADERS_BYTES = 128 * 1024
// Verified in current official 1.4.5 getFixedProfileArn/getAllProfiles, not inferred from old code.
const BUILDER_PROFILE = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
const SOCIAL_PROFILE = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
const unsupportedEnterpriseFallback = (value: string): boolean => /^arn:aws:codewhisperer:[a-z0-9-]+:610548660232:profile\/VNECVYCYYAWN$/.test(value)

export class KiroRuntimeError extends Error {
  readonly retryable = false
  readonly code: string
  readonly outputStarted: boolean
  readonly upstreamStatus?: number
  readonly retryAfterMs?: number
  constructor(code: string, message: string, options: { outputStarted?: boolean; upstreamStatus?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'KiroRuntimeError'
    this.code = code
    this.outputStarted = options.outputStarted === true
    this.upstreamStatus = options.upstreamStatus
    this.retryAfterMs = options.retryAfterMs
  }
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const pick = (value: unknown, names: readonly string[]): JsonObject => object(value)
  ? Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]])) : {}

/** SDK schema serialization omits fields absent from the current model. */
function messageForRuntime(value: unknown): JsonObject {
  if (!object(value)) throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime conversation message')
  if (object(value.userInputMessage)) {
    const message = pick(value.userInputMessage, ['content', 'modelId', 'origin', 'images', 'documents'])
    if (typeof message.content !== 'string' || typeof message.origin !== 'string') throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime user message')
    const context = pick(value.userInputMessage.userInputMessageContext, ['editorState', 'envState', 'cursorState', 'toolResults', 'tools'])
    if (Object.keys(context).length > 0) message.userInputMessageContext = context
    return { userInputMessage: message }
  }
  if (object(value.assistantResponseMessage)) {
    return { assistantResponseMessage: pick(value.assistantResponseMessage, ['content', 'messageId', 'toolUses', 'reasoningContent']) }
  }
  throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime conversation message')
}

export interface RuntimeRequestOptions {
  regionOverride?: string
  agentMode?: 'vibe' | 'spec'
  clientVersion?: string
}

export function buildRuntimeRequest(account: ProxyAccount, original: KiroPayload, options: RuntimeRequestOptions = {}): {
  url: string; method: 'POST'; headers: Record<string, string>; body: string; payload: JsonObject; region: string
} {
  if (!account.accessToken?.trim() || /[\r\n]/.test(account.accessToken)) throw new KiroRuntimeError('missing_access_token', 'A valid access token is required')
  let profileArn: string | undefined
  let profileRegion: string | undefined
  const suppliedProfile = account.profileArn && !unsupportedEnterpriseFallback(account.profileArn) ? account.profileArn : undefined
  const selectedProfile = suppliedProfile || (account.provider === 'BuilderId' ? BUILDER_PROFILE
    : ['Google', 'Github'].includes(account.provider || '') ? SOCIAL_PROFILE : undefined)
  if (selectedProfile) {
    const match = PROFILE_ARN.exec(selectedProfile)
    if (!match) throw new KiroRuntimeError('invalid_profile', 'Invalid Runtime profile ARN')
    profileArn = selectedProfile
    profileRegion = match[1]
  }
  // Never borrow a payload profile or invent an enterprise ARN. Known providers use current official defaults.
  const region = options.regionOverride ?? profileRegion ?? account.region ?? 'us-east-1'
  if (!REGION.test(region)) throw new KiroRuntimeError('invalid_region', 'Invalid Runtime region')
  const state = original.conversationState
  if (!object(state) || typeof state.conversationId !== 'string' || !state.conversationId || state.chatTriggerType !== 'MANUAL') throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime conversation state')
  const conversationState = pick(state, ['chatTriggerType', 'conversationId', 'agentContinuationId', 'agentTaskType', 'rootConversationId'])
  conversationState.currentMessage = messageForRuntime(state.currentMessage)
  if (state.history !== undefined) {
    if (!Array.isArray(state.history)) throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime history')
    conversationState.history = state.history.map(messageForRuntime)
  }
  const payload: JsonObject = { conversationState, agentMode: options.agentMode ?? 'vibe' }
  if (profileArn) payload.profileArn = profileArn
  if (original.additionalModelRequestFields !== undefined) {
    if (!object(original.additionalModelRequestFields)) throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime model parameters')
    payload.additionalModelRequestFields = original.additionalModelRequestFields
  }
  const systemPrompt = (original as KiroPayload & { systemPrompt?: unknown }).systemPrompt
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') throw new KiroRuntimeError('invalid_payload', 'Invalid Runtime system prompt')
    payload.systemPrompt = systemPrompt
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.0',
    'x-amz-target': 'KiroRuntimeService.GenerateAssistantResponse',
    'Authorization': `Bearer ${account.accessToken}`,
    'user-agent': `kiroaccout/${options.clientVersion?.replace(/[^0-9A-Za-z.+-]/g, '') || '1'}`,
    'amz-sdk-request': 'attempt=1; max=1'
  }
  if (account.authMethod === 'external_idp' || account.provider === 'ExternalIdp') headers.TokenType = 'EXTERNAL_IDP'
  else if (account.authMethod?.toLowerCase() === 'idc' || ['BuilderId', 'Enterprise', 'IAM_SSO', 'AWSIdC', 'Internal'].includes(account.provider ?? '')) headers.TokenType = 'SSO_OIDC'
  let body: string
  try { body = JSON.stringify(payload) } catch { throw new KiroRuntimeError('invalid_payload', 'Runtime payload cannot be serialized') }
  return { url: `https://runtime.${region}.kiro.dev/`, method: 'POST', headers, body, payload, region }
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  CRC_TABLE[index] = value >>> 0
}
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}
const utf8 = new TextDecoder('utf-8', { fatal: true })

function frameHeaders(bytes: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {}
  let offset = 0
  const requireBytes = (size: number): void => { if (size < 0 || offset + size > bytes.length) throw new KiroRuntimeError('invalid_frame', 'Invalid Runtime event headers') }
  while (offset < bytes.length) {
    const nameLength = bytes[offset++]
    if (nameLength === 0) throw new KiroRuntimeError('invalid_frame', 'Invalid Runtime event header name')
    requireBytes(nameLength + 1)
    const name = utf8.decode(bytes.subarray(offset, offset + nameLength)); offset += nameLength
    const type = bytes[offset++]
    if (Object.hasOwn(headers, name)) throw new KiroRuntimeError('invalid_frame', 'Duplicate Runtime event header')
    if (type === 6 || type === 7) {
      requireBytes(2)
      const length = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2
      requireBytes(length)
      if (type === 7) headers[name] = utf8.decode(bytes.subarray(offset, offset + length))
      offset += length
    } else {
      const sizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
      if (sizes[type] === undefined) throw new KiroRuntimeError('invalid_frame', 'Unsupported Runtime event header type')
      requireBytes(sizes[type]); offset += sizes[type]
    }
  }
  return headers
}

function deadline<T>(promise: Promise<T>, milliseconds: number, code: string, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => { if (timer) clearTimeout(timer); controller.signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(controller.signal.reason instanceof KiroRuntimeError ? controller.signal.reason : new KiroRuntimeError('cancelled', 'Request cancelled')) }
    if (controller.signal.aborted) { abort(); return }
    controller.signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => controller.abort(new KiroRuntimeError(code, code === 'first_byte_timeout' ? 'Runtime first-byte timeout' : 'Runtime stream idle timeout')), Math.max(1, milliseconds))
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

interface RuntimeCallbacks {
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, signature?: string, redacted?: string) => void | Promise<void>
  onComplete: (usage: KiroUsage) => void
  onError: (error: Error) => void
}
export interface ExecuteRuntimeOptions extends RuntimeRequestOptions, RuntimeCallbacks {
  account: ProxyAccount
  payload: KiroPayload
  fetcher?: (url: string, options: RequestInit) => Promise<Response>
  signal?: AbortSignal
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  estimateTokens?: (text: string) => number
  onEventCounts?: (counts: Record<string, number>) => void
}

/** Single upstream invocation. Never retries or changes endpoints after a failure. */
export async function executeRuntimeRequest(options: ExecuteRuntimeOptions): Promise<void> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(new KiroRuntimeError('cancelled', 'Request cancelled'))
  let terminal = false
  let outputStarted = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const started = Date.now()
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 30000
  const idleTimeoutMs = options.idleTimeoutMs ?? 60000
  const eventCounts: Record<string, number> = {}
  const usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const tools = new Map<string, { name: string; input: string }>()
  const completedTools = new Set<string>()
  let activeTool: string | undefined
  let outputText = ''
  let hasRealInput = false
  let hasRealOutput = false
  let meaningfulEvents = 0
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const emit = async (text: string, tool?: KiroToolUse, thinking?: boolean, signature?: string, redacted?: string): Promise<void> => {
    outputStarted = true
    if (text) outputText += text
    await options.onChunk(text, tool, thinking, signature, redacted)
  }
  const consume = async (headers: Record<string, string>, raw: Uint8Array): Promise<void> => {
    const type = headers[':event-type'] ?? headers[':exception-type']
    if (!type) throw new KiroRuntimeError('invalid_frame', 'Runtime event type is missing')
    let parsed: unknown
    try { parsed = JSON.parse(utf8.decode(raw)) } catch { throw new KiroRuntimeError('invalid_event', 'Invalid Runtime event JSON') }
    if (!object(parsed)) throw new KiroRuntimeError('invalid_event', 'Invalid Runtime event payload')
    const event = object(parsed[type]) ? parsed[type] as JsonObject : parsed
    eventCounts[type] = (eventCounts[type] ?? 0) + 1
    if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error' || ['error', 'throttlingError', 'validationError', 'serviceUnavailableError'].includes(type)) {
      const status = type === 'throttlingError' ? 429 : type === 'validationError' ? 400 : type === 'serviceUnavailableError' ? 503 : 500
      throw new KiroRuntimeError('stream_error', 'Runtime returned a stream error', { upstreamStatus: status, retryAfterMs: number(event.retryAfterMilliseconds) ? event.retryAfterMilliseconds : undefined })
    }
    if (headers[':message-type'] !== 'event') throw new KiroRuntimeError('invalid_frame', 'Invalid Runtime message type')
    if (type === 'assistantResponseEvent') {
      if (typeof event.content !== 'string') throw new KiroRuntimeError('invalid_event', 'Invalid Runtime assistant event')
      meaningfulEvents++
      if (event.content) await emit(event.content)
    } else if (type === 'reasoningContentEvent') {
      if (event.text !== undefined && typeof event.text !== 'string' || event.signature !== undefined && typeof event.signature !== 'string' || event.redactedContent !== undefined && typeof event.redactedContent !== 'string') throw new KiroRuntimeError('invalid_event', 'Invalid Runtime reasoning event')
      meaningfulEvents++
      await emit(typeof event.text === 'string' ? event.text : '', undefined, true, typeof event.signature === 'string' ? event.signature : undefined, typeof event.redactedContent === 'string' ? event.redactedContent : undefined)
    } else if (type === 'toolUseEvent') {
      const id = typeof event.toolUseId === 'string' && event.toolUseId ? event.toolUseId : activeTool
      if (!id || completedTools.has(id)) throw new KiroRuntimeError('invalid_tool', 'Invalid or duplicate Runtime tool event')
      const previous = tools.get(id)
      const name = typeof event.name === 'string' && event.name ? event.name : previous?.name
      if (!name || previous && previous.name !== name || event.input !== undefined && typeof event.input !== 'string') throw new KiroRuntimeError('invalid_tool', 'Invalid Runtime tool event')
      const tool = previous ?? { name, input: '' }
      if (typeof event.input === 'string') tool.input += event.input
      if (tool.input.length > MAX_FRAME_BYTES) throw new KiroRuntimeError('invalid_tool', 'Runtime tool input is too large')
      tools.set(id, tool); activeTool = id
      meaningfulEvents++
      if (event.stop === true) {
        let input: unknown
        try { input = tool.input ? JSON.parse(tool.input) : {} } catch { throw new KiroRuntimeError('invalid_tool', 'Runtime tool input is incomplete') }
        if (!object(input)) throw new KiroRuntimeError('invalid_tool', 'Runtime tool input must be an object')
        completedTools.add(id); tools.delete(id)
        await emit('', { toolUseId: id, name, input })
      }
    } else if (type === 'metadataEvent') {
      meaningfulEvents++
      if (object(event.tokenUsage)) {
        const tokens = event.tokenUsage
        const inputFields = ['uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens']
        if (inputFields.some(name => number(tokens[name]))) {
          usage.inputTokens = inputFields.reduce((sum, name) => sum + (number(tokens[name]) ? tokens[name] as number : 0), 0)
          hasRealInput = true
        }
        if (number(tokens.outputTokens)) { usage.outputTokens = tokens.outputTokens; hasRealOutput = true }
        if (!hasRealInput && number(tokens.totalTokens) && hasRealOutput && tokens.totalTokens >= usage.outputTokens) { usage.inputTokens = tokens.totalTokens - usage.outputTokens; hasRealInput = true }
        if (number(tokens.cacheReadInputTokens)) usage.cacheReadTokens = tokens.cacheReadInputTokens
        if (number(tokens.cacheWriteInputTokens)) usage.cacheWriteTokens = tokens.cacheWriteInputTokens
        if (number(tokens.contextUsagePercentage)) usage.contextUsage = { percentage: tokens.contextUsagePercentage }
      }
    } else if (type === 'meteringEvent') {
      if (number(event.usage)) usage.credits += event.usage
    } else if (type === 'contextUsageEvent') {
      if (number(event.contextUsagePercentage)) usage.contextUsage = { percentage: event.contextUsagePercentage }
    }
    // Citations and toolResultEvent are side metadata; never reinterpret them as model/tool text.
  }

  try {
    if (options.signal?.aborted) abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (controller.signal.aborted) throw controller.signal.reason
    const request = buildRuntimeRequest(options.account, options.payload, options)
    const response = await deadline((options.fetcher ?? fetch)(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal, redirect: 'error' }), firstByteTimeoutMs, 'first_byte_timeout', controller)
    if (!response.ok) {
      // Do not consume/log arbitrary upstream error bodies: they can echo tokens or account details.
      void response.body?.cancel().catch(() => undefined)
      const retryAfter = Number(response.headers.get('x-amzn-kiro-ratelimit-retry-after'))
      throw new KiroRuntimeError('http_error', response.status === 403 ? 'Kiro Runtime permission denied' : response.status === 401 ? 'Kiro Runtime credentials are not accepted' : response.status === 429 ? 'Kiro Runtime request throttled' : 'Kiro Runtime request failed', { upstreamStatus: response.status, retryAfterMs: response.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined })
    }
    if (!response.body) throw new KiroRuntimeError('empty_stream', 'Runtime response body is missing')
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType && contentType !== 'application/vnd.amazon.eventstream' && contentType !== 'application/octet-stream') throw new KiroRuntimeError('unsupported_protocol', 'Runtime returned an unsupported response protocol')
    reader = response.body.getReader()
    let buffer = new Uint8Array(0)
    let receivedBytes = false
    while (true) {
      const read = await deadline(reader.read(), receivedBytes ? idleTimeoutMs : firstByteTimeoutMs - (Date.now() - started), receivedBytes ? 'idle_timeout' : 'first_byte_timeout', controller)
      if (read.done) break
      if (!read.value.length) continue
      receivedBytes = true
      const next = new Uint8Array(buffer.length + read.value.length)
      next.set(buffer); next.set(read.value, buffer.length); buffer = next
      while (buffer.length >= 12) {
        const length = uint32(buffer, 0), headerLength = uint32(buffer, 4)
        if (length < 16 || length > MAX_FRAME_BYTES || headerLength > MAX_HEADERS_BYTES || headerLength > length - 16) throw new KiroRuntimeError('invalid_frame', 'Invalid Runtime event frame length')
        if (crc32(buffer.subarray(0, 8)) !== uint32(buffer, 8)) throw new KiroRuntimeError('invalid_frame', 'Runtime event prelude checksum mismatch')
        if (buffer.length < length) break
        const frame = buffer.subarray(0, length)
        if (crc32(frame.subarray(0, -4)) !== uint32(frame, length - 4)) throw new KiroRuntimeError('invalid_frame', 'Runtime event checksum mismatch')
        await consume(frameHeaders(frame.subarray(12, 12 + headerLength)), frame.subarray(12 + headerLength, length - 4))
        buffer = buffer.subarray(length)
      }
      if (controller.signal.aborted) throw controller.signal.reason
    }
    if (controller.signal.aborted) throw controller.signal.reason
    if (buffer.length) throw new KiroRuntimeError('truncated_stream', 'Runtime stream ended with an incomplete event frame')
    if (tools.size) throw new KiroRuntimeError('incomplete_tool', 'Runtime stream ended with incomplete tool input')
    if (!meaningfulEvents) throw new KiroRuntimeError('empty_stream', 'Runtime returned no assistant response')
    if (options.estimateTokens) {
      if (!hasRealInput) usage.inputTokens = options.estimateTokens(request.body)
      if (!hasRealOutput && outputText) usage.outputTokens = options.estimateTokens(outputText)
    }
    options.onEventCounts?.({ ...eventCounts })
    terminal = true
    options.onComplete(usage)
  } catch (error) {
    if (!terminal) {
      terminal = true
      const safe = error instanceof KiroRuntimeError
        ? new KiroRuntimeError(error.code, error.message, { outputStarted, upstreamStatus: error.upstreamStatus, retryAfterMs: error.retryAfterMs })
        : new KiroRuntimeError('request_failed', 'Runtime request or response processing failed', { outputStarted })
      try { options.onError(safe) } catch { /* Terminal callbacks are never repeated. */ }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}
