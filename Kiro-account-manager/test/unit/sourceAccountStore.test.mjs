import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { emptyOutcome, resolveExistingDuplicate, normalizeCredentialRecord, parseAccountImportText } from '../../src/shared/accountImport.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'
import { matchesAccountSearch, mergeSourceAccountNames } from '../../src/shared/accountSearch.ts'
import { normalizeAccountSubscription } from '../../src/shared/accountSubscription.ts'
import { executeCredentialImport } from '../../src/renderer/src/utils/accountImport.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
function find(predicate) {
  let found
  const visit = node => { if (predicate(node)) found = node; ts.forEachChild(node, visit) }
  visit(tree)
  assert.ok(found)
  return found
}
function property(name) {
  return find(node => ts.isPropertyAssignment(node) && node.name.getText(tree) === name).initializer.getText(tree)
}
const snapshotSource = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'accountStorageSnapshot').getText(tree)
const snapshot = new Function(`${stripTypeScriptTypes(snapshotSource)}; return accountStorageSnapshot`)()
const clone = value => JSON.parse(JSON.stringify(value))

function fixture(initial = []) {
  const state = {
    accounts: new Map(initial.map(account => [account.id, clone(account)])), groups: new Map(), tags: new Map(),
    proxyPool: new Map(), activeGroupTab: 'all', filter: {}, sort: { field: 'email', order: 'asc' }
  }
  let persisted
  let verifies = 0
  let saves = 0
  let failSave = false
  let verificationInput
  const get = () => ({ ...state, ...actions })
  const set = update => Object.assign(state, typeof update === 'function' ? update(state) : update)
  const window = { api: {
    verifyAccountCredentials: async input => {
      verifies++
      verificationInput = input
      return { success: true, data: { email: 'verified@example.invalid', userId: 'synthetic-user',
        accessToken: 'SYNTHETIC_ACCESS_NEW', refreshToken: 'SYNTHETIC_REFRESH_NEW', expiresIn: 120,
        subscriptionType: 'Pro', usage: { current: 1, limit: 10 } } }
    },
    getAppVersion: async () => 'synthetic-version',
    loadAccounts: async () => clone(persisted)
  } }
  const deps = {
    get, set, emptyOutcome, planBackupRestore, executeCredentialImport, matchesAccountSearch, mergeSourceAccountNames,
    resolveExistingDuplicate, normalizeCredentialRecord, normalizeAccountSubscription,
    window, consumedImportTokens: new Map(), lastSaveError: null,
    enqueueAccountImport: work => work(), uuidv4: () => 'generated-id', generateRandomMachineId: () => 'f'.repeat(64),
    DEFAULT_PROXY_POOL_CONFIG: {}, syncLocalSsoAccountAsync: async () => {},
    console: { log() {}, error(...errors) { throw errors.at(-1) } }
  }
  const compile = name => new Function(...Object.keys(deps), `let _filterCache; return (${stripTypeScriptTypes(property(name))});`)(...Object.values(deps))
  const persist = async () => {
    saves++
    if (failSave) throw new Error('synthetic persistence failure')
    persisted = clone(snapshot(state))
  }
  const actions = {
    flushSaveImmediately: persist,
    saveToStorage: persist,
    startAutoSave() {},
    applyTheme() {},
    addAccount: account => {
      const id = 'generated-id'
      set({ accounts: new Map(state.accounts).set(id, { id, machineId: 'f'.repeat(64), ...account }) })
      return id
    },
    updateAccount: (id, update) => {
      set({ accounts: new Map(state.accounts).set(id, { ...state.accounts.get(id), ...update }) })
      void persist()
    }
  }
  for (const name of ['importAccountPlan', 'getFilteredAccounts', 'loadFromStorage', 'importAccounts']) actions[name] = compile(name)
  return { state, actions, get verifies() { return verifies }, get saves() { return saves },
    get verificationInput() { return verificationInput }, get persisted() { return persisted },
    set failSave(value) { failSave = value } }
}
const originalCredential = extra => ({ provider: 'Github', email: 'synthetic-original-name', refreshToken: 'SYNTHETIC_REFRESH', ...extra })
const existingAccount = extra => ({ id: 'existing', email: 'verified@example.invalid', nickname: 'kept-nickname',
  idp: 'Github', machineId: 'f'.repeat(64), subscription: { type: 'Pro' }, credentials: { provider: 'Github', refreshToken: 'SYNTHETIC_REFRESH' }, ...extra })

test('real store imports source metadata, excludes it from verification, and searches it after saving and reloading', async () => {
  const ctx = fixture()
  const outcome = await ctx.actions.importAccountPlan(parseAccountImportText(JSON.stringify(originalCredential({ sourceAccountNames: ['prior-source'] }))))
  assert.equal(outcome.added, 1)
  assert.equal(ctx.verifies, 1)
  assert.equal(Object.hasOwn(ctx.verificationInput, 'sourceAccountNames'), false)
  assert.deepEqual(ctx.persisted.accounts['generated-id'].sourceAccountNames, ['prior-source', 'synthetic-original-name'])
  ctx.state.accounts = new Map()
  await ctx.actions.loadFromStorage()
  ctx.state.filter = { search: 'ORIGINAL-NAME' }
  const result = ctx.actions.getFilteredAccounts()
  assert.equal(result.length, 1)
  assert.equal(result[0].email, 'verified@example.invalid')
  assert.equal(result[0].nickname, 'verified')
})

test('real store invalidates cached search when a duplicate import supplies the original account name', async () => {
  const ctx = fixture([existingAccount()])
  ctx.state.filter = { search: 'synthetic-original' }
  assert.equal(ctx.actions.getFilteredAccounts().length, 0)
  const before = ctx.state.accounts
  const credentialBefore = ctx.state.accounts.get('existing').credentials
  const outcome = await ctx.actions.importAccountPlan(parseAccountImportText(JSON.stringify(originalCredential())))
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.verifies, 0)
  assert.notEqual(ctx.state.accounts, before)
  assert.equal(ctx.state.accounts.get('existing').credentials, credentialBefore)
  assert.equal(ctx.actions.getFilteredAccounts().length, 1)
  assert.deepEqual(ctx.persisted.accounts.existing.sourceAccountNames, ['synthetic-original-name'])
})

test('real store source-name search still obeys group filters', () => {
  const ctx = fixture([existingAccount({ sourceAccountNames: ['synthetic-original-name'], groupId: 'one' })])
  ctx.state.filter = { search: 'synthetic-original' }
  ctx.state.activeGroupTab = 'two'
  assert.equal(ctx.actions.getFilteredAccounts().length, 0)
  ctx.state.activeGroupTab = 'one'
  assert.equal(ctx.actions.getFilteredAccounts().length, 1)
})

test('real store duplicate backup updates persist and report failed metadata writes without changing credentials', async () => {
  const ctx = fixture([existingAccount()])
  const backup = { version: '1', accounts: [existingAccount({ sourceAccountNames: ['synthetic-backup-name'] })], groups: [], tags: [] }
  const plan = parseAccountImportText(JSON.stringify(backup))
  ctx.failSave = true
  const first = await ctx.actions.importAccountPlan(plan)
  assert.equal(first.failed, 1)
  assert.equal(first.duplicate, 0)
  ctx.failSave = false
  const retry = await ctx.actions.importAccountPlan(plan)
  assert.equal(retry.duplicate, 1)
  assert.equal(ctx.verifies, 0)
  assert.deepEqual(ctx.persisted.accounts.existing.sourceAccountNames, ['synthetic-backup-name'])
  assert.equal(ctx.state.accounts.get('existing').nickname, 'kept-nickname')
})

test('legacy store import retains source names on both added and matching existing accounts', () => {
  const ctx = fixture([existingAccount()])
  ctx.actions.importAccounts([originalCredential()])
  assert.deepEqual(ctx.state.accounts.get('existing').sourceAccountNames, ['synthetic-original-name'])
  assert.equal(ctx.verifies, 0)
  const fresh = fixture()
  assert.equal(fresh.actions.importAccounts([originalCredential()]).success, 1)
  assert.deepEqual(fresh.state.accounts.get('generated-id').sourceAccountNames, ['synthetic-original-name'])
  assert.equal(Object.hasOwn(fresh.state.accounts.get('generated-id').credentials, 'sourceAccountNames'), false)
})

test('legacy store source updates use the token owner before an earlier matching email', () => {
  const ctx = fixture([
    existingAccount({ id: 'email-match', email: 'synthetic-original-name', credentials: { provider: 'Github', refreshToken: 'SYNTHETIC_OTHER' } }),
    existingAccount({ id: 'token-match' })
  ])
  ctx.actions.importAccounts([originalCredential({ sourceAccountNames: ['token-owner-source'] })])
  assert.equal(ctx.state.accounts.size, 2)
  assert.equal(ctx.state.accounts.get('email-match').sourceAccountNames, undefined)
  assert.deepEqual(ctx.state.accounts.get('token-match').sourceAccountNames, ['token-owner-source', 'synthetic-original-name'])
  assert.equal(ctx.verifies, 0)
})

test('legacy store conflicts neither update source names nor add an account', () => {
  const ctx = fixture([
    existingAccount({ id: 'first', userId: 'first-user' }),
    existingAccount({ id: 'second', userId: 'second-user', credentials: { provider: 'Github', refreshToken: 'SYNTHETIC_OTHER' } })
  ])
  const outcome = ctx.actions.importAccounts([originalCredential({ userId: 'second-user' })])
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.success, 0)
  assert.equal(ctx.state.accounts.size, 2)
  assert.ok([...ctx.state.accounts.values()].every(account => !account.sourceAccountNames))
  assert.equal(ctx.verifies, 0)
})
