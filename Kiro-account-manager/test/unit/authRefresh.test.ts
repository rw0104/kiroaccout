import test from 'node:test'
import assert from 'node:assert/strict'
import { TokenRefreshService } from '../../src/main/authRefresh'

const credential = { kind: 'IdC' as const, refreshToken: 'SYNTHETIC_REFRESH', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1' }
const good = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_ROTATED', expiresIn: 3600 }
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data })
const dependencies = (fetch: (url: string, init: RequestInit, proxyUrl?: string) => Promise<ReturnType<typeof response>>) => ({
  fetch, socialEndpoint: 'https://auth.example.invalid', socialUserAgent: () => 'SYNTHETIC_AGENT'
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

test('a timed-out generation cannot publish late success or overwrite a later successful retry', async () => {
  const late = deferredResponse()
  let calls = 0
  const final = { ...good, refreshToken: 'SYNTHETIC_FINAL' }
  const service = new TokenRefreshService({ ...dependencies(async () => ++calls === 1 ? late.promise : response(final)), timeoutMs: 10 })
  assert.equal((await service.refresh(credential)).errorCode, 'timeout')
  assert.equal((await service.refresh(credential)).refreshToken, final.refreshToken)
  late.resolve(response(good))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await service.refresh(credential)).refreshToken, final.refreshToken)
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

test('deadline aborts fetch and body reads, settles even a non-cooperative transport, then permits recovery', async () => {
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
  assert.equal((await service.refresh(credential)).success, true)
})
