import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
const clean = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness(overrides = {}) {
  const states = [], refs = [], dependencies = [], effects = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0
  const calls = { get: [], save: [], open: [], defaultWrites: [] }
  const api = {
    kiroInstances: { snapshot: async () => ({ success: true, value: { supported: true, instances: [
      { schemaVersion: 2, id: 'synthetic-instance', label: 'Synthetic managed IDE', launchStatus: 'stopped' }
    ] } }) },
    getKiroSettings: async target => { calls.get.push(clean(target)); return { settings: {} } },
    saveKiroSettings: async (patch, target) => { calls.save.push({ patch: clean(patch), target: clean(target) }); return { success: true } },
    openKiroSettingsFile: async target => { calls.open.push(clean(target)); return { success: true } },
    getKiroAvailableModels: async () => ({ models: [] }),
    openKiroMcpConfig: async () => { calls.defaultWrites.push('mcp'); return { success: true } },
    openKiroSteeringFolder: async () => { calls.defaultWrites.push('steering'); return { success: true } },
    openKiroSteeringFile: async () => { calls.defaultWrites.push('steering-file'); return { success: true } },
    createKiroDefaultRules: async () => { calls.defaultWrites.push('rules'); return { success: true } },
    deleteKiroSteeringFile: async () => { calls.defaultWrites.push('delete-steering'); return { success: true } },
    deleteMcpServer: async () => { calls.defaultWrites.push('delete-mcp'); return { success: true } },
    openExternal() {},
    ...overrides
  }
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update }]
    },
    useRef(initial) { return (refs[refIndex++] ??= { current: initial }) },
    useEffect(run, deps) {
      const index = effectIndex++
      if (!dependencies[index] || deps?.some((value, i) => value !== dependencies[index][i])) {
        dependencies[index] = deps
        effects.push(run)
      }
    }
  }
  const exports = {}
  const source = readFileSync(new URL('../../src/renderer/src/components/pages/KiroSettingsPage.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  vm.runInNewContext(compiled, {
    exports, window: { api }, confirm: () => true, console: { error() {} },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === '../ui') return Object.fromEntries(['Card', 'CardContent', 'CardHeader', 'CardTitle', 'Button', 'Toggle', 'Select'].map(type => [type, type]))
      if (name === '../kiro') return { SteeringEditor: 'SteeringEditor', McpServerEditor: 'McpServerEditor' }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: key => key === 'common.unknown' ? 'Unknown' : key }) }
      return {}
    }
  })
  return {
    calls, api,
    render() { stateIndex = 0; refIndex = 0; effectIndex = 0; return exports.KiroSettingsPage() },
    async flush() { for (const effect of effects.splice(0)) effect(); for (let i = 0; i < 8; i++) await Promise.resolve() },
    async ready() { this.render(); await this.flush(); return this.render() }
  }
}

function nodes(tree, predicate) {
  const matches = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (predicate(value)) matches.push(value)
    visit(value.props?.children)
  }
  visit(tree)
  return matches
}
const byId = (tree, id) => nodes(tree, node => node.props?.id === id)[0]
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join(' ') : tree && typeof tree === 'object' ? text(tree.props?.children) : ''
const button = (tree, label) => nodes(tree, node => node.type === 'Button' && text(node).trim() === label)[0]

test('A-B-A target switching cannot reuse the first model request for the latest A visit', async () => {
  const requests = []
  const ctx = harness({ getKiroAvailableModels: () => { const pending = deferred(); requests.push(pending); return pending.promise } })
  await ctx.ready()
  for (const value of ['instance:synthetic-instance', 'default']) {
    byId(ctx.render(), 'kiro-settings-target').props.onChange({ target: { value } })
    ctx.render(); await ctx.flush()
  }
  requests[2].resolve({ models: [{ id: 'latest-catalog', name: 'Latest' }] })
  await ctx.flush()
  requests[0].resolve({ models: [{ id: 'obsolete-catalog', name: 'Obsolete' }] })
  await ctx.flush()
  assert.match(JSON.stringify(ctx.render()), /latest-catalog/)
  assert.doesNotMatch(JSON.stringify(ctx.render()), /obsolete-catalog/)
})

test('late default resource operations do not reload another target or discard its unsaved settings', async () => {
  const pending = deferred()
  const ctx = harness({ createKiroDefaultRules: () => pending.promise })
  let tree = await ctx.ready()
  const operation = button(tree, 'Create Rules').props.onClick()
  byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  ctx.render(); await ctx.flush()
  byId(ctx.render(), 'kiro-memory').props.onChange('useOnly')
  const reads = ctx.calls.get.length
  pending.resolve({ success: true })
  await operation; await ctx.flush()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-memory').props.value, 'useOnly')
  assert.equal(button(tree, 'Save').props.disabled, false)
  assert.equal(ctx.calls.get.length, reads)
})

test('refreshing default resource lists preserves unsaved Memory settings on the same target', async () => {
  const ctx = harness()
  let tree = await ctx.ready()
  byId(tree, 'kiro-memory').props.onChange('useOnly')
  tree = ctx.render()
  await button(tree, 'Create Rules').props.onClick()
  await ctx.flush()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-memory').props.value, 'useOnly')
  assert.equal(button(tree, 'Save').props.disabled, false)
})

test('model refresh follows the selected settings target and ignores a late catalog from the old target', async () => {
  const requests = []
  const ctx = harness({ getKiroAvailableModels: target => { const pending = deferred(); requests.push({ target: clean(target), pending }); return pending.promise } })
  let tree = await ctx.ready()
  byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  ctx.render(); await ctx.flush()
  assert.deepEqual(requests.map(request => request.target), [{ type: 'default' }, { type: 'instance', instanceId: 'synthetic-instance' }])
  requests[1].pending.resolve({ models: [{ id: 'managed-model', name: 'Managed model' }] })
  await ctx.flush()
  assert.match(JSON.stringify(ctx.render()), /managed-model/)
  requests[0].pending.resolve({ models: [{ id: 'wrong-default-model', name: 'Wrong default' }] })
  await ctx.flush()
  assert.doesNotMatch(JSON.stringify(ctx.render()), /wrong-default-model/)
})

test('memory and workflows use verified values, preserve loaded choices, and save only changed fields', async () => {
  const ctx = harness({ getKiroSettings: async () => ({ settings: { memory: 'useOnly', workflowsEnabled: true } }) })
  let tree = await ctx.ready()
  const memory = byId(tree, 'kiro-memory')
  assert.ok(memory)
  assert.equal(memory.props.value, 'useOnly')
  assert.deepEqual(clean(memory.props.options.map(option => option.value)), ['off', 'useAndLearn', 'useWithoutLearning', 'useOnly'])
  assert.equal(byId(tree, 'kiro-workflows-enabled').props.checked, true)
  memory.props.onChange('useAndLearn')
  tree = ctx.render()
  await button(tree, 'Save').props.onClick()
  assert.deepEqual(ctx.calls.save, [{ patch: { memory: 'useAndLearn' }, target: { type: 'default' } }])
  assert.equal(byId(ctx.render(), 'kiro-memory').props.value, 'useAndLearn')
})

test('missing optional settings stay unset when another field is edited; failed saves retain changes for retry', async () => {
  let fail = true
  const ctx = harness()
  ctx.api.saveKiroSettings = async (patch, target) => {
    ctx.calls.save.push({ patch: clean(patch), target: clean(target) })
    return fail ? { success: false, error: 'Synthetic write failed' } : { success: true }
  }
  let tree = await ctx.ready()
  assert.equal(byId(tree, 'kiro-memory').props.value, 'off')
  byId(tree, 'kiro-workflows-enabled').props.onChange(true)
  await button(ctx.render(), 'Save').props.onClick()
  tree = ctx.render()
  assert.ok(text(tree).includes('Synthetic write failed'))
  assert.equal(button(tree, 'Save').props.disabled, false)
  fail = false
  await button(tree, 'Save').props.onClick()
  assert.deepEqual(ctx.calls.save.map(call => call.patch), [{ workflowsEnabled: true }, { workflowsEnabled: true }])
})

test('out-of-order target reads never replace the selected instance, and instance saves/open use its ID', async () => {
  const pendingDefault = deferred(), pendingInstance = deferred()
  const ctx = harness({ getKiroSettings: target => {
    ctx.calls.get.push(clean(target))
    return target.type === 'default' ? pendingDefault.promise : pendingInstance.promise
  } })
  let tree = await ctx.ready()
  const scope = byId(tree, 'kiro-settings-target')
  assert.ok(scope, 'target remains selectable during a pending read')
  scope.props.onChange({ target: { value: 'instance:synthetic-instance' } })
  ctx.render(); await ctx.flush()
  pendingInstance.resolve({ settings: { memory: 'useWithoutLearning' }, target: { type: 'instance', instanceId: 'synthetic-instance', label: 'Synthetic managed IDE', settingsPath: 'D:/Synthetic/User/settings.json' } })
  await ctx.flush()
  pendingDefault.resolve({ settings: { memory: 'useOnly' } })
  await ctx.flush()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-memory').props.value, 'useWithoutLearning')
  assert.equal(nodes(tree, node => node.type === 'SteeringEditor' || node.type === 'McpServerEditor').length, 0)
  assert.equal(button(tree, 'Add MCP Server'), undefined)
  assert.equal(button(tree, 'Create Rules'), undefined)
  byId(tree, 'kiro-memory').props.onChange('off')
  await button(ctx.render(), 'Save').props.onClick()
  await button(ctx.render(), 'Open File').props.onClick()
  assert.deepEqual(ctx.calls.save.at(-1), { patch: { memory: 'off' }, target: { type: 'instance', instanceId: 'synthetic-instance' } })
  assert.deepEqual(ctx.calls.open.at(-1), { type: 'instance', instanceId: 'synthetic-instance' })
  assert.deepEqual(ctx.calls.defaultWrites, [])
})

test('a failed target read disables saving and exposes the error without showing stale settings', async () => {
  const ctx = harness({ getKiroSettings: async () => ({ error: 'Synthetic invalid target' }) })
  const tree = await ctx.ready()
  assert.ok(text(tree).includes('Synthetic invalid target'))
  assert.equal(button(tree, 'Save').props.disabled, true)
  await button(tree, 'Save').props.onClick()
  assert.equal(ctx.calls.save.length, 0)
})

test('saving keeps the captured target locked and errors from an old file-open target are ignored', async () => {
  const save = deferred(), open = deferred()
  const ctx = harness()
  ctx.api.saveKiroSettings = (patch, target) => {
    ctx.calls.save.push({ patch: clean(patch), target: clean(target) })
    return save.promise
  }
  ctx.api.openKiroSettingsFile = () => open.promise
  let tree = await ctx.ready()
  const pendingOpen = button(tree, 'Open File').props.onClick()
  byId(tree, 'kiro-memory').props.onChange('useOnly')
  const pendingSave = button(ctx.render(), 'Save').props.onClick()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-settings-target').props.disabled, true)
  byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  assert.equal(byId(ctx.render(), 'kiro-settings-target').props.value, 'default')
  save.resolve({ success: true })
  await pendingSave
  byId(ctx.render(), 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  ctx.render(); await ctx.flush()
  open.resolve({ success: false, error: 'Stale default error' })
  await pendingOpen
  assert.equal(text(ctx.render()).includes('Stale default error'), false)
  assert.deepEqual(ctx.calls.save[0].target, { type: 'default' })
})

function inputHarness(component, props) {
  const states = [], refs = []
  let stateIndex = 0, refIndex = 0
  const exports = {}
  const hooks = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update }] },
    useRef(initial) { return refs[refIndex++] ??= { current: initial } },
    useEffect() {}
  }
  const source = readFileSync(new URL(`../../src/renderer/src/components/ui/${component}.tsx`, import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, {
    exports,
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: (type, properties) => ({ type, props: properties }), jsxs: (type, properties) => ({ type, props: properties }) }
      if (name.endsWith('/utils')) return { cn: () => '' }
      return {}
    }
  })
  return { render() { stateIndex = 0; refIndex = 0; return exports[component](props) } }
}

test('Select and Toggle forward field labels and block disabled mouse/keyboard changes', () => {
  let changes = 0
  const props = { id: 'synthetic-setting', 'aria-describedby': 'synthetic-hint', disabled: true, value: 'off', checked: false, options: [{ value: 'off', label: 'Off' }], onChange() { changes++ } }
  const select = inputHarness('Select', props)
  let trigger = nodes(select.render(), node => node.type === 'button')[0]
  assert.equal(trigger.props.id, props.id)
  assert.equal(trigger.props['aria-describedby'], 'synthetic-hint')
  assert.equal(trigger.props.disabled, true)
  trigger.props.onClick()
  trigger.props.onKeyDown({ key: 'Enter', preventDefault() { throw new Error('disabled key must be ignored') } })
  assert.equal(nodes(select.render(), node => node.props?.role === 'listbox').length, 0)
  trigger = inputHarness('Toggle', props).render()
  assert.equal(trigger.props.id, props.id)
  assert.equal(trigger.props.disabled, true)
  trigger.props.onClick()
  assert.equal(changes, 0)

  const enabled = inputHarness('Select', { ...props, disabled: undefined })
  nodes(enabled.render(), node => node.type === 'button')[0].props.onClick()
  const menu = nodes(enabled.render(), node => node.props?.role === 'listbox')[0]
  assert.ok(menu, 'optional disabled prop preserves existing enabled behavior')
  nodes(menu, node => node.type === 'button')[0].props.onClick()
  assert.equal(changes, 1)
})
