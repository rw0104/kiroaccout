import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { mergeAccountSubscription, normalizeAccountSubscription, normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'

import { applyManagerTokenRotation } from '../../src/main/managerAccountRefresh.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
const names = ['loadFromStorage', 'refreshAccountToken', 'checkAccountStatus', 'applyBackgroundRefreshResults', 'applyBackgroundCheckResults', 'updateAccount', 'updateAccountStatus', 'moveAccountsToGroup', 'removeGroup', 'addTagToAccounts', 'removeTagFromAccounts', 'removeTag', 'saveToStorage', 'flushSaveImmediately']
const properties = []
const helpers = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && names.includes(node.name?.getText(tree))) properties.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && ['isBannedAccountError', 'failedCheckHealth', 'credentialVersion', 'credentialResultDisposition', 'isDeferredAccountOperation', 'accountOperationCountsAfter', 'enqueueAccountPersistence', 'accountStorageSnapshot', 'receivedProfileArn'].includes(node.name?.text)) helpers.push(node.getText(tree).replace(/^export /, ''))
  ts.forEachChild(node, visit)
}
visit(tree)
const appSource = readFileSync(new URL('../../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const appTree = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let receiveRotation
function findRotationListener(node) {
  if (ts.isCallExpression(node) && node.expression.getText(appTree) === 'window.api.onKiroInstanceAccountUpdate') {
    receiveRotation = node.arguments[0].getText(appTree)
  }
  ts.forEachChild(node, findRotationListener)
}
findRotationListener(appTree)
assert.ok(receiveRotation)
function uiHandler(relativePath, name) {
  const uiSource = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const uiTree = ts.createSourceFile(relativePath, uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(uiTree) === name) {
      const value = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer
      handler = value.getText(uiTree)
    }
    ts.forEachChild(node, visit)
  }
  visit(uiTree)
  assert.ok(handler)
  return handler
}
const cardRefreshHandler = uiHandler('../../src/renderer/src/components/accounts/AccountCard.tsx', 'handleRefreshToken')
const rowRefreshHandler = uiHandler('../../src/renderer/src/components/accounts/AccountListRow.tsx', 'handleRefresh')
assert.equal(properties.length, names.length)
const factory = ts.transpileModule(`
let saveDebounceTimer = null, saveMaxWaitTimer = null, saveInFlight = null, lastSaveError = null;
let savePendingResolvers = [], accountPersistenceQueue = Promise.resolve();
const saveQueuedFlushes = new Map();
const SAVE_DEBOUNCE_MS = 500, SAVE_MAX_WAIT_MS = 5000;
${helpers.join('\n')}\nconst actions = {${properties.join(',\n')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const account = (accessToken = 'SYNTHETIC_ACCESS_0', refreshToken = 'SYNTHETIC_REFRESH_0') => ({
  id: 'synthetic', email: 'synthetic@example.invalid', userId: 'synthetic-user', idp: 'BuilderId',
  credentials: { accessToken, refreshToken, expiresAt: 12345, clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1', authMethod: 'IdC', provider: 'BuilderId' },
  usage: { current: 1, limit: 10, percentUsed: 0.1, lastUpdated: 1 }, subscription: { type: 'Free' }, tags: ['original-tag'], groupId: 'original-group', status: 'active', lastError: undefined
})
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(api = {}) {
  const state = { accounts: new Map([['synthetic', account()]]), accountOperationCounts: new Map(), groups: new Map(), tags: new Map(), proxyPool: new Map() }
  let saves = 0
  let feedback = null, spinning = false
  const hooks = [], writes = [], timers = new Map()
  let timerId = 0
  let actions
  const get = () => ({ ...state, ...actions, applyTheme() {}, startAutoSave() {}, saveToStorage() { saves++; return actions.saveToStorage() } })
  const set = value => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const context = vm.createContext({ pendingRotationHealth: new WeakMap(), get, set, window: { api: { saveAccounts: async data => { writes.push(JSON.parse(JSON.stringify(data))) }, getAppVersion: async () => 'synthetic', ...api } }, console: { log() {}, warn() {}, error() {} }, Date,
    mergeAccountSubscription, normalizeAccountSubscription, normalizeSubscriptionType,
    DEFAULT_PROXY_POOL_CONFIG: {}, generateRandomMachineId: () => 'f'.repeat(64), queueMicrotask() {},
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
    triggerWebhook: (...args) => hooks.push(args) })
  vm.runInContext(factory, context)
  actions = vm.runInContext('actions', context)
  context.useAccountsStore = { getState: get }
  context.updateAccount = actions.updateAccount
  Object.assign(context, { account: account(), isEn: true, isRefreshing: false, isAccountOperationPending: false,
    refreshAccountToken: actions.refreshAccountToken, checkAccountStatus: actions.checkAccountStatus,
    setIsRefreshingToken: value => { spinning = value }, setIsRefreshing: value => { spinning = value },
    setTokenRefreshFeedback: value => { feedback = value } })
  const compileUi = handler => vm.runInContext(ts.transpileModule('(' + handler + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const cardRefresh = compileUi(cardRefreshHandler)
  const rowRefresh = () => compileUi(rowRefreshHandler)({ stopPropagation() {} })
  const notify = vm.runInContext(ts.transpileModule('(' + receiveRotation + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { state, actions, hooks, writes, notify, cardRefresh, rowRefresh, get feedback() { return feedback }, get spinning() { return spinning }, get saves() { return saves }, replace: value => state.accounts.set('synthetic', value), current: () => state.accounts.get('synthetic') }
}
const success = (accessToken = 'SYNTHETIC_ACCESS_1', refreshToken = 'SYNTHETIC_REFRESH_1') => ({ success: true, data: { accessToken, refreshToken, expiresIn: 3600 } })
const expected = { expectedRefreshToken: 'SYNTHETIC_REFRESH_0', expectedAccessToken: 'SYNTHETIC_ACCESS_0' }

const oldProfile = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/SYNTHETIC_OLD'
const newProfile = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/SYNTHETIC_NEW'
function withProfile(accountValue, profile = oldProfile) {
  return { ...accountValue, idp: 'Google', profileArn: profile, credentials: { ...accountValue.credentials, provider: 'Google', authMethod: 'social', profileArn: profile } }
}
function profileResponse(kind, profileArn) {
  const data = { ...success().data, profileArn, expiresAt: 67890 }
  return kind === 'manual' || kind === 'background'
    ? { success: true, data }
    : { success: kind !== 'check-error', data: { status: 'active', newCredentials: data }, error: { message: 'Synthetic follow-up failure' } }
}
async function applyProfileResult(ctx, kind, response) {
  if (kind === 'background') ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', ...expected, ...response }])
  else await ctx.actions[kind === 'manual' ? 'refreshAccountToken' : 'checkAccountStatus']('synthetic')
}

test('all refresh result entry points persist a nonempty returned Social profile alongside its credential generation', async () => {
  for (const kind of ['manual', 'background', 'check-success', 'check-error']) {
    const response = profileResponse(kind, ` ${newProfile} `)
    const ctx = fixture({ refreshAccountToken: async () => response, checkAccountStatus: async () => response })
    ctx.replace(withProfile(account()))
    await applyProfileResult(ctx, kind, response)
    assert.equal(ctx.current().profileArn, newProfile, kind)
    assert.equal(ctx.current().credentials.profileArn, newProfile, kind)
    assert.equal(ctx.current().credentials.accessToken, 'SYNTHETIC_ACCESS_1')
    await ctx.actions.flushSaveImmediately()
    assert.equal(ctx.writes.at(-1).accounts.synthetic.profileArn, newProfile)
    assert.equal(ctx.writes.at(-1).accounts.synthetic.credentials.profileArn, newProfile)
  }
})

test('omitted, blank and malformed returned profiles preserve both saved fields without hiding a preexisting conflict', async () => {
  for (const kind of ['manual', 'background', 'check-success', 'check-error']) {
    for (const profileArn of [undefined, '', '  ', null, 123, {}]) {
      const response = profileResponse(kind, profileArn)
      const ctx = fixture({ refreshAccountToken: async () => response, checkAccountStatus: async () => response })
      const original = withProfile(account())
      original.profileArn = `${oldProfile}_TOP`
      ctx.replace(original)
      await applyProfileResult(ctx, kind, response)
      assert.equal(ctx.current().profileArn, `${oldProfile}_TOP`, kind)
      assert.equal(ctx.current().credentials.profileArn, oldProfile, kind)
    }
  }
})

test('stale and duplicate refresh replies cannot restore an older profile over the current generation', async () => {
  for (const kind of ['manual', 'background', 'check-success', 'check-error']) {
    for (const duplicate of [false, true]) {
      const response = profileResponse(kind, oldProfile)
      const wait = deferred()
      const ctx = fixture({ refreshAccountToken: () => wait.promise, checkAccountStatus: () => wait.promise })
      const pending = kind === 'background' ? undefined : applyProfileResult(ctx, kind, response)
      const current = withProfile(account(duplicate ? 'SYNTHETIC_ACCESS_1' : 'SYNTHETIC_ACCESS_2', duplicate ? 'SYNTHETIC_REFRESH_1' : 'SYNTHETIC_REFRESH_2'), newProfile)
      ctx.replace(current)
      if (kind === 'background') await applyProfileResult(ctx, kind, response)
      else { wait.resolve(response); await pending }
      assert.equal(ctx.current(), current, kind)
    }
  }
})

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

test('status-check failure still persists a rotated credential returned with the error', async () => {
  const ctx = fixture({ checkAccountStatus: async () => ({
    success: false,
    data: { status: 'error', newCredentials: { accessToken: 'SYNTHETIC_ACCESS_1', refreshToken: 'SYNTHETIC_REFRESH_1', expiresAt: 67890 } },
    error: { message: 'Synthetic follow-up query failed' }
  }) })
  await ctx.actions.checkAccountStatus('synthetic')
  assert.equal(ctx.current().credentials.accessToken, 'SYNTHETIC_ACCESS_1')
  assert.equal(ctx.current().credentials.refreshToken, 'SYNTHETIC_REFRESH_1')
  assert.equal(ctx.current().credentials.expiresAt, 67890)
  assert.equal(ctx.current().status, 'error')
  assert.equal(ctx.current().lastError, 'Synthetic follow-up query failed')
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
      assert.equal(ctx.current().status, outcome === 'success' ? method === 'refreshAccountToken' ? 'active' : 'expired' : outcome === 'throw' ? 'active' : 'error')
      assert.equal(!!ctx.current().lastCheckInconclusive, outcome === 'throw')
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

test('inconclusive checks and renewals preserve the previous health until a confirmed result arrives', async () => {
  for (const [method, diagnostic] of [
    ['refreshAccountToken', 'HTTP 403: refresh rejected'],
    ['checkAccountStatus', 'missing_profile'],
    ['applyBackgroundRefreshResults', 'connection timed out'],
    ['applyBackgroundCheckResults', 'HTTP 429: rate limited']
  ]) {
    for (const previousStatus of ['active', 'expired']) {
      const manual = method === 'refreshAccountToken' || method === 'checkAccountStatus'
      let response = { success: false, preserveStatus: true, error: manual ? { message: diagnostic } : diagnostic }
      const ctx = fixture({ [method]: async () => response })
      const original = { ...account(), status: previousStatus, lastError: previousStatus === 'expired' ? 'Token expired' : undefined }
      ctx.replace(original)
      const deliver = () => manual
        ? ctx.actions[method]('synthetic')
        : ctx.actions[method]([{ id: 'synthetic', ...expected, ...response }])
      await deliver()
      assert.equal(ctx.current().status, previousStatus, method)
      assert.equal(ctx.current().lastError, original.lastError, method)
      assert.equal(ctx.current().lastCheckInconclusive, true, method)
      assert.equal(ctx.current().credentials.expiresAt, original.credentials.expiresAt, method)
      assert.equal(ctx.hooks.length, 0, method)
      await ctx.actions.flushSaveImmediately()
      assert.equal(ctx.writes.at(-1).accounts.synthetic.lastCheckInconclusive, true, method)

      response = method === 'refreshAccountToken' ? success() : { success: true, data: { status: 'active' } }
      await deliver()
      assert.equal(ctx.current().status, 'active', method)
      assert.equal(ctx.current().lastError, undefined, method)
      assert.ok(!ctx.current().lastCheckInconclusive, method)
    }
  }
})

test('a failed batch check carrying an explicit token rejection persists expired status', () => {
  const ctx = fixture()
  ctx.replace({ ...account(), lastCheckInconclusive: true })
  ctx.actions.applyBackgroundCheckResults([{
    id: 'synthetic', ...expected, success: false, data: { status: 'expired' }, error: 'Token expired'
  }])
  assert.equal(ctx.current().status, 'expired')
  assert.equal(ctx.current().lastError, 'Token expired')
  assert.ok(!ctx.current().lastCheckInconclusive)
})

test('an inconclusive background information check still saves a successful credential rotation exactly once', () => {
  const ctx = fixture()
  ctx.replace({ ...account(), status: 'expired', lastError: 'Previous expiry' })
  const result = { id: 'synthetic', ...expected, ...success(), success: false, credentialsRefreshed: true, preserveStatus: true }
  const before = Date.now()
  ctx.actions.applyBackgroundRefreshResults([result])
  assert.equal(ctx.current().status, 'expired')
  assert.equal(ctx.current().lastError, 'Previous expiry')
  assert.equal(ctx.current().lastCheckInconclusive, true)
  assert.equal(ctx.current().credentials.accessToken, result.data.accessToken)
  assert.equal(ctx.current().credentials.refreshToken, result.data.refreshToken)
  const deadline = ctx.current().credentials.expiresAt
  assert.ok(deadline >= before + result.data.expiresIn * 1000 && deadline <= Date.now() + result.data.expiresIn * 1000)
  ctx.actions.applyBackgroundRefreshResults([{ ...result, data: { ...result.data, expiresIn: 7200 } }])
  assert.equal(ctx.current().credentials.expiresAt, deadline)
})

test('a manager credential push followed by its health result recovers immediately and retains the absolute expiry', async () => {
  for (const kind of ['manual', 'background', 'check-success', 'check-error']) {
    const wait = deferred()
    const ctx = fixture({ refreshAccountToken: () => wait.promise, checkAccountStatus: () => wait.promise })
    const original = { ...account(), nickname: 'keep', status: 'error', lastError: 'previous error' }
    ctx.replace(original)
    const pending = kind === 'background' ? undefined : applyProfileResult(ctx, kind)
    const response = profileResponse(kind, undefined)
    const { updates } = applyManagerTokenRotation({ accounts: { synthetic: original } }, expected.expectedRefreshToken, { success: true, ...success().data }, 1200)
    const notification = updates[0]
    ctx.notify(notification)
    assert.equal(ctx.current().credentials.expiresAt, notification.credentials.expiresAt)
    assert.equal(ctx.current().status, 'error')
    ctx.actions.updateAccount('synthetic', { nickname: 'edited while the result is in flight' })
    if (kind === 'background') await applyProfileResult(ctx, kind, response)
    else { wait.resolve(response); await pending }
    if (kind === 'check-error') assert.equal(ctx.current().lastError, 'Synthetic follow-up failure')
    else { assert.equal(ctx.current().status, 'active', kind); assert.equal(ctx.current().lastError, undefined) }
    assert.equal(ctx.current().credentials.expiresAt, notification.credentials.expiresAt, kind)
    assert.equal(ctx.current().nickname, 'edited while the result is in flight')
    const latest = ctx.current()
    ctx.notify(notification)
    assert.equal(ctx.current(), latest, 'replayed main event')
    if (kind === 'background') {
      await applyProfileResult(ctx, kind, response)
      assert.equal(ctx.current(), latest, 'replayed result')
    }
  }
})

test('an intervening health check supersedes the buffered result for an already published rotation', () => {
  const ctx = fixture()
  const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
  ctx.notify(updates[0])
  ctx.actions.updateAccountStatus('synthetic', 'error', 'HTTP 423: AccountSuspendedException')
  const banned = ctx.current()
  ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', ...expected, ...success() }])
  assert.equal(ctx.current(), banned)
})


test('metadata changes do not discard a matching rotation health result', () => {
  for (const mutate of [
    actions => actions.moveAccountsToGroup(['synthetic'], 'new-group'),
    actions => actions.removeGroup('original-group'),
    actions => actions.addTagToAccounts(['synthetic'], 'new-tag'),
    actions => actions.removeTagFromAccounts(['synthetic'], 'original-tag'),
    actions => actions.removeTag('original-tag'),
    (actions, current) => actions.updateAccount('synthetic', { credentials: { ...current.credentials, profileArn: newProfile } })
  ]) {
    const ctx = fixture()
    ctx.replace({ ...account(), status: 'error', lastError: 'Previous token failure' })
    const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data }, 1200)
    ctx.notify(updates[0])
    mutate(ctx.actions, ctx.current())
    const edited = ctx.current()
    ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', ...expected, ...success() }])
    assert.equal(ctx.current().status, 'active')
    assert.equal(ctx.current().lastError, undefined)
    assert.equal(ctx.current().credentials.expiresAt, updates[0].credentials.expiresAt)
    assert.equal(ctx.current().groupId, edited.groupId)
    assert.deepEqual(ctx.current().tags, edited.tags)
  }
})

test('token-only renewal never clears a confirmed suspension but a successful status query can', async () => {
  for (const kind of ['manual', 'background']) {
    const response = success()
    const ctx = fixture({ refreshAccountToken: async () => response })
    ctx.replace({ ...account(), status: 'error', lastError: 'HTTP 423: AccountSuspendedException' })
    await applyProfileResult(ctx, kind, response)
    assert.equal(ctx.current().status, 'error', kind)
    assert.equal(ctx.current().lastError, 'HTTP 423: AccountSuspendedException', kind)
    ctx.actions.applyBackgroundCheckResults([{
      id: 'synthetic', expectedAccessToken: ctx.current().credentials.accessToken,
      expectedRefreshToken: ctx.current().credentials.refreshToken,
      success: true, data: { status: 'active' }
    }])
    assert.equal(ctx.current().status, 'active')
    assert.equal(ctx.current().lastError, undefined)
  }
})


test('all newer health entry points consume a pending rotation before its older buffered result arrives', async () => {
  for (const kind of ['manual', 'background-check', 'background-refresh', 'update']) {
    const ctx = fixture({ checkAccountStatus: async () => ({ success: true, data: { status: 'expired' } }) })
    const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
    ctx.notify(updates[0])
    if (kind === 'manual') await ctx.actions.checkAccountStatus('synthetic')
    else if (kind === 'update') ctx.actions.updateAccount('synthetic', { status: 'expired' })
    else ctx.actions[kind === 'background-check' ? 'applyBackgroundCheckResults' : 'applyBackgroundRefreshResults']([{
      id: 'synthetic', expectedAccessToken: ctx.current().credentials.accessToken,
      expectedRefreshToken: ctx.current().credentials.refreshToken,
      success: false, data: { status: 'expired' }, error: 'Token expired'
    }])
    const newer = ctx.current()
    assert.equal(newer.status, 'expired', kind)
    ctx.actions.applyBackgroundRefreshResults([{ id: 'synthetic', ...expected, ...success() }])
    assert.equal(ctx.current(), newer, kind)
  }
})


test('card key reports the current failed renewal instead of only stopping its spinner', async () => {
  const rejection = 'HTTP 403: synthetic current refresh refusal'
  const ctx = fixture({ refreshAccountToken: async () => ({ success: false, preserveStatus: true, error: { message: rejection } }) })
  ctx.replace({ ...account(), status: 'error', lastError: 'Historical token expiry' })
  await ctx.cardRefresh()
  assert.equal(ctx.spinning, false)
  assert.equal(ctx.feedback?.success, false)
  assert.equal(ctx.feedback?.message, rejection)
  assert.equal(ctx.current().lastError, 'Historical token expiry')
  assert.equal(ctx.current().lastCheckInconclusive, true)
})

test('list refresh stops after a failed renewal instead of issuing a second status-triggered renewal', async () => {
  let checks = 0
  const ctx = fixture({
    refreshAccountToken: async () => ({ success: false, preserveStatus: true, error: { message: 'HTTP 403: synthetic refusal' } }),
    checkAccountStatus: async () => { checks++; return { success: false, preserveStatus: true } }
  })
  await ctx.rowRefresh()
  assert.equal(checks, 0)
  assert.equal(ctx.feedback?.success, false)
})

test('an inconclusive concurrent check does not discard the card renewal success after credentials were published', async () => {
  for (const check of ['manual', 'background']) {
    const wait = deferred()
    const ctx = fixture({ refreshAccountToken: () => wait.promise, checkAccountStatus: async () => ({ success: false, preserveStatus: true, error: { message: 'Synthetic timeout' } }) })
    ctx.replace({ ...account(), status: 'error', lastError: 'Historical token expiry' })
    const pending = ctx.cardRefresh()
    const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
    ctx.notify(updates[0])
    if (check === 'manual') await ctx.actions.checkAccountStatus('synthetic')
    else ctx.actions.applyBackgroundCheckResults([{
      id: 'synthetic', expectedAccessToken: ctx.current().credentials.accessToken, expectedRefreshToken: ctx.current().credentials.refreshToken,
      success: false, preserveStatus: true, error: 'Synthetic timeout'
    }])
    wait.resolve(success())
    await pending
    assert.equal(ctx.current().lastError, undefined, check)
    assert.equal(ctx.current().status, 'active', check)
    assert.equal(ctx.current().credentials.expiresAt, updates[0].credentials.expiresAt)
    assert.equal(ctx.feedback?.success, true)
  }
})


test('a storage reload of the same published generation retains the card renewal completion', async () => {
  const wait = deferred()
  let stored
  const ctx = fixture({ refreshAccountToken: () => wait.promise, loadAccounts: async () => stored })
  ctx.replace({ ...account(), status: 'error', lastError: 'Historical token expiry' })
  const pending = ctx.cardRefresh()
  const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
  ctx.notify(updates[0])
  stored = JSON.parse(JSON.stringify({ accounts: { synthetic: ctx.current() } }))
  await ctx.actions.loadFromStorage()
  wait.resolve(success())
  await pending
  assert.equal(ctx.current().lastError, undefined)
  assert.equal(ctx.current().credentials.expiresAt, updates[0].credentials.expiresAt)
})


test('card feedback describes token renewal without clearing a separately confirmed suspension', async () => {
  const ctx = fixture({ refreshAccountToken: async () => success() })
  ctx.replace({ ...account(), status: 'error', lastError: 'HTTP 423: AccountSuspendedException' })
  await ctx.cardRefresh()
  assert.equal(ctx.feedback?.success, true)
  assert.equal(ctx.feedback?.message, 'Access token renewed.')
  assert.equal(ctx.current().status, 'error')
  assert.equal(ctx.current().lastError, 'HTTP 423: AccountSuspendedException')
})

test('card feedback stays attached to its own request when automatic renewal finishes concurrently', async () => {
  const manual = deferred(), automatic = deferred()
  let calls = 0
  const ctx = fixture({ refreshAccountToken: () => ++calls === 1 ? manual.promise : automatic.promise })
  const clicked = ctx.cardRefresh()
  const background = ctx.actions.refreshAccountToken('synthetic')
  manual.resolve({ success: false, preserveStatus: true, error: { message: 'HTTP 403: manual refusal' } })
  automatic.resolve({ success: false, preserveStatus: true, error: { message: 'HTTP 429: automatic rate limit' } })
  await Promise.all([clicked, background])
  assert.equal(ctx.feedback?.success, false)
  assert.equal(ctx.feedback?.message, 'HTTP 403: manual refusal')
})

test('a storage reload carrying newer health does not inherit pending rotation completion', async () => {
  const wait = deferred()
  let stored
  const ctx = fixture({ refreshAccountToken: () => wait.promise, loadAccounts: async () => stored })
  const pending = ctx.cardRefresh()
  const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
  ctx.notify(updates[0])
  stored = JSON.parse(JSON.stringify({ accounts: { synthetic: { ...ctx.current(), status: 'error', lastError: 'HTTP 423: AccountSuspendedException', lastCheckedAt: Date.now() } } }))
  await ctx.actions.loadFromStorage()
  const loaded = ctx.current()
  wait.resolve(success())
  await pending
  assert.equal(ctx.current(), loaded)
  assert.equal(ctx.current().lastError, 'HTTP 423: AccountSuspendedException')
})


test('an older same-generation reload after an inconclusive check retains pending card renewal', async () => {
  const wait = deferred()
  let stored
  const ctx = fixture({ refreshAccountToken: () => wait.promise, loadAccounts: async () => stored,
    checkAccountStatus: async () => ({ success: false, preserveStatus: true, error: { message: 'Synthetic timeout' } }) })
  ctx.replace({ ...account(), status: 'error', lastError: 'Historical token expiry', lastCheckedAt: 1000 })
  const pending = ctx.cardRefresh()
  const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
  ctx.notify(updates[0])
  stored = JSON.parse(JSON.stringify({ accounts: { synthetic: ctx.current() } }))
  await ctx.actions.checkAccountStatus('synthetic')
  assert.equal(ctx.current().lastCheckInconclusive, true)
  assert.ok(ctx.current().lastCheckedAt > stored.accounts.synthetic.lastCheckedAt)
  await ctx.actions.loadFromStorage()
  wait.resolve(success())
  await pending
  assert.equal(ctx.current().lastError, undefined)
  assert.equal(ctx.current().status, 'active')
  assert.equal(ctx.current().credentials.expiresAt, updates[0].credentials.expiresAt)
})


test('reloads with newer confirmed health or different credentials still supersede inconclusive checks', async () => {
  for (const change of ['newer-health', 'different-credentials']) {
    const wait = deferred()
    let stored
    const ctx = fixture({ refreshAccountToken: () => wait.promise, loadAccounts: async () => stored,
      checkAccountStatus: async () => ({ success: false, preserveStatus: true, error: { message: 'Synthetic timeout' } }) })
    ctx.replace({ ...account(), status: 'error', lastError: 'Historical token expiry', lastCheckedAt: 1000 })
    const pending = ctx.cardRefresh()
    const { updates } = applyManagerTokenRotation({ accounts: { synthetic: ctx.current() } }, expected.expectedRefreshToken, { success: true, ...success().data })
    ctx.notify(updates[0])
    stored = JSON.parse(JSON.stringify({ accounts: { synthetic: ctx.current() } }))
    await ctx.actions.checkAccountStatus('synthetic')
    if (change === 'newer-health') stored.accounts.synthetic.lastCheckedAt = ctx.current().lastCheckedAt + 1
    else stored.accounts.synthetic.credentials.accessToken = 'SYNTHETIC_ACCESS_NEWER'
    await ctx.actions.loadFromStorage()
    const newer = ctx.current()
    wait.resolve(success())
    await pending
    assert.equal(ctx.current(), newer, change)
    assert.equal(ctx.current().lastError, 'Historical token expiry', change)
  }
})
