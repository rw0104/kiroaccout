// 完整备份恢复规划回归测试（合成数据）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseAccountImportText, isOutcomeBalanced } from '../../src/shared/accountImport.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'

let seq = 0
const ctx = (over = {}) => ({
  existingAccounts: [],
  existingGroups: new Map(),
  existingTags: new Map(),
  generateId: () => `gen-${++seq}`,
  generateMachineId: () => 'm'.repeat(64),
  now: 1000,
  ...over
})

const acct = (id, email, extra = {}) => ({
  id,
  email,
  idp: 'BuilderId',
  credentials: { accessToken: '', csrfToken: '', refreshToken: `FAKE_RT_${id}`, clientId: 'FAKE_C', clientSecret: 'FAKE_S', expiresAt: 1, provider: 'BuilderId', authMethod: 'IdC' },
  subscription: { type: 'Pro' },
  usage: { current: 1, limit: 10, percentUsed: 0.1, lastUpdated: 1 },
  tags: [],
  status: 'active',
  createdAt: 1,
  lastUsedAt: 1,
  ...extra
})

const backupOf = (accounts, groups = [], tags = []) => parseAccountImportText(JSON.stringify({ version: '1.7.6', exportedAt: 1, accounts, groups, tags })).backup

test('AC-01：完整备份往返，保留分组/标签关系', () => {
  const b = backupOf(
    [acct('a1', 'a@example.invalid', { groupId: 'g1', tags: ['t1'] })],
    [{ id: 'g1', name: 'Team', order: 0, createdAt: 1 }],
    [{ id: 't1', name: 'Tag', color: '#fff' }]
  )
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.accounts[0].id, 'a1')
  assert.equal(plan.accounts[0].groupId, 'g1')
  assert.deepEqual(plan.accounts[0].tags, ['t1'])
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.tags.length, 1)
  assert.ok(isOutcomeBalanced(plan.outcome))
})

test('AC-01：分组 ID 冲突且定义不同 → 新 ID 并重映射，本地定义不被覆盖', () => {
  const b = backupOf([acct('a1', 'a@example.invalid', { groupId: 'g1' })], [{ id: 'g1', name: 'Imported', order: 0, createdAt: 1 }])
  const local = new Map([['g1', { id: 'g1', name: 'Local', order: 0, createdAt: 1 }]])
  const plan = planBackupRestore(b, ctx({ existingGroups: local }))
  assert.equal(plan.groups.length, 1)
  assert.notEqual(plan.groups[0].id, 'g1')
  assert.equal(plan.accounts[0].groupId, plan.groups[0].id)
})

test('F-04：账户 ID 与本地冲突 → 重新分配，不覆盖已有账户', () => {
  const b = backupOf([acct('same', 'new@example.invalid')])
  const plan = planBackupRestore(b, ctx({ existingAccounts: [{ id: 'same', email: 'old@example.invalid', credentials: { refreshToken: 'FAKE_OTHER' } }] }))
  assert.equal(plan.outcome.added, 1)
  assert.notEqual(plan.accounts[0].id, 'same')
})

test('F-04：同一备份内两个不同账户使用相同 ID → 两个都保留', () => {
  const b = backupOf([acct('dup', 'a@example.invalid'), { ...acct('dup', 'b@example.invalid'), credentials: { ...acct('x', '').credentials, refreshToken: 'FAKE_RT_OTHER' } }])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 2)
  assert.notEqual(plan.accounts[0].id, plan.accounts[1].id)
})

test('F-04：缺 id/credentials 的扁平记录不能伪装为成功', () => {
  const b = backupOf([{ refreshToken: 'FAKE_1', provider: 'Github' }, { refreshToken: 'FAKE_2', provider: 'Github' }])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 0)
  assert.equal(plan.outcome.invalid, 2)
  assert.ok(isOutcomeBalanced(plan.outcome))
})

test('null 记录、未知 provider 不会导致整批失败', () => {
  const b = backupOf([null, acct('ok', 'ok@example.invalid'), acct('bad', 'bad@example.invalid', { idp: 'X', credentials: { ...acct('bad', '').credentials, provider: 'Facebook' } })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.outcome.invalid, 2)
})

test('与本地重复的账户计为 duplicate（同邮箱同 provider）；同邮箱不同 provider 保留', () => {
  const existing = [{ id: 'e', email: 'A@example.invalid', idp: 'BuilderId', credentials: { provider: 'BuilderId', refreshToken: 'FAKE_E' } }]
  const google = acct('g', 'a@example.invalid', { idp: 'Google', credentials: { accessToken: '', csrfToken: '', refreshToken: 'FAKE_G', expiresAt: 1, provider: 'Google', authMethod: 'social' } })
  const b = backupOf([acct('b', 'a@example.invalid'), google])
  const plan = planBackupRestore(b, ctx({ existingAccounts: existing }))
  assert.equal(plan.outcome.duplicate, 1)
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.accounts[0].idp, 'Google')
})

test('groups/tags 缺失或类型错误不抛异常', () => {
  const missing = parseAccountImportText(JSON.stringify({ version: '1', accounts: [acct('a', 'a@example.invalid')] })).backup
  assert.equal(planBackupRestore(missing, ctx()).outcome.added, 1)
  const wrong = parseAccountImportText(JSON.stringify({ version: '1', accounts: [acct('a', 'a@example.invalid')], groups: 'x', tags: 5 })).backup
  const plan = planBackupRestore(wrong, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.ok(plan.notes.length >= 2)
})

test('旧备份 provider 别名被标准化，idp 与 credentials 同步', () => {
  const b = backupOf([acct('a', 'a@example.invalid', { idp: 'BuilderId', credentials: { refreshToken: 'FAKE', clientId: 'C', clientSecret: 'S', provider: 'Builder ID' } })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.accounts[0].idp, 'BuilderId')
  assert.equal(plan.accounts[0].credentials.provider, 'BuilderId')
  assert.equal(plan.accounts[0].credentials.authMethod, 'IdC')
})

test('无凭证导出（Token 为空）仍可作为数据恢复', () => {
  const b = backupOf([acct('a', 'a@example.invalid', { credentials: { accessToken: '', refreshToken: '', csrfToken: '', clientId: 'C', clientSecret: 'S', provider: 'BuilderId', authMethod: 'IdC', expiresAt: 1 } })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.accounts[0].status, 'unknown')
})

test('IdC with a refresh token cannot restore missing client credentials as usable', () => {
  const b = backupOf([acct('a', 'a@example.invalid', {
    credentials: { refreshToken: 'FAKE_INCOMPLETE', provider: 'Builder ID' }
  })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 0)
  assert.equal(plan.outcome.invalid, 1)
  assert.ok(plan.outcome.errors[0].message.includes('clientId'))
  assert.ok(isOutcomeBalanced(plan.outcome))
})

test('tokenless metadata backup still requires a recognizable identity', () => {
  const b = backupOf([acct('a', '', { credentials: { provider: 'Google', authMethod: 'social' } })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.invalid, 1)
})

test('restore rejects unknown or missing providers without guessing Google', () => {
  const b = backupOf([
    acct('a', 'a@example.invalid', { idp: undefined, credentials: { refreshToken: 'FAKE_A', authMethod: 'social' } }),
    acct('b', 'b@example.invalid', { idp: 'constructor', credentials: { refreshToken: 'FAKE_B' } })
  ])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 0)
  assert.equal(plan.outcome.invalid, 2)
})

test('restore shares snake_case normalization and conflict rejection', () => {
  const b = backupOf([
    acct('a', 'a@example.invalid', { credentials: { refresh_token: 'FAKE_A', client_id: 'C', client_secret: 'S', provider: 'builder_id' } }),
    acct('b', 'b@example.invalid', { refreshToken: 'FAKE_CONFLICT' })
  ])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.outcome.invalid, 1)
  assert.equal(plan.accounts[0].credentials.refreshToken, 'FAKE_A')
  assert.equal(plan.accounts[0].credentials.clientId, 'C')
})

test('invalid region and typed credential fields are rejected per record', () => {
  const b = backupOf([
    acct('a', 'a@example.invalid', { credentials: { ...acct('a', '').credentials, region: 'NOT_A_REGION' } }),
    acct('b', 'b@example.invalid', { credentials: { ...acct('b', '').credentials, refreshToken: 42 } }),
    acct('c', 'c@example.invalid')
  ])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.invalid, 2)
  assert.equal(plan.outcome.added, 1)
  assert.ok(!JSON.stringify(plan.outcome.errors).includes('NOT_A_REGION'))
})

test('in-batch duplicate restored identities are counted once', () => {
  const b = backupOf([
    acct('a', 'A@example.invalid'), acct('b', 'a@example.invalid'),
    acct('c', 'c@example.invalid', { credentials: acct('a', '').credentials })
  ])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.outcome.added, 1)
  assert.equal(plan.outcome.duplicate, 2)
  assert.ok(isOutcomeBalanced(plan.outcome))
  assert.ok(!JSON.stringify(plan.outcome.errors).includes('@example.invalid'))
})

test('repeated group/tag source IDs retain one definition and stable references', () => {
  const b = backupOf(
    [acct('a', 'a@example.invalid', { groupId: 'g', tags: ['t', 't', 'missing'] })],
    [{ id: 'g', name: 'First' }, { id: 'g', name: 'Second' }],
    [{ id: 't', name: 'First', color: '#fff' }, { id: 't', name: 'Second', color: '#000' }]
  )
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.groups.length, 1)
  assert.equal(plan.tags.length, 1)
  assert.equal(plan.groups[0].name, 'First')
  assert.equal(plan.accounts[0].groupId, 'g')
  assert.deepEqual(plan.accounts[0].tags, ['t'])
})

test('malformed or explicit empty collections cannot attach unrelated local references', () => {
  for (const collections of [{ groups: 'invalid', tags: 3 }, { groups: [], tags: [] }]) {
    const b = backupOf([acct('a', 'a@example.invalid', { groupId: 'g', tags: ['t'] })])
    Object.assign(b, collections)
    const plan = planBackupRestore(b, ctx({
      existingGroups: new Map([['g', { id: 'g', name: 'Unrelated', order: 0, createdAt: 1 }]]),
      existingTags: new Map([['t', { id: 't', name: 'Unrelated', color: '#fff' }]])
    }))
    assert.equal(plan.accounts[0].groupId, undefined)
    assert.deepEqual(plan.accounts[0].tags, [])
  }
})

test('colliding ID generator cannot overwrite local or future source IDs', () => {
  const b = backupOf([acct('same', 'a@example.invalid'), acct('future', 'b@example.invalid')],
    [{ id: 'g', name: 'Incoming' }, { id: 'future', name: 'Future' }],
    [{ id: 't', name: 'Incoming' }, { id: 'future', name: 'Future' }])
  const plan = planBackupRestore(b, ctx({
    existingAccounts: [{ id: 'same', credentials: { refreshToken: 'FAKE_LOCAL' } }],
    existingGroups: new Map([['g', { id: 'g', name: 'Local', order: 0, createdAt: 1 }]]),
    existingTags: new Map([['t', { id: 't', name: 'Local', color: '#000' }]]),
    generateId: () => 'future'
  }))
  assert.equal(plan.outcome.added, 2)
  assert.equal(plan.accounts[1].id, 'future')
  assert.notEqual(plan.accounts[0].id, 'future')
  assert.equal(new Set(plan.groups.map(group => group.id)).size, 2)
  assert.equal(new Set(plan.tags.map(tag => tag.id)).size, 2)
  assert.ok(isOutcomeBalanced(plan.outcome))
})

test('group description differences are preserved and notes do not expose names', () => {
  const b = backupOf([acct('a', 'a@example.invalid', { groupId: 'g' })],
    [{ id: 'g', name: 'SENSITIVE_NAME', description: 'Incoming' }])
  const plan = planBackupRestore(b, ctx({ existingGroups: new Map([
    ['g', { id: 'g', name: 'SENSITIVE_NAME', description: 'Local', order: 0, createdAt: 1 }]
  ]) }))
  assert.equal(plan.groups.length, 1)
  assert.notEqual(plan.groups[0].id, 'g')
  assert.ok(!JSON.stringify(plan.notes).includes('SENSITIVE_NAME'))
})

test('unknown subscriptions and transient state are normalized for restored accounts', () => {
  const b = backupOf([acct('a', 'a@example.invalid', { status: 'refreshing', subscription: { type: 'Unknown' }, usage: { current: '1' } })])
  const plan = planBackupRestore(b, ctx())
  assert.equal(plan.accounts[0].status, 'unknown')
  assert.equal(plan.accounts[0].subscription.type, 'Unknown')
  assert.equal(plan.accounts[0].usage.current, 0)
  assert.equal(plan.accounts[0].isActive, false)
})
