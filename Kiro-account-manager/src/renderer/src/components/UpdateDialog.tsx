import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, RefreshCw, CheckCircle, AlertCircle, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { AppUpdateState } from '../../../main/appUpdater'
import { acknowledgeUpdateSave, subscribeUpdateState } from '../lib/updateClient'
import { formatReleaseNotes } from '../lib/releaseNotes'

type ReleaseBlock =
  | { kind: 'heading' | 'paragraph' | 'code'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }

function releaseBlocks(text: string, original?: string): ReleaseBlock[] {
  // HTML still passes through the existing inert text formatter. These strings
  // only recover heading roles; no remote HTML or attributes enter the React tree.
  const headings = new Set(typeof original === 'string'
    ? [...original.matchAll(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi)].slice(0, 100).map(match => formatReleaseNotes(match[0]))
    : [])
  const blocks: ReleaseBlock[] = []
  let paragraph: string[] = [], code: string[] | undefined
  const flush = (): void => {
    if (paragraph.length) { blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = [] }
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      flush()
      if (code) { blocks.push({ kind: 'code', text: code.join('\n') }); code = undefined } else code = []
      continue
    }
    if (code) { code.push(line); continue }
    const trimmed = line.trim()
    if (!trimmed) { flush(); continue }
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(trimmed)
    if (heading || headings.has(trimmed)) {
      flush(); blocks.push({ kind: 'heading', text: heading?.[1] || trimmed }); continue
    }
    const item = /^(?:([-*•])|(\d+)[.)])\s+(.+)$/.exec(trimmed)
    if (item) {
      flush()
      const ordered = !!item[2], previous = blocks.at(-1)
      if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(item[3])
      else blocks.push({ kind: 'list', ordered, start: ordered ? Number(item[2]) : 1, items: [item[3]] })
      continue
    }
    paragraph.push(line)
  }
  flush()
  if (code) blocks.push({ kind: 'code', text: code.join('\n') })
  return blocks
}

function releaseInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded border px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1, -1)}</code>
    return part
  })
}

export function UpdateDialog(): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const notifiedVersion = useRef<string | undefined>(undefined)
  const actionBusy = useRef(false)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const releaseNotes = useMemo(() => formatReleaseNotes(state?.releaseNotes), [state?.releaseNotes])
  const notes = useMemo(() => releaseBlocks(releaseNotes, state?.releaseNotes), [releaseNotes, state?.releaseNotes])

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
      void acknowledgeUpdateSave(requestId, () => useAccountsStore.getState().saveAccountChanges(requestId), window.api.confirmAppUpdateSave)
    })
    return () => { stateCleanup(); showCleanup(); saveCleanup() }
  }, [])

  const run = async (operation: 'check' | 'download' | 'install'): Promise<void> => {
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
          : status === 'error' ? state?.errorStage === 'download' ? (isEn ? 'Download incomplete' : '下载未完成')
            : state?.errorStage === 'install' ? (isEn ? 'Installation incomplete' : '安装未完成')
              : (isEn ? 'Could not check for updates' : '无法检查更新')
          : (isEn ? 'Software updates' : '软件更新')
  const error = requestError || state?.error
  const formatBytes = (bytes: number): string => {
    const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
    return safe >= 1048576 ? `${(safe / 1048576).toFixed(1)} MB` : `${(safe / 1024).toFixed(0)} KB`
  }
  const percentage = Number.isFinite(state?.progress?.percent) ? Math.min(100, Math.max(0, state!.progress!.percent)) : 0
  const showNotes = ['available', 'downloading', 'downloaded'].includes(status)
  const HeaderIcon = status === 'error' ? AlertCircle : ['downloaded', 'not-available'].includes(status) ? CheckCircle : ['available', 'downloading'].includes(status) ? Download : RefreshCw
  const actionClass = 'min-h-11 whitespace-normal sm:min-h-9'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (status !== 'installing') setOpen(false) }} />
      <div data-testid="app-update-panel" className="relative rounded-xl bg-card border shadow-xl w-full max-w-xl m-4 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <header data-testid="app-update-header" className="shrink-0 border-b p-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${status === 'error' ? 'text-destructive' : 'text-primary'}`} aria-hidden="true"><HeaderIcon className="h-5 w-5" /></span>
              <h2 className="font-semibold text-xl leading-tight">{title}</h2>
            </div>
            <button type="button" aria-label={isEn ? 'Close' : '关闭'} disabled={status === 'installing'} onClick={() => setOpen(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 sm:h-9 sm:w-9"><X className="h-5 w-5" /></button>
          </div>
          <div className="mt-4 flex min-w-0 items-center gap-3" role="group" aria-label={isEn ? 'Version comparison' : '版本对比'}>
            <div className="min-w-0 flex-1 rounded-lg border px-3 py-2.5">
              <p className="text-sm text-muted-foreground">{isEn ? 'Current version' : '当前版本'}</p>
              <p className="mt-1 break-all font-medium text-base tabular-nums">{state?.currentVersion || '…'}</p>
            </div>
            {state?.version && <>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1 rounded-lg border px-3 py-2.5">
                <p className="text-sm text-muted-foreground">{isEn ? 'New version' : '新版本'}</p>
                <p className="mt-1 break-all font-semibold text-lg text-primary tabular-nums">{state.version}</p>
              </div>
            </>}
          </div>
        </header>
        <div data-testid="app-update-body" className="min-h-0 overflow-y-auto overscroll-contain p-5 sm:px-6 space-y-5">
          {status === 'disabled' && <p className="text-sm leading-relaxed text-muted-foreground">{isEn ? 'In-app installation is available in the Windows release build.' : '开发环境和未支持的平台不启用更新安装。'}</p>}
          {status === 'idle' && <p className="text-sm leading-relaxed text-muted-foreground">{isEn ? 'Check for a stable release. You choose when to download and install it.' : '检查新的正式版本，由你决定何时下载和安装。'}</p>}
          {status === 'checking' && <p className="flex items-center gap-2 text-sm" role="status"><RefreshCw className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />{isEn ? 'Checking for updates…' : '正在检查更新…'}</p>}
          {status === 'not-available' && <p className="flex items-center gap-2 text-sm" role="status"><CheckCircle className="h-4 w-4 shrink-0 text-success" />{isEn ? 'No newer stable version is available.' : '当前没有更新的正式版本。'}</p>}
          {status === 'downloading' && <section className="space-y-3" aria-label={isEn ? 'Download progress' : '下载进度'}>
            <div className="flex items-baseline justify-between gap-3 text-sm"><span>{isEn ? 'Download progress' : '下载进度'}</span><span className="font-semibold text-lg tabular-nums">{percentage.toFixed(1)}%</span></div>
            <Progress value={percentage} indicatorClassName="bg-primary" role="progressbar" aria-label={isEn ? 'Download progress' : '下载进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} />
            {state?.progress && <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums"><span>{formatBytes(state.progress.transferred)} / {formatBytes(state.progress.total)}</span><span>{formatBytes(state.progress.bytesPerSecond)}/s</span></div>}
            <p className="text-sm text-muted-foreground">{isEn ? 'You can close this panel; the download continues.' : '可以关闭此面板，下载会继续。'}</p>
          </section>}
          {status === 'downloaded' && <div className="flex items-start gap-3 text-sm leading-relaxed" role="status"><CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-success" /><p>{isEn ? 'The package is verified. Confirm to save account data, then restart and install.' : '更新包已通过校验。确认后会先保存账户资料，再重启并安装。'}</p></div>}
          {status === 'installing' && <div className="flex items-start gap-3 text-sm leading-relaxed" role="status"><RefreshCw className="mt-0.5 h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" /><p>{isEn ? 'Saving account data and preparing installation. Keep this window open until preparation finishes.' : '正在保存账户资料并准备安装，准备完成前请保持此窗口开启。'}</p></div>}
          {error && <div className="flex items-start gap-3 text-sm leading-relaxed text-destructive" role="alert"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0" /><p className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</p></div>}
          {showNotes && <section aria-labelledby="app-update-notes-title" className="min-w-0 space-y-3">
            <h3 id="app-update-notes-title" className="text-sm font-semibold">{isEn ? 'What’s new' : '更新内容'}</h3>
            {notes.length ? <div data-testid="app-update-notes" className="min-w-0 rounded-lg bg-muted/50 p-4 text-sm leading-7 [overflow-wrap:anywhere] space-y-4">
              {notes.map((block, index) => block.kind === 'heading'
                ? <h4 key={index} className="font-semibold leading-6">{releaseInline(block.text)}</h4>
                : block.kind === 'list' ? block.ordered
                  ? <ol key={index} start={block.start} className="list-decimal pl-5 space-y-2">{block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1">{releaseInline(item)}</li>)}</ol>
                  : <ul key={index} className="list-disc pl-5 space-y-2">{block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1">{releaseInline(item)}</li>)}</ul>
                : block.kind === 'code' ? <pre key={index} className="whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-xs leading-6">{block.text}</pre>
                : <p key={index} className="whitespace-pre-line">{releaseInline(block.text)}</p>)}
            </div> : <p className="text-sm leading-relaxed text-muted-foreground">{isEn ? 'Release notes are not available for this version.' : '此版本暂无发行说明。'}</p>}
          </section>}
        </div>
        <footer data-testid="app-update-footer" className="shrink-0 border-t p-4 sm:px-6">
          {status === 'available' && <p className="mb-3 text-sm text-muted-foreground">{isEn ? 'Downloading does not install the update automatically.' : '下载完成后，仍需你确认重启和安装。'}</p>}
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button className={actionClass} variant="outline" disabled={status === 'installing'} onClick={() => setOpen(false)}>{isEn ? 'Later' : '稍后'}</Button>
            {status === 'error' && state?.errorStage === 'install' && !state.installRequiresRestart && <Button className={actionClass} variant="outline" onClick={() => window.api.openExternal('https://github.com/rw0104/kiroaccout/releases/latest')}>{isEn ? 'Download installer' : '手动下载安装包'}</Button>}
            {status === 'available' || status === 'error' && state?.errorStage === 'download' ? <Button className={actionClass} disabled={busy} onClick={() => void run('download')}><Download className="h-4 w-4" />{isEn ? 'Download update' : '下载更新'}</Button>
              : state?.installRequiresRestart ? <Button className={actionClass} onClick={() => window.api.openExternal('https://github.com/rw0104/kiroaccout/releases')}>{isEn ? 'Open downloads' : '打开下载页面'}</Button>
                : status === 'downloaded' || status === 'error' && state?.errorStage === 'install' ? <Button className={actionClass} disabled={busy} onClick={() => void run('install')}><RefreshCw className="h-4 w-4" />{isEn ? 'Confirm restart and install' : '确认重启并安装'}</Button>
                : !['disabled', 'downloading', 'installing'].includes(status) && <Button className={actionClass} disabled={busy} onClick={() => void run('check')}>{isEn ? 'Check again' : '重新检查'}</Button>}
          </div>
        </footer>
      </div>
    </div>, document.body
  )
}
