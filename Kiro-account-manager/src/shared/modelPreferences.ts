import type { AccountModelInfo } from './modelCatalog'

export interface ModelPreferencesSnapshot {
  accountId: string
  revision: string
  models: AccountModelInfo[]
  chains: Record<string, string[]>
}

export type ModelPreferencesResult =
  | { success: true; snapshot: ModelPreferencesSnapshot }
  | { success: false; error: string }

export interface ModelPreferencesWrite {
  accountId: string
  revision: string
  targetModelId: string
  chain: string[]
}

/** Electron's structured clone need not preserve the map's null prototype. */
export function getStoredFallbackChain(chains: Record<string, string[]>, modelId: string): string[] {
  return Object.hasOwn(chains, modelId) && Array.isArray(chains[modelId]) ? chains[modelId] : []
}

/** Official 1.4.121 isUsableFallbackTarget checks absence, not an assumed enum. */
export function isUsableFallbackTarget(model: Pick<AccountModelInfo, 'consentStatus'>): boolean {
  return model.consentStatus === undefined
}

export function validateFallbackChain(models: AccountModelInfo[], targetModelId: unknown, chain: unknown): string[] {
  if (typeof targetModelId !== 'string' || !models.some(model => model.id === targetModelId)) throw new Error('请选择当前目录中的主模型。')
  if (!Array.isArray(chain) || chain.length > 1 || chain.some(id => typeof id !== 'string')) throw new Error('只能设置一个后备模型或清除设置。')
  for (const id of chain) {
    const model = models.find(item => item.id === id)
    if (!model || id === targetModelId || !isUsableFallbackTarget(model)) throw new Error('后备链包含不可用、自身或需要同意状态核验的模型。')
  }
  return [...chain]
}
