import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerManagedCrewIpc } from '../../src/main/ipc/managedCrew'
import type { ManagedCrewApi, ManagedCrewState } from '../../src/shared/managedCrew'

const request = { accountId: 'synthetic-account', operationId: '12345678-1234-4234-8234-123456789abc' }
const channels = ['inspect', 'start', 'open', 'stop', 'choose-executable'].map(name => `managed-crew:${name}`)
const state = (): ManagedCrewState => ({ status: 'stopped', canStart: true, canOpen: false, canStop: false,
  selectedAccount: false, version: '0.12.0', message: '工作区已停止', messageEn: 'Workspace stopped.' })

function fixture({ deny = false, rich = false } = {}): {
  calls: Array<[string, unknown?]>
  invoke(channel: string, args?: unknown[]): Promise<unknown>
} {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const calls: Array<[string, unknown?]> = []
  const status = rich ? { ...state(), url: 'http://127.0.0.1/?token=SYNTHETIC_SECRET', root: 'SYNTHETIC_PRIVATE_ROOT',
    accessToken: 'SYNTHETIC_ACCESS', profileArn: 'SYNTHETIC_PROFILE' } : state()
  const result = { success: true, state: status, token: 'SYNTHETIC_SECRET' }
  const service: Pick<ManagedCrewApi, 'inspect' | 'start' | 'open' | 'stop'> = {
    inspect: async id => { calls.push(['inspect', id]); return status },
    start: async input => { calls.push(['start', input]); return result },
    open: async input => { calls.push(['open', input]); return result },
    stop: async input => { calls.push(['stop', input]); return result }
  }
  registerManagedCrewIpc({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) } as Pick<IpcMain, 'handle'>,
    trusted: () => { calls.push(['trusted']); if (deny) throw Error('untrusted') }, service,
    chooseExecutable: async () => { calls.push(['choose']); return { success: true, path: 'SYNTHETIC_PRIVATE_PATH' } }
  })
  return { calls, invoke: (channel: string, args: unknown[] = channel.endsWith('choose-executable') ? [] : [channel.endsWith('inspect') ? request.accountId : request]) =>
    Promise.resolve().then(() => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)) }
}

test('all managed Crew IPC routes check the main-window trust boundary before any business work', async () => {
  const f = fixture({ deny: true })
  for (const channel of channels) {
    f.calls.length = 0
    await assert.rejects(f.invoke(channel))
    assert.deepEqual(f.calls, [['trusted']])
  }
})

test('managed Crew requests reject invalid identity, operation IDs and renderer paths before reaching the service', async () => {
  const f = fixture()
  const invalid = [null, [], {}, { ...request, accountId: '' }, { ...request, accountId: 'unsafe\naccount' },
    { ...request, operationId: 'not-a-uuid' }, { ...request, operationId: '' },
    { ...request, root: 'SYNTHETIC_PRIVATE_PATH' }, { ...request, executablePath: 'SYNTHETIC_EXE' },
    { ...request, port: 1234 }, { ...request, url: 'http://localhost/' }, { ...request, accessToken: 'SYNTHETIC_ACCESS' }]
  for (const channel of channels.slice(1, 4)) for (const input of invalid) {
    f.calls.length = 0
    await assert.rejects(f.invoke(channel, [input]))
    assert.deepEqual(f.calls, [['trusted']])
  }
  for (const account of [null, {}, '', '  ', 'bad\0id', 'a'.repeat(513)]) {
    f.calls.length = 0
    await assert.rejects(f.invoke(channels[0], [account]))
    assert.deepEqual(f.calls, [['trusted']])
  }
  f.calls.length = 0
  await assert.rejects(f.invoke(channels[4], ['SYNTHETIC_EXE']))
  assert.deepEqual(f.calls, [['trusted']])
})

test('valid requests preserve the selected account and never forward credentials or runtime configuration', async () => {
  const f = fixture()
  for (const method of ['start', 'open', 'stop']) {
    f.calls.length = 0
    const result = await f.invoke(`managed-crew:${method}`)
    assert.deepEqual(result, { success: true, state: state() })
    assert.deepEqual(f.calls, [['trusted'], [method, request]])
  }
  f.calls.length = 0
  assert.deepEqual(await f.invoke('managed-crew:inspect'), state())
  assert.deepEqual(f.calls, [['trusted'], ['inspect', request.accountId]])
})

test('IPC replies expose only safe workspace state even when a dependency accidentally returns richer data', async () => {
  const f = fixture({ rich: true })
  for (const channel of channels) {
    const result = await f.invoke(channel)
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|127\.0\.0\.1|token=/)
  }
})
