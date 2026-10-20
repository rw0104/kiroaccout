// Inspect built files only. Never execute Electron or the installer.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
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
for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
  'node_modules/electron-store/package.json', 'node_modules/undici/package.json',
  'node_modules/tlsclientwrapper/package.json', 'node_modules/koffi/package.json']) {
  assert.ok(entries.includes(entry), `Required application entry missing: ${entry}`)
}
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packaged.version, metadata.version, 'Package version must match source')
assert.equal(packaged.main, './out/main/index.js')
const dll = join(unpacked, 'resources', 'tls-client-xgo-1.14.0-windows-amd64.dll')
assert.ok(statSync(dll).size > 1000000, 'Required Windows x64 TLS library missing')
assert.ok(statSync(join(unpacked, 'LICENSE.kiroaccout.txt')).size > 10000, 'AGPL license must accompany the package')
const updateConfig = readFileSync(join(unpacked, 'resources', 'app-update.yml'), 'utf8')
assert.match(updateConfig, /owner: rw0104/)
assert.match(updateConfig, /repo: kiroaccout/)
for (const file of [
  `${metadata.name}-${metadata.version}-x64-setup.exe`,
  `${metadata.name}-${metadata.version}-x64-windows.zip`
]) assert.ok(statSync(join(dist, file)).size > 1000000, `Release artifact missing: ${file}`)
const exe = readFileSync(join(unpacked, 'kiro-account-manager.exe'))
assert.equal(exe.toString('ascii', 0, 2), 'MZ')
const peOffset = exe.readUInt32LE(0x3c)
assert.equal(exe.readUInt16LE(peOffset + 4), 0x8664, 'Executable must be Windows x64')
const report = { version: packaged.version, platform: 'windows-x64', archiveEntries: entries.length,
  allowedRoots: [...allowedRoots], updaterRepository: 'rw0104/kiroaccout',
  licenseIncluded: true, nativeLibraryIncluded: true, applicationExecuted: false }
writeFileSync(join(dist, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
