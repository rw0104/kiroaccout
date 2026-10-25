import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCipheriv, randomBytes, pbkdf2Sync } from 'node:crypto'
import { openSecureStore, type SystemSecretStorage } from '../../src/main/secureStore.ts'

function secretStorage(marker = 'synthetic-os-key'): SystemSecretStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(marker + ':' + value),
    decryptString: bytes => { const text = bytes.toString(); if (!text.startsWith(marker + ':')) throw Error('locked'); return text.slice(marker.length + 1) }
  }
}
function fixture(t: TestContext): string {
  const base = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'kiro-synthetic-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const values = { accountData: { accounts: { synthetic: { credentials: { refreshToken: 'SYNTHETIC_REFRESH_ONLY' } } } }, proxyConfig: { apiKey: 'SYNTHETIC_API_KEY_ONLY' }, unknownFutureSetting: [1, 2] }
function legacyBytes(value: unknown): Buffer {
  const iv = randomBytes(16)
  const key = pbkdf2Sync('kiro-account-manager-secret-key', iv, 10000, 32, 'sha512')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, Buffer.from(':'), cipher.update(JSON.stringify(value)), cipher.final()])
}

test('legacy credentials and all unknown settings migrate once, encrypted with an OS protected random key', t => {
  const dir = fixture(t), secrets = secretStorage()
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes(values))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.json'), JSON.stringify(values.accountData))
  const store = openSecureStore(dir, secrets, 'win32')
  assert.deepEqual(store.get('accountData'), values.accountData)
  assert.deepEqual(store.get('unknownFutureSetting'), [1, 2])
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.backup.json')), false)
  const encrypted = fs.readFileSync(store.path, 'utf8')
  assert.doesNotMatch(encrypted, /SYNTHETIC_REFRESH_ONLY|SYNTHETIC_API_KEY_ONLY/)
  assert.deepEqual(openSecureStore(dir, secrets, 'win32').get('proxyConfig'), values.proxyConfig)
  const copy = store.get('accountData') as typeof values.accountData
  copy.accounts.synthetic.credentials.refreshToken = 'CHANGED_ONLY_IN_MEMORY'
  assert.deepEqual(store.get('accountData'), values.accountData)
  store.set('extra', { flag: true })
  assert.deepEqual(openSecureStore(dir, secrets, 'win32').get('extra'), { flag: true })
})

test('separate installations create different keys and wrong OS identity cannot decrypt the store', t => {
  const left = fixture(t), right = fixture(t), secrets = secretStorage()
  const a = openSecureStore(left, secrets, 'win32'), b = openSecureStore(right, secrets, 'win32')
  a.set('accountData', values.accountData); b.set('accountData', values.accountData)
  assert.notDeepEqual(fs.readFileSync(path.join(left, 'kiro-accounts.key.enc')), fs.readFileSync(path.join(right, 'kiro-accounts.key.enc')))
  assert.throws(() => openSecureStore(left, secretStorage('other-os-user'), 'win32'), /安全存储|解密|密钥/)
})

test('unavailable or Linux basic_text storage leaves legacy data intact and never writes plaintext fallbacks', t => {
  for (const platform of ['win32', 'linux'] as const) {
    const dir = fixture(t), legacy = legacyBytes(values)
    fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacy)
    const secrets = secretStorage()
    if (platform === 'linux') secrets.getSelectedStorageBackend = () => 'basic_text'
    else secrets.isEncryptionAvailable = () => false
    assert.throws(() => openSecureStore(dir, secrets, platform), /安全存储/)
    assert.deepEqual(fs.readdirSync(dir), ['kiro-accounts.json'])
    assert.deepEqual(fs.readFileSync(path.join(dir, 'kiro-accounts.json')), legacy)
  }
})

test('a corrupted current generation restores the authenticated backup, while both corrupt fails closed', t => {
  const dir = fixture(t), secrets = secretStorage(), store = openSecureStore(dir, secrets, 'win32')
  store.set('value', 'first'); store.set('value', 'second')
  fs.writeFileSync(store.path, 'corrupt')
  assert.equal(openSecureStore(dir, secrets, 'win32').get('value'), 'first')
  fs.writeFileSync(store.path, 'corrupt')
  fs.writeFileSync(path.join(dir, 'kiro-accounts.secure.backup'), 'corrupt')
  // A planted old-format file must never downgrade a known encrypted store.
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes(values))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /损坏|解密/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.json')), true)
})

test('missing protected key and failed OS key wrapping do not overwrite or migrate existing files', t => {
  const dir = fixture(t), secrets = secretStorage(), store = openSecureStore(dir, secrets, 'win32')
  store.set('value', 'preserve')
  const before = fs.readFileSync(store.path)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.key.enc'))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /密钥/)
  assert.deepEqual(fs.readFileSync(store.path), before)
  const other = fixture(t), legacy = legacyBytes(values)
  fs.writeFileSync(path.join(other, 'kiro-accounts.json'), legacy)
  const unavailable = secretStorage(); unavailable.encryptString = () => { throw Error('synthetic failure') }
  assert.throws(() => openSecureStore(other, unavailable, 'win32'), /安全存储|密钥/)
  assert.deepEqual(fs.readFileSync(path.join(other, 'kiro-accounts.json')), legacy)
  assert.equal(fs.existsSync(path.join(other, 'kiro-accounts.secure.json')), false)
})

test('failed serialization and authentication tampering never change the current persisted values', t => {
  const dir = fixture(t), secrets = secretStorage(), store = openSecureStore(dir, secrets, 'win32')
  store.set('value', 'before')
  const before = fs.readFileSync(store.path)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  assert.throws(() => store.set('value', cyclic))
  assert.deepEqual(fs.readFileSync(store.path), before)
  assert.equal(store.get('value'), 'before')
  const bad = JSON.parse(before.toString()); bad.tag = Buffer.alloc(16, 7).toString('base64')
  fs.writeFileSync(store.path, JSON.stringify(bad))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.secure.backup'), JSON.stringify(bad))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /损坏|解密/)
})

test('invalid encrypted backup cannot hide a valid legacy plaintext backup during migration', t => {
  for (const invalid of [null, {}, { accounts: null }, []]) {
    const dir = fixture(t), secrets = secretStorage()
    fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes({ settings: 'preserved' }))
    fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), secrets.encryptString(JSON.stringify(invalid)))
    fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.json'), JSON.stringify(values.accountData))
    const store = openSecureStore(dir, secrets, 'win32')
    assert.deepEqual(store.get('accountData'), values.accountData)
    assert.equal(store.get('settings'), 'preserved')
    assert.ok(fs.existsSync(path.join(dir, 'kiro-accounts.migration.enc')))
  }
})

test('migration preserves old sources when no backup is valid or the encrypted archive cannot be written', t => {
  const dir = fixture(t), secrets = secretStorage(), legacy = legacyBytes({ settings: 'preserve' })
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacy)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), secrets.encryptString('null'))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /备份损坏/)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'kiro-accounts.json')), legacy)
  const other = fixture(t)
  fs.writeFileSync(path.join(other, 'kiro-accounts.json'), legacyBytes(values))
  fs.mkdirSync(path.join(other, 'kiro-accounts.migration.enc'))
  assert.throws(() => openSecureStore(other, secrets, 'win32'))
  assert.ok(fs.existsSync(path.join(other, 'kiro-accounts.json')))
  fs.rmdirSync(path.join(other, 'kiro-accounts.migration.enc'))
  assert.deepEqual(openSecureStore(other, secrets, 'win32').get('accountData'), values.accountData)
  assert.equal(fs.existsSync(path.join(other, 'kiro-accounts.json')), false)
})

test('later legacy writes are preserved and a failed encrypted backup write does not commit a value', t => {
  const dir = fixture(t), secrets = secretStorage()
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes(values))
  const store = openSecureStore(dir, secrets, 'win32')
  const archive = fs.readFileSync(path.join(dir, 'kiro-accounts.migration.enc'))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes({ additional: 'legacy edit' }))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /迁移后发生变化/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.json')), true)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'kiro-accounts.migration.enc')), archive)
  const before = fs.readFileSync(store.path)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.secure.backup'))
  fs.mkdirSync(path.join(dir, 'kiro-accounts.secure.backup'))
  assert.throws(() => store.set('uncommitted', 'value'), /写入失败/)
  assert.equal(store.get('uncommitted'), undefined)
  assert.deepEqual(fs.readFileSync(store.path), before)
})

test('a damaged legacy primary can recover a valid OS-encrypted account backup while archiving the old bytes', t => {
  const dir = fixture(t), secrets = secretStorage()
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), 'SYNTHETIC_DAMAGED_PRIMARY')
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), secrets.encryptString(JSON.stringify(values.accountData)))
  const store = openSecureStore(dir, secrets, 'win32')
  assert.deepEqual(store.get('accountData'), values.accountData)
  assert.ok(fs.existsSync(path.join(dir, 'kiro-accounts.migration.enc')))
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.json')), false)
  const other = fixture(t)
  fs.writeFileSync(path.join(other, 'kiro-accounts.json'), 'SYNTHETIC_DAMAGED_PRIMARY')
  assert.throws(() => openSecureStore(other, secrets, 'win32'), /没有有效备份/)
  assert.equal(fs.readFileSync(path.join(other, 'kiro-accounts.json'), 'utf8'), 'SYNTHETIC_DAMAGED_PRIMARY')
})

test('an archive-only recovery state never generates a replacement key or creates an empty store', t => {
  const dir = fixture(t), secrets = secretStorage()
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), legacyBytes(values))
  const store = openSecureStore(dir, secrets, 'win32')
  fs.unlinkSync(store.path)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.secure.backup'))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /保留迁移归档/)
  assert.equal(fs.existsSync(store.path), false)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.key.enc'))
  assert.throws(() => openSecureStore(dir, secrets, 'win32'), /密钥文件缺失/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.key.enc')), false)
})
