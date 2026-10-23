import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '../ui'
import {
  X,
  FileJson,
  FileText,
  Table,
  Clipboard,
  Check,
  Download,
  Key,
  Braces,
  AlertTriangle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account } from '@/types/account'
import { createAccountExport } from '../../../../shared/accountExport'
import type { AccountExportFormat, AccountExportScope } from '../../../../shared/accountExport'

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  /** Candidate selection from the caller; the complete collection comes from the store. */
  accounts: Account[]
  selectedCount: number
}

export function ExportDialog({
  open,
  onClose,
  accounts,
  selectedCount
}: ExportDialogProps): ReactElement | null {
  const [selectedFormat, setSelectedFormat] = useState<AccountExportFormat>('json')
  const [scope, setScope] = useState<AccountExportScope>('all')
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedCount, setCopiedCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const allAccounts = useAccountsStore((state) => state.accounts)
  const groups = useAccountsStore((state) => state.groups)
  const tags = useAccountsStore((state) => state.tags)
  const appVersion = useAccountsStore((state) => state.appVersion)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const hasSelection = selectedCount > 0

  useEffect(() => {
    if (open) {
      setScope(hasSelection ? 'selected' : 'all')
      setIncludeCredentials(false)
      setSelectedFormat('json')
      setCopied(false)
      setError('')
    }
  }, [open, hasSelection])

  if (!open) return null

  const selectedIds = hasSelection ? accounts.map((account) => account.id) : []
  const selectionMismatch = scope === 'selected' && selectedCount !== new Set(selectedIds).size
  const result = createAccountExport({
    accounts: [...allAccounts.values()],
    groups: [...groups.values()],
    tags: [...tags.values()],
    selectedIds,
    scope,
    format: selectedFormat,
    includeCredentials,
    appVersion
  })
  const validationError = selectionMismatch
    ? isEn
      ? 'The selection changed. Close this dialog and select accounts again.'
      : '选择数量已变化，请关闭窗口后重新选择账户。'
    : !result.ok
      ? isEn
        ? 'Export could not be prepared. Check the selected accounts, authentication fields, groups and tags.'
        : result.message
      : ''

  const formats: { id: AccountExportFormat; name: string; icon: typeof FileJson; desc: string }[] =
    [
      {
        id: 'json',
        name: isEn ? 'Backup JSON' : '完整备份 JSON',
        icon: FileJson,
        desc: isEn ? 'Accounts, groups and tags' : '保留账户、分组与标签关系'
      },
      {
        id: 'oidc',
        name: isEn ? 'Credential JSON' : '精简凭证 JSON',
        icon: Braces,
        desc: isEn ? 'Provider, auth method and region' : '保留登录方式、认证方式与区域'
      },
      {
        id: 'kami',
        name: isEn ? 'Card Key' : '卡密',
        icon: Key,
        desc: isEn ? 'Requires credentials' : '仅在包含凭证模式下可用'
      },
      { id: 'txt', name: 'TXT', icon: FileText, desc: isEn ? 'Text account list' : '文本账户列表' },
      {
        id: 'csv',
        name: 'CSV',
        icon: Table,
        desc: isEn ? 'Spreadsheet compatible' : '兼容电子表格'
      },
      {
        id: 'clipboard',
        name: isEn ? 'Clipboard' : '剪贴板',
        icon: Clipboard,
        desc: isEn ? 'Copy a text list' : '复制文本列表'
      }
    ]

  const handleExport = async (copyOnly = false): Promise<void> => {
    if (inFlight.current || validationError || !result.ok) return
    // Use this validated snapshot for both the advertised count and output bytes.
    inFlight.current = true
    setBusy(true)
    setCopied(false)
    setError('')
    try {
      if (copyOnly || selectedFormat === 'clipboard') {
        await navigator.clipboard.writeText(result.content)
        setCopiedCount(result.count)
        setCopied(true)
      } else {
        const success = await window.api.exportToFile(result.content, result.filename)
        if (success) {
          alert(isEn ? `Exported ${result.count} accounts` : `已导出 ${result.count} 个账户`)
          onClose()
        }
      }
    } catch {
      setError(
        isEn
          ? 'Export failed. No success was confirmed; check file access or clipboard permissions and retry.'
          : '导出失败，尚未确认成功。请检查文件写入或剪贴板权限后重试。'
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const changeCredentials = (checked: boolean): void => {
    setIncludeCredentials(checked)
    setCopied(false)
    setError('')
    if (!checked && selectedFormat === 'kami') setSelectedFormat('json')
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-export-title"
    >
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <div className="relative bg-background rounded-xl shadow-2xl w-full max-w-[520px] max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            <h2 id="account-export-title" className="text-lg font-semibold">
              {isEn ? 'Export Accounts' : '导出账户'}
            </h2>
            <Badge variant="secondary">
              {result.count} {isEn ? 'accounts' : '个账户'}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-8 w-8 p-0"
            onClick={onClose}
            aria-label={isEn ? 'Close' : '关闭'}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-6 space-y-4">
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-sm font-medium mb-2">
              {isEn ? 'Export scope' : '导出范围'}
            </legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="export-scope"
                  checked={scope === 'all'}
                  onChange={() => {
                    setScope('all')
                    setCopied(false)
                  }}
                />
                {isEn ? `All ${allAccounts.size} accounts` : `全部 ${allAccounts.size} 个账户`}
              </label>
              <label
                className={cn(
                  'flex items-center gap-2',
                  hasSelection ? 'cursor-pointer' : 'text-muted-foreground'
                )}
              >
                <input
                  type="radio"
                  name="export-scope"
                  disabled={!hasSelection}
                  checked={scope === 'selected'}
                  onChange={() => {
                    setScope('selected')
                    setCopied(false)
                  }}
                />
                {isEn
                  ? `Selected ${selectedIds.length} accounts`
                  : `选中 ${selectedIds.length} 个账户`}
              </label>
            </div>
          </fieldset>

          <label className="flex items-start gap-2 p-3 bg-muted rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={includeCredentials}
              disabled={busy}
              onChange={(event) => changeCredentials(event.target.checked)}
              className="w-4 h-4 mt-0.5 rounded"
            />
            <span>
              <span className="block text-sm font-medium">
                {isEn ? 'Include login credentials (sensitive)' : '包含登录凭证（敏感）'}
              </span>
              <span className="block text-xs text-muted-foreground">
                {isEn
                  ? 'Opt in to export tokens, client secrets and saved passwords in plain text.'
                  : '勾选后会以明文导出 Token、客户端密钥和已保存的密码。'}
              </span>
            </span>
          </label>

          <div
            className={cn(
              'p-3 rounded-lg text-xs flex gap-2',
              includeCredentials
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p>
              {includeCredentials
                ? isEn
                  ? 'Anyone with this file or clipboard content may access your accounts. Store it securely and never share it publicly. Credential validity still depends on the upstream service.'
                  : '取得文件或剪贴板内容的人可能访问你的账户。请妥善保存，不要公开分享；凭证是否有效仍取决于上游服务。'
                : isEn
                  ? 'Credential-free export keeps account information such as email, groups and tags. It cannot restore login or refresh tokens; sign in again after import.'
                  : '无凭证导出仍保留邮箱、分组和标签等账户资料。它无法恢复登录或刷新 Token，导入后需要重新登录。'}
            </p>
          </div>

          <fieldset disabled={busy} className="grid grid-cols-2 gap-3">
            <legend className="sr-only">{isEn ? 'Export format' : '导出格式'}</legend>
            {formats.map((format) => {
              const Icon = format.icon
              const selected = selectedFormat === format.id
              return (
                <button
                  key={format.id}
                  type="button"
                  disabled={format.id === 'kami' && !includeCredentials}
                  onClick={() => {
                    setSelectedFormat(format.id)
                    setCopied(false)
                    setError('')
                  }}
                  className={cn(
                    'p-3 rounded-lg border-2 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-muted-foreground/30'
                  )}
                >
                  <span className="flex items-center gap-2 mb-1">
                    <Icon className={cn('h-4 w-4', selected && 'text-primary')} />
                    <span className={cn('font-medium text-sm', selected && 'text-primary')}>
                      {format.name}
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">{format.desc}</span>
                </button>
              )
            })}
          </fieldset>

          {selectedFormat === 'oidc' && (
            <p className="text-xs text-muted-foreground">
              {includeCredentials
                ? isEn
                  ? 'JSON supports Builder ID, Google, GitHub and enterprise identities. Import through Add Account → OIDC batch import.'
                  : 'JSON 支持 Builder ID、Google、GitHub 和企业身份，可用于「添加账户 → OIDC 批量导入」。'
                : isEn
                  ? 'This is a metadata-only JSON array, not login credentials.'
                  : '当前导出的是无凭证 JSON 摘要，不可作为登录凭证导入。'}
            </p>
          )}
          {!['json', 'oidc'].includes(selectedFormat) && includeCredentials && (
            <p className="text-xs text-muted-foreground">
              {isEn
                ? 'Use JSON for reliable migration across login methods and regions; text formats carry fewer fields.'
                : '跨登录方式和区域迁移请使用 JSON；文本格式包含的字段较少。'}
            </p>
          )}
          {(validationError || error) && (
            <p role="alert" className="text-sm text-destructive">
              {validationError || error}
            </p>
          )}
          {copied && (
            <p role="status" className="text-sm text-green-600">
              {isEn ? `Copied ${copiedCount} accounts` : `已复制 ${copiedCount} 个账户`}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {isEn ? 'Close' : '关闭'}
          </Button>
          {(selectedFormat === 'kami' ||
            selectedFormat === 'oidc' ||
            selectedFormat === 'json') && (
            <Button
              variant="outline"
              disabled={busy || Boolean(validationError)}
              onClick={() => {
                void handleExport(true)
              }}
            >
              <Clipboard className="h-4 w-4 mr-2" />
              {isEn ? 'Copy' : '复制'}
            </Button>
          )}
          <Button
            disabled={busy || Boolean(validationError)}
            onClick={() => {
              void handleExport()
            }}
          >
            {copied ? <Check className="h-4 w-4 mr-2" /> : <Download className="h-4 w-4 mr-2" />}
            {busy
              ? isEn
                ? 'Exporting…'
                : '正在导出…'
              : selectedFormat === 'clipboard'
                ? isEn
                  ? 'Copy'
                  : '复制到剪贴板'
                : isEn
                  ? 'Export file'
                  : '导出文件'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
