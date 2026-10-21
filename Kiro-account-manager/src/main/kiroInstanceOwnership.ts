import { createHash } from 'node:crypto'

export const INSTANCE_ACCOUNT_REAUTH_REQUIRED = '实例凭证未核验，已保留实例资料；使用此账户前请重新授权'

export interface InstanceOwnershipInput {
  accountId?: string
  refreshToken?: string
  accessToken?: string
}
export interface InstanceOwnershipSources {
  records(): unknown
  /** Account collection, keyed by account ID; no filesystem or token refresh is performed here. */
  accounts(): unknown
}

export class InstanceOwnershipError extends Error {
  readonly code: 'instance-owned' | 'invalid-ownership-state' | 'account-operation-in-flight' | 'reauthorization-required'
  constructor(code: 'instance-owned' | 'invalid-ownership-state' | 'account-operation-in-flight' | 'reauthorization-required') {
    super(code === 'instance-owned'
      ? '该账户已由独立 Kiro 实例管理，请先停止实例并同步凭证、移除绑定后再执行刷新或切号。'
      : code === 'account-operation-in-flight'
        ? '该账户还有刷新或切号操作正在完成，请稍后再绑定实例。'
      : code === 'reauthorization-required'
        ? INSTANCE_ACCOUNT_REAUTH_REQUIRED
      : '无法确认实例账户的刷新归属，已阻止操作；请检查实例配置和账户资料。')
    this.name = 'InstanceOwnershipError'
    this.code = code
  }
}

interface Binding { instanceId: string; accountId: string }
interface BoundSnapshot { bindings: Binding[]; hashes: Map<string, Set<string>>; accounts: Map<string, unknown> }
interface AccountOperation { accountId?: string; hashes: Set<string> }
const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const invalid = (): never => { throw new InstanceOwnershipError('invalid-ownership-state') }
const owned = (): never => { throw new InstanceOwnershipError('instance-owned') }
const digest = (value: string): string => createHash('sha256').update(value.trim()).digest('hex')

function optionalToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return invalid()
  return value.trim() || undefined
}
function accountHashes(value: unknown, accountId: string): string[] {
  if (!plain(value) || value.id !== undefined && value.id !== accountId || !plain(value.credentials)) return invalid()
  const refreshToken = optionalToken(value.credentials.refreshToken)
  const accessToken = optionalToken(value.credentials.accessToken)
  return [...new Set([refreshToken, accessToken].filter((token): token is string => token !== undefined).map(digest))]
}
function freshCredentialPair(proposed: unknown, authoritative: unknown): boolean {
  if (!plain(proposed) || !plain(authoritative)) return false
  const refreshToken = optionalToken(proposed.refreshToken)
  const accessToken = optionalToken(proposed.accessToken)
  const oldTokens = [optionalToken(authoritative.refreshToken), optionalToken(authoritative.accessToken)]
  return !!refreshToken && !!accessToken && !oldTokens.includes(refreshToken) && !oldTokens.includes(accessToken)
}
function accountMap(value: unknown): Map<string, unknown> {
  if (value instanceof Map) {
    if ([...value.keys()].some(key => typeof key !== 'string' || !ID.test(key))) return invalid()
    return new Map(value)
  }
  if (!plain(value)) return invalid()
  const entries = Object.entries(value)
  if (entries.some(([key]) => !ID.test(key))) return invalid()
  return new Map(entries)
}
function inputHashes(input: InstanceOwnershipInput): string[] {
  if (!plain(input) || input.accountId !== undefined && (typeof input.accountId !== 'string' || !ID.test(input.accountId))) return invalid()
  return [optionalToken(input.refreshToken), optionalToken(input.accessToken)]
    .filter((token): token is string => token !== undefined).map(digest)
}

function decodeBindings(value: unknown): Binding[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) return invalid()
  const bindings: Binding[] = []
  const instances = new Set<string>()
  const boundIds = new Set<string>()
  for (const row of value) {
    if (!plain(row) || typeof row.id !== 'string' || !ID.test(row.id) || instances.has(row.id)) return invalid()
    instances.add(row.id)
    // Historical RC records carry no account binding and cannot own a manager account.
    if (row.schemaVersion === undefined || row.schemaVersion === 1) {
      if (row.accountId !== undefined) return invalid()
      continue
    }
    if (row.schemaVersion !== 2) return invalid()
    if (row.accountBindingState !== undefined && row.accountBindingState !== 'pending' && row.accountBindingState !== 'active') return invalid()
    if (row.accountId === undefined) {
      if (row.accountBindingState !== undefined) return invalid()
      continue
    }
    if (typeof row.accountId !== 'string' || !ID.test(row.accountId) || boundIds.has(row.accountId)) return invalid()
    boundIds.add(row.accountId)
    // Selecting an account for an unlaunched profile does not transfer its session.
    // Historical records have no phase; retain their ownership conservatively.
    if (row.accountBindingState !== 'pending') bindings.push({ instanceId: row.id, accountId: row.accountId })
  }
  return bindings
}

/**
 * Renderer saves may arrive after an instance has rotated its credentials in the main
 * process. Keep the main process copy authoritative while a persisted binding exists.
 */
export function mergeInstanceOwnedAccounts<T>(incoming: T, current: unknown, records: unknown): T {
  try {
    const bindings = decodeBindings(records)
    const recoveryAccounts = plain(current) && plain(current.accounts)
      ? Object.entries(current.accounts).filter(([, account]) => plain(account) && account.lastError === INSTANCE_ACCOUNT_REAUTH_REQUIRED)
      : []
    if (!bindings.length && !recoveryAccounts.length) return incoming
    if (!plain(incoming) || !plain(current) || !plain(incoming.accounts) || !plain(current.accounts)) return invalid()
    const accounts: Record<string, unknown> = { ...incoming.accounts }
    for (const { accountId } of bindings) {
      const authoritative = current.accounts[accountId]
      const proposed = incoming.accounts[accountId]
      if (!plain(authoritative) || !plain(authoritative.credentials)) return invalid()
      // Removing or replacing a bound identity would detach its running refresh owner.
      if (!plain(proposed)) return owned()
      for (const name of ['id', 'idp', 'userId', 'provider', 'authMethod']) {
        if (proposed[name] !== authoritative[name]) return owned()
      }
      accounts[accountId] = {
        ...proposed,
        credentials: { ...authoritative.credentials },
        ...(Object.hasOwn(authoritative, 'profileArn') ? { profileArn: authoritative.profileArn } : {})
      }
      if (!Object.hasOwn(authoritative, 'profileArn') && Object.hasOwn(proposed, 'profileArn')) {
        delete (accounts[accountId] as Record<string, unknown>).profileArn
      }
    }
    for (const [accountId, authoritative] of recoveryAccounts) {
      if (!plain(authoritative) || !plain(authoritative.credentials)) return invalid()
      const proposed = accounts[accountId]
      if (!plain(proposed)) throw new InstanceOwnershipError('reauthorization-required')
      if (!freshCredentialPair(proposed.credentials, authoritative.credentials)) {
        accounts[accountId] = { ...proposed, lastError: authoritative.lastError, status: authoritative.status }
      }
    }
    return { ...incoming, accounts } as T
  } catch (error) {
    if (error instanceof InstanceOwnershipError) throw error
    return invalid()
  }
}

/**
 * A persisted instance binding owns refreshes even while its IDE is stopped. Guard every
 * manager refresh/switch entry point, including credential-only verification/import paths.
 * Seen token hashes remain aliases until that account is unbound; no secrets are retained
 * in the alias map, exposed in errors or sent to a logger.
 */
export class InstanceAccountOwnership {
  private readonly sources: InstanceOwnershipSources
  private readonly aliases = new Map<string, Set<string>>()
  private readonly operations = new Map<symbol, AccountOperation>()
  constructor(sources: InstanceOwnershipSources) { this.sources = sources }

  private snapshot(): BoundSnapshot {
    try {
      const value = this.sources.records()
      const bindings = decodeBindings(value)
      const boundIds = new Set(bindings.map(binding => binding.accountId))
      for (const accountId of this.aliases.keys()) if (!boundIds.has(accountId)) this.aliases.delete(accountId)
      if (!bindings.length) return { bindings, hashes: new Map(), accounts: new Map() }
      const accounts = accountMap(this.sources.accounts())
      const hashes = new Map<string, Set<string>>()
      for (const binding of bindings) {
        const current = accountHashes(accounts.get(binding.accountId), binding.accountId)
        const aliases = this.aliases.get(binding.accountId) ?? new Set<string>()
        for (const hash of current) aliases.add(hash)
        this.aliases.set(binding.accountId, aliases)
        hashes.set(binding.accountId, new Set(aliases))
      }
      return { bindings, hashes, accounts }
    } catch { return invalid() }
  }

  isBound(input: InstanceOwnershipInput): boolean {
    const tokens = inputHashes(input)
    const snapshot = this.snapshot()
    if (input.accountId && snapshot.bindings.some(row => row.accountId === input.accountId)) return true
    return snapshot.bindings.some(row => tokens.some(token => snapshot.hashes.get(row.accountId)?.has(token)))
  }

  assertAvailable(input: InstanceOwnershipInput): void {
    if (this.isBound(input)) owned()
    const tokens = inputHashes(input)
    let accounts: Map<string, unknown>
    try { accounts = accountMap(this.sources.accounts() ?? {}) } catch { return invalid() }
    for (const [id, account] of accounts) {
      if (!plain(account) || account.lastError !== INSTANCE_ACCOUNT_REAUTH_REQUIRED) continue
      const oldTokens = accountHashes(account, id)
      if (tokens.some(token => oldTokens.includes(token)) ||
          input.accountId === id && !freshCredentialPair(input, account.credentials)) {
        throw new InstanceOwnershipError('reauthorization-required')
      }
    }
  }

  /** Hold until the complete operation, including credential and IDE cache writes, settles. */
  beginOperation(input: InstanceOwnershipInput): () => void {
    this.assertAvailable(input)
    const operation = Symbol('account-operation')
    this.operations.set(operation, { accountId: input.accountId, hashes: new Set(inputHashes(input)) })
    return () => { this.operations.delete(operation) }
  }

  /** Call before adding a binding; the caller must serialize the check with its config write. */
  assertCanBind(accountId: string, excludingInstanceId?: string): void {
    if (typeof accountId !== 'string' || !ID.test(accountId) ||
        excludingInstanceId !== undefined && (typeof excludingInstanceId !== 'string' || !ID.test(excludingInstanceId))) return invalid()
    const snapshot = this.snapshot()
    let accounts = snapshot.accounts
    if (!accounts.size) {
      try { accounts = accountMap(this.sources.accounts()) } catch { return invalid() }
    }
    const candidateHashes = accountHashes(accounts.get(accountId), accountId)
    const candidateAliases = this.aliases.get(accountId)
    if (candidateAliases) candidateHashes.push(...candidateAliases)
    const alreadyOwns = snapshot.bindings.some(binding => binding.instanceId === excludingInstanceId && binding.accountId === accountId)
    if (!alreadyOwns) {
      const candidate = accounts.get(accountId)
      if (plain(candidate) && candidate.lastError === INSTANCE_ACCOUNT_REAUTH_REQUIRED) {
        throw new InstanceOwnershipError('reauthorization-required')
      }
      for (const operation of this.operations.values()) {
        if (operation.accountId === accountId || candidateHashes.some(hash => operation.hashes.has(hash))) {
          throw new InstanceOwnershipError('account-operation-in-flight')
        }
      }
    }
    for (const binding of snapshot.bindings) {
      if (binding.instanceId === excludingInstanceId) continue
      if (binding.accountId === accountId || candidateHashes.some(hash => snapshot.hashes.get(binding.accountId)?.has(hash))) owned()
    }
  }
}
