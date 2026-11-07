import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCrewAccessAdapter, readCrewAccessRevision, type CrewAccessAdapterOptions } from '../../src/main/crewAccessAdapter'
import { ClientAccessProjectionError, accessPrincipalFingerprint, type AccessCredential } from '../../src/main/clientAccessProjection'

const helperPath = fileURLToPath(new URL('../../resources/client-switch/crew-access.py', import.meta.url))
const root = fileURLToPath(new URL('../../../.local/isolated/', import.meta.url))
const principalA = 'synthetic-stable-user-a'
const principalB = 'synthetic-stable-user-b'
const context = { accountId: 'synthetic-account', runtimeId: 'synthetic-crew', explicit: true,
  principalFingerprint: accessPrincipalFingerprint({ provider: 'Github', principalId: principalA })! }
const token = (): AccessCredential => ({ accessToken: 'SYNTHETIC_ACCESS_ONLY', expiresAt: Date.now() + 3_600_000,
  provider: 'Github', authMethod: 'social', profileArn: 'SYNTHETIC_PROFILE_ARN', region: 'us-east-1' })
const revision = 'a'.repeat(64)

function fixture(t: TestContext): { directory: string; options: CrewAccessAdapterOptions } {
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'crew-access-adapter-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, options: { pythonExecutable: join(directory, 'python.exe'), helperPath,
    dataHome: join(directory, 'data'), authDomainId: 'synthetic-auth-domain' } }
}

test('revision preflight does not create a missing Crew data home or decrypt its files', async t => {
  const { options } = fixture(t)
  const adapter = createCrewAccessAdapter(options, { run: () => { throw new Error('must not execute Python for read') } })
  assert.match(await adapter.readRevision(), /^[a-f0-9]{64}$/)
  assert.equal(existsSync(options.dataHome), false)
})

test('revision covers vault ciphertext, key and both sign-in/out generations', t => {
  const { options } = fixture(t)
  const seen = new Set([readCrewAccessRevision(options.dataHome)])
  for (const path of ['kas/.vault/secrets.enc', 'kas/.vault/.vault_key', 'kas/signed-in', 'kas/signed-out']) {
    const destination = join(options.dataHome, path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, `SYNTHETIC_${path}`)
    const next = readCrewAccessRevision(options.dataHome)
    assert.equal(seen.has(next), false)
    seen.add(next)
  }
})

test('revision refuses a directory at a credential-file location', t => {
  const { options } = fixture(t)
  mkdirSync(join(options.dataHome, 'kas', 'signed-in'), { recursive: true })
  assert.throws(() => readCrewAccessRevision(options.dataHome), { code: 'target-read-failed' })
})

test('revision follows the effective engine selection but ignores unrelated configuration changes', t => {
  const { options } = fixture(t)
  mkdirSync(options.dataHome, { recursive: true })
  const initial = readCrewAccessRevision(options.dataHome)
  writeFileSync(join(options.dataHome, 'config.json'), JSON.stringify({ ui: { theme: 'dark' }, agent: { provider: 'acp', acp_backend: 'kas' } }))
  assert.equal(readCrewAccessRevision(options.dataHome), initial)
  writeFileSync(join(options.dataHome, 'config.local.json'), JSON.stringify({ agent: { kas_bundle: true }, ui: { theme: 'light' } }))
  const bundled = readCrewAccessRevision(options.dataHome)
  assert.notEqual(bundled, initial)
  writeFileSync(join(options.dataHome, 'config.json'), JSON.stringify({ ui: { theme: 'other' }, agent: { kas_bundle: false } }))
  assert.equal(readCrewAccessRevision(options.dataHome), bundled, 'overlay wins; unrelated or overridden changes are not new engine semantics')
  writeFileSync(join(options.dataHome, 'config.local.json'), JSON.stringify({ agent: { provider: 'other', kas_bundle: true } }))
  assert.notEqual(readCrewAccessRevision(options.dataHome), bundled)
})

test('malformed base or overlay config fails preflight rather than treating it as defaults', t => {
  const { options } = fixture(t)
  mkdirSync(options.dataHome, { recursive: true })
  for (const name of ['config.json', 'config.local.json']) {
    for (const malformed of ['{', '[]', 'null', '{"agent":null}', '{"agent":{"kas_bundle":"false"}}']) {
      writeFileSync(join(options.dataHome, name), malformed)
      assert.throws(() => readCrewAccessRevision(options.dataHome), { code: 'target-read-failed' })
      assert.equal(readFileSync(join(options.dataHome, name), 'utf8'), malformed)
    }
    rmSync(join(options.dataHome, name))
  }
})

test('write sends access-only stdin to isolated official Python with hidden window and bounded timeout', async t => {
  const { options } = fixture(t)
  let guarded = false
  const access = token()
  const adapter = createCrewAccessAdapter(options, { run: (executable, args, config) => {
    assert.equal(guarded, true)
    assert.equal(executable, options.pythonExecutable)
    assert.deepEqual(args, ['-I', '-B', helperPath])
    assert.equal(args.join(' ').includes(access.accessToken), false)
    assert.equal(config.windowsHide, true)
    assert.equal(config.timeout, 5000)
    assert.deepEqual(config.stdio, ['pipe', 'pipe', 'pipe'])
    const input = JSON.parse(String(config.input))
    assert.deepEqual(input.access, access)
    assert.equal(input.accountIdentity, context.principalFingerprint)
    assert.equal(input.accountIdentity.includes(context.accountId), false)
    assert.equal(input.access.principalId, undefined)
    assert.equal(String(config.input).includes(principalA), false)
    assert.equal(input.expectedRevision, revision)
    assert.equal(input.explicit, true)
    return JSON.stringify({ ok: true, revision: 'b'.repeat(64) })
  } })
  assert.equal(await adapter.write(access, revision, () => { guarded = true }, context), 'b'.repeat(64))
})

test('Crew helper identity comes from stable provider principal rather than the mutable manager record id', async t => {
  const { options } = fixture(t)
  const identities: string[] = []
  const adapter = createCrewAccessAdapter(options, { run: (_executable, _args, config) => {
    const input = JSON.parse(String(config.input))
    identities.push(input.accountIdentity)
    assert.equal(input.access.principalId, undefined)
    assert.equal(String(config.input).includes(principalA), false)
    assert.equal(String(config.input).includes(principalB), false)
    return JSON.stringify({ ok: true, revision: 'b'.repeat(64) })
  } })
  await adapter.write(token(), revision, () => {}, context)
  await adapter.write(token(), revision, () => {}, { ...context, accountId: 'renamed-manager-record' })
  await adapter.write(token(), revision, () => {}, { ...context,
    principalFingerprint: accessPrincipalFingerprint({ provider: 'Github', principalId: principalB })! })
  assert.equal(identities[0], identities[1], 'renaming the manager record does not create a different upstream identity')
  assert.notEqual(identities[0], identities[2], 'a different real subject must not inherit the previous record identity')
})

test('Crew accepts organization metadata but does not forward startUrl to KasToken helper input', async t => {
  const { options } = fixture(t)
  const access = { ...token(), provider: 'Enterprise', authMethod: 'IdC',
    startUrl: 'https://synthetic-team.awsapps.com/start', profileArn: 'SYNTHETIC_ENTERPRISE_PROFILE' }
  let invoked = false
  const adapter = createCrewAccessAdapter(options, { run: (_executable, _args, config) => {
    invoked = true
    const input = JSON.parse(String(config.input))
    assert.equal(input.access.provider, 'Enterprise')
    assert.equal(input.access.profileArn, access.profileArn)
    assert.equal(Object.hasOwn(input.access, 'startUrl'), false)
    assert.equal(Object.hasOwn(input.access, 'start_url'), false)
    assert.equal(Object.hasOwn(input.access, 'refreshToken'), false)
    return JSON.stringify({ ok: true, revision: 'b'.repeat(64) })
  } })
  await adapter.write(access, revision, () => {}, { ...context,
    principalFingerprint: accessPrincipalFingerprint({ provider: access.provider, principalId: principalA, profileArn: access.profileArn })! })
  assert.equal(invoked, true)
})

test('manager commit guard refusal prevents running the helper', async t => {
  const { options } = fixture(t)
  let invoked = false
  const adapter = createCrewAccessAdapter(options, { run: () => { invoked = true; return '' } })
  await assert.rejects(adapter.write(token(), revision, () => { throw new ClientAccessProjectionError('credential-changed') }, context),
    { code: 'credential-changed' })
  assert.equal(invoked, false)
})

test('adapter rejects refresh/client-secret fields, unsupported providers and absent social profiles', async t => {
  const { options } = fixture(t)
  let invoked = false
  const adapter = createCrewAccessAdapter(options, { run: () => { invoked = true; return '' } })
  for (const access of [
    { ...token(), refreshToken: 'SYNTHETIC_DO_NOT_SEND' },
    { ...token(), clientSecret: 'SYNTHETIC_DO_NOT_SEND' },
    { ...token(), principalId: principalA },
    { ...token(), provider: 'Unverified' },
    { ...token(), region: 'not/a/region' },
    { ...token(), profileArn: undefined },
    { ...token(), authMethod: 'IdC' }
  ]) await assert.rejects(adapter.write(access, revision, () => {}, context), { code: 'credential-unusable' })
  assert.equal(invoked, false)
})

test('helper target-CAS refusal stops projection and child errors never expose transport output', async t => {
  const { options } = fixture(t)
  const adapter = createCrewAccessAdapter(options, { run: () => JSON.stringify({ ok: false, error: 'target-changed' }) })
  await assert.rejects(adapter.write(token(), revision, () => {}, context), { code: 'target-changed' })
  const configuredOnly = createCrewAccessAdapter(options, { run: () => JSON.stringify({ ok: false, error: 'write-failed', backendConfigured: true, writeUncertain: false }) })
  await assert.rejects(configuredOnly.write(token(), revision, () => {}, context), { code: 'target-write-failed', backendConfigured: true })
  const broken = createCrewAccessAdapter(options, { run: () => { throw new Error('SYNTHETIC_SECRET_FROM_CHILD') } })
  try { await broken.write(token(), revision, () => {}, context); assert.fail('expected refusal') }
  catch (error) {
    assert.equal((error as ClientAccessProjectionError).code, 'target-write-uncertain')
    assert.equal(String(error).includes('SECRET_FROM_CHILD'), false)
  }
})

test('malformed helper responses are never treated as successful writes', async t => {
  const { options } = fixture(t)
  for (const response of ['garbage', 'null', '{}', '{"ok":true}', '{"ok":true,"revision":"not-a-revision"}']) {
    const adapter = createCrewAccessAdapter(options, { run: () => response })
    await assert.rejects(adapter.write(token(), revision, () => {}, context), { code: 'target-write-uncertain', targetWriteUncertain: true })
  }
})

test('partial auth writes and helper timeouts are uncertain, never a known not-started failure', async t => {
  const { options } = fixture(t)
  for (const response of [
    { ok: false, error: 'write-failed', writeUncertain: true, backendConfigured: true },
    { ok: false, error: 'target-changed', writeUncertain: true },
    { ok: false, error: 'write-failed' }
  ]) {
    const adapter = createCrewAccessAdapter(options, { run: () => JSON.stringify(response) })
    await assert.rejects(adapter.write(token(), revision, () => {}, context), {
      code: 'target-write-uncertain', targetWriteUncertain: true, backendConfigured: response.backendConfigured === true
    })
  }
  const timeout = createCrewAccessAdapter(options, { run: () => {
    throw Object.assign(new Error('SYNTHETIC_TOKEN_IN_CHILD_ERROR'), {
      code: 'ETIMEDOUT', stdout: 'SYNTHETIC_PRIVATE_STDOUT', stderr: 'SYNTHETIC_PRIVATE_STDERR'
    })
  } })
  try { await timeout.write(token(), revision, () => {}, context); assert.fail('expected uncertain result') }
  catch (error) {
    assert.equal((error as ClientAccessProjectionError).code, 'target-write-uncertain')
    assert.equal((error as { targetWriteUncertain?: boolean }).targetWriteUncertain, true)
    assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_TOKEN|PRIVATE_STD/)
  }
})

test('configuration bounds the synchronous commit helper to five seconds and absolute paths', t => {
  const { options } = fixture(t)
  for (const timeoutMs of [0, 99, 5001, Infinity, NaN]) assert.throws(() => createCrewAccessAdapter({ ...options, timeoutMs }))
  assert.throws(() => createCrewAccessAdapter({ ...options, dataHome: 'relative' }))
  assert.throws(() => createCrewAccessAdapter({ ...options, pythonExecutable: 'python' }))
})

// Opt-in local integration uses the actual unpacked, signed Crew distribution. No downloads,
// account libraries, or real user data are accessed; CI still exercises all adapter contracts.
const officialPython = process.env.KIRO_CREW_TEST_PYTHON

interface MultiSlotObservation {
  provider: string
  resolvedA: boolean
  resolvedB: boolean
  socialMarkerMatches: boolean
  otherSlotsEmpty: boolean
}

async function multiSlotFixture(t: TestContext): Promise<{
  options: ReturnType<typeof fixture>['options']
  adapter: ReturnType<typeof createCrewAccessAdapter>
  signedIn: string
  signedOut: string
  inspect: (insertBuilder?: boolean) => MultiSlotObservation
}> {
  const { options } = fixture(t)
  options.pythonExecutable = officialPython!
  const adapter = createCrewAccessAdapter(options)
  await adapter.write(token(), await adapter.readRevision(), () => {}, context)
  const signedIn = readFileSync(join(options.dataHome, 'kas', 'signed-in'), 'utf8')
  const signedOut = readFileSync(join(options.dataHome, 'kas', 'signed-out'), 'utf8')
  const script = [
    'import asyncio,json,sys',
    'from datetime import datetime,timedelta,timezone',
    'from kiro_crew.auth.store import TokenStore,KasToken,KNOWN_IDENTITIES',
    'from kiro_crew.auth.provider import KasAuthProvider',
    'import kiro_crew.auth.refresh as refresh',
    'async def forbidden_request(*args,**kwargs):',
    '    raise AssertionError("Synthetic multi-slot test must never perform network refresh")',
    'refresh._request=forbidden_request',
    'data=json.loads(sys.stdin.read());store=TokenStore(data["home"])',
    'if data["insertBuilder"]:',
    '    other=KasToken(access_token="SYNTHETIC_HIGH_PRIORITY_BUILDER_B",expires_at=datetime.now(timezone.utc)+timedelta(hours=1),provider="BuilderId",identity="builder_id",region="us-east-1",auth_method="IdC",extra={"manager_account_identity":data["builderPrincipal"]})',
    '    store.save(other)',
    'current=asyncio.run(KasAuthProvider(store,allow_env_api_key=False).current())',
    'social=store.load("social")',
    'print(json.dumps({"provider":current.provider,"resolvedA":current.access_token=="SYNTHETIC_ACCESS_ONLY","resolvedB":current.access_token=="SYNTHETIC_HIGH_PRIORITY_BUILDER_B","socialMarkerMatches":social is not None and social.extra.get("manager_account_identity")==data["socialPrincipal"],"otherSlotsEmpty":all(store.load(identity) is None for identity in KNOWN_IDENTITIES if identity!="social")}))'
  ].join('\n')
  const inspect = (insertBuilder = false): MultiSlotObservation => JSON.parse(execFileSync(officialPython!, ['-I', '-B', '-c', script], {
    input: JSON.stringify({ home: options.dataHome, insertBuilder, socialPrincipal: context.principalFingerprint,
      builderPrincipal: accessPrincipalFingerprint({ provider: 'BuilderId', principalId: principalB })! }),
    encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, KIROCREW_HOME: options.dataHome }
  }))
  assert.deepEqual(inspect(true), { provider: 'BuilderId', resolvedA: false, resolvedB: true, socialMarkerMatches: true, otherSlotsEmpty: false },
    'the actual official provider must choose the higher-priority Builder B while the previous Social A marker still exists')
  return { options, adapter, signedIn, signedOut, inspect }
}

test('official multi-slot explicit reselection clears competing identities and the provider actually returns selected Social A',
  { skip: !officialPython }, async t => {
    const f = await multiSlotFixture(t)
    await f.adapter.write(token(), await f.adapter.readRevision(), () => {}, context)
    const observed = f.inspect()
    assert.deepEqual(observed, { provider: 'Github', resolvedA: true, resolvedB: false, socialMarkerMatches: true, otherSlotsEmpty: true },
      'a successful explicit switch must make the official provider resolve the selected account, not retain a higher-priority identity')
    assert.notEqual(readFileSync(join(f.options.dataHome, 'kas', 'signed-in'), 'utf8'), f.signedIn)
    assert.notEqual(readFileSync(join(f.options.dataHome, 'kas', 'signed-out'), 'utf8'), f.signedOut)
  })

test('official multi-slot background synchronization refuses competing identities even with a fresh target revision',
  { skip: !officialPython }, async t => {
    const f = await multiSlotFixture(t)
    const before = readFileSync(join(f.options.dataHome, 'kas/.vault/secrets.enc'))
    const currentRevision = await f.adapter.readRevision()
    await assert.rejects(f.adapter.write(token(), currentRevision, () => {}, { ...context, explicit: false }), { code: 'target-changed' })
    assert.deepEqual(readFileSync(join(f.options.dataHome, 'kas/.vault/secrets.enc')), before)
    assert.equal(readFileSync(join(f.options.dataHome, 'kas', 'signed-in'), 'utf8'), f.signedIn)
    assert.equal(readFileSync(join(f.options.dataHome, 'kas', 'signed-out'), 'utf8'), f.signedOut)
    assert.deepEqual(f.inspect(), { provider: 'BuilderId', resolvedA: false, resolvedB: true, socialMarkerMatches: true, otherSlotsEmpty: false })
  })

test('official Crew TokenStore stores usable access-only, preserves generations on rotation and fences account changes',
  { skip: !officialPython }, async t => {
    const { options } = fixture(t)
    options.pythonExecutable = officialPython!
    const adapter = createCrewAccessAdapter(options)
    mkdirSync(options.dataHome, { recursive: true })
    const baseConfig = { agent: { provider: 'acp', acp_backend: 'kas', kas_bundle: false, max_turns: 7 },
      ui: { theme: 'dark' }, custom: { keep: ['SYNTHETIC', { value: 42 }] } }
    const overlay = JSON.stringify({ ui: { theme: 'light' }, agent: { temperature: 0.25 } })
    writeFileSync(join(options.dataHome, 'config.json'), '\uFEFF' + JSON.stringify(baseConfig))
    writeFileSync(join(options.dataHome, 'config.local.json'), overlay)
    const firstAccess = token()
    const firstRevision = await adapter.write(firstAccess, await adapter.readRevision(), () => {}, context)
    assert.equal(firstRevision, await adapter.readRevision())
    assert.deepEqual(JSON.parse(readFileSync(join(options.dataHome, 'config.json'), 'utf8')), {
      ...baseConfig, agent: { ...baseConfig.agent, kas_bundle: true }
    })
    assert.equal(readFileSync(join(options.dataHome, 'config.local.json'), 'utf8'), overlay)
    const signedIn = readFileSync(join(options.dataHome, 'kas', 'signed-in'), 'utf8')
    const signedOut = readFileSync(join(options.dataHome, 'kas', 'signed-out'), 'utf8')
    const rotation = { ...firstAccess, accessToken: 'SYNTHETIC_ACCESS_ROTATION' }
    const secondRevision = await adapter.write(rotation, firstRevision, () => {}, { ...context, explicit: false })
    assert.notEqual(secondRevision, firstRevision)
    assert.equal(readFileSync(join(options.dataHome, 'kas', 'signed-in'), 'utf8'), signedIn)
    assert.equal(readFileSync(join(options.dataHome, 'kas', 'signed-out'), 'utf8'), signedOut)
    await adapter.write({ ...rotation, accessToken: 'SYNTHETIC_OTHER_ACCOUNT' }, secondRevision, () => {},
      { ...context, accountId: 'different-synthetic-account',
        principalFingerprint: accessPrincipalFingerprint({ provider: 'Github', principalId: principalB })! })
    assert.notEqual(readFileSync(join(options.dataHome, 'kas', 'signed-in'), 'utf8'), signedIn)
    assert.notEqual(readFileSync(join(options.dataHome, 'kas', 'signed-out'), 'utf8'), signedOut)
    const inspector = [
      'import json,sys', 'from kiro_crew.auth.store import TokenStore',
      'from kiro_crew.config import KiroCrewConfig',
      's=TokenStore(json.loads(sys.stdin.read())["home"]);t=s.resolve()',
      'cfg=KiroCrewConfig.load()',
      'print(json.dumps({"usable":t.is_usable(),"storable":t.is_storable(),"refreshAbsent":t.refresh_token is None,"secretAbsent":t.client_secret is None,"expected":t.access_token=="SYNTHETIC_OTHER_ACCOUNT","region":t.region,"ownEngine":cfg.agent.kas_bundle and cfg.agent.acp_backend=="kas" and cfg.agent.provider=="acp","otherSlotsEmpty":all(s.load(k) is None for k in ("builder_id","identity_center","external_idp"))}))'
    ].join('\n')
    const checked = JSON.parse(execFileSync(officialPython!, ['-I', '-B', '-c', inspector], {
      input: JSON.stringify({ home: options.dataHome }), encoding: 'utf8', windowsHide: true, timeout: 5000,
      env: { ...process.env, KIROCREW_HOME: options.dataHome }
    }))
    assert.deepEqual(checked, { usable: true, storable: true, refreshAbsent: true, secretAbsent: true, expected: true, region: 'us-east-1', ownEngine: true, otherSlotsEmpty: true })
    await assert.rejects(adapter.write(token(), firstRevision, () => {}, context), { code: 'target-changed' })
    const privateInput = { version: 1, dataHome: options.dataHome, expectedRevision: await adapter.readRevision(),
      accountIdentity: context.principalFingerprint, explicit: true,
      access: { ...token(), refreshToken: 'SYNTHETIC_FORBIDDEN_REFRESH' } }
    const rejected = execFileSync(officialPython!, ['-I', '-B', helperPath], {
      input: JSON.stringify(privateInput), encoding: 'utf8', windowsHide: true, timeout: 5000
    })
    assert.deepEqual(JSON.parse(rejected), { ok: false, error: 'invalid-request', writeUncertain: false })
    assert.equal(rejected.includes('FORBIDDEN_REFRESH'), false)
  })

test('official helper reports uncertainty when a real vault save succeeds and subsequent work throws',
  { skip: !officialPython }, async t => {
    const { options } = fixture(t)
    mkdirSync(options.dataHome, { recursive: true })
    const before = readCrewAccessRevision(options.dataHome)
    const payload = { version: 1, dataHome: options.dataHome, expectedRevision: before,
      accountIdentity: context.principalFingerprint, explicit: true, access: token() }
    const failingAfterSave = [
      'import runpy,sys', 'from kiro_crew.auth.store import TokenStore',
      'original_save=TokenStore.save',
      'def save_then_fail(self,*args,**kwargs):',
      '    original_save(self,*args,**kwargs)',
      '    raise RuntimeError("SYNTHETIC_PRIVATE_AFTER_COMMIT")',
      'TokenStore.save=save_then_fail',
      'runpy.run_path(sys.argv[1],run_name="__main__")'
    ].join('\n')
    const output = execFileSync(officialPython!, ['-I', '-B', '-c', failingAfterSave, helperPath], {
      input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000,
      env: { ...process.env, KIROCREW_HOME: options.dataHome }
    })
    assert.deepEqual(JSON.parse(output), { ok: false, error: 'write-failed', writeUncertain: true, backendConfigured: true })
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE_AFTER_COMMIT|SYNTHETIC_ACCESS/)
    assert.equal(existsSync(join(options.dataHome, 'kas/.vault/secrets.enc')), true)
    assert.notEqual(readCrewAccessRevision(options.dataHome), before)
    assert.equal(JSON.parse(readFileSync(join(options.dataHome, 'config.json'), 'utf8')).agent.kas_bundle, true)
  })

test('official helper never changes the user engine during background sync or overrides an overlay/non-Kiro choice',
  { skip: !officialPython }, async t => {
    const { options } = fixture(t)
    options.pythonExecutable = officialPython!
    const adapter = createCrewAccessAdapter(options)
    const first = await adapter.write(token(), await adapter.readRevision(), () => {}, context)
    const vault = readFileSync(join(options.dataHome, 'kas/.vault/secrets.enc'))
    writeFileSync(join(options.dataHome, 'config.json'), JSON.stringify({ agent: { kas_bundle: false }, keep: 'SYNTHETIC' }))
    await assert.rejects(adapter.write(token(), first, () => {}, { ...context, explicit: false }), { code: 'target-changed' })
    await assert.rejects(adapter.write(token(), await adapter.readRevision(), () => {}, { ...context, explicit: false }), { code: 'target-changed' })
    assert.deepEqual(JSON.parse(readFileSync(join(options.dataHome, 'config.json'), 'utf8')), { agent: { kas_bundle: false }, keep: 'SYNTHETIC' })
    assert.deepEqual(readFileSync(join(options.dataHome, 'kas/.vault/secrets.enc')), vault)
    for (const configuration of [
      { base: { agent: { provider: 'ollama', kas_bundle: true } }, overlay: {} },
      { base: { agent: { kas_bundle: true } }, overlay: { agent: { kas_bundle: false } } },
      { base: { agent: { kas_bundle: true } }, overlay: { agent: { acp_backend: 'claude' } } }
    ]) {
      const baseText = JSON.stringify(configuration.base), overlayText = JSON.stringify(configuration.overlay)
      writeFileSync(join(options.dataHome, 'config.json'), baseText)
      writeFileSync(join(options.dataHome, 'config.local.json'), overlayText)
      await assert.rejects(adapter.write(token(), await adapter.readRevision(), () => {}, context), { code: 'target-write-failed' })
      assert.equal(readFileSync(join(options.dataHome, 'config.json'), 'utf8'), baseText)
      assert.equal(readFileSync(join(options.dataHome, 'config.local.json'), 'utf8'), overlayText)
      assert.deepEqual(readFileSync(join(options.dataHome, 'kas/.vault/secrets.enc')), vault)
    }
  })
