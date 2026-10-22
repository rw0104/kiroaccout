import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { releaseArtifactNames, releaseTargets, checksumFilename } from '../../scripts/lib/releaseArtifacts.mjs'
import { verifyBinaryArchitecture } from '../../scripts/lib/platformResources.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const preview = { name: 'kiro-account-manager', version: '1.8.5-rc.1' }
const run = (script, args = []) => spawnSync(process.execPath, [join(appRoot, 'scripts', script), ...args], { encoding: 'utf8', timeout: 10000 })
function temporary(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'kiro-release-fixture-'))
  try { fn(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('preview matrix has unique target payloads and excludes every updater channel and blockmap', () => {
  const targets = releaseTargets(preview.version)
  assert.equal(targets.length, 4)
  const files = targets.flatMap(target => releaseArtifactNames({ ...preview, ...target }))
  assert.deepEqual(files, [
    'kiro-account-manager-1.8.5-rc.1-x64-setup.exe', 'kiro-account-manager-1.8.5-rc.1-x64-windows.zip',
    'kiro-account-manager-1.8.5-rc.1-x64-mac.dmg', 'kiro-account-manager-1.8.5-rc.1-x64-mac.zip',
    'kiro-account-manager-1.8.5-rc.1-arm64-mac.dmg', 'kiro-account-manager-1.8.5-rc.1-arm64-mac.zip',
    'kiro-account-manager-1.8.5-rc.1-x64-linux.AppImage', 'kiro-account-manager-1.8.5-rc.1-x64-linux.deb'
  ])
  assert.equal(new Set(targets.map(checksumFilename)).size, 4)
  assert.throws(() => releaseArtifactNames({ ...preview, platform: 'linux', arch: 'arm64' }), /Unsupported/)
})

test('stable matrix includes all four targets and preserves only the Windows updater payload', () => {
  const stable = { name: preview.name, version: '1.8.5' }
  const targets = releaseTargets(stable.version)
  assert.deepEqual(targets, releaseTargets(preview.version))
  assert.deepEqual(releaseArtifactNames(stable), [
    'kiro-account-manager-1.8.5-x64-setup.exe', 'kiro-account-manager-1.8.5-x64-windows.zip',
    'kiro-account-manager-1.8.5-x64-setup.exe.blockmap', 'latest.yml'
  ])
  const manualAssets = targets.filter(target => target.platform !== 'win32')
    .flatMap(target => releaseArtifactNames({ ...stable, ...target }))
  assert.deepEqual(manualAssets, [
    'kiro-account-manager-1.8.5-x64-mac.dmg', 'kiro-account-manager-1.8.5-x64-mac.zip',
    'kiro-account-manager-1.8.5-arm64-mac.dmg', 'kiro-account-manager-1.8.5-arm64-mac.zip',
    'kiro-account-manager-1.8.5-x64-linux.AppImage', 'kiro-account-manager-1.8.5-x64-linux.deb'
  ])
  assert.ok(manualAssets.every(file => !/\.yml$|\.blockmap$/.test(file)))
})

test('checksum aggregation validates each payload and rejects extra assets before release', () => temporary(dist => {
  assert.equal(releaseTargets(metadata.version).length, 4)
  for (const target of releaseTargets(metadata.version)) {
    for (const file of releaseArtifactNames({ ...metadata, ...target })) writeFileSync(join(dist, file), `synthetic payload: ${file}`)
    const result = run('release-checksums.mjs', ['--dist', dist, '--platform', target.platform, '--arch', target.arch])
    assert.equal(result.status, 0, result.stderr)
  }
  let result = run('release-checksums.mjs', ['--all', '--dist', dist])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(readFileSync(join(dist, 'SHA256SUMS.txt'), 'utf8').includes(metadata.version))
  for (const unexpected of ['latest-mac.yml', 'latest-linux.yml', 'rc.yml']) {
    writeFileSync(join(dist, unexpected), 'unexpected updater metadata')
    result = run('release-checksums.mjs', ['--all', '--dist', dist])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unexpected or missing assets/)
    rmSync(join(dist, unexpected))
  }
  const artifact = releaseArtifactNames(metadata)[0]
  writeFileSync(join(dist, artifact), 'changed payload')
  result = run('release-checksums.mjs', ['--all', '--dist', dist])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Checksum verification failed/)
}))

test('staging includes only target assets and rejects stale content in the stage', () => temporary(dist => {
  const target = { platform: 'win32', arch: 'x64' }
  const files = releaseArtifactNames({ ...metadata, ...target })
  for (const file of files) writeFileSync(join(dist, file), `synthetic payload: ${file}`)
  const args = ['--dist', dist, '--platform', target.platform, '--arch', target.arch]
  assert.equal(run('release-checksums.mjs', args).status, 0)
  assert.equal(run('stage-release.mjs', args).status, 0)
  const destination = join(dist, 'release-assets', metadata.version)
  assert.deepEqual(readdirSync(destination).sort(), [...files, checksumFilename(target)].sort())
  writeFileSync(join(destination, 'unexpected.txt'), 'synthetic stale content')
  const result = run('stage-release.mjs', args)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unexpected files/)
}))

test('resource preparation and package verification fail before any application execution', () => temporary(dist => {
  const foreignPlatform = process.platform === 'win32' ? 'darwin' : 'win32'
  const prepared = run('prepare-platform-resources.mjs', ['--dist', dist, '--platform', foreignPlatform, '--arch', 'x64'])
  assert.notEqual(prepared.status, 0)
  assert.match(prepared.stderr, /native target OS/)
  const verified = run('verify-platform-package.mjs', ['--dist', dist, '--platform', 'win32', '--arch', 'x64'])
  assert.notEqual(verified.status, 0)
  assert.match(verified.stderr, /Build the win32-x64 package/)
}))

test('binary inspection rejects a mismatched architecture and truncated native binaries', () => {
  const elf = Buffer.alloc(64)
  elf.write('\x7fELF', 'binary'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18)
  assert.doesNotThrow(() => verifyBinaryArchitecture(elf, 'linux', 'x64'))
  assert.throws(() => verifyBinaryArchitecture(elf, 'linux', 'arm64'), /Expected Linux arm64/)
  const macho = Buffer.alloc(64)
  macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4)
  assert.doesNotThrow(() => verifyBinaryArchitecture(macho, 'darwin', 'arm64'))
  assert.throws(() => verifyBinaryArchitecture(macho, 'darwin', 'x64'), /Expected macOS x64/)
  assert.throws(() => verifyBinaryArchitecture(Buffer.alloc(16), 'win32', 'x64'), /truncated/)
})
