import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { spawn, SpawnOptions } from 'node:child_process'
import { createManagedCrewRuntime, managedCrewEnvironment, type ManagedCrewInstallation, type ManagedCrewProcessOptions } from '../../src/main/managedCrewProcess'
import type { ManagedCrewProcessState } from '../../src/main/managedCrew'

const sessionId = '11111111-1111-4111-8111-111111111111'
const otherSession = '22222222-2222-4222-8222-222222222222'
const otherOwner = '33333333-3333-4333-8333-333333333333'
const token = 'SYNTHETIC_PRIVATE_URL_TOKEN'
const argument = (args: string[], name: string): string => args[args.indexOf(name) + 1]

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  kills = 0
  eof = false
  input = ''
  onEof?: () => void
  readonly pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
    this.stdin.on('data', data => { this.input += data.toString() })
    this.stdin.on('finish', () => { this.eof = true; this.onEof?.() })
  }
  json(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n') }
  close(code = 0): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.stdout.end(); this.stderr.end()
    this.emit('close', code)
  }
  kill(): boolean { this.kills++; this.signalCode = 'SIGTERM'; queueMicrotask(() => this.close(1)); return true }
}

function fixture(t: { after(fn: () => void): void }, options: Partial<ManagedCrewProcessOptions> = {}) {
  // macOS exposes its temporary root through /var -> /private/var. Use the
  // canonical fixture root so the production anti-link checks keep their force.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-crew-process-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'managed-crew/workspace-v1')
  const resources = join(directory, 'resources')
  mkdirSync(resources)
  for (const file of ['launcher.py', 'overlay.py', 'manifest.json', 'access.py']) writeFileSync(join(resources, file), file === 'manifest.json' ? '{}' : '# synthetic fixture\n')
  const installation: ManagedCrewInstallation = { executablePath: join(directory, 'official/Crew.exe'), pythonExecutable: join(directory, 'official/python.exe'),
    bundleDirectory: join(directory, 'official/kas'), version: '0.12.0', revision: 'synthetic-installation-revision' }
  const calls: Array<{ exe: string; args: string[]; options: SpawnOptions; child: FakeChild }> = []
  let response: ((call: typeof calls[number]) => void) | undefined
  const fakeSpawn = ((exe: string, args: string[], config: SpawnOptions) => {
    const child = new FakeChild(10_000 + calls.length)
    const call = { exe, args: [...args], options: config, child }
    calls.push(call)
    if (args[3] === 'serve') child.onEof = () => child.close()
    queueMicrotask(() => {
      if (response) response(call)
      else if (args[3] === 'status') { child.json({ type: 'state', running: false, ownerId: argument(args, '--owner') }); child.close() }
    })
    return child
  }) as unknown as typeof spawn
  const config: ManagedCrewProcessOptions = { root, resources, accessHelper: join(resources, 'access.py'), installation,
    spawn: fakeSpawn, startupTimeoutMs: 100, stopTimeoutMs: 100, ...options }
  const runtime = () => createManagedCrewRuntime(config)
  const ownerId = (): string => JSON.parse(readFileSync(join(root, '.kiroaccout-crew-managed.json'), 'utf8')).ownerId
  const ready = (call = calls.at(-1)!, patch: Record<string, unknown> = {}): void => call.child.json({
    type: 'ready', ownerId: ownerId(), sessionId: argument(call.args, '--session'), pid: call.child.pid,
    port: 42345, urlToken: token, ...patch
  })
  return { directory, root, resources, installation, calls, config, runtime, ownerId, ready,
    respond: (value: typeof response) => { response = value } }
}

test('runtime construction and first status are read-only and never claim an absent workspace', async t => {
  const h = fixture(t)
  const runtime = h.runtime()
  assert.deepEqual(await runtime.status(), { running: false })
  assert.equal(existsSync(h.root), false)
  assert.equal(h.calls.length, 0)
})

test('an owned control-pipe EPIPE cannot crash the manager while a gateway is exiting', async t => {
  const h = fixture(t), runtime = h.runtime()
  await runtime.prepare()
  const pending = runtime.launch(sessionId)
  const child = h.calls[0].child
  try {
    assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('SYNTHETIC_PRIVATE_PIPE'), { code: 'EPIPE' })))
  } finally {
    h.ready()
    const launched = await pending
    child.close()
    await launched.exited
  }
})

test('an unmarked nonempty root is not adopted and invalid ownership metadata is refused', async t => {
  const h = fixture(t)
  mkdirSync(h.root, { recursive: true }); writeFileSync(join(h.root, 'existing.txt'), 'preserve')
  const runtime = h.runtime()
  await assert.rejects(runtime.prepare(), /validation failed/)
  assert.equal(readFileSync(join(h.root, 'existing.txt'), 'utf8'), 'preserve')
  assert.equal(existsSync(join(h.root, '.kiroaccout-crew-managed.json')), false)
  writeFileSync(join(h.root, '.kiroaccout-crew-managed.json'), JSON.stringify({ schemaVersion: 1, ownerId: 'wrong' }))
  await assert.rejects(runtime.status(), /validation failed/)
  assert.equal(h.calls.length, 0)
})

test('a linked workspace root is refused before any helper starts', async t => {
  const h = fixture(t), other = join(h.directory, 'other')
  mkdirSync(other); mkdirSync(join(h.directory, 'managed-crew'))
  symlinkSync(other, h.root, 'junction')
  assert.throws(h.runtime, /validation failed/)
  assert.equal(h.calls.length, 0)
})

test('preparation refuses a linked home ancestor instead of entering an external user tree', async t => {
  const h = fixture(t), other = join(h.directory, 'other-home')
  mkdirSync(h.root, { recursive: true })
  writeFileSync(join(h.root, '.kiroaccout-crew-managed.json'), JSON.stringify({ schemaVersion: 1, ownerId: otherOwner }))
  for (const path of ['AppData/Local', 'AppData/Roaming', '.aws']) mkdirSync(join(other, path), { recursive: true })
  writeFileSync(join(other, '.aws/config'), 'SYNTHETIC_EXTERNAL_CONFIG')
  writeFileSync(join(other, '.aws/credentials'), 'SYNTHETIC_EXTERNAL_CREDENTIALS')
  symlinkSync(other, join(h.root, 'home'), 'junction')
  await assert.rejects(h.runtime().prepare(), /validation failed/)
  assert.equal(readFileSync(join(other, '.aws/config'), 'utf8'), 'SYNTHETIC_EXTERNAL_CONFIG')
  assert.equal(h.calls.length, 0)
})

test('launch and status recheck private descendants after preparation', async t => {
  const h = fixture(t), runtime = h.runtime(), other = join(h.directory, 'other-workspace')
  await runtime.prepare()
  rmSync(join(h.root, 'workspace'), { recursive: true })
  mkdirSync(other)
  symlinkSync(other, join(h.root, 'workspace'), 'junction')
  await assert.rejects(runtime.status(), /validation failed/)
  await assert.rejects(runtime.launch(sessionId), /validation failed/)
  assert.equal(h.calls.length, 0)
})

test('process environment uses private paths and does not inherit model keys, AWS identity or Python injection', async t => {
  const h = fixture(t)
  const inherited = { SystemRoot: 'C:\\Windows', AWS_ACCESS_KEY_ID: 'PRIVATE', AWS_SECRET_ACCESS_KEY: 'PRIVATE',
    OPENAI_API_KEY: 'PRIVATE', ANTHROPIC_API_KEY: 'PRIVATE', KIRO_API_KEY: 'PRIVATE', KIROCREW_HOME: 'FOREIGN',
    PYTHONPATH: 'FOREIGN', NODE_OPTIONS: 'FOREIGN', HOME: 'FOREIGN', APPDATA: 'FOREIGN', PATH: 'FOREIGN',
    HTTPS_PROXY: 'http://127.0.0.1:1234' }
  const env = managedCrewEnvironment(h.root, h.installation, inherited)
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KIRO_API_KEY', 'PYTHONPATH', 'NODE_OPTIONS']) assert.equal(env[name], undefined)
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'KIROCREW_HOME', 'KIRO_HOME', 'KIROCREW_OS_HOME', 'KIROCREW_WORKSPACE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) assert.ok(env[name]?.startsWith(h.root))
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY)
  assert.equal(env.PATH?.includes('FOREIGN'), false)
  const runtime = h.runtime(); await runtime.prepare()
  const initialOwner = h.ownerId(); await runtime.prepare()
  assert.equal(h.ownerId(), initialOwner)
  assert.equal(readFileSync(join(h.root, 'home/.aws/credentials'), 'utf8'), '')
})

test('READY accepts only its own process and returns the internal whitelist without forwarding helper extras', async t => {
  const h = fixture(t), runtime = h.runtime()
  await runtime.prepare()
  h.respond(call => {
    call.child.stderr.write('SYNTHETIC_PRIVATE_STDERR')
    call.child.stdout.write('SYNTHETIC_PRIVATE_LOG\n')
    h.ready(call, { accessToken: 'SYNTHETIC_PRIVATE_ACCESS', arbitrary: 'SYNTHETIC_PRIVATE_EXTRA' })
  })
  const process = await runtime.launch(sessionId)
  assert.deepEqual(Object.keys(process).sort(), ['exited', 'ownerId', 'pid', 'port', 'running', 'sessionId', 'urlToken'].sort())
  assert.equal(process.urlToken, token)
  assert.equal(process.sessionId, sessionId)
  assert.equal(h.calls[0].options.windowsHide, true)
  assert.deepEqual(h.calls[0].args.slice(0, 3), ['-I', '-B', join(h.resources, 'launcher.py')])
  h.calls[0].child.close(); await process.exited
})

test('invalid READY identities, ports and tokens fail with EOF and a fixed error without stopping foreign processes', async t => {
  for (const patch of [{ ownerId: otherOwner }, { sessionId: otherSession }, { pid: 99999 }, { port: 0 }, { port: 65536 }, { port: '42345' }, { urlToken: 'PRIVATE\nTOKEN' }]) {
    const h = fixture(t), runtime = h.runtime()
    await runtime.prepare()
    h.respond(call => { call.child.stderr.write('SYNTHETIC_PRIVATE_STDERR'); h.ready(call, patch) })
    await assert.rejects(runtime.launch(sessionId), error => error instanceof Error && error.message === 'Managed Crew startup failed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls[0].child.eof, true)
    assert.equal(h.calls[0].child.kills, 0)
    assert.equal(h.calls.length, 1)
  }
})

test('startup timeout and oversized output close only the owned control pipe and never expose raw diagnostics', async t => {
  for (const oversized of [false, true]) {
    const h = fixture(t, { startupTimeoutMs: 20 }), runtime = h.runtime()
    await runtime.prepare()
    h.respond(call => { call.child.stderr.write('SYNTHETIC_PRIVATE_STDERR'); if (oversized) call.child.stdout.write('SYNTHETIC_PRIVATE'.repeat(5000)) })
    await assert.rejects(runtime.launch(sessionId), /Managed Crew startup failed/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls[0].child.eof, true)
    assert.equal(h.calls[0].child.kills, 0)
    assert.equal(h.calls.length, 1)
  }
})

test('status validates owner/session/pid/port and strips any secret helper fields', async t => {
  for (const patch of [{}, { ownerId: otherOwner }, { sessionId: 'bad' }, { pid: -1 }, { port: 65536 }]) {
    const h = fixture(t), runtime = h.runtime()
    await runtime.prepare()
    h.respond(call => { call.child.json({ type: 'state', running: true, ownerId: h.ownerId(), sessionId, pid: 321, port: 42345, urlToken: token, ...patch }); call.child.close() })
    if (Object.keys(patch).length) await assert.rejects(runtime.status(), /validation failed/)
    else {
      const state = await runtime.status()
      assert.deepEqual(Object.keys(state).sort(), ['running', 'ownerId', 'sessionId', 'pid', 'port'].sort())
      assert.equal(JSON.stringify(state).includes(token), false)
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls[0].child.eof, true)
  }
})

test('tracked stop uses the owned EOF handshake and confirms exit without a process-kill command', async t => {
  const h = fixture(t), runtime = h.runtime()
  await runtime.prepare()
  h.respond(call => {
    if (call.args[3] === 'serve') h.ready(call)
    else { call.child.json({ type: 'state', running: false, ownerId: h.ownerId() }); call.child.close() }
  })
  const process = await runtime.launch(sessionId)
  await runtime.stop(process)
  assert.equal(h.calls[0].child.input, '{"type":"stop"}\n')
  assert.equal(h.calls[0].child.eof, true)
  assert.equal(h.calls.every(call => call.child.kills === 0), true)
  assert.deepEqual(h.calls.map(call => call.args[3]), ['serve', 'status'])
})

test('stop refuses foreign ownership before creating any helper', async t => {
  const h = fixture(t), runtime = h.runtime()
  await runtime.prepare()
  const foreign: ManagedCrewProcessState = { running: true, ownerId: otherOwner, sessionId, pid: 321, port: 42345 }
  await assert.rejects(runtime.stop(foreign), /validation failed/)
  assert.equal(h.calls.length, 0)
})

test('a verified starting session may report port zero, while ordinary running sessions cannot', async t => {
  const h = fixture(t), runtime = h.runtime()
  await runtime.prepare()
  h.respond(call => { call.child.json({ type: 'state', running: true, starting: true,
    ownerId: h.ownerId(), sessionId, pid: 321, port: 0 }); call.child.close() })
  const state = await runtime.status()
  assert.deepEqual(state, { running: true, starting: true, ownerId: h.ownerId(), sessionId, pid: 321, port: 0 })
  h.respond(call => { call.child.json({ type: 'state', running: true, ownerId: h.ownerId(), sessionId, pid: 321, port: 0 }); call.child.close() })
  await assert.rejects(runtime.status(), /validation failed/)
})

test('invalid stop process coordinates never reach the helper transport', async t => {
  for (const patch of [{ pid: 0 }, { pid: -1 }, { port: -1 }, { port: 65536 }, { port: 0 }]) {
    const h = fixture(t), runtime = h.runtime()
    await runtime.prepare()
    await assert.rejects(runtime.stop({ running: true, ownerId: h.ownerId(), sessionId, pid: 321, port: 42345, ...patch }), /validation failed/)
    assert.equal(h.calls.length, 0)
  }
})

test('process errors and EOF before READY report fixed diagnostics and cannot launch a recovery child', async t => {
  for (const fault of ['error', 'close']) {
    const h = fixture(t), runtime = h.runtime()
    await runtime.prepare()
    h.respond(call => {
      call.child.stderr.write('SYNTHETIC_PRIVATE_PROCESS_DETAILS')
      if (fault === 'error') call.child.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'))
      else call.child.close(1)
    })
    await assert.rejects(runtime.launch(sessionId), error => error instanceof Error && error.message === 'Managed Crew startup failed')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].child.eof, true)
    assert.equal(h.calls[0].child.kills, 0)
  }
})

test('stop helper timeout kills only that short-lived helper and returns no stderr text', async t => {
  // Exercise the bounded stop-command seam, whose configurable test timeout is
  // shorter than status's fixed 15 seconds. It must not send an OS kill to the PID argument.
  const h = fixture(t, { stopTimeoutMs: 20 }), runtime = h.runtime()
  await runtime.prepare()
  h.respond(call => { call.child.stderr.write('SYNTHETIC_PRIVATE_STDERR') })
  await assert.rejects(runtime.stop({ running: true, ownerId: h.ownerId(), sessionId, pid: 321, port: 42345 }), /helper timed out/)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].args[3], 'stop')
  assert.equal(argument(h.calls[0].args, '--pid'), '321')
  assert.equal(h.calls[0].child.kills, 1)
})
