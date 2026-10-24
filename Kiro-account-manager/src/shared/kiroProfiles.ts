// Public fixed profiles used by the official Kiro IDE 1.4.26 identity resolver.
// These identify service surfaces, not user credentials or organization profiles.
export const KIRO_SOCIAL_DEFAULT_PROFILE = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
export const KIRO_BUILDER_DEFAULT_PROFILE = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

/** Organization identities must supply an authenticated profile; never invent one. */
export function defaultKiroProfile(provider: string): string | undefined {
  if (provider === 'Google' || provider === 'Github') return KIRO_SOCIAL_DEFAULT_PROFILE
  if (provider === 'BuilderId') return KIRO_BUILDER_DEFAULT_PROFILE
  return undefined
}
