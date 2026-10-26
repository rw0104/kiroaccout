import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveOidcRegistrationExpiry,
  type OidcRegistrationInput
} from '../../src/shared/oidcRegistration.ts'

const clientId = 'SYNTHETIC_CLIENT'
const expiry = 1_900_000_000
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const secret = (
  serialized: unknown = { clientId: { value: clientId }, expirationTimestamp: expiry + 0.180562 },
  header: unknown = { alg: 'HS256' }
): string =>
  `${encode(header)}.${encode({ serialized: JSON.stringify(serialized) })}.${Buffer.from('SYNTHETIC_SIGNATURE').toString('base64url')}`
const input = { clientId, clientSecret: secret() }

test('recovers the precise original registration deadline from a matching serialized client secret', () => {
  assert.equal(resolveOidcRegistrationExpiry(input), expiry)
  assert.equal(
    resolveOidcRegistrationExpiry({
      ...input,
      clientSecret: secret({
        clientId: { value: clientId },
        expirationTimestamp: expiry,
        createdTimestamp: expiry - 86400
      })
    }),
    expiry
  )
  assert.deepEqual(
    input,
    { clientId, clientSecret: secret() },
    'does not mutate or persist credentials'
  )
})

test('explicit genuine deadlines take priority, including an already expired deadline', () => {
  assert.equal(resolveOidcRegistrationExpiry({ ...input, clientSecretExpiresAt: 1_000 }), 1_000)
  assert.equal(
    resolveOidcRegistrationExpiry({ ...input, clientSecretExpiresAt: expiry + 1.9 }),
    expiry + 1
  )
  assert.equal(
    resolveOidcRegistrationExpiry({ clientSecretExpiresAt: expiry * 1000 + 999 }),
    expiry
  )
})

test('explicit malformed deadlines never fall back to a seemingly valid secret', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1, 0.5, 1e30, null, false, String(expiry)]) {
    assert.equal(
      resolveOidcRegistrationExpiry({
        ...input,
        clientSecretExpiresAt: value
      } as OidcRegistrationInput),
      undefined
    )
  }
})

test('a registration deadline is usable only for its exact client ID', () => {
  for (const candidate of [undefined, '', ' ', 'OTHER_CLIENT', `${clientId} `]) {
    assert.equal(
      resolveOidcRegistrationExpiry({ clientId: candidate, clientSecret: secret() }),
      undefined
    )
  }
  for (const serialized of [
    { expirationTimestamp: expiry },
    { clientId, expirationTimestamp: expiry },
    { clientId: { value: 'OTHER_CLIENT' }, expirationTimestamp: expiry }
  ]) {
    assert.equal(
      resolveOidcRegistrationExpiry({ ...input, clientSecret: secret(serialized) }),
      undefined
    )
  }
})

test('unknown and malformed secret layouts do not fabricate a deadline or use generic JWT exp', () => {
  const header = encode({ alg: 'HS256' })
  for (const payload of [
    { exp: expiry },
    { serialized: {} },
    { serialized: 'invalid-json' },
    [],
    null,
    { serialized: '[]' },
    { serialized: 'null' }
  ]) {
    assert.equal(
      resolveOidcRegistrationExpiry({
        ...input,
        clientSecret: `${header}.${encode(payload)}.c2ln`
      }),
      undefined
    )
  }
  for (const candidate of [
    '',
    'opaque-client-secret',
    'a.b',
    'a.b.c.d',
    `${header}.!.c2ln`,
    `${header}.${encode({ serialized: '{}' })}.`,
    secret().replace(/\./, '=.'),
    secret() + 'A'.repeat(65536)
  ]) {
    assert.equal(resolveOidcRegistrationExpiry({ ...input, clientSecret: candidate }), undefined)
  }
})

test('unsigned or malformed JWT headers are not registration metadata', () => {
  for (const header of [
    { alg: 'none' },
    { alg: 'NONE' },
    { alg: ' none ' },
    { alg: '' },
    {},
    null,
    [],
    'HS256',
    { alg: 1 }
  ]) {
    assert.equal(
      resolveOidcRegistrationExpiry({ ...input, clientSecret: secret(undefined, header) }),
      undefined
    )
  }
})

test('nested timestamps must be finite positive Unix seconds, never guessed milliseconds', () => {
  for (const expirationTimestamp of [
    null,
    false,
    String(expiry),
    0,
    -1,
    0.5,
    1e30,
    expiry * 1000,
    undefined
  ]) {
    assert.equal(
      resolveOidcRegistrationExpiry({
        ...input,
        clientSecret: secret({ clientId: { value: clientId }, expirationTimestamp })
      }),
      undefined
    )
  }
  const expired = 1_000
  assert.equal(
    resolveOidcRegistrationExpiry({
      ...input,
      clientSecret: secret({ clientId: { value: clientId }, expirationTimestamp: expired })
    }),
    expired,
    'caller applies its expiry safety window'
  )
})
