import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ClientAccessProjectionError, type AccessCredential, type ClientAccessProjectionAdapter } from './clientAccessProjection'

const tokenKeys = ['kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token'] as const
const registrationKey = 'kirocli:odic:device-registration'
const runtimeMarkerKey = 'kirocli:auth:last-forced-refresh-at'
const supportedKeys = new Set<string>([...tokenKeys, registrationKey, runtimeMarkerKey])

function authenticationValue(key: string, raw: string): unknown {
  if (!(tokenKeys as readonly string[]).includes(key)) return raw
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return raw
    // CLI serializes optional fields as null and adds a telemetry-only generation
    // on its first real request. Neither operation changes the authentication.
    const optional = new Set(['refresh_token', 'start_url', 'scopes', 'profile_arn'])
    return Object.keys(value).sort().filter(name => name !== 'telemetry_generation' && !(optional.has(name) && value[name] === null))
      .map(name => [name, value[name]])
  } catch { return raw }
}

function existsFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('invalid-database')
    return true
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function snapshot(db: DatabaseSync): string {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_kv'").get()
  if (!table) return JSON.stringify({ table: false, rows: [] })
  const rows = db.prepare('SELECT key, value FROM auth_kv ORDER BY key').all()
  if (rows.length > 256 || rows.some(row => typeof row.key !== 'string' || typeof row.value !== 'string' || row.value.length > 1024 * 1024)) {
    throw new Error('unsupported-auth-store')
  }
  // A newer, higher-priority auth scheme must never silently win over this projection.
  if (rows.some(row => !supportedKeys.has(row.key as string))) throw new Error('unsupported-auth-entry')
  // The CLI updates this timestamp itself; it is not a login/credential change.
  return JSON.stringify({ table: true, rows: rows.filter(row => row.key !== runtimeMarkerKey).map(row => [row.key, authenticationValue(row.key as string, row.value as string)]) })
}

const absent = (): string => createHash('sha256').update('cli-access-v1\0absent').digest('hex')
const digest = (value: string): string => createHash('sha256').update('cli-access-v1\0').update(value).digest('hex')

/** Native CLI 3.1 access-only schema, verified without refresh tokens or registrations. */
export function cliAccessPayload(access: Readonly<AccessCredential>): { key: string; value: string } {
  if (Object.keys(access).some(key => !['accessToken', 'expiresAt', 'provider', 'authMethod', 'profileArn', 'region', 'startUrl'].includes(key)) ||
      typeof access.accessToken !== 'string' || !access.accessToken || !Number.isFinite(access.expiresAt) ||
      !['Github', 'Google', 'BuilderId', 'Enterprise'].includes(access.provider)) throw new ClientAccessProjectionError('credential-unusable')
  const social = access.provider === 'Google' || access.provider === 'Github'
  if (access.authMethod !== undefined && access.authMethod !== (social ? 'social' : 'IdC') ||
      access.provider !== 'BuilderId' && !access.profileArn ||
      !social && (!access.region || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(access.region))) {
    throw new ClientAccessProjectionError('credential-unusable')
  }
  if (access.provider === 'Enterprise') {
    try {
      if (!access.startUrl || access.startUrl.length > 2048) throw new Error()
      const issuer = new URL(access.startUrl)
      if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash ||
          !/(^|\.)awsapps\.com$/.test(issuer.hostname) || !/^\/(?:start\/?|directory\/[a-zA-Z0-9-]+\/?)$/.test(issuer.pathname) ||
          issuer.href.replace(/\/$/, '') === 'https://view.awsapps.com/start') throw new Error()
    } catch { throw new ClientAccessProjectionError('credential-unusable') }
  }
  const value = {
    access_token: access.accessToken,
    expires_at: new Date(access.expiresAt).toISOString(),
    ...(social ? { provider: access.provider } : {
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
        if (present && digest(observed) !== expectedRevision || !present && observed !== JSON.stringify({ table: false, rows: [] })) {
          throw new ClientAccessProjectionError('target-changed')
        }
        assertCurrent()
        if (access.expiresAt <= Date.now() + 180_000) throw new ClientAccessProjectionError('credential-unusable')
        db.exec('CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)')
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
