/* eslint-disable @typescript-eslint/explicit-function-return-type -- This is a JavaScript harness for the transpiled React component. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/renderer/src/components/accounts/ClientSwitchDialog.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const event = () => ({ preventDefault() { return undefined }, stopPropagation() { return undefined } })
const capability = (target, status = 'ready', extras = {}) => ({ target, status, runtimeId: `${target}-runtime`, revision: `${target}-revision`, message: '客户端状态', messageEn: `${target} state`, ...extras })
const response = (overrides = {}) => ({ status: 'identity-verified', message: '已验证所选账号', messageEn: 'Selected account verified', ...overrides })
const modelRepairState = (overrides = {}) => ({ status: 'repaired', ready: true, canRepair: false, canRestore: true,
  version: '0.12.2', revision: 'synthetic-installation-revision', message: '模型目录修复已安装', messageEn: 'Model catalog repair is installed.', ...overrides })

function harness(overrides = {}, windowApi, repairOverrides = {}) {
  const state = [], refs = [], effects = [], callbacks = []
  const listeners = new Map()
  const calls = []
  const repairCalls = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0, callbackIndex = 0, idIndex = 0, pending = []
  let closed = 0, sequence = 0
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef(initial) { return (refs[refIndex++] ??= { current: initial }) },
    useId() { return `test-id-${idIndex++}` },
    useCallback(callback, deps) {
      const index = callbackIndex++
      if (!callbacks[index] || deps.some((value, i) => value !== callbacks[index].deps[i])) callbacks[index] = { callback, deps }
      return callbacks[index].callback
    },
    useEffect(run, deps) {
      const index = effectIndex++
      const previous = effects[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: run() } })
      }
    }
  }
  const api = {
    inspect: async id => { calls.push(['inspect', id]); return { targets: [capability('crew'), capability('cli')] } },
    execute: async input => { calls.push(['execute', JSON.parse(JSON.stringify(input))]); return response() },
    authorize: async input => { calls.push(['authorize', JSON.parse(JSON.stringify(input))]); return response() },
    disconnect: async input => { calls.push(['disconnect', JSON.parse(JSON.stringify(input))]); return response({ status: 'disconnected' }) },
    chooseExecutable: async target => { calls.push(['chooseExecutable', target]); return { success: true } },
    cancelAuthorization: async id => { calls.push(['cancelAuthorization', id]) },
    ...overrides
  }
  const repairApi = {
    inspect: async id => { repairCalls.push(['inspect', id]); return modelRepairState() },
    repair: async input => { repairCalls.push(['repair', JSON.parse(JSON.stringify(input))]); return { success: true, state: modelRepairState() } },
    restore: async input => { repairCalls.push(['restore', JSON.parse(JSON.stringify(input))]); return { success: true, state: modelRepairState({ status: 'needs-repair', ready: false, canRepair: true, canRestore: false }) } },
    ...repairOverrides
  }
  const jsx = (type, props) => ({ type, props })
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    window: windowApi ? { api: windowApi } : undefined,
    HTMLElement: class {},
    crypto: { randomUUID: () => `operation-${++sequence}` },
    document: {
      body: {}, activeElement: null,
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type) }
    },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-dom') return { createPortal: value => value }
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => key })
      if (name === '../ui') return { Button: 'Button' }
      if (name === '@/lib/utils') return { cn: (...parts) => parts.filter(Boolean).join(' ') }
      throw new Error(`Unexpected import ${name}`)
    }
  })
  return {
    api, calls, repairCalls,
    get closed() { return closed },
    render(props = {}) {
      stateIndex = refIndex = effectIndex = callbackIndex = idIndex = 0
      const tree = exports.ClientSwitchDialog({
        accountId: 'account-a', accountLabel: 'Example account', isCurrentAccount: false, isEn: true, api, modelRepairApi: repairApi,
        onSwitchIde: async () => { calls.push(['ide']); return { success: true } },
        onClose: () => { closed++ }, ...props
      })
      const work = pending; pending = []; work.forEach(run => run())
      return tree
    },
    key(key) { listeners.get('keydown')?.({ key, ...event() }) },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) }
  }
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(item => find(item, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)]
}
const words = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(words).join('') : words(tree?.props?.children ?? '')
const button = (tree, text) => find(tree, node => node.type === 'Button' && words(node) === text)[0]?.props
const radio = (tree, target) => find(tree, node => node.type === 'input' && node.props['data-client-target'] === target)[0]?.props
const selectCrew = view => { radio(view.render(), 'crew').onChange() }
const submit = tree => find(tree, node => node.type === 'form')[0].props.onSubmit(event())

test('Crew selection uses the existing official client directly without workspace modes', async () => {
  const h = harness()
  h.render(); await drain()
  selectCrew(h)
  const tree = h.render()
  const clients = find(tree, node => node.type === 'input' && node.props.type === 'radio')
  assert.deepEqual(clients.map(node => node.props.value), ['ide', 'crew', 'cli'])
  assert.equal(radio(tree, 'crew').checked, true)
  assert.equal(button(tree, 'Switch account').disabled, false)
  assert.match(words(tree), /does not start it/)
  assert.doesNotMatch(words(tree), /workspace/i)
  assert.deepEqual(h.calls, [['inspect', 'account-a']])
  await submit(tree)
  assert.equal(h.calls.find(call => call[0] === 'execute')[1].target, 'crew')
})

test('client detection and selection work when the workspace preload API is absent', async () => {
  const windowApi = {}
  Object.defineProperty(windowApi, 'managedCrew', { get() { throw new Error('Removed API must not be accessed') } })
  const h = harness({}, windowApi)
  h.render(); await drain()
  selectCrew(h)
  assert.equal(button(h.render(), 'Switch account').disabled, false)
  await submit(h.render())
  assert.equal(h.calls.filter(call => call[0] === 'execute').length, 1)
})

test('opening and selecting clients inspect metadata only; IDE is the default on every mount', async () => {
  const h = harness()
  let tree = h.render()
  assert.equal(radio(tree, 'ide').checked, true)
  assert.equal(radio(tree, 'crew').checked, false)
  await drain()
  tree = h.render()
  radio(tree, 'cli').onChange()
  tree = h.render()
  assert.equal(radio(tree, 'cli').checked, true)
  assert.deepEqual(h.calls, [['inspect', 'account-a']])
  button(tree, 'Cancel').onClick()
  assert.equal(h.closed, 1)
  h.unmount()
  assert.equal(radio(harness().render(), 'ide').checked, true)
})

test('IDE submission invokes only the existing IDE callback, even if external discovery fails', async () => {
  const h = harness({ inspect: async () => { throw new Error('synthetic discovery failure') } })
  h.render()
  await drain()
  const tree = h.render({ isCurrentAccount: true })
  assert.match(words(tree), /Current account/)
  assert.equal(button(tree, 'Switch account').disabled, false)
  await submit(tree)
  assert.deepEqual(h.calls, [['ide']])
  assert.equal(h.closed, 1)
})

test('external submission carries target identity and revision without manager credentials', async () => {
  const h = harness()
  h.render(); await drain()
  selectCrew(h)
  await submit(h.render())
  assert.deepEqual(h.calls.find(call => call[0] === 'execute'), ['execute', {
    operationId: 'operation-1', accountId: 'account-a', target: 'crew',
    runtimeId: 'crew-runtime', expectedRuntimeRevision: 'crew-revision'
  }])
  assert.equal(h.calls.some(call => call[0] === 'ide'), false)
  assert.match(words(h.render()), /Selected account verified/)
  assert.equal(h.closed, 0)
})

test('blocked targets show their reason and cannot fall back to a legacy credential write', async () => {
  const h = harness({ inspect: async () => ({ targets: [capability('crew', 'blocked', { messageEn: 'Finish the running Crew task first.' })] }) })
  h.render(); await drain()
  selectCrew(h)
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.match(words(tree), /Finish the running Crew task first/)
  await submit(tree)
  assert.deepEqual(h.calls, [])
})

test('authorization is explicit and cancel uses its operation ID before closing', async () => {
  const pending = deferred()
  const h = harness({
    inspect: async () => ({ targets: [capability('cli', 'needs-login')] }),
    authorize: input => { h.calls.push(['authorize', JSON.parse(JSON.stringify(input))]); return pending.promise }
  })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  let tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.deepEqual(h.calls, [])
  button(tree, 'Authorize this account in client').onClick()
  tree = h.render()
  assert.match(words(tree), /Complete sign-in/)
  assert.equal(h.calls[0][0], 'authorize')
  button(tree, 'Cancel authorization').onClick()
  await drain()
  assert.deepEqual(h.calls[1], ['cancelAuthorization', 'operation-1'])
  assert.equal(h.closed, 1)
  h.unmount()
  pending.resolve(response())
  await drain()
  assert.equal(h.calls.filter(call => call[0] === 'cancelAuthorization').length, 1)
  assert.equal(h.calls.some(call => call[0] === 'execute' || call[0] === 'ide'), false)
})

test('shared Crew and CLI authentication is explained before committing', async () => {
  const h = harness({ inspect: async () => ({ targets: [capability('crew', 'ready', { sharedTargets: ['crew', 'cli'] })] }) })
  h.render(); await drain()
  selectCrew(h)
  assert.match(words(h.render()), /Switching will affect both clients/)
  assert.deepEqual(h.calls, [])
})

test('late authorization cancellation cannot close another account dialog', async () => {
  const authorization = deferred(), cancellation = deferred()
  const h = harness({
    inspect: async () => ({ targets: [capability('cli', 'needs-login')] }),
    authorize: () => authorization.promise,
    cancelAuthorization: id => { h.calls.push(['cancelAuthorization', id]); return cancellation.promise }
  })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  button(h.render(), 'Authorize this account in client').onClick()
  const cancel = button(h.render(), 'Cancel authorization')
  cancel.onClick(); cancel.onClick()
  assert.equal(h.calls.length, 1)
  h.render({ accountId: 'account-b' }); await drain()
  cancellation.resolve()
  authorization.resolve(response())
  await drain()
  const tree = h.render({ accountId: 'account-b' })
  assert.equal(h.closed, 0)
  assert.equal(radio(tree, 'ide').checked, true)
  assert.equal(h.calls.length, 1)
  assert.doesNotMatch(words(tree), /Selected account verified/)
})

test('duplicate submits are serialized and Escape cannot dismiss an in-flight write', async () => {
  const pending = deferred()
  const h = harness({ execute: input => { h.calls.push(['execute', input]); return pending.promise } })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  const tree = h.render()
  const selectAnotherClient = radio(tree, 'crew').onChange
  const first = submit(tree)
  await submit(tree)
  selectAnotherClient()
  assert.equal(radio(h.render(), 'cli').checked, true)
  h.key('Escape')
  assert.equal(h.closed, 0)
  assert.equal(h.calls.filter(call => call[0] === 'execute').length, 1)
  pending.resolve(response({ status: 'failed', messageEn: 'Target write failed; target credentials were retained.' }))
  await first
  assert.match(words(h.render()), /Target write failed; target credentials were retained/)
  h.key('Escape')
  assert.equal(h.closed, 1)
})

test('a late inspection or write response cannot update a newly selected account', async () => {
  const lateInspect = deferred(), lateWrite = deferred()
  const h = harness({
    inspect: id => id === 'account-a' ? lateInspect.promise : Promise.resolve({ targets: [capability('cli')] }),
    execute: () => lateWrite.promise
  })
  h.render()
  h.render({ accountId: 'account-b' })
  await drain()
  lateInspect.resolve({ targets: [capability('crew', 'ready', { messageEn: 'Stale account A state' })] })
  await drain()
  let tree = h.render({ accountId: 'account-b' })
  assert.doesNotMatch(words(tree), /Stale account A state/)
  radio(tree, 'cli').onChange()
  const write = submit(h.render({ accountId: 'account-b' }))
  h.render({ accountId: 'account-c' }); await drain()
  lateWrite.resolve(response({ messageEn: 'Stale account B success' }))
  await write
  tree = h.render({ accountId: 'account-c' })
  assert.equal(radio(tree, 'ide').checked, true)
  assert.doesNotMatch(words(tree), /Stale account B success/)
})

test('choosing a client executable delegates to the native picker without executing a switch', async () => {
  const h = harness()
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  button(h.render(), 'Choose installed client').onClick()
  await drain()
  assert.deepEqual(h.calls.find(call => call[0] === 'chooseExecutable'), ['chooseExecutable', 'cli'])
  assert.equal(h.calls.some(call => call[0] === 'execute' || call[0] === 'authorize' || call[0] === 'ide'), false)
})

test('disconnect is explicit for a connected external client and never appears for IDE', async () => {
  let connected = true
  const h = harness({
    inspect: async id => { h.calls.push(['inspect', id]); return { targets: [capability('cli', 'ready', { connected }), capability('crew')] } },
    disconnect: async input => { h.calls.push(['disconnect', JSON.parse(JSON.stringify(input))]); connected = false; return response({ status: 'disconnected' }) }
  })
  h.render(); await drain()
  assert.equal(button(h.render(), 'Disconnect'), undefined)
  selectCrew(h)
  assert.equal(button(h.render(), 'Disconnect'), undefined)
  radio(h.render(), 'cli').onChange()
  let tree = h.render()
  assert.equal(button(tree, 'Disconnect').disabled, false)
  assert.deepEqual(h.calls, [['inspect', 'account-a']])
  button(tree, 'Disconnect').onClick()
  await drain()
  assert.deepEqual(h.calls[1], ['disconnect', {
    operationId: 'operation-1', accountId: 'account-a', target: 'cli',
    runtimeId: 'cli-runtime', expectedRuntimeRevision: 'cli-revision'
  }])
  tree = h.render()
  assert.equal(button(tree, 'Disconnect'), undefined)
  assert.match(words(tree), /Existing short-lived client credentials will expire naturally/)
  assert.match(words(tree), /manager sign-in is unchanged/)
  assert.deepEqual(h.calls.map(call => call[0]), ['inspect', 'disconnect', 'inspect'])
  assert.equal(h.closed, 0)
})

test('a connected but blocked target can stop synchronization without attempting a write', async () => {
  const h = harness({ inspect: async () => ({ targets: [capability('crew', 'blocked', { connected: true, sharedTargets: ['crew', 'cli'] })] }) })
  h.render(); await drain()
  selectCrew(h)
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.equal(button(tree, 'Disconnect').disabled, false)
  assert.match(words(tree), /disconnecting synchronization affects both clients/)
  button(tree, 'Disconnect').onClick()
  await drain()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], 'disconnect')
})

test('disconnect is serialized and a stale response cannot alter another account dialog', async () => {
  const pending = deferred()
  const h = harness({
    inspect: async () => ({ targets: [capability('cli', 'ready', { connected: true })] }),
    disconnect: input => { h.calls.push(['disconnect', JSON.parse(JSON.stringify(input))]); return pending.promise }
  })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  const disconnect = button(h.render(), 'Disconnect')
  disconnect.onClick(); disconnect.onClick()
  assert.equal(h.calls.length, 1)
  assert.equal(button(h.render(), 'Disconnecting…').disabled, true)
  h.key('Escape')
  assert.equal(h.closed, 0)
  h.render({ accountId: 'account-b' }); await drain()
  pending.resolve(response({ status: 'disconnected' }))
  await drain()
  const tree = h.render({ accountId: 'account-b' })
  assert.equal(radio(tree, 'ide').checked, true)
  assert.doesNotMatch(words(tree), /Synchronization stopped/)
  assert.equal(h.closed, 0)
})

test('failed disconnect displays the actual failure and preserves retry capability', async () => {
  const h = harness({
    inspect: async () => ({ targets: [capability('cli', 'ready', { connected: true })] }),
    disconnect: async input => { h.calls.push(['disconnect', input]); return response({ status: 'blocked', messageEn: 'Another operation is still running.' }) }
  })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  button(h.render(), 'Disconnect').onClick()
  await drain()
  const tree = h.render()
  assert.match(words(tree), /Another operation is still running/)
  assert.doesNotMatch(words(tree), /Synchronization stopped/)
  assert.equal(button(tree, 'Disconnect').disabled, false)
  assert.equal(h.calls.filter(call => call[0] === 'disconnect').length, 1)
})

test('Crew must repair the selected installation before switching and sends its inspected revision', async () => {
  let ready = false
  const h = harness({}, undefined, {
    inspect: async () => modelRepairState({ status: ready ? 'repaired' : 'needs-repair', ready,
      canRepair: !ready, canRestore: ready, messageEn: ready ? 'Model catalog repair is installed.' : 'The model catalog needs repair.' }),
    repair: async input => { h.repairCalls.push(['repair', JSON.parse(JSON.stringify(input))]); ready = true; return { success: true, state: modelRepairState() } }
  })
  h.render(); await drain(); selectCrew(h)
  let tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.equal(button(tree, 'Repair model list').disabled, false)
  assert.match(words(tree), /selected official Crew installation/i)
  assert.match(words(tree), /0\.12\.2/)
  assert.doesNotMatch(words(tree), /synthetic-installation-revision/)
  await submit(tree)
  assert.equal(h.calls.some(call => call[0] === 'execute'), false)
  button(tree, 'Repair model list').onClick(); await drain()
  assert.deepEqual(h.repairCalls[0], ['repair', { operationId: 'operation-1', accountId: 'account-a', expectedRevision: 'synthetic-installation-revision' }])
  tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, false)
  await submit(tree)
  assert.equal(h.calls.find(call => call[0] === 'execute')[1].target, 'crew')
})

test('running but repaired Crew may switch while its repair and restore actions remain unavailable', async () => {
  const h = harness({}, undefined, { inspect: async () => modelRepairState({ status: 'running', ready: true, canRestore: false,
    messageEn: 'Crew is running with the repaired model catalog.' }) })
  h.render(); await drain(); selectCrew(h)
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, false)
  assert.equal(button(tree, 'Repair model list').disabled, true)
  assert.equal(button(tree, 'Restore official files').disabled, true)
})

test('restoring official files is explicit and blocks switching again when a catalog repair is needed', async () => {
  let restored = false
  const state = () => modelRepairState({ status: restored ? 'needs-repair' : 'repaired', ready: !restored, canRepair: restored, canRestore: !restored })
  const h = harness({}, undefined, { inspect: async () => state(), restore: async input => {
    h.repairCalls.push(['restore', JSON.parse(JSON.stringify(input))]); restored = true
    return { success: true, state: state(), messageEn: 'Official files restored.' }
  } })
  h.render(); await drain(); selectCrew(h)
  button(h.render(), 'Restore official files').onClick(); await drain()
  assert.deepEqual(h.repairCalls[0], ['restore', { operationId: 'operation-1', accountId: 'account-a', expectedRevision: 'synthetic-installation-revision' }])
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.match(words(tree), /Official files restored/)
  assert.equal(h.calls.some(call => call[0] === 'execute' || call[0] === 'authorize'), false)
})

test('rechecking after a client update invalidates an old ready state without touching IDE or CLI', async () => {
  const update = deferred()
  let checks = 0
  const h = harness({}, undefined, { inspect: async () => ++checks === 1 ? modelRepairState() : update.promise })
  h.render(); await drain(); selectCrew(h)
  const oldTree = h.render()
  button(oldTree, 'Check again').onClick()
  assert.equal(button(h.render(), 'Switch account').disabled, true)
  update.resolve(modelRepairState({ status: 'unsupported', ready: false, canRepair: false, canRestore: false, revision: 'synthetic-new-install',
    messageEn: 'This updated client needs a compatibility check.' }))
  await drain()
  let tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.match(words(tree), /updated client needs a compatibility check/)
  radio(tree, 'cli').onChange()
  assert.equal(button(h.render(), 'Switch account').disabled, false)
  assert.equal(button(h.render(), 'Repair model list'), undefined)
  assert.equal(h.repairCalls.some(call => call[0] === 'repair' || call[0] === 'restore'), false)
})

test('repair mutations require a revision, serialize clicks, and discard late results for another account', async () => {
  const pending = deferred()
  const h = harness({}, undefined, { inspect: async () => modelRepairState({ status: 'needs-repair', ready: false, canRepair: true, canRestore: false }),
    repair: input => { h.repairCalls.push(['repair', input]); return pending.promise } })
  h.render(); await drain(); selectCrew(h)
  const action = button(h.render(), 'Repair model list')
  action.onClick(); action.onClick()
  assert.equal(h.repairCalls.length, 1)
  assert.equal(button(h.render(), 'Repairing…').disabled, true)
  h.key('Escape'); assert.equal(h.closed, 0)
  h.render({ accountId: 'account-b' }); await drain()
  pending.resolve({ success: true, state: modelRepairState(), messageEn: 'Stale repair result.' }); await drain()
  const tree = h.render({ accountId: 'account-b' })
  assert.equal(radio(tree, 'ide').checked, true)
  assert.doesNotMatch(words(tree), /Stale repair result/)
  const noRevision = harness({}, undefined, { inspect: async () => modelRepairState({ status: 'needs-repair', ready: false, canRepair: true, revision: undefined }) })
  noRevision.render(); await drain(); selectCrew(noRevision)
  assert.equal(button(noRevision.render(), 'Repair model list').disabled, true)
})

test('missing or failed repair inspection cannot silently bypass Crew readiness but IDE remains usable', async () => {
  const h = harness({}, undefined, { inspect: async () => { throw new Error('SYNTHETIC_PRIVATE_PATH') } })
  h.render(); await drain(); selectCrew(h)
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.match(words(tree), /Model list inspection failed/)
  assert.doesNotMatch(words(tree), /SYNTHETIC_PRIVATE_PATH/)
  radio(tree, 'ide').onChange()
  assert.equal(button(h.render(), 'Switch account').disabled, false)
})

test('a slow Crew model inspection does not block CLI switching and a newer upstream fix needs no repair', async () => {
  const pending = deferred()
  const h = harness({}, undefined, { inspect: () => pending.promise })
  h.render(); await drain()
  radio(h.render(), 'cli').onChange()
  assert.equal(button(h.render(), 'Switch account').disabled, false)
  await submit(h.render())
  assert.equal(h.calls.find(call => call[0] === 'execute')[1].target, 'cli')
  pending.resolve(modelRepairState({ status: 'upstream-fixed', ready: true, canRestore: false,
    messageEn: 'This official version already handles model catalog updates.' }))
  await drain(); selectCrew(h)
  const tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, false)
  assert.equal(button(tree, 'Repair model list').disabled, true)
  assert.equal(button(tree, 'Restore official files').disabled, true)
  assert.match(words(tree), /official version already handles/)
})

test('failed file repair exposes safe retry guidance without claiming success or switching accounts', async () => {
  const h = harness({}, undefined, {
    inspect: async () => modelRepairState({ status: 'needs-repair', ready: false, canRepair: true, canRestore: false }),
    repair: async () => { throw new Error('SYNTHETIC_PRIVATE_INSTALL_PATH') }
  })
  h.render(); await drain(); selectCrew(h)
  button(h.render(), 'Repair model list').onClick(); await drain()
  let tree = h.render()
  assert.equal(button(tree, 'Switch account').disabled, true)
  assert.match(words(tree), /operation did not complete/)
  assert.doesNotMatch(words(tree), /SYNTHETIC_PRIVATE_INSTALL_PATH|Model catalog repair is installed/)
  button(tree, 'Check again').onClick(); await drain()
  tree = h.render()
  assert.equal(button(tree, 'Repair model list').disabled, false)
  assert.equal(h.calls.some(call => call[0] === 'execute'), false)
})
