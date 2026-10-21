import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { KiroInstancesApi, KiroInstancesSnapshot } from '../../../../shared/kiroInstances'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '../ui'

/** The host passes its narrow preload API; this panel cannot create Windows accounts or handle passwords. */
export function KiroInstancesPanel({ api }: { api: KiroInstancesApi }) {
  const [snapshot, setSnapshot] = useState<KiroInstancesSnapshot | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [label, setLabel] = useState('')
  const [sid, setSid] = useState('')
  const [executablePath, setExecutablePath] = useState('')
  const [busy, setBusy] = useState('')
  const active = useRef(true)
  const reload = useCallback(async () => {
    const result = await api.snapshot()
    if (!active.current) return
    if (result.success) setSnapshot(result.value)
    else setError(result.error)
  }, [api])

  useEffect(() => {
    active.current = true
    void reload().catch(() => { if (active.current) setError('无法读取隔离实例配置，请重试。') })
    return () => { active.current = false }
  }, [reload])

  const perform = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key); setError(''); setNotice('')
    try { await action() }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally {
      if (active.current) {
        setBusy('')
        await reload().catch(() => setError('无法刷新实例状态，请重试。'))
      }
    }
  }

  const create = () => perform('create', async () => {
    const result = await api.create({ label, sid, executablePath })
    if (!result.success) throw new Error(result.error)
    if (active.current) { setLabel(''); setSid(''); setExecutablePath(''); setNotice('已添加配置。目标 Windows 用户中的 Kiro 需要使用独立授权的账户登录。') }
  })

  const choose = () => perform('choose', async () => {
    const result = await api.chooseExecutable()
    if (!result.success) throw new Error(result.error)
    if (result.value && active.current) setExecutablePath(result.value)
  })

  const availableUsers = snapshot?.users.filter(user => !snapshot.instances.some(instance => instance.sid.toLowerCase() === user.sid.toLowerCase())) ?? []

  return <Card>
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Kiro 客户端隔离多开</CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm space-y-2">
        <p>使用不同的 Windows 用户隔离 Kiro 的登录缓存、IDE 数据和扩展。每个 Windows 用户只配置一个实例；管理器不会复制账户或凭证。</p>
        <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
          <li>在 Windows“设置 → 账户 → 其他用户”创建独立的普通本地用户，并登录该用户一次以初始化配置目录。</li>
          <li>在目标用户中安装官方 Kiro；安装必须位于该用户的配置目录内，且当前管理器可以读取和验证数字签名。</li>
          <li>回到此处添加配置。点击启动后，在 Windows runas 控制台输入目标用户的密码（不是 PIN）；管理器不接收或保存密码。</li>
        </ol>
        <p className="text-muted-foreground">使用独立授权的账户。机器级策略、网络、代理和证书仍共用；这不是虚拟机隔离，也不会隔离当前账户管理器与旧版资料。</p>
      </div>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {snapshot && !snapshot.supported && <p className="text-sm text-muted-foreground">{snapshot.message}</p>}
      {snapshot?.supported && <>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm space-y-1">实例名称<Input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} placeholder="例如：独立测试环境" disabled={!!busy} /></label>
          <label className="text-sm space-y-1">Windows 用户<select className="flex h-9 w-full rounded-lg border border-foreground/15 bg-background px-3 text-sm" value={sid} onChange={event => { setSid(event.target.value); setExecutablePath('') }} disabled={!!busy}>
            <option value="">{availableUsers.length ? '选择已初始化的独立用户' : '没有可用的独立 Windows 用户'}</option>
            {availableUsers.map(user => <option key={user.sid} value={user.sid}>{user.accountName}</option>)}
          </select></label>
          <div className="md:col-span-2 space-y-1">
            <label htmlFor="kiro-instance-executable" className="text-sm">目标用户的 Kiro.exe</label>
            <div className="flex gap-2"><Input id="kiro-instance-executable" value={executablePath} onChange={event => setExecutablePath(event.target.value)} placeholder="选择目标 Windows 用户安装的 Kiro.exe" disabled={!!busy} /><Button variant="outline" onClick={choose} disabled={!!busy}><FolderOpen className="mr-2 h-4 w-4" />选择</Button></div>
            {sid && <p className="break-all text-xs text-muted-foreground">目标配置目录：{availableUsers.find(user => user.sid === sid)?.profilePath}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={create} disabled={!!busy || !label.trim() || !sid || !executablePath}>{busy === 'create' ? '正在验证…' : '验证并添加实例'}</Button>
          <Button variant="outline" disabled={!!busy} onClick={() => void perform('refresh', reload)}><RefreshCw className="mr-2 h-4 w-4" />刷新用户和配置</Button>
        </div>
        {snapshot.instances.length === 0 && <p className="py-2 text-sm text-muted-foreground">暂无实例。当前 Windows 用户及系统账户不会出现在可选列表中。</p>}
        <div className="space-y-3">{snapshot.instances.map(instance => <div key={instance.id} className="rounded-lg border border-foreground/10 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-medium">{instance.label}</p><p className="text-xs text-muted-foreground">{instance.accountName}</p></div>
            <div className="flex gap-2">
              <Button size="sm" disabled={!!busy || instance.launchStatus === 'awaiting-credentials'} onClick={() => void perform(`launch:${instance.id}`, async () => {
                setNotice('请在系统 runas 窗口输入目标 Windows 用户密码；完成前不要重复启动。取消可关闭该系统窗口。')
                const result = await api.launch(instance.id)
                if (!result.success) throw new Error(result.error)
              })}><Play className="mr-1 h-3.5 w-3.5" />{busy === `launch:${instance.id}` || instance.launchStatus === 'awaiting-credentials' ? '等待系统授权…' : '启动 Kiro'}</Button>
              <Button size="sm" variant="outline" disabled={!!busy || instance.launchStatus === 'awaiting-credentials'} onClick={() => void perform(`remove:${instance.id}`, async () => {
                const result = await api.remove(instance.id)
                if (!result.success) throw new Error(result.error)
                setNotice('已移除管理器中的配置。未停止进程，也未删除 Windows 用户或任何文件。')
              })}><Trash2 className="mr-1 h-3.5 w-3.5" />移除配置</Button>
            </div>
          </div>
          <p className="break-all text-xs text-muted-foreground">{instance.executablePath}</p>
          {instance.message && <p role="status" className={`text-sm ${instance.launchStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{instance.message}</p>}
        </div>)}</div>
        <p className="text-xs text-muted-foreground">这里只记录启动请求，不判断 IDE 是否存活。退出 Kiro 请在对应窗口内操作；移除配置不会删除数据或结束进程。</p>
      </>}
    </CardContent>
  </Card>
}
