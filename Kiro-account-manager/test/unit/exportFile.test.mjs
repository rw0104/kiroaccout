import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')

function handlerHarness({ cancelled = false, fail = false } = {}) {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let handler
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === 'export-to-file') handler = node.arguments[1].getText(tree)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  let writes = 0
  let filter
  const context = vm.createContext({
    mainWindow: {}, dialog: { showSaveDialog: async (_window, options) => { filter = options.filters[0].extensions[0]; return { canceled: cancelled, filePath: 'SYNTHETIC_TARGET' } } },
    writeFile: async () => { writes++; if (fail) throw new Error('SYNTHETIC_PRIVATE_PATH') }
  })
  vm.runInContext(ts.transpileModule(`globalThis.exportFile = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { run: (...args) => context.exportFile(undefined, ...args), get writes() { return writes }, get filter() { return filter } }
}

test('actual export IPC distinguishes cancellation, write success and a redacted write failure', async () => {
  const cancelled = handlerHarness({ cancelled: true })
  assert.equal(await cancelled.run('{}', 'synthetic.json'), false)
  assert.equal(cancelled.writes, 0)
  const success = handlerHarness()
  assert.equal(await success.run('SYNTHETIC_CONTENT', 'synthetic.csv'), true)
  assert.equal(success.filter, 'csv')
  assert.equal(success.writes, 1)
  const failed = handlerHarness({ fail: true })
  await assert.rejects(failed.run('{}', 'synthetic.json'), error => !error.message.includes('SYNTHETIC_PRIVATE_PATH') && error.message.includes('导出文件写入失败'))
})
