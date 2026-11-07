import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { cliAccessPayload, createCliAccessAdapter } from '../../src/main/cliAccessAdapter'
import { ClientAccessProjectionError, ClientAccessProjectionService, accessPrincipalFingerprint, type AccessCredential, type ManagerAccessSnapshot, type ClientAccessProjectionBinding, type ClientAccessProjectionRequest } from '../../src/main/clientAccessProjection'

const socialKey = 'kirocli:social:token'
const idcKey = 'kirocli:odic:token'
const legacyKey = 'codewhisperer:odic:token'
const registrationKey = 'kirocli:odic:device-registration'
const runtimeMarkerKey = 'kirocli:auth:last-forced-refresh-at'
const supportedKeys = [socialKey, idcKey, legacyKey, registrationKey]
const nativeRegistration = JSON.stringify({ client_id: 'SYNTHETIC_NATIVE_ID', client_secret: 'SYNTHETIC_NATIVE_SECRET', oauth_flow: 'Pkce', region: 'us-east-1' })
const principalA = 'synthetic-stable-user-a'
const principalB = 'synthetic-stable-user-b'
const context = { accountId: 'synthetic-account', runtimeId: 'synthetic-cli', explicit: true,
  principalFingerprint: accessPrincipalFingerprint({ provider: 'Github', principalId: principalA })! }
const contextFor = (credential: AccessCredential, principalId = principalA): typeof context => ({ ...context,
  principalFingerprint: accessPrincipalFingerprint({ provider: credential.provider, principalId, profileArn: credential.profileArn })! })
const access = (overrides: Partial<AccessCredential> = {}): AccessCredential => ({
  accessToken: 'SYNTHETIC_ACCESS_ONLY', expiresAt: Date.now() + 3_600_000,
  provider: 'Github', authMethod: 'social', profileArn: 'SYNTHETIC_PROFILE', ...overrides
})
const guard = (): void => { /* The account generation stays current in this fixture. */ }
const isError = (code: string) => (error: unknown): boolean => error instanceof ClientAccessProjectionError && error.code === code

function fixture(t: TestContext): { dir: string; path: string } {
  const root = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'cli-access-adapter-'))
  t.after(() => {
    const absolute = resolve(dir)
    assert.ok(isAbsolute(absolute) && absolute.startsWith(resolve(root) + sep), 'temporary cleanup must remain inside the isolated root')
    assert.equal(lstatSync(absolute).isSymbolicLink(), false)
    rmSync(absolute, { recursive: true, force: true })
  })
  return { dir, path: join(dir, 'client', 'data.sqlite3') }
}

function seed(path: string, rows: Array<[string, string]> = []): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('workspace', 'SYNTHETIC_KEEP_SETTINGS')
    const insert = db.prepare('INSERT INTO auth_kv VALUES (?, ?)')
    for (const row of rows) insert.run(...row)
  } finally { db.close() }
}

function rows(path: string): Array<[string, string]> {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT key, value FROM auth_kv ORDER BY key').all().map(row => [row.key as string, row.value as string]) }
  finally { db.close() }
}

function mutate(path: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try { action(db) } finally { db.close() }
}

function projectionFixture(t: TestContext, credential: AccessCredential = access()): {
  dir: string
  path: string
  adapter: ReturnType<typeof createCliAccessAdapter>
  accounts: Map<string, ManagerAccessSnapshot>
  bindings: Map<string, ClientAccessProjectionBinding>
  service: ClientAccessProjectionService
  request: ClientAccessProjectionRequest
} {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const accounts = new Map<string, ManagerAccessSnapshot>([
    ['account-a', { ...credential, principalId: principalA }],
    ['account-b', { ...access({ accessToken: 'SYNTHETIC_ACCOUNT_B_ACCESS', profileArn: 'SYNTHETIC_ACCOUNT_B_PROFILE' }), principalId: principalB }]
  ])
  const bindings = new Map<string, ClientAccessProjectionBinding>()
  const service = new ClientAccessProjectionService({
    account: id => accounts.get(id),
    adapter: id => id === 'synthetic-cli' ? adapter : undefined,
    readBindings: () => [...bindings.values()].map(binding => ({ ...binding })),
    writeBinding: (binding, expectedRevision) => {
      if (bindings.get(binding.authDomainId)?.revision !== expectedRevision) return false
      bindings.set(binding.authDomainId, { ...binding })
      return true
    }
  })
  t.after(() => service.close())
  return { ...f, adapter, service, accounts, bindings,
    request: { accountId: 'account-a', runtimeId: 'synthetic-cli', authDomainId: 'synthetic-auth' } }
}

function nativeSerialization(path: string, key: string, generation: string): Record<string, unknown> {
  const stored = JSON.parse(rows(path).find(([name]) => name === key)![1])
  const native = { telemetry_generation: generation, refresh_token: null, start_url: null, scopes: null,
    ...Object.fromEntries(Object.entries(stored).reverse()) }
  mutate(path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify(native, null, 2), key))
  return native
}

test('social payload includes its required provider and only the verified access schema', () => {
  for (const provider of ['Github', 'Google']) {
    const credential = access({ provider })
    const payload = cliAccessPayload(Object.freeze(credential))
    assert.equal(payload.key, socialKey)
    assert.deepEqual(JSON.parse(payload.value), {
      access_token: credential.accessToken, expires_at: new Date(credential.expiresAt).toISOString(),
      provider, profile_arn: credential.profileArn
    })
    assert.equal(payload.value.includes('refresh'), false)
    assert.equal(payload.value.includes('client_secret'), false)
    assert.equal(payload.value.includes('oauth_flow'), false)
  }
  for (const provider of ['', 'github', 'Unknown']) assert.throws(() => cliAccessPayload(access({ provider })), isError('credential-unusable'))
  assert.throws(() => cliAccessPayload(access({ profileArn: undefined })), isError('credential-unusable'))
  assert.throws(() => cliAccessPayload(access({ authMethod: 'IdC' })), isError('credential-unusable'))
})

test('IdC payload requires region and serializes a local oauth_flow tag without refresh or client registration', () => {
  for (const provider of ['BuilderId', 'Enterprise']) {
    const credential = access({ provider, authMethod: 'IdC', region: 'eu-west-1', profileArn: provider === 'BuilderId' ? undefined : 'SYNTHETIC_ENTERPRISE_PROFILE',
      ...(provider === 'Enterprise' ? { startUrl: 'https://synthetic-team.awsapps.com/start' } : {}) })
    const payload = cliAccessPayload(credential)
    const value = JSON.parse(payload.value)
    assert.equal(payload.key, idcKey)
    assert.equal(value.region, 'eu-west-1')
    assert.equal(value.oauth_flow, 'DeviceCode')
    assert.deepEqual(Object.keys(value).sort(), ['access_token', 'expires_at', 'oauth_flow', 'region', ...(credential.profileArn ? ['profile_arn'] : []), ...(provider === 'Enterprise' ? ['start_url'] : [])].sort())
    assert.equal(value.provider, undefined)
    assert.equal(value.refresh_token, undefined)
    assert.equal(value.client_secret, undefined)
    assert.equal(value.client_id, undefined)
  }
  for (const region of [undefined, '', 'relative', 'US-EAST-1', 'us-east-1\0']) {
    assert.throws(() => cliAccessPayload(access({ provider: 'BuilderId', authMethod: 'IdC', region })), isError('credential-unusable'))
  }
  assert.throws(() => cliAccessPayload(access({ provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined })), isError('credential-unusable'))
})

test('Enterprise JSON preserves its validated organization start URL and profile without creating refresh capability', async t => {
  const f = fixture(t)
  for (const [index, startUrl] of [
    'https://synthetic-team.awsapps.com/start',
    'https://synthetic-team.awsapps.com/start/',
    'https://synthetic-team.awsapps.com/directory/d-synthetic123'
  ].entries()) {
    const credential = access({ provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
      profileArn: 'SYNTHETIC_ORGANIZATION_PROFILE', startUrl })
    const payload = cliAccessPayload(credential)
    assert.equal(payload.key, idcKey)
    assert.deepEqual(JSON.parse(payload.value), {
      access_token: credential.accessToken, expires_at: new Date(credential.expiresAt).toISOString(),
      region: 'us-east-1', oauth_flow: 'DeviceCode', start_url: startUrl, profile_arn: 'SYNTHETIC_ORGANIZATION_PROFILE'
    })
    const path = join(f.dir, String(index), 'data.sqlite3')
    const adapter = createCliAccessAdapter({ databasePath: path, authDomainId: `enterprise-${index}` })
    adapter.validate!(credential)
    await adapter.write(credential, await adapter.readRevision(), guard, contextFor(credential))
    assert.deepEqual(rows(path), [[idcKey, payload.value]])
  }
})

test('Enterprise rejects missing, Builder portal and malicious organization URLs before creating target files', async t => {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-enterprise' })
  const initial = await adapter.readRevision()
  for (const startUrl of [undefined, '', ' ', 'https://view.awsapps.com/start', 'https://view.awsapps.com/start/',
    'http://synthetic-team.awsapps.com/start', 'https://awsapps.com.attacker.invalid/start',
    'https://notawsapps.com/start', 'https://user:password@synthetic-team.awsapps.com/start',
    'https://synthetic-team.awsapps.com:8443/start', 'https://synthetic-team.awsapps.com/start?redirect=elsewhere',
    'https://synthetic-team.awsapps.com/start#token', 'https://synthetic-team.awsapps.com/other',
    'javascript:alert(1)', 'file:///synthetic/start', 'https://synthetic-team.awsapps.com/' + 'x'.repeat(2050)]) {
    const credential = access({ provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
      profileArn: 'SYNTHETIC_ENTERPRISE_PROFILE', startUrl })
    assert.throws(() => adapter.validate!(credential), isError('credential-unusable'))
    await assert.rejects(adapter.write(credential, initial, guard, contextFor(credential)), isError('credential-unusable'))
    assert.equal(existsSync(dirname(f.path)), false)
  }
  for (const profileArn of [undefined, '']) {
    const credential = access({ provider: 'Enterprise', authMethod: 'IdC', region: 'us-east-1',
      startUrl: 'https://synthetic-team.awsapps.com/start', profileArn })
    assert.throws(() => cliAccessPayload(credential), isError('credential-unusable'))
  }
})

test('Builder ID omits start_url completely even when manager metadata contains an empty URL or the Builder portal', () => {
  for (const startUrl of [undefined, '', 'https://view.awsapps.com/start', 'https://synthetic-team.awsapps.com/start']) {
    const credential = access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined, startUrl })
    const payload = JSON.parse(cliAccessPayload(credential).value)
    assert.equal(Object.hasOwn(payload, 'start_url'), false)
    assert.equal(Object.hasOwn(payload, 'refresh_token'), false)
    assert.equal(payload.oauth_flow, 'DeviceCode')
  }
})

test('richer manager objects cannot leak refresh tokens, client secrets or registrations through the adapter', async t => {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  for (const secret of [
    { refreshToken: 'SYNTHETIC_MANAGER_REFRESH' },
    { refresh_token: 'SYNTHETIC_MANAGER_REFRESH' },
    { clientSecret: 'SYNTHETIC_MANAGER_SECRET' },
    { client_id: 'SYNTHETIC_MANAGER_CLIENT' },
    { principalId: principalA },
    { registration: nativeRegistration }
  ]) {
    const credential = { ...access(), ...secret }
    assert.throws(() => cliAccessPayload(credential), isError('credential-unusable'))
    await assert.rejects(adapter.write(credential, revision, guard, context), isError('credential-unusable'))
    assert.equal(existsSync(f.path), false)
  }
})

test('readRevision is side-effect free for an absent directory/database and an existing database without auth_kv', async t => {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const first = await adapter.readRevision()
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(await adapter.readRevision(), first)
  assert.equal(existsSync(dirname(f.path)), false)
  mkdirSync(dirname(f.path), { recursive: true })
  mutate(f.path, db => db.exec('CREATE TABLE workspace (name TEXT)'))
  const before = readFileSync(f.path)
  const existing = await adapter.readRevision()
  assert.notEqual(existing, first)
  assert.deepEqual(readFileSync(f.path), before)
  mutate(f.path, db => assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='auth_kv'").get(), undefined))
})

test('new Social and IdC stores receive no refresh capability or registration and source manager data stays unchanged', async t => {
  const f = fixture(t)
  const mainData = join(f.dir, 'manager.json')
  const manager = Object.freeze({ ...access(), principalId: principalA, refreshToken: 'SYNTHETIC_KEEP_MANAGER_REFRESH', clientSecret: 'SYNTHETIC_KEEP_MANAGER_SECRET', autoRefreshEnabled: true })
  const original = JSON.stringify(manager)
  writeFileSync(mainData, original)
  for (const provider of ['Github', 'BuilderId']) {
    const target = join(f.dir, provider, 'data.sqlite3')
    const adapter = createCliAccessAdapter({ databasePath: target, authDomainId: `synthetic-${provider}` })
    const credential = Object.freeze(access({ provider, authMethod: provider === 'Github' ? 'social' : 'IdC', region: 'us-east-1' }))
    const before = JSON.stringify(credential)
    const committed = await adapter.write(credential, await adapter.readRevision(), guard, contextFor(credential))
    assert.equal(await adapter.readRevision(), committed)
    const entries = rows(target)
    assert.equal(entries.length, 1)
    const value = JSON.parse(entries[0][1])
    assert.equal(value.refresh_token, undefined)
    assert.equal(value.client_secret, undefined)
    assert.equal(value.client_id, undefined)
    assert.equal(entries.some(([key]) => key === registrationKey), false)
    assert.equal(JSON.stringify(credential), before)
    assert.equal(JSON.stringify(manager), original)
    assert.equal(readFileSync(mainData, 'utf8'), original)
  }
})

test('switching replaces every competing token row while preserving the exact native registration and non-auth data', async t => {
  const f = fixture(t)
  seed(f.path, [[registrationKey, nativeRegistration], [socialKey, 'SYNTHETIC_OLD_SOCIAL'], [idcKey, 'SYNTHETIC_OLD_IDC'], [legacyKey, 'SYNTHETIC_OLD_LEGACY']])
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  for (const credential of [access(), access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1' }), access({ provider: 'Google' })]) {
    const payload = cliAccessPayload(credential)
    const next = await adapter.write(credential, await adapter.readRevision(), guard, contextFor(credential))
    assert.deepEqual(rows(f.path), [[registrationKey, nativeRegistration], [payload.key, payload.value]].sort(([a], [b]) => a.localeCompare(b)))
    assert.equal(await adapter.readRevision(), next)
    mutate(f.path, db => assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get('workspace')?.value, 'SYNTHETIC_KEEP_SETTINGS'))
  }
})

test('CAS covers every credential and registration row, not only the selected token scheme', async t => {
  const f = fixture(t)
  for (const changed of supportedKeys) {
    const path = join(f.dir, String(supportedKeys.indexOf(changed)), 'data.sqlite3')
    seed(path, supportedKeys.map(key => [key, `SYNTHETIC_ORIGINAL_${key}`]))
    const adapter = createCliAccessAdapter({ databasePath: path, authDomainId: 'synthetic-auth' })
    const original = await adapter.readRevision()
    mutate(path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run('SYNTHETIC_CONCURRENT_CHANGE', changed))
    const current = rows(path)
    await assert.rejects(adapter.write(access(), original, guard, context), isError('target-changed'))
    assert.deepEqual(rows(path), current)
  }
})

test('the official forced-refresh timestamp is preserved and does not count as a credential identity change', async t => {
  const f = fixture(t)
  seed(f.path, [[socialKey, 'SYNTHETIC_OLD'], [registrationKey, nativeRegistration]])
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const beforeMarker = await adapter.readRevision()
  mutate(f.path, db => db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run(runtimeMarkerKey, '1800000000'))
  assert.equal(await adapter.readRevision(), beforeMarker, 'a new runtime marker is not a login change')
  mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run('1800000060', runtimeMarkerKey))
  assert.equal(await adapter.readRevision(), beforeMarker, 'the CLI may advance its runtime timestamp between preflight and commit')
  const credential = access()
  const payload = cliAccessPayload(credential)
  const committed = await adapter.write(credential, beforeMarker, guard, context)
  assert.deepEqual(rows(f.path), [
    [runtimeMarkerKey, '1800000060'], [registrationKey, nativeRegistration], [payload.key, payload.value]
  ].sort(([a], [b]) => a.localeCompare(b)))
  assert.equal(await adapter.readRevision(), committed)
  mutate(f.path, db => db.prepare('DELETE FROM auth_kv WHERE key=?').run(runtimeMarkerKey))
  assert.equal(await adapter.readRevision(), committed, 'removing non-credential runtime metadata is not a login change')
})

test('real service and SQLite adapter continue syncing after native CLI optional-null and telemetry serialization', async t => {
  for (const credential of [access(), access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined })]) {
    const f = projectionFixture(t, credential)
    const key = cliAccessPayload(credential).key
    assert.equal((await f.service.execute(f.request)).status, 'projected')
    const binding = f.bindings.get('synthetic-auth')!
    const native = nativeSerialization(f.path, key, 'SYNTHETIC_NATIVE_TELEMETRY')
    if (credential.provider === 'BuilderId') {
      native.profile_arn = null
      mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify(native), key))
    }
    assert.equal(await f.adapter.readRevision(), binding.targetRevision, 'serialization-only changes do not alter credential identity')
    assert.equal((await f.service.tick())[0].status, 'unchanged')
    assert.equal(f.bindings.get('synthetic-auth')!.status, 'active')

    const renewed = { ...f.accounts.get('account-a')!, accessToken: 'SYNTHETIC_ORIGINAL_MANAGER_NEXT_ACCESS', expiresAt: Date.now() + 7_200_000 }
    f.accounts.set('account-a', renewed)
    const beforeManager = JSON.stringify(renewed)
    const result = (await f.service.tick())[0]
    assert.equal(result.status, 'projected')
    assert.equal(result.targetCommitted, true)
    assert.equal(f.bindings.get('synthetic-auth')!.status, 'active')
    const projected = JSON.parse(rows(f.path).find(([name]) => name === key)![1])
    assert.equal(projected.access_token, renewed.accessToken)
    assert.equal(projected.expires_at, new Date(renewed.expiresAt).toISOString())
    assert.equal(projected.telemetry_generation, 'SYNTHETIC_NATIVE_TELEMETRY')
    assert.equal(projected.refresh_token, undefined)
    assert.equal(projected.client_secret, undefined)
    assert.equal(projected.principalId, undefined)
    assert.equal(JSON.stringify(projected).includes(principalA), false)
    assert.equal(JSON.stringify(f.accounts.get('account-a')), beforeManager)
    assert.equal((await f.service.tick())[0].status, 'unchanged')
  }
})

test('UTC expiry serialization from whole-second .000Z to Z does not stop a real service binding', async t => {
  const wholeSecond = Math.floor(Date.now() / 1000) * 1000 + 3_600_000
  const credential = access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined, expiresAt: wholeSecond })
  const f = projectionFixture(t, credential)
  assert.equal((await f.service.execute(f.request)).status, 'projected')
  const initialBinding = { ...f.bindings.get('synthetic-auth')! }
  const native = nativeSerialization(f.path, idcKey, 'SYNTHETIC_EXPIRY_TELEMETRY')
  assert.match(String(native.expires_at), /\.000Z$/)
  native.expires_at = String(native.expires_at).replace(/\.000Z$/, 'Z')
  mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify(native), idcKey))
  const unchanged = (await f.service.tick())[0]
  assert.equal(unchanged.status, 'unchanged', 'the official CLI changed only UTC formatting, not the expiration instant')
  assert.equal(f.bindings.get('synthetic-auth')!.status, 'active')
  assert.equal(f.bindings.get('synthetic-auth')!.revision, initialBinding.revision)
  const renewed = { ...f.accounts.get('account-a')!, accessToken: 'SYNTHETIC_NEW_ACCESS_AFTER_FORMAT_CHANGE', expiresAt: wholeSecond + 3_600_000 }
  f.accounts.set('account-a', renewed)
  assert.equal((await f.service.tick())[0].status, 'projected')
  const projected = JSON.parse(rows(f.path).find(([key]) => key === idcKey)![1])
  assert.equal(projected.access_token, renewed.accessToken)
  assert.equal(projected.expires_at, new Date(renewed.expiresAt).toISOString())
  assert.equal(projected.telemetry_generation, 'SYNTHETIC_EXPIRY_TELEMETRY')
  assert.equal(projected.refresh_token, undefined)
  assert.equal(f.bindings.get('synthetic-auth')!.principalFingerprint, initialBinding.principalFingerprint)
  assert.equal(f.accounts.get('account-a'), renewed)
})

test('UTC expiry fractional trailing zeros are equivalent without changing the active binding', async t => {
  const base = Date.UTC(2099, 2, 1, 12, 0, 0)
  for (const sample of [
    { millis: 120, representations: ['.120000Z', '.12Z'] },
    { millis: 100, representations: ['.100000Z', '.1Z'] },
    { millis: 10, representations: ['.010000Z', '.01Z'] },
    { millis: 1, representations: ['.001000Z', '.001Z'] },
    { millis: 0, representations: ['.000000Z', 'Z'] }
  ]) {
    const credential = access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined, expiresAt: base + sample.millis })
    const f = projectionFixture(t, credential)
    await f.service.execute(f.request)
    const binding = { ...f.bindings.get('synthetic-auth')! }
    const native = nativeSerialization(f.path, idcKey, 'SYNTHETIC_TRAILING_ZERO_TELEMETRY')
    for (const fraction of sample.representations) {
      native.expires_at = '2099-03-01T12:00:00' + fraction
      mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify(native), idcKey))
      assert.equal((await f.service.tick())[0].status, 'unchanged', String(native.expires_at))
      assert.equal(f.bindings.get('synthetic-auth')!.revision, binding.revision)
      assert.equal(f.bindings.get('synthetic-auth')!.status, 'active')
      assert.equal(await f.adapter.readRevision(), binding.targetRevision)
    }
  }
})

test('UTC expiry normalization still rejects real time changes, invalid calendar dates and non-string fields', async t => {
  const wholeSecond = Date.UTC(2099, 2, 1, 12, 0, 0)
  for (const replacement of [
    new Date(wholeSecond + 1).toISOString(),
    new Date(wholeSecond + 1000).toISOString(),
    'not-an-expiry',
    '2099-02-29T12:00:00Z',
    '2099-03-01T12:00:00.invalidZ',
    wholeSecond,
    null,
    { utc: '2099-03-01T12:00:00Z' }
  ]) {
    const credential = access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1', profileArn: undefined, expiresAt: wholeSecond })
    const f = projectionFixture(t, credential)
    await f.service.execute(f.request)
    const expected = f.bindings.get('synthetic-auth')!.targetRevision
    const native = nativeSerialization(f.path, idcKey, 'SYNTHETIC_INVALID_EXPIRY_TELEMETRY')
    native.expires_at = replacement
    mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify(native), idcKey))
    const changed = rows(f.path)
    assert.notEqual(await f.adapter.readRevision(), expected, JSON.stringify(replacement))
    await assert.rejects(f.adapter.write(credential, expected, guard, contextFor(credential)), isError('target-changed'))
    const stopped = (await f.service.tick())[0]
    assert.equal(stopped.reason, 'target-changed')
    assert.equal(stopped.targetCommitted, false)
    assert.equal(f.bindings.get('synthetic-auth')!.status, 'needs-attention')
    assert.deepEqual(rows(f.path), changed)
  }
})

test('normalization still rejects real access, refresh, profile, expiry and other authentication changes', async t => {
  const mutations: Array<{ credential?: AccessCredential; patch: Record<string, unknown> }> = [
    { patch: { access_token: 'SYNTHETIC_EXTERNAL_LOGIN_ACCESS' } },
    { patch: { refresh_token: 'SYNTHETIC_EXTERNAL_REFRESH_CAPABILITY' } },
    { patch: { profile_arn: 'SYNTHETIC_EXTERNAL_PROFILE' } },
    { patch: { expires_at: new Date(Date.now() + 9_000_000).toISOString() } },
    { patch: { provider: 'Google' } },
    { patch: { start_url: 'https://example.invalid/synthetic-start' } },
    { patch: { scopes: ['synthetic:new-scope'] } },
    { patch: { unknown_auth_field: null } },
    { credential: access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1' }), patch: { region: 'eu-west-1' } },
    { credential: access({ provider: 'BuilderId', authMethod: 'IdC', region: 'us-east-1' }), patch: { oauth_flow: 'Pkce' } }
  ]
  for (const scenario of mutations) {
    const credential = scenario.credential ?? access()
    const f = projectionFixture(t, credential)
    const key = cliAccessPayload(credential).key
    await f.service.execute(f.request)
    const expectedRevision = f.bindings.get('synthetic-auth')!.targetRevision
    const native = nativeSerialization(f.path, key, 'SYNTHETIC_NATIVE_TELEMETRY')
    mutate(f.path, db => db.prepare('UPDATE auth_kv SET value=? WHERE key=?').run(JSON.stringify({ ...native, ...scenario.patch }), key))
    const changedRows = rows(f.path)
    assert.notEqual(await f.adapter.readRevision(), expectedRevision, Object.keys(scenario.patch)[0])
    await assert.rejects(f.adapter.write(credential, expectedRevision, guard, contextFor(credential)), isError('target-changed'))
    const result = (await f.service.tick())[0]
    assert.equal(result.status, 'needs-attention')
    assert.equal(result.reason, 'target-changed')
    assert.equal(result.targetCommitted, false)
    assert.equal(f.bindings.get('synthetic-auth')!.status, 'needs-attention')
    assert.deepEqual(rows(f.path), changedRows, 'neither direct CAS nor automatic sync overwrites a different login')
  }
})

test('real account replacement does not carry the previous account telemetry generation', async t => {
  const f = projectionFixture(t)
  await f.service.execute(f.request)
  nativeSerialization(f.path, socialKey, 'SYNTHETIC_ACCOUNT_A_TELEMETRY')
  f.accounts.set('account-a', { ...f.accounts.get('account-a')!, accessToken: 'SYNTHETIC_ACCOUNT_A_NEW_ACCESS' })
  assert.equal((await f.service.tick())[0].status, 'projected')
  assert.equal(JSON.parse(rows(f.path).find(([key]) => key === socialKey)![1]).telemetry_generation, 'SYNTHETIC_ACCOUNT_A_TELEMETRY')
  const accountA = JSON.stringify(f.accounts.get('account-a'))
  const replacement = await f.service.execute({ ...f.request, accountId: 'account-b' })
  assert.equal(replacement.status, 'projected')
  assert.equal(f.bindings.get('synthetic-auth')!.accountId, 'account-b')
  const projected = JSON.parse(rows(f.path).find(([key]) => key === socialKey)![1])
  assert.equal(projected.access_token, f.accounts.get('account-b')!.accessToken)
  assert.equal(projected.profile_arn, f.accounts.get('account-b')!.profileArn)
  assert.equal(projected.telemetry_generation, undefined)
  assert.equal(JSON.stringify(f.accounts.get('account-a')), accountA)
})

test('CAS rejects inserted/deleted rows and a database created after an absent preflight', async t => {
  const f = fixture(t)
  for (const mutation of ['insert', 'delete'] as const) {
    const path = join(f.dir, mutation, 'data.sqlite3')
    seed(path, [[socialKey, 'SYNTHETIC_OLD']])
    const adapter = createCliAccessAdapter({ databasePath: path, authDomainId: 'synthetic-auth' })
    const previous = await adapter.readRevision()
    mutate(path, db => mutation === 'insert' ? db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run(registrationKey, nativeRegistration) : db.exec('DELETE FROM auth_kv'))
    const changed = rows(path)
    await assert.rejects(adapter.write(access(), previous, guard, context), isError('target-changed'))
    assert.deepEqual(rows(path), changed)
  }
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const absent = await adapter.readRevision()
  seed(f.path, [[socialKey, 'SYNTHETIC_CREATED_BY_NATIVE_CLI']])
  await assert.rejects(adapter.write(access(), absent, guard, context), isError('target-changed'))
  assert.deepEqual(rows(f.path), [[socialKey, 'SYNTHETIC_CREATED_BY_NATIVE_CLI']])
})

test('unknown auth schemes are refused both during inspection and if inserted after inspection', async t => {
  const f = fixture(t)
  seed(f.path, [[socialKey, 'SYNTHETIC_OLD']])
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  mutate(f.path, db => db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('future:credential', 'SYNTHETIC_HIGH_PRIORITY_AUTH'))
  const current = rows(f.path)
  await assert.rejects(adapter.readRevision(), isError('target-read-failed'))
  await assert.rejects(adapter.write(access(), revision, guard, context), isError('target-write-failed'))
  assert.deepEqual(rows(f.path), current)
})

test('a failed source guard inside the SQLite transaction preserves old credentials and releases the write lock', async t => {
  const f = fixture(t)
  seed(f.path, [[socialKey, 'SYNTHETIC_OLD'], [registrationKey, nativeRegistration]])
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  const before = rows(f.path)
  let calls = 0
  await assert.rejects(adapter.write(access(), revision, () => {
    calls++
    if (calls === 2) throw new ClientAccessProjectionError('credential-changed')
  }, context), isError('credential-changed'))
  assert.equal(calls, 2)
  assert.deepEqual(rows(f.path), before)
  mutate(f.path, db => { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK') })
})

test('a failing initial guard creates no directory or database', async t => {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  await assert.rejects(adapter.write(access(), revision, () => { throw new ClientAccessProjectionError('account-unavailable') }, context), isError('account-unavailable'))
  assert.equal(existsSync(dirname(f.path)), false)
})

test('expired and near-expiry access never replaces an existing database', async t => {
  const f = fixture(t)
  seed(f.path, [[socialKey, 'SYNTHETIC_STILL_VALID_TARGET']])
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  const before = readFileSync(f.path)
  for (const expiresAt of [Date.now() - 1, Date.now(), Date.now() + 120_000]) {
    await assert.rejects(adapter.write(access({ expiresAt }), revision, guard, context), isError('credential-unusable'))
    assert.deepEqual(readFileSync(f.path), before)
  }
})

test('expired access does not create a missing target directory or database', async t => {
  const f = fixture(t)
  const adapter = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  const revision = await adapter.readRevision()
  await assert.rejects(adapter.write(access({ expiresAt: Date.now() - 1 }), revision, guard, context), isError('credential-unusable'))
  assert.equal(existsSync(f.path), false)
  assert.equal(existsSync(dirname(f.path)), false)
})

test('relative, empty-domain, directory and corrupt database configurations are rejected without overwriting content', async t => {
  const f = fixture(t)
  assert.throws(() => createCliAccessAdapter({ databasePath: 'relative.sqlite3', authDomainId: 'synthetic-auth' }), /Invalid CLI access configuration/)
  assert.throws(() => createCliAccessAdapter({ databasePath: f.path, authDomainId: '' }), /Invalid CLI access configuration/)
  const directoryAdapter = createCliAccessAdapter({ databasePath: f.dir, authDomainId: 'synthetic-auth' })
  await assert.rejects(directoryAdapter.readRevision(), isError('target-read-failed'))
  await assert.rejects(directoryAdapter.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  mkdirSync(dirname(f.path), { recursive: true })
  const original = 'SYNTHETIC_NOT_A_SQLITE_DATABASE'
  writeFileSync(f.path, original)
  const corrupt = createCliAccessAdapter({ databasePath: f.path, authDomainId: 'synthetic-auth' })
  await assert.rejects(corrupt.readRevision(), isError('target-read-failed'))
  await assert.rejects(corrupt.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.equal(readFileSync(f.path, 'utf8'), original)
})

test('a direct parent symbolic link or Windows junction cannot redirect authentication writes', async t => {
  const f = fixture(t)
  const actual = join(f.dir, 'actual')
  const linked = join(f.dir, 'linked')
  seed(join(actual, 'data.sqlite3'), [[socialKey, 'SYNTHETIC_UNCHANGED']])
  symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const adapter = createCliAccessAdapter({ databasePath: join(linked, 'data.sqlite3'), authDomainId: 'synthetic-auth' })
  await assert.rejects(adapter.readRevision(), isError('target-read-failed'))
  await assert.rejects(adapter.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.deepEqual(rows(join(actual, 'data.sqlite3')), [[socialKey, 'SYNTHETIC_UNCHANGED']])
})

test('an ancestor symbolic link or junction cannot bypass target path validation', async t => {
  const f = fixture(t)
  const actual = join(f.dir, 'actual')
  const actualPath = join(actual, 'nested', 'data.sqlite3')
  const linked = join(f.dir, 'linked')
  seed(actualPath, [[socialKey, 'SYNTHETIC_UNCHANGED']])
  symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const adapter = createCliAccessAdapter({ databasePath: join(linked, 'nested', 'data.sqlite3'), authDomainId: 'synthetic-auth' })
  await assert.rejects(adapter.readRevision(), isError('target-read-failed'))
  await assert.rejects(adapter.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.deepEqual(rows(actualPath), [[socialKey, 'SYNTHETIC_UNCHANGED']])
})

test('a symbolic link at the database file is rejected without touching its target', async t => {
  const f = fixture(t)
  const actualPath = join(f.dir, 'actual.sqlite3')
  const linkedPath = join(f.dir, 'linked.sqlite3')
  seed(actualPath, [[socialKey, 'SYNTHETIC_UNCHANGED']])
  try { symlinkSync(actualPath, linkedPath, 'file') }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows host does not permit file symlinks; directory junction tests still cover path redirection')
      return
    }
    throw error
  }
  const adapter = createCliAccessAdapter({ databasePath: linkedPath, authDomainId: 'synthetic-auth' })
  await assert.rejects(adapter.readRevision(), isError('target-read-failed'))
  await assert.rejects(adapter.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.deepEqual(rows(actualPath), [[socialKey, 'SYNTHETIC_UNCHANGED']])
})

test('NUL paths and a non-directory ancestor never create or alter the requested target', async t => {
  const f = fixture(t)
  const invalid = createCliAccessAdapter({ databasePath: f.path + '\0', authDomainId: 'synthetic-auth' })
  await assert.rejects(invalid.readRevision(), isError('target-read-failed'))
  await assert.rejects(invalid.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.equal(existsSync(f.path), false)
  const fileParent = join(f.dir, 'not-a-directory')
  writeFileSync(fileParent, 'SYNTHETIC_KEEP_FILE')
  const belowFile = createCliAccessAdapter({ databasePath: join(fileParent, 'nested', 'data.sqlite3'), authDomainId: 'synthetic-auth' })
  await assert.rejects(belowFile.readRevision(), isError('target-read-failed'))
  await assert.rejects(belowFile.write(access(), 'synthetic-revision', guard, context), isError('target-write-failed'))
  assert.equal(readFileSync(fileParent, 'utf8'), 'SYNTHETIC_KEEP_FILE')
})
