/** Local subscription classification. Display titles and service identifiers remain unchanged. */
export const SUBSCRIPTION_TYPES = ['Free', 'Pro', 'Pro_Plus', 'Pro_Max', 'Power', 'Enterprise', 'Teams', 'Unknown'] as const
export type SubscriptionType = typeof SUBSCRIPTION_TYPES[number]

export interface SubscriptionInput {
  type?: unknown
  title?: unknown
  rawType?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function classify(value: unknown): SubscriptionType | undefined {
  const original = text(value)
  if (!original) return undefined
  const key = original.toUpperCase().replace(/\+/g, '_PLUS').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  const has = (word: string): boolean => new RegExp(`(?:^|_)${word}(?:_|$)`).test(key)
  if (has('PRO_MAX') || has('PROMAX')) return 'Pro_Max'
  if (has('POWER')) return 'Power'
  if (has('PRO_PLUS') || has('PROPLUS')) return 'Pro_Plus'
  if (has('ENTERPRISE')) return 'Enterprise'
  if (has('TEAMS')) return 'Teams'
  if (has('PRO')) return 'Pro'
  if (has('FREE')) return 'Free'
  return undefined
}

/** Specific service metadata wins over a generic PRO identifier or a legacy stored category. */
export function normalizeSubscriptionType(input?: SubscriptionInput | string | null): SubscriptionType {
  if (typeof input === 'string') return classify(input) ?? 'Unknown'
  if (!input || typeof input !== 'object') return 'Unknown'
  const metadata = [classify(input.rawType), classify(input.title)]
  for (const specific of ['Pro_Max', 'Power', 'Pro_Plus'] as const) {
    if (metadata.includes(specific)) return specific
  }
  const known = metadata.find(type => type !== undefined)
  if (known) return known
  // New/unrecognized service plans must not inherit a stale FREE (or paid) category.
  if (text(input.rawType) || text(input.title)) return 'Unknown'
  return classify(input.type) ?? 'Unknown'
}

export function normalizeAccountSubscription<T extends SubscriptionInput>(input: T): Omit<T, 'type'> & { type: SubscriptionType } {
  return { ...input, type: normalizeSubscriptionType(input) }
}

/** Merge a fresh observation without allowing old raw metadata to override a changed plan. */
export function mergeAccountSubscription<T extends SubscriptionInput>(current: T, update?: Partial<Omit<T, 'type'>> & SubscriptionInput): Omit<T, 'type'> & { type: SubscriptionType } {
  if (!update) return normalizeAccountSubscription(current)
  const merged = { ...current, ...update }
  const has = (key: keyof SubscriptionInput): boolean => Object.prototype.hasOwnProperty.call(update, key)
  if (has('title') && update.title !== current.title && !has('rawType')) merged.rawType = undefined
  if (has('type') && !has('title') && !has('rawType') && normalizeSubscriptionType({ type: update.type }) !== normalizeSubscriptionType(current)) {
    merged.title = undefined
    merged.rawType = undefined
  }
  return normalizeAccountSubscription(merged)
}

export function isPaidSubscription(input?: SubscriptionInput | string | null): boolean {
  const type = normalizeSubscriptionType(input)
  return type !== 'Free' && type !== 'Unknown'
}

export function compareSubscriptionTypes(left: SubscriptionInput, right: SubscriptionInput): number {
  return SUBSCRIPTION_TYPES.indexOf(normalizeSubscriptionType(left)) - SUBSCRIPTION_TYPES.indexOf(normalizeSubscriptionType(right))
}

export function emptySubscriptionCounts(): Record<SubscriptionType, number> {
  return Object.fromEntries(SUBSCRIPTION_TYPES.map(type => [type, 0])) as Record<SubscriptionType, number>
}
