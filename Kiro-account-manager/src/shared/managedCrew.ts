/** The manager-owned Crew workspace never exposes its credentials or local URL over IPC. */
export type ManagedCrewStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'blocked'

export interface ManagedCrewState {
  status: ManagedCrewStatus
  canStart: boolean
  canOpen: boolean
  canStop: boolean
  selectedAccount: boolean
  version?: string
  message: string
  messageEn?: string
  errorCode?: string
}

export interface ManagedCrewRequest {
  accountId: string
  operationId: string
}

export interface ManagedCrewResult {
  success: boolean
  state: ManagedCrewState
}

export interface ManagedCrewApi {
  inspect(accountId: string): Promise<ManagedCrewState>
  /** Starts the private gateway and opens its window after readiness is verified. */
  start(request: ManagedCrewRequest): Promise<ManagedCrewResult>
  open(request: ManagedCrewRequest): Promise<ManagedCrewResult>
  stop(request: ManagedCrewRequest): Promise<ManagedCrewResult>
  chooseExecutable(): Promise<{ success: boolean; canceled?: boolean; message?: string }>
}
