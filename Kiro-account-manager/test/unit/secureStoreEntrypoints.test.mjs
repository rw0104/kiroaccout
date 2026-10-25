import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as secureStore from '../../src/main/secureStore.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
let startup
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'app.whenReady().then') startup = node.arguments[0]
  ts.forEachChild(node, visit)
}
visit(tree)

test('actual startup initializes protected storage before any watcher or persisted logging, and stops on failure', async () => {
  const prefix = startup.body.statements.slice(0, 4).map(node => node.getText(tree)).join('\n')
  for (const fail of [false, true]) {
    const calls = []
    const context = vm.createContext({
      initStore: async () => { calls.push('storage'); if (fail) throw new secureStore.SecureStoreError('SYNTHETIC_UNAVAILABLE') },
      SecureStoreError: secureStore.SecureStoreError,
      dialog: { showErrorBox: () => calls.push('error-dialog') },
      app: { quit: () => calls.push('quit'), getPath: () => 'synthetic' },
      proxyLogStore: { initialize: () => calls.push('logging') },
      interceptConsole: () => calls.push('intercept'), startKiroAuthTokenWatcher: () => calls.push('watcher')
    })
    vm.runInContext(ts.transpileModule(`globalThis.start = async () => {${prefix}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
    await context.start()
    assert.deepEqual(calls, fail ? ['storage', 'error-dialog', 'quit'] : ['storage', 'logging', 'intercept', 'watcher'])
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
      encryptString: value => { if (mode === 'encrypt-error') throw Error('synthetic'); return Buffer.from('SYNTHETIC_ENCRYPTED:' + value) }
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
