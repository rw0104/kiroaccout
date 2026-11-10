import type { ClientSwitchCapability, ClientSwitchRequest, ClientSwitchResult, ClientSwitchSnapshot, ExternalClientTarget } from '../shared/clientSwitch'
import { ClientAccessProjectionService, ClientAccessProjectionError, accessPrincipalFingerprint, projectableClientAccess, type ClientAccessValidationIssue, type ManagerAccessSnapshot, type ClientAccessProjectionBinding, type ClientAccessProjectionAdapter } from './clientAccessProjection'

export interface ClientSwitchRuntime {
  id: string
  target: ExternalClientTarget
  revision: string
  version: string
  adapter: ClientAccessProjectionAdapter
  /** Conservative inspection only; never stops the user's processes. */
  isRunning(): Promise<boolean>
}

export interface ClientSwitchDependencies {
  account(accountId: string): ManagerAccessSnapshot | undefined
  runtime(target: ExternalClientTarget): Promise<ClientSwitchRuntime | undefined>
  projection: ClientAccessProjectionService
  bindings(): readonly ClientAccessProjectionBinding[]
  /** Holds the existing manager operation lease without changing refresh ownership. */
  beginOperation(accountId: string): () => void
  now?: () => number
  platformSupported?: () => boolean
}

const targets: ExternalClientTarget[] = ['crew', 'cli']
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)
const validRequest = (value: ClientSwitchRequest): boolean => !!value && validId(value.operationId) && validId(value.accountId) &&
  targets.includes(value.target) && (value.runtimeId === undefined || validId(value.runtimeId)) &&
  (value.expectedRuntimeRevision === undefined || validId(value.expectedRuntimeRevision))

const accessIssueMessages: Record<ClientAccessValidationIssue, { message: string; messageEn: string }> = {
  'provider-unsupported': { message: '账号登录提供商无法识别或不受此客户端支持，请核对导入资料或重新授权。',
    messageEn: 'The account provider is unrecognized or unsupported by this client. Check the imported details or authorize again.' },
  'auth-method-mismatch': { message: '账号认证方式与登录提供商不一致，请核对导入资料或重新授权。',
    messageEn: 'The authentication method does not match the account provider. Check the imported details or authorize again.' },
  'metadata-conflict': { message: '账号身份资料存在冲突，无法安全选择 profile 或登录身份。请重新导入一致的资料或重新授权。',
    messageEn: 'The account identity metadata conflicts. Import consistent details or authorize again before selecting a profile or identity.' },
  'profile-missing': { message: '账号缺少登录返回的 profile 信息，请重新导入完整资料或重新授权后重试。',
    messageEn: 'The account is missing the profile returned by sign-in. Import complete details or authorize again.' },
  'profile-invalid': { message: '账号 profile 信息格式无效，请重新导入完整资料或重新授权后重试。',
    messageEn: 'The account profile metadata is invalid. Import complete details or authorize again.' },
  'region-missing': { message: '账号缺少此客户端所需的区域信息，请核对原登录资料后重试。',
    messageEn: 'The account is missing the region required by this client. Check the original sign-in details.' },
  'region-invalid': { message: '账号区域格式无效，请核对原登录资料中的区域后重试。',
    messageEn: 'The account region has an invalid format. Check the region in the original sign-in details.' },
  'start-url-missing': { message: '企业账号缺少组织登录地址，请重新导入完整的企业登录资料。',
    messageEn: 'The enterprise account is missing its organization sign-in URL. Import complete enterprise sign-in details.' },
  'start-url-invalid': { message: '企业账号的组织登录地址无效，请核对原企业登录地址后重试。',
    messageEn: 'The enterprise organization sign-in URL is invalid. Check the original enterprise sign-in URL.' }
}

/** Only known local categories cross IPC; arbitrary adapter messages never do. */
function accessDiagnostic(error: unknown, provider?: string): { errorCode: string; message: string; messageEn: string } {
  const issue = error instanceof ClientAccessProjectionError && error.code === 'credential-unusable' ? error.validationIssue : undefined
  if (issue && Object.hasOwn(accessIssueMessages, issue)) {
    if ((issue === 'start-url-missing' || issue === 'start-url-invalid') && provider !== 'Enterprise') {
      return { errorCode: issue, message: '账号包含无效的登录地址资料，请重新导入与此登录方式一致的资料。',
        messageEn: 'The account contains invalid sign-in URL metadata. Import details consistent with this sign-in method.' }
    }
    return { errorCode: issue, ...accessIssueMessages[issue] }
  }
  return { errorCode: 'credential-unusable', message: '账号访问资料未通过客户端校验，请重新导入完整资料或重新授权后重试。',
    messageEn: 'The account access details failed client validation. Import complete details or authorize again.' }
}

/** Public IPC results contain state only, never authentication payloads. */
export class ClientSwitchService {
  private readonly deps: ClientSwitchDependencies
  private readonly now: () => number
  private readonly operations = new Map<string, { key: string; promise: Promise<ClientSwitchResult> }>()

  constructor(deps: ClientSwitchDependencies) { this.deps = deps; this.now = deps.now ?? Date.now }

  private result(request: ClientSwitchRequest, message: string, messageEn: string,
    errorCode?: string, committed = false): ClientSwitchResult {
    return {
      operationId: validId(request?.operationId) ? request.operationId : '',
      target: targets.includes(request?.target) ? request.target : 'cli',
      status: errorCode ? committed ? 'failed' : 'blocked' : 'credentials-written',
      credentialWrite: committed ? 'committed' : 'not-started', credentialRotation: 'none',
      affectedTargets: targets.includes(request?.target) ? [request.target] : [],
      requiresNewSession: committed && !errorCode, message, messageEn,
      ...(errorCode ? { errorCode } : {})
    }
  }

  async inspect(accountId: string): Promise<ClientSwitchSnapshot> {
    if (!validId(accountId)) throw new Error('Invalid account selection')
    if (this.deps.platformSupported && !this.deps.platformSupported()) return { targets: targets.map(target => ({ target, status: 'blocked',
      message: '此版本的 CLI/Crew 连接目前仅支持 Windows；IDE 切号保持可用。',
      messageEn: 'CLI/Crew connections in this release support Windows. IDE account switching remains available.' })) }
    const access = this.deps.account(accountId)
    const principal = accessPrincipalFingerprint(access)
    const inspectedRuntimes = new Map<ExternalClientTarget, ClientSwitchRuntime>()
    const snapshots = await Promise.all(targets.map(async (target): Promise<ClientSwitchCapability> => {
      let runtime: ClientSwitchRuntime | undefined
      try { runtime = await this.deps.runtime(target) } catch {
        return { target, status: 'blocked', message: '客户端兼容性检测未完成，请重试或重新选择安装位置。',
          messageEn: 'Client verification did not complete. Retry or select its installation again.' }
      }
      if (!runtime) return { target, status: 'not-installed', message: '请选择已安装且支持的官方客户端。', messageEn: 'Select a supported official client installation.' }
      inspectedRuntimes.set(target, runtime)
      const binding = this.deps.bindings().find(item => item.authDomainId === runtime!.adapter.authDomainId)
      const base = { target, runtimeId: runtime.id, revision: runtime.revision, version: runtime.version,
        connected: !!principal && binding?.status === 'active' && binding.accountId === accountId &&
          binding.runtimeId === runtime.id && binding.principalFingerprint === principal }
      if (access?.validationIssue !== undefined) return { ...base, status: 'blocked',
        ...accessDiagnostic(new ClientAccessProjectionError('credential-unusable', access.validationIssue), access.provider) }
      if (access?.temporarilyUnavailable) return { ...base, status: 'blocked',
        message: '管理器账号状态暂时不可用；现有同步绑定已保留，待原刷新或状态检查恢复后会自动继续。',
        messageEn: 'The manager account is temporarily unavailable. Its sync binding is retained and resumes after the existing refresh or status check recovers.' }
      if (!access?.accessToken || !Number.isFinite(access.expiresAt) || access.expiresAt <= this.now() + 180_000) {
        return { ...base, status: 'blocked', message: '管理器访问凭证尚未就绪，请等待原自动刷新或在账户中完成授权后重试。',
          messageEn: 'The manager access token is not ready. Wait for its existing refresh or authorize the account, then retry.' }
      }
      if (!principal) return { ...base, status: 'blocked', message: '无法确认账号的稳定身份，请完成账号信息校验或重新授权后重试。',
        messageEn: 'The stable account identity is unavailable. Verify the account information or authorize it, then retry.' }
      try { runtime.adapter.validate?.(projectableClientAccess(access)!) } catch (error) {
        return { ...base, status: 'blocked', ...accessDiagnostic(error, access.provider) }
      }
      let bindingCurrent = base.connected
      if (bindingCurrent) {
        try { bindingCurrent = await runtime.adapter.readRevision() === binding!.targetRevision }
        catch { bindingCurrent = false }
      }
      if (!bindingCurrent) {
        try {
          if (await runtime.isRunning()) return { ...base, status: 'blocked', message: '请先正常关闭此客户端及其后台会话，再替换账号。',
            messageEn: 'Close this client and its background sessions before changing accounts.' }
        } catch {
          return { ...base, status: 'blocked', message: '无法确认客户端运行状态，暂未允许替换。', messageEn: 'The client running state could not be verified.' }
        }
      }
      return { ...base, status: 'ready', message: '仅同步短期访问凭证；请保持管理器运行。原登录与自动刷新设置保持不变。',
        messageEn: 'Syncs short-lived access only. Keep the manager running; its sign-in and refresh settings stay unchanged.' }
    }))
    for (const snapshot of snapshots) {
      if (!snapshot.runtimeId) continue
      const runtime = inspectedRuntimes.get(snapshot.target)
      if (!runtime || runtime.revision !== snapshot.revision) continue
      const shared: ExternalClientTarget[] = []
      for (const other of snapshots) {
        const candidate = inspectedRuntimes.get(other.target)
        if (candidate?.adapter.authDomainId === runtime.adapter.authDomainId) shared.push(other.target)
      }
      if (shared.length > 1) snapshot.sharedTargets = shared
    }
    return { targets: snapshots }
  }

  execute(request: ClientSwitchRequest): Promise<ClientSwitchResult> {
    if (!validRequest(request)) return Promise.resolve(this.result(request, '切换请求无效。', 'Invalid client selection.', 'INVALID_REQUEST'))
    const key = JSON.stringify([request.accountId, request.target, request.runtimeId, request.expectedRuntimeRevision])
    const pending = this.operations.get(request.operationId)
    if (pending) return pending.key === key ? pending.promise : Promise.resolve(this.result(request, '操作编号已用于另一请求。', 'The operation ID belongs to another request.', 'OPERATION_MISMATCH'))
    const promise = this.perform({ ...request }).finally(() => {
      if (this.operations.get(request.operationId)?.promise === promise) this.operations.delete(request.operationId)
    })
    this.operations.set(request.operationId, { key, promise })
    return promise
  }

  private async perform(request: ClientSwitchRequest): Promise<ClientSwitchResult> {
    let release: (() => void) | undefined
    try {
      release = this.deps.beginOperation(request.accountId)
      const principal = accessPrincipalFingerprint(this.deps.account(request.accountId))
      const snapshot = await this.inspect(request.accountId)
      const capability = snapshot.targets.find(item => item.target === request.target)!
      if (capability.status !== 'ready') return this.result(request, capability.message, capability.messageEn || 'Client not ready.', capability.errorCode || 'CLIENT_NOT_READY')
      const runtime = await this.deps.runtime(request.target)
      if (!runtime || runtime.id !== capability.runtimeId || runtime.revision !== capability.revision ||
          request.runtimeId !== undefined && request.runtimeId !== runtime.id ||
          request.expectedRuntimeRevision !== undefined && request.expectedRuntimeRevision !== runtime.revision) {
        return this.result(request, '客户端配置已变化，请重新检测。', 'The client configuration changed. Inspect it again.', 'RUNTIME_CHANGED')
      }
      if (!principal || accessPrincipalFingerprint(this.deps.account(request.accountId)) !== principal) {
        return this.result(request, '所选账号的身份已变化，请重新检测后再切换。',
          'The selected account identity changed. Inspect it again before switching.', 'PRINCIPAL_CHANGED')
      }
      const binding = this.deps.bindings().find(item => item.authDomainId === runtime.adapter.authDomainId)
      const sameBinding = binding?.status === 'active' && binding.accountId === request.accountId && binding.runtimeId === runtime.id &&
        binding.principalFingerprint === principal && binding.targetRevision === await runtime.adapter.readRevision()
      if (!sameBinding && await runtime.isRunning()) {
        return this.result(request, '客户端已开始运行，请正常关闭后重试。', 'The client has started. Close it normally and retry.', 'CLIENT_RUNNING')
      }
      if (accessPrincipalFingerprint(this.deps.account(request.accountId)) !== principal) {
        return this.result(request, '所选账号的身份已变化，请重新检测后再切换。',
          'The selected account identity changed. Inspect it again before switching.', 'PRINCIPAL_CHANGED')
      }
      const projected = await this.deps.projection.execute({ accountId: request.accountId, runtimeId: runtime.id,
        authDomainId: runtime.adapter.authDomainId, expectedPrincipalFingerprint: principal })
      if (projected.status !== 'projected' && projected.status !== 'unchanged') {
        if (projected.targetWriteUncertain) return { ...this.result(request,
          '客户端凭证写入结果尚未确认，请重新检测。管理器登录和刷新未更改。',
          'The client write outcome is uncertain. Inspect again. The manager sign-in and refresh were not changed.',
          'TARGET_WRITE_UNCERTAIN'), status: 'failed', credentialWrite: 'uncertain' }
        if (projected.targetConfigurationChanged) return this.result(request,
          '客户端连接设置已更新，但凭证替换未完成。请重新检测；管理器登录未更改。',
          'Client connection settings were updated, but access was not replaced. Inspect again; the manager sign-in was not changed.',
          projected.reason || 'TARGET_WRITE_FAILED', projected.targetCommitted)
        if (!projected.targetCommitted && projected.validationIssue) {
          const diagnostic = accessDiagnostic(new ClientAccessProjectionError('credential-unusable', projected.validationIssue), this.deps.account(request.accountId)?.provider)
          return this.result(request, diagnostic.message, diagnostic.messageEn, diagnostic.errorCode)
        }
        return this.result(request, projected.targetCommitted
          ? '客户端凭证已写入，但同步绑定未保存。请重新检测，未回滚管理器凭证。'
          : '客户端状态或访问凭证发生变化，未完成替换。管理器登录与刷新未更改。',
        projected.targetCommitted ? 'Access was written, but its sync binding could not be saved. Inspect again.'
          : 'Client state or access changed. The manager sign-in and refresh were not changed.',
        projected.reason || projected.status, projected.targetCommitted)
      }
      const result = this.result(request, '本机客户端访问凭证已替换。请新建会话使用；保持管理器运行以同步原自动刷新产生的新凭证。',
        'Local client access was updated. Use a new session and keep the manager running to sync its normally refreshed access.', undefined, true)
      result.affectedTargets = capability.sharedTargets || [request.target]
      result.requiresNewSession = projected.status !== 'unchanged'
      if (projected.status === 'unchanged') {
        result.credentialWrite = 'not-started'
        result.message = '本机客户端已连接此账号，当前访问凭证无需更新。'
        result.messageEn = 'The local client is already connected to this account; access does not need updating.'
      }
      return result
    } catch {
      return this.result(request, '未能确认账号或客户端状态，替换已停止；管理器登录未更改。',
        'Account or client state could not be verified. The manager sign-in was not changed.', 'SWITCH_REFUSED')
    } finally { release?.() }
  }

  authorize(request: ClientSwitchRequest): Promise<ClientSwitchResult> {
    return Promise.resolve(this.result(request, '此连接只使用管理器的短期访问凭证；请在管理器中完成账号授权后重试。',
      'This connection uses manager access only. Authorize the account in the manager, then retry.', 'MANAGER_AUTH_REQUIRED'))
  }

  async disconnect(request: ClientSwitchRequest): Promise<ClientSwitchResult> {
    if (!validRequest(request)) return this.result(request, '切换请求无效。', 'Invalid client selection.', 'INVALID_REQUEST')
    try {
      const runtime = await this.deps.runtime(request.target)
      if (!runtime || request.runtimeId !== undefined && runtime.id !== request.runtimeId ||
          request.expectedRuntimeRevision !== undefined && runtime.revision !== request.expectedRuntimeRevision) {
        return this.result(request, '客户端配置已变化，请重新检测。', 'The client configuration changed. Inspect again.', 'RUNTIME_CHANGED')
      }
      const revoked = this.deps.projection.disconnect({ accountId: request.accountId, runtimeId: runtime.id, authDomainId: runtime.adapter.authDomainId })
      if (revoked.status !== 'unchanged') return this.result(request, '同步状态未能保存，请重试。', 'The sync state could not be saved. Retry.', revoked.reason || 'DISCONNECT_FAILED')
      return { ...this.result(request, '已停止同步；客户端现有短期凭证会自然到期。管理器登录与刷新保持不变。',
        'Sync stopped. Existing client access will expire naturally; the manager sign-in and refresh are unchanged.'), status: 'disconnected', requiresNewSession: false }
    } catch { return this.result(request, '同步状态未能保存，请重试。', 'The sync state could not be saved. Retry.', 'DISCONNECT_FAILED') }
  }
}
