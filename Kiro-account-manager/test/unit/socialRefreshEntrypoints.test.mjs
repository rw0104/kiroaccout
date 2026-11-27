import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { accountProbeFailure, userInfoFailure, preserveRefreshStatus } from '../../src/main/accountProbe.ts'
import { normalizeCredentialRecord } from '../../src/shared/accountImport.ts'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'
import { parseAccountUsage } from '../../src/shared/accountUsage.ts'
import { normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'
import { ControlPlaneError } from '../../src/main/kiroControlPlane.ts'
import { TokenRefreshService, refreshFailureDiagnostic } from '../../src/main/authRefresh.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let batchCheck
const callbacks = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && ['verify-account-credentials', 'refresh-account-token', 'check-account-status'].includes(node.arguments[0]?.text)) {
    callbacks.set(node.arguments[0].text, node.arguments[1].getText(tree))
  }
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'background-batch-check') batchCheck = node.arguments[1].getText(tree)
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
  historicalSwitch = false, queryFailure = false, existingProfile = oldProfile, needsTokenRefresh = true, probeError, userInfoError, refreshFailure } = {}) {
  const social = ['Google', 'Github'].includes(provider)
  const queries = [], writes = [], events = [], refreshes = [], logs = []
  const account = { id: 'SYNTHETIC_ACCOUNT', idp: provider, profileArn: existingProfile,
    credentials: { provider, authMethod: social ? 'social' : 'IdC', accessToken: oldAccess,
      refreshToken: oldRefresh, region: 'us-east-1', profileArn: existingProfile,
      ...(!social ? { clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET' } : {}) }, needsTokenRefresh }
  const context = vm.createContext({
    accountProbeFailure, userInfoFailure, preserveRefreshStatus, refreshFailureDiagnostic,
    Error, Date, Set, Promise, setTimeout, ControlPlaneError, resolveIdentity, normalizeCredentialRecord,
    parseAccountUsage, normalizeSubscriptionType,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }, proxyServer: null,
    instanceAccountOwnership: { assertAvailable() {}, isBound: () => false, beginOperation: () => () => {} },
    poolRefreshInFlightIds: new Set(), lastSwitchedAccountId: historicalSwitch ? account.id : undefined,
    lastWrittenTokenSignature: undefined, proactiveRenewalEnabled: false,
    scheduleProactiveRenewal: () => assert.fail('must not enable proactive renewal'),
    mainWindow: { webContents: { send: (name, value) => events.push({ name, value }) } },
    refreshTokenByMethod: async (...args) => {
      refreshes.push(args)
      if (refreshFailure) return typeof refreshFailure === 'function' ? refreshFailure() : refreshFailure
      return { success: true, accessToken: newAccess, refreshToken: newRefresh, expiresIn: 3600,
        ...(responseProfile === null ? {} : { profileArn: responseProfile }) }
    },
    readMatchingKiroAuthToken: async () => activeIde ? { accessToken: oldAccess, refreshToken: oldRefresh, profileArn: oldProfile, provider } : null,
    updateKiroAuthTokenFile: async (generation, rotation) => {
      writes.push({ ...generation, ...rotation, profileArn: rotation.profileArn ?? generation.profileArn })
      return true
    },
    fetchEnterpriseProfileArn: async () => undefined,
    getUserInfo: async () => { if (userInfoError) throw userInfoError; return { status: 'Active', idp: provider } },
    kiroApiRequest: async () => { if (userInfoError) throw userInfoError; return { status: 'Active', idp: provider } },
    getUsageAndLimits: async (...args) => {
      queries.push(args)
      if (probeError) throw probeError
      if (entrypoint === 'check-account-status' && args[0] === oldAccess) throw new Error('HTTP 401')
      if (queryFailure) throw new Error('SYNTHETIC_QUERY_FAILED')
      return usage
    }
  })
  vm.runInContext(ts.transpileModule(`globalThis.run = ${entrypoint === 'batch-check' ? batchCheck : callbacks.get(entrypoint)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  return { account, queries, writes, events, refreshes, logs,
    run: (items = [account]) => entrypoint === 'batch-check' ? context.run(undefined, items, items.length) : entrypoint === 'background' ? context.run(items, items.length, true)
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
    assert.equal(result.successCount, queryFailure ? 0 : 1)
    assert.equal(result.failedCount, queryFailure ? 1 : 0)
    const summary = h.logs.find(args => args[0] === '[BackgroundRefresh] Failure summary:')
    if (queryFailure) {
      assert.equal(JSON.parse(summary[1])[0].stage, 'probe')
      assert.equal(JSON.parse(summary[1])[0].count, 1)
    } else assert.equal(summary, undefined)
    assert.equal(h.queries[0][2], newProfile)
    assert.equal(h.writes.length, activeIde ? 1 : 0)
    if (activeIde) assert.equal(h.writes[0].profileArn, newProfile)
    const event = h.events.find(item => item.name === 'background-refresh-result').value
    assert.equal(event.success, !queryFailure)
    assert.equal(event.credentialsRefreshed, true)
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


test('delayed manual and background refresh cannot replace another IDE login using historical switch state', async () => {
  for (const entrypoint of ['refresh-account-token', 'background']) {
    const h = fixture(entrypoint, { historicalSwitch: true })
    const result = await h.run()
    assert.ok(result.success)
    assert.equal(h.writes.length, 0, entrypoint)
  }
})

test('batch status events distinguish explicit token rejection, suspension and inconclusive checks', async () => {
  const tokenError = new ControlPlaneError('request_failed', 400, { serviceCode: 'AccessDeniedException', reason: 'token' })
  for (const [probeError, userInfoError, status] of [
    [tokenError, undefined, 'expired'],
    [new Error('HTTP 401'), undefined, 'expired'],
    [new ControlPlaneError('timeout'), undefined, undefined],
    [new ControlPlaneError('missing_profile'), undefined, undefined],
    [new ControlPlaneError('request_failed', 403, { serviceCode: 'AccessDeniedException' }), undefined, undefined],
    [new ControlPlaneError('request_failed', 400, { serviceCode: 'AccountSuspendedException' }), undefined, 'error'],
    [new Error('request 423 failed for private@example.invalid'), undefined, undefined],
    [new Error('HTTP 503'), new Error('HTTP 423'), 'error'],
    [new Error('HTTP 403: AccountSuspendedException: denied'), undefined, 'error']
  ]) {
    const h = fixture('batch-check', { probeError, userInfoError })
    const result = await h.run()
    const { value: event } = h.events.find(item => item.name === 'background-check-result')
    assert.equal(result.successCount, 0)
    assert.equal(result.failedCount, 1)
    assert.equal(event.success, false)
    assert.equal(event.data?.status, status)
    assert.equal(!!event.preserveStatus, status === undefined)
    assert.doesNotMatch(event.error, /private@example/)
  }
})

test('failed renewal preserves health for unconfirmed failures and reports definitive credential rejection', async () => {
  for (const kind of ['temporary', 'uncertain', 'reauth-required']) {
    for (const entrypoint of ['refresh-account-token', 'background', 'check-account-status']) {
      const h = fixture(entrypoint, { refreshFailure: { success: false, failureKind: kind, error: 'Refresh rejected' } })
      const result = await h.run()
      const reply = entrypoint === 'background' ? h.events.find(item => item.name === 'background-refresh-result').value : result
      assert.equal(reply.success, false)
      assert.equal(!!reply.preserveStatus, kind !== 'reauth-required', entrypoint)
    }
  }
})

test('info-only refresh with two unavailable probes cannot clear an existing account error', async () => {
  const h = fixture('background', { needsTokenRefresh: false, probeError: new ControlPlaneError('timeout'), userInfoError: new Error('HTTP 503') })
  const result = await h.run()
  const event = h.events.find(item => item.name === 'background-refresh-result').value
  assert.equal(result.failedCount, 1)
  assert.equal(event.success, false)
  assert.equal(event.preserveStatus, true)
})

test('real refresh refusals preserve account health through each production renewal entrypoint', async () => {
  for (const status of [400, 403, 404, 422]) {
    const service = new TokenRefreshService({
      fetch: async () => ({ ok: false, status, json: async () => ({}) }),
      socialEndpoint: 'https://synthetic.invalid', socialUserAgent: () => 'synthetic-test'
    })
    const refreshFailure = await service.refresh({ kind: 'social', refreshToken: oldRefresh })
    for (const entrypoint of ['refresh-account-token', 'background', 'check-account-status']) {
      const h = fixture(entrypoint, { refreshFailure })
      const result = await h.run()
      const reply = entrypoint === 'background' ? h.events.find(item => item.name === 'background-refresh-result').value : result
      assert.equal(reply.success, false)
      assert.equal(reply.preserveStatus, true, `${entrypoint}: HTTP ${status}`)
      if (entrypoint === 'background') {
        assert.equal(result.successCount, 0)
        assert.equal(result.failedCount, 1)
      }
      assert.equal(h.refreshes.length, 1)
      assert.equal(h.writes.length, 0)
    }
  }
})

test('batch queries retain profiles when older records populate only one saved profile field', async () => {
  for (const entrypoint of ['batch-check', 'background']) {
    for (const profileLocation of ['account', 'credentials']) {
      const h = fixture(entrypoint, { needsTokenRefresh: false })
      if (profileLocation === 'account') delete h.account.credentials.profileArn
      else delete h.account.profileArn
      const result = await h.run()
      assert.equal(result.successCount, 1)
      assert.equal(result.failedCount, 0)
      assert.equal(h.queries[0][2], oldProfile)
      assert.equal(h.refreshes.length, 0)
    }
  }
})

test('actual manual refusal logs only safe diagnostic fields from the current operation', async () => {
  const h = fixture('refresh-account-token', { refreshFailure: {
    success: false, errorCode: 'http', httpStatus: 403, serviceCode: 'access_denied',
    failureKind: 'reauth-required', preserveStatus: true, error: 'SYNTHETIC_PRIVATE', refreshToken: oldRefresh
  } })
  const result = await h.run()
  assert.equal(result.success, false)
  const entries = h.logs.filter(args => args[0] === '[AccountRefresh] Failed:')
  assert.equal(entries.length, 1)
  const diagnostic = JSON.parse(entries[0][1])
  assert.equal(diagnostic.httpStatus, 403)
  assert.equal(diagnostic.serviceCode, 'access_denied')
  assert.equal(diagnostic.preserveStatus, true)
  assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC|profile|refreshToken|accessToken|email/)
})

test('actual batch refusal diagnostics aggregate repeated failures without account identifiers', async () => {
  const h = fixture('background', { refreshFailure: {
    success: false, errorCode: 'http', httpStatus: 403, responseFormat: 'html',
    failureKind: 'reauth-required', preserveStatus: true, error: 'SYNTHETIC_PRIVATE'
  } })
  const result = await h.run(Array.from({ length: 5 }, (_, i) => ({ ...h.account, id: `SYNTHETIC_${i}` })))
  assert.equal(result.failedCount, 5)
  const entries = h.logs.filter(args => args[0] === '[BackgroundRefresh] Failure summary:')
  assert.equal(entries.length, 1)
  const summary = JSON.parse(entries[0][1])
  assert.equal(summary.length, 1)
  assert.equal(summary[0].count, 5)
  assert.equal(summary[0].stage, 'refresh')
  assert.equal(summary[0].authMethod, 'social')
  assert.equal(summary[0].httpStatus, 403)
  assert.equal(summary[0].responseFormat, 'html')
  assert.equal(summary[0].serviceCode, undefined)
  assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC|profile|refreshToken|accessToken|email/)
})

test('batch diagnostic categories are capped and unknown fields never enter logs', async () => {
  let index = 0
  const h = fixture('background', { refreshFailure: () => ({
    success: false, errorCode: 'SYNTHETIC_PRIVATE', httpStatus: 400 + index++,
    serviceCode: 'SYNTHETIC_PRIVATE', responseFormat: 'SYNTHETIC_PRIVATE', failureKind: 'SYNTHETIC_PRIVATE', error: 'SYNTHETIC_PRIVATE'
  }) })
  const result = await h.run(Array.from({ length: 40 }, (_, i) => ({ ...h.account, id: `SYNTHETIC_${i}` })))
  assert.equal(result.failedCount, 40)
  const entries = h.logs.filter(args => args[0] === '[BackgroundRefresh] Failure summary:')
  assert.equal(entries.length, 1)
  const summary = JSON.parse(entries[0][1])
  assert.ok(summary.length <= 33)
  assert.equal(summary.reduce((total, item) => total + item.count, 0), 40)
  assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC|profile|refreshToken|accessToken|email/)
})
