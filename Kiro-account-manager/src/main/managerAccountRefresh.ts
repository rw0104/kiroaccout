import { normalizeProvider, resolveIdentity } from '../shared/authIdentity'
import { normalizeRefreshProfileArn } from './authRefresh'

export interface ManagerTokenRotationResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
}

export interface ManagerTokenRotationUpdate {
  id: string
  credentials: Record<string, unknown>
  profileArn?: string
}

const record = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Apply a completed refresh only to accounts that still own its exact input token. */
export function applyManagerTokenRotation(
  data: unknown,
  expectedRefreshToken: string,
  result: ManagerTokenRotationResult,
  now = Date.now()
): { data: unknown; updates: ManagerTokenRotationUpdate[] } {
  const unchanged = { data, updates: [] as ManagerTokenRotationUpdate[] }
  if (!record(data) || !record(data.accounts) || !result || result.success !== true ||
      typeof expectedRefreshToken !== 'string' || !expectedRefreshToken.trim() ||
      typeof result.accessToken !== 'string' || !result.accessToken.trim() ||
      result.refreshToken !== undefined && typeof result.refreshToken !== 'string') return unchanged

  // Older refresh providers omit the lifetime; preserve the existing one-hour default.
  // A provided invalid lifetime must never be converted into apparently usable credentials.
  const expiresIn = result.expiresIn === undefined ? 3600 : result.expiresIn
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
      !Number.isFinite(now)) return unchanged
  const expiresAt = now + expiresIn * 1000
  if (!Number.isFinite(expiresAt) || Math.abs(expiresAt) > 8.64e15 || expiresAt <= now) return unchanged

  const updates: ManagerTokenRotationUpdate[] = []
  let accounts: Record<string, unknown> | undefined
  for (const [id, account] of Object.entries(data.accounts)) {
    if (!record(account) || !record(account.credentials) ||
        account.credentials.refreshToken !== expectedRefreshToken) continue
    const identity = resolveIdentity({ provider: account.credentials.provider,
      authMethod: account.credentials.authMethod, idp: account.idp })
    const idp = normalizeProvider(account.idp)
    // Only a consistent Social identity can recover metadata from this response.
    // An enterprise or contradictory alias must not inherit a personal profile.
    const profileArn = identity.ok && identity.authMethod === 'social' &&
      (idp === undefined || idp === identity.provider)
      ? normalizeRefreshProfileArn(result.profileArn) : undefined
    const credentials = {
      ...account.credentials,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken?.trim() ? result.refreshToken : expectedRefreshToken,
      expiresAt,
      ...(profileArn ? { profileArn } : {})
    }
    accounts ??= { ...data.accounts }
    accounts[id] = { ...account, credentials, ...(profileArn ? { profileArn } : {}) }
    updates.push({ id, credentials, ...(profileArn ? { profileArn } : {}) })
  }
  return accounts ? { data: { ...data, accounts }, updates } : unchanged
}
