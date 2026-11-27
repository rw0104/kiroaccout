import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetch as undiciFetch } from 'undici'
import { TokenRefreshService, refreshFailureDiagnostic, type AuthRefreshResult } from '../../src/main/authRefresh'

const credential = { kind: 'IdC' as const, refreshToken: 'SYNTHETIC_REFRESH', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1' }
const good = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_ROTATED', expiresIn: 3600 }
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data })
const dependencies = (fetch: (url: string, init: RequestInit, proxyUrl?: string) => Promise<ReturnType<typeof response>>) => ({
  fetch, socialEndpoint: 'https://auth.example.invalid', socialUserAgent: () => 'SYNTHETIC_AGENT'
})

test('legacy registration recovery preserves server validation and rejects an actually expired embedded deadline', async () => {
  const now = 1_800_000_000_000
  const secret = (deadline: number) => [
    { alg: 'HS256' },
    { serialized: JSON.stringify({ clientId: { value: credential.clientId }, expirationTimestamp: deadline + 0.180562 }) }
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.U1lOVEhFVElD'
  const payloads: Record<string, unknown>[] = []
  const service = new TokenRefreshService({ ...dependencies(async (_url, init) => {
    payloads.push(JSON.parse(String(init.body)))
    return response({ error: 'invalid_client' }, 401)
  }), now: () => now })
  const clientSecret = secret(now / 1000 + 86400)
  const rejected = await service.refresh({ ...credential, clientSecret })
  assert.equal(rejected.success, false)
  assert.equal(rejected.errorCode, 'http', 'decoding metadata is never authentication')
  assert.equal(payloads[0].clientSecret, clientSecret)
  assert.equal(payloads[0].grantType, 'refresh_token')
  assert.equal(Object.hasOwn(payloads[0], 'clientSecretExpiresAt'), false)
  const expired = await service.refresh({ ...credential, clientSecret: secret(now / 1000 - 1) })
  assert.equal(expired.errorCode, 'invalid-input')
  assert.equal(payloads.length, 1)
})

test('refresh rejects incomplete successful payloads rather than overwriting valid credentials', async () => {
  for (const data of [{}, { accessToken: '', expiresIn: 3600 }, { accessToken: 'SYNTHETIC_ACCESS' },
    { accessToken: 'SYNTHETIC_ACCESS', expiresIn: -1 }, { ...good, expiresIn: Infinity }, { ...good, refreshToken: '' }]) {
    const service = new TokenRefreshService(dependencies(async () => response(data)))
    const result = await service.refresh(credential)
    assert.equal(result.success, false)
    assert.equal(result.errorCode, 'invalid-response')
    assert.equal(result.accessToken, undefined)
  }
})

test('manual, verification and background refreshes share one rotation and briefly replay it for late callers', async () => {
  let calls = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let now = 1000
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; await pending; return response(good) }), now: () => now })
  const first = service.refresh(credential)
  const second = service.refresh({ ...credential, proxyUrl: 'http://proxy.example.invalid' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, await second)
  now += 1000
  const replay = await service.refresh(credential)
  assert.equal(replay.refreshToken, good.refreshToken)
  assert.equal(replay.expiresIn, 3599)
  assert.equal(calls, 1)
  replay.accessToken = 'MUTATED_COPY'
  assert.equal((await service.refresh(credential)).accessToken, good.accessToken)
  now += 16000
  await service.refresh(credential)
  assert.equal(calls, 1, 'a consumed input token always hands off the valid newest generation')
  await service.refresh({ ...credential, refreshToken: good.refreshToken })
  assert.equal(calls, 2, 'the current token may explicitly refresh after the short replay window')
})

test('rotation lineage joins all generations and never returns a consumed intermediate token to late callers', async () => {
  let now = 0
  let calls = 0
  const third = { ...good, accessToken: 'SYNTHETIC_ACCESS_THIRD', refreshToken: 'SYNTHETIC_THIRD' }
  const delayed = deferredResponse()
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return calls === 1 ? response(good) : delayed.promise }), now: () => now })
  const first = await service.refresh(credential)
  assert.equal(first.refreshToken, good.refreshToken)
  now += 1000
  assert.equal((await service.refresh({ ...credential, refreshToken: good.refreshToken })).refreshToken, good.refreshToken)
  assert.equal(calls, 1, 'receiving the latest refresh token must not immediately rotate it again')
  now = 16000
  const newest = service.refresh({ ...credential, refreshToken: good.refreshToken })
  await new Promise(resolve => setImmediate(resolve))
  const lateOld = service.refresh(credential)
  assert.equal(calls, 2)
  delayed.resolve(response(third))
  assert.equal((await newest).refreshToken, third.refreshToken)
  assert.equal((await lateOld).refreshToken, third.refreshToken)
  now += 1000
  assert.equal((await service.refresh(credential)).refreshToken, third.refreshToken)
  assert.equal((await service.refresh({ ...credential, refreshToken: good.refreshToken })).accessToken, third.accessToken)
  assert.equal(calls, 2)
})

test('aliases converge when a next-generation caller starts before the older request has completed', async () => {
  const first = deferredResponse()
  const second = deferredResponse()
  let calls = 0
  const third = { ...good, refreshToken: 'SYNTHETIC_THIRD' }
  const service = new TokenRefreshService(dependencies(async () => ++calls === 1 ? first.promise : second.promise))
  const older = service.refresh(credential)
  const newer = service.refresh({ ...credential, refreshToken: good.refreshToken })
  await new Promise(resolve => setImmediate(resolve))
  first.resolve(response(good))
  second.resolve(response(third))
  assert.equal((await older).refreshToken, third.refreshToken)
  assert.equal((await newer).refreshToken, third.refreshToken)
  assert.equal((await service.refresh(credential)).refreshToken, third.refreshToken)
  assert.equal(calls, 2)
})

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof response>) => void
  const promise = new Promise<ReturnType<typeof response>>(done => { resolve = done })
  return { promise, resolve }
}

test('failed next-generation refresh is handed to old callers without an implicit retry or stale success', async () => {
  let now = 0
  let calls = 0
  const service = new TokenRefreshService({ ...dependencies(async () => ++calls === 1 ? response(good) : response({ error: 'invalid_grant' }, 400)), now: () => now })
  await service.refresh(credential)
  now = 16000
  assert.equal((await service.refresh({ ...credential, refreshToken: good.refreshToken })).success, false)
  assert.equal((await service.refresh(credential)).success, false)
  assert.equal(calls, 2)
})

test('a timed-out generation is never replayed and cannot publish late success over a reauthorized generation', async () => {
  const late = deferredResponse()
  let calls = 0
  const final = { ...good, refreshToken: 'SYNTHETIC_FINAL' }
  const service = new TokenRefreshService({ ...dependencies(async () => ++calls === 1 ? late.promise : response(final)), timeoutMs: 10 })
  assert.equal((await service.refresh(credential)).errorCode, 'timeout')
  assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
  assert.equal(calls, 1)
  const recovered = { ...credential, refreshToken: 'SYNTHETIC_REAUTHORIZED' }
  assert.equal((await service.refresh(recovered)).refreshToken, final.refreshToken)
  late.resolve(response(good))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
  assert.equal((await service.refresh(recovered)).refreshToken, final.refreshToken)
  assert.equal(calls, 2)
})

test('rotation alias retention has a finite bound independent of access-token duration', async () => {
  let now = 0
  let calls = 0
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return response(good) }), now: () => now, maxRetentionMs: 1000 })
  await service.refresh(credential)
  now = 1001
  await service.refresh(credential)
  assert.equal(calls, 2)
})

test('known expired or soon-expiring OIDC registration never reaches the network; absent expiry stays compatible', async () => {
  let calls = 0
  const now = 1_800_000_000_000
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return response(good) }), now: () => now })
  for (const expiry of [0, now / 1000 - 1, now / 1000 + 899, now / 1000 + 900, NaN, Infinity]) {
    assert.equal((await service.refresh({ ...credential, clientSecretExpiresAt: expiry })).errorCode, 'invalid-input')
  }
  assert.equal(calls, 0)
  assert.equal((await service.refresh({ ...credential, clientSecretExpiresAt: now / 1000 + 901 })).success, true)
  assert.equal((await service.refresh({ ...credential, clientId: 'SYNTHETIC_OTHER' })).success, true)
  assert.equal(calls, 2)
})

test('a large batch of failed new credentials cannot exhaust cache capacity for a valid account', async () => {
  let valid = false
  let calls = 0
  const service = new TokenRefreshService(dependencies(async () => { calls++; return valid ? response(good) : response({ error: 'invalid_grant' }, 400) }))
  for (let index = 0; index < 1030; index++) {
    assert.equal((await service.refresh({ ...credential, refreshToken: `SYNTHETIC_INVALID_${index}` })).errorCode, 'http')
  }
  valid = true
  assert.equal((await service.refresh(credential)).success, true)
  assert.equal(calls, 1031)
})

test('short-lived results expire from the rotation replay cache at actual token expiry', async () => {
  let now = 0
  let calls = 0
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return response({ ...good, expiresIn: 1 }) }), now: () => now })
  await service.refresh(credential)
  now = 1001
  await service.refresh(credential)
  assert.equal(calls, 2)
})

test('OIDC keeps the verified AWS JSON contract and optional refresh token semantics', async () => {
  const calls: Array<{url: string; init: RequestInit; proxy?: string}> = []
  const service = new TokenRefreshService(dependencies(async (url, init, proxy) => {
    calls.push({ url, init, proxy }); return response({ accessToken: good.accessToken, expiresIn: 600 })
  }))
  const result = await service.refresh({ ...credential, region: 'eu-central-1', proxyUrl: 'http://proxy.example.invalid' })
  assert.equal(result.refreshToken, credential.refreshToken)
  assert.equal(calls[0].url, 'https://oidc.eu-central-1.amazonaws.com/token')
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { clientId: credential.clientId, clientSecret: credential.clientSecret, refreshToken: credential.refreshToken, grantType: 'refresh_token' })
  assert.equal(calls[0].init.redirect, 'error')
  assert.ok(calls[0].init.signal)
  assert.equal(calls[0].proxy, 'http://proxy.example.invalid')
})

test('Social refresh sends only its actual refresh body and client headers', async () => {
  let payload: RequestInit | undefined
  let target = ''
  const service = new TokenRefreshService(dependencies(async (url, init) => { target = url; payload = init; return response(good) }))
  assert.equal((await service.refresh({ kind: 'social', refreshToken: credential.refreshToken })).success, true)
  assert.equal(target, 'https://auth.example.invalid/refreshToken')
  assert.deepEqual(JSON.parse(payload!.body as string), { refreshToken: credential.refreshToken })
  assert.equal((payload!.headers as Record<string, string>)['User-Agent'], 'SYNTHETIC_AGENT')
})

test('invalid input never reaches a service and separate registrations do not share tokens', async () => {
  let calls = 0
  const service = new TokenRefreshService(dependencies(async () => { calls++; return response(good) }))
  for (const input of [{ ...credential, refreshToken: '' }, { ...credential, clientSecret: '' }, { ...credential, region: 'us-east-1.attacker.invalid/path' }]) {
    assert.equal((await service.refresh(input)).errorCode, 'invalid-input')
  }
  assert.equal(calls, 0)
  await Promise.all([service.refresh(credential), service.refresh({ ...credential, clientId: 'OTHER_SYNTHETIC_CLIENT' })])
  assert.equal(calls, 2)
})

test('HTTP, malformed JSON and transport errors never echo server or transport secrets and never retry POSTs', async () => {
  for (const callback of [
    async () => response({ error: 'invalid_grant', message: 'SYNTHETIC_PRIVATE' }, 400),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('SYNTHETIC_PRIVATE') } }),
    async () => { throw new Error('SYNTHETIC_PRIVATE') }
  ]) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => { calls++; return callback() }))
    const result = await service.refresh(credential)
    assert.equal(result.success, false)
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/)
    assert.equal(calls, 1)
  }
})

test('deadline aborts fetch and body reads and requires a new generation before recovery', async () => {
  let signal: AbortSignal | undefined
  let healthy = false
  let calls = 0
  const service = new TokenRefreshService({ ...dependencies(async (_url, init) => {
    calls++; signal = init.signal as AbortSignal
    if (healthy) return response(good)
    return { ok: true, status: 200, json: () => new Promise(() => {}) }
  }), timeoutMs: 10 })
  const result = await service.refresh(credential)
  assert.equal(result.errorCode, 'timeout')
  assert.equal(signal?.aborted, true)
  assert.equal(calls, 1)
  healthy = true
  assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
  assert.equal(calls, 1)
  assert.equal((await service.refresh({ ...credential, refreshToken: 'SYNTHETIC_REAUTHORIZED' })).success, true)
})

test('refresh failures distinguish temporary responses, permanent credentials and uncertain transports without replaying', async () => {
  for (const [status, body, failureKind] of [
    [429, {}, 'temporary'], [400, { error: 'slow_down' }, 'temporary'],
    [500, {}, 'temporary'], [503, {}, 'temporary'],
    [408, {}, 'uncertain'], [502, {}, 'uncertain'], [504, {}, 'uncertain'],
    [400, { error: 'invalid_grant' }, 'reauth-required'],
    [400, { error: 'expired_token' }, 'reauth-required'],
    [401, {}, 'reauth-required'], [403, {}, 'reauth-required'],
    [400, { error: 'invalid_client' }, 'reauth-required']
  ] as const) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => { calls++; return response(body, status) }))
    assert.equal((await service.refresh(credential)).failureKind, failureKind, String(status))
    if (failureKind === 'uncertain') {
      assert.equal((await service.refresh(credential)).failureKind, failureKind, String(status))
      assert.equal(calls, 1, 'an intermediary failure may hide a completed refresh')
    }
  }
  let calls = 0
  const service = new TokenRefreshService(dependencies(async () => { calls++; throw new Error('SYNTHETIC_TRANSPORT') }))
  assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
  assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
  assert.equal(calls, 1)
})

test('connection setup failures allow a later explicit refresh without automatically replaying the POST', async () => {
  const setupError = (code: string) => Object.assign(new Error('SYNTHETIC_PRIVATE_CONNECTION'), { code })
  for (const cause of [
    ...['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_PROXY_POOL_CAPACITY'].map(setupError),
    new AggregateError([setupError('ECONNREFUSED'), setupError('ENOTFOUND')])
  ]) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed', { cause })
      return response(good)
    }))
    const failed = await service.refresh(credential)
    assert.equal(failed.errorCode, 'network')
    assert.equal(failed.failureKind, 'temporary')
    assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC_PRIVATE_CONNECTION/)
    assert.equal(calls, 1, 'the first attempt never automatically retries')
    assert.equal((await service.refresh({ ...credential, manualRetry: true })).success, true)
    assert.equal(calls, 2, 'the next explicit call can recover in the same process')
  }
})

test('real fetch connection refusal recovers in the same service after the local listener returns', async () => {
  for (const fetcher of [fetch, undiciFetch]) {
    let delivered = 0
    const server = createServer((request, reply) => {
      delivered++
      request.resume()
      reply.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      reply.end(JSON.stringify(good))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    let calls = 0
    const service = new TokenRefreshService(dependencies(async (_url, init) => {
      calls++
      return await fetcher(`http://127.0.0.1:${port}/token`, init)
    }))
    const failed = await service.refresh(credential)
    assert.equal(calls, 1)
    assert.equal(delivered, 0)
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
    try {
      const recovered = await service.refresh({ ...credential, manualRetry: true })
      assert.equal(failed.failureKind, 'temporary')
      assert.equal(recovered.success, true)
      assert.equal(calls, 2)
      assert.equal(delivered, 1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
})

test('unknown failures, mixed connection outcomes and response read failures remain uncertain', async () => {
  const setup = Object.assign(new Error('SYNTHETIC_PRIVATE'), { code: 'ENOTFOUND' })
  const socket = Object.assign(new Error('SYNTHETIC_PRIVATE'), { code: 'ECONNRESET' })
  const cyclic: { cause?: unknown } = {}
  cyclic.cause = cyclic
  for (const error of [new Error('SYNTHETIC_PRIVATE'), socket,
    ...['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].map(code => Object.assign(new Error(), { code })),
    new AggregateError([setup, socket]), new AggregateError([]), cyclic,
    Object.assign(new AggregateError([setup]), { code: 'ECONNRESET' }),
    Object.assign(new Error(), { code: 'ECONNRESET', cause: setup })]) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => { calls++; throw new TypeError('fetch failed', { cause: error }) }))
    assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
    assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
    assert.equal(calls, 1)
  }
  for (const status of [200, 503]) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => {
      calls++
      return { ok: status === 200, status, json: async () => { throw setup } }
    }))
    const first = await service.refresh(credential)
    if (status === 200) {
      assert.equal(first.failureKind, 'uncertain', 'receiving headers proves the request was sent')
      assert.equal((await service.refresh(credential)).failureKind, 'uncertain')
      assert.equal(calls, 1)
    } else {
      assert.equal(first.failureKind, 'temporary', 'a confirmed HTTP 503 keeps its existing classification')
    }
  }
})

test('a bare HTTP 403 does not diagnose a permanently invalid account credential', async () => {
  for (const [body, preserveStatus] of [[{}, true], [{ error: 'invalid_grant' }, false]] as const) {
    const service = new TokenRefreshService(dependencies(async () => response(body, 403)))
    const result = await service.refresh(credential)
    assert.equal(result.failureKind, 'reauth-required')
    assert.equal(!!result.preserveStatus, preserveStatus)
  }
})

test('other inconclusive HTTP refusals preserve health without changing the explicit retry policy', async () => {
  for (const status of [400, 403, 404, 422]) {
    for (const body of [{}, { error: 'access_denied' }, { error: 'unsupported_grant_type' }]) {
      const service = new TokenRefreshService(dependencies(async () => response(body, status)))
      const result = await service.refresh(credential)
      assert.equal(result.success, false)
      assert.equal(result.failureKind, 'reauth-required')
      assert.equal(result.preserveStatus, true, `unconfirmed HTTP ${status}`)
    }
  }
  for (const [status, body] of [[401, {}], [400, { error: 'invalid_grant' }], [403, { error: 'invalid_client' }]] as const) {
    const service = new TokenRefreshService(dependencies(async () => response(body, status)))
    assert.equal(!!(await service.refresh(credential)).preserveStatus, false)
  }
})

test('refresh failures retain only allowlisted service diagnostics and the actual HTTP status', async () => {
  for (const [status, body, expectedCode] of [
    [400, { error: 'invalid_grant', message: 'SYNTHETIC_PRIVATE' }, 'invalid_grant'],
    [403, { error: 'access_denied', message: 'SYNTHETIC_PRIVATE' }, 'access_denied'],
    [429, { error: 'slow_down' }, 'slow_down'],
    [504, { error: 'temporarily_unavailable' }, 'temporarily_unavailable'],
    [403, { error: 'SYNTHETIC_PRIVATE', message: 'SYNTHETIC_PRIVATE' }, undefined],
    [403, { error: { code: 'SYNTHETIC_PRIVATE' } }, undefined]
  ] as const) {
    let calls = 0
    const service = new TokenRefreshService(dependencies(async () => { calls++; return response(body, status) }))
    const result = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_REFRESH' })
    assert.equal(result.httpStatus, status)
    assert.equal(result.serviceCode, expectedCode)
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|SYNTHETIC_REFRESH/)
    assert.equal(calls, 1)
  }
})

test('safe refresh diagnostics reject malformed metadata and describe effective status preservation', () => {
  for (const httpStatus of [NaN, Infinity, -1, 600, 403.5, 'SYNTHETIC_PRIVATE']) {
    const diagnostic = refreshFailureDiagnostic({
      success: false, httpStatus, errorCode: 'SYNTHETIC_PRIVATE', failureKind: 'SYNTHETIC_PRIVATE',
      serviceCode: 'SYNTHETIC_PRIVATE', error: 'SYNTHETIC_PRIVATE', accessToken: 'SYNTHETIC_PRIVATE'
    } as unknown as AuthRefreshResult)
    assert.equal(diagnostic.httpStatus, undefined)
    assert.equal(diagnostic.errorCode, 'unknown')
    assert.equal(diagnostic.failureKind, 'unknown')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_PRIVATE|accessToken|error"/)
  }
  assert.equal(refreshFailureDiagnostic({ success: false, errorCode: 'timeout', failureKind: 'uncertain' }).preserveStatus, true)
  assert.equal(refreshFailureDiagnostic({ success: false, errorCode: 'http', failureKind: 'reauth-required' }).preserveStatus, false)
})

test('HTTP refusal diagnostics distinguish JSON from HTML without returning response content', async () => {
  for (const [contentType, parses, expected] of [
    ['application/json', true, 'json'],
    ['text/html; charset=utf-8', false, 'html'],
    ['TEXT/HTML', false, 'html'],
    ['application/json', false, 'unknown'],
    ['text/plain; SYNTHETIC_PRIVATE', false, 'unknown'],
    [null, false, 'unknown']
  ] as const) {
    const service = new TokenRefreshService({
      ...dependencies(async () => response({})),
      fetch: async () => ({
        ok: false, status: 403, headers: { get: () => contentType },
        json: async () => { if (!parses) throw new Error('<html>SYNTHETIC_PRIVATE</html>'); return { error: 'access_denied', message: 'SYNTHETIC_PRIVATE' } }
      })
    })
    const result = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_REFRESH' })
    assert.equal(result.httpStatus, 403)
    assert.equal(result.responseFormat, expected)
    assert.equal(refreshFailureDiagnostic(result).responseFormat, expected)
    assert.equal(result.preserveStatus, true)
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|<html>|text\/html|charset/)
  }
})

test('shared refresh service cools repeated failures while an explicit manual retry remains deliberate', async () => {
  let now = 1_800_000_000_000, calls = 0
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return response({}, 403) }), now: () => now })
  const first = await service.refresh(credential)
  assert.equal(first.success, false)
  assert.equal(first.retryDeferred, undefined)
  const deferred = await service.refresh(credential)
  assert.equal(calls, 1)
  assert.equal(deferred.retryDeferred, true)
  assert.equal(deferred.retryAfterMs, 5000)
  now += 4999
  assert.equal((await service.refresh(credential)).retryAfterMs, 1)
  now++
  assert.equal((await service.refresh(credential)).retryDeferred, undefined)
  assert.equal(calls, 2)
  assert.equal((await service.refresh({ ...credential, manualRetry: true })).retryDeferred, undefined)
  assert.equal(calls, 3)
})

test('a burst of distinct Social HTML refusals opens a shared route gate and defers queued POSTs', async () => {
  let calls = 0, active = 0, peak = 0
  const service = new TokenRefreshService({
    ...dependencies(async () => {
      calls++; active++; peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } }
    }), now: () => 1_800_000_000_000
  })
  const results = await Promise.all(Array.from({ length: 300 }, (_, i) => service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` })))
  assert.ok(peak <= 4, `peak ${peak}`)
  assert.ok(calls <= 6, `sent ${calls} POSTs before the shared rejection gate opened`)
  assert.equal(results.filter(result => result.retryDeferred).length, results.length - calls)
  assert.ok(results.every(result => result.success === false))
  assert.ok(results.filter(result => result.retryDeferred).every(result => result.retryAfterMs > 0 && result.retryAfterMs <= 1_800_000))
  assert.equal((await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_LATER' })).retryDeferred, true)
})

test('one recovery probe can restore a Social route without treating its rejected credential as healthy', async () => {
  let now = 1_800_000_000_000, calls = 0, reachable = false
  let releaseProbe: (() => void) | undefined
  const service = new TokenRefreshService({ ...dependencies(async () => {
    calls++
    if (reachable) {
      if (releaseProbe === undefined) await new Promise<void>(resolve => { releaseProbe = resolve })
      return response({ error: 'invalid_grant' }, 400)
    }
    return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } }
  }), now: () => now })
  for (let i = 0; i < 3; i++) await service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` })
  const beforeProbe = calls
  now += 5000; reachable = true
  const probe = service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_PROBE' })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  const waiting = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_WAITING' })
  assert.equal(waiting.retryDeferred, true)
  assert.equal(calls, beforeProbe + 1)
  assert.ok(releaseProbe)
  releaseProbe()
  const rejected = await probe
  assert.equal(rejected.success, false)
  assert.equal(rejected.serviceCode, 'invalid_grant')
  assert.equal((await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_PROBE' })).retryDeferred, true)
  const next = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_NEXT' })
  assert.equal(next.retryDeferred, undefined)
  assert.equal(next.success, false)
  assert.equal(calls, beforeProbe + 2)
})

test('manual retry never bypasses an uncertain POST or an already consumed credential generation', async () => {
  let calls = 0
  const uncertain = new TokenRefreshService(dependencies(async () => { calls++; throw new Error('SYNTHETIC_UNCERTAIN') }))
  await uncertain.refresh(credential)
  assert.equal((await uncertain.refresh({ ...credential, manualRetry: true })).failureKind, 'uncertain')
  assert.equal(calls, 1)
  let rotatedCalls = 0
  const rotated = new TokenRefreshService(dependencies(async () => { rotatedCalls++; return response(good) }))
  await rotated.refresh(credential)
  assert.equal((await rotated.refresh({ ...credential, manualRetry: true })).refreshToken, good.refreshToken)
  assert.equal(rotatedCalls, 1)
})

test('an older success joining a newer failed lineage cannot erase its cooldown or report a fresh rejection', async () => {
  let now = 1_800_000_000_000, calls = 0
  let releaseOld: ((value: ReturnType<typeof response>) => void) | undefined
  const service = new TokenRefreshService({ ...dependencies(async (_url, init) => {
    calls++
    const token = JSON.parse(String(init.body)).refreshToken
    if (token === 'SYNTHETIC_A') return new Promise(resolve => { releaseOld = resolve })
    if (token === 'SYNTHETIC_B') return response({ ...good, refreshToken: 'SYNTHETIC_C' })
    return response({}, 403)
  }), now: () => now })
  const pending = service.refresh({ ...credential, refreshToken: 'SYNTHETIC_A' })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await service.refresh({ ...credential, refreshToken: 'SYNTHETIC_B' })
  now += 16000
  await service.refresh({ ...credential, refreshToken: 'SYNTHETIC_C' })
  assert.equal((await service.refresh({ ...credential, refreshToken: 'SYNTHETIC_C' })).retryDeferred, true)
  releaseOld!(response({ ...good, refreshToken: 'SYNTHETIC_C' }))
  const joined = await pending
  assert.equal(joined.success, false)
  assert.equal(joined.retryDeferred, true)
  assert.equal((await service.refresh({ ...credential, refreshToken: 'SYNTHETIC_C' })).retryDeferred, true)
  assert.equal(calls, 3)
})

test('credential cooldown follows the official sequence, caps at 30 minutes, and resets after success', async () => {
  let now = 1_800_000_000_000, calls = 0, succeed = false
  const service = new TokenRefreshService({ ...dependencies(async () => { calls++; return succeed ? response({ ...good, refreshToken: credential.refreshToken }) : response({}, 403) }), now: () => now })
  for (let attempt = 1; attempt <= 65; attempt++) {
    const result = await service.refresh(credential)
    const expected = attempt <= 4 ? [5000, 10000, 15000, 30000][attempt - 1] : Math.min((attempt - 3) * 30000, 1800000)
    assert.equal(result.retryAfterMs, expected)
    assert.equal((await service.refresh(credential)).retryDeferred, true)
    assert.equal(calls, attempt)
    now += expected + 1
  }
  succeed = true
  assert.equal((await service.refresh(credential)).success, true)
  now += 16000; succeed = false
  assert.equal((await service.refresh(credential)).retryAfterMs, 5000)
})

test('throttling, server errors and arbitrary JSON cannot reopen a blocked Social route', async () => {
  for (const [status, body] of [[429, { error: 'slow_down' }], [503, { error: 'server_error' }],
    [400, { error: 'slow_down' }], [400, {}], [403, {}], [401, { error: 'temporarily_unavailable' }]] as const) {
    let now = 1_800_000_000_000, calls = 0, probe = false
    const service = new TokenRefreshService({ ...dependencies(async () => {
      calls++
      return probe ? response(body, status) : { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } }
    }), now: () => now })
    for (let i = 0; i < 3; i++) await service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` })
    now += 5000; probe = true
    await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_PROBE' })
    const waiting = await Promise.all(Array.from({ length: 100 }, (_, i) => service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_WAITING_${i}` })))
    assert.equal(calls, 4, `${status}: continued throttling or an unrecognized envelope must keep the gate closed`)
    assert.ok(waiting.every(result => result.retryDeferred === true))
  }
})

test('a proxy change while queued re-enters admission and never sends through the old captured route', async () => {
  let route = 'route-A'
  const sent: string[] = [], release: Array<() => void> = []
  const service = new TokenRefreshService({ ...dependencies(async () => response({})),
    resolveTransport: () => {
      const selected = route
      return { routeKey: selected, fetch: async () => {
        sent.push(selected)
        if (sent.length <= 4) await new Promise<void>(resolve => release.push(resolve))
        return response({ error: 'invalid_grant' }, 400)
      } }
    }
  })
  const calls = Array.from({ length: 5 }, (_, i) => service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` }))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(sent.length, 4)
  route = 'route-B'
  for (const done of release) done()
  await Promise.all(calls)
  assert.deepEqual(sent, ['route-A', 'route-A', 'route-A', 'route-A', 'route-B'])
})

test('queued requests start their timeout only after admission and uncertain generations still cannot replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: Array<(value: ReturnType<typeof response>) => void> = []
  const service = new TokenRefreshService({ ...dependencies(async () => new Promise(resolve => requests.push(resolve))), timeoutMs: 1000 })
  const calls = Array.from({ length: 5 }, (_, i) => service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` }))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(requests.length, 4)
  t.mock.timers.tick(1000)
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(requests.length, 5)
  requests[4](response(good))
  const results = await Promise.all(calls)
  assert.ok(results.slice(0, 4).every(result => result.failureKind === 'uncertain'))
  assert.equal(results[4].success, true, 'a request that was only queued must not be recorded as an uncertain POST')
  assert.equal((await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_0', manualRetry: true })).retryDeferred, true)
  assert.equal(requests.length, 5)
})

test('a manual retry permits one recovery probe while other callers still observe the route cooldown', async () => {
  let calls = 0, probe = false
  let release: (() => void) | undefined
  const service = new TokenRefreshService({ ...dependencies(async () => {
    calls++
    if (probe) { await new Promise<void>(resolve => { release = resolve }); return response({ error: 'invalid_grant' }, 401) }
    return { ok: false, status: 403, headers: { get: () => 'text/html' }, json: async () => { throw new Error('SYNTHETIC_HTML') } }
  }), now: () => 1_800_000_000_000 })
  for (let i = 0; i < 3; i++) await service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}` })
  probe = true
  const pending = service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_0', manualRetry: true })
  for (let i = 0; i < 15; i++) await Promise.resolve()
  const other = await service.refresh({ kind: 'social', refreshToken: 'SYNTHETIC_OTHER', manualRetry: true })
  assert.equal(other.retryDeferred, true)
  assert.equal(calls, 4)
  release!()
  assert.equal((await pending).success, false)
})

test('idle route records expire and the route map rejects overflow without dispatching a POST', async () => {
  let now = 1_800_000_000_000, calls = 0
  const transport = async () => { calls++; return response({ error: 'invalid_grant' }, 401) }
  const service = new TokenRefreshService({ ...dependencies(transport), now: () => now,
    resolveTransport: proxyUrl => ({ routeKey: proxyUrl || 'direct', fetch: transport }) })
  for (let i = 0; i < 128; i++) await service.refresh({ kind: 'social', refreshToken: `SYNTHETIC_${i}`, proxyUrl: `route-${i}` })
  assert.equal(calls, 128)
  const overflow = { kind: 'social' as const, refreshToken: 'SYNTHETIC_OVERFLOW', proxyUrl: 'route-overflow' }
  assert.equal((await service.refresh(overflow)).retryDeferred, true)
  assert.equal(calls, 128)
  now += 3600001
  assert.equal((await service.refresh(overflow)).retryDeferred, undefined)
  assert.equal(calls, 129)
})

test('safe diagnostics distinguish an actual failed POST from deferred or reused failure observations', async () => {
  const service = new TokenRefreshService({ ...dependencies(async () => response({}, 403)), now: () => 1_800_000_000_000 })
  const actual = refreshFailureDiagnostic(await service.refresh(credential))
  const deferred = refreshFailureDiagnostic(await service.refresh(credential))
  assert.equal(actual.httpStatus, 403)
  assert.equal(actual.retryDeferred, undefined)
  assert.equal(actual.retryAfterMs, 5000)
  assert.equal(deferred.httpStatus, 403)
  assert.equal(deferred.retryDeferred, true)
  assert.equal(deferred.retryAfterMs, 5000)
  for (const retryAfterMs of [0, -1, Infinity, NaN, 1800001, 'SYNTHETIC_PRIVATE']) {
    const diagnostic = refreshFailureDiagnostic({ success: false, retryDeferred: 'SYNTHETIC_PRIVATE', retryAfterMs } as unknown as AuthRefreshResult)
    assert.equal(diagnostic.retryDeferred, undefined)
    assert.equal(diagnostic.retryAfterMs, undefined)
    assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC/)
  }
})
