import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const model = {
  id: 'claude-haiku-5.5',
  name: 'Claude Haiku 5.5',
  description: 'Catalog description stays visible',
  rateMultiplier: 0.06,
  status: 'EXPERIMENTAL',
  modelProvider: 'Anthropic',
  maxInputTokens: 1000000,
  maxOutputTokens: 64000,
  supportsThinking: false,
  supportsPromptCaching: true
}

function harness(isEn, models = [model], privacyMode = false) {
  let stateIndex = 0
  const sources = new Map()
  const opened = []
  const jsx = (type, props) =>
    typeof type === 'function' && type.name === 'ModelPricing' ? type(props) : { type, props }
  const hooks = {
    useState(initial) {
      return [
        stateIndex++ === 0 ? models : typeof initial === 'function' ? initial() : initial,
        () => {}
      ]
    },
    useEffect() {}
  }
  function load(relativePath) {
    if (sources.has(relativePath)) return sources.get(relativePath)
    const source = readFileSync(
      new URL(`../../src/renderer/src/components/${relativePath}.tsx`, import.meta.url),
      'utf8'
    )
    const exports = {}
    vm.runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX
        }
      }).outputText,
      {
        exports,
        document: { body: {} },
        localStorage: { getItem: () => '1' },
        window: { api: { openExternal: (url) => opened.push(url) } },
        require(name) {
          if (name === 'react') return hooks
          if (name === 'react-dom') return { createPortal: (child) => child }
          if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
          if (name === '../ModelPricing') return load('ModelPricing')
          if (name.includes('shared/modelPricing'))
            return require('../../src/shared/modelPricing.ts')
          if (name.includes('shared/accountSearch'))
            return require('../../src/shared/accountSearch.ts')
          if (name === '@/store/accounts')
            return {
              useAccountsStore: () => ({
                maskEmail: () => 'synthetic@example.invalid',
                maskNickname: () => 'Synthetic nickname',
                privacyMode
              })
            }
          if (name === '@/hooks/useTranslation')
            return {
              useTranslation: () => ({
                t: (key) => (key === 'common.unknown' ? (isEn ? 'Unknown' : '未知') : key)
              })
            }
          if (name === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') }
          if (name === './_helpers') return { getSubscriptionColor: () => '' }
          return {}
        }
      }
    )
    sources.set(relativePath, exports)
    return exports
  }
  return {
    render(component) {
      stateIndex = 0
      const account = {
        id: 'synthetic-account',
        email: 'synthetic@example.invalid',
        nickname: 'Synthetic nickname',
        sourceAccountNames: ['synthetic-original-account'],
        idp: 'Github',
        status: 'active',
        subscription: { type: 'Free' },
        usage: { current: 0, limit: 10, percentUsed: 0 },
        credentials: { accessToken: 'SYNTHETIC_ACCESS', provider: 'Github', expiresAt: 1 }
      }
      const name = component.split('/').at(-1)
      return load(component)[name]({ open: true, onOpenChange() {}, isEn, account })
    },
    opened
  }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const match = find(child, predicate)
      if (match) return match
    }
    return undefined
  }
  if (predicate(tree)) return tree
  return find(tree.props?.children, predicate)
}

function renderedText(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (!tree || typeof tree !== 'object') return ''
  if (Array.isArray(tree)) return tree.map(renderedText).join('')
  return renderedText(tree.props?.children)
}

test('both actual model interfaces show the same complete tiers, provenance and live metadata', () => {
  for (const component of ['proxy/ModelsDialog', 'accounts/AccountDetailDialog']) {
    const app = harness(true)
    const tree = app.render(component)
    const text = renderedText(tree)
    for (const value of [
      '≤100K: 0.06x',
      '>100K: 0.3x',
      '2026-10-24',
      'Catalog description stays visible',
      'EXPERIMENTAL',
      'Anthropic',
      '1.0M'
    ]) {
      if (value === '1.0M' && component.includes('AccountDetail')) assert.match(text, /1M/)
      else assert.ok(text.includes(value), `${component}: ${value}`)
    }
    assert.ok(text.includes('Actual credit use is returned by Kiro.'))
    const source = find(
      tree,
      (node) => node.type === 'button' && node.props?.children === 'Official pricing'
    )
    assert.ok(source)
    source.props.onClick()
    assert.deepEqual(app.opened, ['https://kiro.dev/changelog/models/claude-haiku-5-5/'])
    if (component.includes('AccountDetail')) assert.ok(text.includes('synthetic-original-account'))
  }
})

test('Chinese prices explain billing boundaries and catalog mismatch never retains stale numbers', () => {
  const app = harness(false, [{ ...model, rateMultiplier: 0.08 }])
  for (const component of ['proxy/ModelsDialog', 'accounts/AccountDetailDialog']) {
    const text = renderedText(app.render(component))
    assert.ok(text.includes('0.08x'))
    assert.equal(text.includes('0.06x'), false)
    assert.equal(text.includes('0.3x'), false)
    assert.ok(text.includes('目录倍率与已核对规则不同'))
    assert.ok(text.includes('实际消耗以 Kiro 返回为准。'))
  }
  const hidden = JSON.stringify(harness(true, [model], true).render('accounts/AccountDetailDialog'))
  assert.equal(hidden.includes('synthetic-original-account'), false)
})

test('both actual interfaces prefer the current Luna rate over superseded documented tiers', () => {
  const luna = { ...model, id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', rateMultiplier: 0.6 }
  const app = harness(true, [luna])
  for (const component of ['proxy/ModelsDialog', 'accounts/AccountDetailDialog']) {
    const text = renderedText(app.render(component))
    assert.ok(text.includes('0.6x'))
    assert.equal(text.includes('1.1x'), false)
    assert.equal(text.includes('2.2x'), false)
    assert.ok(text.includes('The catalog rate differs from the verified tiers.'))
    assert.ok(text.includes('Actual credit use is returned by Kiro.'))
  }
})
