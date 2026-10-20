import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { LoginSessionManager } from '../../src/main/loginSessions'
import { startSerialLoginPolling } from '../../src/renderer/src/lib/loginPolling'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data })
const registration = () => response({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret' })
const authorization = () => response({ deviceCode: 'synthetic-device', userCode: 'TEST-CODE', verificationUri: 'https://example.invalid/device', interval: 5, expiresIn: 600 })
const tokens = () => response({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 3600 })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('cancel during Builder start and stale completion cannot overwrite a newer session', async () => {
  const delayed = deferred<ReturnType<typeof registration>>()
  let calls = 0
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async () => ++calls === 1 ? delayed.promise : calls === 2 ? registration() : authorization() })
  const first = manager.startBuilder('A')
  manager.cancel('builderid', 'A')
  const second = await manager.startBuilder('B')
  delayed.resolve(registration())
  assert.equal((await first).status, 'cancelled')
  assert.equal(second.success, true)
  manager.cancel('builderid', 'A')
  manager.cancel('social', 'B')
  assert.equal((await manager.pollBuilder('B')).success, true)
  assert.equal(calls, 3)
  manager.cancel('builderid', 'B')
})

test('Builder enforces interval, single in-flight request and slow_down for every later poll', async () => {
  let now = 0
  let tokenCalls = 0
  const delayed = deferred<ReturnType<typeof tokens>>()
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', now: () => now, openBrowser() {}, notifySocial() {}, fetch: async url => url.endsWith('/register') ? registration() : url.endsWith('/device_authorization') ? authorization() : (++tokenCalls === 1 ? delayed.promise : tokens()) })
  await manager.startBuilder('builder')
  assert.equal((await manager.pollBuilder('builder')).retryAfter, 5)
  assert.equal(tokenCalls, 0)
  now = 5000
  const firstPoll = manager.pollBuilder('builder')
  assert.equal((await manager.pollBuilder('builder')).completed, false)
  assert.equal(tokenCalls, 1)
  delayed.resolve(response({ error: 'slow_down' }, 400))
  const slowed = await firstPoll
  assert.equal(slowed.interval, 10)
  now = 14999
  assert.equal((await manager.pollBuilder('builder')).completed, false)
  assert.equal(tokenCalls, 1)
  now = 15000
  assert.equal((await manager.pollBuilder('builder')).completed, true)
  assert.equal(tokenCalls, 2)
  assert.equal((await manager.pollBuilder('builder')).success, false)
})

test('Builder late poll cannot consume new session and errors never echo upstream response', async () => {
  let now = 0
  const delayed = deferred<ReturnType<typeof tokens>>()
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', now: () => now, openBrowser() {}, notifySocial() {}, fetch: async url => url.endsWith('/register') ? registration() : url.endsWith('/device_authorization') ? authorization() : delayed.promise })
  await manager.startBuilder('old')
  now = 5000
  const oldPoll = manager.pollBuilder('old')
  await manager.startBuilder('new')
  delayed.resolve(tokens())
  assert.equal((await oldPoll).status, 'cancelled')
  assert.equal((await manager.pollBuilder('new')).success, true)
  now = 700000
  assert.equal((await manager.pollBuilder('new')).success, false)
  const failure = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async () => response({ message: 'synthetic-private-value' }, 400) })
  assert.doesNotMatch(JSON.stringify(await failure.startBuilder('bad')), /synthetic-private-value/)
})

test('Social callback is cached before start returns; bad state leaves valid session; only one exchange', async () => {
  const opened = deferred<void>()
  let loginUrl = ''
  let calls = 0
  let notifications = 0
  const tokenReply = deferred<ReturnType<typeof tokens>>()
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser(url) { loginUrl = url; return opened.promise }, notifySocial() { notifications++ }, fetch: async () => { calls++; return tokenReply.promise } })
  const starting = manager.startSocial('social', 'Github')
  const state = new URL(loginUrl).searchParams.get('state')!
  assert.equal(manager.acceptSocialCallback({ code: 'synthetic-code', state: 'wrong' }), false)
  assert.equal(manager.acceptSocialCallback({ error: 'synthetic-private-error', state: 'wrong' }), false)
  assert.equal(manager.acceptSocialCallback({ code: 'synthetic-code', state }), true)
  assert.equal(manager.acceptSocialCallback({ code: 'synthetic-code', state }), false)
  assert.equal(notifications, 1)
  assert.equal(manager.getSocialCallback('social')?.code, 'synthetic-code')
  opened.resolve()
  assert.equal((await starting).success, true)
  assert.equal((await manager.exchangeSocial('social', 'synthetic-code', 'bad-state')).success, false)
  const exchanging = manager.exchangeSocial('social', 'synthetic-code', state)
  assert.equal((await manager.exchangeSocial('social', 'synthetic-code', state)).status, 'busy')
  assert.equal(calls, 1)
  tokenReply.resolve(tokens())
  assert.equal((await exchanging).completed, true)
  assert.equal(manager.getSocialCallback('social'), null)
  assert.equal((await manager.exchangeSocial('social', 'synthetic-code', state)).success, false)
})

test('Social expiry, cancellation and old exchange never clear a newer session; memory loss is explicit', async () => {
  let now = 0
  const delayed = deferred<ReturnType<typeof tokens>>()
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', now: () => now, openBrowser() {}, notifySocial() {}, fetch: async () => delayed.promise })
  const first = await manager.startSocial('A', 'Google')
  manager.acceptSocialCallback({ code: 'synthetic-code', state: first.state })
  const exchanging = manager.exchangeSocial('A', 'synthetic-code', first.state!)
  const second = await manager.startSocial('B', 'Github')
  delayed.resolve(tokens())
  assert.equal((await exchanging).status, 'cancelled')
  manager.cancel('social', 'A')
  assert.equal(manager.acceptSocialCallback({ code: 'next-code', state: second.state }), true)
  now = 600000
  assert.equal(manager.getSocialCallback('B'), null)
  assert.equal((await manager.exchangeSocial('B', 'next-code', second.state!)).success, false)
  const fresh = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async () => tokens() })
  assert.equal(fresh.acceptSocialCallback({ code: 'synthetic-code', state: first.state }), false)
  assert.equal(fresh.getSocialCallback('A'), null)
})

test('device response re-arms expiry from its actual lifetime after delayed registration', async () => {
  let now = 0
  const delays: number[] = []
  const cancelled: unknown[] = []
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', now: () => now, openBrowser() {}, notifySocial() {},
    schedule: ((_run: () => void, delay: number) => { delays.push(delay); return delays.length }) as unknown as typeof setTimeout,
    unschedule: (timer => { cancelled.push(timer) }) as typeof clearTimeout,
    fetch: async url => {
      if (url.endsWith('/register')) { now = 50000; return registration() }
      return response({ deviceCode: 'synthetic-device', userCode: 'TEST', verificationUri: 'https://example.invalid/device', expiresIn: 900 })
    }
  })
  await manager.startBuilder('long-device')
  assert.deepEqual(delays, [600000, 900000])
  assert.deepEqual(cancelled, [1])
  now = 610000
  // Still valid beyond the original fixed 600-second timer.
  assert.equal((await manager.pollBuilder('wrong-session')).success, false)
  manager.cancel('builderid', 'long-device')
  assert.deepEqual(cancelled, [1, 2])
})

test('Social expiry timer notifies renderer and clears retained callback', async () => {
  let expire: (() => void) | undefined
  const notifications: unknown[] = []
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial(callback) { notifications.push(callback) }, fetch: async () => tokens(),
    schedule: ((run: () => void) => { expire = run; return 1 }) as unknown as typeof setTimeout,
    unschedule: (() => {}) as typeof clearTimeout
  })
  await manager.startSocial('expiring', 'Google')
  expire!()
  assert.equal((notifications[0] as { sessionId: string }).sessionId, 'expiring')
  assert.match((notifications[0] as { error: string }).error, /过期/)
  assert.equal(manager.getSocialCallback('expiring'), null)
})

test('Social callback arriving after expiry but before timer notifies exactly once', async () => {
  let now = 0
  let timer: (() => void) | undefined
  const notifications: Array<{ sessionId: string; error?: string }> = []
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', now: () => now, openBrowser() {}, notifySocial(callback) { notifications.push(callback) }, fetch: async () => tokens(),
    schedule: ((run: () => void) => { timer = run; return 1 }) as unknown as typeof setTimeout,
    unschedule: (() => {}) as typeof clearTimeout
  })
  const first = await manager.startSocial('expired-callback', 'Google')
  const oldTimer = timer!
  now = 600001
  assert.equal(manager.acceptSocialCallback({ state: first.state, code: 'synthetic-late-code' }), false)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].sessionId, 'expired-callback')
  assert.match(notifications[0].error!, /过期/)
  assert.equal(manager.getSocialCallback('expired-callback'), null)
  oldTimer()
  assert.equal(notifications.length, 1)
  const next = await manager.startSocial('new-social', 'Github')
  oldTimer()
  assert.equal(manager.acceptSocialCallback({ state: next.state, code: 'synthetic-new-code' }), true)
  assert.equal(notifications.length, 2)
  manager.cancel('social', 'new-social')
})

test('IAM listens on the same dynamic server, rejects wrong state without consuming session and exchanges once', async () => {
  const delayed = deferred<ReturnType<typeof tokens>>()
  let tokenCalls = 0
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async url => url.endsWith('/register') ? registration() : (tokenCalls++, delayed.promise) })
  const start = await manager.startIam('iam', 'https://example.invalid/start')
  assert.equal(start.success, true)
  const authorize = new URL(start.authorizeUrl!)
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  assert.equal(callback.hostname, '127.0.0.1')
  assert.notEqual(callback.port, '')
  callback.searchParams.set('state', 'wrong')
  callback.searchParams.set('code', 'synthetic-code')
  assert.equal((await fetch(callback)).status, 400)
  assert.equal(manager.pollIam('iam').completed, false)
  callback.searchParams.set('state', authorize.searchParams.get('state')!)
  const first = fetch(callback)
  await tick()
  // Wait until the callback has reached the injected exchange without an external service.
  for (let i = 0; i < 20 && tokenCalls === 0; i++) await tick()
  assert.equal((await fetch(callback)).status, 409)
  assert.equal(tokenCalls, 1)
  delayed.resolve(tokens())
  assert.equal((await first).status, 200)
  assert.equal(manager.pollIam('iam').completed, true)
  assert.equal(manager.pollIam('iam').success, false)
})

test('IAM cancelled callback cannot publish tokens into the next session', async () => {
  const delayed = deferred<ReturnType<typeof tokens>>()
  let exchanging = false
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async url => url.endsWith('/register') ? registration() : (exchanging = true, delayed.promise) })
  const old = await manager.startIam('old', 'https://example.invalid/start')
  const auth = new URL(old.authorizeUrl!)
  const callback = new URL(auth.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', auth.searchParams.get('state')!)
  callback.searchParams.set('code', 'synthetic-code')
  const late = fetch(callback)
  for (let i = 0; i < 100 && !exchanging; i++) await tick()
  assert.equal(exchanging, true)
  manager.cancel('iamsso', 'old')
  await manager.startIam('new', 'https://example.invalid/start')
  delayed.resolve(tokens())
  assert.equal((await late).status, 410)
  manager.cancel('iamsso', 'old')
  assert.equal(manager.pollIam('new').completed, false)
  manager.cancel('iamsso', 'new')
})

test('IAM malformed loopback request returns 400 without an unhandled rejection or consuming session', async () => {
  const manager = new LoginSessionManager({ authEndpoint: 'https://example.invalid', openBrowser() {}, notifySocial() {}, fetch: async () => registration() })
  const started = await manager.startIam('malformed', 'https://example.invalid/start')
  const callback = new URL(new URL(started.authorizeUrl!).searchParams.get('redirect_uri')!)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: callback.port, path: 'http://[', method: 'GET' }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 400)
  assert.equal(manager.pollIam('malformed').completed, false)
  manager.cancel('iamsso', 'malformed')
})

test('renderer polling schedules only after await, uses returned slow interval and discards cancelled replies', async () => {
  let callback: (() => void) | undefined
  const delays: number[] = []
  const reply = deferred<number>()
  let received = 0
  let active = true
  let calls = 0
  const stop = startSerialLoginPolling({ initialInterval: 5, isCurrent: () => active, poll: async () => { calls++; return reply.promise }, onResult: async value => { received++; return value }, onError() { assert.fail('unexpected polling failure') }, schedule(run, delay) { callback = run; delays.push(delay); return 1 as unknown as ReturnType<typeof setTimeout> }, unschedule() {} })
  callback!()
  assert.equal(calls, 1)
  assert.deepEqual(delays, [5000])
  reply.resolve(10)
  await tick()
  assert.deepEqual(delays, [5000, 10000])
  assert.equal(received, 1)
  active = false
  stop()
  callback!()
  assert.equal(calls, 1)
})
