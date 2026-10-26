import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { win32 as windowsPath } from 'node:path'
import { AppUpdateController } from '../../src/main/appUpdater.ts'

function actualInstallerMethods(native) {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('electron-updater/out/BaseUpdater.js'), 'utf8')
  const quitStart = source.indexOf('    quitAndInstall(isSilent = false, isForceRunAfter = false) {')
  const quitEnd = source.indexOf('    executeDownload(', quitStart)
  const installStart = source.indexOf('    install(isSilent = false, isForceRunAfter = false) {')
  const installEnd = source.indexOf('    addQuitHandler()', installStart)
  assert.ok(quitStart >= 0 && quitEnd > quitStart && installStart >= 0 && installEnd > installStart)
  const actualQuit = new Function('require', `return ({${source.slice(quitStart, quitEnd)}}).quitAndInstall`)(() => ({ autoUpdater: native }))
  const actualInstall = new Function(`return ({${source.slice(installStart, installEnd)}}).install`)()
  const nsis = readFileSync(require.resolve('electron-updater/out/NsisUpdater.js'), 'utf8')
  const nsisStart = nsis.indexOf('    doInstall(options) {')
  const nsisEnd = nsis.indexOf('    async differentialDownloadWebPackage(', nsisStart)
  assert.ok(nsisStart >= 0 && nsisEnd > nsisStart)
  const actualNsisInstall = new Function('path', 'process', 'require', `return ({${nsis.slice(nsisStart, nsisEnd)}}).doInstall`)(
    windowsPath, { resourcesPath: 'C:\\synthetic-resources' }, () => assert.fail('unexpected Electron shell fallback')
  )
  return { quitAndInstall: actualQuit, install: actualInstall, doInstall: actualNsisInstall }
}

test('actual Windows updater waits for saved data and launches NSIS with silent restart flags', async () => {
  for (const autoRunAppAfterInstall of [true, false]) {
    const native = new EventEmitter()
    const sequence = []
    const launches = []
    let finishSave
    const save = new Promise(resolve => { finishSave = resolve })
    const engine = Object.assign(new EventEmitter(), actualInstallerMethods(native), {
      autoDownload: true, autoInstallOnAppQuit: true, autoRunAppAfterInstall,
      allowPrerelease: true, allowDowngrade: true, channel: null,
      quitAndInstallCalled: false, installerPath: 'synthetic installer.exe',
      downloadedUpdateHelper: { downloadedFileInfo: {} }, _logger: { info() {}, warn() {} },
      checkForUpdates: async () => ({ updateInfo: { version: '1.7.7' } }),
      downloadUpdate: async () => { engine.emit('update-downloaded', { version: '1.7.7' }); return [] },
      dispatchError: error => engine.emit('error', error),
      spawnLog: async (file, args) => { sequence.push('launch'); launches.push({ file, args }); return true },
      app: { quit() { sequence.push('quit') } }
    })
    const controller = new AppUpdateController({ updater: engine, enabled: true, currentVersion: '1.7.6',
      notify() {}, prepareInstall: async () => { sequence.push('save'); await save; sequence.push('saved') },
      beforeInstall() { sequence.push('prepare') } })
    try {
      await controller.check()
      await controller.download()
      const installing = controller.install()
      await Promise.resolve()
      assert.deepEqual(sequence, ['save'])
      assert.deepEqual(launches, [])
      finishSave()
      assert.equal((await installing).success, true)
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(sequence, ['save', 'saved', 'prepare', 'launch', 'quit'])
      assert.deepEqual(launches, [{ file: 'synthetic installer.exe', args: ['--updated', '/S', '--force-run'] }])
    } finally {
      controller.dispose()
    }
  }
})

test('actual BaseUpdater scheduled quit is blocked after an asynchronous NSIS launch failure', async () => {
  const native = new EventEmitter()
  const methods = actualInstallerMethods(native)
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const start = main.indexOf("app.on('before-quit', (event) => {")
  const end = main.indexOf('\n})', start)
  assert.ok(start >= 0 && end > start)
  const handlerCode = main.slice(start + "app.on('before-quit', ".length, end + 2)
  let quitCalls = 0
  let prevented = 0
  let rollbacks = 0
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, autoRunAppAfterInstall: true,
    allowPrerelease: true, allowDowngrade: true, channel: null,
    quitAndInstallCalled: false, installerPath: 'synthetic-installer.exe',
    downloadedUpdateHelper: { downloadedFileInfo: {} }, _logger: { info() {}, warn() {} },
    checkForUpdates: async () => ({ updateInfo: { version: '1.7.7' } }),
    downloadUpdate: async () => { engine.emit('update-downloaded', { version: '1.7.7' }); return [] },
    install: methods.install, quitAndInstall: methods.quitAndInstall,
    dispatchError: error => engine.emit('error', error),
    doInstall() { queueMicrotask(() => engine.dispatchError(new Error('synthetic EPERM'))); return true },
    app: { quit() { beforeQuit({ preventDefault() { prevented++ } }); if (!prevented) quitCalls++ } }
  })
  const controller = new AppUpdateController({ updater: engine, enabled: true, currentVersion: '1.7.6',
    notify() {}, prepareInstall: async () => {}, beforeInstall() {}, installFailed() { rollbacks++ } })
  const gate = new Function('appUpdateController', `let updateQuitRequested = false; let updateInstallSave = null;
    return { mark() { updateQuitRequested = true }, beforeQuit: (${handlerCode}) };`)(controller)
  native.on('before-quit-for-update', () => gate.mark())
  const beforeQuit = gate.beforeQuit
  await controller.check(); await controller.download(); await controller.install()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(prevented, 1)
  assert.equal(quitCalls, 0)
  assert.equal(rollbacks, 1)
  assert.equal(controller.getState().status, 'error')
  assert.equal(controller.getState().installRequiresRestart, true)
  assert.equal(engine.quitAndInstallCalled, true, 'real dependency keeps its internal latch after async failure')
  assert.equal((await controller.install()).success, false)
  assert.equal((await controller.check()).status, 'error', 'a check must not erase the restart requirement')
  controller.dispose()
})
