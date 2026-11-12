/**
 * Compatibility identities retained by existing service adapters. These are
 * transport-specific values, not the installed IDE version. Updating the IDE
 * alone is not evidence that an adapter's request headers must change.
 * Current static protocol review: IDE 1.4.154 / Agent 1.1.873 (2026-11-12).
 */
export const KIRO_LEGACY_IDENTITY = Object.freeze({
  account: '0.6.18',
  streaming: '0.12.155',
  subscription: '0.12.155'
})

/** Verified against the official stable auth-service client, separately from SDK adapters. */
export const KIRO_AUTH_CLIENT_VERSION = '1.4.154'

export function getKiroSocialUserAgent(machineId?: string): string {
  const suffix = machineId && /^[A-Za-z0-9-]{1,128}$/.test(machineId) ? `-${machineId}` : ''
  return `KiroIDE-${KIRO_AUTH_CLIENT_VERSION}${suffix}`
}
