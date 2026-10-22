import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { releaseTarget } from './releaseArtifacts.mjs'

export function tlsLibrarySpec(appRoot, platform, arch) {
  releaseTarget(platform, arch)
  const require = createRequire(`${appRoot}/package.json`)
  const source = readFileSync(require.resolve('tlsclientwrapper'), 'utf8')
  const version = source.match(/this\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/)?.[1]
  const prefix = source.match(/this\.filename\s*=\s*["'](tls-client-xgo)["']/)?.[1]
  assert.ok(version && prefix, 'Cannot determine TLS library version from installed tlsclientwrapper')
  const distribution = `${{ win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]}-${arch === 'x64' ? 'amd64' : arch}`
  const extension = { win32: 'dll', darwin: 'dylib', linux: 'so' }[platform]
  const filename = `${prefix}-${version}-${distribution}.${extension}`
  return { platform, arch, version, filename, url: `https://github.com/bogdanfinn/tls-client/releases/download/v${version}/${filename}` }
}

// Inspect headers only; never execute packaged applications or native addons.
export function verifyBinaryArchitecture(buffer, platform, arch) {
  assert.ok(buffer.length >= 64, 'Native binary header is truncated')
  if (platform === 'win32') {
    assert.equal(buffer.toString('ascii', 0, 2), 'MZ', 'Expected a PE binary')
    const offset = buffer.readUInt32LE(0x3c)
    assert.ok(offset + 6 <= buffer.length, 'Invalid PE header offset')
    assert.equal(buffer.toString('binary', offset, offset + 4), 'PE\0\0', 'Invalid PE signature')
    assert.equal(buffer.readUInt16LE(offset + 4), arch === 'x64' ? 0x8664 : 0xaa64, `Expected Windows ${arch}`)
  } else if (platform === 'linux') {
    assert.equal(buffer.toString('binary', 0, 4), '\x7fELF', 'Expected an ELF binary')
    assert.equal(buffer[4], 2, 'Expected a 64-bit ELF binary')
    assert.equal(buffer[5], 1, 'Expected a little-endian ELF binary')
    assert.equal(buffer.readUInt16LE(18), arch === 'x64' ? 62 : 183, `Expected Linux ${arch}`)
  } else {
    assert.equal(platform, 'darwin', 'Unknown binary platform')
    assert.equal(buffer.readUInt32LE(0), 0xfeedfacf, 'Expected a thin 64-bit Mach-O binary')
    assert.equal(buffer.readUInt32LE(4), arch === 'x64' ? 0x01000007 : 0x0100000c, `Expected macOS ${arch}`)
  }
}
