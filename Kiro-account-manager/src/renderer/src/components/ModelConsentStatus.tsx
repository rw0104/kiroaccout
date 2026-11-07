import { Badge } from './ui/badge'

/** Display the service value without interpreting undocumented enum meanings. */
export function ModelConsentStatus({ value, isEn }: { value: string | null | undefined; isEn: boolean }) {
  if (value === undefined) return null
  const label = typeof value === 'string' && value ? value.slice(0, 160) : (isEn ? 'Returned by service' : '服务已返回状态')
  return <Badge variant="secondary" className="text-[10px] max-w-full break-all" title={isEn ? 'Check consent in the official Kiro client. This model cannot be selected as a fallback.' : '请在官方 Kiro 客户端查看同意状态；该模型不能设为后备模型。'}>
    {isEn ? 'Consent: ' : '同意状态：'}{label}
  </Badge>
}
