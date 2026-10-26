import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  KIRO_AUTO_APPROVAL_TEMPLATE_YAML,
  KIRO_AUTO_APPROVAL_TEMPLATE_VERSION
} from '../../src/shared/kiroPermissions.ts'
import {
  KiroPermissionsError,
  inspectKiroPermissionsDocument,
  planKiroAutoApprovalMerge,
  sha256Buffer
} from '../../src/main/kiroPermissions.ts'
import {
  KiroPermissionsService,
  defaultPermissionsFileSystem,
  kiroPermissionsFailure
} from '../../src/main/kiroPermissionsService.ts'
import { requireTrustedMainWindow } from '../../src/main/trustedIpc.ts'

const INSTANCE_A = '11111111-1111-4111-8111-111111111111'
const INSTANCE_B = '22222222-2222-4222-8222-222222222222'
const DELETED_INSTANCE = '33333333-3333-4333-8333-333333333333'

function createTempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'kiro-permissions-test-'))
  const defaultHome = join(root, 'default-home')
  const instanceAHome = join(root, 'instances', INSTANCE_A, 'home')
  const instanceBHome = join(root, 'instances', INSTANCE_B, 'home')
  const backupRoot = join(root, 'userData', 'kiro-permissions-backups')
  mkdirSync(defaultHome, { recursive: true })
  mkdirSync(instanceAHome, { recursive: true })
  mkdirSync(instanceBHome, { recursive: true })
  mkdirSync(backupRoot, { recursive: true })
  return {
    root,
    defaultHome,
    instanceAHome,
    instanceBHome,
    backupRoot,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function createServiceHarness(ws, overrides = {}) {
  const instances = new Map([
    [
      INSTANCE_A,
      {
        label: 'Instance A',
        homeDir: ws.instanceAHome,
        settingsPath: join(ws.instanceAHome, 'User', 'settings.json')
      }
    ],
    [
      INSTANCE_B,
      {
        label: 'Instance B',
        homeDir: ws.instanceBHome,
        settingsPath: join(ws.instanceBHome, 'User', 'settings.json')
      }
    ]
  ])

  let version = 'version' in overrides ? overrides.version : '1.4.26'
  const service = new KiroPermissionsService({
    platform: overrides.platform ?? process.platform,
    homeDir: ws.defaultHome,
    backupRoot: ws.backupRoot,
    resolveInstance: async id => {
      const found = instances.get(id)
      if (!found) {
        throw new Error('找不到所选 Kiro 多开实例，未读取或修改默认 Kiro 设置。')
      }
      return found
    },
    inspectVersion: overrides.inspectVersion ?? (async () => version),
    chooseExportPath: overrides.chooseExportPath,
    fileSystem: overrides.fileSystem,
    beforeCommitHook: overrides.beforeCommitHook
  })

  return {
    service,
    instances,
    setVersion(nextVersion) {
      version = nextVersion
    }
  }
}

test('YAML inspection and lossless merge cover empty, comment-only, partial, idempotent, scoped, restrictive, BOM and CRLF cases', () => {
  // 1. Empty or comment-only preserves comments and adds both rules
  const commentOnly = '# header comment\r\n# second line\r\n'
  const mergedFromComments = planKiroAutoApprovalMerge(commentOnly)
  assert.equal(mergedFromComments.changed, true)
  assert.deepEqual(mergedFromComments.addedRules, ['all', 'fs_write'])
  assert.ok(mergedFromComments.content.startsWith('# header comment\r\n# second line\r\n'))
  assert.match(mergedFromComments.content, /\r\n/)
  assert.equal(mergedFromComments.afterInspection.contentStatus, 'configured')

  // 2. Partial rule: only allow: all present -> only adds fs_write
  const onlyAll = 'rules:\n  - capability: all\n    effect: allow\n'
  const mergedFromAll = planKiroAutoApprovalMerge(onlyAll)
  assert.equal(mergedFromAll.changed, true)
  assert.deepEqual(mergedFromAll.addedRules, ['fs_write'])
  assert.equal(mergedFromAll.afterInspection.contentStatus, 'configured')

  // 3. Partial rule: only allow: fs_write present -> only adds all
  const onlyFsWrite = 'rules:\n  - capability: fs_write\n    effect: allow\n'
  const mergedFromFsWrite = planKiroAutoApprovalMerge(onlyFsWrite)
  assert.equal(mergedFromFsWrite.changed, true)
  assert.deepEqual(mergedFromFsWrite.addedRules, ['all'])
  assert.equal(mergedFromFsWrite.afterInspection.contentStatus, 'configured')

  // 4. Idempotent when both rules already exist
  const secondPass = planKiroAutoApprovalMerge(mergedFromAll.content)
  assert.equal(secondPass.changed, false)
  assert.deepEqual(secondPass.addedRules, [])
  assert.equal(secondPass.content, mergedFromAll.content)

  // 5. Scoped allow rule (with match / exclude / extra keys) is NOT treated as unconditional auto-approval
  const scopedYaml = [
    '\uFEFF# user custom rules',
    'version: 1',
    'rules:',
    '  - capability: all',
    '    effect: allow',
    '    match:',
    '      - "npm test"',
    '  - capability: fs_write',
    '    effect: allow',
    '    exclude:',
    '      - ".env*"',
    '  - capability: shell',
    '    effect: deny',
    '    match:',
    '      - "rm -rf *"',
    '  - capability: mcp',
    '    effect: ask',
    '  - capability: future_capability',
    '    effect: allow',
    '    customField: preserved',
    ''
  ].join('\r\n')

  const scopedInspection = inspectKiroPermissionsDocument(scopedYaml)
  assert.equal(scopedInspection.contentStatus, 'unconfigured')
  assert.deepEqual(scopedInspection.presence.missingRules, ['all', 'fs_write'])
  assert.equal(scopedInspection.restrictions.hasRestrictiveRules, true)
  assert.equal(scopedInspection.restrictions.denyCount, 1)
  assert.equal(scopedInspection.restrictions.askCount, 1)
  assert.equal(scopedInspection.restrictions.scopedAllowCount, 2)
  assert.equal(scopedInspection.restrictions.unknownRuleCount, 1)

  const mergedScoped = planKiroAutoApprovalMerge(scopedYaml)
  assert.equal(mergedScoped.changed, true)
  assert.deepEqual(mergedScoped.addedRules, ['all', 'fs_write'])
  assert.ok(mergedScoped.content.startsWith('\uFEFF# user custom rules\r\n'))
  assert.match(mergedScoped.content, /version: 1\r\n/)
  assert.match(mergedScoped.content, /future_capability/)
  assert.match(mergedScoped.content, /customField: preserved/)
  assert.equal(mergedScoped.afterInspection.contentStatus, 'configured')
  assert.equal(mergedScoped.afterInspection.restrictions.hasRestrictiveRules, true)
  assert.equal(mergedScoped.afterInspection.restrictions.denyCount, 1)
  assert.equal(mergedScoped.afterInspection.restrictions.askCount, 1)
  assert.equal(mergedScoped.afterInspection.restrictions.scopedAllowCount, 2)
  assert.equal(mergedScoped.afterInspection.restrictions.unknownRuleCount, 1)
})

test('YAML validation rejects malformed syntax, duplicate keys, multi-doc, anchors/aliases, custom tags, >1 MiB and >4096 rules without leaking content', () => {
  const secretMarker = 'PRIVATE_SECRET_TOKEN_VALUE_999'
  const invalidCases = [
    {
      name: 'syntax error',
      yaml: `rules:\n  - capability: "${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'non-map root',
      yaml: `- capability: all\n  secret: ${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'non-array rules',
      yaml: `rules:\n  secret: ${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'non-map rule item',
      yaml: `rules:\n  - "${secretMarker}"\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'duplicate key in root',
      yaml: `rules: []\nrules:\n  - capability: ${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'duplicate key in rule',
      yaml: `rules:\n  - capability: all\n    capability: ${secretMarker}\n    effect: allow\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'multi-document YAML',
      yaml: `rules: []\n---\nsecret: ${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'anchor and alias',
      yaml: `rules:\n  - &a\n    capability: all\n    effect: allow\n    secret: ${secretMarker}\n  - *a\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'custom tag',
      yaml: `rules:\n  - !custom\n    capability: ${secretMarker}\n`,
      code: 'INVALID_YAML'
    },
    {
      name: 'file larger than 1 MiB',
      yaml: `# ${'x'.repeat(1024 * 1024 + 32)}\n`,
      code: 'FILE_TOO_LARGE'
    },
    {
      name: 'more than 4096 rules',
      yaml: 'rules:\n' + '  - capability: shell\n    effect: ask\n'.repeat(4097),
      code: 'TOO_MANY_RULES'
    }
  ]

  for (const item of invalidCases) {
    assert.throws(
      () => inspectKiroPermissionsDocument(item.yaml),
      error => {
        assert.ok(error instanceof KiroPermissionsError, `Expected KiroPermissionsError for ${item.name}`)
        assert.equal(error.code, item.code, `Unexpected code for ${item.name}`)
        assert.equal(error.message.includes(secretMarker), false, `Leaked content in ${item.name}`)
        return true
      }
    )
  }
})

test('service lifecycle: missing file apply & restore, existing file apply & restore, and multi-instance isolation', async () => {
  const ws = createTempWorkspace()
  try {
    const { service } = createServiceHarness(ws)
    const defaultPermPath = join(ws.defaultHome, '.kiro', 'settings', 'permissions.yaml')
    const instanceAPermPath = join(ws.instanceAHome, '.kiro', 'settings', 'permissions.yaml')
    const instanceBPermPath = join(ws.instanceBHome, '.kiro', 'settings', 'permissions.yaml')

    // Initial state on default client (file does not exist)
    const initDefault = await service.getState({ type: 'default' })
    assert.equal(initDefault.success, true)
    assert.equal(initDefault.state.contentStatus, 'unconfigured')
    assert.equal(initDefault.state.revision.exists, false)
    assert.deepEqual(initDefault.state.presence.missingRules, ['all', 'fs_write'])
    assert.equal(initDefault.state.restore.canRestore, false)
    assert.equal(initDefault.state.restore.status, 'none')

    // Apply on default client creates file
    const appliedDefault = await service.applyAutoApproval({ type: 'default' }, initDefault.state.revision)
    assert.equal(appliedDefault.success, true)
    assert.equal(appliedDefault.changed, true)
    assert.deepEqual(appliedDefault.addedRules, ['all', 'fs_write'])
    assert.equal(appliedDefault.state.contentStatus, 'configured')
    assert.equal(appliedDefault.state.restore.canRestore, true)
    assert.equal(appliedDefault.state.restore.status, 'available')
    assert.equal(appliedDefault.state.restore.originalExisted, false)
    assert.equal(existsSync(defaultPermPath), true)
    assert.equal(existsSync(instanceAPermPath), false)
    assert.equal(existsSync(instanceBPermPath), false)

    // Restore on default client deletes the newly created file
    const restoredDefault = await service.restoreBeforeAutoApproval(
      { type: 'default' },
      appliedDefault.state.revision
    )
    assert.equal(restoredDefault.success, true)
    assert.equal(restoredDefault.restored, true)
    assert.equal(existsSync(defaultPermPath), false)
    assert.equal(restoredDefault.state.contentStatus, 'unconfigured')
    assert.equal(restoredDefault.state.restore.canRestore, false)
    assert.equal(restoredDefault.state.restore.status, 'none')

    // Pre-populate Instance A with custom permissions.yaml
    mkdirSync(join(ws.instanceAHome, '.kiro', 'settings'), { recursive: true })
    const customYamlA = '# instance A comment\nrules:\n  - capability: shell\n    effect: ask\n'
    writeFileSync(instanceAPermPath, customYamlA, 'utf8')

    const initA = await service.getState({ type: 'instance', instanceId: INSTANCE_A })
    assert.equal(initA.success, true)
    assert.equal(initA.state.contentStatus, 'unconfigured')
    assert.equal(initA.state.restrictions.askCount, 1)

    // Apply on Instance A preserves comment + ask rule and adds both rules
    const appliedA = await service.applyAutoApproval(
      { type: 'instance', instanceId: INSTANCE_A },
      initA.state.revision
    )
    assert.equal(appliedA.success, true)
    assert.equal(appliedA.changed, true)
    assert.equal(appliedA.state.contentStatus, 'configured')
    assert.equal(appliedA.state.restrictions.hasRestrictiveRules, true)
    assert.equal(appliedA.state.restore.canRestore, true)
    assert.equal(appliedA.state.restore.originalExisted, true)
    assert.equal(existsSync(defaultPermPath), false)
    assert.equal(existsSync(instanceBPermPath), false)

    // Restore on Instance A restores exact original content
    const restoredA = await service.restoreBeforeAutoApproval(
      { type: 'instance', instanceId: INSTANCE_A },
      appliedA.state.revision
    )
    assert.equal(restoredA.success, true)
    assert.equal(readFileSync(instanceAPermPath, 'utf8'), customYamlA)
    assert.equal(restoredA.state.restore.canRestore, false)
  } finally {
    ws.cleanup()
  }
})

test('invalid targets, deleted instances, symlinks, hardlinks and unsupported client versions are rejected safely', async () => {
  const ws = createTempWorkspace()
  try {
    const { service, setVersion } = createServiceHarness(ws)
    const defaultPermPath = join(ws.defaultHome, '.kiro', 'settings', 'permissions.yaml')

    // 1. Deleted instance or invalid target never falls back to default
    const deletedRes = await service.getState({ type: 'instance', instanceId: DELETED_INSTANCE })
    assert.equal(deletedRes.success, false)
    assert.equal(deletedRes.code, 'INVALID_TARGET')

    const traversalRes = await service.getState({ type: 'instance', instanceId: '../default-home' })
    assert.equal(traversalRes.success, false)
    assert.equal(traversalRes.code, 'INVALID_TARGET')

    const extraFieldRes = await service.getState({
      type: 'default',
      permissionsPath: defaultPermPath
    })
    assert.equal(extraFieldRes.success, false)
    assert.equal(extraFieldRes.code, 'INVALID_TARGET')

    // 2. Unsupported client version disables apply/restore while allowing getState and exportTemplate
    setVersion('2.0.0')
    const stateV2 = await service.getState({ type: 'default' })
    assert.equal(stateV2.success, true)
    assert.equal(stateV2.state.compatibility.status, 'unverified')
    assert.equal(stateV2.state.compatibility.writable, false)

    setVersion('0.9.0')
    const stateV0 = await service.getState({ type: 'default' })
    assert.equal(stateV0.success, true)
    assert.equal(stateV0.state.compatibility.status, 'unsupported')
    assert.equal(stateV0.state.compatibility.writable, false)

    const applyV2 = await service.applyAutoApproval({ type: 'default' }, stateV2.state.revision)
    assert.equal(applyV2.success, false)
    assert.equal(applyV2.code, 'COMPATIBILITY_UNVERIFIED')
    assert.equal(existsSync(defaultPermPath), false)

    setVersion(undefined)
    const stateUnknown = await service.getState({ type: 'default' })
    assert.equal(stateUnknown.success, true)
    assert.equal(stateUnknown.state.compatibility.writable, false)
    const applyUnknown = await service.applyAutoApproval(
      { type: 'default' },
      stateUnknown.state.revision
    )
    assert.equal(applyUnknown.success, false)
    assert.equal(applyUnknown.code, 'COMPATIBILITY_UNVERIFIED')

    // Restore version to 1.4.26
    setVersion('1.4.26')

    // 3. Symlinked or hardlinked target file is rejected via fileSystem lstat check
    mkdirSync(join(ws.defaultHome, '.kiro', 'settings'), { recursive: true })
    writeFileSync(defaultPermPath, 'rules: []\n', 'utf8')

    const symlinkFs = {
      ...defaultPermissionsFileSystem,
      async lstat(path) {
        const real = await defaultPermissionsFileSystem.lstat(path)
        if (path === defaultPermPath) {
          return {
            isSymbolicLink: () => true,
            isDirectory: () => false,
            isFile: () => true,
            size: real.size,
            nlink: 1
          }
        }
        return real
      }
    }
    const symlinkService = createServiceHarness(ws, { fileSystem: symlinkFs }).service
    const symlinkState = await symlinkService.getState({ type: 'default' })
    assert.equal(symlinkState.success, false)
    assert.equal(symlinkState.code, 'PATH_REDIRECTED')

    const hardlinkFs = {
      ...defaultPermissionsFileSystem,
      async lstat(path) {
        const real = await defaultPermissionsFileSystem.lstat(path)
        if (path === defaultPermPath) {
          return {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
            size: real.size,
            nlink: 2
          }
        }
        return real
      }
    }
    const hardlinkService = createServiceHarness(ws, { fileSystem: hardlinkFs }).service
    const hardlinkState = await hardlinkService.getState({ type: 'default' })
    assert.equal(hardlinkState.success, false)
    assert.equal(hardlinkState.code, 'PATH_REDIRECTED')
  } finally {
    ws.cleanup()
  }
})

test('concurrent writes, revision checks, external modification conflicts and crash recovery stages work deterministically', async () => {
  const ws = createTempWorkspace()
  try {
    const defaultPermPath = join(ws.defaultHome, '.kiro', 'settings', 'permissions.yaml')
    const { service } = createServiceHarness(ws)

    const initial = await service.getState({ type: 'default' })
    assert.equal(initial.success, true)

    // 1. Concurrent apply calls with the same initial revision: first succeeds, second fails with REVISION_CONFLICT
    const [firstApply, secondApply] = await Promise.all([
      service.applyAutoApproval({ type: 'default' }, initial.state.revision),
      service.applyAutoApproval({ type: 'default' }, initial.state.revision)
    ])
    assert.equal(firstApply.success, true, JSON.stringify(firstApply))
    assert.equal(secondApply.success, false, JSON.stringify(secondApply))
    assert.equal(secondApply.code, 'REVISION_CONFLICT')

    // 2. External modification after apply disables restore and prevents silent snapshot overwrite when both rules still exist
    const externallyEdited =
      readFileSync(defaultPermPath, 'utf8') + '\n# user added comment externally\n'
    writeFileSync(defaultPermPath, externallyEdited, 'utf8')

    const afterExternalState = await service.getState({ type: 'default' })
    assert.equal(afterExternalState.success, true)
    assert.equal(afterExternalState.state.contentStatus, 'configured')
    assert.equal(afterExternalState.state.restore.canRestore, false)
    assert.equal(afterExternalState.state.restore.status, 'external_modified')

    const blockedRestore = await service.restoreBeforeAutoApproval(
      { type: 'default' },
      afterExternalState.state.revision
    )
    assert.equal(blockedRestore.success, false)
    assert.equal(blockedRestore.code, 'RESTORE_CONFLICT')
    assert.equal(readFileSync(defaultPermPath, 'utf8'), externallyEdited)

    // Re-applying when both rules already exist is a no-op and preserves external_modified restore status
    const noopApply = await service.applyAutoApproval(
      { type: 'default' },
      afterExternalState.state.revision
    )
    assert.equal(noopApply.success, true)
    assert.equal(noopApply.changed, false)
    assert.equal(noopApply.state.restore.status, 'external_modified')

    // 3. External modification when missing rules appear also refuses to silently overwrite previous snapshot baseline
    writeFileSync(defaultPermPath, 'rules: []\n', 'utf8')
    const afterRuleRemovedState = await service.getState({ type: 'default' })
    assert.equal(afterRuleRemovedState.success, true)
    assert.equal(afterRuleRemovedState.state.restore.status, 'external_modified')
    const protectBaselineApply = await service.applyAutoApproval(
      { type: 'default' },
      afterRuleRemovedState.state.revision
    )
    assert.equal(protectBaselineApply.success, false)
    assert.equal(protectBaselineApply.code, 'RESTORE_CONFLICT')

    // 3b. Pre-commit external modification conflict during apply (tested on Instance A)
    const instanceAPermPath = join(ws.instanceAHome, '.kiro', 'settings', 'permissions.yaml')
    mkdirSync(join(ws.instanceAHome, '.kiro', 'settings'), { recursive: true })
    writeFileSync(instanceAPermPath, 'rules: []\n', 'utf8')
    const beforeHookState = await service.getState({ type: 'instance', instanceId: INSTANCE_A })
    assert.equal(beforeHookState.success, true)

    const raceService = createServiceHarness(ws, {
      beforeCommitHook: async ({ permissionsPath }) => {
        writeFileSync(permissionsPath, '# concurrent external edit\nrules: []\n', 'utf8')
      }
    }).service

    const raceApply = await raceService.applyAutoApproval(
      { type: 'instance', instanceId: INSTANCE_A },
      beforeHookState.state.revision
    )
    assert.equal(raceApply.success, false)
    assert.equal(raceApply.code, 'REVISION_CONFLICT')
    assert.equal(readFileSync(instanceAPermPath, 'utf8'), '# concurrent external edit\nrules: []\n')

    // 4. Crash recovery reconciliation: stage = 'prepared' with third-party hash -> pending_verification
    const latestPath = join(ws.backupRoot, 'default', 'latest.json')
    const latestPointer = JSON.parse(readFileSync(latestPath, 'utf8'))
    const manifestPath = join(ws.backupRoot, 'default', latestPointer.operationId, 'manifest.json')
    const latestManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const interruptedManifest = {
      ...latestManifest,
      stage: 'prepared',
      originalExisted: false,
      beforeHash: null,
      afterHash: 'f'.repeat(64)
    }
    writeFileSync(manifestPath, JSON.stringify(interruptedManifest, null, 2), 'utf8')

    const conflictState = await service.getState({ type: 'default' })
    assert.equal(conflictState.success, true)
    assert.equal(conflictState.state.restore.status, 'pending_verification')
    assert.equal(conflictState.state.restore.canRestore, false)
    assert.ok(conflictState.state.restore.backupDir)

    // Apply is blocked while pending_verification is unresolved
    const blockedApplyOnConflict = await service.applyAutoApproval(
      { type: 'default' },
      conflictState.state.revision
    )
    assert.equal(blockedApplyOnConflict.success, false)
    assert.equal(blockedApplyOnConflict.code, 'RESTORE_CONFLICT')

    // 5. Crash recovery reconciliation: stage = 'prepared' where current file already equals afterHash -> reconciled to 'applied'
    const currentBytes = readFileSync(defaultPermPath)
    const currentSha = sha256Buffer(currentBytes)
    const completedOnDiskManifest = {
      ...latestManifest,
      stage: 'prepared',
      originalExisted: false,
      beforeHash: null,
      afterHash: currentSha
    }
    writeFileSync(manifestPath, JSON.stringify(completedOnDiskManifest, null, 2), 'utf8')

    const reconciledApplied = await service.getState({ type: 'default' })
    assert.equal(reconciledApplied.success, true)
    assert.equal(reconciledApplied.state.restore.status, 'available')
    assert.equal(reconciledApplied.state.restore.canRestore, true)

    // 6. Export template writes KIRO_AUTO_APPROVAL_TEMPLATE_YAML to chosen path
    const exportTarget = join(ws.root, 'exported-permissions.yaml')
    const exportService = createServiceHarness(ws, {
      chooseExportPath: async () => exportTarget
    }).service
    const exportRes = await exportService.exportTemplate()
    assert.equal(exportRes.success, true)
    assert.equal(readFileSync(exportTarget, 'utf8'), KIRO_AUTO_APPROVAL_TEMPLATE_YAML)
    assert.ok(KIRO_AUTO_APPROVAL_TEMPLATE_VERSION)
  } finally {
    ws.cleanup()
  }
})

function extractPermissionsIpcHandlers(deps) {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const sourceFile = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const channels = new Set([
    'get-kiro-permissions',
    'apply-kiro-auto-approval',
    'restore-kiro-auto-approval',
    'export-kiro-auto-approval-template'
  ])
  const statements = []
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ipcMain' &&
      node.expression.name.text === 'handle' &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      channels.has(node.arguments[0].text)
    ) {
      statements.push(node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.equal(statements.length, 4, 'Expected all four Kiro permissions IPC handlers in src/main/index.ts')

  const handlers = new Map()
  const compiled = ts.transpileModule(statements.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText

  vm.runInNewContext(compiled, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    requireTrustedMainWindow,
    mainWindow: deps.mainWindow,
    __dirname: 'D:\\app\\out\\main',
    join: win32.join,
    is: { dev: false },
    process: { env: {} },
    kiroPermissionsService: deps.service,
    kiroPermissionsFailure
  })

  return handlers
}

test('actual permissions IPC handlers in src/main/index.ts enforce requireTrustedMainWindow and reject untrusted senders', async () => {
  const ws = createTempWorkspace()
  try {
    const { service } = createServiceHarness(ws)
    const trustedMainFrame = { routingId: 10, url: 'file:///D:/app/out/renderer/index.html' }
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { id: 1, mainFrame: trustedMainFrame }
    }
    const handlers = extractPermissionsIpcHandlers({ mainWindow, service })

    // Untrusted sender (wrong webContents id or non-main frame) is rejected before service runs
    const untrustedEvent = {
      sender: { id: 999, mainFrame: trustedMainFrame },
      senderFrame: trustedMainFrame
    }
    for (const [channel, handler] of handlers.entries()) {
      const res = await handler(untrustedEvent, { type: 'default' })
      assert.equal(res.success, false, `Expected ${channel} to reject untrusted sender`)
      assert.equal(res.code, 'IO_ERROR')
    }

    // Trusted sender succeeds and cannot pass arbitrary paths
    const trustedEvent = {
      sender: mainWindow.webContents,
      senderFrame: trustedMainFrame
    }
    const getRes = await handlers.get('get-kiro-permissions')(trustedEvent, { type: 'default' })
    assert.equal(getRes.success, true)

    const badTargetRes = await handlers.get('apply-kiro-auto-approval')(
      trustedEvent,
      { type: 'default', extraPath: 'C:\\evil.yaml' },
      getRes.state.revision
    )
    assert.equal(badTargetRes.success, false)
    assert.equal(badTargetRes.code, 'INVALID_TARGET')
  } finally {
    ws.cleanup()
  }
})
