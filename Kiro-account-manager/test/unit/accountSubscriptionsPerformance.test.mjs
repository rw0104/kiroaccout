import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { shallow } from 'zustand/shallow'

const ts = createRequire(import.meta.url)('typescript')
function selector(file) {
  const source = readFileSync(new URL(`../../src/renderer/src/${file}`, import.meta.url), 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let selection
  function visit(node) {
    if (selection === undefined && ts.isCallExpression(node) && node.expression.getText(tree) === 'useAccountsStore') {
      const argument = node.arguments[0]
      selection = argument ? (ts.isCallExpression(argument) ? argument.arguments[0] : argument).getText(tree) : 'state => state'
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(selection)
  const code = ts.transpileModule(`const select = ${selection};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return vm.runInNewContext(`${code}\nselect`, { account: { id: 'visible' } })
}

test('account UI subscriptions ignore unrelated save progress and other-account operation bursts', () => {
  const files = ['App.tsx', 'components/accounts/AccountManager.tsx', 'components/accounts/AccountGrid.tsx',
    'components/accounts/AccountList.tsx', 'components/accounts/AccountCard.tsx', 'components/accounts/AccountListRow.tsx']
  const empty = [], accounts = new Map(), counts = new Map()
  const state = { accounts, groups: new Map(), tags: new Map(), selectedIds: new Set(), accountOperationCounts: counts,
    accountProxyBindings: {}, proxyPool: new Map(), getFilteredAccounts: () => empty, privacyMode: false }
  for (const file of files) {
    const select = selector(file), first = select(state)
    for (let i = 0; i < 100; i++) {
      const next = { ...state, isSyncing: !!(i % 2), accountOperationCounts: new Map([['unrelated', i + 1]]) }
      assert.equal(shallow(first, select(next)), true, `${file} must not invalidate on unrelated persistence/progress`)
    }
  }
})

test('account row subscriptions retain privacy and their own operation feedback', () => {
  const state = { accountOperationCounts: new Map(), accountProxyBindings: {}, proxyPool: new Map(), privacyMode: false }
  for (const file of ['AccountCard.tsx', 'AccountListRow.tsx']) {
    const select = selector(`components/accounts/${file}`), first = select(state)
    assert.equal(shallow(first, select({ ...state, privacyMode: true })), false)
    assert.equal(shallow(first, select({ ...state, accountOperationCounts: new Map([['visible', 1]]) })), false)
  }
})
