import { createHash, randomUUID } from 'node:crypto'

/** The projection boundary deliberately has no refresh-token or refresh dependency. */
export interface AccessCredential {
  accessToken: string
  /** Unix milliseconds, matching the manager's stored credential expiry. */
  expiresAt: number
  provider: string
  authMethod?: string
  profileArn?: string
  region?: string
  startUrl?: string
}

/** Stable upstream subject belongs to the manager boundary, never to client token payloads. */
export interface ManagerAccessSnapshot extends AccessCredential {
  principalId: string
  /** Local metadata diagnosis only; never included in a client credential payload. */
  validationIssue?: ClientAccessValidationIssue
  /** A transient manager query/transport failure pauses projection without revoking it. */
  temporarilyUnavailable?: boolean
}

export type ClientAccessValidationIssue =
  | 'provider-unsupported' | 'auth-method-mismatch' | 'metadata-conflict'
  | 'profile-missing' | 'profile-invalid' | 'region-missing' | 'region-invalid'
  | 'start-url-missing' | 'start-url-invalid'

const validationIssues = new Set<ClientAccessValidationIssue>([
  'provider-unsupported', 'auth-method-mismatch', 'metadata-conflict',
  'profile-missing', 'profile-invalid', 'region-missing', 'region-invalid',
  'start-url-missing', 'start-url-invalid'
])

export interface ClientAccessProjectionBinding {
  revision: string
  accountId: string
  runtimeId: string
  authDomainId: string
  targetRevision: string
  credentialFingerprint: string
  /** Missing on legacy bindings: automatic projection pauses until an explicit idle rebind. */
  principalFingerprint?: string
  status: 'active' | 'needs-attention'
  updatedAt: number
  reason?: ClientAccessProjectionReason
}

export type ClientAccessProjectionReason =
  | 'invalid-request' | 'invalid-binding' | 'runtime-unavailable' | 'domain-mismatch'
  | 'account-unavailable' | 'credential-unusable' | 'credential-changed'
  | 'principal-unavailable' | 'principal-changed'
  | 'target-changed' | 'binding-changed' | 'target-read-failed' | 'target-write-failed'
  | 'target-write-uncertain'
  | 'binding-save-failed' | 'busy' | 'closed'
  | 'user-disconnected'

export interface ClientAccessProjectionResult {
  status: 'projected' | 'unchanged' | 'needs-attention' | 'failed' | 'busy' | 'closed'
  accountId: string
  runtimeId: string
  authDomainId: string
  /** A failed metadata save must not conceal that the target already changed. */
  targetCommitted: boolean
  reason?: ClientAccessProjectionReason
  validationIssue?: ClientAccessValidationIssue
  targetWriteUncertain?: boolean
  targetConfigurationChanged?: boolean
}

export interface ClientAccessProjectionRequest {
  accountId: string
  runtimeId: string
  authDomainId: string
  expectedPrincipalFingerprint?: string
}

export interface ClientAccessProjectionAdapter {
  /** Authoritative domain identity, resolved in the main process, not by the renderer. */
  readonly authDomainId: string
  validate?(access: Readonly<AccessCredential>): void
  readRevision(): Promise<string>
  /**
   * Compare expectedRevision and call assertCurrent immediately before committing.
   * There must be no asynchronous gap between the guard and the atomic commit.
   * Do not mutate the target when either check fails; return the committed revision.
   */
  write(access: Readonly<AccessCredential>, expectedRevision: string, assertCurrent: () => void,
    context: Readonly<{ accountId: string; runtimeId: string; explicit: boolean; sameAccount?: boolean; principalFingerprint: string }>): Promise<string>
}

export interface ClientAccessProjectionDependencies {
  account(id: string): ManagerAccessSnapshot | undefined
  adapter(runtimeId: string): ClientAccessProjectionAdapter | undefined
  readBindings(): readonly ClientAccessProjectionBinding[]
  /** Atomic metadata-only CAS. undefined means the domain must have no binding. */
  writeBinding(binding: ClientAccessProjectionBinding, expectedRevision: string | undefined): boolean
  now?: () => number
  minValidityMs?: number
}

/** Adapters may use this class to report their own failed target CAS. */
export class ClientAccessProjectionError extends Error {
  readonly code: ClientAccessProjectionReason
  readonly validationIssue?: ClientAccessValidationIssue
  constructor(code: ClientAccessProjectionReason, validationIssue?: ClientAccessValidationIssue) {
    super(code)
    this.name = 'ClientAccessProjectionError'
    this.code = code
    if (code === 'credential-unusable' && validationIssue && validationIssues.has(validationIssue)) this.validationIssue = validationIssue
  }
}

const nonempty = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
const validFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const requestValid = (value: ClientAccessProjectionRequest): boolean => !!value &&
  nonempty(value.accountId, 512) && nonempty(value.runtimeId, 512) && nonempty(value.authDomainId, 512) &&
  (value.expectedPrincipalFingerprint === undefined || validFingerprint(value.expectedPrincipalFingerprint))
const bindingValid = (value: ClientAccessProjectionBinding): boolean => requestValid(value) &&
  nonempty(value.revision, 512) && nonempty(value.targetRevision, 8192) &&
  typeof value.credentialFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.credentialFingerprint) &&
  (value.status === 'active' || value.status === 'needs-attention') && Number.isFinite(value.updatedAt)

/** Whitelist fields: even an accidental richer account object cannot leak refresh secrets. */
function copyAccess(value: (AccessCredential & { validationIssue?: ClientAccessValidationIssue }) | undefined): AccessCredential | undefined {
  if (!value) return undefined
  if (value.validationIssue !== undefined) throw new ClientAccessProjectionError('credential-unusable', value.validationIssue)
  if (!nonempty(value.accessToken, 512 * 1024) || !Number.isFinite(value.expiresAt)) {
    throw new ClientAccessProjectionError('credential-unusable')
  }
  if (!nonempty(value.provider, 128)) throw new ClientAccessProjectionError('credential-unusable', 'provider-unsupported')
  if (value.authMethod !== undefined && !nonempty(value.authMethod, 128)) throw new ClientAccessProjectionError('credential-unusable', 'auth-method-mismatch')
  if (value.profileArn !== undefined && !nonempty(value.profileArn, 4096)) throw new ClientAccessProjectionError('credential-unusable', 'profile-invalid')
  if (value.region !== undefined && (typeof value.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(value.region))) {
    throw new ClientAccessProjectionError('credential-unusable', 'region-invalid')
  }
  if (value.startUrl !== undefined && !nonempty(value.startUrl, 2048)) throw new ClientAccessProjectionError('credential-unusable', 'start-url-invalid')
  return {
    accessToken: value.accessToken, expiresAt: value.expiresAt, provider: value.provider,
    ...(value.authMethod === undefined ? {} : { authMethod: value.authMethod }),
    ...(value.profileArn === undefined ? {} : { profileArn: value.profileArn }),
    ...(value.region === undefined ? {} : { region: value.region }),
    ...(value.startUrl === undefined ? {} : { startUrl: value.startUrl })
  }
}

/** Shared whitelist for read-only capability validation and actual projection. */
export const projectableClientAccess = copyAccess

/** Common provider requirements; target-specific storage requirements stay in each adapter. */
export function validateClientAccessIdentity(access: Readonly<AccessCredential>): void {
  if (!['Google', 'Github', 'BuilderId', 'Enterprise'].includes(access.provider)) {
    throw new ClientAccessProjectionError('credential-unusable', 'provider-unsupported')
  }
  const social = access.provider === 'Google' || access.provider === 'Github'
  if (access.authMethod !== undefined && access.authMethod !== (social ? 'social' : 'IdC')) {
    throw new ClientAccessProjectionError('credential-unusable', 'auth-method-mismatch')
  }
  if (access.provider !== 'BuilderId' && (access.profileArn === undefined || typeof access.profileArn === 'string' && !access.profileArn.trim())) {
    throw new ClientAccessProjectionError('credential-unusable', 'profile-missing')
  }
}

/** Deliberately independent of mutable manager record IDs and rotating refresh/access tokens. */
export function accessPrincipalFingerprint(value: Pick<ManagerAccessSnapshot, 'principalId' | 'provider' | 'profileArn' | 'validationIssue'> | undefined): string | undefined {
  if (!value || value.validationIssue !== undefined || !nonempty(value.principalId, 4096) || !nonempty(value.provider, 128) || /[\r\n]/.test(value.principalId)) return undefined
  return createHash('sha256').update(JSON.stringify(['kiro-principal-v1', value.provider, value.principalId,
    ...(value.provider === 'Enterprise' ? [value.profileArn ?? null] : [])])).digest('hex')
}

function fingerprint(value: AccessCredential, principal: string): string {
  return createHash('sha256').update(JSON.stringify([
    principal, value.accessToken, value.expiresAt, value.provider, value.authMethod ?? null, value.profileArn ?? null, value.region ?? null, value.startUrl ?? null
  ])).digest('hex')
}

/** Access-only projection. It never owns, rotates, or changes manager credentials. */
export class ClientAccessProjectionService {
  private readonly deps: ClientAccessProjectionDependencies
  private readonly now: () => number
  private readonly minValidityMs: number
  private readonly operations = new Map<string, { key: string; promise: Promise<ClientAccessProjectionResult> }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(deps: ClientAccessProjectionDependencies) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.minValidityMs = deps.minValidityMs ?? 180_000
    if (!Number.isFinite(this.minValidityMs) || this.minValidityMs < 0) throw new Error('Invalid projection validity window')
  }

  private result(request: ClientAccessProjectionRequest, status: ClientAccessProjectionResult['status'],
    reason?: ClientAccessProjectionReason, targetCommitted = false): ClientAccessProjectionResult {
    return { accountId: request.accountId, runtimeId: request.runtimeId, authDomainId: request.authDomainId,
      status, targetCommitted, ...(reason ? { reason } : {}) }
  }

  private binding(domain: string): ClientAccessProjectionBinding | undefined {
    const values = this.deps.readBindings().filter(binding => binding?.authDomainId === domain)
    if (values.length > 1 || values.length === 1 && !bindingValid(values[0])) throw new ClientAccessProjectionError('invalid-binding')
    return values[0] ? { ...values[0] } : undefined
  }

  private currentSnapshot(accountId: string, expectedPrincipal?: string): { access: AccessCredential; principalFingerprint: string } {
    const snapshot = this.deps.account(accountId)
    if (!snapshot) throw new ClientAccessProjectionError('account-unavailable')
    if (snapshot.validationIssue !== undefined) throw new ClientAccessProjectionError('credential-unusable', snapshot.validationIssue)
    const principal = accessPrincipalFingerprint(snapshot)
    if (!principal) throw new ClientAccessProjectionError('principal-unavailable')
    // A subject change always revokes the old binding, even while the new record
    // is temporarily unavailable or has not obtained usable access yet.
    if (expectedPrincipal !== undefined && expectedPrincipal !== principal) throw new ClientAccessProjectionError('principal-changed')
    if (snapshot.temporarilyUnavailable) throw new ClientAccessProjectionError('credential-unusable')
    const access = copyAccess(snapshot)!
    const now = this.now()
    if (!Number.isFinite(now) || access.expiresAt - now <= this.minValidityMs) throw new ClientAccessProjectionError('credential-unusable')
    return { access, principalFingerprint: principal }
  }

  private assertBinding(domain: string, expected: ClientAccessProjectionBinding | undefined): void {
    const current = this.binding(domain)
    if (current?.revision !== expected?.revision) throw new ClientAccessProjectionError('binding-changed')
  }

  private assertCurrent(request: ClientAccessProjectionRequest, expected: ClientAccessProjectionBinding | undefined,
    expectedFingerprint: string, expectedPrincipal: string, adapter: ClientAccessProjectionAdapter): void {
    if (this.closed) throw new ClientAccessProjectionError('closed')
    this.assertBinding(request.authDomainId, expected)
    const resolved = this.deps.adapter(request.runtimeId)
    if (!resolved || resolved !== adapter || resolved.authDomainId !== request.authDomainId) {
      throw new ClientAccessProjectionError('runtime-unavailable')
    }
    const current = this.currentSnapshot(request.accountId, expectedPrincipal)
    if (current.principalFingerprint !== expectedPrincipal) throw new ClientAccessProjectionError('principal-changed')
    if (fingerprint(current.access, current.principalFingerprint) !== expectedFingerprint) throw new ClientAccessProjectionError('credential-changed')
  }

  /** Explicit user replacement may replace an earlier account binding in the same domain. */
  execute(request: ClientAccessProjectionRequest): Promise<ClientAccessProjectionResult> {
    if (!requestValid(request)) return Promise.resolve(this.result(request ?? { accountId: '', runtimeId: '', authDomainId: '' }, 'failed', 'invalid-request'))
    return this.lock({ ...request }, `execute:${JSON.stringify([request.accountId, request.runtimeId, request.expectedPrincipalFingerprint])}`)
  }

  private lock(request: ClientAccessProjectionRequest, key: string, expected?: ClientAccessProjectionBinding): Promise<ClientAccessProjectionResult> {
    if (this.closed) return Promise.resolve(this.result(request, 'closed', 'closed'))
    const operation = this.operations.get(request.authDomainId)
    if (operation) return operation.key === key ? operation.promise : Promise.resolve(this.result(request, 'busy', 'busy'))
    const promise = Promise.resolve().then(() => this.project(request, expected)).finally(() => {
      if (this.operations.get(request.authDomainId)?.promise === promise) this.operations.delete(request.authDomainId)
    })
    this.operations.set(request.authDomainId, { key, promise })
    return promise
  }

  private attention(binding: ClientAccessProjectionBinding, reason: ClientAccessProjectionReason): boolean {
    this.assertBinding(binding.authDomainId, binding)
    return this.deps.writeBinding({ ...binding, revision: randomUUID(), status: 'needs-attention', reason, updatedAt: this.now() }, binding.revision)
  }

  private async project(request: ClientAccessProjectionRequest, syncing?: ClientAccessProjectionBinding): Promise<ClientAccessProjectionResult> {
    let expected: ClientAccessProjectionBinding | undefined
    let targetCommitted = false
    let stage: 'read' | 'write' | 'save' = 'read'
    try {
      if (this.closed) throw new ClientAccessProjectionError('closed')
      expected = this.binding(request.authDomainId)
      if (syncing && (expected?.revision !== syncing.revision || expected.status !== 'active' ||
          expected.accountId !== request.accountId || expected.runtimeId !== request.runtimeId)) {
        throw new ClientAccessProjectionError('binding-changed')
      }
      const adapter = this.deps.adapter(request.runtimeId)
      if (!adapter) throw new ClientAccessProjectionError('runtime-unavailable')
      if (adapter.authDomainId !== request.authDomainId) throw new ClientAccessProjectionError('domain-mismatch')
      if (syncing && !validFingerprint(syncing.principalFingerprint)) throw new ClientAccessProjectionError('principal-unavailable')
      const current = this.currentSnapshot(request.accountId, syncing?.principalFingerprint ?? request.expectedPrincipalFingerprint)
      const principal = current.principalFingerprint
      if (syncing && syncing.principalFingerprint !== principal ||
          request.expectedPrincipalFingerprint !== undefined && request.expectedPrincipalFingerprint !== principal) {
        throw new ClientAccessProjectionError('principal-changed')
      }
      const access = Object.freeze(current.access)
      adapter.validate?.(access)
      const signature = fingerprint(access, principal)
      const targetRevision = await adapter.readRevision()
      if (!nonempty(targetRevision, 8192)) throw new ClientAccessProjectionError('target-read-failed')
      this.assertCurrent(request, expected, signature, principal, adapter)
      if (syncing && targetRevision !== syncing.targetRevision) {
        if (!this.attention(syncing, 'target-changed')) throw new ClientAccessProjectionError('binding-changed')
        return this.result(request, 'needs-attention', 'target-changed')
      }
      if (expected?.status === 'active' && expected.accountId === request.accountId && expected.runtimeId === request.runtimeId &&
          expected.principalFingerprint === principal && expected.credentialFingerprint === signature && expected.targetRevision === targetRevision) {
        return this.result(request, 'unchanged')
      }
      stage = 'write'
      const revision = await adapter.write(access, targetRevision, () => this.assertCurrent(request, expected, signature, principal, adapter),
        Object.freeze({ accountId: request.accountId, runtimeId: request.runtimeId, explicit: !syncing, principalFingerprint: principal,
          sameAccount: expected?.status === 'active' && expected.accountId === request.accountId && expected.runtimeId === request.runtimeId &&
            expected.principalFingerprint === principal && expected.targetRevision === targetRevision }))
      targetCommitted = true
      if (!nonempty(revision, 8192)) throw new ClientAccessProjectionError('target-write-failed')
      stage = 'save'
      // A commit may already have happened. Persist its exact observation, never a newer source
      // fingerprint; the next tick can project the newer source. Do not roll back target tokens.
      this.assertBinding(request.authDomainId, expected)
      const binding: ClientAccessProjectionBinding = {
        accountId: request.accountId, runtimeId: request.runtimeId, authDomainId: request.authDomainId,
        revision: randomUUID(), targetRevision: revision, credentialFingerprint: signature, principalFingerprint: principal,
        status: 'active', updatedAt: this.now()
      }
      if (!this.deps.writeBinding(binding, expected?.revision)) throw new ClientAccessProjectionError('binding-changed')
      return this.result(request, 'projected', undefined, true)
    } catch (error) {
      const reason = error instanceof ClientAccessProjectionError ? error.code
        : stage === 'write' ? 'target-write-failed' : stage === 'save' ? 'binding-save-failed' : 'target-read-failed'
      const uncertain = reason === 'target-write-uncertain'
      const configured = !!error && typeof error === 'object' && 'backendConfigured' in error && error.backendConfigured === true
      if (syncing && expected && !targetCommitted &&
          ['account-unavailable', 'principal-unavailable', 'principal-changed', 'runtime-unavailable', 'domain-mismatch', 'target-changed', 'target-write-uncertain'].includes(reason)) {
        try { this.attention(expected, reason) } catch { /* A concurrent binding change must not be overwritten. */ }
      }
      const status = reason === 'closed' ? 'closed' :
        ['target-changed', 'binding-changed', 'account-unavailable', 'principal-unavailable', 'principal-changed', 'credential-unusable', 'credential-changed', 'runtime-unavailable', 'domain-mismatch'].includes(reason)
          ? 'needs-attention' : 'failed'
      return { ...this.result(request, status, reason, targetCommitted),
        ...(error instanceof ClientAccessProjectionError && error.validationIssue ? { validationIssue: error.validationIssue } : {}),
        ...(uncertain ? { targetWriteUncertain: true } : {}), ...(configured ? { targetConfigurationChanged: true } : {}) }
    }
  }

  /** Reads the latest manager access only; never triggers refresh or changes its scheduler. */
  async tick(): Promise<ClientAccessProjectionResult[]> {
    if (this.closed) return []
    let bindings: readonly ClientAccessProjectionBinding[]
    try { bindings = this.deps.readBindings() } catch { return [] }
    return await Promise.all(bindings.filter(binding => bindingValid(binding) && binding.status === 'active').map(binding => {
      const snapshot = { ...binding }
      return this.lock(snapshot, `sync:${snapshot.revision}`, snapshot)
    }))
  }

  /** Metadata-only revocation; never logs out a client or modifies its files. */
  disconnect(request: ClientAccessProjectionRequest): ClientAccessProjectionResult {
    if (!requestValid(request)) return this.result(request, 'failed', 'invalid-request')
    try {
      const binding = this.binding(request.authDomainId)
      if (!binding) return this.result(request, 'unchanged')
      if (binding.accountId !== request.accountId || binding.runtimeId !== request.runtimeId) return this.result(request, 'failed', 'binding-changed')
      if (binding.status !== 'active') return this.result(request, 'unchanged')
      if (!this.attention(binding, 'user-disconnected')) return this.result(request, 'failed', 'binding-changed')
      return this.result(request, 'unchanged')
    } catch { return this.result(request, 'failed', 'binding-save-failed') }
  }

  start(intervalMs = 30_000): void {
    if (this.closed) return
    if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error('Invalid projection interval')
    this.stop()
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
  }

  /** Stops future scheduled ticks without falsely releasing an in-flight domain lock. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  close(): void {
    this.closed = true
    this.stop()
    // In-flight promises retain their locks and their commit guard observes closed.
  }
}
