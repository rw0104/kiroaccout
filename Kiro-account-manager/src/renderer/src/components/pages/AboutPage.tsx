import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import { Github, Code, ExternalLink, RefreshCw, Info, Zap } from 'lucide-react'
import kiroLogo from '@/assets/kiro-high-resolution-logo-transparent.png'
import { useAccountsStore } from '@/store/accounts'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const { darkMode } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  const checkForUpdates = () => {
    window.api.showAppUpdateDialog()
    void window.api.checkForUpdates().catch(() => {})
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-8">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative text-center space-y-4">
          <img 
            src={kiroLogo} 
            alt="Kiro" 
            className={cn("h-20 w-auto mx-auto transition-all", darkMode && "invert brightness-0")} 
          />
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Kiro Account Manager' : 'Kiro 账户管理器'}</h1>
            <p className="text-muted-foreground">{isEn ? `Version ${version}` : `版本 ${version}`}</p>
          </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={checkForUpdates}
          >
            <RefreshCw className="h-4 w-4" />
            {isEn ? 'Check Updates' : '检查更新'}
          </Button>
        </div>
        
        </div>
      </div>

      {/* Description */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'About' : '关于本应用'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>
            {isEn 
              ? 'Kiro Account Manager manages Kiro accounts, imports account credentials, and organizes accounts with groups and tags.'
              : 'Kiro 账户管理器用于管理 Kiro 账号、导入账号凭证，以及按分组和标签整理账号。'}
          </p>
          <p>
            {isEn 
              ? 'Built with Electron, React and TypeScript. Account data is saved locally; authentication and account checks connect to the relevant services. Current release packages target Windows x64.'
              : '使用 Electron、React 和 TypeScript 开发。账号资料保存在本地，登录和账号校验需要连接相关服务。当前提供 Windows x64 安装包。'}
          </p>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Features' : '主要功能'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Multi-Account' : '多账号管理'}</strong>{isEn ? ': Add, edit, delete multiple accounts' : '：支持添加、编辑、删除多个 Kiro 账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'One-Click Switch' : '一键切换'}</strong>{isEn ? ': Quick account switching' : '：快速切换当前使用的账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Refresh' : '自动刷新'}</strong>{isEn ? ': Auto refresh tokens before expiry' : '：Token 过期前自动刷新，保持登录状态'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Groups & Tags' : '分组与标签'}</strong>{isEn ? ': Batch set groups/tags' : '：多选账户批量设置分组/标签，支持多标签'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Privacy Mode' : '隐私模式'}</strong>{isEn ? ': Hide sensitive info' : '：隐藏邮箱和账号敏感信息'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Batch Import' : '批量导入'}</strong>{isEn ? ': SSO Token & OIDC batch import' : '：支持 SSO Token 和 OIDC 凭证批量导入'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Machine ID' : '机器码管理'}</strong>{isEn ? ': Modify device identifier' : '：读取与管理设备标识符'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch ID' : '自动换机器码'}</strong>{isEn ? ': Auto change ID on switch' : '：切换账号时自动更换机器码'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'ID Binding' : '账户机器码绑定'}</strong>{isEn ? ': Unique ID per account' : '：为每个账户分配唯一机器码'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch' : '自动换号'}</strong>{isEn ? ': Switch when balance low' : '：余额不足时自动切换可用账号'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Proxy Support' : '代理支持'}</strong>{isEn ? ': HTTP/HTTPS/SOCKS5' : '：支持 HTTP/HTTPS/SOCKS5 代理'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Themes' : '主题定制'}</strong>{isEn ? ': Theme colors and dark/light mode' : '：主题颜色与深色/浅色模式'}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Code className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Tech Stack' : '技术栈'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'Zustand', 'Vite'].map((tech) => (
              <span 
                key={tech}
                className="px-2.5 py-1 text-xs bg-muted rounded-full text-muted-foreground"
              >
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Project links */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Github className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Open-source project' : '开源项目'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {isEn ? 'Repository: rw0104/kiroaccout · License: AGPL-3.0' : '项目仓库：rw0104/kiroaccout · 许可证：AGPL-3.0'}
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => window.api.openExternal('https://github.com/rw0104/kiroaccout')}>
              <Github className="h-4 w-4" />
              {isEn ? 'Source code' : '开源代码'}
              <ExternalLink className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => window.api.openExternal('https://github.com/rw0104/kiroaccout/issues')}>
              {isEn ? 'Report an issue' : '反馈问题'}
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground py-4">
        <p>kiroaccout · AGPL-3.0</p>
      </div>
    </div>
  )
}
