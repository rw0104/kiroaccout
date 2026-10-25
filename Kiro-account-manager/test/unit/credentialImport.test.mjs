import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { parseAccountImportText, isOutcomeBalanced } from '../../src/shared/accountImport.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'
import { executeCredentialImport, formatImportOutcome } from '../../src/renderer/src/utils/accountImport.ts'

const credential = (overrides = {}) => ({
  provider: 'Builder ID', refreshToken: 'SYNTHETIC_REFRESH', clientId: 'SYNTHETIC_CLIENT',
  clientSecret: 'SYNTHETIC_SECRET', ...overrides
})
const response = (input, overrides = {}) => ({ success: true, data: {
  email: 'test@example.invalid', userId: 'synthetic-user', accessToken: 'SYNTHETIC_ACCESS',
  refreshToken: `${input.refreshToken}_rotated`, expiresIn: 120,
  subscriptionType: 'Pro', subscriptionTitle: 'Pro', usage: { current: 1, limit: 10 }, ...overrides
} })
function fixture() {
  const stored = []
  const calls = []
  let saves = 0
  return {
    stored, calls, get saves() { return saves },
    deps: {
      existing: () => stored,
      verify: async input => { calls.push(input); return response(input) },
      add: account => { stored.push({ id: 'synthetic-id', ...account }); return 'synthetic-id' },
      persist: async () => { saves++ }, now: () => 1000
    }
  }
}

function enableSourceNameUpdates(ctx) {
  ctx.deps.updateSourceAccountNames = (id, names) => {
    const account = ctx.stored.find(row => row.id === id)
    assert.ok(account)
    const seen = new Set()
    account.sourceAccountNames = [...(account.sourceAccountNames || []), ...names]
      .filter(name => {
        const key = name.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }
}

test('verified email and nickname remain authoritative while the original account is retained for search', async () => {
  const ctx = fixture()
  const plan = parseAccountImportText(JSON.stringify(credential({ email: 'synthetic-import-name' })))
  const outcome = await executeCredentialImport(plan, ctx.deps)
  assert.equal(outcome.added, 1)
  assert.equal(ctx.stored[0].email, 'test@example.invalid')
  assert.equal(ctx.stored[0].nickname, 'test')
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['synthetic-import-name'])
})

test('re-importing the original account supplements a matched account without verification or changing its credentials', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  const existing = { id: 'existing', email: 'verified@example.invalid', nickname: 'custom-name',
    credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'BuilderId' } }
  ctx.stored.push(existing)
  const originalCredentials = existing.credentials
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential({ email: 'synthetic-source' }))), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(outcome.added, 0)
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.stored.length, 1)
  assert.equal(existing.email, 'verified@example.invalid')
  assert.equal(existing.nickname, 'custom-name')
  assert.equal(existing.credentials, originalCredentials)
  assert.deepEqual(existing.sourceAccountNames, ['synthetic-source'])
  assert.equal(ctx.saves, 1)
})

test('duplicate rows with different original names are retained after the first verification rotates credentials', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  const plan = parseAccountImportText(JSON.stringify([
    credential({ email: 'synthetic-first-name' }), credential({ email: 'synthetic-second-name' })
  ]))
  const outcome = await executeCredentialImport(plan, ctx.deps)
  assert.equal(outcome.added, 1)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.calls.length, 1)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['synthetic-first-name', 'synthetic-second-name'])
  assert.equal(ctx.saves, 1)
})

test('each duplicate row keeps its own token identity when the batch shares an original account label', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  const first = { id: 'first', email: 'first@example.invalid', credentials: { refreshToken: 'SYNTHETIC_FIRST', provider: 'BuilderId' } }
  const second = { id: 'second', email: 'second@example.invalid', credentials: { refreshToken: 'SYNTHETIC_SECOND', provider: 'BuilderId' } }
  ctx.stored.push(first, second)
  const originalCredentials = ctx.stored.map(account => account.credentials)
  const plan = parseAccountImportText(JSON.stringify([
    credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_FIRST', sourceAccountNames: ['first-source'] }),
    credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_SECOND', sourceAccountNames: ['second-source'] })
  ]))
  assert.equal(plan.records[1].status, 'duplicate')
  assert.equal(plan.records[1].duplicateOf, 0)
  const outcome = await executeCredentialImport(plan, ctx.deps)
  assert.equal(outcome.duplicate, 2)
  assert.equal(ctx.calls.length, 0)
  assert.deepEqual(first.sourceAccountNames, ['first-source', 'synthetic-shared-label'])
  assert.deepEqual(second.sourceAccountNames, ['second-source', 'synthetic-shared-label'])
  assert.deepEqual(ctx.stored.map(account => account.email), ['first@example.invalid', 'second@example.invalid'])
  ctx.stored.forEach((account, index) => assert.equal(account.credentials, originalCredentials[index]))
  assert.equal(ctx.saves, 1)
  assert.ok(isOutcomeBalanced(outcome))
})

test('a direct token match outranks an earlier existing account with the same email', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.stored.push(
    { id: 'email-match', email: 'shared@example.invalid', credentials: { refreshToken: 'SYNTHETIC_OTHER', provider: 'BuilderId' } },
    { id: 'token-match', email: 'verified@example.invalid', credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'BuilderId' } }
  )
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential({
    email: 'shared@example.invalid', sourceAccountNames: ['synthetic-source']
  }))), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.stored[0].sourceAccountNames, undefined)
  assert.deepEqual(ctx.stored[1].sourceAccountNames, ['synthetic-source', 'shared@example.invalid'])
  assert.ok(isOutcomeBalanced(outcome))
})

for (const identity of ['userId', 'consumed']) {
  test(`a duplicate row uses its own ${identity} identity before the shared input label`, async () => {
    const ctx = fixture()
    enableSourceNameUpdates(ctx)
    ctx.stored.push(
      { id: 'first', email: 'first@example.invalid', credentials: { refreshToken: 'SYNTHETIC_FIRST', provider: 'BuilderId' } },
      { id: 'second', email: 'second@example.invalid', userId: 'second-user', credentials: { refreshToken: 'SYNTHETIC_ROTATED', provider: 'BuilderId' } }
    )
    if (identity === 'consumed') ctx.deps.getConsumedAccountId = input => input.refreshToken === 'SYNTHETIC_SECOND' ? 'second' : undefined
    const plan = parseAccountImportText(JSON.stringify([
      credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_FIRST', sourceAccountNames: ['first-source'] }),
      credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_SECOND', sourceAccountNames: ['second-source'],
        ...(identity === 'userId' ? { userId: 'second-user' } : {}) })
    ]))
    const outcome = await executeCredentialImport(plan, ctx.deps)
    assert.equal(outcome.duplicate, 2)
    assert.equal(ctx.calls.length, 0)
    assert.deepEqual(ctx.stored[0].sourceAccountNames, ['first-source', 'synthetic-shared-label'])
    assert.deepEqual(ctx.stored[1].sourceAccountNames, ['second-source', 'synthetic-shared-label'])
    assert.ok(isOutcomeBalanced(outcome))
  })
}

test('an input label alone never transfers another row source name to a verified account', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  const plan = parseAccountImportText(JSON.stringify([
    credential({ email: 'synthetic-shared-label', sourceAccountNames: ['first-source'] }),
    credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_OTHER', sourceAccountNames: ['unresolved-source'] })
  ]))
  const outcome = await executeCredentialImport(plan, ctx.deps)
  assert.equal(outcome.added, 1)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.calls.length, 1)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['first-source', 'synthetic-shared-label'])
  assert.ok(isOutcomeBalanced(outcome))
})

test('an email-only existing match cannot establish a token binding for other batch source names', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.stored.push({ id: 'existing', email: 'known@example.invalid', credentials: { refreshToken: 'SYNTHETIC_OTHER', provider: 'BuilderId' } })
  const plan = parseAccountImportText(JSON.stringify([
    credential({ email: 'known@example.invalid' }),
    credential({ email: 'synthetic-unverified-source' })
  ]))
  const outcome = await executeCredentialImport(plan, ctx.deps)
  assert.equal(outcome.duplicate, 2)
  assert.equal(ctx.calls.length, 0)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['known@example.invalid'])
  assert.ok(isOutcomeBalanced(outcome))
})

for (const conflict of ['userId', 'consumed']) {
  test(`conflicting token and ${conflict} identities do not update either account or refresh again`, async () => {
    const ctx = fixture()
    enableSourceNameUpdates(ctx)
    ctx.stored.push(
      { id: 'first', email: 'first@example.invalid', userId: 'first-user', credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'BuilderId' } },
      { id: 'second', email: 'second@example.invalid', userId: 'second-user', credentials: { refreshToken: 'SYNTHETIC_OTHER', provider: 'BuilderId' } }
    )
    if (conflict === 'consumed') ctx.deps.getConsumedAccountId = () => 'second'
    const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential({
      email: 'synthetic-source', ...(conflict === 'userId' ? { userId: 'second-user' } : {})
    }))), ctx.deps)
    assert.equal(outcome.failed, 1)
    assert.equal(ctx.calls.length, 0)
    assert.equal(ctx.saves, 0)
    assert.ok(ctx.stored.every(account => !account.sourceAccountNames))
    assert.ok(isOutcomeBalanced(outcome))
  })
}

test('a failed save counts both directly matched duplicate rows once and retries without verification', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.stored.push(
    { id: 'first', credentials: { refreshToken: 'SYNTHETIC_FIRST', provider: 'BuilderId' } },
    { id: 'second', credentials: { refreshToken: 'SYNTHETIC_SECOND', provider: 'BuilderId' } }
  )
  const plan = parseAccountImportText(JSON.stringify([
    credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_FIRST', sourceAccountNames: ['first-source'] }),
    credential({ email: 'synthetic-shared-label', refreshToken: 'SYNTHETIC_SECOND', sourceAccountNames: ['second-source'] })
  ]))
  let attempts = 0
  ctx.deps.persist = async () => { if (++attempts === 1) throw new Error('synthetic disk failure') }
  const first = await executeCredentialImport(plan, ctx.deps)
  const second = await executeCredentialImport(plan, ctx.deps)
  assert.equal(first.failed, 2)
  assert.equal(first.duplicate, 0)
  assert.equal(first.errors.length, 2)
  assert.equal(second.duplicate, 2)
  assert.equal(ctx.calls.length, 0)
  assert.equal(attempts, 2)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['first-source', 'synthetic-shared-label'])
  assert.deepEqual(ctx.stored[1].sourceAccountNames, ['second-source', 'synthetic-shared-label'])
  assert.ok(isOutcomeBalanced(first) && isOutcomeBalanced(second))
})

test('source names are added to the verified duplicate discovered after awaiting verification', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.deps.verify = async input => {
    ctx.stored.push({ id: 'existing', email: 'test@example.invalid', credentials: { provider: 'BuilderId' } })
    return response(input)
  }
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential({ email: 'synthetic-source' }))), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.stored.length, 1)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['synthetic-source'])
  assert.equal(ctx.saves, 1)
})

test('source-name persistence failure is visible and a duplicate retry saves again without verification', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.stored.push({ id: 'existing', email: 'verified@example.invalid', credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'BuilderId' } })
  let attempts = 0
  ctx.deps.persist = async () => { if (++attempts === 1) throw new Error('synthetic disk failure') }
  const plan = parseAccountImportText(JSON.stringify(credential({ email: 'synthetic-source' })))
  const first = await executeCredentialImport(plan, ctx.deps)
  const second = await executeCredentialImport(plan, ctx.deps)
  assert.equal(first.failed, 1)
  assert.equal(first.duplicate, 0)
  assert.equal(second.duplicate, 1)
  assert.equal(ctx.calls.length, 0)
  assert.equal(attempts, 2)
  assert.ok(isOutcomeBalanced(first) && isOutcomeBalanced(second))
})

test('consumed old credentials can add a new source name without another verification', async () => {
  const ctx = fixture()
  enableSourceNameUpdates(ctx)
  ctx.stored.push({ id: 'existing', email: 'verified@example.invalid', credentials: { refreshToken: 'SYNTHETIC_ROTATED', provider: 'BuilderId' } })
  ctx.deps.getConsumedAccountId = () => 'existing'
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential({ email: 'synthetic-source' }))), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.calls.length, 0)
  assert.deepEqual(ctx.stored[0].sourceAccountNames, ['synthetic-source'])
  assert.equal(ctx.saves, 1)
})

test('actual execution uses normalized route, preserves metadata, and accounts for invalid/duplicate rows', async () => {
  const ctx = fixture()
  const plan = parseAccountImportText(JSON.stringify([credential(), credential(), null]))
  const outcome = await executeCredentialImport(plan, ctx.deps, 'test-group')
  assert.equal(outcome.added, 1)
  assert.equal(outcome.duplicate, 1)
  assert.equal(outcome.invalid, 1)
  assert.ok(isOutcomeBalanced(outcome))
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].provider, 'BuilderId')
  assert.equal(ctx.calls[0].authMethod, 'IdC')
  assert.equal(ctx.stored[0].credentials.provider, 'BuilderId')
  assert.equal(ctx.stored[0].credentials.expiresAt, 121000)
  assert.equal(ctx.stored[0].groupId, 'test-group')
  assert.equal(ctx.saves, 1)
})

test('known token is skipped before a refresh can invalidate an existing account', async () => {
  const ctx = fixture()
  ctx.stored.push({ credentials: { refreshToken: 'SYNTHETIC_REFRESH', provider: 'BuilderId' } })
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential())), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.saves, 0)
})

test('identity is rechecked after awaiting validation, preventing concurrent duplicate insertion', async () => {
  const ctx = fixture()
  ctx.deps.verify = async input => {
    ctx.stored.push({ email: 'test@example.invalid', credentials: { provider: 'BuilderId' } })
    return response(input)
  }
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential())), ctx.deps)
  assert.equal(outcome.duplicate, 1)
  assert.equal(ctx.stored.length, 1)
  assert.equal(outcome.added, 0)
})

test('closing a batch during a pending request prevents late insertion and later requests', async () => {
  const ctx = fixture()
  const controller = new AbortController()
  ctx.deps.verify = async input => { ctx.calls.push(input); controller.abort(); return response(input) }
  const plan = parseAccountImportText(JSON.stringify([credential(), credential({ refreshToken: 'SYNTHETIC_OTHER' })]))
  const outcome = await executeCredentialImport(plan, ctx.deps, undefined, controller.signal)
  assert.equal(outcome.cancelled, 2)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.stored.length, 0)
  assert.ok(isOutcomeBalanced(outcome))
})

test('remote rejection is redacted and does not prevent valid siblings', async () => {
  const ctx = fixture()
  ctx.deps.verify = async input => input.refreshToken === 'SYNTHETIC_REFRESH'
    ? { success: false, error: `rejected ${input.refreshToken} ${input.clientSecret}` }
    : response(input)
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify([
    credential(), credential({ refreshToken: 'SYNTHETIC_OTHER' })
  ])), ctx.deps)
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.added, 1)
  assert.ok(isOutcomeBalanced(outcome))
  assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_REFRESH'))
  assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_SECRET'))
})

test('save rejection is visible and never reported as durable success', async () => {
  const ctx = fixture()
  ctx.deps.persist = async () => { throw new Error('synthetic disk failure') }
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential())), ctx.deps)
  assert.equal(outcome.added, 0)
  assert.equal(outcome.failed, 1)
  assert.equal(ctx.stored.length, 1)
  assert.ok(isOutcomeBalanced(outcome))
  assert.match(formatImportOutcome(outcome), /保存失败/)
})

test('missing verification token/identity is rejected before storage', async () => {
  const ctx = fixture()
  ctx.deps.verify = async input => response(input, { accessToken: '' })
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential())), ctx.deps)
  assert.equal(outcome.failed, 1)
  assert.equal(ctx.stored.length, 0)
})

test('remote errors cannot disclose newly issued secrets or previously unknown identities', async () => {
  const ctx = fixture()
  ctx.deps.verify = async () => ({ success: false, error: 'new-token SYNTHETIC_NEW_SECRET private-remote@example.invalid' })
  const outcome = await executeCredentialImport(parseAccountImportText(JSON.stringify(credential())), ctx.deps)
  assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_NEW_SECRET'))
  assert.ok(!JSON.stringify(outcome).includes('private-remote@example.invalid'))
})

test('display does not echo account-map keys from an error location', () => {
  const display = formatImportOutcome({ total: 1, added: 0, failed: 0, invalid: 1, duplicate: 0, cancelled: 0,
    errors: [{ source: '$.accounts.private@example.invalid', message: 'invalid field' }] })
  assert.ok(!display.includes('private@example.invalid'))
})

test('real store action restores a tokenless backup without calling verification and waits for save', async () => {
  const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  importAccountPlan: (plan, groupId, signal) => enqueueAccountImport(async () => {')
  const end = source.indexOf('  // ==================== 状态管理', start)
  assert.ok(start >= 0 && end > start)
  const snippet = stripTypeScriptTypes(`({${source.slice(start, end)}})`, { mode: 'strip' })
  const state = { accounts: new Map(), groups: new Map(), tags: new Map() }
  let saves = 0
  const get = () => ({ ...state, flushSaveImmediately: async () => { saves++ } })
  const set = fn => Object.assign(state, fn(state))
  const action = new Function('get', 'set', 'emptyOutcome', 'planBackupRestore', 'executeCredentialImport',
    'uuidv4', 'generateRandomMachineId', 'lastSaveError', 'enqueueAccountImport', `return ${snippet}.importAccountPlan`)(
    get, set, () => { throw new Error('unexpected cancellation') }, planBackupRestore,
    () => { throw new Error('backup must not verify credentials') }, () => 'generated-id', () => 'synthetic-machine', null, work => work())
  const backup = { version: '1.7.5', accounts: [{ id: 'backup-id', email: 'backup@example.invalid', idp: 'Google',
    credentials: { accessToken: '', refreshToken: '', provider: 'Google', authMethod: 'social' } }], groups: [], tags: [] }
  const outcome = await action(parseAccountImportText(JSON.stringify(backup)))
  assert.equal(outcome.added, 1)
  assert.equal(state.accounts.size, 1)
  assert.equal(state.accounts.get('backup-id').status, 'unknown')
  assert.equal(saves, 1)
})

test('re-importing a consumed credential skips a second refresh and retries persistence only', async () => {
  const ctx = fixture()
  const consumed = new Map()
  ctx.deps.wasConsumed = input => consumed.has(input.refreshToken)
  ctx.deps.rememberConsumed = (input, id) => consumed.set(input.refreshToken, id)
  const plan = parseAccountImportText(JSON.stringify(credential()))
  let attempts = 0
  ctx.deps.persist = async () => { if (++attempts === 1) throw new Error('synthetic disk failure') }
  const first = await executeCredentialImport(plan, ctx.deps)
  const second = await executeCredentialImport(plan, ctx.deps)
  assert.equal(first.failed, 1)
  assert.equal(second.duplicate, 1)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.stored.length, 1)
  assert.equal(attempts, 2)
  assert.ok(isOutcomeBalanced(first) && isOutcomeBalanced(second))
})

test('real store import queue serializes work across entry points and recovers after failure', async () => {
  const source = readFileSync(new URL('../../src/renderer/src/store/accounts.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function enqueueAccountImport<T>')
  const end = source.indexOf('\n}', start) + 2
  const snippet = stripTypeScriptTypes(source.slice(start, end))
  const enqueue = new Function(`let accountImportQueue = Promise.resolve(); ${snippet}; return enqueueAccountImport`)()
  let release
  const order = []
  const first = enqueue(async () => { order.push('first'); await new Promise(resolve => { release = resolve }); throw new Error('synthetic') })
  const caught = first.catch(() => {})
  const second = enqueue(async () => { order.push('second') })
  await Promise.resolve()
  assert.deepEqual(order, ['first'])
  release()
  await Promise.all([caught, second])
  assert.deepEqual(order, ['first', 'second'])
})
