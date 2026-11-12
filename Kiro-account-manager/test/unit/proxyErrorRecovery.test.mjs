import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
const quiet = { log() {}, warn() {}, error() {} }
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const source = ts.createSourceFile('server.ts', readFileSync(new URL('../../src/main/proxy/proxyServer.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
const members = declaration.members.filter(node => ['handleApiError', 'callWithRetry', 'isAccountAllowed', 'getAllowedAccountIds'].includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n')

function harness() {
  const context = vm.createContext({ console: quiet, exports: {}, ModelRequestError: class extends Error {} })
  vm.runInContext(compile(readFileSync(new URL('../../src/main/proxy/accountPool.ts', import.meta.url), 'utf8')), context)
  Object.assign(context, context.exports)
  vm.runInContext(compile(`class Subject { ${members} }; globalThis.Subject=Subject`), context)
  const server = new context.Subject()
  server.accountPool = new context.AccountPool()
  server.accountPool.addAccount({ id: 'synthetic', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3600000 })
  server.config = { enableMultiAccount: false, maxRetries: 2, retryDelayMs: 1 }
  server.events = {}
  server.recordRequestFailed = server.recordRequest = () => {}
  server.isAbortError = server.isResponseClosed = server.isAnthropicPath = () => false
  server.throwIfAborted = () => {}
  server.detectSuspendedError = () => undefined
  let refreshes = 0, status
  server.refreshToken = async () => { refreshes++; return false }
  server.waitForRetry = async () => {}
  server.sendError = (_res, code) => { status = code }
  return { server, get status() { return status }, get refreshes() { return refreshes },
    report: error => server.handleApiError({ headersSent: false }, { id: 'synthetic' }, error, '/v1/messages') }
}

test('actual Runtime 429 is rate limiting, not an exhausted account that later produces local 503', () => {
  const h = harness()
  h.report(Object.assign(new Error('Kiro Runtime request throttled'), { upstreamStatus: 429, retryable: false }))
  assert.equal(h.status, 429)
  assert.equal(h.server.accountPool.isQuotaExhausted(h.server.accountPool.getAccount('synthetic')), false)
  assert.equal(h.server.accountPool.getQuotaStatus().cooldown, 1)
  h.report(Object.assign(new Error('Kiro Runtime quota exhausted'), { upstreamStatus: 402, retryable: false }))
  assert.equal(h.server.accountPool.isQuotaExhausted(h.server.accountPool.getAccount('synthetic')), true)
})

test('unrelated numeric request identifiers cannot fabricate HTTP 403 or 503', () => {
  for (const message of ['Connection closed; request id 403812', 'Read failed; offset 503028']) {
    const h = harness()
    h.report(new Error(message))
    assert.equal(h.status, 500)
    assert.equal(h.server.accountPool.getAccount('synthetic').errorCount, 0)
  }
})

test('explicit permission denial remains 403 without credential refresh while structured 503 stays 503', async () => {
  const h = harness()
  const denied = Object.assign(new Error('HTTP 403: permission denied'), { upstreamStatus: 403 })
  await assert.rejects(h.server.callWithRetry(h.server.accountPool.getAccount('synthetic'), async () => { throw denied }, '/v1/messages'))
  assert.equal(h.refreshes, 0)
  h.report(denied)
  assert.equal(h.status, 403)
  h.report(Object.assign(new Error('Kiro Runtime request failed'), { upstreamStatus: 503, retryable: false }))
  assert.equal(h.status, 503)
})
