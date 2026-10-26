export interface OidcRegistrationInput {
  clientId?: string
  clientSecret?: string
  clientSecretExpiresAt?: number
}

const MAX_SECRET_LENGTH = 64 * 1024
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function normalizeSeconds(value: unknown, allowMilliseconds: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (!allowMilliseconds && value >= 1e12) return undefined
  const seconds = Math.floor(value >= 1e12 ? value / 1000 : value)
  return seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined
}

function decodeJson(segment: string): unknown {
  const bytes = Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0)
  )
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

/**
 * Recover omitted metadata from the original AWS registration secret, never by
 * inventing a lifetime or replacing an explicit deadline. Current registration
 * secrets wrap a serialized client ID and a fractional Unix-second timestamp.
 *
 * Decoding does NOT verify the signature or authenticate the client. A caller
 * must still validate the original secret through the normal server refresh
 * before accepting credentials or publishing an IDE cache. Unknown formats
 * intentionally remain unresolved and require the original registration data.
 */
export function resolveOidcRegistrationExpiry(input: OidcRegistrationInput): number | undefined {
  if (input.clientSecretExpiresAt !== undefined)
    return normalizeSeconds(input.clientSecretExpiresAt, true)
  if (
    typeof input.clientId !== 'string' ||
    !input.clientId.trim() ||
    typeof input.clientSecret !== 'string' ||
    input.clientSecret.length > MAX_SECRET_LENGTH
  )
    return undefined
  const parts = input.clientSecret.split('.')
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1)
  )
    return undefined
  try {
    const header = decodeJson(parts[0])
    if (
      !object(header) ||
      typeof header.alg !== 'string' ||
      !header.alg.trim() ||
      header.alg.trim().toLowerCase() === 'none'
    )
      return undefined
    const payload = decodeJson(parts[1])
    if (!object(payload) || typeof payload.serialized !== 'string') return undefined
    const registration: unknown = JSON.parse(payload.serialized)
    if (
      !object(registration) ||
      !object(registration.clientId) ||
      registration.clientId.value !== input.clientId
    )
      return undefined
    return normalizeSeconds(registration.expirationTimestamp, false)
  } catch {
    return undefined
  }
}
