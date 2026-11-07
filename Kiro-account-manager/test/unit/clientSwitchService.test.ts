import test from 'node:test'
import assert from 'node:assert/strict'
import { ClientSwitchService, type ClientSwitchDependencies, type ClientSwitchRuntime } from '../../src/main/clientSwitch'
import { ClientAccessProjectionService, accessPrincipalFingerprint, type ManagerAccessSnapshot, type ClientAccessProjectionBinding,
  type ClientAccessProjectionAdapter, type ClientAccessProjectionDependencies } from '../../src/main/clientAccessProjection'
import type { ClientSwitchRequest, ExternalClientTarget } from '../../src/shared/clientSwitch'
import { cliAccessPayload } from '../../src/main/cliAccessAdapter'

const now = 1_800_000_000_000
const request: ClientSwitchRequest = { operationId: 'op-first', accountId: 'account-a', target: 'cli',
  runtimeId: 'runtime-cli', expectedRuntimeRevision: 'runtime-v1' }
interface ManagerFixtureAccount extends ManagerAccessSnapshot {
  refreshToken: string
  activeAccountId: string
  autoRefreshEnabled: boolean
  autoRefreshInterval: number
  status: string
  generation: number
}

const source = (): ManagerFixtureAccount => ({ accessToken: 'SYNTHETIC_ACCESS', expiresAt: now + 3_600_000, provider: 'Github',
  authMethod: 'social', profileArn: 'SYNTHETIC_PROFILE', region: 'us-east-1', principalId: 'SYNTHETIC_SUBJECT_A', temporarilyUnavailable: false,
  refreshToken: 'SYNTHETIC_REFRESH_MUST_REMAIN_PRIVATE', activeAccountId: 'account-a',
  autoRefreshEnabled: true, autoRefreshInterval: 5, status: 'active', generation: 3 })
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

interface SwitchFixture {
  managerAccount: ManagerFixtureAccount
  counters: Record<'accountReads' | 'runtimeReads' | 'targetReads' | 'writes' | 'acquired' | 'released', number>
  bindings: Map<string, ClientAccessProjectionBinding>
  adapter: ClientAccessProjectionAdapter
  cli: ClientSwitchRuntime
  crew: ClientSwitchRuntime
  runtimes: Map<ExternalClientTarget, ClientSwitchRuntime>
  deps: ClientSwitchDependencies
  projection: ClientAccessProjectionService
  service: ClientSwitchService
  setRunning(value: boolean): void
  externalTargetChange(): void
  failMetadata(): void
}

function fixture(): SwitchFixture {
  const managerAccount = source()
  const counters = { accountReads: 0, runtimeReads: 0, targetReads: 0, writes: 0, acquired: 0, released: 0 }
  const bindings = new Map<string, ClientAccessProjectionBinding>()
  let targetRevision = 'target-v1'
  let running = false
  let failMetadata = false
  const adapter: ClientAccessProjectionAdapter = {
    authDomainId: 'shared-domain',
    readRevision: async () => { counters.targetReads++; return targetRevision },
    write: async (access, expected, guard) => {
      assert.equal(expected, targetRevision)
      guard()
      assert.equal('refreshToken' in access, false)
      assert.equal('autoRefreshEnabled' in access, false)
      counters.writes++
      targetRevision = `written-${counters.writes}`
      return targetRevision
    }
  }
  const cli: ClientSwitchRuntime = { id: 'runtime-cli', target: 'cli', revision: 'runtime-v1', version: 'synthetic',
    adapter, isRunning: async () => running }
  const crew: ClientSwitchRuntime = { ...cli, id: 'runtime-crew', target: 'crew' }
  const runtimes = new Map<ExternalClientTarget, ClientSwitchRuntime>([['cli', cli], ['crew', crew]])
  const projectionDeps: ClientAccessProjectionDependencies = {
    account: id => { counters.accountReads++; return id === 'account-a' ? managerAccount : undefined },
    adapter: id => [...runtimes.values()].find(runtime => runtime.id === id)?.adapter,
    readBindings: () => [...bindings.values()].map(binding => ({ ...binding })),
    writeBinding: (binding, expected) => {
      if (failMetadata || bindings.get(binding.authDomainId)?.revision !== expected) return false
      bindings.set(binding.authDomainId, { ...binding })
      return true
    },
    now: () => now
  }
  const projection = new ClientAccessProjectionService(projectionDeps)
  const deps: ClientSwitchDependencies = {
    account: projectionDeps.account,
    runtime: async target => { counters.runtimeReads++; return runtimes.get(target) },
    projection, bindings: projectionDeps.readBindings,
    beginOperation: () => { counters.acquired++; return () => { counters.released++ } },
    now: () => now
  }
  return { managerAccount, counters, bindings, adapter, cli, crew, runtimes, deps, projection,
    service: new ClientSwitchService(deps),
    setRunning: (value: boolean) => { running = value },
    externalTargetChange: () => { targetRevision = 'changed-by-official-client' },
    failMetadata: () => { failMetadata = true } }
}

test('invalid execution requests, including IDE, never read accounts/runtimes or acquire a lease', async () => {
  const f = fixture()
  for (const invalid of [null, {}, { ...request, operationId: '' }, { ...request, accountId: 'bad\naccount' },
    { ...request, target: 'ide' }, { ...request, target: 'both' }, { ...request, runtimeId: '' },
    { ...request, expectedRuntimeRevision: 'bad\0revision' }]) {
    const result = await f.service.execute(invalid as ClientSwitchRequest)
    assert.equal(result.errorCode, 'INVALID_REQUEST')
    assert.equal(result.credentialWrite, 'not-started')
  }
  assert.deepEqual(f.counters, { accountReads: 0, runtimeReads: 0, targetReads: 0, writes: 0, acquired: 0, released: 0 })
  assert.equal(f.bindings.size, 0)
  await assert.rejects(f.service.inspect('bad\naccount'))
  assert.equal(f.counters.accountReads, 0)
})

test('stale caller runtime id or revision blocks projection and releases its operation lease', async () => {
  for (const patch of [{ runtimeId: 'old-runtime' }, { expectedRuntimeRevision: 'old-revision' }]) {
    const f = fixture()
    const result = await f.service.execute({ ...request, ...patch })
    assert.equal(result.errorCode, 'RUNTIME_CHANGED')
    assert.equal(result.credentialWrite, 'not-started')
    assert.equal(f.counters.writes, 0)
    assert.equal(f.counters.acquired, 1)
    assert.equal(f.counters.released, 1)
  }
})

test('running unbound targets and unverifiable process state cannot be replaced', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture()
    f.setRunning(true)
    if (uncertain) f.cli.isRunning = async () => { throw new Error('SYNTHETIC_PRIVATE_PROCESS_DETAIL') }
    const result = await f.service.execute(request)
    assert.equal(result.errorCode, 'CLIENT_NOT_READY')
    assert.equal(f.counters.writes, 0)
    assert.equal(f.counters.released, 1)
    assert.equal(JSON.stringify(result).includes('PRIVATE_PROCESS_DETAIL'), false)
  }
})

test('a running target with externally changed auth cannot use its stale binding to bypass the idle check', async () => {
  const f = fixture()
  assert.equal((await f.service.execute(request)).status, 'credentials-written')
  f.externalTargetChange()
  f.setRunning(true)
  const result = await f.service.execute({ ...request, operationId: 'op-after-user-login' })
  assert.equal(result.errorCode, 'CLIENT_NOT_READY')
  assert.equal(result.credentialWrite, 'not-started')
  assert.equal(f.counters.writes, 1)
  assert.equal(f.counters.acquired, 2)
  assert.equal(f.counters.released, 2)
})

test('the same unchanged binding may stay running without another write or new-session instruction', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.setRunning(true)
  const result = await f.service.execute({ ...request, operationId: 'op-same-binding' })
  assert.equal(result.status, 'credentials-written')
  assert.equal(result.requiresNewSession, false)
  assert.equal(f.counters.writes, 1)
  assert.equal(f.counters.released, 2)
})

test('identical pending operation ids share one promise; reusing the id for another request is rejected', async () => {
  const f = fixture()
  const runtimeGate = deferred<void>()
  const original = f.deps.runtime
  f.deps.runtime = async target => { await runtimeGate.promise; return await original(target) }
  const first = f.service.execute(request)
  assert.equal(f.service.execute({ ...request }), first)
  const mismatch = await f.service.execute({ ...request, target: 'crew' })
  assert.equal(mismatch.errorCode, 'OPERATION_MISMATCH')
  assert.equal(f.counters.acquired, 1)
  assert.equal(f.counters.released, 0)
  runtimeGate.resolve()
  assert.equal((await first).status, 'credentials-written')
  assert.equal(f.counters.writes, 1)
  assert.equal(f.counters.released, 1)
})

test('lease refusals and missing accounts remain state-only errors without target writes', async () => {
  const denied = fixture()
  denied.deps.beginOperation = () => { throw new Error('SYNTHETIC_PRIVATE_OWNER_DETAIL') }
  const denial = await denied.service.execute(request)
  assert.equal(denial.errorCode, 'SWITCH_REFUSED')
  assert.equal(JSON.stringify(denial).includes('PRIVATE_OWNER_DETAIL'), false)
  assert.equal(denied.counters.writes, 0)
  const missing = fixture()
  const result = await missing.service.execute({ ...request, accountId: 'deleted-account' })
  assert.equal(result.errorCode, 'CLIENT_NOT_READY')
  assert.equal(missing.counters.writes, 0)
  assert.equal(missing.counters.released, 1)
})

test('target commit followed by failed binding CAS reports committed failure without rolling credentials back', async () => {
  const f = fixture()
  f.failMetadata()
  const result = await f.service.execute(request)
  assert.equal(result.status, 'failed')
  assert.equal(result.credentialWrite, 'committed')
  assert.equal(result.credentialRotation, 'none')
  assert.equal(result.errorCode, 'binding-changed')
  assert.equal(f.counters.writes, 1)
  assert.equal(f.bindings.size, 0)
  assert.equal(f.counters.released, 1)
})

test('successful projection leaves manager login, refresh settings and private credentials unchanged', async () => {
  const f = fixture()
  const before = JSON.stringify(f.managerAccount)
  const inspected = await f.service.inspect('account-a')
  assert.equal(f.counters.writes, 0)
  assert.equal(f.counters.acquired, 0)
  assert.ok(inspected.targets.every(capability => capability.status === 'ready'))
  const result = await f.service.execute(request)
  assert.equal(result.status, 'credentials-written')
  assert.equal(result.credentialRotation, 'none')
  assert.equal(result.requiresNewSession, true)
  assert.deepEqual(result.affectedTargets.sort(), ['cli', 'crew'])
  assert.equal(JSON.stringify(f.managerAccount), before)
  assert.equal(JSON.stringify(result).includes(f.managerAccount.accessToken), false)
  assert.equal(JSON.stringify(inspected).includes(f.managerAccount.refreshToken), false)
  assert.equal(f.counters.released, 1)
})

test('near-expiry source access blocks without starting a second manager refresh path', async () => {
  const f = fixture()
  f.managerAccount.expiresAt = now + 180_000
  const before = JSON.stringify(f.managerAccount)
  const result = await f.service.execute(request)
  assert.equal(result.errorCode, 'CLIENT_NOT_READY')
  assert.equal(f.counters.writes, 0)
  assert.equal(JSON.stringify(f.managerAccount), before)
  assert.equal(f.counters.released, 1)
})

test('real CLI schema validation blocks incomplete Enterprise details before any target read or write', async () => {
  for (const patch of [{ startUrl: undefined }, { startUrl: '' }, { startUrl: 'https://view.awsapps.com/start' },
    { startUrl: 'https://awsapps.com.attacker.invalid/start' }, { profileArn: '' }, { profileArn: undefined }]) {
    const f = fixture()
    Object.assign(f.managerAccount, { provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
      startUrl: 'https://synthetic-team.awsapps.com/start', profileArn: 'SYNTHETIC_ENTERPRISE_PROFILE' }, patch)
    let validations = 0
    f.adapter.validate = access => {
      validations++
      assert.equal('principalId' in access, false)
      assert.equal('refreshToken' in access, false)
      cliAccessPayload(access)
    }
    const before = JSON.stringify(f.managerAccount)
    const snapshot = await f.service.inspect('account-a')
    assert.ok(snapshot.targets.every(item => item.status === 'blocked'))
    const result = await f.service.execute(request)
    assert.equal(result.status, 'blocked')
    assert.equal(result.errorCode, 'CLIENT_NOT_READY')
    assert.equal(result.credentialWrite, 'not-started')
    assert.equal(f.counters.targetReads, 0)
    assert.equal(f.counters.writes, 0)
    assert.equal(f.bindings.size, 0)
    assert.equal(JSON.stringify(f.managerAccount), before)
    const sourceShapeRejected = patch.startUrl === '' || patch.profileArn === ''
    assert.equal(validations > 0, !sourceShapeRejected, 'empty source fields stop at the shared whitelist; other incomplete values reach the real CLI validator')
    assert.equal(f.counters.acquired, f.counters.released)
  }
})

test('complete Enterprise details pass the same real CLI validator without forwarding manager secrets', async () => {
  const f = fixture()
  Object.assign(f.managerAccount, { provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
    startUrl: 'https://synthetic-team.awsapps.com/start', profileArn: 'SYNTHETIC_ENTERPRISE_PROFILE' })
  let validatedStartUrl: string | undefined
  f.adapter.validate = access => { validatedStartUrl = access.startUrl; cliAccessPayload(access) }
  const before = JSON.stringify(f.managerAccount)
  assert.equal((await f.service.execute(request)).status, 'credentials-written')
  assert.equal(validatedStartUrl, 'https://synthetic-team.awsapps.com/start')
  assert.equal(f.counters.writes, 1)
  assert.equal(JSON.stringify(f.managerAccount), before)
})

test('same record ID with a different Builder ID principal is disconnected and cannot rebind a busy target', async () => {
  const f = fixture()
  Object.assign(f.managerAccount, { provider: 'BuilderId', authMethod: 'IdC', profileArn: undefined, principalId: 'builder-subject-a' })
  await f.service.execute(request)
  f.managerAccount.principalId = 'builder-subject-b'
  f.managerAccount.accessToken = 'SYNTHETIC_DIFFERENT_BUILDER'
  f.setRunning(true)
  const snapshot = await f.service.inspect(request.accountId)
  const capability = snapshot.targets.find(item => item.target === 'cli')!
  assert.equal(capability.connected, false)
  assert.equal(capability.status, 'blocked')
  const refused = await f.service.execute({ ...request, operationId: 'new-principal-busy' })
  assert.equal(refused.errorCode, 'CLIENT_NOT_READY')
  assert.equal(f.counters.writes, 1)
  f.setRunning(false)
  const allowed = await f.service.execute({ ...request, operationId: 'new-principal-idle' })
  assert.equal(allowed.status, 'credentials-written')
  assert.equal(f.counters.writes, 2)
  assert.equal(f.bindings.get('shared-domain')!.principalFingerprint, accessPrincipalFingerprint(f.managerAccount))
})

test('legacy bindings without principal cannot bypass the idle check and can be repaired explicitly while idle', async () => {
  const f = fixture()
  await f.service.execute(request)
  delete f.bindings.get('shared-domain')!.principalFingerprint
  f.setRunning(true)
  const blocked = await f.service.execute({ ...request, operationId: 'legacy-busy' })
  assert.equal(blocked.errorCode, 'CLIENT_NOT_READY')
  assert.equal(f.counters.writes, 1)
  f.setRunning(false)
  assert.equal((await f.service.execute({ ...request, operationId: 'legacy-idle' })).status, 'credentials-written')
  assert.equal(f.counters.writes, 2)
  assert.equal(f.bindings.get('shared-domain')!.principalFingerprint, accessPrincipalFingerprint(f.managerAccount))
})

test('missing stable principal blocks readiness and execution without touching target credentials', async () => {
  const f = fixture()
  f.managerAccount.principalId = ''
  const snapshot = await f.service.inspect(request.accountId)
  assert.ok(snapshot.targets.every(item => item.status === 'blocked' && !item.connected))
  assert.equal((await f.service.execute(request)).errorCode, 'CLIENT_NOT_READY')
  assert.equal(f.counters.writes, 0)
})

test('a transient manager failure remains connected-but-blocked and the original binding resumes automatically', async () => {
  const f = fixture()
  await f.service.execute(request)
  const originalBinding = { ...f.bindings.get('shared-domain')! }
  f.managerAccount.temporarilyUnavailable = true
  const capability = (await f.service.inspect(request.accountId)).targets.find(item => item.target === 'cli')!
  assert.equal(capability.connected, true)
  assert.equal(capability.status, 'blocked')
  assert.match(capability.messageEn!, /temporarily unavailable/)
  assert.equal((await f.projection.tick())[0].reason, 'credential-unusable')
  assert.deepEqual(f.bindings.get('shared-domain'), originalBinding)
  f.managerAccount.temporarilyUnavailable = false
  f.managerAccount.accessToken = 'SYNTHETIC_RECOVERED_FROM_TRANSIENT'
  assert.equal((await f.projection.tick())[0].status, 'projected')
  assert.equal(f.counters.writes, 2)
  assert.equal((await f.service.inspect(request.accountId)).targets.find(item => item.target === 'cli')!.connected, true)
})

test('principal changed while runtime detection awaits is not silently substituted into the selected operation', async () => {
  const f = fixture()
  const original = f.deps.runtime
  let changed = false
  f.deps.runtime = async target => {
    const runtime = await original(target)
    if (!changed) { f.managerAccount.principalId = 'edited-during-inspection'; changed = true }
    return runtime
  }
  assert.equal((await f.service.execute(request)).errorCode, 'PRINCIPAL_CHANGED')
  assert.equal(f.counters.writes, 0)
  assert.equal(f.counters.released, 1)
})

test('disconnect reports metadata-only success, exposes connected state, and leaves the current client session untouched', async () => {
  const f = fixture()
  await f.service.execute(request)
  assert.equal((await f.service.inspect('account-a')).targets.find(item => item.target === 'cli')!.connected, true)
  const sourceBefore = JSON.stringify(f.managerAccount)
  const counters = { ...f.counters }
  const bindingBefore = { ...f.bindings.get('shared-domain')! }
  const result = await f.service.disconnect({ ...request, operationId: 'disconnect-first' })
  assert.equal(result.status, 'disconnected')
  assert.equal(result.credentialWrite, 'not-started')
  assert.equal(result.credentialRotation, 'none')
  assert.equal(result.requiresNewSession, false)
  assert.match(result.message, /自然到期/)
  assert.match(result.message, /登录与刷新保持不变/)
  assert.equal(f.counters.accountReads, counters.accountReads)
  assert.equal(f.counters.targetReads, counters.targetReads)
  assert.equal(f.counters.writes, counters.writes)
  assert.equal(f.counters.acquired, counters.acquired)
  assert.equal(JSON.stringify(f.managerAccount), sourceBefore)
  assert.equal(f.bindings.get('shared-domain')!.targetRevision, bindingBefore.targetRevision)
  assert.equal(f.bindings.get('shared-domain')!.reason, 'user-disconnected')
  assert.deepEqual(await f.projection.tick(), [])
  assert.equal((await f.service.inspect('account-a')).targets.find(item => item.target === 'cli')!.connected, false)
})

test('expired manager access and externally changed running client do not prevent disconnecting the owned binding', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.managerAccount.expiresAt = now - 1
  f.externalTargetChange()
  f.setRunning(true)
  const capability = (await f.service.inspect('account-a')).targets.find(item => item.target === 'cli')!
  assert.equal(capability.status, 'blocked')
  assert.equal(capability.connected, true)
  const before = JSON.stringify(f.managerAccount)
  assert.equal((await f.service.disconnect(request)).status, 'disconnected')
  assert.equal(JSON.stringify(f.managerAccount), before)
  assert.equal(f.counters.writes, 1)
  assert.equal(f.bindings.get('shared-domain')!.reason, 'user-disconnected')
})

test('stale disconnect runtime, revision or account cannot revoke a different binding', async () => {
  for (const patch of [{ runtimeId: 'stale-runtime' }, { expectedRuntimeRevision: 'old-revision' }, { accountId: 'account-b' },
    { target: 'crew' as const, runtimeId: 'runtime-crew' }]) {
    const f = fixture()
    await f.service.execute(request)
    const binding = { ...f.bindings.get('shared-domain')! }
    const result = await f.service.disconnect({ ...request, ...patch })
    assert.notEqual(result.status, 'disconnected')
    assert.equal(result.credentialWrite, 'not-started')
    assert.ok(result.errorCode)
    assert.deepEqual(f.bindings.get('shared-domain'), binding)
    assert.equal(f.counters.writes, 1)
  }
})

test('disconnect metadata persistence failures are surfaced without a successful logout or credential write', async () => {
  const f = fixture()
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-domain')! }
  f.failMetadata()
  const result = await f.service.disconnect(request)
  assert.notEqual(result.status, 'disconnected')
  assert.equal(result.errorCode, 'binding-changed')
  assert.equal(result.credentialWrite, 'not-started')
  assert.equal(result.credentialRotation, 'none')
  assert.match(result.message, /未能保存/)
  assert.deepEqual(f.bindings.get('shared-domain'), binding)
  assert.equal(f.counters.writes, 1)
})
