import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Monitor, RefreshCw, Terminal, Users, X } from 'lucide-react'
import { Button } from '../ui'
import { cn } from '@/lib/utils'
import type { ClientSwitchApi, ClientSwitchCapability, ClientSwitchTarget } from '../../../../shared/clientSwitch'
import type { ManagedCrewApi, ManagedCrewState } from '../../../../shared/managedCrew'

interface ClientSwitchDialogProps {
  accountId: string
  accountLabel: string
  isCurrentAccount: boolean
  isEn: boolean
  api: ClientSwitchApi
  managedApi?: ManagedCrewApi
  onSwitchIde: () => Promise<{ success: boolean; error?: string }>
  onClose: () => void
}

type DialogTarget = ClientSwitchTarget | 'crew-managed'
const targets = ['ide', 'crew', 'cli'] as const
const clientNames: Record<DialogTarget, string> = { ide: 'Kiro IDE', crew: 'Kiro Crew', 'crew-managed': 'Kiro Crew', cli: 'Kiro CLI' }
const clientIcons = { ide: Monitor, crew: Users, 'crew-managed': Users, cli: Terminal }

/** A selection or inspection never starts a credential write. Only submit does. */
export function ClientSwitchDialog({ accountId, accountLabel, isCurrentAccount, isEn, api, managedApi, onSwitchIde, onClose }: ClientSwitchDialogProps): React.ReactNode {
  const titleId = useId()
  const accountLabelId = useId()
  const [target, setTarget] = useState<DialogTarget>('ide')
  const [capabilities, setCapabilities] = useState<ClientSwitchCapability[]>([])
  const [managedState, setManagedState] = useState<ManagedCrewState | null>(null)
  const [managedInspectError, setManagedInspectError] = useState(false)
  const [inspecting, setInspecting] = useState(true)
  const [inspectError, setInspectError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<'switch' | 'authorize' | 'configure' | 'disconnect' | 'workspace-start' | 'workspace-open' | 'workspace-stop' | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const initialRadioRef = useRef<HTMLInputElement>(null)
  const apiRef = useRef(api)
  const managedApiRef = useRef(managedApi)
  const closeRef = useRef(onClose)
  const busyRef = useRef(false)
  const cancelingRef = useRef(false)
  const authorizationRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const inspectSequence = useRef(0)
  const operationSequence = useRef(0)
  apiRef.current = api
  managedApiRef.current = managedApi ?? (typeof window === 'undefined' ? undefined : window.api?.managedCrew)

  const inspect = useCallback(async () => {
    const sequence = ++inspectSequence.current
    setInspecting(true)
    setInspectError(false)
    setManagedInspectError(false)
    try {
      const [existing, workspace] = await Promise.allSettled([
        apiRef.current.inspect(accountId),
        managedApiRef.current?.inspect(accountId) ?? Promise.resolve(undefined)
      ])
      if (!mountedRef.current || sequence !== inspectSequence.current) return
      if (existing.status === 'fulfilled') setCapabilities(existing.value.targets)
      else { setCapabilities([]); setInspectError(true) }
      if (workspace.status === 'fulfilled') setManagedState(workspace.value ?? null)
      else { setManagedState(null); setManagedInspectError(true) }
    } catch {
      if (!mountedRef.current || sequence !== inspectSequence.current) return
      setCapabilities([])
      setInspectError(true)
      setManagedState(null)
      setManagedInspectError(true)
    } finally {
      if (mountedRef.current && sequence === inspectSequence.current) setInspecting(false)
    }
  }, [accountId])

  useEffect(() => {
    mountedRef.current = true
    setTarget('ide')
    setResult(null)
    setManagedState(null)
    busyRef.current = false
    setBusy(false)
    setActivity(null)
    setCanceling(false)
    cancelingRef.current = false
    void inspect()
    return () => {
      mountedRef.current = false
      inspectSequence.current++
      operationSequence.current++
      if (authorizationRef.current) {
        if (!cancelingRef.current) void apiRef.current.cancelAuthorization(authorizationRef.current).catch(() => {})
        authorizationRef.current = null
      }
    }
  }, [inspect])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialRadioRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]'
      ) ?? []).filter(element => element.getAttribute('aria-hidden') !== 'true')
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        panelRef.current?.focus()
      } else if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  const capability = capabilities.find(item => item.target === target)
  const isManaged = target === 'crew-managed'
  const isCrew = target === 'crew-managed' || target === 'crew'
  const canOpenManaged = managedState?.selectedAccount === true && managedState.canOpen
  const canSubmit = !busy && (target === 'ide' || (!inspecting && (isManaged
    ? !!managedApiRef.current && (managedState?.canStart === true || canOpenManaged)
    : capability?.status === 'ready')))
  const sharedAuthentication = capability?.sharedTargets && capability.sharedTargets.length > 1

  const requestClose = async (): Promise<void> => {
    if (cancelingRef.current || (busyRef.current && !authorizationRef.current)) return
    const sequence = operationSequence.current
    if (authorizationRef.current) {
      const operationId = authorizationRef.current
      cancelingRef.current = true
      setCanceling(true)
      try {
        await apiRef.current.cancelAuthorization(operationId)
        if (!mountedRef.current || sequence !== operationSequence.current) return
        authorizationRef.current = null
      } catch {
        if (mountedRef.current && sequence === operationSequence.current) {
          cancelingRef.current = false
          setCanceling(false)
          setResult({ success: false, message: isEn ? 'Could not cancel authorization. Please try again.' : '取消授权失败，请重试。' })
        }
        return
      }
    }
    if (mountedRef.current && sequence === operationSequence.current) onClose()
  }
  closeRef.current = () => { void requestClose() }

  const chooseExecutable = async (): Promise<void> => {
    if (target === 'ide' || busyRef.current) return
    const sequence = ++operationSequence.current
    busyRef.current = true
    setBusy(true)
    setActivity('configure')
    setResult(null)
    try {
      const response = target === 'crew-managed'
        ? await managedApiRef.current!.chooseExecutable()
        : await apiRef.current.chooseExecutable(target)
      if (!mountedRef.current || sequence !== operationSequence.current) return
      if (!response.success && !response.canceled) setResult({ success: false, message: response.message || (isEn ? 'Could not configure this client.' : '客户端配置未完成。') })
      if (response.success) void inspect()
    } catch {
      if (mountedRef.current && sequence === operationSequence.current) setResult({ success: false, message: isEn ? 'Could not configure this client.' : '客户端配置未完成。' })
    } finally {
      if (sequence === operationSequence.current) {
        busyRef.current = false
        if (mountedRef.current) { setBusy(false); setActivity(null) }
      }
    }
  }

  const authorize = async (): Promise<void> => {
    if (target === 'ide' || target === 'crew-managed' || busyRef.current || capability?.status !== 'needs-login') return
    const sequence = ++operationSequence.current
    const operationId = crypto.randomUUID()
    authorizationRef.current = operationId
    busyRef.current = true
    setBusy(true)
    setActivity('authorize')
    setResult(null)
    try {
      const response = await apiRef.current.authorize({ operationId, accountId, target, runtimeId: capability.runtimeId, expectedRuntimeRevision: capability.revision })
      if (!mountedRef.current || sequence !== operationSequence.current) return
      setResult({ success: response.status === 'identity-verified', message: isEn ? response.messageEn || response.message : response.message })
      void inspect()
    } catch {
      if (mountedRef.current && sequence === operationSequence.current) setResult({ success: false, message: isEn ? 'Client authorization did not complete. Please try again.' : '客户端授权未完成，请重试。' })
    } finally {
      if (sequence === operationSequence.current) {
        authorizationRef.current = null
        busyRef.current = false
        cancelingRef.current = false
        if (mountedRef.current) { setBusy(false); setActivity(null); setCanceling(false) }
      }
    }
  }

  const disconnect = async (): Promise<void> => {
    if (target === 'ide' || target === 'crew-managed' || busyRef.current || inspecting || !capability?.connected) return
    const sequence = ++operationSequence.current
    busyRef.current = true
    setBusy(true)
    setActivity('disconnect')
    setResult(null)
    try {
      const response = await apiRef.current.disconnect({
        operationId: crypto.randomUUID(), accountId, target,
        runtimeId: capability.runtimeId, expectedRuntimeRevision: capability.revision
      })
      if (!mountedRef.current || sequence !== operationSequence.current) return
      const success = response.status === 'disconnected'
      setResult({
        success,
        message: success
          ? (isEn ? 'Synchronization stopped. Existing short-lived client credentials will expire naturally. The manager sign-in is unchanged.' : '已停止同步，客户端现有短期凭证会自然到期；管理器登录不变。')
          : (isEn ? response.messageEn || response.message : response.message)
      })
      void inspect()
    } catch {
      if (mountedRef.current && sequence === operationSequence.current) setResult({ success: false, message: isEn ? 'Could not stop synchronization. Check the client state before retrying.' : '停止同步未完成，请检查客户端状态后重试。' })
    } finally {
      if (sequence === operationSequence.current) {
        busyRef.current = false
        if (mountedRef.current) { setBusy(false); setActivity(null) }
      }
    }
  }

  const stopWorkspace = async (): Promise<void> => {
    if (!isManaged || busyRef.current || inspecting || !managedApiRef.current || !managedState?.canStop || !managedState.selectedAccount) return
    const sequence = ++operationSequence.current
    busyRef.current = true
    setBusy(true)
    setActivity('workspace-stop')
    setResult(null)
    try {
      const response = await managedApiRef.current.stop({ accountId, operationId: crypto.randomUUID() })
      if (!mountedRef.current || sequence !== operationSequence.current) return
      setManagedState(response.state)
      setResult({ success: response.success, message: isEn ? response.state.messageEn || response.state.message : response.state.message })
      void inspect()
    } catch {
      if (mountedRef.current && sequence === operationSequence.current) setResult({ success: false,
        message: isEn ? 'The independent workspace could not be stopped. Check its state and retry.' : '独立工作区未能停止，请检查状态后重试。' })
    } finally {
      if (sequence === operationSequence.current) {
        busyRef.current = false
        if (mountedRef.current) { setBusy(false); setActivity(null) }
      }
    }
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    if (busyRef.current || !canSubmit) return
    const sequence = ++operationSequence.current
    busyRef.current = true
    setBusy(true)
    setActivity(isManaged ? canOpenManaged ? 'workspace-open' : 'workspace-start' : 'switch')
    setResult(null)
    try {
      if (target === 'ide') {
        const response = await onSwitchIde()
        if (!mountedRef.current || sequence !== operationSequence.current) return
        if (response.success) onClose()
        else setResult({ success: false, message: response.error || (isEn ? 'The account could not be switched. Please try again.' : '账号切换未完成，请重试。') })
      } else if (target === 'crew-managed') {
        const workspaceApi = managedApiRef.current
        if (!workspaceApi) throw new Error('Workspace unavailable')
        const request = { accountId, operationId: crypto.randomUUID() }
        const response = canOpenManaged ? await workspaceApi.open(request) : await workspaceApi.start(request)
        if (!mountedRef.current || sequence !== operationSequence.current) return
        setManagedState(response.state)
        setResult({ success: response.success, message: isEn ? response.state.messageEn || response.state.message : response.state.message })
        void inspect()
      } else {
        const response = await apiRef.current.execute({
          operationId: crypto.randomUUID(),
          accountId,
          target,
          runtimeId: capability?.runtimeId,
          expectedRuntimeRevision: capability?.revision
        })
        if (!mountedRef.current || sequence !== operationSequence.current) return
        setResult({
          success: response.status === 'credentials-written' || response.status === 'identity-verified',
          message: isEn ? response.messageEn || response.message : response.message
        })
        void inspect()
      }
    } catch {
      if (mountedRef.current && sequence === operationSequence.current) setResult({ success: false, message: isEn ? 'The request did not complete. Check the client state before retrying.' : '请求未完成，请检查客户端状态后重试。' })
    } finally {
      if (sequence === operationSequence.current) {
        busyRef.current = false
        if (mountedRef.current) { setBusy(false); setActivity(null) }
      }
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={event => event.stopPropagation()}>
      <div className="absolute inset-0 bg-black/50" onClick={() => closeRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={accountLabelId}
        aria-busy={busy}
        tabIndex={-1}
        className="relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border bg-background shadow-2xl"
      >
        <form onSubmit={submit}>
          <div className="flex items-start justify-between gap-3 border-b p-5">
            <div className="min-w-0 space-y-1">
              <h2 id={titleId} className="text-base font-semibold">{isEn ? 'Choose a client' : '选择切换客户端'}</h2>
              <p id={accountLabelId} className="break-all text-xs text-muted-foreground">
                {isEn ? 'Account: ' : '账号：'}{accountLabel}
              </p>
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={canceling || (busy && activity !== 'authorize')} onClick={() => void requestClose()} aria-label={isEn ? 'Close' : '关闭'}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-4 p-5">
            <fieldset disabled={busy} className="space-y-2">
              <legend className="sr-only">{isEn ? 'Switch the selected account to' : '将所选账号切换到'}</legend>
              {targets.map(client => {
                const Icon = clientIcons[client]
                const item = capabilities.find(entry => entry.target === client)
                const selected = client === 'crew' ? isCrew : target === client
                const description = client === 'ide'
                  ? (isEn ? 'Use the existing IDE account switch.' : '按现有方式切换 IDE 账号。')
                  : client === 'crew'
                    ? (isEn ? 'Open an independent workspace or switch an existing Crew client.' : '打开独立工作区，或切换已有 Crew 客户端的账号。')
                    : (isEn ? 'Switch the account used by the local CLI.' : '切换本机 CLI 使用的账号。')
                const detail = client === 'ide' || client === 'crew' ? '' : inspecting
                  ? (isEn ? 'Checking client…' : '正在检测客户端…')
                  : item ? (isEn ? item.messageEn || item.message : item.message)
                    : (isEn ? 'Client information is unavailable.' : '暂时无法获取客户端信息。')
                return (
                  <label key={client} className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                    selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                    busy && 'cursor-wait opacity-70'
                  )}>
                    <input
                      ref={client === 'ide' ? initialRadioRef : undefined}
                      type="radio"
                      name={titleId}
                      value={client}
                      data-client-target={client}
                      checked={selected}
                      onChange={() => { setTarget(client === 'crew' ? 'crew-managed' : client); setResult(null) }}
                      className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    />
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {clientNames[client]}
                        {client === 'ide' && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{isEn ? 'Default' : '默认'}</span>}
                        {client === 'ide' && isCurrentAccount && <span className="text-[10px] text-muted-foreground">{isEn ? 'Current account' : '当前账号'}</span>}
                      </span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                      {detail && <span className={cn('block break-words text-xs', item?.status === 'ready' ? 'text-muted-foreground' : 'text-foreground')}>{detail}</span>}
                    </span>
                  </label>
                )
              })}
            </fieldset>
            {isCrew && <fieldset data-testid="crew-mode-picker" disabled={busy} className="space-y-3">
              <legend className="mb-2 text-xs font-medium">{isEn ? 'How to use Crew' : 'Crew 使用方式'}</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['crew-managed', 'crew'] as const).map(mode => <label key={mode} className={cn(
                  'flex min-w-0 cursor-pointer flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 text-xs',
                  target === mode ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                  busy && 'cursor-wait opacity-70'
                )}>
                  <input type="radio" name={`${titleId}-crew-mode`} value={mode} data-crew-mode={mode}
                    checked={target === mode} onChange={() => { if (!busyRef.current) { setTarget(mode); setResult(null) } }}
                    className="h-4 w-4 shrink-0 accent-primary" />
                  <span>{mode === 'crew-managed' ? (isEn ? 'Independent workspace' : '独立工作区') : (isEn ? 'Existing client' : '现有客户端')}</span>
                  {mode === 'crew-managed' && <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">{isEn ? 'Recommended' : '推荐'}</span>}
                </label>)}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{isManaged
                ? (isEn ? 'Start Crew with independent data and the model-menu fix. Existing client sign-in is preserved.' : '使用独立数据启动 Crew，并修复模型菜单；保留现有客户端登录。')
                : (isEn ? 'Only switch the account in your existing Crew client. This does not start it.' : '仅切换已有 Crew 客户端的账号，不会启动客户端。')}</p>
              <p className="break-words text-xs" role="status">{inspecting
                ? (isEn ? 'Checking client…' : '正在检测客户端…')
                : isManaged
                  ? managedInspectError ? (isEn ? 'Workspace detection failed. Refresh to retry.' : '独立工作区检测失败，请重新检测。')
                    : managedState ? (isEn ? managedState.messageEn || managedState.message : managedState.message)
                      : (isEn ? 'The independent workspace is unavailable.' : '独立工作区暂不可用。')
                  : capability ? (isEn ? capability.messageEn || capability.message : capability.message)
                    : (isEn ? 'Client information is unavailable.' : '暂时无法获取客户端信息。')}</p>
            </fieldset>}
            {target !== 'ide' && target !== 'crew-managed' && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {capability?.connected && (
                  <Button type="button" variant="outline" size="sm" disabled={busy || inspecting} onClick={() => void disconnect()}>
                    {isEn ? 'Disconnect' : '停止同步'}
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" disabled={busy || inspecting} onClick={() => void chooseExecutable()}>
                  {isEn ? 'Choose installed client' : '选择已安装客户端'}
                </Button>
                {capability?.status === 'needs-login' && (
                  <Button type="button" variant="outline" size="sm" disabled={busy || inspecting} onClick={() => void authorize()}>
                    {isEn ? 'Authorize this account in client' : '在客户端授权此账号'}
                  </Button>
                )}
              </div>
            )}
            {isManaged && <>
              <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground" role="note">
                {isEn ? 'Keep the manager running to synchronize short-lived access. The workspace keeps its own data and leaves the official installation and existing sign-in unchanged.' : '请保持管理器运行以同步短期凭证。工作区使用独立数据，保留官方安装和现有登录。'}
              </p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {managedState?.canStop && managedState.selectedAccount && <Button type="button" variant="outline" size="sm" disabled={busy || inspecting} onClick={() => void stopWorkspace()}>
                  {isEn ? 'Stop workspace' : '停止工作区'}
                </Button>}
                <Button type="button" variant="ghost" size="sm" disabled={busy || inspecting || !managedApiRef.current} onClick={() => void chooseExecutable()}>
                  {isEn ? 'Choose installed client' : '选择已安装客户端'}
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy || inspecting} onClick={() => void inspect()}>
                  <RefreshCw className="h-3 w-3" />{isEn ? 'Refresh workspace' : '重新检测工作区'}
                </Button>
              </div>
            </>}
            {activity === 'authorize' && (
              <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                {isEn ? 'Complete sign-in in the official client authorization page. You can cancel this authorization below.' : '请在官方客户端授权页面完成登录。可使用下方按钮取消本次授权。'}
              </p>
            )}
            {sharedAuthentication && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground" role="note">
                {capability?.connected
                  ? (isEn ? 'Crew and the local CLI share this sign-in. Switching accounts or disconnecting synchronization affects both clients.' : 'Crew 与本地 CLI 共用此登录信息，切换账号或停止同步会同时影响两者。')
                  : (isEn ? 'Crew and the local CLI share this sign-in. Switching will affect both clients.' : 'Crew 与本地 CLI 共用此登录信息，本次切换会同时影响两者。')}
              </p>
            )}
            {inspectError && !isManaged && (
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground" role="status">
                <span>{isEn ? 'Client detection failed. IDE switching is still available.' : '客户端检测失败，仍可使用原 IDE 切号。'}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void inspect()} disabled={busy || inspecting}>
                  <RefreshCw className="h-3 w-3" />{isEn ? 'Retry' : '重试'}
                </Button>
              </div>
            )}
            {result && (
              <div role={result.success ? 'status' : 'alert'} className={cn('flex items-start gap-2 rounded-lg p-3 text-xs text-foreground', result.success ? 'bg-success/10' : 'bg-destructive/10')}>
                {result.success ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                <span className="break-words">{result.message}</span>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t p-4">
            <Button type="button" variant="ghost" disabled={canceling || (busy && activity !== 'authorize')} onClick={() => void requestClose()}>
              {canceling ? (isEn ? 'Canceling…' : '正在取消…') : activity === 'authorize' ? (isEn ? 'Cancel authorization' : '取消授权') : result?.success ? (isEn ? 'Close' : '关闭') : (isEn ? 'Cancel' : '取消')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? (activity === 'authorize' ? (isEn ? 'Authorizing…' : '正在授权…') : activity === 'configure' ? (isEn ? 'Configuring…' : '正在配置…') : activity === 'disconnect' ? (isEn ? 'Disconnecting…' : '正在停止同步…')
                : activity === 'workspace-start' ? (isEn ? 'Starting workspace…' : '正在启动工作区…')
                : activity === 'workspace-open' ? (isEn ? 'Opening workspace…' : '正在打开工作区…')
                : activity === 'workspace-stop' ? (isEn ? 'Stopping workspace…' : '正在停止工作区…')
                : (isEn ? 'Switching…' : '正在切换…'))
                : isManaged ? canOpenManaged ? (isEn ? 'Open workspace' : '打开工作区') : (isEn ? 'Start and open' : '启动并打开')
                : (isEn ? 'Switch account' : '切换账号')}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
