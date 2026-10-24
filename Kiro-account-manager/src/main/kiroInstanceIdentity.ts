import { buildControlPlaneRequest } from './kiroControlPlane'
import type { InstanceAccountCredentials } from './kiroInstanceAccounts'

export interface KiroInstanceIdentityOptions {
  /** Host may supply its proxy-aware fetch; tests supply a fully offline transport. */
  fetch?: typeof globalThis.fetch
}
const TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 1024 * 1024
const nonempty = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

async function readIdentity(response: Response, signal: AbortSignal): Promise<{ userId: string } | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted || !response.ok || Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
      cancel()
      return null
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BODY_BYTES) { cancel(); return null }
      chunks.push(part.value)
    }
    if (signal.aborted) return null
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))
    return object(value) && object(value.userInfo) && nonempty(value.userInfo.userId, 4096) ? { userId: value.userInfo.userId } : null
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/**
 * Official 1.4.13 ControlPlane AWS JSON 1.0 wire (see lifecycle evidence §6).
 * Authenticates only the supplied access token. Never refreshes, retries, falls
 * back to another service, persists credentials, or logs a request/response.
 */
export async function verifyKiroInstanceIdentity(
  credentials: Pick<InstanceAccountCredentials, 'accessToken' | 'provider' | 'authMethod' | 'region' | 'profileArn'>,
  options: KiroInstanceIdentityOptions = {}
): Promise<{ userId: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  try {
    if (!nonempty(credentials.accessToken, 131072)) return null
    const wire = buildControlPlaneRequest(credentials, 'GetUsageLimits', {})
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null) }, TIMEOUT_MS)
    })
    const request = async () => {
      const response = await (options.fetch ?? globalThis.fetch)(wire.url, {
        ...wire, signal: controller.signal, redirect: 'error'
      })
      return readIdentity(response, controller.signal)
    }
    return await Promise.race([request(), timeout])
  } catch { return null }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
