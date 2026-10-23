// Pure GetUsageLimits response parsing shared by checks, refreshes and proxy pools.
export interface AccountAddOnCredit {
  id: string
  current: number
  limit: number
  remaining: number
  expiresAt?: string
  status: 'active' | 'exhausted' | 'expired' | 'inactive'
}

export interface AccountBonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

export interface ParsedAccountUsage {
  current: number
  limit: number
  totalCurrent: number
  totalLimit: number
  percentUsed: number
  lastUpdated: number
  baseCurrent: number
  baseLimit: number
  freeTrialCurrent: number
  freeTrialLimit: number
  freeTrialExpiry?: string
  bonuses: AccountBonusUsage[]
  addOnCredits: AccountAddOnCredit[]
  addOnCurrent: number
  addOnLimit: number
  nextResetDate?: string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function amount(precise: unknown, fallback: unknown): number {
  for (const value of [precise, fallback]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

/** Official JSON timestamps are Unix seconds or ISO; SDK Date values are also accepted. */
export function normalizeUsageDate(value: unknown): string | undefined {
  let milliseconds: number
  if (value instanceof Date) milliseconds = value.getTime()
  else if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value
  } else if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    milliseconds = /^\d+(?:\.\d+)?$/.test(text)
      ? Number(text) * (Number(text) < 1e12 ? 1000 : 1)
      : Date.parse(text)
  } else return undefined
  if (!Number.isFinite(milliseconds)) return undefined
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function current(row: Record<string, unknown>): number {
  return amount(row.currentUsageWithPrecision, row.currentUsage)
}

function limit(row: Record<string, unknown>): number {
  return amount(row.usageLimitWithPrecision, row.usageLimit)
}

function expiryState(
  row: Record<string, unknown>,
  key: string,
  now: number
): 'valid' | 'expired' | 'invalid' {
  if (row[key] === undefined || row[key] === null) return 'valid'
  const expiry = normalizeUsageDate(row[key])
  if (!expiry) return 'invalid'
  return Date.parse(expiry) <= now ? 'expired' : 'valid'
}

function activeStatus(row: Record<string, unknown>): boolean {
  return row.status === undefined || row.status === 'ACTIVE' || row.status === 'EXHAUSTED'
}

/** Monthly reset applies to the base allowance only; purchased credits retain their expiry. */
export function parseAccountUsage(response: unknown, now = Date.now()): ParsedAccountUsage {
  const data = record(response)
  const rows = Array.isArray(data.usageBreakdownList)
    ? data.usageBreakdownList.map(record).filter((row) => row.resourceType === 'CREDIT')
    : []
  let baseCurrent = 0
  let baseLimit = 0
  let freeTrialCurrent = 0
  let freeTrialLimit = 0
  let freeTrialExpiry: string | undefined
  const bonuses: AccountBonusUsage[] = []
  const addOnCredits: AccountAddOnCredit[] = []
  for (const [rowIndex, row] of rows.entries()) {
    baseCurrent += current(row)
    baseLimit += limit(row)
    const trial = record(row.freeTrialInfo ?? row.freeTrialUsage)
    if (
      trial.freeTrialStatus === 'ACTIVE' &&
      expiryState(trial, 'freeTrialExpiry', now) === 'valid'
    ) {
      freeTrialCurrent += current(trial)
      freeTrialLimit += limit(trial)
      const expiry = normalizeUsageDate(trial.freeTrialExpiry)
      if (expiry && (!freeTrialExpiry || expiry < freeTrialExpiry)) freeTrialExpiry = expiry
    }
    for (const [index, raw] of (Array.isArray(row.bonuses) ? row.bonuses : []).entries()) {
      const bonus = record(raw)
      if (!activeStatus(bonus) || expiryState(bonus, 'expiresAt', now) !== 'valid') continue
      bonuses.push({
        code: typeof bonus.bonusCode === 'string' ? bonus.bonusCode : `bonus-${rowIndex}-${index}`,
        name: typeof bonus.displayName === 'string' ? bonus.displayName : 'Bonus',
        current: current(bonus),
        limit: limit(bonus),
        expiresAt: normalizeUsageDate(bonus.expiresAt)
      })
    }
    for (const [index, raw] of (Array.isArray(row.overageCredits)
      ? row.overageCredits
      : []
    ).entries()) {
      const pack = record(raw)
      const used = current(pack)
      const total = limit(pack)
      const expiry = expiryState(pack, 'expiresAt', now)
      const status =
        expiry === 'expired'
          ? 'expired'
          : expiry === 'invalid' || !activeStatus(pack)
            ? 'inactive'
            : pack.status === 'EXHAUSTED' || used >= total
              ? 'exhausted'
              : 'active'
      addOnCredits.push({
        id: `add-on-${rowIndex}-${index}`,
        current: used,
        limit: total,
        remaining: status === 'active' ? Math.max(0, total - used) : 0,
        expiresAt: normalizeUsageDate(pack.expiresAt),
        status
      })
    }
  }
  addOnCredits.sort((a, b) => (a.expiresAt ?? '\uffff').localeCompare(b.expiresAt ?? '\uffff'))
  const validPacks = addOnCredits.filter(
    (pack) => pack.status === 'active' || pack.status === 'exhausted'
  )
  // An explicit EXHAUSTED status cannot leave phantom balance when an older API
  // response omits currentUsage. Keep the reported per-pack amount for inspection.
  const addOnCurrent = validPacks.reduce(
    (sum, pack) =>
      sum + (pack.status === 'exhausted' ? Math.max(pack.current, pack.limit) : pack.current),
    0
  )
  const addOnLimit = validPacks.reduce((sum, pack) => sum + pack.limit, 0)
  const totalCurrent =
    baseCurrent +
    freeTrialCurrent +
    bonuses.reduce((sum, bonus) => sum + bonus.current, 0) +
    addOnCurrent
  const totalLimit =
    baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0) + addOnLimit
  return {
    current: totalCurrent,
    limit: totalLimit,
    totalCurrent,
    totalLimit,
    percentUsed: totalLimit > 0 ? totalCurrent / totalLimit : 0,
    lastUpdated: now,
    baseCurrent,
    baseLimit,
    freeTrialCurrent,
    freeTrialLimit,
    freeTrialExpiry,
    bonuses,
    addOnCredits,
    addOnCurrent,
    addOnLimit,
    nextResetDate: normalizeUsageDate(data.nextDateReset)
  }
}
