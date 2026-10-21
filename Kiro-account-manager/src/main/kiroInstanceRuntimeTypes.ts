import type { KiroProcessIdentity } from '../shared/kiroInstances'

export interface KiroProcessObservation {
  pid: number
  parentPid: number
  ownerSid?: string
  executablePath?: string
  startedAt?: string
  commandLine?: string
}
export interface KiroProcessInventory {
  complete: boolean
  currentSid: string
  processes: KiroProcessObservation[]
}
export interface KiroInstallationInfo { version: string; publisher: string; portableSupported: boolean }
export interface KiroInstanceRuntime {
  assertSafeDirectory?(path: string): Promise<void>
  assertSafeDirectories?(paths: string[]): Promise<void>
  inspectInstallation(executablePath: string): Promise<KiroInstallationInfo>
  inspectProcesses(): Promise<KiroProcessInventory>
  launch(executablePath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void>
  requestClose(processes: KiroProcessIdentity[]): Promise<void>
}
