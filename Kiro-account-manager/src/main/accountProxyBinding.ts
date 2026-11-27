const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Account routing belongs to saved configuration, independently of proxy-pool membership. */
export function resolveAccountProxyUrl(data: unknown, accountId: unknown): string | undefined {
  if (!record(data) || typeof accountId !== 'string' || !accountId ||
      !record(data.accountProxyBindings) || !record(data.proxyPool) ||
      !Object.hasOwn(data.accountProxyBindings, accountId)) return undefined
  const proxyId = data.accountProxyBindings[accountId]
  if (typeof proxyId !== 'string' || !proxyId || !Object.hasOwn(data.proxyPool, proxyId)) return undefined
  const proxy = data.proxyPool[proxyId]
  if (!record(proxy) || proxy.enabled !== true || proxy.status === 'dead' || typeof proxy.url !== 'string') return undefined
  return proxy.url.trim() || undefined
}
