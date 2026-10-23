import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { trackWindowVisibility } from '../../src/main/windowVisibility.ts'
import { createWindowVisibilityStore, type WindowVisibilityState } from '../../src/shared/windowVisibility.ts'

test('native hidden and minimized states pause visual activity without affecting business work', () => {
  const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { isDestroyed: () => boolean; send: (channel: string, state: WindowVisibilityState) => void }; isDestroyed: () => boolean; isVisible: () => boolean; isMinimized: () => boolean }
  let visible = false
  let minimized = false
  const sent: WindowVisibilityState[] = []
  window.isDestroyed = () => false
  window.isVisible = () => visible
  window.isMinimized = () => minimized
  window.webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_channel: string, state: WindowVisibilityState) => { sent.push(state) } })
  const tracker = trackWindowVisibility(window)
  assert.deepEqual(tracker.getSnapshot(), { visible: false, revision: 0 })
  visible = true; window.emit('show')
  assert.deepEqual(sent.at(-1), { visible: true, revision: 1 })
  minimized = true; window.emit('minimize')
  assert.deepEqual(sent.at(-1), { visible: false, revision: 2 })
  minimized = false; window.emit('restore')
  assert.deepEqual(sent.at(-1), { visible: true, revision: 3 })
  visible = false; window.emit('hide')
  window.webContents.emit('did-finish-load')
  assert.deepEqual(sent.at(-1), { visible: false, revision: 4 })
  window.emit('closed')
  assert.equal(window.eventNames().length, 0)
  assert.equal(window.webContents.eventNames().length, 0)
})

test('all views share one native listener and delayed snapshots cannot undo newer hide/show events', async () => {
  let callback: ((state: WindowVisibilityState) => void) | undefined
  let resolve: ((state: WindowVisibilityState) => void) | undefined
  let attached = 0
  let detached = 0
  const store = createWindowVisibilityStore({
    getWindowVisibility: () => new Promise(done => { resolve = done }),
    onWindowVisibilityChanged: listener => { attached++; callback = listener; return () => { detached++ } }
  })
  assert.equal(store.getSnapshot(), false)
  let updates = 0
  const first = store.subscribe(() => { updates++ })
  const second = store.subscribe(() => { updates++ })
  assert.equal(attached, 1)
  callback!({ visible: true, revision: 2 })
  resolve!({ visible: false, revision: 0 })
  await Promise.resolve()
  assert.equal(store.getSnapshot(), true)
  assert.equal(updates, 2)
  callback!({ visible: false, revision: 3 })
  assert.equal(store.getSnapshot(), false)
  first(); assert.equal(detached, 0)
  second(); assert.equal(detached, 1)
  callback!({ visible: true, revision: 4 })
  assert.equal(store.getSnapshot(), false)
})

test('a remounted view ignores a previous subscription generation and reads fresh native state', async () => {
  const callbacks: Array<(state: WindowVisibilityState) => void> = []
  const resolvers: Array<(state: WindowVisibilityState) => void> = []
  const store = createWindowVisibilityStore({
    getWindowVisibility: () => new Promise(resolve => { resolvers.push(resolve) }),
    onWindowVisibilityChanged: callback => { callbacks.push(callback); return () => {} }
  })
  const first = store.subscribe(() => {})
  first()
  const second = store.subscribe(() => {})
  callbacks[0]({ visible: true, revision: 100 })
  resolvers[0]({ visible: true, revision: 100 })
  await Promise.resolve()
  assert.equal(store.getSnapshot(), false)
  resolvers[1]({ visible: true, revision: 0 })
  await Promise.resolve()
  assert.equal(store.getSnapshot(), true)
  callbacks[1]({ visible: false, revision: 1 })
  assert.equal(store.getSnapshot(), false)
  second()
})
