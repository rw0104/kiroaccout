import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import * as updaterModule from '../../src/main/appUpdater.ts'

// Execute the actual main-process handshake with only windows, IPC and timers mocked.
// No Electron process, filesystem storage or installer is started.
function handshake() {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const prepareStart = source.indexOf('function prepareUpdateInstall(): Promise<void> {')
  const prepareEnd = source.indexOf('\nfunction setupAutoUpdater()', prepareStart)
  const ackStart = source.indexOf("  ipcMain.on('confirm-app-update-save',")
  const ackEnd = source.indexOf('\n  })', ackStart) + '\n  })'.length
  const quitStart = source.indexOf("app.on('before-quit', (event) => {")
  const quitEnd = source.indexOf('\n})', quitStart) + '\n})'.length
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart && ackStart >= 0 && ackEnd > ackStart && quitStart >= 0 && quitEnd > quitStart)
  let ack
  let beforeQuit
  let nextRequest = 0
  const timers = new Map()
  const sent = []
  const window = { isDestroyed: () => false, webContents: { id: 7, send: (...args) => sent.push(args) } }
  const code = ts.transpileModule(`
    let mainWindow = initialWindow;
    let updateInstallSave = null;
    let updateQuitRequested = false;
    let appUpdateController = null;
    ${source.slice(prepareStart, prepareEnd)}
    ${source.slice(ackStart, ackEnd)}
    ${source.slice(quitStart, quitEnd)}
    return { prepare: prepareUpdateInstall, pending: () => updateInstallSave,
      setWindow: (value) => { mainWindow = value } };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const main = new Function('initialWindow', 'ipcMain', 'app', 'randomUUID', 'setTimeout', 'clearTimeout', 'UpdatePreparationError', code)(
    window, { on(_event, handler) { ack = handler } }, { on(_event, handler) { beforeQuit = handler } },
    () => `synthetic-request-${++nextRequest}`,
    (callback, delay) => { assert.equal(delay, 15000); const key = {}; timers.set(key, callback); return key },
    key => timers.delete(key), updaterModule.UpdatePreparationError
  )
  return { ...main, window, sent, timers,
    confirm(success, senderId = 7, requestId = main.pending()?.requestId) { ack({ sender: { id: senderId } }, { requestId, success }) },
    timeout() { const [key, callback] = timers.entries().next().value; timers.delete(key); callback() },
    close() { beforeQuit({ preventDefault() { assert.fail('ordinary close should not be blocked') } }) }
  }
}

function controllerFor(main) {
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, channel: null,
    checkForUpdates: async () => ({ updateInfo: { version: '1.8.3' } }),
    downloadUpdate: async () => { engine.emit('update-downloaded', { version: '1.8.3' }); return [] },
    quitAndInstall() { counts.installs++ }
  })
  const counts = { installs: 0, prepared: 0, rollbacks: 0 }
  const dependencies = { updater: engine, enabled: true, currentVersion: '1.8.2', notify() {},
    prepareInstall: main.prepare, beforeInstall() { counts.prepared++ }, installFailed() { counts.rollbacks++ } }
  return { controller: new updaterModule.AppUpdateController(dependencies), dependencies, counts }
}

test('main update handshake distinguishes negative ACK, timeout, pending save and unavailable window', async () => {
  for (const mode of ['save-rejected', 'save-timeout', 'save-pending', 'window-unavailable']) {
    const main = handshake()
    if (mode === 'window-unavailable') main.setWindow(null)
    const pending = main.prepare()
    if (mode === 'save-rejected') main.confirm(false)
    if (mode === 'save-timeout') main.timeout()
    if (mode === 'save-pending') {
      await assert.rejects(main.prepare(), error => error.code === mode)
      main.confirm(false)
      await assert.rejects(pending, error => error.code === 'save-rejected')
    } else await assert.rejects(pending, error => error.code === mode)
    assert.equal(main.timers.size, 0)
    assert.equal(main.pending(), null)
  }
})

test('main rejects wrong-window/stale ACKs, permits a confirmed retry and rejects save when closing', async () => {
  const main = handshake()
  const first = main.prepare()
  main.confirm(true, 8)
  main.confirm(true, 7, 'stale-request')
  assert.ok(main.pending())
  main.confirm(false)
  await assert.rejects(first, error => error.code === 'save-rejected')
  const retry = main.prepare()
  main.confirm(true)
  await retry
  assert.equal(main.pending(), null)
  assert.equal(main.timers.size, 0)
  const closing = main.prepare()
  main.close()
  await assert.rejects(closing, error => error.code === 'window-unavailable')
  assert.equal(main.pending(), null)
  assert.equal(main.timers.size, 0)
})

test('destroyed windows and failed IPC sends are controlled failures without a stuck pending save', async () => {
  const destroyed = handshake()
  destroyed.window.isDestroyed = () => true
  await assert.rejects(destroyed.prepare(), error => error.code === 'window-unavailable')
  assert.equal(destroyed.pending(), null)
  const sendFailure = handshake()
  sendFailure.window.webContents.send = () => { throw new Error('synthetic-private-IPC-details') }
  await assert.rejects(sendFailure.prepare(), error => error.code === 'window-unavailable' && !error.message.includes('private'))
  assert.equal(sendFailure.pending(), null)
  assert.equal(sendFailure.timers.size, 0)
})

test('real handshake failures stay before quit preparation, expose specific safe feedback and can retry', async () => {
  for (const [mode, expected] of [['save-rejected', /账户保存未完成/], ['save-timeout', /未收到保存确认/]]) {
    const main = handshake()
    const { controller, counts } = controllerFor(main)
    await controller.check()
    await controller.download()
    const failedInstall = controller.install()
    await Promise.resolve()
    if (mode === 'save-rejected') main.confirm(false)
    else main.timeout()
    const result = await failedInstall
    assert.equal(result.success, false)
    assert.equal(result.state.errorStage, 'install')
    assert.match(result.error, expected)
    assert.deepEqual(counts, { installs: 0, prepared: 0, rollbacks: 0 })
    assert.equal(controller.canQuitForUpdate(), false)
    const retry = controller.install()
    await Promise.resolve()
    main.confirm(true)
    assert.equal((await retry).success, true)
    assert.deepEqual(counts, { installs: 1, prepared: 1, rollbacks: 0 })
    assert.equal(controller.canQuitForUpdate(), true)
    controller.dispose()
  }
})

test('unexpected save exceptions cannot expose secrets and differ from installer preparation errors', async () => {
  const main = handshake()
  const { controller, dependencies, counts } = controllerFor(main)
  await controller.check()
  await controller.download()
  dependencies.prepareInstall = async () => { throw Object.assign(new Error('synthetic-private-path-and-secret'), { code: 'save-timeout' }) }
  const saveFailure = await controller.install()
  assert.match(saveFailure.error, /账户保存失败/)
  assert.ok(!JSON.stringify(saveFailure).includes('synthetic-private'))
  assert.equal(counts.prepared, 0)
  assert.equal(counts.installs, 0)
  dependencies.prepareInstall = async () => {}
  dependencies.beforeInstall = () => { throw new Error('synthetic-install-private-path-and-secret') }
  const installerFailure = await controller.install()
  assert.match(installerFailure.error, /更新安装准备失败/)
  assert.ok(!JSON.stringify(installerFailure).includes('synthetic-install-private'))
  assert.equal(controller.canQuitForUpdate(), false)
  assert.equal(counts.installs, 0)
  assert.equal(counts.rollbacks, 1)
  controller.dispose()
})
