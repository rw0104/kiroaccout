import { applyEdits, modify, parse, parseTree, type ParseError } from 'jsonc-parser'
import type { KiroMemoryMode, KiroSettingsTargetInfo } from '../shared/kiroSettings'
import { resolveKiroSettingsPath } from './kiroSettingsPath'

export class KiroSettingsError extends Error {}

const FIELD_NAMES = {
  modelSelection: 'kiroAgent.modelSelection',
  agentAutonomy: 'kiroAgent.agentAutonomy',
  enableDebugLogs: 'kiroAgent.enableDebugLogs',
  enableTabAutocomplete: 'kiroAgent.enableTabAutocomplete',
  enableCodebaseIndexing: 'kiroAgent.enableCodebaseIndexing',
  usageSummary: 'kiroAgent.usageSummary',
  codeReferences: 'kiroAgent.codeReferences.referenceTracker',
  configureMCP: 'kiroAgent.configureMCP',
  trustedCommands: 'kiroAgent.trustedCommands',
  trustedTools: 'kiroAgent.trustedTools',
  commandDenylist: 'kiroAgent.commandDenylist',
  ignoreFiles: 'kiroAgent.ignoreFiles',
  mcpApprovedEnvVars: 'kiroAgent.mcpApprovedEnvVars',
  notificationsActionRequired: 'kiroAgent.notifications.agent.actionRequired',
  notificationsFailure: 'kiroAgent.notifications.agent.failure',
  notificationsSuccess: 'kiroAgent.notifications.agent.success',
  notificationsBilling: 'kiroAgent.notifications.billing',
  memory: 'kiroAgent.memory',
  workflowsEnabled: 'kiroAgent.workflows.enabled'
} as const

type SettingField = keyof typeof FIELD_NAMES
const STRING_FIELDS = new Set<SettingField>(['modelSelection', 'agentAutonomy', 'configureMCP'])
const ARRAY_FIELDS = new Set<SettingField>(['trustedCommands', 'commandDenylist', 'ignoreFiles', 'mcpApprovedEnvVars'])
const MEMORY_MODES: readonly KiroMemoryMode[] = ['useAndLearn', 'useWithoutLearning', 'useOnly', 'off']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const parseOptions = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true }

/** Errors are fixed text: parser snippets may include private URLs, commands or environment values. */
export function parseKiroSettingsObject(content: string): Record<string, unknown> {
  const text = content.replace(/^\uFEFF/, '')
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, parseOptions)
  if (errors.length || (parsed !== undefined && !object(parsed))) {
    throw new KiroSettingsError('Kiro 设置文件不是有效的 JSONC 对象，请修正后重试；原文件未更改。')
  }
  // Duplicate top-level settings are ambiguous to a property editor. Refuse to
  // edit rather than leaving a second value that silently overrides the change.
  const tree = parseTree(text, [], parseOptions)
  const names = new Set<string>()
  for (const property of tree?.children ?? []) {
    const name: unknown = property.children?.[0]?.value
    if (typeof name !== 'string' || names.has(name)) {
      throw new KiroSettingsError('Kiro 设置包含重复的配置键，请修正后重试；原文件未更改。')
    }
    names.add(name)
  }
  return parsed ?? {}
}

function validateSetting(field: SettingField, value: unknown): void {
  const invalid = (): never => { throw new KiroSettingsError('Kiro 设置值无效，请检查所选设置后重试；原文件未更改。') }
  if (field === 'memory') {
    if (!MEMORY_MODES.includes(value as KiroMemoryMode)) invalid()
  } else if (STRING_FIELDS.has(field)) {
    if (typeof value !== 'string' || value.length > 4096) invalid()
  } else if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value) || value.length > 4096 || value.some(item => typeof item !== 'string' || item.length > 8192)) invalid()
  } else if (field === 'trustedTools') {
    if (!object(value) || Object.keys(value).length > 4096 || Object.values(value).some(item => typeof item !== 'boolean')) invalid()
  } else if (typeof value !== 'boolean') invalid()
}

export function readKiroSettingsDocument(content: string): Record<string, unknown> {
  const parsed = parseKiroSettingsObject(content)
  const result: Record<string, unknown> = {}
  for (const [field, key] of Object.entries(FIELD_NAMES)) result[field] = parsed[key]
  for (const field of ARRAY_FIELDS) result[field] ??= []
  result.trustedTools ??= {}
  result.memory ??= 'off'
  result.workflowsEnabled ??= false
  validateSetting('memory', result.memory)
  validateSetting('workflowsEnabled', result.workflowsEnabled)
  return result
}

/** Edit only supplied known settings; retain unknown keys, comments and formatting. */
export function updateKiroSettingsDocument(content: string, updates: unknown): string {
  parseKiroSettingsObject(content)
  if (!object(updates)) throw new KiroSettingsError('Kiro 设置更新必须是对象；原文件未更改。')
  const changes: Array<[SettingField, unknown]> = []
  for (const [field, value] of Object.entries(updates)) {
    if (!Object.hasOwn(FIELD_NAMES, field)) throw new KiroSettingsError('包含不支持的 Kiro 设置；原文件未更改。')
    if (value === undefined) continue
    validateSetting(field as SettingField, value)
    changes.push([field as SettingField, value])
  }
  if (!changes.length) return content
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  let text = bom ? content.slice(1) : content
  const indent = /(?:^|\r?\n)([\t ]+)"/.exec(text)?.[1]
  const formattingOptions = {
    insertSpaces: !indent?.includes('\t'),
    tabSize: indent && !indent.includes('\t') ? indent.length : 4,
    eol: text.includes('\r\n') ? '\r\n' : '\n'
  }
  for (const [field, value] of changes) {
    text = applyEdits(text, modify(text, [FIELD_NAMES[field]], value, { formattingOptions }))
  }
  parseKiroSettingsObject(text)
  return bom + text
}

export interface ResolvedKiroSettingsTarget extends KiroSettingsTargetInfo { homeDir: string; accountId?: string }

export async function resolveKiroSettingsTarget(target: unknown, deps: {
  platform: NodeJS.Platform
  homeDir: string
  env: NodeJS.ProcessEnv
  resolveInstance(id: string): Promise<{ label: string; homeDir: string; settingsPath: string; accountId?: string }>
}): Promise<ResolvedKiroSettingsTarget> {
  if (target === undefined || (object(target) && target.type === 'default' && Object.keys(target).length === 1)) {
    return { type: 'default', label: '默认 Kiro', homeDir: deps.homeDir, settingsPath: resolveKiroSettingsPath(deps.platform, deps.homeDir, deps.env) }
  }
  if (!object(target) || target.type !== 'instance' || Object.keys(target).length !== 2 ||
      typeof target.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.instanceId) || deps.platform !== 'win32') {
    throw new KiroSettingsError('Kiro 设置目标无效，请重新选择默认客户端或受管实例。')
  }
  const resolved = await deps.resolveInstance(target.instanceId)
  return { type: 'instance', instanceId: target.instanceId, ...resolved }
}

export function kiroSettingsFailure(error: unknown): string {
  return error instanceof KiroSettingsError ? error.message : '无法访问所选 Kiro 设置，请检查配置文件或重新选择有效实例。'
}
