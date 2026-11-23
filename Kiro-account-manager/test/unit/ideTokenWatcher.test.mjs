import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { parseAccessTokenClaims } from '../../src/main/kiroAuthSync.ts'
import { INSTANCE_ACCOUNT_REAUTH_REQUIRED } from '../../src/main/kiroInstanceOwnership.ts'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'

const ts = createRequire(import.meta.url)('typescript')
function functions(file, names) {
  const source = readFileSync(new URL('../../src/main/' + file, import.meta.url), 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  return tree.statements.filter(node => names.includes(node.name?.text))
    .map(node => node.getText(tree).replace(/^export /, '')).join('\n')
}
const code = ts.transpileModule([
  functions('kiroAuthSync.ts', ['computeClientIdHash', 'readKiroWatcherRegistration', 'watchKiroAuthTokenFile']),
  functions('index.ts', ['startKiroAuthTokenWatcher', 'syncIdeTokenChangeToStore'])
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const tick = () => new Promise(resolve => setImmediate(resolve))
const now = Date.now()
const old = { authMethod: 'social', provider: 'Google', accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh', expiresAt: new Date(now + 3600000).toISOString() }
const row = (token = old, extra = {}) => ({ credentials: { ...token, expiresAt: Date.parse(token.expiresAt), ...extra } })
const issuer = 'https://example.invalid/start'
const hash = crypto.createHash('sha1').update(JSON.stringify({ startUrl: issuer })).digest('hex')
const jwt = (sub, issued, iss = 'https://issuer.invalid') => 'eyJhbGciOiJSUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ iss, sub, iat: issued })).toString('base64url') + '.c3ludGhldGlj'

async function route(accounts, initial = old, options = {}) {
  let disk = initial, data = { accounts }, listener, seq = 0
  const notifications = [], timers = new Map(), registrationReads = []
  const registrationPath = path.join('isolated-cache', hash + '.json')
  const context = vm.createContext({
    parseAccessTokenClaims, resolveIdentity, INSTANCE_ACCOUNT_REAUTH_REQUIRED, crypto, path, Buffer,
    KIRO_SSO_CACHE_DIR: 'isolated-cache', KIRO_AUTH_TOKEN_PATH: 'simulated-token-path', KIRO_DEFAULT_START_URL: issuer,
    stopKiroAuthTokenWatcher: null, lastWrittenTokenSignature: null,
    store: { get: () => data, set: (_, value) => { data = value } },
    lastSavedData: data, pendingStoreWrites: new Map(),
    readKiroAuthTokenFile: async () => structuredClone(disk),
    fsSync: { watchFile(_path, _opts, fn) { listener = fn }, unwatchFile() {} },
    fs: {
      async lstat(file) {
        assert.equal(file, registrationPath)
        return { isFile: () => true, isSymbolicLink: () => false, size: 150 }
      },
      async readFile(file) {
        registrationReads.push(file)
        assert.equal(file, registrationPath)
        options.onRegistration?.({ setDisk: value => { disk = value }, setData: value => { data = value } })
        return JSON.stringify(options.registration)
      }
    },
    setTimeout(fn) { timers.set(++seq, fn); return seq }, clearTimeout(id) { timers.delete(id) },
    mainWindow: { webContents: { send: (_event, update) => notifications.push(update.accountId) } },
    instanceAccountOwnership: { isBound: () => !!options.bound }, console: { log() {}, warn() {} }
  })
  vm.runInContext(code, context)
  context.startKiroAuthTokenWatcher()
  await tick()
  return { notifications, registrationReads, get accounts() { return data.accounts },
    async change(value) {
      disk = value
      listener()
      for (const [id, fn] of timers) { timers.delete(id); fn() }
      await tick()
    } }
}

test('watcher accepts an observed rotation with a shorter or elapsed access lifetime and never restores a stale manager generation', async () => {
  for (const time of [now + 5000, now - 5000]) {
    const next = { ...old, refreshToken: 'synthetic-rotated', expiresAt: new Date(time).toISOString() }
    const h = await route({ active: row(), other: row({ ...old, accessToken: 'synthetic-other', refreshToken: 'synthetic-unrelated' }) })
    await h.change(next)
    assert.deepEqual(h.notifications, ['active'])
    assert.equal(h.accounts.active.credentials.refreshToken, next.refreshToken)
    assert.equal(h.accounts.active.credentials.expiresAt, time)
    await h.change(old)
    assert.deepEqual(h.notifications, ['active'])
    assert.equal(h.accounts.active.credentials.refreshToken, next.refreshToken)
    const advanced = await route({ active: row({ ...old, refreshToken: 'synthetic-manager-advanced' }) })
    await advanced.change(next)
    assert.deepEqual(advanced.notifications, [])
  }
})

test('watcher requires an unambiguous observed account, valid expiry and identity continuity', async () => {
  const next = { ...old, accessToken: 'synthetic-new' }
  for (const [accounts, initial, token, options] of [
    [{ first: row(), second: row() }, old, next],
    [{ active: row() }, null, next],
    [{ active: row() }, old, { ...next, expiresAt: 'invalid' }],
    [{ active: row() }, old, { ...next, provider: 'Github' }],
    [{ active: row() }, old, { ...next, refreshToken: 'synthetic-new-refresh' }],
    [{ active: row() }, old, next, { bound: true }],
    [{ active: { ...row(), lastError: INSTANCE_ACCOUNT_REAUTH_REQUIRED } }, old, next]
  ]) {
    const h = await route(accounts, initial, options)
    await h.change(token)
    assert.deepEqual(h.notifications, [])
  }
  const h = await route({ active: row() })
  await h.change(null)
  await h.change(next)
  assert.deepEqual(h.notifications, [])
})

test('fully rotated Social tokens require the same issuer, subject and sign-in provider', async () => {
  const initial = { ...old, accessToken: jwt('a', 20) }
  for (const [accessToken, provider, expected] of [
    [jwt('a', 21), 'Google', ['active']], [jwt('a', 19), 'Google', []],
    [jwt('b', 21), 'Google', []], [jwt('a', 21, 'https://other.invalid'), 'Google', []],
    [jwt('a', 21), 'Github', []]
  ]) {
    const h = await route({ active: row(initial) }, initial)
    await h.change({ ...initial, accessToken, provider, refreshToken: 'synthetic-full-rotation' })
    assert.deepEqual(h.notifications, expected)
  }
})

test('OIDC rotation checks the registration itself and rechecks both IDE and store after asynchronous reads', async () => {
  const registration = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
  const initial = { ...old, authMethod: 'IdC', provider: 'Enterprise', region: 'eu-central-1',
    clientIdHash: hash, accessToken: jwt('user', 1) }
  const accounts = { active: row(initial, { ...registration, startUrl: issuer }) }
  const next = { ...initial, accessToken: jwt('user', 2), refreshToken: 'synthetic-next-generation' }
  const options = [
    [next, { registration }, ['active']],
    [next, { registration: { ...registration, clientId: 'new-registration' } }, []],
    [next, { registration: { ...registration, clientSecret: 'new-secret' } }, []],
    [{ ...next, clientIdHash: '../invalid' }, { registration }, []],
    [{ ...next, region: 'us-east-1' }, { registration }, []],
    [next, { registration, onRegistration: ({ setDisk }) => setDisk(null) }, []],
    [next, { registration, onRegistration: ({ setData }) => setData({ accounts: { active: row(next) } }) }, []]
  ]
  for (const [incoming, config, expected] of options) {
    const h = await route(accounts, initial, config)
    await h.change(incoming)
    assert.deepEqual(h.notifications, expected)
    if (expected.length) assert.equal(h.registrationReads.length, 1)
    if (incoming.clientIdHash !== hash) assert.equal(h.registrationReads.length, 0)
  }
})
