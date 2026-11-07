import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { KiroModelPreferencesService, ModelPreferencesError } from '../../src/main/kiroModelPreferences.ts'
import { ControlPlaneError, requestControlPlane } from '../../src/main/kiroControlPlane.ts'
import { InstanceOwnershipError } from '../../src/main/kiroInstanceOwnership.ts'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc.ts'
import * as preferences from '../../src/shared/modelPreferences.ts'

const source = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8')
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const clean = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const model = (id, consentStatus) => ({ id, name: id, description: '', consentStatus })
const viewSnapshot = (accountId, overrides = {}) => ({ success: true, snapshot: {
  accountId, revision: `${accountId}-read`, models: [model('primary'), model('fallback'), model('consent-model', 'SYNTHETIC_STATUS')], chains: {}, ...overrides
} })
const identity = (accountId, generation = 1) => ({ accountId, accessToken: `SYNTHETIC_${accountId}_${generation}` })

function ui(api) {
  const states = [], refs = [], effects = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0, pending = []
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef(value) { return (refs[refIndex++] ??= { current: value }) },
    useEffect(run, deps) {
      const index = effectIndex++
      const previous = effects[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
      }
    }
  }
  const jsx = (type, props) => ({ type, props })
  const exports = {}
  vm.runInNewContext(compile(source('renderer/src/components/accounts/ModelFallbackPreferences.tsx')), { exports, window: { api }, require(name) {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'lucide-react') return Object.fromEntries(['Loader2', 'RefreshCw', 'Save'].map(key => [key, key]))
    if (name === '../ui/button') return { Button: 'Button' }
    if (name.endsWith('/modelPreferences')) return preferences
    throw new Error(`Unexpected import ${name}`)
  } })
  return { render(identity) {
    stateIndex = refIndex = effectIndex = 0
    const tree = exports.ModelFallbackPreferences({ identity, isEn: true })
    const work = pending; pending = []
    work.forEach(effect => effect())
    return tree
  } }
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(item => find(item, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)]
}
const words = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(words).join('') : words(tree?.props?.children ?? '')
const button = (tree, label) => find(tree, node => node.type === 'Button' && words(node) === label)[0]?.props
const selector = (tree, label) => find(tree, node => node.type === 'select' && node.props['aria-label'] === label)[0]?.props

test('the actual editor reads only on click, limits choices, and saves only when explicitly requested', async () => {
  const calls = []
  const account = identity('account-a')
  const h = ui({
    accountReadModelPreferences: async id => { calls.push(['read', id]); return viewSnapshot(id, { models: [model('constructor'), model('fallback'), model('consent-model', 'SYNTHETIC_STATUS')] }) },
    accountSaveModelPreferences: async input => { calls.push(['save', clean(input)]); return viewSnapshot(input.accountId, { revision: 'next', chains: { [input.targetModelId]: input.chain } }) }
  })
  assert.deepEqual(calls, [])
  button(h.render(account), 'Read preferences').onClick()
  await drain()
  const tree = h.render(account)
  const chooser = selector(tree, 'Choose fallback model')
  assert.deepEqual(Array.from(find(chooser.children, node => node.type === 'option'), node => node.props.value), ['', 'fallback'])
  assert.equal(button(tree, 'Save to account').disabled, true)
  chooser.onChange({ target: { value: 'fallback' } })
  assert.deepEqual(calls, [['read', 'account-a']])
  button(h.render(account), 'Save to account').onClick()
  await drain()
  assert.deepEqual(calls[1], ['save', { accountId: 'account-a', revision: 'account-a-read', targetModelId: 'constructor', chain: ['fallback'] }])
  assert.ok(words(h.render(account)).includes('Saved and verified'))
})

test('the actual editor drops stale read and write responses when the credential changes', async () => {
  const lateRead = deferred(), lateWrite = deferred()
  const first = identity('account-a'), second = identity('account-b'), rotated = identity('account-b', 2)
  const h = ui({
    accountReadModelPreferences: id => id === first.accountId ? lateRead.promise : Promise.resolve(viewSnapshot(id)),
    accountSaveModelPreferences: () => lateWrite.promise
  })
  button(h.render(first), 'Read preferences').onClick()
  h.render(second)
  lateRead.resolve(viewSnapshot(first.accountId))
  await drain()
  assert.equal(selector(h.render(second), 'Choose fallback model'), undefined)
  button(h.render(second), 'Read preferences').onClick()
  await drain()
  selector(h.render(second), 'Choose fallback model').onChange({ target: { value: 'fallback' } })
  button(h.render(second), 'Save to account').onClick()
  h.render(rotated)
  lateWrite.resolve(viewSnapshot(second.accountId, { chains: { primary: ['fallback'] } }))
  await drain()
  const tree = h.render(rotated)
  assert.equal(selector(tree, 'Choose fallback model'), undefined)
  assert.equal(words(tree).includes('Saved and verified'), false)
})

const channels = ['account-read-model-preferences', 'account-save-model-preferences']
const main = ts.createSourceFile('index.ts', source('main/index.ts'), ts.ScriptTarget.Latest, true)
const ipcHandlers = new Map()
function scan(node) {
  if (ts.isCallExpression(node) && node.expression.getText(main) === 'ipcMain.handle' && channels.includes(node.arguments[0]?.text)) ipcHandlers.set(node.arguments[0].text, node.arguments[1].getText(main))
  ts.forEachChild(node, scan)
}
scan(main)
assert.equal(ipcHandlers.size, channels.length)

test('actual IPC requires the trusted main frame and writes with the stored identity only', async () => {
  const captured = []
  const __dirname = 'synthetic/main'
  const mainFrame = { url: pathToFileURL(join(__dirname, '../renderer/index.html')).href }
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame } }
  const sender = { sender: mainWindow.webContents, senderFrame: mainFrame }
  const expiresAt = Date.now() + 60000
  let chain
  const modelPreferences = new KiroModelPreferencesService({
    account: id => ({ id, credentials: { accessToken: 'SYNTHETIC_STORED', authMethod: 'social', provider: 'Google', expiresAt } }),
    beginOperation: () => () => {},
    models: async () => ['primary', 'fallback'].map(modelId => ({ modelId, modelName: modelId, description: '' })),
    request: (identity, operation, input) => requestControlPlane(identity, operation, input, { fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      captured.push({ operation, body, auth: new Headers(init.headers).get('authorization') })
      if (operation === 'SetUserPreference') {
        chain = body.modelFallbacks.perModel.primary
        return Response.json({ batchResult: { successfulPreferences: [{ preferenceType: 'MODEL_FALLBACKS', modelId: 'primary' }] } })
      }
      return Response.json(chain ? { modelFallbacks: { perModel: { primary: chain } } } : {})
    } })
  })
  const handlers = {}
  vm.runInNewContext(compile([...ipcHandlers].map(([channel, fn]) => `handlers[${JSON.stringify(channel)}] = ${fn};`).join('\n')), {
    handlers, modelPreferences, requireTrustedMainWindow, ModelPreferencesError, ControlPlaneError, InstanceOwnershipError, mainWindow, __dirname, join, is: { dev: false }, process: { env: {} }
  })
  const foreignFrame = { ...sender, senderFrame: { ...mainFrame } }
  assert.equal((await handlers[channels[0]](foreignFrame, 'account-a')).success, false)
  assert.equal((await handlers[channels[1]](foreignFrame, {})).success, false)
  assert.equal(captured.length, 0)
  const read = await handlers[channels[0]](sender, 'account-a')
  assert.equal(read.success, true)
  const result = await handlers[channels[1]](sender, { accountId: 'account-a', revision: read.snapshot.revision, targetModelId: 'primary', chain: ['fallback'], accessToken: 'SYNTHETIC_UNTRUSTED' })
  assert.equal(result.success, true)
  assert.deepEqual(result.snapshot.chains.primary, ['fallback'])
  assert.deepEqual(captured.map(call => call.operation), ['GetUserPreference', 'SetUserPreference', 'GetUserPreference'])
  assert.ok(captured.every(call => call.auth === 'Bearer SYNTHETIC_STORED' && !JSON.stringify(call.body).includes('SYNTHETIC_UNTRUSTED')))
})
