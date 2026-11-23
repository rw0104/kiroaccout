import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const nestedProfile = 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/SYNTHETIC_A'
const selectedProfile = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/SYNTHETIC_B'
const account = () => ({
  id: 'synthetic-enterprise', idp: 'Enterprise', status: 'active',
  subscription: { type: 'Enterprise' }, usage: { current: 0, limit: 10, percentUsed: 0 },
  credentials: { accessToken: 'SYNTHETIC_ACCESS', provider: 'Enterprise', authMethod: 'IdC',
    region: 'eu-central-1', profileArn: nestedProfile }
})

// Run the actual component and its effect, with the IPC boundary replaced by a
// pending synthetic catalog. No account storage, service or browser is accessed.
function harness() {
  const states = [], dependencies = [], effects = [], cleanups = [], requests = []
  let stateIndex = 0, effectIndex = 0
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = value }]
    },
    useEffect(run, deps) {
      const index = effectIndex++
      if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) {
        dependencies[index] = deps
        effects.push(() => { cleanups[index]?.(); cleanups[index] = run() })
      }
    }
  }
  const exports = {}
  const source = readFileSync(new URL('../../src/renderer/src/components/accounts/AccountDetailDialog.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  vm.runInNewContext(compiled, {
    exports, document: { body: {} },
    window: { api: { accountGetModels(...args) {
      return new Promise(resolve => { requests.push({ args, resolve }) })
    } } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react-dom') return { createPortal: child => child }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === '@/store/accounts') return { useAccountsStore: () => ({ maskEmail: value => value, maskNickname: value => value, privacyMode: false }) }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: key => key === 'common.unknown' ? 'Unknown' : key }) }
      if (name.includes('shared/accountSearch')) return require('../../src/shared/accountSearch.ts')
      if (name === '@/lib/utils') return { cn: () => '' }
      if (name === './_helpers') return { getSubscriptionColor: () => '' }
      return {}
    }
  })
  return {
    requests,
    render(value) {
      stateIndex = 0; effectIndex = 0
      return exports.AccountDetailDialog({ open: true, account: value, onOpenChange() {} })
    },
    async flush() {
      for (const effect of effects.splice(0)) effect()
      for (let i = 0; i < 6; i++) await Promise.resolve()
    }
  }
}

test('account details forward the authenticated profile stored by an enterprise login', async () => {
  const ctx = harness(), row = account()
  ctx.render(row); await ctx.flush()
  assert.equal(ctx.requests.length, 1)
  assert.deepEqual(ctx.requests[0].args, ['SYNTHETIC_ACCESS', 'eu-central-1', nestedProfile, undefined, 'Enterprise', 'IdC', row.id])
})

test('an explicit account profile retains precedence over the credential fallback', async () => {
  const ctx = harness()
  ctx.render({ ...account(), profileArn: selectedProfile }); await ctx.flush()
  assert.equal(ctx.requests[0].args[2], selectedProfile)
})

test('changing the credential profile reloads its catalog and ignores the previous response', async () => {
  const ctx = harness(), initial = account()
  ctx.render(initial); await ctx.flush()
  const changed = { ...initial, credentials: { ...initial.credentials, profileArn: selectedProfile } }
  ctx.render(changed); await ctx.flush()
  assert.equal(ctx.requests.length, 2, 'a new credential profile starts a new request')
  assert.equal(ctx.requests[1].args[2], selectedProfile)
  ctx.requests[1].resolve({ success: true, models: [{ id: 'synthetic-current-catalog' }] })
  await ctx.flush()
  ctx.requests[0].resolve({ success: true, models: [{ id: 'synthetic-obsolete-catalog' }] })
  await ctx.flush()
  const rendered = JSON.stringify(ctx.render(changed))
  assert.match(rendered, /synthetic-current-catalog/)
  assert.doesNotMatch(rendered, /synthetic-obsolete-catalog/)
})
