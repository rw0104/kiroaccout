import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { normalizeCredentialRecord } from '../../src/shared/accountImport.ts'
import * as registrationRecovery from '../../src/shared/oidcRegistration.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const now = Date.parse('2026-10-22T12:00:00Z')
const expires = now + 30 * 86400000
const base = {
  accessToken: 'SYNTHETIC_ACCESS',
  refreshToken: 'SYNTHETIC_REFRESH',
  expiresAtIso: new Date(now + 3600000).toISOString(),
  authMethod: 'IdC',
  provider: 'BuilderId',
  clientId: 'SYNTHETIC_CLIENT',
  clientSecret: 'SYNTHETIC_SECRET',
  clientSecretExpiresAt: expires / 1000
}
const source = readFileSync(new URL('../../src/main/kiroAuthSync.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const legacySecret = (clientId = base.clientId, deadline = expires / 1000 + 0.180562) =>
  [
    { alg: 'RS256', typ: 'JWT' },
    { serialized: JSON.stringify({ clientId: { value: clientId }, expirationTimestamp: deadline }) }
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.U1lOVEhFVElD'

const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const mainTree = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
let switchHandler
function findSwitch(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'switch-account') {
    switchHandler = node.arguments[1].getText(mainTree)
  }
  ts.forEachChild(node, findSwitch)
}
findSwitch(mainTree)
assert.ok(switchHandler)

// Execute the complete module with filesystem and home replaced before evaluation.
// No production paths, cache reads, writes, listeners or Electron are reachable.
function harness({ registrationFailure = false } = {}) {
  const calls = [],
    files = new Map(),
    exports = {}
  vm.runInNewContext(code, {
    exports,
    Buffer,
    Error,
    Date: class extends Date {
      static now() {
        return now
      }
    },
    require(name) {
      if (name === '../shared/oidcRegistration') return registrationRecovery
      if (name === 'fs/promises')
        return {
          async mkdir(path, options) {
            calls.push(['mkdir', path, options])
          },
          async writeFile(path, content, options) {
            calls.push(['write', path, options])
            if (registrationFailure && !path.endsWith('kiro-auth-token.json'))
              throw new Error('SYNTHETIC_DISK_FAILURE')
            files.set(path, JSON.parse(content))
          },
          async chmod(path, mode) {
            calls.push(['chmod', path, mode])
          }
        }
      if (name === 'fs')
        return {
          watchFile() {
            throw new Error('Watcher must remain disabled')
          }
        }
      if (name === 'os') return { homedir: () => 'SYNTHETIC_HOME' }
      if (['path', 'crypto'].includes(name)) return require(name)
      throw new Error(`Unexpected module: ${name}`)
    }
  })
  return { ...exports, calls, files }
}

function switching({ refreshFailure = false } = {}) {
  const h = harness(), refreshes = []
  const context = vm.createContext({
    ...h,
    Error,
    Date: class extends Date { static now() { return now } },
    console: { log() {}, warn() {}, error() {} },
    instanceAccountOwnership: { assertAvailable() {} },
    refreshTokenByMethod: async (...args) => {
      refreshes.push(args)
      return refreshFailure
        ? { success: false, error: 'HTTP 401: 客户端注册已失效，请重新登录' }
        : { success: true, accessToken: 'SYNTHETIC_ACCESS_2', refreshToken: 'SYNTHETIC_REFRESH_2', expiresIn: 3600 }
    },
    switchHandoffs: { issue: () => 'SYNTHETIC_HANDOFF' },
    proactiveRenewalEnabled: false,
    lastSwitchedAccountId: undefined,
    lastWrittenTokenSignature: undefined
  })
  vm.runInContext(ts.transpileModule(`globalThis.switchAccount = ${switchHandler}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  return { ...h, refreshes, run: credentials => context.switchAccount(undefined, credentials) }
}

test('legacy IdC account switches through the real IPC using the matching secret registration deadline', async () => {
  const h = switching()
  const result = await h.run({ ...base, accountId: 'synthetic-account', clientSecret: legacySecret(), clientSecretExpiresAt: undefined })
  assert.equal(result.success, true, result.error)
  assert.equal(h.refreshes.length, 1)
  assert.equal(h.refreshes[0][2], legacySecret(), 'the original secret must be verified upstream')
  const token = [...h.files.values()].find(value => value.accessToken)
  const registration = [...h.files.values()].find(value => value.clientId)
  assert.equal(registration.expiresAt, new Date(expires).toISOString())
  assert.equal(token.refreshToken, 'SYNTHETIC_REFRESH_2')
  assert.equal(result.refreshedCredentials.refreshToken, token.refreshToken)
  assert.equal(result.preparedExpiresAt, now + 3600000)
})

test('decoded registration metadata never bypasses the real switch refresh or publishes rejected credentials', async () => {
  const h = switching({ refreshFailure: true })
  const result = await h.run({ ...base, clientSecret: legacySecret(), clientSecretExpiresAt: undefined })
  assert.equal(result.success, false)
  assert.equal(h.refreshes.length, 1)
  assert.match(result.error, /HTTP 401/)
  assert.equal(h.files.size, 0)
  assert.deepEqual(h.calls, [])
})

test('legacy recovery cannot borrow another client deadline or replace a known expired deadline', async () => {
  for (const extra of [
    { clientSecret: legacySecret('another-client'), clientSecretExpiresAt: undefined },
    { clientSecret: legacySecret(), clientSecretExpiresAt: now / 1000 - 1 },
    { clientSecret: legacySecret(base.clientId, (now + 900000) / 1000), clientSecretExpiresAt: undefined }
  ]) {
    const h = switching()
    assert.equal((await h.run({ ...base, ...extra })).success, false)
    assert.equal(h.refreshes.length, 0)
    assert.equal(h.files.size, 0)
  }
})

test('actual IDE cache writer stores the genuine OIDC registration expiry with UTC Z and writes registration before token', async () => {
  const h = harness()
  const result = await h.writeKiroAuthTokenFile(base)
  const registration = h.files.get(result.clientRegPath)
  assert.equal(registration.expiresAt, new Date(expires).toISOString())
  assert.equal(registration.clientId, base.clientId)
  assert.equal(registration.clientSecret, base.clientSecret)
  assert.deepEqual(Object.keys(registration).sort(), ['clientId', 'clientSecret', 'expiresAt'])
  const token = h.files.get(result.tokenPath)
  assert.equal(token.accessToken, base.accessToken)
  assert.ok(result.clientRegPath.endsWith(`${token.clientIdHash}.json`))
  const writes = h.calls.filter((call) => call[0] === 'write')
  assert.equal(writes[0][1], result.clientRegPath)
  assert.equal(writes[1][1], result.tokenPath)
  assert.equal(
    writes.every((call) => call[2].mode === 0o600),
    true
  )
})

test('missing, invalid, expired or near-expiry registrations reject before any filesystem operation', async () => {
  const invalid = [
    { clientId: undefined },
    { clientSecret: '   ' },
    { clientSecretExpiresAt: undefined },
    { clientSecretExpiresAt: NaN },
    { clientSecretExpiresAt: Infinity },
    { clientSecretExpiresAt: 1e30 },
    { clientSecretExpiresAt: now / 1000 - 1 },
    { clientSecretExpiresAt: (now + 900000) / 1000 },
    { clientSecretExpiresAt: 'invalid-private-value' }
  ]
  for (const extra of invalid) {
    const h = harness()
    await assert.rejects(
      h.writeKiroAuthTokenFile({ ...base, ...extra }),
      (error) => /重新授权/.test(error.message) && !/SYNTHETIC|private-value/.test(error.message)
    )
    assert.deepEqual(h.calls, [])
    assert.equal(h.files.size, 0)
  }
})

test('preflight normalizes imported seconds without I/O and preserves historical millisecond values', () => {
  const parsed = normalizeCredentialRecord({
    provider: 'BuilderId',
    authMethod: 'IdC',
    refreshToken: base.refreshToken,
    clientId: base.clientId,
    clientSecret: base.clientSecret,
    clientSecretExpiresAt: new Date(expires).toISOString()
  })
  assert.ok(parsed.credential)
  const h = harness()
  const registration = h.validateKiroClientRegistration(parsed.credential, now)
  assert.equal(registration.expiresAt, new Date(expires).toISOString())
  assert.equal(
    h.validateKiroClientRegistration({ ...base, clientSecretExpiresAt: expires }, now).expiresAt,
    registration.expiresAt
  )
  assert.deepEqual(h.calls, [])
})

test('a registration write failure never publishes the new token and social login requires no registration', async () => {
  const failed = harness({ registrationFailure: true })
  await assert.rejects(failed.writeKiroAuthTokenFile(base), /SYNTHETIC_DISK_FAILURE/)
  assert.equal(
    [...failed.files.keys()].some((path) => path.endsWith('kiro-auth-token.json')),
    false
  )
  const social = harness()
  const result = await social.writeKiroAuthTokenFile({
    ...base,
    authMethod: 'social',
    provider: 'Google',
    clientId: undefined,
    clientSecret: undefined,
    clientSecretExpiresAt: undefined
  })
  assert.equal(result.clientRegPath, undefined)
  assert.equal(social.files.size, 1)
  assert.equal(social.files.get(result.tokenPath).clientIdHash, undefined)
})
