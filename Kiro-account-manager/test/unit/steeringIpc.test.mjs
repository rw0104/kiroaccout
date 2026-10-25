import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix, win32, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { createSteeringFiles, steeringFileFailure, validateSteeringFilename } from '../../src/main/steeringFiles.ts'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const fileChannels = ['read-kiro-steering-file', 'save-kiro-steering-file', 'delete-kiro-steering-file', 'open-kiro-steering-file']
const channels = [...fileChannels, 'open-kiro-steering-folder', 'create-kiro-default-rules', 'get-kiro-settings']
const handlers = new Map()
function visit(node) {
  if (ts.isCallExpression(node) && channels.includes(node.arguments[0]?.text)) handlers.set(node.arguments[0].text, node.arguments[1].getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(handlers.size, channels.length)

function harness(fixture) {
  const calls = [], inspected = [], entries = new Map(), descriptors = new Map()
  let id = 0
  const put = (name, kind, content = '') => entries.set(name, { kind, content, ino: ++id, dev: 1, nlink: 1 })
  put(fixture.home, 'directory')
  const root = fixture.path.join(fixture.home, '.kiro', 'steering')
  const stat = item => ({ ...item, isSymbolicLink: () => item.kind === 'link', isDirectory: () => item.kind === 'directory', isFile: () => item.kind === 'file' })
  const item = filename => {
    const value = entries.get(filename)
    if (!value) throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' })
    return value
  }
  const fs = {
    constants: { O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 2, O_EXCL: 4, O_NOFOLLOW: 8 },
    existsSync: name => entries.has(name),
    lstatSync: name => { inspected.push(name); return stat(item(name)) },
    realpathSync: name => { inspected.push(name); return item(name).redirect ?? name },
    mkdirSync: name => { calls.push('mkdir'); put(name, 'directory') },
    readdirSync: name => { calls.push('list'); return [...entries.keys()].filter(key => fixture.path.dirname(key) === name).map(key => fixture.path.basename(key)) },
    openSync: (name, flags) => {
      calls.push('open-descriptor')
      if (!entries.has(name)) { assert.ok(flags & fs.constants.O_EXCL); put(name, 'file') }
      assert.notEqual(item(name).kind, 'link'); descriptors.set(++id, item(name)); return id
    },
    fstatSync: fd => stat(descriptors.get(fd)), closeSync: fd => descriptors.delete(fd),
    readFileSync: fd => { calls.push('read'); return descriptors.get(fd).content },
    ftruncateSync: fd => { calls.push('truncate'); descriptors.get(fd).content = '' },
    writeFileSync: (fd, value) => { calls.push('write'); descriptors.get(fd).content = value },
    unlinkSync: name => { calls.push('delete'); entries.delete(name) }
  }
  const dirname = 'D:\\Synthetic\\main'
  const mainFrame = { url: pathToFileURL(join(dirname, '../renderer/index.html')).href }
  const window = { isDestroyed: () => false, webContents: { mainFrame } }
  const event = { sender: window.webContents, senderFrame: mainFrame }
  const context = vm.createContext({ handlers: {}, requireTrustedMainWindow, createSteeringFiles: home => createSteeringFiles(home, fs, fixture.path), steeringFileFailure,
    mainWindow: window, join, __dirname: dirname, is: { dev: false }, process: { env: {} },
    resolveKiroSettingsTarget: async () => ({ homeDir: fixture.home, type: 'default', settingsPath: fixture.path.join(fixture.home, 'settings.json') }),
    readKiroSettingsDocument: () => ({}), parseKiroSettingsObject: () => ({}), kiroSettingsFailure: () => 'Cannot load settings',
    kiroInstanceService: {}, console: { log() {}, error() {} }, shell: { openPath: async () => { calls.push('open-shell'); return '' } },
    require: name => name === 'fs' ? fs : name === 'path' ? fixture.path : { homedir: () => fixture.home } })
  const code = [...handlers].map(([channel, handler]) => `handlers[${JSON.stringify(channel)}] = ${handler};`).join('\n')
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return { calls, inspected, entries, put, root, event, window, invoke: (channel, args = [], sender = event) => context.handlers[channel](sender, ...args), files: createSteeringFiles(fixture.home, fs, fixture.path) }
}

for (const fixture of [{ platform: 'win32', path: win32, home: 'C:\\Synthetic\\home' }, { platform: 'linux', path: posix, home: '/home/synthetic' }, { platform: 'darwin', path: posix, home: '/Users/synthetic' }]) {
  test(`actual Steering IPC refuses audit traversal before file operations (${fixture.platform})`, async () => {
    const h = harness(fixture)
    for (const filename of ['../../canary.md', '..\\..\\canary.md', '/canary.md', 'C:\\canary.md', '\\\\server\\canary.md', 'x/../canary.md', 'x\\canary.md', 'x.md:stream', 'x.txt', 'CON.md', '', null, {}, 'a\u0000.md']) {
      for (const channel of fileChannels) assert.equal((await h.invoke(channel, [filename, 'REPLACEMENT'])).success, false)
    }
    assert.equal(h.calls.length, 0, 'invalid paths must not reach an I/O sink')
    assert.equal(h.inspected.length, 0, 'invalid paths must be rejected before filesystem inspection')
  })
  test(`actual Steering IPC supports normal file lifecycle and creation (${fixture.platform})`, async () => {
    const h = harness(fixture)
    assert.equal((await h.invoke('save-kiro-steering-file', ['规则.md', 'hello'])).success, true)
    assert.equal((await h.invoke('read-kiro-steering-file', ['规则.md'])).content, 'hello')
    assert.equal((await h.invoke('save-kiro-steering-file', ['规则.md', 'updated'])).success, true)
    assert.equal((await h.invoke('read-kiro-steering-file', ['规则.md'])).content, 'updated')
    assert.equal((await h.invoke('open-kiro-steering-file', ['规则.md'])).success, true)
    assert.equal((await h.invoke('open-kiro-steering-folder')).success, true)
    assert.equal((await h.invoke('create-kiro-default-rules')).success, true)
    assert.equal((await h.invoke('get-kiro-settings')).steeringFiles.length, 2)
    assert.equal((await h.invoke('delete-kiro-steering-file', ['规则.md'])).success, true)
    assert.equal((await h.invoke('read-kiro-steering-file', ['规则.md'])).success, false)
    assert.deepEqual(h.files.list(), ['rules.md'])
  })
  test(`actual Steering IPC rejects linked directories, linked files and hardlinks (${fixture.platform})`, async () => {
    for (const attack of ['kiro-link', 'steering-link', 'file-link', 'file-hardlink', 'realpath-escape']) {
      const h = harness(fixture)
      h.put(fixture.path.dirname(h.root), 'directory'); h.put(h.root, 'directory'); h.put(fixture.path.join(h.root, 'rules.md'), 'file', 'CANARY')
      const target = attack === 'kiro-link' ? fixture.path.dirname(h.root) : attack === 'steering-link' ? h.root : fixture.path.join(h.root, 'rules.md')
      if (attack.includes('link') && attack !== 'file-hardlink') h.entries.get(target).kind = 'link'
      if (attack === 'file-hardlink') h.entries.get(target).nlink = 2
      if (attack === 'realpath-escape') h.entries.get(target).redirect = fixture.path.join(fixture.home, 'outside.md')
      for (const channel of [...fileChannels, 'create-kiro-default-rules']) assert.equal((await h.invoke(channel, ['rules.md', 'REPLACEMENT'])).success, false)
      if (attack === 'kiro-link' || attack === 'steering-link') assert.equal((await h.invoke('open-kiro-steering-folder')).success, false)
      assert.equal(h.calls.length, 0, 'blocked paths must not reach file/shell operations')
    }
  })
  test(`every Steering IPC verifies the trusted main frame before I/O (${fixture.platform})`, async () => {
    const h = harness(fixture)
    for (const sender of [{}, { sender: {}, senderFrame: h.event.senderFrame }, { sender: h.event.sender, senderFrame: { ...h.event.senderFrame } }]) {
      for (const channel of channels) {
        const result = await h.invoke(channel, ['rules.md', 'content'], sender)
        assert.ok(result.error)
      }
    }
    h.event.senderFrame.url = 'https://untrusted.invalid/'
    for (const channel of channels) assert.ok((await h.invoke(channel, ['rules.md', 'content'])).error)
    assert.equal(h.calls.length, 0); assert.equal(h.inspected.length, 0)
  })
}

test('portable basename accepts Markdown and rejects prototype/non-string inputs', () => {
  for (const name of ['rules.md', '规则.MD', 'my rules.md']) assert.doesNotThrow(() => validateSteeringFilename(name))
  for (const name of [undefined, 1, ['rules.md'], '..md', 'a..b.md', 'rules.md ', 'NUL.md']) assert.throws(() => validateSteeringFilename(name))
})
