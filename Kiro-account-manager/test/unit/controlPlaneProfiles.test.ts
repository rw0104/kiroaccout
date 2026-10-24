import test from 'node:test'
import assert from 'node:assert/strict'
import { buildControlPlaneRequest, requestControlPlane, ControlPlaneError } from '../../src/main/kiroControlPlane.ts'
import { KIRO_SOCIAL_DEFAULT_PROFILE, KIRO_BUILDER_DEFAULT_PROFILE } from '../../src/shared/kiroProfiles.ts'

test('personal accounts resolve the official default profile before ControlPlane usage and model requests', async () => {
  for (const [provider, authMethod, profile] of [
    ['Github', 'social', KIRO_SOCIAL_DEFAULT_PROFILE],
    ['Google', 'social', KIRO_SOCIAL_DEFAULT_PROFILE],
    ['BuilderId', 'IdC', KIRO_BUILDER_DEFAULT_PROFILE]
  ]) {
    for (const operation of ['GetUsageLimits', 'ListAvailableModels'] as const) {
      let calls = 0
      const response = await requestControlPlane({ accessToken: 'SYNTHETIC_ACCESS', provider, authMethod, region: 'eu-central-1' }, operation, {}, {
        fetch: async (url, init) => {
          calls++
          const body = JSON.parse(String(init?.body))
          // Models and usage share the official resolved identity. The SDK's
          // optional field does not mean the service accepts an absent profile.
          if (body.profileArn !== profile) return Response.json({ __type: 'ValidationException', message: 'Invalid profileArn.' }, { status: 400 })
          assert.equal(url, 'https://management.us-east-1.kiro.dev/')
          assert.equal(new Headers(init?.headers).get('tokentype'), provider === 'BuilderId' ? 'SSO_OIDC' : null)
          assert.doesNotMatch(String(init?.body), /refreshToken|clientSecret|SYNTHETIC_ACCESS/)
          return Response.json({ accepted: true })
        }
      })
      assert.deepEqual(response, { accepted: true })
      assert.equal(calls, 1)
    }
  }
})

test('an existing selected profile and its Region take precedence over personal defaults', () => {
  const selected = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCDEFGHIJKL'
  for (const provider of ['Github', 'Google', 'BuilderId', 'Enterprise', 'IAM_SSO']) {
    const request = buildControlPlaneRequest({ accessToken: 'SYNTHETIC_ACCESS', provider, profileArn: selected, region: 'us-east-1' }, 'GetUsageLimits', {})
    assert.equal(request.url, 'https://management.eu-central-1.kiro.dev/')
    assert.equal(JSON.parse(request.body).profileArn, selected)
  }
})

test('missing organization profiles fail locally without borrowing a personal profile or making network requests', async () => {
  let calls = 0
  for (const provider of ['Enterprise', 'IAM_SSO', 'ExternalIdp']) {
    await assert.rejects(requestControlPlane({ accessToken: 'SYNTHETIC_ACCESS', provider, authMethod: provider === 'ExternalIdp' ? 'external_idp' : 'IdC' }, 'GetUsageLimits', {}, {
      fetch: async () => { calls++; return Response.json({}) }
    }), error => error instanceof ControlPlaneError && error.code === 'missing_profile')
  }
  assert.equal(calls, 0)
})
