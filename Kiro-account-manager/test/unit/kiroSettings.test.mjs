import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import vm from 'node:vm'
import { resolveKiroSettingsPath } from '../../src/main/kiroSettingsPath.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const handlers = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && ['get-kiro-settings', 'save-kiro-settings'].includes(node.arguments[0]?.text)) {
    handlers.set(node.arguments[0].text, node.arguments[1].getText(tree))
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(handlers.size, 2)

for (const fixture of [
  { platform: 'win32', home: 'C:\\Synthetic\\home', env: { APPDATA: 'D:\\Synthetic\\Roaming' }, settingsPath: 'D:\\Synthetic\\Roaming\\Kiro\\User\\settings.json' },
  { platform: 'darwin', home: '/Users/synthetic', env: {}, settingsPath: '/Users/synthetic/Library/Application Support/Kiro/User/settings.json' },
  { platform: 'linux', home: '/home/synthetic', env: {}, settingsPath: '/home/synthetic/.config/Kiro/User/settings.json' },
  { platform: 'linux', home: '/home/synthetic', env: { XDG_CONFIG_HOME: '/synthetic/config' }, settingsPath: '/synthetic/config/Kiro/User/settings.json' }
]) {
  test(`actual Kiro settings IPC reads and saves the same ${fixture.platform} profile ${fixture.env.XDG_CONFIG_HOME ? 'with XDG override' : ''}`, async () => {
    const files = new Map([[fixture.settingsPath, JSON.stringify({ 'kiroAgent.modelSelection': 'before', 'synthetic.preserved': true })]])
    const writes = []
    const dirs = new Set()
    const fakeFs = {
      existsSync: path => files.has(path) || dirs.has(path),
      readFileSync: path => { assert.ok(files.has(path), `unexpected read: ${path}`); return files.get(path) },
      mkdirSync: path => dirs.add(path),
      writeFileSync: (path, content) => { writes.push(path); files.set(path, content) }
    }
    const context = vm.createContext({
      process: { platform: fixture.platform, env: fixture.env },
      resolveKiroSettingsPath,
      console: { log() {}, error() {} },
      require: name => {
        if (name === 'os') return { homedir: () => fixture.home }
        if (name === 'path') return fixture.platform === 'win32' ? win32 : posix
        if (name === 'fs') return fakeFs
        throw new Error(`unexpected module: ${name}`)
      }
    })
    const code = `globalThis.readSettings = ${handlers.get('get-kiro-settings')}; globalThis.saveSettings = ${handlers.get('save-kiro-settings')}`
    vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
    assert.equal((await context.readSettings()).settings.modelSelection, 'before')
    assert.equal((await context.saveSettings(undefined, { modelSelection: 'after' })).success, true)
    assert.deepEqual(writes, [fixture.settingsPath])
    assert.equal((await context.readSettings()).settings.modelSelection, 'after')
    assert.equal(JSON.parse(files.get(fixture.settingsPath))['synthetic.preserved'], true)
  })
}
