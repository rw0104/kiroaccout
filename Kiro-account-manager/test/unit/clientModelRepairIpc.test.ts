import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerClientModelRepairIpc } from '../../src/main/ipc/clientModelRepair'

const revision = 'a'.repeat(64)
const request = { accountId: 'synthetic-account', operationId: 'synthetic-operation', expectedRevision: revision }
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const event = {} as IpcMainInvokeEvent
  const calls: string[] = []
  const state = { status: 'needs-repair' as const, ready: false, canRepair: true, canRestore: false,
    revision, version: '0.12.2', message: 'Synthetic model status', accessToken: 'PRIVATE_SYNTHETIC', installationPath: 'PRIVATE_PATH' }
  let release: (() => void) | undefined
  const service = {
    inspect: async () => { calls.push('inspect'); return state },
    repair: async (expected: string) => {
      assert.equal(expected, revision); calls.push('repair')
      await new Promise<void>(resolve => { release = resolve })
      return { success: true, state: { ...state, status: 'repaired' as const, ready: true, canRepair: false, canRestore: true } }
    },
    restore: async () => { calls.push('restore'); return { success: true, state } }
  }
  registerClientModelRepairIpc({ ipc: { handle(channel, handler) { handlers.set(channel, handler) } } as Pick<IpcMain, 'handle'>,
    trusted: candidate => { calls.push('trusted'); if (candidate !== event) throw new Error('untrusted') },
    accountExists: id => { calls.push('account'); return id === request.accountId }, service })
  return { calls, handlers, event, service, release: () => release?.(),
    invoke: (channel: string, value: unknown, sender = event) => Promise.resolve().then(() => handlers.get(channel)!(sender, value)) }
}

test('native model repair IPC verifies the trusted window before any account or installation work', async () => {
  const f = fixture()
  for (const action of ['inspect', 'repair', 'restore']) {
    f.calls.length = 0
    await assert.rejects(f.invoke(`client-model-repair:${action}`, action === 'inspect' ? request.accountId : request, {} as IpcMainInvokeEvent), /untrusted/)
    assert.deepEqual(f.calls, ['trusted'])
  }
})

test('native repair rejects path injection, unknown accounts and absent/stale revision shapes', async () => {
  const f = fixture()
  for (const value of [null, {}, { ...request, accountId: 'other' }, { ...request, expectedRevision: undefined },
    { ...request, installationPath: 'injected' }, { ...request, operationId: 'bad\nvalue' }]) {
    await assert.rejects(f.invoke('client-model-repair:repair', value))
  }
  assert.equal(f.calls.includes('repair'), false)
})

test('native repair entrypoints expose only the state whitelist and deduplicate identical in-flight operations', async () => {
  const f = fixture()
  const inspected = await f.invoke('client-model-repair:inspect', request.accountId)
  assert.equal(JSON.stringify(inspected).includes('PRIVATE'), false)
  const first = f.invoke('client-model-repair:repair', request)
  const second = f.invoke('client-model-repair:repair', request)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.filter(call => call === 'repair').length, 1)
  await assert.rejects(f.invoke('client-model-repair:restore', request), /Operation ID/)
  f.release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(a).includes('PRIVATE'), false)
  await f.invoke('client-model-repair:repair', request)
  assert.equal(f.calls.filter(call => call === 'repair').length, 1, 'a replay must not mutate the installation twice')
})

test('native deployment errors never expose filesystem details across IPC', async () => {
  const f = fixture()
  f.service.restore = async () => { throw new Error('PRIVATE_INSTALL_PATH') }
  f.service.inspect = async () => { throw new Error('PRIVATE_INSTALL_PATH') }
  await assert.rejects(f.invoke('client-model-repair:inspect', request.accountId), error => {
    assert.equal(String(error).includes('PRIVATE'), false)
    return true
  })
  await assert.rejects(f.invoke('client-model-repair:restore', request), error => {
    assert.equal(String(error).includes('PRIVATE'), false)
    return true
  })
})
