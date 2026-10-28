/**
 * Compatibility identities retained by existing service adapters. These are
 * transport-specific values, not the installed IDE version. Updating the IDE
 * alone is not evidence that an adapter's request headers must change.
 * Current static protocol review: IDE 1.4.51 / Agent 1.1.615 (2026-10-28).
 */
export const KIRO_LEGACY_IDENTITY = Object.freeze({
  account: '0.6.18',
  streaming: '0.12.155',
  subscription: '0.12.155'
})
