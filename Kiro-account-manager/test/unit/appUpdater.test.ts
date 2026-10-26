import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AppUpdateController } from '../../src/main/appUpdater'
import type { AppUpdateState } from '../../src/main/appUpdater'
import { acknowledgeUpdateSave, subscribeUpdateState } from '../../src/renderer/src/lib/updateClient'

const info = (version = '1.7.7') => ({ version, releaseDate: '2026-10-20', releaseNotes: 'Synthetic release notes' })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class Engine extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  channel: string | null = null
  checks = 0
  downloads = 0
  installs = 0
  check = async (): Promise<{ updateInfo?: unknown }> => ({ updateInfo: info() })
  download = async (): Promise<unknown> => { this.emit('update-downloaded', info()); return ['synthetic-installer'] }
  install = (): void => {}
  async checkForUpdates() { this.checks++; return this.check() }
  async downloadUpdate() { this.downloads++; return this.download() }
  quitAndInstall(silent?: boolean, restart?: boolean) {
    assert.equal(silent, true); assert.equal(restart, true)
    this.installs++; this.install()
  }
}

function fixture(options: { enabled?: boolean; notify?: (state: AppUpdateState) => void } = {}) {
  const engine = new Engine()
  let saves = 0
  let prepared = 0
  let rolledBack = 0
  const dependencies = {
    updater: engine, enabled: options.enabled ?? true, currentVersion: '1.7.6',
    notify: options.notify ?? (() => {}), prepareInstall: async () => { saves++ },
    beforeInstall: () => { prepared++ }, installFailed: () => { rolledBack++ }
  }
  const controller = new AppUpdateController(dependencies)
  return { engine, controller, dependencies, counts: () => ({ saves, prepared, rolledBack }) }
}

test('stable updater never downloads or installs implicitly and rejects RC/downgrade', async () => {
  const { engine, controller } = fixture()
  assert.equal(engine.autoDownload, false)
  assert.equal(engine.autoInstallOnAppQuit, false)
  assert.equal(engine.allowPrerelease, false)
  assert.equal(engine.allowDowngrade, false)
  assert.equal(engine.channel, 'latest')
  for (const version of ['1.7.5', '1.7.6', '1.7.7-rc.1', 'invalid']) {
    engine.check = async () => ({ updateInfo: info(version) })
    assert.equal((await controller.check()).status, 'not-available')
    assert.equal((await controller.download()).success, false)
  }
  assert.equal(engine.downloads, 0)
  assert.equal(engine.installs, 0)
  controller.dispose()
})

test('disabled development instance never checks, downloads or installs', async () => {
  const { engine, controller } = fixture({ enabled: false })
  assert.equal((await controller.check()).status, 'disabled')
  assert.equal((await controller.download()).success, false)
  assert.equal((await controller.install()).success, false)
  assert.equal(engine.checks + engine.downloads + engine.installs, 0)
  controller.dispose()
})

test('check is single-flight and snapshot survives a missing renderer', async () => {
  const pending = deferred<{ updateInfo?: unknown }>()
  const { engine, controller } = fixture({ notify: () => { throw new Error('synthetic renderer unavailable') } })
  engine.check = () => pending.promise
  const first = controller.check()
  const second = controller.check()
  await Promise.resolve()
  assert.equal(engine.checks, 1)
  pending.resolve({ updateInfo: info() })
  await Promise.all([first, second])
  assert.equal(controller.getState().version, '1.7.7')
  assert.equal(controller.getState().status, 'available')
  assert.equal(engine.downloads, 0)
  controller.dispose()
})

test('failed check stays an error, exposes no raw paths and can retry', async () => {
  const { engine, controller } = fixture()
  engine.check = async () => { throw new Error('synthetic-private-path-and-secret') }
  assert.equal((await controller.check()).status, 'error')
  assert.ok(!JSON.stringify(controller.getState()).includes('synthetic-private'))
  engine.check = async () => ({ updateInfo: info() })
  assert.equal((await controller.check()).status, 'available')
  controller.dispose()
})

test('download is single-flight, publishes progress and requires the verified completion event', async () => {
  const { engine, controller } = fixture()
  await controller.check()
  const pending = deferred<unknown>()
  engine.download = () => pending.promise
  const first = controller.download()
  const second = controller.download()
  await Promise.resolve()
  assert.equal(engine.downloads, 1)
  engine.emit('download-progress', { percent: 42, bytesPerSecond: 1024, transferred: 42, total: 100 })
  assert.equal(controller.getState().progress?.percent, 42)
  assert.equal((await controller.install()).success, false)
  engine.emit('update-downloaded', info())
  pending.resolve(['synthetic-file'])
  assert.ok((await first).success && (await second).success)
  assert.equal(controller.getState().status, 'downloaded')
  assert.equal(engine.installs, 0)
  controller.dispose()
})

test('checksum error and incomplete/mismatched download never become installable', async () => {
  for (const mode of ['checksum', 'missing-event', 'wrong-version']) {
    const { engine, controller } = fixture()
    await controller.check()
    engine.download = async () => {
      if (mode === 'checksum') { engine.emit('error', new Error('sha512 mismatch synthetic-private-value')); throw new Error('hash') }
      if (mode === 'wrong-version') engine.emit('update-downloaded', info('1.7.8'))
      return []
    }
    assert.equal((await controller.download()).success, false)
    assert.equal(controller.getState().errorStage, 'download')
    assert.ok(!JSON.stringify(controller.getState()).includes('synthetic-private'))
    assert.equal((await controller.install()).success, false)
    assert.equal(engine.installs, 0)
    controller.dispose()
  }
})

test('download failure can retry without parallel checks changing the chosen version', async () => {
  const { engine, controller } = fixture()
  await controller.check()
  engine.download = async () => { throw new Error('offline') }
  assert.equal((await controller.download()).success, false)
  engine.download = async () => { engine.emit('update-downloaded', info()); return [] }
  assert.equal((await controller.download()).success, true)
  const checks = engine.checks
  await controller.check()
  assert.equal(engine.checks, checks)
  assert.equal(controller.getState().status, 'downloaded')
  controller.dispose()
})

test('install requires a successful persistence acknowledgment and supports save-only retry', async () => {
  const { engine, controller, dependencies, counts } = fixture()
  assert.equal((await controller.install()).success, false)
  await controller.check(); await controller.download()
  dependencies.prepareInstall = async () => { throw new Error('synthetic disk full') }
  assert.equal((await controller.install()).success, false)
  assert.equal(engine.installs, 0)
  assert.equal(counts().prepared, 0)
  const saved = deferred<void>()
  dependencies.prepareInstall = () => saved.promise
  const first = controller.install()
  const second = controller.install()
  await Promise.resolve()
  assert.equal(engine.installs, 0)
  saved.resolve()
  assert.ok((await first).success && (await second).success)
  assert.equal(engine.installs, 1)
  assert.equal(counts().prepared, 1)
  controller.dispose()
})

test('installation startup failure restores quit flags and permits a controlled retry', async () => {
  const { engine, controller, counts } = fixture()
  await controller.check(); await controller.download()
  engine.install = () => { throw new Error('synthetic spawn failure') }
  assert.equal((await controller.install()).success, false)
  assert.equal(counts().rolledBack, 1)
  engine.install = () => {}
  assert.equal((await controller.install()).success, true)
  assert.equal(engine.installs, 2)
  controller.dispose()
})

test('automatic checks start after three seconds, repeat at six hours and are disposed', async () => {
  const engine = new Engine()
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  let cancelled = 0
  const controller = new AppUpdateController({ updater: engine, enabled: true, currentVersion: '1.7.6',
    notify() {}, prepareInstall: async () => {}, beforeInstall() {},
    schedule: ((callback: () => void, delay: number) => { scheduled.push({ callback, delay }); return { unref() {} } }) as unknown as typeof setTimeout,
    unschedule: (() => { cancelled++ }) as typeof clearTimeout })
  controller.start(); controller.start()
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 3000)
  scheduled[0].callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scheduled[1].delay, 6 * 60 * 60 * 1000)
  assert.equal(engine.checks, 1)
  controller.dispose()
  assert.equal(cancelled, 1)
  assert.equal(engine.listenerCount('update-available'), 0)
  assert.equal((await controller.download()).success, false)
})

test('renderer subscribes before reading state and ignores stale snapshot replies/unmounted updates', async () => {
  const snapshot = deferred<AppUpdateState>()
  let handler!: (state: AppUpdateState) => void
  let unsubscribed = false
  const states: AppUpdateState[] = []
  const stop = subscribeUpdateState({
    onAppUpdateState(next) { handler = next; return () => { unsubscribed = true } },
    getAppUpdateState() { assert.ok(handler); return snapshot.promise }
  }, state => states.push(state), () => assert.fail('unexpected read failure'))
  handler({ revision: 3, status: 'downloaded', currentVersion: '1.7.6', version: '1.7.7' })
  snapshot.resolve({ revision: 1, status: 'checking', currentVersion: '1.7.6' })
  await Promise.resolve()
  assert.equal(states.length, 1)
  stop()
  handler({ revision: 4, status: 'installing', currentVersion: '1.7.6' })
  assert.equal(states.length, 1)
  assert.equal(unsubscribed, true)
})

test('renderer acknowledgment is sent only after storage completes, failures are negative ACKs', async () => {
  const pending = deferred<void>()
  const confirmations: Array<[string, boolean]> = []
  const operation = acknowledgeUpdateSave('synthetic-request', () => pending.promise, (id, ok) => confirmations.push([id, ok]))
  assert.equal(confirmations.length, 0)
  pending.resolve(); await operation
  assert.deepEqual(confirmations, [['synthetic-request', true]])
  await acknowledgeUpdateSave('failed-request', async () => { throw new Error('synthetic') }, (id, ok) => confirmations.push([id, ok]))
  assert.deepEqual(confirmations[1], ['failed-request', false])
})
