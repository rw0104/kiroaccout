// Kiro IDE 1.4.26 / Agent 1.1.571 uses AWS JSON 1.0, regardless of
// the REST traits retained in its Smithy schemas. No refresh or region retry.
import { resolveIdentity } from '../shared/authIdentity'
import { defaultKiroProfile } from '../shared/kiroProfiles'

export interface ControlPlaneIdentity {
  accessToken: string
  region?: string
  profileArn?: string
  provider?: string
  authMethod?: string
}

type Operation = 'GetUsageLimits' | 'ListAvailableModels'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() &&
  !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

export type ControlPlaneFailureReason = 'serialization' | 'unknown_operation' | 'validation' | 'missing_resource_type' | 'invalid_profile' | 'token'
interface ServiceDiagnostic { serviceCode?: string; reason?: ControlPlaneFailureReason }
const ERROR_BODY_MAXIMUM = 16 * 1024
const SERVICE_CODES: Record<string, { serviceCode: string; reason?: ControlPlaneFailureReason }> = {
  serializationexception: { serviceCode: 'SerializationException', reason: 'serialization' },
  serializationerror: { serviceCode: 'SerializationError', reason: 'serialization' },
  unknownoperationexception: { serviceCode: 'UnknownOperationException', reason: 'unknown_operation' },
  unknownoperationerror: { serviceCode: 'UnknownOperationError', reason: 'unknown_operation' },
  validationexception: { serviceCode: 'ValidationException', reason: 'validation' },
  validationerror: { serviceCode: 'ValidationError', reason: 'validation' },
  invalidparameterexception: { serviceCode: 'InvalidParameterException', reason: 'validation' },
  invalidrequestexception: { serviceCode: 'InvalidRequestException', reason: 'validation' },
  missingrequiredparameterexception: { serviceCode: 'MissingRequiredParameterException', reason: 'validation' },
  invalidprofileexception: { serviceCode: 'InvalidProfileException', reason: 'invalid_profile' },
  invalidprofilearnexception: { serviceCode: 'InvalidProfileArnException', reason: 'invalid_profile' },
  invalidtokenexception: { serviceCode: 'InvalidTokenException', reason: 'token' },
  invalid_token: { serviceCode: 'InvalidTokenException', reason: 'token' },
  expiredtokenexception: { serviceCode: 'ExpiredTokenException', reason: 'token' },
  unrecognizedclientexception: { serviceCode: 'UnrecognizedClientException', reason: 'token' },
  accessdeniedexception: { serviceCode: 'AccessDeniedException' },
  unauthorizedexception: { serviceCode: 'UnauthorizedException', reason: 'token' },
  throttlingexception: { serviceCode: 'ThrottlingException' }
}
const REASON_ADVICE: Record<ControlPlaneFailureReason, string> = {
  serialization: '请求格式与客户端接口不匹配，请更新管理器后重试',
  unknown_operation: '客户端接口尚不受支持，请更新管理器后重试',
  validation: '请求参数未通过服务校验，请更新管理器后重试',
  missing_resource_type: '请求缺少额度资源类型，请更新管理器后重试',
  invalid_profile: '管理器的账户配置标识不匹配，请更新管理器后重试',
  token: '访问凭证无效或已过期，请重新授权该账户'
}

function approvedServiceCode(value: unknown): ServiceDiagnostic {
  if (typeof value !== 'string' || value.length > 256) return {}
  const name = value.trim().split('#').at(-1)?.split(':')[0].toLowerCase() ?? ''
  return Object.hasOwn(SERVICE_CODES, name) ? { ...SERVICE_CODES[name] } : {}
}

/** Server text is used only to match known field/phrase patterns, never echoed or retained. */
function serviceDiagnostic(header: string | null, body?: unknown): ServiceDiagnostic {
  const envelopes = object(body) ? [body, ...(object(body.error) ? [body.error] : []), ...(object(body.Error) ? [body.Error] : [])] : []
  let diagnostic = approvedServiceCode(header)
  if (!diagnostic.serviceCode) {
    for (const envelope of envelopes) {
      for (const key of ['__type', 'errorCode', 'code', 'Code', 'error', 'Error']) {
        const candidate = approvedServiceCode(envelope[key])
        if (candidate.serviceCode) { diagnostic = candidate; break }
      }
      if (diagnostic.serviceCode) break
    }
  }
  if (!diagnostic.serviceCode) return diagnostic
  for (const envelope of envelopes) {
    const value = envelope.message ?? envelope.Message
    if (typeof value !== 'string' || value.length > ERROR_BODY_MAXIMUM) continue
    if (['AccessDeniedException', 'ValidationException', 'InvalidRequestException'].includes(diagnostic.serviceCode) &&
        /^(?:invalid(?: access)? token|(?:the )?(?:access )?token (?:is )?(?:invalid|expired))\.?$/i.test(value.trim())) {
      return { ...diagnostic, reason: 'token' }
    }
    if (diagnostic.reason === 'validation' || diagnostic.reason === 'serialization') {
      if (/^invalid profile(?:Arn)?\.?$/i.test(value.trim())) return { ...diagnostic, reason: 'invalid_profile' }
      if (/^(?:missing|required)(?: required)?(?: (?:field|parameter|member))?[:\s]+['"]?resourceType['"]?\.?$/i.test(value.trim()) ||
          /\bresourceType\b[^\r\n]{0,80}\b(?:is required|must not be null|cannot be null)\b/i.test(value) ||
          /\bValue null at ['"]resourceType['"][^\r\n]{0,120}\b(?:must not be null|required)\b/i.test(value)) {
        return { ...diagnostic, reason: 'missing_resource_type' }
      }
    }
  }
  return diagnostic
}

export class ControlPlaneError extends Error {
  readonly code: string
  readonly status?: number
  readonly serviceCode?: string
  readonly reason?: ControlPlaneFailureReason
  constructor(code: string, status?: number, diagnostic: ServiceDiagnostic = {}) {
    const approved = approvedServiceCode(diagnostic.serviceCode)
    const reason = approved.serviceCode && diagnostic.reason && Object.hasOwn(REASON_ADVICE, diagnostic.reason) ? diagnostic.reason : approved.reason
    super(`Kiro account service: ${code}${status ? ` (HTTP ${status})` : ''}${approved.serviceCode ? ` [${approved.serviceCode}]` : ''}${reason ? `：${REASON_ADVICE[reason]}` : ''}`)
    this.name = 'ControlPlaneError'
    this.code = code
    this.status = status
    this.serviceCode = approved.serviceCode
    this.reason = reason
  }
}

export function buildControlPlaneRequest(identity: ControlPlaneIdentity, operation: Operation, input: Record<string, unknown>): {
  url: string; method: 'POST'; headers: Record<string, string>; body: string
} {
  if (!['GetUsageLimits', 'ListAvailableModels'].includes(operation)) throw new ControlPlaneError('unsupported_operation')
  if (!safeText(identity.accessToken) || identity.accessToken.length > 131072) throw new ControlPlaneError('invalid_access_token')
  if (identity.region !== undefined && !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(identity.region)) throw new ControlPlaneError('invalid_region')
  const external = identity.authMethod === 'external_idp' || identity.provider === 'ExternalIdp'
  const resolved = external ? undefined : resolveIdentity(identity)
  if ((external && identity.authMethod && identity.authMethod !== 'external_idp') || (resolved && !resolved.ok)) throw new ControlPlaneError('invalid_identity')
  // The SDK field is optional, but the service validates the resolved profile.
  // Official personal identities fill their public default before calling CPS.
  const profileArn = identity.profileArn || defaultKiroProfile(resolved?.ok ? resolved.provider : identity.provider ?? '')
  if (!profileArn) throw new ControlPlaneError('missing_profile')
  let region = identity.region || 'us-east-1'
  if (profileArn) {
    const match = /^arn:(?:aws|aws-us-gov|aws-cn):(?:kiro|codewhisperer|q):([a-z0-9-]+):\d{12}:profile\/[A-Za-z0-9_-]+$/.exec(profileArn)
    if (!match) throw new ControlPlaneError('invalid_profile')
    region = match[1]
  }
  if (!/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(region)) throw new ControlPlaneError('invalid_region')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${identity.accessToken}`,
    'Content-Type': 'application/x-amz-json-1.0',
    'x-amz-target': `KiroControlPlaneBearerService.${operation}`,
    'User-Agent': 'kiroaccout',
    'amz-sdk-request': 'attempt=1; max=1'
  }
  if (external) {
    headers.TokenType = 'EXTERNAL_IDP'
  } else {
    if (resolved?.ok && resolved.authMethod === 'IdC') headers.TokenType = 'SSO_OIDC'
  }
  // Only current operation fields may cross this boundary. Never send client
  // secrets, caller-supplied profiles, refresh tokens or arbitrary extra fields.
  // The current Kiro client leaves the optional GetUsageLimits schema fields
  // out of this command. Keep the wire limited to the fields observed in the
  // current AWS JSON request; the legacy CBOR route owns its own input shape.
  const body: Record<string, unknown> = { origin: 'AI_EDITOR', profileArn }
  if (operation === 'ListAvailableModels' && input.nextToken !== undefined) {
    if (!safeText(input.nextToken) || input.nextToken.length > 16384) throw new ControlPlaneError('invalid_next_token')
    body.nextToken = input.nextToken
  }
  return { url: `https://management.${region}.kiro.dev/`, method: 'POST', headers, body: JSON.stringify(body) }
}

export async function requestControlPlane<T>(identity: ControlPlaneIdentity, operation: Operation, input: Record<string, unknown>, options: {
  fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number
} = {}): Promise<T> {
  const request = buildControlPlaneRequest(identity, operation, input)
  const controller = new AbortController()
  const abort = (): void => controller.abort(new ControlPlaneError('cancelled'))
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      void reader?.cancel().catch(() => {})
      reject(controller.signal.reason)
    }
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => controller.abort(new ControlPlaneError('timeout')), options.timeoutMs ?? 15000)
  })
  const execute = async (): Promise<T> => {
    if (controller.signal.aborted) throw controller.signal.reason
    const response = await (options.fetch ?? globalThis.fetch)(request.url, { ...request, signal: controller.signal, redirect: 'error' })
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      throw controller.signal.reason
    }
    if (!response.ok) {
      const code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'access_denied' : response.status === 429 ? 'rate_limited' : 'request_failed'
      const header = response.headers.get('x-amzn-errortype')
      let diagnostic = serviceDiagnostic(header)
      // Preserve existing auth/rate-limit classification without waiting for a
      // potentially unbounded error body. Other failures get bounded diagnosis.
      if ([401, 403, 429].includes(response.status) || Number(response.headers.get('content-length')) > ERROR_BODY_MAXIMUM || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw new ControlPlaneError(code, response.status, diagnostic)
      }
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > ERROR_BODY_MAXIMUM) {
            void reader.cancel().catch(() => {})
            throw new ControlPlaneError(code, response.status, diagnostic)
          }
          chunks.push(part.value)
        }
        if (controller.signal.aborted) throw controller.signal.reason
        try {
          const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
          diagnostic = serviceDiagnostic(header, body)
        } catch { /* An absent/invalid envelope adds no public error detail. */ }
        throw new ControlPlaneError(code, response.status, diagnostic)
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (error instanceof ControlPlaneError) throw error
        throw new ControlPlaneError(code, response.status, diagnostic)
      } finally { reader.releaseLock(); reader = undefined }
    }
    const maximum = 4 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > maximum || !response.body) throw new ControlPlaneError('invalid_response')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > maximum) { await reader.cancel(); throw new ControlPlaneError('response_too_large') }
        chunks.push(part.value)
      }
      if (controller.signal.aborted) throw controller.signal.reason
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
      if (!object(value)) throw new ControlPlaneError('invalid_response')
      return value as T
    } finally { reader.releaseLock() }
  }
  try { return await Promise.race([execute(), cancelled]) }
  catch (error) {
    if (error instanceof ControlPlaneError) throw error
    throw new ControlPlaneError('invalid_response_or_transport')
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
