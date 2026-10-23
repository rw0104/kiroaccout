import { resolveIdentity, type CanonicalAuthMethod, type CanonicalProvider } from './authIdentity'

export type AccountSwitchTarget = 'ide' | 'cli' | 'both'
export interface SwitchAccountSnapshot {
  id: string
  idp?: string
  profileArn?: string
  credentials: {
    accessToken: string
    expiresAt?: number
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    clientSecretExpiresAt?: number
    region?: string
    startUrl?: string
    authMethod?: string
    provider?: string
    profileArn?: string
  }
}
export interface AccountSwitchPayload {
  accountId: string
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
  clientSecretExpiresAt?: number
  region: string
  startUrl?: string
  authMethod: CanonicalAuthMethod
  provider: CanonicalProvider
  profileArn?: string
  expiresAt?: number
  reusePreparedCredentials?: boolean
  handoffProof?: string
}
export interface SwitchCredentialUpdate {
  accessToken: string
  refreshToken: string
  expiresAt: number
}
export interface AccountSwitchResponse {
  success: boolean
  error?: string
  refreshedCredentials?: { accessToken: string; refreshToken: string; expiresIn: number }
  handoffProof?: string
  preparedExpiresAt?: number
}
export interface AccountSwitchResult {
  success: boolean
  error?: string
  completedTargets: Array<'ide' | 'cli'>
}
export interface AccountSwitchDependencies {
  getAccount: (id: string) => SwitchAccountSnapshot | undefined
  switchIde: (payload: AccountSwitchPayload) => Promise<AccountSwitchResponse>
  switchCli: (payload: AccountSwitchPayload) => Promise<AccountSwitchResponse>
  applyCredentials: (id: string, expected: SwitchAccountSnapshot['credentials'], next: SwitchCredentialUpdate) => boolean
  persist: () => Promise<void>
  activate: (id: string) => Promise<void>
  now?: () => number
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Each client receives the newest stored generation; rotations are retained even if its write fails. */
export async function switchAccountToClients(id: string, target: AccountSwitchTarget, deps: AccountSwitchDependencies): Promise<AccountSwitchResult> {
  const completedTargets: AccountSwitchResult['completedTargets'] = []
  const failure = (message: string): AccountSwitchResult => ({ success: false, error: `${completedTargets.includes('ide') && target === 'both' ? 'Kiro IDE 已切换；' : ''}${message}`, completedTargets })
  if (!['ide', 'cli', 'both'].includes(target)) return failure('切换目标无效')
  const steps = target === 'both' ? ['ide', 'cli'] as const : [target]
  let handoffProof: string | undefined
  for (const step of steps) {
    const account = deps.getAccount(id)
    if (!account) return failure('账户已移除，切换已停止')
    const credentials = { ...account.credentials }
    const identity = resolveIdentity({ provider: credentials.provider, idp: account.idp, authMethod: credentials.authMethod,
      hasClientCredentials: nonempty(credentials.clientId) && nonempty(credentials.clientSecret) })
    if (!identity.ok || !nonempty(credentials.refreshToken) || identity.authMethod !== 'social' && (!nonempty(credentials.clientId) || !nonempty(credentials.clientSecret))) {
      return failure('账号凭证不完整或身份不一致，请重新授权后再切换')
    }
    const payload: AccountSwitchPayload = {
      accountId: id, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken,
      clientId: credentials.clientId || '', clientSecret: credentials.clientSecret || '', clientSecretExpiresAt: credentials.clientSecretExpiresAt,
      region: credentials.region || 'us-east-1', startUrl: credentials.startUrl, authMethod: identity.authMethod,
      provider: identity.provider, profileArn: account.profileArn || credentials.profileArn
    }
    if (step === 'cli' && target === 'both') {
      if (!handoffProof || !Number.isFinite(credentials.expiresAt) || credentials.expiresAt! <= (deps.now ?? Date.now)()) {
        return failure('IDE 凭证交接无效，CLI 未写入；请重新切换')
      }
      payload.reusePreparedCredentials = true
      payload.handoffProof = handoffProof
      payload.expiresAt = credentials.expiresAt
    }
    let response: AccountSwitchResponse
    try { response = await (step === 'ide' ? deps.switchIde : deps.switchCli)(payload) }
    catch { return failure(`${step === 'ide' ? 'Kiro IDE' : 'Kiro CLI'} 切换请求失败，请检查状态后重试`) }
    if (response.refreshedCredentials) {
      const rotation = response.refreshedCredentials
      const expiresAt = response.preparedExpiresAt ?? (deps.now ?? Date.now)() + rotation.expiresIn * 1000
      if (!nonempty(rotation.accessToken) || !nonempty(rotation.refreshToken) || !Number.isFinite(rotation.expiresIn) || rotation.expiresIn <= 0 || !Number.isFinite(expiresAt)) {
        return failure('切换返回的凭证不完整，请重新授权后再试')
      }
      if (!deps.applyCredentials(id, credentials, { accessToken: rotation.accessToken, refreshToken: rotation.refreshToken, expiresAt })) {
        return failure('账户凭证已变化，未覆盖较新的凭证；切换已停止')
      }
      try { await deps.persist() }
      catch { return failure('新凭证已保留在当前窗口，但保存失败；请保存成功后再继续切换') }
      // A slow client write can outlive a short access-token lifetime. Preserve
      // the usable refresh generation first, then stop rather than activate it.
      if (expiresAt <= (deps.now ?? Date.now)()) return failure('访问凭证已到期，新刷新凭证已保留；请重新执行切换')
    }
    if (!response.success) return failure(`${step === 'ide' ? 'Kiro IDE' : 'Kiro CLI'} 切换失败${response.error ? `：${response.error}` : ''}`)
    completedTargets.push(step)
    if (step === 'ide' && target === 'both') {
      if (!nonempty(response.handoffProof)) return failure('IDE 凭证交接未完成，CLI 未写入；请重新切换')
      handoffProof = response.handoffProof
    }
  }
  try { await deps.activate(id) }
  catch { return failure('客户端已切换，但管理器状态保存失败，请重试保存') }
  return { success: true, completedTargets }
}
