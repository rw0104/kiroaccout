import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function deferred() {
  let resolve, reject
  return { promise: new Promise((res, rej) => { resolve = res; reject = rej }), resolve, reject }
}

const clean = value => JSON.parse(JSON.stringify(value))

function makePermState(overrides = {}) {
  return {
    target: {
      type: 'default',
      label: 'Default Kiro IDE',
      permissionsPath: 'D:\\Users\\Test\\.kiro\\settings\\permissions.yaml',
      ...(overrides.target ?? {})
    },
    compatibility: {
      status: 'supported',
      ideVersion: '1.4.26',
      writable: true,
      reason: 'Kiro IDE 1.x',
      ...(overrides.compatibility ?? {})
    },
    contentStatus: overrides.contentStatus ?? 'unconfigured',
    revision: {
      exists: false,
      sha256: null,
      ...(overrides.revision ?? {})
    },
    presence: {
      allAllow: false,
      fsWriteAllow: false,
      missingRules: ['all', 'fs_write'],
      ...(overrides.presence ?? {})
    },
    restrictions: {
      askCount: 0,
      denyCount: 0,
      evaluateCount: 0,
      scopedAllowCount: 0,
      unknownRuleCount: 0,
      hasPolicyReferences: false,
      hasRestrictiveRules: false,
      ...(overrides.restrictions ?? {})
    },
    restore: {
      status: 'none',
      canRestore: false,
      ...(overrides.restore ?? {})
    },
    ...(overrides.parseError ? { parseError: overrides.parseError } : {})
  }
}

function harness(overrides = {}) {
  const states = [], refs = [], dependencies = [], effects = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0
  const calls = {
    getSettings: [],
    saveSettings: [],
    getPermissions: [],
    applyPermissions: [],
    restorePermissions: [],
    exportPermissions: 0
  }

  const api = {
    kiroInstances: {
      snapshot: async () => ({
        success: true,
        value: {
          instances: [
            {
              schemaVersion: 2,
              id: 'synthetic-instance',
              label: 'Synthetic managed IDE',
              running: false,
              accountId: 'a1'
            }
          ]
        }
      })
    },
    getKiroSettings: async target => {
      calls.getSettings.push(clean(target))
      return { settings: {} }
    },
    getKiroAvailableModels: async () => ({ models: [{ id: 'auto', name: 'Auto', description: '' }] }),
    saveKiroSettings: async (patch, target) => {
      calls.saveSettings.push({ patch: clean(patch), target: clean(target) })
      return { success: true }
    },
    openKiroSettingsFile: async () => ({ success: true }),
    getKiroPermissions: async target => {
      calls.getPermissions.push(clean(target))
      return { success: true, state: makePermState({ target: target?.type === 'instance' ? { type: 'instance', instanceId: target.instanceId, label: 'Synthetic managed IDE', permissionsPath: 'D:\\Instances\\A\\.kiro\\settings\\permissions.yaml' } : undefined }) }
    },
    applyKiroAutoApproval: async (target, revision) => {
      calls.applyPermissions.push({ target: clean(target), revision: clean(revision) })
      return {
        success: true,
        changed: true,
        addedRules: ['all', 'fs_write'],
        state: makePermState({
          contentStatus: 'configured',
          revision: { exists: true, sha256: 'a'.repeat(64) },
          presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
          restore: {
            status: 'available',
            canRestore: true,
            addedRules: ['all', 'fs_write'],
            backupDir: 'D:\\Backups\\default\\op-1'
          }
        })
      }
    },
    restoreKiroAutoApproval: async (target, revision) => {
      calls.restorePermissions.push({ target: clean(target), revision: clean(revision) })
      return {
        success: true,
        restored: true,
        state: makePermState({
          contentStatus: 'unconfigured',
          revision: { exists: false, sha256: null },
          presence: { allAllow: false, fsWriteAllow: false, missingRules: ['all', 'fs_write'] },
          restore: { status: 'none', canRestore: false }
        })
      }
    },
    exportKiroAutoApprovalTemplate: async () => {
      calls.exportPermissions++
      return { success: true }
    },
    openExternal() {},
    ...overrides
  }

  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], update => { states[index] = typeof update === 'function' ? update(states[index]) : update }]
    },
    useRef(initial) {
      return (refs[refIndex++] ??= { current: initial })
    },
    useEffect(run, deps) {
      const index = effectIndex++
      if (!dependencies[index] || deps?.some((value, i) => value !== dependencies[index][i])) {
        dependencies[index] = deps
        effects.push(run)
      }
    }
  }

  const jsxRuntime = {
    jsx: (type, props) => (typeof type === 'function' ? type(props) : { type, props }),
    jsxs: (type, props) => (typeof type === 'function' ? type(props) : { type, props })
  }

  const sectionExports = {}
  const sectionSource = readFileSync(
    new URL('../../src/renderer/src/components/kiro/KiroPermissionsSection.tsx', import.meta.url),
    'utf8'
  )
  const sectionCompiled = ts.transpileModule(sectionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  vm.runInNewContext(sectionCompiled, {
    exports: sectionExports,
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === '../ui') return Object.fromEntries(['Card', 'CardContent', 'CardHeader', 'CardTitle', 'Button', 'Toggle', 'Select'].map(type => [type, type]))
      return {}
    }
  })

  const pageExports = {}
  const pageSource = readFileSync(
    new URL('../../src/renderer/src/components/pages/KiroSettingsPage.tsx', import.meta.url),
    'utf8'
  )
  const pageCompiled = ts.transpileModule(pageSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  vm.runInNewContext(pageCompiled, {
    exports: pageExports,
    window: { api },
    confirm: () => true,
    console: { error() {} },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === '../ui') return Object.fromEntries(['Card', 'CardContent', 'CardHeader', 'CardTitle', 'Button', 'Toggle', 'Select'].map(type => [type, type]))
      if (name === '../kiro') {
        return {
          SteeringEditor: 'SteeringEditor',
          McpServerEditor: 'McpServerEditor',
          KiroPermissionsSection: sectionExports.KiroPermissionsSection
        }
      }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: key => (key === 'common.unknown' ? 'Unknown' : key) }) }
      return {}
    }
  })

  return {
    calls,
    api,
    render() {
      stateIndex = 0
      refIndex = 0
      effectIndex = 0
      return pageExports.KiroSettingsPage()
    },
    async flush() {
      for (const effect of effects.splice(0)) effect()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    },
    async ready() {
      this.render()
      await this.flush()
      return this.render()
    }
  }
}

function nodes(tree, predicate) {
  const matches = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (predicate(value)) matches.push(value)
    visit(value.props?.children)
  }
  visit(tree)
  return matches
}

const byId = (tree, id) => nodes(tree, node => node.props?.id === id)[0]
const text = tree =>
  typeof tree === 'string'
    ? tree
    : Array.isArray(tree)
      ? tree.map(text).join(' ')
      : tree && typeof tree === 'object'
        ? text(tree.props?.children)
        : ''
const button = (tree, label) => nodes(tree, node => node.type === 'Button' && text(node).trim() === label)[0]

test('A-B-A target switching ignores stale permissions responses from earlier target visits', async () => {
  const permRequests = []
  const ctx = harness({
    getKiroPermissions: target => {
      const pending = deferred()
      permRequests.push({ target: clean(target), pending })
      return pending.promise
    }
  })

  await ctx.ready()
  for (const value of ['instance:synthetic-instance', 'default']) {
    byId(ctx.render(), 'kiro-settings-target').props.onChange({ target: { value } })
    ctx.render()
    await ctx.flush()
  }

  assert.equal(permRequests.length, 3)

  // Resolve latest default visit (request 2) as configured
  permRequests[2].pending.resolve({
    success: true,
    state: makePermState({
      contentStatus: 'configured',
      presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
      restore: { status: 'available', canRestore: true }
    })
  })
  await ctx.flush()

  // Resolve stale first default visit (request 0) and stale instance visit (request 1) as invalid
  permRequests[0].pending.resolve({
    success: true,
    state: makePermState({ contentStatus: 'invalid', parseError: 'Stale error 0' })
  })
  permRequests[1].pending.resolve({
    success: true,
    state: makePermState({ contentStatus: 'invalid', parseError: 'Stale error 1' })
  })
  await ctx.flush()

  const tree = ctx.render()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Both rules present')
  assert.equal(text(byId(tree, 'kiro-permissions-restore-status')), 'Restore available')
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, false)
})

test('apply and restore lock target switching and ordinary Save while preserving unsaved ordinary settings', async () => {
  const applyPending = deferred()
  const ctx = harness({
    applyKiroAutoApproval: (target, revision) => {
      ctx.calls.applyPermissions.push({ target: clean(target), revision: clean(revision) })
      return applyPending.promise
    }
  })

  let tree = await ctx.ready()
  // Edit an ordinary Kiro setting without saving it
  byId(tree, 'kiro-memory').props.onChange('useOnly')
  tree = ctx.render()
  assert.equal(button(tree, 'Save').props.disabled, false)
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, false)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, true)

  // Click Apply auto-approval
  const pendingWrite = byId(tree, 'kiro-permissions-apply').props.onClick()
  tree = ctx.render()

  // During apply, target selector and ordinary Save button are locked
  assert.equal(byId(tree, 'kiro-settings-target').props.disabled, true)
  assert.equal(button(tree, 'Saving...').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)

  // Attempt to switch target while saving is ignored
  byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  assert.equal(byId(ctx.render(), 'kiro-settings-target').props.value, 'default')

  // Complete apply
  applyPending.resolve({
    success: true,
    changed: true,
    addedRules: ['all', 'fs_write'],
    state: makePermState({
      contentStatus: 'configured',
      revision: { exists: true, sha256: 'b'.repeat(64) },
      presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
      restore: { status: 'available', canRestore: true }
    })
  })
  await pendingWrite
  await ctx.flush()

  tree = ctx.render()
  // Ordinary unsaved setting is still preserved and Save is re-enabled!
  assert.equal(byId(tree, 'kiro-memory').props.value, 'useOnly')
  assert.equal(button(tree, 'Save').props.disabled, false)
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, false)
  assert.match(text(byId(tree, 'kiro-permissions-notice')), /Start a new Kiro session to verify/)
})

test('permissions section renders manual config, restrictive rules, invalid YAML, unverified compatibility and details drawer accurately', async () => {
  let currentState = makePermState({
    contentStatus: 'configured',
    presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
    restrictions: {
      askCount: 2,
      denyCount: 1,
      evaluateCount: 0,
      scopedAllowCount: 3,
      unknownRuleCount: 1,
      hasPolicyReferences: false,
      hasRestrictiveRules: true
    },
    restore: {
      status: 'none',
      canRestore: false,
      addedRules: ['fs_write'],
      backupDir: 'D:\\Backups\\default\\op-2'
    }
  })

  const ctx = harness({
    getKiroPermissions: async () => ({ success: true, state: currentState })
  })

  let tree = await ctx.ready()
  // Configured with restrictions + manual config (no restore snapshot)
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Both rules present, with restrictions')
  assert.equal(text(byId(tree, 'kiro-permissions-restore-status')), 'No restore snapshot')
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, true)
  assert.match(text(byId(tree, 'kiro-permissions-restrictions-warning')), /deny: 1, ask: 2, conditional allow: 3/)
  assert.ok(byId(tree, 'kiro-permissions-unknown-rules-note'))

  // Toggle details drawer
  byId(tree, 'kiro-permissions-details-toggle').props.onClick()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-permissions-details-toggle').props['aria-expanded'], true)
  assert.match(text(byId(tree, 'kiro-permissions-details')), /D:\\Users\\Test\\\.kiro\\settings\\permissions\.yaml/)
  assert.match(text(byId(tree, 'kiro-permissions-details')), /D:\\Backups\\default\\op-2/)

  // Unverified compatibility disables apply & restore but keeps export enabled
  currentState = makePermState({
    compatibility: {
      status: 'unverified',
      writable: false,
      reason: 'Could not verify Kiro IDE 1.x installation'
    }
  })
  await button(tree, 'Refresh').props.onClick()
  await ctx.flush()
  tree = ctx.render()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Compatibility unverified')
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-export').props.disabled, false)

  await byId(tree, 'kiro-permissions-export').props.onClick()
  assert.equal(ctx.calls.exportPermissions, 1)
})
