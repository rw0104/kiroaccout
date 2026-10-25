/** Local search metadata only. These labels never establish an account's identity. */
export function mergeSourceAccountNames(...groups: unknown[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const value of group) {
      if (typeof value !== 'string') continue
      const name = value.trim()
      const key = name.toLowerCase()
      if (!name || seen.has(key)) continue
      seen.add(key)
      names.push(name)
    }
  }
  return names
}

export interface SearchableAccount {
  email?: string
  nickname?: string
  sourceAccountNames?: readonly string[]
}

export function matchesAccountSearch(account: SearchableAccount, query: string): boolean {
  const search = query.trim().toLowerCase()
  if (!search) return true
  const fields = [account.email, account.nickname, ...mergeSourceAccountNames(account.sourceAccountNames)]
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(search))
}
