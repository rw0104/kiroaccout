import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountExport } from '../../src/shared/accountExport.ts'
import { parseAccountImportText } from '../../src/shared/accountImport.ts'
import { planBackupRestore } from '../../src/shared/backupRestore.ts'

const account = (id, provider, region = 'us-east-1') => ({
  id,
  email: `${id}@example.invalid`,
  idp: provider,
  nickname: `Synthetic ${id}`,
  password: `FAKE_PASSWORD_${id}`,
  userId: `synthetic-user-${id}`,
  isActive: true,
  credentials: {
    provider,
    authMethod: ['Google', 'Github'].includes(provider) ? 'social' : 'IdC',
    region,
    refreshToken: `FAKE_REFRESH_${id}`,
    accessToken: `FAKE_ACCESS_${id}`,
    csrfToken: `FAKE_CSRF_${id}`,
    ...(provider === 'BuilderId'
      ? { clientId: `FAKE_CLIENT_${id}`, clientSecret: `FAKE_SECRET_${id}` }
      : {}),
    expiresAt: 5000
  },
  groupId: 'g1',
  tags: ['t1'],
  subscription: { type: 'Pro', title: 'Synthetic Pro' },
  usage: { current: 2, limit: 20, percentUsed: 10, lastUpdated: 1000 },
  status: 'active',
  createdAt: 100,
  lastUsedAt: 200
})
const three = () => [
  account('builder', 'BuilderId', 'eu-west-1'),
  account('google', 'Google'),
  account('github', 'Github', 'ap-northeast-1')
]
const input = (over = {}) => ({
  accounts: three(),
  groups: [{ id: 'g1', name: 'Synthetic group', order: 1, createdAt: 100 }],
  tags: [{ id: 't1', name: 'Synthetic tag', color: '#abcdef' }],
  scope: 'all',
  format: 'json',
  appVersion: '1.7.7',
  now: 1000,
  ...over
})
const restore = (exported) => {
  assert.equal(exported.ok, true)
  const parsed = parseAccountImportText(exported.content)
  assert.equal(parsed.ok, true)
  assert.ok(parsed.backup)
  assert.equal(parsed.counts.invalid, 0)
  let id = 0
  return planBackupRestore(parsed.backup, {
    existingAccounts: [],
    existingGroups: new Map(),
    existingTags: new Map(),
    generateId: () => `generated-${++id}`,
    generateMachineId: () => 'f'.repeat(64),
    now: 10000
  })
}

test('credential-free backup removes legacy device authorization codes and AWS access key identifiers', () => {
  const row = account('builder', 'BuilderId')
  row.deviceCode = 'SYNTHETIC_DEVICE_CODE'
  row.extensions = { user_code: 'SYNTHETIC_USER_CODE', accessKeyId: 'SYNTHETIC_AWS_KEY', samlAssertion: 'SYNTHETIC_ASSERTION' }
  const result = createAccountExport(input({ accounts: [row] }))
  assert.equal(result.ok, true)
  assert.doesNotMatch(result.content, /SYNTHETIC_DEVICE_CODE|SYNTHETIC_USER_CODE|SYNTHETIC_AWS_KEY|SYNTHETIC_ASSERTION/)
})

test('current client registration expiry survives credential JSON and full backup round trips', () => {
  const row = account('builder', 'BuilderId')
  row.credentials.clientSecretExpiresAt = 1900000000
  for (const format of ['json', 'oidc']) {
    const result = createAccountExport(input({ accounts: [row], format, includeCredentials: true }))
    assert.equal(result.ok, true)
    const parsed = parseAccountImportText(result.content)
    assert.equal(parsed.records[0].credential.clientSecretExpiresAt, 1900000000)
    if (format === 'json') assert.equal(restore(result).accounts[0].credentials.clientSecretExpiresAt, 1900000000)
  }
})

test('complete credential backup round-trips all providers, non-default regions, metadata and relationships', () => {
  const data = input({ includeCredentials: true })
  const result = createAccountExport(data)
  const restored = restore(result)
  assert.equal(result.count, 3)
  assert.equal(restored.outcome.added, 3)
  assert.equal(restored.outcome.invalid, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(restored.groups)), data.groups)
  assert.deepEqual(restored.tags, data.tags)
  for (let index = 0; index < restored.accounts.length; index++) {
    const actual = restored.accounts[index]
    const expected = data.accounts[index]
    assert.equal(actual.idp, expected.idp)
    assert.equal(actual.credentials.authMethod, expected.credentials.authMethod)
    assert.equal(actual.credentials.region, expected.credentials.region)
    assert.equal(actual.credentials.refreshToken, expected.credentials.refreshToken)
    assert.equal(actual.password, expected.password)
    assert.equal(actual.groupId, 'g1')
    assert.deepEqual(actual.tags, ['t1'])
    assert.deepEqual(actual.subscription, expected.subscription)
    assert.deepEqual(actual.usage, expected.usage)
    assert.equal(actual.isActive, false)
  }
  assert.ok(
    data.accounts.every((item) => item.isActive),
    'export does not mutate active-account flags'
  )
})

test('minimal credential JSON imports through the shared parser without guessing provider or region', () => {
  const original = three()
  const result = createAccountExport(
    input({ accounts: original, format: 'oidc', includeCredentials: true })
  )
  assert.equal(result.ok, true)
  const parsed = parseAccountImportText(result.content)
  assert.deepEqual(parsed.counts, { total: 3, valid: 3, invalid: 0, duplicate: 0 })
  parsed.records.forEach((record, index) => {
    assert.equal(record.credential.provider, original[index].idp)
    assert.equal(record.credential.authMethod, original[index].credentials.authMethod)
    assert.equal(record.credential.region, original[index].credentials.region)
    assert.equal(record.credential.refreshToken, original[index].credentials.refreshToken)
  })
  const exported = JSON.parse(result.content)
  assert.equal(exported[0].clientSecret, 'FAKE_SECRET_builder')
  assert.equal(
    exported[0].accessToken,
    undefined,
    'minimal export avoids unnecessary access tokens'
  )
})

test('all credential-free output formats default to excluding tokens, client secrets and passwords', () => {
  for (const format of ['json', 'oidc', 'txt', 'csv', 'clipboard']) {
    const result = createAccountExport(input({ format }))
    assert.equal(result.ok, true, format)
    assert.equal(result.containsCredentials, false)
    assert.equal(result.count, 3)
    assert.doesNotMatch(result.content, /FAKE_(REFRESH|ACCESS|CSRF|SECRET|PASSWORD|CLIENT)/)
    assert.match(
      result.content,
      /example\.invalid/,
      'credential-free export is not email anonymization'
    )
  }
  const denied = createAccountExport(input({ format: 'kami' }))
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'credentials_required')
})

test('credential-free backup removes legacy and nested auth fields without changing source data', () => {
  const record = account('legacy', 'BuilderId')
  record.access_token = 'FAKE_ACCESS_LEGACY'
  record.lastError = 'server echoed FAKE_REFRESH_legacy'
  record.extension = {
    Authorization: 'FAKE_AUTH',
    session_id: 'FAKE_SESSION',
    safe: [{ client_secret: 'FAKE_NESTED', count: 1 }]
  }
  record.credentials.extension = { leaked: 'FAKE_CREDENTIAL_EXTENSION' }
  const before = JSON.stringify(record)
  const result = createAccountExport(input({ accounts: [record] }))
  assert.equal(result.ok, true)
  assert.doesNotMatch(result.content, /FAKE_/)
  assert.equal(JSON.stringify(record), before)
  const exported = JSON.parse(result.content)
  assert.equal(exported.credentialsIncluded, false)
  assert.deepEqual(exported.accounts[0].extension.safe, [{ count: 1 }])
  assert.equal(exported.accounts[0].status, 'unknown')
  const restored = restore(result)
  assert.equal(restored.outcome.added, 1)
  assert.equal(restored.accounts[0].credentials.refreshToken, undefined)
  assert.equal(restored.accounts[0].credentials.clientSecret, undefined)
  assert.equal(restored.accounts[0].password, undefined)
  assert.equal(restored.accounts[0].status, 'unknown')
  assert.equal(restored.accounts[0].credentials.provider, 'BuilderId')
})

test('selected scope writes exactly that selection and its relationships; all scope retains unused definitions', () => {
  const data = input({
    selectedIds: ['github', 'github'],
    scope: 'selected',
    includeCredentials: true,
    groups: [...input().groups, { id: 'unused-g', name: 'Unused', order: 2, createdAt: 1 }],
    tags: [...input().tags, { id: 'unused-t', name: 'Unused tag', color: '#fff' }]
  })
  const result = createAccountExport(data)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  const selected = JSON.parse(result.content)
  assert.deepEqual(
    selected.accounts.map((item) => item.id),
    ['github']
  )
  assert.deepEqual(
    selected.groups.map((item) => item.id),
    ['g1']
  )
  assert.deepEqual(
    selected.tags.map((item) => item.id),
    ['t1']
  )
  assert.equal(restore(result).outcome.added, 1)
  const all = createAccountExport({ ...data, scope: 'all' })
  assert.equal(all.ok, true)
  assert.equal(all.count, 3)
  assert.equal(JSON.parse(all.content).groups.length, 2)
  assert.equal(JSON.parse(all.content).tags.length, 2)
})

test('single-account filenames use the exported email for every file format and credential mode', () => {
  for (const format of ['json', 'oidc', 'txt', 'csv', 'kami']) {
    for (const includeCredentials of [false, true]) {
      if (format === 'kami' && !includeCredentials) continue
      const extension = ['json', 'oidc'].includes(format) ? 'json' : format === 'csv' ? 'csv' : 'txt'
      for (const scope of ['all', 'selected']) {
        const result = createAccountExport(input({
          accounts: scope === 'all' ? [account('github', 'Github')] : three(),
          selectedIds: ['github', 'github'], scope, format, includeCredentials
        }))
        assert.equal(result.ok, true)
        assert.equal(result.count, 1)
        assert.equal(result.filename, `github@example.invalid.${extension}`)
      }
    }
  }
})

test('multiple-account filenames retain the existing format, credential mode and date', () => {
  for (const format of ['json', 'oidc', 'txt', 'csv', 'kami']) {
    const result = createAccountExport(input({ format, includeCredentials: true }))
    assert.equal(result.ok, true)
    const kind = format === 'json' ? 'backup' : format === 'oidc' ? 'credentials' : format
    assert.equal(result.filename, `kiro-accounts-${kind}-with-credentials-1970-01-01.${result.extension}`)
  }
  const metadata = createAccountExport(input())
  assert.equal(metadata.filename, 'kiro-accounts-backup-no-credentials-1970-01-01.json')
})

test('missing single-account email falls back safely without using an unselected account email', () => {
  const blank = account('blank', 'Google')
  blank.email = '   '
  for (const includeCredentials of [false, true]) {
    const result = createAccountExport(input({
      accounts: [account('unselected', 'Google'), blank],
      scope: 'selected', selectedIds: ['blank'], includeCredentials
    }))
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
    assert.equal(result.filename, `kiro-accounts-backup-${includeCredentials ? 'with' : 'no'}-credentials-1970-01-01.json`)
    assert.doesNotMatch(result.filename, /unselected/)
  }
})

test('email filenames are safe file components on Windows and preserve normal addresses', () => {
  for (const email of [
    '  synthetic+tag@example.invalid  ',
    '../synthetic:name\\with?"<>|*\u0000@example.invalid. ',
    'CON', 'NUL.json', 'COM\u00b9',
    `${'合成😀'.repeat(80)}@example.invalid`,
    '...'
  ]) {
    const row = account('safe', 'Google')
    row.email = email
    const result = createAccountExport(input({ accounts: [row] }))
    assert.equal(result.ok, true)
    assert.ok(Buffer.byteLength(result.filename, 'utf8') <= 255)
    assert.doesNotMatch(result.filename, /[<>:"/\\|?*\u0000-\u001f\u007f]/)
    assert.doesNotMatch(result.filename, /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i)
    assert.match(result.filename, /[^. ]\.json$/)
    if (email.trim() === 'synthetic+tag@example.invalid') {
      assert.equal(result.filename, 'synthetic+tag@example.invalid.json')
    }
    if (email === '...') assert.match(result.filename, /^kiro-accounts-backup-/)
  }
})

test('empty or stale selection never falls back to exporting every account', () => {
  const empty = createAccountExport(input({ scope: 'selected', selectedIds: [] }))
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'empty_selection')
  assert.equal('content' in empty, false)
  const stale = createAccountExport(
    input({ scope: 'selected', selectedIds: ['github', 'missing'] })
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale_selection')
  assert.equal('content' in stale, false)
  assert.equal('filename' in stale, false)
})

test('invalid authentication, duplicate IDs and missing relationships block the whole export with redacted errors', () => {
  const invalid = account('invalid', 'BuilderId')
  invalid.credentials.clientSecret = ''
  const failed = createAccountExport(
    input({
      accounts: [account('ok', 'Google'), invalid],
      format: 'oidc',
      includeCredentials: true
    })
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'invalid_credentials')
  assert.equal(failed.count, 2)
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_|example\.invalid/)
  assert.equal('content' in failed, false)
  assert.equal(
    createAccountExport(input({ accounts: [invalid, invalid] })).code,
    'invalid_account_ids'
  )
  assert.equal(createAccountExport(input({ groups: [] })).code, 'missing_relationship')
  assert.equal(createAccountExport(input({ tags: [] })).code, 'missing_relationship')
})

test('credential JSON rejects expired metadata-only records instead of implying login can be restored', () => {
  const metadata = account('metadata', 'Google')
  delete metadata.credentials.refreshToken
  const minimal = createAccountExport(
    input({ accounts: [metadata], format: 'oidc', includeCredentials: true })
  )
  assert.equal(minimal.ok, false)
  assert.equal(minimal.code, 'invalid_credentials')
  const backup = createAccountExport(input({ accounts: [metadata] }))
  assert.equal(backup.ok, true)
  assert.equal(restore(backup).outcome.added, 1)
})

test('serialization failures never return partial content or exception details', () => {
  const cyclic = account('cyclic', 'Google')
  cyclic.privateNote = { back: cyclic }
  const failed = createAccountExport(input({ accounts: [cyclic], includeCredentials: true }))
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'serialization_failed')
  assert.equal('content' in failed, false)
  assert.doesNotMatch(JSON.stringify(failed), /FAKE_|example\.invalid/)
})
