export const KIRO_CONNECTION_FILE_NAME = 'kiro-connection.json'

export type KiroConnectionDescriptor =
  | { authMethod: 'IdC'; provider: 'BuilderId' | 'Internal' }
  | { authMethod: 'IdC'; provider: 'Enterprise'; startUrl: string; region: string }

export interface KiroReconnectState {
  reconnectReady: boolean
  connectionWarning?: 'reconnect-unavailable'
}

/** Kiro 1.4.51's reconnect hint is optional and never establishes account identity. */
export function createKiroConnectionDescriptor(input: {
  authMethod?: string
  provider?: string
  startUrl?: string
  region?: string
}): KiroConnectionDescriptor | undefined {
  if (input.authMethod !== 'IdC') return undefined
  if (input.provider === 'BuilderId' || input.provider === 'Internal') {
    return { authMethod: 'IdC', provider: input.provider }
  }
  if (
    input.provider !== 'Enterprise' ||
    typeof input.startUrl !== 'string' ||
    input.startUrl.length > 2048 ||
    // eslint-disable-next-line no-control-regex -- Persisted login metadata must reject control characters.
    /[\x00-\x1f\x7f-\x9f]/.test(input.startUrl) ||
    typeof input.region !== 'string' ||
    // eslint-disable-next-line no-control-regex -- Also reject whitespace that a trailing regex anchor can accept.
    /[\x00-\x20\x7f-\x9f]/.test(input.region) ||
    !/^[a-z0-9-]+$/.test(input.region)
  ) return undefined
  try {
    const issuer = new URL(input.startUrl)
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash) return undefined
    return { authMethod: 'IdC', provider: 'Enterprise', startUrl: issuer.toString(), region: input.region }
  } catch {
    return undefined
  }
}
