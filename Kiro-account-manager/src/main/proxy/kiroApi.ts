// Kiro API 调用核心模块
import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Dispatcher } from 'undici'
import type {
  KiroPayload,
  KiroUserInputMessage,
  KiroHistoryMessage,
  KiroToolWrapper,
  KiroToolResult,
  KiroImage,
  KiroDocument,
  KiroToolUse,
  KiroCachePoint,
  KiroRequestContext,
  KiroUsage,
  ProxyAccount
} from './types'
import { proxyLogger } from './logger'
import { executeRuntimeRequest } from './kiroRuntime'
import { requestControlPlane } from '../kiroControlPlane'
import { isRetiredModelId, ModelRequestError, type KiroModel } from '../../shared/modelCatalog'
export type { KiroModel } from '../../shared/modelCatalog'
import { getKProxyService } from '../kproxy'
import { getSystemProxy, safeCreateProxyAgent } from './systemProxy'
import {
  countTokens,
  getModelContextLength,
  setModelContextWindow,
  getModelContextWindow
} from './tokenCounter'
// 重新导出以保持向后兼容（proxyServer.ts 等模块仍 from './kiroApi' 导入）
export { setModelContextWindow, getModelContextWindow }

// 是否使用 K-Proxy 代理发送 API 请求（从主进程导入）
let useKProxyForApi = false
let logStreamEvents = false

export function setUseKProxyForApiInProxy(enabled: boolean): void {
  useKProxyForApi = enabled
}

// profileArn 自愈持久化回调：当 Enterprise 账号在运行时首次解析出真实 profileArn 时，
// 通过该回调通知主进程回写到 renderer store + 磁盘，避免每次请求都重新获取。
type ProfileArnPersistCallback = (accountId: string, profileArn: string) => void
let profileArnPersistCallback: ProfileArnPersistCallback | undefined
export function setProfileArnPersistCallback(cb: ProfileArnPersistCallback | undefined): void {
  profileArnPersistCallback = cb
}

export function setLogStreamEvents(enabled: boolean): void {
  logStreamEvents = enabled
}

// Payload 大小限制（KB），用户可在高级设置中调整
let payloadSizeLimitKB = 153600 // 默认 150MB（支持大图片）
export function setPayloadSizeLimitKB(limitKB: number): void {
  payloadSizeLimitKB = Math.max(256, Math.min(204800, limitKB))
}

// Token buffer reserve 开关（默认 false = 完全跳过 trimHistoryByTokens）
// 关闭时后端不再裁剪任何旧消息，超出 context window 由 Kiro 后端原样返回错误
let enableTokenBufferReserve = false
export function setEnableTokenBufferReserve(enabled: boolean): void {
  enableTokenBufferReserve = !!enabled
}
export function getEnableTokenBufferReserve(): boolean {
  return enableTokenBufferReserve
}

// Token buffer reserve（仅在 enableTokenBufferReserve=true 时生效）
// 为 model context window 预留的余量，覆盖 system + tools + current + output + 估算偏差 + schema 开销
// 默认 20K：开关启用后的合理初始值（200K → effective 180K, 1M → effective 980K）
let tokenBufferReserve = 20000
export function setTokenBufferReserve(tokens: number): void {
  tokenBufferReserve = Math.max(5000, Math.min(150000, tokens))
}
export function getTokenBufferReserve(): number {
  return tokenBufferReserve
}

// 根据 modelId 和 buffer 计算 effective token limit
// 仅在 enableTokenBufferReserve=true 时被调用
// 查不到 model 时 fallback 到 200K context (Claude 默认)
function getEffectiveTokenLimit(modelId?: string): number {
  // 复用 getModelContextLength（支持 cache 命中 → 模糊匹配 → 关键词兜底）
  const ctx = modelId ? getModelContextLength(modelId) : 200000
  return Math.max(8000, ctx - tokenBufferReserve)
}

// Token 估算 (UTF-8 字节数 / 3.5，对中英混合场景做安全偏保守估算)
// 比真实 cl100k_base tokenizer 略偏高 (10-20%), 用于触发裁剪阈值是安全的
function estimateTokensFromString(str: string): number {
  return Math.ceil(Buffer.byteLength(str, 'utf-8') / 3.5)
}

function estimatePayloadTokens(payload: KiroPayload): number {
  return estimateTokensFromString(JSON.stringify(payload))
}

/**
 * 获取网络代理 agent
 * 优先级（从高到低）：
 *   1. 账号自身绑定的 proxyUrl（实现"N 个号一个 IP"分桶反代）
 *   2. K-Proxy（如果启用）
 *   3. 环境变量代理
 *   4. 系统代理
 *
 * 传入 account 让账号级代理覆盖全局；不传则走全局逻辑。
 */
function getNetworkAgent(account?: ProxyAccount): Dispatcher | undefined {
  // 1. 账号专属代理：实现"N 个账号共用 1 个 IP"的分桶反代
  if (account?.proxyUrl) {
    const agent = safeCreateProxyAgent(account.proxyUrl)
    if (agent) {
      proxyLogger.debug('KiroAPI', `Using account-bound proxy for ${account.email || account.id}`)
      return agent
    }
  }
  // 2. K-Proxy
  if (useKProxyForApi) {
    const kproxyService = getKProxyService()
    if (kproxyService?.isRunning()) {
      const config = kproxyService.getConfig()
      const proxyUrl = `http://${config.host}:${config.port}`
      const agent = safeCreateProxyAgent(proxyUrl)
      if (agent) return agent
    }
  }
  // 3. 环境变量
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const envAgent = safeCreateProxyAgent(envProxy)
  if (envAgent) return envAgent
  // 4. 系统代理
  return safeCreateProxyAgent(getSystemProxy())
}

/**
 * 使用代理的 fetch 函数
 * 传入 account 时会优先使用账号绑定的代理（账号-代理 N:1 分桶）
 */
async function fetchWithProxy(url: string, options: RequestInit, account?: ProxyAccount): Promise<Response> {
  const agent = getNetworkAgent(account)
  if (agent) {
    proxyLogger.debug('KiroAPI', `Using proxy agent: ${agent.constructor.name}`)
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// Kiro 版本号（跟随官方 IDE 更新）
const KIRO_VERSION = '0.12.155'
const AWS_SDK_VERSION = '1.0.34'
const AWS_STREAMING_API_VERSION = '1.0.34'

const OS_PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'macos' : 'linux'
const OS_RELEASE = (() => { try { return require('os').release() } catch { return '10.0.0' } })()
const NODE_VERSION = process.versions.node || '22.22.0'

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${OS_PLATFORM}#${OS_RELEASE} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${AWS_STREAMING_API_VERSION} m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/${AWS_SDK_VERSION} ${suffix}`
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const KIRO_CLI_OS = OS_PLATFORM === 'win32' ? 'windows' : OS_PLATFORM === 'macos' ? 'macos' : 'linux'
void KIRO_CLI_OS // reserved for future kiro-cli UA

// Agent 模式（可通过 setAgentMode 配置切换）
let configuredAgentMode: 'vibe' | 'spec' = 'vibe'
export function setAgentMode(mode: 'vibe' | 'spec'): void {
  configuredAgentMode = mode
}
export function getAgentMode(): 'vibe' | 'spec' {
  return configuredAgentMode
}

// profileArn 决策中心已迁移到 ../kiroAuthSync，反代和账号管理器主进程共用同一份定义，
// 防止多处常量漂移。注意 KIRO_BUILDER_ID_PLACEHOLDER_ARN 仍以本模块为出口 re-export，
// 这样 main/index.ts 等老 import 路径不需要改。
import {
  KIRO_BUILDER_ID_PLACEHOLDER_ARN as _KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN,
  isPlaceholderProfileArn as _isPlaceholderProfileArn,
  getEnterpriseFallbackArn
} from '../kiroAuthSync'

export const KIRO_BUILDER_ID_PLACEHOLDER_ARN = _KIRO_BUILDER_ID_PLACEHOLDER_ARN
export const isPlaceholderProfileArn = _isPlaceholderProfileArn

/**
 * 反代调 Kiro API 时使用的 profileArn 决策。
 * 优先级：真实 ARN（自动获取） > 备用固定 ARN（按账号类型）
 * - 已有真实 ARN（非占位符） → 直接用
 * - Enterprise/IdC → 区域化备用 ARN（自动获取失败时兜底）
 * - Social（Github/Google） → 固定 social ARN
 * - BuilderId → 占位符 ARN
 */
function resolveProfileArn(account: ProxyAccount): string | undefined {
  if (account.profileArn && !isPlaceholderProfileArn(account.profileArn)) {
    return account.profileArn
  }
  if (account.provider === 'Enterprise' || account.authMethod === 'external_idp') {
    return getEnterpriseFallbackArn(account.region)
  }
  if (account.authMethod === 'social' || account.provider === 'Github' || account.provider === 'Google') {
    return KIRO_SOCIAL_PROFILE_ARN
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

// 兼容 SDK 部分调用仍想知道社交 ARN 的场景（极少；保留 export 不破坏外部 import）
export { KIRO_SOCIAL_PROFILE_ARN }

// Agentic 模式系统提示 - 防止大文件写入超时
const AGENTIC_SYSTEM_PROMPT = `# CRITICAL: CHUNKED WRITE PROTOCOL (MANDATORY)

You MUST follow these rules for ALL file operations. Violation causes server timeouts and task failure.

## ABSOLUTE LIMITS
- **MAXIMUM 350 LINES** per single write/edit operation - NO EXCEPTIONS
- **RECOMMENDED 300 LINES** or less for optimal performance
- **NEVER** write entire files in one operation if >300 lines

## MANDATORY CHUNKED WRITE STRATEGY

### For NEW FILES (>300 lines total):
1. FIRST: Write initial chunk (first 250-300 lines) using write_to_file/fsWrite
2. THEN: Append remaining content in 250-300 line chunks using file append operations
3. REPEAT: Continue appending until complete

### For EDITING EXISTING FILES:
1. Use surgical edits (apply_diff/targeted edits) - change ONLY what's needed
2. NEVER rewrite entire files - use incremental modifications
3. Split large refactors into multiple small, focused edits

REMEMBER: When in doubt, write LESS per operation. Multiple small operations > one large operation.`

// Thinking 模式标签
const THINKING_MODE_PROMPT = `<thinking_mode>enabled</thinking_mode>
<max_thinking_length>200000</max_thinking_length>`

// 模型 ID 映射
const MODEL_ID_MAP: Record<string, string> = {
  // Claude 4.5 系列
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4.5': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4.5': 'claude-opus-4.5',
  // An omitted model asks Kiro to route it. Cross-provider aliases belong to
  // explicit user mappings, never an implicit substitute for the requested ID.
  'default': 'auto'
}

/**
 * 归一化 Claude 版本号：把版本号里的短横线转成点号。
 *
 * 背景：部分客户端（如 Claude Code）不允许模型名里出现 "."，会把 "claude-opus-4.6"
 * 写成 "claude-opus-4-6"，若原样透传给 Kiro 会被解析成 "claude-opus-4"（丢掉 minor），
 * 导致 1M 上下文等特性设置失败。这里把 claude-{family}-{major}-{minor} 的最后一段
 * 版本短横转成点号，兼容未来任意新版本（4.6 / 4.7 / 5.0 ...）。
 *
 * 仅当 minor 是 1~2 位数字且其后不是更多数字时才转换，避免误伤日期快照后缀
 * （如 claude-sonnet-4-20250514 不会被改）。
 */
function normalizeClaudeVersion(modelId: string): string {
  return modelId.replace(
    /^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i,
    '$1-$2.$3'
  )
}

function isCodeWhispererModelId(modelId: string): boolean {
  return /^[A-Z0-9_]+$/.test(modelId) && modelId.includes('_')
}

export function mapModelId(model: string): string {
  if (typeof model !== 'string') throw new ModelRequestError('Model must be a string. Choose a model available to this account.')
  let modelId = model.trim()
  if (!modelId) return MODEL_ID_MAP.default
  if (isRetiredModelId(modelId)) throw new ModelRequestError('Model is retired: Sonnet 4.0 reached end of life on 2026-10-14. Choose a currently available model.')
  if (isCodeWhispererModelId(modelId)) return modelId
  // 0) 归一化版本号短横 → 点号（claude-opus-4-6 → claude-opus-4.6），兼容不支持 "." 的客户端
  modelId = normalizeClaudeVersion(modelId)
  if (isRetiredModelId(modelId)) throw new ModelRequestError('Model is retired: Sonnet 4.0 reached end of life on 2026-10-14. Choose a currently available model.')
  const lower = modelId.toLowerCase()
  // 1) 显式 alias 映射优先
  if (MODEL_ID_MAP[lower]) return MODEL_ID_MAP[lower]
  // 2) 看似 Kiro 支持的 Claude 模型格式 (claude-{sonnet|haiku|opus}-{ver})，原样透传
  //    用于向前兼容尚未加入 MODEL_ID_MAP 的新发布模型
  if (/^claude-(sonnet|haiku|opus)-/.test(lower)) return modelId
  // Current Runtime model IDs evolve independently from this client's alias table.
  // Let the service reject an unknown model instead of silently billing a different one.
  if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(modelId)) return modelId
  throw new ModelRequestError('Invalid model identifier')
}

// 检测是否为 Agentic 模式请求
export function isAgenticRequest(model: string, tools?: unknown[]): boolean {
  const lower = model.toLowerCase()
  // 模型名称包含 -agentic 或有工具调用
  return lower.includes('-agentic') || lower.includes('agentic') || Boolean(tools && tools.length > 0)
}

// 检测是否启用 Thinking 模式
export function isThinkingEnabled(headers?: Record<string, string>): boolean {
  if (!headers) return false
  // 检查 Anthropic-Beta 头是否包含 thinking
  const betaHeader = headers['anthropic-beta'] || headers['Anthropic-Beta'] || ''
  return betaHeader.toLowerCase().includes('thinking')
}

// 注入系统提示
export function injectSystemPrompts(
  content: string,
  isAgentic: boolean,
  thinkingEnabled: boolean
): string {
  let result = content
  
  // 注入时间戳
  const timestamp = new Date().toISOString()
  const timestampPrompt = `Current time: ${timestamp}`
  
  // 注入 Thinking 模式（必须在最前面）
  if (thinkingEnabled) {
    result = THINKING_MODE_PROMPT + '\n\n' + result
  }
  
  // 注入 Agentic 模式提示
  if (isAgentic) {
    result = result + '\n\n' + AGENTIC_SYSTEM_PROMPT
  }
  
  // 注入时间戳
  result = timestampPrompt + '\n\n' + result
  
  return result
}

// ============= 消息清理逻辑（参考 Kiro 官方实现）=============

// 占位消息
const HELLO_MESSAGE: KiroHistoryMessage = {
  userInputMessage: { content: 'Hello', origin: 'AI_EDITOR' }
}

const CONTINUE_MESSAGE: KiroHistoryMessage = {
  userInputMessage: { content: 'Continue', origin: 'AI_EDITOR' }
}

const UNDERSTOOD_MESSAGE: KiroHistoryMessage = {
  assistantResponseMessage: { content: 'understood' }
}

// 创建失败的工具结果消息
function createFailedToolUseMessage(toolUseIds: string[]): KiroHistoryMessage {
  return {
    userInputMessage: {
      content: '',
      origin: 'AI_EDITOR',
      userInputMessageContext: {
        toolResults: toolUseIds.map(createFailedToolResult)
      }
    }
  }
}

// 类型检查函数
function isUserInputMessage(message: KiroHistoryMessage): boolean {
  return message != null && 'userInputMessage' in message && message.userInputMessage != null
}

function isAssistantResponseMessage(message: KiroHistoryMessage): boolean {
  return message != null && 'assistantResponseMessage' in message && message.assistantResponseMessage != null
}

function hasToolResults(message: KiroHistoryMessage): boolean {
  return !!(message.userInputMessage?.userInputMessageContext?.toolResults?.length)
}

function hasToolUses(message: KiroHistoryMessage): boolean {
  return !!(message.assistantResponseMessage?.toolUses?.length)
}

function hasMatchingToolResults(
  toolUses: KiroToolUse[] | undefined,
  toolResults: KiroToolResult[] | undefined
): boolean {
  if (!toolUses || !toolUses.length) return true
  if (!toolResults || !toolResults.length) return false
  
  const allToolUsesHaveResults = toolUses.every(
    toolUse => toolResults.some(result => result.toolUseId === toolUse.toolUseId)
  )
  const allToolResultsHaveUses = toolResults.every(
    result => toolUses.some(toolUse => result.toolUseId === toolUse.toolUseId)
  )
  return allToolUsesHaveResults && allToolResultsHaveUses
}

function createFailedToolResult(toolUseId: string): KiroToolResult {
  return {
    toolUseId,
    content: [{ text: 'Tool execution failed' }],
    status: 'error'
  }
}

function stripInvalidToolResults(message: KiroHistoryMessage): KiroHistoryMessage | null {
  if (message.userInputMessage?.content?.trim()) {
    return {
      userInputMessage: {
        ...message.userInputMessage,
        userInputMessageContext: undefined
      }
    }
  }
  return null
}

// 确保以 user 消息开始
function ensureStartsWithUserMessage(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length === 0 || isUserInputMessage(messages[0])) {
    return messages
  }
  return [HELLO_MESSAGE, ...messages]
}

// 确保以 user 消息结束
function ensureEndsWithUserMessage(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length === 0) return [HELLO_MESSAGE]
  if (isUserInputMessage(messages[messages.length - 1])) return messages
  return [...messages, CONTINUE_MESSAGE]
}

// 确保消息交替
function ensureAlternatingMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length <= 1) return messages
  
  const result: KiroHistoryMessage[] = [messages[0]]
  for (let i = 1; i < messages.length; i++) {
    const prevMessage = result[result.length - 1]
    const currentMessage = messages[i]
    
    if (isUserInputMessage(prevMessage) && isUserInputMessage(currentMessage)) {
      result.push(UNDERSTOOD_MESSAGE)
    } else if (isAssistantResponseMessage(prevMessage) && isAssistantResponseMessage(currentMessage)) {
      result.push(CONTINUE_MESSAGE)
    }
    result.push(currentMessage)
  }
  return result
}

function relocateToolResultMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const assistantToolUseIndexes: number[] = []
  const toolResultIndexById = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      assistantToolUseIndexes.push(i)
    } else if (isUserInputMessage(message) && hasToolResults(message)) {
      for (const toolResult of message.userInputMessage?.userInputMessageContext?.toolResults ?? []) {
        if (toolResult.toolUseId && !toolResultIndexById.has(toolResult.toolUseId)) {
          toolResultIndexById.set(toolResult.toolUseId, i)
        }
      }
    }
  }

  if (assistantToolUseIndexes.length === 0) return messages

  const result: KiroHistoryMessage[] = []
  const usedIndexes = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (usedIndexes.has(i)) continue
    const message = messages[i]
    result.push(message)
    usedIndexes.add(i)

    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      for (const toolUse of message.assistantResponseMessage?.toolUses ?? []) {
        const toolResultIndex = toolResultIndexById.get(toolUse.toolUseId)
        if (toolResultIndex !== undefined && toolResultIndex !== i + 1 && !usedIndexes.has(toolResultIndex)) {
          const toolResultMessage = messages[toolResultIndex]
          if (toolResultMessage) {
            result.push(toolResultMessage)
            usedIndexes.add(toolResultIndex)
          }
        }
      }
    }
  }
  return result
}

function removeInvalidToolResultMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const result: KiroHistoryMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const previousMessage = i > 0 ? messages[i - 1] : null
    if (!isUserInputMessage(message) || !hasToolResults(message)) {
      result.push(message)
      continue
    }
    if (!previousMessage || !isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage)) {
      const stripped = stripInvalidToolResults(message)
      if (stripped) result.push(stripped)
      continue
    }

    const validToolUseIds = new Set((previousMessage.assistantResponseMessage?.toolUses ?? []).map(toolUse => toolUse.toolUseId).filter(Boolean))
    const seenToolUseIds = new Set<string>()
    const toolResults = message.userInputMessage?.userInputMessageContext?.toolResults ?? []
    const filteredToolResults = toolResults.filter(toolResult => {
      if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId)) return false
      seenToolUseIds.add(toolResult.toolUseId)
      return true
    })

    if (filteredToolResults.length === toolResults.length) {
      result.push(message)
    } else if (filteredToolResults.length > 0) {
      result.push({
        userInputMessage: {
          ...message.userInputMessage!,
          userInputMessageContext: {
            ...message.userInputMessage!.userInputMessageContext,
            toolResults: filteredToolResults
          }
        }
      })
    } else {
      const stripped = stripInvalidToolResults(message)
      if (stripped) result.push(stripped)
    }
  }
  return result
}

// 确保工具调用有对应结果
function ensureValidToolUsesAndResults(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const result: KiroHistoryMessage[] = []
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    result.push(message)
    
    if (isAssistantResponseMessage(message) && hasToolUses(message)) {
      const nextMessage = i + 1 < messages.length ? messages[i + 1] : null
      const toolUses = message.assistantResponseMessage?.toolUses ?? []
      const toolUseIds = toolUses.map((tu, idx) => tu.toolUseId ?? `toolUse_${idx + 1}`)
      
      if (!nextMessage || !isUserInputMessage(nextMessage) || !hasToolResults(nextMessage)) {
        // 没有对应的工具结果，添加失败消息
        result.push(createFailedToolUseMessage(toolUseIds))
      } else if (!hasMatchingToolResults(
        message.assistantResponseMessage?.toolUses,
        nextMessage.userInputMessage?.userInputMessageContext?.toolResults
      ) && !messages.some((candidate, index) => (
        index !== i
        && isAssistantResponseMessage(candidate)
        && hasToolUses(candidate)
        && hasMatchingToolResults(candidate.assistantResponseMessage?.toolUses, nextMessage.userInputMessage?.userInputMessageContext?.toolResults)
      ))) {
        // 工具结果不匹配，添加失败消息
        const existingToolResults = nextMessage.userInputMessage?.userInputMessageContext?.toolResults ?? []
        const validToolUseIds = new Set(toolUseIds)
        const usedToolUseIds = new Set<string>()
        const completedToolResults = existingToolResults.filter(toolResult => {
          if (!toolResult.toolUseId || !validToolUseIds.has(toolResult.toolUseId) || usedToolUseIds.has(toolResult.toolUseId)) return false
          usedToolUseIds.add(toolResult.toolUseId)
          return true
        })
        for (const toolUseId of toolUseIds) {
          if (!usedToolUseIds.has(toolUseId)) completedToolResults.push(createFailedToolResult(toolUseId))
        }
        result.push({
          userInputMessage: {
            ...nextMessage.userInputMessage!,
            userInputMessageContext: {
              ...nextMessage.userInputMessage!.userInputMessageContext,
              toolResults: completedToolResults
            }
          }
        })
        i++
      }
    }
  }
  return result
}

// 移除空的 user 消息
function removeEmptyUserMessages(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length <= 1) return messages
  
  const firstUserMessageIndex = messages.findIndex(isUserInputMessage)
  return messages.filter((message, index) => {
    if (isAssistantResponseMessage(message)) return true
    if (isUserInputMessage(message) && index === firstUserMessageIndex) return true
    if (isUserInputMessage(message)) {
      const hasContent = message.userInputMessage?.content?.trim() !== ''
      return hasContent || hasToolResults(message)
    }
    return true
  })
}

function validateConversation(messages: KiroHistoryMessage[]): string[] {
  const errors: string[] = []
  if (messages.length === 0 || !isUserInputMessage(messages[0])) {
    errors.push('STARTS_WITH_USER_MESSAGE:index=0')
  }
  if (messages.length === 0 || !isUserInputMessage(messages[messages.length - 1])) {
    errors.push(`ENDS_WITH_USER_MESSAGE:index=${Math.max(messages.length - 1, 0)}`)
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1]
    const currentMessage = messages[i]
    if (isUserInputMessage(previousMessage) && isUserInputMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`)
      break
    }
    if (isAssistantResponseMessage(previousMessage) && isAssistantResponseMessage(currentMessage)) {
      errors.push(`ALTERNATING_MESSAGES:index=${i}`)
      break
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i]
    const nextMessage = messages[i + 1]
    if (isAssistantResponseMessage(message) && hasToolUses(message) && (!isUserInputMessage(nextMessage) || !hasMatchingToolResults(message.assistantResponseMessage?.toolUses, nextMessage?.userInputMessage?.userInputMessageContext?.toolResults))) {
      errors.push(`TOOL_USES_AND_RESULTS:index=${i + 1}`)
      break
    }
    if (isAssistantResponseMessage(message) && !hasToolUses(message) && isUserInputMessage(nextMessage) && hasToolResults(nextMessage)) {
      errors.push(`TOOL_RESULTS_AND_NO_USES:index=${i}`)
      break
    }
  }
  for (let i = 1; i < messages.length; i++) {
    const previousMessage = messages[i - 1]
    const currentMessage = messages[i]
    if (!isAssistantResponseMessage(previousMessage) || !hasToolUses(previousMessage) || !isUserInputMessage(currentMessage) || !hasToolResults(currentMessage)) continue
    const toolUseIds = new Set((previousMessage.assistantResponseMessage?.toolUses ?? []).map(toolUse => toolUse.toolUseId).filter(Boolean))
    const seenToolUseIds = new Set<string>()
    const hasInvalidToolResult = (currentMessage.userInputMessage?.userInputMessageContext?.toolResults ?? []).some(toolResult => {
      if (!toolResult.toolUseId || !toolUseIds.has(toolResult.toolUseId) || seenToolUseIds.has(toolResult.toolUseId)) return true
      seenToolUseIds.add(toolResult.toolUseId)
      return false
    })
    if (hasInvalidToolResult) {
      errors.push(`TOOL_RESULTS_ORPHAN_IDS:index=${i}`)
      break
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isUserInputMessage(message) && !message.userInputMessage?.content?.trim() && !hasToolResults(message)) {
      errors.push(`NON_EMPTY_USER_MESSAGE:index=${i}`)
      break
    }
  }
  return errors
}

function getToolNames(tools: KiroToolWrapper[]): Set<string> {
  return new Set(tools.flatMap(tool => 'toolSpecification' in tool ? [tool.toolSpecification.name] : []))
}

function stringifyToolInput(input: unknown): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function flattenContent(content: string, extra: string): string {
  const trimmedContent = content.trim()
  if (!trimmedContent) return extra
  if (!extra) return trimmedContent
  return `${trimmedContent}\n\n${extra}`
}

function formatToolUses(toolUses: KiroToolUse[]): string {
  return toolUses.map(toolUse => [
    `<tool_use id="${toolUse.toolUseId}" name="${toolUse.name}">`,
    stringifyToolInput(toolUse.input),
    '</tool_use>'
  ].filter(Boolean).join('\n')).join('\n\n')
}

function formatToolResults(toolResults: KiroToolResult[]): string {
  return toolResults.map(toolResult => [
    `<tool_result id="${toolResult.toolUseId}" status="${toolResult.status}">`,
    toolResult.content.map(content => content.text).join('\n'),
    '</tool_result>'
  ].filter(Boolean).join('\n')).join('\n\n')
}

function normalizeToolHistory(messages: KiroHistoryMessage[], tools: KiroToolWrapper[]): KiroHistoryMessage[] {
  const toolNames = getToolNames(tools)
  const hasUnknownToolUse = messages.some(message => (
    message.assistantResponseMessage?.toolUses?.some(toolUse => !toolNames.has(toolUse.name)) ?? false
  ))
  if (!hasUnknownToolUse) return messages

  return messages.map(message => {
    if (message.assistantResponseMessage?.toolUses?.length) {
      return {
        assistantResponseMessage: {
          ...message.assistantResponseMessage,
          content: flattenContent(message.assistantResponseMessage.content, formatToolUses(message.assistantResponseMessage.toolUses)),
          toolUses: undefined
        }
      }
    }
    if (message.userInputMessage?.userInputMessageContext?.toolResults?.length) {
      return {
        userInputMessage: {
          ...message.userInputMessage,
          content: flattenContent(message.userInputMessage.content, formatToolResults(message.userInputMessage.userInputMessageContext.toolResults)),
          userInputMessageContext: {
            ...message.userInputMessage.userInputMessageContext,
            toolResults: undefined
          }
        }
      }
    }
    return message
  })
}

// 清理会话消息（参考 Kiro 官方实现）
function sanitizeConversation(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  let sanitized = [...messages]
  sanitized = ensureStartsWithUserMessage(sanitized)
  sanitized = removeEmptyUserMessages(sanitized)
  sanitized = relocateToolResultMessages(sanitized)
  sanitized = removeInvalidToolResultMessages(sanitized)
  sanitized = ensureValidToolUsesAndResults(sanitized)
  sanitized = ensureAlternatingMessages(sanitized)
  sanitized = ensureEndsWithUserMessage(sanitized)
  const validationErrors = validateConversation(sanitized)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid Kiro conversation after sanitization: ${validationErrors.join(', ')}`)
  }
  return sanitized
}

// 按 token 估算成对裁剪 history 最旧消息 (避免后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD)
// 切点保证不破坏 toolUse↔toolResult 配对：assistant(toolUse) 必须连同后续 user(toolResult) 一起裁
// 裁剪后用 ensureStartsWithUserMessage 兜底重新规范化
function trimHistoryByTokens(payload: KiroPayload, maxTokens: number): { trimmed: number; finalTokens: number; iterations: number } {
  let history = payload.conversationState.history
  if (!history || history.length === 0) {
    return { trimmed: 0, finalTokens: estimatePayloadTokens(payload), iterations: 0 }
  }

  let totalTrimmed = 0
  let iterations = 0
  let currentTokens = estimatePayloadTokens(payload)
  const MAX_ITERATIONS = 100 // 防止极端情况死循环

  while (currentTokens > maxTokens && history.length >= 4 && iterations < MAX_ITERATIONS) {
    iterations++
    // 计算安全切点：从 index 0 开始至少裁掉 1 组 (user+assistant)，并连带 toolUse/toolResult 配对
    let cutAt = 0
    while (cutAt < history.length - 2) {
      const msg = history[cutAt]
      // assistant(toolUse) → 下一条 user(toolResult) 必须一起裁，避免配对断裂
      if (isAssistantResponseMessage(msg) && hasToolUses(msg)) {
        cutAt += 2
      } else {
        cutAt += 1
      }
      if (cutAt >= 2) break
    }

    if (cutAt === 0) break // 无法继续裁剪

    history = history.slice(cutAt)
    totalTrimmed += cutAt

    // 裁剪后 history 可能以 assistant 起头 → 补 HELLO 重新规范
    history = ensureStartsWithUserMessage(history)
    payload.conversationState.history = history
    currentTokens = estimatePayloadTokens(payload)
  }

  return { trimmed: totalTrimmed, finalTokens: currentTokens, iterations }
}

// ============= 构建 Kiro API 请求负载（参考 Kiro 官方实现）=============

export function buildKiroPayload(
  content: string,
  modelId: string,
  origin: string,
  history: KiroHistoryMessage[] = [],
  tools: KiroToolWrapper[] = [],
  toolResults: KiroToolResult[] = [],
  images: KiroImage[] = [],
  profileArn?: string,
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number },
  messageOptions?: { cachePoint?: KiroCachePoint | undefined; clientCacheConfig?: unknown; documents?: KiroDocument[]; conversationId?: string; context?: KiroRequestContext },
  additionalModelRequestFields?: Record<string, unknown>
): KiroPayload {
  // 构建当前消息
  const finalContent = content.trim() || (toolResults.length > 0 ? '' : 'Continue')
  
  const currentUserInputMessage: KiroUserInputMessage = {
    content: finalContent,
    modelId,
    origin
  }

  if (images.length > 0) {
    currentUserInputMessage.images = images
  }

  if (messageOptions?.documents?.length) {
    currentUserInputMessage.documents = messageOptions.documents
  }

  if (messageOptions?.cachePoint) {
    currentUserInputMessage.cachePoint = messageOptions.cachePoint
  }

  if (messageOptions?.clientCacheConfig !== undefined) {
    currentUserInputMessage.clientCacheConfig = messageOptions.clientCacheConfig
  }

  // 构建 userInputMessageContext（包含 tools 和 toolResults）
  // 注意：tools 只放在最后一条消息（currentMessage）的 userInputMessageContext 中
  if (tools.length > 0 || toolResults.length > 0) {
    currentUserInputMessage.userInputMessageContext = {}
    if (tools.length > 0) {
      currentUserInputMessage.userInputMessageContext.tools = tools
    }
    if (toolResults.length > 0) {
      currentUserInputMessage.userInputMessageContext.toolResults = toolResults
    }
  }

  if (messageOptions?.context) {
    currentUserInputMessage.userInputMessageContext = {
      ...currentUserInputMessage.userInputMessageContext,
      ...(messageOptions.context.editorState !== undefined ? { editorState: messageOptions.context.editorState } : {}),
      ...(messageOptions.context.shellState !== undefined ? { shellState: messageOptions.context.shellState } : {}),
      ...(messageOptions.context.gitState !== undefined ? { gitState: messageOptions.context.gitState } : {}),
      ...(messageOptions.context.envState !== undefined ? { envState: messageOptions.context.envState } : {}),
      ...(messageOptions.context.additionalContext !== undefined ? { additionalContext: messageOptions.context.additionalContext } : {})
    }
  }

  // 构建 currentMessage
  const currentMessage: KiroHistoryMessage = {
    userInputMessage: currentUserInputMessage
  }

  // 清理并准备所有消息（history + currentMessage）
  const allMessages = [...history, currentMessage]
  const sanitizedMessages = sanitizeConversation(normalizeToolHistory(allMessages, tools))
  
  // 分离 history 和 currentMessage
  // currentMessage 是最后一条消息，history 是其余的
  const sanitizedHistory = sanitizedMessages.slice(0, -1)
  let finalCurrentMessage = sanitizedMessages.at(-1)!

  // 确保 currentMessage 是 user 消息（sanitizeConversation 保证以 user 消息结束）
  // 并确保包含 tools
  if (!finalCurrentMessage.userInputMessage) {
    // 如果清理后最后一条不是 user 消息，创建一个新的
    finalCurrentMessage = {
      userInputMessage: {
        content: finalContent || 'Continue',
        modelId,
        origin
      }
    }
  }
  
  finalCurrentMessage.userInputMessage!.userInputMessageContext = {
    ...finalCurrentMessage.userInputMessage!.userInputMessageContext,
    ...(tools.length > 0 ? { tools } : {})
  }

  // conversationId 稳定化：同一会话的多轮请求复用同一个 conversationId
  // 优先级：客户端显式 conversation_id → sessionHint（header 提取）→ history fingerprint → 新 UUID
  const conversationId = resolveConversationId(history, messageOptions?.conversationId)
  const payload: KiroPayload = {
    conversationState: {
      agentContinuationId: uuidv4(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: {
        userInputMessage: finalCurrentMessage.userInputMessage!
      },
      history: sanitizedHistory.length > 0 ? sanitizedHistory : undefined
    }
  }

  if (profileArn !== undefined) {
    payload.profileArn = profileArn
  }

  if (inferenceConfig && (inferenceConfig.maxTokens || inferenceConfig.temperature !== undefined || inferenceConfig.topP !== undefined)) {
    payload.inferenceConfig = {}
    if (inferenceConfig.maxTokens) {
      payload.inferenceConfig.maxTokens = inferenceConfig.maxTokens
    }
    if (inferenceConfig.temperature !== undefined) {
      payload.inferenceConfig.temperature = inferenceConfig.temperature
    }
    if (inferenceConfig.topP !== undefined) {
      payload.inferenceConfig.topP = inferenceConfig.topP
    }
  }

  // additionalModelRequestFields（thinking 等模型级参数）
  if (additionalModelRequestFields && Object.keys(additionalModelRequestFields).length > 0) {
    payload.additionalModelRequestFields = additionalModelRequestFields
  }

  // ====== 第一阶段：按 token 估算成对裁剪旧 history ======
  // 避免 Kiro 后端 CONTENT_LENGTH_EXCEEDS_THRESHOLD（token 维度的拒绝）
  // 注意：byte size 充足但 token 超限是常见情况（长对话+大量小消息）
  // effectiveLimit 按模型 context window 自动算：ctx - tokenBufferReserve（开关启用时，默认 20K）
  // 例：sonnet-4.5 (200K) → 180K, sonnet-4.5 with 1M beta → 980K
  // 开关关闭时完全跳过，超出 context window 由 Kiro 后端原样返回错误
  if (enableTokenBufferReserve) {
    const effectiveTokenLimit = getEffectiveTokenLimit(modelId)
    const tokenTrimResult = trimHistoryByTokens(payload, effectiveTokenLimit)
    if (tokenTrimResult.trimmed > 0) {
      const modelCtx = getModelContextLength(modelId)
      console.log(`[KiroPayload] Trimmed ${tokenTrimResult.trimmed} oldest history messages by token estimate (≈${tokenTrimResult.finalTokens.toLocaleString()} / ${effectiveTokenLimit.toLocaleString()} tokens [model ctx ${modelCtx.toLocaleString()} - buffer ${tokenBufferReserve.toLocaleString()}], ${tokenTrimResult.iterations} iter)`)
    }
  }

  // ====== 第二阶段：按 byte 截断 tool result 内容 ======
  // 避免 HTTP body 过大被 Kiro 网关拒绝
  // 用户可在高级设置中调整限制值（默认 1536KB = 1.5MB）
  const PAYLOAD_SIZE_LIMIT = (payloadSizeLimitKB || 1536) * 1024
  const TOOL_RESULT_TRUNCATE_LENGTH = 4000
  let initialPayloadSize = JSON.stringify(payload).length
  if (initialPayloadSize > PAYLOAD_SIZE_LIMIT && payload.conversationState.history) {
    const historyMessages = payload.conversationState.history
    let truncatedCount = 0
    for (const message of historyMessages) {
      if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
      const userToolResults = message.userInputMessage?.userInputMessageContext?.toolResults
      if (!userToolResults) continue
      for (const toolResult of userToolResults) {
        if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
        if (!toolResult.content) continue
        for (const contentItem of toolResult.content) {
          if (initialPayloadSize <= PAYLOAD_SIZE_LIMIT) break
          if (contentItem.text && contentItem.text.length > TOOL_RESULT_TRUNCATE_LENGTH) {
            const originalLen = contentItem.text.length
            contentItem.text = `${contentItem.text.slice(0, TOOL_RESULT_TRUNCATE_LENGTH)}\n\n[Truncated by proxy: original ${originalLen} chars]`
            truncatedCount++
            initialPayloadSize = JSON.stringify(payload).length
          }
        }
      }
    }
    if (truncatedCount > 0) {
      console.log(`[KiroPayload] Truncated ${truncatedCount} large tool results to fit payload size limit (final size: ${initialPayloadSize} bytes)`)
    }
  }

  // 调试日志
  console.log(`[KiroPayload] Built payload (native history mode):`, {
    contentLength: finalContent.length,
    originalHistoryLength: history.length,
    sanitizedHistoryLength: sanitizedHistory.length,
    toolsCount: tools.length,
    toolResultsCount: toolResults.length,
    hasProfileArn: payload.profileArn !== undefined,
    hasThinking: !!additionalModelRequestFields?.thinking,
    payloadSize: initialPayloadSize
  })

  return payload
}

// conversationId 稳定化：同一会话的多轮请求复用同一个 conversationId
// 策略：sessionHint（由 proxyServer 从 header/body 提取）→ 稳定映射到固定 conversationId
// 无 sessionHint 时用 history fingerprint 兜底
const conversationCache = new Map<string, { id: string; timestamp: number }>()
const CONVERSATION_CACHE_TTL = 2 * 60 * 60 * 1000 // 2 小时
const CONVERSATION_CACHE_MAX = 1000

export function cleanupConversationCache(now: number = Date.now()): number {
  let removed = 0
  for (const [key, entry] of conversationCache) {
    if (now - entry.timestamp >= CONVERSATION_CACHE_TTL) {
      conversationCache.delete(key)
      removed++
    }
  }
  while (conversationCache.size > CONVERSATION_CACHE_MAX) {
    conversationCache.delete(conversationCache.keys().next().value!)
    removed++
  }
  return removed
}

function resolveConversationId(history: KiroHistoryMessage[], sessionHint?: string): string {
  // sessionHint 已包含 API Key hash 前缀（由 proxyServer 注入），天然隔离不同用户
  const hint = typeof sessionHint === 'string' && sessionHint.length > 0 ? sessionHint : undefined
  const source = hint || fingerprintFromHistory(history)
  if (!source) return uuidv4()
  // Hash the entire identity, including its namespace, instead of retaining an
  // arbitrarily large body field or truncating distinct sessions to one prefix.
  const key = createHash('sha256').update(hint ? 'hint:' : 'history:').update(source).digest('hex')

  const now = Date.now()
  cleanupConversationCache(now)
  const cached = conversationCache.get(key)
  if (cached) {
    cached.timestamp = now
    conversationCache.delete(key)
    conversationCache.set(key, cached)
    return cached.id
  }

  const id = uuidv4()
  conversationCache.set(key, { id, timestamp: now })
  // Map insertion order is the access order: hits move to the end above.
  while (conversationCache.size > CONVERSATION_CACHE_MAX) conversationCache.delete(conversationCache.keys().next().value!)
  return id
}

function fingerprintFromHistory(history: KiroHistoryMessage[]): string | undefined {
  if (history.length === 0) return undefined
  const fp = history.slice(0, 2).map(msg =>
    `${msg.userInputMessage?.content || ''}|${msg.assistantResponseMessage?.content || ''}`
  ).join('::')
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(fp).digest('hex').slice(0, 32)
}

// 清除所有内存缓存
export function clearAllCaches(): { conversation: number; model: number } {
  const conversationCount = conversationCache.size
  conversationCache.clear()
  return { conversation: conversationCount, model: 0 }
}

// machineId 稳定生成缓存（用于无绑定 machineId 且 K-Proxy 不可用时的兆底）
const fallbackMachineIds = new Map<string, string>()

function generateStableMachineId(accountId: string): string {
  const cached = fallbackMachineIds.get(accountId)
  if (cached) return cached
  const crypto = require('crypto')
  const hash = crypto.createHash('sha256').update(`kiro-device-${accountId}`).digest('hex')
  fallbackMachineIds.set(accountId, hash)
  return hash
}

// 获取账号绑定的 Machine ID（保证永远不为空）
function getAccountMachineId(accountId: string, accountMachineId?: string): string {
  if (accountMachineId) return accountMachineId
  const kproxyService = getKProxyService()
  if (kproxyService) {
    const deviceId = kproxyService.getDeviceIdForAccount(accountId)
    if (deviceId) return deviceId
  }
  return generateStableMachineId(accountId)
}

function getAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  if (signal?.reason) return new Error(String(signal.reason))
  return new Error('Request aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortError(signal)
}

// Current IDE Runtime protocol. Old saved endpoint preferences migrate here; never
// replay a partially consumed request against an unrelated service or account.
export async function callKiroApiStream(
  account: ProxyAccount,
  payload: KiroPayload,
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void | Promise<void>,
  onComplete: (usage: KiroUsage) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
  _preferredEndpoint?: 'runtime' | 'codewhisperer' | 'amazonq' | 'amazonq-cli'
): Promise<void> {
  await executeRuntimeRequest({
    account, payload, onChunk, onComplete, onError, signal,
    agentMode: configuredAgentMode,
    estimateTokens: countTokens,
    fetcher: (url, options) => fetchWithProxy(url, options, account),
    onEventCounts: logStreamEvents ? counts => proxyLogger.debug('Kiro', 'Runtime stream event counts', counts) : undefined
  })
}

// Used by prompt cache estimation as well as legacy API consumers.
export function estimateTokens(text: string): number {
  return countTokens(text)
}

// 非流式调用（等待完整响应）
export async function callKiroApi(
  account: ProxyAccount,
  payload: KiroPayload,
  signal?: AbortSignal
): Promise<{
  content: string
  toolUses: KiroToolUse[]
  usage: KiroUsage
  reasoningContent?: { text?: string; signature?: string; redactedContent?: string }
}> {
  return new Promise((resolve, reject) => {
    let content = ''
    let reasoningText = ''
    let reasoningSignature: string | undefined
    let redactedContent = ''
    const toolUses: KiroToolUse[] = []
    let usage: KiroUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }

    callKiroApiStream(
      account,
      payload,
      (text, toolUse, isThinking, signature, redacted) => {
        if (isThinking) {
          if (text) reasoningText += text
          if (signature) reasoningSignature = signature
          if (redacted) redactedContent += redacted
        } else {
          content += text
        }
        if (toolUse) {
          toolUses.push(toolUse)
        }
      },
      (u) => {
        usage = u
        if (reasoningText || redactedContent) {
          const rc: { text?: string; signature?: string; redactedContent?: string } = {}
          if (reasoningText) rc.text = reasoningText
          if (reasoningSignature) rc.signature = reasoningSignature
          if (redactedContent) rc.redactedContent = redactedContent
          resolve({ content, toolUses, usage, reasoningContent: rc })
          return
        }
        resolve({ content, toolUses, usage })
      },
      reject,
      signal
    ).catch(reject)
  })
}

// 根据账号区域获取 Q Service 端点（官方插件使用 q.{region}.amazonaws.com）
function getQServiceEndpoint(region?: string): string {
  if (region?.startsWith('eu-')) return 'https://q.eu-central-1.amazonaws.com'
  return 'https://q.us-east-1.amazonaws.com'
}

// 根据账号区域获取 CodeWhisperer Runtime 端点
function getCodeWhispererEndpoint(region?: string): string {
  if (region?.startsWith('eu-')) return 'https://codewhisperer.eu-central-1.amazonaws.com'
  return 'https://codewhisperer.us-east-1.amazonaws.com'
}

/**
 * Enterprise 账号获取 profileArn（通过 CodeWhisperer Runtime 的 /ListAvailableProfiles）
 * 官方 IDE 在认证后通过此 API 获取可用 profiles，用户选择后存储 ARN。
 * 反代自动取第一个 profile。
 */
export async function fetchEnterpriseProfileArn(account: ProxyAccount): Promise<string | undefined> {
  const baseUrl = getCodeWhispererEndpoint(account.region)
  const url = `${baseUrl}/ListAvailableProfiles`
  const machineId = getAccountMachineId(account.id, account.machineId)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${account.accessToken}`,
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'user-agent': getKiroUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }

  // 获取该账号类型对应的备用 ARN（403 时兜底，避免每次请求都重复尝试）
  const fallbackArn = resolveProfileArn(account)

  try {
    const response = await fetchWithProxy(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    }, account)

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      console.error(`[KiroAPI] ListAvailableProfiles failed: ${response.status}`, errBody.slice(0, 200))
      // 403 = 无权限（BuilderId/Social 账号不支持此 API）→ 返回备用 ARN 作为缓存，不再重复尝试
      if (response.status === 403 && fallbackArn) {
        console.log(`[KiroAPI] Using fallback profileArn for ${account.provider || 'unknown'}: ${fallbackArn}`)
        return fallbackArn
      }
      return undefined
    }

    const data = await response.json() as { profiles?: Array<{ arn?: string; profileName?: string }> }
    const profiles = data.profiles || []
    if (profiles.length === 0) {
      console.warn('[KiroAPI] ListAvailableProfiles: no profiles returned')
      return undefined
    }

    const arn = profiles[0].arn
    if (arn) {
      console.log('[KiroAPI] Enterprise profile resolved')
      if (account.id) profileArnPersistCallback?.(account.id, arn)
    }
    return arn || undefined
  } catch (error) {
    console.error('[KiroAPI] fetchEnterpriseProfileArn error:', error)
    return undefined
  }
}

// 获取 Kiro 官方模型列表（支持分页，与官方插件一致传递 profileArn）
export async function fetchKiroModels(account: ProxyAccount, signal?: AbortSignal): Promise<KiroModel[]> {
  const allModels: KiroModel[] = []
  const seenTokens = new Set<string>()
  let nextToken: string | undefined
  const enterprise = account.provider === 'Enterprise' || account.provider === 'ExternalIdp' || account.authMethod === 'external_idp'
  // Control-plane identity differs from Runtime defaults: absence of a profile
  // must not manufacture a US profile and override the account's Region.
  const profileArn = account.profileArn && !isPlaceholderProfileArn(account.profileArn) && !/^arn:aws:codewhisperer:[a-z0-9-]+:610548660232:profile\/VNECVYCYYAWN$/.test(account.profileArn) ? account.profileArn : undefined
  if (enterprise && !profileArn) throw new ModelRequestError('An authenticated organization profile is required to load models. Sign in again and select a profile.')
  const identity = { ...account, profileArn }
  // IDE 1.4.13 uses AWS JSON 1.0 POST /, despite the SDK's retained REST
  // trait. A failed later page must not become an apparently complete catalog.
  for (let page = 0; page < 10; page++) {
    throwIfAborted(signal)
    const data = await requestControlPlane<{ models?: KiroModel[]; nextToken?: string }>(identity, 'ListAvailableModels', { nextToken }, {
      signal,
      fetch: ((url, init) => fetchWithProxy(String(url), init, account)) as typeof fetch
    })
    throwIfAborted(signal)
    if (!Array.isArray(data.models) || data.models.some(model => !model || typeof model !== 'object' || typeof model.modelId !== 'string' || !model.modelId.trim())) {
      throw new Error('Kiro model catalog returned an invalid model list')
    }
    allModels.push(...data.models)
    if (data.nextToken === undefined || data.nextToken === null || data.nextToken === '') return allModels
    if (typeof data.nextToken !== 'string' || seenTokens.has(data.nextToken)) throw new Error('Kiro model catalog returned invalid pagination')
    seenTokens.add(data.nextToken)
    nextToken = data.nextToken
  }
  throw new Error('Kiro model catalog exceeded the pagination limit')
}

// 订阅计划信息
export interface SubscriptionPlan {
  name: string  // KIRO_FREE, KIRO_PRO, KIRO_PRO_PLUS, KIRO_POWER
  qSubscriptionType: string
  description: {
    title: string
    billingInterval: string
    featureHeader: string
    features: string[]
  }
  pricing: {
    amount: number
    currency: string
  }
}

// 订阅列表响应
export interface SubscriptionListResponse {
  disclaimer?: string[]
  subscriptionPlans?: SubscriptionPlan[]
}

// 订阅请求专用 User-Agent（匹配 Kiro IDE 实际报文格式）
const KIRO_SUBSCRIPTION_VERSION = '0.12.155'

function getSubscriptionUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}-${machineId}` : `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`
  return `aws-sdk-js/1.0.0 ua/2.1 os/win32#10.0.19043 lang/js md/nodejs#22.22.0 api/codewhispererruntime#1.0.0 m/N,E ${suffix}`
}

function getSubscriptionAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}-${machineId}` : `KiroIDE-${KIRO_SUBSCRIPTION_VERSION}`
  return `aws-sdk-js/1.0.0 ${suffix}`
}

// 获取可用订阅列表
export async function fetchAvailableSubscriptions(account: ProxyAccount): Promise<SubscriptionListResponse> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/listAvailableSubscriptions`
  const machineId = getAccountMachineId(account.id, account.machineId)
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }

  const profileArn = resolveProfileArn(account)
  const body = JSON.stringify(profileArn ? { profileArn } : {})

  console.log(`[KiroAPI] ListAvailableSubscriptions [${account.email || account.id.slice(0, 8)}]`, {
    url,
    hasProfileArn: profileArn !== undefined
  })

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body }, account)
    const responseText = await response.text()
    console.log(`[KiroAPI] ListAvailableSubscriptions → ${response.status}`, JSON.parse(responseText))
    
    if (!response.ok) {
      return {}
    }

    return JSON.parse(responseText)
  } catch (error) {
    console.error('[KiroAPI] ListAvailableSubscriptions error:', error)
    return {}
  }
}

// 订阅 Token 响应
export interface SubscriptionTokenResponse {
  encodedVerificationUrl?: string
  status?: string
  token?: string | null
  message?: string
}

// 获取订阅管理/支付链接
export async function fetchSubscriptionToken(
  account: ProxyAccount,
  subscriptionType?: string
): Promise<SubscriptionTokenResponse> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/CreateSubscriptionToken`
  const machineId = getAccountMachineId(account.id, account.machineId)
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }

  const profileArn = resolveProfileArn(account)

  // clientToken 是必需参数；profileArn 仅在解析出有效值时附带
  const payload: Record<string, string> = {
    clientToken: uuidv4(),
    provider: 'STRIPE'
  }
  if (profileArn) {
    payload.profileArn = profileArn
  }
  if (subscriptionType) {
    payload.subscriptionType = subscriptionType
  }

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body: JSON.stringify(payload) }, account)
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('[KiroAPI] CreateSubscriptionToken failed:', response.status, errorData)
      return { message: errorData.message || `Request failed with status ${response.status}` }
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('[KiroAPI] CreateSubscriptionToken error:', error)
    return { message: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 设置用户偏好（超额开启/关闭）
export async function setUserPreference(
  account: ProxyAccount,
  overageStatus: 'ENABLED' | 'DISABLED'
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = getQServiceEndpoint(account.region)
  const url = `${baseUrl}/setUserPreference`
  const machineId = getAccountMachineId(account.id, account.machineId)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    'user-agent': getSubscriptionUserAgent(machineId),
    'x-amz-user-agent': getSubscriptionAmzUserAgent(machineId),
    'amz-sdk-invocation-id': uuidv4(),
    'amz-sdk-request': 'attempt=1; max=1'
  }

  const profileArn = resolveProfileArn(account)
  const bodyPayload: Record<string, unknown> = {
    overageConfiguration: { overageStatus }
  }
  if (profileArn) {
    bodyPayload.profileArn = profileArn
  }
  const body = JSON.stringify(bodyPayload)

  try {
    const response = await fetchWithProxy(url, { method: 'POST', headers, body }, account)
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 200)}` }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
