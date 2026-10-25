export type KiroMemoryMode = 'useAndLearn' | 'useWithoutLearning' | 'useOnly' | 'off'

/** The renderer selects a registered profile by ID, never by a filesystem path. */
export type KiroSettingsTarget = { type: 'default' } | { type: 'instance'; instanceId: string }

export interface KiroSettingsTargetInfo {
  type: 'default' | 'instance'
  instanceId?: string
  label: string
  settingsPath: string
}

export interface KiroSettingsReadResult {
  settings?: Record<string, unknown>
  mcpConfig?: { mcpServers: Record<string, unknown> }
  steeringFiles?: string[]
  target?: KiroSettingsTargetInfo
  error?: string
}
