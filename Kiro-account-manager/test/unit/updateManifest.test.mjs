import test from 'node:test'
import assert from 'node:assert/strict'
import { releaseArtifactNames, validateStableManifest } from '../../scripts/lib/releaseArtifacts.mjs'

const expected = { version: '1.7.6', installer: 'kiro-account-manager-1.7.6-x64-setup.exe', size: 123456, sha512: 'synthetic-base64-sha512' }
const manifest = () => ({ version: expected.version, path: expected.installer, sha512: expected.sha512,
  files: [{ url: expected.installer, size: expected.size, sha512: expected.sha512 }] })

test('stable release includes update metadata while RC excludes it', () => {
  const stable = releaseArtifactNames({ name: 'kiro-account-manager', version: '1.7.6' })
  assert.ok(stable.includes('latest.yml') && stable.includes(`${expected.installer}.blockmap`))
  const rc = releaseArtifactNames({ name: 'kiro-account-manager', version: '1.7.6-rc.1' })
  assert.equal(rc.length, 2)
  assert.ok(!rc.includes('latest.yml'))
})

test('stable manifest binds version, file path, size and SHA-512 to the built installer', () => {
  assert.doesNotThrow(() => validateStableManifest(manifest(), expected))
  for (const change of [
    value => { value.version = '1.7.5' },
    value => { value.files[0].url = 'other.exe' },
    value => { value.files[0].size++ },
    value => { value.files[0].sha512 = 'different' },
    value => { value.path = 'other.exe' },
    value => { value.sha512 = 'different' },
    value => { value.files.push({ ...value.files[0] }) }
  ]) {
    const value = manifest(); change(value)
    assert.throws(() => validateStableManifest(value, expected))
  }
})
