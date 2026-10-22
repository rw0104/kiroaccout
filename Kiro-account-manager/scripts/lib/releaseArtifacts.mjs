import assert from 'node:assert/strict'

export function releaseTarget(platform = 'win32', arch = 'x64') {
  assert.ok(platform === 'win32' && arch === 'x64' || platform === 'darwin' && ['x64', 'arm64'].includes(arch) || platform === 'linux' && arch === 'x64', `Unsupported release target: ${platform}-${arch}`)
  return { platform, arch }
}

export function releaseTargets(version) {
  return version.includes('-')
    ? [releaseTarget(), releaseTarget('darwin', 'x64'), releaseTarget('darwin', 'arm64'), releaseTarget('linux', 'x64')]
    : [releaseTarget()]
}

export function checksumFilename({ platform = 'win32', arch = 'x64' } = {}) {
  releaseTarget(platform, arch)
  return `SHA256SUMS-${platform}-${arch}.txt`
}

export function releaseArtifactNames({ name, version, platform = 'win32', arch = 'x64' }) {
  assert.match(name, /^[a-z0-9-]+$/)
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/)
  releaseTarget(platform, arch)
  assert.ok(version.includes('-') || platform === 'win32', 'Stable non-Windows releases require separate updater validation')
  const base = `${name}-${version}-${arch}`
  if (platform === 'darwin') return [`${base}-mac.dmg`, `${base}-mac.zip`]
  if (platform === 'linux') return [`${base}-linux.AppImage`, `${base}-linux.deb`]
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
