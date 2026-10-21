import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KiroInstanceService, KiroInstanceError, isOrdinaryUserSid, canonicalWindowsPath,
  executableWithinProfile, quoteWindowsArgument, runasArguments,
  createWindowsKiroInstanceService, INSPECT_USERS_SCRIPT, VERIFY_EXECUTABLE_SCRIPT,
  REQUEST_LAUNCH_SCRIPT, type KiroInstanceDependencies, type WindowsUserInventory
} from '../../src/main/kiroInstances'
import { registerKiroInstanceIpc } from '../../src/main/ipc/kiroInstances'
import { KIRO_INSTANCE_CHANNELS, type KiroInstanceRecord } from '../../src/shared/kiroInstances'

const currentSid = 'S-1-5-21-100-200-300-1000'
const targetSid = 'S-1-5-21-100-200-300-1001'
const secondSid = 'S-1-5-21-100-200-300-1002'
const profile = 'C:\\Users\\Synthetic Target'
const executable = `${profile}\\AppData\\Local\\Programs\\Kiro\\Kiro.exe`
const inventory = (): WindowsUserInventory => ({
  currentSid, currentProfilePath: 'C:\\Users\\Synthetic Current',
  users: [{ sid: targetSid, accountName: 'SYNTHETIC-PC\\Synthetic Target', profilePath: profile, disabled: false, special: false, administrator: false }]
})
const input = () => ({ label: 'Synthetic instance', sid: targetSid, executablePath: executable })
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(overrides: Partial<KiroInstanceDependencies> = {}) {
  let stored: unknown = []
  let inspected = inventory()
  const verifies: unknown[][] = []
  const launches: unknown[][] = []
  const writes: unknown[] = []
  let sequence = 0
  const deps: KiroInstanceDependencies = {
    platform: 'win32', readConfig: async () => structuredClone(stored),
    writeConfig: async records => { stored = structuredClone(records); writes.push(records) },
    inspectUsers: async () => structuredClone(inspected),
    verifyExecutable: async (...args) => { verifies.push(args) },
    requestLaunch: async (...args) => { launches.push(args) },
    uuid: () => `synthetic-${++sequence}`, now: () => new Date('2026-10-20T00:00:00Z'), ...overrides
  }
  return { service: new KiroInstanceService(deps), verifies, launches, writes,
    setRecords(value: unknown) { stored = value },
    setInventory(value: WindowsUserInventory) { inspected = value }
  }
}

test('instance paths must be local, exact Kiro executables inside a target profile', () => {
  assert.equal(canonicalWindowsPath(executable), executable)
  assert.equal(executableWithinProfile(profile, executable.toLowerCase()), executable.toLowerCase())
  for (const invalid of [
    '\\\\server\\share\\Kiro.exe', '\\\\?\\C:\\Users\\Synthetic Target\\Kiro.exe', 'C:/Users/Synthetic Target/Kiro.exe',
    `${profile}\\..\\Other\\Kiro.exe`, `${profile}\\Kiro.exe:payload`, `${profile}\\Kiro.exe" --inject`,
    `${profile}\\A&bad\\Kiro.exe`, `${profile}\\A%APPDATA%\\Kiro.exe`, `${profile}\\A?\\Kiro.exe`,
    `${profile}\\A*\\Kiro.exe`, `${profile}\\A.\\Kiro.exe`, `${profile}\\A \\Kiro.exe`, `${profile}\\\\Kiro.exe`,
    'C:\\Users\\Synthetic Target-other\\Kiro.exe', `${profile}\\powershell.exe`
  ]) assert.throws(() => executableWithinProfile(profile, invalid), KiroInstanceError)
})

test('only ordinary separate user SIDs with separate initialized profiles are eligible', async () => {
  for (const sid of ['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5-21-1-2-3-500', 'S-1-5-21-1-2-3-501', 'S-1-5-21-1-2-3-999', 'arbitrary']) assert.equal(isOrdinaryUserSid(sid), false)
  assert.equal(isOrdinaryUserSid(targetSid), true)
  const h = harness()
  const inv = inventory()
  inv.users.push(
    { ...inv.users[0], sid: currentSid, accountName: 'SYNTHETIC-PC\\Current Alias' },
    { ...inv.users[0], sid: secondSid, disabled: true },
    { ...inv.users[0], sid: 'S-1-5-18', special: true },
    { ...inv.users[0], sid: 'S-1-5-21-100-200-300-1005', administrator: true },
    { ...inv.users[0], sid: 'S-1-5-21-100-200-300-1003', profilePath: inv.currentProfilePath },
    { ...inv.users[0], sid: 'S-1-5-21-100-200-300-1004', profilePath: `${inv.currentProfilePath}\\nested` }
  )
  h.setInventory(inv)
  assert.deepEqual((await h.service.snapshot()).users.map(user => user.sid), [targetSid])
  for (const sid of [currentSid, secondSid, 'S-1-5-18']) await assert.rejects(h.service.create({ ...input(), sid }), KiroInstanceError)
  assert.equal(h.verifies.length, 0)
  assert.equal(h.writes.length, 0)
})

test('duplicate SIDs and overlapping profiles fail closed rather than assuming isolation', async () => {
  for (const row of [
    { sid: targetSid, profilePath: profile },
    { sid: secondSid, profilePath: profile.toLowerCase() },
    { sid: secondSid, profilePath: `${profile}\\nested` }
  ]) {
    const h = harness()
    const inv = inventory()
    inv.users.push({ ...inv.users[0], ...row })
    h.setInventory(inv)
    await assert.rejects(h.service.snapshot(), KiroInstanceError)
  }
  const h = harness()
  h.setInventory({ ...inventory(), currentSid: 'unknown' })
  await assert.rejects(h.service.snapshot(), KiroInstanceError)
})

test('create persists only a validated instance and enforces one configuration per SID under concurrent creates', async () => {
  const h = harness()
  const results = await Promise.allSettled([h.service.create(input()), h.service.create({ ...input(), label: 'Alias instance' })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.deepEqual(h.verifies, [[profile, executable]])
  assert.equal(h.writes.length, 1)
  const snapshot = await h.service.snapshot()
  assert.equal(snapshot.instances[0].launchStatus, 'idle')
  assert.equal(snapshot.instances[0].sid, targetSid)
  assert.equal(snapshot.instances[0].createdAt, '2026-10-20T00:00:00.000Z')
  assert.doesNotMatch(JSON.stringify(snapshot), /password|refreshToken|accessToken|clientSecret/)
})

test('verification and persistence failures do not create configurations; the serial mutation queue recovers', async () => {
  let verifyFails = true
  let writeFails = false
  let stored: KiroInstanceRecord[] = []
  const h = harness({
    verifyExecutable: async () => { if (verifyFails) throw new Error('SYNTHETIC_PRIVATE') },
    writeConfig: async value => { if (writeFails) throw new Error('SYNTHETIC_PRIVATE'); stored = value },
    readConfig: async () => stored
  })
  await assert.rejects(h.service.create(input()))
  assert.deepEqual(stored, [])
  verifyFails = false; writeFails = true
  await assert.rejects(h.service.create(input()))
  assert.deepEqual(stored, [])
  writeFails = false
  await h.service.create(input())
  assert.equal(stored.length, 1)
})

test('concurrent configurations for separate Windows users do not lose either record', async () => {
  const h = harness()
  const inv = inventory()
  const secondProfile = 'C:\\Users\\Synthetic Second'
  inv.users.push({ ...inv.users[0], sid: secondSid, accountName: 'SYNTHETIC-PC\\Synthetic Second', profilePath: secondProfile })
  h.setInventory(inv)
  await Promise.all([
    h.service.create(input()),
    h.service.create({ label: 'Second instance', sid: secondSid, executablePath: `${secondProfile}\\Kiro.exe` })
  ])
  assert.deepEqual((await h.service.snapshot()).instances.map(row => row.sid).sort(), [targetSid, secondSid].sort())
  assert.equal(h.launches.length, 0)
})

test('runas arguments contain only the validated target and fixed client argument, never environment or stored credentials', () => {
  const args = runasArguments('SYNTHETIC-PC\\Synthetic Target', executable, profile)
  assert.deepEqual(args, ['/profile', '/user:SYNTHETIC-PC\\Synthetic Target', `"${executable}" --new-window`])
  const line = args.map(quoteWindowsArgument).join(' ')
  assert.ok(line.startsWith('"/profile" "/user:SYNTHETIC-PC\\Synthetic Target"'))
  assert.ok(line.includes('\\"C:\\Users\\Synthetic Target'))
  assert.doesNotMatch(line, /\/savecred|\/env|--user-data-dir|--extensions-dir|--inspect|password/i)
  for (const bad of ['SYNTHETIC-PC\\user" /savecred', 'SYNTHETIC-PC\\user&other', 'user', 'SYNTHETIC-PC\\user\n']) {
    assert.throws(() => runasArguments(bad, executable, profile), KiroInstanceError)
  }
  assert.equal(quoteWindowsArgument('path\\'), '"path\\\\"')
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"')
})

test('one pending system prompt per instance, no removal while pending, and requested is not a running status', async () => {
  const waiting = deferred<void>()
  const h = harness({ requestLaunch: () => waiting.promise })
  const record = await h.service.create(input())
  const launch = h.service.launch(record.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'awaiting-credentials')
  await assert.rejects(h.service.launch(record.id), KiroInstanceError)
  await assert.rejects(h.service.remove(record.id), KiroInstanceError)
  waiting.resolve()
  await launch
  const snapshot = await h.service.snapshot()
  assert.equal(snapshot.instances[0].launchStatus, 'requested')
  assert.match(snapshot.instances[0].message!, /不代表 IDE 存活/)
  await h.service.remove(record.id)
  assert.equal((await h.service.snapshot()).instances.length, 0)
})

test('launch rechecks system identity, signature and profile every time, and failure leaves a recoverable state', async () => {
  let failLaunch = true
  const h = harness({ requestLaunch: async () => { if (failLaunch) throw new Error('SYNTHETIC_PRIVATE_PATH') } })
  const record = await h.service.create(input())
  await assert.rejects(h.service.launch(record.id), error => error instanceof KiroInstanceError && !error.message.includes('SYNTHETIC_PRIVATE'))
  assert.equal((await h.service.snapshot()).instances[0].launchStatus, 'error')
  failLaunch = false
  await h.service.launch(record.id)
  assert.equal(h.verifies.length, 3)
  const inv = inventory()
  inv.users[0].profilePath = 'C:\\Users\\Different Synthetic Target'
  h.setInventory(inv)
  await assert.rejects(h.service.launch(record.id), KiroInstanceError)
  assert.equal(h.verifies.length, 3)
})

test('corrupt config and unsupported platforms cannot reach process or executable adapters', async () => {
  const h = harness({ platform: 'linux' })
  assert.equal((await h.service.snapshot()).supported, false)
  await assert.rejects(h.service.create(input()), KiroInstanceError)
  await assert.rejects(h.service.launch('synthetic'), KiroInstanceError)
  assert.equal(h.verifies.length + h.launches.length, 0)
  const valid = harness()
  const record = await valid.service.create(input())
  for (const bad of [{ arbitrary: true }, [record, record], [{ ...record, sid: currentSid, executablePath: 'C:\\elsewhere\\Kiro.exe' }]]) {
    valid.setRecords(bad)
    await assert.rejects(valid.service.snapshot(), KiroInstanceError)
  }
})

test('Windows adapters keep user data out of scripts, verify publisher and send no passwords', async () => {
  const calls: Array<{script: string; payload: any; options: any}> = []
  let stored: KiroInstanceRecord[] = []
  const service = createWindowsKiroInstanceService({
    platform: 'win32', readConfig: async () => stored, writeConfig: async value => { stored = value },
    trustedPublishers: ['Amazon.com, Inc.'],
    execute: async (script, payload, options) => {
      calls.push({ script, payload, options })
      if (script === INSPECT_USERS_SCRIPT) return JSON.stringify(inventory())
      if (script === VERIFY_EXECUTABLE_SCRIPT) return 'verified'
      if (script === REQUEST_LAUNCH_SCRIPT) return 'requested'
      throw new Error('unexpected script')
    }
  })
  const record = await service.create(input())
  await service.launch(record.id)
  const verifies = calls.filter(call => call.script === VERIFY_EXECUTABLE_SCRIPT)
  assert.equal(verifies.length, 2)
  assert.deepEqual(verifies[0].payload.trustedPublishers, ['Amazon.com, Inc.'])
  const launch = calls.find(call => call.script === REQUEST_LAUNCH_SCRIPT)!
  assert.deepEqual(launch.options, { interactive: true })
  assert.equal(launch.payload.sid, targetSid)
  assert.equal(launch.payload.profilePath, profile)
  assert.equal(launch.payload.executablePath, executable)
  assert.deepEqual(launch.payload.trustedPublishers, ['Amazon.com, Inc.'])
  assert.doesNotMatch(JSON.stringify(launch.payload), /password|accessToken|refreshToken|clientSecret/i)
  assert.ok(calls.every(call => !call.script.includes('Synthetic Target')))
  assert.match(VERIFY_EXECUTABLE_SCRIPT, /ReparsePoint/)
  assert.match(VERIFY_EXECUTABLE_SCRIPT, /Get-AuthenticodeSignature/)
  assert.match(VERIFY_EXECUTABLE_SCRIPT, /ProductName.*'Kiro'/)
  assert.match(REQUEST_LAUNCH_SCRIPT, /WindowStyle Normal/)
  assert.match(REQUEST_LAUNCH_SCRIPT, /WorkingDirectory \$profile/)
  assert.match(REQUEST_LAUNCH_SCRIPT, /Get-AuthenticodeSignature/)
  assert.match(REQUEST_LAUNCH_SCRIPT, /\[IO.FileShare\]::Read/)
  assert.ok(REQUEST_LAUNCH_SCRIPT.indexOf('[IO.File]::Open') < REQUEST_LAUNCH_SCRIPT.indexOf('Get-AuthenticodeSignature'))
  assert.ok(REQUEST_LAUNCH_SCRIPT.indexOf('$process.WaitForExit()') < REQUEST_LAUNCH_SCRIPT.indexOf('$stream.Dispose()'))
  assert.doesNotMatch(REQUEST_LAUNCH_SCRIPT, /\/savecred|\/env|Set-ItemProperty|Remove-Item|Stop-Process/)
})

test('missing publisher evidence and incomplete system inventory fail closed', async () => {
  let verificationCalls = 0
  const service = createWindowsKiroInstanceService({
    platform: 'win32', readConfig: async () => [], writeConfig: async () => {},
    execute: async script => { if (script === INSPECT_USERS_SCRIPT) return JSON.stringify(inventory()); verificationCalls++; return 'verified' }
  })
  await assert.rejects(service.create(input()), KiroInstanceError)
  assert.equal(verificationCalls, 0)
  for (const invalid of ['{}', '{"currentSid":"x","users":[]}', JSON.stringify({ ...inventory(), users: [{}] })]) {
    const broken = createWindowsKiroInstanceService({
      platform: 'win32', readConfig: async () => [], writeConfig: async () => {}, execute: async () => invalid
    })
    await assert.rejects(broken.snapshot())
  }
})

test('IPC exposes only the five narrow operations and replaces arbitrary internal exceptions', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  const removed: string[] = []
  const h = harness({ readConfig: async () => { throw new Error('SYNTHETIC_PRIVATE_VALUE') } })
  const dispose = registerKiroInstanceIpc({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener as (...args: any[]) => Promise<unknown>) }, removeHandler(channel) { removed.push(channel) } },
    service: h.service, chooseExecutable: async () => null
  })
  assert.deepEqual([...handlers.keys()].sort(), Object.values(KIRO_INSTANCE_CHANNELS).sort())
  const result: any = await handlers.get(KIRO_INSTANCE_CHANNELS.snapshot)!({})
  assert.equal(result.success, false)
  assert.doesNotMatch(result.error, /SYNTHETIC_PRIVATE_VALUE/)
  assert.deepEqual(await handlers.get(KIRO_INSTANCE_CHANNELS.chooseExecutable)!({}), { success: true, value: null })
  dispose()
  assert.deepEqual(removed.sort(), Object.values(KIRO_INSTANCE_CHANNELS).sort())
})
