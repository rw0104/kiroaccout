import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ClientSwitchRequest, ExternalClientTarget } from '../../shared/clientSwitch'
import type { ClientSwitchService } from '../clientSwitch'

export function registerClientSwitchIpc(deps: {
  ipc: Pick<IpcMain, 'handle'>
  trusted(event: IpcMainInvokeEvent): void
  service: ClientSwitchService
  chooseExecutable(target: ExternalClientTarget): Promise<{ success: boolean; canceled?: boolean; message?: string }>
}): void {
  deps.ipc.handle('client-switch:inspect', (event, accountId: string) => {
    deps.trusted(event)
    return deps.service.inspect(accountId)
  })
  deps.ipc.handle('client-switch:execute', (event, request: ClientSwitchRequest) => {
    deps.trusted(event)
    return deps.service.execute(request)
  })
  deps.ipc.handle('client-switch:authorize', (event, request: ClientSwitchRequest) => {
    deps.trusted(event)
    return deps.service.authorize(request)
  })
  deps.ipc.handle('client-switch:disconnect', (event, request: ClientSwitchRequest) => {
    deps.trusted(event)
    return deps.service.disconnect(request)
  })
  deps.ipc.handle('client-switch:choose-executable', (event, target: ExternalClientTarget) => {
    deps.trusted(event)
    if (target !== 'cli' && target !== 'crew') throw new Error('Invalid client selection')
    return deps.chooseExecutable(target)
  })
  deps.ipc.handle('client-switch:cancel-authorization', (event) => {
    deps.trusted(event)
    // Access-only projections never start a separate authorization session.
  })
}
