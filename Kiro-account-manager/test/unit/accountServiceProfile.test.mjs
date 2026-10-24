import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { requestControlPlane, ControlPlaneError } from '../../src/main/kiroControlPlane.ts'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'
import { parseAccountUsage, normalizeUsageDate } from '../../src/shared/accountUsage.ts'
import { normalizeSubscriptionType } from '../../src/shared/accountSubscription.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const names = ['getUsageLimitsRest', 'normalizeUsageExpiry', 'normalizeUsageResponse', 'getUsageAndLimits']
const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree)).join('\n')
let checkHandler
const walk = node => {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'check-account-status') checkHandler = node.arguments[1].getText(tree)
  ts.forEachChild(node, walk)
}
walk(tree)
assert.ok(checkHandler)
const builderProfile = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
const socialProfile = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

function fixture(provider, profileArn, region = 'us-east-1', options = {}) {
  const calls = []
  const refreshCalls = []
  let refreshes = 0
  const expectedProfile = profileArn || (['Github', 'Google'].includes(provider) ? socialProfile : builderProfile)
  const context = vm.createContext({
    Error, Date, ControlPlaneError, resolveIdentity, requestControlPlane, normalizeUsageDate, parseAccountUsage, normalizeSubscriptionType,
    currentUsageApiType: 'rest', proxyServer: null, getKProxyAgent: () => undefined,
    console: { log() {}, error() {}, warn() {} },
    getUserInfo: async () => ({ status: 'Active', idp: provider }),
    refreshTokenByMethod: async (...args) => {
      refreshes++; refreshCalls.push(args)
      if (!options.allowRefresh) throw new Error('Synthetic test must never refresh')
      return { success: true, accessToken: 'SYNTHETIC_ACCESS_NEW', refreshToken: 'SYNTHETIC_REFRESH_NEW', expiresIn: 3600 }
    },
    fetchWithAppProxy: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body, headers: init.headers })
      if (body.profileArn !== expectedProfile) return Response.json({ __type: 'ValidationException', message: 'Invalid profileArn.' }, { status: 400 })
      if (options.error && calls.length <= (options.failures ?? 1)) return Response.json(options.error, { status: 400 })
      return Response.json({ userInfo: { email: 'synthetic@example.invalid', userId: 'synthetic-user' },
        subscriptionInfo: { subscriptionTitle: 'KIRO FREE' }, usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 5, usageLimit: 50 }] })
    }
  })
  vm.runInContext(ts.transpileModule(`${functions}\nglobalThis.check=${checkHandler};globalThis.usage=getUsageAndLimits`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  const account = { id: 'synthetic-account', idp: provider, profileArn, subscription: { type: 'Free' }, credentials: {
    accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', region,
    authMethod: ['Google', 'Github'].includes(provider) ? 'social' : 'IdC', provider,
    ...(!['Google', 'Github'].includes(provider) ? { clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET' } : {})
  } }
  return { account, calls, refreshCalls, get refreshes() { return refreshes }, check: input => context.check(undefined, input ?? account),
    usage: () => context.usage('SYNTHETIC_ACCESS', provider, profileArn, undefined, region) }
}

test('actual manual account checks send official default profiles for older Github, Google and Builder records', async () => {
  for (const provider of ['Github', 'Google', 'BuilderId']) {
    const h = fixture(provider)
    assert.equal(h.account.profileArn, undefined)
    assert.equal(h.account.credentials.profileArn, undefined)
    const result = await h.check()
    assert.equal(result.success, true, `${provider}: ${result.error?.message}`)
    assert.equal(result.data.usage.current, 5)
    assert.equal(result.data.usage.limit, 50)
    assert.equal(h.calls.length, 1)
    assert.equal(h.refreshes, 0)
    assert.equal(h.calls[0].body.profileArn, provider === 'BuilderId' ? builderProfile : socialProfile)
  }
})

test('actual checks resolve legacy Social provider from the account idp when the credential provider is absent', async () => {
  const h = fixture('Github')
  delete h.account.credentials.provider
  const result = await h.check()
  assert.equal(result.success, true)
  assert.equal(h.calls[0].body.profileArn, socialProfile)
  assert.equal(h.calls[0].headers.TokenType, undefined)
  assert.equal(h.refreshes, 0)
})

test('manual check uses a legacy Github idp when credential provider and auth method are both absent', async () => {
  const h = fixture('Github')
  delete h.account.credentials.provider
  delete h.account.credentials.authMethod
  // Supply a genuine selected profile so this test isolates the header identity,
  // independently of whether the shared default-profile fix has landed yet.
  h.account.profileArn = socialProfile
  const result = await h.check()
  assert.equal(result.success, true)
  assert.equal(h.calls[0].headers.TokenType, undefined, 'Social access tokens must not be labelled SSO_OIDC')
  assert.equal(h.refreshes, 0)
})

test('actual usage wrapper preserves a selected organization profile and its service region', async () => {
  const organizationProfile = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC_ORG'
  const h = fixture('Enterprise', organizationProfile, 'eu-west-1')
  await h.usage()
  assert.equal(h.calls[0].body.profileArn, organizationProfile)
  assert.equal(h.calls[0].url, 'https://management.eu-central-1.kiro.dev/')
  assert.equal(h.calls[0].headers.TokenType, 'SSO_OIDC')
  assert.equal(h.refreshes, 0)
})

test('a typed invalid-profile HTTP 400 never consumes a refresh token', async () => {
  const h = fixture('Github', socialProfile, 'us-east-1', { error: { __type: 'ValidationException', message: 'Invalid profileArn.' } })
  const result = await h.check()
  assert.equal(result.success, false)
  assert.match(result.error.message, /HTTP 400/)
  assert.equal(h.refreshes, 0)
  assert.equal(h.calls.length, 1)
})

test('a typed expired-token HTTP 400 permits one refresh on the normalized Social route and then checks again', async () => {
  const h = fixture('Github', socialProfile, 'us-east-1', { allowRefresh: true, error: { __type: 'AccessDeniedException', message: 'Invalid token.' } })
  delete h.account.credentials.provider
  delete h.account.credentials.authMethod
  const result = await h.check()
  assert.equal(result.success, true)
  assert.equal(h.refreshes, 1)
  assert.equal(h.refreshCalls[0][4], 'social')
  assert.equal(h.calls.length, 2)
  assert.equal(result.data.newCredentials.refreshToken, 'SYNTHETIC_REFRESH_NEW')
})

test('a second token error does not recursively refresh and generic access denial cannot trigger refresh', async () => {
  const h = fixture('Github', socialProfile, 'us-east-1', { allowRefresh: true, failures: 2, error: { __type: 'AccessDeniedException', message: 'Invalid token.' } })
  const result = await h.check()
  assert.equal(result.success, false)
  assert.equal(h.refreshes, 1)
  assert.equal(h.calls.length, 2)
  assert.equal(result.data.newCredentials.refreshToken, 'SYNTHETIC_REFRESH_NEW')
  const denied = fixture('Github', socialProfile, 'us-east-1', { error: { __type: 'AccessDeniedException', message: 'Organization policy denied access.' } })
  assert.equal((await denied.check()).success, false)
  assert.equal(denied.refreshes, 0)
})
