import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientRuntimeRegistry, type ClientRuntimeConfig, type ClientRuntimeDependencies, type ClientRuntimeProbe } from '../../src/main/clientRuntimes'
import type { ExternalClientTarget } from '../../src/shared/clientSwitch'

const root = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const verified = (target: ExternalClientTarget): ClientRuntimeProbe => ({ valid: true, publisher: 'CN=Amazon.com, Inc.',
  version: target === 'cli' ? '3.1.0' : '0.12.0' })

type RuntimeProbe = (path: string, target: ExternalClientTarget) => Promise<ClientRuntimeProbe>
interface RuntimeFixture {
  directory: string
  helperPath: string
  configs: Map<ExternalClientTarget, ClientRuntimeConfig>
  probed: string[]
  writes: Array<{ target: ExternalClientTarget; config: ClientRuntimeConfig }>
  deps: ClientRuntimeDependencies
  put(path: string, content: string): void
  install(name: string, target: ExternalClientTarget): string
  registry: ClientRuntimeRegistry
  probe(next: RuntimeProbe): void
}

function fixture(t: TestContext): RuntimeFixture {
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'client-runtime-registry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const helperPath = join(directory, 'manager-resources', 'crew-access.py')
  const put = (path: string, content: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  put(helperPath, '# synthetic helper')
  const configs = new Map<ExternalClientTarget, ClientRuntimeConfig>()
  const probed: string[] = []
  const writes: Array<{ target: ExternalClientTarget; config: ClientRuntimeConfig }> = []
  let probe: RuntimeProbe = async (_path, target) => verified(target)
  const deps: ClientRuntimeDependencies = {
    helperPath, platform: 'win32', home: join(directory, 'home'), env: {},
    readConfig: target => configs.get(target),
    writeConfig: (target, config) => { writes.push({ target, config }); configs.set(target, config) },
    probeExecutable: async (path, target) => { probed.push(path); return await probe(path, target) }
  }
  const install = (name: string, target: ExternalClientTarget): string => {
    const executable = join(directory, name, target === 'cli' ? 'kiro-cli.exe' : 'KiroCrew.exe')
    put(executable, `SYNTHETIC_OFFICIAL_EXE_${name}`)
    if (target === 'crew') {
      const backend = join(dirname(executable), 'resources/backend-dist/kirocrew-backend')
      for (const filename of ['python.exe', 'python3.dll', 'python312.dll', 'BUILD']) put(join(backend, filename), `SYNTHETIC_${filename}`)
      put(join(backend, 'Lib/site-packages/kirocrew-0.12.0.dist-info/METADATA'), 'Name: kirocrew\nVersion: 0.12.0\n')
      for (const filename of ['auth/__init__.py', 'auth/store.py', 'auth/provider.py', 'auth/refresh.py',
        'secrets/__init__.py', 'secrets/vault.py', 'platform_compat.py', 'platform_lock_compat.py',
        'platform_owner_compat.py', 'platform_compat_links.py', 'windows_acl.py',
        'config/loader_document.py', 'config/loader_locations.py', 'config/sections_agent.py', 'atomic_write.py']) {
        put(join(backend, 'Lib/site-packages/kiro_crew', filename), `# SYNTHETIC_${filename}`)
      }
    }
    return executable
  }
  return { directory, helperPath, configs, probed, writes, deps, put, install,
    registry: new ClientRuntimeRegistry(deps),
    probe: (next: typeof probe) => { probe = next } }
}

test('unchanged real installation files reuse the validated runtime and stable adapter', async t => {
  const f = fixture(t)
  const executablePath = f.install('cli', 'cli')
  f.configs.set('cli', { executablePath, dataHome: join(f.directory, 'cli-data') })
  const first = await f.registry.get('cli')
  assert.ok(first)
  assert.equal(await f.registry.get('cli'), first)
  assert.equal(f.registry.adapter(first.id), first.adapter)
  assert.deepEqual(f.probed, [executablePath])
  assert.equal(f.writes.length, 0)
})

test('direct data-home configuration changes invalidate an already returned adapter synchronously', async t => {
  const f = fixture(t)
  const executablePath = f.install('cli', 'cli')
  const config = { executablePath, dataHome: join(f.directory, 'old-data') }
  f.configs.set('cli', config)
  const previous = (await f.registry.get('cli'))!
  config.dataHome = join(f.directory, 'new-data')
  assert.equal(f.registry.adapter(previous.id), undefined)
  const current = (await f.registry.get('cli'))!
  assert.notEqual(current.revision, previous.revision)
  assert.notEqual(current.adapter.authDomainId, previous.adapter.authDomainId)
  assert.equal(f.registry.adapter(current.id), current.adapter)
})

test('an old deferred probe cannot publish its runtime over a newer imported configuration', async t => {
  const f = fixture(t)
  const oldPath = f.install('old-cli', 'cli'), newPath = f.install('new-cli', 'cli')
  const gate = deferred<ClientRuntimeProbe>(), entered = deferred<void>()
  f.configs.set('cli', { executablePath: oldPath, dataHome: join(f.directory, 'data') })
  f.probe(async (path, target) => {
    if (path === oldPath) { entered.resolve(); return await gate.promise }
    return verified(target)
  })
  const old = f.registry.get('cli')
  assert.equal(f.registry.get('cli'), old)
  await entered.promise
  f.configs.set('cli', { executablePath: newPath, dataHome: join(f.directory, 'data') })
  const current = (await f.registry.get('cli'))!
  gate.resolve(verified('cli'))
  assert.equal(await old, undefined)
  assert.equal(await f.registry.get('cli'), current)
  assert.equal(f.registry.adapter(current.id), current.adapter)
})

test('configure invalidates an earlier pending resolution before its new executable probe completes', async t => {
  const f = fixture(t)
  const oldPath = f.install('old-crew', 'crew'), newPath = f.install('new-crew', 'crew')
  const gate = deferred<ClientRuntimeProbe>(), entered = deferred<void>()
  f.configs.set('crew', { executablePath: oldPath, dataHome: join(f.directory, 'old-data') })
  f.probe(async (path, target) => {
    if (path === oldPath) { entered.resolve(); return await gate.promise }
    return verified(target)
  })
  const old = f.registry.get('crew')
  await entered.promise
  await f.registry.configure('crew', newPath)
  const current = (await f.registry.get('crew'))!
  gate.resolve(verified('crew'))
  assert.equal(await old, undefined)
  assert.equal(f.configs.get('crew')!.executablePath, newPath)
  assert.equal(f.registry.adapter(current.id), current.adapter)
  assert.equal(f.writes.length, 1)
})

test('a delayed configure cannot overwrite a newer configure choice', async t => {
  const f = fixture(t)
  const firstPath = f.install('first-crew', 'crew'), finalPath = f.install('final-crew', 'crew')
  const gate = deferred<ClientRuntimeProbe>(), entered = deferred<void>()
  f.probe(async (path, target) => {
    if (path === firstPath) { entered.resolve(); return await gate.promise }
    return verified(target)
  })
  const old = f.registry.configure('crew', firstPath)
  await entered.promise
  await f.registry.configure('crew', finalPath)
  gate.resolve(verified('crew'))
  await assert.rejects(old, /configuration-changed/)
  assert.equal(f.configs.get('crew')!.executablePath, finalPath)
  assert.equal(f.writes.length, 1)
})

test('backend and helper updates invalidate the old Crew adapter even when its outer EXE stays unchanged', async t => {
  const f = fixture(t)
  const executablePath = f.install('crew', 'crew')
  f.configs.set('crew', { executablePath, dataHome: join(f.directory, 'crew-data') })
  const backend = join(dirname(executablePath), 'resources/backend-dist/kirocrew-backend')
  const files = [join(backend, 'python.exe'), join(backend, 'python312.dll'),
    join(backend, 'Lib/site-packages/kiro_crew/auth/store.py'), join(backend, 'Lib/site-packages/kiro_crew/auth/provider.py'),
    join(backend, 'Lib/site-packages/kiro_crew/platform_lock_compat.py'), f.helperPath]
  for (const changed of files) {
    const previous = (await f.registry.get('crew'))!
    const sameLength = readFileSync(changed)
    // Real filesystem metadata changes, with content size held constant.
    writeFileSync(changed, Buffer.alloc(sameLength.length, 'x'))
    const shifted = new Date(Date.now() + 3000)
    utimesSync(changed, shifted, shifted)
    assert.equal(f.registry.adapter(previous.id), undefined)
    const current = (await f.registry.get('crew'))!
    assert.notEqual(current.revision, previous.revision)
    assert.notEqual(current.adapter, previous.adapter)
  }
  assert.ok(f.probed.length >= files.length + 1)
})

test('resources changed while the executable is being verified are not cached as a stable runtime', async t => {
  const f = fixture(t)
  const executablePath = f.install('crew', 'crew')
  f.configs.set('crew', { executablePath, dataHome: join(f.directory, 'data') })
  const gate = deferred<ClientRuntimeProbe>(), entered = deferred<void>()
  f.probe(async () => { entered.resolve(); return await gate.promise })
  const pending = f.registry.get('crew')
  await entered.promise
  f.put(join(dirname(executablePath), 'resources/backend-dist/kirocrew-backend/Lib/site-packages/kiro_crew/auth/store.py'), '# CHANGED_DURING_PROBE')
  gate.resolve(verified('crew'))
  assert.equal(await pending, undefined)
})

test('a mismatched Crew backend package version is rejected despite a supported signed outer EXE', async t => {
  const f = fixture(t)
  const executablePath = f.install('crew', 'crew')
  f.configs.set('crew', { executablePath, dataHome: join(f.directory, 'data') })
  f.put(join(dirname(executablePath), 'resources/backend-dist/kirocrew-backend/Lib/site-packages/kirocrew-0.12.0.dist-info/METADATA'),
    'Name: kirocrew\nVersion: 0.13.0\n')
  await assert.rejects(f.registry.get('crew'), /unsupported-client-version/)
  assert.equal(f.writes.length, 0)
})

test('invalid imported configuration invalidates the cache and does not fall back to another installation', async t => {
  const f = fixture(t)
  const executablePath = f.install('cli', 'cli')
  f.configs.set('cli', { executablePath, dataHome: join(f.directory, 'data') })
  const previous = (await f.registry.get('cli'))!
  f.configs.set('cli', { executablePath: 'relative.exe' })
  assert.equal(f.registry.adapter(previous.id), undefined)
  assert.equal(await f.registry.get('cli'), undefined)
  assert.equal(f.probed.length, 1)
})
