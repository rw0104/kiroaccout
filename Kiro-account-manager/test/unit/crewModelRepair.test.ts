import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { CrewModelRepairService, type CrewRepairInstallation } from '../../src/main/crewModelRepair'

const resourcesRoot = fileURLToPath(new URL('../../resources/crew-model-repair', import.meta.url))
const originals = fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.2/src/kiro_crew', import.meta.url))
function fixture(t: test.TestContext, options: { localResources?: boolean; version?: '0.12.0' | '0.12.2' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-native-repair-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const install = join(root, 'official'), bundleDirectory = join(install, 'resources/backend-dist/kirocrew-backend')
  const packageRoot = join(bundleDirectory, 'Lib/site-packages/kiro_crew')
  const version = options.version ?? '0.12.2'
  const source = version === '0.12.2' ? originals : fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.0/src/kiro_crew', import.meta.url))
  mkdirSync(bundleDirectory, { recursive: true }); cpSync(source, packageRoot, { recursive: true })
  if (version === '0.12.0') {
    cpSync(fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.0/core.py', import.meta.url)), join(packageRoot, 'dashboard/handlers/core.py'))
    const frontend = join(packageRoot, 'static/dist/assets/useWebSocket-DK9hitwq.js')
    mkdirSync(dirname(frontend), { recursive: true })
    cpSync(fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.0/frontend/useWebSocket-DK9hitwq.js', import.meta.url)), frontend)
    for (const extension of ['.br', '.gz']) cpSync(fileURLToPath(new URL(`../fixtures/crew-model-repair/0.12.0/frontend/useWebSocket-DK9hitwq.js${extension}`, import.meta.url)), frontend + extension)
  } else {
    const frontend = join(packageRoot, 'static/dist/assets/useWebSocket-BatKnCqf.js')
    mkdirSync(dirname(frontend), { recursive: true })
    cpSync(fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.2/frontend/useWebSocket-BatKnCqf.js', import.meta.url)), frontend)
  }
  const executablePath = join(install, 'KiroCrew.exe'), pythonExecutable = join(bundleDirectory, 'python.exe')
  writeFileSync(executablePath, 'SYNTHETIC_SIGNED_APPLICATION'); writeFileSync(pythonExecutable, 'SYNTHETIC_PYTHON')
  const installation: CrewRepairInstallation = { executablePath, pythonExecutable, bundleDirectory, version, revision: 'synthetic-install-1' }
  const selectedResources = options.localResources ? join(root, 'resources') : resourcesRoot
  if (options.localResources) cpSync(resourcesRoot, selectedResources, { recursive: true })
  let running = false, processUnknown = false, replaceCount = 0, failAt = 0
  const service = new CrewModelRepairService({ resourcesRoot: selectedResources, backupRoot: join(root, 'backups'),
    installation: async () => installation,
    assertStopped: async () => {
      if (processUnknown) throw Object.assign(new Error('process-state-unknown'), { code: 'process-state-unknown' })
      if (running) throw Object.assign(new Error('client-running'), { code: 'client-running' })
    },
    replace: (source, target) => { replaceCount++; if (replaceCount === failAt) throw new Error('synthetic write failure'); renameSync(source, target) } })
  return { service, root, install, packageRoot, installation, resourcesRoot: selectedResources,
    setRunning: (value: boolean) => { running = value }, setProcessUnknown: (value: boolean) => { processUnknown = value }, failAt: (value: number) => { failAt = value } }
}

test('native repair publishes the verified official source fix and restores exact original bytes without a workspace', async t => {
  const f = fixture(t), original = readFileSync(join(f.packageRoot, 'acp/session_handle_updates.py'))
  const before = await f.service.inspect()
  assert.equal(before.status, 'needs-repair'); assert.equal(before.ready, false); assert.equal(before.canRepair, true)
  const { state: repaired } = await f.service.repair(before.revision!)
  assert.equal(repaired.ready, true); assert.equal(repaired.canRestore, true)
  assert.match(readFileSync(join(f.packageRoot, 'acp/session_handle_updates.py'), 'utf8'), /apply_config_options/)
  assert.ok(existsSync(join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')))
  const { state: restored } = await f.service.restore(repaired.revision!)
  assert.equal(restored.status, 'needs-repair')
  assert.deepEqual(readFileSync(join(f.packageRoot, 'acp/session_handle_updates.py')), original)
  assert.equal(existsSync(join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')), false)
  assert.equal(existsSync(join(f.install, 'managed-crew')), false)
})

test('running clients prevent installation and restore, while a repaired running client remains ready', async t => {
  const f = fixture(t), before = await f.service.inspect()
  f.setRunning(true)
  const running = await f.service.inspect()
  assert.equal(running.status, 'running'); assert.equal(running.ready, false); assert.equal(running.canRepair, false)
  await assert.rejects(f.service.repair(before.revision!), { code: 'client-running' })
  f.setRunning(false)
  await f.service.repair((await f.service.inspect()).revision!)
  f.setRunning(true)
  const ready = await f.service.inspect()
  assert.equal(ready.ready, true); assert.equal(ready.canRestore, false)
  await assert.rejects(f.service.restore(ready.revision!), { code: 'client-running' })
})

test('official updates and third-party edits invalidate snapshots and never receive an old restore', async t => {
  const f = fixture(t), before = await f.service.inspect()
  writeFileSync(join(f.packageRoot, 'acp/session_handle_updates.py'), '# SYNTHETIC_UNKNOWN_UPSTREAM_CHANGE')
  await assert.rejects(f.service.repair(before.revision!), { code: 'installation-changed' })
  assert.equal((await f.service.inspect()).status, 'unsupported')
  cpSync(originals, f.packageRoot, { recursive: true })
  const { state: repaired } = await f.service.repair((await f.service.inspect()).revision!)
  f.installation.version = '0.13.0'; f.installation.revision = 'synthetic-new-install'
  writeFileSync(f.installation.executablePath, 'SYNTHETIC_NEW_OFFICIAL_EXE')
  await assert.rejects(f.service.restore(repaired.revision!), { code: 'installation-changed' })
  assert.equal((await f.service.inspect()).canRestore, false)
})

test('a newer patch version with the exact same verified source contract remains repairable', async t => {
  const f = fixture(t)
  f.installation.version = '0.12.3'; f.installation.revision = 'synthetic-update-same-contract'
  const before = await f.service.inspect()
  assert.equal(before.canRepair, true)
  assert.equal((await f.service.repair(before.revision!)).state.ready, true)
})

test('an official update that retains only our known added helper can be repaired with a new backup generation', async t => {
  const f = fixture(t)
  await f.service.repair((await f.service.inspect()).revision!)
  cpSync(originals, f.packageRoot, { recursive: true })
  f.installation.version = '0.12.3'; f.installation.revision = 'synthetic-official-update'
  writeFileSync(f.installation.executablePath, 'SYNTHETIC_NEW_OFFICIAL_EXE')
  assert.equal(existsSync(join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')), true)
  const updated = await f.service.inspect()
  assert.equal(updated.canRepair, true)
  const repaired = await f.service.repair(updated.revision!)
  assert.equal(repaired.state.ready, true)
  assert.equal(readdirSync(join(f.root, 'backups')).length, 2, 'updated installation has its own backup, not the old one')
  await f.service.restore(repaired.state.revision!)
  assert.equal(existsSync(join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')), false)
  assert.deepEqual(readFileSync(join(f.packageRoot, 'acp/session_handle_updates.py')), readFileSync(join(originals, 'acp/session_handle_updates.py')))
})

test('0.12.0 to 0.12.2 updates replace a known leftover helper without borrowing old backups', async t => {
  const f = fixture(t, { version: '0.12.0' })
  await f.service.repair((await f.service.inspect()).revision!)
  const added = join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py'), oldHelper = readFileSync(added)
  cpSync(originals, f.packageRoot, { recursive: true })
  cpSync(fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.2/frontend/useWebSocket-BatKnCqf.js', import.meta.url)), join(f.packageRoot, 'static/dist/assets/useWebSocket-BatKnCqf.js'))
  f.installation.version = '0.12.2'; f.installation.revision = 'synthetic-official-cross-contract-update'
  writeFileSync(f.installation.executablePath, 'SYNTHETIC_0122_OFFICIAL_EXE')
  const updated = await f.service.inspect(); assert.equal(updated.canRepair, true)
  const repaired = await f.service.repair(updated.revision!)
  assert.equal(repaired.state.ready, true); assert.notDeepEqual(readFileSync(added), oldHelper)
  assert.equal(readdirSync(join(f.root, 'backups')).length, 2)
  await f.service.restore(repaired.state.revision!)
  assert.equal(existsSync(added), false)
  assert.deepEqual(readFileSync(join(f.packageRoot, 'acp/session_handle_updates.py')), readFileSync(join(originals, 'acp/session_handle_updates.py')))
})

test('unknown added helper content is never adopted as an old manager repair', async t => {
  const f = fixture(t), added = join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')
  const before = await f.service.inspect()
  writeFileSync(added, '# SYNTHETIC_THIRD_PARTY_IMPLEMENTATION')
  const state = await f.service.inspect()
  assert.equal(state.status, 'unsupported'); assert.equal(state.ready, false); assert.equal(state.canRepair, false)
  await assert.rejects(f.service.repair(before.revision!), { code: 'installation-changed' })
  assert.equal(readFileSync(added, 'utf8'), '# SYNTHETIC_THIRD_PARTY_IMPLEMENTATION')
})

test('a publish failure rolls back every already changed file', async t => {
  const f = fixture(t), original = readFileSync(join(f.packageRoot, 'agent_sdk/kas_model_catalog.py'))
  const before = await f.service.inspect(); f.failAt(3)
  await assert.rejects(f.service.repair(before.revision!), { code: 'write-failed' })
  assert.deepEqual(readFileSync(join(f.packageRoot, 'agent_sdk/kas_model_catalog.py')), original)
  assert.equal(existsSync(join(f.packageRoot, 'dashboard/server_runtime/model_catalog_events.py')), false)
  assert.equal((await f.service.inspect()).status, 'needs-repair')
})

test('linked source or backup paths are rejected before any installation write', async t => {
  const f = fixture(t), linkTarget = join(f.root, 'elsewhere.py'), source = join(f.packageRoot, 'agent_sdk/kas_model_catalog.py')
  writeFileSync(linkTarget, readFileSync(source)); rmSync(source)
  try { symlinkSync(linkTarget, source, 'file') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation unavailable'); return }
    throw error
  }
  const state = await f.service.inspect()
  assert.equal(state.ready, false); assert.equal(state.canRepair, false)
})

test('restore interrupted after source restoration retains an explicit recovery path', async t => {
  const f = fixture(t), before = await f.service.inspect()
  const repaired = await f.service.repair(before.revision!)
  await f.service.restore(repaired.state.revision!)
  const backup = join(f.root, 'backups', readdirSync(join(f.root, 'backups'))[0], 'journal.json')
  const journal = JSON.parse(readFileSync(backup, 'utf8')); journal.state = 'applied'
  writeFileSync(backup, JSON.stringify(journal))
  const interrupted = await f.service.inspect()
  assert.equal(interrupted.canRestore, true); assert.equal(interrupted.canRepair, false)
  assert.equal((await f.service.restore(interrupted.revision!)).state.status, 'needs-repair')
})

test('replacement payload tampering after service construction is rejected before touching the install', async t => {
  const f = fixture(t, { localResources: true }), before = await f.service.inspect()
  const original = readFileSync(join(f.packageRoot, 'agent_sdk/kas_model_catalog.py'))
  writeFileSync(join(f.resourcesRoot, '0.12.2/agent_sdk/kas_model_catalog.py'), '# SYNTHETIC_TAMPERED_RESOURCE')
  await assert.rejects(f.service.repair(before.revision!), { code: 'resource-hash-mismatch' })
  assert.deepEqual(readFileSync(join(f.packageRoot, 'agent_sdk/kas_model_catalog.py')), original)
})

test('unknown process state never reports repaired installation ready for switching', async t => {
  const f = fixture(t)
  await f.service.repair((await f.service.inspect()).revision!)
  f.setProcessUnknown(true)
  const state = await f.service.inspect()
  assert.equal(state.status, 'error'); assert.equal(state.ready, false); assert.equal(state.canRepair, false); assert.equal(state.canRestore, false)
  const codeOnly = await f.service.inspectReadiness()
  assert.equal(codeOnly.ready, true, 'ordinary client-switch has its own process check; readiness performs no duplicate process scan')
  assert.equal(codeOnly.canRepair, false); assert.equal(codeOnly.canRestore, false)
})

test('unchanged backend code cannot mask an incompatible or missing official frontend event handler', async t => {
  const f = fixture(t)
  const before = await f.service.inspect()
  writeFileSync(join(f.packageRoot, 'static/dist/assets/useWebSocket-BatKnCqf.js'), '// SYNTHETIC_NEW_FRONTEND_PROTOCOL')
  await assert.rejects(f.service.repair(before.revision!), { code: 'installation-changed' })
  const state = await f.service.inspect()
  assert.equal(state.status, 'unsupported'); assert.equal(state.ready, false)
})

test('verified 0.12.0 native repair installs its matching frontend notification and restores it', async t => {
  const f = fixture(t, { version: '0.12.0' }), frontend = join(f.packageRoot, 'static/dist/assets/useWebSocket-DK9hitwq.js')
  const original = readFileSync(frontend)
  const before = await f.service.inspect(); assert.equal(before.canRepair, true)
  const repaired = await f.service.repair(before.revision!)
  assert.equal(repaired.state.ready, true)
  assert.match(readFileSync(frontend, 'utf8'), /models_catalog_changed/)
  await f.service.restore(repaired.state.revision!)
  assert.deepEqual(readFileSync(frontend), original)
})

test('the actual official static response serves the repaired frontend for Brotli, gzip and identity', async t => {
  const f = fixture(t, { version: '0.12.0' })
  const original = readFileSync(join(f.packageRoot,'static/dist/assets/useWebSocket-DK9hitwq.js'))
  const repaired = await f.service.repair((await f.service.inspect()).revision!)
  const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0)
  assert.ok(python)
  const verify = (expected: Buffer) => {
    const response = spawnSync(python, ['-I','-B',fileURLToPath(new URL('./crewModelStaticResponse.py', import.meta.url)), f.packageRoot], { encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:1024*1024 })
    assert.equal(response.status,0,response.stderr)
    for (const item of JSON.parse(response.stdout)) {
      const encoded = Buffer.from(item.body,'base64')
      assert.equal(encoded.length,item.length)
      const decoded = item.encoding === 'br' ? brotliDecompressSync(encoded) : item.encoding === 'gzip' ? gunzipSync(encoded) : encoded
      assert.deepEqual(decoded,expected,`official ${item.requested} response must use the current asset`)
    }
  }
  verify(readFileSync(join(f.packageRoot,'static/dist/assets/useWebSocket-DK9hitwq.js')))
  await f.service.restore(repaired.state.revision!)
  verify(original)
})

test('native 0.12.0 repair invalidates only web caches once and retains official version and gateway identity', async t => {
  const f = fixture(t, { version: '0.12.0' })
  const repaired = await f.service.repair((await f.service.inspect()).revision!)
  const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0)
  assert.ok(python)
  const probe = () => {
    const result = spawnSync(python, ['-I','-B',fileURLToPath(new URL('./crewModelHealthProbe.py', import.meta.url)),f.packageRoot], {encoding:'utf8',timeout:30000,windowsHide:true})
    assert.equal(result.status,0,result.stderr)
    return JSON.parse(result.stdout)
  }
  const report = probe()
  assert.equal(report.local.version,'0.12.0+kiroaccout.models.1')
  assert.deepEqual(report.remote,{ok:true}); assert.deepEqual(report.rebound,{ok:true})
  assert.equal(report.apiVersion.version,'0.12.0'); assert.equal(report.live.version,'0.12.0'); assert.equal(report.moduleVersion,'0.12.0')
  const require = createRequire(import.meta.url), ts = require('typescript')
  const desktop = fileURLToPath(new URL('../fixtures/crew-model-repair/0.12.0/desktop',import.meta.url))
  const functions = (file: string, names: string[]) => {
    const source=readFileSync(join(desktop,file),'utf8'), tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true)
    return tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(tree)).join('\n')
  }
  const scope=vm.createContext({require,module:{exports:{}}})
  vm.runInContext(functions('auto-update.js',['channelForVersion','isNewerVersion','fourthVersionPart'])+'\n'+functions('instance-guard.js',['identityFamily','decideGatewayAction']),scope)
  assert.equal(scope.channelForVersion(report.local.version),'stable')
  assert.equal(scope.isNewerVersion('0.12.0',report.local.version),false); assert.equal(scope.isNewerVersion(report.local.version,'0.12.0'),false)
  assert.equal(scope.decideGatewayAction('0.12.0',report.local,{localOwner:'kirocrew',bundledGateway:true}).action,'reuse')
  vm.runInContext(readFileSync(join(desktop,'upgrade-cache.js'),'utf8'),scope)
  const stored = new Map([['lastCacheVersion','0.12.0+0.12.0']]), events: unknown[]=[]
  const clear=(version:string)=>scope.module.exports.clearCacheOnUpgrade({appVersion:'0.12.0',probe:async()=>({version}),log(){},
    session:{clearCache:async()=>events.push('http-cache'),clearStorageData:async(options)=>events.push([...options.storages])},
    store:{get:key=>stored.get(key),set:(key,value)=>stored.set(key,value)}})
  assert.equal(await clear(report.local.version),true); assert.equal(await clear(report.local.version),false)
  await f.service.restore(repaired.state.revision!)
  const restored=probe(); assert.equal(restored.local.version,'0.12.0')
  assert.equal(await clear(restored.local.version),true)
  assert.deepEqual(events,['http-cache',['serviceworkers','cachestorage'],'http-cache',['serviceworkers','cachestorage']])
})

for (const version of ['0.12.0', '0.12.2'] as const) {
  test(`deployed ${version} official functions recover the dynamic model menu without a workspace`, async t => {
    const f = fixture(t, { version }), before = await f.service.inspect()
    const repaired = await f.service.repair(before.revision!)
    assert.equal(repaired.success, true)
    const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0)
    assert.ok(python, 'Python 3 is required for native Crew model regression tests')
    const result = spawnSync(python, ['-I', '-B', fileURLToPath(new URL('./crewModelCatalogRegression.py', import.meta.url)), '--version', version, '--installed-root', f.packageRoot],
      { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.successful, true); assert.equal(report.testsRun, 11)
    assert.equal(report.realClientsStarted, 0); assert.equal(report.networkRequests, 0)
    assert.ok(report.beforeAfter.filter(row => row.patched).every(row => row.afterCount === 22))
    if (version === '0.12.2') {
      const cold = spawnSync(python, ['-I','-B',fileURLToPath(new URL('./crewModelColdProbeRegression.py',import.meta.url)), '--installed-root',f.packageRoot],
        {encoding:'utf8',timeout:30000,windowsHide:true})
      assert.equal(cold.status,0,cold.stderr||cold.stdout)
      const lifecycle=JSON.parse(cold.stdout)
      assert.equal(lifecycle.successful,true); assert.equal(lifecycle.testsRun,8)
      assert.equal(lifecycle.realInferenceRequests,0)
    }
  })
}
