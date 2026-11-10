import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ManagedCrewService, type ManagedCrewDependencies, type ManagedCrewProcess, type ManagedCrewRuntime } from '../../src/main/managedCrew'
import type { AccessCredential, ClientAccessProjectionBinding, ManagerAccessSnapshot } from '../../src/main/clientAccessProjection'

const now = 1_800_000_000_000
const source = (name = 'A'): ManagerAccessSnapshot & { refreshToken: string; clientSecret: string } => ({
  principalId: `SYNTHETIC_SUBJECT_${name}`, provider: 'Github', authMethod: 'social', profileArn: `SYNTHETIC_PROFILE_${name}`,
  accessToken: `SYNTHETIC_ACCESS_${name}`, expiresAt: now + 3_600_000, region: 'us-east-1',
  refreshToken: `SYNTHETIC_REFRESH_${name}`, clientSecret: `SYNTHETIC_SECRET_${name}`
})
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let operation = 0
const request = (accountId = 'account-a'): { accountId: string; operationId: string } => ({ accountId,
  operationId: `12345678-1234-4234-8234-${(++operation).toString(16).padStart(12, '0')}` })
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve() }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve the inferred types of this composed mock fixture.
function fixture(t: TestContext) {
  const calls: string[] = [], writes: AccessCredential[] = [], urls: string[] = [], closures: Array<() => void> = []
  const accounts = new Map([['account-a', source()], ['account-b', source('B')]])
  const legacyBindings = Object.freeze([Object.freeze({ accountId: 'legacy', runtimeId: 'crew:official', status: 'active' })])
  const saved: { managed?: ClientAccessProjectionBinding; legacy: typeof legacyBindings } = { legacy: legacyBindings }
  let revision = 'target-initial', running = false, currentProcess: ManagedCrewProcess | undefined
  let exitSignal: ReturnType<typeof deferred<void>> | undefined
  const controls: {
    prepare?: () => Promise<void>
    launch?: () => Promise<void>
    write?: () => Promise<void>
    window?: () => Promise<void>
    stop?: () => Promise<void>
    platform: boolean
    rejectBindingSave: boolean
    stopFails: boolean
    windowFails: boolean
  } = { platform: true, rejectBindingSave: false, stopFails: false, windowFails: false }
  const runtime: ManagedCrewRuntime = {
    id: 'crew-managed:synthetic-runtime', revision: 'synthetic-installation-1', version: '0.12.0',
    adapter: {
      authDomainId: 'crew-managed:synthetic-domain',
      validate: access => { assert.equal(access.provider, 'Github') },
      readRevision: async () => { calls.push('target-read'); return revision },
      write: async (access, expected, guard) => {
        if (controls.write) await controls.write()
        assert.equal(expected, revision)
        guard()
        assert.equal('refreshToken' in access, false)
        assert.equal('clientSecret' in access, false)
        assert.equal('principalId' in access, false)
        calls.push('target-write'); writes.push({ ...access }); revision = `target-${writes.length}`
        return revision
      }
    },
    prepare: async () => { calls.push('prepare'); if (controls.prepare) await controls.prepare() },
    status: async () => { calls.push('process-status'); return running && currentProcess ? currentProcess : { running: false } },
    launch: async sessionId => {
      calls.push('launch')
      if (controls.launch) await controls.launch()
      exitSignal = deferred<void>()
      currentProcess = { running: true, ownerId: 'synthetic-owned-root', sessionId, pid: 4242, port: 54321,
        urlToken: 'SYNTHETIC_PRIVATE_URL_TOKEN', exited: exitSignal.promise }
      running = true
      return currentProcess
    },
    stop: async process => {
      calls.push('stop')
      assert.equal(process.ownerId, 'synthetic-owned-root')
      if (controls.stopFails) throw Error('SYNTHETIC_PRIVATE_STOP_ERROR')
      if (controls.stop) await controls.stop()
      running = false; exitSignal?.resolve()
    }
  }
  const deps: ManagedCrewDependencies = {
    account: id => { calls.push('source-read'); return accounts.get(id) },
    runtime: async () => { calls.push('runtime'); return runtime },
    readBinding: () => saved.managed,
    writeBinding: (binding, expected) => {
      calls.push('binding-write')
      if (controls.rejectBindingSave || saved.managed?.revision !== expected) return false
      saved.managed = { ...binding }; return true
    },
    beginOperation: id => { calls.push(`lease:${id}`); return () => { calls.push(`release:${id}`) } },
    openWindow: async (url, onClosed) => {
      calls.push('window-open'); urls.push(url); closures.push(onClosed)
      if (controls.windowFails) throw Error('SYNTHETIC_PRIVATE_WINDOW_ERROR')
      if (controls.window) await controls.window()
    },
    closeWindow: () => { calls.push('window-close') },
    platformSupported: () => controls.platform,
    now: () => now,
    intervalMs: 60_000
  }
  const service = new ManagedCrewService(deps)
  t.after(async () => { controls.stopFails = false; controls.rejectBindingSave = false; await service.close().catch(() => {}) })
  return { service, deps, runtime, controls, calls, accounts, writes, urls, closures, saved,
    running: () => running, externalExit: () => { running = false; exitSignal?.resolve() },
    changeTarget: () => { revision = 'target-external' } }
}

test('workspace inspection is read-only and unsupported platforms never inspect installations or credentials', async t => {
  const f = fixture(t)
  f.controls.platform = false
  assert.equal((await f.service.inspect('account-a')).errorCode, 'platform-unsupported')
  assert.equal((await f.service.start(request())).success, false)
  assert.equal((await f.service.open(request())).success, false)
  assert.deepEqual(f.calls, [])
  f.controls.platform = true
  assert.equal((await f.service.inspect('account-a')).canStart, true)
  assert.equal(f.calls.some(call => ['prepare', 'target-write', 'launch', 'window-open'].includes(call)), false)
})

test('start projects access only, leaves legacy bindings and source settings intact, and opens one owned window', async t => {
  const f = fixture(t)
  const accountBefore = JSON.stringify([...f.accounts]), legacyBefore = JSON.stringify(f.saved.legacy)
  const result = await f.service.start(request())
  assert.equal(result.success, true)
  assert.equal(result.state.status, 'running')
  assert.equal(result.state.selectedAccount, true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.urls.length, 1)
  assert.match(f.urls[0], /^http:\/\/127\.0\.0\.1:54321\/\?token=/)
  assert.equal(JSON.stringify([...f.accounts]), accountBefore)
  assert.equal(JSON.stringify(f.saved.legacy), legacyBefore)
  assert.equal(f.saved.managed?.authDomainId, f.runtime.adapter.authDomainId)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|127\.0\.0\.1|54321/)
  assert.equal(f.calls.filter(call => call === 'lease:account-a').length, 1)
  assert.equal(f.calls.filter(call => call === 'release:account-a').length, 1)
})

test('duplicate start and open operation IDs coalesce without another projection or window action', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), ready = deferred<void>()
  f.controls.launch = async () => { entered.resolve(); await ready.promise }
  const input = request()
  const first = f.service.start(input), duplicate = f.service.start(input)
  assert.equal(first, duplicate)
  await entered.promise
  assert.equal((await f.service.start(request('account-b'))).success, false)
  ready.resolve()
  assert.equal((await first).success, true)
  assert.equal(f.calls.filter(call => call === 'launch').length, 1)
  const openEntered = deferred<void>(), openReady = deferred<void>()
  f.controls.window = async () => { openEntered.resolve(); await openReady.promise }
  const opening = request()
  const opened = f.service.open(opening), reopened = f.service.open(opening)
  assert.equal(opened, reopened)
  await openEntered.promise; openReady.resolve(); assert.equal((await opened).success, true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.urls.length, 2)
})

test('running workspace cannot be opened, replaced or stopped from another account', async t => {
  const f = fixture(t)
  await f.service.start(request())
  const before = f.calls.length
  const state = await f.service.inspect('account-b')
  assert.equal(state.canOpen, false); assert.equal(state.canStop, false); assert.equal(state.canStart, false)
  assert.equal((await f.service.start(request('account-b'))).success, false)
  assert.equal((await f.service.open(request('account-b'))).success, false)
  assert.equal((await f.service.stop(request('account-b'))).success, false)
  assert.equal(f.calls.slice(before).some(call => ['launch', 'target-write', 'stop', 'window-open'].includes(call)), false)
  assert.equal(f.running(), true)
})

test('a source identity change during preparation is rejected before writing or launching', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), resume = deferred<void>()
  f.controls.prepare = async () => { entered.resolve(); await resume.promise }
  const pending = f.service.start(request())
  await entered.promise
  f.accounts.set('account-a', source('REPLACED'))
  resume.resolve()
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(f.writes.length, 0)
  assert.equal(f.calls.includes('launch'), false)
  assert.equal(f.calls.includes('release:account-a'), true)
})

test('a source identity change while launch is pending stops the owned process and never opens it', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), resume = deferred<void>()
  f.controls.launch = async () => { entered.resolve(); await resume.promise }
  const pending = f.service.start(request())
  await entered.promise
  f.accounts.set('account-a', source('REPLACED'))
  resume.resolve()
  assert.equal((await pending).success, false)
  assert.equal(f.calls.filter(call => call === 'stop').length, 1)
  assert.equal(f.urls.length, 0)
  assert.equal(f.running(), false)
})

test('normal access rotation syncs one new generation without restarting or changing refresh secrets', async t => {
  const f = fixture(t)
  await f.service.start(request())
  const previous = f.accounts.get('account-a')!
  f.accounts.set('account-a', { ...previous, accessToken: 'SYNTHETIC_ACCESS_ROTATED', expiresAt: now + 7_200_000 })
  await f.service.tick()
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[1].accessToken, 'SYNTHETIC_ACCESS_ROTATED')
  assert.equal(f.accounts.get('account-a')?.refreshToken, previous.refreshToken)
  assert.equal(f.calls.filter(call => call === 'launch').length, 1)
  assert.equal(f.urls.length, 1)
  await f.service.tick()
  assert.equal(f.writes.length, 2)
})

test('source replacement and external target changes pause sync rather than overwrite another identity', async t => {
  const f = fixture(t)
  await f.service.start(request())
  f.accounts.set('account-a', source('REPLACED'))
  await f.service.tick()
  assert.equal(f.writes.length, 1)
  assert.equal(f.saved.managed?.status, 'needs-attention')
  assert.equal((await f.service.inspect('account-a')).canOpen, false)
  assert.equal((await f.service.inspect('account-a')).canStop, true)
  await f.service.stop(request())
  f.accounts.set('account-a', source())
  await f.service.start(request())
  const count = f.writes.length
  f.changeTarget()
  f.accounts.set('account-a', { ...source(), accessToken: 'SYNTHETIC_ACCESS_LATEST' })
  await f.service.tick()
  assert.equal(f.writes.length, count)
  assert.equal(f.saved.managed?.reason, 'target-changed')
})

test('closing during a pending launch waits for it and prevents any late window or process revival', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), resume = deferred<void>()
  f.controls.launch = async () => { entered.resolve(); await resume.promise }
  const pending = f.service.start(request())
  await entered.promise
  const closing = f.service.close()
  resume.resolve()
  assert.equal((await pending).success, false)
  await closing
  assert.equal(f.running(), false)
  assert.equal(f.urls.length, 0)
  assert.equal((await f.service.inspect('account-a')).errorCode, 'closing')
  assert.equal(f.saved.managed?.status, 'needs-attention')
})

test('a user stop during pending launch returns only after the late process is closed', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), resume = deferred<void>()
  f.controls.launch = async () => { entered.resolve(); await resume.promise }
  const pending = f.service.start(request())
  await entered.promise
  const stopped = f.service.stop(request())
  resume.resolve()
  assert.equal((await pending).success, false)
  assert.equal((await stopped).success, true)
  assert.equal(f.running(), false)
  assert.equal(f.urls.length, 0)
})

test('owned window close stops its workspace and an old window callback cannot stop a newer account', async t => {
  const f = fixture(t)
  await f.service.start(request())
  const oldClosed = f.closures[0]
  oldClosed(); await settle()
  assert.equal(f.running(), false)
  assert.equal(f.saved.managed?.status, 'needs-attention')
  await f.service.start(request('account-b'))
  const stops = f.calls.filter(call => call === 'stop').length
  oldClosed(); await settle()
  assert.equal(f.calls.filter(call => call === 'stop').length, stops)
  assert.equal((await f.service.inspect('account-b')).canOpen, true)
})

test('window-open failure rolls back only the new owned process and reports no internal details', async t => {
  const f = fixture(t)
  f.controls.windowFails = true
  const result = await f.service.start(request())
  assert.equal(result.success, false)
  assert.equal(f.running(), false)
  assert.equal(f.calls.filter(call => call === 'stop').length, 1)
  assert.equal(f.calls.includes('window-close'), true)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|127\.0\.0\.1/)
})

test('failed stop remains retryable without claiming exit or touching another process', async t => {
  const f = fixture(t)
  await f.service.start(request())
  f.controls.stopFails = true
  const failed = await f.service.stop(request())
  assert.equal(failed.success, false)
  assert.equal(failed.state.canStop, true)
  assert.equal(f.running(), true)
  assert.equal(f.saved.managed?.status, 'active')
  assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC_PRIVATE_STOP_ERROR/)
  f.controls.stopFails = false
  assert.equal((await f.service.stop(request())).success, true)
  assert.equal(f.running(), false)
  assert.equal(f.saved.managed?.status, 'needs-attention')
})

test('closing the window while its initial open is pending cannot acknowledge a successful start', async t => {
  const f = fixture(t)
  const entered = deferred<void>(), resume = deferred<void>()
  f.controls.window = async () => { entered.resolve(); await resume.promise }
  const starting = f.service.start(request())
  await entered.promise
  f.closures[0]()
  resume.resolve()
  const result = await starting
  await settle()
  assert.equal(result.success, false)
  assert.equal(f.running(), false)
})

test('failure to persist disconnection is reported rather than claiming a fully stopped binding', async t => {
  const f = fixture(t)
  await f.service.start(request())
  f.controls.rejectBindingSave = true
  const result = await f.service.stop(request())
  assert.equal(f.running(), false)
  assert.equal(result.success, false)
  assert.equal(f.saved.managed?.status, 'active')
})

test('an identity change between open inspection and the window action cannot expose the previous account workspace', async t => {
  const f = fixture(t)
  await f.service.start(request())
  const ready = deferred<ManagedCrewRuntime>()
  f.deps.runtime = () => ready.promise
  const opening = f.service.open(request())
  ready.resolve(f.runtime)
  queueMicrotask(() => f.accounts.set('account-a', source('REPLACED')))
  const result = await opening
  assert.equal(result.success, false)
  assert.equal(f.urls.length, 1)
})

test('unexpected owned process exit closes its window and permits a fresh explicit start', async t => {
  const f = fixture(t)
  await f.service.start(request())
  f.externalExit(); await settle()
  const stopped = await f.service.inspect('account-a')
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.canOpen, false)
  assert.equal(stopped.canStart, true)
  assert.equal(f.calls.includes('window-close'), true)
  assert.equal((await f.service.start(request())).success, true)
  assert.equal(f.calls.filter(call => call === 'launch').length, 2)
})

test('installation changes pause projection and preserve an owned stop action', async t => {
  const f = fixture(t)
  await f.service.start(request())
  f.deps.runtime = async () => ({ ...f.runtime, revision: 'synthetic-installation-2' })
  f.accounts.set('account-a', { ...source(), accessToken: 'SYNTHETIC_NEW_ACCESS' })
  await f.service.tick()
  assert.equal(f.writes.length, 1)
  const state = await f.service.inspect('account-a')
  assert.equal(state.errorCode, 'installation-changed')
  assert.equal(state.canOpen, false)
  assert.equal(state.canStop, true)
  assert.equal((await f.service.stop(request())).success, true)
})
