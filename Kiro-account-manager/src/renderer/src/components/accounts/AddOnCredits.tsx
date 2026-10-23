import type { ReactElement } from 'react'
import type { AccountAddOnCredit } from '../../../../shared/accountUsage'

interface AddOnCreditsProps {
  credits?: readonly AccountAddOnCredit[]
  isEn: boolean
  precision?: boolean
  inline?: boolean
  detailed?: boolean
}

/** The compact list row exposes every pack through its native tooltip. */
export function AddOnCredits({
  credits,
  isEn,
  precision = false,
  inline = false,
  detailed = false
}: AddOnCreditsProps): ReactElement | null {
  if (!credits?.length) return null
  const format = (value: number): string =>
    precision
      ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : Math.floor(value).toLocaleString()
  const now = Date.now()
  const packs = credits.map((pack) => ({
    ...pack,
    status: pack.expiresAt && Date.parse(pack.expiresAt) <= now ? ('expired' as const) : pack.status
  }))
  const active = packs.filter((pack) => pack.status === 'active')
  const remaining = active.reduce((sum, pack) => sum + pack.remaining, 0)
  const nearestExpiry = active
    .map((pack) => pack.expiresAt)
    .filter((date): date is string => Boolean(date))
    .sort()[0]
    ?.slice(0, 10)
  const statusText = (status: AccountAddOnCredit['status']): string =>
    ({
      active: isEn ? 'Available' : '可用',
      exhausted: isEn ? 'Used up' : '已耗尽',
      expired: isEn ? 'Expired' : '已过期',
      inactive: isEn ? 'Unavailable' : '不可用'
    })[status]
  const lines = packs.map(
    (pack, index) =>
      `${isEn ? 'Pack' : '充值包'} ${index + 1}: ${format(pack.current)} / ${format(pack.limit)} ${isEn ? 'used' : '已用'} · ${statusText(pack.status)} · ${pack.expiresAt ? `${pack.expiresAt.slice(0, 10)} ${isEn ? 'expires' : '到期'}` : isEn ? 'Expiry not provided' : '未提供到期日'}`
  )
  if (inline) {
    return (
      <div className="text-[9px] text-emerald-600 truncate" title={lines.join('\n')}>
        {isEn ? 'Add-ons' : '充值包'}: {format(remaining)} {isEn ? 'left' : '剩余'}
        {nearestExpiry ? ` · ${nearestExpiry}` : ''}
      </div>
    )
  }
  return (
    <div className={detailed ? 'space-y-3' : 'space-y-1.5 text-[10px]'}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-emerald-600">
          {isEn ? 'Add-on credits' : '充值额度包'}
        </span>
        <span className="font-medium">
          {format(remaining)} {isEn ? 'remaining' : '剩余'}
        </span>
      </div>
      {detailed && (
        <p className="text-xs text-muted-foreground">
          {isEn
            ? 'Packs keep their own expiry and do not reset each month.'
            : '充值包按各自到期日有效，不随月度套餐重置。'}
        </p>
      )}
      {packs.map((pack, index) => (
        <div
          key={pack.id}
          className={detailed ? 'rounded-xl border bg-background p-3 space-y-1' : 'space-y-0.5'}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              {isEn ? 'Pack' : '充值包'} {index + 1} · {statusText(pack.status)}
            </span>
            <span className="font-medium tabular-nums">
              {format(pack.current)} / {format(pack.limit)} {isEn ? 'used' : '已用'}
            </span>
          </div>
          <div className="text-muted-foreground">
            {pack.expiresAt
              ? `${pack.expiresAt.slice(0, 10)} ${isEn ? 'expires' : '到期'}`
              : isEn
                ? 'Expiry not provided'
                : '未提供到期日'}
          </div>
        </div>
      ))}
    </div>
  )
}
