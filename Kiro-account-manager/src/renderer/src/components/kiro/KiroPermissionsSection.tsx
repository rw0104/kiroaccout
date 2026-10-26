import { Button } from '../ui'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Download, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import type { KiroPermissionsState } from '../../../../shared/kiroPermissions'

export interface KiroPermissionsSectionProps {
  state: KiroPermissionsState | null
  loading: boolean
  busy: boolean
  exporting?: boolean
  error: string | null
  notice: string | null
  isEn: boolean
  detailsOpen: boolean
  onToggleDetails: () => void
  onApply: () => void
  onRestore: () => void
  onExport: () => void
  onRetry: () => void
}

export function KiroPermissionsSection({
  state,
  loading,
  busy,
  exporting = false,
  error,
  notice,
  isEn,
  detailsOpen,
  onToggleDetails,
  onApply,
  onRestore,
  onExport,
  onRetry
}: KiroPermissionsSectionProps) {
  const getContentStatusLabel = (
    current: KiroPermissionsState | null
  ): { label: string; detail: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } => {
    if (loading) {
      return {
        label: isEn ? 'Loading...' : '加载中…',
        detail: isEn ? 'Inspecting selected client permissions configuration' : '正在检查所选客户端的权限配置',
        tone: 'neutral'
      }
    }
    if (!current) {
      return {
        label: error ? (isEn ? 'Unable to load' : '读取失败') : (isEn ? 'Not checked' : '尚未检查'),
        detail: isEn
          ? 'The permissions configuration has not been read. Retry to check the selected client.'
          : '尚未读取到权限配置，请重试检查所选客户端。',
        tone: error ? 'danger' : 'neutral'
      }
    }
    if (!current.compatibility.writable) {
      const verifiedReadOnly = current.compatibility.status === 'supported'
      return {
        label: verifiedReadOnly
          ? (isEn ? 'Read-only configuration' : '权限文件只读')
          : (isEn ? 'Compatibility unverified' : '兼容性待确认'),
        detail:
          current.compatibility.reason ||
          (isEn
            ? 'Client version compatibility could not be verified; write operations are disabled.'
            : '当前客户端版本兼容性待确认，已禁用写入与恢复操作。'),
        tone: 'warning'
      }
    }
    switch (current.contentStatus) {
      case 'unconfigured':
        return {
          label: isEn ? 'Unconfigured' : '未配置',
          detail: isEn
            ? 'The permissions file does not exist or has no unconditional auto-approval rules.'
            : '权限文件不存在或不含无条件自动批准规则。',
          tone: 'neutral'
        }
      case 'partial':
        return {
          label: isEn ? 'Partially configured' : '部分配置',
          detail: isEn
            ? 'Only one unconditional auto-approval rule is present; applying will add the missing rule.'
            : '仅存在其中一条无条件自动批准规则；点击应用将补充缺失规则。',
          tone: 'warning'
        }
      case 'configured':
        if (current.restrictions.hasRestrictiveRules) {
          return {
            label: isEn ? 'Both rules present, with restrictions' : '双规则已存在，含限制规则',
            detail: isEn
              ? 'Simultaneous deny, ask, or conditional rules exist; some operations may still prompt or be blocked.'
              : '同时存在 deny、ask 或条件规则，部分操作仍可能提示或被阻止。',
            tone: 'warning'
          }
        }
        return {
          label: isEn ? 'Both rules present' : '双规则已存在',
          detail: isEn
            ? 'Both unconditional auto-approval rules (all and fs_write) are present.'
            : '两条无条件自动批准规则（all 与 fs_write）均已存在。',
          tone: 'success'
        }
      case 'invalid':
        return {
          label: isEn ? 'File cannot be processed' : '文件无法处理',
          detail:
            current.parseError ||
            (isEn
              ? 'Overwrite is disabled. Please back up or repair the existing permissions file first.'
              : '不提供覆盖写入，请先备份或修复原权限文件。'),
          tone: 'danger'
        }
    }
  }

  const getRestoreStatusLabel = (
    current: KiroPermissionsState | null
  ): { label: string; detail: string } => {
    if (!current) {
      return {
        label: isEn ? 'Checking...' : '检查中…',
        detail: ''
      }
    }
    switch (current.restore.status) {
      case 'none':
        return {
          label: isEn ? 'No restore snapshot' : '无可恢复记录',
          detail: isEn
            ? 'Current rules may have been configured manually or have not been written by this manager.'
            : '当前自动批准规则可能是手动配置，或尚未由应用写入。'
        }
      case 'available':
        return {
          label: isEn ? 'Restore available' : '可恢复',
          detail: isEn
            ? 'A pre-write snapshot from this manager is available and matches the current file hash.'
            : '存在本应用最近一次写入前快照，且当前文件哈希与写入后哈希一致。'
        }
      case 'external_modified':
        return {
          label: isEn ? 'Modified externally' : '外部已修改',
          detail: isEn
            ? 'The file was modified externally after this manager applied rules; automatic restore is disabled to avoid overwriting.'
            : '应用写入后文件又被外部修改，不覆盖当前文件，已禁用自动恢复。'
        }
      case 'pending_verification':
      case 'corrupted':
        return {
          label: isEn ? 'Interrupted transaction requires review' : '操作中断待核对',
          detail:
            current.restore.message ||
            (isEn
              ? 'An interrupted write/restore was detected alongside external changes. Backup directory is preserved for manual review.'
              : '检测到上次写入或恢复中断且文件已被外部改动，不自动覆盖，保留备份目录供核对。')
        }
    }
  }

  const contentStatus = getContentStatusLabel(state)
  const restoreStatus = getRestoreStatusLabel(state)

  const canApply = Boolean(
    !loading &&
      !busy &&
      state &&
      state.compatibility.writable &&
      state.contentStatus !== 'invalid' &&
      state.restore.status !== 'pending_verification' &&
      state.restore.status !== 'corrupted' &&
      state.presence.missingRules.length > 0
  )

  const canRestore = Boolean(
    !loading &&
      !busy &&
      state &&
      state.compatibility.writable &&
      state.restore.canRestore &&
      state.restore.status === 'available'
  )

  const badgeToneClass =
    contentStatus.tone === 'success'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
      : contentStatus.tone === 'warning'
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
        : contentStatus.tone === 'danger'
          ? 'bg-destructive/10 text-destructive border-destructive/20'
          : 'bg-muted text-muted-foreground border-border'

  return (
    <div id="kiro-permissions-section" className="border-t pt-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="font-medium">{isEn ? 'Tool auto-approval' : '工具自动批准'}</span>
            <span
              id="kiro-permissions-content-status"
              className={`px-2 py-0.5 text-xs rounded-full border ${badgeToneClass}`}
            >
              {contentStatus.label}
            </span>
            {state && (
              <span
                id="kiro-permissions-restore-status"
                className="px-2 py-0.5 text-xs rounded-full border bg-muted/60 text-muted-foreground"
              >
                {restoreStatus.label}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {isEn
              ? 'Reduces confirmation prompts during tool execution. Built-in protections and restrictive rules may still require confirmation or block execution.'
              : '减少工具执行时的确认提示。部分内置保护和限制规则仍需确认或会阻止执行。'}
          </p>
          <p className="text-xs text-muted-foreground">
            {isEn
              ? 'Allows command execution and file modifications in the selected IDE. CLI V3 supports permissions.yaml; this page manages only the selected IDE configuration.'
              : '允许所选 IDE 执行命令和修改文件。CLI V3 支持 permissions.yaml；此处仅管理所选 IDE 的配置。'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            id="kiro-permissions-apply"
            type="button"
            size="sm"
            disabled={!canApply}
            onClick={onApply}
          >
            {isEn ? 'Apply auto-approval' : '应用自动批准配置'}
          </Button>
          <Button
            id="kiro-permissions-restore"
            type="button"
            variant="outline"
            size="sm"
            disabled={!canRestore}
            onClick={onRestore}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {isEn ? 'Restore previous configuration' : '恢复原配置'}
          </Button>
          <Button
            id="kiro-permissions-export"
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || exporting}
            onClick={onExport}
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {isEn ? 'Export configuration' : '导出配置'}
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>{contentStatus.detail}</p>
        {restoreStatus.detail && <p>{restoreStatus.detail}</p>}
      </div>

      {state?.restrictions.hasRestrictiveRules && (
        <div
          id="kiro-permissions-restrictions-warning"
          className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              {isEn
                ? 'Restrictive rules detected in the current file; restrictions in other scopes may also apply'
                : '检测到当前文件中的限制规则；其他作用域也可能存在限制'}
            </p>
            <p className="mt-0.5">
              {isEn
                ? `deny: ${state.restrictions.denyCount}, ask: ${state.restrictions.askCount}, conditional allow: ${state.restrictions.scopedAllowCount}`
                : `deny 规则：${state.restrictions.denyCount} 条，ask 规则：${state.restrictions.askCount} 条，条件性 allow 规则：${state.restrictions.scopedAllowCount} 条`}
            </p>
          </div>
        </div>
      )}

      {state && state.restrictions.unknownRuleCount > 0 && (
        <p id="kiro-permissions-unknown-rules-note" className="text-xs text-muted-foreground">
          {isEn
            ? `Detected ${state.restrictions.unknownRuleCount} rule(s) with unrecognized fields or capabilities; they will be preserved as-is when updating.`
            : `检测到 ${state.restrictions.unknownRuleCount} 条包含未识别字段或能力的规则，更新时将原样保留。`}
        </p>
      )}

      {notice && (
        <div
          id="kiro-permissions-notice"
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div
          id="kiro-permissions-error"
          role="alert"
          className="flex items-center gap-2 p-2.5 rounded-lg bg-destructive/10 text-destructive text-xs"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button
            id="kiro-permissions-retry"
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || busy}
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {isEn ? 'Retry' : '重试'}
          </Button>
        </div>
      )}

      <div>
        <button
          id="kiro-permissions-details-toggle"
          type="button"
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <span>{isEn ? 'View details' : '查看详情'}</span>
          {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {detailsOpen && state && (
          <div id="kiro-permissions-details" className="mt-2 p-3 rounded-lg bg-muted/40 border text-xs space-y-1.5">
            <div>
              <span className="font-medium">{isEn ? 'Target client: ' : '当前设置对象：'}</span>
              <span>{state.target.label}</span>
            </div>
            <div>
              <span className="font-medium">{isEn ? 'Permissions file path: ' : '目标权限文件路径：'}</span>
              <span className="font-mono break-all">{state.target.permissionsPath}</span>
            </div>
            <div>
              <span className="font-medium">{isEn ? 'Client version compatibility: ' : '客户端版本兼容性：'}</span>
              <span>
                {state.compatibility.ideVersion
                  ? `${state.compatibility.ideVersion}${state.compatibility.reason ? ` (${state.compatibility.reason})` : ''}`
                  : state.compatibility.reason || state.compatibility.status}
              </span>
            </div>
            <div>
              <span className="font-medium">{isEn ? 'Managed rules: ' : '自动批准规则条目：'}</span>
              <span>
                {isEn
                  ? 'Unconditional allow: all and allow: fs_write'
                  : '无条件 allow: all 与 allow: fs_write（缺失：' +
                    (state.presence.missingRules.length > 0
                      ? state.presence.missingRules.join(', ')
                      : '无') +
                    '）'}
              </span>
            </div>
            {state.restore.addedRules && state.restore.addedRules.length > 0 && (
              <div>
                <span className="font-medium">{isEn ? 'Rules added in last apply: ' : '最近一次写入补充的规则：'}</span>
                <span className="font-mono">{state.restore.addedRules.join(', ')}</span>
              </div>
            )}
            {state.restore.backupDir && (
              <div>
                <span className="font-medium">{isEn ? 'Backup directory: ' : '备份目录：'}</span>
                <span className="font-mono break-all">{state.restore.backupDir}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
