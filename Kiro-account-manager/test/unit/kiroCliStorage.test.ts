import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { inspectKiroCliRegistration, KiroCliRegistrationError, resolveKiroCliDatabasePath, writeKiroCliRegisteredToken } from '../../src/main/kiroCliStorage.ts'

test('CLI switches use the platform data root and ignore overrides from other platforms', () => {
  assert.equal(resolveKiroCliDatabasePath('darwin', '/Users/sample', { XDG_DATA_HOME: '/external' }),
    '/Users/sample/Library/Application Support/kiro-cli/data.sqlite3')
  assert.equal(resolveKiroCliDatabasePath('win32', 'C:\\Users\\Sample', { LOCALAPPDATA: 'D:\\LocalData', XDG_DATA_HOME: '/external' }),
    'D:\\LocalData\\kiro-cli\\data.sqlite3')
  assert.equal(resolveKiroCliDatabasePath('win32', 'C:\\Users\\Sample', { LOCALAPPDATA: 'relative' }),
    'C:\\Users\\Sample\\AppData\\Local\\kiro-cli\\data.sqlite3')
})

test('CLI on Linux accepts an absolute XDG data root and rejects empty or relative paths', () => {
  assert.equal(resolveKiroCliDatabasePath('linux', '/home/sample', { XDG_DATA_HOME: '/sandbox/local-data' }),
    '/sandbox/local-data/kiro-cli/data.sqlite3')
  for (const root of [undefined, '', 'relative', '~/relative']) {
    assert.equal(resolveKiroCliDatabasePath('linux', '/home/sample', { XDG_DATA_HOME: root }),
      '/home/sample/.local/share/kiro-cli/data.sqlite3')
  }
})

const registrationKey = 'kirocli:odic:device-registration'
const tokenKey = 'kirocli:odic:token'
const socialKey = 'kirocli:social:token'
const identity = { clientId: 'SYNTHETIC_ID', clientSecret: 'SYNTHETIC_SECRET', region: 'us-east-1' }
const registration = JSON.stringify({ client_id: identity.clientId, client_secret: identity.clientSecret, region: identity.region,
  client_secret_expires_at: '2099-11-07T00:00:00Z', oauth_flow: 'DeviceCode', scopes: ['codewhisperer:completions'] })

function fixture(t: Parameters<Parameters<typeof test>[1]>[0]): string {
  const root = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'cli-registration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'data.sqlite3')
}

test('CLI preflight requires the existing native registration and does not create a missing database', async t => {
  const path = fixture(t)
  await assert.rejects(inspectKiroCliRegistration(path, identity), KiroCliRegistrationError)
  assert.equal(existsSync(path), false)
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run(registrationKey, JSON.stringify({ client_id: identity.clientId, client_secret: identity.clientSecret, region: identity.region }))
  db.close()
  await assert.rejects(inspectKiroCliRegistration(path, identity), KiroCliRegistrationError)
})

test('IdC write preserves native registration and refuses a changed registration or token revision', async t => {
  const path = fixture(t)
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
    const set = db.prepare('INSERT OR REPLACE INTO auth_kv VALUES (?, ?)')
    const read = db.prepare('SELECT value FROM auth_kv WHERE key = ?')
    set.run(registrationKey, registration)
    set.run(tokenKey, 'SYNTHETIC_IDC_OLD')
    set.run(socialKey, 'SYNTHETIC_SOCIAL_OLD')
    await assert.rejects(inspectKiroCliRegistration(path, { ...identity, clientId: 'ANOTHER_CLIENT' }), KiroCliRegistrationError)
    const initial = await inspectKiroCliRegistration(path, identity)
    set.run(registrationKey, registration + ' ')
    await assert.rejects(writeKiroCliRegisteredToken(path, identity, initial, 'SYNTHETIC_DO_NOT_WRITE', () => {}), KiroCliRegistrationError)
    assert.equal(read.get(tokenKey)?.value, 'SYNTHETIC_IDC_OLD')

    set.run(registrationKey, registration)
    set.run(tokenKey, 'SYNTHETIC_ROTATED_BY_CLI')
    await assert.rejects(writeKiroCliRegisteredToken(path, identity, initial, 'SYNTHETIC_DO_NOT_WRITE', () => {}), KiroCliRegistrationError)
    assert.equal(read.get(tokenKey)?.value, 'SYNTHETIC_ROTATED_BY_CLI')
    assert.equal(read.get(socialKey)?.value, 'SYNTHETIC_SOCIAL_OLD')

    const current = await inspectKiroCliRegistration(path, identity)
    await writeKiroCliRegisteredToken(path, identity, current, 'SYNTHETIC_NEW', () => {})
    assert.equal(read.get(registrationKey)?.value, registration)
    assert.equal(read.get(tokenKey)?.value, 'SYNTHETIC_NEW')
    assert.equal(read.get(socialKey), undefined)
  } finally { db.close() }
})
