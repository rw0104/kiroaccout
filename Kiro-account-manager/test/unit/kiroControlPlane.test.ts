import test from 'node:test'
import assert from 'node:assert/strict'
import { buildControlPlaneRequest, requestControlPlane, ControlPlaneError } from '../../src/main/kiroControlPlane.ts'

const identity = { accessToken: 'SYNTHETIC_ACCESS', provider: 'Google', authMethod: 'social', region: 'us-east-1' }
const profileArn = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC'

test('current ControlPlane wire keeps identity region, profile, provider and operation together', () => {
  const social = buildControlPlaneRequest(identity, 'GetUsageLimits', { isEmailRequired: true, refreshToken: 'NEVER_SEND', profileArn, origin: 'UNTRUSTED' })
  assert.equal(social.method, 'POST')
  assert.equal(social.url, 'https://management.us-east-1.kiro.dev/')
  assert.equal(social.headers['x-amz-target'], 'KiroControlPlaneBearerService.GetUsageLimits')
  assert.equal(social.headers['Content-Type'], 'application/x-amz-json-1.0')
  assert.equal(social.headers.TokenType, undefined)
  assert.deepEqual(JSON.parse(social.body), { origin: 'AI_EDITOR', isEmailRequired: true })
  const idc = buildControlPlaneRequest({ ...identity, provider: 'Enterprise', authMethod: 'IdC', profileArn }, 'ListAvailableModels', { nextToken: 'SYNTHETIC_PAGE' })
  assert.equal(idc.url, 'https://management.eu-central-1.kiro.dev/')
  assert.equal(idc.headers.TokenType, 'SSO_OIDC')
  assert.deepEqual(JSON.parse(idc.body), { origin: 'AI_EDITOR', profileArn, nextToken: 'SYNTHETIC_PAGE' })
  assert.equal(buildControlPlaneRequest({ ...identity, provider: 'ExternalIdp', authMethod: 'external_idp' }, 'GetUsageLimits', {}).headers.TokenType, 'EXTERNAL_IDP')
  for (const invalid of [{ ...identity, accessToken: 'bad\r\nheader' }, { ...identity, region: 'evil.example/path' }, { ...identity, profileArn: 'invalid' }, { ...identity, authMethod: 'IdC' }]) {
    assert.throws(() => buildControlPlaneRequest(invalid, 'GetUsageLimits', {}), ControlPlaneError)
  }
})

test('usage requests preserve purchased-credit data and never cross-region retry or refresh', async () => {
  let calls = 0
  const response = { usageBreakdownList: [{ resourceType: 'CREDIT', overageCredits: [{ currentUsage: 3, usageLimit: 125, expiresAt: 1900000000 }] }] }
  const result = await requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async (_url, init) => {
    calls++
    assert.equal(init?.redirect, 'error')
    assert.equal(JSON.stringify(init).includes('refreshToken'), false)
    return Response.json(response)
  } })
  assert.deepEqual(result, response)
  assert.equal(calls, 1)
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => {
    calls++
    return new Response('SYNTHETIC_PRIVATE_BODY', { status: 403 })
  } }), error => error instanceof ControlPlaneError && error.status === 403 && !error.message.includes('PRIVATE'))
  assert.equal(calls, 2)
})

test('timeouts and cancellation cover transport and body reads; malformed responses are controlled', async () => {
  const never = async (): Promise<Response> => new Promise(() => {})
  await assert.rejects(requestControlPlane(identity, 'ListAvailableModels', {}, { fetch: never, timeoutMs: 10 }), { code: 'timeout' })
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { signal: controller.signal, fetch: async () => { calls++; return Response.json({}) } }), { code: 'cancelled' })
  assert.equal(calls, 0)
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response('not json') }), { code: 'invalid_response_or_transport' })
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => Response.json([]) }), { code: 'invalid_response' })
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }) }), { code: 'invalid_response' })
})
