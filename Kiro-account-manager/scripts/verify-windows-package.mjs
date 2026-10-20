// Inspect built files only. Never execute Electron or the installer.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { validateStableManifest } from './lib/releaseArtifacts.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(appRoot, 'dist')
const unpacked = join(dist, 'win-unpacked')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const archive = join(unpacked, 'resources', 'app.asar')
assert.ok(existsSync(archive), 'Build the Windows package before verifying it')
const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''))
const allowedRoots = new Set(['out', 'resources', 'node_modules', 'package.json'])
assert.ok(entries.every(entry => allowedRoots.has(entry.split('/')[0])), 'Unexpected top-level files in app.asar')
assert.ok(!entries.some(entry => /(^|\/)(\.env(?:\.[^/]*)?|\.kiro|\.local|\.git|kiro-accounts[^/]*\.json)$/.test(entry)), 'Local state must not be packaged')
assert.ok(!entries.some(entry => /author-avatar|支付宝支付|微信支付|交流群/.test(entry)), 'Old promotional resources must not be packaged')
for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
  'node_modules/electron-store/package.json', 'node_modules/undici/package.json',
  'node_modules/@cbor-extract/cbor-extract-win32-x64/node.napi.node',
  'node_modules/koffi/build/koffi/win32_x64/koffi.node',
  'node_modules/tlsclientwrapper/package.json', 'node_modules/koffi/package.json']) {
  assert.ok(entries.includes(entry), `Required application entry missing: ${entry}`)
}
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packaged.version, metadata.version, 'Package version must match source')
assert.equal(packaged.main, './out/main/index.js')
const dll = join(unpacked, 'resources', 'tls-client-xgo-1.14.0-windows-amd64.dll')
assert.ok(statSync(dll).size > 1000000, 'Required Windows x64 TLS library missing')
assert.ok(statSync(join(unpacked, 'LICENSE.kiroaccout.txt')).size > 10000, 'AGPL license must accompany the package')
assert.ok(statSync(join(unpacked, 'THIRD_PARTY_NOTICES.md')).size > 0, 'Upstream and third-party notices must accompany the package')
const updateConfig = readFileSync(join(unpacked, 'resources', 'app-update.yml'), 'utf8')
assert.match(updateConfig, /owner: rw0104/)
assert.match(updateConfig, /repo: kiroaccout/)
for (const file of [
  `${metadata.name}-${metadata.version}-x64-setup.exe`,
  `${metadata.name}-${metadata.version}-x64-windows.zip`
]) assert.ok(statSync(join(dist, file)).size > 1000000, `Release artifact missing: ${file}`)
if (!metadata.version.includes('-')) {
  const installer = `${metadata.name}-${metadata.version}-x64-setup.exe`
  const payload = readFileSync(join(dist, installer))
  validateStableManifest(yaml.load(readFileSync(join(dist, 'latest.yml'), 'utf8')), {
    version: metadata.version, installer, size: payload.length,
    sha512: createHash('sha512').update(payload).digest('base64')
  })
  const blockmap = JSON.parse(gunzipSync(readFileSync(join(dist, `${installer}.blockmap`))).toString('utf8'))
  assert.ok(Array.isArray(blockmap.files) && blockmap.files.length > 0, 'Installer blockmap must be valid')
}
const exe = readFileSync(join(unpacked, 'kiro-account-manager.exe'))
assert.equal(exe.toString('ascii', 0, 2), 'MZ')
const peOffset = exe.readUInt32LE(0x3c)
assert.equal(exe.readUInt16LE(peOffset + 4), 0x8664, 'Executable must be Windows x64')
const report = { version: packaged.version, platform: 'windows-x64', archiveEntries: entries.length,
  allowedRoots: [...allowedRoots], updaterRepository: 'rw0104/kiroaccout',
  licenseIncluded: true, nativeLibraryIncluded: true, applicationExecuted: false }
writeFileSync(join(dist, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
