import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as ownership from '../../src/main/kiroInstanceOwnership.ts'
import { AppUpdateController } from '../../src/main/appUpdater.ts'
import { acknowledgeUpdateSave } from '../../src/renderer/src/lib/updateClient.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let saveHandler
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'ipcMain.handle' && node.arguments[0]?.text === 'save-accounts') {
    saveHandler = node.arguments[1].getText(tree)
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(saveHandler)
const compiled = ts.transpileModule(`
  const { initStore, store, createBackup, mergeInstanceOwnedAccounts, mergeInstanceOwnedAccountsForUpdate, console } = deps;
  let updateInstallSave = deps.pending, lastSavedData = null;
  return { save: ${saveHandler}, lastSaved: () => lastSavedData };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const instantiate = vm.compileFunction(compiled, ['deps'])
const account = id => ({ id, idp: 'Github', status: 'active', userId: `SYNTHETIC_USER_${id}`,
  credentials: { accessToken: `SYNTHETIC_ACCESS_${id}`, refreshToken: `SYNTHETIC_REFRESH_${id}`, expiresAt: 1800000000000 } })
function fixture(options = {}) {
  const bound = account('bound')
  const recovery = { ...account('recovery'), status: 'error', lastError: ownership.INSTANCE_ACCOUNT_REAUTH_REQUIRED }
  const current = { accounts: { bound, recovery, removed: account('removed') }, groups: {}, tags: {} }
  const records = [{ schemaVersion: 2, id: 'synthetic-instance', accountId: 'bound', accountBindingState: 'active' }]
  let stored = current, writes = 0
  const pending = options.pending === false ? null : { requestId: 'synthetic-update', senderId: 17 }
  const host = instantiate({
    initStore: async () => {}, pending, ...ownership,
    store: { get: key => key === 'kiroInstances' ? records : stored, set: (_key, value) => {
      if (options.diskFailure) throw new Error('SYNTHETIC_PRIVATE_DISK_PATH')
      writes++; stored = value
    } },
    createBackup: async () => {}, console: { error() {} }
  })
  const incoming = { accounts: { added: account('added') }, groups: { synthetic: { id: 'synthetic' } }, tags: {} }
  return { ...host, current, incoming, records, get stored() { return stored }, get writes() { return writes },
    saveSnapshot: (data = incoming, senderId = 17, requestId = 'synthetic-update') => host.save({ sender: { id: senderId } }, data, requestId) }
}

test('the real update save preserves protected accounts omitted by a stale window and persists other edits', async () => {
  const h = fixture(), before = structuredClone(h.current), proposed = structuredClone(h.incoming)
  await h.saveSnapshot()
  assert.deepEqual(h.stored.accounts.bound, before.accounts.bound)
  assert.deepEqual(h.stored.accounts.recovery, before.accounts.recovery)
  assert.deepEqual(h.stored.accounts.added, proposed.accounts.added)
  assert.equal(h.stored.accounts.removed, undefined, 'an ordinary unbound deletion remains a deletion')
  assert.deepEqual(h.stored.groups, proposed.groups)
  assert.deepEqual(h.current, before)
  assert.deepEqual(h.incoming, proposed)
  assert.equal(h.lastSaved(), h.stored)
})

test('update preservation cannot be used by normal saves or an unrelated renderer', async () => {
  for (const options of [{ pending: false }, {}]) {
    const h = fixture(options)
    await assert.rejects(h.saveSnapshot(h.incoming, options.pending === false ? 17 : 99), error => error.code === 'instance-owned')
    assert.equal(h.writes, 0)
    assert.equal(h.stored, h.current)
  }
  for (const requestId of [null, '', 'stale-request']) {
    const h = fixture()
    await assert.rejects(h.saveSnapshot(h.incoming, 17, requestId), error => error.code === 'instance-owned')
    assert.equal(h.writes, 0)
  }
})

test('update saving never replaces a protected identity or its authoritative credential generation', async () => {
  const h = fixture()
  h.incoming.accounts.bound = { ...account('bound'), idp: 'Google', credentials: account('foreign').credentials }
  await h.saveSnapshot()
  assert.deepEqual(h.stored.accounts.bound, h.current.accounts.bound)
  assert.equal(h.stored.accounts.recovery.lastError, ownership.INSTANCE_ACCOUNT_REAUTH_REQUIRED)
})

test('preserving protected accounts does not grant ownership to a pending selection', async () => {
  const h = fixture()
  h.records[0].accountBindingState = 'pending'
  await h.saveSnapshot()
  assert.equal(h.stored.accounts.bound, undefined)
  assert.deepEqual(h.stored.accounts.recovery, h.current.accounts.recovery)
})

async function readyController(h) {
  let installs = 0
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false, channel: 'latest',
    checkForUpdates: async () => ({ updateInfo: { version: '1.8.3' } }),
    downloadUpdate: async () => { engine.emit('update-downloaded', { version: '1.8.3' }); return [] },
    quitAndInstall: () => { installs++ }
  })
  const controller = new AppUpdateController({ updater: engine, enabled: true, currentVersion: '1.8.2',
    notify() {}, beforeInstall() {}, prepareInstall: () => new Promise((resolve, reject) => {
      void acknowledgeUpdateSave('synthetic-update', () => h.saveSnapshot(), (_id, success) => success ? resolve() : reject(new Error('save rejected')))
    }) })
  await controller.check(); await controller.download()
  return { controller, installs: () => installs }
}

test('actual save IPC and renderer ACK let a verified update proceed without deleting bound accounts', async () => {
  const h = fixture(), { controller, installs } = await readyController(h)
  try {
    assert.equal((await controller.install()).success, true)
    assert.equal(installs(), 1)
    assert.equal(h.writes, 1)
    assert.deepEqual(h.stored.accounts.bound, h.current.accounts.bound)
  } finally { controller.dispose() }
})

test('a genuine disk write failure still blocks installation and leaves the prior account data intact', async () => {
  const h = fixture({ diskFailure: true }), { controller, installs } = await readyController(h)
  try {
    assert.equal((await controller.install()).success, false)
    assert.equal(installs(), 0)
    assert.equal(h.stored, h.current)
    assert.equal(h.writes, 0)
    assert.doesNotMatch(JSON.stringify(controller.getState()), /SYNTHETIC_PRIVATE/)
  } finally { controller.dispose() }
})
