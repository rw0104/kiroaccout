import { createHash, randomUUID } from 'node:crypto'
import { filterAvailableModels, toAccountModel, type KiroModel } from '../shared/modelCatalog'
import { getStoredFallbackChain, validateFallbackChain, type ModelPreferencesSnapshot, type ModelPreferencesWrite } from '../shared/modelPreferences'
import type { ControlPlaneIdentity, ControlPlaneOperation } from './kiroControlPlane'

type PreferenceIdentity = ControlPlaneIdentity & { proxyUrl?: string }

export interface ModelPreferenceAccount {
  id: string
  idp?: string
  profileArn?: string
  proxyUrl?: string
  credentials: ControlPlaneIdentity & { expiresAt?: number; refreshToken?: string }
}
interface Dependencies {
  account: (id: string) => ModelPreferenceAccount | undefined
  beginOperation: (account: ModelPreferenceAccount) => () => void
  models: (identity: PreferenceIdentity & { id: string }) => Promise<KiroModel[]>
  request: (identity: PreferenceIdentity, operation: ControlPlaneOperation, input: Record<string, unknown>) => Promise<unknown>
  now?: () => number
}
interface Grant { revision: string; fingerprint: string; expiresAt: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export class ModelPreferencesError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelPreferencesError' }
}
const changed = (): never => { throw new ModelPreferencesError('账户或凭证已变化，请重新读取模型偏好。') }

/** Explicit account-scoped reads/writes. Never refreshes or persists credentials. */
export class KiroModelPreferencesService {
  private readonly grants = new Map<string, Grant>()
  private readonly busy = new Set<string>()
  private readonly reads = new Map<string, symbol>()
  private readonly deps: Dependencies
  constructor(deps: Dependencies) { this.deps = deps }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private snapshot(accountId: string): ModelPreferenceAccount {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) return changed()
    const source = this.deps.account(accountId)
    if (!source || source.id !== accountId || !source.credentials?.accessToken || !Number.isFinite(source.credentials.expiresAt) || source.credentials.expiresAt! <= this.now()) throw new ModelPreferencesError('账户访问凭证不可用，请先刷新或重新授权。')
    if (source.profileArn && source.credentials.profileArn && source.profileArn !== source.credentials.profileArn) throw new ModelPreferencesError('账户 profile 资料不一致，请先核对账户。')
    return { ...source, credentials: { ...source.credentials, provider: source.credentials.provider || source.idp, profileArn: source.credentials.profileArn || source.profileArn } }
  }
  private fingerprint(account: ModelPreferenceAccount): string {
    return createHash('sha256').update(JSON.stringify([account.id, account.idp, account.profileArn, account.proxyUrl, account.credentials])).digest('hex')
  }
  private identity(account: ModelPreferenceAccount): PreferenceIdentity & { id: string } {
    const { accessToken, authMethod, provider, profileArn, region } = account.credentials
    return { id: account.id, accessToken, authMethod, provider, profileArn, region, proxyUrl: account.proxyUrl }
  }
  private assertCurrent(account: ModelPreferenceAccount): void {
    if (this.fingerprint(this.snapshot(account.id)) !== this.fingerprint(account)) changed()
  }
  private issue(account: ModelPreferenceAccount, models: KiroModel[], chains: Record<string, string[]>): ModelPreferencesSnapshot {
    const revision = randomUUID()
    this.grants.delete(account.id)
    this.grants.set(account.id, { revision, fingerprint: this.fingerprint(account), expiresAt: this.now() + 300000 })
    while (this.grants.size > 128) this.grants.delete(this.grants.keys().next().value!)
    return { accountId: account.id, revision, models: filterAvailableModels(models).map(toAccountModel), chains }
  }
  private chains(response: unknown): Record<string, string[]> {
    if (!object(response)) throw new ModelPreferencesError('模型偏好响应无效。')
    const fallback = response.modelFallbacks
    if (fallback === undefined || fallback === null) return {}
    if (!object(fallback)) throw new ModelPreferencesError('模型偏好响应无效。')
    if (fallback.perModel === undefined || fallback.perModel === null) return {}
    if (!object(fallback.perModel)) throw new ModelPreferencesError('模型偏好响应无效。')
    const chains: Record<string, string[]> = Object.create(null)
    const entries = Object.entries(fallback.perModel)
    if (entries.length > 10000) throw new ModelPreferencesError('模型偏好响应过大。')
    for (const [id, value] of entries) {
      if (!Array.isArray(value) || value.length > 32 || value.some(row => !object(row) || typeof row.modelId !== 'string' || !row.modelId || row.modelId.length > 512)) throw new ModelPreferencesError('模型偏好响应无效。')
      chains[id] = value.map(row => (row as { modelId: string }).modelId)
    }
    return chains
  }
  async read(accountId: string): Promise<ModelPreferencesSnapshot> {
    if (this.busy.has(accountId)) throw new ModelPreferencesError('正在保存该账户的模型偏好，请稍后读取。')
    const account = this.snapshot(accountId)
    const release = this.deps.beginOperation(account)
    const epoch = Symbol('model-preference-read')
    this.reads.set(accountId, epoch)
    this.grants.delete(accountId)
    try {
      const identity = this.identity(account)
      // Hold the ownership lease until both reads have finished, even if one fails first.
      const [models, response] = await Promise.allSettled([
        Promise.resolve().then(() => this.deps.models(identity)),
        Promise.resolve().then(() => this.deps.request(identity, 'GetUserPreference', {}))
      ])
      this.assertCurrent(account)
      if (epoch !== this.reads.get(accountId) || this.busy.has(accountId)) return changed()
      if (models.status === 'rejected') throw models.reason
      if (response.status === 'rejected') throw response.reason
      return this.issue(account, models.value, this.chains(response.value))
    } finally {
      if (this.reads.get(accountId) === epoch) this.reads.delete(accountId)
      release()
    }
  }
  async save(input: ModelPreferencesWrite): Promise<ModelPreferencesSnapshot> {
    if (!input || typeof input !== 'object') return changed()
    const account = this.snapshot(input.accountId)
    const grant = this.grants.get(account.id)
    if (!grant || grant.revision !== input.revision || grant.expiresAt <= this.now() || grant.fingerprint !== this.fingerprint(account)) return changed()
    if (this.busy.has(account.id)) throw new ModelPreferencesError('正在保存该账户的模型偏好，请稍后重试。')
    const release = this.deps.beginOperation(account)
    this.busy.add(account.id)
    this.reads.delete(account.id)
    // A write may have reached the server even if its response is lost. Require
    // an explicit fresh read before any subsequent save instead of replaying it.
    this.grants.delete(account.id)
    try {
      const identity = this.identity(account)
      const models = await this.deps.models(identity)
      this.assertCurrent(account)
      let chain: string[]
      try { chain = validateFallbackChain(filterAvailableModels(models).map(toAccountModel), input.targetModelId, input.chain) }
      catch { throw new ModelPreferencesError('只能设置一个可用的后备模型或清除设置；不能选择主模型自身或带同意状态的模型。') }
      const response = await this.deps.request(identity, 'SetUserPreference', { targetModelId: input.targetModelId, chain })
      this.assertCurrent(account)
      const batch = object(response) && object(response.batchResult) ? response.batchResult : undefined
      if (!batch || !Array.isArray(batch.successfulPreferences) || batch.errors !== undefined && (!Array.isArray(batch.errors) || batch.errors.length > 0) || !batch.successfulPreferences.some(row => object(row) && row.preferenceType === 'MODEL_FALLBACKS' && row.modelId === input.targetModelId)) throw new ModelPreferencesError('服务未确认该模型的后备链已保存，请重新读取后核对。')
      // Read back after confirmed writes; do not fabricate success from HTTP 200.
      let readback: Record<string, string[]>
      try { readback = this.chains(await this.deps.request(identity, 'GetUserPreference', {})) }
      catch { throw new ModelPreferencesError('服务已确认写入，后续读取未完成，请重新读取后核对。') }
      this.assertCurrent(account)
      const actual = getStoredFallbackChain(readback, input.targetModelId)
      if (JSON.stringify(actual) !== JSON.stringify(chain)) throw new ModelPreferencesError('服务已确认写入，读取结果尚未一致，请重新读取后核对。')
      return this.issue(account, models, readback)
    } finally { this.busy.delete(account.id); release() }
  }
}
