import test from 'node:test'
import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import { KiroInstanceService, KiroInstanceError, buildInstanceArguments, buildInstanceEnvironment, parseWindowsCommandLine, type KiroInstanceDependencies } from '../../src/main/kiroInstances'
import { canonicalWindowsPath, makeInstancePaths, type KiroInstanceFileSystem } from '../../src/main/kiroInstancePaths'
import type { KiroInstanceRuntime, KiroProcessInventory, KiroProcessObservation } from '../../src/main/kiroInstanceRuntimeTypes'
import { registerKiroInstanceIpc } from '../../src/main/ipc/kiroInstances'
import { InstanceOwnershipError } from '../../src/main/kiroInstanceOwnership'
import { KIRO_INSTANCE_CHANNELS, type KiroInstanceRecord, type KiroProcessIdentity } from '../../src/shared/kiroInstances'

const baseRoot = 'C:\\Synthetic\\instances'
const executablePath = 'C:\\Synthetic\\Kiro\\Kiro.exe'
const sid = 'S-1-5-21-100-200-300-1000'
const firstId = '00000000-0000-4000-8000-000000000001'
const key = (path: string): string => win32.normalize(path).toLowerCase()
const absent = () => Object.assign(new Error('missing synthetic file'), { code: 'ENOENT' })
const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function memoryFileSystem() {
  const entries = new Map<string, { directory: boolean; symbolic?: boolean; target?: string; text?: string }>()
  const writes: string[] = []
  const io: KiroInstanceFileSystem = {
    lstat: async path => {
      const value = entries.get(key(path)); if (!value) throw absent()
      return { isDirectory: () => value.directory, isSymbolicLink: () => value.symbolic === true }
    },
    realpath: async path => { const value = entries.get(key(path)); if (!value) throw absent(); return value.target || path },
    mkdir: async path => { if (entries.has(key(path))) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); entries.set(key(path), { directory: true }) },
    readFile: async path => { const value = entries.get(key(path)); if (!value || value.directory) throw absent(); return value.text! },
    writeMarker: async (path, text) => { if (entries.has(key(path))) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); writes.push(path); entries.set(key(path), { directory: false, text }) }
  }
  return { io, entries, writes }
}

function harness() {
  const files = memoryFileSystem()
  let records: unknown = []
  let sequence = 0, nextPid = 200, launchCount = 0
  let inventory: KiroProcessInventory = { complete: true, currentSid: sid, processes: [] }
  let portable = false
  const closes: KiroProcessIdentity[][] = []
  const launchPlans: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
  let onLaunch: (() => Promise<void>) | undefined
  let onClose: ((processes: KiroProcessIdentity[]) => Promise<void>) | undefined
  let onSleep: (() => Promise<void>) | undefined
  const parentEnv = { USERPROFILE: 'C:\\Synthetic\\production-home', APPDATA: 'C:\\Synthetic\\production-appdata',
    AWS_ACCESS_KEY_ID: 'SYNTHETIC_PRIVATE', KIRO_API_KEY: 'SYNTHETIC_PRIVATE', VSCODE_PORTABLE: 'C:\\Synthetic\\production-portable',
    NODE_OPTIONS: '--require synthetic', NODE_PATH: 'C:\\Synthetic\\injected-node-path', ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\Windows\\System32' }
  const runtime: KiroInstanceRuntime = {
    inspectInstallation: async () => ({ version: '1.4.13', publisher: 'Amazon.com, Inc.', portableSupported: portable }),
    inspectProcesses: async () => structuredClone(inventory),
    assertSafeDirectory: async () => {},
    launch: async (executable, args, env, cwd) => {
      launchCount++; launchPlans.push({ executable, args, env, cwd })
      if (onLaunch) { await onLaunch(); return }
      const id = ++nextPid
      inventory.processes.push({ pid: id, parentPid: 1, ownerSid: sid, executablePath: executable,
        startedAt: new Date(1800000000000 + launchCount * 1000).toISOString(), commandLine: [executable, ...args].map(quote).join(' ') })
      inventory.processes.push({ pid: ++nextPid, parentPid: id, ownerSid: sid, executablePath: executable,
        startedAt: new Date(1800000000001 + launchCount * 1000).toISOString(), commandLine: `${quote(executable)} --type=renderer` })
    },
    requestClose: async processes => {
      closes.push(structuredClone(processes))
      if (onClose) { await onClose(processes); return }
      const ids = new Set(processes.map(row => row.pid)); inventory.processes = inventory.processes.filter(row => !ids.has(row.pid))
    }
  }
  const options: KiroInstanceDependencies = {
    platform: 'win32', baseRoot, runtime, fileSystem: files.io, parentEnv,
    readConfig: async () => structuredClone(records), writeConfig: async (value: KiroInstanceRecord[]) => { records = structuredClone(value) },
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    now: () => new Date('2026-10-20T00:00:00Z'), pollIntervalMs: 1, launchTimeoutMs: 3, stopTimeoutMs: 3,
    sleep: async () => { if (onSleep) await onSleep() }
  }
  return {
    service: new KiroInstanceService(options), files, runtime, options, parentEnv, launchPlans, closes,
    get records() { return records as KiroInstanceRecord[] }, setRecords(value: unknown) { records = value },
    get inventory() { return inventory }, setInventory(value: KiroProcessInventory) { inventory = value },
    get launchCount() { return launchCount }, setPortable(value: boolean) { portable = value },
    onLaunch(value: () => Promise<void>) { onLaunch = value }, onClose(value: (processes: KiroProcessIdentity[]) => Promise<void>) { onClose = value },
    onSleep(value: () => Promise<void>) { onSleep = value }, recreate() { return new KiroInstanceService(options) },
    create(label = 'Synthetic instance') { return this.service.create({ label, executablePath }) }
  }
}

test('managed roots reject relative paths, traversal, stream names and noncanonical Windows paths', () => {
  assert.equal(canonicalWindowsPath(executablePath), executablePath)
  for (const path of ['relative', '\\\\host\\share', 'C:/Synthetic/Kiro.exe', 'C:\\Synthetic\\..\\Other', 'C:\\Synthetic\\Kiro.exe:stream',
    'C:\\Synthetic\\a?b', 'C:\\Synthetic\\a*b', 'C:\\Synthetic\\a.\\b', 'C:\\Synthetic\\a \\b', 'C:\\Synthetic\\\\b']) assert.throws(() => canonicalWindowsPath(path))
  assert.throws(() => makeInstancePaths(baseRoot, '../escape', false))
})

test('two profiles share one executable but get disjoint configuration and credential roots', async () => {
  const h = harness()
  const [a, b] = await Promise.all([h.create('First'), h.create('Second')])
  assert.equal(a.executablePath, b.executablePath)
  assert.notEqual(a.paths.home, b.paths.home)
  assert.notEqual(a.paths.userData, b.paths.userData)
  assert.equal(a.id, firstId)
  for (const path of Object.values(a.paths)) assert.ok(path.toLowerCase().startsWith((baseRoot + '\\' + a.id).toLowerCase()))
  const settings = JSON.parse(await h.files.io.readFile(win32.join(a.paths.userData, 'User', 'settings.json')))
  assert.equal(settings['window.title'], 'Kiro · First')
  assert.equal(settings['update.mode'], 'none')
  assert.equal(h.launchCount, 0)
  assert.equal(h.files.writes.filter(path => path.includes('kiro-auth-token')).length, 0)
  assert.equal(h.records.length, 2)
})

test('explicit account bindings persist through service recreation and remain unique under concurrent creates', async () => {
  const h = harness()
  const inputs = { label: 'Bound synthetic account', executablePath, accountId: 'synthetic-account-one' }
  const results = await Promise.allSettled([h.service.create(inputs), h.service.create({ ...inputs, label: 'Duplicate synthetic account' })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0].accountId, inputs.accountId)
  const view = (await h.recreate().snapshot()).instances[0]
  assert.equal(view.schemaVersion === 2 ? view.accountId : undefined, inputs.accountId)
  const other = await h.service.create({ label: 'Another account', executablePath, accountId: 'synthetic-account-two' })
  assert.equal(other.accountId, 'synthetic-account-two')
  assert.doesNotMatch(JSON.stringify(h.records), /accessToken|refreshToken|clientSecret|password/)
})

test('invalid account identifiers and duplicate persisted bindings fail before touching the client', async () => {
  for (const accountId of ['', '../production', 'synthetic\\path', 'synthetic\nprivate', 'x'.repeat(129), 1, {}]) {
    const h = harness()
    await assert.rejects(h.service.create({ label: 'Invalid account', executablePath, accountId } as any), /绑定/)
    assert.equal(h.records.length, 0)
    assert.equal(h.files.writes.length, 0)
  }
  const h = harness()
  const first = await h.service.create({ label: 'First account', executablePath, accountId: 'synthetic-account-one' })
  const second = await h.service.create({ label: 'Second account', executablePath, accountId: 'synthetic-account-two' })
  h.setRecords([first, { ...second, accountId: first.accountId }])
  await assert.rejects(h.service.snapshot(), /重复绑定/)
  assert.equal(h.launchCount, 0)
})

test('a bound profile requires account preparation and preparation failures never launch or fall back to blank login', async () => {
  const h = harness()
  const record = await h.service.create({ label: 'Bound account', executablePath, accountId: 'synthetic-account-one' })
  await assert.rejects(h.service.launch(record.id), /账户绑定准备/)
  assert.equal(h.launchCount, 0)
  h.options.syncAccount = async () => {}
  h.options.prepareAccount = async () => { throw new Error('SYNTHETIC_CREDENTIAL_ERROR') }
  await assert.rejects(h.recreate().launch(record.id), /SYNTHETIC_CREDENTIAL_ERROR/)
  assert.equal(h.launchCount, 0)
  assert.equal(h.records[0].accountId, record.accountId)
})

test('a bound launch waits for selected-account preparation before creating any client process', async () => {
  const h = harness(), entered = deferred<void>(), release = deferred<void>()
  let preparedAccount: string | undefined
  h.options.syncAccount = async () => {}
  h.options.prepareAccount = async record => {
    entered.resolve()
    await release.promise
    preparedAccount = record.accountId
  }
  const launch = h.runtime.launch
  h.runtime.launch = async (executable, args, env, cwd) => {
    assert.equal(preparedAccount, 'synthetic-account-one')
    await launch(executable, args, env, cwd)
  }
  const record = await h.service.create({ label: 'Prepared account', executablePath, accountId: 'synthetic-account-one' })
  const started = h.service.launch(record.id)
  await entered.promise
  assert.equal(h.launchCount, 0)
  assert.deepEqual(h.inventory.processes, [])
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'starting')
  release.resolve()
  await started
  assert.equal(h.launchCount, 1)
  assert.equal(h.launchPlans[0].cwd, record.paths.home)
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'running')
})

test('account hooks only receive the chosen verified profile and sync only after all its processes stop', async () => {
  const h = harness()
  const calls: Array<{ action: string; id: string; accountId: string | undefined; home: string; active: boolean }> = []
  h.options.prepareAccount = async record => { calls.push({ action: 'prepare', id: record.id, accountId: record.accountId, home: record.paths.home, active: h.inventory.processes.some(row => row.commandLine?.includes(record.paths.userData)) }) }
  h.options.syncAccount = async record => { calls.push({ action: 'sync', id: record.id, accountId: record.accountId, home: record.paths.home, active: h.inventory.processes.some(row => row.commandLine?.includes(record.paths.userData)) }) }
  const bound = await h.service.create({ label: 'Bound account', executablePath, accountId: 'synthetic-account-one' })
  const blank = await h.create('Unbound profile')
  await h.service.launch(bound.id)
  await h.service.launch(blank.id)
  assert.deepEqual(calls.map(call => call.action), ['prepare'])
  assert.equal(calls[0].id, bound.id)
  assert.equal(calls[0].home, bound.paths.home)
  assert.equal(calls[0].active, false)
  await h.service.stop(bound.id)
  assert.equal(calls[1].action, 'sync')
  assert.equal(calls[1].active, false)
  assert.equal((await h.service.snapshot()).instances[1].launchStatus, 'running')
  await h.service.stop(blank.id)
  assert.equal(calls.length, 2)
})

test('failed profile synchronization blocks a restart or removal rather than discarding new credentials', async () => {
  const h = harness()
  h.options.prepareAccount = async () => {}
  h.options.syncAccount = async () => { throw new Error('SYNTHETIC_SYNC_FAILURE') }
  const record = await h.service.create({ label: 'Bound account', executablePath, accountId: 'synthetic-account-one' })
  await h.service.launch(record.id)
  await assert.rejects(h.service.restart(record.id))
  assert.equal(h.launchCount, 1)
  const profileFiles = structuredClone([...h.files.entries])
  await assert.rejects(h.service.remove(record.id))
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0].accountId, record.accountId)
  assert.deepEqual([...h.files.entries], profileFiles)
})

test('external profile exit synchronizes the latest generation before preparing a new launch', async () => {
  const h = harness(), order: string[] = []
  let managerGeneration = 'synthetic-generation-one'
  let instanceGeneration = managerGeneration
  const prepared: string[] = []
  h.options.prepareAccount = async () => { order.push('prepare'); prepared.push(managerGeneration) }
  h.options.syncAccount = async () => { order.push('sync'); managerGeneration = instanceGeneration }
  const record = await h.service.create({ label: 'Bound account', executablePath, accountId: 'synthetic-account-one' })
  await h.service.launch(record.id)
  instanceGeneration = 'synthetic-generation-two'
  h.inventory.processes = []
  await h.recreate().launch(record.id)
  assert.deepEqual(order, ['prepare', 'sync', 'prepare'])
  assert.deepEqual(prepared, ['synthetic-generation-one', 'synthetic-generation-two'])
  assert.equal(h.launchCount, 2)
  assert.equal((await h.recreate().snapshot()).instances[0].launchStatus, 'running')
})

test('restart drains the previous process group and synchronizes before preparing the next credential generation', async () => {
  const h = harness(), order: string[] = [], launchedGenerations: number[] = []
  let managerGeneration = 1, instanceGeneration = 1, preparedGeneration: number | undefined
  h.options.prepareAccount = async () => { preparedGeneration = managerGeneration; order.push(`prepare:${managerGeneration}`) }
  h.options.syncAccount = async record => {
    const owned = new Set(record.lastProcesses?.map(row => row.pid))
    assert.equal(h.inventory.processes.some(row => owned.has(row.pid)), false, 'sync must not race a still-running IDE or child')
    managerGeneration = instanceGeneration
    order.push(`sync:${managerGeneration}`)
  }
  const launch = h.runtime.launch
  h.runtime.launch = async (executable, args, env, cwd) => {
    assert.equal(preparedGeneration, managerGeneration)
    launchedGenerations.push(preparedGeneration!)
    order.push(`launch:${preparedGeneration}`)
    await launch(executable, args, env, cwd)
  }
  const record = await h.service.create({ label: 'Rotating account', executablePath, accountId: 'synthetic-account-one' })
  await h.service.launch(record.id)
  const previousPids = h.inventory.processes.map(row => row.pid)
  instanceGeneration = 2
  h.onClose(async processes => {
    order.push('close')
    assert.deepEqual(h.inventory.processes.map(row => row.pid), previousPids)
    h.inventory.processes = h.inventory.processes.filter(row => row.pid !== processes[0].pid)
  })
  h.onSleep(async () => {
    assert.equal(managerGeneration, 1, 'new credentials must not be imported before the last child exits')
    assert.equal(launchedGenerations.length, 1)
    assert.equal(h.inventory.processes.length, 1)
    order.push('drain')
    h.inventory.processes = []
  })
  await h.service.restart(record.id)
  assert.deepEqual(launchedGenerations, [1, 2])
  assert.ok(order.indexOf('close') < order.indexOf('drain'))
  assert.ok(order.indexOf('drain') < order.indexOf('sync:2'))
  assert.ok(order.indexOf('sync:2') < order.indexOf('prepare:2'))
  assert.ok(order.indexOf('prepare:2') < order.indexOf('launch:2'))
  assert.equal(h.inventory.processes.some(row => previousPids.includes(row.pid)), false)
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'running')
})

test('a stopped bound configuration retains its files and account until synchronization succeeds', async () => {
  const h = harness()
  let allowSync = false, syncCount = 0
  h.options.syncAccount = async () => {
    syncCount++
    if (!allowSync) throw new KiroInstanceError('Synthetic account validation failed')
  }
  const record = await h.service.create({ label: 'Stopped binding', executablePath, accountId: 'synthetic-account-one' })
  const profileFiles = structuredClone([...h.files.entries])
  await assert.rejects(h.service.remove(record.id), /Synthetic account validation failed/)
  assert.equal(h.records[0].accountId, 'synthetic-account-one')
  assert.deepEqual([...h.files.entries], profileFiles)
  assert.equal(h.closes.length, 0)
  assert.equal(h.launchCount, 0)
  allowSync = true
  await h.service.remove(record.id)
  assert.equal(syncCount, 2)
  assert.equal(h.records.length, 0)
  assert.deepEqual([...h.files.entries], profileFiles)
})

test('all blank-profile lifecycle operations remain independent of account hooks', async () => {
  const h = harness()
  h.options.prepareAccount = async () => { assert.fail('blank profiles must not prepare an account') }
  h.options.syncAccount = async () => { assert.fail('blank profiles must not import account credentials') }
  const record = await h.create('Blank instance')
  await h.service.launch(record.id)
  await h.recreate().restart(record.id)
  await h.service.stop(record.id)
  const profileFiles = structuredClone([...h.files.entries])
  await h.recreate().remove(record.id)
  assert.equal(h.records.length, 0)
  assert.equal(h.launchCount, 2)
  assert.deepEqual([...h.files.entries], profileFiles)
})

test('bound lifecycle operations fail closed when the account synchronization dependency is missing', async () => {
  const h = harness()
  h.options.prepareAccount = async () => {}
  const record = await h.service.create({ label: 'Incomplete binding host', executablePath, accountId: 'synthetic-account-one' })
  await assert.rejects(h.service.launch(record.id), /账户绑定准备及同步/)
  await assert.rejects(h.service.stop(record.id), /账户同步/)
  await assert.rejects(h.service.remove(record.id), /账户同步/)
  assert.equal(h.records.length, 1)
  assert.equal(h.launchCount, 0)
  h.options.syncAccount = async () => {}
  await h.service.launch(record.id)
  delete h.options.syncAccount
  await assert.rejects(h.service.stop(record.id), /账户同步/)
  assert.equal(h.closes.length, 0)
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'running')
})

test('recovery detachment marks reauthorization without synchronizing or changing any profile file', async () => {
  const h = harness(), marked: KiroInstanceRecord[] = []
  h.options.prepareAccount = async () => { assert.fail('recovery must not prepare credentials') }
  h.options.syncAccount = async () => { assert.fail('recovery must not import unverified credentials') }
  h.options.markAccountReauthorizationRequired = async record => { marked.push(structuredClone(record)) }
  const record = await h.service.create({ label: 'Recover stopped account', executablePath, accountId: 'synthetic-account-one' })
  const profileFiles = structuredClone([...h.files.entries])
  await h.service.detach(record.id)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].id, record.id)
  assert.equal(marked[0].accountId, 'synthetic-account-one')
  assert.equal(h.records.length, 0)
  assert.deepEqual([...h.files.entries], profileFiles)
  assert.equal(h.closes.length, 0)
  assert.equal(h.launchCount, 0)
})

test('recovery detachment requires a durable reauthorization marker before removing a binding', async () => {
  const h = harness()
  const record = await h.service.create({ label: 'Recover failed sync', executablePath, accountId: 'synthetic-account-one' })
  const profileFiles = structuredClone([...h.files.entries])
  await assert.rejects(h.service.detach(record.id), /重新授权标记/)
  h.options.markAccountReauthorizationRequired = async () => { throw new Error('SYNTHETIC_MARK_FAILURE') }
  await assert.rejects(h.service.detach(record.id), /SYNTHETIC_MARK_FAILURE/)
  assert.equal(h.records[0].accountId, record.accountId)
  assert.deepEqual([...h.files.entries], profileFiles)
  h.options.markAccountReauthorizationRequired = async () => {}
  await h.service.detach(record.id)
  assert.equal(h.records.length, 0)
  assert.deepEqual([...h.files.entries], profileFiles)
})

test('recovery detachment refuses running, uncertain and draining process groups', async () => {
  for (const mode of ['running', 'incomplete', 'draining']) {
    const h = harness()
    let marked = false
    h.options.prepareAccount = async () => {}
    h.options.syncAccount = async () => {}
    h.options.markAccountReauthorizationRequired = async () => { marked = true }
    const record = await h.service.create({ label: `Recovery ${mode}`, executablePath, accountId: 'synthetic-account-one' })
    await h.service.launch(record.id)
    if (mode === 'incomplete') h.inventory.complete = false
    if (mode === 'draining') h.inventory.processes = h.inventory.processes.slice(1)
    await assert.rejects(h.service.detach(record.id), /必须确认/)
    assert.equal(marked, false)
    assert.equal(h.records.length, 1)
    assert.equal(h.closes.length, 0)
  }
})

test('recovery detachment rechecks the stopped state after marking and rejects legacy or blank profiles', async () => {
  const h = harness()
  const record = await h.service.create({ label: 'Externally restarted', executablePath, accountId: 'synthetic-account-one' })
  h.options.markAccountReauthorizationRequired = async selected => {
    await h.runtime.launch(selected.executablePath, buildInstanceArguments(selected.paths), {}, selected.paths.home)
  }
  await assert.rejects(h.service.detach(record.id), /状态已经变化/)
  assert.equal(h.records.length, 1)
  assert.equal(h.closes.length, 0)
  const blank = await h.create('Blank profile')
  await assert.rejects(h.service.detach(blank.id), /仅适用/)
  h.setRecords([{ id: 'old-synthetic', label: 'Old entry', executablePath, createdAt: '2026-10-20T00:00:00Z' }])
  await assert.rejects(h.service.detach('old-synthetic'), /旧版/)
})

test('background synchronization shares the lifecycle lock and does not launch a client', async () => {
  const h = harness(), entered = deferred<void>(), release = deferred<void>()
  const record = await h.service.create({ label: 'Background sync', executablePath, accountId: 'synthetic-account-one' })
  let count = 0
  h.options.syncAccount = async selected => {
    assert.equal(selected.accountId, record.accountId)
    count++
    entered.resolve()
    await release.promise
  }
  const first = h.service.synchronize(record.id), duplicate = h.service.synchronize(record.id)
  await entered.promise
  await assert.rejects(h.service.detach(record.id), /操作正在完成/)
  await assert.rejects(h.service.launch(record.id), /操作正在完成/)
  release.resolve()
  await Promise.all([first, duplicate])
  assert.equal(count, 1)
  assert.equal(h.launchCount, 0)
  assert.equal(h.closes.length, 0)
  const blank = await h.create('Blank synchronization')
  await h.service.synchronize(blank.id)
  assert.equal(count, 1)
  delete h.options.syncAccount
  await assert.rejects(h.service.synchronize(record.id), /账户同步/)
})

test('launch plans isolate every supported directory and remove inherited authentication and module injection', async () => {
  const h = harness(), original = structuredClone(h.parentEnv)
  const record = await h.create()
  const env = buildInstanceEnvironment(h.parentEnv, record.paths, false)
  assert.equal(env.USERPROFILE, record.paths.home)
  assert.equal(env.HOME, record.paths.home)
  assert.equal(env.APPDATA, record.paths.appData)
  assert.equal(env.LOCALAPPDATA, record.paths.localAppData)
  assert.equal(env.TEMP, record.paths.temp)
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true')
  for (const name of ['KIRO_API_KEY', 'AWS_ACCESS_KEY_ID', 'VSCODE_PORTABLE', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[name], undefined)
  assert.deepEqual(h.parentEnv, original)
  assert.equal(buildInstanceEnvironment(h.parentEnv, record.paths, true).VSCODE_PORTABLE, record.paths.portable)
  const args = buildInstanceArguments(record.paths)
  for (const flag of ['--user-data-dir', '--extensions-dir', '--shared-data-dir', '--agent-plugins-dir', '--agents-user-data-dir', '--agents-extensions-dir']) assert.equal(args.filter(arg => arg === flag).length, 1)
  assert.ok(args.includes('--disable-updates'))
})

test('portable installations use an existing dedicated portable root and its matching user-data', async () => {
  const h = harness(); h.setPortable(true)
  const record = await h.create()
  assert.equal(record.paths.userData, win32.join(record.paths.portable, 'user-data'))
  await h.service.launch(record.id)
  assert.equal(h.launchPlans[0].env.VSCODE_PORTABLE, record.paths.portable)
  assert.equal(h.launchPlans[0].cwd, record.paths.home)
})

test('real process discovery excludes the production profile and recovers managed instances after service recreation', async () => {
  const h = harness(), record = await h.create()
  const production: KiroProcessObservation = { pid: 99, parentPid: 1, ownerSid: sid, executablePath, startedAt: '2026-10-20T00:00:00Z', commandLine: `${quote(executablePath)} --new-window` }
  h.inventory.processes.push(production)
  await h.service.launch(record.id)
  const view = (await h.recreate().snapshot()).instances[0]
  assert.equal(view.launchStatus, 'running')
  assert.equal(view.canStop, true)
  assert.equal(h.records[0].lastProcesses?.length, 2)
  await h.recreate().stop(record.id)
  assert.deepEqual(h.inventory.processes, [production])
  assert.equal(h.closes[0].some(row => row.pid === 99), false)
})

test('launcher returning before the real main process appears does not mark the request successful early', async () => {
  const h = harness(), record = await h.create()
  h.onLaunch(async () => {})
  let sleeps = 0
  h.onSleep(async () => {
    sleeps++
    if (sleeps === 2) h.inventory.processes.push({ pid: 301, parentPid: 1, ownerSid: sid, executablePath, startedAt: '2026-10-20T00:00:00Z', commandLine: `${quote(executablePath)} --user-data-dir ${quote(record.paths.userData)}` })
  })
  await h.service.launch(record.id)
  assert.equal(sleeps, 2)
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'running')
})

test('renderer-only or prefix-collision parameters cannot be mistaken for an independent main process', async () => {
  const h = harness(), record = await h.create()
  const common = { pid: 301, parentPid: 1, ownerSid: sid, executablePath, startedAt: '2026-10-20T00:00:00Z' }
  for (const commandLine of [`${quote(executablePath)} --type=renderer --user-data-dir ${quote(record.paths.userData)}`, `${quote(executablePath)} --user-data-dir ${quote(record.paths.userData + '-other')}`]) {
    h.setInventory({ complete: true, currentSid: sid, processes: [{ ...common, commandLine }] })
    assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'stopped')
  }
})

test('duplicate profile arguments, mismatched owners and duplicate mains fail closed', async () => {
  for (const mode of ['duplicate-argument', 'wrong-owner', 'wrong-exe', 'duplicate-main']) {
    const h = harness(), record = await h.create()
    const row = { pid: 301, parentPid: 1, ownerSid: sid, executablePath, startedAt: '2026-10-20T00:00:00Z', commandLine: `${quote(executablePath)} --user-data-dir ${quote(record.paths.userData)}` }
    if (mode === 'duplicate-argument') row.commandLine += ` --user-data-dir=${quote(record.paths.userData)}`
    if (mode === 'wrong-owner') row.ownerSid = 'S-1-5-21-100-200-300-1001'
    if (mode === 'wrong-exe') row.executablePath = 'C:\\Synthetic\\Other\\Kiro.exe'
    h.inventory.processes = [row, ...(mode === 'duplicate-main' ? [{ ...row, pid: 302 }] : [])]
    assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'unverified')
    await assert.rejects(h.service.stop(record.id))
    await assert.rejects(h.service.restart(record.id))
    assert.equal(h.closes.length, 0)
    assert.equal(h.launchCount, 0)
  }
})

test('PID reuse and incomplete inventories never become permission to stop or duplicate a profile', async () => {
  const h = harness(), record = await h.create()
  await h.service.launch(record.id)
  h.inventory.processes[0].startedAt = '2026-10-20T01:00:00Z'
  assert.equal((await h.recreate().snapshot()).instances[0].launchStatus, 'unverified')
  await assert.rejects(h.service.stop(record.id))
  h.inventory.complete = false
  await assert.rejects(h.service.restart(record.id))
  await assert.rejects(h.service.remove(record.id))
  assert.equal(h.closes.length, 0)
  assert.equal(h.launchCount, 1)
})

test('graceful stop waits for known child processes to drain after the main window exits', async () => {
  const h = harness(), record = await h.create()
  await h.service.launch(record.id)
  h.onClose(async processes => { h.inventory.processes = h.inventory.processes.filter(row => row.pid !== processes[0].pid) })
  let waited = false
  h.onSleep(async () => { waited = true; h.inventory.processes = [] })
  await h.service.stop(record.id)
  assert.equal(waited, true)
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'exited')
})

test('a save prompt or surviving orphan prevents restart from spawning a second instance', async () => {
  for (const orphan of [false, true]) {
    const h = harness(), record = await h.create()
    await h.service.launch(record.id)
    h.onClose(async processes => { if (orphan) h.inventory.processes = h.inventory.processes.filter(row => row.pid !== processes[0].pid) })
    await assert.rejects(h.service.restart(record.id), /尚未退出/)
    assert.equal(h.launchCount, 1)
    assert.equal((await h.service.snapshot()).instances[0].launchStatus, orphan ? 'unverified' : 'running')
  }
})

test('a new child created just before the parent exits is discovered before restart or removal', async () => {
  const h = harness(), record = await h.create()
  await h.service.launch(record.id)
  h.onClose(async processes => {
    h.inventory.processes = [{ pid: 999, parentPid: processes[0].pid, ownerSid: sid, executablePath,
      startedAt: '2027-01-16T08:00:03.000Z', commandLine: `${quote(executablePath)} --type=utility` }]
  })
  await assert.rejects(h.service.restart(record.id), /尚未退出/)
  assert.equal(h.launchCount, 1)
  assert.equal(h.records[0].lastProcesses?.some(row => row.pid === 999), true)
  await assert.rejects(h.recreate().remove(record.id))
})

test('successful restart changes only the requested profile and discovers a fresh main identity', async () => {
  const h = harness(), a = await h.create('A'), b = await h.create('B')
  await h.service.launch(a.id); await h.service.launch(b.id)
  const previous = (await h.service.snapshot()).instances
  await h.service.restart(a.id)
  const next = (await h.service.snapshot()).instances
  assert.equal(next[0].launchStatus, 'running')
  assert.notEqual(next[0].schemaVersion === 2 ? next[0].pid : null, previous[0].schemaVersion === 2 ? previous[0].pid : null)
  assert.equal(next[1].schemaVersion === 2 ? next[1].pid : null, previous[1].schemaVersion === 2 ? previous[1].pid : null)
  assert.equal(h.closes.length, 1)
  assert.equal(h.closes[0].every(row => row.userDataPath === a.paths.userData), true)
})

test('simultaneous launches share one operation while conflicting operations are refused', async () => {
  const h = harness(), record = await h.create(), release = deferred<void>()
  h.onLaunch(async () => { await release.promise; h.inventory.processes.push({ pid: 301, parentPid: 1, ownerSid: sid, executablePath, startedAt: '2026-10-20T00:00:00Z', commandLine: `${quote(executablePath)} --user-data-dir ${quote(record.paths.userData)}` }) })
  const first = h.service.launch(record.id), second = h.service.launch(record.id)
  await assert.rejects(h.service.remove(record.id), /操作正在完成/)
  await assert.rejects(h.service.stop(record.id), /操作正在完成/)
  release.resolve()
  await Promise.all([first, second])
  assert.equal(h.launchCount, 1)
})

test('a delayed status snapshot cannot replace a newer restarted process lease', async () => {
  const h = harness(), record = await h.create()
  await h.service.launch(record.id)
  const entered = deferred<void>(), release = deferred<void>()
  let hold = true
  h.runtime.inspectProcesses = async () => {
    const inventory = structuredClone(h.inventory)
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return inventory
  }
  const oldSnapshot = h.service.snapshot()
  await entered.promise
  await h.service.restart(record.id)
  const newestPid = h.records[0].lastProcesses![0].pid
  release.resolve()
  const stale = await oldSnapshot
  assert.equal(stale.instances[0].launchStatus, 'unverified')
  assert.equal(h.records[0].lastProcesses![0].pid, newestPid)
  const current = (await h.service.snapshot()).instances[0]
  assert.equal(current.launchStatus, 'running')
  assert.equal(current.schemaVersion === 2 ? current.pid : null, newestPid)
})

test('native directory assertions cover credential subdirectories in one batch per verification', async () => {
  const h = harness(), record = await h.create()
  const batches: string[][] = []
  h.runtime.assertSafeDirectories = async paths => { batches.push(paths) }
  await h.service.snapshot()
  assert.equal(batches.length, 1)
  assert.ok(batches[0].includes(win32.join(record.paths.home, '.aws', 'sso', 'cache')))
  assert.ok(batches[0].includes(win32.join(record.paths.home, '.kiro')))
})

test('directory markers, authentication-root junctions and redirection are rechecked before control operations', async () => {
  for (const mode of ['marker', 'auth-junction', 'redirect']) {
    const h = harness(), record = await h.create()
    if (mode === 'marker') h.files.entries.set(key(win32.join(record.paths.root, '.kiro-instance.json')), { directory: false, text: JSON.stringify({ schemaVersion: 2, id: 'OTHER_SYNTHETIC' }) })
    if (mode === 'auth-junction') h.files.entries.set(key(win32.join(record.paths.home, '.aws')), { directory: true, symbolic: true })
    if (mode === 'redirect') h.files.entries.set(key(record.paths.sharedData), { directory: true, target: 'C:\\Synthetic\\production' })
    assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'unverified')
    await assert.rejects(h.service.launch(record.id))
    assert.equal(h.launchCount, 0)
  }
})

test('running configurations cannot be removed; stopped removal never deletes profile data', async () => {
  const h = harness(), record = await h.create()
  await h.service.launch(record.id)
  await assert.rejects(h.service.remove(record.id))
  await h.service.stop(record.id)
  const files = [...h.files.entries.keys()]
  await h.service.remove(record.id)
  assert.equal(h.records.length, 0)
  assert.deepEqual([...h.files.entries.keys()], files)
})

test('legacy Windows-user entries are shown for migration and can only be removed', async () => {
  const h = harness()
  h.setRecords([{ id: 'old-synthetic', label: 'Old user entry', executablePath, createdAt: '2026-10-20T00:00:00Z', sid: 'SYNTHETIC_OLD_SID' }])
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'legacy')
  await assert.rejects(h.service.launch('old-synthetic'), /旧版/)
  await h.service.remove('old-synthetic')
  assert.equal(h.records.length, 0)
  assert.equal(h.files.entries.size, 0)
})

test('malformed persisted roots or a replaced installation mode fail closed', async () => {
  const h = harness(), record = await h.create()
  h.setPortable(true)
  await assert.rejects(h.service.launch(record.id), /安装模式已变化/)
  h.setRecords([{ ...record, paths: { ...record.paths, home: 'C:\\Synthetic\\production' } }])
  await assert.rejects(h.service.snapshot(), /目录/)
})

test('command parsing preserves quoted Windows paths and rejects incomplete quotes', () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Synthetic App\\Kiro.exe" --user-data-dir="C:\\Synthetic Root\\user-data" --new-window'), ['C:\\Synthetic App\\Kiro.exe', '--user-data-dir=C:\\Synthetic Root\\user-data', '--new-window'])
  assert.throws(() => parseWindowsCommandLine('"incomplete'))
})

test('narrow IPC exposes lifecycle operations and redacts system exception details', async () => {
  const h = harness(), handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const release = registerKiroInstanceIpc({ ipcMain: { handle: (channel, action) => { handlers.set(channel, action as any) }, removeHandler: channel => { handlers.delete(channel) } }, service: h.service, chooseExecutable: async () => { throw new Error('SYNTHETIC_PRIVATE_PATH') } })
  assert.equal(handlers.size, Object.keys(KIRO_INSTANCE_CHANNELS).length)
  const result = await handlers.get(KIRO_INSTANCE_CHANNELS.chooseExecutable)!(undefined)
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_PATH/)
  const record = await h.create()
  assert.deepEqual(await handlers.get(KIRO_INSTANCE_CHANNELS.launch)!(undefined, record.id), { success: true, value: undefined })
  assert.deepEqual(await handlers.get(KIRO_INSTANCE_CHANNELS.stop)!(undefined, record.id), { success: true, value: undefined })
  h.options.markAccountReauthorizationRequired = async () => {}
  const bound = await h.service.create({ label: 'Recovery IPC', executablePath, accountId: 'synthetic-account-one' })
  assert.deepEqual(await handlers.get(KIRO_INSTANCE_CHANNELS.detach)!(undefined, bound.id), { success: true, value: undefined })
  release(); assert.equal(handlers.size, 0)
})

test('instance IPC preserves fixed ownership guidance instead of hiding a rejected binding', async () => {
  const h = harness(), handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  h.options.writeConfig = async () => { throw new InstanceOwnershipError('account-operation-in-flight') }
  const release = registerKiroInstanceIpc({ ipcMain: { handle: (channel, action) => { handlers.set(channel, action as any) }, removeHandler: channel => { handlers.delete(channel) } }, service: h.service, chooseExecutable: async () => null })
  const result = await handlers.get(KIRO_INSTANCE_CHANNELS.create)!(undefined, { label: 'Pending operation', executablePath, accountId: 'synthetic-account-one' })
  assert.deepEqual(result, { success: false, error: new InstanceOwnershipError('account-operation-in-flight').message })
  assert.equal(h.records.length, 0)
  release()
})
