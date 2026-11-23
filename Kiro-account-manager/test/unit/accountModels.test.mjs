import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { requestControlPlane } from '../../src/main/kiroControlPlane.ts'
import * as catalog from '../../src/shared/modelCatalog.ts'

const ts = createRequire(import.meta.url)('typescript')
function parse(path) {
  return ts.createSourceFile(path, readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
}
const main = parse('main/index.ts'), api = parse('main/proxy/kiroApi.ts'), preload = parse('preload/index.ts')
const fetchModels = api.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fetchKiroModels')
let handler, entry
function find(node, source) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && node.arguments[0]?.text === 'account-get-models') handler = node.arguments[1].getText(source)
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'accountGetModels') entry = node.initializer.getText(source)
  ts.forEachChild(node, child => find(child, source))
}
find(main, main); find(preload, preload)
assert.ok(handler && entry && fetchModels)
const profile = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/SYNTHETIC_ORGANIZATION'
const clean = value => JSON.parse(JSON.stringify(value))
const model = (modelId, extra = {}) => ({ modelId, modelName: modelId, description: 'Synthetic catalog entry', ...extra })

// The real preload -> main IPC -> paginated catalog -> request builder runs with
// a synthetic HTTP transport. No credentials are loaded and no service is called.
function harness(respond) {
  const calls = []
  const context = vm.createContext({ ...catalog, requestControlPlane,
    fetchWithProxy: async (url, init) => { calls.push({ url, init }); return respond(calls.length) },
    throwIfAborted: signal => { if (signal?.aborted) throw signal.reason },
    ipcRenderer: { invoke: (channel, ...args) => {
      assert.equal(channel, 'account-get-models')
      return context.handleModels({}, ...args)
    } }, console })
  const code = `${fetchModels.getText(api).replace(/^export /, '')}\nglobalThis.handleModels = ${handler};\nglobalThis.accountGetModels = ${entry}`
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return { calls, load: (selectedProfile = profile) => context.accountGetModels('SYNTHETIC_ACCESS', 'us-east-1', selectedProfile, undefined, 'Enterprise', 'IdC', 'SYNTHETIC_ACCOUNT') }
}

test('enterprise account details retain a returned Fable entry whose origin metadata is empty', async () => {
  const fable = model('SYNTHETIC_FABLE_5_1', { modelName: 'Claude Fable 5.1', availableOrigins: [], status: 'ACTIVE',
    consentStatus: 'SYNTHETIC_CONSENT', tokenLimits: { maxInputTokens: 1000000 }, modelProvider: 'Synthetic provider' })
  const ctx = harness(page => Response.json(page === 1
    ? { models: [model('SYNTHETIC_STANDARD')], nextToken: 'SYNTHETIC_PAGE_2' }
    : { models: [fable, fable] }))
  const result = await ctx.load()
  assert.equal(result.success, true)
  assert.deepEqual(clean(result.models.map(row => row.id)), ['SYNTHETIC_STANDARD', fable.modelId])
  assert.deepEqual(clean(result.models[1]), clean(catalog.toAccountModel(fable)))
  assert.equal(ctx.calls.length, 2)
  for (const { url, init } of ctx.calls) {
    assert.equal(url, 'https://management.us-east-1.kiro.dev/')
    assert.equal(init.headers.TokenType, 'SSO_OIDC')
    assert.equal(init.headers['x-amz-target'], 'KiroControlPlaneBearerService.ListAvailableModels')
    assert.equal(JSON.parse(init.body).profileArn, profile)
    assert.equal(JSON.parse(init.body).origin, 'AI_EDITOR')
    assert.equal(init.headers.Authorization, 'Bearer SYNTHETIC_ACCESS')
  }
  assert.equal(JSON.parse(ctx.calls[1].init.body).nextToken, 'SYNTHETIC_PAGE_2')
})

test('account catalog display preserves service lifecycle and origin metadata without changing proxy admission', async () => {
  const rows = [model('SYNTHETIC_ALTERNATE_ORIGIN', { availableOrigins: ['SYNTHETIC_NEW_ORIGIN'] }),
    model('SYNTHETIC_STATUS', { status: 'INACTIVE' }), model('SYNTHETIC_FUTURE_STATUS', { status: 'SYNTHETIC_FUTURE_STATUS' })]
  const result = await harness(() => Response.json({ models: rows })).load()
  assert.equal(result.success, true)
  assert.deepEqual(clean(result.models), rows.map(row => clean(catalog.toAccountModel(row))))
  assert.deepEqual(catalog.filterAvailableModels(rows).map(row => row.modelId), ['SYNTHETIC_FUTURE_STATUS'])
})

test('an empty or failed account catalog never invents a Fable entry or returns partial pages', async () => {
  const empty = await harness(() => Response.json({ models: [] })).load()
  assert.equal(empty.success, true)
  assert.deepEqual(clean(empty.models), [])
  const failed = harness(page => page === 1 ? Response.json({ models: [model('SYNTHETIC_STANDARD')], nextToken: 'SYNTHETIC_PAGE_2' })
    : new Response('SYNTHETIC_PRIVATE_BODY', { status: 403 }))
  const result = await failed.load()
  assert.equal(result.success, false)
  assert.deepEqual(clean(result.models), [])
  assert.doesNotMatch(result.error, /SYNTHETIC_PRIVATE_BODY|SYNTHETIC_ACCESS/)
  const noProfile = harness(() => { throw Error('Unexpected request') })
  assert.equal((await noProfile.load('')).success, false)
  assert.equal(noProfile.calls.length, 0)
})
