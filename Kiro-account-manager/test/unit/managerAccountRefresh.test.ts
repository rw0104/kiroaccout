import test from 'node:test'
import assert from 'node:assert/strict'
import { applyManagerTokenRotation, type ManagerTokenRotationResult } from '../../src/main/managerAccountRefresh'

const now = 1_800_000_000_000
const account = (id: string, refreshToken = 'SYNTHETIC_OLD_REFRESH') => ({
  id, idp: 'Google', email: 'synthetic@example.invalid', nickname: 'Kept metadata',
  status: 'active', profileArn: 'SYNTHETIC_PROFILE', usage: { current: 2, limit: 100 },
  credentials: { authMethod: 'social', provider: 'Google', refreshToken,
    accessToken: 'SYNTHETIC_OLD_ACCESS', expiresAt: now - 1000, clientSecretExpiresAt: now + 1_000_000 }
})
const result = { success: true, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH', expiresIn: 1800 }

test('a rotation preserves account metadata, unrelated accounts and input objects', () => {
  const input = { version: '1.8.0', accounts: { first: account('first'), unrelated: account('unrelated', 'SYNTHETIC_UNRELATED') },
    groups: [{ id: 'group', name: 'Synthetic group' }] }
  const before = JSON.stringify(input)
  const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', result, now)
  const updated = applied.data as typeof input
  assert.notEqual(updated, input)
  assert.notEqual(updated.accounts, input.accounts)
  assert.notEqual(updated.accounts.first, input.accounts.first)
  assert.notEqual(updated.accounts.first.credentials, input.accounts.first.credentials)
  assert.deepEqual(updated.accounts.first, {
    ...input.accounts.first,
    credentials: { ...input.accounts.first.credentials, accessToken: result.accessToken,
      refreshToken: result.refreshToken, expiresAt: now + 1_800_000 }
  })
  assert.equal(updated.accounts.unrelated, input.accounts.unrelated)
  assert.equal(updated.groups, input.groups)
  assert.deepEqual(applied.updates, [{ id: 'first', credentials: updated.accounts.first.credentials }])
  assert.equal(JSON.stringify(input), before)
})

test('a delayed old refresh result cannot overwrite the next credential generation', () => {
  const original = { accounts: { first: account('first') } }
  const first = applyManagerTokenRotation(original, 'SYNTHETIC_OLD_REFRESH', result, now)
  const delayed = applyManagerTokenRotation(first.data, 'SYNTHETIC_OLD_REFRESH', {
    success: true, accessToken: 'SYNTHETIC_STALE_ACCESS', refreshToken: 'SYNTHETIC_STALE_REFRESH', expiresIn: 10
  }, now + 100)
  assert.equal(delayed.data, first.data)
  assert.deepEqual(delayed.updates, [])
  const latest = applyManagerTokenRotation(first.data, 'SYNTHETIC_NEW_REFRESH', {
    success: true, accessToken: 'SYNTHETIC_LATEST_ACCESS', refreshToken: 'SYNTHETIC_LATEST_REFRESH', expiresIn: 60
  }, now + 200)
  assert.equal(latest.updates[0].credentials.refreshToken, 'SYNTHETIC_LATEST_REFRESH')
})

test('all account aliases sharing the exact refresh token receive the same rotation', () => {
  const input = { accounts: { first: account('first'), alias: account('alias'), other: account('other', 'SYNTHETIC_OTHER') } }
  const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', result, now)
  const updated = applied.data as typeof input
  assert.deepEqual(applied.updates.map(update => update.id), ['first', 'alias'])
  for (const update of applied.updates) {
    assert.equal(update.credentials.refreshToken, 'SYNTHETIC_NEW_REFRESH')
    assert.equal(update.credentials.expiresAt, now + 1_800_000)
  }
  assert.equal(updated.accounts.other, input.accounts.other)
})

test('refreshing an unbound account does not roll back a separately updated instance account', () => {
  const current = { accounts: { first: account('first'), instance: {
    ...account('instance', 'SYNTHETIC_INSTANCE_NEW_REFRESH'),
    credentials: { ...account('instance').credentials, refreshToken: 'SYNTHETIC_INSTANCE_NEW_REFRESH',
      accessToken: 'SYNTHETIC_INSTANCE_NEW_ACCESS', expiresAt: now + 999_000 }
  } } }
  const applied = applyManagerTokenRotation(current, 'SYNTHETIC_OLD_REFRESH', result, now)
  const updated = applied.data as typeof current
  assert.equal(updated.accounts.instance, current.accounts.instance)
  assert.equal(updated.accounts.instance.credentials.refreshToken, 'SYNTHETIC_INSTANCE_NEW_REFRESH')
  assert.deepEqual(applied.updates.map(update => update.id), ['first'])
})

test('omitted rotation tokens retain the current refresh token and legacy lifetime default', () => {
  const input = { accounts: { first: account('first') } }
  for (const refreshToken of [undefined, '', '   ']) {
    const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', {
      success: true, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken
    }, now)
    assert.equal(applied.updates[0].credentials.refreshToken, 'SYNTHETIC_OLD_REFRESH')
    assert.equal(applied.updates[0].credentials.expiresAt, now + 3_600_000)
  }
})

test('invalid supplied lifetimes never create usable-looking credential state', () => {
  const input = { accounts: { first: account('first') } }
  for (const expiresIn of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE, null, '3600']) {
    const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', {
      ...result, expiresIn
    } as ManagerTokenRotationResult, now)
    assert.equal(applied.data, input)
    assert.deepEqual(applied.updates, [])
  }
  for (const invalidNow of [NaN, Infinity, 8.64e15]) {
    const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', result, invalidNow)
    assert.equal(applied.data, input)
    assert.deepEqual(applied.updates, [])
  }
})

test('failed, empty, unmatched and malformed inputs remain untouched', () => {
  const input = { accounts: { first: account('first') } }
  for (const invalidResult of [{ ...result, success: false }, { ...result, accessToken: undefined },
    { ...result, accessToken: '' }, { ...result, accessToken: '   ' }, { ...result, refreshToken: 123 }]) {
    const applied = applyManagerTokenRotation(input, 'SYNTHETIC_OLD_REFRESH', invalidResult as ManagerTokenRotationResult, now)
    assert.equal(applied.data, input)
    assert.deepEqual(applied.updates, [])
  }
  for (const expected of ['', 'SYNTHETIC_OTHER', ' SYNTHETIC_OLD_REFRESH ']) {
    const applied = applyManagerTokenRotation(input, expected, result, now)
    assert.equal(applied.data, input)
    assert.deepEqual(applied.updates, [])
  }
  for (const malformed of [null, [], {}, { accounts: null }, { accounts: [] },
    { accounts: { missing: null, noCredentials: {}, arrayCredentials: { credentials: [] } } }]) {
    const applied = applyManagerTokenRotation(malformed, 'SYNTHETIC_OLD_REFRESH', result, now)
    assert.equal(applied.data, malformed)
    assert.deepEqual(applied.updates, [])
  }
})
