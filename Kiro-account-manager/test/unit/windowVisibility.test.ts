import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { trackWindowVisibility } from '../../src/main/windowVisibility.ts'
import { createWindowVisibilityStore, type WindowVisibilityState } from '../../src/shared/windowVisibility.ts'

function createDestroyableWindow() {
  let windowDestroyed = false
  let contentsDestroyed = false
  const sent: WindowVisibilityState[] = []
  const requireLiveWindow = (): void => {
    if (windowDestroyed) throw new TypeError('Object has been destroyed')
  }
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => contentsDestroyed,
    send: (_channel: string, state: WindowVisibilityState) => {
      if (contentsDestroyed) throw new TypeError('Object has been destroyed')
      sent.push(state)
    }
  })
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => windowDestroyed,
    isVisible: () => { requireLiveWindow(); return true },
    isMinimized: () => { requireLiveWindow(); return false }
  }) as EventEmitter & {
    isDestroyed: () => boolean
    isVisible: () => boolean
    isMinimized: () => boolean
    webContents: typeof contents
  }
  Object.defineProperty(window, 'webContents', {
    get: () => { requireLiveWindow(); return contents }
  })
  return {
    window,
    contents,
    sent,
    destroyWindow: () => { windowDestroyed = true },
    destroyContents: () => { contentsDestroyed = true }
  }
}

test('closed cleanup succeeds after the native window and webContents are destroyed', () => {
  const fixture = createDestroyableWindow()
  const tracker = trackWindowVisibility(fixture.window)
  let referenceCleared = false
  fixture.window.once('closed', () => {
    tracker.dispose()
    referenceCleared = true
  })
  fixture.destroyContents()
  fixture.destroyWindow()
  assert.doesNotThrow(() => fixture.window.emit('closed'))
  assert.equal(referenceCleared, true)
  assert.doesNotThrow(() => tracker.dispose())
  assert.equal(fixture.window.eventNames().length, 0)
  assert.equal(fixture.contents.eventNames().length, 0)
})

test('late visibility and load callbacks stop when the native window is destroyed', () => {
  const fixture = createDestroyableWindow()
  const tracker = trackWindowVisibility(fixture.window)
  fixture.destroyWindow()
  assert.doesNotThrow(() => fixture.window.emit('hide'))
  assert.doesNotThrow(() => fixture.contents.emit('did-finish-load'))
  assert.deepEqual(fixture.sent, [])
  tracker.dispose()
})

test('destroyed webContents receives no visibility messages and can still be detached', () => {
  const fixture = createDestroyableWindow()
  const tracker = trackWindowVisibility(fixture.window)
  fixture.destroyContents()
  fixture.window.emit('hide')
  fixture.contents.emit('did-finish-load')
  assert.deepEqual(fixture.sent, [])
  assert.doesNotThrow(() => tracker.dispose())
  assert.equal(fixture.contents.eventNames().length, 0)
})

test('explicit disposal is repeatable and pending callbacks cannot publish after disposal', () => {
  const fixture = createDestroyableWindow()
  const tracker = trackWindowVisibility(fixture.window)
  const pendingLoad = fixture.contents.listeners('did-finish-load')[0]
  tracker.dispose()
  fixture.destroyContents()
  fixture.destroyWindow()
  assert.doesNotThrow(() => tracker.dispose())
  assert.doesNotThrow(() => pendingLoad())
  assert.deepEqual(fixture.sent, [])
  assert.equal(fixture.window.eventNames().length, 0)
  assert.equal(fixture.contents.eventNames().length, 0)
})

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
