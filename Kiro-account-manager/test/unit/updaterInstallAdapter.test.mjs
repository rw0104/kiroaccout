import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { AppUpdateController } from '../../src/main/appUpdater.ts'

test('actual BaseUpdater scheduled quit is blocked after an asynchronous NSIS launch failure', async () => {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('electron-updater/out/BaseUpdater.js'), 'utf8')
  const quitStart = source.indexOf('    quitAndInstall(isSilent = false, isForceRunAfter = false) {')
  const quitEnd = source.indexOf('    executeDownload(', quitStart)
  const installStart = source.indexOf('    install(isSilent = false, isForceRunAfter = false) {')
  const installEnd = source.indexOf('    addQuitHandler()', installStart)
  assert.ok(quitStart >= 0 && quitEnd > quitStart && installStart >= 0 && installEnd > installStart)
  const native = new EventEmitter()
  const actualQuit = new Function('require', `return ({${source.slice(quitStart, quitEnd)}}).quitAndInstall`)(() => ({ autoUpdater: native }))
  const actualInstall = new Function(`return ({${source.slice(installStart, installEnd)}}).install`)()
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
    install: actualInstall, quitAndInstall: actualQuit,
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
