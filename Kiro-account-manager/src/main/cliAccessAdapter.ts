import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ClientAccessProjectionError, projectableClientAccess, validateClientAccessIdentity, type AccessCredential, type ClientAccessProjectionAdapter } from './clientAccessProjection'

const tokenKeys = ['kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token'] as const
const registrationKey = 'kirocli:odic:device-registration'
const runtimeMarkerKey = 'kirocli:auth:last-forced-refresh-at'
const profileStateKey = 'api.codewhisperer.profile'
const supportedKeys = new Set<string>([...tokenKeys, registrationKey, runtimeMarkerKey])

function normalizeUtcExpiry(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!parts) return value
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return value
  // CLI's UTC serializer drops .000 and other insignificant fractional zeros.
  // Do not use Date.parse: its calendar rollover could hide invalid edits.
  const fraction = parts[7]?.replace(/0+$/, '')
  return `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}${fraction ? `.${fraction}` : ''}Z`
}

function authenticationValue(key: string, raw: string): unknown {
  if (!(tokenKeys as readonly string[]).includes(key)) return raw
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return raw
    // CLI serializes optional fields as null and adds a telemetry-only generation
    // on its first real request. Neither operation changes the authentication.
    const optional = new Set(['refresh_token', 'start_url', 'scopes', 'profile_arn'])
    return Object.keys(value).sort().filter(name => name !== 'telemetry_generation' && !(optional.has(name) && value[name] === null))
      .map(name => [name, name === 'expires_at' ? normalizeUtcExpiry(value[name]) : value[name]])
  } catch { return raw }
}

function existsFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('invalid-database')
    return true
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function profileStateSnapshot(db: DatabaseSync): { table: boolean; profile: unknown } {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get()
  if (!table) return { table: false, profile: null }
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(profileStateKey)
  if (!row) return { table: true, profile: null }
  const value = row.value
  if (typeof value === 'string' && value.length <= 1024 * 1024) return { table: true, profile: ['text', value] }
  if (value instanceof Uint8Array && value.byteLength <= 1024 * 1024) {
    return { table: true, profile: ['blob', Buffer.from(value).toString('base64')] }
  }
  if (value === null) return { table: true, profile: ['null'] }
  throw new Error('unsupported-profile-state')
}

function snapshot(db: DatabaseSync): string {
  // Native list-models/usage resolve AuthProfile from state independently of
  // the v3 bridge's token.profile_arn. It is part of the same account CAS.
  const profileState = profileStateSnapshot(db)
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_kv'").get()
  if (!table) return JSON.stringify({ table: false, rows: [], profileState })
  const rows = db.prepare('SELECT key, value FROM auth_kv ORDER BY key').all()
  if (rows.length > 256 || rows.some(row => typeof row.key !== 'string' || typeof row.value !== 'string' || row.value.length > 1024 * 1024)) {
    throw new Error('unsupported-auth-store')
  }
  // A newer, higher-priority auth scheme must never silently win over this projection.
  if (rows.some(row => !supportedKeys.has(row.key as string))) throw new Error('unsupported-auth-entry')
  // The CLI updates this timestamp itself; it is not a login/credential change.
  return JSON.stringify({ table: true, rows: rows.filter(row => row.key !== runtimeMarkerKey).map(row => [row.key, authenticationValue(row.key as string, row.value as string)]), profileState })
}

// v1 could bind a Social record whose title-case provider the native v3 bridge
// cannot deserialize. Keep old bindings from returning "unchanged": background
// sync pauses at the revision boundary; explicit reselection writes the new schema.
const absent = (): string => createHash('sha256').update('cli-access-v2\0absent').digest('hex')
const digest = (value: string): string => createHash('sha256').update('cli-access-v2\0').update(value).digest('hex')

/** Native CLI 3.1 access-only schema, verified without refresh tokens or registrations. */
export function cliAccessPayload(access: Readonly<AccessCredential>): { key: string; value: string } {
  if (Object.keys(access).some(key => !['accessToken', 'expiresAt', 'provider', 'authMethod', 'profileArn', 'region', 'startUrl'].includes(key))) {
    throw new ClientAccessProjectionError('credential-unusable')
  }
  validateClientAccessIdentity(access)
  const social = access.provider === 'Google' || access.provider === 'Github'
  if (!social && (access.region === undefined || typeof access.region === 'string' && !access.region.trim())) {
    throw new ClientAccessProjectionError('credential-unusable', 'region-missing')
  }
  if (access.provider === 'Enterprise') {
    if (access.startUrl === undefined || typeof access.startUrl === 'string' && !access.startUrl.trim()) {
      throw new ClientAccessProjectionError('credential-unusable', 'start-url-missing')
    }
    try {
      if (typeof access.startUrl !== 'string' || access.startUrl.length > 2048) throw new Error()
      const issuer = new URL(access.startUrl)
      if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash ||
          !/(^|\.)awsapps\.com$/.test(issuer.hostname) || !/^\/(?:start\/?|directory\/[a-zA-Z0-9-]+\/?)$/.test(issuer.pathname) ||
          issuer.href.replace(/\/$/, '') === 'https://view.awsapps.com/start') throw new Error()
    } catch { throw new ClientAccessProjectionError('credential-unusable', 'start-url-invalid') }
  }
  projectableClientAccess({ ...access, startUrl: access.provider === 'Enterprise' ? access.startUrl : undefined })
  const value = {
    access_token: access.accessToken,
    expires_at: new Date(access.expiresAt).toISOString(),
    // CLI's Social token enum is lowercase. Manager/Crew identity labels remain
    // canonical title case; translating here must not change the source identity.
    ...(social ? { provider: access.provider.toLowerCase() } : {
      region: access.region,
      // Required local CLI serde discriminator, not a claim about the manager's grant.
      // No refresh token, client credentials or registration are supplied by this adapter.
      oauth_flow: 'DeviceCode'
    }),
    ...(access.provider === 'Enterprise' ? { start_url: access.startUrl } : {}),
    ...(access.profileArn ? { profile_arn: access.profileArn } : {})
  }
  return { key: social ? tokenKeys[0] : tokenKeys[1], value: JSON.stringify(value) }
}

export function createCliAccessAdapter(options: { databasePath: string; authDomainId: string }): ClientAccessProjectionAdapter {
  if (!isAbsolute(options.databasePath) || !options.authDomainId) throw new Error('Invalid CLI access configuration')
  const filename = options.databasePath
  const checkParent = (): void => {
    for (let current = dirname(filename); ; current = dirname(current)) {
      try {
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid-directory')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (current === dirname(current)) break
    }
  }
  return {
    authDomainId: options.authDomainId,
    validate: access => { cliAccessPayload(access) },
    async readRevision() {
      try {
        checkParent()
        if (!existsFile(filename)) return absent()
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(filename, { readOnly: true, timeout: 1000 })
        try { db.exec('BEGIN'); return digest(snapshot(db)) } finally { db.close() }
      } catch { throw new ClientAccessProjectionError('target-read-failed') }
    },
    async write(access, expectedRevision, assertCurrent, context) {
      const payload = cliAccessPayload(access)
      if (access.expiresAt <= Date.now() + 180_000) throw new ClientAccessProjectionError('credential-unusable')
      const { DatabaseSync } = await import('node:sqlite')
      let db: DatabaseSync | undefined
      let committed = false
      try {
        checkParent()
        const present = existsFile(filename)
        if (!present && expectedRevision !== absent()) throw new ClientAccessProjectionError('target-changed')
        assertCurrent()
        mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
        // exclusive create prevents treating another writer's newly created database as absent.
        if (!present) {
          assertCurrent()
          try { closeSync(openSync(filename, 'wx', 0o600)) }
          catch { throw new ClientAccessProjectionError('target-changed') }
        }
        db = new DatabaseSync(filename, { timeout: 1000 })
        db.exec('BEGIN IMMEDIATE')
        const observed = snapshot(db)
        if (present && digest(observed) !== expectedRevision || !present && observed !== JSON.stringify({ table: false, rows: [], profileState: { table: false, profile: null } })) {
          throw new ClientAccessProjectionError('target-changed')
        }
        assertCurrent()
        if (access.expiresAt <= Date.now() + 180_000) throw new ClientAccessProjectionError('credential-unusable')
        db.exec('CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)')
        db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB)')
        let value = payload.value
        if (context?.sameAccount) {
          const previous = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(payload.key)
          try {
            const stored = typeof previous?.value === 'string' ? JSON.parse(previous.value) : undefined
            if (typeof stored?.telemetry_generation === 'string') {
              value = JSON.stringify({ ...JSON.parse(value), telemetry_generation: stored.telemetry_generation })
            }
          } catch { /* Broken optional telemetry is not carried into a valid projection. */ }
        }
        const remove = db.prepare('DELETE FROM auth_kv WHERE key = ?')
        for (const key of tokenKeys) remove.run(key)
        db.prepare('INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)').run(payload.key, value)
        if (access.profileArn) {
          // Current CLI accepts this AuthProfile shape; the personal label is
          // its own login label. No upstream organization name is invented.
          const profile = { arn: access.profileArn,
            profile_name: access.provider === 'Google' || access.provider === 'Github' ? 'Social_Default_Profile' : '' }
          db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(profileStateKey, JSON.stringify(profile))
        } else {
          // Switching to an identity without an explicit profile must not leave
          // the previous account's profile available to the native API client.
          db.prepare('DELETE FROM state WHERE key = ?').run(profileStateKey)
        }
        const revision = digest(snapshot(db))
        db.exec('COMMIT'); committed = true
        return revision
      } catch (error) {
        if (error instanceof ClientAccessProjectionError) throw error
        throw new ClientAccessProjectionError('target-write-failed')
      } finally {
        if (db) {
          if (!committed) { try { db.exec('ROLLBACK') } catch { /* Opening may fail before a transaction begins. */ } }
          db.close()
        }
      }
    }
  }
}
