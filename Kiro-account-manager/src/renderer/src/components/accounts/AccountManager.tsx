import { useState, useEffect, useRef } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountToolbar, type AccountViewMode } from './AccountToolbar'
import { AccountGrid } from './AccountGrid'
import { AccountList } from './AccountList'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { GroupManageDialog } from './GroupManageDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { Button } from '../ui'
import type { Account } from '@/types/account'
import { parseAccountImportText } from '../../../../shared/accountImport'
import { formatImportOutcome } from '../../utils/accountImport'
import { ArrowLeft, Loader2, Users } from 'lucide-react'

interface AccountManagerProps {
  onBack?: () => void
}

export function AccountManager({ onBack }: AccountManagerProps): React.ReactNode {
  const {
    isLoading,
    accounts,
    importAccountPlan,
    selectedIds,
    activeGroupTab,
    groups
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)
  // 视图模式：grid（卡片，默认）/ list（紧凑列表），持久化到 localStorage
  const [viewMode, setViewMode] = useState<AccountViewMode>(() => {
    const saved = localStorage.getItem('accounts_viewMode')
    return saved === 'list' ? 'list' : 'grid'
  })
  useEffect(() => {
    localStorage.setItem('accounts_viewMode', viewMode)
  }, [viewMode])
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 获取要导出的账号列表
  const getExportAccounts = () => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter(acc => selectedIds.has(acc.id))
    }
    return accountList
  }

  // 导出
  const handleExport = (): void => {
    setShowExportDialog(true)
  }

  // 解析 CSV 行（处理引号和逗号）
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    result.push(current.trim())
    return result
  }

  const importInFlight = useRef(false)

  // 导入
  const handleImport = async (): Promise<void> => {
    if (importInFlight.current) return
    importInFlight.current = true
    try {
      const fileData = await window.api.importFromFile()
      if (!fileData) return
      const currentGroupId = groups.has(activeGroupTab) ? activeGroupTab : undefined
      const { content, format } = fileData
      let input = content
      if (format === 'csv') {
        const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())
        if (rows.length < 2) { alert('CSV 文件为空或只有标题行'); return }
        input = JSON.stringify(rows.slice(1).map(line => {
          const cols = parseCSVLine(line)
          return { email: cols[0], nickname: cols[1], provider: cols[2] || undefined,
            refreshToken: cols[3], clientId: cols[4], clientSecret: cols[5], region: cols[6] || 'us-east-1' }
        }))
      } else if (format === 'txt') {
        const lines = content.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
        const structured = /^[\s\uFEFF]*[\[{]/.test(content)
        const card = lines.some(line => line.includes('----') || line.includes('\t') || /\S\s{2,}\S/.test(line))
        if (!structured && !card) {
          input = JSON.stringify(lines.map(line => {
            const parts = (line.includes('|') ? line.split('|') : parseCSVLine(line)).map(value => value.trim())
            return { email: parts[0], refreshToken: parts[1], nickname: parts[2], provider: parts[3] || undefined }
          }))
        }
      } else if (format !== 'json') { alert('不支持的文件格式'); return }
      const plan = parseAccountImportText(input)
      if (!plan.ok) { alert(plan.error?.message || '无法识别账户格式'); return }
      const result = await importAccountPlan(plan, currentGroupId)
      alert(formatImportOutcome(result))
    } catch {
      alert('导入失败，请检查文件或网络状态')
    } finally { importInFlight.current = false }
  }

  // 管理分组
  const handleManageGroups = (): void => {
    setShowGroupDialog(true)
  }

  // 管理标签
  const handleManageTags = (): void => {
    setShowTagDialog(true)
  }

  // 编辑账号
  const handleEditAccount = (account: Account): void => {
    setEditingAccount(account)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">加载账号数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 - 玻璃态（relative z-20 抬升 stacking context，确保下拉菜单浮在卡片之上） */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-3 py-3 glass-toolbar">
        <div className="flex items-center gap-4">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-lg font-semibold text-primary">{isEn ? 'Accounts' : '账户管理'}</h1>
          </div>
        </div>
        
        {/* 工具栏 */}
        <AccountToolbar
          onAddAccount={() => setShowAddDialog(true)}
          onImport={handleImport}
          onExport={handleExport}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onManageGroups={handleManageGroups}
          onManageTags={handleManageTags}
          isFilterExpanded={isFilterExpanded}
          onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
        />
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 py-3 gap-3">
        {/* 账号列表（卡片 或 紧凑列表） */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <AccountGrid
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          ) : (
            <AccountList
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          )}
        </div>
      </div>

      {/* 添加账号对话框 */}
      <AddAccountDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />

      {/* 编辑账号对话框 */}
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* 分组管理对话框 */}
      <GroupManageDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
      />

      {/* 标签管理对话框 */}
      <TagManageDialog
        isOpen={showTagDialog}
        onClose={() => setShowTagDialog(false)}
      />

      {/* 导出对话框 */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
      />
    </div>
  )
}
