// Offline account export. No store, filesystem, Electron or network access.
// One result drives both the displayed count and the bytes written/copied.
import { normalizeCredentialRecord } from './accountImport'
import type { NormalizedCredential } from './accountImport'
import type { GroupLike, TagLike } from './backupRestore'

export type AccountExportFormat = 'json' | 'oidc' | 'txt' | 'csv' | 'kami' | 'clipboard'
export type AccountExportScope = 'all' | 'selected'

export interface ExportAccountLike {
  id: string
  email: string
  idp?: string
  nickname?: string
  password?: string
  credentials: {
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    clientSecretExpiresAt?: number
    provider?: string
    authMethod?: string
    region?: string
  }
  groupId?: string
  tags?: string[]
}

export interface AccountExportInput {
  accounts: readonly ExportAccountLike[]
  groups: readonly GroupLike[]
  tags: readonly TagLike[]
  selectedIds?: readonly string[]
  scope: AccountExportScope
  format: AccountExportFormat
  /** Explicit opt-in. Omitting this option always produces a credential-free export. */
  includeCredentials?: boolean
  appVersion: string
  now?: number
}

export type AccountExportResult =
  | {
      ok: true
      content: string
      count: number
      extension: 'json' | 'txt' | 'csv'
      containsCredentials: boolean
    }
  | { ok: false; code: string; message: string; count: number }

const SECRET_KEY =
  /token|secret|password|passwd|passphrase|cookie|authorization|authcode|bearer|apikey|privatekey|pkce|verifier|session|devicecode|usercode|accesskey|assertion/
const PRIVATE_CREDENTIAL_KEYS = new Set([
  'provider',
  'authMethod',
  'region',
  'startUrl',
  'profileArn',
  'expiresAt'
])

/** Remove auth secrets recursively, including legacy aliases and nested extension fields. */
export function removeExportCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeExportCredentials)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[\s_-]/g, '')
    // Error strings may embed request bodies or server responses containing credentials.
    if (SECRET_KEY.test(normalized) || normalized === 'lasterror') continue
    if (normalized === 'credentials') {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        out[key] = Object.fromEntries(
          Object.entries(child).filter(([name]) => PRIVATE_CREDENTIAL_KEYS.has(name))
        )
      }
    } else {
      out[key] = removeExportCredentials(child)
    }
  }
  return out
}

function fail(code: string, message: string, count = 0): AccountExportResult {
  return { ok: false, code, message, count }
}

function cloneJson<T>(value: T): T {
  // Callers get an independent snapshot; stripping private fields must never mutate the store.
  return JSON.parse(JSON.stringify(value)) as T
}

function minimalCredential(
  credential: NormalizedCredential,
  includeCredentials: boolean
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    email: credential.email ?? '',
    provider: credential.provider,
    authMethod: credential.authMethod,
    region: credential.region
  }
  if (credential.nickname) record.nickname = credential.nickname
  if (credential.startUrl) record.startUrl = credential.startUrl
  if (credential.profileArn) record.profileArn = credential.profileArn
  if (includeCredentials) {
    record.refreshToken = credential.refreshToken
    if (credential.clientId) record.clientId = credential.clientId
    if (credential.clientSecret) record.clientSecret = credential.clientSecret
    if (credential.clientSecretExpiresAt !== undefined) record.clientSecretExpiresAt = credential.clientSecretExpiresAt
    if (credential.password) record.password = credential.password
  }
  return record
}

export function createAccountExport(input: AccountExportInput): AccountExportResult {
  const includeCredentials = input.includeCredentials === true
  const source = new Map<string, ExportAccountLike>()
  for (const account of input.accounts) {
    if (!account.id || source.has(account.id))
      return fail('invalid_account_ids', '账户 ID 缺失或重复，未导出任何内容')
    source.set(account.id, account)
  }
  const ids =
    input.scope === 'selected' ? [...new Set(input.selectedIds ?? [])] : [...source.keys()]
  if (ids.length === 0) return fail('empty_selection', '没有可导出的账户')
  if (ids.some((id) => !source.has(id)))
    return fail('stale_selection', '部分选中账户已不存在，请重新选择后导出', ids.length)
  if (input.format === 'kami' && !includeCredentials)
    return fail(
      'credentials_required',
      '卡密格式需要明确选择包含凭证；无凭证导出请使用 JSON 或文本',
      ids.length
    )

  try {
    const accounts = cloneJson(ids.map((id) => source.get(id)!))
    const normalized: NormalizedCredential[] = []
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index]
      const record = includeCredentials ? account : removeExportCredentials(account)
      const result = normalizeCredentialRecord(record, {
        allowEmptyCredentials: !includeCredentials || input.format === 'json'
      })
      if (!result.credential) {
        return fail(
          'invalid_credentials',
          `第 ${index + 1} 个账户的认证字段不完整或冲突，请先修正；未导出任何内容`,
          accounts.length
        )
      }
      // A metadata-only backup needs a durable identity to remain restorable.
      if (
        !result.credential.email &&
        !result.credential.userId &&
        !result.credential.refreshToken
      ) {
        return fail(
          'missing_identity',
          `第 ${index + 1} 个账户缺少可恢复的身份，未导出任何内容`,
          accounts.length
        )
      }
      normalized.push(result.credential)
    }

    let content: string
    let extension: 'json' | 'txt' | 'csv' = 'txt'
    switch (input.format) {
      case 'json': {
        const groupIds = new Set(accounts.map((account) => account.groupId).filter(Boolean))
        const tagIds = new Set(accounts.flatMap((account) => account.tags ?? []))
        const groups =
          input.scope === 'all'
            ? input.groups
            : input.groups.filter((group) => groupIds.has(group.id))
        const tags =
          input.scope === 'all' ? input.tags : input.tags.filter((tag) => tagIds.has(tag.id))
        if (
          [...groupIds].some((id) => !groups.some((group) => group.id === id)) ||
          [...tagIds].some((id) => !tags.some((tag) => tag.id === id))
        ) {
          return fail(
            'missing_relationship',
            '账户引用的分组或标签缺失，未导出任何内容，请先检查分组和标签',
            accounts.length
          )
        }
        const backupAccounts = accounts.map((account, index) => {
          const record = account as unknown as Record<string, unknown>
          const credentials = normalized[index]
          delete record.isActive
          record.idp = credentials.provider
          record.credentials = {
            ...account.credentials,
            provider: credentials.provider,
            authMethod: credentials.authMethod,
            region: credentials.region
          }
          if (!includeCredentials) {
            record.status = 'unknown'
            ;(record.credentials as Record<string, unknown>).expiresAt = 0
          }
          return record
        })
        const backup = {
          format: 'kiro-account-backup',
          schemaVersion: 1,
          version: input.appVersion,
          exportedAt: input.now ?? Date.now(),
          credentialsIncluded: includeCredentials,
          accounts: backupAccounts,
          groups: cloneJson(groups),
          tags: cloneJson(tags)
        }
        content = JSON.stringify(
          includeCredentials ? backup : removeExportCredentials(backup),
          null,
          2
        )
        extension = 'json'
        break
      }
      case 'oidc':
        content = JSON.stringify(
          normalized.map((credential) => minimalCredential(credential, includeCredentials)),
          null,
          2
        )
        extension = 'json'
        break
      case 'kami':
        content = normalized
          .map((credential) =>
            [
              credential.email ?? '',
              credential.password || 'no_password',
              credential.refreshToken,
              credential.clientId ?? '',
              credential.clientSecret ?? '',
              credential.provider
            ].join('----')
          )
          .join('\n')
        break
      case 'csv': {
        const headers = includeCredentials
          ? [
              '邮箱',
              '昵称',
              '登录方式',
              'RefreshToken',
              'ClientId',
              'ClientSecret',
              'Region',
              'AuthMethod'
            ]
          : ['邮箱', '昵称', '登录方式', 'Region', 'AuthMethod']
        const rows = normalized.map((credential) =>
          includeCredentials
            ? [
                credential.email ?? '',
                credential.nickname ?? '',
                credential.provider,
                credential.refreshToken,
                credential.clientId ?? '',
                credential.clientSecret ?? '',
                credential.region,
                credential.authMethod
              ]
            : [
                credential.email ?? '',
                credential.nickname ?? '',
                credential.provider,
                credential.region,
                credential.authMethod
              ]
        )
        content =
          '\ufeff' +
          [headers, ...rows]
            .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
            .join('\n')
        extension = 'csv'
        break
      }
      case 'txt':
      case 'clipboard':
        content = normalized
          .map((credential) =>
            includeCredentials
              ? [
                  credential.email ?? '',
                  credential.refreshToken,
                  credential.nickname ?? '',
                  credential.provider
                ].join(',')
              : `${credential.email ?? ''}${credential.nickname ? ` (${credential.nickname})` : ''} - ${credential.provider} / ${credential.authMethod} / ${credential.region}`
          )
          .join('\n')
        break
      default:
        return fail('unsupported_format', '不支持的导出格式，未导出任何内容', accounts.length)
    }
    return {
      ok: true,
      content,
      count: accounts.length,
      extension,
      containsCredentials: includeCredentials
    }
  } catch {
    // JSON or extension values may be invalid. Never return exception text or partial exports.
    return fail('serialization_failed', '账户数据无法序列化，未导出任何内容', ids.length)
  }
}
