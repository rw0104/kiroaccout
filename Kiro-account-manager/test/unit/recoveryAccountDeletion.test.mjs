import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as ownership from '../../src/main/kiroInstanceOwnership.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let saveHandler
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' && node.arguments[0]?.text === 'save-accounts') saveHandler = node.arguments[1].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(saveHandler)
const compiled = ts.transpileModule(`
  const { store, initStore, createBackup, proxyServer, suspendedInstancePoolAccounts, mergeInstanceOwnedAccounts, mergeInstanceOwnedAccountsForUpdate, mergeInstanceOwnedAccountsForDeletion, InstanceOwnershipError, console } = deps;
  let updateInstallSave = deps.pending, lastSavedData = null;
  return { save: ${saveHandler}, lastSaved: () => lastSavedData };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const instantiate = vm.compileFunction(compiled, ['deps'])
const account = id => ({ id, status: 'error', lastError: ownership.INSTANCE_ACCOUNT_REAUTH_REQUIRED,
  credentials: { accessToken: `SYNTHETIC_ACCESS_${id}`, refreshToken: `SYNTHETIC_REFRESH_${id}` } })
function fixture({ records = [], diskFailure = false, pending = null } = {}) {
  const current = { accounts: { first: account('first'), second: account('second'), normal: { ...account('normal'), status: 'active', lastError: undefined } } }
  let stored = current, writes = 0
  const removed = []
  const suspended = new Map([['first', { id: 'first' }]])
  const h = instantiate({ ...ownership, pending, initStore: async () => {}, createBackup: async () => {},
    store: { get: key => key === 'kiroInstances' ? records : stored, set: (_key, data) => {
      if (diskFailure) throw new Error('SYNTHETIC_DISK_FAILURE')
      writes++; stored = data
    } },
    proxyServer: { getAccountPool: () => ({ removeAccount: id => removed.push(id) }) }, suspendedInstancePoolAccounts: suspended, console: { error() {} }
  })
  const without = (...ids) => ({ accounts: Object.fromEntries(Object.entries(current.accounts).filter(([id]) => !ids.includes(id))) })
  return { ...h, current, without, records, removed, suspended, get writes() { return writes }, get stored() { return stored },
    save: (data, ids, requestId) => h.save({ sender: { id: 17 } }, data, requestId, ids) }
}

test('explicitly deleting an unbound recovery account succeeds without reauthorization and releases its local credential guard', async () => {
  const h = fixture(), original = structuredClone(h.current)
  await h.save(h.without('first'), ['first'])
  assert.equal(h.stored.accounts.first, undefined)
  assert.deepEqual(h.stored.accounts.second, original.accounts.second)
  assert.equal(h.writes, 1)
  assert.equal(h.lastSaved(), h.stored)
  assert.deepEqual(h.removed, ['first'])
  assert.equal(h.suspended.has('first'), false)
  assert.deepEqual(h.current, original)
  const guard = new ownership.InstanceAccountOwnership({ records: () => h.records, accounts: () => h.stored.accounts })
  guard.assertAvailable({ accountId: 'first', ...original.accounts.first.credentials })
  assert.throws(() => guard.assertAvailable({ accountId: 'second' }), error => error.code === 'reauthorization-required')
})

test('ordinary saves and deletion of another account cannot erase an unbound recovery record', async () => {
  for (const deletionIds of [undefined, ['normal']]) {
    const h = fixture()
    await assert.rejects(h.save(h.without('first', 'normal'), deletionIds), error => error.code === 'reauthorization-required')
    assert.equal(h.stored, h.current)
    assert.equal(h.writes, 0)
    assert.deepEqual(h.removed, [])
  }
})

test('explicit deletion cannot remove a still-owned account or bypass malformed instance configuration', async () => {
  for (const records of [
    [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first' }],
    [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first', accountBindingState: 'active' }],
    'SYNTHETIC_CORRUPT_CONFIG'
  ]) {
    const h = fixture({ records })
    await assert.rejects(h.save(h.without('first'), ['first']))
    assert.equal(h.stored, h.current)
    assert.deepEqual(h.removed, [])
  }
})

test('a pending selection does not prevent explicitly deleting an unbound recovery account', async () => {
  const h = fixture({ records: [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'first', accountBindingState: 'pending' }] })
  await h.save(h.without('first'), ['first'])
  assert.equal(h.stored.accounts.first, undefined)
  assert.equal(h.records[0].accountBindingState, 'pending', 'deletion does not rewrite or remove profile files or configuration')
})

test('invalid deletion intents and combined update/deletion requests fail before storage or pool mutation', async () => {
  for (const ids of [null, 'first', [], [null], [''], ['invalid/id'], ['first', 'first']]) {
    const h = fixture()
    await assert.rejects(h.save(h.without('first'), ids))
    assert.equal(h.writes, 0)
    assert.deepEqual(h.removed, [])
  }
  const h = fixture({ pending: { senderId: 17, requestId: 'synthetic-update' } })
  await assert.rejects(h.save(h.without('first'), ['first'], 'synthetic-update'))
  assert.equal(h.writes, 0)
  await assert.rejects(h.save(h.without('normal'), ['first']), 'a deletion intent must name accounts absent from the proposed snapshot')
})

test('batch deletion stays atomic when one target is bound, and actual disk failure leaves accounts and pool unchanged', async () => {
  const bound = fixture({ records: [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'second' }] })
  await assert.rejects(bound.save(bound.without('first', 'second'), ['first', 'second']))
  assert.equal(bound.writes, 0)
  assert.equal(bound.stored, bound.current)
  const disk = fixture({ diskFailure: true })
  await assert.rejects(disk.save(disk.without('first'), ['first']), /SYNTHETIC_DISK_FAILURE/)
  assert.equal(disk.writes, 0)
  assert.equal(disk.stored, disk.current)
  assert.deepEqual(disk.removed, [])
})
