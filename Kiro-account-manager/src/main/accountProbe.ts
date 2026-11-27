import type { AuthRefreshResult } from './authRefresh'
import { ControlPlaneError } from './kiroControlPlane'

export interface AccountProbeFailure {
  status?: 'error' | 'expired'
  message: string
}

const suspended: AccountProbeFailure = { status: 'error', message: '账户已封禁（AccountSuspendedException）' }
const expired: AccountProbeFailure = { status: 'expired', message: '访问令牌无效或已过期，请刷新' }

/** The legacy CBOR transport prefixes its HTTP status and service exception. */
export function accountProbeFailure(error: unknown): AccountProbeFailure {
  if (error instanceof ControlPlaneError) {
    if (error.status === 423 || error.serviceCode === 'AccountSuspendedException') return suspended
    if (error.status === 401 || error.reason === 'token') return expired
    return { message: error.message }
  }
  const message = error instanceof Error ? error.message : ''
  const http = /^HTTP (\d{3})(?::|$)/.exec(message)
  if (http?.[1] === '423' || /^HTTP \d{3}: AccountSuspendedException(?::|$)/.test(message)) return suspended
  if (http?.[1] === '401') return expired
  return { message: http ? `账户服务查询失败（HTTP ${http[1]}）` : '账户服务查询未完成，请稍后重试' }
}

/** User info is optional. A suspended account takes priority over a usage error. */
export function userInfoFailure(status?: string): AccountProbeFailure | undefined {
  if (!status || status === 'Active' || status === 'Stale') return undefined
  if (/^(?:Suspended|Temporarily_Suspended)$/i.test(status)) return suspended
  return { status: 'error', message: '账户服务报告用户状态异常' }
}

export function preserveRefreshStatus(result: AuthRefreshResult): boolean {
  return result.preserveStatus === true || result.failureKind !== 'reauth-required'
}
