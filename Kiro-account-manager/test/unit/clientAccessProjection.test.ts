import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ClientAccessProjectionService, ClientAccessProjectionError,
  accessPrincipalFingerprint, type AccessCredential, type ManagerAccessSnapshot, type ClientAccessProjectionAdapter,
  type ClientAccessProjectionBinding, type ClientAccessProjectionDependencies
} from '../../src/main/clientAccessProjection'

const now = 1_800_000_000_000
const request = { accountId: 'account-a', runtimeId: 'runtime-cli', authDomainId: 'shared-auth' }
const token = (generation = 'FIRST'): ManagerAccessSnapshot => ({ accessToken: `SYNTHETIC_${generation}_ACCESS`,
  expiresAt: now + 3_600_000, provider: 'Github', authMethod: 'social', profileArn: 'SYNTHETIC_PROFILE', principalId: 'SYNTHETIC_SUBJECT_A' })
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface ProjectionFixture {
  deps: ClientAccessProjectionDependencies
  accounts: Map<string, ManagerAccessSnapshot>
  bindings: Map<string, ClientAccessProjectionBinding>
  writes: Array<Readonly<AccessCredential>>
  adapter: ClientAccessProjectionAdapter
  adapters: Map<string, ClientAccessProjectionAdapter>
  service: ClientAccessProjectionService
  setClock(value: number): void
  editTarget(): void
}

function fixture(): ProjectionFixture {
  let clock = now
  const accounts = new Map<string, ManagerAccessSnapshot>([['account-a', token()], ['account-b', { ...token('SECOND'), principalId: 'SYNTHETIC_SUBJECT_B' }]])
  const bindings = new Map<string, ClientAccessProjectionBinding>()
  let targetRevision = 'target-initial'
  const writes: Array<Readonly<AccessCredential>> = []
  const adapter: ClientAccessProjectionAdapter = {
    authDomainId: 'shared-auth',
    readRevision: async () => targetRevision,
    write: async (access, expected, assertCurrent) => {
      if (expected !== targetRevision) throw new ClientAccessProjectionError('target-changed')
      assertCurrent()
      writes.push({ ...access })
      targetRevision = `target-${writes.length}`
      return targetRevision
    }
  }
  const adapters = new Map([['runtime-cli', adapter], ['runtime-crew', adapter]])
  const deps: ClientAccessProjectionDependencies = {
    account: id => accounts.get(id),
    adapter: id => adapters.get(id),
    readBindings: () => [...bindings.values()].map(binding => ({ ...binding })),
    writeBinding: (binding, expected) => {
      if (bindings.get(binding.authDomainId)?.revision !== expected) return false
      bindings.set(binding.authDomainId, { ...binding })
      return true
    },
    now: () => clock
  }
  return { deps, accounts, bindings, writes, adapter, adapters, service: new ClientAccessProjectionService(deps),
    setClock: (value: number) => { clock = value },
    editTarget: () => { targetRevision = 'target-external-change' } }
}

test('explicit projection copies only access fields and persists only metadata without changing manager state', async () => {
  const f = fixture()
  const manager = { ...token(), refreshToken: 'SYNTHETIC_PRIVATE_REFRESH', clientSecret: 'SYNTHETIC_PRIVATE_SECRET',
    refreshEnabled: true, activeAccountId: 'account-a' }
  f.accounts.set('account-a', manager)
  const before = JSON.stringify(manager)
  const result = await f.service.execute(request)
  assert.equal(result.status, 'projected')
  assert.equal(result.targetCommitted, true)
  const { principalId: _principal, ...shortAccess } = token()
  assert.equal(_principal, manager.principalId)
  assert.deepEqual(f.writes, [shortAccess])
  const saved = JSON.stringify([...f.bindings.values()])
  assert.equal(saved.includes(manager.accessToken), false)
  assert.equal(saved.includes(manager.refreshToken), false)
  assert.equal(saved.includes(manager.clientSecret), false)
  assert.equal(saved.includes(manager.principalId), false)
  assert.equal('principalId' in f.writes[0], false)
  assert.match(f.bindings.get('shared-auth')!.credentialFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(manager), before)
  assert.equal(f.accounts.get('account-a'), manager)
})

test('same pending execute reuses its promise and another runtime/account cannot write the shared domain', async () => {
  const f = fixture()
  const read = deferred<string>()
  f.adapter.readRevision = () => read.promise
  const first = f.service.execute(request)
  assert.equal(f.service.execute({ ...request }), first)
  assert.equal((await f.service.execute({ ...request, runtimeId: 'runtime-crew' })).status, 'busy')
  assert.equal((await f.service.execute({ ...request, accountId: 'account-b' })).status, 'busy')
  read.resolve('target-initial')
  assert.equal((await first).status, 'projected')
  assert.equal(f.writes.length, 1)
})

test('the authoritative adapter domain rejects a caller-supplied different domain without target IO', async () => {
  const f = fixture()
  let reads = 0
  f.adapter.readRevision = async () => { reads++; return 'unused' }
  const result = await f.service.execute({ ...request, authDomainId: 'spoofed-domain' })
  assert.equal(result.reason, 'domain-mismatch')
  assert.equal(reads, 0)
  assert.equal(f.writes.length, 0)
  assert.equal(f.bindings.size, 0)
})

test('tick projects a new manager generation, persists its fingerprint and skips unchanged generations', async () => {
  const f = fixture()
  await f.service.execute(request)
  assert.equal((await f.service.tick())[0].status, 'unchanged')
  assert.equal(f.writes.length, 1)
  const original = f.bindings.get('shared-auth')!
  f.accounts.set('account-a', token('ROTATED_BY_ORIGINAL_MANAGER'))
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.writes.length, 2)
  assert.notEqual(f.bindings.get('shared-auth')!.credentialFingerprint, original.credentialFingerprint)
  assert.equal(f.writes[1].accessToken, token('ROTATED_BY_ORIGINAL_MANAGER').accessToken)
})

test('auth method, profile, region and expiry participate in the fingerprint even with identical access text', async () => {
  const f = fixture()
  await f.service.execute(request)
  const patches = [{ authMethod: 'IdC' }, { profileArn: 'SYNTHETIC_OTHER_PROFILE' }, { region: 'eu-west-1' }, { expiresAt: now + 4_000_000 }]
  for (const patch of patches) {
    const previous = f.bindings.get('shared-auth')!.credentialFingerprint
    f.accounts.set('account-a', { ...f.accounts.get('account-a')!, ...patch })
    assert.equal((await f.service.tick())[0].status, 'projected')
    assert.notEqual(f.bindings.get('shared-auth')!.credentialFingerprint, previous)
  }
  assert.equal(f.writes.length, 5)
})

test('principal fingerprint requires a stable upstream subject and is scoped to the provider', () => {
  assert.equal(accessPrincipalFingerprint(undefined), undefined)
  for (const principalId of ['', ' ', 'bad\nsubject', 'bad\0subject']) {
    assert.equal(accessPrincipalFingerprint({ provider: 'BuilderId', principalId }), undefined)
  }
  const first = accessPrincipalFingerprint({ provider: 'BuilderId', principalId: 'official-subject-a' })!
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(first.includes('official-subject-a'), false)
  assert.notEqual(first, accessPrincipalFingerprint({ provider: 'BuilderId', principalId: 'official-subject-b' }))
  assert.notEqual(first, accessPrincipalFingerprint({ provider: 'Github', principalId: 'official-subject-a' }))
})

test('Enterprise profile changes pause the existing background binding even when the stable user ID is unchanged', async () => {
  const f = fixture()
  const enterprise: ManagerAccessSnapshot = { ...token(), provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
    startUrl: 'https://synthetic-team.awsapps.com/start', profileArn: 'SYNTHETIC_ORGANIZATION_PROFILE_A' }
  f.accounts.set('account-a', enterprise)
  assert.equal((await f.service.execute(request)).status, 'projected')
  const binding = { ...f.bindings.get('shared-auth')! }
  const changed = { ...enterprise, profileArn: 'SYNTHETIC_ORGANIZATION_PROFILE_B' }
  assert.equal(changed.principalId, enterprise.principalId)
  assert.notEqual(accessPrincipalFingerprint(changed), accessPrincipalFingerprint(enterprise))
  f.accounts.set('account-a', changed)
  const result = (await f.service.tick())[0]
  assert.equal(result.status, 'needs-attention')
  assert.equal(result.reason, 'principal-changed')
  assert.equal(result.targetCommitted, false)
  assert.equal(f.writes.length, 1)
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, binding.principalFingerprint)
  assert.equal(f.accounts.get('account-a'), changed)
  assert.deepEqual(await f.service.tick(), [])
})

test('organization start URL participates in the access whitelist and generation fingerprint', async () => {
  const f = fixture()
  const enterprise: ManagerAccessSnapshot = { ...token(), provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
    startUrl: 'https://synthetic-team.awsapps.com/start', profileArn: 'SYNTHETIC_ORGANIZATION_PROFILE' }
  f.accounts.set('account-a', enterprise)
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-auth')! }
  assert.equal(f.writes[0].startUrl, enterprise.startUrl)
  assert.equal('principalId' in f.writes[0], false)
  f.accounts.set('account-a', { ...enterprise, startUrl: 'https://synthetic-team.awsapps.com/start/' })
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.writes[1].startUrl, 'https://synthetic-team.awsapps.com/start/')
  assert.notEqual(f.bindings.get('shared-auth')!.credentialFingerprint, binding.credentialFingerprint)
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, binding.principalFingerprint)
})

test('same manager record edited from Builder ID subject A to B stops automatic projection without a profile ARN', async () => {
  const f = fixture()
  const builder: ManagerAccessSnapshot = { accessToken: 'SYNTHETIC_BUILDER_ACCESS', expiresAt: now + 3_600_000,
    provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', principalId: 'official-subject-a' }
  f.accounts.set('account-a', builder)
  await f.service.execute(request)
  const previous = { ...f.bindings.get('shared-auth')! }
  // Mutable record ID/provider/region remain identical; only the authoritative subject changes.
  f.accounts.set('account-a', { ...builder, principalId: 'official-subject-b' })
  const result = (await f.service.tick())[0]
  assert.equal(result.reason, 'principal-changed')
  assert.equal(result.status, 'needs-attention')
  assert.equal(f.writes.length, 1)
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, previous.principalFingerprint)
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  assert.deepEqual(await f.service.tick(), [])
})

test('normal Builder ID access rotation retains the same principal and continues automatic projection', async () => {
  const f = fixture()
  f.accounts.set('account-a', { accessToken: 'SYNTHETIC_BUILDER_FIRST', expiresAt: now + 3_600_000,
    provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', principalId: 'official-subject-a' })
  await f.service.execute(request)
  const principal = f.bindings.get('shared-auth')!.principalFingerprint
  f.accounts.set('account-a', { ...f.accounts.get('account-a')!, accessToken: 'SYNTHETIC_BUILDER_ROTATION', expiresAt: now + 7_200_000 })
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, principal)
  assert.equal(f.writes.length, 2)
})

test('temporary manager errors preserve the active binding and recover on a later same-principal access update', async () => {
  const f = fixture()
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-auth')! }
  f.accounts.set('account-a', { ...token(), temporarilyUnavailable: true })
  assert.equal((await f.service.tick())[0].reason, 'credential-unusable')
  assert.deepEqual(f.bindings.get('shared-auth'), binding)
  assert.equal(f.writes.length, 1)
  f.accounts.set('account-a', token('RECOVERED_AFTER_NETWORK_ERROR'))
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.bindings.get('shared-auth')!.status, 'active')
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, binding.principalFingerprint)
  assert.equal(f.writes.length, 2)
  assert.equal('temporarilyUnavailable' in f.writes[1], false)
})

test('a principal change still pauses the binding permanently when the replacement record has a temporary error', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.accounts.set('account-a', { ...token(), principalId: 'DIFFERENT_SUBJECT', temporarilyUnavailable: true, expiresAt: now - 1 })
  assert.equal((await f.service.tick())[0].reason, 'principal-changed')
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  f.accounts.set('account-a', { ...token('RECOVERED_B'), principalId: 'DIFFERENT_SUBJECT' })
  assert.deepEqual(await f.service.tick(), [])
  assert.equal(f.writes.length, 1)
})

test('missing principal fails closed and legacy bindings pause but allow an explicit rebind', async () => {
  const absent = fixture()
  absent.accounts.set('account-a', { ...token(), principalId: '' })
  assert.equal((await absent.service.execute(request)).reason, 'principal-unavailable')
  assert.equal(absent.writes.length, 0)
  const f = fixture()
  await f.service.execute(request)
  const old = { ...f.bindings.get('shared-auth')! }
  delete old.principalFingerprint
  f.bindings.set('shared-auth', old)
  assert.equal((await f.service.tick())[0].reason, 'principal-unavailable')
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  assert.equal(f.writes.length, 1)
  assert.equal((await f.service.execute(request)).status, 'projected')
  assert.equal(f.bindings.get('shared-auth')!.principalFingerprint, accessPrincipalFingerprint(token()))
  assert.equal(f.writes.length, 2)
})

test('adapter context carries the stable principal hash and only calls it the same account when subjects match', async () => {
  const f = fixture()
  const contexts: Array<Parameters<ClientAccessProjectionAdapter['write']>[3]> = []
  const original = f.adapter.write
  f.adapter.write = async (access, revision, guard, context) => {
    contexts.push(context)
    assert.equal('principalId' in access, false)
    return await original(access, revision, guard, context)
  }
  await f.service.execute(request)
  f.accounts.set('account-a', token('ROTATED'))
  await f.service.tick()
  f.accounts.set('account-a', { ...token('DIFFERENT_SUBJECT'), principalId: 'official-subject-b' })
  await f.service.execute(request)
  assert.equal(contexts[0].sameAccount, false)
  assert.equal(contexts[1].sameAccount, true)
  assert.equal(contexts[2].sameAccount, false)
  assert.equal(contexts[0].principalFingerprint, contexts[1].principalFingerprint)
  assert.notEqual(contexts[0].principalFingerprint, contexts[2].principalFingerprint)
})

test('principal change during preflight or immediately before commit cannot write the new subject through an old operation', async () => {
  for (const atCommit of [false, true]) {
    const f = fixture()
    const change = (): Map<string, ManagerAccessSnapshot> => f.accounts.set('account-a', { ...token(), principalId: 'official-subject-b' })
    if (atCommit) {
      const original = f.adapter.write
      f.adapter.write = async (...args) => { change(); return await original(...args) }
    } else f.adapter.readRevision = async () => { change(); return 'target-initial' }
    assert.equal((await f.service.execute(request)).reason, 'principal-changed')
    assert.equal(f.writes.length, 0)
  }
})

test('the service-selected principal is pinned across the execute microtask boundary', async () => {
  const f = fixture()
  const pending = f.service.execute({ ...request, expectedPrincipalFingerprint: accessPrincipalFingerprint(token())! })
  f.accounts.set('account-a', { ...token(), principalId: 'official-subject-b' })
  assert.equal((await pending).reason, 'principal-changed')
  assert.equal(f.writes.length, 0)
})

test('a restored service checks the saved target revision and continues the same binding after restart', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.service.close()
  const restarted = new ClientAccessProjectionService(f.deps)
  assert.equal((await restarted.tick())[0].status, 'unchanged')
  f.accounts.set('account-a', token('AFTER_RESTART'))
  assert.equal((await restarted.tick())[0].status, 'projected')
  assert.equal(f.writes.length, 2)
})

test('external target modification stops automatic binding without overwriting even an unchanged source token', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.editTarget()
  const result = (await f.service.tick())[0]
  assert.equal(result.status, 'needs-attention')
  assert.equal(result.reason, 'target-changed')
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  f.accounts.set('account-a', token('NEW_AFTER_USER_EDIT'))
  assert.deepEqual(await f.service.tick(), [])
  assert.equal(f.writes.length, 1)
})

test('explicit replacement can bind another account and runtime in the same domain', async () => {
  const f = fixture()
  await f.service.execute(request)
  const result = await f.service.execute({ ...request, accountId: 'account-b', runtimeId: 'runtime-crew' })
  assert.equal(result.status, 'projected')
  assert.equal(f.bindings.get('shared-auth')!.accountId, 'account-b')
  assert.equal(f.bindings.get('shared-auth')!.runtimeId, 'runtime-crew')
  f.accounts.set('account-a', token('IGNORED_PREVIOUS_ACCOUNT'))
  assert.equal((await f.service.tick())[0].status, 'unchanged')
  assert.equal(f.writes.length, 2)
})

test('missing or near-expiry credentials cannot be projected and deleted bound accounts stop syncing', async () => {
  for (const expiresAt of [now - 1, now, now + 180_000, NaN, Infinity]) {
    const f = fixture()
    f.accounts.set('account-a', { ...token(), expiresAt })
    assert.equal((await f.service.execute(request)).reason, 'credential-unusable')
    assert.equal(f.writes.length, 0)
  }
  const f = fixture()
  await f.service.execute(request)
  f.accounts.delete('account-a')
  assert.equal((await f.service.tick())[0].reason, 'account-unavailable')
  assert.equal(f.bindings.get('shared-auth')!.status, 'needs-attention')
  assert.equal(f.writes.length, 1)
})

test('source rotation during target preflight does not dispatch an obsolete access token', async () => {
  const f = fixture()
  f.adapter.readRevision = async () => {
    f.accounts.set('account-a', token('CONCURRENT_REFRESH'))
    return 'target-initial'
  }
  assert.equal((await f.service.execute(request)).reason, 'credential-changed')
  assert.equal(f.writes.length, 0)
  assert.equal(f.bindings.size, 0)
})

test('an expiring source pauses projection until the existing manager refresh supplies a new valid access', async () => {
  const f = fixture()
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-auth')! }
  f.setClock(now + 3_500_000)
  assert.equal((await f.service.tick())[0].reason, 'credential-unusable')
  assert.deepEqual(f.bindings.get('shared-auth'), binding)
  assert.equal(f.writes.length, 1)
  f.accounts.set('account-a', { ...token('NATURALLY_REFRESHED'), expiresAt: now + 7_000_000 })
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.writes.length, 2)
})

test('the adapter commit guard rejects source rotation, deletion or expiry after write begins', async () => {
  for (const change of ['rotate', 'delete', 'expire'] as const) {
    const f = fixture()
    const entered = deferred<void>()
    const proceed = deferred<void>()
    const original = f.adapter.write
    f.adapter.write = async (...args) => { entered.resolve(); await proceed.promise; return await original(...args) }
    const pending = f.service.execute(request)
    await entered.promise
    if (change === 'rotate') f.accounts.set('account-a', token('CHANGED_DURING_WRITE'))
    if (change === 'delete') f.accounts.delete('account-a')
    if (change === 'expire') f.setClock(now + 3_500_000)
    proceed.resolve()
    assert.equal((await pending).status, 'needs-attention')
    assert.equal(f.writes.length, 0)
    assert.equal(f.bindings.size, 0)
  }
})

test('failed writes preserve the previous metadata and a future tick can retry without refreshing manager credentials', async () => {
  const f = fixture()
  await f.service.execute(request)
  const saved = JSON.stringify([...f.bindings.values()])
  const original = f.adapter.write
  f.accounts.set('account-a', token('NEW_GENERATION'))
  f.adapter.write = async () => { throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_DETAIL') }
  const failed = (await f.service.tick())[0]
  assert.equal(failed.reason, 'target-write-failed')
  assert.equal(JSON.stringify(failed).includes('PRIVATE_TRANSPORT_DETAIL'), false)
  assert.equal(JSON.stringify([...f.bindings.values()]), saved)
  f.adapter.write = original
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(f.accounts.get('account-a')!.accessToken, token('NEW_GENERATION').accessToken)
})

test('a changed binding during target IO is not overwritten or resurrected', async () => {
  const f = fixture()
  await f.service.execute(request)
  const old = { ...f.bindings.get('shared-auth')! }
  f.accounts.set('account-a', token('LATEST'))
  f.adapter.readRevision = async () => {
    f.bindings.set('shared-auth', { ...old, revision: 'user-disabled', status: 'needs-attention' })
    return old.targetRevision
  }
  const result = (await f.service.tick())[0]
  assert.equal(result.reason, 'binding-changed')
  assert.equal(f.bindings.get('shared-auth')!.revision, 'user-disabled')
  assert.equal(f.writes.length, 1)
})

test('failed metadata CAS reports target commitment and does not roll back or invent a saved binding', async () => {
  const f = fixture()
  f.deps.writeBinding = () => false
  const result = await f.service.execute(request)
  assert.equal(result.reason, 'binding-changed')
  assert.equal(result.targetCommitted, true)
  assert.equal(f.writes.length, 1)
  assert.equal(f.bindings.size, 0)
})

test('stop leaves the current domain lock held until the actual operation finishes', async () => {
  const f = fixture()
  const entered = deferred<void>()
  const proceed = deferred<void>()
  const original = f.adapter.write
  f.adapter.write = async (...args) => { entered.resolve(); await proceed.promise; return await original(...args) }
  const first = f.service.execute(request)
  await entered.promise
  f.service.stop()
  assert.equal((await f.service.execute({ ...request, accountId: 'account-b' })).status, 'busy')
  proceed.resolve()
  assert.equal((await first).status, 'projected')
  assert.equal((await f.service.execute({ ...request, accountId: 'account-b' })).status, 'projected')
})

test('close prevents new work and the guarded in-flight commit, without clearing its lock prematurely', async () => {
  const f = fixture()
  const entered = deferred<void>()
  const proceed = deferred<void>()
  const original = f.adapter.write
  f.adapter.write = async (...args) => { entered.resolve(); await proceed.promise; return await original(...args) }
  const pending = f.service.execute(request)
  await entered.promise
  f.service.close()
  assert.equal((await f.service.execute(request)).status, 'closed')
  assert.deepEqual(await f.service.tick(), [])
  proceed.resolve()
  assert.equal((await pending).status, 'closed')
  assert.equal(f.writes.length, 0)
  assert.equal(f.bindings.size, 0)
})

test('disconnect changes binding metadata only and future ticks leave target and manager credentials alone', async () => {
  const f = fixture()
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-auth')! }
  const source = JSON.stringify([...f.accounts.values()])
  const writes = JSON.stringify(f.writes)
  const targetRevision = await f.adapter.readRevision()
  let targetReads = 0
  f.adapter.readRevision = async () => { targetReads++; return targetRevision }
  const result = f.service.disconnect(request)
  assert.equal(result.status, 'unchanged')
  assert.equal(result.targetCommitted, false)
  const disconnected = f.bindings.get('shared-auth')!
  assert.equal(disconnected.status, 'needs-attention')
  assert.equal(disconnected.reason, 'user-disconnected')
  assert.notEqual(disconnected.revision, binding.revision)
  assert.equal(disconnected.targetRevision, binding.targetRevision)
  assert.equal(disconnected.credentialFingerprint, binding.credentialFingerprint)
  assert.equal(JSON.stringify([...f.accounts.values()]), source)
  assert.equal(JSON.stringify(f.writes), writes)
  assert.equal(targetReads, 0)
  f.accounts.set('account-a', token('MANAGER_CONTINUES_REFRESHING'))
  assert.deepEqual(await f.service.tick(), [])
  assert.equal(JSON.stringify(f.writes), writes)
  assert.equal(targetReads, 0)
  assert.equal(f.service.disconnect(request).status, 'unchanged')
  assert.deepEqual(f.bindings.get('shared-auth'), disconnected)
})

test('disconnect works after access expires without reading credentials or a client database', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.setClock(now + 7_200_000)
  f.deps.account = () => { throw new Error('disconnect must not load account credentials') }
  f.adapter.readRevision = async () => { throw new Error('disconnect must not inspect target credentials') }
  assert.equal(f.service.disconnect(request).status, 'unchanged')
  assert.equal(f.bindings.get('shared-auth')!.reason, 'user-disconnected')
  assert.equal(f.writes.length, 1)
  assert.deepEqual(await f.service.tick(), [])
})

test('a stale account or runtime cannot disconnect another binding in the shared domain', async () => {
  const f = fixture()
  await f.service.execute(request)
  const binding = { ...f.bindings.get('shared-auth')! }
  for (const patch of [{ accountId: 'account-b' }, { runtimeId: 'runtime-crew' }]) {
    const result = f.service.disconnect({ ...request, ...patch })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'binding-changed')
    assert.equal(result.targetCommitted, false)
    assert.deepEqual(f.bindings.get('shared-auth'), binding)
  }
  assert.equal(f.writes.length, 1)
})

test('disconnect during an in-flight tick invalidates its guard and cannot resurrect the binding', async () => {
  const f = fixture()
  await f.service.execute(request)
  f.accounts.set('account-a', token('LATEST_MANAGER_ACCESS'))
  const entered = deferred<void>()
  const proceed = deferred<void>()
  const write = f.adapter.write
  f.adapter.write = async (...args) => { entered.resolve(); await proceed.promise; return await write(...args) }
  const pending = f.service.tick()
  await entered.promise
  assert.equal(f.service.disconnect(request).status, 'unchanged')
  const disconnected = { ...f.bindings.get('shared-auth')! }
  proceed.resolve()
  const result = (await pending)[0]
  assert.equal(result.reason, 'binding-changed')
  assert.equal(result.targetCommitted, false)
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.bindings.get('shared-auth'), disconnected)
  assert.equal(disconnected.reason, 'user-disconnected')
  assert.deepEqual(await f.service.tick(), [])
  assert.equal(f.accounts.get('account-a')!.accessToken, 'SYNTHETIC_LATEST_MANAGER_ACCESS_ACCESS')
})

test('disconnect metadata save failures remain failures and never claim the active binding was revoked', async () => {
  for (const mode of ['cas', 'throw'] as const) {
    const f = fixture()
    await f.service.execute(request)
    const original = { ...f.bindings.get('shared-auth')! }
    f.deps.writeBinding = () => {
      if (mode === 'throw') throw new Error('SYNTHETIC_PRIVATE_PERSISTENCE_DETAIL')
      return false
    }
    const result = f.service.disconnect(request)
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, mode === 'cas' ? 'binding-changed' : 'binding-save-failed')
    assert.equal(result.targetCommitted, false)
    assert.deepEqual(f.bindings.get('shared-auth'), original)
    assert.equal(f.writes.length, 1)
    assert.equal(JSON.stringify(result).includes('PRIVATE_PERSISTENCE_DETAIL'), false)
  }
})
