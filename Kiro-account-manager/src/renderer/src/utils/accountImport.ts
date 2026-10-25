import {
  emptyOutcome,
  resolveExistingDuplicate,
  formatIssues,
  type ExistingAccountLike,
  type ImportOutcome,
  type ImportPlan,
  type NormalizedCredential
} from '../../../shared/accountImport'
import type { Account } from '../types/account'
import { normalizeSubscriptionType } from '../../../shared/accountSubscription'
import { mergeSourceAccountNames } from '../../../shared/accountSearch'

type Verification = Awaited<ReturnType<Window['api']['verifyAccountCredentials']>>
type AccountInput = Omit<Account, 'id' | 'createdAt' | 'isActive'>

export interface CredentialImportDependencies {
  existing: () => Iterable<ExistingAccountLike>
  verify: (credential: NormalizedCredential) => Promise<Verification>
  add: (account: AccountInput) => string
  persist: () => Promise<void>
  updateSourceAccountNames?: (accountId: string, names: string[]) => void
  getConsumedAccountId?: (credential: NormalizedCredential) => string | undefined
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
  const sourceAccountNames = mergeSourceAccountNames(credential.sourceAccountNames, [credential.email])
  return {
    email,
    userId,
    ...(sourceAccountNames.length ? { sourceAccountNames } : {}),
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
      clientSecretExpiresAt: credential.clientSecretExpiresAt,
      region: credential.region,
      startUrl: credential.startUrl,
      expiresAt: now + seconds * 1000,
      provider: credential.provider,
      authMethod: credential.authMethod,
      profileArn: data.profileArn || credential.profileArn
    },
    profileArn: data.profileArn || credential.profileArn,
    subscription: {
      type: normalizeSubscriptionType({ type: data.subscriptionType, title: data.subscriptionTitle, rawType: data.subscription?.rawType }),
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
  const duplicateSaveSources = new Set<string>()
  const resolvedAccounts = new Map<number, string>()
  const credentialsByIndex = new Map(plan.records.map(record => [record.index, record.credential]))
  const recordDuplicate = (index: number, source: string, credential: NormalizedCredential, accountId?: string, retrySave = false, stable = false): void => {
    if (accountId) {
      // Only verified or stable identity matches can bind rotated tokens to later rows.
      if (stable) resolvedAccounts.set(index, accountId)
      const names = mergeSourceAccountNames(credential.sourceAccountNames, [credential.email])
      if (names.length && deps.updateSourceAccountNames) {
        deps.updateSourceAccountNames(accountId, names)
        // Save on retries too: a previous failed write may have already updated memory.
        duplicateSaveSources.add(source)
      }
    }
    if (retrySave) duplicateSaveSources.add(source)
    outcome.duplicate++
  }
  const recordConflict = (source: string): void => {
    outcome.failed++
    outcome.errors.push({ source, message: '账户身份信息冲突，未更新来源账号，请检查导入记录' })
  }
  for (const record of plan.records) {
    const source = `#${record.index + 1}`
    if (signal?.aborted) { outcome.cancelled++; continue }
    if (!record.credential || record.status === 'invalid') {
      outcome.invalid++
      outcome.errors.push({ source, message: formatIssues(record) })
      continue
    }
    const credential = record.credential
    try {
      const consumedId = deps.getConsumedAccountId?.(credential)
      const previous = record.duplicateOf === undefined ? undefined : credentialsByIndex.get(record.duplicateOf)
      const sharesStableIdentity = previous && (
        previous.refreshToken === credential.refreshToken ||
        (credential.userId && previous.userId === credential.userId)
      )
      const batchId = sharesStableIdentity ? resolvedAccounts.get(record.duplicateOf!) : undefined
      const match = resolveExistingDuplicate(deps.existing(), credential, [consumedId, batchId])
      if (match.conflict) {
        recordConflict(source)
        continue
      }
      if (match.account) {
        recordDuplicate(record.index, source, credential, match.account.id, Boolean(consumedId), match.stable)
        continue
      }
      if (consumedId || deps.wasConsumed?.(credential)) {
        recordDuplicate(record.index, source, credential, undefined, true)
        continue
      }
      if (record.status === 'duplicate') {
        // A shared input label is not evidence that another row owns this token.
        recordDuplicate(record.index, source, credential)
        continue
      }
      const result = await deps.verify(credential)
      if (signal?.aborted) { outcome.cancelled++; continue }
      if (!result.success || !result.data) {
        outcome.failed++
        outcome.errors.push({ source, message: verificationError(result.error) })
        continue
      }
      const account = verifiedAccount(credential, result.data, (deps.now || Date.now)(), groupId)
      const verifiedMatch = resolveExistingDuplicate(deps.existing(), {
        email: account.email, userId: account.userId, provider: credential.provider,
        refreshToken: account.credentials.refreshToken
      })
      if (verifiedMatch.conflict) {
        recordConflict(source)
        continue
      }
      const verifiedDuplicate = verifiedMatch.account
      if (verifiedDuplicate) {
        recordDuplicate(record.index, source, credential, verifiedDuplicate.id, false, true)
        if (verifiedDuplicate.id) deps.rememberConsumed?.(credential, verifiedDuplicate.id)
        continue
      }
      // No await between the final duplicate check and insertion.
      const accountId = deps.add(account)
      resolvedAccounts.set(record.index, accountId)
      deps.rememberConsumed?.(credential, accountId)
      addedSources.push(source)
      outcome.added++
    } catch {
      if (signal?.aborted) { outcome.cancelled++; continue }
      outcome.failed++
      outcome.errors.push({ source, message: '账户验证或添加失败，请检查网络及账户状态' })
    }
  }
  if (outcome.added > 0 || duplicateSaveSources.size > 0) {
    try { await deps.persist() } catch {
      // Keep the in-memory entries to avoid rotating the same token again on a retry.
      outcome.failed += outcome.added + duplicateSaveSources.size
      outcome.duplicate -= duplicateSaveSources.size
      outcome.added = 0
      for (const source of [...addedSources, ...duplicateSaveSources]) outcome.errors.push({ source, message: '账户已在当前窗口保留，但保存失败；请重试保存后再退出' })
    }
  }
  return outcome
}

export function formatImportOutcome(outcome: ImportOutcome): string {
  const summary = `共 ${outcome.total} 条：新增 ${outcome.added}，重复 ${outcome.duplicate}，无效 ${outcome.invalid}，失败 ${outcome.failed}，取消 ${outcome.cancelled}`
  return [summary, ...outcome.errors.slice(0, 10).map((error, index) => `${/^#\d+$/.test(error.source) ? error.source : `#${index + 1}`}: ${error.message}`)].join('\n')
}
