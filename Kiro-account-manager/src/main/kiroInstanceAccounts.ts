import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type { KiroInstanceRecord } from '../shared/kiroInstances'
import { resolveIdentity } from '../shared/authIdentity'
import { canonicalWindowsPath, equalWindowsPath, instanceFileSystem, KiroInstanceError, makeInstancePaths, verifyInstanceDirectories } from './kiroInstancePaths'

export interface InstanceAccountCredentials {
  accessToken: string
  refreshToken?: string
  provider?: string
  authMethod?: string
  region?: string
  profileArn?: string
  startUrl?: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
  /** Unix seconds from the actual OIDC registration; never invented. */
  clientSecretExpiresAt?: number
}
export interface InstanceBoundAccount {
  id: string
  userId?: string
  idp?: string
  credentials: InstanceAccountCredentials
}
export interface InstanceAccountInput {
  record: KiroInstanceRecord
  account: InstanceBoundAccount
  now?: number
  /** Trusted lifecycle: no launch was requested; replace an unchanged abandoned seed. */
  resetPending?: boolean
  /** Optional trusted host identity lookup. This module never performs network requests. */
  verifyIdentity?: (credentials: InstanceAccountCredentials) => Promise<{ userId: string } | null>
}
export interface InstanceAccountUpdate { credentials: InstanceAccountCredentials }
interface Binding {
  schemaVersion: 1
  instanceId: string
  accountId: string
  provider: string
  authMethod: string
  clientIdHash?: string
  refreshFingerprint: string
  accessFingerprint?: string
  subjectFingerprint?: string
  userIdFingerprint?: string
}
const TOKEN_NAME = 'kiro-auth-token.json'
const BINDING_NAME = '.kiro-account-binding.json'
const BUILDER_PROFILE = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
const SOCIAL_PROFILE = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
const queues = new Map<string, Promise<unknown>>()
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length < 131072 && !/[\x00-\x1f\x7f]/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (message = '实例账户缓存无法安全验证，请检查账户绑定；未改动其他账户。'): never => { throw new KiroInstanceError(message) }
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

function subjectFingerprint(token: string): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[1].length > 65536) return undefined
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return object(value) && nonempty(value.sub) ? fingerprint(value.sub) : undefined
  } catch { return undefined }
}
function registrationHash(startUrl: string): string {
  return createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
}
function selectedIdentity(account: InstanceBoundAccount) {
  const result = resolveIdentity({ provider: account.credentials.provider, authMethod: account.credentials.authMethod, idp: account.idp })
  if (!result.ok) return fail('绑定账户的登录提供商或认证方式无效，请先修复账户资料。')
  return result
}
async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = root.toLowerCase()
  const prior = queues.get(key) || Promise.resolve()
  const task = prior.then(action, action)
  queues.set(key, task)
  try { return await task }
  finally { if (queues.get(key) === task) queues.delete(key) }
}

async function verifiedPaths(input: InstanceAccountInput) {
  const { record, account } = input
  if (!record || record.schemaVersion !== 2 || !nonempty(record.accountId) || record.accountId !== account?.id || !account.credentials) return fail('实例与所选账户不匹配，未写入登录缓存。')
  const root = canonicalWindowsPath(record.paths?.root)
  const portable = equalWindowsPath(record.paths.userData, win32.join(root, 'portable', 'user-data'))
  const expected = makeInstancePaths(win32.dirname(root), record.id, portable)
  if (Object.keys(record.paths).length !== Object.keys(expected).length || Object.entries(expected).some(([name, value]) => !equalWindowsPath((record.paths as unknown as Record<string, string>)[name] || '', value))) return fail()
  await verifyInstanceDirectories(instanceFileSystem, record.paths, record.id)
  return { token: win32.join(record.paths.home, '.aws', 'sso', 'cache', TOKEN_NAME), binding: win32.join(root, BINDING_NAME), cache: win32.join(record.paths.home, '.aws', 'sso', 'cache') }
}

async function checkedFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || !equalWindowsPath(canonicalWindowsPath(await fs.realpath(path)), path)) return fail()
    return true
  } catch (error) { if (absent(error)) return false; throw error }
}
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!await checkedFile(path)) return null
  const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
  if (!object(value)) return fail()
  return value
}
async function atomicJson(input: InstanceAccountInput, path: string, value: unknown): Promise<void> {
  await verifiedPaths(input)
  await checkedFile(path)
  const temporary = win32.join(win32.dirname(path), `.kiro-write-${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    await verifiedPaths(input)
    await checkedFile(path)
    await fs.rename(temporary, path)
    // Windows treats mode as advisory; never claim this is an OS-user security boundary.
    await fs.chmod(path, 0o600).catch(() => {})
  } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}) }
}
function bindingFrom(value: Record<string, unknown>, input: InstanceAccountInput): Binding {
  const identity = selectedIdentity(input.account)
  const allowed = new Set(['schemaVersion', 'instanceId', 'accountId', 'provider', 'authMethod', 'clientIdHash', 'refreshFingerprint', 'accessFingerprint', 'subjectFingerprint', 'userIdFingerprint'])
  if (Object.keys(value).some(key => !allowed.has(key)) || value.schemaVersion !== 1 || value.instanceId !== input.record.id || value.accountId !== input.account.id ||
      value.provider !== identity.provider || value.authMethod !== identity.authMethod || typeof value.refreshFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.refreshFingerprint) ||
      value.accessFingerprint !== undefined && (typeof value.accessFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.accessFingerprint)) ||
      value.subjectFingerprint !== undefined && (typeof value.subjectFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.subjectFingerprint)) ||
      value.userIdFingerprint !== undefined && (typeof value.userIdFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.userIdFingerprint)) ||
      value.clientIdHash !== undefined && (typeof value.clientIdHash !== 'string' || !/^[a-f0-9]{40}$/.test(value.clientIdHash))) return fail()
  return value as unknown as Binding
}
function profileFor(account: InstanceBoundAccount, provider: string): string | undefined {
  const value = account.credentials.profileArn
  if (value !== undefined) {
    if (!/^arn:(?:aws|aws-us-gov|aws-cn):(?:codewhisperer|kiro|q):[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9_-]+$/.test(value) || /^arn:aws:codewhisperer:[a-z0-9-]+:610548660232:profile\/VNECVYCYYAWN$/.test(value)) return fail('账户 profile 无法确认，请先取得有效 profile 后再绑定实例。')
    return value
  }
  if (provider === 'Google' || provider === 'Github') return SOCIAL_PROFILE
  if (provider === 'BuilderId') return BUILDER_PROFILE
  return fail('组织账户缺少已验证的 profile，请先完成账户授权。')
}
function registrationExpiry(value: unknown): number | undefined {
  // Imported historical records can contain ISO dates or milliseconds. Preserve
  // the actual deadline while returning the manager's Unix-second convention.
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const seconds = value >= 1e12 ? value / 1000 : value
  return Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined
}
function registration(account: InstanceBoundAccount, now: number) {
  const { credentials } = account
  const expiresAt = registrationExpiry(credentials.clientSecretExpiresAt)
  if (!nonempty(credentials.clientId) || !nonempty(credentials.clientSecret) || expiresAt === undefined || expiresAt * 1000 <= now + 900000) return fail('OIDC 客户端登记缺失或即将到期，请在绑定前重新授权；不会虚构登记有效期。')
  const startUrl = credentials.startUrl || 'https://view.awsapps.com/start'
  try { const parsed = new URL(startUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return fail() } catch { return fail('OIDC Start URL 无效，请检查账户资料。') }
  return { hash: registrationHash(startUrl), startUrl, expiresAt, data: { clientId: credentials.clientId, clientSecret: credentials.clientSecret, expiresAt: new Date(expiresAt * 1000).toISOString() } }
}

async function readUpdate(input: InstanceAccountInput): Promise<InstanceAccountUpdate | null> {
  const paths = await verifiedPaths(input)
  const [bindingValue, token] = await Promise.all([readJson(paths.binding), readJson(paths.token)])
  if (!bindingValue && !token) return null
  if (!bindingValue || !token) return fail('实例已有未绑定缓存或登录缓存已移除，请先核对实例账户后重新绑定。')
  const binding = bindingFrom(bindingValue, input)
  const identity = resolveIdentity({ provider: token.provider, authMethod: token.authMethod })
  if (!identity.ok || identity.provider !== binding.provider || identity.authMethod !== binding.authMethod || !nonempty(token.accessToken) || !nonempty(token.refreshToken) || typeof token.expiresAt !== 'string') return fail('实例账户身份或凭证格式已变化，未同步到管理器。')
  const expiresAt = Date.parse(token.expiresAt)
  if (!Number.isFinite(expiresAt)) return fail()
  const tokenSubject = subjectFingerprint(token.accessToken)
  const tokenRefresh = fingerprint(token.refreshToken)
  const managerSubject = subjectFingerprint(input.account.credentials.accessToken)
  const managerRefresh = nonempty(input.account.credentials.refreshToken) ? fingerprint(input.account.credentials.refreshToken) : undefined
  const accountUserId = nonempty(input.account.userId) ? fingerprint(input.account.userId) : undefined
  if (binding.userIdFingerprint && binding.userIdFingerprint !== accountUserId) return fail('管理器账户身份已变化，请先核对绑定。')
  if (binding.subjectFingerprint && tokenSubject && binding.subjectFingerprint !== tokenSubject) return fail('实例已登录不同账户，未覆盖原绑定账户；请重新绑定。')
  if (managerSubject && binding.subjectFingerprint && managerSubject !== binding.subjectFingerprint) return fail('管理器账户身份已变化，请先核对绑定。')
  const needsIdentityProof = tokenRefresh !== binding.refreshFingerprint && (!binding.subjectFingerprint || !tokenSubject || tokenSubject !== binding.subjectFingerprint) ||
    managerRefresh && managerRefresh !== binding.refreshFingerprint && managerRefresh !== tokenRefresh && (!binding.subjectFingerprint || managerSubject !== binding.subjectFingerprint)
  const result: InstanceAccountCredentials = {
    ...input.account.credentials, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt,
    provider: identity.provider, authMethod: identity.authMethod,
    profileArn: nonempty(token.profileArn) ? profileFor({ ...input.account, credentials: { ...input.account.credentials, profileArn: token.profileArn } }, identity.provider) : profileFor(input.account, identity.provider)
  }
  if (identity.authMethod === 'IdC') {
    const reg = registration(input.account, input.now ?? Date.now())
    if (token.clientIdHash !== reg.hash || binding.clientIdHash !== reg.hash) return fail()
    const stored = await readJson(win32.join(paths.cache, `${reg.hash}.json`))
    if (!stored || stored.clientId !== input.account.credentials.clientId || stored.clientSecret !== input.account.credentials.clientSecret || stored.expiresAt !== reg.data.expiresAt) return fail('实例客户端登记已变化，未同步凭证。')
    if (!nonempty(token.region) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(token.region)) return fail()
    result.region = token.region
    result.startUrl = reg.startUrl
    result.clientSecretExpiresAt = reg.expiresAt
  }
  if (needsIdentityProof) {
    if (!accountUserId || !input.verifyIdentity) return fail('实例刷新凭证已变化且身份无法确认，请先验证并重新绑定；未覆盖管理器账户。')
    // Only the host can supply authenticated identity evidence. Provider/profile
    // equality and the instance's own files cannot establish account ownership.
    let verified: { userId: string } | null
    try { verified = await input.verifyIdentity({ ...result }) }
    catch { return fail('实例身份验证暂时失败，请重试同步；未覆盖管理器账户。') }
    if (!verified || !nonempty(verified.userId) || fingerprint(verified.userId) !== accountUserId) return fail('实例身份验证未通过，未覆盖原绑定账户；请核对账户后重试。')
    if (JSON.stringify(await readJson(paths.token)) !== JSON.stringify(token)) return fail('实例凭证在验证期间发生变化，请重试同步。')
  }
  // Advance only identity-proven rotations. Metadata contains hashes, not extra raw credentials.
  if (binding.refreshFingerprint !== tokenRefresh || !binding.subjectFingerprint && tokenSubject || !binding.userIdFingerprint && accountUserId) {
    await atomicJson(input, paths.binding, { ...binding, refreshFingerprint: tokenRefresh, ...(tokenSubject ? { subjectFingerprint: tokenSubject } : {}), ...(accountUserId ? { userIdFingerprint: accountUserId } : {}) })
  }
  return { credentials: result }
}

/** Read only the selected instance. This function never reads the default user cache or refreshes. */
export async function readKiroInstanceAccountUpdate(input: InstanceAccountInput): Promise<InstanceAccountUpdate | null> {
  try { return await locked(input.record.paths.root, () => readUpdate(input)) }
  catch (error) { if (error instanceof KiroInstanceError) throw error; return fail() }
}

/** Seed/retain a bound account; only its official client may refresh expired access tokens. */
export async function prepareKiroInstanceAccount(input: InstanceAccountInput): Promise<InstanceAccountUpdate & { source: 'manager' | 'instance' }> {
  try {
    return await locked(input.record.paths.root, async () => {
      const paths = await verifiedPaths(input)
      const now = input.now ?? Date.now()
      if (input.resetPending) {
        const [bindingValue, token] = await Promise.all([readJson(paths.binding), readJson(paths.token)])
        if (token) {
          if (!bindingValue) return fail('实例存在未绑定缓存，未覆盖；请核对实例资料后重新创建。')
          const binding = bindingFrom(bindingValue, input)
          // A failed first launch may leave a seed behind while the manager is
          // free to refresh. Reseed only that exact copy, never a client rotation.
          if (!nonempty(token.accessToken) || !nonempty(token.refreshToken) || !binding.accessFingerprint ||
              fingerprint(token.accessToken) !== binding.accessFingerprint || fingerprint(token.refreshToken) !== binding.refreshFingerprint) {
            return fail('实例缓存已变化，未覆盖；请核对实例账户后重新创建。')
          }
        } else if (bindingValue) bindingFrom(bindingValue, input)
      }
      const previous = input.resetPending ? null : await readUpdate(input)
      if (previous) return { ...previous, source: 'instance' }
      const identity = selectedIdentity(input.account)
      const credentials = input.account.credentials
      if (!nonempty(credentials.accessToken) || !nonempty(credentials.refreshToken) || !Number.isFinite(credentials.expiresAt) || !Number.isFinite(new Date(credentials.expiresAt).getTime())) return fail('所选账户凭证不完整或到期时间无效，请先修复账户资料。')
      const profileArn = profileFor(input.account, identity.provider)
      const token: Record<string, unknown> = { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken,
        expiresAt: new Date(credentials.expiresAt).toISOString(), authMethod: identity.authMethod, provider: identity.provider, profileArn }
      const binding: Binding = { schemaVersion: 1, instanceId: input.record.id, accountId: input.account.id, provider: identity.provider,
        authMethod: identity.authMethod, refreshFingerprint: fingerprint(credentials.refreshToken), accessFingerprint: fingerprint(credentials.accessToken),
        ...(subjectFingerprint(credentials.accessToken) ? { subjectFingerprint: subjectFingerprint(credentials.accessToken) } : {}),
        ...(nonempty(input.account.userId) ? { userIdFingerprint: fingerprint(input.account.userId) } : {}) }
      let startUrl = credentials.startUrl
      let clientSecretExpiresAt = credentials.clientSecretExpiresAt
      if (identity.authMethod === 'IdC') {
        const reg = registration(input.account, now)
        const region = credentials.region || 'us-east-1'
        if (!/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(region)) return fail('账户区域无效，请检查账户资料。')
        token.clientIdHash = reg.hash; token.region = region; binding.clientIdHash = reg.hash; startUrl = reg.startUrl; clientSecretExpiresAt = reg.expiresAt
        await atomicJson(input, win32.join(paths.cache, `${reg.hash}.json`), reg.data)
      }
      await atomicJson(input, paths.binding, binding)
      await atomicJson(input, paths.token, token)
      return { source: 'manager', credentials: { ...credentials, provider: identity.provider, authMethod: identity.authMethod, profileArn, ...(startUrl ? { startUrl } : {}), ...(clientSecretExpiresAt !== undefined ? { clientSecretExpiresAt } : {}) } }
    })
  } catch (error) { if (error instanceof KiroInstanceError) throw error; return fail() }
}
