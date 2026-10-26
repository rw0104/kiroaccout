import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const existingTestsUrl = new URL('./kiroPermissionsUi.test.mjs', import.meta.url)
const requireFromApp = createRequire(new URL('../../package.json', import.meta.url))
let harnessSource = readFileSync(existingTestsUrl, 'utf8').split("test('A-B-A target switching")[0]
harnessSource = harnessSource.replaceAll('import.meta.url', JSON.stringify(existingTestsUrl.href))
harnessSource += '\nexports.loadStateHarness = { harness, deferred, makePermState, byId, button, text };\n'
const exports = {}
vm.runInNewContext(ts.transpileModule(harnessSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true
  }
}).outputText, { exports, require: requireFromApp, URL, console })
const { harness, deferred, makePermState, byId, button, text } = exports.loadStateHarness

test('a completed permissions read failure ends its loading display and can retry the selected target', async () => {
  const retry = deferred()
  const targets = []
  const ctx = harness({ getKiroPermissions: async target => {
    targets.push(JSON.parse(JSON.stringify(target)))
    return targets.length === 1
      ? { success: false, code: 'INVALID_TARGET', error: 'Synthetic directory unavailable' }
      : retry.promise
  } })
  let tree = await ctx.ready()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Unable to load')
  assert.doesNotMatch(text(byId(tree, 'kiro-permissions-section')), /Loading\.\.\.|Inspecting selected/)
  assert.match(text(byId(tree, 'kiro-permissions-error')), /Synthetic directory unavailable/)
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-restore').props.disabled, true)
  assert.equal(byId(tree, 'kiro-permissions-export').props.disabled, false)
  const pending = byId(tree, 'kiro-permissions-retry').props.onClick()
  tree = ctx.render()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Loading...')
  assert.deepEqual(targets, [{ type: 'default' }, { type: 'default' }])
  retry.resolve({ success: true, state: makePermState() })
  await pending
  await ctx.flush()
  tree = ctx.render()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Unconfigured')
  assert.equal(byId(tree, 'kiro-permissions-error'), undefined)
  assert.equal(byId(tree, 'kiro-permissions-apply').props.disabled, false)
})

test('permissions retry respects the ordinary save lock and ignores responses for an earlier target', async () => {
  const save = deferred()
  const retry = deferred()
  let reads = 0
  const ctx = harness({
    getKiroPermissions: async target => {
      reads++
      if (reads === 1) return { success: false, error: 'Synthetic read failed' }
      if (reads === 2) return retry.promise
      return { success: true, state: makePermState({ target: { type: 'instance', instanceId: target.instanceId, label: 'New target' } }) }
    },
    saveKiroSettings: async () => save.promise
  })
  let tree = await ctx.ready()
  byId(tree, 'kiro-memory').props.onChange('useOnly')
  tree = ctx.render()
  const pendingSave = button(tree, 'Save').props.onClick()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-permissions-retry').props.disabled, true)
  await byId(tree, 'kiro-permissions-retry').props.onClick()
  assert.equal(reads, 1)
  save.resolve({ success: true })
  await pendingSave
  await ctx.flush()
  tree = ctx.render()
  const pendingRetry = byId(tree, 'kiro-permissions-retry').props.onClick()
  tree = ctx.render()
  byId(tree, 'kiro-settings-target').props.onChange({ target: { value: 'instance:synthetic-instance' } })
  ctx.render()
  await ctx.flush()
  tree = ctx.render()
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Unconfigured')
  retry.resolve({ success: false, error: 'Stale failure' })
  await pendingRetry
  await ctx.flush()
  tree = ctx.render()
  assert.equal(byId(tree, 'kiro-permissions-error'), undefined)
  assert.equal(text(byId(tree, 'kiro-permissions-content-status')), 'Unconfigured')
})
