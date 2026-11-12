import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

function persistence(saveAccounts) {
  const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  flushSaveImmediately: async (')
  const end = source.indexOf('  // ==================== 设置', start)
  assert.ok(start >= 0 && end > start)
  const snippet = stripTypeScriptTypes(`({${source.slice(start, end)}})`, { mode: 'strip' })
  const tree = ts.createSourceFile('accounts.ts', source, ts.ScriptTarget.Latest, true)
  const helperNames = ['enqueueAccountPersistence', 'accountStorageSnapshot']
  const helpers = tree.statements.filter(node => ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text))
    .map(node => stripTypeScriptTypes(node.getText(tree), { mode: 'strip' })).join('\n')
  const state = { accounts: new Map([['a', { id: 'a' }]]), groups: new Map(), tags: new Map(), proxyPool: new Map() }
  const get = () => ({ ...state, flushSaveImmediately: action.flushSaveImmediately })
  const set = next => Object.assign(state, next)
  const action = new Function('get', 'set', 'window', 'console', `
    let saveDebounceTimer = null, saveMaxWaitTimer = null, saveInFlight = null, lastSaveError = null;
    let savePendingResolvers = [];
    let saveQueuedFlushes = new Map();
    let accountPersistenceQueue = Promise.resolve();
    ${helpers}
    const action = ${snippet};
    return { ...action, lastError: () => lastSaveError };
  `)(get, set, { api: { saveAccounts } }, { error() {} })
  return { action, state }
}

test('a flush during an in-flight save waits for a fresh snapshot before acknowledging', async () => {
  const snapshots = []
  const releases = []
  const { action, state } = persistence(data => {
    snapshots.push(data)
    return new Promise(resolve => releases.push(resolve))
  })
  const first = action.flushSaveImmediately()
  await Promise.resolve()
  state.accounts = new Map([...state.accounts, ['b', { id: 'b' }]])
  let acknowledged = false
  const second = action.flushSaveImmediately().then(() => { acknowledged = true })
  assert.equal(snapshots.length, 1)
  assert.equal(acknowledged, false)
  releases[0]()
  await first
  await Promise.resolve()
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[1].accounts.b.id, 'b')
  assert.equal(acknowledged, false)
  releases[1]()
  await second
  assert.equal(acknowledged, true)
})

test('a synchronous save exception is recorded and the next save can recover', async () => {
  let attempts = 0
  const { action } = persistence(() => {
    attempts++
    if (attempts === 1) throw new Error('synthetic failure')
    return Promise.resolve()
  })
  await action.flushSaveImmediately()
  assert.ok(action.lastError())
  await action.flushSaveImmediately()
  assert.equal(attempts, 2)
  assert.equal(action.lastError(), null)
})

test('update-save request identity reaches the fresh snapshot after an in-flight ordinary save', async () => {
  const requests = [], releases = []
  const { action } = persistence((_data, requestId) => {
    requests.push(requestId)
    return new Promise(resolve => releases.push(resolve))
  })
  const first = action.flushSaveImmediately()
  await Promise.resolve()
  const update = action.flushSaveImmediately('synthetic-update-request')
  assert.equal(requests[0], undefined)
  releases[0]()
  await first
  await Promise.resolve()
  assert.equal(requests[1], 'synthetic-update-request')
  releases[1]()
  await update
})

test('a burst of concurrent flushes shares one fresh snapshot instead of serializing every caller', async () => {
  const snapshots = [], releases = []
  const { action, state } = persistence(data => {
    snapshots.push(data)
    return new Promise(resolve => releases.push(resolve))
  })
  const first = action.flushSaveImmediately()
  await Promise.resolve()
  state.accounts = new Map([...state.accounts, ['b', { id: 'b' }]])
  const concurrent = Array.from({ length: 100 }, () => action.flushSaveImmediately())
  releases.shift()()
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[1].accounts.b.id, 'b')
  let acknowledged = 0
  for (const promise of concurrent) promise.then(() => { acknowledged++ })
  releases.shift()()
  // Drain any incorrect extra saves so the regression reports a count failure.
  for (let i = 0; i < 105; i++) {
    await new Promise(resolve => setImmediate(resolve))
    while (releases.length) releases.shift()()
  }
  await Promise.all(concurrent)
  assert.equal(acknowledged, 100)
  assert.equal(snapshots.length, 2, 'one fresh snapshot satisfies all waiters for the same generation')
})

test('a mutation during the shared follow-up write still gets its own fresh snapshot', async () => {
  const snapshots = [], releases = []
  const { action, state } = persistence(data => {
    snapshots.push(data)
    return new Promise(resolve => releases.push(resolve))
  })
  const first = action.flushSaveImmediately()
  await Promise.resolve()
  const second = action.flushSaveImmediately()
  releases.shift()()
  await first
  await new Promise(resolve => setImmediate(resolve))
  state.accounts = new Map([...state.accounts, ['late', { id: 'late' }]])
  const third = action.flushSaveImmediately()
  releases.shift()()
  await second
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(snapshots.length, 3)
  assert.equal(snapshots[2].accounts.late.id, 'late')
  releases.shift()()
  await third
})
