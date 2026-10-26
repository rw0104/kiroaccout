import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecipheriv } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as secureStore from '../../src/main/secureStore.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const original = { accountData: { accounts: { synthetic: { credentials: { refreshToken: 'SYNTHETIC_ORIGINAL' } } } } }
const secrets = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`SYNTHETIC_OS:${value}`),
  decryptString: bytes => {
    assert.ok(bytes.toString().startsWith('SYNTHETIC_OS:'))
    return bytes.toString().slice('SYNTHETIC_OS:'.length)
  }
}
function fixture(t, migrate = true) {
  const base = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'secure-recovery-'))
  t.after(() => {
    const relative = path.relative(base, path.resolve(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  if (migrate) fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original))
  const store = secureStore.openSecureStore(dir, secrets, 'win32')
  store.set('afterMigration', 'SYNTHETIC_CURRENT_SETTING')
  return { dir, store }
}
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]))
}
function conflict(dir, open = secureStore.openSecureStore) {
  assert.throws(() => open(dir, secrets, 'win32'), error => {
    assert.equal(error.code, 'legacy-migration-conflict')
    return true
  })
  try { open(dir, secrets, 'win32') } catch (error) { return error }
  assert.fail('expected a migration conflict')
}
function decodeArchive(dir, filename) {
  const key = Buffer.from(secrets.decryptString(fs.readFileSync(path.join(dir, 'kiro-accounts.key.enc'))), 'hex')
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'))
  decipher.setAAD(Buffer.from('kiro-account-manager/store/v1'))
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString())
}
function withFs(overrides) {
  const exports = {}
  const source = fs.readFileSync(new URL('../../src/main/secureStore.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Buffer, process, require: name => name === 'node:fs' ? { ...fs, ...overrides } : require(name)
  })
  return exports.openSecureStore
}

test('confirmed recovery preserves both generations in authenticated ciphertext and reopens without another conflict', t => {
  const { dir } = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original, null, 2))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.json'), 'SYNTHETIC_NEW_LEGACY_BACKUP')
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), secrets.encryptString('SYNTHETIC_ACCOUNT_BACKUP'))
  const before = snapshot(dir), error = conflict(dir)
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_ORIGINAL|SYNTHETIC_NEW_LEGACY_BACKUP/)
  assert.deepEqual(error.files.map(file => file.name), ['kiro-accounts.json', 'kiro-accounts.backup.json', 'kiro-accounts.backup.enc'])
  const store = secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint })
  assert.equal(store.get('afterMigration'), 'SYNTHETIC_CURRENT_SETTING')
  assert.deepEqual(store.get('accountData'), original.accountData)
  for (const [name, bytes] of Object.entries(before)) {
    if (name !== 'kiro-accounts.secure.json' && name !== 'kiro-accounts.secure.backup') assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes)
  }
  const recovery = path.join(dir, error.archiveName), archived = decodeArchive(dir, recovery)
  assert.doesNotMatch(fs.readFileSync(recovery, 'utf8'), /SYNTHETIC_ORIGINAL|SYNTHETIC_NEW_LEGACY_BACKUP/)
  for (const name of ['kiro-accounts.json', 'kiro-accounts.backup.json']) assert.deepEqual(Buffer.from(archived.legacyFiles[name], 'base64'), before[name])
  for (const name of ['kiro-accounts.secure.json', 'kiro-accounts.secure.backup', 'kiro-accounts.key.enc', 'kiro-accounts.migration.enc', 'kiro-accounts.backup.enc']) {
    assert.deepEqual(Buffer.from(archived.secureFiles[name], 'base64'), before[name])
  }
  const archiveBytes = fs.readFileSync(recovery)
  store.set('later', 'SYNTHETIC_LATER')
  assert.equal(secureStore.openSecureStore(dir, secrets, 'win32').get('later'), 'SYNTHETIC_LATER')
  assert.deepEqual(fs.readFileSync(recovery), archiveBytes)
})

test('another legacy change requires fresh confirmation and retains the earlier recovery archive', t => {
  const { dir } = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ ...original, setting: 'first' }))
  const first = conflict(dir)
  secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: first.fingerprint })
  const saved = fs.readFileSync(path.join(dir, first.archiveName))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.json'), JSON.stringify(original.accountData))
  const second = conflict(dir)
  assert.notEqual(second.fingerprint, first.fingerprint)
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: first.fingerprint }), error => error.code === 'legacy-migration-conflict')
  secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: second.fingerprint })
  assert.deepEqual(fs.readFileSync(path.join(dir, first.archiveName)), saved)
  assert.ok(fs.existsSync(path.join(dir, second.archiveName)))
})

test('an existing secure store without a migration archive cannot silently consume a later old-format file', t => {
  const { dir } = fixture(t, false)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ accountData: { accounts: { other: {} } } }))
  const before = snapshot(dir), error = conflict(dir)
  assert.deepEqual(snapshot(dir), before)
  assert.deepEqual(secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint }).get('accountData'), undefined)
  assert.ok(fs.existsSync(path.join(dir, 'kiro-accounts.json')))
})

test('a failed recovery archive write preserves every source and can be retried', t => {
  const { dir } = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original, null, 2))
  const error = conflict(dir), before = snapshot(dir)
  const open = withFs({ renameSync(from, to) {
    if (path.basename(to) === error.archiveName) throw Error('SYNTHETIC_DISK_FAILURE')
    fs.renameSync(from, to)
  } })
  assert.throws(() => open(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint }), /写入失败/)
  assert.deepEqual(snapshot(dir), before)
  assert.equal(secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint }).get('afterMigration'), 'SYNTHETIC_CURRENT_SETTING')
})

test('legacy changes while archiving are retained and never acknowledged by a stale choice', t => {
  const { dir } = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original, null, 2))
  const error = conflict(dir), replacement = 'SYNTHETIC_CONCURRENT_LEGACY_EDIT'
  const open = withFs({ renameSync(from, to) {
    fs.renameSync(from, to)
    if (path.basename(to) === error.archiveName) fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), replacement)
  } })
  assert.throws(() => open(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint }), /再次变化|备份期间发生变化/)
  assert.equal(fs.readFileSync(path.join(dir, 'kiro-accounts.json'), 'utf8'), replacement)
  assert.notEqual(conflict(dir).fingerprint, error.fingerprint)
})

test('damaged recovery archives cannot authorize a bypass or be silently overwritten', t => {
  const { dir } = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original, null, 2))
  const error = conflict(dir)
  fs.writeFileSync(path.join(dir, error.archiveName), 'SYNTHETIC_CORRUPT_ARCHIVE')
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint }), /损坏|解密/)
  assert.equal(fs.readFileSync(path.join(dir, error.archiveName), 'utf8'), 'SYNTHETIC_CORRUPT_ARCHIVE')
})

test('recovery archives alone cannot cause replacement keys or an empty account store', t => {
  const { dir } = fixture(t, false)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(original))
  const error = conflict(dir)
  secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: error.fingerprint })
  for (const name of ['kiro-accounts.secure.json', 'kiro-accounts.secure.backup']) fs.unlinkSync(path.join(dir, name))
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32'), /保留.*归档/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.secure.json')), false)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.key.enc'))
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32'), /密钥文件缺失/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.key.enc')), false)
})
