// Offline regression tests. All credentials and identities are synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProvider, normalizeAuthMethod, resolveIdentity } from '../../src/shared/authIdentity.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'
import {
  parseAccountImportText, findExistingDuplicate, serializeRecordsForRetry,
  isOutcomeBalanced, emptyOutcome, splitCredentialLine, normalizeTimestamp
} from '../../src/shared/accountImport.ts'

const bid = { refreshToken: 'FAKE_RT_A', clientId: 'FAKE_C', clientSecret: 'FAKE_S', provider: 'BuilderId' }
const bid2 = { ...bid, refreshToken: 'FAKE_RT_B' }
const social = { refreshToken: 'FAKE_RT_SOCIAL', provider: 'Github' }

test('shared parsing keeps normalized source account names as metadata', () => {
  const plan = parseAccountImportText(JSON.stringify({
    ...social,
    email: 'synthetic-login-42',
    sourceAccountNames: ['  older-login ', 'OLDER-LOGIN', null, 123]
  }))
  assert.equal(plan.counts.valid, 1)
  assert.deepEqual(plan.records[0].credential?.sourceAccountNames, ['older-login'])
  assert.equal(plan.records[0].credential?.email, 'synthetic-login-42')
})

test('source account names do not establish account identity or cause duplicate imports', () => {
  const plan = parseAccountImportText(JSON.stringify([
    { ...social, sourceAccountNames: ['shared-source-label'] },
    { ...social, refreshToken: 'FAKE_RT_DIFFERENT', sourceAccountNames: ['shared-source-label'] }
  ]))
  assert.equal(plan.counts.valid, 2)
  assert.equal(plan.counts.duplicate, 0)
})

function assertBackupPreviewMatchesRestore(plan: ReturnType<typeof parseAccountImportText>): void {
  assert.ok(plan.backup)
  const restored = planBackupRestore(plan.backup, {
    existingAccounts: [], existingGroups: new Map(), existingTags: new Map(),
    generateId: () => 'synthetic-restored-id', generateMachineId: () => 'synthetic-machine', now: 1000
  })
  assert.equal(plan.counts.valid, restored.outcome.added)
  assert.equal(plan.counts.invalid, restored.outcome.invalid)
  assert.equal(plan.counts.duplicate, restored.outcome.duplicate)
}

test('normalizes documented provider aliases and rejects unknown values', () => {
  for (const value of ['BuilderId', 'Builder ID', 'builder_id', 'builder-id', 'BUILDERID', 'AWS Builder ID']) {
    assert.equal(normalizeProvider(value), 'BuilderId')
  }
  for (const value of ['Github', 'GitHub', 'github']) assert.equal(normalizeProvider(value), 'Github')
  assert.equal(normalizeProvider('google'), 'Google')
  assert.equal(normalizeProvider('IAM_SSO'), 'IAM_SSO')
  assert.equal(normalizeProvider('Enterprise'), 'Enterprise')
  assert.equal(normalizeProvider('AWSIdC'), 'Enterprise')
  assert.equal(normalizeProvider(undefined), undefined)
  assert.equal(normalizeProvider('  '), undefined)
  assert.equal(normalizeProvider('Facebook'), null)
  assert.equal(normalizeProvider(42), null)
  assert.equal(normalizeProvider('constructor'), null)
})

test('normalizes auth methods using a whitelist', () => {
  for (const value of ['IdC', 'idc', 'OIDC']) assert.equal(normalizeAuthMethod(value), 'IdC')
  assert.equal(normalizeAuthMethod('Social'), 'social')
  assert.equal(normalizeAuthMethod('password'), null)
  assert.equal(normalizeAuthMethod('constructor'), null)
})

test('Builder ID selects IdC and rejects a conflicting explicit auth method', () => {
  assert.deepEqual(resolveIdentity({ provider: 'Builder ID' }), {
    ok: true, provider: 'BuilderId', authMethod: 'IdC', inferred: false, warnings: []
  })
  const conflict = resolveIdentity({ provider: 'BuilderId', authMethod: 'social' })
  assert.ok(!conflict.ok && conflict.code === 'provider_auth_method_conflict')
})

test('unknown provider is rejected even with OIDC client credentials', () => {
  const result = resolveIdentity({ provider: 'Facebook', hasClientCredentials: true })
  assert.ok(!result.ok && result.code === 'unsupported_provider')
})

test('missing provider may use idp or complete OIDC clients', () => {
  const github = resolveIdentity({ idp: 'github' })
  assert.ok(github.ok && github.provider === 'Github' && github.authMethod === 'social')
  const inferred = resolveIdentity({ hasClientCredentials: true })
  assert.ok(inferred.ok && inferred.provider === 'BuilderId' && inferred.inferred && inferred.warnings.length > 0)
})

test('missing identity never silently defaults to Google', () => {
  for (const input of [{}, { authMethod: 'social' }, { authMethod: 'social', hasClientCredentials: true }]) {
    const result = resolveIdentity(input)
    assert.ok(!result.ok && result.code === 'missing_provider')
  }
})

test('identity errors do not expose arbitrary user input', () => {
  const marker = 'SENSITIVE_SYNTHETIC_VALUE'
  for (const input of [{ provider: marker }, { idp: marker }, { authMethod: marker }]) {
    const result = resolveIdentity(input)
    assert.ok(!result.ok)
    assert.ok(!result.message.includes(marker))
  }
})

test('all documented JSON containers produce the same valid records', () => {
  const cases = [
    [JSON.stringify(bid), 'object', 1],
    [JSON.stringify([bid, bid2]), 'array', 2],
    [JSON.stringify({ accounts: [bid, bid2] }), 'accounts-array', 2],
    [JSON.stringify({ accounts: { a: bid, b: bid2 } }), 'accounts-map', 2],
    [JSON.stringify({ data: [bid, bid2] }), 'data-array', 2]
  ] as const
  for (const [text, container, count] of cases) {
    const plan = parseAccountImportText(text)
    assert.ok(plan.ok, plan.error?.message)
    assert.equal(plan.container, container)
    assert.equal(plan.counts.total, count)
    assert.equal(plan.counts.valid, count)
  }
})

test('account-map sources retain their JSON position for retry', () => {
  const plan = parseAccountImportText(JSON.stringify({ accounts: { abc: bid } }))
  assert.equal(plan.records[0].source, '$.accounts.abc')
})

test('unrelated JSON and unsupported containers are rejected', () => {
  for (const text of ['{"foo":1,"bar":{"refreshToken":"x"}}', '"string"', '42', 'null', '{"accounts":3}', '{"data":{}}']) {
    const plan = parseAccountImportText(text)
    assert.equal(plan.ok, false)
    assert.equal(plan.records.length, 0)
  }
})

test('empty arrays and empty containers give a clear empty-accounts error', () => {
  for (const value of [[], { accounts: [] }, { accounts: {} }, { data: [] }]) {
    const plan = parseAccountImportText(JSON.stringify(value))
    assert.equal(plan.error?.code, 'empty_accounts')
  }
})

test('complete backup is recognized and keeps group and tag collections', () => {
  const plan = parseAccountImportText(JSON.stringify({
    version: '1.7.6', exportedAt: 1,
    accounts: [{ id: 'a', email: 'backup@example.invalid', idp: 'BuilderId', credentials: bid }],
    groups: [{ id: 'g', name: 'Team' }], tags: []
  }))
  assert.equal(plan.container, 'backup')
  assert.equal(plan.backup?.accounts.length, 1)
  assert.equal(plan.counts.valid, 1)
})

test('tokenless full backups preview metadata rows as valid without treating empty tokens as duplicates', () => {
  const plan = parseAccountImportText(JSON.stringify({ version: '1.7.5', accounts: [
    { id: 'a', email: 'a@example.invalid', idp: 'Google', credentials: { accessToken: '', refreshToken: '', provider: 'Google' } },
    { id: 'b', userId: 'synthetic-user-b', idp: 'BuilderId', credentials: { accessToken: '', refreshToken: '', provider: 'Builder ID' } }
  ] }))
  assert.equal(plan.container, 'backup')
  assert.deepEqual(plan.counts, { total: 2, valid: 2, invalid: 0, duplicate: 0 })
  assert.ok(plan.records.every(record => record.credential?.refreshToken === ''))
  assertBackupPreviewMatchesRestore(plan)
})

test('flat credentials wrapped in backup metadata preview as invalid instead of usable accounts', () => {
  const plan = parseAccountImportText(JSON.stringify({ version: '1.7.5', accounts: [bid, social] }))
  assert.equal(plan.container, 'backup')
  assert.deepEqual(plan.counts, { total: 2, valid: 0, invalid: 2, duplicate: 0 })
  assert.ok(plan.records.every(record => record.issues.some(issue => issue.code === 'incomplete_backup_record')))
  assertBackupPreviewMatchesRestore(plan)
  // Those same records remain valid at the simplified credential entry point.
  assert.equal(parseAccountImportText(JSON.stringify([bid, social])).counts.valid, 2)
})

test('full backup preview requires stable identity and shares credential validation with restore', () => {
  const plan = parseAccountImportText(JSON.stringify({ version: '1.7.5', accounts: [
    { id: 'a', credentials: social },
    { id: 'b', email: 'b@example.invalid', credentials: { provider: 'BuilderId', refreshToken: 'FAKE_INCOMPLETE' } },
    { id: 'c', userId: 'synthetic-user-c', credentials: { provider: 'Github', refreshToken: 'FAKE_VALID' } }
  ] }))
  assert.deepEqual(plan.counts, { total: 3, valid: 1, invalid: 2, duplicate: 0 })
  assert.ok(plan.records[0].issues.some(issue => issue.code === 'missing_stable_identity'))
  assert.ok(plan.records[1].issues.some(issue => issue.code === 'missing_field'))
  assertBackupPreviewMatchesRestore(plan)
})

test('nested credentials and snake_case aliases normalize consistently', () => {
  const plan = parseAccountImportText(JSON.stringify({
    email: 'n@example.invalid',
    credentials: { refresh_token: 'FAKE_RT_N', client_id: 'FAKE_C', client_secret: 'FAKE_S', auth_method: 'idc', provider: 'builder_id' }
  }))
  assert.equal(plan.counts.valid, 1)
  assert.equal(plan.records[0].credential?.provider, 'BuilderId')
  assert.equal(plan.records[0].credential?.authMethod, 'IdC')
  assert.equal(plan.records[0].credential?.clientId, 'FAKE_C')
  assert.equal(plan.records[0].credential?.email, 'n@example.invalid')
})

test('credential strings are trimmed', () => {
  const plan = parseAccountImportText(JSON.stringify({ refreshToken: '  FAKE_RT  ', provider: ' Github ' }))
  assert.equal(plan.records[0].credential?.refreshToken, 'FAKE_RT')
  assert.equal(plan.records[0].credential?.provider, 'Github')
})

test('conflicting top-level and nested values are rejected; equivalent aliases are accepted', () => {
  const bad = parseAccountImportText(JSON.stringify({ ...social, credentials: { refreshToken: 'FAKE_DIFFERENT' } }))
  assert.equal(bad.records[0].status, 'invalid')
  assert.ok(bad.records[0].issues.some(issue => issue.code === 'field_conflict'))
  const good = parseAccountImportText(JSON.stringify({ ...social, credentials: { ...social, provider: 'GitHub' } }))
  assert.equal(good.records[0].status, 'valid')
})

test('type and missing-field errors are per-record and contain no credential values', () => {
  const marker = 'FAKE_SECRET_VALUE_XYZ'
  const plan = parseAccountImportText(JSON.stringify([
    { refreshToken: { nested: true }, provider: 'Github' },
    { refreshToken: marker, provider: 'BuilderId', clientId: 'FAKE_C' }, null, {}
  ]))
  assert.ok(plan.ok)
  assert.equal(plan.counts.invalid, 4)
  assert.ok(plan.records[0].issues.some(issue => issue.field === 'refreshToken' && issue.code === 'invalid_type'))
  assert.ok(plan.records[1].issues.some(issue => issue.code === 'missing_field' && issue.message.includes('clientSecret')))
  assert.ok(!JSON.stringify(plan.records.map(record => record.issues)).includes(marker))
})

test('blank tokens are missing; Social needs no OIDC clients; invalid region is redacted', () => {
  assert.equal(parseAccountImportText(JSON.stringify({ ...social, refreshToken: '  ' })).counts.invalid, 1)
  assert.equal(parseAccountImportText(JSON.stringify(social)).counts.valid, 1)
  const bad = parseAccountImportText(JSON.stringify({ ...social, region: 'SECRET_REGION_VALUE' }))
  assert.ok(bad.records[0].issues.some(issue => issue.code === 'invalid_region'))
  assert.ok(!JSON.stringify(bad.records[0].issues).includes('SECRET_REGION_VALUE'))
})

test('BOM, outer whitespace, and complete Markdown fences are accepted', () => {
  const body = JSON.stringify([bid])
  for (const text of ['\uFEFF' + body, `\n  ${body}  \n`, '```json\n' + body + '\n```', '```\n' + body + '\n```']) {
    assert.equal(parseAccountImportText(text).counts.valid, 1)
  }
})

test('incomplete fences and invalid JSON are not retried as credential lines', () => {
  assert.equal(parseAccountImportText('```json\n[{"refreshToken":"x"}]').error?.code, 'incomplete_code_fence')
  assert.equal(parseAccountImportText('[{"refreshToken":"x",}]').error?.code, 'json_syntax')
})

test('JSON syntax errors never include parser snippets or the original secret', () => {
  const result = parseAccountImportText('{"refreshToken":"SYNTHETIC_SECRET_THAT_MUST_NOT_LEAK",}')
  assert.equal(result.error?.code, 'json_syntax')
  assert.ok(!result.error?.message.includes('SYNTHETIC_SECRET'))
})

test('credential lines preserve original positions and ignore blank or comment lines', () => {
  const plan = parseAccountImportText([
    '# comment', 'a@example.invalid----no_password----FAKE_RT_1----FAKE_C----FAKE_S', '',
    'b@example.invalid----pw----FAKE_RT_2------------Github', 'garbage line without separator'
  ].join('\n'))
  assert.ok(plan.ok)
  assert.equal(plan.format, 'lines')
  assert.equal(plan.counts.total, 3)
  assert.equal(plan.records[0].source, '\u7b2c 2 \u884c')
  assert.equal(plan.records[0].credential?.provider, 'BuilderId')
  assert.equal(plan.records[0].credential?.password, undefined)
  assert.equal(plan.records[1].credential?.provider, 'Github')
  assert.equal(plan.records[2].status, 'invalid')
  assert.equal(plan.records[2].source, '\u7b2c 5 \u884c')
})

test('unsupported text and lines with extra fields are rejected', () => {
  assert.equal(parseAccountImportText('hello world').error?.code, 'unsupported_text')
  const plan = parseAccountImportText('a----b----RT------------Github----extra')
  assert.equal(plan.counts.invalid, 1)
})

test('in-batch duplicates use token, user ID, and provider-qualified email', () => {
  for (const records of [
    [bid, { ...bid }],
    [{ ...bid, userId: 'u' }, { ...bid2, userId: 'u' }],
    [{ ...bid, email: 'A@example.invalid' }, { ...bid2, email: 'a@example.invalid' }]
  ]) {
    const plan = parseAccountImportText(JSON.stringify(records))
    assert.equal(plan.counts.valid, 1)
    assert.equal(plan.counts.duplicate, 1)
    assert.equal(plan.records[1].duplicateOf, 0)
  }
})

test('same email under different providers remains distinct', () => {
  const plan = parseAccountImportText(JSON.stringify([
    { ...social, email: 'x@example.invalid' },
    { ...social, refreshToken: 'FAKE_OTHER', provider: 'Google', email: 'x@example.invalid' }
  ]))
  assert.equal(plan.counts.valid, 2)
})

test('duplicate messages do not echo account-map keys', () => {
  const plan = parseAccountImportText(JSON.stringify({ accounts: { 'SENSITIVE_MAP_KEY': bid, other: bid } }))
  assert.equal(plan.counts.duplicate, 1)
  assert.ok(!plan.records[1].issues[0].message.includes('SENSITIVE_MAP_KEY'))
})

test('existing duplicates use user ID, refresh token, and canonicalized provider', () => {
  const existing = [{ id: '1', email: 'A@example.invalid', userId: 'u1', idp: 'BuilderId', credentials: { refreshToken: 'FAKE_EXIST' } }]
  assert.ok(findExistingDuplicate(existing, { userId: 'u1' }))
  assert.ok(findExistingDuplicate(existing, { refreshToken: 'FAKE_EXIST' }))
  assert.ok(findExistingDuplicate(existing, { email: 'a@example.invalid', provider: 'Builder ID' }))
  assert.equal(findExistingDuplicate(existing, { email: 'a@example.invalid', provider: 'Google' }), undefined)
})

test('failed records can be recovered in their original input format', () => {
  const json = parseAccountImportText(JSON.stringify([bid, bid2]))
  assert.deepEqual(JSON.parse(serializeRecordsForRetry(json, [1])), [bid2])
  const lines = parseAccountImportText('a----b----FAKE_1------------Github\nc----d----FAKE_2------------Google')
  assert.equal(serializeRecordsForRetry(lines, [1]), 'c----d----FAKE_2------------Google')
})

test('result totals satisfy the accounting invariant', () => {
  const outcome = emptyOutcome(5)
  Object.assign(outcome, { added: 2, duplicate: 1, invalid: 1, failed: 1 })
  assert.ok(isOutcomeBalanced(outcome))
})

test('synthetic samples matching the three user formats are all recognized', () => {
  const samples = [
    [1, 2, 3].map(i => ({ accessToken: `FAKE_AT_GH_${i}`, refreshToken: `FAKE_RT_GH_${i}`, provider: 'Github', authMethod: 'social' })),
    [1, 2].map(i => ({ email: `google-${i}@example.invalid`, provider: 'Google', authMethod: 'social', accessToken: `FAKE_AT_GG_${i}`, refreshToken: `FAKE_RT_GG_${i}`, clientId: '', expiresAt: '2026-10-20T00:00:00Z' })),
    [1, 2, 3, 4].map(i => ({ email: `builder-${i}@example.invalid`, password: 'FAKE_PASSWORD', refreshToken: `FAKE_RT_BID_${i}`, clientId: `FAKE_CLIENT_${i}`, clientSecret: `FAKE_SECRET_${i}`, provider: 'Builder ID' }))
  ]
  for (const sample of samples) assert.equal(parseAccountImportText(JSON.stringify(sample)).counts.valid, sample.length)
})

test('credential-line delimiter preserves empty client slots and token hyphens', () => {
  const exported = ['s@example.invalid', 'no_password', 'FAKE_RT_S', '', '', 'Github'].join('----')
  assert.deepEqual(splitCredentialLine(exported), ['s@example.invalid', 'no_password', 'FAKE_RT_S', '', '', 'Github'])
  assert.equal(parseAccountImportText(exported).records[0].credential?.authMethod, 'social')
  assert.deepEqual(splitCredentialLine('a----tok-----c'), ['a', 'tok-', 'c'])
})

test('timestamps normalize seconds, milliseconds and ISO without inventing validity', () => {
  const ms = Date.parse('2026-10-20T00:00:00Z')
  assert.equal(normalizeTimestamp(ms / 1000), ms)
  assert.equal(normalizeTimestamp(ms), ms)
  assert.equal(normalizeTimestamp(String(ms)), ms)
  assert.equal(normalizeTimestamp('2026-10-20T00:00:00Z'), ms)
  for (const value of [undefined, null, -1, '-1', 0, Number.NaN, Number.POSITIVE_INFINITY, 1e20, 'not a date', 'October 20, 2026']) {
    assert.equal(normalizeTimestamp(value), undefined)
  }
})

test('legacy OIDC clipboard aliases and nested client registration fields normalize to Builder ID IdC', () => {
  const plan = parseAccountImportText(JSON.stringify({
    email: 'builder-alias@example.invalid',
    oidc_credentials: {
      RefreshToken: 'FAKE_RT_OIDC_ALIAS',
      AccessToken: 'FAKE_AT_OIDC_ALIAS',
      ClientId: 'FAKE_CLIENT_OIDC_ALIAS',
      ClientSecret: 'FAKE_SECRET_OIDC_ALIAS',
      AuthMethod: 'OLDC',
      Provider: 'OIDC',
      Region: 'eu-west-1'
    }
  }))
  assert.equal(plan.counts.valid, 1)
  assert.equal(plan.records[0].credential?.provider, 'BuilderId')
  assert.equal(plan.records[0].credential?.authMethod, 'IdC')
  assert.equal(plan.records[0].credential?.region, 'eu-west-1')
})

test('generic IdC provider label is treated as Builder ID only when OIDC clients are present', () => {
  const plan = parseAccountImportText(JSON.stringify({
    refreshToken: 'FAKE_RT_GENERIC_IDC',
    clientId: 'FAKE_CLIENT_GENERIC_IDC',
    clientSecret: 'FAKE_SECRET_GENERIC_IDC',
    provider: 'IdC'
  }))
  assert.equal(plan.counts.valid, 1)
  assert.equal(plan.records[0].credential?.provider, 'BuilderId')
  assert.equal(plan.records[0].credential?.authMethod, 'IdC')
})

test('external_idp and AWSIdC aliases preserve Enterprise IdC identity', () => {
  const plan = parseAccountImportText(JSON.stringify({
    refresh_token: 'FAKE_RT_ENTERPRISE_ALIAS',
    client_id: 'FAKE_CLIENT_ENTERPRISE_ALIAS',
    client_secret: 'FAKE_SECRET_ENTERPRISE_ALIAS',
    external_idp: 'awsidc'
  }))
  assert.equal(plan.counts.valid, 1)
  assert.equal(plan.records[0].credential?.provider, 'Enterprise')
  assert.equal(plan.records[0].credential?.authMethod, 'IdC')
})

test('explicit ExternalIdp legacy identity is retained on the Enterprise IdC branch', () => {
  const plan = parseAccountImportText(JSON.stringify({
    refreshToken: 'FAKE_RT_EXTERNAL_IDP',
    clientId: 'FAKE_CLIENT_EXTERNAL_IDP',
    clientSecret: 'FAKE_SECRET_EXTERNAL_IDP',
    provider: 'ExternalIdp',
    authMethod: 'external_idp'
  }))
  assert.equal(plan.counts.valid, 1)
  assert.equal(plan.records[0].credential?.provider, 'Enterprise')
  assert.equal(plan.records[0].credential?.authMethod, 'IdC')
})

test('OIDC typo never turns a Social provider into IdC', () => {
  const plan = parseAccountImportText(JSON.stringify({
    refreshToken: 'FAKE_RT_SOCIAL_CONFLICT',
    provider: 'GitHub',
    authMethod: 'OLDC'
  }))
  assert.equal(plan.counts.invalid, 1)
  assert.ok(plan.records[0].issues.some(issue => issue.code === 'provider_auth_method_conflict'))
})

test('unknown explicit provider remains rejected instead of being inferred as Builder ID', () => {
  const plan = parseAccountImportText(JSON.stringify({
    refreshToken: 'FAKE_RT_UNKNOWN_PROVIDER',
    clientId: 'FAKE_CLIENT_UNKNOWN_PROVIDER',
    clientSecret: 'FAKE_SECRET_UNKNOWN_PROVIDER',
    provider: 'Facebook'
  }))
  assert.equal(plan.counts.invalid, 1)
  assert.ok(plan.records[0].issues.some(issue => issue.code === 'unsupported_provider'))
})
