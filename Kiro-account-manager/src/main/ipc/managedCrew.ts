import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ManagedCrewApi, ManagedCrewRequest, ManagedCrewResult, ManagedCrewState } from '../../shared/managedCrew'

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  value === value.trim() && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

function request(value: unknown): ManagedCrewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'accountId' && key !== 'operationId') ||
      !Object.hasOwn(value, 'accountId') || !Object.hasOwn(value, 'operationId')) throw Error('Invalid workspace request')
  const input = value as Record<string, unknown>
  if (!id(input.accountId) || !uuid(input.operationId)) throw Error('Invalid workspace request')
  return { accountId: input.accountId, operationId: input.operationId }
}

/** Credentials, process handles and authenticated URLs must remain in the main process. */
function state(value: ManagedCrewState): ManagedCrewState {
  if (!value || !['stopped', 'starting', 'running', 'stopping', 'blocked'].includes(value.status) ||
      typeof value.message !== 'string' || value.message.length > 4096 ||
      ['canStart', 'canOpen', 'canStop', 'selectedAccount'].some(key => typeof value[key as keyof ManagedCrewState] !== 'boolean')) {
    throw Error('Invalid workspace state')
  }
  return { status: value.status, canStart: value.canStart, canOpen: value.canOpen, canStop: value.canStop,
    selectedAccount: value.selectedAccount, message: value.message,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.messageEn === 'string' ? { messageEn: value.messageEn } : {}),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}) }
}

function result(value: ManagedCrewResult): ManagedCrewResult {
  if (!value || typeof value.success !== 'boolean') throw Error('Invalid workspace result')
  return { success: value.success, state: state(value.state) }
}

export function registerManagedCrewIpc(deps: {
  ipc: Pick<IpcMain, 'handle'>
  trusted(event: IpcMainInvokeEvent): void
  service: Pick<ManagedCrewApi, 'inspect' | 'start' | 'open' | 'stop'>
  chooseExecutable: ManagedCrewApi['chooseExecutable']
}): void {
  deps.ipc.handle('managed-crew:inspect', async (event, accountId: unknown) => {
    deps.trusted(event)
    if (!id(accountId)) throw Error('Invalid workspace account')
    return state(await deps.service.inspect(accountId))
  })
  for (const action of ['start', 'open', 'stop'] as const) {
    deps.ipc.handle(`managed-crew:${action}`, async (event, value: unknown) => {
      deps.trusted(event)
      return result(await deps.service[action](request(value)))
    })
  }
  deps.ipc.handle('managed-crew:choose-executable', async (event, ...args: unknown[]) => {
    deps.trusted(event)
    if (args.length) throw Error('Invalid workspace configuration request')
    const response = await deps.chooseExecutable()
    return { success: response.success,
      ...(response.canceled === undefined ? {} : { canceled: response.canceled }),
      ...(response.message === undefined ? {} : { message: response.message }) }
  })
}
