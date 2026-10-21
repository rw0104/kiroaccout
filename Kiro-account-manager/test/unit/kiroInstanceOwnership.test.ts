import test from 'node:test'
import assert from 'node:assert/strict'
import { InstanceAccountOwnership, InstanceOwnershipError, INSTANCE_ACCOUNT_REAUTH_REQUIRED, mergeInstanceOwnedAccounts } from '../../src/main/kiroInstanceOwnership'

const account = (id: string, refreshToken = `SYNTHETIC_REFRESH_${id}`, accessToken = `SYNTHETIC_ACCESS_${id}`) => ({
  id, credentials: { refreshToken, accessToken }
})
function harness() {
  const state: { records: unknown; accounts: unknown } = {
    records: [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first' }],
    accounts: { first: account('first'), second: account('second') }
  }
  const guard = new InstanceAccountOwnership({ records: () => state.records, accounts: () => state.accounts })
  return { state, guard }
}
const blocked = (action: () => unknown, code = 'instance-owned') => assert.throws(action, error => error instanceof InstanceOwnershipError && error.code === code)

test('persisted account bindings retain ownership regardless of stopped or running process state', () => {
  const { state, guard } = harness()
  for (const status of ['stopped', 'running', 'exited', 'error']) {
    state.records = [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first', launchStatus: status }]
    assert.equal(guard.isBound({ accountId: 'first' }), true)
    blocked(() => guard.assertAvailable({ accountId: 'first' }))
    guard.assertAvailable({ accountId: 'second' })
  }
})

test('credential-only, differently labelled and trimmed credential inputs cannot bypass ownership', () => {
  const { guard } = harness()
  for (const input of [
    { refreshToken: 'SYNTHETIC_REFRESH_first' },
    { accessToken: 'SYNTHETIC_ACCESS_first' },
    { accountId: 'second', refreshToken: 'SYNTHETIC_REFRESH_first' },
    { accountId: 'second', accessToken: ' SYNTHETIC_ACCESS_first ' },
    { refreshToken: 'SYNTHETIC_ACCESS_first' }
  ]) blocked(() => guard.assertAvailable(input))
  guard.assertAvailable({ refreshToken: 'SYNTHETIC_UNRELATED' })
  assert.equal(guard.isBound({ refreshToken: '' }), false)
})

test('seen older generations stay locked until the persisted binding is actually removed', () => {
  const { guard, state } = harness()
  assert.equal(guard.isBound({ refreshToken: 'SYNTHETIC_REFRESH_first' }), true)
  state.accounts = { first: account('first', 'SYNTHETIC_ROTATED', 'SYNTHETIC_NEW_ACCESS'), second: account('second') }
  blocked(() => guard.assertAvailable({ refreshToken: 'SYNTHETIC_ROTATED' }))
  blocked(() => guard.assertAvailable({ refreshToken: 'SYNTHETIC_REFRESH_first' }))
  blocked(() => guard.assertAvailable({ accessToken: 'SYNTHETIC_ACCESS_first' }))
  state.records = []
  guard.assertAvailable({ accountId: 'first', refreshToken: 'SYNTHETIC_REFRESH_first' })
  state.records = [{ schemaVersion: 2, id: 'new-instance', accountId: 'first' }]
  guard.assertAvailable({ refreshToken: 'SYNTHETIC_REFRESH_first' })
  blocked(() => guard.assertAvailable({ refreshToken: 'SYNTHETIC_ROTATED' }))
})

test('different account IDs sharing either token cannot be bound to separate instances', () => {
  for (const credentials of [
    { refreshToken: 'SYNTHETIC_REFRESH_first', accessToken: 'OTHER' },
    { refreshToken: 'OTHER', accessToken: 'SYNTHETIC_ACCESS_first' }
  ]) {
    const { state, guard } = harness()
    state.accounts = { first: account('first'), second: { id: 'second', credentials } }
    blocked(() => guard.assertCanBind('second'))
  }
  const { guard } = harness()
  blocked(() => guard.assertCanBind('first'))
  guard.assertCanBind('first', 'synthetic-instance')
  guard.assertCanBind('second')
})

test('map collections and historical unbound RC records remain compatible', () => {
  const { state, guard } = harness()
  state.accounts = new Map([['first', account('first')], ['second', account('second')]])
  blocked(() => guard.assertCanBind('first'))
  guard.assertCanBind('second')
  state.records = [{ id: 'legacy-instance', sid: 'SYNTHETIC_SID' }, { schemaVersion: 2, id: 'blank-instance' }]
  guard.assertAvailable({ accountId: 'first' })
  guard.assertCanBind('first')
  state.records = null
  state.accounts = undefined
  guard.assertAvailable({ refreshToken: 'SYNTHETIC_UNRELATED' })
})

test('invalid ownership configuration fails closed with a controlled, credential-free error', () => {
  for (const records of [
    {}, 'SYNTHETIC_SECRET', [null], [{ id: 'one', schemaVersion: 9 }], [{ id: 'one', schemaVersion: 2, accountId: '' }],
    [{ id: 'one', schemaVersion: 2, accountId: 'first' }, { id: 'two', schemaVersion: 2, accountId: 'first' }],
    [{ id: 'same', schemaVersion: 2 }, { id: 'same', schemaVersion: 2 }],
    [{ id: 'legacy', accountId: 'first' }]
  ]) {
    const { state, guard } = harness(); state.records = records
    blocked(() => guard.assertAvailable({ accountId: 'second' }), 'invalid-ownership-state')
  }
  const guard = new InstanceAccountOwnership({ records() { throw new Error('SYNTHETIC_SECRET') }, accounts() { return {} } })
  assert.throws(() => guard.assertAvailable({}), error => error instanceof InstanceOwnershipError && !error.message.includes('SYNTHETIC_SECRET'))
})

test('missing, renamed or malformed bound accounts cannot silently drop the lock', () => {
  for (const accounts of [undefined, [], {}, { first: null }, { first: { id: 'second', credentials: {} } },
    { first: { id: 'first', credentials: { refreshToken: 123 } } }]) {
    const { state, guard } = harness(); state.accounts = accounts
    blocked(() => guard.isBound({ accountId: 'second' }), 'invalid-ownership-state')
  }
  const { guard } = harness()
  blocked(() => guard.assertCanBind('missing'), 'invalid-ownership-state')
})

test('guards do not mutate source account or instance data and errors never echo tokens or identifiers', () => {
  const { state, guard } = harness()
  const before = JSON.stringify(state)
  assert.throws(() => guard.assertAvailable({ refreshToken: 'SYNTHETIC_REFRESH_first' }), error => {
    assert.ok(error instanceof InstanceOwnershipError)
    assert.doesNotMatch(error.message, /SYNTHETIC|first|synthetic-instance/)
    return true
  })
  guard.assertCanBind('second')
  assert.equal(JSON.stringify(state), before)
})

test('late renderer saves cannot roll back credentials owned and updated by an instance', () => {
  const { state } = harness()
  const current = { version: '1.8.0', accounts: { first: { ...account('first', 'SYNTHETIC_NEW_REFRESH', 'SYNTHETIC_NEW_ACCESS'),
    idp: 'Google', userId: 'SYNTHETIC_USER', nickname: 'Old metadata', profileArn: 'SYNTHETIC_NEW_PROFILE' }, second: account('second') } }
  const incoming = { version: '1.8.0', accounts: { first: { ...account('first'), idp: 'Google', userId: 'SYNTHETIC_USER',
    nickname: 'Updated metadata', profileArn: 'SYNTHETIC_OLD_PROFILE' }, second: account('second', 'SYNTHETIC_OTHER_NEW') } }
  const beforeCurrent = JSON.stringify(current), beforeIncoming = JSON.stringify(incoming)
  const merged = mergeInstanceOwnedAccounts(incoming, current, state.records)
  assert.equal(merged.accounts.first.credentials.refreshToken, 'SYNTHETIC_NEW_REFRESH')
  assert.equal(merged.accounts.first.credentials.accessToken, 'SYNTHETIC_NEW_ACCESS')
  assert.equal(merged.accounts.first.nickname, 'Updated metadata')
  assert.equal(merged.accounts.first.profileArn, 'SYNTHETIC_NEW_PROFILE')
  assert.equal(merged.accounts.second.credentials.refreshToken, 'SYNTHETIC_OTHER_NEW')
  assert.notEqual(merged, incoming)
  assert.notEqual(merged.accounts, incoming.accounts)
  assert.notEqual(merged.accounts.first.credentials, current.accounts.first.credentials)
  assert.equal(JSON.stringify(current), beforeCurrent)
  assert.equal(JSON.stringify(incoming), beforeIncoming)
})

test('renderer saves cannot delete or replace the identity of a bound account', () => {
  const { state } = harness()
  const current = { accounts: { first: { ...account('first'), idp: 'Github', userId: 'SYNTHETIC_USER' } } }
  for (const proposed of [undefined, { ...current.accounts.first, id: 'second' },
    { ...current.accounts.first, idp: 'Google' }, { ...current.accounts.first, userId: 'OTHER_SYNTHETIC_USER' },
    { ...current.accounts.first, authMethod: 'IdC' }]) {
    const incoming = { accounts: proposed ? { first: proposed } : {} }
    blocked(() => mergeInstanceOwnedAccounts(incoming, current, state.records))
  }
  blocked(() => mergeInstanceOwnedAccounts({ accounts: {} }, { accounts: {} }, state.records), 'invalid-ownership-state')
})

test('unbound saves pass through while corrupt binding state never silently unlocks a save', () => {
  const incoming = { accounts: { first: account('first') }, groups: [], tags: [] }
  assert.equal(mergeInstanceOwnedAccounts(incoming, null, []), incoming)
  assert.equal(mergeInstanceOwnedAccounts(incoming, null, null), incoming)
  blocked(() => mergeInstanceOwnedAccounts(incoming, null, 'SYNTHETIC_SECRET'), 'invalid-ownership-state')
  const records = [{ id: 'instance', schemaVersion: 2, accountId: 'first' }]
  const current = { accounts: { first: account('first') } }
  const proposed = { accounts: { first: { ...account('first'), profileArn: 'SYNTHETIC_UNTRUSTED_PROFILE' } } }
  assert.equal(Object.hasOwn(mergeInstanceOwnedAccounts(proposed, current, records).accounts.first, 'profileArn'), false)
})

test('an account operation blocks new binding through its final credential write', async () => {
  const { state, guard } = harness()
  state.records = []
  const release = guard.beginOperation({ accountId: 'first', refreshToken: 'SYNTHETIC_REFRESH_first' })
  blocked(() => guard.assertCanBind('first'), 'account-operation-in-flight')
  guard.assertCanBind('second')
  // Completing the network request alone must not release the caller's operation lease.
  await Promise.resolve()
  state.accounts = { first: account('first', 'SYNTHETIC_ROTATED', 'SYNTHETIC_NEW_ACCESS'), second: account('second') }
  blocked(() => guard.assertCanBind('first'), 'account-operation-in-flight')
  release()
  guard.assertCanBind('first')
  state.records = [{ schemaVersion: 2, id: 'new-instance', accountId: 'first' }]
  blocked(() => guard.beginOperation({ accountId: 'first', refreshToken: 'SYNTHETIC_ROTATED' }))
})

test('pending credential-only operations also block bindings through differently labelled aliases', () => {
  for (const input of [
    { refreshToken: 'SYNTHETIC_REFRESH_first' },
    { accessToken: 'SYNTHETIC_ACCESS_first' },
    { accountId: 'second', refreshToken: ' SYNTHETIC_REFRESH_first ' },
    { refreshToken: 'SYNTHETIC_ACCESS_first' }
  ]) {
    const { state, guard } = harness(); state.records = []
    const release = guard.beginOperation(input)
    blocked(() => guard.assertCanBind('first'), 'account-operation-in-flight')
    release()
    guard.assertCanBind('first')
  }
})

test('concurrent operation leases release independently and each release is idempotent', () => {
  const { state, guard } = harness(); state.records = []
  const releaseFirst = guard.beginOperation({ accountId: 'first' })
  const releaseSecond = guard.beginOperation({ refreshToken: 'SYNTHETIC_REFRESH_first' })
  releaseFirst()
  releaseFirst()
  blocked(() => guard.assertCanBind('first'), 'account-operation-in-flight')
  releaseSecond()
  releaseSecond()
  guard.assertCanBind('first')
})

test('persisted ownership restoration is not blocked by an older in-flight operation', () => {
  const { state, guard } = harness(); state.records = []
  const release = guard.beginOperation({ accountId: 'first', refreshToken: 'SYNTHETIC_REFRESH_first' })
  state.records = [{ schemaVersion: 2, id: 'restored-instance', accountId: 'first' }]
  guard.assertCanBind('first', 'restored-instance')
  blocked(() => guard.assertCanBind('first', 'different-instance'), 'account-operation-in-flight')
  release()
  blocked(() => guard.assertCanBind('first', 'different-instance'))
})

test('operation guards fail closed and pending errors never expose identifiers or credentials', () => {
  const { state, guard } = harness()
  blocked(() => guard.beginOperation({ refreshToken: 'SYNTHETIC_REFRESH_first' }))
  state.records = []
  const release = guard.beginOperation({ accountId: 'first', refreshToken: 'SYNTHETIC_REFRESH_first' })
  assert.throws(() => guard.assertCanBind('first'), error => {
    assert.ok(error instanceof InstanceOwnershipError)
    assert.equal(error.code, 'account-operation-in-flight')
    assert.doesNotMatch(error.message, /SYNTHETIC|first|synthetic-instance/)
    return true
  })
  state.records = 'SYNTHETIC_SECRET'
  blocked(() => guard.beginOperation({ accountId: 'second' }), 'invalid-ownership-state')
  release()
})

test('recovery unbinding blocks old account credentials without blocking unrelated accounts', () => {
  const { state, guard } = harness()
  state.records = []
  state.accounts = { first: { ...account('first'), status: 'error', lastError: INSTANCE_ACCOUNT_REAUTH_REQUIRED }, second: account('second') }
  for (const input of [
    { accountId: 'first' }, { refreshToken: 'SYNTHETIC_REFRESH_first' },
    { accessToken: 'SYNTHETIC_ACCESS_first' }, { accountId: 'second', refreshToken: 'SYNTHETIC_REFRESH_first' },
    { refreshToken: 'SYNTHETIC_NEW_REFRESH', accessToken: 'SYNTHETIC_ACCESS_first' },
    { refreshToken: 'SYNTHETIC_REFRESH_first', accessToken: 'SYNTHETIC_NEW_ACCESS' }
  ]) {
    blocked(() => guard.assertAvailable(input), 'reauthorization-required')
    blocked(() => guard.beginOperation(input), 'reauthorization-required')
  }
  guard.assertAvailable({ accountId: 'second', ...account('second').credentials })
  const release = guard.beginOperation({ accountId: 'second' })
  release()
  assert.throws(() => guard.assertAvailable({ accountId: 'first' }), error =>
    error instanceof InstanceOwnershipError && error.message === INSTANCE_ACCOUNT_REAUTH_REQUIRED)
  blocked(() => guard.assertCanBind('first'), 'reauthorization-required')
  guard.assertCanBind('second')
})

test('fresh authorization pairs can be verified and can clear a recovery marker', () => {
  const { state, guard } = harness(); state.records = []
  const recovery = { ...account('first'), status: 'error', lastError: INSTANCE_ACCOUNT_REAUTH_REQUIRED }
  state.accounts = { first: recovery, second: account('second') }
  const credentials = { refreshToken: 'SYNTHETIC_REAUTHORIZED_REFRESH', accessToken: 'SYNTHETIC_REAUTHORIZED_ACCESS' }
  for (const input of [credentials, { accountId: 'first', ...credentials }]) {
    guard.assertAvailable(input)
    const release = guard.beginOperation(input)
    release()
  }
  const proposed = { ...recovery, status: 'active', lastError: undefined, credentials }
  const merged = mergeInstanceOwnedAccounts({ accounts: { first: proposed } }, { accounts: { first: recovery } }, [])
  assert.equal(merged.accounts.first.lastError, undefined)
  assert.equal(merged.accounts.first.status, 'active')
  assert.equal(merged.accounts.first.credentials, credentials)
  state.accounts = merged.accounts
  guard.assertAvailable({ accountId: 'first', ...credentials })
  guard.assertCanBind('first')
})

test('late or partly changed renderer snapshots cannot clear an unbound recovery marker', () => {
  const recovery = { ...account('first'), status: 'error', lastError: INSTANCE_ACCOUNT_REAUTH_REQUIRED }
  const current = { accounts: { first: recovery } }
  for (const credentials of [
    recovery.credentials,
    { ...recovery.credentials, refreshToken: 'SYNTHETIC_NEW_REFRESH' },
    { ...recovery.credentials, accessToken: 'SYNTHETIC_NEW_ACCESS' },
    { refreshToken: 'SYNTHETIC_NEW_REFRESH' },
    { refreshToken: '', accessToken: 'SYNTHETIC_NEW_ACCESS' },
    { refreshToken: recovery.credentials.accessToken, accessToken: recovery.credentials.refreshToken }
  ]) {
    const incoming = { accounts: { first: { ...recovery, nickname: 'Changed metadata',
      status: 'active', lastError: undefined, credentials } } }
    const beforeIncoming = JSON.stringify(incoming), beforeCurrent = JSON.stringify(current)
    const merged = mergeInstanceOwnedAccounts(incoming, current, [])
    assert.equal(merged.accounts.first.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
    assert.equal(merged.accounts.first.status, 'error')
    assert.equal(merged.accounts.first.nickname, 'Changed metadata')
    assert.equal(merged.accounts.first.credentials, credentials)
    assert.equal(JSON.stringify(incoming), beforeIncoming)
    assert.equal(JSON.stringify(current), beforeCurrent)
  }
  blocked(() => mergeInstanceOwnedAccounts({ accounts: {} }, current, []), 'reauthorization-required')
})
