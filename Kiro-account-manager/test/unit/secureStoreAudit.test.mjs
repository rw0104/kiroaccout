import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createDecipheriv } from 'node:crypto'
import * as secureStore from '../../src/main/secureStore.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const current = { accountData: { accounts: { synthetic: { label: 'SYNTHETIC_CURRENT' } } } }
const secrets = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: value => Buffer.from(`SYNTHETIC_AUDIT_OS:${value}`),
  decryptString: bytes => {
    const value = bytes.toString()
    assert.ok(value.startsWith('SYNTHETIC_AUDIT_OS:'))
    return value.slice('SYNTHETIC_AUDIT_OS:'.length)
  }
}
function fixture(t, migrate = true) {
  const base = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'secure-store-audit-'))
  t.after(() => {
    const relative = path.relative(base, path.resolve(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify(current))
  if (migrate) secureStore.openSecureStore(dir, secrets, 'win32')
  return dir
}
function captureConflict(dir) {
  try {
    secureStore.openSecureStore(dir, secrets, 'win32')
  } catch (error) {
    assert.equal(error.code, 'legacy-migration-conflict')
    return error
  }
  assert.fail('the changed legacy generation must require a current recovery choice')
}
function confirm(dir, conflict) {
  return secureStore.openSecureStore(dir, secrets, 'win32', { legacyRecoveryFingerprint: conflict.fingerprint })
}
function moduleWithFs(overrides) {
  const exports = {}
  const source = fs.readFileSync(new URL('../../src/main/secureStore.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Buffer, process, require: name => name === 'node:fs' ? { ...fs, ...overrides } : require(name)
  })
  return exports
}
function backupModule(platform = process.platform, storage = secrets) {
  const exports = {}
  const source = fs.readFileSync(new URL('../../src/main/secureBackup.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Buffer, process: { platform }, require: name => name === 'electron' ? { safeStorage: storage } : name === './secureStore' ? secureStore : require(name)
  })
  return exports
}
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))]))
}
function containsBytes(value, bytes) {
  if (typeof value === 'string') return value === bytes.toString('base64')
  return value && typeof value === 'object' && Object.values(value).some(item => containsBytes(item, bytes))
}
function decryptRecovery(dir, name) {
  const key = Buffer.from(secrets.decryptString(fs.readFileSync(path.join(dir, 'kiro-accounts.key.enc'))), 'hex')
  const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'))
  decipher.setAAD(Buffer.from('kiro-account-manager/store/v1'))
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]).toString())
}
function retainedRawBytes(dir, bytes, except = 'kiro-accounts.backup.enc') {
  return fs.readdirSync(dir).filter(name => name !== except).some(name => {
    const filename = path.join(dir, name)
    return fs.statSync(filename).isFile() && fs.readFileSync(filename).equals(bytes)
  })
}

test('first migration binds its parsed account data and archive to one source snapshot', t => {
  const dir = fixture(t, false)
  const later = { accountData: { accounts: { later: { label: 'SYNTHETIC_LATER_GENERATION' } } } }
  const legacy = path.join(dir, 'kiro-accounts.json')
  let changed = false
  const isolated = moduleWithFs({ renameSync(from, to) {
    fs.renameSync(from, to)
    if (!changed && path.basename(to) === 'kiro-accounts.secure.json') {
      changed = true
      fs.writeFileSync(legacy, JSON.stringify(later))
    }
  } })
  assert.throws(() => isolated.openSecureStore(dir, secrets, 'win32'), /变化|冲突/)
  assert.equal(changed, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')), later)
  const error = captureConflict(dir)
  const store = confirm(dir, error)
  assert.deepEqual(store.get('accountData'), current.accountData, 'choosing the secure store must not import the unconfirmed later legacy generation')
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')), later)
})

test('an unresolved conflict preserves the damaged primary until backup restoration is explicitly accepted', t => {
  const dir = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ ...current, setting: 'SYNTHETIC_CHANGED' }))
  const main = path.join(dir, 'kiro-accounts.secure.json')
  const damaged = Buffer.from('SYNTHETIC_DAMAGED_PRIMARY_FOR_RECOVERY')
  fs.writeFileSync(main, damaged)
  const before = snapshot(dir), error = captureConflict(dir)
  assert.deepEqual(snapshot(dir), before, 'even repairing the main file must wait while recovery is unresolved')
  const store = confirm(dir, error)
  assert.deepEqual(store.get('accountData'), current.accountData)
  const archives = fs.readdirSync(dir).filter(name => /^kiro-accounts\.recovery-.*\.enc$/.test(name))
  assert.ok(archives.some(name => containsBytes(decryptRecovery(dir, name), damaged)), 'an authenticated recovery archive must retain the pre-repair primary bytes')
})

test('an earlier migration recovery choice cannot discard a later damaged primary during backup repair', t => {
  const dir = fixture(t)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ ...current, setting: 'SYNTHETIC_CHANGED' }))
  const store = confirm(dir, captureConflict(dir))
  store.set('later', 'SYNTHETIC_LATER_SETTING')
  const damaged = Buffer.from('SYNTHETIC_DAMAGED_PRIMARY_AFTER_EARLIER_RECOVERY')
  fs.writeFileSync(path.join(dir, 'kiro-accounts.secure.json'), damaged)
  const recovered = secureStore.openSecureStore(dir, secrets, 'win32')
  assert.deepEqual(recovered.get('accountData'), current.accountData)
  const archives = fs.readdirSync(dir).filter(name => /^kiro-accounts\.(?:repair|recovery)-.*\.enc$/.test(name))
  assert.ok(archives.some(name => containsBytes(decryptRecovery(dir, name), damaged)), 'an authenticated archive must preserve the current damaged bytes even when a past migration choice remains valid')
})

test('a repair-only installation never replaces its key or creates an empty store', t => {
  const dir = fixture(t, false)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.json'))
  const store = secureStore.openSecureStore(dir, secrets, 'win32')
  store.set('accountData', current.accountData)
  store.set('later', 'SYNTHETIC_LATER_SETTING')
  fs.writeFileSync(path.join(dir, 'kiro-accounts.secure.json'), 'SYNTHETIC_DAMAGED_PRIMARY')
  assert.deepEqual(secureStore.openSecureStore(dir, secrets, 'win32').get('accountData'), current.accountData)
  assert.ok(fs.readdirSync(dir).some(name => /^kiro-accounts\.repair-.*\.enc$/.test(name)))
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.migration.enc')), false)
  for (const name of ['kiro-accounts.secure.json', 'kiro-accounts.secure.backup']) fs.unlinkSync(path.join(dir, name))
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32'), /归档|备份/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.secure.json')), false)
  fs.unlinkSync(path.join(dir, 'kiro-accounts.key.enc'))
  assert.throws(() => secureStore.openSecureStore(dir, secrets, 'win32'), /密钥文件缺失/)
  assert.equal(fs.existsSync(path.join(dir, 'kiro-accounts.key.enc')), false)
})

test('A to B to A legacy changes require a fresh choice instead of reusing an historical archive as consent', t => {
  const dir = fixture(t), legacy = path.join(dir, 'kiro-accounts.json')
  const generationA = JSON.stringify({ ...current, setting: 'SYNTHETIC_LEGACY_A' })
  fs.writeFileSync(legacy, generationA)
  const first = captureConflict(dir)
  confirm(dir, first)
  const firstArchive = fs.readFileSync(path.join(dir, first.archiveName))
  fs.writeFileSync(legacy, JSON.stringify({ ...current, setting: 'SYNTHETIC_LEGACY_B' }))
  const second = captureConflict(dir)
  confirm(dir, second)
  assert.notEqual(first.fingerprint, second.fingerprint)
  fs.writeFileSync(legacy, generationA)
  const returning = captureConflict(dir)
  assert.notEqual(returning.fingerprint, first.fingerprint, 'confirmation must also bind the current secure generation')
  assert.deepEqual(fs.readFileSync(path.join(dir, first.archiveName)), firstArchive)
  assert.equal(confirm(dir, returning).get('accountData').accounts.synthetic.label, 'SYNTHETIC_CURRENT')
})

test('a later external encrypted backup cannot be ignored after an earlier recovery choice', async t => {
  const dir = fixture(t), backup = backupModule()
  await backup.writeSecureBackup(dir, current.accountData)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ ...current, setting: 'SYNTHETIC_CHANGED' }))
  confirm(dir, captureConflict(dir))
  const external = secrets.encryptString(JSON.stringify({ accounts: { external: { label: 'SYNTHETIC_EXTERNAL_BACKUP' } } }))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), external)
  let error
  try { secureStore.openSecureStore(dir, secrets, 'win32') } catch (caught) { error = caught }
  if (error) assert.equal(error.code, 'legacy-migration-conflict')
  else assert.ok(retainedRawBytes(dir, external), 'a newly observed external backup must be retained before startup can ignore its generation')
  assert.deepEqual(fs.readFileSync(path.join(dir, 'kiro-accounts.backup.enc')), external)
})

test('the actual backup writer retains an unknown encrypted generation before replacing it', async t => {
  const dir = fixture(t), backup = backupModule()
  await backup.writeSecureBackup(dir, current.accountData)
  const external = secrets.encryptString(JSON.stringify({ accounts: { external: { label: 'SYNTHETIC_EXTERNAL_BACKUP' } } }))
  fs.writeFileSync(path.join(dir, 'kiro-accounts.backup.enc'), external)
  await backup.writeSecureBackup(dir, { accounts: { replacement: { label: 'SYNTHETIC_NEW_SAVE' } } })
  assert.ok(retainedRawBytes(dir, external), 'overwriting a backup created by another version must first retain its exact encrypted bytes')
  assert.notDeepEqual(fs.readFileSync(path.join(dir, 'kiro-accounts.backup.enc')), external)
})

test('normal backups written by this application do not repeatedly prompt over unchanged retained legacy sources', async t => {
  const dir = fixture(t), backup = backupModule()
  await backup.writeSecureBackup(dir, current.accountData)
  fs.writeFileSync(path.join(dir, 'kiro-accounts.json'), JSON.stringify({ ...current, setting: 'SYNTHETIC_CHANGED' }))
  confirm(dir, captureConflict(dir))
  await backup.writeSecureBackup(dir, { accounts: { replacement: { label: 'SYNTHETIC_NEW_SAVE' } } })
  assert.deepEqual(secureStore.openSecureStore(dir, secrets, 'win32').get('accountData'), current.accountData)
})

test('the real backup entrypoint requires a secure Linux backend and preserves existing files when it is absent', async t => {
  const dir = fixture(t)
  await backupModule('linux').writeSecureBackup(dir, current.accountData)
  const before = snapshot(dir)
  for (const backend of ['basic_text', 'unknown', undefined]) {
    const storage = { ...secrets, getSelectedStorageBackend: () => backend }
    await assert.rejects(backupModule('linux', storage).writeSecureBackup(dir, { accounts: {} }), /系统安全存储不可用/)
    assert.deepEqual(snapshot(dir), before)
  }
})

test('a legal five MiB store can recover when its combined preservation archive exceeds one-store limits', t => {
  const dir = fixture(t, false)
  const values = { ...current, syntheticLargeSetting: 'x'.repeat(5 * 1024 * 1024) }
  const legacy = path.join(dir, 'kiro-accounts.json')
  fs.writeFileSync(legacy, JSON.stringify(values))
  const initial = secureStore.openSecureStore(dir, secrets, 'win32')
  assert.equal(initial.get('syntheticLargeSetting').length, values.syntheticLargeSetting.length)
  const changed = JSON.stringify(values, null, 1)
  fs.writeFileSync(legacy, changed)
  const error = captureConflict(dir), restored = confirm(dir, error)
  assert.deepEqual(restored.get('accountData'), current.accountData)
  assert.equal(restored.get('syntheticLargeSetting'), values.syntheticLargeSetting)
  assert.equal(fs.readFileSync(legacy, 'utf8'), changed)
  assert.ok(fs.statSync(path.join(dir, error.archiveName)).size > 32 * 1024 * 1024)
  assert.equal(secureStore.openSecureStore(dir, secrets, 'win32').get('syntheticLargeSetting').length, values.syntheticLargeSetting.length)
})
