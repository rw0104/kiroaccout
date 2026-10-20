import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { AppUpdateState } from '../../../main/appUpdater'
import { acknowledgeUpdateSave, subscribeUpdateState } from '../lib/updateClient'

export function UpdateDialog() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const notifiedVersion = useRef<string | undefined>(undefined)
  const actionBusy = useRef(false)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    const stateCleanup = subscribeUpdateState(window.api, next => {
      setState(next)
      if (next.status === 'available' && next.version !== notifiedVersion.current) {
        notifiedVersion.current = next.version
        setOpen(true)
      }
      if (next.status === 'downloaded' || next.status === 'error' && next.errorStage !== 'check') setOpen(true)
    }, () => setRequestError('无法读取更新状态，请稍后重试'))
    const showCleanup = window.api.onShowAppUpdateDialog(() => setOpen(true))
    const saveCleanup = window.api.onPrepareAppUpdateInstall(requestId => {
      void acknowledgeUpdateSave(requestId, () => useAccountsStore.getState().saveAccountChanges(), window.api.confirmAppUpdateSave)
    })
    return () => { stateCleanup(); showCleanup(); saveCleanup() }
  }, [])

  const run = async (operation: 'check' | 'download' | 'install') => {
    if (actionBusy.current) return
    actionBusy.current = true
    setRequestError(null)
    try {
      const result = operation === 'check' ? await window.api.checkForUpdates()
        : operation === 'download' ? await window.api.downloadUpdate() : await window.api.installUpdate()
      if (result.error) setRequestError(result.error)
      // Use the ordered subscription for state. A delayed action reply must not overwrite a newer event.
    } catch { setRequestError(isEn ? 'Update request failed. Please retry.' : '更新操作失败，请重试。') }
    finally { actionBusy.current = false }
  }

  if (!open) return null
  const status = state?.status || 'idle'
  const busy = ['checking', 'downloading', 'installing'].includes(status)
  const title = status === 'available' ? (isEn ? 'Update available' : '发现新版本')
    : status === 'downloaded' ? (isEn ? 'Ready to install' : '更新已就绪')
      : status === 'downloading' ? (isEn ? 'Downloading update' : '正在下载更新')
        : status === 'installing' ? (isEn ? 'Preparing installation' : '正在保存并准备安装')
          : (isEn ? 'Software updates' : '软件更新')
  const error = requestError || state?.error
  const formatBytes = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (status !== 'installing') setOpen(false) }} />
      <div className="relative rounded-xl bg-card border shadow-xl w-full max-w-md m-4 p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-lg">{title}</h2>
            <p className="text-sm text-muted-foreground">{isEn ? 'Current version' : '当前版本'}：{state?.currentVersion || '…'}{state?.version ? ` → ${state.version}` : ''}</p>
          </div>
          <button type="button" aria-label={isEn ? 'Close' : '关闭'} disabled={status === 'installing'} onClick={() => setOpen(false)} className="p-1 rounded hover:bg-muted disabled:opacity-50"><X className="h-5 w-5" /></button>
        </div>
        {status === 'disabled' && <p className="text-sm text-muted-foreground">{isEn ? 'In-app installation is available in the Windows release build.' : '开发环境和未支持的平台不启用更新安装。'}</p>}
        {status === 'checking' && <p className="flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4 animate-spin" />{isEn ? 'Checking for updates…' : '正在检查更新…'}</p>}
        {status === 'not-available' && <p className="flex items-center gap-2 text-sm"><CheckCircle className="h-4 w-4" />{isEn ? 'No newer stable version is available.' : '当前没有更新的正式版本。'}</p>}
        {state?.releaseNotes && ['available', 'downloading', 'downloaded'].includes(status) && <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded max-h-48 overflow-auto whitespace-pre-wrap">{state.releaseNotes}</div>}
        {status === 'downloading' && <div className="space-y-2">
          <div className="flex justify-between text-sm"><span>{isEn ? 'Download progress' : '下载进度'}</span><span>{(state?.progress?.percent || 0).toFixed(1)}%</span></div>
          <Progress value={state?.progress?.percent || 0} />
          {state?.progress && <p className="text-xs text-muted-foreground">{formatBytes(state.progress.transferred)} / {formatBytes(state.progress.total)} · {formatBytes(state.progress.bytesPerSecond)}/s</p>}
          <p className="text-xs text-muted-foreground">{isEn ? 'You can close this panel; the download continues.' : '可以关闭此面板，下载会继续。'}</p>
        </div>}
        {status === 'downloaded' && <p className="text-sm">{isEn ? 'The package is verified. Confirm to save account data, restart and install.' : '更新包已通过校验。确认后会先保存账户资料，再重启并安装。'}</p>}
        {status === 'installing' && <p className="text-sm">{isEn ? 'Saving account data and preparing installation…' : '正在保存账户资料并准备安装，请稍候…'}</p>}
        {error && <p className="text-sm text-destructive flex items-start gap-2" role="alert"><AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={status === 'installing'} onClick={() => setOpen(false)}>{isEn ? 'Later' : '稍后'}</Button>
          {status === 'available' || status === 'error' && state?.errorStage === 'download' ? <Button disabled={busy} onClick={() => void run('download')}><Download className="h-4 w-4 mr-2" />{isEn ? 'Download update' : '下载更新'}</Button>
            : state?.installRequiresRestart ? <Button onClick={() => window.api.openExternal('https://github.com/rw0104/kiroaccout/releases')}>{isEn ? 'Open downloads' : '打开下载页面'}</Button>
              : status === 'downloaded' || status === 'error' && state?.errorStage === 'install' ? <Button disabled={busy} onClick={() => void run('install')}><RefreshCw className="h-4 w-4 mr-2" />{isEn ? 'Confirm restart and install' : '确认重启并安装'}</Button>
              : !['disabled', 'downloading', 'installing'].includes(status) && <Button disabled={busy} onClick={() => void run('check')}>{isEn ? 'Check again' : '重新检查'}</Button>}
        </div>
      </div>
    </div>, document.body
  )
}
