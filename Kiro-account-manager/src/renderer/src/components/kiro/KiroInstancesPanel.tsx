import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Play, RefreshCw, ShieldCheck, Square, Trash2 } from 'lucide-react'
import type { KiroInstanceView, KiroInstancesApi, KiroInstancesSnapshot } from '../../../../shared/kiroInstances'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '../ui'
import { useAccountsStore } from '@/store/accounts'

const labels = { stopped: '未运行', starting: '正在启动', running: '运行中', stopping: '正在关闭', exited: '已退出', unverified: '状态无法确认', error: '操作失败', legacy: '旧版配置' }
const removable = (instance: KiroInstanceView) => !['starting', 'running', 'stopping', 'unverified'].includes(instance.launchStatus)
const BLANK_ACCOUNT_OPTION = '@advanced:blank'

export function KiroInstancesPanel({ api }: { api: KiroInstancesApi }) {
  const [snapshot, setSnapshot] = useState<KiroInstancesSnapshot | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [label, setLabel] = useState('')
  const [executablePath, setExecutablePath] = useState('')
  const [accountId, setAccountId] = useState('')
  const [detachTargetId, setDetachTargetId] = useState('')
  const accounts = useAccountsStore(state => state.accounts)
  const [busy, setBusy] = useState('')
  const active = useRef(true)
  const loading = useRef(false)
  const operation = useRef(false)
  const reload = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    try {
      const result = await api.snapshot()
      if (!active.current) return
      if (result.success) { setSnapshot(result.value); if (result.value.instances.length) setExecutablePath(previous => previous || result.value.instances[0].executablePath) }
      else setError(result.error)
    } finally { loading.current = false }
  }, [api])
  useEffect(() => {
    active.current = true
    const refresh = () => { void reload().catch(() => { if (active.current) setError('无法读取实例状态，请重试。') }) }
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => { active.current = false; clearInterval(timer) }
  }, [reload])

  const perform = async (key: string, action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusy(key); setError(''); setNotice('')
    try { await action() }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally {
      operation.current = false
      if (active.current) { setBusy(''); await reload().catch(() => setError('无法刷新实例状态，请重试。')) }
    }
  }
  const create = () => perform('create', async () => {
    if (!accountId) throw new Error('请选择管理器中的已有账户，或明确选择高级空白实例。')
    const result = await api.create({ label, executablePath, accountId: accountId === BLANK_ACCOUNT_OPTION ? undefined : accountId })
    if (!result.success) throw new Error(result.error)
    if (active.current) { setLabel(''); setAccountId(''); setNotice(result.value.accountId ? '实例已创建。启动时将使用绑定账户，不需要再次登录。' : '空白实例已创建。') }
  })
  const choose = () => perform('choose', async () => {
    const result = await api.chooseExecutable()
    if (!result.success) throw new Error(result.error)
    if (result.value && active.current) setExecutablePath(result.value)
  })
  const act = (instance: KiroInstanceView, action: 'launch' | 'stop' | 'restart' | 'remove' | 'detach') => perform(`${action}:${instance.id}`, async () => {
    if (action === 'stop' || action === 'restart') setNotice('正在请求正常关闭；若 Kiro 提示保存未完成的编辑，请先在对应窗口处理。')
    const result = await api[action](instance.id)
    if (!result.success) throw new Error(result.error)
    if (active.current) {
      setDetachTargetId('')
      setNotice(action === 'detach' ? '已恢复解绑，实例文件全部保留。原账户需要重新授权后才能继续使用。' : action === 'remove' ? '配置已移除，实例文件和账户资料仍保留。' : '')
    }
  })

  return <Card>
    <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Kiro 客户端隔离多开</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm space-y-2">
        <p>多个实例共用一份官方 Kiro 客户端，各自保存账户、配置、扩展和缓存；无需重复安装或创建 Windows 用户。</p>
        <p className="text-muted-foreground">选择 Kiro.exe 和管理器中的已有账户，再创建并启动。每个账户只能绑定一个实例；绑定期间由实例独占凭证续期，管理器不再刷新或切换该账户。系统网络、代理和证书仍共用，这不是安全沙箱。</p>
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {snapshot && !snapshot.supported && <p className="text-sm text-muted-foreground">{snapshot.message}</p>}
      {snapshot?.supported && <>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm space-y-1">实例名称<Input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} placeholder="例如：工作账户" disabled={!!busy} /></label>
          <label className="text-sm space-y-1">绑定已有账户<select className="flex h-9 w-full rounded-lg border border-foreground/15 bg-background px-3 text-sm" value={accountId} onChange={event => setAccountId(event.target.value)} disabled={!!busy}>
            <option value="" disabled>请选择已有账户</option>
            {[...accounts.values()].filter(account => !snapshot.instances.some(instance => instance.schemaVersion === 2 && instance.accountId === account.id)).map(account => <option key={account.id} value={account.id}>{account.nickname || account.email || account.id} · {account.idp}</option>)}
            <option value={BLANK_ACCOUNT_OPTION}>高级：空白实例（需要另行登录）</option>
          </select></label>
          <div className="space-y-1"><label htmlFor="kiro-instance-executable" className="text-sm">共用的官方 Kiro.exe</label>
            <div className="flex gap-2"><Input id="kiro-instance-executable" value={executablePath} onChange={event => setExecutablePath(event.target.value)} placeholder="选择已安装的 Kiro.exe" disabled={!!busy} /><Button variant="outline" onClick={choose} disabled={!!busy}><FolderOpen className="mr-2 h-4 w-4" />选择</Button></div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Button onClick={create} disabled={!!busy || !label.trim() || !executablePath || !accountId}>{busy === 'create' ? '正在验证…' : '创建独立实例'}</Button><Button variant="outline" disabled={!!busy} onClick={() => void perform('refresh', reload)}><RefreshCw className="mr-2 h-4 w-4" />刷新状态</Button></div>
        {snapshot.instances.length === 0 && <p className="py-2 text-sm text-muted-foreground">暂无实例。请选择账户并创建，再点击启动。</p>}
        <div className="space-y-3">{snapshot.instances.map(instance => <div key={instance.id} className="rounded-lg border border-foreground/10 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-medium">{instance.label}</p><p className="text-xs text-muted-foreground">{labels[instance.launchStatus]}{instance.schemaVersion === 2 && instance.pid ? ` · PID ${instance.pid}` : ''}</p></div>
            <div className="flex flex-wrap gap-2">
              {instance.schemaVersion === 2 && <>
                <Button size="sm" disabled={!!busy || !['stopped', 'exited', 'error'].includes(instance.launchStatus)} onClick={() => void act(instance, 'launch')}><Play className="mr-1 h-3.5 w-3.5" />启动</Button>
                <Button size="sm" variant="outline" disabled={!!busy || !instance.canStop} onClick={() => void act(instance, 'stop')}><Square className="mr-1 h-3.5 w-3.5" />停止</Button>
                <Button size="sm" variant="outline" disabled={!!busy || !instance.canRestart} onClick={() => void act(instance, 'restart')}><RefreshCw className="mr-1 h-3.5 w-3.5" />重新启动</Button>
              </>}
              <Button size="sm" variant="outline" disabled={!!busy || !removable(instance)} onClick={() => void act(instance, 'remove')}><Trash2 className="mr-1 h-3.5 w-3.5" />移除配置</Button>
              {instance.schemaVersion === 2 && instance.accountId && ['stopped', 'exited'].includes(instance.launchStatus) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setDetachTargetId(instance.id)}>恢复解绑</Button>}
            </div>
          </div>
          <p className="break-all text-xs text-muted-foreground">{instance.executablePath}</p>
          {instance.schemaVersion === 2 && <p className="break-all text-xs text-muted-foreground">独立数据：{instance.paths.root}</p>}
          {instance.schemaVersion === 2 && instance.accountId && <p className="text-xs text-muted-foreground">绑定账户：{accounts.get(instance.accountId)?.nickname || accounts.get(instance.accountId)?.email || '账户已从管理器移除'}</p>}
          {instance.message && <p role="status" className={`text-sm ${['error', 'unverified'].includes(instance.launchStatus) ? 'text-destructive' : 'text-muted-foreground'}`}>{instance.message}</p>}
          {detachTargetId === instance.id && instance.schemaVersion === 2 && instance.accountId && ['stopped', 'exited'].includes(instance.launchStatus) && <div role="alertdialog" aria-label="确认恢复解绑" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
            <p className="text-sm">仅在正常同步无法完成时使用。恢复解绑不会把未核验的实例凭证写回管理器，全部实例文件会保留，原账户将被标记为需要重新授权。</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!!busy} onClick={() => setDetachTargetId('')}>取消</Button><Button size="sm" disabled={!!busy} onClick={() => void act(instance, 'detach')}>确认解绑并要求重新授权</Button></div>
          </div>}
        </div>)}</div>
        <p className="text-xs text-muted-foreground">停止采用正常关闭，不自动强制结束。无法确认进程归属时会阻止操作；移除配置不会删除资料。账户管理器自身与旧版的数据隔离不属于此功能。</p>
      </>}
    </CardContent>
  </Card>
}
