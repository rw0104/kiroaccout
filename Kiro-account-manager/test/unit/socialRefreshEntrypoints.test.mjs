import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { normalizeCredentialRecord } from '../../src/shared/accountImport.ts'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'
import { parseAccountUsage } from '../../src/shared/accountUsage.ts'
import { normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'
import { ControlPlaneError } from '../../src/main/kiroControlPlane.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const callbacks = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && ['verify-account-credentials', 'refresh-account-token', 'check-account-status'].includes(node.arguments[0]?.text)) {
    callbacks.set(node.arguments[0].text, node.arguments[1].getText(tree))
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'backgroundBatchRefresh') {
    callbacks.set('background', node.initializer.getText(tree))
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(callbacks.size, 4, 'extract the four actual production entrypoints')

const oldProfile = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/SYNTHETIC_OLD'
const newProfile = 'arn:aws:codewhisperer:us-east-1:111111111111:profile/SYNTHETIC_NEW'
const oldAccess = 'SYNTHETIC_ACCESS_OLD'
const oldRefresh = 'SYNTHETIC_REFRESH_OLD'
const newAccess = 'SYNTHETIC_ACCESS_NEW'
const newRefresh = 'SYNTHETIC_REFRESH_NEW'
const usage = { userInfo: { email: 'synthetic@example.invalid', userId: 'SYNTHETIC_USER' },
  subscriptionInfo: { subscriptionTitle: 'KIRO FREE' },
  usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 1, usageLimit: 50 }] }

function fixture(entrypoint, { provider = 'Google', responseProfile = newProfile, activeIde = false,
  queryFailure = false, existingProfile = oldProfile, needsTokenRefresh = true } = {}) {
  const social = ['Google', 'Github'].includes(provider)
  const queries = [], writes = [], events = [], refreshes = []
  const account = { id: 'SYNTHETIC_ACCOUNT', idp: provider, profileArn: existingProfile,
    credentials: { provider, authMethod: social ? 'social' : 'IdC', accessToken: oldAccess,
      refreshToken: oldRefresh, region: 'us-east-1', profileArn: existingProfile,
      ...(!social ? { clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET' } : {}) }, needsTokenRefresh }
  const context = vm.createContext({
    Error, Date, Set, Promise, setTimeout, ControlPlaneError, resolveIdentity, normalizeCredentialRecord,
    parseAccountUsage, normalizeSubscriptionType,
    console: { log() {}, warn() {}, error() {} }, proxyServer: null,
    instanceAccountOwnership: { assertAvailable() {}, isBound: () => false, beginOperation: () => () => {} },
    poolRefreshInFlightIds: new Set(), lastSwitchedAccountId: undefined,
    lastWrittenTokenSignature: undefined, proactiveRenewalEnabled: false,
    scheduleProactiveRenewal: () => assert.fail('must not enable proactive renewal'),
    mainWindow: { webContents: { send: (name, value) => events.push({ name, value }) } },
    refreshTokenByMethod: async (...args) => {
      refreshes.push(args)
      return { success: true, accessToken: newAccess, refreshToken: newRefresh, expiresIn: 3600,
        ...(responseProfile === null ? {} : { profileArn: responseProfile }) }
    },
    readKiroAuthTokenFile: async () => ({ refreshToken: activeIde ? oldRefresh : 'SYNTHETIC_OTHER_REFRESH', profileArn: oldProfile, provider }),
    resolveProfileArnForWrite: input => input.profileArn,
    writeKiroAuthTokenFile: async value => { writes.push(value) },
    fetchEnterpriseProfileArn: async () => undefined,
    getUserInfo: async () => ({ status: 'Active', idp: provider }),
    getUsageAndLimits: async (...args) => {
      queries.push(args)
      if (entrypoint === 'check-account-status' && args[0] === oldAccess) throw new Error('HTTP 401')
      if (queryFailure) throw new Error('SYNTHETIC_QUERY_FAILED')
      return usage
    }
  })
  vm.runInContext(ts.transpileModule(`globalThis.run = ${callbacks.get(entrypoint)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  return { account, queries, writes, events, refreshes,
    run: () => entrypoint === 'background' ? context.run([account], 1, true)
      : context.run(undefined, entrypoint === 'verify-account-credentials'
        ? { ...account.credentials, accessToken: undefined } : account) }
}

test('actual credential verification queries and returns the authenticated Social response profile', async () => {
  for (const provider of ['Google', 'Github']) for (const existingProfile of ['', oldProfile]) {
    const h = fixture('verify-account-credentials', { provider, existingProfile })
    const result = await h.run()
    assert.equal(result.success, true, result.error)
    assert.equal(h.queries[0][2], newProfile)
    assert.equal(result.data.profileArn, newProfile)
    assert.equal(h.refreshes.length, 1)
    assert.equal(h.writes.length, 0)
  }
})

test('actual manual refresh returns Social metadata and preserves the IDE synchronization condition', async () => {
  for (const provider of ['Google', 'Github']) for (const activeIde of [false, true]) {
    const h = fixture('refresh-account-token', { provider, activeIde })
    const result = await h.run()
    assert.equal(result.success, true)
    assert.equal(result.data.profileArn, newProfile)
    assert.equal(result.data.syncedToIde, activeIde)
    assert.equal(h.writes.length, activeIde ? 1 : 0)
    if (activeIde) assert.equal(h.writes[0].profileArn, newProfile)
    assert.equal(h.refreshes.length, 1)
  }
})

test('actual status retry carries Social profile in both successful and failed-query credentials', async () => {
  for (const queryFailure of [false, true]) {
    const h = fixture('check-account-status', { queryFailure })
    const result = await h.run()
    assert.equal(result.success, !queryFailure)
    assert.equal(h.queries.length, 2)
    assert.equal(h.queries[1][2], newProfile)
    assert.equal(result.data.newCredentials.profileArn, newProfile)
    assert.equal(result.data.newCredentials.refreshToken, newRefresh)
    assert.equal(h.refreshes.length, 1)
    assert.equal(h.writes.length, 0)
  }
})

test('actual background refresh carries Social profile into usage, IDE sync and the guarded event', async () => {
  for (const activeIde of [false, true]) for (const queryFailure of [false, true]) {
    const h = fixture('background', { activeIde, queryFailure })
    const result = await h.run()
    assert.equal(result.successCount, 1)
    assert.equal(h.queries[0][2], newProfile)
    assert.equal(h.writes.length, activeIde ? 1 : 0)
    if (activeIde) assert.equal(h.writes[0].profileArn, newProfile)
    const event = h.events.find(item => item.name === 'background-refresh-result').value
    assert.equal(event.data.profileArn, newProfile)
    assert.equal(event.expectedAccessToken, oldAccess)
    assert.equal(event.expectedRefreshToken, oldRefresh)
    assert.equal(h.refreshes.length, 1)
  }
})

test('all four actual entrypoints retain supplied profiles when Social refresh omits metadata', async () => {
  for (const entrypoint of callbacks.keys()) {
    const h = fixture(entrypoint, { responseProfile: null, activeIde: true })
    const result = await h.run()
    assert.ok(result.success)
    for (const query of h.queries) assert.equal(query[2], oldProfile)
    for (const write of h.writes) assert.equal(write.profileArn, oldProfile)
    const response = entrypoint === 'background' ? h.events.find(item => item.name === 'background-refresh-result').value.data : result.data
    assert.ok(response.profileArn === undefined || response.profileArn === oldProfile)
    assert.equal(response.newCredentials?.profileArn, undefined)
    assert.equal(h.refreshes.length, 1)
  }
})

test('IdC entrypoints ignore an unrelated response profile and preserve the existing organization profile', async () => {
  for (const entrypoint of callbacks.keys()) {
    const h = fixture(entrypoint, { provider: 'Enterprise', activeIde: true })
    const result = await h.run()
    assert.ok(result.success)
    for (const query of h.queries) assert.equal(query[2], oldProfile)
    for (const write of h.writes) assert.equal(write.profileArn, oldProfile)
    const response = entrypoint === 'background' ? h.events.find(item => item.name === 'background-refresh-result').value.data : result.data
    assert.notEqual(response.profileArn, newProfile)
    assert.notEqual(response.newCredentials?.profileArn, newProfile)
  }
})

test('background information-only checks do not refresh or invent new metadata', async () => {
  const h = fixture('background', { needsTokenRefresh: false, activeIde: true })
  const result = await h.run()
  assert.equal(result.successCount, 1)
  assert.equal(h.queries[0][2], oldProfile)
  assert.equal(h.refreshes.length, 0)
  assert.equal(h.writes.length, 0)
  assert.notEqual(h.events.find(item => item.name === 'background-refresh-result').value.data.profileArn, newProfile)
})
