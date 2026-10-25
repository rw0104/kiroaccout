import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// Render the real component tree with hooks and storage mocked. Effects are
// explicit, so account detail rendering never calls the account API.
function componentHarness(component, account, privacyMode = false) {
  const states = [], refs = [], effects = [], updates = []
  let stateIndex = 0, refIndex = 0, verificationCalls = 0, closed = false
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = value }]
    },
    useRef(initial) {
      const index = refIndex++
      return (refs[index] ??= { current: initial })
    },
    useEffect(run) { effects.push(run) }
  }
  const store = {
    privacyMode,
    maskEmail: email => privacyMode ? '********' : email,
    maskNickname: nickname => privacyMode ? '********' : nickname,
    updateAccount(id, update) { updates.push({ id, update }) }
  }
  const exports = {}
  const source = readFileSync(new URL(`../../src/renderer/src/components/accounts/${component}.tsx`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  vm.runInNewContext(compiled, {
    exports,
    document: { body: {} },
    window: { api: { verifyAccountCredentials() { verificationCalls++; throw new Error('Unexpected verification') } } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react-dom') return { createPortal: child => child }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === '@/store' || name === '@/store/accounts') return { useAccountsStore: () => store }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: key => key === 'common.unknown' ? 'Unknown' : key }) }
      if (name.includes('shared/accountSearch')) return require('../../src/shared/accountSearch.ts')
      if (name === '@/lib/utils') return { cn: () => '' }
      if (name === './_helpers') return { getSubscriptionColor: () => '' }
      return {}
    }
  })
  return {
    render() {
      stateIndex = 0
      refIndex = 0
      return exports[component]({ open: true, account, onOpenChange: value => { closed = !value } })
    },
    runEffects() { for (const effect of effects.splice(0)) effect() },
    updates,
    get verificationCalls() { return verificationCalls },
    get closed() { return closed }
  }
}

function findNode(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (predicate(tree)) return tree
  return findNode(tree.props?.children, predicate)
}

const account = () => ({
  id: 'synthetic-expired-account',
  email: 'verified@example.invalid',
  nickname: 'Existing nickname',
  sourceAccountNames: ['synthetic-source-account'],
  idp: 'Github',
  status: 'expired',
  credentials: { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', provider: 'Github', authMethod: 'social', expiresAt: 1 },
  subscription: { type: 'Free' },
  usage: { current: 0, limit: 10, percentUsed: 0 }
})

test('editing original account names preserves expired credentials and status without verification', () => {
  const original = account()
  const snapshot = JSON.stringify(original)
  const harness = componentHarness('EditAccountDialog', original)
  harness.render()
  harness.runEffects()
  const editor = findNode(harness.render(), node => node.type === 'textarea' && node.props.id === 'source-account-names')
  assert.ok(editor, 'original account metadata is editable')
  assert.equal(editor.props.value, 'synthetic-source-account')
  editor.props.onChange({ target: { value: '  synthetic-source-account  \nSYNTHETIC-SOURCE-ACCOUNT\n second-source \n\n' } })
  const save = findNode(harness.render(), node => node.props?.children === 'Save Changes')
  assert.ok(save)
  save.props.onClick()
  assert.equal(harness.updates.length, 1)
  const { id, update } = harness.updates[0]
  assert.equal(id, original.id)
  assert.deepEqual(JSON.parse(JSON.stringify(update)), {
    nickname: 'Existing nickname', sourceAccountNames: ['synthetic-source-account', 'second-source']
  })
  assert.equal(harness.verificationCalls, 0)
  assert.equal(JSON.stringify(original), snapshot)
  assert.equal(harness.closed, true)
})

test('original account details are visible normally and fully masked in privacy mode', () => {
  const original = account()
  const visible = JSON.stringify(componentHarness('AccountDetailDialog', original).render())
  assert.ok(visible.includes('synthetic-source-account'), 'original account appears in the detail view')
  const masked = JSON.stringify(componentHarness('AccountDetailDialog', original, true).render())
  assert.equal(masked.includes('synthetic-source-account'), false, 'privacy mode hides the original account in all rendered properties')
})
