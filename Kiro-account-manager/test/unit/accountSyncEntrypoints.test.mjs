import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import { parseAccountUsage, normalizeUsageDate } from '../../src/shared/accountUsage.ts'
import { normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'
import { SwitchHandoffStore } from '../../src/main/switchHandoff.ts'
import { applyManagerTokenRotation } from '../../src/main/managerAccountRefresh.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
function find(predicate) {
  let found
  const walk = node => { if (predicate(node)) found = node; ts.forEachChild(node, walk) }
  walk(tree)
  assert.ok(found)
  return found
}
const transpile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

test('actual single-account status parser preserves Max title, Plus/Power categories and purchased balances', () => {
  const callback = find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'parseUsageResponse').initializer.getText(tree)
  const context = vm.createContext({ parseAccountUsage, normalizeSubscriptionType, Date, account: { subscription: { type: 'Pro' } }, console: { log() {} } })
  vm.runInContext(transpile(`globalThis.run = ${callback}`), context)
  for (const [title, expected] of [['KIRO PRO MAX', 'Pro_Max'], ['KIRO PRO+', 'Pro_Plus'], ['KIRO POWER', 'Power'], ['KIRO FREE', 'Free']]) {
    const result = context.run({
      usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 5000, usageLimit: 5000, overageCredits: [{ currentUsage: 10, usageLimit: 125, expiresAt: '2099-01-01T00:00:00Z' }] }],
      subscriptionInfo: { subscriptionTitle: title }, nextDateReset: '2099-01-01T00:00:00Z'
    })
    assert.equal(result.success, true)
    assert.equal(result.data.subscription.title, title)
    assert.equal(result.data.subscription.type, expected)
    assert.equal(result.data.usage.limit, 5125)
    assert.equal(result.data.usage.current, 5010)
    assert.equal(result.data.usage.addOnCredits[0].remaining, 115)
  }
})

test('real usage transport wrapper preserves new fields through both configured entry paths', async () => {
  const functions = ['normalizeUsageExpiry', 'normalizeUsageResponse', 'getUsageAndLimits'].map(name => find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree)).join('\n')
  const body = { usageBreakdownList: [{ resourceType: 'CREDIT', overageCredits: [{ currentUsage: 0, usageLimit: 125, expiresAt: 1900000000 }] }], nextDateReset: 1900000000 }
  let requests = 0
  const context = vm.createContext({ normalizeUsageDate, currentUsageApiType: 'rest', getUsageLimitsRest: async () => { requests++; return body }, kiroApiRequest: async () => body })
  vm.runInContext(transpile(`${functions}\nglobalThis.run = getUsageAndLimits`), context)
  for (const type of ['rest', 'cbor']) {
    context.currentUsageApiType = type
    const normalized = await context.run('SYNTHETIC_ACCESS', 'Google')
    assert.equal(normalized.usageBreakdownList[0].overageCredits[0].usageLimit, 125)
    assert.equal(normalized.usageBreakdownList[0].overageCredits[0].expiresAt, new Date(1900000000000).toISOString())
  }
  assert.equal(requests, 1)
  body.usageBreakdownList[0].overageCredits[0].expiresAt = 'not-a-date'
  const invalid = await context.run('SYNTHETIC_ACCESS', 'Google')
  assert.equal(parseAccountUsage(invalid).addOnLimit, 0)
  assert.equal(parseAccountUsage(invalid).addOnCredits[0].status, 'inactive')
})

function cliHarness({ refreshFails = false, diskFails = false, onMkdir } = {}) {
  const callback = find(node => ts.isCallExpression(node) && node.arguments[0]?.text === 'switch-account-cli').arguments[1].getText(tree)
  const sql = []
  let directories = 0
  let refreshes = 0
  const handoffs = new SwitchHandoffStore()
  let savedCredentials
  const context = vm.createContext({
    Date, console: { log() {}, warn() {}, error() {} },
    instanceAccountOwnership: { assertAvailable() {} },
    switchHandoffs: handoffs,
    store: { get: () => ({ accounts: { 'synthetic-account': { credentials: savedCredentials } } }) },
    resolveProfileArnForWrite: () => undefined,
    refreshTokenByMethod: async () => { refreshes++; return refreshFails ? { success: false, error: 'SYNTHETIC_DENIED' } : { success: true, accessToken: 'SYNTHETIC_ACCESS_NEW', refreshToken: 'SYNTHETIC_REFRESH_NEW', expiresIn: 7200 } },
    process: { platform: 'win32' },
    require: name => {
      if (name === 'os') return { homedir: () => 'SYNTHETIC_HOME' }
      if (name === 'path') return path
      if (name === 'fs/promises') return { mkdir: async () => { directories++; if (onMkdir) savedCredentials = onMkdir() } }
      if (name === 'child_process') return { execFileSync: (_exe, _args, options) => { if (diskFails) throw new Error('SYNTHETIC_PRIVATE'); sql.push(options.input) } }
      throw new Error('SYNTHETIC_NO_SQLITE')
    }
  })
  vm.runInContext(transpile(`globalThis.run = ${callback}`), context)
  return { run: (over = {}) => context.run(undefined, { accessToken: 'SYNTHETIC_ACCESS_OLD', refreshToken: 'SYNTHETIC_REFRESH_OLD', provider: 'Google', ...over }), sql, handoffs, setSaved: credentials => { savedCredentials = credentials }, get refreshes() { return refreshes }, get directories() { return directories } }
}

test('actual CLI handoff writes rotated refresh token, real expiry and one transaction', async () => {
  const harness = cliHarness()
  const before = Date.now()
  const result = await harness.run()
  assert.equal(result.success, true)
  assert.equal(result.refreshedCredentials.refreshToken, 'SYNTHETIC_REFRESH_NEW')
  assert.equal(result.refreshedCredentials.expiresIn, 7200)
  assert.match(harness.sql[0], /SYNTHETIC_REFRESH_NEW/)
  assert.doesNotMatch(harness.sql[0], /SYNTHETIC_REFRESH_OLD/)
  const match = /"expires_at":"([^"]+)"/.exec(harness.sql[0])
  assert.ok(Date.parse(match[1]) >= before + 7200000)
  assert.match(harness.sql[0], /^BEGIN IMMEDIATE;/)
  assert.match(harness.sql[0], /COMMIT;$/)
})

test('CLI refresh failure writes nothing; a later disk failure still returns the rotated credentials', async () => {
  const denied = cliHarness({ refreshFails: true })
  assert.equal((await denied.run()).success, false)
  assert.equal(denied.directories, 0)
  assert.equal(denied.sql.length, 0)
  const failed = await cliHarness({ diskFails: true }).run()
  assert.equal(failed.success, false)
  assert.equal(failed.refreshedCredentials.refreshToken, 'SYNTHETIC_REFRESH_NEW')
  assert.doesNotMatch(failed.error, /PRIVATE/)
})

test('both-client CLI handoff consumes the IDE generation once without another refresh', async () => {
  const harness = cliHarness()
  const credentials = { accessToken: 'SYNTHETIC_IDE_ACCESS', refreshToken: 'SYNTHETIC_IDE_REFRESH', expiresAt: Date.now() + 7200000 }
  const proof = harness.handoffs.issue('synthetic-account', credentials)
  harness.setSaved(credentials)
  const payload = { ...credentials, accountId: 'synthetic-account', reusePreparedCredentials: true, handoffProof: proof }
  const result = await harness.run(payload)
  assert.equal(result.success, true)
  assert.equal(harness.refreshes, 0)
  assert.match(harness.sql[0], /SYNTHETIC_IDE_REFRESH/)
  assert.equal(result.preparedExpiresAt, credentials.expiresAt)
  assert.equal((await harness.run(payload)).success, false)
  assert.equal(harness.sql.length, 1)
  assert.equal(harness.refreshes, 0)
})

test('a delayed both-client handoff cannot write a generation already replaced in the main store', async () => {
  const harness = cliHarness()
  const credentials = { accessToken: 'SYNTHETIC_IDE_ACCESS', refreshToken: 'SYNTHETIC_IDE_REFRESH', expiresAt: Date.now() + 7200000 }
  const proof = harness.handoffs.issue('synthetic-account', credentials)
  harness.setSaved({ accessToken: 'SYNTHETIC_NEWER_ACCESS', refreshToken: 'SYNTHETIC_NEWER_REFRESH' })
  const result = await harness.run({ ...credentials, accountId: 'synthetic-account', reusePreparedCredentials: true, handoffProof: proof })
  assert.equal(result.success, false)
  assert.equal(harness.refreshes, 0)
  assert.equal(harness.sql.length, 0)
})

test('a generation change after proof consumption refuses CLI writing without salvaging the old generation', async () => {
  const harness = cliHarness({ onMkdir: () => ({ accessToken: 'SYNTHETIC_NEWER_ACCESS', refreshToken: 'SYNTHETIC_NEWER_REFRESH' }) })
  const credentials = { accessToken: 'SYNTHETIC_IDE_ACCESS', refreshToken: 'SYNTHETIC_IDE_REFRESH', expiresAt: Date.now() + 7200000 }
  const proof = harness.handoffs.issue('synthetic-account', credentials)
  harness.setSaved(credentials)
  const result = await harness.run({ ...credentials, accountId: 'synthetic-account', reusePreparedCredentials: true, handoffProof: proof })
  assert.equal(result.success, false)
  assert.equal(result.refreshedCredentials, undefined)
  assert.equal(harness.refreshes, 0)
  assert.equal(harness.sql.length, 0)
})

test('real refresh wrapper returns a completed rotation when account persistence fails', async () => {
  const fn = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'refreshTokenByMethod').getText(tree)
  const next = { success: true, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH', expiresIn: 7200 }
  const data = { accounts: { synthetic: { id: 'synthetic', credentials: { accessToken: 'SYNTHETIC_OLD_ACCESS', refreshToken: 'SYNTHETIC_OLD_REFRESH' } } } }
  const updates = []
  let released = false
  const context = vm.createContext({
    instanceAccountOwnership: { beginOperation: () => () => { released = true } },
    refreshSocialToken: async () => next, applyManagerTokenRotation,
    store: { get: () => data, set: () => { throw new Error('SYNTHETIC_PRIVATE_PATH') } },
    mainWindow: { webContents: { send: (_event, update) => updates.push(update) } },
    pendingStoreWrites: new Map(), lastSavedData: null, console: { warn() {} }
  })
  vm.runInContext(transpile(`${fn}\nglobalThis.run = refreshTokenByMethod`), context)
  const result = await context.run('SYNTHETIC_OLD_REFRESH', '', '', 'us-east-1', 'social')
  assert.equal(result.success, true)
  assert.equal(result.persistenceError, true)
  assert.equal(result.refreshToken, next.refreshToken)
  assert.equal(updates[0].credentials.refreshToken, next.refreshToken)
  assert.equal(released, true)
  assert.doesNotMatch(result.error, /PRIVATE_PATH/)
})

test('a handoff rejects another account, altered generation or expiry, and expiry of the capability', () => {
  const handoffs = new SwitchHandoffStore()
  const credentials = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: 1000000 }
  const proof = handoffs.issue('synthetic-account', credentials, 1000)
  assert.throws(() => handoffs.consume(proof, 'other-account', credentials, 2000))
  assert.throws(() => handoffs.consume(proof, 'synthetic-account', { ...credentials, refreshToken: 'DIFFERENT' }, 2000))
  assert.throws(() => handoffs.consume(proof, 'synthetic-account', { ...credentials, expiresAt: 2000000 }, 2000))
  assert.throws(() => handoffs.consume(proof, 'synthetic-account', credentials, 62000))
})
