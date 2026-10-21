import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as ownership from '../../src/main/kiroInstanceOwnership.ts'

const { mergeInstanceOwnedAccounts, INSTANCE_ACCOUNT_REAUTH_REQUIRED } = ownership
// Falling back reproduces the pre-fix guard until the explicit-deletion helper exists.
const mergeDeletion = (...args) => (ownership.mergeInstanceOwnedAccountsForDeletion ?? mergeInstanceOwnedAccounts)(...args)

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
const actionNames = ['removeAccount', 'removeAccounts', 'flushSaveImmediately', 'saveAccountChanges']
const helperNames = ['enqueueAccountPersistence', 'accountStorageSnapshot', 'accountStateWithout', 'accountDeletionError']
const actions = [], helpers = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && actionNames.includes(node.name?.getText(tree))) actions.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)) helpers.push(node.getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(actions.length, actionNames.length)
const script = ts.transpileModule(`
let saveDebounceTimer = null, saveMaxWaitTimer = null, saveInFlight = null, lastSaveError = null;
let savePendingResolvers = [], accountPersistenceQueue = Promise.resolve();
${helpers.join('\n')}
const actions = {${actions.join(',\n')}};
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const preloadTree = ts.createSourceFile('preload.ts', preloadSource, ts.ScriptTarget.Latest, true)
let saveAccountsProperty
function visitPreload(node) {
  if (ts.isPropertyAssignment(node) && node.name?.getText(preloadTree) === 'saveAccounts') saveAccountsProperty = node.getText(preloadTree)
  ts.forEachChild(node, visitPreload)
}
visitPreload(preloadTree)
assert.ok(saveAccountsProperty)
const preloadScript = ts.transpileModule(`const api = { ${saveAccountsProperty} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
function preloadSaveAccounts(invoke) {
  const context = vm.createContext({ ipcRenderer: { invoke } })
  vm.runInContext(preloadScript, context)
  return vm.runInContext('api.saveAccounts', context)
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(saveAccounts) {
  const first = { id: 'first', credentials: { refreshToken: 'SYNTHETIC_FIRST' } }
  const second = { id: 'second', credentials: { refreshToken: 'SYNTHETIC_SECOND' } }
  const state = { accounts: new Map([['first', first], ['second', second]]), selectedIds: new Set(['first', 'second']),
    activeAccountId: 'first', accountProxyBindings: { first: 'proxy-one', second: 'proxy-two' },
    groups: new Map(), tags: new Map(), proxyPool: new Map() }
  let actions
  const get = () => ({ ...state, ...actions, saveToStorage: () => actions.flushSaveImmediately() })
  const set = value => Object.assign(state, typeof value === 'function' ? value(state) : value)
  const context = vm.createContext({ get, set, window: { api: { saveAccounts } }, console: { error() {} }, clearTimeout, Error })
  vm.runInContext(script, context)
  actions = vm.runInContext('actions', context)
  return { state, actions, first, second }
}

test('single deletion retains the account, active selection and proxy binding until persistence succeeds', async () => {
  const wait = deferred(), writes = []
  const ctx = fixture(data => { writes.push(data); return wait.promise })
  const deletion = ctx.actions.removeAccount('first')
  await tick()
  assert.equal(ctx.state.accounts.get('first'), ctx.first)
  assert.equal(ctx.state.activeAccountId, 'first')
  assert.equal(ctx.state.selectedIds.has('first'), true)
  assert.equal(ctx.state.accountProxyBindings.first, 'proxy-one')
  assert.equal(writes[0].accounts.first, undefined)
  wait.resolve()
  await deletion
  assert.equal(ctx.state.accounts.has('first'), false)
  assert.equal(ctx.state.activeAccountId, null)
  assert.equal(ctx.state.selectedIds.has('first'), false)
  assert.equal(ctx.state.accountProxyBindings.first, undefined)
})

test('rejected bound-account deletion rejects visibly and leaves renderer and persisted identity intact', async () => {
  const ctx = fixture(async () => { throw new Error('该账户已由独立 Kiro 实例管理，请先停止实例并同步凭证、移除绑定后再执行刷新或切号。') })
  await assert.rejects(ctx.actions.removeAccount('first'), /多开|实例/)
  assert.equal(ctx.state.accounts.get('first'), ctx.first)
  assert.equal(ctx.state.activeAccountId, 'first')
  assert.equal(ctx.state.selectedIds.has('first'), true)
  assert.equal(ctx.state.accountProxyBindings.first, 'proxy-one')
})

test('explicit deletion still rejects active and legacy instance bindings without removing the visible account', async () => {
  for (const accountBindingState of ['active', undefined]) {
    const records = [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first', accountBindingState }]
    let persisted
    const ctx = fixture(preloadSaveAccounts(async (channel, data, updateRequestId, deleteAccountIds) => {
      assert.equal(channel, 'save-accounts')
      assert.equal(updateRequestId, undefined)
      // IPC serializes renderer objects into the main process realm.
      persisted = mergeDeletion(structuredClone(data), persisted, records, structuredClone(deleteAccountIds))
    }))
    ctx.first.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
    persisted = structuredClone({ accounts: Object.fromEntries(ctx.state.accounts) })
    const result = await ctx.actions.removeAccounts(['first'])
    assert.equal(result.success, 0)
    assert.equal(result.failed, 1)
    assert.equal(ctx.state.accounts.get('first'), ctx.first)
    assert.equal(persisted.accounts.first.credentials.refreshToken, 'SYNTHETIC_FIRST')
  }
})

test('explicit deletion crosses the real renderer and preload IPC and removes an unbound recovery account only after persistence succeeds', async () => {
  const wait = deferred(), calls = []
  let persisted
  const ctx = fixture(preloadSaveAccounts(async (channel, data, updateRequestId, deleteAccountIds) => {
    calls.push({ channel, data: structuredClone(data), updateRequestId, deleteAccountIds: structuredClone(deleteAccountIds) })
    const next = mergeDeletion(structuredClone(data), persisted, [], structuredClone(deleteAccountIds))
    await wait.promise
    persisted = next
  }))
  ctx.first.status = 'error'
  ctx.first.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
  ctx.second.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
  persisted = structuredClone({ accounts: Object.fromEntries(ctx.state.accounts) })
  const deletion = ctx.actions.removeAccounts(['first', 'first'])
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].channel, 'save-accounts')
  assert.equal(calls[0].updateRequestId, undefined)
  assert.deepEqual(calls[0].deleteAccountIds, ['first'])
  assert.equal(calls[0].data.accounts.first, undefined)
  assert.equal(ctx.state.accounts.get('first'), ctx.first)
  assert.equal(persisted.accounts.first.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
  wait.resolve()
  const result = await deletion
  assert.equal(result.success, 1)
  assert.equal(result.failed, 0)
  assert.equal(ctx.state.accounts.has('first'), false)
  assert.equal(persisted.accounts.first, undefined)
  assert.equal(persisted.accounts.second.credentials.refreshToken, 'SYNTHETIC_SECOND')
  assert.equal(persisted.accounts.second.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
})

test('a stale renderer cannot attach another recovery account deletion to the selected deletion intent', async () => {
  let persisted
  const ctx = fixture(preloadSaveAccounts(async (_channel, data, _updateRequestId, deleteAccountIds) => {
    persisted = mergeDeletion(structuredClone(data), persisted, [], structuredClone(deleteAccountIds))
  }))
  ctx.first.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
  ctx.second.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
  persisted = structuredClone({ accounts: Object.fromEntries(ctx.state.accounts) })
  // An old window has already lost the other protected row from its snapshot.
  ctx.state.accounts.delete('second')
  const result = await ctx.actions.removeAccounts(['first'])
  assert.equal(result.success, 0)
  assert.equal(result.failed, 1)
  assert.equal(ctx.state.accounts.get('first'), ctx.first)
  assert.equal(persisted.accounts.first.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
  assert.equal(persisted.accounts.second.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
  assert.match(result.errors[0].error, /恢复记录.*重新加载/)
  assert.doesNotMatch(result.errors[0].error, /先完成重新授权/)
})

test('a real save failure after the recovery deletion guard succeeds retains the row and reports failure', async () => {
  let persisted, guardSucceeded = false
  const ctx = fixture(preloadSaveAccounts(async (_channel, data, _updateRequestId, deleteAccountIds) => {
    mergeDeletion(structuredClone(data), persisted, [], structuredClone(deleteAccountIds))
    guardSucceeded = true
    throw new Error('synthetic disk write failure')
  }))
  ctx.first.lastError = INSTANCE_ACCOUNT_REAUTH_REQUIRED
  persisted = structuredClone({ accounts: Object.fromEntries(ctx.state.accounts) })
  const result = await ctx.actions.removeAccounts(['first'])
  assert.equal(guardSucceeded, true)
  assert.equal(result.success, 0)
  assert.equal(result.failed, 1)
  assert.equal(ctx.state.accounts.get('first'), ctx.first)
  assert.equal(persisted.accounts.first.lastError, INSTANCE_ACCOUNT_REAUTH_REQUIRED)
})

test('ordinary and update saves send no deletion intent through preload', async () => {
  const calls = []
  const ctx = fixture(preloadSaveAccounts(async (...args) => { calls.push(structuredClone(args)) }))
  await ctx.actions.flushSaveImmediately()
  await ctx.actions.saveAccountChanges('synthetic-update-request')
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'save-accounts')
  assert.equal(calls[0][2], undefined)
  assert.equal(calls[0][3], undefined)
  assert.equal(calls[1][2], 'synthetic-update-request')
  assert.equal(calls[1][3], undefined)
})

test('batch persistence failure reports zero deletions and preserves every selected account', async () => {
  const ctx = fixture(async () => { throw new Error('synthetic save failure') })
  const result = await ctx.actions.removeAccounts(['first', 'second'])
  assert.equal(result.success, 0)
  assert.equal(result.failed, 2)
  assert.equal(result.errors.length, 2)
  assert.equal(ctx.state.accounts.size, 2)
  assert.equal(ctx.state.selectedIds.size, 2)
})

test('deletion and a background save serialize fresh snapshots and cannot resurrect a deleted account', async () => {
  const waits = [], writes = []
  const ctx = fixture(data => { const wait = deferred(); waits.push(wait); writes.push(data); return wait.promise })
  const previous = ctx.actions.flushSaveImmediately()
  await tick()
  const deletion = ctx.actions.removeAccount('first')
  const background = ctx.actions.flushSaveImmediately()
  assert.equal(writes.length, 1)
  waits[0].resolve()
  await previous
  await tick()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].accounts.first, undefined)
  ctx.state.accounts = new Map([...ctx.state.accounts, ['third', { id: 'third' }]])
  waits[1].resolve()
  await deletion
  await tick()
  assert.equal(writes.length, 3)
  assert.equal(writes[2].accounts.first, undefined)
  assert.equal(writes[2].accounts.third.id, 'third')
  assert.equal(ctx.state.accounts.has('third'), true)
  waits[2].resolve()
  await background
})

test('a failed deletion does not poison the write queue or prevent a later valid deletion', async () => {
  let failed = true
  const ctx = fixture(async () => { if (failed) throw new Error('synthetic failure') })
  const first = await ctx.actions.removeAccounts(['first'])
  assert.equal(first.success, 0)
  failed = false
  const next = await ctx.actions.removeAccounts(['first', 'first', 'missing'])
  assert.equal(next.success, 1)
  assert.equal(next.failed, 1)
  assert.equal(ctx.state.accounts.has('first'), false)
})
