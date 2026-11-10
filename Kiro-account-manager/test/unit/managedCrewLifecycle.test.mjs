/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript harness executes actual lifecycle code with mocked boundaries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { AppUpdateController, UpdatePreparationError } from '../../src/main/appUpdater.ts'

const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
function find(predicate) {
  let result
  const visit = node => { if (predicate(node)) result = node; ts.forEachChild(node, visit) }
  visit(tree); assert.ok(result)
  return result
}
const declaration = name => find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree)
const callback = (owner, event) => find(node => ts.isCallExpression(node) && node.expression.getText(tree) === owner && node.arguments[0]?.text === event).arguments[1].getText(tree)
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function quitFixture({ tray = false } = {}) {
  const stopping = deferred(), calls = [], errors = []
  let prevented = 0, allowed = 0
  const context = vm.createContext({
    updateQuitRequested: false, managedQuitReady: false, managedQuitPending: undefined, updateInstallSave: null,
    isQuitting: tray,
    managedCrewService: { suspendAndStop: () => { calls.push('stop'); return stopping.promise }, resume: () => calls.push('resume') },
    appUpdateController: { canQuitForUpdate: () => false, dispose: () => calls.push('dispose-updater') },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }) },
    clearTimeout: () => calls.push('clear-save-timer'),
    app: { quit: () => { calls.push('quit-again'); invoke() } }
  })
  vm.runInContext(compile(`globalThis.beforeQuit = ${callback('app.on', 'before-quit')}`), context)
  function invoke() {
    let blocked = false
    context.beforeQuit({ preventDefault() { prevented++; blocked = true } })
    if (!blocked) allowed++
  }
  return { context, stopping, calls, errors, invoke, counts: () => ({ prevented, allowed }) }
}

test('actual before-quit waits once for the owned workspace even when tray exit already set isQuitting', async () => {
  for (const tray of [false, true]) {
    const f = quitFixture({ tray })
    f.invoke(); f.invoke()
    assert.deepEqual(f.calls, ['stop'])
    assert.deepEqual(f.counts(), { prevented: 2, allowed: 0 })
    f.stopping.resolve(); await settle()
    assert.deepEqual(f.calls, ['stop', 'quit-again', 'dispose-updater'])
    assert.equal(f.context.managedQuitReady, true)
    assert.equal(f.counts().allowed, 1)
  }
})

test('failed owned shutdown cancels quit, resumes controls and restores the tray close state without exposing errors', async () => {
  const f = quitFixture({ tray: true })
  f.invoke()
  f.stopping.reject(Error('SYNTHETIC_PRIVATE_STOP_PATH_AND_TOKEN')); await settle()
  assert.deepEqual(f.calls, ['stop', 'resume'])
  assert.equal(f.counts().allowed, 0)
  assert.equal(f.context.managedQuitReady, false)
  assert.equal(f.context.isQuitting, false)
  assert.equal(f.errors.length, 1)
  assert.doesNotMatch(JSON.stringify(f.errors), /SYNTHETIC_PRIVATE/)
})

test('an unprepared updater quit stays rejected before touching the owned workspace', async () => {
  const f = quitFixture()
  f.context.updateQuitRequested = true
  f.invoke(); await settle()
  assert.deepEqual(f.calls, [])
  assert.equal(f.counts().allowed, 0)
  assert.equal(f.context.updateQuitRequested, false)
})

test('a pending renderer save is rejected only on the final allowed quit after workspace shutdown', async () => {
  const f = quitFixture(), rejected = []
  f.context.updateInstallSave = { timer: {}, reject: code => rejected.push(code) }
  f.invoke()
  assert.deepEqual(rejected, [])
  f.stopping.resolve(); await settle()
  assert.deepEqual(rejected, ['window-unavailable'])
  assert.equal(f.context.updateInstallSave, null)
})

function setupFixture() {
  const legacy = { bindings: [{ runtimeId: 'crew:existing', status: 'active' }], config: { crew: { executablePath: 'SYNTHETIC_ORIGINAL_CREW' } } }
  const storage = new Map([['clientAccessBindings', legacy.bindings], ['clientSwitchRuntimes', legacy.config]])
  const reads = [], writes = [], calls = [], services = [], registries = []
  let registration, picker = async () => ({ canceled: false, filePaths: [path.resolve('synthetic-official/KiroCrew.exe')] })
  class Registry {
    constructor(deps) { this.deps = deps; registries.push(this) }
    async crewInstallation() { calls.push('installation'); return { version: '0.12.0', executablePath: 'SYNTHETIC_OFFICIAL' } }
    async configure(target, executablePath) { calls.push('configure'); assert.equal(target, 'crew'); this.deps.writeConfig(target, { executablePath }) }
  }
  class Service {
    busy = false
    constructor(deps) { this.deps = deps; services.push(this) }
  }
  const context = vm.createContext({
    join: path.join, __dirname: path.resolve('synthetic/resources/app.asar/out/main'),
    app: { getPath: name => { assert.equal(name, 'userData'); return path.resolve('synthetic-manager-data') } },
    store: { get: key => { reads.push(key); return storage.get(key) }, set: (key, value) => { writes.push(key); storage.set(key, value) } },
    process: { platform: 'win32', env: { KIROCREW_HOME: 'SYNTHETIC_ORIGINAL_HOME' } }, is: { dev: false },
    ClientRuntimeRegistry: Registry, ManagedCrewService: Service,
    ManagedCrewWindowController: class { open() { calls.push('window-open'); return Promise.resolve() } close() { calls.push('window-close') } },
    BrowserWindow: class {}, mainWindow: { id: 'synthetic-main-window' }, ipcMain: {},
    getClientProjectionAccess: id => ({ selected: id }), instanceAccountOwnership: { beginOperation: () => () => {} },
    createManagedCrewRuntime: options => { calls.push('make-runtime'); return options },
    registerManagedCrewIpc: deps => { registration = deps }, requireTrustedMainWindow: () => calls.push('trusted'),
    dialog: { showOpenDialog: (...args) => { calls.push('picker'); return picker(...args) } }, managedCrewService: undefined
  })
  vm.runInContext(compile(`${declaration('setupManagedCrew')}; setupManagedCrew()`), context)
  return { context, storage, legacy, reads, writes, calls, registration, service: services[0], registry: registries[0],
    setPicker: value => { picker = value } }
}

test('the actual managed setup has independent storage/runtime roots and never hydrates or migrates legacy Crew bindings', async () => {
  const f = setupFixture()
  const before = JSON.stringify(f.legacy)
  const deps = f.service.deps
  assert.equal(deps.readBinding(), undefined)
  const binding = { revision: 'managed-one', accountId: 'synthetic' }
  assert.equal(deps.writeBinding(binding, undefined), true)
  assert.equal(deps.writeBinding({ ...binding, revision: 'stale' }, undefined), false)
  assert.equal(f.storage.get('managedCrewBinding'), binding)
  const runtime = await deps.runtime()
  assert.equal(runtime.root, path.resolve('synthetic-manager-data/managed-crew/workspace-v1'))
  assert.match(runtime.resources, /app\.asar\.unpacked[\\/]resources[\\/]crew-managed$/)
  assert.match(f.registry.deps.env.KIROCREW_HOME, /managed-crew[\\/]workspace-v1[\\/]data$/)
  assert.equal(f.context.process.env.KIROCREW_HOME, 'SYNTHETIC_ORIGINAL_HOME')
  assert.equal(f.reads.includes('clientAccessBindings'), false)
  assert.equal(f.reads.includes('clientSwitchRuntimes'), false)
  assert.deepEqual(f.writes, ['managedCrewBinding'])
  assert.equal(JSON.stringify(f.legacy), before)
  f.registration.trusted({})
  assert.equal(f.calls.at(-1), 'trusted')
})

test('the actual managed executable picker saves only its own configuration and rejects an in-flight workspace', async () => {
  const f = setupFixture()
  f.service.busy = true
  assert.equal((await f.registration.chooseExecutable()).success, false)
  assert.equal(f.calls.includes('picker'), false)
  f.service.busy = false
  assert.equal((await f.registration.chooseExecutable()).success, true)
  assert.deepEqual(f.writes, ['managedCrewExecutable'])
  assert.equal(f.storage.get('clientSwitchRuntimes'), f.legacy.config)
  const pending = deferred()
  f.setPicker(() => pending.promise)
  const choosing = f.registration.chooseExecutable()
  f.service.busy = true
  pending.resolve({ canceled: false, filePaths: [path.resolve('synthetic-other/KiroCrew.exe')] })
  assert.equal((await choosing).success, false)
  assert.equal(f.calls.filter(call => call === 'configure').length, 1)
})

function updateFixture(t) {
  const calls = [], sent = [], stopping = deferred()
  let ack, installerFails = false
  const engine = Object.assign(new EventEmitter(), {
    setFeedURL: () => calls.push('feed'), autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, channel: null,
    checkForUpdates: async () => ({ updateInfo: { version: '1.10.4' } }),
    downloadUpdate: async () => { engine.emit('update-downloaded', { version: '1.10.4' }) },
    quitAndInstall: () => { calls.push('installer'); if (installerFails) throw Error('SYNTHETIC_PRIVATE_INSTALL_ERROR') }
  })
  const context = vm.createContext({ AppUpdateController, UpdatePreparationError,
    appUpdateController: null, autoUpdater: engine, app: { isPackaged: true, getVersion: () => '1.10.3' },
    process: { platform: 'win32' }, publishUpdateState: () => {},
    managedCrewService: { suspendAndStop: () => { calls.push('workspace-stop'); return stopping.promise }, resume: () => calls.push('workspace-resume') },
    managedQuitReady: false, managedQuitPending: undefined, updateInstallSave: null, updatePoolWasRunning: false,
    mainPoolRefreshTimer: {}, isQuitting: false,
    stopMainPoolTokenRefresh: () => calls.push('pool-stop'), startMainPoolTokenRefresh: () => calls.push('pool-resume'),
    mainWindow: { isDestroyed: () => false, webContents: { id: 7, send: (...args) => sent.push(args) } },
    randomUUID: () => 'synthetic-update-save', setTimeout, clearTimeout,
    ipcMain: { on: (_event, callback) => { ack = callback } }
  })
  vm.runInContext(compile(`${declaration('prepareUpdateInstall')}; ${declaration('setupAutoUpdater')};
    ipcMain.on('confirm-app-update-save', ${callback('ipcMain.on', 'confirm-app-update-save')}); setupAutoUpdater()`), context)
  const controller = context.appUpdateController
  t.after(() => controller.dispose())
  return { calls, sent, stopping, context, controller,
    confirm: success => ack({ sender: { id: 7 } }, { requestId: context.updateInstallSave?.requestId, success }),
    failInstaller: () => { installerFails = true } }
}

test('actual update setup waits for saved accounts and owned workspace shutdown before invoking the installer', async t => {
  const f = updateFixture(t)
  await f.controller.check(); await f.controller.download()
  const installing = f.controller.install(); await settle()
  assert.equal(f.calls.includes('workspace-stop'), false)
  f.confirm(true); await settle()
  assert.equal(f.calls.includes('workspace-stop'), true)
  assert.equal(f.calls.includes('installer'), false)
  assert.equal(f.context.isQuitting, false)
  f.stopping.resolve()
  assert.equal((await installing).success, true)
  assert.deepEqual(f.calls.slice(-3), ['workspace-stop', 'pool-stop', 'installer'])
  assert.equal(f.context.managedQuitReady, true)
  assert.equal(f.context.isQuitting, true)
})

test('workspace-stop-failed from the actual updater setup prevents installation and exposes only its fixed remediation', async t => {
  const f = updateFixture(t)
  await f.controller.check(); await f.controller.download()
  const installing = f.controller.install(); await settle(); f.confirm(true); await settle()
  f.stopping.reject(Error('SYNTHETIC_PRIVATE_STOP_PATH_AND_TOKEN'))
  const result = await installing
  assert.equal(result.success, false)
  assert.equal(result.state.errorStage, 'install')
  assert.match(result.error, /独立 Crew 工作区已停止/)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/)
  assert.equal(f.calls.includes('installer'), false)
  assert.equal(f.calls.includes('pool-stop'), false)
  assert.equal(f.context.isQuitting, false)
  assert.equal(f.controller.canQuitForUpdate(), false)
})

test('an installer failure resumes managed controls and the original refresh scheduler without quitting', async t => {
  const f = updateFixture(t)
  await f.controller.check(); await f.controller.download(); f.failInstaller()
  const installing = f.controller.install(); await settle(); f.confirm(true); f.stopping.resolve()
  const result = await installing
  assert.equal(result.success, false)
  assert.equal(f.context.isQuitting, false)
  assert.equal(f.context.managedQuitReady, false)
  assert.ok(f.calls.includes('workspace-resume'))
  assert.ok(f.calls.includes('pool-resume'))
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE/)
})
