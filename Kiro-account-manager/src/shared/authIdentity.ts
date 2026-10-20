// ============================================
// 认证身份标准化（main 与 renderer 共用的纯函数）
//
// 目的：provider / authMethod / idp 的别名、大小写、推导与冲突规则只在此处定义一次，
// 避免 renderer 选择一条刷新链路、main 又按另一条链路存储身份（见 docs/2026-10-19-account-import-login F-02）。
// 本模块不发起任何网络请求，不改变上游请求格式，只决定使用已有的哪条刷新链路。
// ============================================

export type CanonicalProvider = 'BuilderId' | 'Enterprise' | 'IAM_SSO' | 'Github' | 'Google'
export type CanonicalAuthMethod = 'IdC' | 'social'

export const CANONICAL_PROVIDERS: readonly CanonicalProvider[] = [
  'BuilderId',
  'Enterprise',
  'IAM_SSO',
  'Github',
  'Google'
]

// 别名表：key 为去掉空白/下划线/连字符并转小写后的形式
const PROVIDER_ALIASES: Record<string, CanonicalProvider> = {
  builderid: 'BuilderId',
  awsbuilderid: 'BuilderId',
  enterprise: 'Enterprise',
  awsidc: 'Enterprise',
  internal: 'Enterprise',
  iamsso: 'IAM_SSO',
  github: 'Github',
  google: 'Google'
}

const AUTH_METHOD_ALIASES: Record<string, CanonicalAuthMethod> = {
  idc: 'IdC',
  oidc: 'IdC',
  social: 'social'
}

function aliasKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

/**
 * 标准化 provider。
 * - 缺失（undefined / null / 空白字符串）返回 undefined
 * - 无法识别或类型错误返回 null
 */
export function normalizeProvider(raw: unknown): CanonicalProvider | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return null
  if (!raw.trim()) return undefined
  const key = aliasKey(raw)
  return Object.hasOwn(PROVIDER_ALIASES, key) ? PROVIDER_ALIASES[key] : null
}

/**
 * 标准化 authMethod。缺失返回 undefined，无法识别或类型错误返回 null。
 */
export function normalizeAuthMethod(raw: unknown): CanonicalAuthMethod | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return null
  if (!raw.trim()) return undefined
  const key = aliasKey(raw)
  return Object.hasOwn(AUTH_METHOD_ALIASES, key) ? AUTH_METHOD_ALIASES[key] : null
}

/** provider 对应的认证方式：Github/Google 为 social，其余为 IdC */
export function authMethodForProvider(provider: CanonicalProvider): CanonicalAuthMethod {
  return provider === 'Github' || provider === 'Google' ? 'social' : 'IdC'
}

export type IdentityErrorCode =
  | 'unsupported_provider'
  | 'unsupported_idp'
  | 'unsupported_auth_method'
  | 'missing_provider'
  | 'provider_auth_method_conflict'

export interface IdentityInput {
  provider?: unknown
  authMethod?: unknown
  /** 账户顶层 idp，仅在 provider 缺失时作为身份来源 */
  idp?: unknown
  /** 是否同时具备 clientId 与 clientSecret（仅在身份完全缺失时用于推导） */
  hasClientCredentials?: boolean
}

export type IdentityResult =
  | {
      ok: true
      provider: CanonicalProvider
      authMethod: CanonicalAuthMethod
      /** 身份是否由规则推导而非显式给出 */
      inferred: boolean
      warnings: string[]
    }
  | {
      ok: false
      code: IdentityErrorCode
      message: string
    }

/**
 * 解析认证身份。规则（与修复方案 §2.2 对齐）：
 * 1. 显式 provider 优先；无法识别时报错，不回退为 BuilderId/Social。
 * 2. provider 缺失时读取 idp；idp 无法识别同样报错。
 * 3. 显式 authMethod 只接受白名单；与 provider 不一致时报冲突，不悄悄选择其中一个。
 * 4. 仅身份完全缺失时推导：
 *    - authMethod=IdC 或具备 clientId+clientSecret → BuilderId / IdC（企业账号需显式指定 provider）
 *    - 其余情况要求显式填写 provider，不能从缺失身份猜测 Google / Github
 *    推导结果附带 warning，供界面展示。
 */
export function resolveIdentity(input: IdentityInput): IdentityResult {
  const warnings: string[] = []

  let provider = normalizeProvider(input.provider)
  if (provider === null) {
    return {
      ok: false,
      code: 'unsupported_provider',
      message: '不支持的 provider，可选值：BuilderId / Enterprise / IAM_SSO / Github / Google'
    }
  }

  let providerFromIdp = false
  if (provider === undefined) {
    const fromIdp = normalizeProvider(input.idp)
    if (fromIdp === null) {
      return {
        ok: false,
        code: 'unsupported_idp',
        message: '不支持的 idp，可选值：BuilderId / Enterprise / IAM_SSO / Github / Google'
      }
    }
    if (fromIdp !== undefined) {
      provider = fromIdp
      providerFromIdp = true
    }
  }

  const authMethod = normalizeAuthMethod(input.authMethod)
  if (authMethod === null) {
    return {
      ok: false,
      code: 'unsupported_auth_method',
      message: '不支持的 authMethod，可选值：IdC / social'
    }
  }

  if (provider !== undefined) {
    const expected = authMethodForProvider(provider)
    if (authMethod !== undefined && authMethod !== expected) {
      return {
        ok: false,
        code: 'provider_auth_method_conflict',
        message: `provider ${provider} 需要 authMethod=${expected}，但记录为 ${authMethod}`
      }
    }
    return { ok: true, provider, authMethod: expected, inferred: providerFromIdp && authMethod === undefined, warnings }
  }

  // provider 与 idp 都缺失
  if (authMethod === 'IdC') {
    warnings.push('未指定 provider，按 Builder ID 处理；企业账号请显式填写 provider=Enterprise')
    return { ok: true, provider: 'BuilderId', authMethod: 'IdC', inferred: true, warnings }
  }
  if (authMethod === 'social') {
    return { ok: false, code: 'missing_provider', message: 'Social 凭证缺少 provider，请明确填写 Google 或 Github' }
  }
  if (input.hasClientCredentials) {
    warnings.push('未指定 provider/authMethod，根据 clientId/clientSecret 按 Builder ID (IdC) 处理')
    return { ok: true, provider: 'BuilderId', authMethod: 'IdC', inferred: true, warnings }
  }
  return { ok: false, code: 'missing_provider', message: '缺少可识别的 provider 或完整 OIDC clientId/clientSecret，无法判断认证方式' }
}
