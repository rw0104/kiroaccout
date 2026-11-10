import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

// Compile the actual window controller without importing or starting Electron.
const source = readFileSync(new URL('../../src/main/managedCrewWindow.ts', import.meta.url), 'utf8')
const exportsObject: Record<string, unknown> = {}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText, { exports: exportsObject, URL })
const Controller = exportsObject.ManagedCrewWindowController as typeof import('../../src/main/managedCrewWindow').ManagedCrewWindowController
const options = exportsObject.managedCrewWindowOptions as () => BrowserWindowConstructorOptions
const url = 'http://127.0.0.1:54321/?token=SYNTHETIC_ONE_USE_TOKEN'
const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  shows = 0
  focuses = 0
  restores = 0
  destroys = 0
  loaded: string[] = []
  loading: Promise<void> = Promise.resolve()
  openHandler?: () => { action: string }
  permission?: (_contents: unknown, _permission: unknown, callback: (granted: boolean) => void) => void
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (handler: () => { action: string }) => { this.openHandler = handler },
    session: { setPermissionRequestHandler: (handler: FakeWindow['permission']) => { this.permission = handler } }
  })
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
  restore(): void { this.restores++; this.minimized = false }
  show(): void { this.shows++ }
  focus(): void { this.focuses++ }
  loadURL(value: string): Promise<void> { this.loaded.push(value); return this.loading }
  destroy(): void { this.destroys++; this.destroyed = true; this.emit('closed') }
}
function fixture(): { controller: InstanceType<typeof Controller>; windows: FakeWindow[]; configurations: BrowserWindowConstructorOptions[] } {
  const windows: FakeWindow[] = [], configurations: BrowserWindowConstructorOptions[] = []
  const controller = new Controller(config => {
    configurations.push(config)
    const window = new FakeWindow(); windows.push(window)
    return window as unknown as BrowserWindow
  })
  return { controller, windows, configurations }
}

test('managed Crew window has an isolated partition and no manager preload or Node authority', async () => {
  const prefs = options().webPreferences!
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.webSecurity, true)
  assert.equal(prefs.preload, undefined)
  assert.equal(prefs.webviewTag, undefined)
  assert.equal(prefs.partition, 'persist:kiroaccout-crew-managed-v1')
  const f = fixture()
  await f.controller.open(url, () => {})
  assert.equal(f.configurations.length, 1)
  assert.equal(f.windows[0].shows, 1)
  let granted: boolean | undefined
  f.windows[0].permission?.({}, 'media', value => { granted = value })
  assert.equal(granted, false)
  f.controller.close()
})

test('invalid origins or URL shapes are rejected before a browser window can be created', async () => {
  const f = fixture()
  for (const value of ['https://example.invalid/?token=x', 'file:///private', 'javascript:alert(1)',
    'http://localhost:54321/?token=x', 'http://127.0.0.1/?token=x', 'http://127.0.0.1:54321/',
    'http://user:password@127.0.0.1:54321/?token=x', 'http://127.0.0.1:54321/other?token=x',
    'http://127.0.0.1:54321/?token=x&root=private']) await assert.rejects(f.controller.open(value, () => {}))
  assert.equal(f.windows.length, 0)
})

test('navigation, redirects, webviews and popup windows cannot escape the owned loopback origin', async () => {
  const f = fixture(); await f.controller.open(url, () => {})
  const window = f.windows[0]
  for (const type of ['will-navigate', 'will-redirect']) {
    for (const target of ['https://example.invalid/', 'http://127.0.0.1:54322/', 'file:///private', 'javascript:alert(1)', 'invalid-url']) {
      let prevented = false
      window.webContents.emit(type, { preventDefault: () => { prevented = true } }, target)
      assert.equal(prevented, true, `${type}/${target}`)
    }
    let prevented = false
    window.webContents.emit(type, { preventDefault: () => { prevented = true } }, 'http://127.0.0.1:54321/chat')
    assert.equal(prevented, false)
  }
  let webviewDenied = false
  window.webContents.emit('will-attach-webview', { preventDefault: () => { webviewDenied = true } })
  assert.equal(webviewDenied, true)
  assert.equal(window.openHandler?.().action, 'deny')
  f.controller.close()
})

test('reopening focuses the current window without replaying a one-use login token', async () => {
  const f = fixture(); let firstClosed = 0, replacementClosed = 0
  await f.controller.open(url, () => { firstClosed++ })
  f.windows[0].minimized = true
  await f.controller.open('http://127.0.0.1:54321/?token=SYNTHETIC_SECOND_TOKEN', () => { replacementClosed++ })
  assert.equal(f.windows.length, 1)
  assert.deepEqual(f.windows[0].loaded, [url])
  assert.equal(f.windows[0].restores, 1)
  assert.equal(f.windows[0].focuses, 1)
  await assert.rejects(f.controller.open('http://127.0.0.1:54322/?token=SYNTHETIC_OTHER', () => {}))
  assert.equal(f.windows[0].loaded.length, 1)
  f.windows[0].destroy(); f.windows[0].emit('closed')
  assert.equal(firstClosed, 1)
  assert.equal(replacementClosed, 0)
})

test('controller close never recursively invokes the user-close stop callback and old events cannot close a new window', async () => {
  const f = fixture(); let closed = 0
  await f.controller.open(url, () => { closed++ })
  const old = f.windows[0]
  f.controller.close(); f.controller.close()
  assert.equal(old.destroys, 1)
  assert.equal(closed, 0)
  await f.controller.open('http://127.0.0.1:54322/?token=SYNTHETIC_NEW', () => { closed++ })
  old.emit('closed')
  assert.equal(closed, 0)
  f.windows[1].destroy()
  assert.equal(closed, 1)
})

test('a pending load cannot show a window that has already been closed', async () => {
  const pending = deferred(), window = new FakeWindow(); window.loading = pending.promise
  const controller = new Controller(() => window as unknown as BrowserWindow)
  let closed = 0
  const opening = controller.open(url, () => { closed++ })
  controller.close(); pending.resolve()
  await assert.rejects(opening)
  assert.equal(window.shows, 0)
  assert.equal(closed, 0)
})
