import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import vm from 'node:vm'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'
import { normalizeTimestamp } from '../../src/shared/accountImport.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('main/index.ts', source, ts.ScriptTarget.Latest, true)
let handler
const visit = node => {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'load-kiro-credentials') handler = node.arguments[1].getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(handler, 'exercise the real main-process local-import IPC handler')
const compiled = ts.transpileModule(`globalThis.load = ${handler};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const hash = startUrl => createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
const builderUrl = 'https://view.awsapps.com/start'
const organizationUrl = 'https://synthetic-team.awsapps.com/start'
const registration = { clientId: 'SYNTHETIC_CLIENT_ID', clientSecret: 'SYNTHETIC_CLIENT_SECRET', clientSecretExpiresAt: 4_000_000_000 }
const token = patch => ({ accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
  profileArn: '  SYNTHETIC_PROFILE  ', region: 'us-east-1', ...patch })

function fixture(tokenData, registrations = {}) {
  const reads = []
  let scans = 0
  const logs = []
  const read = async filename => {
    const name = path.basename(filename)
    reads.push(name)
    if (name === 'kiro-auth-token.json') return JSON.stringify(tokenData)
    if (Object.hasOwn(registrations, name)) return JSON.stringify(registrations[name])
    throw Object.assign(new Error('SYNTHETIC_PRIVATE_IO_ERROR'), { code: 'ENOENT' })
  }
  const modules = {
    os: { homedir: () => path.resolve('synthetic-home-never-read') }, path,
    crypto: { createHash },
    'fs/promises': { readFile: read, readdir: async () => { scans++; return Object.keys(registrations) } }
  }
  const context = vm.createContext({
    require: name => { assert.ok(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name] },
    readFile: read, normalizeTimestamp, resolveIdentity,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  })
  vm.runInContext(compiled, context)
  return { run: async () => JSON.parse(JSON.stringify(await context.load())), reads, scans: () => scans, logs }
}

for (const provider of ['Google', 'Github', ' google ', 'GITHUB']) {
  test(`Social ${provider} imports the saved profile without touching unrelated registration`, async () => {
    const f = fixture(token({ provider, startUrl: organizationUrl, clientIdHash: hash(builderUrl) }), {
      [`${hash(builderUrl)}.json`]: registration
    })
    const result = await f.run()
    assert.equal(result.success, true)
    assert.equal(result.data.profileArn, 'SYNTHETIC_PROFILE')
    assert.equal(result.data.provider, provider.trim().toLowerCase() === 'google' ? 'Google' : 'Github')
    assert.equal(result.data.authMethod, 'social')
    assert.equal(result.data.clientId, '')
    assert.equal(result.data.clientSecret, '')
    assert.equal(Object.hasOwn(result.data, 'clientSecretExpiresAt'), false)
    assert.equal(Object.hasOwn(result.data, 'startUrl'), false)
    assert.deepEqual(f.reads, ['kiro-auth-token.json'])
    assert.equal(f.scans(), 0)
    assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_ACCESS'), false)
    assert.equal(JSON.stringify(f.logs).includes('SYNTHETIC_REFRESH'), false)
  })
}

for (const provider of ['Enterprise', 'IAM_SSO', 'aws-idc']) {
  test(`${provider} imports its profile and organization URL using the saved URL registration hash`, async () => {
    const f = fixture(token({ provider, authMethod: 'oidc', startUrl: ` ${organizationUrl} ` }), {
      [`${hash(builderUrl)}.json`]: { ...registration, clientId: 'SYNTHETIC_UNRELATED_CLIENT' },
      [`${hash(organizationUrl)}.json`]: registration
    })
    const result = await f.run()
    assert.equal(result.success, true)
    assert.equal(result.data.profileArn, 'SYNTHETIC_PROFILE')
    assert.equal(result.data.startUrl, organizationUrl)
    assert.equal(result.data.provider, provider === 'IAM_SSO' ? 'IAM_SSO' : 'Enterprise')
    assert.equal(result.data.authMethod, 'IdC')
    assert.equal(result.data.clientId, registration.clientId)
    assert.equal(result.data.clientSecretExpiresAt, registration.clientSecretExpiresAt)
    assert.deepEqual(f.reads, ['kiro-auth-token.json', `${hash(organizationUrl)}.json`])
    assert.equal(f.scans(), 0)
  })
}

test('explicit registration hash retains precedence and ISO registration expiry remains supported', async () => {
  const explicitHash = 'a'.repeat(40)
  const f = fixture(token({ provider: 'Enterprise', authMethod: 'IdC', startUrl: organizationUrl, clientIdHash: explicitHash }), {
    [`${explicitHash}.json`]: { clientId: registration.clientId, clientSecret: registration.clientSecret, expiresAt: '2030-01-01T00:00:00Z' }
  })
  const result = await f.run()
  assert.equal(result.success, true)
  assert.equal(result.data.startUrl, organizationUrl)
  assert.equal(result.data.clientSecretExpiresAt, Date.parse('2030-01-01T00:00:00Z') / 1000)
  assert.deepEqual(f.reads, ['kiro-auth-token.json', `${explicitHash}.json`])
})

test('Builder and legacy IdC preserve registration compatibility without returning organization URLs', async () => {
  for (const identity of [{ provider: 'aws builder id' }, { authMethod: 'IdC' }, {}]) {
    const f = fixture(token({ ...identity, startUrl: organizationUrl }), { [`${hash(builderUrl)}.json`]: registration })
    const result = await f.run()
    assert.equal(result.success, true)
    assert.equal(result.data.provider, 'BuilderId')
    assert.equal(result.data.authMethod, 'IdC')
    assert.equal(result.data.clientId, registration.clientId)
    assert.equal(result.data.clientSecretExpiresAt, registration.clientSecretExpiresAt)
    assert.equal(result.data.profileArn, 'SYNTHETIC_PROFILE')
    assert.equal(Object.hasOwn(result.data, 'startUrl'), false)
  }
})

test('missing and blank optional metadata remains absent instead of inventing a profile', async () => {
  for (const profileArn of [undefined, '', '   ']) {
    const f = fixture(token({ provider: 'Github', authMethod: ' SOCIAL ', profileArn }))
    const result = await f.run()
    assert.equal(result.success, true)
    assert.equal(Object.hasOwn(result.data, 'profileArn'), false)
    assert.equal(Object.hasOwn(result.data, 'startUrl'), false)
    assert.deepEqual(f.reads, ['kiro-auth-token.json'])
    assert.equal(f.scans(), 0)
  }
})

test('identity conflicts, unsupported providers and Social without a provider fail before registration IO', async () => {
  for (const identity of [{ provider: 'Google', authMethod: 'IdC' }, { provider: 'BuilderId', authMethod: 'social' },
    { provider: 'SYNTHETIC_PRIVATE_PROVIDER' }, { authMethod: 'social' }]) {
    const f = fixture(token(identity), { [`${hash(builderUrl)}.json`]: registration })
    const result = await f.run()
    assert.equal(result.success, false)
    assert.equal(result.data, undefined)
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false)
    assert.deepEqual(f.reads, ['kiro-auth-token.json'])
    assert.equal(f.scans(), 0)
  }
})
