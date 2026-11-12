import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ClientModelRepairRequest, ClientModelRepairResult, ClientModelRepairState } from '../../shared/clientModelRepair'

const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const statuses = new Set(['unsupported', 'needs-repair', 'repaired', 'upstream-fixed', 'running', 'error'])

function request(value: unknown): ClientModelRepairRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model repair request')
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !['operationId', 'accountId', 'expectedRevision'].includes(key)) ||
      !identifier(data.operationId) || !identifier(data.accountId) || !revision(data.expectedRevision)) throw new Error('Invalid model repair request')
  return { operationId: data.operationId, accountId: data.accountId, expectedRevision: data.expectedRevision }
}

/** Only the public status crosses IPC, never installation/backup paths or resources. */
function publicState(state: ClientModelRepairState): ClientModelRepairState {
  if (!state || !statuses.has(state.status) || [state.ready, state.canRepair, state.canRestore].some(value => typeof value !== 'boolean') ||
      typeof state.message !== 'string' || state.message.length > 2048 ||
      state.revision !== undefined && !revision(state.revision)) throw new Error('Invalid model repair response')
  return { status: state.status, ready: state.ready, canRepair: state.canRepair, canRestore: state.canRestore, message: state.message,
    ...(typeof state.messageEn === 'string' ? { messageEn: state.messageEn.slice(0, 2048) } : {}),
    ...(state.revision ? { revision: state.revision } : {}),
    ...(typeof state.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(state.version) ? { version: state.version } : {}),
    ...(typeof state.errorCode === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(state.errorCode) ? { errorCode: state.errorCode } : {}) }
}

export function registerClientModelRepairIpc(deps: {
  ipc: Pick<IpcMain, 'handle'>
  trusted(event: IpcMainInvokeEvent): void
  accountExists(accountId: string): boolean
  service: {
    inspect(): Promise<ClientModelRepairState>
    repair(expectedRevision: string): Promise<ClientModelRepairResult>
    restore(expectedRevision: string): Promise<ClientModelRepairResult>
  }
}): void {
  const operations = new Map<string, { key: string; task: Promise<ClientModelRepairResult>; finished: boolean }>()
  const account = (id: unknown): string => {
    if (!identifier(id) || !deps.accountExists(id)) throw new Error('Invalid account selection')
    return id
  }
  deps.ipc.handle('client-model-repair:inspect', async (event, id: unknown) => {
    deps.trusted(event)
    account(id)
    try { return publicState(await deps.service.inspect()) }
    catch { throw new Error('Model compatibility could not be inspected. Retry the client check.') }
  })
  for (const action of ['repair', 'restore'] as const) deps.ipc.handle(`client-model-repair:${action}`, (event, value: unknown) => {
    deps.trusted(event)
    const selected = request(value)
    account(selected.accountId)
    const key = JSON.stringify([action, selected.accountId, selected.expectedRevision])
    const existing = operations.get(selected.operationId)
    if (existing) {
      if (existing.key !== key) throw new Error('Operation ID already used')
      return existing.task
    }
    while (operations.size >= 128) {
      const oldest = [...operations].find(([, entry]) => entry.finished)
      if (!oldest) throw new Error('Model repair is busy')
      operations.delete(oldest[0])
    }
    const entry = { key, finished: false, task: undefined as unknown as Promise<ClientModelRepairResult> }
    entry.task = Promise.resolve().then(() => deps.service[action](selected.expectedRevision)).then(result => {
      if (!result || typeof result.success !== 'boolean') throw new Error('Invalid model repair response')
      const state = publicState(result.state)
      return { success: result.success, state, message: state.message, messageEn: state.messageEn }
    }).catch(() => {
      // Native errors can contain a filesystem path; the UI receives one safe category.
      throw new Error('Model repair could not complete. Inspect the client again.')
    }).finally(() => { entry.finished = true })
    operations.set(selected.operationId, entry)
    return entry.task
  })
}
