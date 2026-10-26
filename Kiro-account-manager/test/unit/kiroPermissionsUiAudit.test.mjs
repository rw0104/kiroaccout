import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const existingTestsUrl = new URL('./kiroPermissionsUi.test.mjs', import.meta.url)
const requireFromApp = createRequire(new URL('../../package.json', import.meta.url))
// Reuse the existing real-component harness without executing its tests or
// duplicating production functions. All injected window APIs are synthetic.
let harnessSource = readFileSync(existingTestsUrl, 'utf8').split("test('A-B-A target switching")[0]
harnessSource = harnessSource.replaceAll('import.meta.url', JSON.stringify(existingTestsUrl.href))
harnessSource += '\nexports.auditHarness = { harness, deferred, makePermState, byId, button, text };\n'
const exports = {}
vm.runInNewContext(ts.transpileModule(harnessSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true
  }
}).outputText, { exports, require: requireFromApp, URL, console })
const { harness, deferred, makePermState, byId, button, text } = exports.auditHarness

function ancestorChain(node, targetId, chain = []) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = ancestorChain(child, targetId, chain)
      if (found) return found
    }
    return null
  }
  if (node.props?.id === targetId) return [...chain, node]
  return ancestorChain(node.props?.children, targetId, [...chain, node])
}

function effectivelyDisabled(tree, targetId) {
  const chain = ancestorChain(tree, targetId)
  assert.ok(chain, `Missing control ${targetId}`)
  return chain.some((node, index) =>
    node.props?.disabled && (index === chain.length - 1 || node.type === 'fieldset')
  )
}

for (const action of ['apply', 'restore']) {
  test(`${action} keeps the shared save lock through conflict refresh and cannot release a later save`, async () => {
    const refresh = deferred()
    const save = deferred()
    let permissionReads = 0
    let ordinarySaveCalls = 0
    const initialState = action === 'restore'
      ? makePermState({
          contentStatus: 'configured',
          presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
          restore: { status: 'available', canRestore: true }
        })
      : makePermState()
    const conflict = async () => ({
      success: false,
      code: 'REVISION_CONFLICT',
      error: 'Synthetic revision conflict'
    })
    const ctx = harness({
      getKiroPermissions: async () => ++permissionReads === 1
        ? { success: true, state: initialState }
        : refresh.promise,
      applyKiroAutoApproval: conflict,
      restoreKiroAutoApproval: conflict,
      saveKiroSettings: async () => { ordinarySaveCalls++; return save.promise }
    })
    let tree = await ctx.ready()
    byId(tree, 'kiro-memory').props.onChange('useOnly')
    tree = ctx.render()
    const pendingPermission = byId(tree, `kiro-permissions-${action}`).props.onClick()
    await ctx.flush()
    tree = ctx.render()
    assert.equal(permissionReads, 2)
    assert.equal(byId(tree, 'kiro-settings-target').props.disabled, true)
    assert.equal(button(tree, 'Saving...').props.disabled, true)
    await button(tree, 'Saving...').props.onClick()
    assert.equal(ordinarySaveCalls, 0)
    byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
    assert.equal(byId(ctx.render(), 'kiro-settings-target').props.value, 'default')

    refresh.resolve({ success: true, state: initialState })
    await pendingPermission
    await ctx.flush()
    tree = ctx.render()
    assert.equal(byId(tree, 'kiro-memory').props.value, 'useOnly')
    const pendingSave = button(tree, 'Save').props.onClick()
    tree = ctx.render()
    assert.equal(ordinarySaveCalls, 1)
    assert.equal(byId(tree, 'kiro-settings-target').props.disabled, true)
    assert.equal(button(tree, 'Saving...').props.disabled, true)
    await ctx.flush()
    assert.equal(byId(ctx.render(), 'kiro-settings-target').props.disabled, true)
    save.resolve({ success: true })
    await pendingSave
    await ctx.flush()
    assert.equal(byId(ctx.render(), 'kiro-settings-target').props.disabled, false)
  })
}

test('invalid ordinary settings do not disable independent permissions apply, restore or template export', async () => {
  for (const configured of [false, true]) {
    const ctx = harness({
      getKiroSettings: async () => ({ error: 'Synthetic invalid settings.json' }),
      getKiroPermissions: async () => ({
        success: true,
        state: configured
          ? makePermState({
              contentStatus: 'configured',
              presence: { allAllow: true, fsWriteAllow: true, missingRules: [] },
              restore: { status: 'available', canRestore: true }
            })
          : makePermState()
      })
    })
    const tree = await ctx.ready()
    assert.equal(effectivelyDisabled(tree, 'kiro-memory'), true)
    assert.equal(effectivelyDisabled(tree, 'kiro-permissions-export'), false)
    assert.equal(effectivelyDisabled(tree, configured ? 'kiro-permissions-restore' : 'kiro-permissions-apply'), false)
    await byId(tree, 'kiro-permissions-export').props.onClick()
    assert.equal(ctx.calls.exportPermissions, 1)
  }
})

test('an existing JSON policy displays its read-only reason and actual path while keeping export available', async () => {
  const reason = 'Existing permissions.json is read-only; its restrictions will be preserved.'
  const ctx = harness({
    getKiroPermissions: async () => ({
      success: true,
      state: makePermState({
        target: { permissionsPath: 'D:\\Synthetic\\.kiro\\settings\\permissions.json' },
        compatibility: { status: 'supported', writable: false, reason },
        restrictions: { denyCount: 1, hasRestrictiveRules: true }
      })
    })
  })
  let tree = await ctx.ready()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Read-only configuration')
  assert.equal(effectivelyDisabled(tree, 'kiro-permissions-apply'), true)
  assert.equal(effectivelyDisabled(tree, 'kiro-permissions-restore'), true)
  assert.equal(effectivelyDisabled(tree, 'kiro-permissions-export'), false)
  assert.ok(text(tree).includes(reason))
  byId(tree, 'kiro-permissions-details-toggle').props.onClick()
  tree = ctx.render()
  assert.match(text(byId(tree, 'kiro-permissions-details')), /permissions\.json/)
  assert.doesNotMatch(text(byId(tree, 'kiro-permissions-details')), /permissions\.yaml/)
  await byId(tree, 'kiro-permissions-export').props.onClick()
  assert.equal(ctx.calls.exportPermissions, 1)
})

test('permissions describe the IDE scope and CLI V3 file support accurately in both languages', () => {
  const sectionSource = readFileSync(new URL('../../src/renderer/src/components/kiro/KiroPermissionsSection.tsx', import.meta.url), 'utf8')
  const sectionExports = {}
  const jsxRuntime = {
    jsx: (type, props) => typeof type === 'function' ? type(props) : { type, props },
    jsxs: (type, props) => typeof type === 'function' ? type(props) : { type, props }
  }
  vm.runInNewContext(ts.transpileModule(sectionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, {
    exports: sectionExports,
    require(name) {
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === '../ui') return { Button: 'Button' }
      return {}
    }
  })
  for (const isEn of [false, true]) {
    const tree = sectionExports.KiroPermissionsSection({
      state: makePermState(),
      loading: false, busy: false, exporting: false, error: null, notice: null,
      isEn, detailsOpen: false,
      onToggleDetails() {}, onApply() {}, onRestore() {}, onExport() {}
    })
    const copy = text(tree)
    assert.doesNotMatch(copy, /V3 (?:does not read|不读取) permissions\.yaml/)
    assert.match(copy, isEn ? /CLI V3 supports permissions\.yaml/ : /CLI V3 支持 permissions\.yaml/)
    assert.match(copy, isEn ? /selected IDE/ : /所选 IDE/)
  }
})
