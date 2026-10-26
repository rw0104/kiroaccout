import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Toggle, Select } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { SteeringEditor, McpServerEditor, KiroPermissionsSection } from '../kiro'
import type { KiroMemoryMode, KiroSettingsTarget, KiroSettingsTargetInfo } from '../../../../shared/kiroSettings'
import type { KiroPermissionsState } from '../../../../shared/kiroPermissions'
import type { KiroManagedInstanceView } from '../../../../shared/kiroInstances'
import { 
  FileText, 
  ChevronDown, 
  ChevronUp, 
  Plus, 
  Trash2, 
  RefreshCw,
  ExternalLink,
  FolderOpen,
  Save,
  AlertCircle,
  Edit,
  Sparkles,
  Shield,
  Zap,
  Settings2,
  Terminal
} from 'lucide-react'

interface KiroSettings {
  memory: KiroMemoryMode
  workflowsEnabled: boolean
  agentAutonomy: string
  modelSelection: string
  enableDebugLogs: boolean
  enableTabAutocomplete: boolean
  enableCodebaseIndexing: boolean
  usageSummary: boolean
  codeReferences: boolean
  configureMCP: string
  trustedCommands: string[]
  trustedTools: Record<string, boolean>
  commandDenylist: string[]
  ignoreFiles: string[]
  mcpApprovedEnvVars: string[]
  // 通知设置
  notificationsActionRequired: boolean
  notificationsFailure: boolean
  notificationsSuccess: boolean
  notificationsBilling: boolean
}

interface McpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers: Record<string, McpServer>
}

// 默认禁止的危险命令
const defaultDenyCommands = [
  'rm -rf *',
  'rm -rf /',
  'rm -rf ~',
  'del /f /s /q *',
  'format',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'wget * | sh',
  'curl * | sh',
  'shutdown',
  'reboot',
  'init 0',
  'init 6'
]

// Kiro 默认设置（与 Kiro IDE 内置默认值一致）
const defaultSettings: KiroSettings = {
  memory: 'off',
  workflowsEnabled: false,
  agentAutonomy: 'Autopilot',
  modelSelection: 'auto',
  enableDebugLogs: false,
  enableTabAutocomplete: false,
  enableCodebaseIndexing: false,
  usageSummary: true,
  codeReferences: false,
  configureMCP: 'Enabled',
  trustedCommands: [],
  trustedTools: {},
  commandDenylist: [],
  ignoreFiles: [],
  mcpApprovedEnvVars: [],
  notificationsActionRequired: true,
  notificationsFailure: false,
  notificationsSuccess: false,
  notificationsBilling: true
}

const autonomyOptionsZh = [
  { value: 'Autopilot', label: 'Autopilot (自动执行)', description: 'Agent 自动执行任务' },
  { value: 'Supervised', label: 'Supervised (需确认)', description: '每个步骤需要手动确认' }
]

const autonomyOptionsEn = [
  { value: 'Autopilot', label: 'Autopilot (Auto)', description: 'Agent executes tasks automatically' },
  { value: 'Supervised', label: 'Supervised (Confirm)', description: 'Manual confirmation for each step' }
]

const mcpOptionsZh = [
  { value: 'Enabled', label: '启用', description: '允许 MCP 服务器连接' },
  { value: 'Disabled', label: '禁用', description: '禁用所有 MCP 功能' }
]

const mcpOptionsEn = [
  { value: 'Enabled', label: 'Enabled', description: 'Allow MCP server connections' },
  { value: 'Disabled', label: 'Disabled', description: 'Disable all MCP features' }
]

export function KiroSettingsPage() {
  const [settings, setSettings] = useState<KiroSettings>(defaultSettings)
  const baselineRef = useRef<KiroSettings>(defaultSettings)
  const [targetValue, setTargetValue] = useState('default')
  const targetRef = useRef<KiroSettingsTarget>({ type: 'default' })
  const requestRef = useRef(0)
  const modelRequestRef = useRef(0)
  const resourceRequestRef = useRef(0)
  const permissionsRequestRef = useRef(0)
  const savingRef = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [targetInfo, setTargetInfo] = useState<KiroSettingsTargetInfo | undefined>()
  const [instances, setInstances] = useState<KiroManagedInstanceView[]>([])
  const [instanceError, setInstanceError] = useState<string | null>(null)
  const [mcpConfig, setMcpConfig] = useState<McpConfig>({ mcpServers: {} })
  const [steeringFiles, setSteeringFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [permissionsState, setPermissionsState] = useState<KiroPermissionsState | null>(null)
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [permissionsExporting, setPermissionsExporting] = useState(false)
  const [permissionsError, setPermissionsError] = useState<string | null>(null)
  const [permissionsNotice, setPermissionsNotice] = useState<string | null>(null)
  const [permissionsDetailsOpen, setPermissionsDetailsOpen] = useState(false)
  
  const [expandedSections, setExpandedSections] = useState({
    agent: true,
    mcp: true,
    steering: true,
    commands: false
  })

  const [newTrustedCommand, setNewTrustedCommand] = useState('')
  const [newTrustedToolName, setNewTrustedToolName] = useState('')
  const [newDenyCommand, setNewDenyCommand] = useState('')
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [editingMcp, setEditingMcp] = useState<{ name?: string; server?: McpServer } | null>(null)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const autonomyOptions = isEn ? autonomyOptionsEn : autonomyOptionsZh
  const mcpOptions = isEn ? mcpOptionsEn : mcpOptionsZh
  const isDefaultTarget = targetValue === 'default'
  const dirty = Object.keys(settings).some(key =>
    JSON.stringify(settings[key as keyof KiroSettings]) !== JSON.stringify(baselineRef.current[key as keyof KiroSettings])
  )
  const memoryOptions = [
    { value: 'off', label: isEn ? 'Off' : '关闭' },
    { value: 'useAndLearn', label: isEn ? 'Use and learn' : '使用并学习' },
    { value: 'useWithoutLearning', label: isEn ? "Use but don't learn" : '使用但不自动学习' },
    { value: 'useOnly', label: isEn ? 'Use only (read-only)' : '仅使用（只读）' }
  ]

  useEffect(() => {
    let active = true
    void window.api.kiroInstances.snapshot().then(result => {
      if (!active) return
      if (!result.success) {
        setInstanceError(result.error)
        return
      }
      setInstances(result.value.instances.filter((instance): instance is KiroManagedInstanceView => instance.schemaVersion === 2))
      setInstanceError(null)
    }).catch(() => {
      if (active) setInstanceError(isEn ? 'Could not load managed instances. Default IDE settings remain available.' : '无法加载受管实例，仍可管理默认 IDE 设置。')
    })
    return () => { active = false; requestRef.current++; modelRequestRef.current++; resourceRequestRef.current++; permissionsRequestRef.current++ }
  }, [])

  useEffect(() => {
    void loadKiroSettings()
    void loadAvailableModels()
    void loadKiroPermissions()
  }, [targetValue])

  const changeTarget = (value: string): void => {
    if (savingRef.current || value === targetValue || value !== 'default' && !value.startsWith('instance:')) return
    const nextTarget: KiroSettingsTarget = value === 'default'
      ? { type: 'default' }
      : { type: 'instance', instanceId: value.slice('instance:'.length) }
    if (nextTarget.type === 'instance' && !instances.some(instance => instance.id === nextTarget.instanceId)) return
    requestRef.current++
    modelRequestRef.current++
    resourceRequestRef.current++
    permissionsRequestRef.current++
    targetRef.current = nextTarget
    setTargetValue(value)
    setLoaded(false)
    setLoading(true)
    setSaved(false)
    setError(null)
    setSettings(defaultSettings)
    baselineRef.current = defaultSettings
    setTargetInfo(undefined)
    setAvailableModels([])
    setEditingFile(null)
    setEditingMcp(null)
    setMcpConfig({ mcpServers: {} })
    setSteeringFiles([])
    setPermissionsState(null)
    setPermissionsLoading(true)
    setPermissionsError(null)
    setPermissionsNotice(null)
    setPermissionsDetailsOpen(false)
  }

  const loadAvailableModels = async () => {
    const requestId = ++modelRequestRef.current
    const target = { ...targetRef.current }
    setLoadingModels(true)
    setAvailableModels([])
    try {
      const result = await window.api.getKiroAvailableModels(target)
      if (requestId !== modelRequestRef.current) return
      setAvailableModels(Array.isArray(result.models) ? result.models : [])
    } catch {
      if (requestId === modelRequestRef.current) setAvailableModels([])
    } finally {
      if (requestId === modelRequestRef.current) setLoadingModels(false)
    }
  }

  const loadKiroSettings = async () => {
    if (savingRef.current) return
    const requestId = ++requestRef.current
    const target = { ...targetRef.current }
    setLoading(true)
    setLoaded(false)
    setSaved(false)
    setError(null)
    try {
      const result = await window.api.getKiroSettings(target)
      if (requestId !== requestRef.current) return
      if (result.error || !result.settings) {
        setError(result.error || (isEn ? 'Failed to load Kiro settings' : '加载 Kiro 设置失败'))
        setSettings(defaultSettings)
        setMcpConfig({ mcpServers: {} })
        setSteeringFiles([])
        return
      }
      {
        // 过滤掉 undefined 值，避免覆盖默认值
        const filteredSettings = Object.fromEntries(
          Object.entries(result.settings).filter(([, v]) => v !== undefined)
        ) as Partial<KiroSettings>
        const loadedSettings = { ...defaultSettings, ...filteredSettings }
        baselineRef.current = loadedSettings
        setSettings(loadedSettings)
      }
      setTargetInfo(result.target)
      if (target.type === 'default' && result.mcpConfig) {
        setMcpConfig(result.mcpConfig as McpConfig)
      }
      if (target.type === 'default' && result.steeringFiles) {
        setSteeringFiles(result.steeringFiles)
      }
      setLoaded(true)
    } catch {
      if (requestId === requestRef.current) setError(isEn ? 'Failed to load Kiro settings' : '加载 Kiro 设置失败')
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }

  const loadKiroPermissions = async (duringPermissionWrite = false) => {
    if (savingRef.current && !duringPermissionWrite) return
    const requestId = ++permissionsRequestRef.current
    const target = { ...targetRef.current }
    if (typeof window.api.getKiroPermissions !== 'function') {
      setPermissionsLoading(false)
      return
    }
    setPermissionsLoading(true)
    setPermissionsError(null)
    try {
      const result = await window.api.getKiroPermissions(target)
      if (requestId !== permissionsRequestRef.current) return
      if (!result.success || !result.state) {
        setPermissionsState(null)
        setPermissionsError(result.error || (isEn ? 'Failed to load permissions configuration' : '加载权限配置失败'))
        return
      }
      setPermissionsState(result.state)
    } catch {
      if (requestId === permissionsRequestRef.current) {
        setPermissionsState(null)
        setPermissionsError(isEn ? 'Failed to load permissions configuration' : '加载权限配置失败')
      }
    } finally {
      if (requestId === permissionsRequestRef.current) setPermissionsLoading(false)
    }
  }

  const applyAutoApproval = async () => {
    if (
      savingRef.current ||
      permissionsLoading ||
      !permissionsState ||
      !permissionsState.compatibility.writable ||
      permissionsState.contentStatus === 'invalid' ||
      permissionsState.restore.status === 'pending_verification' ||
      permissionsState.restore.status === 'corrupted' ||
      permissionsState.presence.missingRules.length === 0 ||
      typeof window.api.applyKiroAutoApproval !== 'function'
    ) {
      return
    }
    const target = { ...targetRef.current }
    const expectedRevision = permissionsState.revision
    const generation = permissionsRequestRef.current
    savingRef.current = true
    setSaving(true)
    setPermissionsError(null)
    setPermissionsNotice(null)
    try {
      const result = await window.api.applyKiroAutoApproval(target, expectedRevision)
      if (generation !== permissionsRequestRef.current) return
      if (!result.success) {
        if (result.state) setPermissionsState(result.state)
        setPermissionsError(result.error || (isEn ? 'Failed to apply auto-approval configuration' : '应用工具自动批准配置失败'))
        if (result.code === 'REVISION_CONFLICT' || result.code === 'RESTORE_CONFLICT') {
          // Keep the write lock until this operation's refresh has finished.
          await loadKiroPermissions(true)
        }
        return
      }
      if (result.state) setPermissionsState(result.state)
      setPermissionsNotice(
        isEn
          ? 'Permissions written to the selected client. Start a new Kiro session to verify.'
          : '已写入所选客户端的权限配置。建议在 Kiro 中新建会话验证生效情况。'
      )
    } catch {
      if (generation === permissionsRequestRef.current) {
        setPermissionsError(isEn ? 'Failed to apply auto-approval configuration' : '应用工具自动批准配置失败')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const restoreAutoApproval = async () => {
    if (
      savingRef.current ||
      permissionsLoading ||
      !permissionsState ||
      !permissionsState.compatibility.writable ||
      !permissionsState.restore.canRestore ||
      permissionsState.restore.status !== 'available' ||
      typeof window.api.restoreKiroAutoApproval !== 'function'
    ) {
      return
    }
    const target = { ...targetRef.current }
    const expectedRevision = permissionsState.revision
    const generation = permissionsRequestRef.current
    savingRef.current = true
    setSaving(true)
    setPermissionsError(null)
    setPermissionsNotice(null)
    try {
      const result = await window.api.restoreKiroAutoApproval(target, expectedRevision)
      if (generation !== permissionsRequestRef.current) return
      if (!result.success) {
        if (result.state) setPermissionsState(result.state)
        setPermissionsError(result.error || (isEn ? 'Failed to restore previous configuration' : '恢复原配置失败'))
        if (result.code === 'REVISION_CONFLICT' || result.code === 'RESTORE_CONFLICT') {
          await loadKiroPermissions(true)
        }
        return
      }
      if (result.state) setPermissionsState(result.state)
      setPermissionsNotice(
        isEn
          ? 'Restored the selected client permissions configuration. Start a new Kiro session to verify.'
          : '已恢复所选客户端的原权限配置。建议在 Kiro 中新建会话验证生效情况。'
      )
    } catch {
      if (generation === permissionsRequestRef.current) {
        setPermissionsError(isEn ? 'Failed to restore previous configuration' : '恢复原配置失败')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const exportAutoApproval = async () => {
    if (savingRef.current || permissionsExporting || typeof window.api.exportKiroAutoApprovalTemplate !== 'function') return
    const generation = permissionsRequestRef.current
    setPermissionsExporting(true)
    setPermissionsError(null)
    setPermissionsNotice(null)
    try {
      const result = await window.api.exportKiroAutoApprovalTemplate()
      if (generation !== permissionsRequestRef.current || result.canceled) return
      if (!result.success) {
        setPermissionsError(result.error || (isEn ? 'Failed to export configuration template' : '导出配置模板失败'))
        return
      }
      setPermissionsNotice(
        isEn
          ? 'Auto-approval configuration template exported.'
          : '已导出工具自动批准配置模板。'
      )
    } catch {
      if (generation === permissionsRequestRef.current) {
        setPermissionsError(isEn ? 'Failed to export configuration template' : '导出配置模板失败')
      }
    } finally {
      setPermissionsExporting(false)
    }
  }

  const refreshSelectedTarget = () => {
    void loadKiroSettings()
    void loadKiroPermissions()
  }

  const saveSettings = async () => {
    if (!loaded || loading || savingRef.current || !dirty) return
    const target = { ...targetRef.current }
    const requestId = requestRef.current
    const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(baselineRef.current[key as keyof KiroSettings])
    ))
    savingRef.current = true
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const result = await window.api.saveKiroSettings(patch, target)
      if (requestId !== requestRef.current) return
      if (!result.success) {
        setError(result.error || (isEn ? 'Failed to save settings' : '保存设置失败'))
        return
      }
      baselineRef.current = { ...baselineRef.current, ...patch }
      setSaved(true)
    } catch {
      if (requestId === requestRef.current) setError(isEn ? 'Failed to save settings' : '保存设置失败')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const openKiroSettingsFile = async () => {
    const requestId = requestRef.current
    // 打开 Kiro settings.json 文件
    try {
      const result = await window.api.openKiroSettingsFile({ ...targetRef.current })
      if (requestId === requestRef.current && !result.success) setError(result.error || (isEn ? 'Could not open settings file' : '无法打开设置文件'))
    } catch {
      if (requestId === requestRef.current) setError(isEn ? 'Could not open settings file' : '无法打开设置文件')
    }
  }

  const openMcpConfig = async (type: 'user' | 'workspace') => {
    if (targetRef.current.type !== 'default') return
    try {
      await window.api.openKiroMcpConfig(type)
    } catch (err) {
      console.error(err)
    }
  }

  const openSteeringFolder = async () => {
    if (targetRef.current.type !== 'default') return
    try {
      await window.api.openKiroSteeringFolder()
    } catch (err) {
      console.error(err)
    }
  }

  const openSteeringFile = (filename: string) => {
    if (targetRef.current.type !== 'default') return
    setEditingFile(filename)
  }

  const openSteeringFileExternal = async (filename: string) => {
    if (targetRef.current.type !== 'default') return
    try {
      await window.api.openKiroSteeringFile(filename)
    } catch (err) {
      console.error(err)
    }
  }

  const refreshDefaultResources = async (generation: number): Promise<void> => {
    if (generation !== requestRef.current || targetRef.current.type !== 'default') return
    const resourceRequest = ++resourceRequestRef.current
    const result = await window.api.getKiroSettings({ type: 'default' })
    if (generation !== requestRef.current || resourceRequest !== resourceRequestRef.current || targetRef.current.type !== 'default') return
    if (result.error) { setError(result.error); return }
    if (result.mcpConfig) setMcpConfig(result.mcpConfig as McpConfig)
    if (result.steeringFiles) setSteeringFiles(result.steeringFiles)
  }

  // Editors may finish after their target has been unmounted. Capture this visit.
  const editorGeneration = requestRef.current
  const onResourceSaved = async (): Promise<void> => {
    try { await refreshDefaultResources(editorGeneration) } catch {
      if (editorGeneration === requestRef.current) setError(isEn ? 'Failed to reload configuration files' : '刷新配置文件失败')
    }
  }

  const createDefaultRules = async () => {
    if (targetRef.current.type !== 'default') return
    const generation = requestRef.current
    try {
      const result = await window.api.createKiroDefaultRules()
      if (generation !== requestRef.current) return
      if (result.success) {
        await refreshDefaultResources(generation)
      } else setError(result.error || (isEn ? 'Failed to create rules' : '创建规则失败'))
    } catch {
      if (generation === requestRef.current) setError(isEn ? 'Failed to create rules' : '创建规则失败')
    }
  }

  const deleteSteeringFile = async (filename: string) => {
    if (targetRef.current.type !== 'default') return
    const generation = requestRef.current
    if (!confirm(isEn ? `Delete "${filename}"? This cannot be undone.` : `确定要删除 "${filename}" 吗？此操作无法撤销。`)) {
      return
    }
    try {
      const result = await window.api.deleteKiroSteeringFile(filename)
      if (generation !== requestRef.current) return
      if (result.success) {
        await refreshDefaultResources(generation)
      } else {
        setError(result.error || (isEn ? 'Failed to delete file' : '删除文件失败'))
      }
    } catch {
      if (generation === requestRef.current) setError(isEn ? 'Failed to delete file' : '删除文件失败')
    }
  }

  const deleteMcpServer = async (name: string) => {
    if (targetRef.current.type !== 'default') return
    const generation = requestRef.current
    if (!confirm(isEn ? `Delete MCP server "${name}"?` : `确定要删除 MCP 服务器 "${name}" 吗？`)) {
      return
    }
    try {
      const result = await window.api.deleteMcpServer(name)
      if (generation !== requestRef.current) return
      if (result.success) {
        await refreshDefaultResources(generation)
      } else {
        setError(result.error || (isEn ? 'Failed to delete server' : '删除服务器失败'))
      }
    } catch {
      if (generation === requestRef.current) setError(isEn ? 'Failed to delete server' : '删除服务器失败')
    }
  }

  const addTrustedCommand = () => {
    if (newTrustedCommand.trim()) {
      setSettings(prev => ({
        ...prev,
        trustedCommands: [...prev.trustedCommands, newTrustedCommand.trim()]
      }))
      setNewTrustedCommand('')
    }
  }

  const removeTrustedCommand = (index: number) => {
    setSettings(prev => ({
      ...prev,
      trustedCommands: prev.trustedCommands.filter((_, i) => i !== index)
    }))
  }

  const addDenyCommand = () => {
    if (newDenyCommand.trim()) {
      setSettings(prev => ({
        ...prev,
        commandDenylist: [...prev.commandDenylist, newDenyCommand.trim()]
      }))
      setNewDenyCommand('')
    }
  }

  const addDefaultDenyCommands = () => {
    setSettings(prev => {
      // 过滤掉已存在的命令
      const newCommands = defaultDenyCommands.filter(
        cmd => !prev.commandDenylist.includes(cmd)
      )
      return {
        ...prev,
        commandDenylist: [...prev.commandDenylist, ...newCommands]
      }
    })
  }

  const removeDenyCommand = (index: number) => {
    setSettings(prev => ({
      ...prev,
      commandDenylist: prev.commandDenylist.filter((_, i) => i !== index)
    }))
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* 页面头部 */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
              <Sparkles className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-primary">{isEn ? 'Kiro Settings' : 'Kiro 设置'}</h1>
              <p className="text-muted-foreground">{isEn ? 'Manage Kiro IDE config, MCP servers and user rules' : '管理 Kiro IDE 的配置、MCP 服务器和用户规则'}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refreshSelectedTarget} disabled={saving} className="bg-background/50 backdrop-blur-sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              {isEn ? 'Refresh' : '刷新'}
            </Button>
            <Button variant="outline" size="sm" onClick={openKiroSettingsFile} disabled={saving} className="bg-background/50 backdrop-blur-sm">
              <ExternalLink className="h-4 w-4 mr-2" />
              {isEn ? 'Open File' : '打开设置文件'}
            </Button>
            <Button size="sm" onClick={saveSettings} disabled={saving || loading || !loaded || !dirty}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save' : '保存设置')}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="space-y-1">
          <label htmlFor="kiro-settings-target" className="text-sm font-medium">{isEn ? 'Settings target' : '设置作用对象'}</label>
          <select
            id="kiro-settings-target"
            value={targetValue}
            disabled={saving}
            onChange={event => changeTarget(event.target.value)}
            aria-describedby="kiro-settings-target-hint"
            className="block min-w-[240px] max-w-full px-3 py-2 rounded-xl border bg-background text-sm disabled:opacity-50"
          >
            <option value="default">{isEn ? 'Default Kiro IDE' : '默认 Kiro IDE'}</option>
            {instances.map(instance => <option key={instance.id} value={`instance:${instance.id}`}>{instance.label}</option>)}
          </select>
        </div>
        <div id="kiro-settings-target-hint" className="flex-1 min-w-[200px] text-sm text-muted-foreground pt-1">
          <p>{isDefaultTarget
            ? (isEn ? 'Changes apply to the default IDE user profile. Managed instances keep their own settings.' : '修改默认 IDE 的用户设置。受管实例使用各自的独立设置。')
            : (isEn ? 'Changes apply only to this managed instance. MCP and Steering editing below is available for the default IDE only.' : '修改仅作用于所选受管实例。MCP 和 Steering 编辑目前仅支持默认 IDE。')}</p>
          {targetInfo && <p className="mt-1 break-all font-mono text-xs">{targetInfo.settingsPath}</p>}
          {instanceError && <p className="mt-1 text-destructive">{instanceError}</p>}
        </div>
      </div>

      {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />{isEn ? 'Loading selected settings...' : '正在加载所选对象的设置…'}</p>}

      {error && (
        <div role="alert" className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
      {saved && !dirty && <p role="status" className="text-sm text-muted-foreground">{isEn ? 'Settings saved to the selected IDE profile.' : '设置已保存至所选 IDE 配置。'}</p>}

      <div className="space-y-6">
      {/* Agent 设置 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('agent')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Settings2 className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'Agent Settings' : 'Agent 设置'}</span>
            </div>
            {expandedSections.agent ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.agent && (
          <CardContent className="space-y-4">
            <fieldset disabled={loading || saving || !loaded} className="space-y-4 disabled:opacity-60">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex-1 min-w-[220px]">
                <label htmlFor="kiro-memory" className="font-medium">{isEn ? 'Memory' : '记忆'}</label>
                <p id="kiro-memory-hint" className="text-sm text-muted-foreground mt-1">{isEn
                  ? 'User-level setting for the selected IDE. Switching to or from Off or Use only applies to new sessions. Switching between the two learning modes applies immediately to local sessions.'
                  : '所选 IDE 的用户级设置。切换关闭或仅使用（只读）需新建会话；在两种学习模式间切换会立即应用到本地会话。'}</p>
              </div>
              <Select
                id="kiro-memory"
                aria-describedby="kiro-memory-hint"
                disabled={loading || saving || !loaded}
                value={settings.memory}
                options={memoryOptions}
                onChange={value => setSettings(prev => ({ ...prev, memory: value as KiroMemoryMode }))}
                className="w-[240px]"
              />
            </div>

            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label htmlFor="kiro-workflows-enabled" className="font-medium">{isEn ? 'Enable Workflows' : '启用工作流'}</label>
                  <p id="kiro-workflows-hint" className="text-sm text-muted-foreground mt-1">{isEn ? 'Allows new workflows in new chat sessions. Existing runs and recipes remain available.' : '在新会话中允许启动工作流。已有运行记录和配方会保留。'}</p>
                </div>
                <Toggle
                  id="kiro-workflows-enabled"
                  aria-describedby="kiro-workflows-hint"
                  disabled={loading || saving || !loaded}
                  checked={settings.workflowsEnabled}
                  onChange={checked => setSettings(prev => ({ ...prev, workflowsEnabled: checked }))}
                />
              </div>
              <p className="text-sm text-muted-foreground">{isEn
                ? 'Choose Only when asked, Only for large tasks, or As much as possible in Use workflows above the parent chat in Kiro. This session preference is separate from the switch here.'
                : '请在 Kiro 主会话上方的 Use workflows 中选择“仅在要求时”“仅复杂任务”或“尽量使用”。会话偏好与此处的总开关分开。'}</p>
              <button type="button" className="text-sm text-primary hover:underline" onClick={() => window.api.openExternal('https://kiro.dev/docs/workflows/')}>{isEn ? 'Workflows guide' : '工作流说明'}</button>
            </div>

            {/* Agent Autonomy */}
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{isEn ? 'Agent Autonomy' : 'Agent 自主模式'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Determines whether the agent will ask for accept/reject at each checkpoint in the workflow.' : '决定 Agent 在工作流的每个检查点是否要求接受/拒绝'}</p>
              </div>
              <Select
                value={settings.agentAutonomy}
                options={autonomyOptions}
                onChange={(value) => setSettings(prev => ({ ...prev, agentAutonomy: value }))}
                className="w-[200px]"
              />
            </div>

            </fieldset>

            {KiroPermissionsSection && (
              <KiroPermissionsSection
                state={permissionsState}
                loading={permissionsLoading}
                busy={saving}
                exporting={permissionsExporting}
                error={permissionsError}
                notice={permissionsNotice}
                isEn={isEn}
                detailsOpen={permissionsDetailsOpen}
                onToggleDetails={() => setPermissionsDetailsOpen(prev => !prev)}
                onApply={applyAutoApproval}
                onRestore={restoreAutoApproval}
                onExport={exportAutoApproval}
              />
            )}

            <fieldset disabled={loading || saving || !loaded} className="space-y-4 disabled:opacity-60">
            {/* Model Selection */}
            <div className="flex items-center justify-between border-t pt-4">
              <div className="flex-1 mr-4">
                <p className="font-medium">{isEn ? 'Model Selection' : '模型选择'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Select model to use for agent operations.' : '选择 Agent 操作使用的模型'}</p>
              </div>
              <div className="flex items-center gap-2">
                {availableModels.length > 0 ? (
                  <Select
                    value={settings.modelSelection}
                    options={availableModels.map(m => ({
                      value: m.id,
                      label: m.name || m.id,
                      description: m.description
                    }))}
                    onChange={(value) => setSettings(prev => ({ ...prev, modelSelection: value }))}
                    className="w-[240px]"
                  />
                ) : (
                  <input
                    type="text"
                    value={settings.modelSelection}
                    onChange={(e) => setSettings(prev => ({ ...prev, modelSelection: e.target.value }))}
                    placeholder="claude-haiku-4.5"
                    className="w-[240px] px-3 py-1.5 rounded-md border bg-background text-sm"
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadAvailableModels}
                  disabled={loadingModels}
                  title={isEn ? 'Refresh models' : '刷新模型列表'}
                >
                  <RefreshCw className={`h-4 w-4 ${loadingModels ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>

            {/* Toggle Options */}
            <div className="border-t pt-4 space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Tab Autocomplete' : 'Tab 自动补全'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Tab Autocomplete allows Kiro Agent to provide code suggestions in the editor as you type.' : 'Tab 自动补全允许 Kiro Agent 在输入时提供代码建议'}</p>
                </div>
                <Toggle
                  checked={settings.enableTabAutocomplete}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableTabAutocomplete: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Usage Summary' : '使用统计'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Display usage summary and elapsed time for agent executions.' : '显示 Agent 执行的用量摘要和耗时'}</p>
                </div>
                <Toggle
                  checked={settings.usageSummary}
                  onChange={(checked) => setSettings(prev => ({ ...prev, usageSummary: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Code References: Reference Tracker' : '代码引用追踪'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Allow Kiro to generate code with code references. Sometimes code generated by Kiro may be similar to publicly available code.' : '允许 Kiro 生成带代码引用的代码。Kiro 生成的代码可能与公开可用代码相似。'}</p>
                </div>
                <Toggle
                  checked={settings.codeReferences}
                  onChange={(checked) => setSettings(prev => ({ ...prev, codeReferences: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Codebase Indexing' : '代码库索引'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Enable Repo Indexing (Experimental). This is an experimental feature which does not work with multi-folder workspaces.' : '启用仓库索引（实验性）。这是一个实验性功能，不支持多文件夹工作区。'}</p>
                </div>
                <Toggle
                  checked={settings.enableCodebaseIndexing}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableCodebaseIndexing: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Debug Logs' : '调试日志'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Enable Kiro Debug Logs in the Output panel.' : '在输出面板启用 Kiro 调试日志'}</p>
                </div>
                <Toggle
                  checked={settings.enableDebugLogs}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableDebugLogs: checked }))}
                />
              </div>
            </div>

            {/* 通知设置 */}
            <div className="border-t pt-4">
              <p className="font-medium mb-3">{isEn ? 'Notifications' : '通知设置'}</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Action Required' : 'Agent: 需要操作'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notification when the agent requires input, e.g. for a shell command.' : 'Agent 需要输入时显示桌面通知，如执行 Shell 命令时'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsActionRequired}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsActionRequired: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Failure' : 'Agent: 失败'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notification when the agent encounters an unexpected failure.' : 'Agent 遇到意外失败时显示桌面通知'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsFailure}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsFailure: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Success' : 'Agent: 成功'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notifications when the agent successfully completes a task.' : 'Agent 成功完成任务时显示桌面通知'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsSuccess}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsSuccess: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Billing' : '账单'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show in-app notifications for billing and usage events (usage resets, low resources, overages).' : '显示账单和用量事件的应用内通知（用量重置、资源不足、超额）'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsBilling}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsBilling: checked }))}
                  />
                </div>
              </div>
            </div>
            </fieldset>
          </CardContent>
        )}
      </Card>

      <fieldset disabled={loading || saving || !loaded} className="space-y-6 disabled:opacity-60">
      {isDefaultTarget && <>
      {/* MCP 设置 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('mcp')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'MCP Servers' : 'MCP 服务器'}</span>
              <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                {Object.keys(mcpConfig.mcpServers).length}
              </span>
            </div>
            {expandedSections.mcp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.mcp && (
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{isEn ? 'Enable MCP' : '启用 MCP'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Allow connections to external tools and data sources' : '允许连接外部工具和数据源'}</p>
              </div>
              <Select
                value={settings.configureMCP}
                options={mcpOptions}
                onChange={(value) => setSettings(prev => ({ ...prev, configureMCP: value }))}
              />
            </div>

            <div className="border-t pt-4">
              <p className="font-medium mb-2">{isEn ? 'Configured MCP Servers' : '已配置的 MCP 服务器'}</p>
              {Object.keys(mcpConfig.mcpServers).length === 0 ? (
                <p className="text-sm text-muted-foreground">{isEn ? 'No MCP servers configured' : '暂无配置的 MCP 服务器'}</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(mcpConfig.mcpServers).map(([name, server]) => (
                    <div key={name} className="flex items-center justify-between p-2 bg-muted rounded-md">
                      <div className="flex-1">
                        <p className="font-medium text-sm">{name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{server.command}</p>
                      </div>
                      <div className="flex gap-1">
                        <button
                          className="p-1 hover:bg-background rounded transition-colors"
                          onClick={() => setEditingMcp({ name, server })}
                          title={isEn ? 'Edit' : '编辑'}
                        >
                          <Edit className="h-4 w-4 text-primary" />
                        </button>
                        <button
                          className="p-1 hover:bg-background rounded transition-colors"
                          onClick={() => deleteMcpServer(name)}
                          title={isEn ? 'Delete' : '删除'}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditingMcp({})}>
                <Plus className="h-4 w-4 mr-2" />
                {isEn ? 'Add MCP Server' : '添加 MCP 服务器'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('user')}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'User MCP Config' : '用户 MCP 配置'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('workspace')}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'Workspace MCP Config' : '工作区 MCP 配置'}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Steering 用户规则 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('steering')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'User Rules (Steering)' : '用户规则 (Steering)'}</span>
              <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                {steeringFiles.length} {isEn ? 'files' : '个文件'}
              </span>
            </div>
            {expandedSections.steering ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.steering && (
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isEn ? 'Steering files define AI assistant behavior rules and context' : 'Steering 文件用于定义 AI 助手的行为规则和上下文'}
            </p>

            {steeringFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{isEn ? 'No steering files' : '暂无 Steering 文件'}</p>
            ) : (
              <div className="space-y-2">
                {steeringFiles.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 bg-muted rounded-md"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-mono flex-1">{file}</span>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => openSteeringFile(file)}
                      title={isEn ? 'Edit internally' : '内部编辑'}
                    >
                      <Edit className="h-4 w-4 text-primary" />
                    </button>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => openSteeringFileExternal(file)}
                      title={isEn ? 'Open externally' : '外部打开'}
                    >
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => deleteSteeringFile(file)}
                      title={isEn ? 'Delete' : '删除'}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={createDefaultRules}>
                <Plus className="h-4 w-4 mr-2" />
                {isEn ? 'Create Rules' : '创建规则文件'}
              </Button>
              <Button variant="outline" size="sm" onClick={openSteeringFolder}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'Open Steering Folder' : '打开 Steering 目录'}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      </>}

      {/* 命令设置 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('commands')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Terminal className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'Command Config' : '命令配置'}</span>
            </div>
            {expandedSections.commands ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.commands && (
          <CardContent className="space-y-6">
            {/* Trusted Commands */}
            <div className="p-4 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="h-4 w-4 text-primary" />
                <p className="font-medium">{isEn ? 'Trusted Commands' : '信任的命令'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'These commands will auto-execute without confirmation' : '这些命令将自动执行，无需确认'}</p>
              <div className="space-y-2">
                {settings.trustedCommands.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeTrustedCommand(index)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTrustedCommand}
                    onChange={(e) => setNewTrustedCommand(e.target.value)}
                    placeholder={isEn ? 'e.g.: npm *' : '如: npm *'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && addTrustedCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addTrustedCommand}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Trusted Tools */}
            <div className="p-4 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="h-4 w-4 text-primary" />
                <p className="font-medium">{isEn ? 'Trusted Tools' : '信任的工具'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'Tools to auto-accept if requested by the Agent. Each tool name maps to a boolean indicating whether it should be trusted.' : '当 Agent 请求使用这些工具时自动批准。每个工具名称对应是否信任的布尔值。'}</p>
              <div className="space-y-2">
                {Object.entries(settings.trustedTools).map(([name, trusted]) => (
                  <div key={name} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{name}</code>
                    <Toggle
                      checked={trusted}
                      onChange={(checked) => setSettings(prev => ({
                        ...prev,
                        trustedTools: { ...prev.trustedTools, [name]: checked }
                      }))}
                    />
                    <Button variant="ghost" size="sm" onClick={() => {
                      setSettings(prev => {
                        const tools = { ...prev.trustedTools }
                        delete tools[name]
                        return { ...prev, trustedTools: tools }
                      })
                    }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTrustedToolName}
                    onChange={(e) => setNewTrustedToolName(e.target.value)}
                    placeholder={isEn ? 'Tool name' : '工具名称'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTrustedToolName.trim()) {
                        setSettings(prev => ({
                          ...prev,
                          trustedTools: { ...prev.trustedTools, [newTrustedToolName.trim()]: true }
                        }))
                        setNewTrustedToolName('')
                      }
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={() => {
                    if (newTrustedToolName.trim()) {
                      setSettings(prev => ({
                        ...prev,
                        trustedTools: { ...prev.trustedTools, [newTrustedToolName.trim()]: true }
                      }))
                      setNewTrustedToolName('')
                    }
                  }}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Command Denylist */}
            <div className="p-4 rounded-lg bg-destructive/5 border border-destructive/20">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="h-4 w-4 text-destructive" />
                <p className="font-medium text-destructive">{isEn ? 'Blocked Commands' : '禁止的命令'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'These commands always require manual confirmation' : '这些命令总是需要手动确认'}</p>
              <div className="space-y-2">
                {settings.commandDenylist.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeDenyCommand(index)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDenyCommand}
                    onChange={(e) => setNewDenyCommand(e.target.value)}
                    placeholder={isEn ? 'e.g.: rm -rf *' : '如: rm -rf *'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && addDenyCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addDenyCommand}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={addDefaultDenyCommands}
                  className="mt-2"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {isEn ? 'Add Default Blocked' : '添加默认禁止命令'}
                </Button>
              </div>
            </div>
          </CardContent>
        )}
      </Card>
      </fieldset>
      </div>

      {/* Steering 文件编辑器 */}
      {isDefaultTarget && editingFile && (
        <SteeringEditor
          filename={editingFile}
          onClose={() => { if (editorGeneration === requestRef.current) setEditingFile(null) }}
          onSaved={onResourceSaved}
        />
      )}

      {/* MCP 服务器编辑器 */}
      {isDefaultTarget && editingMcp && (
        <McpServerEditor
          serverName={editingMcp.name}
          server={editingMcp.server}
          onClose={() => { if (editorGeneration === requestRef.current) setEditingMcp(null) }}
          onSaved={onResourceSaved}
        />
      )}
    </div>
  )
}
