import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as secureStore from '../../src/main/secureStore.ts'
import { openSecureStoreForStartup, SecureStoreRecoveryCancelled } from '../../src/main/secureStoreRecovery.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
let startup, initializer
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'app.whenReady().then') startup = node.arguments[0]
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'initStore') initializer = node
  ts.forEachChild(node, visit)
}
visit(tree)

test('actual startup initializes protected storage before any watcher or persisted logging, and stops on failure', async () => {
  const prefix = startup.body.statements.slice(0, 4).map(node => node.getText(tree)).join('\n')
  for (const mode of ['success', 'failure', 'cancel']) {
    const calls = []
    const context = vm.createContext({
      initStore: async () => {
        calls.push('storage')
        if (mode === 'failure') throw new secureStore.SecureStoreError('SYNTHETIC_UNAVAILABLE')
        if (mode === 'cancel') throw new SecureStoreRecoveryCancelled()
      },
      SecureStoreError: secureStore.SecureStoreError,
      SecureStoreRecoveryCancelled,
      dialog: { showErrorBox: () => calls.push('error-dialog') },
      app: { quit: () => calls.push('quit'), getPath: () => 'synthetic' },
      proxyLogStore: { initialize: () => calls.push('logging') },
      interceptConsole: () => calls.push('intercept'), startKiroAuthTokenWatcher: () => calls.push('watcher')
    })
    vm.runInContext(ts.transpileModule(`globalThis.start = async () => {${prefix}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
    await context.start()
    assert.deepEqual(calls, mode === 'failure' ? ['storage', 'error-dialog', 'quit'] : mode === 'cancel' ? ['storage', 'quit'] : ['storage', 'logging', 'intercept', 'watcher'])
  }
})

test('actual backup entrypoint refuses unavailable/basic-text backends and preserves an existing encrypted backup', async t => {
  const base = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  fs.mkdirSync(base, { recursive: true })
  const directory = fs.mkdtempSync(path.join(base, 'secure-backup-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'kiro-accounts.backup.enc')
  fs.writeFileSync(filename, 'SYNTHETIC_ENCRYPTED_EXISTING')
  const backupSource = fs.readFileSync(new URL('../../src/main/secureBackup.ts', import.meta.url), 'utf8')
  for (const mode of ['unavailable', 'basic_text', 'encrypt-error', 'secure']) {
    const exports = {}
    const safeStorage = {
      isEncryptionAvailable: () => mode !== 'unavailable',
      getSelectedStorageBackend: () => mode === 'basic_text' ? mode : 'gnome_libsecret',
      encryptString: value => { if (mode === 'encrypt-error') throw Error('synthetic'); return Buffer.from('SYNTHETIC_ENCRYPTED:' + value) },
      decryptString: value => {
        assert.ok(value.toString().startsWith('SYNTHETIC_ENCRYPTED:'))
        return value.toString().slice('SYNTHETIC_ENCRYPTED:'.length)
      }
    }
    vm.runInNewContext(ts.transpileModule(backupSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, Buffer, process: { platform: 'linux' }, require: name => name === 'electron' ? { safeStorage } : name === './secureStore' ? secureStore : require(name)
    })
    if (mode === 'secure') await exports.writeSecureBackup(directory, { accounts: {} })
    else {
      await assert.rejects(exports.writeSecureBackup(directory, { accounts: {} }))
      assert.equal(fs.readFileSync(filename, 'utf8'), 'SYNTHETIC_ENCRYPTED_EXISTING')
    }
    assert.equal(fs.existsSync(path.join(directory, 'kiro-accounts.backup.json')), false)
  }
})

const syntheticAccounts = { accounts: { synthetic: { credentials: { refreshToken: 'SYNTHETIC_REFRESH_ONLY' } } } }
function secrets() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from('SYNTHETIC_OS:' + value),
    decryptString: bytes => {
      assert.ok(bytes.toString().startsWith('SYNTHETIC_OS:'))
      return bytes.toString().slice('SYNTHETIC_OS:'.length)
    }
  }
}
function fixture(t) {
  const base = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
  fs.mkdirSync(base, { recursive: true })
  const directory = fs.mkdtempSync(path.join(base, 'secure-startup-test-'))
  t.after(() => {
    const relative = path.relative(base, path.resolve(directory))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const safeStorage = secrets()
  fs.writeFileSync(path.join(directory, 'kiro-accounts.json'), JSON.stringify({ accountData: syntheticAccounts }))
  secureStore.openSecureStore(directory, safeStorage, 'win32')
  fs.writeFileSync(path.join(directory, 'kiro-accounts.json'), JSON.stringify({ accountData: syntheticAccounts }, null, 2))
  return { directory, safeStorage }
}
function recoveryArchives(directory) {
  return fs.readdirSync(directory).filter(name => /^kiro-accounts\.recovery-/.test(name))
}
function sourceSnapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name))]))
}
function startupHarness({ directory, safeStorage, choose, openDirectory = async () => '' }) {
  const calls = [], prompts = [], errors = []
  const context = vm.createContext({
    openSecureStoreForStartup,
    SecureStoreRecoveryCancelled,
    SecureStoreError: secureStore.SecureStoreError,
    safeStorage,
    dialog: {
      showMessageBox: async options => { calls.push('prompt'); prompts.push(options); return { response: await choose(options) } },
      showErrorBox: (...details) => { calls.push('error-dialog'); errors.push(details) }
    },
    shell: { openPath: async location => { calls.push('directory'); return openDirectory(location) } },
    app: { quit: () => calls.push('quit'), getPath: name => { assert.equal(name, 'userData'); return directory } },
    migrateAccountDataIfNeeded: () => calls.push('account-migration'),
    proxyLogStore: { initialize: () => calls.push('logging') },
    interceptConsole: () => calls.push('intercept'),
    startKiroAuthTokenWatcher: () => calls.push('watcher'),
    afterStartup: () => calls.push('remaining-startup'),
    console: { log() {}, warn() {}, error() {} }
  })
  const prefix = startup.body.statements.slice(0, 4).map(node => node.getText(tree)).join('\n')
  const compiled = ts.transpileModule(`
    let store = null, storeInitialization = null, proactiveRenewalEnabled = false;
    ${initializer.getText(tree)}
    globalThis.initialize = initStore;
    globalThis.storage = () => store;
    globalThis.start = async () => { ${prefix}; afterStartup(); };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInContext(compiled, context)
  return { context, calls, prompts, errors }
}

test('real initStore and startup await one shared recovery choice before assigning the store or starting side effects', async t => {
  const state = fixture(t), pending = Promise.withResolvers()
  const h = startupHarness({ ...state, choose: () => pending.promise })
  const before = sourceSnapshot(state.directory)
  const start = h.context.start(), secondInitializer = h.context.initialize()
  assert.deepEqual(h.calls, ['prompt'])
  assert.equal(h.context.storage(), null)
  assert.deepEqual(sourceSnapshot(state.directory), before)
  assert.equal(h.prompts[0].defaultId, 2)
  assert.equal(h.prompts[0].cancelId, 2)
  assert.doesNotMatch(JSON.stringify(h.prompts[0]), /SYNTHETIC_REFRESH_ONLY/)
  pending.resolve(0)
  await Promise.all([start, secondInitializer])
  assert.deepEqual(h.calls, ['prompt', 'account-migration', 'logging', 'intercept', 'watcher', 'remaining-startup'])
  assert.deepEqual(h.context.storage().get('accountData'), syntheticAccounts)
  assert.equal(recoveryArchives(state.directory).length, 1)
  for (const [name, bytes] of Object.entries(before)) {
    if (name !== 'kiro-accounts.secure.json' && name !== 'kiro-accounts.secure.backup') {
      assert.deepEqual(fs.readFileSync(path.join(state.directory, name)), bytes)
    }
  }
})

test('real startup cancellation leaves all generations intact without a generic error or background work', async t => {
  const state = fixture(t), before = sourceSnapshot(state.directory)
  const h = startupHarness({ ...state, choose: async () => 2 })
  await h.context.start()
  assert.deepEqual(h.calls, ['prompt', 'quit'])
  assert.equal(h.context.storage(), null)
  assert.deepEqual(sourceSnapshot(state.directory), before)
})

test('real startup directory viewing does not accept recovery; the later choice controls continuation', async t => {
  for (const response of [0, 2]) {
    const state = fixture(t), pending = Promise.withResolvers()
    let count = 0
    const h = startupHarness({ ...state, choose: () => ++count === 1 ? 1 : pending.promise })
    const running = h.context.start()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.calls, ['prompt', 'directory', 'prompt'])
    assert.equal(h.context.storage(), null)
    assert.equal(recoveryArchives(state.directory).length, 0)
    pending.resolve(response)
    await running
    assert.equal(h.calls.at(-1), response === 0 ? 'remaining-startup' : 'quit')
    assert.equal(recoveryArchives(state.directory).length, response === 0 ? 1 : 0)
  }
})

test('real startup directory errors remain fatal and preserve sources without logging the shell error', async t => {
  for (const failure of ['return', 'throw']) {
    const state = fixture(t), before = sourceSnapshot(state.directory)
    const h = startupHarness({ ...state, choose: async () => 1, openDirectory: async () => {
      if (failure === 'throw') throw Error('SYNTHETIC_PRIVATE_PATH')
      return 'SYNTHETIC_PRIVATE_PATH'
    } })
    await h.context.start()
    assert.deepEqual(h.calls, ['prompt', 'directory', 'error-dialog', 'quit'])
    assert.doesNotMatch(JSON.stringify(h.errors), /SYNTHETIC_PRIVATE_PATH/)
    assert.equal(h.context.storage(), null)
    assert.deepEqual(sourceSnapshot(state.directory), before)
  }
})

test('changing a legacy source while the real recovery dialog is open requires a fresh choice', async t => {
  const state = fixture(t)
  let count = 0
  const h = startupHarness({ ...state, choose: async () => {
    if (++count === 1) fs.writeFileSync(path.join(state.directory, 'kiro-accounts.json'), 'SYNTHETIC_CHANGED_DURING_CHOICE')
    return 0
  } })
  await h.context.start()
  assert.deepEqual(h.calls, ['prompt', 'prompt', 'account-migration', 'logging', 'intercept', 'watcher', 'remaining-startup'])
  assert.equal(recoveryArchives(state.directory).length, 1)
  assert.notEqual(h.prompts[0].detail, h.prompts[1].detail)
  assert.equal(fs.readFileSync(path.join(state.directory, 'kiro-accounts.json'), 'utf8'), 'SYNTHETIC_CHANGED_DURING_CHOICE')
})

test('continuously changing legacy sources stop after bounded choices without committing a recovery', async t => {
  const state = fixture(t)
  let count = 0
  const h = startupHarness({ ...state, choose: async () => {
    fs.writeFileSync(path.join(state.directory, 'kiro-accounts.json'), `SYNTHETIC_LEGACY_CHANGE_${++count}`)
    return 0
  } })
  await h.context.start()
  assert.deepEqual(h.calls, ['prompt', 'prompt', 'prompt', 'error-dialog', 'quit'])
  assert.equal(h.context.storage(), null)
  assert.equal(recoveryArchives(state.directory).length, 0)
})

test('missing keys and invalid secure generations cannot enter the recovery dialog', async t => {
  for (const mode of ['missing-key', 'corrupt-stores', 'unavailable']) {
    const state = fixture(t)
    if (mode === 'missing-key') fs.unlinkSync(path.join(state.directory, 'kiro-accounts.key.enc'))
    if (mode === 'corrupt-stores') for (const name of ['kiro-accounts.secure.json', 'kiro-accounts.secure.backup']) fs.writeFileSync(path.join(state.directory, name), 'SYNTHETIC_CORRUPT')
    if (mode === 'unavailable') state.safeStorage.isEncryptionAvailable = () => false
    const before = sourceSnapshot(state.directory)
    const h = startupHarness({ ...state, choose: async () => assert.fail('hard failures must not offer a bypass') })
    await h.context.start()
    assert.deepEqual(h.calls, ['error-dialog', 'quit'])
    assert.equal(h.context.storage(), null)
    assert.deepEqual(sourceSnapshot(state.directory), before)
  }
})

test('a recovery archive write failure cannot assign the store or start background work', async t => {
  const state = fixture(t)
  let conflict
  try { secureStore.openSecureStore(state.directory, state.safeStorage, 'win32') } catch (error) { conflict = error }
  const h = startupHarness({ ...state, choose: async () => {
    fs.mkdirSync(path.join(state.directory, conflict.archiveName))
    return 0
  } })
  await h.context.start()
  assert.deepEqual(h.calls, ['prompt', 'error-dialog', 'quit'])
  assert.equal(h.context.storage(), null)
  assert.equal(fs.readFileSync(path.join(state.directory, 'kiro-accounts.json'), 'utf8'), JSON.stringify({ accountData: syntheticAccounts }, null, 2))
})

test('the actual encrypted backup writer retains a legacy JSON backup awaiting conflict resolution', async t => {
  const { directory } = fixture(t)
  const filename = path.join(directory, 'kiro-accounts.backup.json'), legacy = Buffer.from('SYNTHETIC_UNRESOLVED_LEGACY_BACKUP')
  fs.writeFileSync(filename, legacy)
  const exports = {}, safeStorage = secrets()
  const backupSource = fs.readFileSync(new URL('../../src/main/secureBackup.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(backupSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, Buffer, process: { platform: 'win32' }, require: name => name === 'electron' ? { safeStorage } : name === './secureStore' ? secureStore : require(name)
  })
  await exports.writeSecureBackup(directory, { accounts: {} })
  assert.deepEqual(fs.readFileSync(filename), legacy)
  assert.equal(safeStorage.decryptString(fs.readFileSync(path.join(directory, 'kiro-accounts.backup.enc'))), '{"accounts":{}}')
})
