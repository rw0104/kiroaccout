import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = name => readFileSync(new URL(`../../src/renderer/src/${name}`, import.meta.url), 'utf8')
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

function logHarness(detailed = false, apiOverrides = {}, preferences = {}) {
  const name = detailed ? 'components/proxy/ProxyDetailedLogsDialog.tsx' : 'components/pages/LogsPage.tsx'
  const component = detailed ? 'ProxyDetailedLogsDialog' : 'LogsPage'
  let text = source(name)
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === component)
  const lastReturn = [...declaration.body.statements].reverse().find(ts.isReturnStatement)
  text = text.slice(0, lastReturn.getStart(tree)) + `return { logs, refresh: ${detailed ? 'loadLogs' : 'fetchLogs'}, clear: ${detailed ? 'handleClearLogs' : 'handleClear'}, filteredLogs, search: ${detailed ? 'setSearchText' : 'setFilter'}, exportLogs: ${detailed ? 'handleExportLogs' : 'handleExport'} };` + text.slice(lastReturn.end)
  if (detailed) text = text.replace('if (!open) return null', 'if (!open) return { logs, filteredLogs }')
  const states = [], refs = [], memos = [], effects = [], timers = new Map()
  let stateIndex, refIndex, memoIndex, effectIndex, dirty = false, nextTimer = 1, visible = false, snapshot, mounted = true, lateUpdates = 0, props = { open: true, onOpenChange() {} }
  const calls = [], downloads = []
  const row = id => ({ id, timestamp: '2030-01-01T00:00:00Z', level: 'INFO', category: 'Synthetic', message: `Message ${id}` })
  const api = {
    proxyGetLogPage: async (cursor, limit) => { calls.push({ cursor, limit }); return { entries: cursor ? [] : [row('1')], nextCursor: 'epoch:1', epoch: 'epoch', reset: !cursor, hasMore: false, total: 1 } },
    proxyGetLogs: async () => { calls.push({ legacy: true }); return [row('1')] }, proxyGetLogsCount: async () => 1, proxyClearLogs: async () => {}, ...apiOverrides
  }
  const hooks = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { if (!mounted) lateUpdates++; const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; dirty = true } }] },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial } },
    useMemo(create, deps) { const index = memoIndex++; if (!equal(memos[index]?.deps, deps)) memos[index] = { deps, value: create() }; return memos[index].value },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps) },
    useEffect(run, deps) { const index = effectIndex++; const old = effects[index]; if (!equal(old?.deps, deps)) effects[index] = { deps, run, cleanup: old?.cleanup, pending: true } }
  }
  const exports = {}, modules = new Map()
  const context = vm.createContext({ exports, console: { error() {} }, Date, TextEncoder,
    window: { api }, document: { hidden: false, createElement: () => ({ click() {} }) },
    Blob, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:synthetic' }, revokeObjectURL() {} },
    localStorage: { getItem(key) { return preferences[key] ?? null }, setItem() {} },
    setTimeout(run, delay) { const id = nextTimer++; timers.set(id, { run, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    setInterval(run, delay) { const id = nextTimer++; timers.set(id, { run, delay, interval: true }); return id }, clearInterval(id) { timers.delete(id) },
    require(name) {
      if (name === 'react') return hooks
      if (name.includes('useWindowVisibility')) return { useWindowVisibility: () => visible }
      if (name.includes('useTranslation')) return { useTranslation: () => ({ t: () => 'Unknown' }) }
      if (name === '@tanstack/react-virtual') return { useVirtualizer: () => ({ scrollToIndex() {} }) }
      if (name.includes('useProxyLogs') || name.includes('proxyLogPolling')) {
        const filename = name.includes('useProxyLogs') ? 'hooks/useProxyLogs.ts' : 'lib/proxyLogPolling.ts'
        if (!modules.has(filename)) {
          const module = {}
          vm.runInContext(`(function(exports, require) {${compile(source(filename))}\n})`, context)(module, context.require)
          modules.set(filename, module)
        }
        return modules.get(filename)
      }
      return {}
    }
  })
  vm.runInContext(compile(text), context)
  const render = () => {
    stateIndex = refIndex = memoIndex = effectIndex = 0; dirty = false
    snapshot = exports[component](props)
    for (const effect of effects) if (effect?.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.run() }
    return snapshot
  }
  return { api, calls, timers, downloads, render, get current() { return snapshot }, get lateUpdates() { return lateUpdates },
    show(value) { visible = value; render() }, close() { props = { ...props, open: false }; render() },
    async flush() { for (let index = 0; index < 20; index++) { await settle(); if (!dirty) return; render() } },
    async tick(delay = 1500) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { if (!timer.interval) timers.delete(id); timer.run() }; await this.flush() },
    unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.() }
  }
}

test('real log views issue no visual IPC while native visibility is hidden and resume incrementally', async () => {
  for (const detailed of [false, true]) {
    const h = logHarness(detailed)
    h.render(); await h.flush()
    assert.equal(h.calls.length, 0)
    h.show(true); await h.flush()
    assert.equal(h.calls.length, 1)
    assert.equal(h.current.logs.length, 1)
    h.show(false); await h.flush()
    for (let index = 0; index < 40; index++) await h.tick()
    assert.equal(h.calls.length, 1)
    h.show(true); await h.flush()
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].cursor, 'epoch:1')
    assert.equal(h.current.filteredLogs.length, 1)
    h.unmount()
  }
})

test('closing details releases history and late responses cannot restore closed or unmounted views', async () => {
  const h = logHarness(true)
  h.show(true); await h.flush()
  assert.equal(h.current.logs.length, 1)
  h.close(); await h.flush()
  assert.equal(h.current.logs.length, 0)
  let finish
  const pending = logHarness(false, { proxyGetLogs: () => new Promise(resolve => { finish = resolve }), proxyGetLogPage: () => new Promise(resolve => { finish = resolve }) })
  pending.show(true); await settle()
  pending.unmount()
  finish({ entries: [], nextCursor: 'epoch:1', epoch: 'epoch', reset: true, hasMore: false, total: 0 })
  await settle()
  assert.equal(pending.lateUpdates, 0)
})

test('manual refresh and polling share one actual transport even when a response stalls', async () => {
  let calls = 0
  const never = () => { calls++; return new Promise(() => {}) }
  for (const detailed of [false, true]) {
    calls = 0
    const h = logHarness(detailed, { proxyGetLogPage: never, proxyGetLogs: never })
    h.show(true); await settle()
    for (let index = 0; index < 20; index++) { h.current.refresh(); await h.tick() }
    assert.equal(calls, 1)
    await h.tick(10000)
    for (let index = 0; index < 20; index++) await h.tick()
    assert.equal(calls, 1, 'a logical timeout must not multiply unresolved IPC transports')
    h.unmount()
  }
})

test('detail display limit applies after searching retained history and export includes the complete bounded history', async () => {
  const history = Array.from({ length: 2500 }, (_, index) => ({ id: String(index), timestamp: '2030-01-01T00:00:00Z',
    level: 'INFO', category: 'Synthetic', message: index === 0 ? 'Archive Needle' : `Recent message ${index}` }))
  const h = logHarness(true, { proxyGetLogPage: async cursor => {
    const start = cursor ? Number(cursor.split(':')[1]) : 0
    const entries = history.slice(start, start + 500)
    const end = start + entries.length
    return { entries, reset: !cursor, nextCursor: `epoch:${end}`, epoch: 'epoch', hasMore: end < history.length, total: history.length }
  } }, { proxyLogs_displayLimit: '100' })
  h.show(true); await h.flush(); await h.tick(50)
  h.current.search('Archive Needle'); await h.flush()
  assert.equal(h.current.filteredLogs.length, 1)
  assert.equal(h.current.filteredLogs[0].id, '0', 'a retained match outside the most recent 100 must remain searchable')
  h.current.exportLogs()
  assert.equal(h.downloads.length, 1)
  const exported = await h.downloads[0].text()
  assert.equal(exported.split('\n').length, 2500)
  assert.match(exported, /Archive Needle/)
  assert.match(exported, /Recent message 2499/)
  h.unmount()
})

function taskHarness(saved = [], Clock = Date) {
  let state, persisted = ''
  const exports = {}
  vm.runInNewContext(compile(source('store/tasks.ts')), { exports, crypto: { randomUUID }, Date: Clock,
    localStorage: { getItem: () => JSON.stringify(saved), setItem(_key, value) { persisted = value } },
    require(name) { if (name !== 'zustand') throw new Error(name); return { create: () => initializer => {
      const get = () => state; const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }; state = initializer(set, get); return { getState: get }
    } } }
  })
  return { get state() { return state }, get persisted() { return persisted } }
}

test('real task store caps completed history in memory while preserving every active task and releasing terminal callbacks', () => {
  const h = taskHarness()
  const active = Array.from({ length: 225 }, (_, index) => h.state.createTask({ title: `Active ${index}`, kind: 'register-batch', total: 1, status: index % 2 ? 'running' : 'paused', onCancel() {} }))
  for (let index = 0; index < 400; index++) {
    const id = h.state.createTask({ title: `Finished ${index}`, kind: 'register-batch', total: 1, onCancel() {}, onPause() {}, onResume() {} })
    h.state.completeTask(id)
  }
  assert.equal(h.state.tasks.size, 425)
  for (const id of active) assert.ok(h.state.tasks.has(id))
  const finished = [...h.state.tasks.values()].filter(task => !['running', 'paused'].includes(task.status))
  assert.equal(finished.length, 200)
  assert.equal(finished.every(task => !task.onCancel && !task.onPause && !task.onResume), true)
  assert.equal(finished.some(task => task.title === 'Finished 399'), true)
  assert.equal(JSON.parse(h.persisted).length, 200)
})

test('task loading is bounded and cancellation calls the active callback before terminal cleanup', () => {
  const h = taskHarness(Array.from({ length: 450 }, (_, index) => ({ id: `old-${index}`, status: 'success', updatedAt: index, createdAt: index })))
  assert.equal(h.state.tasks.size, 200)
  let calls = 0, status
  const id = h.state.createTask({ title: 'Cancel', kind: 'register-batch', total: 1, onCancel() { calls++; status = h.state.tasks.get(id).status } })
  h.state.cancelTask(id)
  assert.equal(calls, 1)
  assert.equal(status, 'running')
  assert.equal(h.state.tasks.get(id).status, 'cancelled')
  assert.equal(h.state.tasks.get(id).onCancel, undefined)
  h.state.cancelTask(id)
  assert.equal(calls, 1)
})

test('tasks completed in the same millisecond retain the newest 200 instead of alternating history order', () => {
  const h = taskHarness([], class extends Date { static now() { return 1000 } })
  for (let index = 0; index < 400; index++) {
    const id = h.state.createTask({ title: String(index), kind: 'register-batch', total: 1 })
    h.state.completeTask(id)
  }
  assert.deepEqual([...h.state.tasks.values()].map(task => Number(task.title)), Array.from({ length: 200 }, (_, index) => index + 200))
})
