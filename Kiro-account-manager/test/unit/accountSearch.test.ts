import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSourceAccountNames, matchesAccountSearch } from '../../src/shared/accountSearch.ts'

test('search finds the original imported account after its displayed email changes', () => {
  const account = {
    email: 'verified@example.invalid',
    nickname: 'Personal account',
    sourceAccountNames: ['synthetic-login-42', 'older-login']
  }
  for (const query of ['SYNTHETIC-LOGIN', ' login-42 ', 'older-login', 'VERIFIED@', 'personal']) {
    assert.equal(matchesAccountSearch(account, query), true)
  }
  assert.equal(matchesAccountSearch(account, 'missing'), false)
  assert.equal(matchesAccountSearch(account, '  '), true)
  assert.equal(account.email, 'verified@example.invalid')
})

test('legacy and malformed optional metadata remain searchable without examining credentials', () => {
  assert.equal(matchesAccountSearch({ email: 'legacy@example.invalid' }, 'legacy'), true)
  assert.equal(matchesAccountSearch({ email: 'legacy@example.invalid' }, 'login'), false)
  const account = JSON.parse('{"email":"legacy@example.invalid","sourceAccountNames":[null,42,"Synthetic-login"],"credentials":{"refreshToken":"SYNTHETIC_SECRET"}}')
  assert.equal(matchesAccountSearch(account, 'synthetic-login'), true)
  assert.equal(matchesAccountSearch(account, 'synthetic_secret'), false)
  account.sourceAccountNames = { unexpected: true }
  assert.equal(matchesAccountSearch(account, 'legacy'), true)
})

test('source account names are trimmed and merged without mutating source arrays', () => {
  const first = ['  Synthetic-login  ', '', 'Synthetic-login']
  const second = ['SYNTHETIC-LOGIN', 'another-login', null, 42]
  assert.deepEqual(mergeSourceAccountNames(first, second, undefined), ['Synthetic-login', 'another-login'])
  assert.equal(first[0], '  Synthetic-login  ')
  assert.deepEqual(mergeSourceAccountNames('unexpected-string', {}), [])
})
