/**
 * Compatibility identities retained by existing service adapters. These are
 * transport-specific values, not the installed IDE version. Updating the IDE
 * alone is not evidence that an adapter's request headers must change.
 */
export const KIRO_LEGACY_IDENTITY = Object.freeze({
  account: '0.6.18',
  streaming: '0.12.155',
  subscription: '0.12.155'
})

/** Windows x64 stable IDE 1.5.11, kiro-authentication 1.1.1122. */
export const KIRO_AUTH_CLIENT_VERSION = '1.5.11'

export function getKiroSocialUserAgent(machineId?: string): string {
  const id = machineId && /^[A-Za-z0-9-]{1,128}$/.test(machineId) ? machineId : 'UNDETERMINED_MACHINE_ID'
  return `KiroIDE-${KIRO_AUTH_CLIENT_VERSION}-${id}`
}
