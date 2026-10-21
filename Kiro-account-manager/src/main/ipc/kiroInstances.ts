import type { IpcMain } from 'electron'
import { KIRO_INSTANCE_CHANNELS, type CreateKiroInstanceInput, type KiroInstanceResult } from '../../shared/kiroInstances'
import { KiroInstanceError, type KiroInstanceService } from '../kiroInstances'
import { InstanceOwnershipError } from '../kiroInstanceOwnership'

export function registerKiroInstanceIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  service: KiroInstanceService
  chooseExecutable(): Promise<string | null>
}): () => void {
  const handle = <T>(channel: string, action: (...args: unknown[]) => Promise<T>): void => {
    deps.ipcMain.handle(channel, async (_event, ...args): Promise<KiroInstanceResult<T>> => {
      try { return { success: true, value: await action(...args) } }
      catch (error) { return { success: false, error: error instanceof KiroInstanceError || error instanceof InstanceOwnershipError ? error.message : '实例操作未完成，请检查所选账户、凭证有效期和客户端状态后重试。' } }
    })
  }
  handle(KIRO_INSTANCE_CHANNELS.snapshot, () => deps.service.snapshot())
  handle(KIRO_INSTANCE_CHANNELS.create, input => deps.service.create(input as CreateKiroInstanceInput))
  handle(KIRO_INSTANCE_CHANNELS.remove, id => deps.service.remove(id as string))
  handle(KIRO_INSTANCE_CHANNELS.detach, id => deps.service.detach(id as string))
  handle(KIRO_INSTANCE_CHANNELS.launch, id => deps.service.launch(id as string))
  handle(KIRO_INSTANCE_CHANNELS.stop, id => deps.service.stop(id as string))
  handle(KIRO_INSTANCE_CHANNELS.restart, id => deps.service.restart(id as string))
  handle(KIRO_INSTANCE_CHANNELS.chooseExecutable, () => deps.chooseExecutable())
  return () => Object.values(KIRO_INSTANCE_CHANNELS).forEach(channel => deps.ipcMain.removeHandler(channel))
}
