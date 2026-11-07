import test from 'node:test'
import assert from 'node:assert/strict'
import { toAccountModel } from '../../src/shared/modelCatalog.ts'
import { buildControlPlaneRequest } from '../../src/main/kiroControlPlane.ts'
import { KiroModelPreferencesService, type ModelPreferenceAccount } from '../../src/main/kiroModelPreferences.ts'
import { getStoredFallbackChain, isUsableFallbackTarget, validateFallbackChain } from '../../src/shared/modelPreferences.ts'
import { filterAvailableModels } from '../../src/shared/modelCatalog.ts'

const identity = { accessToken: 'SYNTHETIC_ACCESS', provider: 'Google', authMethod: 'social' }

test('account model projection preserves consent metadata without changing inference availability', () => {
  const projected = toAccountModel({ modelId: 'SYNTHETIC_MODEL', modelName: 'Synthetic', description: '', consentStatus: 'SYNTHETIC_UNKNOWN_STATE' } as Parameters<typeof toAccountModel>[0])
  assert.equal((projected as unknown as { consentStatus?: string }).consentStatus, 'SYNTHETIC_UNKNOWN_STATE')
  assert.equal(filterAvailableModels([{ modelId: 'SYNTHETIC_MODEL', modelName: 'Synthetic', description: '', consentStatus: 'SYNTHETIC_UNKNOWN_STATE' }]).length, 1)
})

function fixture() {
  let now = 1000000
  let account: ModelPreferenceAccount = { id: 'synthetic-account', idp: 'Google', credentials: { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', provider: 'Google', authMethod: 'social', expiresAt: now + 3600000 } }
  let catalog = ['primary', 'fallback', 'other'].map(modelId => ({ modelId, modelName: modelId, description: '' })) as Parameters<typeof toAccountModel>[0][]
  let chains: Record<string, Array<{ modelId: string }>> = {}
  let response: unknown = { batchResult: { successfulPreferences: [{ preferenceType: 'MODEL_FALLBACKS', modelId: 'primary' }] } }
  let beforeModels: (() => Promise<void>) | undefined
  let beforeRead: (() => Promise<void>) | undefined
  let beforeWrite: (() => Promise<void>) | undefined
  let readbackOverride: unknown
  let blocked = false
  let leases = 0
  const calls: Array<{ operation: string; token: string; input: Record<string, unknown> }> = []
  const service = new KiroModelPreferencesService({
    account: id => id === account.id ? account : undefined,
    beginOperation: () => { if (blocked) throw new Error('SYNTHETIC_BOUND'); leases++; return () => { leases-- } },
    now: () => now,
    models: async () => { await beforeModels?.(); return catalog },
    request: async (selected, operation, input) => {
      calls.push({ operation, token: selected.accessToken, input })
      if (operation === 'SetUserPreference') {
        await beforeWrite?.()
        chains = { ...chains, [String(input.targetModelId)]: (input.chain as string[]).map(modelId => ({ modelId })) }
        return response
      }
      await beforeRead?.()
      return readbackOverride ?? { modelFallbacks: { perModel: chains } }
    }
  })
  return { service, calls, get leases() { return leases }, rotate: () => { account = { ...account, credentials: { ...account.credentials, accessToken: 'SYNTHETIC_ROTATED' } } },
    block: () => { blocked = true }, expire: () => { now += 4000000 }, setResponse: (value: unknown) => { response = value },
    setCatalog: (value: typeof catalog) => { catalog = value }, beforeModels: (action: () => Promise<void>) => { beforeModels = action }, beforeRead: (action: () => Promise<void>) => { beforeRead = action }, beforeWrite: (action: () => Promise<void>) => { beforeWrite = action }, setReadback: (value: unknown) => { readbackOverride = value } }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('fallback eligibility follows field absence and never assumes consent enum semantics', () => {
  const models = ['primary', 'fallback', 'other'].map(id => toAccountModel({ modelId: id, modelName: id, description: '' }))
  assert.deepEqual(validateFallbackChain(models, 'primary', ['fallback']), ['fallback'])
  for (const consentStatus of [null, '', 'ACCEPTED', 'SYNTHETIC_NEW_STATUS']) {
    assert.equal(isUsableFallbackTarget({ consentStatus }), false)
    assert.throws(() => validateFallbackChain([models[0], { ...models[1], consentStatus }], 'primary', ['fallback']))
  }
  for (const chain of [['primary'], ['missing'], ['fallback', 'fallback'], ['fallback', 'other'], null]) assert.throws(() => validateFallbackChain(models, 'primary', chain))
  assert.deepEqual(getStoredFallbackChain({}, 'constructor'), [])
  assert.deepEqual(getStoredFallbackChain({ ['__proto__']: ['fallback'] }, '__proto__'), ['fallback'])
})

test('explicit account read and confirmed save round trip use no refresh and issue new revisions', async () => {
  const f = fixture()
  const read = await f.service.read('synthetic-account')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].operation, 'GetUserPreference')
  assert.deepEqual(Object.keys(read.chains), [])
  assert.equal(f.leases, 0)
  const saved = await f.service.save({ accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] })
  assert.deepEqual(saved.chains.primary, ['fallback'])
  assert.notEqual(read.revision, saved.revision)
  assert.deepEqual(f.calls.map(call => call.operation), ['GetUserPreference', 'SetUserPreference', 'GetUserPreference'])
  assert.equal(JSON.stringify(saved).includes('SYNTHETIC_ACCESS'), false)
  const cleared = await f.service.save({ accountId: read.accountId, revision: saved.revision, targetModelId: 'primary', chain: [] })
  assert.deepEqual(cleared.chains.primary, [])
  assert.equal(f.leases, 0)
})

test('bound, expired, rotated, mismatched revision and duplicate writes cannot mutate preferences', async () => {
  const f = fixture()
  const read = await f.service.read('synthetic-account')
  const write = { accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] }
  await assert.rejects(f.service.save({ ...write, revision: 'unrelated-revision' }))
  await assert.rejects(f.service.save({ ...write, accountId: 'another-account' }))
  f.rotate()
  await assert.rejects(f.service.save(write))
  assert.equal(f.calls.filter(call => call.operation === 'SetUserPreference').length, 0)
  const bound = fixture(); bound.block()
  await assert.rejects(bound.service.read('synthetic-account'), /SYNTHETIC_BOUND/)
  assert.equal(bound.calls.length, 0)
  const expired = fixture(); expired.expire()
  await assert.rejects(expired.service.read('synthetic-account'))
  assert.equal(expired.calls.length, 0)
})

test('fresh catalog validation rejects consent changes before sending a write', async () => {
  const f = fixture()
  const read = await f.service.read('synthetic-account')
  f.setCatalog([{ modelId: 'primary', modelName: 'primary', description: '' }, { modelId: 'fallback', modelName: 'fallback', description: '', consentStatus: 'ACCEPTED' }])
  await assert.rejects(f.service.save({ accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] }))
  assert.equal(f.calls.filter(call => call.operation === 'SetUserPreference').length, 0)
  assert.equal(f.leases, 0)
})

test('HTTP success without exact batch confirmation is not a successful preference save', async () => {
  for (const response of [{}, { batchResult: { successfulPreferences: [] } }, { batchResult: { successfulPreferences: [{ preferenceType: 'MODEL_FALLBACKS', modelId: 'different-model' }] } }, { batchResult: { successfulPreferences: [{ preferenceType: 'MODEL_FALLBACKS', modelId: 'primary' }], errors: [{ message: 'SYNTHETIC_PRIVATE' }] } }]) {
    const f = fixture()
    const read = await f.service.read('synthetic-account')
    f.setResponse(response)
    const write = { accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] }
    await assert.rejects(f.service.save(write), error => !String(error).includes('SYNTHETIC_PRIVATE'))
    await assert.rejects(f.service.save(write))
    assert.equal(f.calls.filter(call => call.operation === 'SetUserPreference').length, 1)
    assert.equal(f.leases, 0)
  }
})

test('a confirmed write without matching readback is not reported as saved or automatically replayed', async () => {
  const f = fixture()
  const read = await f.service.read('synthetic-account')
  f.setReadback({ modelFallbacks: { perModel: { primary: [{ modelId: 'other' }] } } })
  const write = { accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] }
  await assert.rejects(f.service.save(write), /读取结果尚未一致/)
  await assert.rejects(f.service.save(write))
  assert.deepEqual(f.calls.map(call => call.operation), ['GetUserPreference', 'SetUserPreference', 'GetUserPreference'])
})

test('late reads and writes cannot report success after credential generation changes', async () => {
  const f = fixture(), reading = deferred()
  f.beforeModels(() => reading.promise)
  const pendingRead = f.service.read('synthetic-account')
  f.rotate(); reading.resolve()
  await assert.rejects(pendingRead)
  assert.equal(f.leases, 0)
  const w = fixture(), writeGate = deferred()
  const read = await w.service.read('synthetic-account')
  w.beforeWrite(() => writeGate.promise)
  const pendingWrite = w.service.save({ accountId: read.accountId, revision: read.revision, targetModelId: 'primary', chain: ['fallback'] })
  while (!w.calls.some(call => call.operation === 'SetUserPreference')) await Promise.resolve()
  w.rotate(); writeGate.resolve()
  await assert.rejects(pendingWrite)
  assert.equal(w.calls.filter(call => call.operation === 'GetUserPreference').length, 1)
  assert.equal(w.leases, 0)
})

test('a new read invalidates old editor grants and overlapping reads only expose the newest snapshot', async () => {
  const f = fixture()
  const old = await f.service.read('synthetic-account')
  const gate = deferred()
  f.beforeModels(() => gate.promise)
  const first = f.service.read('synthetic-account')
  const second = f.service.read('synthetic-account')
  await assert.rejects(f.service.save({ accountId: old.accountId, revision: old.revision, targetModelId: 'primary', chain: [] }))
  gate.resolve()
  await assert.rejects(first)
  assert.equal((await second).accountId, 'synthetic-account')
  assert.equal(f.leases, 0)
})

test('a failed preference read holds the instance ownership lease until its concurrent catalog fetch settles', async () => {
  const f = fixture(), catalog = deferred()
  f.beforeModels(() => catalog.promise)
  f.beforeRead(async () => { throw new Error('synthetic preference failure') })
  const settled = assert.rejects(f.service.read('synthetic-account'), /synthetic preference failure/)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.leases, 1)
  } finally {
    catalog.resolve()
    await settled
  }
  assert.equal(f.leases, 0)
})

test('model preference RPCs serialize the verified filter and per-model chain only', () => {
  const read = buildControlPlaneRequest(identity, 'GetUserPreference' as Parameters<typeof buildControlPlaneRequest>[1], { refreshToken: 'NEVER_SEND', origin: 'UNTRUSTED' })
  assert.equal(read.headers['x-amz-target'], 'KiroControlPlaneBearerService.GetUserPreference')
  assert.deepEqual(JSON.parse(read.body), { profileArn: JSON.parse(buildControlPlaneRequest(identity, 'GetUsageLimits', {}).body).profileArn, filter: ['MODEL_FALLBACKS'] })
  const write = buildControlPlaneRequest(identity, 'SetUserPreference' as Parameters<typeof buildControlPlaneRequest>[1], { targetModelId: 'synthetic-primary', chain: ['synthetic-fallback'], origin: 'NEVER_SEND' })
  assert.deepEqual(JSON.parse(write.body).modelFallbacks, { perModel: { 'synthetic-primary': [{ modelId: 'synthetic-fallback' }] } })
  assert.equal(JSON.parse(write.body).origin, undefined)
  assert.throws(() => buildControlPlaneRequest(identity, 'SetUserPreference', { targetModelId: 'synthetic-primary', chain: ['first', 'second'] }))
})
