import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { createAccountExport } from '../../src/shared/accountExport.ts'
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
  let defaultPath
  let writtenContent
  const context = vm.createContext({
    mainWindow: {}, dialog: { showSaveDialog: async (_window, options) => { filter = options.filters[0].extensions[0]; defaultPath = options.defaultPath; return { canceled: cancelled, filePath: 'SYNTHETIC_TARGET' } } },
    writeFile: async (_path, content) => { writes++; writtenContent = content; if (fail) throw new Error('SYNTHETIC_PRIVATE_PATH') }
  })
  vm.runInContext(ts.transpileModule(`globalThis.exportFile = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { run: (...args) => context.exportFile(undefined, ...args), get writes() { return writes }, get filter() { return filter }, get defaultPath() { return defaultPath }, get content() { return writtenContent } }
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

function dialogHarness({ format = 'json', scope = 'selected', includeCredentials = false, selectedCount = 1 } = {}) {
  const ipc = handlerHarness()
  const account = id => ({
    id, email: `${id}@example.invalid`, idp: 'Google',
    credentials: { provider: 'Google', authMethod: 'social', region: 'us-east-1', refreshToken: `SYNTHETIC_REFRESH_${id}` }
  })
  const rows = [account('unselected'), account('selected')]
  const store = { accounts: new Map(rows.map(row => [row.id, row])), groups: new Map(), tags: new Map(), appVersion: '1.8.5' }
  const states = [format, scope, includeCredentials]
  let hook = 0
  const source = readFileSync(new URL('../../src/renderer/src/components/accounts/ExportDialog.tsx', import.meta.url), 'utf8')
    .replace('  return createPortal(', '  return { handleExport };\n  return createPortal(')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  const copied = []
  vm.runInNewContext(compiled, {
    exports, window: { api: { exportToFile: ipc.run } }, alert() {},
    navigator: { clipboard: { async writeText(content) { copied.push(content) } } },
    require(name) {
      if (name === 'react') return {
        useState(initial) { const index = hook++; return [index < states.length ? states[index] : initial, () => {}] },
        useRef(initial) { return { current: initial } }, useEffect() {}
      }
      if (name === '@/store/accounts') return { useAccountsStore: select => select(store) }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: () => 'Unknown' }) }
      if (name.includes('shared/accountExport')) return { createAccountExport }
      return {}
    }
  })
  return {
    ipc, copied,
    dialog: exports.ExportDialog({ open: true, onClose() {}, accounts: [rows[1]], selectedCount })
  }
}

test('actual export dialog passes the selected email and format to the native save dialog', async () => {
  for (const format of ['json', 'oidc', 'txt', 'csv', 'kami']) {
    const harness = dialogHarness({ format, includeCredentials: true })
    await harness.dialog.handleExport()
    const extension = ['json', 'oidc'].includes(format) ? 'json' : format === 'csv' ? 'csv' : 'txt'
    assert.equal(harness.ipc.defaultPath, `selected@example.invalid.${extension}`)
    assert.equal(harness.ipc.filter, extension)
    assert.equal(harness.ipc.writes, 1)
    assert.match(harness.ipc.content, /selected@example\.invalid/)
    assert.doesNotMatch(harness.ipc.content, /unselected@example\.invalid/)
  }
})

test('actual export dialog retains bulk names for all scope and keeps clipboard/invalid selections from saving', async () => {
  const all = dialogHarness({ scope: 'all' })
  await all.dialog.handleExport()
  assert.match(all.ipc.defaultPath, /^kiro-accounts-backup-no-credentials-\d{4}-\d{2}-\d{2}\.json$/)
  assert.match(all.ipc.content, /unselected@example\.invalid/)
  const copy = dialogHarness({ format: 'clipboard' })
  await copy.dialog.handleExport()
  assert.equal(copy.ipc.writes, 0)
  assert.equal(copy.copied.length, 1)
  const changed = dialogHarness({ selectedCount: 2 })
  await changed.dialog.handleExport()
  assert.equal(changed.ipc.writes, 0)
})
