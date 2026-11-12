/** Safe UI projection for the selected official Crew installation. */
export interface ClientModelRepairState {
  status: 'unsupported' | 'needs-repair' | 'repaired' | 'upstream-fixed' | 'running' | 'error'
  /** Independent of running state: repaired code may already be in use. */
  ready: boolean
  canRepair: boolean
  canRestore: boolean
  version?: string
  /** Opaque installation/repair snapshot; never an installation path. */
  revision?: string
  message: string
  messageEn?: string
  errorCode?: string
}

export interface ClientModelRepairRequest {
  operationId: string
  accountId: string
  expectedRevision: string
}

export interface ClientModelRepairResult {
  success: boolean
  state: ClientModelRepairState
  message?: string
  messageEn?: string
}

export interface ClientModelRepairApi {
  inspect(accountId: string): Promise<ClientModelRepairState>
  repair(request: ClientModelRepairRequest): Promise<ClientModelRepairResult>
  restore(request: ClientModelRepairRequest): Promise<ClientModelRepairResult>
}
