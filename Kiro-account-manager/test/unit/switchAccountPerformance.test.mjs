import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { SwitchHandoffStore } from '../../src/main/switchHandoff.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let handler
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'registerUnboundAccountHandler' && node.arguments[0]?.text === 'switch-account') handler = node.arguments[1].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(handler)
const script = ts.transpileModule(`const handler = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const now = Date.parse('2030-01-01T00:00:00Z')
function fixture(overrides = {}) {
  const credentials = { accountId: 'synthetic', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
    authMethod: 'social', provider: 'Github', region: 'us-east-1', clientId: '', clientSecret: '' }
  const saved = { status: 'active', credentials: { ...credentials, expiresAt: now + 3600000, ...overrides.saved } }
  let refreshes = 0
  const writes = []
  const context = vm.createContext({ Date: class extends Date { static now() { return now } },
    console: { log() {}, warn() {}, error() {} },
    instanceAccountOwnership: { assertAvailable() {} }, validateKiroClientRegistration() {},
    store: { get: () => ({ accounts: { synthetic: saved } }) },
    refreshTokenByMethod: async () => { refreshes++; return { success: true, accessToken: 'SYNTHETIC_ROTATED_ACCESS', refreshToken: 'SYNTHETIC_ROTATED_REFRESH', expiresIn: 3600 } },
    resolveProfileArnForWrite: () => undefined,
    writeKiroAuthTokenFile: async (input, assertCurrent) => {
      if (overrides.rotateBeforeWrite) saved.credentials = { ...saved.credentials, accessToken: 'SYNTHETIC_NEWER_ACCESS' }
      assertCurrent?.()
      writes.push(input)
      return { tokenPath: 'synthetic-cache' }
    },
    lastSwitchedAccountId: undefined, lastWrittenTokenSignature: undefined, proactiveRenewalEnabled: false,
    switchHandoffs: new SwitchHandoffStore()
  })
  vm.runInContext(script, context)
  return { call: input => vm.runInContext('handler', context)({}, { ...credentials, ...input }), writes, get refreshes() { return refreshes } }
}

test('IDE switch reuses the durable current healthy credential with ample lifetime without a network rotation', async () => {
  const h = fixture()
  const result = await h.call()
  assert.equal(result.success, true)
  assert.equal(h.refreshes, 0)
  assert.equal(h.writes[0].accessToken, 'SYNTHETIC_ACCESS')
  assert.equal(h.writes[0].expiresAtIso, new Date(now + 3600000).toISOString())
  assert.equal(result.preparedExpiresAt, now + 3600000)
  assert.ok(result.handoffProof)
})

test('IDE switch still refreshes missing, near-expiry and non-finite stored lifetimes', async () => {
  for (const expiresAt of [undefined, now + 300000, now - 1, NaN, Infinity]) {
    const h = fixture({ saved: { expiresAt } })
    const result = await h.call({ expiresAt: now + 7200000 })
    assert.equal(result.success, true)
    assert.equal(h.refreshes, 1, 'untrusted renderer lifetime cannot enable reuse')
    assert.equal(h.writes[0].accessToken, 'SYNTHETIC_ROTATED_ACCESS')
  }
})

test('IDE switch never reuses a mismatched stored credential generation', async () => {
  const h = fixture({ saved: { accessToken: 'SYNTHETIC_NEWER_ACCESS', refreshToken: 'SYNTHETIC_NEWER_REFRESH' } })
  const result = await h.call()
  assert.equal(result.success, false)
  assert.equal(h.refreshes, 0)
  assert.equal(h.writes.length, 0)
})

test('IDE switch aborts a reuse whose generation changes while awaiting the cache writer', async () => {
  const h = fixture({ rotateBeforeWrite: true })
  const result = await h.call()
  assert.equal(result.success, false)
  assert.equal(h.refreshes, 0)
  assert.equal(h.writes.length, 0)
})
