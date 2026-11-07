import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
const quiet = { log() {}, warn() {}, error() {} }
const source = readFileSync(new URL('../../src/main/proxy/proxyServer.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
const names = ['isTokenExpiringSoon', 'refreshToken', 'doRefreshToken', 'sameRefreshGeneration', 'isAccessTokenUsable', 'getRefreshSchedule', 'rememberRefreshSchedule', 'canRetainAccessToken', 'acceptRefreshResult', 'getAvailableAccount', 'getAllowedAccountIds', 'isAccountAllowed', 'getScopedNextAccount', 'callWithRetry', 'abortable']
const members = declaration.members.filter(node => names.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n')
const compiled = ts.transpileModule(`class Subject { ${members} }; globalThis.Subject = Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function harness(refresh, remainingSeconds = 120, random = () => 0) {
  let now = 1_800_000_000_000
  const DateClock = class extends Date { static now() { return now } }
  const context = vm.createContext({ Date: DateClock, Math: { floor: Math.floor, min: Math.min, random }, console: quiet, Set, Map, ErrorType: { RECOVERABLE: 'recoverable' } })
  vm.runInContext(compiled, context)
  const server = new context.Subject()
  const accounts = new Map([['A', { id: 'A', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: now + remainingSeconds * 1000, isAvailable: true }]])
  let calls = 0
  const updates = []
  server.config = { enableMultiAccount: true, tokenRefreshBeforeExpiry: 300, maxRetries: 2, retryDelayMs: 1 }
  server.events = { onTokenRefresh: async account => { calls++; return refresh(account, now) }, onAccountUpdate: value => updates.push(value) }
  server.refreshingTokens = new Map()
  server.tokenRefreshSchedules = new Map()
  server.accountPool = {
    getAccount: id => accounts.get(id),
    getAllAccounts: () => [...accounts.values()],
    updateAccount: (id, update) => { if (accounts.has(id)) accounts.set(id, { ...accounts.get(id), ...update }) },
    markNeedsRefresh: id => { if (accounts.has(id)) accounts.get(id).isAvailable = false },
    getNextAccount: () => [...accounts.values()].find(account => account.isAvailable),
    isSuspended: () => false, isQuotaExhausted: () => false
  }
  server.throwIfAborted = signal => { if (signal?.aborted) throw signal.reason }
  server.getAbortError = signal => signal?.reason || new Error('Aborted')
  server.isAbortError = (_error, signal) => !!signal?.aborted
  server.waitForRetry = async () => {}
  server.pickAccountWithAffinity = () => server.accountPool.getNextAccount()
  server.syncKProxyDeviceId = () => {}
  server.detectSuspendedError = () => undefined
  return { server, accounts, updates, get calls() { return calls }, now: () => now, advance: milliseconds => { now += milliseconds } }
}

test('actual proxy selection retains a usable token after a classified temporary pre-refresh failure', async () => {
  for (const failureKind of ['temporary', 'uncertain']) {
    const h = harness(async () => ({ success: false, failureKind }))
    const selected = await h.server.getAvailableAccount()
    assert.equal(selected?.id, 'A', failureKind)
    assert.equal(h.accounts.get('A').isAvailable, true)
    assert.equal(h.calls, 1)
    assert.equal((await h.server.getAvailableAccount())?.id, 'A')
    assert.equal(h.calls, 1, 'a following request must not immediately resend the refresh POST')
  }
})

test('actual proxy never retains an expired, near-expiry, unknown or permanently rejected token', async () => {
  for (const [remaining, failureKind] of [[0, 'temporary'], [9, 'temporary'], [120, 'reauth-required'], [120, undefined]]) {
    const h = harness(async () => ({ success: false, failureKind }), remaining)
    assert.equal(await h.server.getAvailableAccount(), null, `${remaining}/${failureKind}`)
    assert.equal(h.accounts.get('A').isAvailable, false)
  }
  const boundary = harness(async () => ({ success: false, failureKind: 'temporary' }), 10)
  assert.equal((await boundary.server.getAvailableAccount())?.id, 'A', 'ten seconds is the inclusive usable boundary')
  for (const expiresAt of [0, NaN, Infinity]) {
    const invalid = harness(async () => ({ success: false, failureKind: 'temporary' }))
    invalid.accounts.set('A', { ...invalid.accounts.get('A'), expiresAt })
    assert.equal(await invalid.server.getAvailableAccount(), null, `invalid or expired timestamp: ${expiresAt}`)
  }
})

test('a successful capped lifetime is used until its usable deadline without per-request refreshes', async () => {
  for (const seconds of [10, 60, 180, 300]) {
    const h = harness(async (_account, now) => ({ success: true, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH', expiresAt: now + seconds * 1000 }))
    assert.equal((await h.server.getAvailableAccount())?.accessToken, 'SYNTHETIC_NEW_ACCESS')
    for (let index = 0; index < 3; index++) assert.equal((await h.server.getAvailableAccount())?.id, 'A')
    assert.equal(h.calls, 1, String(seconds))
  }
})

test('uncertain proactive refresh is never repeated for the same generation and stops at actual expiry', async () => {
  const h = harness(async () => ({ success: false, failureKind: 'uncertain' }))
  assert.equal((await h.server.getAvailableAccount())?.id, 'A')
  h.advance(115_000)
  assert.equal(await h.server.getAvailableAccount(), null)
  assert.equal(h.calls, 1)
})

test('forced authentication refresh cannot reuse the rejected old token or a proactive fallback result', async () => {
  const h = harness(async () => ({ success: false, failureKind: 'temporary' }))
  const account = h.accounts.get('A')
  assert.equal(await h.server.refreshToken(account), true)
  assert.equal(await h.server.refreshToken(account, undefined, true), false)
  assert.equal(h.accounts.get('A').isAvailable, false)
  const same = harness(async (account, now) => ({ success: true, accessToken: account.accessToken, refreshToken: account.refreshToken, expiresAt: now + 600000 }))
  assert.equal(await same.server.refreshToken(same.accounts.get('A'), undefined, true), false)
  assert.equal(same.accounts.get('A').isAvailable, false)
})

test('temporary failures have a finite retry delay while long-lived successes retain normal proactive refresh', async () => {
  const temporary = harness(async () => ({ success: false, failureKind: 'temporary' }))
  await temporary.server.getAvailableAccount()
  temporary.advance(30_001)
  assert.equal((await temporary.server.getAvailableAccount())?.id, 'A')
  assert.equal(temporary.calls, 2)
  temporary.advance(90_000)
  assert.equal(await temporary.server.getAvailableAccount(), null)
  const normal = harness(async (_account, now) => ({ success: true, accessToken: 'SYNTHETIC_LONG', expiresAt: now + 3600000 }))
  await normal.server.getAvailableAccount()
  normal.advance(3_300_000)
  assert.equal(normal.server.isTokenExpiringSoon(normal.accounts.get('A')), true)
})

test('forced waiter sharing a proactive uncertain operation rejects its retained old token', async () => {
  let finish
  const h = harness(() => new Promise(resolve => { finish = resolve }))
  const proactive = h.server.refreshToken(h.accounts.get('A'))
  const forced = h.server.refreshToken(h.accounts.get('A'), undefined, true)
  await new Promise(resolve => setImmediate(resolve))
  finish({ success: false, failureKind: 'uncertain' })
  assert.equal(await proactive, true)
  assert.equal(await forced, false)
  assert.equal(h.calls, 1)
  assert.equal(h.accounts.get('A').isAvailable, false)
})

test('late refresh success and failure cannot overwrite a different generation or reactivate a removed account', async () => {
  for (const success of [true, false]) {
    let finish
    const h = harness(() => new Promise(resolve => { finish = resolve }))
    const pending = h.server.refreshToken(h.accounts.get('A'))
    await new Promise(resolve => setImmediate(resolve))
    h.accounts.set('A', { ...h.accounts.get('A'), accessToken: 'SYNTHETIC_EXTERNAL_ACCESS', refreshToken: 'SYNTHETIC_EXTERNAL_REFRESH' })
    finish({ success, accessToken: 'SYNTHETIC_STALE_ACCESS', refreshToken: 'SYNTHETIC_STALE_REFRESH', expiresAt: h.now() + 3600000 })
    assert.equal(await pending, true)
    assert.equal(h.accounts.get('A').accessToken, 'SYNTHETIC_EXTERNAL_ACCESS')
    assert.equal(h.updates.length, 0)
  }
  let finish
  const h = harness(() => new Promise(resolve => { finish = resolve }))
  const pending = h.server.refreshToken(h.accounts.get('A'))
  await new Promise(resolve => setImmediate(resolve))
  h.accounts.delete('A')
  finish({ success: true, accessToken: 'SYNTHETIC_STALE_ACCESS', expiresAt: h.now() + 3600000 })
  assert.equal(await pending, false)
  assert.equal(h.updates.length, 0)
})

test('stale forced refresh cannot suppress the newer generation or dispatch with old credentials', async () => {
  const h = harness(async () => ({ success: false, failureKind: 'uncertain' }))
  const old = h.accounts.get('A')
  h.accounts.set('A', { ...old, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH' })
  assert.equal(await h.server.refreshToken(h.accounts.get('A')), true)
  assert.equal(await h.server.refreshToken(old, undefined, true), true)
  assert.equal(h.accounts.get('A').isAvailable, true)
  assert.equal(h.calls, 1)
})

test('account replacement during refresh jitter stops the stale POST', async () => {
  let releaseJitter
  const h = harness(async () => assert.fail('must not send credentials that changed during jitter'), 120, () => 0.5)
  h.server.waitForRetry = () => new Promise(resolve => { releaseJitter = resolve })
  const old = h.accounts.get('A')
  const pending = h.server.refreshToken(old)
  h.accounts.set('A', { ...old, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH' })
  releaseJitter()
  assert.equal(await pending, true)
  assert.equal(h.calls, 0)
})

test('cancelling the request that launched a refresh leaves one dispatched POST for other waiters', async () => {
  let finish
  const h = harness(() => new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  const selected = h.server.getAvailableAccount(controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls, 1)
  controller.abort(new Error('Synthetic request disconnected'))
  await assert.rejects(selected, /disconnected/)
  const other = h.server.getAvailableAccount()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls, 1)
  finish({ success: true, accessToken: 'SYNTHETIC_ROTATED_ACCESS', refreshToken: 'SYNTHETIC_ROTATED_REFRESH', expiresAt: h.now() + 120_000 })
  assert.equal((await other)?.accessToken, 'SYNTHETIC_ROTATED_ACCESS')
  assert.equal(h.updates.length, 1)
})

test('the main-process refresh callback forwards failure classifications and rejects invented expiry', async () => {
  const main = ts.createSourceFile('index.ts', readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let callback
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(main) === 'onTokenRefresh') callback = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(main)
  assert.ok(callback, 'the production ProxyServer bridge must exist')
  const bridge = ts.transpileModule(`globalThis.refresh = (${callback.getText(main)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  for (const failureKind of ['temporary', 'uncertain', 'reauth-required']) {
    const context = vm.createContext({ console: quiet, refreshTokenByMethod: async () => ({ success: false, failureKind }) })
    vm.runInContext(bridge, context)
    const h = harness(context.refresh)
    assert.equal((await h.server.getAvailableAccount())?.id, failureKind === 'reauth-required' ? undefined : 'A')
    assert.equal(h.calls, 1)
  }
  for (const expiresIn of [undefined, NaN, Infinity, 0, -1]) {
    const context = vm.createContext({ console: quiet, refreshTokenByMethod: async () => ({
      success: true, accessToken: 'SYNTHETIC_REPLACEMENT', expiresIn
    }) })
    vm.runInContext(bridge, context)
    const h = harness(context.refresh)
    assert.equal(await h.server.getAvailableAccount(), null)
    assert.equal(h.updates.length, 0, `invalid expiresIn: ${expiresIn}`)
  }
})
