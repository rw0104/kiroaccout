/** Manual client selection is independent of the legacy IDE/CLI/both switch setting. */
export type ClientSwitchTarget = 'ide' | 'crew' | 'cli'
export type ExternalClientTarget = Exclude<ClientSwitchTarget, 'ide'>

export interface ClientSwitchCapability {
  target: ExternalClientTarget
  status: 'ready' | 'blocked' | 'needs-login' | 'not-installed'
  message: string
  messageEn?: string
  runtimeId?: string
  revision?: string
  sharedTargets?: ExternalClientTarget[]
  version?: string
  connected?: boolean
}

export interface ClientSwitchSnapshot {
  targets: ClientSwitchCapability[]
}

export interface ClientSwitchRequest {
  operationId: string
  accountId: string
  target: ExternalClientTarget
  runtimeId?: string
  expectedRuntimeRevision?: string
}

export interface ClientSwitchResult {
  operationId: string
  target: ExternalClientTarget
  status: 'blocked' | 'credentials-written' | 'identity-verified' | 'disconnected' | 'failed'
  credentialWrite: 'not-started' | 'committed' | 'uncertain'
  credentialRotation: 'none' | 'retained' | 'uncertain'
  affectedTargets: ExternalClientTarget[]
  requiresNewSession: boolean
  message: string
  messageEn?: string
  errorCode?: string
}

export interface ClientSwitchApi {
  inspect(accountId: string): Promise<ClientSwitchSnapshot>
  execute(request: ClientSwitchRequest): Promise<ClientSwitchResult>
  disconnect(request: ClientSwitchRequest): Promise<ClientSwitchResult>
  authorize(request: ClientSwitchRequest): Promise<ClientSwitchResult>
  chooseExecutable(target: ExternalClientTarget): Promise<{ success: boolean; canceled?: boolean; message?: string }>
  cancelAuthorization(operationId: string): Promise<void>
}
