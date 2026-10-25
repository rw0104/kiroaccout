import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { resolveKiroSettingsTarget } from '../../src/main/kiroSettings.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
let handler
function visit(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'get-kiro-available-models') handler = node.arguments[1].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(handler)

function fixture(accountId = 'managed') {
  const calls = []
  const identity = id => ({ id, isActive: id === 'default', status: 'active', idp: 'Google', credentials: { accessToken: `SYNTHETIC_${id}` } })
  const accounts = { default: identity('default'), managed: identity('managed') }
  const context = vm.createContext({
    process: { platform: 'win32', env: {} },
    store: { get: () => ({ accounts }) },
    resolveKiroSettingsTarget,
    kiroInstanceService: { resolveSettingsTarget: async () => ({ label: 'Synthetic', homeDir: 'C:\\Synthetic', settingsPath: 'C:\\Synthetic\\settings.json', accountId }) },
    fetchKiroModels: async account => { calls.push(account.id); return [{ modelId: `model-${account.id}` }] },
    filterAvailableModels: models => models,
    toAccountModel: model => ({ id: model.modelId }),
    console: { error() {} },
    require: name => { if (name === 'os') return { homedir: () => 'C:\\Synthetic' }; throw Error('Unexpected module') }
  })
  const code = ts.transpileModule(`globalThis.action = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInContext(code, context)
  return { action: context.action, calls }
}

test('settings model catalogs follow the selected managed account instead of the manager active account', async () => {
  const ctx = fixture()
  const target = { type: 'instance', instanceId: '00000000-0000-4000-8000-000000000001' }
  assert.equal((await ctx.action(undefined, target)).models[0].id, 'model-managed')
  assert.equal((await ctx.action()).models[0].id, 'model-default')
  assert.deepEqual(ctx.calls, ['managed', 'default'])
})

test('an unbound or missing managed account never borrows another account catalog', async () => {
  for (const accountId of ['', 'deleted-account']) {
    const ctx = fixture(accountId)
    const result = await ctx.action(undefined, { type: 'instance', instanceId: '00000000-0000-4000-8000-000000000001' })
    assert.equal(result.models.length, 0)
    assert.ok(result.error)
    assert.deepEqual(ctx.calls, [])
  }
})
