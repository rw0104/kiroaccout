import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerClientSwitchIpc } from '../../src/main/ipc/clientSwitch'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc'
import { ClientSwitchService, type ClientSwitchDependencies } from '../../src/main/clientSwitch'
import { ClientAccessProjectionService, accessPrincipalFingerprint, type ManagerAccessSnapshot, type ClientAccessProjectionBinding } from '../../src/main/clientAccessProjection'
import type { ClientSwitchApi } from '../../src/shared/clientSwitch'

const channels = ['client-switch:inspect', 'client-switch:execute', 'client-switch:authorize',
  'client-switch:disconnect', 'client-switch:choose-executable', 'client-switch:cancel-authorization'] as const
const request = { operationId: 'synthetic-operation', accountId: 'synthetic-account', target: 'cli' as const,
  runtimeId: 'synthetic-runtime', expectedRuntimeRevision: 'synthetic-v1' }
const argsFor = (channel: string): unknown[] => channel.endsWith(':inspect') ? [request.accountId]
  : channel.endsWith(':choose-executable') ? ['cli'] : channel.endsWith(':cancel-authorization') ? [request.operationId] : [request]

type IpcReply = Awaited<ReturnType<ClientSwitchApi[keyof ClientSwitchApi]>>
type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => IpcReply | Promise<IpcReply>
interface IpcFixture {
  handlers: Map<string, IpcHandler>
  calls: string[]
  account: Readonly<ManagerAccessSnapshot & { refreshToken: string; clientSecret: string; autoRefreshEnabled: boolean; status: string }>
  event: IpcMainInvokeEvent
  frame: { url: string }
  webContents: { mainFrame: { url: string } }
  readonly binding: ClientAccessProjectionBinding | undefined
  readonly targetRevision: string
  destroy(): void
  removeWindow(): void
  invoke(channel: string, args?: unknown[], sender?: IpcMainInvokeEvent): Promise<IpcReply>
}

function harness(): IpcFixture {
  const calls: string[] = []
  const handlers = new Map<string, IpcHandler>()
  const renderer = join(process.cwd(), 'synthetic-renderer.html')
  const frame = { url: pathToFileURL(renderer).href + '#/accounts' }
  const webContents = { mainFrame: frame }
  let destroyed = false
  const window = { webContents, isDestroyed: () => destroyed } as unknown as BrowserWindow
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  let activeWindow: BrowserWindow | null = window
  const now = Date.now()
  const account = Object.freeze({ principalId: 'synthetic-stable-user-a', accessToken: 'SYNTHETIC_ACCESS_PRIVATE', refreshToken: 'SYNTHETIC_REFRESH_PRIVATE',
    clientSecret: 'SYNTHETIC_SECRET_PRIVATE', expiresAt: now + 3_600_000, provider: 'Github', authMethod: 'social',
    profileArn: 'SYNTHETIC_PROFILE', region: 'us-east-1', autoRefreshEnabled: true, status: 'active' })
  let binding: ClientAccessProjectionBinding | undefined
  let targetRevision = 'synthetic-target-initial'
  const adapter = {
    authDomainId: 'synthetic-domain',
    readRevision: async () => { calls.push('target-read'); return targetRevision },
    write: async (access: unknown, expected: string, guard: () => void, context: { principalFingerprint: string }) => {
      assert.equal(expected, targetRevision)
      guard()
      calls.push('target-write')
      assert.equal('refreshToken' in (access as object), false)
      assert.equal('clientSecret' in (access as object), false)
      assert.equal('principalId' in (access as object), false)
      assert.equal(context.principalFingerprint, accessPrincipalFingerprint(account))
      targetRevision = 'synthetic-target-written'
      return targetRevision
    }
  }
  const readAccount = (id: string): typeof account | undefined => { calls.push('account-read'); return id === request.accountId ? account : undefined }
  const projection = new ClientAccessProjectionService({
    account: readAccount,
    adapter: id => id === request.runtimeId ? adapter : undefined,
    readBindings: () => binding ? [{ ...binding }] : [],
    writeBinding: (next, expected) => {
      calls.push('binding-write')
      if (binding?.revision !== expected) return false
      binding = { ...next }
      return true
    }, now: () => now
  })
  const deps: ClientSwitchDependencies = {
    account: readAccount,
    runtime: async target => {
      calls.push('runtime-read')
      return target === 'cli' ? { id: request.runtimeId, target, revision: request.expectedRuntimeRevision,
        version: 'synthetic', adapter, isRunning: async () => false } : undefined
    },
    projection,
    bindings: () => binding ? [{ ...binding }] : [],
    beginOperation: () => { calls.push('lease'); return () => { calls.push('release') } },
    now: () => now
  }
  const service = new ClientSwitchService(deps)
  registerClientSwitchIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } } as Pick<IpcMain, 'handle'>,
    trusted: candidate => {
      calls.push('trusted')
      requireTrustedMainWindow(candidate, activeWindow, renderer)
    },
    service,
    chooseExecutable: async target => { calls.push(`configure:${target}`); return { success: true } }
  })
  return { handlers, calls, account, event, frame, webContents,
    get binding() { return binding ? { ...binding } : undefined },
    get targetRevision() { return targetRevision },
    destroy: () => { destroyed = true },
    removeWindow: () => { activeWindow = null },
    invoke: (channel: string, args = argsFor(channel), sender = event) => Promise.resolve().then(() => handlers.get(channel)!(sender, ...args)) }
}

test('all six actual client-switch IPC entrypoints validate the main window before any account, runtime or configuration work', async () => {
  for (const attack of ['missing-event', 'other-window', 'child-frame', 'navigated-frame', 'destroyed-window', 'missing-window'] as const) {
    const h = harness()
    assert.deepEqual([...h.handlers.keys()], [...channels])
    let sender = h.event
    if (attack === 'missing-event') sender = null as unknown as IpcMainInvokeEvent
    if (attack === 'other-window') sender = { sender: {}, senderFrame: h.frame } as unknown as IpcMainInvokeEvent
    if (attack === 'child-frame') sender = { sender: h.webContents, senderFrame: { ...h.frame } } as unknown as IpcMainInvokeEvent
    if (attack === 'navigated-frame') h.frame.url = 'https://untrusted.invalid/'
    if (attack === 'destroyed-window') h.destroy()
    if (attack === 'missing-window') h.removeWindow()
    for (const channel of channels) {
      h.calls.length = 0
      await assert.rejects(h.invoke(channel, argsFor(channel), sender))
      assert.deepEqual(h.calls, ['trusted'], `${attack} ${channel} must have zero business/configuration effects`)
    }
  }
})

test('choose-executable rejects every unsupported target before opening a picker or saving configuration', async () => {
  const h = harness()
  for (const target of ['ide', 'both', '', null, undefined, {}, ['crew'], 'CLI', '__proto__']) {
    h.calls.length = 0
    await assert.rejects(h.invoke('client-switch:choose-executable', [target]))
    assert.deepEqual(h.calls, ['trusted'])
  }
  for (const target of ['cli', 'crew']) {
    h.calls.length = 0
    assert.deepEqual(await h.invoke('client-switch:choose-executable', [target]), { success: true })
    assert.deepEqual(h.calls, ['trusted', `configure:${target}`])
  }
})

test('actual execute IPC returns state only while keeping manager credentials and settings unchanged', async () => {
  const h = harness()
  const before = JSON.stringify(h.account)
  const result = await h.invoke('client-switch:execute') as { status: string; credentialWrite: string; credentialRotation: string }
  assert.equal(h.calls[0], 'trusted')
  assert.equal(result.status, 'credentials-written')
  assert.equal(result.credentialWrite, 'committed')
  assert.equal(result.credentialRotation, 'none')
  assert.ok(h.calls.includes('target-write'))
  assert.ok(h.calls.includes('binding-write'))
  assert.equal(h.calls.at(-1), 'release')
  assert.equal(JSON.stringify(h.account), before)
  for (const secret of [h.account.accessToken, h.account.refreshToken, h.account.clientSecret, h.account.principalId]) {
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('inspect IPC is read-only and authorize/cancel never start login, refresh or configuration work', async () => {
  const h = harness()
  const snapshot = await h.invoke('client-switch:inspect')
  assert.equal(h.calls[0], 'trusted')
  assert.equal(h.calls.includes('target-write'), false)
  assert.equal(h.calls.includes('binding-write'), false)
  assert.equal(h.calls.includes('lease'), false)
  assert.equal(JSON.stringify(snapshot).includes(h.account.accessToken), false)
  h.calls.length = 0
  const result = await h.invoke('client-switch:authorize') as { errorCode: string }
  assert.equal(result.errorCode, 'MANAGER_AUTH_REQUIRED')
  assert.deepEqual(h.calls, ['trusted'])
  h.calls.length = 0
  assert.equal(await h.invoke('client-switch:cancel-authorization'), undefined)
  assert.deepEqual(h.calls, ['trusted'])
})

test('actual disconnect IPC validates trust first and changes metadata without touching source or target credentials', async () => {
  const h = harness()
  await h.invoke('client-switch:execute')
  const beforeAccount = JSON.stringify(h.account)
  const targetRevision = h.targetRevision
  h.calls.length = 0
  const result = await h.invoke('client-switch:disconnect') as { status: string; credentialWrite: string; credentialRotation: string }
  assert.equal(result.status, 'disconnected')
  assert.equal(result.credentialWrite, 'not-started')
  assert.equal(result.credentialRotation, 'none')
  assert.deepEqual(h.calls, ['trusted', 'runtime-read', 'binding-write'])
  assert.equal(h.binding!.reason, 'user-disconnected')
  assert.equal(h.binding!.status, 'needs-attention')
  assert.equal(h.targetRevision, targetRevision)
  assert.equal(JSON.stringify(h.account), beforeAccount)
  for (const secret of [h.account.accessToken, h.account.refreshToken, h.account.clientSecret, h.account.principalId]) assert.equal(JSON.stringify(result).includes(secret), false)
})
