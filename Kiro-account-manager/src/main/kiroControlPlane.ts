// Kiro IDE 1.4.13 / Agent 1.1.530 uses AWS JSON 1.0, regardless of
// the REST traits retained in its Smithy schemas. No refresh or region retry.
import { resolveIdentity } from '../shared/authIdentity'

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

export class ControlPlaneError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, status?: number) {
    super(`Kiro account service: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'ControlPlaneError'
    this.code = code
    this.status = status
  }
}

export function buildControlPlaneRequest(identity: ControlPlaneIdentity, operation: Operation, input: Record<string, unknown>): {
  url: string; method: 'POST'; headers: Record<string, string>; body: string
} {
  if (!['GetUsageLimits', 'ListAvailableModels'].includes(operation)) throw new ControlPlaneError('unsupported_operation')
  if (!safeText(identity.accessToken) || identity.accessToken.length > 131072) throw new ControlPlaneError('invalid_access_token')
  let region = identity.region || 'us-east-1'
  if (identity.profileArn) {
    const match = /^arn:(?:aws|aws-us-gov|aws-cn):(?:kiro|codewhisperer|q):([a-z0-9-]+):\d{12}:profile\/[A-Za-z0-9_-]+$/.exec(identity.profileArn)
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
  if (identity.authMethod === 'external_idp' || identity.provider === 'ExternalIdp') {
    if (identity.authMethod && identity.authMethod !== 'external_idp') throw new ControlPlaneError('invalid_identity')
    headers.TokenType = 'EXTERNAL_IDP'
  } else {
    const resolved = resolveIdentity(identity)
    if (!resolved.ok) throw new ControlPlaneError('invalid_identity')
    if (resolved.authMethod === 'IdC') headers.TokenType = 'SSO_OIDC'
  }
  // Only current operation fields may cross this boundary. Never send client
  // secrets, caller-supplied profiles, refresh tokens or arbitrary extra fields.
  const body: Record<string, unknown> = { origin: 'AI_EDITOR' }
  if (identity.profileArn) body.profileArn = identity.profileArn
  if (operation === 'GetUsageLimits' && input.isEmailRequired === true) body.isEmailRequired = true
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
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new ControlPlaneError(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'access_denied' : response.status === 429 ? 'rate_limited' : 'request_failed', response.status)
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
