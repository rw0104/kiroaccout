import assert from 'node:assert/strict'

export function releaseArtifactNames({ name, version }) {
  assert.match(name, /^[a-z0-9-]+$/)
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/)
  const installer = `${name}-${version}-x64-setup.exe`
  const names = [installer, `${name}-${version}-x64-windows.zip`]
  if (!version.includes('-')) names.push(`${installer}.blockmap`, 'latest.yml')
  return names
}

/** Validate the exact stable update payload, not just whether a channel file exists. */
export function validateStableManifest(manifest, expected) {
  assert.ok(manifest && typeof manifest === 'object', 'Invalid update manifest')
  assert.equal(manifest.version, expected.version, 'Update version does not match the package')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 1, 'Exactly one NSIS update payload is required')
  assert.equal(manifest.files[0].url, expected.installer, 'Unexpected update download path')
  assert.equal(manifest.files[0].size, expected.size, 'Update payload size differs')
  assert.equal(manifest.files[0].sha512, expected.sha512, 'Update payload SHA-512 differs')
  assert.equal(manifest.path, expected.installer, 'Legacy update path differs')
  assert.equal(manifest.sha512, expected.sha512, 'Legacy update SHA-512 differs')
}
