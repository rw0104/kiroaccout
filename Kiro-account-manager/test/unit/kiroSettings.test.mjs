import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import vm from 'node:vm'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc.ts'
import {
  readKiroSettingsDocument, updateKiroSettingsDocument, parseKiroSettingsObject,
  resolveKiroSettingsTarget, kiroSettingsFailure
} from '../../src/main/kiroSettings.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const handlers = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && ['get-kiro-settings', 'save-kiro-settings', 'open-kiro-settings-file'].includes(node.arguments[0]?.text)) {
    handlers.set(node.arguments[0].text, node.arguments[1].getText(tree))
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(handlers.size, 3)

function harness(fixture, initial, resolveInstance = async () => { throw new Error('SYNTHETIC_PRIVATE_INSTANCE') }) {
  const dirname = 'D:\\Synthetic\\main'
  const mainFrame = { url: pathToFileURL(join(dirname, '../renderer/index.html')).href }
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame } }
  const event = { sender: mainWindow.webContents, senderFrame: mainFrame }
  const files = new Map(initial)
  const writes = [], reads = [], opened = [], ids = []
  const dirs = new Set()
  const fakeFs = {
    existsSync: path => files.has(path) || dirs.has(path),
    readFileSync: path => { reads.push(path); assert.ok(files.has(path), `unexpected read: ${path}`); return files.get(path) },
    mkdirSync: path => dirs.add(path),
    writeFileSync: (path, content) => { writes.push(path); files.set(path, content) }
  }
  const context = vm.createContext({
    requireTrustedMainWindow, mainWindow, join, __dirname: dirname, is: { dev: false }, createSteeringFiles: () => ({ list: () => [] }),
    process: { platform: fixture.platform, env: fixture.env },
    readKiroSettingsDocument, updateKiroSettingsDocument, parseKiroSettingsObject,
    resolveKiroSettingsTarget, kiroSettingsFailure,
    kiroInstanceService: { resolveSettingsTarget: async id => { ids.push(id); return resolveInstance(id) } },
    shell: { openPath: async path => { opened.push(path); return '' } },
    console: { log() {}, error() {} },
    require: name => {
      if (name === 'os') return { homedir: () => fixture.home }
      if (name === 'path') return fixture.platform === 'win32' ? win32 : posix
      if (name === 'fs') return fakeFs
      throw new Error(`unexpected module: ${name}`)
    }
  })
  const code = `globalThis.readSettings = ${handlers.get('get-kiro-settings')}; globalThis.saveSettings = ${handlers.get('save-kiro-settings')}; globalThis.openSettings = ${handlers.get('open-kiro-settings-file')}`
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return { ...context, readSettings: (_event, target) => context.readSettings(_event ?? event, target), files, writes, reads, opened, ids }
}

const windows = { platform: 'win32', home: 'C:\\Synthetic\\home', env: { APPDATA: 'D:\\Synthetic\\Roaming' }, settingsPath: 'D:\\Synthetic\\Roaming\\Kiro\\User\\settings.json' }

for (const fixture of [
  windows,
  { platform: 'darwin', home: '/Users/synthetic', env: {}, settingsPath: '/Users/synthetic/Library/Application Support/Kiro/User/settings.json' },
  { platform: 'linux', home: '/home/synthetic', env: {}, settingsPath: '/home/synthetic/.config/Kiro/User/settings.json' },
  { platform: 'linux', home: '/home/synthetic', env: { XDG_CONFIG_HOME: '/synthetic/config' }, settingsPath: '/synthetic/config/Kiro/User/settings.json' }
]) {
  test(`actual Kiro settings IPC preserves JSONC and uses the same ${fixture.platform} target for read/save/open`, async () => {
    const ctx = harness(fixture, [[fixture.settingsPath, `\uFEFF{\n  // Synthetic Kiro configuration\n  "kiroAgent.modelSelection": "before",\n  "synthetic.url": "https://example.invalid/a/*literal*/?q=//text",\n  "synthetic.preserved": true,\n  "kiroAgent.memory": "useOnly",\n}\n`]])
    assert.equal((await ctx.readSettings()).settings.modelSelection, 'before')
    assert.equal((await ctx.saveSettings(undefined, { modelSelection: 'after' })).success, true)
    assert.deepEqual(ctx.writes, [fixture.settingsPath])
    assert.equal((await ctx.readSettings()).settings.modelSelection, 'after')
    assert.match(ctx.files.get(fixture.settingsPath), /https:\/\/example\.invalid\/a\/\*literal\*\/\?q=\/\/text/)
    assert.match(ctx.files.get(fixture.settingsPath), /Synthetic Kiro configuration/)
    assert.equal((await ctx.readSettings()).settings.memory, 'useOnly')
    assert.equal(parseKiroSettingsObject(ctx.files.get(fixture.settingsPath))['synthetic.preserved'], true)
    assert.equal((await ctx.openSettings()).success, true)
    assert.deepEqual(ctx.opened, [fixture.settingsPath])
  })
}

test('actual IPC defaults do not write Memory or Workflows until explicitly changed', async () => {
  const ctx = harness(windows, [[windows.settingsPath, '{ "synthetic.untouched": 42 }']])
  const loaded = await ctx.readSettings()
  assert.equal(loaded.settings.memory, 'off')
  assert.equal(loaded.settings.workflowsEnabled, false)
  assert.equal((await ctx.saveSettings(undefined, { modelSelection: undefined })).success, true)
  assert.equal(ctx.writes.length, 0)
  assert.equal((await ctx.saveSettings(undefined, { memory: 'useWithoutLearning', workflowsEnabled: true })).success, true)
  const parsed = parseKiroSettingsObject(ctx.files.get(windows.settingsPath))
  assert.equal(parsed['kiroAgent.memory'], 'useWithoutLearning')
  assert.equal(parsed['kiroAgent.workflows.enabled'], true)
  assert.equal(parsed['synthetic.untouched'], 42)
})

test('actual IPC rejects malformed files and invalid patches without writing or disclosing their content', async () => {
  for (const content of ['{"private":"SYNTHETIC_PRIVATE"', '[1,2]', 'null', '{"duplicate":1,"duplicate":2}']) {
    const ctx = harness(windows, [[windows.settingsPath, content]])
    const read = await ctx.readSettings()
    const saved = await ctx.saveSettings(undefined, { memory: 'off' })
    assert.ok(read.error)
    assert.equal(saved.success, false)
    assert.doesNotMatch(JSON.stringify([read, saved]), /SYNTHETIC_PRIVATE/)
    assert.equal(ctx.writes.length, 0)
    assert.equal(ctx.files.get(windows.settingsPath), content)
  }
  for (const patch of [{ memory: 'always' }, { workflowsEnabled: 'true' }, { trustedCommands: [42] }, { workflowLaunch: 'delegate-all' }, { 'kiroAgent.memory': 'off' }]) {
    const ctx = harness(windows, [[windows.settingsPath, '{}']])
    assert.equal((await ctx.saveSettings(undefined, patch)).success, false)
    assert.equal(ctx.writes.length, 0)
  }
})

test('actual settings IPC isolates registered managed profiles and never reads the default profile for an instance', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const managedPath = 'C:\\Synthetic\\instances\\one\\user-data\\User\\settings.json'
  const target = { type: 'instance', instanceId: id }
  const ctx = harness(windows, [
    [windows.settingsPath, '{"kiroAgent.memory":"off"}'],
    [managedPath, '{"kiroAgent.memory":"useOnly", "window.title":"Synthetic instance"}']
  ], async requested => { assert.equal(requested, id); return { label: 'Synthetic instance', homeDir: 'C:\\Synthetic\\instances\\one\\home', settingsPath: managedPath } })
  const loaded = await ctx.readSettings(undefined, target)
  assert.equal(loaded.settings.memory, 'useOnly')
  assert.equal(loaded.target.settingsPath, managedPath)
  assert.equal(Object.keys(loaded.mcpConfig.mcpServers).length, 0)
  assert.equal((await ctx.saveSettings(undefined, { workflowsEnabled: true }, target)).success, true)
  assert.equal((await ctx.openSettings(undefined, target)).success, true)
  assert.ok(ctx.reads.every(path => path === managedPath))
  assert.deepEqual(ctx.writes, [managedPath])
  assert.deepEqual(ctx.opened, [managedPath])
  assert.equal(ctx.files.get(windows.settingsPath), '{"kiroAgent.memory":"off"}')
  assert.deepEqual(ctx.ids, [id, id, id])
})

test('actual settings IPC rejects arbitrary paths, deleted instance IDs and unknown targets before filesystem access', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  for (const target of [
    { type: 'instance', instanceId: '../escape' },
    { type: 'instance', instanceId: id, settingsPath: 'C:\\Synthetic\\outside.json' },
    { type: 'default', settingsPath: 'C:\\Synthetic\\outside.json' },
    { type: 'workspace', path: 'C:\\Synthetic' },
    { type: 'instance', instanceId: id }
  ]) {
    const ctx = harness(windows, [])
    const read = await ctx.readSettings(undefined, target)
    const save = await ctx.saveSettings(undefined, { memory: 'off' }, target)
    const open = await ctx.openSettings(undefined, target)
    assert.ok(read.error)
    assert.equal(save.success, false)
    assert.equal(open.success, false)
    assert.equal(ctx.reads.length + ctx.writes.length + ctx.opened.length, 0)
    assert.doesNotMatch(JSON.stringify([read, save, open]), /SYNTHETIC_PRIVATE_INSTANCE/)
  }
})

test('JSONC edits preserve escaped strings, CRLF, tabs, comments and unrelated settings', () => {
  const content = '\uFEFF{\r\n\t/* keep block */ "synthetic.text": "quoted \\\" // not a comment, }",\r\n\t"kiroAgent.memory": "off", // keep inline\r\n}\r\n'
  const updated = updateKiroSettingsDocument(content, { memory: 'useAndLearn' })
  assert.ok(updated.startsWith('\uFEFF'))
  assert.match(updated, /\r\n\t/)
  assert.match(updated, /keep block/)
  assert.match(updated, /keep inline/)
  assert.equal(parseKiroSettingsObject(updated)['synthetic.text'], parseKiroSettingsObject(content)['synthetic.text'])
  assert.equal(readKiroSettingsDocument(updated).memory, 'useAndLearn')
  assert.deepEqual(parseKiroSettingsObject(updateKiroSettingsDocument('// retained comment\n', { memory: 'off' })), { 'kiroAgent.memory': 'off' })
})
