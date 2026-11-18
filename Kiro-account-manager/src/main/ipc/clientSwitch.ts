import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ClientSwitchApi, ClientSwitchRequest, ExternalClientTarget } from '../../shared/clientSwitch'
import type { ClientSwitchService } from '../clientSwitch'
import { cliVersionGuidance } from '../clientCompatibility'

export function registerClientSwitchIpc(deps: {
  ipc: Pick<IpcMain, 'handle'>
  trusted(event: IpcMainInvokeEvent): void
  service: ClientSwitchService
  chooseExecutable: ClientSwitchApi['chooseExecutable']
}): void {
  deps.ipc.handle('client-switch:inspect', (event, accountId: string, target?: ExternalClientTarget) => {
    deps.trusted(event)
    return deps.service.inspect(accountId, target)
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
  deps.ipc.handle('client-switch:choose-executable', async (event, target: ExternalClientTarget) => {
    deps.trusted(event)
    if (target !== 'cli' && target !== 'crew') throw new Error('Invalid client selection')
    try { return await deps.chooseExecutable(target) }
    catch (error) {
      const guidance = target === 'cli' && cliVersionGuidance(error)
      if (guidance) return { success: false, message: guidance.message, messageEn: guidance.messageEn }
      return { success: false, message: '此官方客户端的签名、文件或登录协议未通过兼容性检查，请确认版本并重新检测。',
        messageEn: 'Client verification failed. Check the installation and version, then try again.' }
    }
  })
  deps.ipc.handle('client-switch:cancel-authorization', (event) => {
    deps.trusted(event)
    // Access-only projections never start a separate authorization session.
  })
}
