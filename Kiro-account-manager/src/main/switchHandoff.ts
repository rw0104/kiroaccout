import { randomUUID } from 'node:crypto'

export interface PreparedSwitchCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}
interface Handoff extends PreparedSwitchCredentials { accountId: string; issuedAt: number }

/** A one-use main-process capability permits writing both clients after one rotation. */
export class SwitchHandoffStore {
  private readonly pending = new Map<string, Handoff>()

  issue(accountId: string, credentials: PreparedSwitchCredentials, now = Date.now()): string {
    for (const [key, value] of this.pending) {
      if (now - value.issuedAt > 60000 || value.accountId === accountId) this.pending.delete(key)
    }
    if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value!)
    const proof = randomUUID()
    this.pending.set(proof, { ...credentials, accountId, issuedAt: now })
    return proof
  }

  consume(proof: unknown, accountId: unknown, credentials: PreparedSwitchCredentials, now = Date.now()): PreparedSwitchCredentials {
    const prepared = typeof proof === 'string' ? this.pending.get(proof) : undefined
    if (!prepared || prepared.accountId !== accountId || now - prepared.issuedAt > 60000 || prepared.expiresAt <= now + 30000 ||
      prepared.accessToken !== credentials.accessToken || prepared.refreshToken !== credentials.refreshToken || prepared.expiresAt !== credentials.expiresAt) {
      throw new Error('双端切换的凭证交接已失效，请重新执行双端切换')
    }
    this.pending.delete(proof as string)
    return { accessToken: prepared.accessToken, refreshToken: prepared.refreshToken, expiresAt: prepared.expiresAt }
  }
}
