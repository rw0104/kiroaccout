import assert from 'node:assert/strict'
import test from 'node:test'
import { TokenRefreshService } from '../../src/main/authRefresh.ts'
import { getKiroSocialUserAgent } from '../../src/shared/kiroClientCompatibility.ts'

test('Social refresh uses the verified current auth-service identity without legacy SDK headers', async () => {
  const requests: RequestInit[] = []
  const service = new TokenRefreshService({
    fetch: async (_url, init) => {
      requests.push(init)
      return { ok: true, status: 200, json: async () => ({ accessToken: 'synthetic-access', refreshToken: 'synthetic-next', expiresIn: 3600 }) }
    },
    socialEndpoint: 'https://auth.invalid',
    socialUserAgent: () => getKiroSocialUserAgent('synthetic-machine')
  })
  assert.equal((await service.refresh({ kind: 'social', refreshToken: 'synthetic-refresh' })).success, true)
  assert.deepEqual(requests[0].headers, {
    'Content-Type': 'application/json',
    'User-Agent': 'KiroIDE-1.4.154-synthetic-machine'
  })
  assert.equal(requests[0].body, JSON.stringify({ refreshToken: 'synthetic-refresh' }))

  assert.equal((await service.refresh({ kind: 'IdC', refreshToken: 'synthetic-idc-refresh', clientId: 'synthetic-client', clientSecret: 'synthetic-secret' })).success, true)
  assert.deepEqual(requests[1].headers, { 'Content-Type': 'application/json' })
})

test('Social identity handles missing or unsafe optional machine metadata', () => {
  assert.equal(getKiroSocialUserAgent(), 'KiroIDE-1.4.154')
  assert.equal(getKiroSocialUserAgent(''), 'KiroIDE-1.4.154')
  assert.equal(getKiroSocialUserAgent('machine\r\nInjected: yes'), 'KiroIDE-1.4.154')
  assert.equal(getKiroSocialUserAgent('a'.repeat(129)), 'KiroIDE-1.4.154')
})
