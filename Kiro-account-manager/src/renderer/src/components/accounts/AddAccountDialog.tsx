import { useState, useEffect, useRef, useMemo } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { SubscriptionType } from '@/types/account'
import { X, Loader2, Download, Copy, Check, ExternalLink, Info, EyeOff } from 'lucide-react'
import { parseAccountImportText } from '../../../../shared/accountImport'
import type { ImportOutcome } from '../../../../shared/accountImport'
import { startSerialLoginPolling } from '@/lib/loginPolling'
import type { LoginResult } from '../../../../main/loginSessions'
import type { AccountAddOnCredit } from '../../../../shared/accountUsage'

interface AddAccountDialogProps {
  isOpen: boolean
  onClose: () => void
}

interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

interface VerifiedData {
  email: string
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn?: number
  clientSecretExpiresAt?: number
  subscriptionType: string
  subscriptionTitle: string
  subscription?: {
    managementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  usage: { 
    current: number
    limit: number
    baseLimit?: number
    baseCurrent?: number
    freeTrialLimit?: number
    freeTrialCurrent?: number
    freeTrialExpiry?: string
    bonuses?: BonusData[]
    addOnCredits?: AccountAddOnCredit[]
    addOnCurrent?: number
    addOnLimit?: number
    nextResetDate?: string
    resourceDetail?: {
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      overageEnabled?: boolean
    }
  }
  daysRemaining?: number
  expiresAt?: number
}

type ImportMode = 'oidc' | 'sso' | 'login'
type LoginType = 'builderid' | 'google' | 'github' | 'iamsso'
interface LoginAttempt {
  id: string
  kind: 'builderid' | 'iamsso' | 'portal'
  startUrl?: string
  stopPolling?: () => void
  expiryTimer?: ReturnType<typeof setTimeout>
  adding?: boolean
  added?: boolean
  pendingTokenData?: LoginResult
  expectedProvider?: LoginResult['provider']
  tokenExpiresAt?: number
}


export function AddAccountDialog({ isOpen, onClose }: AddAccountDialogProps): React.ReactNode {
  const { addAccount, importAccountPlan, accounts, batchImportConcurrency, loginPrivateMode, groups, activeGroupTab } = useAccountsStore()

  // 检查账户是否已存在（同userId 或 同邮箱+同provider 才算重复）
  const isAccountExists = (email: string, userId: string, provider?: string): boolean => {
    return Array.from(accounts.values()).some(acc => {
      // userId 相同则重复（主要判断依据）
      if (userId && acc.userId === userId) return true
      // email 非空且相同，且 provider 相同则重复（允许同邮箱不同登录方式）
      // 企业账号可能没有 email，所以 email 为空时不用 email 判断
      if (email && acc.email === email && acc.credentials.provider === provider) return true
      return false
    })
  }

  // 导入模式
  const [importMode, setImportMode] = useState<ImportMode>('login')

  // 添加到的目标分组（默认=当前打开的分组，可在弹窗内改）；undefined=未分组（默认分组）
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined)

  // OIDC 凭证输入
  const [refreshToken, setRefreshToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [authMethod, setAuthMethod] = useState<'IdC' | 'social'>('IdC')
  const [provider, setProvider] = useState('BuilderId')  // 'BuilderId', 'Enterprise', 'Github', 'Google'
  const importedRegistrationRef = useRef<{
    clientId: string
    clientSecret: string
    region: string
    clientSecretExpiresAt?: number
  } | null>(null)

  // SSO Token 导入
  const [ssoToken, setSsoToken] = useState('')
  const [batchImportResult, setBatchImportResult] = useState<{ total: number; success: number; failed: number; errors: string[] } | null>(null)

  // OIDC 批量导入
  const [oidcImportMode, setOidcImportMode] = useState<'single' | 'batch'>('single')
  const [oidcBatchData, setOidcBatchData] = useState('')
  const [oidcBatchImportResult, setOidcBatchImportResult] = useState<ImportOutcome | null>(null)
  const oidcBatchPlan = useMemo(() => parseAccountImportText(oidcBatchData), [oidcBatchData])
  const oidcImportControllerRef = useRef<AbortController | null>(null)

  // Closing or unmounting cancels only this dialog's pending import.
  useEffect(() => {
    if (!isOpen) {
      oidcImportControllerRef.current?.abort()
      oidcImportControllerRef.current = null
      setIsSubmitting(false)
    }
    return () => {
      oidcImportControllerRef.current?.abort()
      oidcImportControllerRef.current = null
    }
  }, [isOpen])

  const handleDialogClose = () => {
    oidcImportControllerRef.current?.abort()
    oidcImportControllerRef.current = null
    setIsSubmitting(false)
    cancelLoginAttempt()
    onClose()
  }

  // 验证后的数据（保留用于条件渲染）
  const [verifiedData, setVerifiedData] = useState<VerifiedData | null>(null)

  // 状态
  const [isVerifying, setIsVerifying] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // 登录相关状态
  const [loginType, setLoginType] = useState<LoginType>('builderid')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [loginSavePending, setLoginSavePending] = useState(false)
  const [loginVerifyPending, setLoginVerifyPending] = useState(false)
  const [usePrivateMode, setUsePrivateMode] = useState(loginPrivateMode) // 临时隐私模式开关，默认跟随全局设置
  const [builderIdLoginData, setBuilderIdLoginData] = useState<{
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const loginAttemptRef = useRef<LoginAttempt | null>(null)
  
  // IAM SSO 登录相关状态
  const [ssoStartUrl, setSsoStartUrl] = useState('')
  const [iamSsoLoginData, setIamSsoLoginData] = useState<{
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  } | null>(null)

  const isCurrentLogin = (attempt: LoginAttempt) => loginAttemptRef.current === attempt
  const cancelLoginAttempt = () => {
    const attempt = loginAttemptRef.current
    if (!attempt) return
    // Invalidate synchronously before any IPC can settle.
    loginAttemptRef.current = null
    setLoginVerifyPending(false)
    attempt.stopPolling?.()
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer)
    const cancel = attempt.kind === 'portal' ? window.api.cancelPortalLogin : attempt.kind === 'builderid' ? window.api.cancelBuilderIdLogin
      : window.api.cancelIamSsoLogin
    void cancel(attempt.id).catch(() => {})
  }
  const finishLoginAttempt = (attempt: LoginAttempt) => {
    if (!isCurrentLogin(attempt)) return
    cancelLoginAttempt()
    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setIamSsoLoginData(null)
  }
  const setAttemptExpiry = (attempt: LoginAttempt, seconds: number) => {
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer)
    attempt.expiryTimer = setTimeout(() => {
      if (!isCurrentLogin(attempt)) return
      setError('登录已过期，请重新开始')
      finishLoginAttempt(attempt)
    }, Math.max(1, seconds) * 1000)
  }
  const beginLoginAttempt = (kind: LoginAttempt['kind']): LoginAttempt => {
    cancelLoginAttempt()
    const attempt: LoginAttempt = { id: crypto.randomUUID(), kind }
    loginAttemptRef.current = attempt
    setAttemptExpiry(attempt, 600)
    setIsLoggingIn(true)
    setBuilderIdLoginData(null)
    setIamSsoLoginData(null)
    setError(null)
    setLoginVerifyPending(false)
    return attempt
  }
  useEffect(() => {
    if (!isOpen) {
      cancelLoginAttempt()
      setIsLoggingIn(false)
      setBuilderIdLoginData(null)
      setIamSsoLoginData(null)
    }
    return () => cancelLoginAttempt()
  }, [isOpen])

  // 打开弹窗时默认选中"当前打开的分组"（activeGroupTab 为真实分组时），否则未分组
  useEffect(() => {
    if (!isOpen) return
    const isRealGroup = activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)
    setSelectedGroupId(isRealGroup ? activeGroupTab : undefined)
  }, [isOpen, activeGroupTab, groups])

  // 处理登录成功
  const handleLoginSuccess = async (attempt: LoginAttempt, tokenData: {
    accessToken: string
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    startUrl?: string
    authMethod?: string
    provider?: string
    profileArn?: string
    expiresIn?: number
    clientSecretExpiresAt?: number
  }) => {
    if (!isCurrentLogin(attempt) || attempt.adding) return
    attempt.adding = true
    
    try {
      // 验证凭证并获取账号信息
      const result = await window.api.verifyAccountCredentials({
        refreshToken: tokenData.refreshToken,
        clientId: tokenData.clientId || '',
        clientSecret: tokenData.clientSecret || '',
        clientSecretExpiresAt: tokenData.clientSecretExpiresAt,
        region: tokenData.region || 'us-east-1',
        authMethod: tokenData.authMethod,
        provider: tokenData.provider,
        ...(attempt.kind === 'portal' ? { accessToken: tokenData.accessToken, expiresIn: tokenData.expiresIn, profileArn: tokenData.profileArn } : {})
      })

      if (!isCurrentLogin(attempt)) return
      if (result.success && result.data) {
        const { email, userId } = result.data
        const providerName = tokenData.provider || 'BuilderId'
        
        // 检查账户是否已存在
        if (isAccountExists(email, userId, providerName)) {
          setError(isEn ? 'This account already exists' : '该账号已存在，无需重复添加')
          return
        }
        
        if (!isCurrentLogin(attempt)) return
        // 添加账号
        const now = Date.now()
        addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: providerName as 'BuilderId' | 'Google' | 'Github',
          groupId: selectedGroupId,
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId: tokenData.clientId || '',
            clientSecret: tokenData.clientSecret || '',
            clientSecretExpiresAt: tokenData.clientSecretExpiresAt,
            region: tokenData.region || 'us-east-1',
            startUrl: tokenData.startUrl,
            expiresAt: attempt.kind === 'portal' && attempt.tokenExpiresAt ? attempt.tokenExpiresAt : result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod: tokenData.authMethod as 'IdC' | 'social',
            provider: (tokenData.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google',
            profileArn: result.data.profileArn || tokenData.profileArn
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            rawType: result.data.subscription?.rawType,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0 
              ? result.data.usage.current / result.data.usage.limit 
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            addOnCredits: result.data.usage.addOnCredits,
            addOnCurrent: result.data.usage.addOnCurrent,
            addOnLimit: result.data.usage.addOnLimit,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          tags: [],
          status: 'active',
          lastUsedAt: now
        })

        // Keep the added account in memory if persistence fails; retry saving without exchanging the code again.
        attempt.added = true
        if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer)
        setLoginSavePending(true)
        await useAccountsStore.getState().saveAccountChanges()
        if (!isCurrentLogin(attempt)) return
        setLoginSavePending(false)
        finishLoginAttempt(attempt)
        resetForm()
        handleDialogClose()
      } else {
        setError(result.error || '验证失败')
        if (attempt.kind === 'portal') { attempt.adding = false; setLoginVerifyPending(true) }
      }
    } catch (e) {
      if (isCurrentLogin(attempt)) setError(attempt.added ? '账户已添加到当前会话，但保存失败；可点击重试保存。' : '添加账户失败，请重试。')
      if (isCurrentLogin(attempt) && attempt.kind === 'portal' && !attempt.added) { attempt.adding = false; setLoginVerifyPending(true) }
    }
  }

  const pollLogin = (attempt: LoginAttempt, interval: number) => {
    attempt.stopPolling = startSerialLoginPolling<LoginResult>({
      initialInterval: interval,
      isCurrent: () => isCurrentLogin(attempt),
      poll: () => attempt.kind === 'portal' ? window.api.pollPortalLogin(attempt.id) : attempt.kind === 'builderid' ? window.api.pollBuilderIdAuth(attempt.id) : window.api.pollIamSsoAuth(attempt.id),
      onResult: async (result) => {
        if (!isCurrentLogin(attempt) || result.sessionId !== attempt.id) return null
        if (!result.success) {
          setError(result.error || '授权失败，请重试')
          finishLoginAttempt(attempt)
          return null
        }
        if (result.completed) {
          if (attempt.kind === 'portal' && (
            !result.provider || !['Google', 'Github', 'BuilderId', 'Enterprise'].includes(result.provider) ||
            (attempt.expectedProvider && result.provider !== attempt.expectedProvider) ||
            result.authMethod !== (['Google', 'Github'].includes(result.provider) ? 'social' : 'IdC')
          )) {
            setError('登录方式与授权结果不一致，请重新开始')
            finishLoginAttempt(attempt)
            return null
          }
          if (!result.accessToken || !result.refreshToken) {
            setError('授权响应不完整，请重新开始')
          } else {
            if (attempt.kind === 'portal') {
              attempt.pendingTokenData = { ...result, expiresIn: result.expiresIn }
              attempt.tokenExpiresAt = Date.now() + (result.expiresIn || 0) * 1000
              if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer)
            }
            await handleLoginSuccess(attempt, {
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              region: result.region,
              startUrl: result.startUrl || attempt.startUrl,
              authMethod: attempt.kind === 'portal' ? result.authMethod : 'IdC',
              provider: attempt.kind === 'portal' ? result.provider : attempt.kind === 'builderid' ? 'BuilderId' : 'Enterprise',
              profileArn: result.profileArn,
              expiresIn: result.expiresIn,
              clientSecretExpiresAt: result.clientSecretExpiresAt
            })
          }
          if (isCurrentLogin(attempt) && !attempt.added && !attempt.pendingTokenData) finishLoginAttempt(attempt)
          return null
        }
        return result.retryAfter || result.interval || interval
      },
      onError: () => {
        if (!isCurrentLogin(attempt)) return
        setError('无法查询授权状态，请重新开始')
        finishLoginAttempt(attempt)
      }
    })
  }

  const handleStartPortalLogin = async (expectedProvider?: LoginResult['provider']) => {
    const attempt = beginLoginAttempt('portal')
    attempt.expectedProvider = expectedProvider
    try {
      const result = await window.api.startPortalLogin(attempt.id, usePrivateMode, expectedProvider)
      if (!isCurrentLogin(attempt) || result.sessionId !== attempt.id) return
      if (!result.success) {
        setError(result.error || '无法打开网页登录，请重试')
        finishLoginAttempt(attempt)
        return
      }
      setAttemptExpiry(attempt, result.expiresIn || 600)
      pollLogin(attempt, result.interval || 1)
    } catch {
      if (isCurrentLogin(attempt)) { setError('无法启动网页登录，请重试'); finishLoginAttempt(attempt) }
    }
  }

  const handleStartBuilderIdLogin = async () => {
    const attempt = beginLoginAttempt('builderid')
    try {
      const result = await window.api.startBuilderIdLogin(region, attempt.id)
      if (!isCurrentLogin(attempt) || result.sessionId !== attempt.id) return
      if (result.success && result.userCode && result.verificationUri) {
        setAttemptExpiry(attempt, result.expiresIn || 600)
        setBuilderIdLoginData({ userCode: result.userCode, verificationUri: result.verificationUri, expiresIn: result.expiresIn || 600, interval: result.interval || 5 })
        window.api.openExternal(result.verificationUri, usePrivateMode)
        pollLogin(attempt, result.interval || 5)
      } else {
        setError(result.error || '启动登录失败')
        finishLoginAttempt(attempt)
      }
    } catch {
      if (!isCurrentLogin(attempt)) return
      setError('启动登录失败，请重试')
      finishLoginAttempt(attempt)
    }
  }

  const handleStartIamSsoLogin = async () => {
    if (!ssoStartUrl.trim()) { setError(isEn ? 'Please enter SSO Start URL' : '请输入 SSO Start URL'); return }
    const attempt = beginLoginAttempt('iamsso')
    attempt.startUrl = ssoStartUrl.trim()
    try {
      const result = await window.api.startIamSsoLogin(attempt.startUrl, region, attempt.id)
      if (!isCurrentLogin(attempt) || result.sessionId !== attempt.id) return
      if (result.success && result.authorizeUrl) {
        setAttemptExpiry(attempt, result.expiresIn || 600)
        setIamSsoLoginData({ userCode: '', verificationUri: result.authorizeUrl, expiresIn: result.expiresIn || 600, interval: 3 })
        window.api.openExternal(result.authorizeUrl, usePrivateMode)
        pollLogin(attempt, 3)
      } else {
        setError(result.error || '启动登录失败')
        finishLoginAttempt(attempt)
      }
    } catch {
      if (!isCurrentLogin(attempt)) return
      setError('启动登录失败，请重试')
      finishLoginAttempt(attempt)
    }
  }

  const handleCancelLogin = async () => {
    cancelLoginAttempt()
    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setIamSsoLoginData(null)
    setError(null)
  }

  // Social buttons use the same PKCE loopback flow and bind the selected provider.
  const handleStartSocialLogin = (socialProvider: 'Google' | 'Github') => handleStartPortalLogin(socialProvider)

  const handleRetryLoginSave = async () => {
    setIsSubmitting(true)
    try {
      await useAccountsStore.getState().saveAccountChanges()
      setLoginSavePending(false)
      setError(null)
      const attempt = loginAttemptRef.current
      if (attempt?.added) { finishLoginAttempt(attempt); resetForm(); handleDialogClose() }
    } catch {
      setError('保存失败，账户仍保留在当前会话，请重试。')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRetryPortalVerification = async () => {
    const attempt = loginAttemptRef.current
    const data = attempt?.pendingTokenData
    if (!attempt || !data?.accessToken || !data.refreshToken || attempt.added || attempt.adding) return
    const remaining = Math.floor(((attempt.tokenExpiresAt || 0) - Date.now()) / 1000)
    if (remaining <= 0) { setError('授权凭证已过期，请重新登录'); setLoginVerifyPending(false); finishLoginAttempt(attempt); return }
    setLoginVerifyPending(false)
    await handleLoginSuccess(attempt, { ...data, expiresIn: remaining, accessToken: data.accessToken, refreshToken: data.refreshToken })
  }

  // 复制 user_code
  const handleCopyUserCode = async () => {
    if (builderIdLoginData?.userCode) {
      await navigator.clipboard.writeText(builderIdLoginData.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // 从本地配置导入
  const handleImportFromLocal = async () => {
    try {
      const result = await window.api.loadKiroCredentials()
      if (result.success && result.data) {
        setRefreshToken(result.data.refreshToken)
        setClientId(result.data.clientId)
        setClientSecret(result.data.clientSecret)
        setRegion(result.data.region)
        importedRegistrationRef.current = {
          clientId: result.data.clientId,
          clientSecret: result.data.clientSecret,
          region: result.data.region,
          clientSecretExpiresAt: result.data.clientSecretExpiresAt
        }
        setAuthMethod(result.data.authMethod as 'IdC' | 'social' || 'IdC')
        setProvider(result.data.provider || 'BuilderId')
        setError(null)
      } else {
        setError(result.error || '导入失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  // 从 SSO Token 导入并添加账号（支持批量）
  const handleSsoImport = async () => {
    if (!ssoToken.trim()) {
      setError('请输入 x-amz-sso_authn 的值')
      return
    }

    // 解析多个 Token（每行一个）
    const tokens = ssoToken
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0)

    if (tokens.length === 0) {
      setError('请输入至少一个 Token')
      return
    }

    setIsVerifying(true)
    setError(null)
    setBatchImportResult(null)

    const importResult = { total: tokens.length, success: 0, failed: 0, errors: [] as string[], failedIndices: [] as number[] }

    // 单个 Token 导入函数
    const importSingleToken = async (token: string, index: number): Promise<void> => {
      try {
        const result = await window.api.importFromSsoToken(token, region)
        
        if (result.success && result.data) {
          const { email, userId } = result.data
          
          // 检查账户是否已存在（已存在的也从输入框中移除）
          if (email && userId && isAccountExists(email, userId, 'BuilderId')) {
            importResult.errors.push(`#${index + 1}: ${email} ${isEn ? 'already exists' : '已存在'}`)
            return
          }
          
          // 添加账号
          const now = Date.now()
          addAccount({
            email: email || '',
            userId: userId || '',
            nickname: email ? email.split('@')[0] : undefined,
            idp: 'BuilderId',
            groupId: selectedGroupId,
            credentials: {
              accessToken: result.data.accessToken,
              csrfToken: '',
              refreshToken: result.data.refreshToken,
              clientId: result.data.clientId,
              clientSecret: result.data.clientSecret,
              clientSecretExpiresAt: result.data.clientSecretExpiresAt,
              region: result.data.region,
              expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000
            },
            subscription: {
              type: (result.data.subscriptionType || 'Free') as SubscriptionType,
              title: result.data.subscriptionTitle || 'KIRO',
              daysRemaining: result.data.daysRemaining,
              managementTarget: result.data.subscription?.managementTarget,
              upgradeCapability: result.data.subscription?.upgradeCapability,
              overageCapability: result.data.subscription?.overageCapability
            },
            usage: {
              current: result.data.usage?.current || 0,
              limit: result.data.usage?.limit || 0,
              percentUsed: (result.data.usage?.limit || 0) > 0 
                ? (result.data.usage?.current || 0) / (result.data.usage?.limit || 1) 
                : 0,
              lastUpdated: now,
              baseLimit: result.data.usage?.baseLimit,
              baseCurrent: result.data.usage?.baseCurrent,
              freeTrialLimit: result.data.usage?.freeTrialLimit,
              freeTrialCurrent: result.data.usage?.freeTrialCurrent,
              freeTrialExpiry: result.data.usage?.freeTrialExpiry,
              bonuses: result.data.usage?.bonuses,
              addOnCredits: result.data.usage?.addOnCredits,
              addOnCurrent: result.data.usage?.addOnCurrent,
              addOnLimit: result.data.usage?.addOnLimit,
              nextResetDate: result.data.usage?.nextResetDate,
              resourceDetail: result.data.usage?.resourceDetail
            },
            tags: [],
            status: 'active',
            lastUsedAt: now
          })
          
          importResult.success++
        } else {
          importResult.failed++
          importResult.failedIndices.push(index)
          importResult.errors.push(`#${index + 1}: ${result.error?.message || '导入失败'}`)
        }
      } catch (e) {
        importResult.failed++
        importResult.failedIndices.push(index)
        importResult.errors.push(`#${index + 1}: ${e instanceof Error ? e.message : '导入失败'}`)
      }
    }

    try {
      // 并发控制：使用配置的并发数，避免 API 限流
      const BATCH_SIZE = batchImportConcurrency
      for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        const batch = tokens.slice(i, i + BATCH_SIZE)
        await Promise.allSettled(
          batch.map((token, batchIndex) => importSingleToken(token, i + batchIndex))
        )
        // 批次间添加短暂延迟
        if (i + BATCH_SIZE < tokens.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      setBatchImportResult(importResult)
      
      // 如果全部成功，关闭弹窗
      if (importResult.failed === 0) {
        resetForm()
        onClose()
      } else {
        // 保留失败的 Token 在输入框中
        const failedTokens = importResult.failedIndices.map(i => tokens[i])
        if (failedTokens.length > 0) {
          setSsoToken(failedTokens.join('\n'))
        }
        if (importResult.success > 0) {
          setError(`成功导入 ${importResult.success} 个，失败 ${importResult.failed} 个`)
        } else {
          setError(`全部导入失败 (${importResult.failed} 个)`)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SSO 导入失败')
    } finally {
      setIsVerifying(false)
    }
  }

  // Preview, button count and submission share the exact same parsed plan.
  const handleOidcBatchAdd = async () => {
    if (oidcImportControllerRef.current) return
    if (!oidcBatchPlan.ok) {
      setError(oidcBatchPlan.error?.message || (isEn ? 'Invalid credentials data' : '凭证数据无效'))
      return
    }

    const controller = new AbortController()
    oidcImportControllerRef.current = controller
    setIsSubmitting(true)
    setError(null)
    setOidcBatchImportResult(null)

    try {
      const outcome = await importAccountPlan(oidcBatchPlan, selectedGroupId, controller.signal)
      // A closed/reopened dialog must not receive a previous batch's result.
      if (oidcImportControllerRef.current !== controller) return
      setOidcBatchImportResult(outcome)
    } catch {
      if (oidcImportControllerRef.current !== controller) return
      setError(isEn ? 'Batch import could not complete. Your input has been kept.' : '批量导入未能完成，输入内容已保留。')
    } finally {
      if (oidcImportControllerRef.current === controller) {
        oidcImportControllerRef.current = null
        setIsSubmitting(false)
      }
    }
  }

  // OIDC 凭证添加账号（验证并添加）
  const handleOidcAdd = async () => {
    if (!refreshToken) {
      setError('请填写 Refresh Token')
      return
    }
    // 社交登录不需要 clientId 和 clientSecret
    if (authMethod !== 'social' && (!clientId || !clientSecret)) {
      setError('请填写 Client ID 和 Client Secret')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const importedRegistration = importedRegistrationRef.current
      const clientSecretExpiresAt =
        importedRegistration?.clientId === clientId &&
        importedRegistration.clientSecret === clientSecret &&
        importedRegistration.region === region
          ? importedRegistration.clientSecretExpiresAt
          : undefined
      const result = await window.api.verifyAccountCredentials({
        refreshToken,
        clientId,
        clientSecret,
        clientSecretExpiresAt,
        region,
        authMethod,
        provider
      })

      if (result.success && result.data) {
        const { email, userId } = result.data
        const providerName = provider || 'BuilderId'
        
        // 检查账户是否已存在
        if (isAccountExists(email, userId, providerName)) {
          setError(isEn ? 'This account already exists' : '该账号已存在，无需重复添加')
          return
        }
        
        // 直接添加账号
        const now = Date.now()
        addAccount({
          email,
          userId,
          nickname: email ? email.split('@')[0] : undefined,
          idp: providerName as 'BuilderId' | 'Github' | 'Google',
          groupId: selectedGroupId,
          credentials: {
            accessToken: result.data.accessToken,
            csrfToken: '',
            refreshToken: result.data.refreshToken,
            clientId,
            clientSecret,
            clientSecretExpiresAt: result.data.clientSecretExpiresAt ?? clientSecretExpiresAt,
            region,
            expiresAt: result.data.expiresIn ? now + result.data.expiresIn * 1000 : now + 3600 * 1000,
            authMethod,
            provider: (provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
          },
          subscription: {
            type: result.data.subscriptionType as SubscriptionType,
            title: result.data.subscriptionTitle,
            daysRemaining: result.data.daysRemaining,
            expiresAt: result.data.expiresAt,
            managementTarget: result.data.subscription?.managementTarget,
            upgradeCapability: result.data.subscription?.upgradeCapability,
            overageCapability: result.data.subscription?.overageCapability
          },
          usage: {
            current: result.data.usage.current,
            limit: result.data.usage.limit,
            percentUsed: result.data.usage.limit > 0 
              ? result.data.usage.current / result.data.usage.limit 
              : 0,
            lastUpdated: now,
            baseLimit: result.data.usage.baseLimit,
            baseCurrent: result.data.usage.baseCurrent,
            freeTrialLimit: result.data.usage.freeTrialLimit,
            freeTrialCurrent: result.data.usage.freeTrialCurrent,
            freeTrialExpiry: result.data.usage.freeTrialExpiry,
            bonuses: result.data.usage.bonuses,
            addOnCredits: result.data.usage.addOnCredits,
            addOnCurrent: result.data.usage.addOnCurrent,
            addOnLimit: result.data.usage.addOnLimit,
            nextResetDate: result.data.usage.nextResetDate,
            resourceDetail: result.data.usage.resourceDetail
          },
          tags: [],
          status: 'active',
          lastUsedAt: now
        })

        resetForm()
        onClose()
      } else {
        setError(result.error || '验证失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetForm = () => {
    importedRegistrationRef.current = null
    setImportMode('login')
    setRefreshToken('')
    setClientId('')
    setClientSecret('')
    setRegion('us-east-1')
    setAuthMethod('IdC')
    setProvider('BuilderId')
    setSsoToken('')
    setVerifiedData(null)
    setError(null)
    // 清理登录状态
    setLoginType('builderid')
    setIsLoggingIn(false)
    setBuilderIdLoginData(null)
    setCopied(false)
    cancelLoginAttempt()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleDialogClose} />

      <Card className="relative w-full max-w-lg max-h-[90vh] overflow-auto z-10">
        <CardHeader className="pb-4 border-b">
          <div className="flex flex-row items-center justify-between">
            <CardTitle className="text-xl font-bold">{isEn ? 'Add Account' : '添加账号'}</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-red-500 hover:text-white transition-colors" onClick={handleDialogClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{isEn ? 'Choose a method to add your Kiro account' : '选择一种方式来添加您的 Kiro 账号'}</p>
        </CardHeader>

        <CardContent className="space-y-6 pt-6">
          {/* 添加到分组（默认=当前打开的分组，可改）；无分组时不显示 */}
          {groups.size > 0 && (
            <div className="flex items-center gap-3">
              <Label className="text-sm whitespace-nowrap">{isEn ? 'Add to group' : '添加到分组'}</Label>
              <Select
                className="flex-1"
                value={selectedGroupId ?? '__default__'}
                onChange={(v) => setSelectedGroupId(v === '__default__' ? undefined : v)}
                options={[
                  { value: '__default__', label: isEn ? 'Default (Ungrouped)' : '默认（未分组）' },
                  ...Array.from(groups.values()).sort((a, b) => a.order - b.order).map(g => ({ value: g.id, label: g.name }))
                ]}
              />
            </div>
          )}
          {/* 导入模式切换 */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-muted/50 rounded-xl border">
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'login' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('login'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn || isSubmitting}
            >
              {isEn ? 'Login' : '在线登录'}
            </button>
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'oidc' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('oidc'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn || isSubmitting}
            >
              {isEn ? 'OIDC Token' : 'OIDC 凭证'}
            </button>
            <button
              className={`py-2 px-3 text-sm rounded-lg transition-all duration-200 font-medium ${
                importMode === 'sso' 
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
              onClick={() => { setImportMode('sso'); setError(null) }}
              disabled={!!verifiedData || isLoggingIn || isSubmitting}
            >
              SSO Token
            </button>
          </div>

          {/* 登录模式 */}
          {importMode === 'login' && !verifiedData && (
            <div className="space-y-4">
              {/* 登录中状态 - Builder ID */}
              {isLoggingIn && builderIdLoginData && (
                <div className="space-y-4">
                  <div className="p-4 bg-primary/[0.08] rounded-lg text-center border border-primary/15">
                    <p className="text-sm text-primary mb-2">
                      {isEn ? 'Complete login in browser and enter this code:' : '请在浏览器中完成登录，并输入以下代码：'}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      <code className="text-2xl font-bold tracking-widest bg-white dark:bg-gray-800 px-4 py-2 rounded border">
                        {builderIdLoginData.userCode}
                      </code>
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={handleCopyUserCode}
                        title={isEn ? 'Copy code' : '复制代码'}
                      >
                        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {isEn ? 'Waiting for authorization...' : '等待授权中...'}
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      className="flex-1"
                      onClick={() => window.api.openExternal(builderIdLoginData.verificationUri, usePrivateMode)}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      {isEn ? 'Open Browser' : '重新打开浏览器'}
                    </Button>
                    <Button 
                      variant="destructive" 
                      className="flex-1"
                      onClick={handleCancelLogin}
                    >
                      {isEn ? 'Cancel' : '取消登录'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 登录中状态 - Social Auth */}
              {isLoggingIn && !builderIdLoginData && (
                <div className="space-y-4">
                  <div className="p-4 bg-primary/[0.08] rounded-lg text-center border border-primary/15">
                    <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-primary" />
                    <p className="text-sm text-primary">
                      {isEn ? 'Complete login in browser...' : '请在浏览器中完成登录...'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {isEn ? 'Will auto return after login' : '登录完成后会自动返回'}
                    </p>
                  </div>
                  
                  <Button 
                    variant="destructive" 
                    className="w-full"
                    onClick={handleCancelLogin}
                  >
                    {isEn ? 'Cancel' : '取消登录'}
                  </Button>
                </div>
              )}

              {/* 未登录状态 - 显示登录选项 */}
              {!isLoggingIn && (
                <div className="space-y-4 py-2">
                  <div className="text-center mb-6">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Check className="w-6 h-6 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Sign in to Kiro' : '登录 Kiro'}</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      {isEn ? 'Choose your provider on the official sign-in page' : '在官方登录页面选择账号提供商'}
                    </p>
                  </div>

                  {/* 隐私模式选项 */}
                  <div className="px-2">
                    <button
                      type="button"
                      onClick={() => setUsePrivateMode(!usePrivateMode)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all duration-200 ${
                        usePrivateMode 
                          ? 'bg-primary/5 border-primary/30 hover:bg-primary/10' 
                          : 'bg-muted/30 border-transparent hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                          usePrivateMode ? 'bg-primary/20' : 'bg-muted'
                        }`}>
                          <EyeOff className={`w-4 h-4 ${usePrivateMode ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <span className={`text-sm font-medium ${usePrivateMode ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {isEn ? 'Private/Incognito Mode' : '隐私/无痕模式'}
                        </span>
                      </div>
                      <div className={`w-10 h-6 rounded-full p-1 transition-colors ${
                        usePrivateMode ? 'bg-primary' : 'bg-muted-foreground/30'
                      }`}>
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                          usePrivateMode ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </div>
                    </button>
                  </div>
                  
                  <div className="space-y-3 px-2">
                    <Button className="w-full h-12" onClick={() => void handleStartPortalLogin()}>
                      <ExternalLink className="mr-2 h-4 w-4" />{isEn ? 'Sign in on Kiro website' : '打开 Kiro 网页登录'}
                    </Button>
                    <p className="text-xs text-muted-foreground">{isEn ? 'Supports Builder ID, Google, GitHub and IAM Identity Center. Returns through a local callback.' : '支持 Builder ID、Google、GitHub 和 IAM Identity Center，授权后通过本地回调完成。'}</p>
                    <p className="pt-2 text-xs text-muted-foreground">{isEn ? 'Provider shortcuts and compatibility methods' : '登录快捷入口及兼容方式'}</p>
                    {/* Google */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('google')
                        handleStartSocialLogin('Google')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">{isEn ? 'Google Account' : 'Google 账号'}</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Quick login with Google' : '使用 Google 账号快捷登录'}</span>
                      </div>
                    </button>

                    {/* GitHub */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('github')
                        handleStartSocialLogin('Github')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" fill="#24292f" className="w-full h-full dark:fill-white">
                          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">{isEn ? 'GitHub Account' : 'GitHub 账号'}</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Quick login with GitHub' : '使用 GitHub 账号快捷登录'}</span>
                      </div>
                    </button>

                    {/* AWS Builder ID */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('builderid')
                        handleStartBuilderIdLogin()
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full">
                          <text x="0" y="17" fontSize="12" fontWeight="bold" fontFamily="Arial" className="fill-[#232f3e] dark:fill-white">aws</text>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">AWS Builder ID</span>
                        <span className="text-xs text-muted-foreground">{isEn ? 'Login with AWS Builder ID' : '使用 AWS Builder ID 登录'}</span>
                      </div>
                    </button>

                    {/* IAM Identity Center (Organization) */}
                    <button 
                      className="group w-full h-14 flex items-center px-4 gap-4 bg-background hover:bg-muted border border-border rounded-xl transition-all duration-200 hover:shadow-md hover:border-primary/30"
                      onClick={() => {
                        setLoginType('iamsso')
                      }}
                    >
                      <div className="w-8 h-8 flex items-center justify-center bg-white dark:bg-slate-800 rounded-full shadow-sm border dark:border-slate-600 p-1.5 group-hover:scale-110 transition-transform">
                        <svg viewBox="0 0 24 24" className="w-full h-full fill-[#232f3e] dark:fill-white">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
                        </svg>
                      </div>
                      <div className="flex flex-col items-start">
                        <span className="text-sm font-semibold text-foreground">Enterprise</span>
                        <span className="text-xs text-muted-foreground">IAM Identity Center SSO</span>
                      </div>
                    </button>
                  </div>

                  {/* IAM SSO 输入框 */}
                  {loginType === 'iamsso' && !iamSsoLoginData && (
                    <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                      <div className="space-y-2">
                        <Label htmlFor="ssoStartUrl" className="text-sm font-medium">{isEn ? 'SSO Start URL' : 'SSO Start URL'}</Label>
                        <Input
                          id="ssoStartUrl"
                          type="url"
                          placeholder="https://your-org.awsapps.com/start"
                          value={ssoStartUrl}
                          onChange={(e) => setSsoStartUrl(e.target.value)}
                          className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          {isEn ? 'Get this from your organization admin' : '从您的组织管理员处获取'}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="ssoRegion" className="text-sm font-medium">{isEn ? 'SSO Region' : 'SSO 区域'}</Label>
                        <div className="flex gap-2">
                          <select
                            id="ssoRegion"
                            value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                            onChange={(e) => {
                              if (e.target.value !== 'custom') setRegion(e.target.value)
                            }}
                            className="flex-1 h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          >
                            <optgroup label="US">
                              <option value="us-east-1">us-east-1 (N. Virginia)</option>
                              <option value="us-east-2">us-east-2 (Ohio)</option>
                              <option value="us-west-1">us-west-1 (N. California)</option>
                              <option value="us-west-2">us-west-2 (Oregon)</option>
                            </optgroup>
                            <optgroup label="Europe">
                              <option value="eu-west-1">eu-west-1 (Ireland)</option>
                              <option value="eu-west-2">eu-west-2 (London)</option>
                              <option value="eu-west-3">eu-west-3 (Paris)</option>
                              <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                              <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                              <option value="eu-south-1">eu-south-1 (Milan)</option>
                            </optgroup>
                            <optgroup label="Asia Pacific">
                              <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                              <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                              <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                              <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                              <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                              <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                              <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                            </optgroup>
                            <optgroup label="Other">
                              <option value="ca-central-1">ca-central-1 (Canada)</option>
                              <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                              <option value="me-south-1">me-south-1 (Bahrain)</option>
                              <option value="af-south-1">af-south-1 (Cape Town)</option>
                            </optgroup>
                            <optgroup label={isEn ? 'Custom' : '自定义'}>
                              <option value="custom">{isEn ? '-- Custom Input --' : '-- 自定义输入 --'}</option>
                            </optgroup>
                          </select>
                          <input
                            type="text"
                            value={region}
                            onChange={(e) => setRegion(e.target.value)}
                            placeholder={isEn ? 'e.g., cn-north-1' : '例如: cn-north-1'}
                            className="w-32 h-10 px-3 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
                          />
                        </div>
                      </div>
                      <Button 
                        className="w-full"
                        onClick={handleStartIamSsoLogin}
                        disabled={!ssoStartUrl.trim() || isLoggingIn}
                      >
                        {isLoggingIn ? (isEn ? 'Starting...' : '启动中...') : (isEn ? 'Start Login' : '开始登录')}
                      </Button>
                    </div>
                  )}

                  {/* IAM SSO 授权中 */}
                  {loginType === 'iamsso' && iamSsoLoginData && (
                    <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                      <div className="text-center space-y-2">
                        <p className="text-sm font-medium">{isEn ? 'Enter this code in browser:' : '在浏览器中输入此代码:'}</p>
                        <div className="flex items-center justify-center gap-2">
                          <code className="px-4 py-2 bg-primary/10 text-primary font-mono text-2xl font-bold rounded-lg">
                            {iamSsoLoginData.userCode}
                          </code>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(iamSsoLoginData.userCode)
                              setCopied(true)
                              setTimeout(() => setCopied(false), 2000)
                            }}
                          >
                            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{isEn ? 'Waiting for authorization...' : '等待授权中...'}</span>
                      </div>
                      <Button 
                        variant="destructive" 
                        className="w-full"
                        onClick={handleCancelLogin}
                      >
                        {isEn ? 'Cancel' : '取消登录'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SSO Token 导入模式 */}
          {importMode === 'sso' && !verifiedData && (
            <div className="space-y-5">
              <div className="p-4 bg-primary/[0.04] rounded-xl border border-primary/15">
                <div className="flex items-start gap-3">
                   <div className="p-2 bg-primary/10 rounded-lg text-primary">
                      <Info className="w-4 h-4" />
                   </div>
                   <div className="flex-1">
                      <p className="text-sm font-semibold text-primary mb-1.5">{isEn ? 'How to get Token?' : '如何获取 Token?'}</p>
                      <ol className="text-xs text-primary/90 list-decimal list-inside space-y-1.5">
                        <li>{isEn ? 'Visit and login:' : '在浏览器中访问并登录:'} <a href="https://view.awsapps.com/start/#/device?user_code=PQCF-FCCN/start/#/device?user_code=PQCF-FCCN" target="_blank" className="underline hover:text-primary/80 font-medium">view.awsapps.com/start/#/device?user_code=PQCF-FCCN</a></li>
                        <li>{isEn ? 'Press F12 → Application → Cookies' : '按 F12 打开开发者工具 → Application → Cookies'}</li>
                        <li>{isEn ? 'Find and copy' : '找到并复制'} <code className="px-1 py-0.5 bg-primary/15 rounded font-mono text-[10px]">x-amz-sso_authn</code> {isEn ? 'value' : '的值'}</li>
                      </ol>
                   </div>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-1">
                    x-amz-sso_authn <span className="text-destructive">*</span>
                    <span className="text-xs text-muted-foreground font-normal ml-2">{isEn ? 'Supports batch import, one per line' : '支持批量导入，每行一个 Token'}</span>
                  </label>
                  <textarea
                    className="w-full min-h-[120px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                    placeholder={isEn ? 'Paste Token content, one per line&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2...' : '粘贴 Token 内容，每行一个&#10;eyJlbmMiOiJBMjU2...&#10;eyJlbmMiOiJBMjU2...'}
                    value={ssoToken}
                    onChange={(e) => { setSsoToken(e.target.value); setBatchImportResult(null) }}
                  />
                  {ssoToken.trim() && (
                    <p className="text-xs text-muted-foreground">
                      {isEn ? `Entered ${ssoToken.split('\n').filter(t => t.trim()).length} tokens` : `已输入 ${ssoToken.split('\n').filter(t => t.trim()).length} 个 Token`}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">AWS Region</label>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                      value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                      onChange={(e) => {
                        if (e.target.value !== 'custom') setRegion(e.target.value)
                      }}
                    >
                      <optgroup label="US">
                        <option value="us-east-1">us-east-1 (N. Virginia)</option>
                        <option value="us-east-2">us-east-2 (Ohio)</option>
                        <option value="us-west-1">us-west-1 (N. California)</option>
                        <option value="us-west-2">us-west-2 (Oregon)</option>
                      </optgroup>
                      <optgroup label="Europe">
                        <option value="eu-west-1">eu-west-1 (Ireland)</option>
                        <option value="eu-west-2">eu-west-2 (London)</option>
                        <option value="eu-west-3">eu-west-3 (Paris)</option>
                        <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                        <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                        <option value="eu-south-1">eu-south-1 (Milan)</option>
                      </optgroup>
                      <optgroup label="Asia Pacific">
                        <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                        <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                        <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                        <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                        <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                        <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                        <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                      </optgroup>
                      <optgroup label="Other">
                        <option value="ca-central-1">ca-central-1 (Canada)</option>
                        <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                        <option value="me-south-1">me-south-1 (Bahrain)</option>
                        <option value="af-south-1">af-south-1 (Cape Town)</option>
                      </optgroup>
                      <optgroup label={isEn ? 'Custom' : '自定义'}>
                        <option value="custom">{isEn ? '-- Custom --' : '-- 自定义 --'}</option>
                      </optgroup>
                    </select>
                    <input
                      type="text"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      placeholder={isEn ? 'e.g., cn-north-1' : '例如: cn-north-1'}
                      className="w-28 h-10 px-2 text-sm rounded-xl border border-input bg-background/50"
                    />
                  </div>
                </div>
              </div>

              {/* 批量导入结果 */}
              {batchImportResult && (
                <div className={`p-3 rounded-lg text-sm ${batchImportResult.failed > 0 ? 'bg-warning/10 border border-warning/30' : 'bg-success/10 border border-success/30'}`}>
                  <p className={`font-medium ${batchImportResult.failed > 0 ? 'text-warning' : 'text-success'}`}>
                    {isEn ? `Result: ${batchImportResult.success}/${batchImportResult.total} succeeded` : `导入结果: 成功 ${batchImportResult.success}/${batchImportResult.total}`}
                  </p>
                  {batchImportResult.errors.length > 0 && (
                    <ul className="mt-2 text-xs text-warning/90 space-y-0.5 max-h-20 overflow-y-auto">
                      {batchImportResult.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <Button 
                type="button" 
                className="w-full h-11 text-sm font-medium rounded-xl shadow-sm"
                onClick={handleSsoImport}
                disabled={isVerifying || !ssoToken.trim()}
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {isEn ? `Importing ${ssoToken.split('\n').filter(t => t.trim()).length} accounts...` : `正在并发导入 ${ssoToken.split('\n').filter(t => t.trim()).length} 个账号...`}
                  </>
                ) : (
                  ssoToken.split('\n').filter(t => t.trim()).length > 1 
                    ? (isEn ? `Batch import ${ssoToken.split('\n').filter(t => t.trim()).length} accounts` : `批量导入 ${ssoToken.split('\n').filter(t => t.trim()).length} 个账号`)
                    : (isEn ? 'Import & Verify' : '导入并验证')
                )}
              </Button>
            </div>
          )}

          {/* OIDC 凭证输入模式 */}
          {importMode === 'oidc' && !verifiedData && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{isEn ? 'Enter OIDC Token' : '输入 OIDC 凭证'}</h3>
                <div className="flex items-center gap-2">
                  {/* 单个/批量 切换 */}
                  <div className="flex bg-muted/50 rounded-lg p-0.5">
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'single' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('single'); setOidcBatchImportResult(null) }}
                      disabled={isSubmitting}
                    >
                      {isEn ? 'Single' : '单个'}
                    </button>
                    <button
                      className={`px-2.5 py-1 text-xs rounded-md transition-all ${oidcImportMode === 'batch' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => { setOidcImportMode('batch'); setOidcBatchImportResult(null) }}
                      disabled={isSubmitting}
                    >
                      {isEn ? 'Batch' : '批量'}
                    </button>
                  </div>
                  {oidcImportMode === 'single' && (
                    <Button 
                      type="button" 
                      variant="outline" 
                      size="sm"
                      className="h-7 rounded-lg text-xs"
                      onClick={handleImportFromLocal}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      {isEn ? 'Import' : '本地导入'}
                    </Button>
                  )}
                </div>
              </div>

              {/* 单个导入模式 */}
              {oidcImportMode === 'single' && (
                <>
                  <div className="space-y-4">
                    {/* 登录类型选择 */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">{isEn ? 'Login Type' : '登录类型'}</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'IdC' && provider === 'BuilderId' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('IdC')
                            setProvider('BuilderId')
                          }}
                        >
                          Builder ID
                        </button>
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'IdC' && provider === 'Enterprise' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('IdC')
                            setProvider('Enterprise')
                          }}
                        >
                          Enterprise
                        </button>
                        <button
                          type="button"
                          className={`flex-1 h-9 px-3 text-sm rounded-lg border transition-all ${authMethod === 'social' ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-muted'}`}
                          onClick={() => {
                            setAuthMethod('social')
                            setProvider('Google')
                          }}
                        >
                          Social
                        </button>
                      </div>
                      {authMethod === 'social' && (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className={`flex-1 h-8 px-3 text-xs rounded-lg border transition-all ${provider === 'Google' ? 'bg-primary/20 text-primary border-primary/50' : 'bg-background border-input hover:bg-muted'}`}
                              onClick={() => setProvider('Google')}
                            >
                              Google
                            </button>
                            <button
                              type="button"
                              className={`flex-1 h-8 px-3 text-xs rounded-lg border transition-all ${provider === 'Github' ? 'bg-primary/20 text-primary border-primary/50' : 'bg-background border-input hover:bg-muted'}`}
                              onClick={() => setProvider('Github')}
                            >
                              GitHub
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {isEn ? 'Social login does not require Client ID and Secret' : '社交登录不需要 Client ID 和 Client Secret'}
                          </p>
                        </div>
                      )}
                      {authMethod === 'IdC' && provider === 'Enterprise' && (
                        <p className="text-xs text-muted-foreground">
                          Enterprise (IAM Identity Center SSO)
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        Refresh Token <span className="text-destructive">*</span>
                      </label>
                      <textarea
                        className="w-full min-h-[80px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono"
                        placeholder={isEn ? 'Paste Refresh Token...' : '粘贴 Refresh Token...'}
                        value={refreshToken}
                        onChange={(e) => setRefreshToken(e.target.value)}
                      />
                    </div>

                    {/* IdC 登录需要 Client ID、Client Secret 和 Region */}
                    {authMethod !== 'social' && (
                      <>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Client ID <span className="text-destructive">*</span>
                            </label>
                            <input
                              type="text"
                              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                              placeholder="Client ID"
                              value={clientId}
                              onChange={(e) => setClientId(e.target.value)}
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium">
                              Client Secret <span className="text-destructive">*</span>
                            </label>
                            <input
                              type="password"
                              className="w-full h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 font-mono"
                              placeholder="Client Secret"
                              value={clientSecret}
                              onChange={(e) => setClientSecret(e.target.value)}
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">AWS Region</label>
                          <div className="flex gap-2">
                            <select
                              className="flex-1 h-10 px-3 py-2 text-sm rounded-xl border border-input bg-background/50 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                              value={['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-east-1', 'ca-central-1', 'sa-east-1', 'me-south-1', 'af-south-1'].includes(region) ? region : 'custom'}
                              onChange={(e) => {
                                if (e.target.value !== 'custom') setRegion(e.target.value)
                              }}
                            >
                              <optgroup label="US">
                                <option value="us-east-1">us-east-1 (N. Virginia)</option>
                                <option value="us-east-2">us-east-2 (Ohio)</option>
                                <option value="us-west-1">us-west-1 (N. California)</option>
                                <option value="us-west-2">us-west-2 (Oregon)</option>
                              </optgroup>
                              <optgroup label="Europe">
                                <option value="eu-west-1">eu-west-1 (Ireland)</option>
                                <option value="eu-west-2">eu-west-2 (London)</option>
                                <option value="eu-west-3">eu-west-3 (Paris)</option>
                                <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                                <option value="eu-north-1">eu-north-1 (Stockholm)</option>
                                <option value="eu-south-1">eu-south-1 (Milan)</option>
                              </optgroup>
                              <optgroup label="Asia Pacific">
                                <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                                <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                                <option value="ap-northeast-3">ap-northeast-3 (Osaka)</option>
                                <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                                <option value="ap-southeast-2">ap-southeast-2 (Sydney)</option>
                                <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                                <option value="ap-east-1">ap-east-1 (Hong Kong)</option>
                              </optgroup>
                              <optgroup label="Other">
                                <option value="ca-central-1">ca-central-1 (Canada)</option>
                                <option value="sa-east-1">sa-east-1 (São Paulo)</option>
                                <option value="me-south-1">me-south-1 (Bahrain)</option>
                                <option value="af-south-1">af-south-1 (Cape Town)</option>
                              </optgroup>
                              <optgroup label={isEn ? 'Custom' : '自定义'}>
                                <option value="custom">{isEn ? '-- Custom --' : '-- 自定义 --'}</option>
                              </optgroup>
                            </select>
                            <input
                              type="text"
                              value={region}
                              onChange={(e) => setRegion(e.target.value)}
                              placeholder={isEn ? 'e.g., cn-north-1' : '例如: cn-north-1'}
                              className="w-28 h-10 px-2 text-sm rounded-xl border border-input bg-background/50"
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}

              {/* 批量导入模式 */}
              {oidcImportMode === 'batch' && (
                <>
                  <div className="p-3 bg-primary/[0.04] rounded-xl border border-primary/15">
                    <p className="text-xs text-primary">
                      {isEn ? 'Supports account objects, arrays, accounts/data containers, complete backups and Card Key lines. Builder ID requires refreshToken, clientId and clientSecret. Google/Github require an explicit provider. Legacy OIDC/IdC, Builder ID, awsidc and external_idp field aliases are accepted.' : '支持单账户、数组、accounts/data 容器、完整备份及卡密行。Builder ID 需 refreshToken、clientId 和 clientSecret；Google/Github 需明确填写 provider；兼容旧版 OIDC/IdC、Builder ID、awsidc 和 external_idp 字段别名。'}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      {isEn ? 'Credentials Data' : '凭证数据'} <span className="text-destructive">*</span>
                    </label>
                    <textarea
                      className="w-full min-h-[180px] px-3 py-2.5 text-sm rounded-xl border border-input bg-background/50 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none font-mono text-xs"
                      placeholder={isEn 
                        ? `JSON format:
[
  {
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId"
  },
  {
    "refreshToken": "yyy",
    "clientId": "yyy",
    "clientSecret": "yyy",
    "provider": "Enterprise"
  },
  {
    "refreshToken": "zzz",
    "provider": "Github"
  },
  {
    "refreshToken": "aaa",
    "provider": "Google"
  }
]

Or Card Key format (one per line):
email----password----refreshToken----clientId----clientSecret`
                        : `JSON 格式：
[
  {
    "refreshToken": "xxx",
    "clientId": "xxx",
    "clientSecret": "xxx",
    "provider": "BuilderId"
  },
  {
    "refreshToken": "yyy",
    "clientId": "yyy",
    "clientSecret": "yyy",
    "provider": "Enterprise"
  },
  {
    "refreshToken": "zzz",
    "provider": "Github"
  },
  {
    "refreshToken": "aaa",
    "provider": "Google"
  }
]

或卡密格式（每行一个）：
邮箱----密码----RefreshToken----ClientId----ClientSecret`}
                      value={oidcBatchData}
                      onChange={(e) => { setOidcBatchData(e.target.value); setOidcBatchImportResult(null); setError(null) }}
                      disabled={isSubmitting}
                    />
                    {oidcBatchData.trim() && (
                      <div className="space-y-1 text-xs" aria-live="polite">
                        {oidcBatchPlan.error ? (
                          <p className="text-destructive">{oidcBatchPlan.error.message}</p>
                        ) : oidcBatchPlan.backup ? (
                          <p className="text-muted-foreground">{isEn ? `Complete backup: ${oidcBatchPlan.counts.total} accounts; records will be validated as backup data.` : `完整备份：${oidcBatchPlan.counts.total} 个账户，将按备份格式校验。`}</p>
                        ) : (
                          <>
                            <p className="text-muted-foreground">{isEn
                              ? `Total ${oidcBatchPlan.counts.total} · Valid ${oidcBatchPlan.counts.valid} · Invalid ${oidcBatchPlan.counts.invalid} · Duplicate ${oidcBatchPlan.counts.duplicate}`
                              : `总数 ${oidcBatchPlan.counts.total} · 有效 ${oidcBatchPlan.counts.valid} · 无效 ${oidcBatchPlan.counts.invalid} · 重复 ${oidcBatchPlan.counts.duplicate}`}</p>
                            <ul className="space-y-1 max-h-28 overflow-y-auto">
                              {oidcBatchPlan.records.map(record => (
                                <li key={record.index} className={record.status === 'invalid' ? 'text-destructive' : 'text-muted-foreground'}>
                                  #{record.index + 1}: {record.credential ? `${record.credential.provider} / ${record.credential.authMethod}` : (isEn ? 'Invalid record' : '无效记录')}
                                  {record.issues.length > 0 && ` — ${record.issues.map(issue => issue.message).join('；')}`}
                                  {record.warnings.length > 0 && ` — ${record.warnings.join('；')}`}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Result stays visible; input remains available for correction and retry. */}
                  {oidcBatchImportResult && (
                    <div role="status" className={`p-3 rounded-lg text-sm ${oidcBatchImportResult.failed + oidcBatchImportResult.invalid + oidcBatchImportResult.cancelled > 0 ? 'bg-warning/10 border border-warning/30' : 'bg-success/10 border border-success/30'}`}>
                      <p className="font-medium">
                        {isEn
                          ? `Total ${oidcBatchImportResult.total} · Added ${oidcBatchImportResult.added} · Duplicate ${oidcBatchImportResult.duplicate} · Invalid ${oidcBatchImportResult.invalid} · Failed ${oidcBatchImportResult.failed} · Cancelled ${oidcBatchImportResult.cancelled}`
                          : `总数 ${oidcBatchImportResult.total} · 新增 ${oidcBatchImportResult.added} · 重复 ${oidcBatchImportResult.duplicate} · 无效 ${oidcBatchImportResult.invalid} · 失败 ${oidcBatchImportResult.failed} · 取消 ${oidcBatchImportResult.cancelled}`}
                      </p>
                      {oidcBatchImportResult.errors.length > 0 && (
                        <ul className="mt-2 text-xs text-warning/90 space-y-0.5 max-h-24 overflow-y-auto">
                          {oidcBatchImportResult.errors.map((issue, index) => {
                            const record = oidcBatchPlan.records.find(item => item.source === issue.source)
                            return <li key={index}>{record ? `#${record.index + 1}: ` : ''}{issue.message}</li>
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 错误信息 */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
              <div className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
              {error}
            </div>
          )}

          {loginVerifyPending && <Button type="button" variant="outline" onClick={handleRetryPortalVerification} disabled={isSubmitting}>
            {isEn ? 'Retry account information' : '重试获取已授权账户信息'}
          </Button>}
          {loginSavePending && (
            <Button type="button" variant="outline" onClick={handleRetryLoginSave} disabled={isSubmitting}>
              {isEn ? 'Retry Saving Added Account' : '重试保存已添加账户'}
            </Button>
          )}

          {/* 提交按钮 - 只在 OIDC 模式显示 */}
          {importMode === 'oidc' && (
            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={handleDialogClose} className="rounded-xl h-10 px-6">
                {isEn ? 'Cancel' : '取消'}
              </Button>
              {oidcImportMode === 'batch' && isSubmitting && (
                <Button type="button" variant="outline" onClick={() => oidcImportControllerRef.current?.abort()} className="rounded-xl h-10 px-6">
                  {isEn ? 'Cancel Import' : '取消导入'}
                </Button>
              )}
              {oidcImportMode === 'single' ? (
                <Button 
                  onClick={handleOidcAdd} 
                  disabled={isSubmitting || !refreshToken || (authMethod !== 'social' && (!clientId || !clientSecret))}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {isEn ? 'Add Account' : '确认添加'}
                </Button>
              ) : (
                <Button 
                  onClick={handleOidcBatchAdd} 
                  disabled={isSubmitting || !oidcBatchPlan.ok || (!oidcBatchPlan.backup && oidcBatchPlan.counts.valid === 0)}
                  className="rounded-xl h-10 px-6"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {isEn ? 'Importing...' : '正在并发导入...'}
                    </>
                  ) : (
                    (isEn ? `Batch import ${oidcBatchPlan.counts.total} accounts` : `批量导入 ${oidcBatchPlan.counts.total} 个账户`)
                  )}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
