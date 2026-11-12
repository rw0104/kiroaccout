import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const prefix = 'resources/crew-model-repair/'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const path = value => typeof value === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(value) &&
  !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')

/** Check the actual published archive, including unpacked files Python must read. */
export function verifyCrewModelRepairPackage({ entries, readPackaged, readUnpacked, readSource }) {
  const read = name => Buffer.from(readPackaged(prefix + name))
  assert.ok(entries.includes(prefix + 'manifest.json'), 'Native Crew repair manifest is missing')
  const manifest = JSON.parse(read('manifest.json').toString('utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(manifest.upstream, 'https://github.com/kirodotdev/KiroCrew')
  assert.ok(Array.isArray(manifest.contracts) && manifest.contracts.length > 0)
  const expected = new Map([['manifest.json', undefined], ['LICENSE.KiroCrew', undefined], ['NOTICE.KiroCrew', undefined]])
  for (const contract of manifest.contracts) {
    assert.match(contract.testedVersion, /^\d+\.\d+\.\d+$/)
    assert.match(contract.upstreamCommit, /^[a-f0-9]{40}$/)
    assert.ok(Array.isArray(contract.files) && contract.files.length > 0)
    for (const file of contract.files) {
      assert.ok(path(file.resource) && path(file.target) && !expected.has(file.resource), 'Invalid native Crew repair resource')
      assert.match(file.afterSha256, /^[a-f0-9]{64}$/)
      assert.ok(file.beforeSha256 === null || /^[a-f0-9]{64}$/.test(file.beforeSha256))
      expected.set(file.resource, file.afterSha256)
    }
    if (contract.files.some(file => file.resource.endsWith('.js'))) expected.set(`${contract.testedVersion}/frontend-source/useWebSocket.ts`, undefined)
  }
  const allowed = new Set(['resources/crew-model-repair'])
  for (const name of expected.keys()) {
    const pieces = (prefix + name).split('/')
    for (let count = 2; count <= pieces.length; count++) allowed.add(pieces.slice(0, count).join('/'))
  }
  for (const entry of entries.filter(name => name === 'resources/crew-model-repair' || name.startsWith(prefix))) {
    assert.ok(allowed.has(entry), `Unexpected native Crew repair package entry: ${entry}`)
  }
  for (const [name, hash] of expected) {
    assert.ok(entries.includes(prefix + name), `Native Crew repair resource is missing: ${name}`)
    const bytes = read(name)
    assert.ok(bytes.length > 0)
    if (hash) assert.equal(sha256(bytes), hash, `Native Crew repair digest differs: ${name}`)
    if (readUnpacked) assert.deepEqual(Buffer.from(readUnpacked(prefix + name)), bytes, `Native Crew unpacked copy differs: ${name}`)
    if (readSource) assert.deepEqual(Buffer.from(readSource(prefix + name)), bytes, `Native Crew source differs: ${name}`)
  }
  assert.match(read('LICENSE.KiroCrew').toString('utf8'), /Apache License/)
  assert.match(read('NOTICE.KiroCrew').toString('utf8'), /KiroCrew/)
  const helper = 'resources/client-switch/crew-access.py'
  assert.ok(entries.includes(helper), 'Native Crew access helper is missing')
  if (readUnpacked) assert.deepEqual(Buffer.from(readUnpacked(helper)), Buffer.from(readPackaged(helper)), 'Native Crew access helper must be unpacked')
  return { contracts: manifest.contracts.map(contract => contract.testedVersion), resources: expected.size, nativeAccessHelper: true }
}
