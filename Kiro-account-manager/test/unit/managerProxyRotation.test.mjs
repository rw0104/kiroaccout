import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { applyManagerTokenRotation } from '../../src/main/managerAccountRefresh.ts'

const ts = createRequire(import.meta.url)('typescript')
const quiet = { log() {}, warn() {}, error() {} }
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const bridge = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'refreshTokenByMethod')
assert.ok(bridge)

function harness({ saveFails = false, suspended = false, duringRefresh } = {}) {
  const context = vm.createContext({ console: quiet, exports: {} })
  vm.runInContext(compile(readFileSync(new URL('../../src/main/proxy/accountPool.ts', import.meta.url), 'utf8')), context)
  const pool = new context.exports.AccountPool()
  const original = { id: 'synthetic', accessToken: 'SYNTHETIC_OLD_ACCESS', refreshToken: 'SYNTHETIC_OLD_REFRESH',
    expiresAt: Date.now() + 1000, authMethod: 'social', provider: 'Google', quotaUsed: 10, quotaLimit: 100,
    ...(suspended ? { suspendedAt: 1, suspendReason: 'SYNTHETIC_SUSPENSION' } : {}) }
  pool.addAccount(original)
  let saved = { accounts: { synthetic: { id: original.id, idp: original.provider, credentials: { ...original } } } }
  const result = { success: true, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH', expiresIn: 3600 }
  Object.assign(context, { applyManagerTokenRotation, proxyServer: { getAccountPool: () => pool },
    instanceAccountOwnership: { beginOperation: () => () => {} },
    store: { get: () => saved, set: (_key, value) => { if (saveFails) throw new Error('synthetic disk failure'); saved = value } },
    pendingStoreWrites: new Map(), lastSavedData: undefined, mainWindow: undefined,
    refreshSocialToken: async () => { duringRefresh?.(pool, original); return result }, refreshOidcToken: async () => result })
  vm.runInContext(compile(`${bridge.getText(source)}; globalThis.refresh = refreshTokenByMethod`), context)
  return { pool, original, result, get saved() { return saved },
    refresh: () => context.refresh(original.refreshToken, '', '', 'us-east-1', 'social') }
}

test('the actual manager refresh bridge publishes the rotation to the live proxy pool without renderer resync', async () => {
  const h = harness()
  await h.refresh()
  const current = h.pool.getAccount('synthetic')
  assert.equal(h.saved.accounts.synthetic.credentials.refreshToken, 'SYNTHETIC_NEW_REFRESH')
  assert.equal(current.refreshToken, 'SYNTHETIC_NEW_REFRESH')
  assert.equal(current.accessToken, 'SYNTHETIC_NEW_ACCESS')
  assert.equal(current.quotaUsed, 10)
  assert.equal(current.quotaLimit, 100)
})

test('rotation remains available to the running pool when persistence fails', async () => {
  const h = harness({ saveFails: true })
  const result = await h.refresh()
  assert.equal(result.persistenceError, true)
  assert.equal(h.pool.getAccount('synthetic').refreshToken, 'SYNTHETIC_NEW_REFRESH')
})

test('a completed rotation neither clears suspension nor overwrites a newer pool generation', async () => {
  const suspended = harness({ suspended: true })
  await suspended.refresh()
  assert.equal(suspended.pool.getAccount('synthetic').refreshToken, 'SYNTHETIC_NEW_REFRESH')
  assert.equal(suspended.pool.getAccount('synthetic').isAvailable, false)
  assert.equal(suspended.pool.getAccount('synthetic').suspendedAt, 1)
  const newer = harness()
  newer.pool.updateAccount('synthetic', { refreshToken: 'SYNTHETIC_NEWER_REFRESH', accessToken: 'SYNTHETIC_NEWER_ACCESS' })
  await newer.refresh()
  assert.equal(newer.pool.getAccount('synthetic').refreshToken, 'SYNTHETIC_NEWER_REFRESH')
})

test('a delayed result cannot replace a newer access token even when the refresh token does not rotate', async () => {
  const h = harness({ duringRefresh: (pool, original) => {
    pool.updateAccount(original.id, { accessToken: 'SYNTHETIC_EXTERNAL_ACCESS', expiresAt: Date.now() + 7200000 })
  } })
  await h.refresh()
  assert.equal(h.pool.getAccount('synthetic').accessToken, 'SYNTHETIC_EXTERNAL_ACCESS')
  assert.ok(h.pool.getAccount('synthetic').expiresAt > Date.now() + 7000000)
})
