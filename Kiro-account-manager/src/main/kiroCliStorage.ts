import { posix, win32 } from 'node:path'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const registrationKey = 'kirocli:odic:device-registration'
const idcTokenKey = 'kirocli:odic:token'
const otherTokenKeys = ['kirocli:social:token', 'codewhisperer:odic:token']

type RegistrationIdentity = { clientId?: string; clientSecret?: string; region: string }
type RegistrationSnapshot = { registration: string; tokens: Array<string | null> }
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')

export class KiroCliRegistrationError extends Error {
  constructor() {
    super('CLI 没有同一账户的有效 OIDC 登记，未写入凭证。请在终端使用 kiro-cli login 登录。')
  }
}

/** The CLI uses the native local-data root, which differs from Electron's userData. */
export function resolveKiroCliDatabasePath(
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>
): string {
  if (platform === 'win32') {
    const override = env.LOCALAPPDATA
    const root = override && win32.isAbsolute(override) && win32.parse(override).root !== '\\' && win32.parse(override).root !== '/'
      ? override : win32.join(homeDir, 'AppData', 'Local')
    return win32.join(root, 'kiro-cli', 'data.sqlite3')
  }
  if (platform === 'darwin') return posix.join(homeDir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  const override = env.XDG_DATA_HOME
  const root = override && posix.isAbsolute(override) ? override : posix.join(homeDir, '.local', 'share')
  return posix.join(root, 'kiro-cli', 'data.sqlite3')
}

function matchingRegistration(db: DatabaseSync, identity: RegistrationIdentity): string {
  const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(registrationKey)
  if (!identity.clientId || !identity.clientSecret || typeof row?.value !== 'string' || row.value.length > 128 * 1024) throw new KiroCliRegistrationError()
  const record = JSON.parse(row.value) as Record<string, unknown> | null
  const expiry = record?.client_secret_expires_at
  const expiresAt = typeof expiry === 'string' ? Date.parse(expiry) : typeof expiry === 'number' ? expiry * 1000 : NaN
  if (!record || record.client_id !== identity.clientId || record.client_secret !== identity.clientSecret || record.region !== identity.region ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
      (record.oauth_flow !== 'DeviceCode' && record.oauth_flow !== 'Pkce') ||
      !Array.isArray(record.scopes) || !record.scopes.every(scope => typeof scope === 'string')) throw new KiroCliRegistrationError()
  return row.value
}

function currentTokens(db: DatabaseSync): Array<string | null> {
  const query = db.prepare('SELECT value FROM auth_kv WHERE key = ?')
  return [idcTokenKey, ...otherTokenKeys].map(key => {
    const row = query.get(key)
    if (!row || row.value === null) return null
    if (typeof row.value !== 'string' || row.value.length > 512 * 1024) throw new KiroCliRegistrationError()
    return row.value
  })
}

/** Validate a native registration without creating a database or refreshing credentials. */
export async function inspectKiroCliRegistration(dbPath: string, identity: RegistrationIdentity): Promise<RegistrationSnapshot> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 })
    try {
      db.exec('BEGIN')
      return { registration: fingerprint(matchingRegistration(db, identity)), tokens: currentTokens(db).map(value => value === null ? null : fingerprint(value)) }
    } finally { db.close() }
  } catch {
    throw new KiroCliRegistrationError()
  }
}

/** Recheck the exact existing registration while holding the SQLite write lock. */
export async function writeKiroCliRegisteredToken(
  dbPath: string, identity: RegistrationIdentity, expected: RegistrationSnapshot, tokenJson: string, assertCurrent: () => void
): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  assertCurrent()
  if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) throw new KiroCliRegistrationError()
  const db = new DatabaseSync(dbPath, { timeout: 1000 })
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (fingerprint(matchingRegistration(db, identity)) !== expected.registration || currentTokens(db).some((token, index) => (token === null ? null : fingerprint(token)) !== expected.tokens[index])) throw new KiroCliRegistrationError()
    } catch {
      throw new KiroCliRegistrationError()
    }
    db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)').run(idcTokenKey, tokenJson)
    const remove = db.prepare('DELETE FROM auth_kv WHERE key = ?')
    for (const key of otherTokenKeys) remove.run(key)
    db.exec('COMMIT')
  } finally { db.close() }
}
