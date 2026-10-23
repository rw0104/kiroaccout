/** Account-scoped metadata returned by the current Kiro control plane. */
export interface KiroModel {
  modelId: string
  modelName: string
  description: string
  modelProvider?: string | null
  rateMultiplier?: number
  rateUnit?: string
  status?: string | null
  supportedInputTypes?: string[]
  tokenLimits?: { maxInputTokens?: number | null; maxOutputTokens?: number | null }
  promptCaching?: {
    supportsPromptCaching: boolean
    maximumCacheCheckpointsPerRequest?: number | null
    minimumTokensPerCacheCheckpoint?: number | null
  } | null
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  availableOrigins?: string[] | null
}

export interface ThinkingConfig {
  schemaPath?: 'output_config' | 'reasoning'
  efforts: string[]
  defaultEffort?: string
  thinkingTypes?: string[]
  defaultThinkingType?: string
  thinkingDisplayTypes?: string[]
}

export interface AccountModelInfo {
  id: string
  name: string
  description: string
  inputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  rateMultiplier?: number
  rateUnit?: string
  supportsThinking: boolean
  thinkingEfforts?: string[]
  thinkingSchemaPath?: 'output_config' | 'reasoning'
  defaultThinkingEffort?: string
  supportsPromptCaching: boolean
  modelProvider?: string | null
  promptCaching?: KiroModel['promptCaching']
  additionalModelRequestFieldsSchema?: KiroModel['additionalModelRequestFieldsSchema']
  status?: string | null
  availableOrigins?: string[] | null
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0) ? [...new Set(value)] : undefined

/** Read the same two effort paths and thinking type enum used by IDE 1.4.13. */
export function extractThinkingSchema(schema?: Record<string, unknown> | null): ThinkingConfig | undefined {
  if (!object(schema?.properties)) return undefined
  const properties = schema.properties
  let result: ThinkingConfig | undefined
  for (const path of ['output_config', 'reasoning'] as const) {
    const container = properties[path]
    const fields = object(container) && object(container.properties) ? container.properties : undefined
    const effort = fields?.effort
    const levels = object(effort) ? strings(effort.enum) : undefined
    if (levels) {
      const defaultLevel = object(effort) ? effort.default : undefined
      result = { schemaPath: path, efforts: levels, ...(typeof defaultLevel === 'string' && levels.includes(defaultLevel) ? { defaultEffort: defaultLevel } : {}) }
      break
    }
  }
  const thinking = properties.thinking
  const fields = object(thinking) && object(thinking.properties) ? thinking.properties : undefined
  const type = fields?.type
  const types = object(type) ? strings(type.enum) : undefined
  if (types?.some(value => value === 'adaptive' || value === 'enabled')) {
    result ??= { efforts: [] }
    result.thinkingTypes = types
    if (object(type) && typeof type.default === 'string' && types.includes(type.default)) result.defaultThinkingType = type.default
    const display = fields?.display
    if (object(display)) result.thinkingDisplayTypes = strings(display.enum)
  }
  return result
}

export class ModelRequestError extends Error {
  readonly statusCode = 400
  readonly retryable = false
  constructor(message: string) { super(message); this.name = 'ModelRequestError' }
}

/** Sonnet 4.0 was retired on 2026-10-14; version spelling is not a new model. */
export function isRetiredModelId(id: string): boolean {
  return /^claude-sonnet-4(?:\.0)?(?:-\d{8})?$/i.test(id) || /^CLAUDE_SONNET_4_20250514(?:_V1_0)?$/i.test(id)
}

export function modelUnavailableReason(model: KiroModel, origin = 'AI_EDITOR'): string | undefined {
  if (isRetiredModelId(model.modelId)) return 'retired (Sonnet 4.0 reached end of life on 2026-10-14)'
  const status = model.status?.toUpperCase().replace(/[\s-]+/g, '_')
  if (status && ['EOL', 'END_OF_LIFE', 'RETIRED', 'REMOVED', 'UNAVAILABLE', 'NOT_AVAILABLE', 'DISABLED', 'INACTIVE', 'BLOCKED', 'ACCESS_DENIED', 'NOT_AUTHORIZED', 'UNSUPPORTED', 'NOT_SUPPORTED'].includes(status)) return `unavailable (${model.status})`
  if (Array.isArray(model.availableOrigins) && !model.availableOrigins.includes(origin)) return `unavailable for ${origin}`
  return undefined
}

export function filterAvailableModels(models: KiroModel[], origin = 'AI_EDITOR'): KiroModel[] {
  const ids = new Set<string>()
  return models.filter(model => {
    if (!model.modelId?.trim() || ids.has(model.modelId) || modelUnavailableReason(model, origin)) return false
    ids.add(model.modelId)
    return true
  })
}

export function toAccountModel(model: KiroModel): AccountModelInfo {
  const thinking = extractThinkingSchema(model.additionalModelRequestFieldsSchema)
  return {
    id: model.modelId, name: model.modelName || model.modelId, description: model.description || '',
    inputTypes: model.supportedInputTypes,
    maxInputTokens: model.tokenLimits?.maxInputTokens, maxOutputTokens: model.tokenLimits?.maxOutputTokens,
    rateMultiplier: model.rateMultiplier, rateUnit: model.rateUnit,
    supportsThinking: !!thinking, thinkingEfforts: thinking?.efforts, thinkingSchemaPath: thinking?.schemaPath,
    defaultThinkingEffort: thinking?.defaultEffort,
    supportsPromptCaching: model.promptCaching?.supportsPromptCaching === true,
    modelProvider: model.modelProvider, promptCaching: model.promptCaching,
    additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema,
    status: model.status, availableOrigins: model.availableOrigins
  }
}
