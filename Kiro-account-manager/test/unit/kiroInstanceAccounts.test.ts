import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { win32, resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { makeInstancePaths, instanceFileSystem, prepareInstanceDirectories, KiroInstanceError } from '../../src/main/kiroInstancePaths'
import { prepareKiroInstanceAccount, readKiroInstanceAccountUpdate, type InstanceBoundAccount } from '../../src/main/kiroInstanceAccounts'
import type { KiroInstanceRecord } from '../../src/shared/kiroInstances'

const now = 1800000000000
const jwt = (sub: string, generation: number) => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub, generation })).toString('base64url'), 'SYNTHETIC_SIGNATURE'].join('.')
const social = (id = 'synthetic-account-a'): InstanceBoundAccount => ({
  id, idp: 'Github', credentials: { accessToken: jwt(id, 1), refreshToken: `SYNTHETIC_REFRESH_${id}`, expiresAt: now + 3600000, provider: 'Github', authMethod: 'social', region: 'us-east-1' }
})
async function fixture(t: { after(action: () => Promise<void>): void }, account = social()) {
  const approvedRoot = resolve('..', '.local', 'isolated', 'account-storage-tests')
  await fs.mkdir(approvedRoot, { recursive: true })
  const baseRoot = await fs.mkdtemp(join(approvedRoot, 'synthetic-'))
  t.after(async () => {
    const checked = resolve(baseRoot)
    assert.ok(checked.startsWith(approvedRoot + win32.sep))
    await fs.rm(checked, { recursive: true, force: true })
  })
  const id = '00000000-0000-4000-8000-000000000001'
  const paths = makeInstancePaths(baseRoot, id, false)
  await prepareInstanceDirectories(instanceFileSystem, paths, id)
  const record: KiroInstanceRecord = { schemaVersion: 2, id, label: 'Synthetic bound instance', accountId: account.id,
    executablePath: 'C:\\Synthetic\\Kiro\\Kiro.exe', createdAt: new Date(now).toISOString(), paths }
  const cache = win32.join(paths.home, '.aws', 'sso', 'cache')
  const tokenPath = win32.join(cache, 'kiro-auth-token.json')
  const bindingPath = win32.join(paths.root, '.kiro-account-binding.json')
  return { record, account, cache, tokenPath, bindingPath, input: { record, account, now },
    token: async () => JSON.parse(await fs.readFile(tokenPath, 'utf8')) as Record<string, unknown>,
    binding: async () => JSON.parse(await fs.readFile(bindingPath, 'utf8')) as Record<string, unknown>,
    writeToken: async (value: unknown) => fs.writeFile(tokenPath, JSON.stringify(value)),
    readCache: async () => fs.readdir(cache)
  }
}
const options = { skip: process.platform !== 'win32' }
const denied = async (action: Promise<unknown>) => assert.rejects(action, error => error instanceof KiroInstanceError && !/SYNTHETIC_(?:REFRESH|SECRET|SIGNATURE)/.test(error.message))

test('selected Social account seeds only its marked instance and stores no extra raw credentials in binding metadata', options, async t => {
  const ctx = await fixture(t)
  const original = structuredClone(ctx.account)
  const result = await prepareKiroInstanceAccount(ctx.input)
  assert.equal(result.source, 'manager')
  const token = await ctx.token()
  assert.equal(token.accessToken, ctx.account.credentials.accessToken)
  assert.equal(token.refreshToken, ctx.account.credentials.refreshToken)
  assert.equal(token.provider, 'Github')
  assert.equal(token.profileArn, 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK')
  assert.equal(token.expiresAt, new Date(ctx.account.credentials.expiresAt).toISOString())
  assert.deepEqual(await ctx.readCache(), ['kiro-auth-token.json'])
  assert.doesNotMatch(JSON.stringify(await ctx.binding()), /SYNTHETIC_REFRESH|SYNTHETIC_SIGNATURE|accessToken|refreshToken/)
  assert.deepEqual(ctx.account, original)
  assert.deepEqual((await readKiroInstanceAccountUpdate(ctx.input))?.credentials, result.credentials)
})

test('IdC writes the current official client hash and actual Unix-second registration deadline without inventing validity', options, async t => {
  const account = social()
  account.idp = 'BuilderId'
  account.credentials = { ...account.credentials, provider: 'BuilderId', authMethod: 'IdC', region: 'eu-central-1',
    startUrl: 'https://view.awsapps.com/start', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: now / 1000 + 86400 }
  const ctx = await fixture(t, account)
  await prepareKiroInstanceAccount(ctx.input)
  const hash = createHash('sha1').update(JSON.stringify({ startUrl: account.credentials.startUrl })).digest('hex')
  const registration = JSON.parse(await fs.readFile(win32.join(ctx.cache, `${hash}.json`), 'utf8'))
  assert.deepEqual(registration, { clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', expiresAt: new Date(account.credentials.clientSecretExpiresAt! * 1000).toISOString() })
  assert.equal((await ctx.token()).clientIdHash, hash)
  assert.equal((await ctx.token()).region, 'eu-central-1')
  assert.equal((await readKiroInstanceAccountUpdate(ctx.input))?.credentials.clientSecretExpiresAt, account.credentials.clientSecretExpiresAt)
})

test('historical ISO and millisecond registration deadlines normalize to their exact real Unix-second value', options, async t => {
  const deadline = now + 86400123
  for (const stored of [deadline, new Date(deadline).toISOString(), new Date(deadline).toISOString().replace('Z', '+00:00')]) {
    const account = social()
    account.credentials = { ...account.credentials, provider: 'BuilderId', authMethod: 'IdC',
      clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: stored as number }
    const ctx = await fixture(t, account)
    const seeded = await prepareKiroInstanceAccount(ctx.input)
    assert.equal(seeded.credentials.clientSecretExpiresAt, deadline / 1000)
    const token = await ctx.token()
    const registration = JSON.parse(await fs.readFile(win32.join(ctx.cache, `${token.clientIdHash}.json`), 'utf8'))
    assert.equal(registration.expiresAt, new Date(deadline).toISOString())
    assert.equal((await readKiroInstanceAccountUpdate(ctx.input))?.credentials.clientSecretExpiresAt, deadline / 1000)
    assert.equal(ctx.account.credentials.clientSecretExpiresAt, stored)
  }
})

test('incomplete credentials and expired or unknown-expiry registrations fail before writing login caches', options, async t => {
  for (const change of [
    { expiresAt: Number.NaN }, { refreshToken: '' },
    { provider: 'BuilderId', authMethod: 'IdC', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET' },
    { provider: 'BuilderId', authMethod: 'IdC', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: now / 1000 - 1 },
    { provider: 'Enterprise', authMethod: 'IdC', clientId: 'SYNTHETIC_CLIENT', clientSecret: 'SYNTHETIC_SECRET', clientSecretExpiresAt: now / 1000 + 86400 }
  ]) {
    const account = social()
    account.credentials = { ...account.credentials, ...change }
    const ctx = await fixture(t, account)
    await denied(prepareKiroInstanceAccount(ctx.input))
    assert.deepEqual(await ctx.readCache(), [])
    await assert.rejects(fs.access(ctx.bindingPath))
  }
})

test('an expired valid access token with a refresh token can start the official client without manager refresh', options, async t => {
  const account = social()
  account.credentials.expiresAt = now - 7200000
  const ctx = await fixture(t, account)
  const result = await prepareKiroInstanceAccount(ctx.input)
  assert.equal(result.source, 'manager')
  assert.equal((await ctx.token()).expiresAt, new Date(account.credentials.expiresAt).toISOString())
  const rotated = { ...await ctx.token(), accessToken: jwt(account.id, 2), refreshToken: 'SYNTHETIC_ROTATED_EXPIRED', expiresAt: new Date(now - 3600000).toISOString() }
  await ctx.writeToken(rotated)
  const retained = await prepareKiroInstanceAccount(ctx.input)
  assert.equal(retained.source, 'instance')
  assert.equal(retained.credentials.refreshToken, rotated.refreshToken)
  assert.equal(retained.credentials.expiresAt, now - 3600000)
  assert.deepEqual(await ctx.token(), rotated)
  assert.equal(account.credentials.refreshToken, `SYNTHETIC_REFRESH_${account.id}`)
})

test('a different accountId cannot read or seed a bound instance', options, async t => {
  const ctx = await fixture(t)
  const other = social('synthetic-account-b')
  await denied(prepareKiroInstanceAccount({ ...ctx.input, account: other }))
  await denied(readKiroInstanceAccountUpdate({ ...ctx.input, account: other }))
  assert.deepEqual(await ctx.readCache(), [])
})

test('two managed instances retain exactly the chosen account and never inherit one another credentials', options, async t => {
  const a = await fixture(t, social('synthetic-a'))
  const b = await fixture(t, social('synthetic-b'))
  await Promise.all([prepareKiroInstanceAccount(a.input), prepareKiroInstanceAccount(b.input)])
  assert.notEqual(a.record.paths.home, b.record.paths.home)
  assert.equal((await a.token()).refreshToken, a.account.credentials.refreshToken)
  assert.equal((await b.token()).refreshToken, b.account.credentials.refreshToken)
  assert.notEqual((await a.token()).refreshToken, (await b.token()).refreshToken)
})

test('unbound foreign cache and mismatched binding metadata are never overwritten', options, async t => {
  const ctx = await fixture(t)
  const foreign = { accessToken: 'SYNTHETIC_FOREIGN_ACCESS', refreshToken: 'SYNTHETIC_FOREIGN_REFRESH' }
  await ctx.writeToken(foreign)
  await denied(prepareKiroInstanceAccount(ctx.input))
  assert.deepEqual(await ctx.token(), foreign)
  await fs.unlink(ctx.tokenPath)
  await prepareKiroInstanceAccount(ctx.input)
  const binding = await ctx.binding()
  await fs.writeFile(ctx.bindingPath, JSON.stringify({ ...binding, accountId: 'other' }))
  await denied(prepareKiroInstanceAccount(ctx.input))
  assert.equal((await ctx.token()).accessToken, ctx.account.credentials.accessToken)
})

test('same-subject rotation is synchronized and restart preserves the newer instance token over expired manager data', options, async t => {
  const ctx = await fixture(t)
  await prepareKiroInstanceAccount(ctx.input)
  const token = await ctx.token()
  const next = { ...token, accessToken: jwt(ctx.account.id, 2), refreshToken: 'SYNTHETIC_ROTATED', expiresAt: new Date(now + 7200000).toISOString() }
  await ctx.writeToken(next)
  const update = await readKiroInstanceAccountUpdate(ctx.input)
  assert.equal(update?.credentials.refreshToken, 'SYNTHETIC_ROTATED')
  const expired = { ...ctx.account, credentials: { ...ctx.account.credentials, expiresAt: now - 1 } }
  const result = await prepareKiroInstanceAccount({ ...ctx.input, account: expired })
  assert.equal(result.source, 'instance')
  assert.equal(result.credentials.accessToken, next.accessToken)
  assert.equal((await ctx.token()).refreshToken, 'SYNTHETIC_ROTATED')
})

test('opaque refresh rotation and a changed JWT subject fail closed without overwriting manager or target data', options, async t => {
  const opaque = social()
  opaque.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const a = await fixture(t, opaque)
  await prepareKiroInstanceAccount(a.input)
  const rotated = { ...await a.token(), refreshToken: 'SYNTHETIC_OPAQUE_ROTATED', accessToken: 'SYNTHETIC_OPAQUE_NEXT' }
  await a.writeToken(rotated)
  await denied(readKiroInstanceAccountUpdate(a.input))
  await denied(prepareKiroInstanceAccount(a.input))
  assert.deepEqual(await a.token(), rotated)
  const b = await fixture(t)
  await prepareKiroInstanceAccount(b.input)
  await b.writeToken({ ...await b.token(), accessToken: jwt('synthetic-other-person', 2) })
  await denied(readKiroInstanceAccountUpdate(b.input))
  assert.equal(b.account.credentials.accessToken, jwt(b.account.id, 1))
})

test('opaque rotation requires authenticated callback identity equal to the bound user hash and then survives restart', options, async t => {
  const account = social()
  account.userId = 'synthetic-verified-user'
  account.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const ctx = await fixture(t, account)
  let calls = 0
  const verifyIdentity = async (credentials: InstanceBoundAccount['credentials']) => {
    calls++
    assert.equal(credentials.accessToken, 'SYNTHETIC_OPAQUE_NEXT')
    assert.equal(credentials.refreshToken, 'SYNTHETIC_OPAQUE_ROTATED')
    assert.notEqual(credentials, account.credentials)
    return { userId: account.userId! }
  }
  await prepareKiroInstanceAccount({ ...ctx.input, verifyIdentity })
  assert.equal(calls, 0)
  assert.equal((await ctx.binding()).userIdFingerprint, createHash('sha256').update(account.userId).digest('hex'))
  assert.doesNotMatch(JSON.stringify(await ctx.binding()), /synthetic-verified-user/)
  await ctx.writeToken({ ...await ctx.token(), accessToken: 'SYNTHETIC_OPAQUE_NEXT', refreshToken: 'SYNTHETIC_OPAQUE_ROTATED' })
  const result = await readKiroInstanceAccountUpdate({ ...ctx.input, verifyIdentity })
  assert.equal(result?.credentials.refreshToken, 'SYNTHETIC_OPAQUE_ROTATED')
  assert.equal(calls, 1)
  // The host persists the returned credentials; this module never writes the
  // manager store itself.
  account.credentials = result!.credentials
  const restarted = await prepareKiroInstanceAccount({ ...ctx.input, verifyIdentity })
  assert.equal(restarted.source, 'instance')
  assert.equal(restarted.credentials.accessToken, 'SYNTHETIC_OPAQUE_NEXT')
  assert.equal(calls, 1)
})

test('wrong, absent or failing callback identity never accepts opaque rotation or leaks callback details', options, async t => {
  const account = social()
  account.userId = 'synthetic-verified-user'
  account.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const ctx = await fixture(t, account)
  await prepareKiroInstanceAccount(ctx.input)
  const originalBinding = await ctx.binding()
  const originalAccount = structuredClone(account)
  const rotated = { ...await ctx.token(), accessToken: 'SYNTHETIC_OPAQUE_NEXT', refreshToken: 'SYNTHETIC_OPAQUE_ROTATED' }
  await ctx.writeToken(rotated)
  for (const verifyIdentity of [
    async () => ({ userId: 'synthetic-wrong-user' }),
    async () => null,
    async () => { throw new Error('SYNTHETIC_SECRET_CALLBACK_DETAILS') },
    async () => { throw new KiroInstanceError('SYNTHETIC_SECRET_CALLBACK_DETAILS') }
  ]) {
    await denied(readKiroInstanceAccountUpdate({ ...ctx.input, verifyIdentity }))
    await denied(prepareKiroInstanceAccount({ ...ctx.input, verifyIdentity }))
    assert.deepEqual(await ctx.binding(), originalBinding)
    assert.deepEqual(await ctx.token(), rotated)
    assert.deepEqual(account, originalAccount)
  }
})

test('missing or changed bound user IDs and conflicting JWT subjects cannot be bypassed by a matching callback', options, async t => {
  const opaque = social()
  opaque.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const a = await fixture(t, opaque)
  await prepareKiroInstanceAccount(a.input)
  await a.writeToken({ ...await a.token(), accessToken: 'SYNTHETIC_OPAQUE_NEXT', refreshToken: 'SYNTHETIC_OPAQUE_ROTATED' })
  let calls = 0
  const verifyIdentity = async () => { calls++; return { userId: 'synthetic-verified-user' } }
  await denied(readKiroInstanceAccountUpdate({ ...a.input, verifyIdentity }))
  const account = social()
  account.userId = 'synthetic-verified-user'
  const b = await fixture(t, account)
  await prepareKiroInstanceAccount(b.input)
  await b.writeToken({ ...await b.token(), accessToken: jwt('synthetic-other-user', 2), refreshToken: 'SYNTHETIC_OTHER_REFRESH' })
  await denied(readKiroInstanceAccountUpdate({ ...b.input, verifyIdentity }))
  account.userId = 'synthetic-other-user'
  await denied(readKiroInstanceAccountUpdate({ ...b.input, verifyIdentity }))
  assert.equal(calls, 0)
})

test('a token changing during asynchronous identity verification is not synchronized or marked accepted', options, async t => {
  const account = social()
  account.userId = 'synthetic-verified-user'
  account.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const ctx = await fixture(t, account)
  await prepareKiroInstanceAccount(ctx.input)
  const originalBinding = await ctx.binding()
  await ctx.writeToken({ ...await ctx.token(), accessToken: 'SYNTHETIC_OPAQUE_NEXT', refreshToken: 'SYNTHETIC_OPAQUE_ROTATED' })
  await denied(readKiroInstanceAccountUpdate({ ...ctx.input, verifyIdentity: async () => {
    await ctx.writeToken({ ...await ctx.token(), accessToken: 'SYNTHETIC_OPAQUE_ANOTHER' })
    return { userId: account.userId! }
  } }))
  assert.deepEqual(await ctx.binding(), originalBinding)
})

test('unchanged opaque refresh token permits access-token renewal but not changed provider or registration', options, async t => {
  const account = social()
  account.credentials.accessToken = 'SYNTHETIC_OPAQUE_ACCESS'
  const ctx = await fixture(t, account)
  await prepareKiroInstanceAccount(ctx.input)
  await ctx.writeToken({ ...await ctx.token(), accessToken: 'SYNTHETIC_OPAQUE_NEW' })
  assert.equal((await readKiroInstanceAccountUpdate(ctx.input))?.credentials.accessToken, 'SYNTHETIC_OPAQUE_NEW')
  await ctx.writeToken({ ...await ctx.token(), provider: 'Google' })
  await denied(readKiroInstanceAccountUpdate(ctx.input))
})

test('a missing login cache after binding requires explicit recovery instead of silently re-seeding', options, async t => {
  const ctx = await fixture(t)
  await prepareKiroInstanceAccount(ctx.input)
  await fs.unlink(ctx.tokenPath)
  await denied(prepareKiroInstanceAccount(ctx.input))
  assert.deepEqual(await ctx.readCache(), [])
})

test('junctions and hard-linked credential files are rejected without traversing or overwriting them', options, async t => {
  const ctx = await fixture(t)
  await prepareKiroInstanceAccount(ctx.input)
  const link = win32.join(ctx.cache, 'synthetic-hardlink.json')
  await fs.link(ctx.tokenPath, link)
  await denied(readKiroInstanceAccountUpdate(ctx.input))
  await fs.unlink(link)
  const relocated = win32.join(ctx.record.paths.root, 'synthetic-relocated-cache')
  await fs.rename(ctx.cache, relocated)
  await fs.symlink(relocated, ctx.cache, 'junction')
  await denied(readKiroInstanceAccountUpdate(ctx.input))
})

test('concurrent prepares serialize to one consistent binding and leave no temporary credential files', options, async t => {
  const ctx = await fixture(t)
  const results = await Promise.all([prepareKiroInstanceAccount(ctx.input), prepareKiroInstanceAccount(ctx.input)])
  assert.deepEqual(results.map(result => result.source), ['manager', 'instance'])
  assert.deepEqual(await ctx.readCache(), ['kiro-auth-token.json'])
  assert.doesNotMatch((await fs.readdir(ctx.record.paths.root)).join(','), /kiro-write-/)
})
