import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')

function retryHarness() {
  const source = readFileSync(new URL('../../src/main/proxy/proxyServer.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
  const members = declaration.members.filter(node => ['callWithRetry', 'isAccountAllowed', 'getAllowedAccountIds'].includes(node.name?.getText(tree)))
  const compiled = ts.transpileModule(`class Subject { ${members.map(node => node.getText(tree)).join('\n')} }; globalThis.Subject=Subject`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const context = vm.createContext({ console: { log() {} }, Set })
  vm.runInContext(compiled, context)
  const server = new context.Subject()
  server.config = { maxRetries: 5, enableMultiAccount: true }
  server.throwIfAborted = () => {}
  server.isAbortError = () => false
  let unexpected = 0
  server.refreshToken = () => { unexpected++; return true }
  server.accountPool = { getAccount: id => ({ id }), getNextAccount() { unexpected++; return { id: 'OTHER_SYNTHETIC' } } }
  return { server, get unexpected() { return unexpected } }
}

test('actual proxy retry boundary never refreshes, switches accounts or replays a Runtime failure', async () => {
  for (const fields of [{ retryable: false, upstreamStatus: 403 }, { outputStarted: true, upstreamStatus: 503 }]) {
    const harness = retryHarness()
    let calls = 0
    const error = Object.assign(new Error('Runtime failure'), fields)
    await assert.rejects(harness.server.callWithRetry({ id: 'SYNTHETIC' }, async () => { calls++; throw error }, '/v1/messages'), value => value === error)
    assert.equal(calls, 1)
    assert.equal(harness.unexpected, 0)
  }
})
