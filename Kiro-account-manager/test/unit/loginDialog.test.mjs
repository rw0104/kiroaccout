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
const verified = (data = {}) => ({ success: true, data: {
  email: 'synthetic@example.invalid', userId: 'synthetic-user', accessToken: 'SYNTHETIC_ACCESS',
  refreshToken: 'SYNTHETIC_REFRESH', expiresIn: 600, usage: { current: 0, limit: 1 },
  subscriptionType: 'Free', subscriptionTitle: 'Free', ...data
} })

// Execute the real handlers with hooks, IPC and storage mocked. No browser, Electron or account API runs.
function dialogHarness(overrides = {}) {
  const events = [], portalStarts = [], timers = new Map(), polls = [], addedAccounts = []
  let nextTimer = 1, sessionId, closed = 0, verificationCalls = 0, legacyCalls = 0
  const legacy = () => { legacyCalls++; throw new Error('Legacy protocol must not be used') }
  const api = {
    onSocialAuthCallback: legacy, startSocialLogin: legacy, getSocialAuthCallback: legacy,
    exchangeSocialToken: legacy, cancelSocialLogin: legacy,
    async cancelBuilderIdLogin() { return { success: true } },
    async cancelIamSsoLogin() { return { success: true } },
    async startPortalLogin(id, privateMode, expectedProvider) {
      sessionId = id; portalStarts.push({ sessionId: id, privateMode, expectedProvider })
      return overrides.start ? overrides.start(id, expectedProvider) : { success: true, sessionId: id, expiresIn: 600, interval: 1 }
    },
    async pollPortalLogin(id) { return { success: true, sessionId: id, status: 'pending' } },
    async cancelPortalLogin(id) { events.push(['cancel-portal', id]); return { success: true } },
    async verifyAccountCredentials(data) { verificationCalls++; return overrides.verify ? overrides.verify(data) : verified() }
  }
  const store = {
    addAccount(account) { addedAccounts.push(account) }, accounts: new Map(), batchImportConcurrency: 1,
    loginPrivateMode: false, groups: new Map(), activeGroupTab: 'all', importAccountPlan() {},
    saveAccountChanges: overrides.save ?? (async () => {})
  }
  const useStore = Object.assign(() => store, { getState: () => store })
  const hooks = {
    useState(initial) { return [initial, value => events.push(value)] },
    useRef(initial) { return { current: initial } },
    useMemo(create) { return create() }, useEffect() {}
  }
  const code = readFileSync(new URL('../../src/renderer/src/components/accounts/AddAccountDialog.tsx', import.meta.url), 'utf8')
    .replace('  if (!isOpen) return null', '  return { handleStartPortalLogin, handleRetryPortalVerification, handleStartSocialLogin, handleCancelLogin, handleDialogClose, handleRetryLoginSave };\n  if (!isOpen) return null')
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
      if (name === '@/lib/loginPolling') return { startSerialLoginPolling(options) {
        const entry = { ...options, stopped: false }; polls.push(entry)
        return () => { entry.stopped = true }
      } }
      return {}
    }
  })
  const dialog = exports.AddAccountDialog({ isOpen: true, onClose() { closed++ } })
  return { dialog, api, events, timers, polls, portalStarts, addedAccounts,
    get polling() { return polls.at(-1) }, get addedAccount() { return addedAccounts.at(-1) },
    get sessionId() { return sessionId }, get added() { return addedAccounts.length }, get closed() { return closed },
    get verificationCalls() { return verificationCalls }, get legacyCalls() { return legacyCalls },
    complete(extra = {}, polling = polls.at(-1), id = sessionId) {
      return polling.onResult({ success: true, completed: true, sessionId: id, provider: 'Google', authMethod: 'social',
        accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresIn: 600, ...extra })
    }
  }
}

test('Google and Github shortcuts start provider-bound portal polling without legacy protocol IPC', async () => {
  for (const provider of ['Google', 'Github']) {
    const harness = dialogHarness()
    await harness.dialog.handleStartSocialLogin(provider)
    assert.equal(harness.portalStarts.length, 1)
    assert.equal(harness.portalStarts[0].expectedProvider, provider)
    assert.equal(harness.polling.initialInterval, 1)
    await harness.complete({ provider })
    assert.equal(harness.addedAccount.idp, provider)
    assert.equal(harness.legacyCalls, 0)
  }
  const generic = dialogHarness()
  await generic.dialog.handleStartPortalLogin()
  assert.equal(generic.portalStarts[0].expectedProvider, undefined)
})

test('closing during portal verification rejects late account insertion and stops only that poll', async () => {
  const verify = deferred()
  const harness = dialogHarness({ verify: () => verify.promise })
  await harness.dialog.handleStartSocialLogin('Google')
  const completing = harness.complete()
  await tick()
  assert.equal(harness.verificationCalls, 1)
  harness.dialog.handleDialogClose()
  verify.resolve(verified())
  await completing
  assert.equal(harness.added, 0)
  assert.equal(harness.closed, 1)
  assert.equal(harness.polling.stopped, true)
  assert.ok(harness.events.some(event => Array.isArray(event) && event[0] === 'cancel-portal' && event[1] === harness.sessionId))
  assert.equal(harness.legacyCalls, 0)
})

test('duplicate portal completions verify and add once, then await durable save before closing', async () => {
  const save = deferred()
  const harness = dialogHarness({ save: () => save.promise })
  await harness.dialog.handleStartSocialLogin('Google')
  const first = harness.complete()
  const duplicate = harness.complete()
  await tick()
  assert.equal(harness.verificationCalls, 1)
  assert.equal(harness.added, 1)
  assert.equal(harness.closed, 0)
  save.resolve()
  await Promise.all([first, duplicate])
  assert.equal(harness.closed, 1)
  assert.equal(harness.legacyCalls, 0)
})

test('failed persistence keeps one portal account and retry saves without authorizing or adding again', async () => {
  let saves = 0
  const harness = dialogHarness({ save: async () => { if (++saves === 1) throw new Error('SYNTHETIC_PRIVATE') } })
  await harness.dialog.handleStartSocialLogin('Github')
  await harness.complete({ provider: 'Github' })
  assert.equal(harness.added, 1)
  assert.equal(harness.closed, 0)
  assert.equal(harness.events.some(value => typeof value === 'string' && value.includes('SYNTHETIC_PRIVATE')), false)
  await harness.dialog.handleRetryLoginSave()
  assert.equal(saves, 2)
  assert.equal(harness.added, 1)
  assert.equal(harness.closed, 1)
  assert.equal(harness.portalStarts.length, 1)
  assert.equal(harness.verificationCalls, 1)
})

test('portal waiting timeout cancels the session and ignores a late completion', async () => {
  const harness = dialogHarness()
  await harness.dialog.handleStartSocialLogin('Google')
  const expiry = [...harness.timers.values()].find(timer => timer.delay === 600000)
  assert.ok(expiry)
  expiry.run()
  await harness.complete()
  assert.equal(harness.verificationCalls, 0)
  assert.equal(harness.added, 0)
  assert.ok(harness.events.includes('登录已过期，请重新开始'))
  assert.ok(harness.events.some(value => Array.isArray(value) && value[0] === 'cancel-portal' && value[1] === harness.sessionId))
  assert.equal(harness.legacyCalls, 0)
})

test('portal polling saves actual Enterprise identity, region, profile and registration deadline', async () => {
  const harness = dialogHarness()
  await harness.dialog.handleStartPortalLogin()
  await harness.complete({ provider: 'Enterprise', authMethod: 'IdC', region: 'eu-central-1',
    startUrl: 'https://synthetic.awsapps.com/start', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET',
    profileArn: 'SYNTHETIC_PROFILE', clientSecretExpiresAt: 1900000000 })
  assert.equal(harness.added, 1)
  assert.equal(harness.addedAccount.idp, 'Enterprise')
  assert.equal(harness.addedAccount.credentials.authMethod, 'IdC')
  assert.equal(harness.addedAccount.credentials.region, 'eu-central-1')
  assert.equal(harness.addedAccount.credentials.profileArn, 'SYNTHETIC_PROFILE')
  assert.equal(harness.addedAccount.credentials.clientSecretExpiresAt, 1900000000)
  assert.equal(harness.closed, 1)
})

test('selected provider or auth method mismatch is rejected before credential verification', async () => {
  for (const result of [{ provider: 'Github', authMethod: 'social' }, { provider: 'Google', authMethod: 'IdC' }, { provider: undefined, authMethod: 'social' }]) {
    const harness = dialogHarness()
    await harness.dialog.handleStartSocialLogin('Google')
    await harness.complete(result)
    assert.equal(harness.added, 0)
    assert.equal(harness.verificationCalls, 0)
    assert.equal(harness.polling.stopped, true)
    assert.ok(harness.events.includes('登录方式与授权结果不一致，请重新开始'))
  }
})

test('cancelling during portal start prevents a late start response from scheduling polling', async () => {
  const pending = deferred()
  const harness = dialogHarness({ start: () => pending.promise })
  const starting = harness.dialog.handleStartSocialLogin('Google')
  const id = harness.sessionId
  harness.dialog.handleCancelLogin()
  pending.resolve({ success: true, sessionId: id, expiresIn: 600 })
  await starting
  assert.equal(harness.polls.length, 0)
  assert.equal(harness.added, 0)
  assert.ok(harness.events.some(event => Array.isArray(event) && event[0] === 'cancel-portal' && event[1] === id))
})

test('old polling and mismatched session replies cannot enter the replacement portal session', async () => {
  const harness = dialogHarness()
  await harness.dialog.handleStartSocialLogin('Google')
  const oldPolling = harness.polling, oldId = harness.sessionId
  await harness.dialog.handleStartSocialLogin('Github')
  await harness.complete({}, oldPolling, oldId)
  await harness.complete({ provider: 'Github', sessionId: oldId })
  assert.equal(harness.verificationCalls, 0)
  await harness.complete({ provider: 'Github' })
  assert.equal(harness.verificationCalls, 1)
  assert.equal(harness.addedAccount.idp, 'Github')
})

test('portal metadata failure retries the same authorized payload without reauthorizing or rotating it', async () => {
  const submitted = []
  const harness = dialogHarness({ verify: async data => {
    submitted.push(data)
    return submitted.length === 1 ? { success: false, error: 'Synthetic network failure' } : verified(data)
  } })
  await harness.dialog.handleStartPortalLogin()
  await harness.complete({ provider: 'BuilderId', authMethod: 'IdC', clientSecretExpiresAt: 1900000000 })
  assert.equal(harness.added, 0)
  await harness.dialog.handleRetryPortalVerification()
  assert.equal(harness.added, 1)
  assert.equal(harness.portalStarts.length, 1)
  assert.equal(submitted[0].accessToken, 'SYNTHETIC_ACCESS')
  assert.equal(submitted[1].refreshToken, submitted[0].refreshToken)
  assert.equal(harness.addedAccount.credentials.clientSecretExpiresAt, 1900000000)
})
