import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createCliAccessAdapter } from '../../src/main/cliAccessAdapter'
import { createCrewAccessAdapter } from '../../src/main/crewAccessAdapter'
import { ClientAccessProjectionService, type ManagerAccessSnapshot } from '../../src/main/clientAccessProjection'
import { ClientSwitchService, type ClientSwitchRuntime } from '../../src/main/clientSwitch'
import type { ExternalClientTarget } from '../../src/shared/clientSwitch'

const now = 1_800_000_000_000
const access = (): ManagerAccessSnapshot => ({
  accessToken: 'SYNTHETIC_PRIVATE_ACCESS', expiresAt: now + 3_600_000,
  provider: 'Google', authMethod: 'social', profileArn: 'SYNTHETIC_PRIVATE_PROFILE',
  region: 'us-east-1', principalId: 'SYNTHETIC_PRIVATE_SUBJECT'
})

function fixture(account: ManagerAccessSnapshot) {
  const directory = fileURLToPath(new URL('../../../.local/isolated/diagnostics-never-created/', import.meta.url))
  const counters = { reads: 0, writes: 0, runs: 0, processes: 0 }
  const adapters = {
    cli: createCliAccessAdapter({ databasePath: join(directory, 'data.sqlite3'), authDomainId: 'cli' }),
    crew: createCrewAccessAdapter({ dataHome: join(directory, 'crew'), pythonExecutable: join(directory, 'python.exe'),
      helperPath: join(directory, 'helper.py'), authDomainId: 'crew' }, { run: () => { counters.runs++; throw new Error('must not run') } })
  }
  const runtimes = new Map<ExternalClientTarget, ClientSwitchRuntime>()
  for (const target of ['cli', 'crew'] as const) {
    const adapter = adapters[target]
    adapter.readRevision = async () => { counters.reads++; return 'synthetic-revision' }
    adapter.write = async () => { counters.writes++; return 'synthetic-write' }
    runtimes.set(target, { target, id: target, revision: 'synthetic-runtime', version: 'synthetic', adapter,
      isRunning: async () => { counters.processes++; return false } })
  }
  const projection = new ClientAccessProjectionService({ account: () => account,
    adapter: id => runtimes.get(id as ExternalClientTarget)?.adapter,
    readBindings: () => [], writeBinding: () => true, now: () => now })
  const service = new ClientSwitchService({ account: () => account, runtime: async target => runtimes.get(target),
    projection, bindings: () => [], beginOperation: () => () => {}, now: () => now })
  return { account, service, projection, counters, adapters }
}

const cases: Array<{ name: string; patch: Partial<ManagerAccessSnapshot>; issue: string; text: RegExp; targets?: ExternalClientTarget[] }> = [
  { name: 'missing Social profile', patch: { profileArn: undefined }, issue: 'profile-missing', text: /profile/ },
  { name: 'malformed profile', patch: { profileArn: ' \0 ' }, issue: 'profile-invalid', text: /profile/ },
  { name: 'malformed region', patch: { region: 'SYNTHETIC_PRIVATE_REGION' }, issue: 'region-invalid', text: /区域/ },
  { name: 'unsupported provider', patch: { provider: 'SYNTHETIC_PRIVATE_PROVIDER' }, issue: 'provider-unsupported', text: /提供商/ },
  { name: 'mismatched auth method', patch: { authMethod: 'IdC' }, issue: 'auth-method-mismatch', text: /认证方式/ },
  { name: 'missing IdC region', patch: { provider: 'BuilderId', authMethod: 'IdC', region: undefined }, issue: 'region-missing', text: /区域/, targets: ['cli'] },
  { name: 'missing Enterprise URL', patch: { provider: 'Enterprise', authMethod: 'IdC' }, issue: 'start-url-missing', text: /组织登录地址/, targets: ['cli'] },
  { name: 'invalid Enterprise URL', patch: { provider: 'Enterprise', authMethod: 'IdC', startUrl: 'https://synthetic-private.invalid/start' },
    issue: 'start-url-invalid', text: /组织登录地址/, targets: ['cli'] }
]

for (const sample of cases) test(`real adapters identify ${sample.name} through inspect and execute before target IO`, async () => {
  const f = fixture({ ...access(), ...sample.patch })
  const snapshot = await f.service.inspect('synthetic-account')
  for (const target of sample.targets ?? ['cli', 'crew']) {
    const capability = snapshot.targets.find(item => item.target === target)!
    assert.equal(capability.status, 'blocked')
    assert.equal(capability.errorCode, sample.issue)
    assert.match(capability.message, sample.text)
    assert.ok(capability.messageEn)
    if (f.account.provider === 'Google') assert.doesNotMatch(capability.message, /组织登录地址/)
    const result = await f.service.execute({ operationId: `synthetic-${target}`, accountId: 'synthetic-account', target })
    assert.equal(result.errorCode, sample.issue)
    assert.equal(result.credentialWrite, 'not-started')
    assert.equal(result.message, capability.message)
    for (const secret of ['SYNTHETIC_PRIVATE_', 'synthetic-private.invalid']) assert.equal(JSON.stringify({ capability, result }).includes(secret), false)
    const projected = await f.projection.execute({ accountId: 'synthetic-account', runtimeId: target, authDomainId: target })
    assert.equal(projected.reason, 'credential-unusable')
    assert.equal(projected.validationIssue, sample.issue)
    assert.equal(projected.targetCommitted, false)
  }
  assert.equal(f.counters.reads, 0)
  assert.equal(f.counters.writes, 0)
  assert.equal(f.counters.runs, 0)
})

test('conflicting manager metadata is diagnosed before identity or target inspection and never projected', async () => {
  const f = fixture(Object.assign(access(), { validationIssue: 'metadata-conflict' }))
  const snapshot = await f.service.inspect('synthetic-account')
  for (const capability of snapshot.targets) {
    assert.equal(capability.status, 'blocked')
    assert.equal(capability.errorCode, 'metadata-conflict')
    assert.match(capability.message, /冲突/)
  }
  const result = await f.projection.execute({ accountId: 'synthetic-account', runtimeId: 'cli', authDomainId: 'cli' })
  assert.equal(result.targetCommitted, false)
  assert.equal(result.reason, 'credential-unusable')
  assert.deepEqual(f.counters, { reads: 0, writes: 0, runs: 0, processes: 0 })
})

test('arbitrary adapter errors and inherited names cannot become diagnostics or expose values', async () => {
  for (const error of [new Error('SYNTHETIC_PRIVATE_ERROR'), Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), { validationIssue: 'profile-missing' })]) {
    const f = fixture(access())
    for (const adapter of Object.values(f.adapters)) adapter.validate = () => { throw error }
    const snapshot = await f.service.inspect('synthetic-account')
    for (const capability of snapshot.targets) {
      assert.equal(capability.errorCode, 'credential-unusable')
      assert.doesNotMatch(capability.message, /SYNTHETIC_PRIVATE|组织登录地址/)
    }
  }
  const f = fixture(Object.assign(access(), { validationIssue: 'toString' }))
  const snapshot = await f.service.inspect('synthetic-account')
  assert.ok(snapshot.targets.every(item => item.status === 'blocked' && item.errorCode === 'credential-unusable'))
  assert.equal(JSON.stringify(snapshot).includes('toString'), false)
  assert.deepEqual(f.counters, { reads: 0, writes: 0, runs: 0, processes: 0 })
})

test('valid Google and Github profiles remain ready without an organization URL', async () => {
  for (const provider of ['Google', 'Github']) {
    const f = fixture({ ...access(), provider })
    const snapshot = await f.service.inspect('synthetic-account')
    assert.ok(snapshot.targets.every(item => item.status === 'ready' && item.errorCode === undefined))
    assert.equal(f.counters.writes, 0)
    assert.equal(f.counters.runs, 0)
  }
})
