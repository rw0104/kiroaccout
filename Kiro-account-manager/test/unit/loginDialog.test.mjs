import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Execute the real dialog's handlers with hooks, IPC and storage mocked. The inserted
// return exposes closures to tests; no application window or Electron process runs.
function dialogHarness(overrides = {}) {
  const events = []
  const timers = new Map()
  let nextTimer = 1
  let callback
  let sessionId
  let added = 0
  let closed = 0
  let exchanged = 0
  const api = {
    onSocialAuthCallback(listener) { callback = listener; return () => {} },
    async startSocialLogin(_provider, _private, id) { sessionId = id; return { success: true, sessionId: id, expiresIn: 600 } },
    async getSocialAuthCallback() { return null },
    async exchangeSocialToken(_code, _state, id) { exchanged++; return { success: true, completed: true, sessionId: id, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', provider: 'Google' } },
    async cancelSocialLogin(id) { events.push(['cancel', id]); return { success: true } },
    async cancelBuilderIdLogin() { return { success: true } },
    async cancelIamSsoLogin() { return { success: true } },
    async verifyAccountCredentials() { return { success: true, data: { email: 'synthetic@example.invalid', userId: 'synthetic-user', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', usage: { current: 0, limit: 1 }, subscriptionType: 'Free', subscriptionTitle: 'Free' } } },
    ...overrides.api
  }
  const store = {
    addAccount() { added++ }, accounts: new Map(), batchImportConcurrency: 1, loginPrivateMode: false, groups: new Map(), activeGroupTab: 'all',
    importAccountPlan() {}, saveAccountChanges: overrides.save ?? (async () => {})
  }
  const useStore = Object.assign(() => store, { getState: () => store })
  const hooks = {
    useState(initial) { return [initial, value => events.push(value)] },
    useRef(initial) { return { current: initial } },
    useMemo(create) { return create() },
    useEffect() {}
  }
  const code = readFileSync(new URL('../../src/renderer/src/components/accounts/AddAccountDialog.tsx', import.meta.url), 'utf8')
    .replace('  if (!isOpen) return null', '  return { handleStartSocialLogin, handleCancelLogin, handleDialogClose, handleRetryLoginSave };\n  if (!isOpen) return null')
  const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, {
    exports, window: { api }, console: { log() {}, error() {} }, crypto: { randomUUID: () => `session-${nextTimer}` }, AbortController,
    setTimeout(run, delay) { const id = nextTimer++; timers.set(id, { run, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {} }
      if (name === '@/store/accounts') return { useAccountsStore: useStore }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: () => 'Unknown' }) }
      if (name.includes('shared/accountImport')) return { parseAccountImportText: () => ({ ok: false, records: [], counts: { total: 0 } }) }
      if (name === '@/lib/loginPolling') return { startSerialLoginPolling() { return () => {} } }
      return {}
    }
  })
  const dialog = exports.AddAccountDialog({ isOpen: true, onClose() { closed++ } })
  return { dialog, events, timers, get sessionId() { return sessionId }, get added() { return added }, get closed() { return closed }, get exchanged() { return exchanged }, deliver(extra = {}) { callback({ sessionId, state: 'synthetic-state', code: 'synthetic-code', ...extra }) } }
}

test('closing during post-login verification rejects late account insertion', async () => {
  const verify = deferred()
  let verified = 0
  const harness = dialogHarness({ api: { verifyAccountCredentials() { verified++; return verify.promise } } })
  await harness.dialog.handleStartSocialLogin('Google')
  harness.deliver()
  harness.deliver()
  await tick()
  assert.equal(verified, 1)
  harness.dialog.handleDialogClose()
  verify.resolve({ success: true, data: { email: 'synthetic@example.invalid', userId: 'synthetic', usage: { current: 0, limit: 1 } } })
  await tick()
  assert.equal(harness.added, 0)
  assert.equal(harness.closed, 1)
})

test('online login waits for durable save before closing and duplicate callback adds once', async () => {
  const save = deferred()
  const harness = dialogHarness({ save: () => save.promise })
  await harness.dialog.handleStartSocialLogin('Google')
  harness.deliver()
  harness.deliver()
  await tick()
  assert.equal(harness.added, 1)
  assert.equal(harness.closed, 0)
  assert.equal(harness.exchanged, 1)
  save.resolve()
  await tick()
  assert.equal(harness.closed, 1)
})

test('failed persistence keeps account and retry saves without re-exchanging code or re-adding', async () => {
  let saves = 0
  const harness = dialogHarness({ save: async () => { if (++saves === 1) throw new Error('synthetic-private-detail') } })
  await harness.dialog.handleStartSocialLogin('Google')
  harness.deliver()
  await tick()
  assert.equal(harness.added, 1)
  assert.equal(harness.closed, 0)
  assert.equal(harness.exchanged, 1)
  assert.equal(harness.events.some(value => typeof value === 'string' && value.includes('synthetic-private-detail')), false)
  await harness.dialog.handleRetryLoginSave()
  assert.equal(saves, 2)
  assert.equal(harness.added, 1)
  assert.equal(harness.exchanged, 1)
})

test('Social waiting timeout exits current attempt and late callback never exchanges', async () => {
  const harness = dialogHarness()
  await harness.dialog.handleStartSocialLogin('Google')
  const expiry = [...harness.timers.values()].find(timer => timer.delay === 600000)
  assert.ok(expiry)
  expiry.run()
  harness.deliver()
  await tick()
  assert.equal(harness.exchanged, 0)
  assert.ok(harness.events.includes('登录已过期，请重新开始'))
  assert.ok(harness.events.some(value => Array.isArray(value) && value[0] === 'cancel' && value[1] === harness.sessionId))
})
