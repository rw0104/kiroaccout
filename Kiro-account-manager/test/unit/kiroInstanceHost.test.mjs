import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { InstanceAccountOwnership, InstanceOwnershipError } from '../../src/main/kiroInstanceOwnership.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let configWriter, guardedHandler
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createWindowsKiroInstanceService') {
    const dependencies = node.arguments[0]
    assert.ok(ts.isObjectLiteralExpression(dependencies))
    const property = dependencies.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'writeConfig')
    assert.ok(property && ts.isArrowFunction(property.initializer))
    configWriter = property.initializer.getText(tree)
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'registerUnboundAccountHandler') guardedHandler = node.getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(configWriter && guardedHandler, 'test must exercise the actual main-process hooks')
const compiled = ts.transpileModule(`
  const { initStore, store, proxyServer, instanceAccountOwnership, suspendedInstancePoolAccounts, ipcMain, InstanceOwnershipError } = deps;
  ${guardedHandler}
  const writeConfig = ${configWriter};
  return { writeConfig, registerUnboundAccountHandler };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
// compileFunction keeps data in the same realm as the real ownership guard's
// plain-object checks. All storage, pool and IPC boundaries are injected.
const instantiate = vm.compileFunction(compiled, ['deps'], { filename: 'synthetic-kiro-instance-host.js' })
const account = (id = 'synthetic-one') => ({
  id, status: 'active', nickname: `Synthetic ${id}`,
  credentials: { accessToken: `SYNTHETIC_ACCESS_${id}`, refreshToken: `SYNTHETIC_REFRESH_${id}`, expiresAt: 1_800_003_600_000 }
})
const binding = (state = 'pending') => ({ schemaVersion: 2, id: 'synthetic-instance', accountId: 'synthetic-one', accountBindingState: state })
function fixture({ pooled = true } = {}) {
  const original = account(), other = account('synthetic-other')
  const state = { kiroInstances: [], accountData: { accounts: { [original.id]: original, [other.id]: other } } }
  const pool = new Map([[other.id, { id: other.id, ...other.credentials, proxyUrl: 'http://127.0.0.1:8081' }]])
  if (pooled) pool.set(original.id, { id: original.id, ...original.credentials, proxyUrl: 'http://127.0.0.1:8082' })
  const poolEvents = [], storageWrites = [], handlers = new Map(), suspended = new Map()
  const guard = new InstanceAccountOwnership({ records: () => state.kiroInstances, accounts: () => state.accountData.accounts })
  const hooks = instantiate({
    initStore: async () => {},
    store: { get: key => state[key], set: (key, value) => { storageWrites.push(key); state[key] = value } },
    proxyServer: { getAccountPool: () => ({
      getAllAccounts: () => [...pool.values()], getAccount: id => pool.get(id),
      removeAccount: id => { poolEvents.push(['remove', id]); pool.delete(id) },
      addAccount: value => { poolEvents.push(['add', value.id]); pool.set(value.id, value) }
    }) },
    instanceAccountOwnership: guard, suspendedInstancePoolAccounts: suspended,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, InstanceOwnershipError
  })
  return { ...hooks, state, pool, poolEvents, storageWrites, guard, handlers, suspended, original }
}

test('main config hook leaves a newly selected pending account usable and in its existing proxy pool', async () => {
  const h = fixture(), before = structuredClone(h.state.accountData)
  await h.writeConfig([binding()])
  h.guard.assertAvailable({ accountId: h.original.id, ...h.original.credentials })
  assert.ok(h.pool.has(h.original.id))
  assert.deepEqual(h.poolEvents, [])
  assert.deepEqual(h.state.accountData, before)
  assert.deepEqual(h.storageWrites, ['kiroInstances'])
})

test('main config hook reserves the account only on activation and removes only that pool entry', async () => {
  const h = fixture(), before = structuredClone(h.state.accountData)
  await h.writeConfig([binding()])
  await h.writeConfig([binding('active')])
  assert.throws(() => h.guard.assertAvailable({ accountId: h.original.id }), error => error.code === 'instance-owned')
  assert.equal(h.pool.has(h.original.id), false)
  assert.ok(h.pool.has('synthetic-other'))
  assert.deepEqual(h.poolEvents, [['remove', h.original.id]])
  assert.deepEqual(h.state.accountData, before)
})

test('a prelaunch rollback restores the previously pooled account without altering account data', async () => {
  const h = fixture(), originalPoolEntry = structuredClone(h.pool.get(h.original.id)), before = structuredClone(h.state.accountData)
  await h.writeConfig([binding()])
  await h.writeConfig([binding('active')])
  await h.writeConfig([binding()])
  h.guard.assertAvailable({ accountId: h.original.id, ...h.original.credentials })
  assert.deepEqual(h.pool.get(h.original.id), originalPoolEntry)
  assert.deepEqual(h.poolEvents, [['remove', h.original.id], ['add', h.original.id]])
  assert.deepEqual(h.state.accountData, before)
  assert.equal(h.suspended.size, 0)
})

test('rollback never adds an account that was absent from the proxy pool', async () => {
  const h = fixture({ pooled: false })
  await h.writeConfig([binding()])
  await h.writeConfig([binding('active')])
  await h.writeConfig([binding()])
  assert.equal(h.pool.has(h.original.id), false)
  assert.deepEqual(h.poolEvents, [])
})

test('rollback does not restore a suspended pool snapshot after credentials or account eligibility changed', async () => {
  for (const change of [
    current => ({ ...current, status: 'error' }),
    current => ({ ...current, credentials: { ...current.credentials, accessToken: 'SYNTHETIC_NEW_ACCESS' } }),
    current => ({ ...current, credentials: { ...current.credentials, refreshToken: 'SYNTHETIC_NEW_REFRESH' } })
  ]) {
    const h = fixture()
    await h.writeConfig([binding('active')])
    h.state.accountData.accounts[h.original.id] = change(h.original)
    await h.writeConfig([binding()])
    assert.equal(h.pool.has(h.original.id), false)
    assert.equal(h.suspended.size, 0)
  }
})

test('removing active ownership clears suspended snapshots instead of automatically rejoining the pool', async () => {
  const h = fixture()
  await h.writeConfig([binding('active')])
  await h.writeConfig([])
  assert.equal(h.suspended.size, 0)
  assert.equal(h.pool.has(h.original.id), false)
  await h.writeConfig([binding()])
  assert.equal(h.pool.has(h.original.id), false)
})

test('main activation rejects an in-flight manager refresh before any config or pool mutation', async () => {
  const h = fixture()
  await h.writeConfig([binding()])
  const release = h.guard.beginOperation({ accountId: h.original.id, ...h.original.credentials })
  await assert.rejects(h.writeConfig([binding('active')]), error => error.code === 'account-operation-in-flight')
  assert.equal(h.state.kiroInstances[0].accountBindingState, 'pending')
  assert.deepEqual(h.poolEvents, [])
  assert.deepEqual(h.storageWrites, ['kiroInstances'])
  release()
  await h.writeConfig([binding('active')])
  assert.equal(h.state.kiroInstances[0].accountBindingState, 'active')
})

test('ownership rejection through the actual IPC wrapper has a stable code and never invokes the request handler', async () => {
  for (const channel of ['refresh-account-token', 'check-account-status']) {
    const h = fixture()
    await h.writeConfig([binding('active')])
    let requests = 0
    h.registerUnboundAccountHandler(channel, async () => { requests++; return { success: true } })
    const result = await h.handlers.get(channel)({}, { accountId: h.original.id, ...h.original.credentials })
    assert.equal(result.success, false)
    assert.equal(result.code, 'instance-owned')
    assert.equal(result.error.code, 'instance-owned')
    assert.equal(requests, 0)
    assert.doesNotMatch(result.error.message, /SYNTHETIC|synthetic-one/)
  }
})

test('the actual IPC wrapper preserves a local in-flight code without entering the network step', async () => {
  const h = fixture()
  await h.writeConfig([binding()])
  let requests = 0
  h.registerUnboundAccountHandler('refresh-account-token', async () => {
    // The wrapper holds this manager operation while a conflicting local
    // ownership transition is attempted. No request may follow the rejection.
    h.guard.assertCanBind(h.original.id, 'synthetic-instance')
    requests++
    return { success: true }
  })
  const result = await h.handlers.get('refresh-account-token')({}, { accountId: h.original.id, ...h.original.credentials })
  assert.equal(result.code, 'account-operation-in-flight')
  assert.equal(result.error.code, 'account-operation-in-flight')
  assert.equal(requests, 0)
  h.guard.assertCanBind(h.original.id, 'synthetic-instance')
})
