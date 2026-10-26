import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { normalizeTimestamp, normalizeCredentialRecord } from '../../src/shared/accountImport.ts'
import { parseAccountUsage } from '../../src/shared/accountUsage.ts'
import {
  normalizeSubscriptionType,
  normalizeAccountSubscription
} from '../../src/shared/accountSubscription.ts'
import { mergeSourceAccountNames } from '../../src/shared/accountSearch.ts'
import { resolveOidcRegistrationExpiry } from '../../src/shared/oidcRegistration.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const now = Date.parse('2030-01-01T00:00:00Z')
const expiry = 4_000_000_000
const Clock = class extends Date {
  static now() {
    return now
  }
}
const source = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8')
const tree = (name) => ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true)
const main = tree('main/index.ts')
const compile = (code) =>
  ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
function find(ast, predicate) {
  let found
  const visit = (node) => {
    if (predicate(node)) found = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found)
  return found.getText(ast)
}
const fn = (ast, name) =>
  find(ast, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).replace(
    /^export /,
    ''
  )
function handler(name) {
  let found
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments[0]?.text === name)
      found = node.arguments[1].getText(main)
    ts.forEachChild(node, visit)
  }
  visit(main)
  assert.ok(found)
  return found
}
const usage = {
  usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsage: 2 }],
  userInfo: { email: 'synthetic@example.invalid', userId: 'synthetic-user' },
  subscriptionInfo: { subscriptionTitle: 'KIRO FREE' }
}
const verified = (input) => ({
  success: true,
  data: {
    email: 'synthetic@example.invalid',
    userId: 'synthetic-user',
    accessToken: 'SYNTHETIC_ACCESS',
    refreshToken: 'SYNTHETIC_REFRESH',
    expiresIn: 3600,
    clientSecretExpiresAt: input.clientSecretExpiresAt,
    subscriptionType: 'Free',
    subscriptionTitle: 'KIRO FREE',
    usage: { current: 2, limit: 50 }
  }
})

function mainHarness(registrationExpiry = expiry) {
  const calls = []
  const refreshes = []
  const context = vm.createContext({
    Date: Clock,
    normalizeTimestamp,
    normalizeCredentialRecord,
    normalizeSubscriptionType,
    parseAccountUsage,
    CLIENT_REGISTRATION_EXPIRY_BUFFER_MS: 900000,
    resolveOidcRegistrationExpiry,
    console: { log() {}, error() {} },
    setTimeout(run) {
      queueMicrotask(run)
      return 1
    },
    getUserInfo: async () => ({ email: 'synthetic@example.invalid', userId: 'synthetic-user' }),
    getUsageAndLimits: async () => usage,
    refreshTokenByMethod: async (...args) => {
      refreshes.push(args)
      return {
        success: true,
        accessToken: 'SYNTHETIC_ACCESS',
        refreshToken: 'SYNTHETIC_REFRESH',
        expiresIn: 3600
      }
    },
    fetchWithAppProxy: async (url) => {
      calls.push(url)
      if (url.endsWith('/client/register'))
        return Response.json({
          clientId: 'SYNTHETIC_CLIENT',
          clientSecret: 'SYNTHETIC_SECRET',
          clientSecretExpiresAt: registrationExpiry
        })
      if (url.endsWith('/device_authorization'))
        return Response.json({
          deviceCode: 'SYNTHETIC_DEVICE',
          userCode: 'SYNTHETIC_USER_CODE',
          interval: 1
        })
      if (url.endsWith('/session/device'))
        return Response.json({ token: 'SYNTHETIC_DEVICE_SESSION' })
      if (url.endsWith('/accept_user_code'))
        return Response.json({ deviceContext: { deviceContextId: 'SYNTHETIC_CONTEXT' } })
      if (url.endsWith('/token'))
        return Response.json({
          accessToken: 'SYNTHETIC_ACCESS',
          refreshToken: 'SYNTHETIC_REFRESH',
          expiresIn: 3600
        })
      return Response.json({})
    }
  })
  vm.runInContext(
    compile(
      `${fn(tree('main/kiroAuthSync.ts'), 'validateKiroClientRegistration')}\n${fn(main, 'ssoDeviceAuth')}\nglobalThis.sso = ${handler('import-from-sso-token')};\nglobalThis.verify = ${handler('verify-account-credentials')};`
    ),
    context
  )
  return {
    calls,
    refreshes,
    sso: (...args) => context.sso(undefined, ...args),
    verify: (input) => context.verify(undefined, input)
  }
}

function preloadMethod(name, invoke) {
  const ast = tree('preload/index.ts')
  const property = find(
    ast,
    (node) => ts.isPropertyAssignment(node) && node.name?.getText(ast) === name
  )
  const context = vm.createContext({ ipcRenderer: { invoke } })
  vm.runInContext(compile(`globalThis.api = {${property}}`), context)
  return context.api[name]
}

// Real component handlers with rerenderable hooks; no browser, Electron or storage.
function dialogHarness(component, api, account) {
  const file = `renderer/src/components/accounts/${component}.tsx`
  const ast = tree(file)
  const stateNames = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(ast) === 'useState'
    )
      stateNames.push(node.name.elements[0].getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const states = [],
    refs = [],
    effects = [],
    added = [],
    updated = []
  let stateIndex = 0,
    refIndex = 0
  const store = {
    accounts: new Map(),
    groups: new Map(),
    activeGroupTab: 'all',
    batchImportConcurrency: 1,
    loginPrivateMode: false,
    addAccount(row) {
      added.push(row)
    },
    updateAccount(id, row) {
      updated.push({ id, ...row })
    },
    importAccountPlan() {},
    saveAccountChanges: async () => {}
  }
  const useStore = Object.assign(() => store, { getState: () => store })
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [
        states[index],
        (value) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value
        }
      ]
    },
    useRef(initial) {
      const index = refIndex++
      return (refs[index] ??= { current: initial })
    },
    useMemo(create) {
      return create()
    },
    useEffect(run) {
      effects.push(run)
    }
  }
  const returnHandlers =
    component === 'AddAccountDialog'
      ? 'return { handleSsoImport, handleImportFromLocal, handleOidcAdd };\n  if (!isOpen) return null'
      : 'return { handleImportFromLocal, handleVerifyAndRefresh, handleSave };\n  if (!open || !account) return null'
  const code = source(file).replace(
    component === 'AddAccountDialog'
      ? 'if (!isOpen) return null'
      : 'if (!open || !account) return null',
    returnHandlers
  )
  const exports = {}
  vm.runInNewContext(compile(code), {
    exports,
    window: { api },
    Date: Clock,
    console: { log() {}, error() {} },
    AbortController,
    setTimeout(run) {
      queueMicrotask(run)
      return 1
    },
    clearTimeout() {},
    require(name) {
      if (name === 'react') return hooks
      if (name === '@/store' || name === '@/store/accounts') return { useAccountsStore: useStore }
      if (name === '@/hooks/useTranslation')
        return { useTranslation: () => ({ t: () => 'Unknown' }) }
      if (name.includes('shared/accountImport'))
        return { parseAccountImportText: () => ({ ok: false }) }
      if (name.includes('shared/accountSearch')) return { mergeSourceAccountNames }
      return {}
    }
  })
  const render = () => {
    stateIndex = 0
    refIndex = 0
    return exports[component](
      component === 'AddAccountDialog'
        ? { isOpen: true, onClose() {} }
        : { open: true, account, onOpenChange() {} }
    )
  }
  const set = (name, value) => {
    const index = stateNames.indexOf(name)
    assert.ok(index >= 0)
    states[index] = value
  }
  return {
    render,
    set,
    added,
    updated,
    runEffects() {
      for (const effect of effects.splice(0)) effect()
    }
  }
}

const local = {
  accessToken: 'SYNTHETIC_ACCESS',
  refreshToken: 'SYNTHETIC_REFRESH',
  clientId: 'SYNTHETIC_CLIENT',
  clientSecret: 'SYNTHETIC_SECRET',
  clientSecretExpiresAt: expiry,
  region: 'eu-central-1',
  authMethod: 'IdC',
  provider: 'BuilderId'
}

test('real registration response retains its deadline through SSO IPC, preload and the actual add-account handler', async () => {
  const main = mainHarness()
  const api = {
    importFromSsoToken: preloadMethod('importFromSsoToken', (channel, token, region) => {
      assert.equal(channel, 'import-from-sso-token')
      return main.sso(token, region)
    })
  }
  const dialog = dialogHarness('AddAccountDialog', api)
  dialog.render()
  dialog.set('ssoToken', 'SYNTHETIC_BEARER')
  await dialog.render().handleSsoImport()
  assert.equal(dialog.added.length, 1)
  assert.equal(dialog.added[0].credentials.clientSecretExpiresAt, expiry)
  assert.equal(dialog.added[0].credentials.clientId, local.clientId)
  assert.equal(main.calls.filter((url) => url.endsWith('/client/register')).length, 1)
})

test('registration without a valid deadline stops before device approval instead of fabricating one', async () => {
  for (const value of [null, 'invalid', now / 1000 - 1]) {
    const main = mainHarness(value)
    const result = await main.sso('SYNTHETIC_BEARER', 'us-east-1')
    assert.equal(result.success, false)
    assert.equal(main.calls.length, 1)
    assert.doesNotMatch(result.error.message, /SYNTHETIC_CLIENT|SYNTHETIC_SECRET/)
  }
})

test('real verification boundary forwards and returns the normalized registration deadline', async () => {
  const main = mainHarness()
  const verify = preloadMethod('verifyAccountCredentials', (channel, input) => {
    assert.equal(channel, 'verify-account-credentials')
    return main.verify(input)
  })
  const result = await verify({
    ...local,
    clientSecretExpiresAt: new Date(expiry * 1000).toISOString()
  })
  assert.equal(result.success, true)
  assert.equal(result.data.clientSecretExpiresAt, expiry)
  assert.equal(main.refreshes[0][6], expiry)
})

test('local add-account import preserves expiry only while the registered client and region match', async () => {
  for (const changed of [undefined, 'clientId', 'clientSecret', 'region']) {
    const inputs = []
    const dialog = dialogHarness('AddAccountDialog', {
      loadKiroCredentials: preloadMethod('loadKiroCredentials', async (channel) => {
        assert.equal(channel, 'load-kiro-credentials')
        return { success: true, data: local }
      }),
      verifyAccountCredentials: async (input) => {
        inputs.push(input)
        return verified(input)
      }
    })
    await dialog.render().handleImportFromLocal()
    if (changed) dialog.set(changed, `SYNTHETIC_CHANGED_${changed}`)
    await dialog.render().handleOidcAdd()
    assert.equal(dialog.added.length, 1)
    assert.equal(inputs[0].clientSecretExpiresAt, changed ? undefined : expiry)
    assert.equal(dialog.added[0].credentials.clientSecretExpiresAt, changed ? undefined : expiry)
  }
})

test('editing preserves a matching registration and clears the old deadline when its client or region changes', async () => {
  for (const changed of [undefined, 'clientId', 'clientSecret', 'region']) {
    const inputs = []
    const account = {
      id: 'synthetic-account',
      email: 'synthetic@example.invalid',
      idp: 'BuilderId',
      credentials: local,
      subscription: { type: 'Free' },
      usage: { current: 2, limit: 50 }
    }
    const dialog = dialogHarness(
      'EditAccountDialog',
      {
        verifyAccountCredentials: async (input) => {
          inputs.push(input)
          return verified(input)
        }
      },
      account
    )
    dialog.render()
    dialog.runEffects()
    if (changed) dialog.set(changed, `SYNTHETIC_CHANGED_${changed}`)
    await dialog.render().handleVerifyAndRefresh()
    dialog.render().handleSave()
    assert.equal(dialog.updated.length, 1)
    assert.equal(inputs[0].clientSecretExpiresAt, changed ? undefined : expiry)
    assert.equal(dialog.updated[0].credentials.clientSecretExpiresAt, changed ? undefined : expiry)
  }
})

test('store import of an unknown local account retains the registration deadline after verification', async () => {
  const ast = tree('renderer/src/store/accounts.ts')
  const inputs = []
  const state = {
    accounts: new Map(),
    activeAccountId: null,
    saveToStorage() {},
    getActiveAccount() {}
  }
  const context = vm.createContext({
    Date: Clock,
    normalizeAccountSubscription,
    console: { log() {}, error() {} },
    window: {
      api: {
        getLocalActiveAccount: async () => ({
          success: true,
          data: { refreshToken: local.refreshToken }
        }),
        loadKiroCredentials: async () => ({ success: true, data: local }),
        verifyAccountCredentials: async (input) => {
          inputs.push(input)
          return verified(input)
        }
      }
    }
  })
  vm.runInContext(
    compile(`${fn(ast, 'syncLocalSsoAccountAsync')}\nglobalThis.run = syncLocalSsoAccountAsync`),
    context
  )
  await context.run(
    () => state,
    (update) => Object.assign(state, typeof update === 'function' ? update(state) : update)
  )
  assert.equal(inputs[0].clientSecretExpiresAt, expiry)
  assert.equal([...state.accounts.values()][0].credentials.clientSecretExpiresAt, expiry)
})
