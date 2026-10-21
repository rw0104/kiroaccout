/** Windows account names and paths are local configuration, never authentication material. */
export interface KiroWindowsUser {
  sid: string
  accountName: string
  profilePath: string
}

export interface KiroInstanceRecord extends KiroWindowsUser {
  id: string
  label: string
  executablePath: string
  createdAt: string
}

export type KiroLaunchStatus = 'idle' | 'awaiting-credentials' | 'requested' | 'error'
export interface KiroInstanceView extends KiroInstanceRecord {
  launchStatus: KiroLaunchStatus
  message?: string
}

export interface KiroInstancesSnapshot {
  supported: boolean
  message?: string
  users: KiroWindowsUser[]
  instances: KiroInstanceView[]
}

export interface CreateKiroInstanceInput {
  label: string
  sid: string
  executablePath: string
}

export type KiroInstanceResult<T = undefined> = { success: true; value: T } | { success: false; error: string }

export interface KiroInstancesApi {
  snapshot(): Promise<KiroInstanceResult<KiroInstancesSnapshot>>
  create(input: CreateKiroInstanceInput): Promise<KiroInstanceResult<KiroInstanceRecord>>
  remove(id: string): Promise<KiroInstanceResult>
  launch(id: string): Promise<KiroInstanceResult>
  chooseExecutable(): Promise<KiroInstanceResult<string | null>>
}

export const KIRO_INSTANCE_CHANNELS = {
  snapshot: 'kiro-instances:snapshot',
  create: 'kiro-instances:create',
  remove: 'kiro-instances:remove',
  launch: 'kiro-instances:launch',
  chooseExecutable: 'kiro-instances:choose-executable'
} as const
