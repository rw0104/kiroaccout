import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSteeringFiles } from '../../src/main/steeringFiles.ts'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc.ts'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

const isolated = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
function fixture(t: { after(callback: () => void): void }) {
  fs.mkdirSync(isolated, { recursive: true })
  const root = fs.mkdtempSync(path.join(isolated, 'steering-files-'))
  t.after(() => {
    const relative = path.relative(isolated, root)
    assert.ok(relative.startsWith('steering-files-') && !relative.includes(path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const home = path.join(root, 'home'), outside = path.join(root, 'outside')
  fs.mkdirSync(home); fs.mkdirSync(outside)
  return { home, outside, files: createSteeringFiles(home) }
}

test('real descriptor operations create, update, list and delete only ordinary Markdown files', t => {
  const h = fixture(t)
  assert.deepEqual(h.files.list(), [])
  h.files.write('rules.md', 'first')
  assert.equal(h.files.read('rules.md'), 'first')
  h.files.write('rules.md', 'short')
  assert.equal(h.files.read('rules.md'), 'short')
  assert.equal(fs.readFileSync(h.files.path('rules.md'), 'utf8'), 'short')
  assert.deepEqual(h.files.list(), ['rules.md'])
  h.files.delete('rules.md')
  assert.deepEqual(h.files.list(), [])
})

test('real directory junctions/symlinks cannot redirect directory creation or rules writes', t => {
  const h = fixture(t)
  const canary = path.join(h.outside, 'rules.md')
  fs.writeFileSync(canary, 'CANARY')
  fs.symlinkSync(h.outside, path.join(h.home, '.kiro'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => h.files.directory())
  assert.throws(() => h.files.write('rules.md', 'REPLACED'))
  assert.throws(() => h.files.read('rules.md'))
  assert.throws(() => h.files.delete('rules.md'))
  assert.throws(() => h.files.list())
  assert.deepEqual(fs.readdirSync(h.outside), ['rules.md'])
  assert.equal(fs.readFileSync(canary, 'utf8'), 'CANARY')
})

test('real hardlinked files are excluded and cannot expose or modify their outside counterpart', t => {
  const h = fixture(t)
  const root = h.files.directory(), canary = path.join(h.outside, 'canary.md')
  fs.writeFileSync(canary, 'CANARY')
  fs.linkSync(canary, path.join(root, 'rules.md'))
  assert.throws(() => h.files.read('rules.md'))
  assert.throws(() => h.files.write('rules.md', 'REPLACED'))
  assert.throws(() => h.files.path('rules.md'))
  assert.throws(() => h.files.delete('rules.md'))
  assert.deepEqual(h.files.list(), [])
  assert.equal(fs.readFileSync(canary, 'utf8'), 'CANARY')
})

test('descriptor identity changes fail before any truncation or read', t => {
  const h = fixture(t)
  h.files.write('rules.md', 'CANARY')
  const io = { ...fs, fstatSync: ((fd: number) => {
    const stat = fs.fstatSync(fd)
    // Windows file IDs can exceed Number.MAX_SAFE_INTEGER, making +1 a no-op.
    // Substitute a different identity explicitly so the injected race is real.
    stat.ino = stat.ino === 0 ? 1 : 0
    return stat
  }) as typeof fs.fstatSync }
  const guarded = createSteeringFiles(h.home, io)
  assert.throws(() => guarded.write('rules.md', 'REPLACED'))
  assert.throws(() => guarded.read('rules.md'))
  assert.equal(h.files.read('rules.md'), 'CANARY')
})

test('trusted IPC permits application hash routes but rejects URL or frame substitutions', () => {
  const frame = { url: 'http://localhost:5173/#/settings' }
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } } as unknown as BrowserWindow
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  assert.doesNotThrow(() => requireTrustedMainWindow(event, window, 'unused', 'http://localhost:5173/'))
  frame.url = 'http://localhost:5173/untrusted'
  assert.throws(() => requireTrustedMainWindow(event, window, 'unused', 'http://localhost:5173/'))
  frame.url = 'http://localhost:5173/?redirect=untrusted'
  assert.throws(() => requireTrustedMainWindow(event, window, 'unused', 'http://localhost:5173/'))
  assert.throws(() => requireTrustedMainWindow(event, null, 'unused'))
})
