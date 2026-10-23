import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as subscriptions from '../../src/shared/accountSubscription.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'
import { verifiedAccount } from '../../src/renderer/src/utils/accountImport.ts'
import { getSubscriptionColor, getSubscriptionSoftColor } from '../../src/renderer/src/components/accounts/_helpers.ts'

const { normalizeSubscriptionType, normalizeAccountSubscription, mergeAccountSubscription, isPaidSubscription, SUBSCRIPTION_TYPES } = subscriptions

test('specific current plans take precedence over generic PRO and historical categories', () => {
  const cases = [
    [{ type: 'Pro', title: 'KIRO PRO MAX' }, 'Pro_Max'],
    [{ type: 'Pro', rawType: 'Q_DEVELOPER_STANDALONE_PRO_MAX', title: 'KIRO PRO' }, 'Pro_Max'],
    [{ type: 'Pro', rawType: 'Q_DEVELOPER_STANDALONE_PRO', title: 'KIRO PRO MAX' }, 'Pro_Max'],
    [{ type: 'Enterprise', title: 'KIRO POWER' }, 'Power'],
    [{ type: 'Enterprise', rawType: 'KIRO_POWER' }, 'Power'],
    [{ type: 'Pro', title: 'KIRO PRO+' }, 'Pro_Plus'],
    [{ type: 'Pro', rawType: 'Q_DEVELOPER_STANDALONE_PRO_PLUS' }, 'Pro_Plus'],
    [{ type: 'Pro_Max', title: 'KIRO FREE' }, 'Free'],
    [{ type: 'Power', title: 'Enterprise' }, 'Enterprise'],
    [{ type: 'Free', title: 'KIRO TEAMS' }, 'Teams']
  ]
  for (const [input, expected] of cases) assert.equal(normalizeSubscriptionType(input), expected)
  for (const type of SUBSCRIPTION_TYPES) assert.equal(normalizeSubscriptionType({ type }), type)
  for (const alias of ['Pro Max', 'pro-max', 'PRO_MAX', 'KIRO_PRO_MAX']) assert.equal(normalizeSubscriptionType(alias), 'Pro_Max')
  for (const alias of ['Pro+', 'Pro Plus', 'PROPLUS']) assert.equal(normalizeSubscriptionType(alias), 'Pro_Plus')
})

test('unknown plans remain unknown, never silently becoming FREE or matching a word fragment', () => {
  for (const input of [undefined, null, {}, { type: 'constructor' }, { type: 'Free', title: 'KIRO FUTURE PLAN' },
    { type: 'Pro', rawType: 'FUTURE_PLAN' }, 'unprofessional', 'powerful', 'freedom']) {
    assert.equal(normalizeSubscriptionType(input), 'Unknown')
    assert.equal(isPaidSubscription(input), false)
  }
  for (const type of ['Pro', 'Pro_Plus', 'Pro_Max', 'Power', 'Enterprise', 'Teams']) assert.equal(isPaidSubscription({ type }), true)
  assert.equal(isPaidSubscription({ type: 'Free' }), false)
})

test('normalization and fresh observations preserve display metadata and update the actual plan', () => {
  const original = { type: 'Pro', title: 'KIRO PRO MAX', rawType: 'KIRO_PRO_MAX', expiresAt: 1234 }
  assert.deepEqual(normalizeAccountSubscription(original), { ...original, type: 'Pro_Max' })
  assert.equal(original.type, 'Pro', 'normalization is pure')
  const downgraded = mergeAccountSubscription(original, { type: 'Free', title: 'KIRO FREE', rawType: 'KIRO_FREE' })
  assert.equal(downgraded.type, 'Free')
  assert.equal(downgraded.rawType, 'KIRO_FREE')
  const changedTitle = mergeAccountSubscription(original, { title: 'KIRO POWER' })
  assert.equal(changedTitle.type, 'Power')
  assert.equal(changedTitle.rawType, undefined, 'stale raw metadata cannot override a fresh title')
  assert.equal(mergeAccountSubscription(original, { type: 'Free' }).type, 'Free')
  assert.equal(mergeAccountSubscription(original, { title: 'KIRO FUTURE PLAN' }).type, 'Unknown')
  assert.equal(mergeAccountSubscription(original, { expiresAt: 5678 }).type, 'Pro_Max')
})

test('backup and verified credential imports retain MAX, POWER, and unknown service titles', () => {
  for (const [title, expected] of [['KIRO PRO MAX', 'Pro_Max'], ['KIRO POWER', 'Power'], ['KIRO FUTURE PLAN', 'Unknown']]) {
    const subscription = { type: title.includes('POWER') ? 'Enterprise' : 'Pro', title, rawType: title.replaceAll(' ', '_') }
    const plan = planBackupRestore({ version: '1.8.5', exportedAt: 1, groups: [], tags: [], accounts: [{ source: '$.accounts[0]', value: {
      id: 'synthetic', email: 'synthetic@example.invalid', idp: 'Github', credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'Github' },
      subscription, usage: { current: 12, limit: 5000 }, tags: []
    } }] }, { existingAccounts: [], existingGroups: new Map(), existingTags: new Map(), generateId: () => 'synthetic', generateMachineId: () => 'synthetic-machine', now: 1000 })
    assert.equal(plan.outcome.added, 1)
    assert.equal(plan.accounts[0].subscription.type, expected)
    assert.equal(plan.accounts[0].subscription.title, title)
    assert.equal(plan.accounts[0].usage.limit, 5000)
    const verified = verifiedAccount({ provider: 'Github', authMethod: 'social', refreshToken: 'SYNTHETIC_REFRESH' }, {
      email: 'synthetic@example.invalid', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_NEXT', expiresIn: 60,
      subscriptionType: 'Pro', subscriptionTitle: title, subscription: { rawType: subscription.rawType }, usage: { current: 12, limit: 5000 }
    }, 1000)
    assert.equal(verified.subscription.type, expected)
    assert.equal(verified.subscription.title, title)
    assert.equal(verified.usage.limit, 5000)
  }
})

test('all account views use distinct MAX, POWER, and enterprise badge colors', () => {
  assert.notEqual(getSubscriptionColor('Pro', 'KIRO PRO MAX'), getSubscriptionColor('Pro', 'KIRO PRO'))
  assert.notEqual(getSubscriptionColor('Enterprise', 'KIRO POWER'), getSubscriptionColor('Enterprise', 'Enterprise'))
  assert.match(getSubscriptionColor('Pro', undefined, 'KIRO_PRO_MAX'), /fuchsia/)
  assert.match(getSubscriptionSoftColor('Enterprise', 'KIRO POWER'), /amber/)
})

// Execute the actual store actions with isolated memory and fixed mock IPC.
// No Electron, application storage, authentication, timers, or network is started.
const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
const actionNames = ['addAccount', 'updateAccount', 'getFilteredAccounts', 'getStats', 'loadFromStorage', 'checkAccountStatus', 'applyBackgroundRefreshResults', 'applyBackgroundCheckResults']
const helperNames = ['credentialVersion', 'credentialResultDisposition', 'isDeferredAccountOperation', 'isBannedAccountError', 'accountOperationCountsAfter']
const actions = [], helpers = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && actionNames.includes(node.name?.getText(tree))) actions.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)) helpers.push(node.getText(tree).replace(/^export /, ''))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(actions.length, actionNames.length)
assert.equal(helpers.length, helperNames.length)
const script = ts.transpileModule(`let _filterCache = null, _statsCache = null; ${helpers.join('\n')} const actions = {${actions.join(',\n')}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
const sample = (id, subscription) => ({
  id, email: `${id}@example.invalid`, idp: 'Github', machineId: 'synthetic-machine', subscription,
  credentials: { accessToken: `SYNTHETIC_ACCESS_${id}`, refreshToken: `SYNTHETIC_REFRESH_${id}`, expiresAt: 1 },
  usage: { current: 12, limit: 5000, percentUsed: 12 / 5000, lastUpdated: 1 }, tags: [], status: 'active', createdAt: 1, lastUsedAt: 1
})
function storeFixture(accounts = [], api = {}) {
  const state = { accounts: new Map(accounts.map(account => [account.id, account])), filter: {}, sort: { field: 'subscription', order: 'asc' }, activeGroupTab: 'all', accountOperationCounts: new Map() }
  let storeActions, saves = 0, nextId = 0
  const effects = { saveToStorage: async () => { saves++ }, applyTheme() {}, startAutoSave() {}, updateAccountStatus() { throw new Error('Unexpected error path') } }
  const get = () => ({ ...state, ...storeActions, ...effects })
  const set = update => Object.assign(state, typeof update === 'function' ? update(state) : update)
  const context = vm.createContext({ ...subscriptions, get, set, window: { api }, console: { log() {}, error() {} },
    uuidv4: () => `synthetic-${++nextId}`, generateRandomMachineId: () => 'synthetic-machine', DEFAULT_PROXY_POOL_CONFIG: {},
    queueMicrotask() {}, Map, Set })
  vm.runInContext(script, context)
  storeActions = vm.runInContext('actions', context)
  return { state, actions: storeActions, get saves() { return saves } }
}

test('actual selectors classify legacy MAX/POWER independently and count/sort unknown plans safely', () => {
  const fixture = storeFixture([
    sample('max', { type: 'Pro', title: 'KIRO PRO MAX' }), sample('power', { type: 'Enterprise', title: 'KIRO POWER' }),
    sample('pro', { type: 'Pro', title: 'KIRO PRO' }), sample('enterprise', { type: 'Enterprise' }),
    sample('unknown', { type: 'Free', title: 'KIRO FUTURE PLAN' }), sample('plus', { type: 'Pro', title: 'KIRO PRO+' })
  ])
  const stats = fixture.actions.getStats()
  for (const type of ['Pro', 'Pro_Plus', 'Pro_Max', 'Power', 'Enterprise', 'Unknown']) assert.equal(stats.bySubscription[type], 1)
  assert.equal(stats.bySubscription.Free, 0)
  assert.equal(Object.values(stats.bySubscription).reduce((sum, value) => sum + value, 0), 6)
  assert.deepEqual(Array.from(fixture.actions.getFilteredAccounts(), account => account.id), ['pro', 'plus', 'max', 'power', 'enterprise', 'unknown'])
  fixture.state.filter = { subscriptionTypes: ['Pro_Max'] }
  assert.deepEqual(Array.from(fixture.actions.getFilteredAccounts(), account => account.id), ['max'])
  fixture.state.filter = { subscriptionTypes: ['Pro'] }
  assert.deepEqual(Array.from(fixture.actions.getFilteredAccounts(), account => account.id), ['pro'])
})

test('actual load/add/update paths migrate only classification and preserve titles and numeric quotas', async () => {
  const legacy = sample('power', { type: 'Enterprise', title: 'KIRO POWER' })
  const fixture = storeFixture([], { getAppVersion: async () => 'synthetic-version', loadAccounts: async () => ({ accounts: { power: legacy } }) })
  await fixture.actions.loadFromStorage()
  assert.equal(fixture.state.accounts.get('power').subscription.type, 'Power')
  assert.equal(fixture.state.accounts.get('power').subscription.title, 'KIRO POWER')
  assert.equal(fixture.saves, 1)
  const id = fixture.actions.addAccount(sample('max', { type: 'Pro', title: 'KIRO PRO MAX' }))
  assert.equal(fixture.state.accounts.get(id).subscription.type, 'Pro_Max')
  fixture.actions.updateAccount(id, { subscription: { type: 'Pro', title: 'KIRO PRO+' } })
  assert.equal(fixture.state.accounts.get(id).subscription.type, 'Pro_Plus')
  assert.equal(fixture.state.accounts.get(id).usage.limit, 5000)
})

test('actual manual check and both background result paths update raw type without collapsing PRO+', async () => {
  for (const route of ['manual', 'refresh', 'check']) {
    const original = sample('account', { type: 'Pro_Max', title: 'KIRO PRO MAX', rawType: 'KIRO_PRO_MAX' })
    const fresh = { type: 'Pro', title: 'KIRO PRO+', rawType: 'Q_DEVELOPER_STANDALONE_PRO_PLUS' }
    const usage = { current: 25, limit: 5500, addOnCurrent: 5, addOnLimit: 500, addOnCredits: [{ id: 'synthetic-pack', current: 5, limit: 500, remaining: 495, status: 'active' }] }
    const fixture = storeFixture([original], { checkAccountStatus: async () => ({ success: true, data: { subscription: fresh, usage, status: 'active' } }) })
    if (route === 'manual') await fixture.actions.checkAccountStatus(original.id)
    else fixture.actions[route === 'refresh' ? 'applyBackgroundRefreshResults' : 'applyBackgroundCheckResults']([{
      id: original.id, success: true, expectedAccessToken: original.credentials.accessToken, expectedRefreshToken: original.credentials.refreshToken,
      data: { subscription: fresh, usage }
    }])
    const updated = fixture.state.accounts.get(original.id)
    assert.equal(updated.subscription.type, 'Pro_Plus', route)
    assert.equal(updated.subscription.title, 'KIRO PRO+', route)
    assert.equal(updated.subscription.rawType, fresh.rawType, route)
    assert.equal(updated.usage.limit, 5500, route)
    assert.equal(updated.usage.addOnLimit, 500, route)
    assert.equal(updated.usage.addOnCredits[0].remaining, 495, route)
    assert.equal(fixture.actions.getStats().bySubscription.Pro_Plus, 1, route)
  }
})
