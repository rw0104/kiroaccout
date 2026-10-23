import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { normalizeCredentialRecord } from '../../src/shared/accountImport.ts'

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

// Execute the complete module with filesystem and home replaced before evaluation.
// No production paths, cache reads, writes, listeners or Electron are reachable.
function harness({ registrationFailure = false } = {}) {
  const calls = [],
    files = new Map(),
    exports = {}
  vm.runInNewContext(code, {
    exports,
    Buffer,
    Date: class extends Date {
      static now() {
        return now
      }
    },
    require(name) {
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
