import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { KiroPermissionsService, defaultPermissionsFileSystem } from '../../src/main/kiroPermissionsService.ts'

const fixtureRoot = fileURLToPath(new URL('../../../.local/isolated/2026-10-26-tool-auto-approval-fixes/service-tests/', import.meta.url))
const target = { type: 'default' }
const original = '# original\nrules: []\n'
async function fixture(overrides = {}) {
  await fs.mkdir(fixtureRoot, { recursive: true })
  const root = await fs.mkdtemp(join(fixtureRoot, 'case-'))
  const home = join(root, 'home')
  const settings = join(home, '.kiro', 'settings')
  const backups = join(root, 'backups')
  await fs.mkdir(settings, { recursive: true })
  await fs.mkdir(backups, { recursive: true })
  const service = new KiroPermissionsService({
    platform: process.platform, homeDir: home, backupRoot: backups, env: {},
    resolveInstance: async () => { throw new Error('Synthetic instance absent') },
    inspectVersion: async () => '1.4.26', ...overrides
  })
  const yaml = join(settings, 'permissions.yaml')
  return { root, home, settings, backups, yaml, service }
}
async function latest(f) {
  const pointerPath = join(f.backups, 'default', 'latest.json')
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'))
  const manifestPath = join(f.backups, 'default', pointer.operationId, 'manifest.json')
  return { pointerPath, pointer, manifestPath, manifest: JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
}
async function apply(f) {
  const state = await f.service.getState(target)
  assert.equal(state.success, true, JSON.stringify(state))
  return f.service.applyAutoApproval(target, state.state.revision)
}

test('JSON-only user policies remain active and read-only; YAML precedence and shadowing races are preserved', async () => {
  const f = await fixture()
  const jsonPath = join(f.settings, 'permissions.json')
  const json = JSON.stringify({ rules: [{ capability: 'shell', effect: 'deny' }, { capability: 'mcp', effect: 'ask' }] })
  await fs.writeFile(jsonPath, json)
  const state = await f.service.getState(target)
  assert.equal(state.success, true)
  assert.equal(state.state.target.permissionsPath, jsonPath)
  assert.equal(state.state.restrictions.denyCount, 1)
  assert.equal(state.state.restrictions.askCount, 1)
  assert.equal(state.state.compatibility.writable, false)
  const applied = await f.service.applyAutoApproval(target, state.state.revision)
  assert.equal(applied.success, false)
  assert.equal(applied.code, 'JSON_POLICY_READ_ONLY')
  assert.equal(await fs.readFile(jsonPath, 'utf8'), json)
  await assert.rejects(fs.stat(f.yaml), { code: 'ENOENT' })
  const restored = await f.service.restoreBeforeAutoApproval(target, state.state.revision)
  assert.equal(restored.success, false)
  assert.equal(restored.code, 'JSON_POLICY_READ_ONLY')

  await fs.writeFile(f.yaml, 'rules:\n  - capability: fs_write\n    effect: ask\n')
  const yamlState = await f.service.getState(target)
  assert.equal(yamlState.success, true)
  assert.equal(yamlState.state.target.permissionsPath, f.yaml)
  assert.equal(yamlState.state.restrictions.denyCount, 0)
  assert.equal(yamlState.state.restrictions.askCount, 1)
  assert.equal(yamlState.state.compatibility.writable, true)

  const race = await fixture({ beforeCommitHook: async ({ permissionsPath }) => {
    await fs.writeFile(join(dirname(permissionsPath), 'permissions.json'), json)
  } })
  // A JSON file that appears after reading an absent YAML must not be shadowed at commit.
  const raceState = await race.service.getState(target)
  assert.equal(raceState.success, true)
  const raceResult = await race.service.applyAutoApproval(target, raceState.state.revision)
  assert.equal(raceResult.success, false)
  await assert.rejects(fs.stat(race.yaml), { code: 'ENOENT' })
})

test('default target follows a valid KIRO_HOME and ignores invalid upstream overrides', async () => {
  const f = await fixture()
  const alternate = join(f.root, 'alternate-kiro')
  await fs.mkdir(join(alternate, 'settings'), { recursive: true })
  const alternateYaml = join(alternate, 'settings', 'permissions.yaml')
  await fs.writeFile(alternateYaml, original)
  const make = env => new KiroPermissionsService({
    platform: process.platform, homeDir: f.home, backupRoot: f.backups, env,
    resolveInstance: async () => { throw new Error('absent') }, inspectVersion: async () => '1.4.26'
  })
  const env = { KIRO_HOME: alternate }
  const service = make(env)
  env.KIRO_HOME = join(f.root, 'changed-after-construction')
  const state = await service.getState(target)
  assert.equal(state.success, true, JSON.stringify(state))
  assert.equal(state.state.target.permissionsPath, alternateYaml)
  if (process.platform === 'win32') {
    const lowerCaseEnvironment = await make({ kiro_home: alternate }).getState(target)
    assert.equal(lowerCaseEnvironment.success, true)
    assert.equal(lowerCaseEnvironment.state.target.permissionsPath, alternateYaml)
  }
  const applied = await service.applyAutoApproval(target, state.state.revision)
  assert.equal(applied.success, true, JSON.stringify(applied))
  await assert.rejects(fs.stat(f.yaml), { code: 'ENOENT' })
  const restored = await service.restoreBeforeAutoApproval(target, applied.state.revision)
  assert.equal(restored.success, true)
  assert.equal(await fs.readFile(alternateYaml, 'utf8'), original)
  for (const value of ['relative-kiro', f.root, f.home, process.platform === 'win32' ? 'C:\\' : '/']) {
    const invalidState = await make({ KIRO_HOME: value }).getState(target)
    assert.equal(invalidState.success, true, JSON.stringify(invalidState))
    assert.equal(invalidState.state.target.permissionsPath, f.yaml)
  }

  // Match the client's support for an absent override root without creating it on a read.
  const absentRoot = join(f.root, 'not-created-yet')
  const absentService = new KiroPermissionsService({
    platform: process.platform, homeDir: f.home, backupRoot: join(f.root, 'separate-backups'),
    env: { KIRO_HOME: absentRoot }, resolveInstance: async () => { throw new Error('absent') },
    inspectVersion: async () => '1.4.26'
  })
  // Backups have their own existing private root, just like production userData.
  await fs.mkdir(join(f.root, 'separate-backups'))
  const absentState = await absentService.getState(target)
  assert.equal(absentState.success, true, JSON.stringify(absentState))
  assert.equal(absentState.state.target.permissionsPath, join(absentRoot, 'settings', 'permissions.yaml'))
  await assert.rejects(fs.stat(absentRoot), { code: 'ENOENT' })
  const absentApplied = await absentService.applyAutoApproval(target, absentState.state.revision)
  assert.equal(absentApplied.success, true, JSON.stringify(absentApplied))
  assert.equal((await fs.stat(join(absentRoot, 'settings', 'permissions.yaml'))).isFile(), true)
})

test('managed instance policy roots ignore the default client KIRO_HOME', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture()
  const instanceHome = join(f.root, 'instance-home')
  await fs.mkdir(instanceHome)
  const service = new KiroPermissionsService({
    platform: 'win32', homeDir: f.home, backupRoot: f.backups,
    env: { KIRO_HOME: join(f.root, 'default-only-override') },
    resolveInstance: async () => ({ label: 'Synthetic instance', homeDir: instanceHome, settingsPath: join(instanceHome, 'settings.json') }),
    inspectVersion: async () => '1.4.26'
  })
  const instanceTarget = { type: 'instance', instanceId: '11111111-1111-4111-8111-111111111111' }
  const state = await service.getState(instanceTarget)
  assert.equal(state.success, true, JSON.stringify(state))
  assert.equal(state.state.target.permissionsPath, join(instanceHome, '.kiro', 'settings', 'permissions.yaml'))
  assert.equal((await service.applyAutoApproval(instanceTarget, state.state.revision)).success, true)
  await assert.rejects(fs.stat(f.yaml), { code: 'ENOENT' })
})

test('transient backup lookup failure never creates a new baseline', async () => {
  let failAt = ''
  let failNext = false
  const io = { ...defaultPermissionsFileSystem, async lstat(path) {
    if (failNext && path.toLowerCase() === failAt.toLowerCase()) {
      failNext = false
      throw Object.assign(new Error('Synthetic EACCES'), { code: 'EACCES' })
    }
    return defaultPermissionsFileSystem.lstat(path)
  } }
  const f = await fixture({ fileSystem: io })
  await fs.writeFile(f.yaml, original)
  assert.equal((await apply(f)).success, true)
  const first = await latest(f)
  await fs.writeFile(f.yaml, '# external edit\nrules: []\n')
  const modified = await f.service.getState(target)
  assert.equal(modified.state.restore.status, 'external_modified')
  failAt = join(f.backups, 'default')
  failNext = true
  const reapplied = await f.service.applyAutoApproval(target, modified.state.revision)
  assert.equal(reapplied.success, false)
  assert.equal(reapplied.code, 'IO_ERROR')
  assert.deepEqual((await latest(f)).pointer, first.pointer)
})

test('restoring stage must be durable before changing the target file', async () => {
  let failUpdates = false
  const io = { ...defaultPermissionsFileSystem, async rename(from, to) {
    if (failUpdates && basename(from).startsWith('.manifest.tmp-')) {
      throw Object.assign(new Error('Synthetic EACCES'), { code: 'EACCES' })
    }
    return defaultPermissionsFileSystem.rename(from, to)
  } }
  const f = await fixture({ fileSystem: io })
  await fs.writeFile(f.yaml, original)
  const applied = await apply(f)
  assert.equal(applied.success, true)
  const appliedBytes = await fs.readFile(f.yaml)
  failUpdates = true
  const restored = await f.service.restoreBeforeAutoApproval(target, applied.state.revision)
  assert.equal(restored.success, false)
  assert.equal(restored.code, 'BACKUP_FAILED')
  assert.deepEqual(await fs.readFile(f.yaml), appliedBytes)
  assert.equal((await latest(f)).manifest.stage, 'applied')
  failUpdates = false
  const retryState = await f.service.getState(target)
  assert.equal(retryState.state.restore.canRestore, true)
  assert.equal((await f.service.restoreBeforeAutoApproval(target, retryState.state.revision)).success, true)
})

test('failed final journal persistence returns pending state and recovers from hashes', async () => {
  let failingStage = 'applied'
  const io = { ...defaultPermissionsFileSystem, async rename(from, to) {
    if (basename(from).startsWith('.manifest.tmp-')) {
      const record = JSON.parse(await fs.readFile(from, 'utf8'))
      if (record.stage === failingStage) throw Object.assign(new Error('Synthetic EACCES'), { code: 'EACCES' })
    }
    return defaultPermissionsFileSystem.rename(from, to)
  } }
  const f = await fixture({ fileSystem: io })
  await fs.writeFile(f.yaml, original)
  const failedApply = await apply(f)
  assert.equal(failedApply.success, false)
  assert.equal(failedApply.code, 'BACKUP_FAILED')
  assert.equal(failedApply.state.restore.status, 'pending_verification')
  const pendingApply = await f.service.getState(target)
  assert.equal(pendingApply.success, true)
  assert.equal(pendingApply.state.restore.status, 'pending_verification')
  assert.equal(pendingApply.state.restore.canRestore, false)
  assert.equal((await latest(f)).manifest.stage, 'prepared')
  failingStage = ''
  const reconciled = await f.service.getState(target)
  assert.equal(reconciled.state.restore.status, 'available')
  failingStage = 'restored'
  const failedRestore = await f.service.restoreBeforeAutoApproval(target, reconciled.state.revision)
  assert.equal(failedRestore.success, false)
  assert.equal(failedRestore.code, 'BACKUP_FAILED')
  assert.equal(failedRestore.state.restore.status, 'pending_verification')
  assert.equal(await fs.readFile(f.yaml, 'utf8'), original)
  assert.equal((await latest(f)).manifest.stage, 'restoring')
  const pendingRestore = await f.service.getState(target)
  assert.equal(pendingRestore.success, true)
  assert.equal(pendingRestore.state.restore.status, 'pending_verification')
  failingStage = ''
  const restored = await f.service.getState(target)
  assert.equal(restored.state.restore.status, 'none')
  assert.equal((await latest(f)).manifest.stage, 'restored')
  assert.equal((await f.service.applyAutoApproval(target, restored.state.revision)).success, true)
})

test('oversized files are rejected before readFile and growing files use a bounded reader', async () => {
  let readCalls = 0
  let boundedCalls = 0
  let grow = false
  const io = { ...defaultPermissionsFileSystem,
    async lstat(path) {
      const stat = await defaultPermissionsFileSystem.lstat(path)
      if (basename(path) !== 'permissions.yaml' || grow) return stat
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, nlink: 1, size: 8 * 1024 ** 3 }
    },
    async readFile(path) {
      if (basename(path) === 'permissions.yaml') readCalls++
      return defaultPermissionsFileSystem.readFile(path)
    },
    async readFileBounded(path, maxBytes) {
      boundedCalls++
      if (grow) return Buffer.alloc(maxBytes + 1)
      return defaultPermissionsFileSystem.readFileBounded(path, maxBytes)
    }
  }
  const f = await fixture({ fileSystem: io })
  await fs.writeFile(f.yaml, original)
  const large = await f.service.getState(target)
  assert.equal(large.success, true)
  assert.equal(large.state.contentStatus, 'invalid')
  assert.equal(readCalls, 0)
  assert.equal(boundedCalls, 0)
  grow = true
  const growing = await f.service.getState(target)
  assert.equal(growing.success, true)
  assert.equal(growing.state.contentStatus, 'invalid')
  assert.equal(readCalls, 0)
  assert.equal(boundedCalls, 1)
  const boundedFixture = join(f.root, 'bounded-read-fixture.bin')
  await fs.writeFile(boundedFixture, Buffer.alloc(1024, 0x61))
  assert.equal((await defaultPermissionsFileSystem.readFileBounded(boundedFixture, 32)).byteLength, 33)
})

test('the actual service preserves BOM and CRLF and restores original bytes', async () => {
  const f = await fixture()
  const bytes = Buffer.from('\uFEFF# preserved\r\nrules: []\r\n')
  await fs.writeFile(f.yaml, bytes)
  const applied = await apply(f)
  assert.equal(applied.success, true, JSON.stringify(applied))
  const nextBytes = await fs.readFile(f.yaml)
  assert.equal(nextBytes.subarray(0, 3).toString('hex'), 'efbbbf')
  assert.equal(nextBytes.toString('utf8').replaceAll('\r\n', '').includes('\n'), false)
  const restored = await f.service.restoreBeforeAutoApproval(target, applied.state.revision)
  assert.equal(restored.success, true)
  assert.deepEqual(await fs.readFile(f.yaml), bytes)
})
