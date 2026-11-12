import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { CrewModelRepairService } from '../../src/main/crewModelRepair.ts'
import { ClientSwitchService } from '../../src/main/clientSwitch.ts'
import { ClientAccessProjectionService } from '../../src/main/clientAccessProjection.ts'
import { registerClientSwitchIpc } from '../../src/main/ipc/clientSwitch.ts'
import { registerClientModelRepairIpc } from '../../src/main/ipc/clientModelRepair.ts'

const app = fileURLToPath(new URL('../..', import.meta.url))
const ts = createRequire(import.meta.url)('typescript')
const source = ts.createSourceFile('main.ts', readFileSync(join(app, 'src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const setup = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setupClientSwitching')
assert.ok(setup)

test('actual main setup wires native repair IPC into normal Crew switching and restore readiness', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crew-native-integration-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const installation = { executablePath: join(directory, 'official/KiroCrew.exe'),
    bundleDirectory: join(directory, 'official/resources/backend-dist/kirocrew-backend'), version: '0.12.2', revision: 'fixture-verified-installation' }
  installation.pythonExecutable = join(installation.bundleDirectory, 'python.exe')
  const packageRoot = join(installation.bundleDirectory, 'Lib/site-packages/kiro_crew')
  cpSync(join(app, 'test/fixtures/crew-model-repair/0.12.2/src/kiro_crew'), packageRoot, { recursive: true })
  const frontend = join(packageRoot, 'static/dist/assets/useWebSocket-BatKnCqf.js')
  mkdirSync(dirname(frontend), { recursive: true })
  cpSync(join(app, 'test/fixtures/crew-model-repair/0.12.2/frontend/useWebSocket-BatKnCqf.js'), frontend)
  writeFileSync(installation.executablePath, 'SYNTHETIC_OFFICIAL_EXE')
  writeFileSync(installation.pythonExecutable, 'SYNTHETIC_PYTHON_EXE')
  const accountId = 'synthetic-account', access = { principalId: 'synthetic-user', accessToken: 'SYNTHETIC_ACCESS',
    expiresAt: Date.now() + 3600_000, provider: 'Github', authMethod: 'social',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/SYNTHETIC', region: 'us-east-1' }
  const stored = new Map([['accountData', { accounts: { [accountId]: { id: accountId } } }]])
  let targetRevision = 'initial', writes = 0, writeDelay, writeEntered, hydrateDelay, hydrateEntered, scheduledTick
  const adapter = { authDomainId: 'synthetic-domain', readRevision: async () => targetRevision,
    write: async (value, expected, guard) => {
      if (writeDelay) { writeEntered?.(); await writeDelay }
      assert.equal(value.accessToken, access.accessToken); assert.equal(expected, targetRevision); guard()
      writes++; targetRevision = 'synthetic-written'; return targetRevision
    } }
  const runtime = { target: 'crew', id: 'crew:synthetic', revision: installation.revision, version: '0.12.2', adapter, isRunning: async () => false }
  class Registry {
    async get(target) { if (hydrateDelay) { hydrateEntered?.(); await hydrateDelay }; return target === 'crew' ? runtime : undefined }
    async crewInstallation() { return installation }
    adapter(id) { return id === runtime.id ? adapter : undefined }
  }
  const handlers = new Map(), event = {}
  const context = vm.createContext({ join, __dirname: join(app, 'out/main'), console,
    process: { platform: 'win32', env: {} }, app: { getPath: () => join(directory, 'manager-data') }, is: { dev: false }, mainWindow: {},
    store: { get: key => stored.get(key), set: (key, value) => stored.set(key, value) },
    ClientRuntimeRegistry: Registry, CrewModelRepairService, ClientSwitchService, ClientAccessProjectionService,
    registerClientSwitchIpc, registerClientModelRepairIpc, assertCrewStopped: async () => {},
    getClientProjectionAccess: id => id === accountId ? access : undefined,
    instanceAccountOwnership: { beginOperation: () => () => {} },
    requireTrustedMainWindow: candidate => assert.equal(candidate, event),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    clientAccessProjection: undefined, clientProjectionTimer: undefined,
    setInterval: callback => { scheduledTick = callback; return { unref() {} } } })
  vm.runInContext(ts.transpileModule(`${setup.getText(source)}; setupClientSwitching()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  const call = (channel, value) => handlers.get(channel)(event, value)
  const switchRequest = { accountId, operationId: 'before', target: 'crew', runtimeId: runtime.id, expectedRuntimeRevision: runtime.revision }
  assert.equal((await call('client-switch:execute', switchRequest)).errorCode, 'MODEL_REPAIR_REQUIRED')
  assert.equal(writes, 0)
  const before = await call('client-model-repair:inspect', accountId)
  assert.equal(before.status, 'needs-repair')
  const repaired = await call('client-model-repair:repair', { accountId, operationId: 'repair', expectedRevision: before.revision })
  assert.equal(repaired.success, true); assert.equal(repaired.state.ready, true)
  assert.equal((await call('client-switch:execute', { ...switchRequest, operationId: 'after' })).status, 'credentials-written')
  assert.equal(writes, 1)
  // A native helper already writing access must finish before any program file changes.
  access.accessToken = 'SYNTHETIC_ROTATED_ACCESS'
  let releaseWrite
  writeDelay = new Promise(resolve => { releaseWrite = resolve })
  const entered = new Promise(resolve => { writeEntered = resolve })
  const switching = call('client-switch:execute', { ...switchRequest, operationId: 'delayed' })
  await entered
  const restoring = call('client-model-repair:restore', { accountId, operationId: 'restore', expectedRevision: repaired.state.revision })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('client-model-repair:inspect', accountId)).errorCode, 'operation-in-progress')
  assert.match(readFileSync(join(packageRoot, 'acp/session_handle_updates.py'), 'utf8'), /apply_config_options/)
  releaseWrite(); writeDelay = undefined
  assert.equal((await switching).status, 'credentials-written')
  const restored = await restoring
  assert.equal(restored.success, true)
  assert.equal((await call('client-switch:inspect', accountId)).targets.find(target => target.target === 'crew').status, 'blocked')
  assert.equal(writes, 2, 'restoring program files must not write account credentials')
  // A background tick that was awaiting runtime detection must not start a new
  // helper after repair begins, and maintenance must not detach its binding.
  const again = await call('client-model-repair:repair', { accountId, operationId: 'repair-again', expectedRevision: restored.state.revision })
  access.accessToken = 'SYNTHETIC_NEXT_ACCESS'
  let releaseHydrate
  hydrateDelay = new Promise(resolve => { releaseHydrate = resolve })
  const hydrating = new Promise(resolve => { hydrateEntered = resolve })
  scheduledTick(); await hydrating
  const restoreAfterTick = call('client-model-repair:restore', { accountId, operationId: 'restore-after-tick', expectedRevision: again.state.revision })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('client-model-repair:inspect', accountId)).errorCode, 'operation-in-progress')
  releaseHydrate(); hydrateDelay = undefined
  assert.equal((await restoreAfterTick).success, true)
  assert.equal(writes, 2, 'a tick overtaken by maintenance must not launch the access helper')
  assert.equal(stored.get('clientAccessBindings')[0].status, 'active')
})
