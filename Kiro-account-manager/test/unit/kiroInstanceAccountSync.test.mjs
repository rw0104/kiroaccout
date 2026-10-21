import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { win32, resolve, join } from 'node:path'
import vm from 'node:vm'
import { normalizeProvider, resolveIdentity } from '../../src/shared/authIdentity.ts'
import { prepareKiroInstanceAccount, readKiroInstanceAccountUpdate } from '../../src/main/kiroInstanceAccounts.ts'
import { makeInstancePaths, prepareInstanceDirectories, instanceFileSystem, KiroInstanceError } from '../../src/main/kiroInstancePaths.ts'

// Exercise the real main-process selection and persistence boundary without
// importing Electron, opening production storage or making network requests.
const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const declarations = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['getInstanceBoundAccount', 'persistInstanceAccountCredentials'].includes(node.name?.text)) declarations.push(node.getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(declarations.length, 2)
const factory = ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const now = 1_800_000_000_000
const plain = value => JSON.parse(JSON.stringify(value))
const jwt = generation => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'synthetic-user', generation })).toString('base64url'), 'SYNTHETIC_SIGNATURE'].join('.')
const social = () => ({
  id: 'synthetic-account', idp: 'Github', userId: 'synthetic-user', nickname: 'Keep original metadata', status: 'active',
  credentials: { accessToken: jwt(1), refreshToken: 'SYNTHETIC_REFRESH_1', expiresAt: now + 3_600_000, authMethod: 'IdC' }
})

function host(original = social()) {
  let data = { accounts: { [original.id]: original } }
  let writes = 0
  let bound = true
  const events = []
  const context = vm.createContext({
    store: { get: () => data, set: (_key, value) => { data = value; writes++ } },
    resolveIdentity, normalizeProvider, KiroInstanceError,
    instanceAccountOwnership: { isBound: () => bound }, pendingStoreWrites: new Map(), lastSavedData: null,
    mainWindow: { webContents: { send: (channel, event) => events.push({ channel, event }) } }
  })
  vm.runInContext(factory, context)
  return {
    select: vm.runInContext('getInstanceBoundAccount', context),
    persist: vm.runInContext('persistInstanceAccountCredentials', context),
    get current() { return data.accounts[original.id] }, get writes() { return writes }, events,
    replace: value => { data = { accounts: { [original.id]: value } } },
    unbind: () => { bound = false }
  }
}

async function instance(t, original = social()) {
  const approvedRoot = resolve('..', '.local', 'isolated', 'account-storage-tests')
  await fs.mkdir(approvedRoot, { recursive: true })
  const baseRoot = await fs.mkdtemp(join(approvedRoot, 'synthetic-sync-'))
  t.after(async () => {
    const checked = resolve(baseRoot)
    assert.ok(checked.startsWith(approvedRoot + win32.sep))
    await fs.rm(checked, { recursive: true, force: true })
  })
  const id = '00000000-0000-4000-8000-000000000001'
  const paths = makeInstancePaths(baseRoot, id, false)
  await prepareInstanceDirectories(instanceFileSystem, paths, id)
  const record = { schemaVersion: 2, id, label: 'Synthetic instance', accountId: original.id,
    executablePath: 'C:\\Synthetic\\Kiro\\Kiro.exe', createdAt: new Date(now).toISOString(), paths }
  const manager = host(original)
  const input = { record, account: manager.select(original.id), now }
  const tokenPath = win32.join(paths.home, '.aws', 'sso', 'cache', 'kiro-auth-token.json')
  return { manager, input,
    readToken: async () => JSON.parse(await fs.readFile(tokenPath, 'utf8')),
    writeToken: async value => fs.writeFile(tokenPath, JSON.stringify(value)) }
}
const windows = { skip: process.platform !== 'win32' }

test('seeding and background synchronization of unchanged tokens never rewrite the selected manager account', windows, async t => {
  const original = social(), before = plain(original)
  const { manager, input } = await instance(t, original)
  assert.equal(input.account.credentials.authMethod, 'social')
  const prepared = await prepareKiroInstanceAccount(input)
  assert.equal(prepared.source, 'manager')
  const update = await readKiroInstanceAccountUpdate(input)
  assert.equal(update.credentials.provider, 'Github')
  assert.ok(update.credentials.profileArn)
  manager.persist(original.id, update.credentials, input.account.credentials)
  assert.equal(manager.writes, 0)
  assert.deepEqual(manager.events, [])
  assert.equal(manager.current, original)
  assert.deepEqual(original, before)
})

test('OIDC launch-only default URL and expiry normalization do not alter an unchanged manager record', windows, async t => {
  const original = social()
  original.idp = 'Builder ID'
  original.credentials = { ...original.credentials, authMethod: 'OIDC', provider: 'AWS Builder ID',
    clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: new Date(now + 86_400_000).toISOString() }
  const before = plain(original)
  const { manager, input } = await instance(t, original)
  await prepareKiroInstanceAccount(input)
  const update = await readKiroInstanceAccountUpdate(input)
  assert.equal(update.credentials.clientSecretExpiresAt, (now + 86_400_000) / 1000)
  assert.ok(update.credentials.startUrl)
  manager.persist(original.id, update.credentials, input.account.credentials)
  assert.equal(manager.writes, 0)
  assert.deepEqual(original, before)
  assert.equal(manager.current, original)
})

test('a verified instance rotation updates only tokens and expiry while preserving original identity metadata', windows, async t => {
  const original = social(), before = plain(original)
  const { manager, input, readToken, writeToken } = await instance(t, original)
  await prepareKiroInstanceAccount(input)
  const rotation = { accessToken: jwt(2), refreshToken: 'SYNTHETIC_REFRESH_2', expiresAt: now + 7_200_000 }
  await writeToken({ ...await readToken(), ...rotation, expiresAt: new Date(rotation.expiresAt).toISOString() })
  const update = await readKiroInstanceAccountUpdate(input)
  manager.persist(original.id, update.credentials, input.account.credentials)
  assert.equal(manager.writes, 1)
  assert.deepEqual(plain(manager.current), { ...before, credentials: { ...before.credentials, ...rotation } })
  assert.deepEqual(plain(manager.events), [{ channel: 'kiro-instance-account-update', event: { id: original.id, credentials: rotation } }])
  assert.deepEqual(original, before)
  manager.persist(original.id, update.credentials, input.account.credentials)
  assert.equal(manager.writes, 1, 'an already persisted rotation is idempotent')
})

test('expiry-only credential changes preserve all manager identity metadata', () => {
  const original = social(), before = plain(original), manager = host(original)
  const selected = manager.select(original.id)
  const next = { ...selected.credentials, expiresAt: original.credentials.expiresAt + 60_000, profileArn: 'SYNTHETIC_PROFILE' }
  manager.persist(original.id, next, selected.credentials)
  assert.deepEqual(plain(manager.current), { ...before, credentials: { ...before.credentials, expiresAt: next.expiresAt } })
})

test('a stale synchronization snapshot cannot overwrite a newer token or expiry generation', () => {
  for (const newer of [{ accessToken: jwt(3) }, { refreshToken: 'SYNTHETIC_REFRESH_3' }, { expiresAt: now + 10_800_000 }]) {
    const original = social(), manager = host(original), selected = manager.select(original.id)
    const authoritative = { ...original, credentials: { ...original.credentials, ...newer } }
    manager.replace(authoritative)
    assert.throws(() => manager.persist(original.id, { ...selected.credentials, accessToken: jwt(2), refreshToken: 'SYNTHETIC_REFRESH_2', expiresAt: now + 7_200_000 }, selected.credentials), /账户凭证刚刚变化/)
    assert.equal(manager.current, authoritative)
    assert.equal(manager.writes, 0)
    assert.deepEqual(manager.events, [])
  }
})

test('a synchronization that loses its binding cannot update manager credentials', () => {
  const original = social(), manager = host(original), selected = manager.select(original.id)
  manager.unbind()
  manager.persist(original.id, { ...selected.credentials, accessToken: jwt(2), refreshToken: 'SYNTHETIC_REFRESH_2' }, selected.credentials)
  assert.equal(manager.current, original)
  assert.equal(manager.writes, 0)
  assert.deepEqual(manager.events, [])
})

test('conflicting explicit provider and idp are rejected before account preparation', () => {
  for (const [idp, provider] of [['Github', 'BuilderId'], ['Google', 'Github'], ['Enterprise', 'Builder ID']]) {
    const original = social()
    original.idp = idp
    original.credentials.provider = provider
    const before = plain(original), manager = host(original)
    assert.throws(() => manager.select(original.id), error => error instanceof KiroInstanceError && /provider.*idp/.test(error.message))
    assert.equal(manager.writes, 0)
    assert.deepEqual(original, before)
  }
})

test('matching provider aliases and an obsolete authMethod normalize only the launch copy', () => {
  const original = social()
  original.idp = 'git_hub'
  original.credentials.provider = 'GitHub'
  const before = plain(original), manager = host(original), selected = manager.select(original.id)
  assert.equal(selected.idp, 'Github')
  assert.equal(selected.credentials.provider, 'Github')
  assert.equal(selected.credentials.authMethod, 'social')
  assert.notEqual(selected.credentials, original.credentials)
  assert.equal(manager.writes, 0)
  assert.deepEqual(original, before)
})
