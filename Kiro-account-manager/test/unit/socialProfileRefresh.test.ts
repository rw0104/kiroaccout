import test from 'node:test'
import assert from 'node:assert/strict'
import { TokenRefreshService } from '../../src/main/authRefresh'
import { applyManagerTokenRotation } from '../../src/main/managerAccountRefresh'

const now = 1_800_000_000_000
const profileArn = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/SYNTHETIC_SOCIAL'
const previousProfile = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/SYNTHETIC_OLD'
const rotated = { accessToken: 'SYNTHETIC_ACCESS_NEW', refreshToken: 'SYNTHETIC_REFRESH_NEW', expiresIn: 3600 }
const socialInput = { kind: 'social' as const, refreshToken: 'SYNTHETIC_REFRESH_OLD' }
const account = (provider: 'Google' | 'Github') => ({
  idp: provider, credentials: { provider, authMethod: 'social', refreshToken: socialInput.refreshToken }
})
const serviceFor = (data: unknown) => new TokenRefreshService({
  fetch: async () => ({ ok: true, status: 200, json: async () => data }),
  socialEndpoint: 'https://auth.example.invalid', socialUserAgent: () => 'SYNTHETIC_AGENT', now: () => now
})

test('successful Social refresh repairs missing metadata through the real service and account merger', async () => {
  for (const provider of ['Google', 'Github'] as const) {
    const input = { accounts: { selected: account(provider) } }
    const result = await serviceFor({ ...rotated, profileArn }).refresh(socialInput)
    assert.equal(result.profileArn, profileArn)
    const applied = applyManagerTokenRotation(input, socialInput.refreshToken, result, now)
    assert.deepEqual(applied.updates, [{ id: 'selected', profileArn, credentials: {
      ...input.accounts.selected.credentials, accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken, expiresAt: now + 3_600_000, profileArn
    } }])
    assert.equal((applied.data as { accounts: { selected: { profileArn?: string } } }).accounts.selected.profileArn, profileArn)
    assert.equal(Object.hasOwn(input.accounts.selected.credentials, 'profileArn'), false)
  }
})

test('authoritative Social response replaces both stored profile locations in one credential generation', async () => {
  const input = { accounts: { selected: {
    ...account('Google'), profileArn: previousProfile,
    credentials: { ...account('Google').credentials, profileArn: previousProfile }
  } } }
  const result = await serviceFor({ ...rotated, profileArn }).refresh(socialInput)
  const applied = applyManagerTokenRotation(input, socialInput.refreshToken, result, now)
  const saved = (applied.data as typeof input).accounts.selected
  assert.equal(saved.profileArn, profileArn)
  assert.equal(saved.credentials.profileArn, profileArn)
})

test('missing, blank and malformed optional response profiles preserve previous metadata and usable rotation', async () => {
  const input = { accounts: { selected: {
    ...account('Github'), profileArn: previousProfile,
    credentials: { ...account('Github').credentials, profileArn: previousProfile }
  } } }
  for (const value of [undefined, null, '', '   ', 42, {}, 'not-an-arn', profileArn + '\nINJECTED', 'x'.repeat(4097)]) {
    const result = await serviceFor({ ...rotated, profileArn: value }).refresh(socialInput)
    assert.equal(result.success, true, 'optional invalid metadata must not discard an already rotated token')
    assert.equal(result.profileArn, undefined)
    const applied = applyManagerTokenRotation(input, socialInput.refreshToken, result, now)
    const saved = (applied.data as typeof input).accounts.selected
    assert.equal(saved.profileArn, previousProfile)
    assert.equal(saved.credentials.profileArn, previousProfile)
    assert.equal(saved.credentials.refreshToken, rotated.refreshToken)
  }
})

test('Social profile follows the existing single flight and replay without another request', async () => {
  let calls = 0
  const service = new TokenRefreshService({
    fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({ ...rotated, profileArn }) } },
    socialEndpoint: 'https://auth.example.invalid', socialUserAgent: () => 'SYNTHETIC_AGENT', now: () => now
  })
  const results = await Promise.all([service.refresh(socialInput), service.refresh(socialInput)])
  assert.equal(results[0].profileArn, profileArn)
  assert.equal(results[1].profileArn, profileArn)
  results[0].profileArn = previousProfile
  assert.equal((await service.refresh(socialInput)).profileArn, profileArn)
  assert.equal(calls, 1)
})

test('OIDC responses cannot attach Social profile metadata to their results', async () => {
  const result = await serviceFor({ ...rotated, profileArn }).refresh({
    kind: 'IdC', refreshToken: 'SYNTHETIC_OIDC_REFRESH', clientId: 'SYNTHETIC_CLIENT',
    clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1'
  })
  assert.equal(result.success, true)
  assert.equal(result.profileArn, undefined)
})

test('profile recovery does not change enterprise, unresolved or contradictory identities sharing a token', () => {
  const identities = [
    { idp: 'Enterprise', provider: 'Enterprise', authMethod: 'IdC' },
    { idp: 'BuilderId', provider: 'BuilderId', authMethod: 'IdC' },
    { idp: 'Enterprise', provider: 'Google', authMethod: 'social' },
    { idp: 'Github', provider: 'Google', authMethod: 'social' },
    { idp: 'Google', provider: 'Google', authMethod: 'IdC' },
    { idp: undefined, provider: undefined, authMethod: 'social' }
  ]
  for (const identity of identities) {
    const input = { accounts: { selected: {
      idp: identity.idp, profileArn: previousProfile,
      credentials: { provider: identity.provider, authMethod: identity.authMethod,
        refreshToken: socialInput.refreshToken, profileArn: previousProfile }
    } } }
    const applied = applyManagerTokenRotation(input, socialInput.refreshToken, { success: true, ...rotated, profileArn }, now)
    const saved = (applied.data as typeof input).accounts.selected
    assert.equal(saved.profileArn, previousProfile)
    assert.equal(saved.credentials.profileArn, previousProfile)
    assert.equal(Object.hasOwn(applied.updates[0], 'profileArn'), false)
  }
})

test('late Social profile responses cannot overwrite a newer token generation', () => {
  const input = { accounts: { selected: account('Google') } }
  const current = applyManagerTokenRotation(input, socialInput.refreshToken, { success: true, ...rotated, profileArn }, now)
  const stale = applyManagerTokenRotation(current.data, socialInput.refreshToken,
    { success: true, ...rotated, profileArn: previousProfile }, now + 1)
  assert.equal(stale.data, current.data)
  assert.deepEqual(stale.updates, [])
  assert.equal(current.updates[0].credentials.profileArn, profileArn)
})
