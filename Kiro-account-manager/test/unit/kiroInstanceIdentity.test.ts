import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyKiroInstanceIdentity } from '../../src/main/kiroInstanceIdentity'
import type { InstanceAccountCredentials } from '../../src/main/kiroInstanceAccounts'

const credentials: InstanceAccountCredentials = {
  accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH_NEVER_SEND', clientSecret: 'SYNTHETIC_SECRET_NEVER_SEND',
  provider: 'Github', authMethod: 'social', region: 'us-east-1', expiresAt: 1800000000000,
  profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/SYNTHETIC'
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/x-amz-json-1.0' } })

test('identity lookup matches official ControlPlane JSON RPC wire and sends no refresh credentials or cookies', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, 'https://management.us-east-1.kiro.dev/')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal instanceof AbortSignal)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC_ACCESS')
    assert.equal(headers.get('content-type'), 'application/x-amz-json-1.0')
    assert.equal(headers.get('x-amz-target'), 'KiroControlPlaneBearerService.GetUsageLimits')
    assert.equal(headers.get('tokentype'), null)
    assert.equal(headers.get('cookie'), null)
    assert.deepEqual(JSON.parse(String(init?.body)), { origin: 'AI_EDITOR', profileArn: credentials.profileArn })
    assert.doesNotMatch(JSON.stringify(init), /SYNTHETIC_REFRESH|SYNTHETIC_SECRET/)
    return json({ userInfo: { userId: 'synthetic-server-user', email: 'synthetic@example.invalid' }, subscriptionInfo: {} })
  }
  assert.deepEqual(await verifyKiroInstanceIdentity(credentials, { fetch }), { userId: 'synthetic-server-user' })
  assert.equal(calls, 1)
})

test('profile region takes precedence and Builder IdC uses the official SSO_OIDC header with only an access token', async () => {
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://management.eu-central-1.kiro.dev/')
    assert.equal(new Headers(init?.headers).get('tokentype'), 'SSO_OIDC')
    return json({ userInfo: { userId: 'synthetic-idc-user' } })
  }
  assert.deepEqual(await verifyKiroInstanceIdentity({ accessToken: 'SYNTHETIC_IDC_ACCESS', provider: 'BuilderId', authMethod: 'IdC',
    region: 'us-east-1', profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC' }, { fetch }), { userId: 'synthetic-idc-user' })
})

test('an absent organization profile cannot be replaced by a personal profile during identity verification', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls++; return json({ userInfo: { userId: 'synthetic-enterprise-user' } }) }
  assert.equal(await verifyKiroInstanceIdentity({ accessToken: 'SYNTHETIC_ACCESS', provider: 'Enterprise', authMethod: 'IdC', region: 'eu-central-1' }, { fetch }), null)
  assert.equal(calls, 0)
})

test('legacy Github identities without a stored profile use the same official default as account and model queries', async () => {
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://management.us-east-1.kiro.dev/')
    assert.deepEqual(JSON.parse(String(init?.body)), { origin: 'AI_EDITOR', profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK' })
    return json({ userInfo: { userId: 'synthetic-personal-user' } })
  }
  assert.deepEqual(await verifyKiroInstanceIdentity({ accessToken: 'SYNTHETIC_ACCESS', provider: 'Github', authMethod: 'social', region: 'eu-central-1' }, { fetch }), { userId: 'synthetic-personal-user' })
})

test('invalid identity, header or endpoint input is rejected before calling any transport', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('Transport must not be called') }
  for (const change of [
    { provider: 'unrecognized' }, { authMethod: 'IdC' }, { accessToken: 'SYNTHETIC\nACCESS' }, { accessToken: '' },
    { profileArn: 'https://example.invalid/steal' }, { profileArn: undefined, region: 'evil.example/path' }
  ]) assert.equal(await verifyKiroInstanceIdentity({ ...credentials, ...change }, { fetch }), null)
  assert.equal(calls, 0)
})

test('HTTP errors, incomplete identity and malformed responses return null without retries or fallback', async () => {
  for (const response of [
    json({ userInfo: { userId: 'synthetic-user' } }, 401), json({}, 429), json({}, 500), json({ userId: 'synthetic-top-level' }),
    json({ userInfo: { userId: '' } }), json({ userInfo: { userId: '\nsynthetic' } }), json({ userInfo: { userId: 42 } }),
    json({ userInfo: [] }), json({ userInfo: { userId: 'x'.repeat(4097) } }), new Response('not JSON')
  ]) {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => { calls++; return response }
    assert.equal(await verifyKiroInstanceIdentity(credentials, { fetch }), null)
    assert.equal(calls, 1)
  }
})

test('network exceptions return null without exposing their payload or sending another request', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('SYNTHETIC_SECRET_SERVER_ERROR') }
  assert.equal(await verifyKiroInstanceIdentity(credentials, { fetch }), null)
  assert.equal(calls, 1)
})

test('an oversized identity response is rejected even if its claimed userId matches', async () => {
  for (const response of [
    new Response('not read', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    json({ userInfo: { userId: 'synthetic-user' }, padding: 'x'.repeat(1024 * 1024) })
  ]) {
    const fetch: typeof globalThis.fetch = async () => response
    assert.equal(await verifyKiroInstanceIdentity(credentials, { fetch }), null)
  }
})

test('identity lookup aborts exactly at eight seconds even when a transport ignores the abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_url, init) => { calls++; signal = init?.signal ?? undefined; return new Promise<Response>(() => {}) }
  const pending = verifyKiroInstanceIdentity(credentials, { fetch })
  t.mock.timers.tick(7999)
  assert.equal(signal?.aborted, false)
  t.mock.timers.tick(1)
  assert.equal(await pending, null)
  assert.equal(signal?.aborted, true)
  assert.equal(calls, 1)
})

test('the same eight-second deadline covers a response body that never finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
  const pending = verifyKiroInstanceIdentity(credentials, { fetch })
  // Let the asynchronous fetch resolve and install the body abort listener.
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(8000)
  assert.equal(await pending, null)
  assert.equal(cancelled, true)
})
