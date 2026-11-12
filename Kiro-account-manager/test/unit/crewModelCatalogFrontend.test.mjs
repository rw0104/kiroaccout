// Execute the actual complete useWebSocket hook/router with deterministic hook,
// transport and query-client boundaries. No npm install, browser or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const app = resolve(import.meta.dirname, '../..')
const ts = createRequire(resolve(app, 'package.json'))('typescript')
const sourcePath = resolve(app, 'resources/crew-model-repair/0.12.0/frontend-source/useWebSocket.ts')
const source = readFileSync(sourcePath, 'utf8')
const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true)
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useWebSocket')
assert.ok(fn)
const importNames = []
for (const node of tree.statements) if (ts.isImportDeclaration(node)) {
  const bindings = node.importClause?.namedBindings
  if (bindings && ts.isNamedImports(bindings)) importNames.push(...bindings.elements.map(item => item.name.text))
}
const code = ts.transpileModule(fn.getText(tree).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function harness() {
  const effects = [], invalidations = [], activities = [], sockets = []
  let available = ['auto'], shown = ['auto']
  const noop = () => noop
  const methods = new Proxy({}, { get: () => noop })
  const queryClient = { invalidateQueries: ({ queryKey }) => {
    invalidations.push([...queryKey])
    if (queryKey[0] === 'available-models') shown = [...available]
    return Promise.resolve()
  } }
  const socket = { ...methods, reconnectingRef: { current: false }, wsRef: { current: null }, wasConnectedRef: { current: false },
    open: () => { const ws = {}; sockets.push(ws); socket.wsRef.current = ws; return ws },
    resetBackoff: noop, resume: noop, sendIfOpen: noop, beginClosing: noop, closeForUnmount: noop,
    subscribeLogs: noop, subscribeSubagents: noop, forceReconnect: (_release, connect) => connect() }
  const imports = Object.fromEntries(importNames.map(name => [name, noop]))
  const context = vm.createContext({ ...imports, Date, ArrayBuffer, Promise,
    useAppDispatch: () => action => activities.push(action), useQueryClient: () => queryClient,
    useSocketConnection: () => socket, useRef: current => ({ current }), useCallback: fn => fn,
    useEffect: fn => effects.push(fn), useMonitorContract: noop,
    useVoicePlayback: () => methods, useAutomationSeed: () => methods, useApprovalRegistry: () => methods,
    useComposerCards: () => methods, useWorkflowRunReconcile: () => noop, useStreamBuffers: () => methods,
    useSlotListSync: () => methods, useBundleReload: () => methods, useChatStream: () => methods,
    useTurnCompletion: () => methods, useRowDeliveryWatchdog: noop, createFoldWatch: () => methods,
    getDashboardState: () => ({}), store: { subscribe: () => noop }, attachFocusRelay: () => noop,
    isLookPreviewFrame: () => false, noteAppSlotFrame: noop, sseActivityEvent: event => ({ type: 'activity', event }),
    decodeFrame: raw => { const msg = JSON.parse(raw); return { msg, type: msg.type, data: msg.data } },
    runFirstConnect: () => { socket.wasConnectedRef.current = true }, runReconnectCatchUp: noop
  })
  vm.runInContext(code, context)
  const hook = context.useWebSocket()
  const cleanup = effects.at(-1)()
  return { invalidations, activities, cleanup, setAvailable: rows => { available = rows }, shown: () => shown,
    open: () => sockets.at(-1).onopen(), reconnect: () => { hook.forceReconnect(); sockets.at(-1).onopen() },
    frame: (type, data) => sockets.at(-1).onmessage({ data: JSON.stringify({ type, data }) }),
    modelReads: () => invalidations.filter(key => key[0] === 'available-models').length }
}

test('actual hook receives delayed catalog signal after a cold successful model read', () => {
  const h = harness()
  h.open()
  assert.deepEqual(h.shown(), ['auto'])
  const before = h.modelReads()
  h.setAvailable(['auto', 'synthetic-model'])
  h.frame('models_catalog_changed', { backend: 'kas' })
  assert.equal(h.modelReads(), before + 1)
  assert.deepEqual(h.shown(), ['auto', 'synthetic-model'])
  assert.equal(h.activities.length, 0, 'catalog is not a chat activity line')
  h.cleanup()
})

test('actual hook ignores malformed signals other backends and warm activity', () => {
  const h = harness()
  h.open()
  const before = h.modelReads()
  for (const data of [null, {}, { backend: 'kiro' }, { backend: 1 }]) h.frame('models_catalog_changed', data)
  h.frame('activity_event', { slot: 's', kind: 'session', spawned: false, text: 'warm' })
  h.frame('activity_event', { slot: 's', kind: 'status', text: 'thinking' })
  assert.equal(h.modelReads(), before)
  assert.equal(h.activities.length, 2)
  h.cleanup()
})

test('actual hook retains session spawned invalidation for other backends', () => {
  const h = harness()
  h.open()
  const before = h.modelReads()
  h.frame('activity_event', { slot: 's', kind: 'session', spawned: true, text: 'created' })
  assert.equal(h.modelReads(), before + 1)
  assert.equal(h.activities.length, 1)
  h.cleanup()
})

test('actual hook refetches once after first registration and once after missed-event reconnect', () => {
  const h = harness()
  h.setAvailable(['auto', 'arrived-before-socket'])
  h.open()
  assert.equal(h.modelReads(), 1)
  assert.deepEqual(h.shown(), ['auto', 'arrived-before-socket'])
  h.setAvailable(['auto', 'arrived-while-disconnected'])
  h.reconnect()
  assert.equal(h.modelReads(), 2)
  assert.deepEqual(h.shown(), ['auto', 'arrived-while-disconnected'])
  h.cleanup()
})
