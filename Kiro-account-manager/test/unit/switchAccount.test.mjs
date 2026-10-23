import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { switchAccountToClients } from '../../src/shared/switchAccount.ts'
import { SwitchHandoffStore } from '../../src/main/switchHandoff.ts'

const now = 1_800_000_000_000
const account = (id = 'candidate') => ({ id, email: `${id}@example.invalid`, idp: 'Github',
  credentials: { accessToken: 'SYNTHETIC_ACCESS_1', refreshToken: 'SYNTHETIC_REFRESH_1', authMethod: 'social', provider: 'Github',
    clientSecretExpiresAt: (now + 86_400_000) / 1000, expiresAt: now + 60_000 },
  usage: { current: 0, limit: 100 }, subscription: { type: 'Free' } })
const rotated = (generation = 2, success = true) => ({ success, error: success ? undefined : '本地写入失败',
  refreshedCredentials: { accessToken: `SYNTHETIC_ACCESS_${generation}`, refreshToken: `SYNTHETIC_REFRESH_${generation}`, expiresIn: 123 },
  preparedExpiresAt: now + 123_000, handoffProof: generation === 2 ? 'synthetic-single-use-proof' : undefined })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(overrides = {}) {
  let current = account(), activated = null
  const calls = [], saved = []
  const deps = {
    now: () => now, getAccount: () => current,
    async switchIde(payload) { calls.push(['ide', payload]); return overrides.ide ? overrides.ide(payload) : rotated() },
    async switchCli(payload) { calls.push(['cli', payload]); return overrides.cli ? overrides.cli(payload) : { success: true } },
    applyCredentials(id, expected, next) {
      if (overrides.stale) current = { ...current, credentials: { ...current.credentials, accessToken: 'SYNTHETIC_NEWER_ACCESS', refreshToken: 'SYNTHETIC_NEWER_REFRESH' } }
      if (current.id !== id || current.credentials.accessToken !== expected.accessToken || current.credentials.refreshToken !== expected.refreshToken) return false
      current = { ...current, credentials: { ...current.credentials, ...next } }
      return true
    },
    async persist() { saved.push({ ...current.credentials }); if (overrides.persist) await overrides.persist() },
    async activate(id) { activated = id }
  }
  return { deps, calls, saved, get current() { return current }, get activated() { return activated } }
}

test('both hands the saved IDE generation and exact expiry to CLI without another refresh', async () => {
  const barrier = deferred()
  const h = fixture({ persist: () => barrier.promise })
  const switching = switchAccountToClients('candidate', 'both', h.deps)
  await tick()
  assert.equal(h.calls.length, 1, 'CLI waits until the rotated manager credentials are durable')
  assert.equal(h.saved[0].refreshToken, 'SYNTHETIC_REFRESH_2')
  barrier.resolve()
  const result = await switching
  assert.equal(result.success, true)
  assert.deepEqual(result.completedTargets, ['ide', 'cli'])
  const payload = h.calls[1][1]
  assert.equal(payload.accountId, 'candidate')
  assert.equal(payload.refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(payload.accessToken, 'SYNTHETIC_ACCESS_2')
  assert.equal(payload.expiresAt, now + 123_000)
  assert.equal(payload.clientSecretExpiresAt, account().credentials.clientSecretExpiresAt)
  assert.equal(payload.reusePreparedCredentials, true)
  assert.equal(payload.handoffProof, 'synthetic-single-use-proof')
  assert.equal(h.current.credentials.refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(h.activated, 'candidate')
})

test('CLI-only rotations are saved using the returned lifetime before activation', async () => {
  const h = fixture({ cli: () => ({ ...rotated(3), preparedExpiresAt: undefined }) })
  const result = await switchAccountToClients('candidate', 'cli', h.deps)
  assert.equal(result.success, true)
  assert.equal(h.calls[0][0], 'cli')
  assert.equal(h.calls[0][1].reusePreparedCredentials, undefined)
  assert.equal(h.current.credentials.refreshToken, 'SYNTHETIC_REFRESH_3')
  assert.equal(h.saved[0].expiresAt, now + 123_000)
  assert.equal(h.activated, 'candidate')
})

test('a failed IDE or CLI write still retains rotation and cannot report overall success', async () => {
  const ide = fixture({ ide: () => rotated(2, false) })
  assert.equal((await switchAccountToClients('candidate', 'both', ide.deps)).success, false)
  assert.equal(ide.saved[0].refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(ide.calls.length, 1)
  assert.equal(ide.activated, null)
  const cli = fixture({ cli: () => rotated(3, false) })
  assert.equal((await switchAccountToClients('candidate', 'cli', cli.deps)).success, false)
  assert.equal(cli.saved[0].refreshToken, 'SYNTHETIC_REFRESH_3')
  assert.equal(cli.activated, null)
  const partial = fixture({ cli: () => ({ success: false, error: 'CLI 写入失败' }) })
  const result = await switchAccountToClients('candidate', 'both', partial.deps)
  assert.equal(result.success, false)
  assert.deepEqual(result.completedTargets, ['ide'])
  assert.match(result.error, /IDE 已切换/)
  assert.equal(partial.activated, null)
})

test('failed persistence, missing handoff proof and stale generations all stop before CLI', async () => {
  for (const overrides of [{ persist: () => { throw new Error('synthetic disk failure') } },
    { ide: () => ({ ...rotated(), handoffProof: undefined }) }, { stale: true }]) {
    const h = fixture(overrides)
    const result = await switchAccountToClients('candidate', 'both', h.deps)
    assert.equal(result.success, false)
    assert.equal(h.calls.length, 1)
    assert.equal(h.activated, null)
    assert.equal(h.current.credentials.refreshToken, overrides.stale ? 'SYNTHETIC_NEWER_REFRESH' : 'SYNTHETIC_REFRESH_2')
  }
})

test('invalid rotation lifetime cannot overwrite credentials or activate an account', async () => {
  const h = fixture({ cli: () => ({ ...rotated(), refreshedCredentials: { ...rotated().refreshedCredentials, expiresIn: 0 } }) })
  assert.equal((await switchAccountToClients('candidate', 'cli', h.deps)).success, false)
  assert.equal(h.current.credentials.refreshToken, 'SYNTHETIC_REFRESH_1')
  assert.equal(h.saved.length, 0)
  assert.equal(h.activated, null)
})

test('an already expired prepared access token retains its new refresh token but never activates', async () => {
  for (const target of ['ide', 'cli', 'both']) {
    const expired = () => ({ ...rotated(3), preparedExpiresAt: now - 1 })
    const h = fixture({ ide: expired, cli: expired })
    const result = await switchAccountToClients('candidate', target, h.deps)
    assert.equal(result.success, false, target)
    assert.match(result.error, /已到期/, target)
    assert.equal(h.saved[0].refreshToken, 'SYNTHETIC_REFRESH_3', target)
    assert.equal(h.current.credentials.expiresAt, now - 1, target)
    assert.equal(h.activated, null, target)
    assert.equal(h.calls.length, 1, target)
  }
})

const ts = createRequire(import.meta.url)('typescript')
const storeSource = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('accounts.ts', storeSource, ts.ScriptTarget.Latest, true)
const names = ['switchAccountToTarget', 'checkAndAutoSwitch']
const helpers = ['accountOperationCountsAfter', 'isBannedAccountError']
const parts = [], declarations = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && names.includes(node.name?.getText(tree))) parts.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && helpers.includes(node.name?.text)) declarations.push(node.getText(tree).replace(/^export /, ''))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(parts.length, names.length)
const script = ts.transpileModule(`let accountSwitchTask; ${declarations.join('\n')} const actions = {${parts.join(',\n')}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

function storeFixture(api, save) {
  const old = { ...account('old'), usage: { current: 100, limit: 100 } }
  const state = { accounts: new Map([['old', old], ['candidate', account()]]), activeAccountId: 'old', switchTarget: 'both',
    autoSwitchThreshold: 0, accountOperationCounts: new Map() }
  const saved = [], warnings = []
  let actions
  const get = () => ({ ...state, ...actions,
    checkAccountStatus: async () => {}, getActiveAccount: () => state.accounts.get(state.activeAccountId),
    saveAccountChanges: async () => { saved.push(state.accounts.get('candidate').credentials.refreshToken); if (save) await save() },
    setActiveAccount: async id => { state.activeAccountId = id }
  })
  const set = next => Object.assign(state, typeof next === 'function' ? next(state) : next)
  const context = vm.createContext({ get, set, window: { api }, switchAccountToClients, Map, Set,
    console: { log() {}, warn: (...args) => warnings.push(args) } })
  vm.runInContext(script, context)
  actions = vm.runInContext('actions', context)
  return { state, actions, saved, warnings }
}

test('actual store switch shares repeated work and blocks competing selections until completion', async () => {
  const wait = deferred(), payloads = []
  const h = storeFixture({ switchAccount: async payload => { payloads.push(payload); return wait.promise }, switchAccountCli: async payload => { payloads.push(payload); return { success: true } } })
  const first = h.actions.switchAccountToTarget('candidate', 'both')
  assert.equal(h.actions.switchAccountToTarget('candidate', 'both'), first)
  assert.equal((await h.actions.switchAccountToTarget('old', 'cli')).success, false)
  assert.equal(h.state.activeAccountId, 'old')
  wait.resolve({ ...rotated(), preparedExpiresAt: Date.now() + 123_000 })
  assert.equal((await first).success, true)
  assert.equal(payloads.length, 2)
  assert.equal(payloads[1].refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(payloads[1].reusePreparedCredentials, true)
  assert.deepEqual(h.saved, ['SYNTHETIC_REFRESH_2', 'SYNTHETIC_REFRESH_2'])
  assert.equal(h.state.activeAccountId, 'candidate')
  assert.equal(h.state.accountOperationCounts.size, 0)
})

test('an earlier main rotation event cannot leave the both-client proof with a different expiry', async () => {
  const handoffs = new SwitchHandoffStore()
  const exactExpiry = Date.now() + 123_000
  let h, cliPayload
  h = storeFixture({
    switchAccount: async () => {
      const prepared = { accessToken: 'SYNTHETIC_ACCESS_2', refreshToken: 'SYNTHETIC_REFRESH_2', expiresAt: exactExpiry }
      // refreshTokenByMethod sends its rotation event before the IDE write completes.
      const prior = h.state.accounts.get('candidate')
      h.state.accounts.set('candidate', { ...prior, credentials: { ...prior.credentials, ...prepared, expiresAt: exactExpiry - 75 } })
      return { ...rotated(), preparedExpiresAt: exactExpiry, handoffProof: handoffs.issue('candidate', prepared) }
    },
    switchAccountCli: async payload => {
      cliPayload = payload
      const prepared = handoffs.consume(payload.handoffProof, payload.accountId, payload)
      return { success: true, refreshedCredentials: rotated().refreshedCredentials, preparedExpiresAt: prepared.expiresAt }
    }
  })
  const result = await h.actions.switchAccountToTarget('candidate', 'both')
  assert.equal(result.success, true)
  assert.equal(cliPayload.expiresAt, exactExpiry)
  assert.equal(h.state.accounts.get('candidate').credentials.expiresAt, exactExpiry)
  assert.equal(h.state.activeAccountId, 'candidate')
})

test('actual automatic switching awaits CLI and keeps the current active account on partial failure', async () => {
  const cli = deferred()
  const h = storeFixture({ switchAccount: async () => ({ ...rotated(), preparedExpiresAt: Date.now() + 123_000 }), switchAccountCli: async () => cli.promise })
  let completed = false
  const work = h.actions.checkAndAutoSwitch().then(() => { completed = true })
  await tick()
  assert.equal(completed, false)
  assert.equal(h.state.activeAccountId, 'old')
  cli.resolve({ success: false, error: 'synthetic local CLI failure' })
  await work
  assert.equal(h.state.activeAccountId, 'old')
  assert.equal(h.state.accounts.get('candidate').credentials.refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(h.warnings.length, 1)
})

test('real card and list handlers delegate to the same coordinator and surface failed switches', async () => {
  for (const file of ['AccountCard.tsx', 'AccountListRow.tsx']) {
    const source = readFileSync(new URL(`../../src/renderer/src/components/accounts/${file}`, import.meta.url), 'utf8')
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let handler
    function find(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleSwitch') handler = node.getText(tree)
      ts.forEachChild(node, find)
    }
    find(tree)
    assert.ok(handler)
    const calls = [], alerts = []
    const context = vm.createContext({ account: { id: 'candidate' }, isEn: false, alert: message => alerts.push(message), useCallback: fn => fn,
      useAccountsStore: { getState: () => ({ switchAccountToTarget: async id => { calls.push(id); return { success: false, error: 'synthetic failure' } } }) } })
    vm.runInContext(ts.transpileModule(`const ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
    await vm.runInContext('handleSwitch', context)({ stopPropagation() {} })
    assert.deepEqual(calls, ['candidate'])
    assert.equal(alerts.length, 1)
    assert.match(alerts[0], /synthetic failure/)
  }
})
