import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
let initializer
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'kiroPermissionsService') {
    initializer = node.initializer.getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(initializer, 'Expected actual Kiro permissions service initialization')
const compiled = ts.transpileModule('globalThis.service = ' + initializer, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function wiring(options = {}) {
  const calls = { discover: 0, inspect: [], init: 0 }
  const env = { KIRO_HOME: 'D:\\Synthetic\\custom-kiro-root' }
  const discovery = options.discovery ?? {
    supported: true,
    candidates: [
      { path: 'D:\\Synthetic\\RunningKiro.exe', version: '1.4.26', source: 'running-process' },
      { path: 'D:\\Synthetic\\OtherKiro.exe', version: '1.4.13', source: 'registry' }
    ]
  }
  const context = vm.createContext({
    KiroPermissionsService: class { constructor(deps) { this.deps = deps } },
    process: { platform: 'win32', env },
    os: { homedir: () => 'D:\\Synthetic\\home' },
    app: { getPath: () => 'D:\\Synthetic\\user-data' },
    join: win32.join,
    kiroInstanceService: { resolveSettingsTarget: async () => { throw new Error('Unexpected profile read') } },
    kiroInstallationDiscovery: { discover: async () => { calls.discover++; return discovery } },
    initStore: async () => { calls.init++ },
    store: { get: key => key === 'kiroInstances' ? (options.instances ?? []) : undefined },
    kiroInstanceRuntime: {
      inspectInstallation: async executable => { calls.inspect.push(executable); return { version: '1.4.26' } }
    }
  })
  vm.runInContext(compiled, context)
  return { deps: context.service.deps, calls, env }
}

test('actual permissions wiring reads discovery.candidates and retains verified discovery priority', async () => {
  const ctx = wiring()
  assert.equal(await ctx.deps.inspectVersion({ type: 'default', homeDir: 'D:\\Synthetic\\home' }), '1.4.26')
  assert.equal(ctx.calls.discover, 1)
  assert.deepEqual(ctx.calls.inspect, [])
})

test('actual permissions wiring keeps no discovered installation unverified', async () => {
  const ctx = wiring({ discovery: { supported: true, candidates: [] } })
  assert.equal(await ctx.deps.inspectVersion({ type: 'default', homeDir: 'D:\\Synthetic\\home' }), undefined)
})

test('actual permissions wiring inspects the chosen managed instance executable', async () => {
  const instanceId = '11111111-1111-4111-8111-111111111111'
  const executablePath = 'D:\\Synthetic\\SelectedKiro.exe'
  const ctx = wiring({ instances: [{ schemaVersion: 2, id: instanceId, executablePath }] })
  assert.equal(await ctx.deps.inspectVersion({ type: 'instance', instanceId, homeDir: 'D:\\Synthetic\\instance-home' }), '1.4.26')
  assert.deepEqual(ctx.calls.inspect, [executablePath])
  assert.equal(ctx.calls.discover, 0)
})

test('actual permissions wiring passes the client environment to the permissions root resolver', () => {
  const ctx = wiring()
  assert.equal(ctx.deps.env, ctx.env)
})
