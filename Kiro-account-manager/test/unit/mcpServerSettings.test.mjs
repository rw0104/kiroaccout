import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import * as shared from '../../src/shared/kiroSettings.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
let action
function visit(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'save-mcp-server') action = node.arguments[1].getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(action)
const code = ts.transpileModule(`globalThis.save = ${action}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function fixture() {
  const remote = { url: 'https://example.invalid/mcp', headers: { 'X-Test': 'synthetic' }, oauthScopes: ['read'] }
  const local = { command: 'old-command', args: ['old-arg'], env: { OLD: 'x' }, disabledTools: ['remove'], timeout: 1000, extension: {} }
  const initial = JSON.stringify({ mcpServers: { remote, local }, other: { keep: true } })
  let contents = initial
  const fs = { existsSync: () => true, readFileSync: () => contents, writeFileSync: (_path, value) => { contents = value } }
  const context = {
    ...shared,
    require(name) { return { os: { homedir: () => '/synthetic' }, fs, path }[name] },
    console: { log() {}, error() {} }
  }
  vm.runInNewContext(code, context)
  return { save: (...args) => context.save(undefined, ...args), read: () => contents, initial, remote }
}

test('MCP save rejects remote edits, duplicate creates, rename collisions, and stale entries before writing', async () => {
  const ctx = fixture()
  for (const [name, oldName] of [['remote', 'remote'], ['remote', undefined], ['local', undefined], ['remote', 'local'], ['unused', 'gone']]) {
    assert.equal((await ctx.save(name, { command: 'node' }, oldName)).success, false, name)
    assert.equal(ctx.read(), ctx.initial)
  }
})

test('MCP command edits replace editor fields and keep advanced options, remote siblings, and root fields', async () => {
  const ctx = fixture()
  assert.equal((await ctx.save('local', { command: 'node' }, 'local')).success, true)
  assert.deepEqual(JSON.parse(ctx.read()), {
    mcpServers: { local: { command: 'node', disabledTools: ['remove'], timeout: 1000, extension: {} }, remote: ctx.remote },
    other: { keep: true }
  })
})
