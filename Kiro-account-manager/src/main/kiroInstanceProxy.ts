import type { KiroInstanceProxy, KiroInstanceProxyInput } from '../shared/kiroInstances'

const SUPPORTED = new Set(['http:', 'https:', 'socks4:', 'socks5:'])

/**
 * Validate and canonicalize a profile proxy. This intentionally accepts the
 * same URL shapes as the account proxy UI, while keeping the instance API
 * narrow and rejecting PAC, file and custom protocols.
 */
export function normalizeKiroInstanceProxy(input: KiroInstanceProxyInput): KiroInstanceProxy | undefined {
  if (input === undefined || input === null || input === '') return undefined
  const raw = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : ''
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 2048 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('实例代理地址无效。')
  // Match the account proxy field's convenience forms (host:port and
  // protocol:host:port) without accepting a scheme other than the allowlist.
  let candidate = trimmed
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const scheme = candidate.match(/^([a-z][a-z0-9+.-]*):\/*(.+)$/i)
    candidate = scheme ? `${scheme[1]}://${scheme[2]}` : `http://${candidate}`
  }
  let parsed: URL
  try { parsed = new URL(candidate) } catch { throw new Error('实例代理地址无效，请使用 protocol://host:port。') }
  if (!SUPPORTED.has(parsed.protocol) || !parsed.hostname || parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)) {
    throw new Error('实例代理仅支持 http、https、socks4、socks5 及有效端口。')
  }
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) throw new Error('实例代理地址不能包含路径、查询参数或片段。')
  // URL serialisation percent-encodes credentials and makes the persisted
  // value stable. Credentials are retained for compatibility with existing
  // proxy URL rules, but callers must redact them before displaying/logging.
  const url = parsed.toString().replace(/\/$/, '')
  return { url }
}

export function redactKiroInstanceProxy(proxy?: KiroInstanceProxy): string | undefined {
  if (!proxy) return undefined
  try {
    const parsed = new URL(proxy.url)
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  } catch { return '[configured]' }
}
