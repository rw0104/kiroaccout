// ============================================
// 账户导入解析（main 与 renderer 共用的纯函数，不依赖 React / Electron / 网络）
//
// 数据流（见 docs/2026-10-19-account-import-login/03-remediation-plan.md §2.1）：
//   文本 → 去 BOM/空白/完整代码围栏 → JSON 解析或卡密行识别 → 白名单容器解包
//        → 字段/身份标准化 → 逐条校验 → ImportPlan
// 预览、按钮计数与实际提交必须共用同一个 ImportPlan。
// 错误信息只包含字段名和原因，不回显凭证值。
// ============================================

import { normalizeAuthMethod, normalizeProvider, resolveIdentity } from './authIdentity'
import type { CanonicalAuthMethod, CanonicalProvider } from './authIdentity'

export type ImportFormat = 'json' | 'lines'
export type ImportContainer =
  | 'object'
  | 'array'
  | 'accounts-array'
  | 'accounts-map'
  | 'data-array'
  | 'backup'
  | 'lines'

export interface ImportIssue {
  field?: string
  code: string
  message: string
}

export type ImportRecordStatus = 'valid' | 'invalid' | 'duplicate'

export interface NormalizedCredential {
  refreshToken: string
  accessToken?: string
  clientId?: string
  clientSecret?: string
  region: string
  provider: CanonicalProvider
  authMethod: CanonicalAuthMethod
  startUrl?: string
  profileArn?: string
  /** 毫秒时间戳 */
  expiresAt?: number
  email?: string
  password?: string
  userId?: string
  nickname?: string
}

export interface ImportRecord {
  /** 在源中的序号（从 0 开始） */
  index: number
  /** 供界面展示的位置：JSON 路径（如 `$[2]`、`$.accounts.abc`）或 `第 N 行` */
  source: string
  status: ImportRecordStatus
  credential?: NormalizedCredential
  issues: ImportIssue[]
  warnings: string[]
  /** 源记录（JSON 对象或卡密行原文），用于失败后回填输入框 */
  raw: unknown
  /** 状态为 duplicate 时，与之重复的记录序号 */
  duplicateOf?: number
}

export interface BackupPayload {
  version?: string
  exportedAt?: number
  /** 原始账户条目及其 JSON 路径 */
  accounts: Array<{ source: string; value: unknown }>
  groups: unknown
  tags: unknown
}

export interface ImportPlanCounts {
  total: number
  valid: number
  invalid: number
  duplicate: number
}

export interface ImportPlan {
  ok: boolean
  error?: { code: string; message: string }
  format?: ImportFormat
  container?: ImportContainer
  records: ImportRecord[]
  counts: ImportPlanCounts
  /** 仅当识别为完整备份时存在 */
  backup?: BackupPayload
}

export const DEFAULT_REGION = 'us-east-1'
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+$/

// ---------- 文本预处理 ----------

/**
 * 去 UTF-8 BOM、首尾空白；若整段文本是一个完整的 Markdown 代码围栏，取出其中内容。
 * 以 ``` 开头但没有闭合围栏时返回错误，而不是把围栏文本当成其他格式。
 */
export function preprocessImportText(text: string): { ok: true; text: string } | { ok: false; code: string; message: string } {
  let t = typeof text === 'string' ? text : ''
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
  t = t.trim()
  if (t.startsWith('```')) {
    const m = /^```[^\n`]*\n([\s\S]*?)\n?[ \t]*```$/.exec(t)
    if (!m) {
      return { ok: false, code: 'incomplete_code_fence', message: '代码围栏不完整：请粘贴完整的 ```json ... ``` 块，或只粘贴 JSON 内容' }
    }
    t = m[1].trim()
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim()
  }
  return { ok: true, text: t }
}

/**
 * 卡密行分隔：优先 `----`，其次 Tab，最后连续空格。
 * 连续 N 个连字符视为 ⌊N/4⌋ 个分隔符（中间为空字段），余下 N%4 个连字符归入前一字段。
 * 这样导出端以 `----` 连接空 clientId/clientSecret 生成的 `RT------------Github` 能还原为 6 个字段
 * （旧实现把整段连字符当成 1 个分隔符，Github 会落到 clientId 位置，见分析文档 F-09）。
 */
export function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) {
    const parts: string[] = []
    const re = /-{4,}/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const separators = Math.floor(m[0].length / 4)
      const extra = m[0].length % 4
      parts.push(line.slice(last, m.index) + '-'.repeat(extra))
      for (let i = 1; i < separators; i++) parts.push('')
      last = m.index + m[0].length
    }
    parts.push(line.slice(last))
    return parts
  }
  if (line.includes('\t')) return line.split('\t')
  return line.split(/\s{2,}/)
}

function hasLineSeparator(line: string): boolean {
  return line.includes('----') || line.includes('\t') || /\S\s{2,}\S/.test(line)
}

// ---------- 字段标准化 ----------

type StringField =
  | 'refreshToken'
  | 'accessToken'
  | 'clientId'
  | 'clientSecret'
  | 'authMethod'
  | 'provider'
  | 'region'
  | 'startUrl'
  | 'profileArn'
  | 'email'
  | 'password'
  | 'userId'
  | 'nickname'
  | 'idp'

const STRING_FIELD_ALIASES: Record<StringField, string[]> = {
  refreshToken: ['refreshToken', 'refresh_token'],
  accessToken: ['accessToken', 'access_token'],
  clientId: ['clientId', 'client_id'],
  clientSecret: ['clientSecret', 'client_secret'],
  authMethod: ['authMethod', 'auth_method'],
  provider: ['provider'],
  region: ['region'],
  startUrl: ['startUrl', 'start_url'],
  profileArn: ['profileArn', 'profile_arn'],
  email: ['email'],
  password: ['password'],
  userId: ['userId', 'user_id'],
  nickname: ['nickname'],
  idp: ['idp']
}
const EXPIRES_AT_ALIASES = ['expiresAt', 'expires_at']

const ALL_KNOWN_KEYS = new Set<string>([
  ...Object.values(STRING_FIELD_ALIASES).flat(),
  ...EXPIRES_AT_ALIASES,
  'credentials'
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** 取出某个字段在顶层与 credentials 中的所有出现 */
function collectOccurrences(
  record: Record<string, unknown>,
  creds: Record<string, unknown> | undefined,
  aliases: string[]
): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = []
  for (const key of aliases) {
    if (key in record && record[key] !== undefined && record[key] !== null) out.push({ path: key, value: record[key] })
  }
  if (creds) {
    for (const key of aliases) {
      if (key in creds && creds[key] !== undefined && creds[key] !== null) out.push({ path: `credentials.${key}`, value: creds[key] })
    }
  }
  return out
}

/**
 * 将毫秒/秒时间戳或 ISO 字符串转换为毫秒时间戳；无法判断时返回 undefined，不伪造长期有效。
 */
export function normalizeTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined
    const ms = raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
    return Number.isFinite(new Date(ms).getTime()) ? ms : undefined
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return undefined
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return normalizeTimestamp(Number(s))
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s)) return undefined
    const ms = Date.parse(s)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
  return undefined
}

interface NormalizeResult {
  credential?: NormalizedCredential
  issues: ImportIssue[]
  warnings: string[]
}

/**
 * 标准化单条记录：读取顶层与 `credentials` 内的 camelCase / snake_case 字段，
 * 校验类型与冲突，解析认证身份，并按认证方式检查必填字段。
 */
export function normalizeCredentialRecord(
  raw: unknown,
  // Backup recovery may restore metadata without tokens; it still requires a
  // complete account shape and a stable identity to create an offline account.
  options: { allowEmptyCredentials?: boolean } = {}
): NormalizeResult {
  const issues: ImportIssue[] = []
  const warnings: string[] = []

  if (!isPlainObject(raw)) {
    return { issues: [{ code: 'not_object', message: `记录必须是对象，实际为 ${typeName(raw)}` }], warnings }
  }
  if (options.allowEmptyCredentials && !isPlainObject(raw.credentials)) {
    return {
      issues: [{ field: 'credentials', code: 'incomplete_backup_record', message: '完整账户备份缺少 credentials 对象，请使用凭证导入入口导入简化凭证' }],
      warnings
    }
  }

  let creds: Record<string, unknown> | undefined
  if ('credentials' in raw && raw.credentials !== undefined && raw.credentials !== null) {
    if (isPlainObject(raw.credentials)) {
      creds = raw.credentials
    } else {
      issues.push({ field: 'credentials', code: 'invalid_type', message: `credentials 必须是对象，实际为 ${typeName(raw.credentials)}` })
    }
  }

  const hasKnownField = Object.keys(raw).some(k => ALL_KNOWN_KEYS.has(k)) || (creds !== undefined && Object.keys(creds).some(k => ALL_KNOWN_KEYS.has(k)))
  if (!hasKnownField) {
    return { issues: [{ code: 'unrecognized_record', message: '未找到任何账户字段（refreshToken、provider、clientId 等）' }], warnings }
  }

  const values: Partial<Record<StringField, string>> = {}
  for (const field of Object.keys(STRING_FIELD_ALIASES) as StringField[]) {
    const occ = collectOccurrences(raw, creds, STRING_FIELD_ALIASES[field])
    const strings: Array<{ path: string; value: string }> = []
    for (const o of occ) {
      if (typeof o.value !== 'string') {
        issues.push({ field: o.path, code: 'invalid_type', message: `${o.path} 必须是字符串，实际为 ${typeName(o.value)}` })
        continue
      }
      const trimmed = o.value.trim()
      if (trimmed) strings.push({ path: o.path, value: trimmed })
    }
    if (strings.length === 0) continue
    // provider / authMethod / idp 以标准化后的值比较，其余按去空白后的原文比较
    const comparable = (v: string): string => {
      if (field === 'provider' || field === 'idp') return String(normalizeProvider(v) ?? v)
      if (field === 'authMethod') return String(normalizeAuthMethod(v) ?? v)
      return v
    }
    const first = strings[0]
    const conflict = strings.find(s => comparable(s.value) !== comparable(first.value))
    if (conflict) {
      issues.push({ field, code: 'field_conflict', message: `字段冲突：${first.path} 与 ${conflict.path} 的值不同` })
      continue
    }
    values[field] = first.value
  }

  // 到期时间（可选）
  let expiresAt: number | undefined
  const expOcc = collectOccurrences(raw, creds, EXPIRES_AT_ALIASES)
  if (expOcc.length > 0) {
    const parsed = expOcc.map(o => ({ path: o.path, ms: normalizeTimestamp(o.value) }))
    const valid = parsed.filter(p => p.ms !== undefined)
    if (valid.length < parsed.length) warnings.push('expiresAt 无法识别，已忽略')
    if (valid.length > 0) {
      const distinct = new Set(valid.map(v => v.ms))
      if (distinct.size > 1) warnings.push('顶层与 credentials 的 expiresAt 不一致，已忽略')
      else expiresAt = valid[0].ms
    }
  }

  // 认证身份
  const identity = resolveIdentity({
    provider: values.provider,
    authMethod: values.authMethod,
    idp: values.provider ? undefined : values.idp,
    hasClientCredentials: Boolean(values.clientId && values.clientSecret)
  })
  if (!identity.ok) {
    issues.push({ field: identity.code === 'unsupported_auth_method' ? 'authMethod' : identity.code === 'unsupported_idp' ? 'idp' : 'provider', code: identity.code, message: identity.message })
  } else {
    warnings.push(...identity.warnings)
  }

  // 必填字段
  if (options.allowEmptyCredentials && !values.email && !values.userId) {
    issues.push({ field: 'email,userId', code: 'missing_stable_identity', message: '完整账户备份缺少 email 或 userId，无法离线恢复账户身份' })
  }
  if (!values.refreshToken && !options.allowEmptyCredentials && !issues.some(i => i.field?.endsWith('refreshToken') || i.field?.endsWith('refresh_token'))) {
    issues.push({ field: 'refreshToken', code: 'missing_field', message: '缺少 refreshToken' })
  }
  if (identity.ok && identity.authMethod === 'IdC' && (!options.allowEmptyCredentials || values.refreshToken)) {
    const missing: string[] = []
    if (!values.clientId) missing.push('clientId')
    if (!values.clientSecret) missing.push('clientSecret')
    if (missing.length > 0) {
      issues.push({ field: missing.join(','), code: 'missing_field', message: `${identity.provider} (IdC) 缺少 ${missing.join('、')}` })
    }
  }

  // 区域
  let region = DEFAULT_REGION
  if (values.region) {
    if (REGION_PATTERN.test(values.region)) region = values.region
    else issues.push({ field: 'region', code: 'invalid_region', message: 'region 格式无效，请填写 AWS 区域标识' })
  }

  if (issues.length > 0 || !identity.ok) {
    return { issues, warnings }
  }

  const credential: NormalizedCredential = {
    refreshToken: values.refreshToken ?? '',
    region,
    provider: identity.provider,
    authMethod: identity.authMethod
  }
  if (values.accessToken) credential.accessToken = values.accessToken
  if (identity.authMethod === 'IdC') {
    credential.clientId = values.clientId
    credential.clientSecret = values.clientSecret
  } else {
    // Social 不需要 OIDC client；若存在则原样保留，便于导出往返
    if (values.clientId) credential.clientId = values.clientId
    if (values.clientSecret) credential.clientSecret = values.clientSecret
  }
  if (values.startUrl) credential.startUrl = values.startUrl
  if (values.profileArn) credential.profileArn = values.profileArn
  if (expiresAt !== undefined) credential.expiresAt = expiresAt
  if (values.email) credential.email = values.email
  if (values.password && values.password !== 'no_password') credential.password = values.password
  if (values.userId) credential.userId = values.userId
  if (values.nickname) credential.nickname = values.nickname

  return { credential, issues, warnings }
}

// ---------- 容器解包 ----------

function looksLikeRecord(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some(k => ALL_KNOWN_KEYS.has(k))
}

function isBackupShape(obj: Record<string, unknown>): boolean {
  if (!('accounts' in obj)) return false
  if (!Array.isArray(obj.accounts) && !isPlainObject(obj.accounts)) return false
  return 'version' in obj || 'exportedAt' in obj || 'groups' in obj || 'tags' in obj
}

function emptyCounts(): ImportPlanCounts {
  return { total: 0, valid: 0, invalid: 0, duplicate: 0 }
}

function failPlan(code: string, message: string, format?: ImportFormat): ImportPlan {
  return { ok: false, error: { code, message }, format, records: [], counts: emptyCounts() }
}

const UNSUPPORTED_STRUCTURE_MESSAGE =
  'JSON 合法，但不是支持的账户结构。支持：单个账户对象、账户数组、{ "accounts": [...] }、{ "data": [...] }、本应用导出的完整备份'

function entriesFromAccounts(value: unknown, basePath: string): Array<{ source: string; value: unknown }> | null {
  if (Array.isArray(value)) return value.map((v, i) => ({ source: `${basePath}[${i}]`, value: v }))
  if (isPlainObject(value)) return Object.entries(value).map(([k, v]) => ({ source: `${basePath}.${k}`, value: v }))
  return null
}

/**
 * 从已解析的 JSON 值生成导入计划。只解包文档化容器，不递归搜索任意对象。
 */
export function planFromJsonValue(value: unknown): ImportPlan {
  let container: ImportContainer
  let entries: Array<{ source: string; value: unknown }>
  let backup: BackupPayload | undefined

  if (Array.isArray(value)) {
    container = 'array'
    entries = value.map((v, i) => ({ source: `$[${i}]`, value: v }))
  } else if (isPlainObject(value)) {
    if (isBackupShape(value)) {
      container = 'backup'
      entries = entriesFromAccounts(value.accounts, '$.accounts') ?? []
      backup = {
        version: typeof value.version === 'string' ? value.version : undefined,
        exportedAt: typeof value.exportedAt === 'number' ? value.exportedAt : undefined,
        accounts: entries,
        groups: value.groups,
        tags: value.tags
      }
    } else if ('accounts' in value && !looksLikeRecord(value)) {
      const e = entriesFromAccounts(value.accounts, '$.accounts')
      if (!e) return failPlan('unsupported_structure', 'accounts 必须是数组或以账户 ID 为键的对象', 'json')
      container = Array.isArray(value.accounts) ? 'accounts-array' : 'accounts-map'
      entries = e
    } else if ('data' in value && !looksLikeRecord(value)) {
      if (!Array.isArray(value.data)) return failPlan('unsupported_structure', 'data 必须是账户数组', 'json')
      container = 'data-array'
      entries = value.data.map((v, i) => ({ source: `$.data[${i}]`, value: v }))
    } else if (looksLikeRecord(value)) {
      container = 'object'
      entries = [{ source: '$', value }]
    } else {
      return failPlan('unsupported_structure', UNSUPPORTED_STRUCTURE_MESSAGE, 'json')
    }
  } else {
    return failPlan('unsupported_structure', UNSUPPORTED_STRUCTURE_MESSAGE, 'json')
  }

  if (entries.length === 0) {
    return { ...failPlan('empty_accounts', '没有找到任何账户记录', 'json'), container, backup }
  }

  const records: ImportRecord[] = entries.map((entry, index) => {
    const r = normalizeCredentialRecord(entry.value, backup ? { allowEmptyCredentials: true } : undefined)
    return {
      index,
      source: entry.source,
      status: r.credential ? 'valid' : 'invalid',
      credential: r.credential,
      issues: r.issues,
      warnings: r.warnings,
      raw: entry.value
    }
  })
  return finalizePlan({ ok: true, format: 'json', container, records, counts: emptyCounts(), backup })
}

/**
 * 解析卡密行：邮箱----密码----RefreshToken----ClientId----ClientSecret[----Provider]
 * 也支持 Tab 或连续空格分隔。空行与 # 注释不计入总数；每行保留原始行号。
 */
export function planFromLines(text: string): ImportPlan {
  const lines = text.split(/\r?\n/)
  const candidates: Array<{ lineNo: number; line: string }> = []
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    candidates.push({ lineNo: i + 1, line: t })
  })
  if (candidates.length === 0) return failPlan('empty_input', '没有可导入的内容', 'lines')
  if (!candidates.some(c => hasLineSeparator(c.line))) {
    return failPlan(
      'unsupported_text',
      '无法识别的格式：请输入 JSON，或卡密格式（邮箱----密码----RefreshToken----ClientId----ClientSecret[----Provider]）',
      'lines'
    )
  }

  const records: ImportRecord[] = candidates.map(({ lineNo, line }, index) => {
    const source = `第 ${lineNo} 行`
    if (!hasLineSeparator(line)) {
      return {
        index,
        source,
        status: 'invalid',
        issues: [{ code: 'unrecognized_line', message: '无法识别的行格式（需要 ---- / Tab / 连续空格分隔）' }],
        warnings: [],
        raw: line
      }
    }
    const parts = splitCredentialLine(line).map(p => p.trim())
    if (parts.length < 3 || parts.length > 6) {
      return {
        index,
        source,
        status: 'invalid',
        issues: [{ code: 'invalid_line_fields', message: '卡密行必须有 3 至 6 个字段，请检查分隔符及字段顺序' }],
        warnings: [],
        raw: line
      }
    }
    const obj: Record<string, string> = {}
    if (parts[0]) obj.email = parts[0]
    if (parts[1]) obj.password = parts[1]
    obj.refreshToken = parts[2] ?? ''
    if (parts[3]) obj.clientId = parts[3]
    if (parts[4]) obj.clientSecret = parts[4]
    if (parts[5]) obj.provider = parts[5]
    const r = normalizeCredentialRecord(obj)
    return {
      index,
      source,
      status: r.credential ? 'valid' : 'invalid',
      credential: r.credential,
      issues: r.issues,
      warnings: r.warnings,
      raw: line
    }
  })
  return finalizePlan({ ok: true, format: 'lines', container: 'lines', records, counts: emptyCounts() })
}

/**
 * 解析导入文本（文件内容或粘贴文本）的唯一入口。
 * 以 `{` 或 `[` 开头按 JSON 解析；语法错误直接报告，不降级为卡密格式。
 */
export function parseAccountImportText(text: string): ImportPlan {
  const pre = preprocessImportText(text)
  if (!pre.ok) return failPlan(pre.code, pre.message)
  const t = pre.text
  if (!t) return failPlan('empty_input', '请输入凭证数据')
  if (t.startsWith('{') || t.startsWith('[')) {
    let value: unknown
    try {
      value = JSON.parse(t)
    } catch {
      // JSON.parse 的异常可能包含原始输入片段，包括 Token 或邮箱。
      return failPlan('json_syntax', 'JSON 语法错误：请检查引号、逗号及括号是否完整', 'json')
    }
    return planFromJsonValue(value)
  }
  return planFromLines(t)
}

// ---------- 输入内去重与计数 ----------

function identityKeys(c: NormalizedCredential): string[] {
  const keys = c.refreshToken ? [`rt:${c.refreshToken}`] : []
  if (c.userId) keys.push(`uid:${c.userId}`)
  if (c.email) keys.push(`email:${c.email.toLowerCase()}|${c.provider}`)
  return keys
}

function finalizePlan(plan: ImportPlan): ImportPlan {
  const seen = new Map<string, number>()
  for (const rec of plan.records) {
    if (rec.status !== 'valid' || !rec.credential) continue
    const keys = identityKeys(rec.credential)
    const hit = keys.map(k => seen.get(k)).find(v => v !== undefined)
    if (hit !== undefined) {
      rec.status = 'duplicate'
      rec.duplicateOf = hit
      rec.issues.push({ code: 'duplicate_in_input', message: `与第 ${hit + 1} 条账户记录重复` })
      continue
    }
    for (const k of keys) seen.set(k, rec.index)
  }
  plan.counts = {
    total: plan.records.length,
    valid: plan.records.filter(r => r.status === 'valid').length,
    invalid: plan.records.filter(r => r.status === 'invalid').length,
    duplicate: plan.records.filter(r => r.status === 'duplicate').length
  }
  return plan
}

// ---------- 与现有账户的去重 ----------

export interface ExistingAccountLike {
  id?: string
  email?: string
  userId?: string
  idp?: string
  credentials?: { provider?: string; refreshToken?: string }
}

export interface DuplicateCandidate {
  email?: string
  userId?: string
  provider?: string
  refreshToken?: string
}

/**
 * 查找与候选身份重复的现有账户。规则沿用产品约定并补充 Token 维度：
 * - userId 相同 → 重复
 * - refreshToken 相同 → 重复（避免对同一凭证再次刷新导致已有账户的 Token 轮换失效）
 * - 邮箱（忽略大小写）相同且 provider 相同 → 重复；允许同邮箱不同登录方式
 * 现有账户的 provider 优先取 credentials.provider，缺失时用 idp。
 */
export function findExistingDuplicate<T extends ExistingAccountLike>(
  existing: Iterable<T>,
  candidate: DuplicateCandidate
): T | undefined {
  const candProvider = normalizeProvider(candidate.provider) ?? undefined
  const candEmail = candidate.email?.trim().toLowerCase()
  for (const acc of existing) {
    if (candidate.userId && acc.userId && acc.userId === candidate.userId) return acc
    if (candidate.refreshToken && acc.credentials?.refreshToken && acc.credentials.refreshToken === candidate.refreshToken) return acc
    if (candEmail && acc.email && acc.email.trim().toLowerCase() === candEmail) {
      const accProvider = normalizeProvider(acc.credentials?.provider) ?? normalizeProvider(acc.idp) ?? undefined
      if (accProvider && candProvider && accProvider === candProvider) return acc
    }
  }
  return undefined
}

// ---------- 批量结果 ----------

export interface ImportOutcome {
  total: number
  added: number
  duplicate: number
  invalid: number
  failed: number
  /** 取消后尚未处理的记录 */
  cancelled: number
  errors: Array<{ source: string; message: string }>
}

export function emptyOutcome(total = 0): ImportOutcome {
  return { total, added: 0, duplicate: 0, invalid: 0, failed: 0, cancelled: 0, errors: [] }
}

/** 总数 = 新增 + 重复 + 无效 + 失败 + 取消 */
export function isOutcomeBalanced(o: ImportOutcome): boolean {
  return o.total === o.added + o.duplicate + o.invalid + o.failed + o.cancelled
}

export function formatIssues(rec: ImportRecord): string {
  return rec.issues.map(i => i.message).join('；')
}

/** 把指定记录还原为可再次粘贴的文本（JSON 数组或卡密行），用于失败后保留输入 */
export function serializeRecordsForRetry(plan: ImportPlan, indices: number[]): string {
  const recs = indices.map(i => plan.records[i]).filter((r): r is ImportRecord => Boolean(r))
  if (recs.length === 0) return ''
  if (plan.format === 'lines') return recs.map(r => String(r.raw)).join('\n')
  return JSON.stringify(recs.map(r => r.raw), null, 2)
}
