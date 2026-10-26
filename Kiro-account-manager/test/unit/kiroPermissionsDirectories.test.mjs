import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { KiroPermissionsService, defaultPermissionsFileSystem } from '../../src/main/kiroPermissionsService.ts'

const fixtureRoot = fileURLToPath(new URL('../../../.local/isolated/permissions-first-use/', import.meta.url))
const target = { type: 'default' }

async function fixture(userName, overrides = {}) {
  await fs.mkdir(fixtureRoot, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(join(fixtureRoot, 'case-')))
  const userHome = join(root, userName)
  const appData = join(root, 'manager-data')
  const backupRoot = join(appData, 'kiro-permissions-backups')
  const permissions = join(userHome, '.kiro', 'settings', 'permissions.yaml')
  await fs.mkdir(userHome)
  await fs.mkdir(appData)
  const service = new KiroPermissionsService({
    platform: process.platform, homeDir: userHome, backupRoot, env: {},
    inspectVersion: async () => '1.4.26',
    resolveInstance: async () => { throw new Error('No synthetic instance') },
    ...overrides
  })
  return { root, userHome, appData, backupRoot, permissions, service }
}

async function absent(path) {
  await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
}

test('first use resolves each current user and creates missing configuration and backups only on apply', async () => {
  for (const userName of ['customer-a', '客户 User']) {
    const f = await fixture(userName)
    try {
      const state = await f.service.getState(target)
      assert.equal(state.success, true, JSON.stringify(state))
      assert.equal(state.state.target.permissionsPath, f.permissions)
      assert.equal(state.state.contentStatus, 'unconfigured')
      assert.equal(state.state.restore.status, 'none')
      await absent(join(f.userHome, '.kiro'))
      await absent(f.backupRoot)
      const applied = await f.service.applyAutoApproval(target, state.state.revision)
      assert.equal(applied.success, true, JSON.stringify(applied))
      assert.equal(applied.state.contentStatus, 'configured')
      assert.equal(applied.state.restore.canRestore, true)
      assert.match(await fs.readFile(f.permissions, 'utf8'), /fs_write/)
      const restored = await f.service.restoreBeforeAutoApproval(target, applied.state.revision)
      assert.equal(restored.success, true, JSON.stringify(restored))
      await absent(f.permissions)
    } finally { await fs.rm(f.root, { recursive: true, force: true }) }
  }
})

test('existing client rules load before the manager has ever made a permissions backup', async () => {
  const f = await fixture('existing-client')
  const original = '# customer rules\nrules:\n  - capability: shell\n    effect: ask\n'
  try {
    await fs.mkdir(join(f.userHome, '.kiro', 'settings'), { recursive: true })
    await fs.writeFile(f.permissions, original)
    const state = await f.service.getState(target)
    assert.equal(state.success, true, JSON.stringify(state))
    assert.equal(state.state.restrictions.askCount, 1)
    assert.equal(state.state.restore.status, 'none')
    await absent(f.backupRoot)
    const applied = await f.service.applyAutoApproval(target, state.state.revision)
    assert.equal(applied.success, true, JSON.stringify(applied))
    const restored = await f.service.restoreBeforeAutoApproval(target, applied.state.revision)
    assert.equal(restored.success, true, JSON.stringify(restored))
    assert.equal(await fs.readFile(f.permissions, 'utf8'), original)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test('first-use backup discovery still rejects inaccessible or redirected directories and a missing user home', async () => {
  const f = await fixture('protected-user')
  try {
    const denied = new KiroPermissionsService({
      platform: process.platform, homeDir: f.userHome, backupRoot: f.backupRoot, env: {},
      inspectVersion: async () => '1.4.26', resolveInstance: async () => { throw new Error('Absent') },
      fileSystem: { ...defaultPermissionsFileSystem, lstat: async path => {
        if (path === f.backupRoot) throw Object.assign(new Error('Synthetic denied'), { code: 'EACCES' })
        return defaultPermissionsFileSystem.lstat(path)
      } }
    })
    const deniedState = await denied.getState(target)
    assert.equal(deniedState.success, false)
    assert.equal(deniedState.code, 'IO_ERROR')
    await absent(f.backupRoot)
    await fs.writeFile(f.backupRoot, 'not a directory')
    const redirected = await f.service.getState(target)
    assert.equal(redirected.success, false)
    assert.equal(redirected.code, 'PATH_REDIRECTED')
    await fs.rm(f.backupRoot)
    await fs.rmdir(f.userHome)
    const missingHome = await f.service.getState(target)
    assert.equal(missingHome.success, false)
    assert.equal(missingHome.code, 'INVALID_TARGET')
    await absent(f.userHome)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})
