import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
const parse = path => ts.createSourceFile(path, readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const find = (tree, predicate) => {
  let result
  const visit = node => { if (predicate(node)) result = node.getText(tree); ts.forEachChild(node, visit) }
  visit(tree)
  assert.ok(result)
  return result
}
const app = parse('renderer/src/App.tsx')
const preload = parse('preload/index.ts')
const registration = find(app, node => ts.isCallExpression(node) && node.expression.getText(app) === 'window.api.onKiroInstanceAccountUpdate')
const listener = find(preload, node => ts.isPropertyAssignment(node) && node.name?.getText(preload) === 'onKiroInstanceAccountUpdate')
const code = ts.transpileModule(`window.api = {${listener}}; ${registration}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const oldProfile = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/SYNTHETIC_OLD'
const newProfile = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/SYNTHETIC_NEW'
function harness() {
  const account = { id: 'synthetic', profileArn: oldProfile, credentials: { profileArn: oldProfile, accessToken: 'SYNTHETIC_OLD_ACCESS' } }
  const accounts = new Map([[account.id, account]])
  let handler
  vm.runInNewContext(code, {
    window: {},
    ipcRenderer: { on(channel, callback) { assert.equal(channel, 'kiro-instance-account-update'); handler = callback } },
    useAccountsStore: { getState: () => ({ accounts }) },
    updateAccount: (id, update) => accounts.set(id, { ...accounts.get(id), ...update })
  })
  return { receive: info => handler(undefined, { id: 'synthetic', ...info }), current: () => accounts.get('synthetic'), accounts }
}

test('actual instance-account event updates both profile copies through preload and the App callback', () => {
  for (const info of [
    { profileArn: ` ${newProfile} `, credentials: { accessToken: 'SYNTHETIC_NEW_ACCESS', profileArn: ` ${newProfile} ` } },
    { credentials: { accessToken: 'SYNTHETIC_NEW_ACCESS', profileArn: newProfile } },
    { profileArn: newProfile, credentials: { accessToken: 'SYNTHETIC_NEW_ACCESS' } }
  ]) {
    const ctx = harness()
    ctx.receive(info)
    assert.equal(ctx.current().profileArn, newProfile)
    assert.equal(ctx.current().credentials.profileArn, newProfile)
    assert.equal(ctx.current().credentials.accessToken, 'SYNTHETIC_NEW_ACCESS')
  }
})

test('instance-account events without usable profile metadata preserve saved identity', () => {
  for (const profileArn of [undefined, '', '  ', null, 123, {}]) {
    const ctx = harness()
    ctx.receive({ profileArn, credentials: { accessToken: 'SYNTHETIC_NEW_ACCESS', profileArn } })
    assert.equal(ctx.current().profileArn, oldProfile)
    assert.equal(ctx.current().credentials.profileArn, oldProfile)
    assert.equal(ctx.current().credentials.accessToken, 'SYNTHETIC_NEW_ACCESS')
  }
})

test('explicit profile conflicts remain visible and removed accounts are never recreated by an event', () => {
  const ctx = harness()
  ctx.receive({ profileArn: oldProfile, credentials: { profileArn: newProfile } })
  assert.equal(ctx.current().profileArn, oldProfile)
  assert.equal(ctx.current().credentials.profileArn, newProfile)
  ctx.accounts.clear()
  ctx.receive({ profileArn: newProfile, credentials: { profileArn: newProfile } })
  assert.equal(ctx.current(), undefined)
})
