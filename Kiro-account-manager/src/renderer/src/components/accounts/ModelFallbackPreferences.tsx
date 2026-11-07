import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Save } from 'lucide-react'
import { Button } from '../ui/button'
import { getStoredFallbackChain, isUsableFallbackTarget, type ModelPreferencesSnapshot } from '../../../../shared/modelPreferences'

interface Identity {
  accountId: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  profileArn?: string
}
const sameIdentity = (a: Identity | null, b: Identity): boolean => !!a && a.accountId === b.accountId && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken && a.expiresAt === b.expiresAt && a.profileArn === b.profileArn

export function ModelFallbackPreferences({ identity, isEn }: { identity: Identity; isEn: boolean }) {
  const current = useRef(identity)
  current.current = identity
  const operation = useRef(0)
  const loadedFor = useRef<Identity | null>(null)
  const statusFor = useRef<Identity | null>(null)
  const [snapshot, setSnapshot] = useState<ModelPreferencesSnapshot | null>(null)
  const [target, setTarget] = useState('')
  const [chain, setChain] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    operation.current++
    loadedFor.current = null
    statusFor.current = null
    setSnapshot(null); setTarget(''); setChain([]); setBusy(false); setMessage('')
    return () => { operation.current++ }
  }, [identity.accountId, identity.accessToken, identity.refreshToken, identity.expiresAt, identity.profileArn])
  const apply = (value: ModelPreferencesSnapshot, preferredTarget: string): void => {
    const selected = value.models.some(model => model.id === preferredTarget) ? preferredTarget : value.models[0]?.id ?? ''
    setSnapshot(value); setTarget(selected); setChain(getStoredFallbackChain(value.chains, selected))
  }
  const load = async (): Promise<void> => {
    const expected = current.current
    const sequence = ++operation.current
    statusFor.current = expected
    setBusy(true); setMessage(''); setError(false)
    try {
      const result = await window.api.accountReadModelPreferences(expected.accountId)
      if (sequence !== operation.current || !sameIdentity(expected, current.current)) return
      if (!result.success) { setSnapshot(null); setError(true); setMessage(result.error); return }
      if (result.snapshot.accountId !== expected.accountId) return
      loadedFor.current = expected
      apply(result.snapshot, target)
    } catch {
      if (sequence === operation.current && sameIdentity(expected, current.current)) { setSnapshot(null); setError(true); setMessage(isEn ? 'Could not read preferences. Try again.' : '模型偏好读取未完成，请重试。') }
    } finally { if (sequence === operation.current && sameIdentity(expected, current.current)) setBusy(false) }
  }
  const save = async (): Promise<void> => {
    const expected = current.current
    if (!snapshot || snapshot.accountId !== expected.accountId || !sameIdentity(loadedFor.current, expected) || chain.length > 1) return
    const sequence = ++operation.current
    statusFor.current = expected
    setBusy(true); setMessage(''); setError(false)
    try {
      const result = await window.api.accountSaveModelPreferences({ accountId: expected.accountId, revision: snapshot.revision, targetModelId: target, chain })
      if (sequence !== operation.current || !sameIdentity(expected, current.current)) return
      if (!result.success) { setSnapshot(null); setError(true); setMessage(result.error); return }
      if (result.snapshot.accountId !== expected.accountId) return
      apply(result.snapshot, target)
      setMessage(isEn ? 'Saved and verified for this account.' : '已保存并核对该账户的后备链。')
    } catch {
      if (sequence === operation.current && sameIdentity(expected, current.current)) { setSnapshot(null); setError(true); setMessage(isEn ? 'Save outcome is uncertain. Read preferences again before retrying.' : '保存结果尚不确定，请重新读取后核对，再决定是否保存。') }
    } finally { if (sequence === operation.current && sameIdentity(expected, current.current)) setBusy(false) }
  }
  const visible = snapshot?.accountId === identity.accountId && sameIdentity(loadedFor.current, identity) ? snapshot : null
  const dirty = visible && JSON.stringify(chain) !== JSON.stringify(getStoredFallbackChain(visible.chains, target))
  const eligible = visible?.models.filter(model => model.id !== target && isUsableFallbackTarget(model)) ?? []
  const selectedFallback = chain.length === 1 && eligible.some(model => model.id === chain[0]) ? chain[0] : ''
  const selectClass = 'w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60'
  return <div className="space-y-3 border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold">{isEn ? 'Official Kiro fallback preferences' : '官方 Kiro 后备模型偏好'}</h4>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
        {isEn ? 'Read preferences' : '读取偏好'}
      </Button>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{isEn ? 'Read the account’s preferences, then set one fallback model or clear the saved setting. This setting applies to the official client. The manager proxy does not use it for automatic retries. Models with a consent status cannot be selected as fallbacks.' : '读取账户偏好后，可设置一个后备模型或清除已保存设置。该设置供官方客户端使用，管理器代理不会用它自动重试。带同意状态的模型不可设为后备模型。'}</p>
    {message && sameIdentity(statusFor.current, identity) && <p role={error ? 'alert' : 'status'} className={`text-xs leading-relaxed ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
    {visible && <div className="space-y-3">
      <label className="block space-y-1.5 text-xs font-medium">
        <span>{isEn ? 'Primary model' : '主模型'}</span>
        <select className={selectClass} value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setChain(getStoredFallbackChain(visible.chains, event.target.value)); setMessage('') }}>
          {!visible.models.length && <option value="">{isEn ? 'No available models' : '暂无可用模型'}</option>}
          {visible.models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      </label>
      {chain.length ? <ol className="space-y-2" aria-label={isEn ? 'Ordered fallback chain' : '按顺序使用的后备链'}>
        {chain.map((id, index) => <li key={`${index}:${id}`} className="flex items-center gap-2 text-sm">
          <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1 break-all">{visible.models.find(model => model.id === id)?.name || id}</span>
        </li>)}
      </ol> : <p className="text-xs text-muted-foreground">{isEn ? 'No custom fallback chain.' : '未设置自定义后备链。'}</p>}
      <select aria-label={isEn ? 'Choose fallback model' : '选择后备模型'} className={selectClass} value={selectedFallback} disabled={busy || !target || !eligible.length} onChange={event => { if (event.target.value && eligible.some(model => model.id === event.target.value)) setChain([event.target.value]) }}>
        <option value="" disabled>{isEn ? 'Choose a fallback model…' : '选择后备模型…'}</option>
        {eligible.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={busy || !chain.length} onClick={() => setChain([])}>{isEn ? 'Clear setting' : '清除设置'}</Button>
        <Button size="sm" disabled={busy || !target || !dirty || chain.length > 1} onClick={() => void save()}><Save className="mr-1.5 h-3.5 w-3.5" />{isEn ? 'Save to account' : '保存到账户'}</Button>
      </div>
    </div>}
  </div>
}
