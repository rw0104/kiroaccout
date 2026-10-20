import {
  emptyOutcome,
  findExistingDuplicate,
  formatIssues,
  type ExistingAccountLike,
  type ImportOutcome,
  type ImportPlan,
  type NormalizedCredential
} from '../../../shared/accountImport'
import type { Account, SubscriptionType } from '../types/account'

type Verification = Awaited<ReturnType<Window['api']['verifyAccountCredentials']>>
type AccountInput = Omit<Account, 'id' | 'createdAt' | 'isActive'>

export interface CredentialImportDependencies {
  existing: () => Iterable<ExistingAccountLike>
  verify: (credential: NormalizedCredential) => Promise<Verification>
  add: (account: AccountInput) => string
  persist: () => Promise<void>
  wasConsumed?: (credential: NormalizedCredential) => boolean
  rememberConsumed?: (credential: NormalizedCredential, accountId: string) => void
  now?: () => number
}

function verificationError(error: unknown): string {
  // Upstream errors can contain both input secrets and newly issued credentials.
  // Return only local fixed messages, never the original response body.
  if (typeof error === 'string') {
    if (/429|too.?many.?requests|限流/i.test(error)) return '请求受限，请稍后重试'
    if (/401|403|invalid_grant|access.?denied|unauthorized|过期/i.test(error)) return '认证被拒绝，请检查凭证有效期与账户状态'
    if (/timeout|timed.?out|超时/i.test(error)) return '请求超时，请检查网络后重试'
  }
  return '凭证验证失败，请检查网络及账户状态'
}

export function verifiedAccount(
  credential: NormalizedCredential,
  data: NonNullable<Verification['data']>,
  now: number,
  groupId?: string
): AccountInput {
  if (typeof data.accessToken !== 'string' || !data.accessToken.trim() ||
      typeof data.refreshToken !== 'string' || !data.refreshToken.trim()) {
    throw new Error('Invalid verification result')
  }
  const email = data.email?.trim() || credential.email || ''
  const userId = data.userId?.trim() || credential.userId
  if (!email && !userId) throw new Error('Missing verified identity')
  const seconds = Number.isFinite(data.expiresIn) && data.expiresIn! > 0 ? data.expiresIn! : 0
  const subscriptions: SubscriptionType[] = ['Free', 'Pro', 'Pro_Plus', 'Enterprise', 'Teams']
  return {
    email,
    userId,
    password: credential.password,
    nickname: credential.nickname || email.split('@')[0] || undefined,
    idp: credential.provider,
    groupId,
    credentials: {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      csrfToken: '',
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      region: credential.region,
      startUrl: credential.startUrl,
      expiresAt: now + seconds * 1000,
      provider: credential.provider,
      authMethod: credential.authMethod,
      profileArn: data.profileArn || credential.profileArn
    },
    profileArn: data.profileArn || credential.profileArn,
    subscription: {
      type: subscriptions.includes(data.subscriptionType as SubscriptionType) ? data.subscriptionType as SubscriptionType : 'Free',
      title: data.subscriptionTitle,
      rawType: data.subscription?.rawType,
      daysRemaining: data.daysRemaining,
      expiresAt: data.expiresAt,
      managementTarget: data.subscription?.managementTarget,
      upgradeCapability: data.subscription?.upgradeCapability,
      overageCapability: data.subscription?.overageCapability
    },
    usage: {
      ...data.usage,
      percentUsed: data.usage.limit > 0 ? data.usage.current / data.usage.limit : 0,
      lastUpdated: now
    },
    tags: [],
    status: seconds > 0 ? 'active' : 'unknown',
    lastUsedAt: now
  }
}

/** Serial verification/commit prevents batch races; the store is read again after each await. */
export async function executeCredentialImport(
  plan: ImportPlan,
  deps: CredentialImportDependencies,
  groupId?: string,
  signal?: AbortSignal
): Promise<ImportOutcome> {
  const outcome = emptyOutcome(plan.counts.total)
  if (!plan.ok) {
    outcome.errors.push({ source: '$', message: plan.error?.message || '无法识别导入格式' })
    return outcome
  }
  const addedSources: string[] = []
  const consumedRetrySources: string[] = []
  for (const record of plan.records) {
    const source = `#${record.index + 1}`
    if (signal?.aborted) { outcome.cancelled++; continue }
    if (record.status === 'duplicate') { outcome.duplicate++; continue }
    if (!record.credential || record.status === 'invalid') {
      outcome.invalid++
      outcome.errors.push({ source, message: formatIssues(record) })
      continue
    }
    const credential = record.credential
    if (deps.wasConsumed?.(credential)) {
      outcome.duplicate++
      consumedRetrySources.push(source)
      continue
    }
    if (findExistingDuplicate(deps.existing(), credential)) { outcome.duplicate++; continue }
    try {
      const result = await deps.verify(credential)
      if (signal?.aborted) { outcome.cancelled++; continue }
      if (!result.success || !result.data) {
        outcome.failed++
        outcome.errors.push({ source, message: verificationError(result.error) })
        continue
      }
      const account = verifiedAccount(credential, result.data, (deps.now || Date.now)(), groupId)
      if (findExistingDuplicate(deps.existing(), {
        email: account.email, userId: account.userId, provider: credential.provider,
        refreshToken: account.credentials.refreshToken
      })) { outcome.duplicate++; continue }
      // No await between the final duplicate check and insertion.
      const accountId = deps.add(account)
      deps.rememberConsumed?.(credential, accountId)
      addedSources.push(source)
      outcome.added++
    } catch {
      if (signal?.aborted) { outcome.cancelled++; continue }
      outcome.failed++
      outcome.errors.push({ source, message: '账户验证或添加失败，请检查网络及账户状态' })
    }
  }
  if (outcome.added > 0 || consumedRetrySources.length > 0) {
    try { await deps.persist() } catch {
      // Keep the in-memory entries to avoid rotating the same token again on a retry.
      outcome.failed += outcome.added + consumedRetrySources.length
      outcome.duplicate -= consumedRetrySources.length
      outcome.added = 0
      for (const source of [...addedSources, ...consumedRetrySources]) outcome.errors.push({ source, message: '账户已在当前窗口保留，但保存失败；请重试保存后再退出' })
    }
  }
  return outcome
}

export function formatImportOutcome(outcome: ImportOutcome): string {
  const summary = `共 ${outcome.total} 条：新增 ${outcome.added}，重复 ${outcome.duplicate}，无效 ${outcome.invalid}，失败 ${outcome.failed}，取消 ${outcome.cancelled}`
  return [summary, ...outcome.errors.slice(0, 10).map((error, index) => `${/^#\d+$/.test(error.source) ? error.source : `#${index + 1}`}: ${error.message}`)].join('\n')
}
