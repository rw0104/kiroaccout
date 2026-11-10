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

function harness(overrides = {}, windowApi) {
  const state = [], refs = [], effects = [], callbacks = []
  const listeners = new Map()
  const calls = []
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
    api, calls,
    get closed() { return closed },
    render(props = {}) {
      stateIndex = refIndex = effectIndex = callbackIndex = idIndex = 0
      const tree = exports.ClientSwitchDialog({
        accountId: 'account-a', accountLabel: 'Example account', isCurrentAccount: false, isEn: true, api,
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
const crewMode = (tree, target) => find(tree, node => node.type === 'input' && node.props['data-crew-mode'] === target)[0]?.props
const selectCrew = (view, mode = 'crew') => { radio(view.render(), 'crew').onChange(); crewMode(view.render(), mode).onChange() }
const submit = tree => find(tree, node => node.type === 'form')[0].props.onSubmit(event())

test('the top-level client picker has one Crew entry and reveals a separate default workspace mode', async () => {
  const f = managedHarness()
  f.render(); await drain()
  let tree = f.render()
  const clients = find(tree, node => node.type === 'input' && node.props.type === 'radio')
  assert.deepEqual(clients.map(node => node.props.value), ['ide', 'crew', 'cli'])
  radio(tree, 'crew').onChange()
  tree = f.render()
  const modeGroup = find(tree, node => node.type === 'fieldset' && node.props['data-testid'] === 'crew-mode-picker')[0]
  assert.ok(modeGroup)
  const modes = find(modeGroup, node => node.type === 'input' && node.props.type === 'radio')
  assert.equal(modes.find(node => node.props.value === 'crew-managed').props.checked, true)
  assert.equal(button(tree, 'Start and open').disabled, false)
  assert.equal(f.h.calls.some(call => ['execute', 'chooseExecutable', 'disconnect'].includes(call[0])), false)
  assert.equal(f.managedCalls.some(call => ['start', 'open', 'stop', 'choose'].includes(call[0])), false)
})

test('Crew mode changes stay within one client choice and never start or switch an account', async () => {
  const f = managedHarness()
  f.render(); await drain()
  radio(f.render(), 'crew').onChange()
  let tree = f.render()
  assert.equal(crewMode(tree, 'crew-managed').checked, true)
  assert.equal(radio(tree, 'crew').checked, true)
  crewMode(tree, 'crew').onChange()
  tree = f.render()
  assert.equal(crewMode(tree, 'crew').checked, true)
  assert.equal(radio(tree, 'crew').checked, true)
  assert.match(words(tree), /does not start it/)
  assert.ok(button(tree, 'Switch account'))
  radio(tree, 'cli').onChange()
  assert.equal(crewMode(f.render(), 'crew'), undefined)
  radio(f.render(), 'crew').onChange()
  assert.equal(crewMode(f.render(), 'crew-managed').checked, true)
  assert.deepEqual(f.managedCalls, [['inspect', 'account-a']])
  assert.deepEqual(f.h.calls, [['inspect', 'account-a']])
})

test('an unavailable workspace stays blocked until the existing client mode is explicitly selected', async () => {
  const f = managedHarness({ inspect: async () => { throw Error('SYNTHETIC_PRIVATE_PATH') } })
  f.render(); await drain()
  radio(f.render(), 'crew').onChange()
  assert.equal(button(f.render(), 'Start and open').disabled, true)
  assert.doesNotMatch(words(f.render()), /crew state|SYNTHETIC_PRIVATE_PATH/)
  crewMode(f.render(), 'crew').onChange()
  assert.equal(button(f.render(), 'Switch account').disabled, false)
  assert.match(words(f.render()), /crew state/)
  assert.equal(f.h.calls.some(call => call[0] === 'execute'), false)
})

test('busy Crew operations disable the mode picker and ignore a stale mode-change handler', async () => {
  const pending = deferred()
  const f = managedHarness({ start: () => pending.promise })
  f.render(); await drain(); radio(f.render(), 'crew').onChange()
  const chooseExisting = crewMode(f.render(), 'crew').onChange
  const submitted = submit(f.render())
  chooseExisting()
  const tree = f.render()
  assert.equal(find(tree, node => node.type === 'fieldset' && node.props['data-testid'] === 'crew-mode-picker')[0].props.disabled, true)
  assert.equal(crewMode(tree, 'crew-managed').checked, true)
  pending.resolve({ success: true, state: workspaceState() })
  await submitted
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
  const first = submit(tree)
  await submit(tree)
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

const workspaceState = (overrides = {}) => ({ status: 'stopped', canStart: true, canOpen: false, canStop: false,
  selectedAccount: false, version: '0.12.0', message: '工作区就绪', messageEn: 'Workspace ready.', ...overrides })
function managedHarness(overrides = {}) {
  const h = harness(), managedCalls = []
  let current = workspaceState()
  const managedApi = {
    inspect: async id => { managedCalls.push(['inspect', id]); return current },
    start: async request => { managedCalls.push(['start', JSON.parse(JSON.stringify(request))]); current = workspaceState({ status: 'running', canStart: false, canOpen: true, canStop: true, selectedAccount: true }); return { success: true, state: current } },
    open: async request => { managedCalls.push(['open', JSON.parse(JSON.stringify(request))]); return { success: true, state: current } },
    stop: async request => { managedCalls.push(['stop', JSON.parse(JSON.stringify(request))]); current = workspaceState(); return { success: true, state: current } },
    chooseExecutable: async () => { managedCalls.push(['choose']); return { success: true } },
    ...overrides
  }
  return { h, managedCalls, render: props => h.render({ managedApi, ...props }), setState: value => { current = value } }
}

test('the independent Crew option is explicit and selection alone never starts or replaces a client', async () => {
  const f = managedHarness()
  f.render(); await drain()
  const tree = f.render()
  assert.equal(radio(tree, 'ide').checked, true)
  assert.ok(radio(tree, 'crew'))
  assert.ok(radio(tree, 'cli'))
  assert.equal(radio(tree, 'crew-managed'), undefined)
  selectCrew(f, 'crew-managed')
  assert.match(words(f.render()), /Recommended/)
  assert.deepEqual(f.managedCalls, [['inspect', 'account-a']])
  assert.equal(button(f.render(), 'Start and open').disabled, false)
  assert.match(words(f.render()), /Keep the manager running/)
})

test('independent Crew start and reopen use only the dedicated API and preserve the selected account', async () => {
  const f = managedHarness()
  f.render(); await drain()
  selectCrew(f, 'crew-managed')
  await submit(f.render()); await drain()
  assert.deepEqual(f.managedCalls.find(call => call[0] === 'start'), ['start', { accountId: 'account-a', operationId: 'operation-1' }])
  assert.equal(f.h.calls.some(call => ['execute', 'ide', 'disconnect', 'chooseExecutable'].includes(call[0])), false)
  assert.equal(button(f.render(), 'Open workspace').disabled, false)
  await submit(f.render()); await drain()
  assert.deepEqual(f.managedCalls.find(call => call[0] === 'open'), ['open', { accountId: 'account-a', operationId: 'operation-2' }])
  assert.equal(f.managedCalls.filter(call => call[0] === 'start').length, 1)
})

test('only the selected running workspace exposes stop and it never disconnects the existing Crew', async () => {
  const f = managedHarness()
  f.setState(workspaceState({ status: 'running', canStart: false, canOpen: true, canStop: true, selectedAccount: true }))
  f.render(); await drain()
  selectCrew(f, 'crew-managed')
  button(f.render(), 'Stop workspace').onClick(); await drain()
  assert.equal(f.managedCalls.filter(call => call[0] === 'stop').length, 1)
  assert.equal(f.h.calls.some(call => call[0] === 'disconnect'), false)
  assert.equal(button(f.render(), 'Start and open').disabled, false)
  f.setState(workspaceState({ status: 'running', canStart: false, canOpen: false, canStop: false, selectedAccount: false,
    messageEn: 'Another account owns the workspace. Stop it from that account first.' }))
  await button(f.render(), 'Refresh workspace').onClick(); await drain()
  assert.equal(button(f.render(), 'Stop workspace'), undefined)
  assert.equal(button(f.render(), 'Start and open').disabled, true)
  assert.match(words(f.render()), /Another account owns/)
})

test('independent executable selection does not alter the original Crew configuration', async () => {
  const f = managedHarness()
  f.render(); await drain(); selectCrew(f, 'crew-managed')
  button(f.render(), 'Choose installed client').onClick(); await drain()
  assert.equal(f.managedCalls.filter(call => call[0] === 'choose').length, 1)
  assert.equal(f.h.calls.some(call => call[0] === 'chooseExecutable'), false)
})

test('independent detection failure leaves the existing IDE and CLI paths usable', async () => {
  const f = managedHarness({ inspect: async () => { throw Error('SYNTHETIC_PRIVATE_PATH') } })
  f.render(); await drain()
  selectCrew(f, 'crew-managed')
  assert.equal(button(f.render(), 'Start and open').disabled, true)
  assert.doesNotMatch(words(f.render()), /SYNTHETIC_PRIVATE_PATH/)
  radio(f.render(), 'cli').onChange()
  assert.equal(button(f.render(), 'Switch account').disabled, false)
  radio(f.render(), 'ide').onChange()
  assert.equal(button(f.render(), 'Switch account').disabled, false)
})

test('a pending workspace start is single flight and its late reply cannot update another account dialog', async () => {
  const pending = deferred()
  let starts = 0
  const f = managedHarness({ start: () => { starts++; return pending.promise } })
  f.render(); await drain(); selectCrew(f, 'crew-managed')
  const tree = f.render()
  void submit(tree); void submit(tree)
  assert.equal(starts, 1)
  f.h.key('Escape')
  assert.equal(f.h.closed, 0)
  f.render({ accountId: 'account-b' }); await drain()
  pending.resolve({ success: true, state: workspaceState({ messageEn: 'Old account workspace started.' }) })
  await drain()
  const changed = f.render({ accountId: 'account-b' })
  assert.equal(radio(changed, 'ide').checked, true)
  assert.doesNotMatch(words(changed), /Old account workspace started/)
})

test('the product dialog uses the dedicated preload API when no test API prop is supplied', async () => {
  const calls = []
  const h = harness({}, { managedCrew: {
    inspect: async accountId => { calls.push(['inspect', accountId]); return workspaceState() },
    start: async request => { calls.push(['start', JSON.parse(JSON.stringify(request))]); return { success: true, state: workspaceState() } }
  } })
  h.render(); await drain()
  selectCrew(h, 'crew-managed')
  await submit(h.render()); await drain()
  assert.deepEqual(calls.find(call => call[0] === 'start'), ['start', { accountId: 'account-a', operationId: 'operation-1' }])
  assert.equal(h.calls.some(call => call[0] === 'execute'), false)
})
