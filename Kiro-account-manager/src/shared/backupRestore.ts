// ============================================
// 完整备份恢复规划（纯函数）
//
// 只负责“备份 → 待写入的账户/分组/标签 + 结果计数”，不读写存储。
// 规则（见 03-remediation-plan.md §2.3 / §2.4）：
// - 先校验结构；缺少可选集合用空数组，集合类型错误给出反馈而非抛异常
// - 分组/标签 ID 与本地冲突且定义不同 → 生成新 ID 并重映射本批引用，保留本地定义
// - 账户 ID 与本地或本批冲突 → 重新分配本地 ID，绝不覆盖已有账户
// - 与本地或本批重复的账户计为 duplicate，不写入
// - 不完整的账户（非对象、缺少 credentials、身份无法识别）计为 invalid
// ============================================

import { emptyOutcome, findExistingDuplicate, normalizeCredentialRecord } from './accountImport'
import type { BackupPayload, ExistingAccountLike, ImportOutcome } from './accountImport'

export interface GroupLike {
  id: string
  name: string
  description?: string
  color?: string
  order: number
  createdAt: number
}

export interface TagLike {
  id: string
  name: string
  color: string
}

export interface RestoreContext {
  existingAccounts: Iterable<ExistingAccountLike & { id: string }>
  existingGroups: Map<string, GroupLike>
  existingTags: Map<string, TagLike>
  generateId: () => string
  generateMachineId: () => string
  now: number
}

/** 恢复后的账户（字段与 renderer 的 Account 类型一致，由调用方断言为 Account） */
export type RestoredAccount = Record<string, unknown> & {
  id: string
  email: string
  idp: string
  credentials: Record<string, unknown>
  tags: string[]
  isActive: false
}

export interface BackupRestorePlan {
  accounts: RestoredAccount[]
  groups: GroupLike[]
  tags: TagLike[]
  outcome: ImportOutcome
  /** 非致命提示（如集合类型错误、被重新分配的 ID） */
  notes: string[]
}

const VALID_STATUSES = new Set(['active', 'expired', 'error', 'refreshing', 'unknown'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// Reserve every incoming ID before allocating IDs, including IDs encountered later.
function reserveIds(existing: Iterable<string>, raw: unknown[]): Set<string> {
  const ids = new Set(existing)
  for (const value of raw) {
    const id = isPlainObject(value) ? nonEmptyString(value.id) : undefined
    if (id) ids.add(id)
  }
  return ids
}

function allocateId(ids: Set<string>, generateId: () => string): string {
  let base = 'imported'
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = nonEmptyString(generateId())
    if (candidate) base = candidate
    if (candidate && !ids.has(candidate)) {
      ids.add(candidate)
      return candidate
    }
  }
  // A faulty generator cannot overwrite data or hang a restore.
  let suffix = 1
  while (ids.has(`${base}-${suffix}`)) suffix++
  const id = `${base}-${suffix}`
  ids.add(id)
  return id
}

export function planBackupRestore(backup: BackupPayload, ctx: RestoreContext): BackupRestorePlan {
  const outcome = emptyOutcome(backup.accounts.length)
  const notes: string[] = []

  // ---------- 分组 ----------
  const groupIdMap = new Map<string, string>()
  const groupsToAdd: GroupLike[] = []
  let rawGroups: unknown[] = []
  if (backup.groups !== undefined && backup.groups !== null) {
    if (Array.isArray(backup.groups)) rawGroups = backup.groups
    else notes.push('备份中的 groups 不是数组，已忽略分组')
  }
  const groupIds = reserveIds(ctx.existingGroups.keys(), rawGroups)
  rawGroups.forEach((g, i) => {
    const id = isPlainObject(g) ? nonEmptyString(g.id) : undefined
    const name = isPlainObject(g) ? nonEmptyString(g.name) : undefined
    if (!isPlainObject(g) || !id || !name) {
      notes.push(`$.groups[${i}] 缺少 id 或 name，已忽略`)
      return
    }
    if (groupIdMap.has(id)) {
      notes.push(`$.groups[${i}] 的 ID 在备份内重复，已保留首次定义`)
      return
    }
    const local = ctx.existingGroups.get(id)
    const color = nonEmptyString(g.color)
    if (local) {
      if (local.name === name && (local.color ?? undefined) === color && nonEmptyString(local.description) === nonEmptyString(g.description)) {
        groupIdMap.set(id, id)
        return
      }
      const newId = allocateId(groupIds, ctx.generateId)
      groupIdMap.set(id, newId)
      notes.push(`$.groups[${i}] 与本地同 ID 分组定义不同，已分配新 ID`)
      groupsToAdd.push({
        id: newId,
        name,
        description: nonEmptyString(g.description),
        color,
        order: finiteNumber(g.order) ?? ctx.existingGroups.size + groupsToAdd.length,
        createdAt: finiteNumber(g.createdAt) ?? ctx.now
      })
      return
    }
    groupIdMap.set(id, id)
    groupsToAdd.push({
      id,
      name,
      description: nonEmptyString(g.description),
      color,
      order: finiteNumber(g.order) ?? ctx.existingGroups.size + groupsToAdd.length,
      createdAt: finiteNumber(g.createdAt) ?? ctx.now
    })
  })

  // ---------- 标签 ----------
  const tagIdMap = new Map<string, string>()
  const tagsToAdd: TagLike[] = []
  let rawTags: unknown[] = []
  if (backup.tags !== undefined && backup.tags !== null) {
    if (Array.isArray(backup.tags)) rawTags = backup.tags
    else notes.push('备份中的 tags 不是数组，已忽略标签')
  }
  const tagIds = reserveIds(ctx.existingTags.keys(), rawTags)
  rawTags.forEach((t, i) => {
    const id = isPlainObject(t) ? nonEmptyString(t.id) : undefined
    const name = isPlainObject(t) ? nonEmptyString(t.name) : undefined
    if (!isPlainObject(t) || !id || !name) {
      notes.push(`$.tags[${i}] 缺少 id 或 name，已忽略`)
      return
    }
    if (tagIdMap.has(id)) {
      notes.push(`$.tags[${i}] 的 ID 在备份内重复，已保留首次定义`)
      return
    }
    const color = nonEmptyString(t.color) ?? '#6b7280'
    const local = ctx.existingTags.get(id)
    if (local) {
      if (local.name === name && local.color === color) {
        tagIdMap.set(id, id)
        return
      }
      const newId = allocateId(tagIds, ctx.generateId)
      tagIdMap.set(id, newId)
      notes.push(`$.tags[${i}] 与本地同 ID 标签定义不同，已分配新 ID`)
      tagsToAdd.push({ id: newId, name, color })
      return
    }
    tagIdMap.set(id, id)
    tagsToAdd.push({ id, name, color })
  })

  // ---------- 账户 ----------
  const existingList = Array.from(ctx.existingAccounts)
  const usedIds = new Set(existingList.map(a => a.id))
  const reservedAccountIds = reserveIds(usedIds, backup.accounts.map(entry => entry.value))
  const accepted: RestoredAccount[] = []

  for (const entry of backup.accounts) {
    const src = entry.value
    if (!isPlainObject(src)) {
      outcome.invalid++
      outcome.errors.push({ source: entry.source, message: '账户记录必须是对象' })
      continue
    }
    if (!isPlainObject(src.credentials)) {
      outcome.invalid++
      outcome.errors.push({
        source: entry.source,
        message: '不是完整账户记录（缺少 credentials 对象）。简化凭证请使用「添加账户 → OIDC 批量导入」'
      })
      continue
    }
    const creds = src.credentials

    // Share field/identity validation with the credential importer. Only genuine
    // tokenless exports may omit IdC client credentials during metadata recovery.
    const normalized = normalizeCredentialRecord(src, { allowEmptyCredentials: true })
    const credential = normalized.credential
    if (!credential) {
      outcome.invalid++
      outcome.errors.push({ source: entry.source, message: normalized.issues.map(issue => issue.message).join('；') })
      continue
    }
    const email = credential.email ?? ''
    const userId = credential.userId
    const refreshToken = credential.refreshToken || undefined
    if (!email && !userId && !refreshToken) {
      outcome.invalid++
      outcome.errors.push({ source: entry.source, message: '缺少可识别的身份（email / userId / refreshToken）' })
      continue
    }

    const dup =
      findExistingDuplicate(existingList, credential) ??
      findExistingDuplicate(accepted as unknown as ExistingAccountLike[], credential)
    if (dup) {
      outcome.duplicate++
      outcome.errors.push({ source: entry.source, message: '该账户已存在，已跳过' })
      continue
    }

    let id = nonEmptyString(src.id)
    if (!id || usedIds.has(id)) {
      const regenerated = Boolean(id)
      id = allocateId(reservedAccountIds, ctx.generateId)
      if (regenerated) notes.push('账户 ID 与已有账户冲突，已重新分配')
    }
    usedIds.add(id)

    const rawGroupId = nonEmptyString(src.groupId)
    let groupId: string | undefined
    if (rawGroupId) {
      if (groupIdMap.has(rawGroupId)) groupId = groupIdMap.get(rawGroupId)
      else if (ctx.existingGroups.has(rawGroupId) && backup.groups == null) groupId = rawGroupId
    }
    const tags = Array.isArray(src.tags)
      ? src.tags
          .filter((t): t is string => typeof t === 'string')
          .map(t => tagIdMap.get(t) ?? (backup.tags == null && ctx.existingTags.has(t) ? t : undefined))
          .filter((t): t is string => Boolean(t))
      : []

    const region = credential.region
    const subscription = isPlainObject(src.subscription) && typeof src.subscription.type === 'string' && ['Free', 'Pro', 'Pro_Plus', 'Enterprise', 'Teams'].includes(src.subscription.type)
      ? src.subscription
      : { type: 'Free' }
    const usageSrc = isPlainObject(src.usage) ? src.usage : {}
    const usage = {
      ...usageSrc,
      current: finiteNumber(usageSrc.current) ?? 0,
      limit: finiteNumber(usageSrc.limit) ?? 0,
      percentUsed: finiteNumber(usageSrc.percentUsed) ?? 0,
      lastUpdated: finiteNumber(usageSrc.lastUpdated) ?? ctx.now
    }

    const account: RestoredAccount = {
      ...src,
      id,
      email,
      userId,
      idp: credential.provider,
      password: credential.password,
      nickname: credential.nickname,
      machineId: nonEmptyString(src.machineId) ?? ctx.generateMachineId(),
      credentials: {
        ...creds,
        accessToken: credential.accessToken ?? '',
        csrfToken: nonEmptyString(creds.csrfToken) ?? '',
        refreshToken,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        clientSecretExpiresAt: credential.clientSecretExpiresAt,
        startUrl: credential.startUrl,
        profileArn: credential.profileArn,
        region,
        expiresAt: credential.expiresAt ?? 0,
        provider: credential.provider,
        authMethod: credential.authMethod
      },
      subscription,
      usage,
      groupId,
      tags: [...new Set(tags)],
      status: refreshToken && typeof src.status === 'string' && VALID_STATUSES.has(src.status) && src.status !== 'refreshing' ? src.status : 'unknown',
      createdAt: finiteNumber(src.createdAt) ?? ctx.now,
      lastUsedAt: finiteNumber(src.lastUsedAt) ?? ctx.now,
      isActive: false
    }
    accepted.push(account)
    outcome.added++
  }

  return { accounts: accepted, groups: groupsToAdd, tags: tagsToAdd, outcome, notes }
}
