/** Same installed client, independent managed profile roots; no credentials are part of this API. */
export interface KiroInstancePaths {
  root: string
  home: string
  portable: string
  userData: string
  extensions: string
  sharedData: string
  agentPlugins: string
  agentsUserData: string
  agentsExtensions: string
  appData: string
  localAppData: string
  temp: string
}
export interface KiroProcessIdentity {
  pid: number
  parentPid: number
  ownerSid: string
  executablePath: string
  startedAt: string
  userDataPath: string
}
/** A proxy used only by one managed Kiro profile. Credentials, when present in
 * the URL, are never included in status messages or logs. */
export interface KiroInstanceProxy {
  /** Canonical URL using http, https, socks4 or socks5. */
  url: string
}
export interface KiroInstanceRecord {
  schemaVersion: 2
  id: string
  label: string
  executablePath: string
  createdAt: string
  accountId?: string
  proxy?: KiroInstanceProxy
  paths: KiroInstancePaths
  lastProcesses?: KiroProcessIdentity[]
}
export type KiroLaunchStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'unverified' | 'error' | 'legacy'
export interface KiroManagedInstanceView extends KiroInstanceRecord {
  launchStatus: KiroLaunchStatus
  message?: string
  pid?: number
  canStop: boolean
  canRestart: boolean
}
export interface KiroLegacyInstanceView {
  schemaVersion: 1
  id: string
  label: string
  executablePath: string
  launchStatus: 'legacy'
  message: string
  canStop: false
  canRestart: false
}
export type KiroInstanceView = KiroManagedInstanceView | KiroLegacyInstanceView
export interface KiroInstancesSnapshot {
  supported: boolean
  message?: string
  instances: KiroInstanceView[]
}
/** A locally installed official Kiro executable discovered without modifying the host. */
export interface KiroInstallationCandidate {
  path: string
  version: string
  publisher: string
  portableSupported: boolean
  source: 'running-process' | 'registry' | 'common-path'
}
export interface KiroInstallationDiscovery {
  supported: boolean
  candidates: KiroInstallationCandidate[]
  message?: string
}
export interface CreateKiroInstanceInput { label: string; executablePath: string; accountId?: string; proxy?: string | KiroInstanceProxy }
export type KiroInstanceProxyInput = string | KiroInstanceProxy | undefined
export type KiroInstanceResult<T = undefined> = { success: true; value: T } | { success: false; error: string }
export interface KiroInstancesApi {
  snapshot(): Promise<KiroInstanceResult<KiroInstancesSnapshot>>
  create(input: CreateKiroInstanceInput): Promise<KiroInstanceResult<KiroInstanceRecord>>
  remove(id: string): Promise<KiroInstanceResult>
  /** Recovery only: retain files, require account reauthorization and remove a stopped binding. */
  detach(id: string): Promise<KiroInstanceResult>
  launch(id: string): Promise<KiroInstanceResult>
  stop(id: string): Promise<KiroInstanceResult>
  restart(id: string): Promise<KiroInstanceResult>
  setProxy(id: string, proxy?: KiroInstanceProxyInput): Promise<KiroInstanceResult>
  discover(): Promise<KiroInstanceResult<KiroInstallationDiscovery>>
  chooseExecutable(): Promise<KiroInstanceResult<string | null>>
}
export const KIRO_INSTANCE_CHANNELS = {
  snapshot: 'kiro-instances:snapshot', create: 'kiro-instances:create', remove: 'kiro-instances:remove', detach: 'kiro-instances:detach',
  launch: 'kiro-instances:launch', stop: 'kiro-instances:stop', restart: 'kiro-instances:restart', setProxy: 'kiro-instances:set-proxy',
  discover: 'kiro-instances:discover',
  chooseExecutable: 'kiro-instances:choose-executable'
} as const
