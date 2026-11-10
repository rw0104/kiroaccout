/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript harness executes the actual preload property. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true)
let property
function walk(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'managedCrew') property = node
  ts.forEachChild(node, walk)
}
walk(tree)
assert.ok(property, 'the actual preload must expose the workspace API')
const compiled = ts.transpileModule(`globalThis.api = { ${property.getText(tree)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

test('the real preload routes each workspace action to its distinct IPC channel without browser paths or tokens', async () => {
  const calls = []
  const context = vm.createContext({ ipcRenderer: { invoke: async (...args) => { calls.push(args); return { success: true } } } })
  vm.runInContext(compiled, context)
  const request = { accountId: 'synthetic', operationId: '12345678-1234-4234-8234-123456789abc' }
  await context.api.managedCrew.inspect(request.accountId)
  for (const action of ['start', 'open', 'stop']) await context.api.managedCrew[action](request)
  await context.api.managedCrew.chooseExecutable()
  assert.deepEqual(calls, [['managed-crew:inspect', request.accountId], ['managed-crew:start', request],
    ['managed-crew:open', request], ['managed-crew:stop', request], ['managed-crew:choose-executable']])
})
