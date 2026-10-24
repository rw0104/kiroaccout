import test from 'node:test'
import assert from 'node:assert/strict'
import { buildControlPlaneRequest, requestControlPlane, ControlPlaneError } from '../../src/main/kiroControlPlane.ts'
import { KIRO_SOCIAL_DEFAULT_PROFILE } from '../../src/shared/kiroProfiles.ts'

const identity = { accessToken: 'SYNTHETIC_ACCESS', provider: 'Google', authMethod: 'social', region: 'us-east-1' }
const profileArn = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC'

test('current ControlPlane wire keeps identity region, profile, provider and operation together', () => {
  const social = buildControlPlaneRequest(identity, 'GetUsageLimits', { isEmailRequired: true, refreshToken: 'NEVER_SEND', profileArn, origin: 'UNTRUSTED' })
  assert.equal(social.method, 'POST')
  assert.equal(social.url, 'https://management.us-east-1.kiro.dev/')
  assert.equal(social.headers['x-amz-target'], 'KiroControlPlaneBearerService.GetUsageLimits')
  assert.equal(social.headers['Content-Type'], 'application/x-amz-json-1.0')
  assert.equal(social.headers.TokenType, undefined)
  assert.deepEqual(JSON.parse(social.body), { origin: 'AI_EDITOR', profileArn: KIRO_SOCIAL_DEFAULT_PROFILE })
  const idc = buildControlPlaneRequest({ ...identity, provider: 'Enterprise', authMethod: 'IdC', profileArn }, 'ListAvailableModels', { nextToken: 'SYNTHETIC_PAGE' })
  assert.equal(idc.url, 'https://management.eu-central-1.kiro.dev/')
  assert.equal(idc.headers.TokenType, 'SSO_OIDC')
  assert.deepEqual(JSON.parse(idc.body), { origin: 'AI_EDITOR', profileArn, nextToken: 'SYNTHETIC_PAGE' })
  assert.equal(buildControlPlaneRequest({ ...identity, provider: 'ExternalIdp', authMethod: 'external_idp', profileArn }, 'GetUsageLimits', {}).headers.TokenType, 'EXTERNAL_IDP')
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

const privateErrorMarker = 'SYNTHETIC_PRIVATE_TOKEN_ARN_EMAIL_URL'
function safeServiceFailure(error: unknown, expected: { status: number; serviceCode?: string; reason?: string; code?: string }): boolean {
  assert.ok(error instanceof ControlPlaneError)
  assert.equal(error.code, expected.code ?? 'request_failed')
  assert.equal(error.status, expected.status)
  assert.equal(error.serviceCode, expected.serviceCode)
  assert.equal(error.reason, expected.reason)
  assert.ok(!(String(error) + JSON.stringify(error)).includes(privateErrorMarker))
  assert.ok(!String(error).includes(profileArn))
  assert.ok(!String(error).includes('synthetic-private@example.invalid'))
  assert.ok(!String(error).includes('https://synthetic-private.invalid/'))
  return true
}

test('HTTP 400 diagnostics expose only approved service codes and fixed missing-field advice', async () => {
  const response = { __type: 'com.amazon.coral.validate#ValidationException',
    message: `Value null at 'resourceType' failed constraint: Member must not be null. ${privateErrorMarker} ${profileArn} synthetic-private@example.invalid https://synthetic-private.invalid/` }
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => Response.json(response, { status: 400 }) }),
    error => safeServiceFailure(error, { status: 400, serviceCode: 'ValidationException', reason: 'missing_resource_type' }))
})

test('service type headers and bounded nested error envelopes identify serialization, operation, profile and token failures', async () => {
  for (const sample of [
    { body: { message: privateErrorMarker }, headers: { 'x-amzn-errortype': 'SerializationException' }, serviceCode: 'SerializationException', reason: 'serialization' },
    { body: { __type: 'com.amazon.coral.service#UnknownOperationException', message: privateErrorMarker }, headers: {}, serviceCode: 'UnknownOperationException', reason: 'unknown_operation' },
    { body: { error: { code: 'InvalidProfileArnException', message: `${privateErrorMarker} ${profileArn}` } }, headers: {}, serviceCode: 'InvalidProfileArnException', reason: 'invalid_profile' },
    { body: { error: { __type: 'ExpiredTokenException', message: privateErrorMarker } }, headers: {}, serviceCode: 'ExpiredTokenException', reason: 'token' },
    { body: { error: 'invalid_token', error_description: privateErrorMarker }, headers: {}, serviceCode: 'InvalidTokenException', reason: 'token' }
  ]) {
    await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => Response.json(sample.body, { status: 400, headers: sample.headers }) }),
      error => safeServiceFailure(error, { status: 400, serviceCode: sample.serviceCode, reason: sample.reason }))
  }
})

test('actual HTTP 400 profile validation and token rejection remain distinct from generic access denial', async () => {
  for (const sample of [
    { type: 'ValidationException', message: 'Invalid profileArn.', reason: 'invalid_profile' },
    { type: 'AccessDeniedException', message: 'Invalid token', reason: 'token' },
    { type: 'AccessDeniedException', message: 'Access denied', reason: undefined },
    { type: 'AccessDeniedException', message: `Invalid token ${privateErrorMarker}`, reason: undefined },
    { type: 'ValidationException', message: `An unrelated note mentioning resourceType and null ${privateErrorMarker}`, reason: 'validation' }
  ]) {
    await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, {
      fetch: async () => Response.json({ __type: `com.amazon.kiro.controlplane#${sample.type}`, message: sample.message,
        details: { token: privateErrorMarker, profileArn, email: 'synthetic-private@example.invalid', url: 'https://synthetic-private.invalid/' } }, { status: 400 })
    }), error => safeServiceFailure(error, { status: 400, serviceCode: sample.type, reason: sample.reason }))
  }
})

test('empty, plain text, JSON strings and unknown arbitrary error fields never echo server values', async () => {
  for (const body of [null, '', `invalid token ${privateErrorMarker}`, JSON.stringify(`invalid token ${privateErrorMarker}`),
    JSON.stringify({ code: privateErrorMarker, message: privateErrorMarker }), JSON.stringify({ nested: { error: privateErrorMarker } })]) {
    await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response(body, { status: 400 }) }),
      error => safeServiceFailure(error, { status: 400 }))
  }
})

test('HTTP 401, 403 and 429 retain their existing public classification and never expose error bodies', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'access_denied'], [429, 'rate_limited']] as const) {
    await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response(privateErrorMarker, { status }) }),
      error => safeServiceFailure(error, { status, code }))
  }
})

test('oversized error bodies are cancelled without draining or retaining more than the 16 KiB budget', async () => {
  let reads = 0, cancelled = 0
  const advertised = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024)) }, cancel() { cancelled++ } })
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response(advertised, {
    status: 400, headers: { 'content-length': String(64 * 1024), 'x-amzn-errortype': 'ValidationException' }
  }) }), error => safeServiceFailure(error, { status: 400, serviceCode: 'ValidationException', reason: 'validation' }))
  assert.ok(reads <= 1)
  assert.equal(cancelled, 1)
  reads = 0; cancelled = 0
  const unbounded = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(8192).fill(65)) }, cancel() { cancelled++ } })
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => new Response(unbounded, { status: 400 }) }),
    error => safeServiceFailure(error, { status: 400 }))
  assert.ok(reads <= 4, `error body was drained beyond budget: ${reads}`)
  assert.equal(cancelled, 1)
})

test('the same request deadline and cancellation cover an error body whose reader or cancellation never settles', async () => {
  let cancellations = 0
  const hung = (): Response => new Response(new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}), cancel() { cancellations++; return new Promise<void>(() => {}) }
  }), { status: 400 })
  await assert.rejects(requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => hung(), timeoutMs: 15 }), { code: 'timeout' })
  assert.equal(cancellations, 1)
  const controller = new AbortController()
  const pending = requestControlPlane(identity, 'GetUsageLimits', {}, { fetch: async () => hung(), signal: controller.signal, timeoutMs: 500 })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(cancellations, 2)
})
