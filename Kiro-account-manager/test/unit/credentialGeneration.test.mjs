import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { mergeAccountSubscription, normalizeAccountSubscription, normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
const names = ['refreshAccountToken', 'checkAccountStatus', 'applyBackgroundRefreshResults', 'applyBackgroundCheckResults', 'updateAccountStatus', 'saveToStorage', 'flushSaveImmediately']
const properties = []
const helpers = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && names.includes(node.name?.getText(tree))) properties.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && ['credentialVersion', 'credentialResultDisposition', 'isDeferredAccountOperation', 'accountOperationCountsAfter', 'enqueueAccountPersistence', 'accountStorageSnapshot'].includes(node.name?.text)) helpers.push(node.getText(tree).replace(/^export /, ''))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(properties.length, names.length)
const factory = ts.transpileModule(`
let saveDebounceTimer = null, saveMaxWaitTimer = null, saveInFlight = null, lastSaveError = null;
let savePendingResolvers = [], accountPersistenceQueue = Promise.resolve();
const SAVE_DEBOUNCE_MS = 500, SAVE_MAX_WAIT_MS = 5000;
${helpers.join('\n')}\nconst actions = {${properties.join(',\n')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const account = (accessToken = 'SYNTHETIC_ACCESS_0', refreshToken = 'SYNTHETIC_REFRESH_0') => ({
  id: 'synthetic', email: 'synthetic@example.invalid', userId: 'synthetic-user', idp: 'BuilderId',
  credentials: { accessToken, refreshToken, expiresAt: 12345, clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1', authMethod: 'IdC', provider: 'BuilderId' },
  usage: { current: 1, limit: 10, percentUsed: 0.1, lastUpdated: 1 }, subscription: { type: 'Free' }, status: 'active', lastError: undefined
})
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(api = {}) {
  const state = { accounts: new Map([['synthetic', account()]]), accountOperationCounts: new Map(), groups: new Map(), tags: new Map(), proxyPool: new Map() }
  let saves = 0
  const hooks = [], writes = [], timers = new Map()
  let timerId = 0
  let actions
  const get = () => ({ ...state, ...actions, saveToStorage() { saves++; return actions.saveToStorage() } })
  const set = value => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const context = vm.createContext({ get, set, window: { api: { saveAccounts: async data => { writes.push(JSON.parse(JSON.stringify(data))) }, ...api } }, console: { log() {}, warn() {}, error() {} }, Date,
    mergeAccountSubscription, normalizeAccountSubscription, normalizeSubscriptionType,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
    triggerWebhook: (...args) => hooks.push(args), isBannedAccountError: () => false })
  vm.runInContext(factory, context)
  actions = vm.runInContext('actions', context)
  return { state, actions, hooks, writes, get saves() { return saves }, replace: value => state.accounts.set('synthetic', value), current: () => state.accounts.get('synthetic') }
}
const success = (accessToken = 'SYNTHETIC_ACCESS_1', refreshToken = 'SYNTHETIC_REFRESH_1') => ({ success: true, data: { accessToken, refreshToken, expiresIn: 3600 } })
const expected = { expectedRefreshToken: 'SYNTHETIC_REFRESH_0', expectedAccessToken: 'SYNTHETIC_ACCESS_0' }

test('manual refresh cannot overwrite a newer credential generation that arrives while IPC is pending', async () => {
  for (const refresh of ['SYNTHETIC_REFRESH_2', 'SYNTHETIC_REFRESH_0']) {
    const wait = deferred()
    const ctx = fixture({ refreshAccountToken: () => wait.promise })
    const task = ctx.actions.refreshAccountToken('synthetic')
    const newest = account('SYNTHETIC_ACCESS_2', refresh)
    ctx.replace(newest)
    wait.resolve(success())
    assert.equal(await task, false)
    assert.equal(ctx.current(), newest)
  }
})

test('late refresh failures never replace the status of rotated or nonrotated newer credentials', async () => {
  for (const [newRefresh, thrown] of [['SYNTHETIC_REFRESH_2', false], ['SYNTHETIC_REFRESH_0', false], ['SYNTHETIC_REFRESH_2', true]]) {
    const wait = deferred()
    const ctx = fixture({ refreshAccountToken: () => wait.promise })
    const task = ctx.actions.refreshAccountToken('synthetic')
    const newest = account('SYNTHETIC_ACCESS_2', newRefresh)
    ctx.replace(newest)
    if (thrown) wait.reject(new Error('Synthetic network failure'))
    else wait.resolve({ success: false, error: { message: 'Synthetic old credential failed' } })
    assert.equal(await task, false)
    assert.equal(ctx.current(), newest)
    assert.equal(ctx.hooks.length, 0)
  }
})

test('status-check success and failure are tied to their captured credentials', async () => {
  for (const result of [
    { success: true, data: { status: 'expired', email: 'older@example.invalid', newCredentials: success().data } },
    { success: false, error: { message: 'Synthetic old failure', isBanned: true } }
  ]) {
    const wait = deferred()
    const ctx = fixture({ checkAccountStatus: () => wait.promise })
    const task = ctx.actions.checkAccountStatus('synthetic')
    const newest = account('SYNTHETIC_ACCESS_2', 'SYNTHETIC_REFRESH_2')
    ctx.replace(newest)
    wait.resolve(result)
    await task
    assert.equal(ctx.current(), newest)
  }
})

test('background rotation results compare the original input rather than only account id', () => {
  const ctx = fixture()
  ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', success: true, ...expected, data: success().data }])
  assert.equal(ctx.current().credentials.refreshToken, 'SYNTHETIC_REFRESH_1')
  const first = ctx.current()
  ctx.actions.applyBackgroundRefreshResults([
    { id: 'synthetic', success: false, ...expected, error: 'Synthetic stale failure' },
    { id: 'synthetic', success: true, ...expected, data: { ...success('SYNTHETIC_OLD', 'SYNTHETIC_OLD').data, userInfo: { email: 'older@example.invalid' } } }
  ])
  assert.equal(ctx.current(), first)
})

test('idempotent deliveries do not extend expiry, replace metadata, or reset status', () => {
  const ctx = fixture()
  ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', success: true, ...expected, data: success().data }])
  const first = ctx.current()
  ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', success: true, ...expected, data: { ...success().data, expiresIn: 7200, userInfo: { email: 'duplicate@example.invalid' } } }])
  assert.equal(ctx.current(), first)
})

test('background checks and unattributed refresh events cannot overwrite a newer account state', () => {
  const ctx = fixture()
  const newest = account('SYNTHETIC_ACCESS_2', 'SYNTHETIC_REFRESH_0')
  ctx.replace(newest)
  ctx.actions.applyBackgroundCheckResults([{ id: 'synthetic', success: false, ...expected, error: 'Synthetic old failure' }])
  ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', success: true, data: success().data }])
  assert.equal(ctx.current(), newest)
})

test('current results still apply and deleted accounts are never recreated by late responses', async () => {
  const ctx = fixture({ refreshAccountToken: async () => success() })
  assert.equal(await ctx.actions.refreshAccountToken('synthetic'), true)
  assert.equal(ctx.current().status, 'active')
  assert.equal(ctx.current().credentials.accessToken, 'SYNTHETIC_ACCESS_1')
  const wait = deferred()
  const deleted = fixture({ checkAccountStatus: () => wait.promise })
  const task = deleted.actions.checkAccountStatus('synthetic')
  deleted.state.accounts.delete('synthetic')
  wait.resolve({ success: true, data: { status: 'active' } })
  await task
  assert.equal(deleted.current(), undefined)
})

test('manual duplicate success acknowledges the already-applied rotation without extending expiry', async () => {
  const wait = deferred()
  const ctx = fixture({ refreshAccountToken: () => wait.promise })
  const task = ctx.actions.refreshAccountToken('synthetic')
  const applied = account('SYNTHETIC_ACCESS_1', 'SYNTHETIC_REFRESH_1')
  ctx.replace(applied)
  wait.resolve(success())
  assert.equal(await task, true)
  assert.equal(ctx.current(), applied)
  assert.equal(ctx.current().credentials.expiresAt, 12345)
})

test('local ownership refusal preserves health, previous errors and checked time without saving or warning webhooks', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    for (const code of ['instance-owned', 'account-operation-in-flight']) {
      for (const status of ['active', 'expired', 'error']) {
        const response = { success: false, code, error: { code, message: 'Synthetic local operation deferred' } }
        const ctx = fixture({ [method]: async () => response })
        const original = { ...account(), status, lastError: 'Synthetic previous status', lastCheckedAt: 1234 }
        ctx.replace(original)
        const result = await ctx.actions[method]('synthetic')
        if (method === 'refreshAccountToken') assert.equal(result, false)
        assert.deepEqual(JSON.parse(JSON.stringify(ctx.current())), original)
        assert.equal(ctx.saves, 0)
        assert.equal(ctx.hooks.length, 0)
      }
    }
  }
})

test('a deferred account operation preserves intervening metadata edits and never undoes a new credential generation', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    for (const changedCredentials of [false, true]) {
      const wait = deferred()
      const ctx = fixture({ [method]: () => wait.promise })
      const task = ctx.actions[method]('synthetic')
      const updated = changedCredentials ? { ...account('SYNTHETIC_NEXT'), lastCheckedAt: 9876 } : { ...ctx.current(), nickname: 'Edited while waiting' }
      ctx.replace(updated)
      wait.resolve({ success: false, error: { code: 'instance-owned', message: 'Synthetic local refusal' } })
      await task
      if (changedCredentials) assert.equal(ctx.current(), updated)
      else {
        assert.equal(ctx.current().nickname, 'Edited while waiting')
        assert.equal(ctx.current().status, 'active')
      }
      assert.equal(ctx.hooks.length, 0)
      assert.equal(ctx.saves, 0)
    }
  }
})

test('credential errors and reauthorization-required remain persistent account failures', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    for (const code of ['reauthorization-required', 'invalid-ownership-state', 'invalid_grant', undefined]) {
      const ctx = fixture({ [method]: async () => ({ success: false, error: { code, message: 'Synthetic credential failure' } }) })
      await ctx.actions[method]('synthetic')
      assert.equal(ctx.current().status, 'error')
      assert.equal(ctx.current().lastError, 'Synthetic credential failure')
      assert.ok(ctx.saves > 0)
    }
  }
})

test('an unrelated pending save never persists manual operation progress or changes a locally refused account', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    for (const code of ['instance-owned', 'account-operation-in-flight']) {
      for (const status of ['active', 'expired', 'error']) {
        const wait = deferred()
        const ctx = fixture({ [method]: () => wait.promise })
        const original = { ...account(), status, lastError: 'Synthetic prior error', lastCheckedAt: 1234 }
        ctx.replace(original)
        const saving = ctx.actions.saveToStorage()
        const operation = ctx.actions[method]('synthetic')
        await ctx.actions.flushSaveImmediately()
        await saving
        assert.equal(ctx.writes[0].accounts.synthetic.status, status)
        assert.deepEqual(ctx.writes[0].accounts.synthetic, original)
        assert.equal('accountOperationCounts' in ctx.writes[0], false)
        assert.equal(ctx.state.accountOperationCounts.get('synthetic'), 1)
        wait.resolve({ success: false, code, error: { code, message: 'Synthetic local refusal' } })
        await operation
        assert.equal(ctx.current(), original)
        assert.equal(ctx.state.accountOperationCounts.has('synthetic'), false)
        assert.equal(ctx.saves, 0)
        assert.equal(ctx.hooks.length, 0)
      }
    }
  }
})

test('overlapping manual operations retain progress until all pending calls settle without overwriting health', async () => {
  for (const firstMethod of ['refreshAccountToken', 'checkAccountStatus']) {
    const secondMethod = firstMethod === 'refreshAccountToken' ? 'checkAccountStatus' : 'refreshAccountToken'
    const first = deferred(), second = deferred()
    const ctx = fixture({ [firstMethod]: () => first.promise, [secondMethod]: () => second.promise })
    const original = ctx.current()
    const firstCall = ctx.actions[firstMethod]('synthetic')
    const secondCall = ctx.actions[secondMethod]('synthetic')
    assert.equal(ctx.state.accountOperationCounts.get('synthetic'), 2)
    first.resolve({ success: false, code: 'account-operation-in-flight' })
    await firstCall
    assert.equal(ctx.state.accountOperationCounts.get('synthetic'), 1)
    assert.equal(ctx.current(), original)
    await ctx.actions.flushSaveImmediately()
    assert.equal(ctx.writes[0].accounts.synthetic.status, 'active')
    second.resolve({ success: false, code: 'instance-owned' })
    await secondCall
    assert.equal(ctx.state.accountOperationCounts.has('synthetic'), false)
    assert.equal(ctx.current(), original)
  }
})

test('manual operation success and real errors persist their outcome and always release progress', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    for (const outcome of ['success', 'error', 'throw']) {
      const wait = deferred()
      const ctx = fixture({ [method]: () => wait.promise })
      const operation = ctx.actions[method]('synthetic')
      await ctx.actions.flushSaveImmediately()
      assert.equal(ctx.writes[0].accounts.synthetic.status, 'active')
      if (outcome === 'throw') wait.reject(new Error('Synthetic transport failure'))
      else if (outcome === 'error') wait.resolve({ success: false, error: { message: 'Synthetic service failure' } })
      else wait.resolve(method === 'refreshAccountToken' ? success() : { success: true, data: { status: 'expired' } })
      await operation
      assert.equal(ctx.state.accountOperationCounts.has('synthetic'), false)
      assert.equal(ctx.current().status, outcome === 'success' ? method === 'refreshAccountToken' ? 'active' : 'expired' : 'error')
      assert.ok(ctx.saves > 0)
      await ctx.actions.flushSaveImmediately()
      assert.equal(ctx.writes.at(-1).accounts.synthetic.status, ctx.current().status)
      assert.equal(ctx.writes.at(-1).accounts.synthetic.lastError, ctx.current().lastError)
    }
  }
})

test('missing accounts do not start progress and late deleted-account replies release progress', async () => {
  for (const method of ['refreshAccountToken', 'checkAccountStatus']) {
    const wait = deferred()
    const ctx = fixture({ [method]: () => wait.promise })
    await ctx.actions[method]('missing')
    assert.equal(ctx.state.accountOperationCounts.size, 0)
    const operation = ctx.actions[method]('synthetic')
    assert.equal(ctx.state.accountOperationCounts.get('synthetic'), 1)
    ctx.state.accounts.delete('synthetic')
    wait.resolve({ success: false, code: 'instance-owned' })
    await operation
    assert.equal(ctx.state.accountOperationCounts.size, 0)
    assert.equal(ctx.current(), undefined)
  }
})
