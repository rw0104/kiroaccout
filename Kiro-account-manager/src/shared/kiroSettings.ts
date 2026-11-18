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

export interface McpCommandServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export function isMcpCommandServer(value: unknown): value is McpCommandServer {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'url' in value) return false
  const server = value as Record<string, unknown>
  return typeof server.command === 'string' && server.command.trim() !== ''
    && (server.args === undefined || (Array.isArray(server.args) && server.args.every(arg => typeof arg === 'string')))
    && (server.env === undefined || (server.env !== null && typeof server.env === 'object'
      && !Array.isArray(server.env) && Object.values(server.env).every(entry => typeof entry === 'string')))
}
