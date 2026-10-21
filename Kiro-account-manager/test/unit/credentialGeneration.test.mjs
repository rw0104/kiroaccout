import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
const names = ['refreshAccountToken', 'checkAccountStatus', 'applyBackgroundRefreshResults', 'applyBackgroundCheckResults', 'updateAccountStatus']
const properties = []
const helpers = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && names.includes(node.name?.getText(tree))) properties.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && ['credentialVersion', 'credentialResultDisposition'].includes(node.name?.text)) helpers.push(node.getText(tree).replace(/^export /, ''))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(properties.length, names.length)
const factory = ts.transpileModule(`${helpers.join('\n')}\nconst actions = {${properties.join(',\n')}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const account = (accessToken = 'SYNTHETIC_ACCESS_0', refreshToken = 'SYNTHETIC_REFRESH_0') => ({
  id: 'synthetic', email: 'synthetic@example.invalid', userId: 'synthetic-user', idp: 'BuilderId',
  credentials: { accessToken, refreshToken, expiresAt: 12345, clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1', authMethod: 'IdC', provider: 'BuilderId' },
  usage: { current: 1, limit: 10, percentUsed: 0.1, lastUpdated: 1 }, subscription: { type: 'Free' }, status: 'active', lastError: undefined
})
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(api = {}) {
  const state = { accounts: new Map([['synthetic', account()]]) }
  let saves = 0
  const hooks = []
  let actions
  const get = () => ({ ...state, ...actions, saveToStorage() { saves++ } })
  const set = value => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const context = vm.createContext({ get, set, window: { api }, console: { log() {}, warn() {}, error() {} }, Date,
    triggerWebhook: (...args) => hooks.push(args), isBannedAccountError: () => false })
  vm.runInContext(factory, context)
  actions = vm.runInContext('actions', context)
  return { state, actions, hooks, get saves() { return saves }, replace: value => state.accounts.set('synthetic', value), current: () => state.accounts.get('synthetic') }
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
